import Fastify from "fastify";
import { NotificationFeed } from "./attention/notification-feed.js";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import {existsSync} from "node:fs";
import {join,resolve} from "node:path";
import { z } from "zod";
import { DomainError } from "../../../packages/domain/src/index.js";
import { createPool, type DbPool } from "./db.js";
import { RoomService } from "./room-service.js";
import { RealtimeHub, type RealtimeOptions } from "./realtime/realtime-hub.js";
import { AgentRuntimeService } from "./agent-runtime/runtime-service.js";
import { AgentGatewayService } from "./agent-gateway/gateway-service.js";
import { registerAgentGatewayRoutes } from "./agent-gateway/gateway-routes.js";
import { AuthService, type SignInLinkDelivery, type SignInReturn } from "./auth/auth-service.js";
import { RoomInviteService } from "./invites/room-invite-service.js";
import { deliveryMode, resolveSignInDelivery, type DeliveryEnvironment } from "./auth/delivery-config.js";
import { assertProductionSafe, isProduction } from "./production-guard.js";
import { ArtifactService, isPreviewable } from "./artifacts/artifact-service.js";
import { storageFrom, LocalArtifactStorage, type ArtifactStorage } from "./artifacts/storage.js";
import { AUTH_LIMITS, PostgresRateLimitStore, clientBucket, emailBucket, overLimit,
  type RateLimitStore } from "./auth/rate-limit.js";

const fakeStep=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('tool'),id:z.string().min(1),name:z.enum(['room.send_message','task.get','task.list_eligible','task.update_status','task.complete','decision.request','decision.get']),arguments:z.record(z.string(),z.unknown())}),
  z.object({kind:z.literal('barrier'),id:z.string().min(1),name:z.string().min(1)}),
  z.object({kind:z.literal('expect_message'),id:z.string().min(1),includes:z.string(),sender_principal_id:z.string().uuid().optional()}),
  z.object({kind:z.literal('expect_decision'),id:z.string().min(1),status:z.enum(['approved','rejected']),note_includes:z.string().optional()}),
  z.object({kind:z.literal('transient_failure'),id:z.string().min(1),times:z.number().int().min(0)}),
  z.object({kind:z.literal('permanent_failure'),id:z.string().min(1),message:z.string()}),
  z.object({kind:z.literal('complete'),id:z.string().min(1)})
]);

const body = <T extends z.ZodTypeAny>(schema:T, value:unknown):z.infer<T> => schema.parse(value);
const SESSION_COOKIE = "mpai_session";
const SESSION_MAX_AGE = 30*24*60*60;
const readSessionCookie = (request:any) => {
  const raw=request.headers.cookie;
  if(typeof raw!=="string") return undefined;
  for(const part of raw.split(";")){ const at=part.indexOf("="); if(at<0) continue; if(part.slice(0,at).trim()===SESSION_COOKIE) return decodeURIComponent(part.slice(at+1).trim()); }
  return undefined;
};
const writeSessionCookie = (reply:any,value:string,maxAge:number,secure:boolean) =>
  reply.header("set-cookie",`${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure?"; Secure":""}`);

export interface AppOptions {
  /** Accept x-principal-id / principal_id. Local development only; never enable in production. */
  allowHeaderPrincipal?: boolean;
  cookieSecure?: boolean;
  signInDelivery?: SignInLinkDelivery;
  /** Where delivery is configured from. Defaults to the process environment. */
  environment?: DeliveryEnvironment;
  /** Counts the public authentication routes. Defaults to one backed by this database. */
  rateLimits?: RateLimitStore;
  /** Where artifact bytes go. Defaults to whatever the environment configures. */
  artifactStorage?: ArtifactStorage;
  /** The origin serving the web app, where a browser sign-in must return. Defaults to WEB_APP_URL. */
  webAppUrl?: string;
  /** How far behind now the notification feed reads, so late-committing events are never skipped. */
  notificationSettleSeconds?: number;
}
const idem = (request:any) => { const key=request.headers["idempotency-key"]; if(typeof key!=="string") throw new DomainError("idempotency_key_required","Idempotency-Key is required",400); return key; };

export function buildApp(pool:DbPool=createPool(), realtimeOptions:RealtimeOptions={}, options:AppOptions={}) {
  const environmentForGuard=(options.environment ?? process.env) as Record<string,string|undefined>;
  /* Refuse to start rather than serve a public origin with a development setting on. */
  assertProductionSafe(environmentForGuard);
  const production=isProduction(environmentForGuard);
  /* Behind Render's proxy the socket address is the proxy's. Without this every caller shares one
     address, and a per-caller limit would lock out everybody at once instead of one abuser. */
  /* Files are large compared with everything else this service handles, so the body limit is
     raised to match the artifact limit rather than the default 1 MB — and no further, because a
     limit that only exists in one layer is a limit somebody will find their way around. */
  const app=Fastify({logger:false,trustProxy:production,bodyLimit:52*1024*1024});
  const storage:ArtifactStorage=options.artifactStorage??storageFrom(environmentForGuard,production);
  const artifacts=new ArtifactService(pool,storage);
  /* Fastify parses JSON and text and refuses everything else, so a PDF arriving as the body would
     be rejected before any of this saw it. Binary uploads are handed over as-is; the declared type
     is a claim, and what it is allowed to be is decided in the service, not here. */
  app.addContentTypeParser('*',{parseAs:'buffer'},(_request,payload,done)=>done(null,payload));
  const allowHeaderPrincipal=options.allowHeaderPrincipal ?? process.env.ALLOW_HEADER_PRINCIPAL==="1";
  /* Where a browser sign-in has to come back to.

     Read from configuration and never from the request, because the alternative is trusting a
     Host or Origin header to decide where a valid single-use token gets emailed — and anyone can
     send a request with any Host. A caller may say it is a browser; it may not say where. */
  const webAppUrl=(options.webAppUrl ?? environmentForGuard.WEB_APP_URL)?.trim().replace(/\/+$/,"");
  const returnFor=(context:"web"|"app"|undefined):SignInReturn|undefined=>
    context==="web"&&webAppUrl?{kind:"web",origin:webAppUrl}:undefined;
  const cookieSecure=options.cookieSecure ?? process.env.AUTH_COOKIE_SECURE!=="0";
  /* Delivery is settled at startup, not on the first sign-in. A deployment that asked for real
     email and cannot send it fails here, loudly, rather than accepting sign-ups and writing
     everybody's link to a console. */
  const environment=options.environment ?? (process.env as DeliveryEnvironment);
  const delivery=options.signInDelivery ?? resolveSignInDelivery(environment);
  const mode=options.signInDelivery ? 'custom' : deliveryMode(environment);
  const auth=new AuthService(pool,delivery);
  const invites=new RoomInviteService(pool);
  const rateLimits=options.rateLimits ?? new PostgresRateLimitStore(pool);

  /* The two routes that send mail to an address the caller chose. Counted before anything looks
     the address up, so the answer cannot depend on whether it has an account. */
  const withinAuthLimits=async(request:any,email:string)=>{
    const [byEmail,byClient]=await Promise.all([
      rateLimits.hit(emailBucket(email),AUTH_LIMITS.perEmail.windowSeconds),
      rateLimits.hit(clientBucket(String(request.ip??"unknown")),AUTH_LIMITS.perClient.windowSeconds),
    ]);
    if(overLimit(byEmail,AUTH_LIMITS.perEmail)||overLimit(byClient,AUTH_LIMITS.perClient))
      throw new DomainError("rate_limited","Too many sign-in requests. Try again later.",429);
  };
  // The acting principal is resolved from the session and the addressed company. A client can
  // never name it, so knowing a principal id grants nothing.
  const principal=async(request:any,companyId:string)=>{
    if(allowHeaderPrincipal){ const id=request.headers["x-principal-id"]; if(typeof id==="string") return id; }
    const session=await auth.resolveSession(readSessionCookie(request));
    return auth.principalFor(session.userId,companyId);
  };
  const service=new RoomService(pool);
  const notifications=new NotificationFeed(pool,options.notificationSettleSeconds);
  /* A mention names a participant by id; where it sits in the text is optional for agents, which
     write "@Name" and let the server place it. Membership and the text itself are checked there. */
  const mentionsSchema=z.array(z.object({principal_id:z.string().uuid(),start:z.number().int().min(0).optional(),end:z.number().int().min(0).optional()})).max(50).optional();
  const agentRuntime=new AgentRuntimeService(pool,service);
  const realtime=new RealtimeHub(pool,service,realtimeOptions);
  const agentGateway=new AgentGatewayService(pool,service);
  app.register(websocket);
  app.setErrorHandler((error,request,reply)=>{ if(error instanceof DomainError) return reply.status(error.statusCode).send({error:{code:error.code,message:error.message,request_id:request.id,details:error.details}}); if(error instanceof z.ZodError) return reply.status(400).send({error:{code:"validation_error",message:"Invalid request",request_id:request.id,details:error.issues}}); request.log.error(error); return reply.status(500).send({error:{code:"internal_error",message:"Internal server error",request_id:request.id}}); });
  /* Liveness: the process is up and answering. Deliberately touches nothing else. */
  app.get('/health',async()=>({status:'ok'}));

  /* Readiness: whether this instance can actually serve the product.
  
     /health answers from the process alone, so a deployment whose database is unreachable or
     unmigrated reports itself perfectly healthy while every route that matters returns 500 — which
     is exactly what a hosted deployment did, and what cost an afternoon to find from the outside.
     This asks the database the two questions that decide it: can I reach you, and are you the
     shape I expect. Table names only; nothing here reveals where the database is or how to get in. */
  app.get('/ready',async(_request,reply)=>{
    try{
      await pool.query('SELECT 1');
    }catch(failure){
      return reply.status(503).send({status:'unavailable',database:'unreachable',
        detail:'The database did not answer. Check the connection string and that the database is running.'});
    }
    const expected=['companies','principals','rooms','users','user_auth_tokens','user_sessions',
      'external_agent_credentials','auth_rate_limits'];
    const found=await pool.query<{name:string|null}>(
      `SELECT to_regclass('public.'||t) name FROM unnest($1::text[]) t`,[expected]);
    const missing=expected.filter((_,index)=>!found.rows[index]?.name);
    if(missing.length) return reply.status(503).send({status:'unavailable',database:'reachable',
      migrations:'incomplete',missing,
      detail:'Run the migration step (node dist/packages/db/src/migrate.js) before serving.'});
    return {status:'ready',database:'reachable',migrations:'complete'};
  });
  /* What the product may say about how a link arrives. Not a secret, and not about any one
     person: it exists so "check your email" is only shown when an email is actually sent, and the
     developer wording about a workspace operator only when that is genuinely what happens. */
  app.get('/v1/app-config',async()=>({sign_in_delivery:mode}));
  app.post('/v1/auth/sign-up',async req=>{const x=body(z.object({name:z.string().min(1).max(100),email:z.string().email(),context:z.enum(['web','app']).optional()}),req.body);await withinAuthLimits(req,x.email);return auth.signUp({name:x.name,email:x.email,returnTo:returnFor(x.context)})});
  app.post('/v1/auth/sign-in-links',async req=>{const x=body(z.object({email:z.string().email(),context:z.enum(['web','app']).optional()}),req.body);await withinAuthLimits(req,x.email);return auth.requestSignInLink(x.email,returnFor(x.context))});
  app.post('/v1/auth/sessions',async(req,reply)=>{const x=body(z.object({token:z.string().min(8)}),req.body);const created=await auth.createSession(x.token);writeSessionCookie(reply,created.session_token,SESSION_MAX_AGE,cookieSecure);return auth.identity(created.user_id)});
  app.delete('/v1/auth/sessions/current',async(req,reply)=>{const result=await auth.revokeSession(readSessionCookie(req));writeSessionCookie(reply,'',0,cookieSecure);return result});
  app.get('/v1/auth/me',async req=>{const session=await auth.resolveSession(readSessionCookie(req));return auth.identity(session.userId)});
  /* Invite secrets live in the URL fragment, never the request path. That keeps them out of
     proxy access logs and referrers; preview and acceptance carry the secret in a POST body. */
  app.post('/v1/room-invites/preview',async req=>{const x=body(z.object({token:z.string().min(20).max(200)}),req.body);return invites.preview(x.token)});
  app.post('/v1/room-invites/accept',async req=>{const x=body(z.object({token:z.string().min(20).max(200)}),req.body);const session=await auth.resolveSession(readSessionCookie(req));return invites.accept(x.token,session.userId)});
  // Developer beta: no email transport, so an authorized company member mints a link and
  // reads it once from this response. Delivery stays behind the SignInLinkDelivery seam.
  app.post('/v1/companies/:companyId/users/:userId/sign-in-links',async req=>{const p=body(z.object({companyId:z.string().uuid(),userId:z.string().uuid()}),req.params);const session=await auth.resolveSession(readSessionCookie(req));return auth.issueSignInLinkFor({companyId:p.companyId,actorUserId:session.userId,userId:p.userId})});
  // Authenticated workspace creation. The unauthenticated POST /v1/companies below remains a
  // developer bootstrap and a documented staging blocker; this path does not depend on it.
  app.post('/v1/workspaces',async req=>{const x=body(z.object({name:z.string().min(1).max(100)}),req.body);const session=await auth.resolveSession(readSessionCookie(req));return service.createWorkspaceForUser(session.userId,x.name)});
  app.get('/v1/companies/:companyId/rooms',async req=>{const p=body(z.object({companyId:z.string().uuid()}),req.params);return service.listRoomsForPrincipal(p.companyId,await principal(req,p.companyId))});
  app.get('/v1/companies/:companyId/agents',async req=>{const p=body(z.object({companyId:z.string().uuid()}),req.params);return service.listCompanyAgents(p.companyId,await principal(req,p.companyId))});
  /* Creating a company and a person used to be possible with no credentials at all, which was
     how the developer beta bootstrapped itself. Signing up is a product route now, so these are
     available only where a deployment has explicitly asked for a bootstrap escape hatch — the
     same flag the header-principal escape hatch uses. In normal configuration they do not exist. */
  if(allowHeaderPrincipal){
    app.post('/v1/companies',async req=>{const x=body(z.object({name:z.string().min(1)}),req.body);return service.createCompany(x.name)});
  app.post('/v1/companies/:companyId/humans',async req=>{const p=body(z.object({companyId:z.string().uuid()}),req.params);const x=body(z.object({email:z.string().email(),display_name:z.string().min(1)}),req.body);return service.createHuman(p.companyId,x.email,x.display_name)});
  }
  /* Adding an agent is an authenticated act by a person in the addressed company; the owner is
     resolved from who is acting, so it can never be chosen by the caller. */
  app.post('/v1/companies/:companyId/agents',async req=>{const p=body(z.object({companyId:z.string().uuid()}),req.params);const x=body(z.object({name:z.string().min(1).max(100)}),req.body);return service.createAgentForPrincipal(p.companyId,await principal(req,p.companyId),x.name)});
  /* A physical runtime is connected only after its local adapter has successfully probed it. The
   * stable installation id is separate from every credential and survives credential rotation. */
  app.get('/v1/companies/:companyId/runtime-connections',async(req,reply)=>{
    const p=body(z.object({companyId:z.string().uuid()}),req.params);
    const x=body(z.object({runtime_type:z.string().min(1).max(50),external_runtime_id:z.string().uuid()}),req.query);
    reply.header('cache-control','no-store');
    return service.lookupRuntimeForPrincipal({companyId:p.companyId,actorId:await principal(req,p.companyId),
      runtimeType:x.runtime_type,externalRuntimeId:x.external_runtime_id});
  });
  app.post('/v1/companies/:companyId/runtime-connections',async req=>{
    const p=body(z.object({companyId:z.string().uuid()}),req.params);
    const x=body(z.object({
      name:z.string().min(1).max(100),runtime_type:z.string().min(1).max(50),
      external_runtime_id:z.string().uuid(),connector_installation_id:z.string().uuid(),
      endpoint:z.string().min(1).max(500),runtime_version:z.string().max(100).optional(),
      probe_status:z.literal('healthy'),create_as_new:z.boolean().default(false),
    }),req.body);
    return service.connectRuntimeForPrincipal({companyId:p.companyId,actorId:await principal(req,p.companyId),
      name:x.name,runtimeType:x.runtime_type,externalRuntimeId:x.external_runtime_id,
      connectorInstallationId:x.connector_installation_id,endpoint:x.endpoint,
      runtimeVersion:x.runtime_version,createAsNew:x.create_as_new});
  });
  app.delete('/v1/companies/:companyId/agents/:agentPrincipalId',async req=>{const p=body(z.object({companyId:z.string().uuid(),agentPrincipalId:z.string().uuid()}),req.params);return service.removeAgent(p.companyId,await principal(req,p.companyId),p.agentPrincipalId)});
  app.post('/v1/companies/:companyId/projects',async req=>{const p=body(z.object({companyId:z.string().uuid()}),req.params);const x=body(z.object({name:z.string().min(1),objective:z.string().min(1)}),req.body);return service.createProject(p.companyId,await principal(req,p.companyId),x.name,x.objective)});
  app.patch('/v1/companies/:companyId/projects/:projectId/objective',async req=>{const p=body(z.object({companyId:z.string().uuid(),projectId:z.string().uuid()}),req.params);const x=body(z.object({objective:z.string().min(1).max(4000),expected_objective:z.string().min(1).max(4000)}),req.body);return service.setProjectObjective(p.companyId,p.projectId,await principal(req,p.companyId),x.objective,x.expected_objective)});
  app.post('/v1/companies/:companyId/projects/:projectId/rooms',async req=>{const p=body(z.object({companyId:z.string().uuid(),projectId:z.string().uuid()}),req.params);const x=body(z.object({name:z.string().min(1),responsibilities:z.string().default('Manage the project room')}),req.body);return service.createRoom(p.companyId,p.projectId,await principal(req,p.companyId),x.name,x.responsibilities)});
  app.delete('/v1/companies/:companyId/rooms/:roomId',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid()}),req.params);return service.deleteRoom(p.companyId,p.roomId,await principal(req,p.companyId))});
  app.post('/v1/companies/:companyId/rooms/:roomId/members',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid()}),req.params);const x=body(z.object({principal_id:z.string().uuid(),role:z.enum(['manager','contributor','worker_agent']),responsibilities:z.string().default('')}),req.body);return service.addMember({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),principalId:x.principal_id,role:x.role,responsibilities:x.responsibilities,idempotencyKey:idem(req)})});
  app.post('/v1/companies/:companyId/rooms/:roomId/invites',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid()}),req.params);const x=body(z.object({ttl_hours:z.number().int().min(1).max(168).optional()}),req.body??{});return invites.issue({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),ttlHours:x.ttl_hours})});
  app.delete('/v1/companies/:companyId/rooms/:roomId/members/:principalId',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),principalId:z.string().uuid()}),req.params);return service.removeMember({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),principalId:p.principalId,idempotencyKey:idem(req)})});
  app.post('/v1/companies/:companyId/rooms/:roomId/read',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid()}),req.params);const x=body(z.object({room_seq:z.number().int().min(0)}),req.body);return service.markRoomRead(p.companyId,p.roomId,await principal(req,p.companyId),x.room_seq)});
  app.post('/v1/companies/:companyId/agents/:agentPrincipalId/owners',async req=>{const p=body(z.object({companyId:z.string().uuid(),agentPrincipalId:z.string().uuid()}),req.params);const x=body(z.object({human_principal_id:z.string().uuid()}),req.body);return service.addAgentOwner(p.companyId,await principal(req,p.companyId),p.agentPrincipalId,x.human_principal_id)});
  app.delete('/v1/companies/:companyId/agents/:agentPrincipalId/owners/:humanPrincipalId',async req=>{const p=body(z.object({companyId:z.string().uuid(),agentPrincipalId:z.string().uuid(),humanPrincipalId:z.string().uuid()}),req.params);return service.removeAgentOwner(p.companyId,await principal(req,p.companyId),p.agentPrincipalId,p.humanPrincipalId)});
  /* Notifications for whoever is signed in, across every workspace and room they belong to. */
  app.get('/v1/me/notifications',async req=>{
    const q=body(z.object({after:z.string().max(200).optional()}),req.query);
    let userId:string;
    const header=allowHeaderPrincipal?req.headers["x-principal-id"]:undefined;
    if(typeof header==="string"){const found=await pool.query<{user_id:string}>(`SELECT user_id FROM principals WHERE id=$1 AND kind='human'`,[header]);if(!found.rows[0])throw new DomainError('unauthenticated','Sign in to read notifications',401);userId=found.rows[0].user_id}
    else userId=(await auth.resolveSession(readSessionCookie(req))).userId;
    return notifications.forUser(userId,q.after);
  });
  app.post('/v1/companies/:companyId/rooms/:roomId/messages',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid()}),req.params);const x=body(z.object({body:z.string().max(100000),artifact_ids:z.array(z.string().uuid()).max(10).optional(),addressed_principal_id:z.string().uuid().optional(),task_id:z.string().uuid().optional(),in_reply_to_message_id:z.string().uuid().optional(),mentions:mentionsSchema}),req.body);return service.sendMessage({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),addressedPrincipalId:x.addressed_principal_id,mentions:x.mentions,body:x.body,artifactIds:x.artifact_ids,taskId:x.task_id,inReplyToMessageId:x.in_reply_to_message_id,idempotencyKey:idem(req)})});
  app.post('/v1/companies/:companyId/rooms/:roomId/tasks',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid()}),req.params);const x=body(z.object({title:z.string().min(1),description:z.string().default(''),assignee_principal_id:z.string().uuid().optional()}),req.body);return service.createTask({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),title:x.title,description:x.description,assigneePrincipalId:x.assignee_principal_id,idempotencyKey:idem(req)})});
  app.patch('/v1/companies/:companyId/rooms/:roomId/tasks/:taskId/status',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),taskId:z.string().uuid()}),req.params);const x=body(z.object({status:z.enum(['open','in_progress','blocked','awaiting_decision','completed','cancelled']),expected_version:z.number().int().positive()}),req.body);return service.updateTaskStatus({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),taskId:p.taskId,status:x.status,expectedVersion:x.expected_version,idempotencyKey:idem(req)})});
  app.post('/v1/companies/:companyId/rooms/:roomId/tasks/:taskId/dependencies',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),taskId:z.string().uuid()}),req.params);const x=body(z.object({depends_on_task_id:z.string().uuid()}),req.body);return service.addTaskDependency({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),taskId:p.taskId,dependsOnTaskId:x.depends_on_task_id,idempotencyKey:idem(req)})});
  app.delete('/v1/companies/:companyId/rooms/:roomId/tasks/:taskId/dependencies/:dependsOnTaskId',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),taskId:z.string().uuid(),dependsOnTaskId:z.string().uuid()}),req.params);return service.removeTaskDependency({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),taskId:p.taskId,dependsOnTaskId:p.dependsOnTaskId,idempotencyKey:idem(req)})});
  app.post('/v1/companies/:companyId/rooms/:roomId/tasks/:taskId/dependency-override',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),taskId:z.string().uuid()}),req.params);const x=body(z.object({reason:z.string().min(1).max(500)}),req.body);return service.overrideTaskDependencies({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),taskId:p.taskId,reason:x.reason,idempotencyKey:idem(req)})});
  app.post('/v1/companies/:companyId/rooms/:roomId/agent-runs',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid()}),req.params);const x=body(z.object({agent_principal_id:z.string().uuid(),task_id:z.string().uuid().optional(),script:z.array(fakeStep).min(1),max_attempts:z.number().int().min(1).max(10).default(3)}),req.body);return agentRuntime.queueRun({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),agentPrincipalId:x.agent_principal_id,taskId:x.task_id,script:x.script,maxAttempts:x.max_attempts,idempotencyKey:idem(req)})});
  app.get('/v1/companies/:companyId/rooms/:roomId/agent-runs/:runId',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),runId:z.string().uuid()}),req.params);await service.snapshot(p.companyId,p.roomId,await principal(req,p.companyId));const run=await agentRuntime.getRun(p.runId);if(run.company_id!==p.companyId||run.room_id!==p.roomId)throw new DomainError('run_not_found','Agent run not found',404);return run});
  app.post('/v1/companies/:companyId/rooms/:roomId/agent-runs/:runId/cancel',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),runId:z.string().uuid()}),req.params);return agentRuntime.cancelRun({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),runId:p.runId,idempotencyKey:idem(req)})});
  app.post('/v1/companies/:companyId/rooms/:roomId/agent-runs/:runId/decisions',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),runId:z.string().uuid()}),req.params);const x=body(z.object({lease_token:z.string().uuid(),step_id:z.string().min(1),title:z.string().min(1),question:z.string().min(1),rationale:z.string().default(''),proposed_action:z.record(z.string(),z.unknown()),expires_at:z.string().datetime({offset:true}).optional()}),req.body);const run=await agentRuntime.getRun(p.runId);if(run.company_id!==p.companyId||run.room_id!==p.roomId)throw new DomainError('run_not_found','Agent run not found',404);if(run.agent_principal_id!==await principal(req,p.companyId))throw new DomainError('permission_denied','Only the running agent may request its decision',403);return agentRuntime.requestDecision({...run,lease_token:x.lease_token,lease_owner:run.lease_owner??'http-tool'} as any,{kind:'tool',id:x.step_id,name:'decision.request',arguments:{title:x.title,question:x.question,rationale:x.rationale,proposed_action:x.proposed_action,...(x.expires_at?{expires_at:x.expires_at}:{})}})});
  app.get('/v1/companies/:companyId/rooms/:roomId/decisions',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid()}),req.params);const q=body(z.object({status:z.enum(['pending','approved','rejected','cancelled','expired']).optional()}),req.query);return agentRuntime.listDecisions({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),status:q.status})});
  app.get('/v1/companies/:companyId/rooms/:roomId/decisions/:decisionId',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),decisionId:z.string().uuid()}),req.params);return agentRuntime.getDecision({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),decisionId:p.decisionId})});
  const resolutionBody=z.object({proposed_action_digest:z.string().regex(/^[0-9a-f]{64}$/),expected_version:z.number().int().positive(),note:z.string().max(4000).optional()});
  app.post('/v1/companies/:companyId/rooms/:roomId/decisions/:decisionId/approve',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),decisionId:z.string().uuid()}),req.params);const x=body(resolutionBody,req.body);return agentRuntime.resolveDecision({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),decisionId:p.decisionId,resolution:'approved',proposedActionDigest:x.proposed_action_digest,expectedVersion:x.expected_version,note:x.note,idempotencyKey:idem(req)})});
  app.post('/v1/companies/:companyId/rooms/:roomId/decisions/:decisionId/reject',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),decisionId:z.string().uuid()}),req.params);const x=body(resolutionBody,req.body);return agentRuntime.resolveDecision({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),decisionId:p.decisionId,resolution:'rejected',proposedActionDigest:x.proposed_action_digest,expectedVersion:x.expected_version,note:x.note,idempotencyKey:idem(req)})});
  app.post('/v1/companies/:companyId/rooms/:roomId/decisions/:decisionId/cancel',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),decisionId:z.string().uuid()}),req.params);const x=body(z.object({expected_version:z.number().int().positive()}),req.body);return agentRuntime.cancelDecision({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),decisionId:p.decisionId,expectedVersion:x.expected_version,idempotencyKey:idem(req)})});
  app.post('/v1/companies/:companyId/rooms/:roomId/agents/:agentId/pause',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),agentId:z.string().uuid()}),req.params);return agentRuntime.pauseAgent({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),agentId:p.agentId,idempotencyKey:idem(req)})});
  app.post('/v1/companies/:companyId/rooms/:roomId/agents/:agentId/resume',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),agentId:z.string().uuid()}),req.params);return agentRuntime.resumeAgent({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),agentId:p.agentId,idempotencyKey:idem(req)})});
  app.patch('/v1/companies/:companyId/rooms/:roomId/tasks/:taskId/assignee',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),taskId:z.string().uuid()}),req.params);const x=body(z.object({assignee_principal_id:z.string().uuid().nullable(),expected_version:z.number().int().positive()}),req.body);return service.reassignTask({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),taskId:p.taskId,assigneePrincipalId:x.assignee_principal_id,expectedVersion:x.expected_version,idempotencyKey:idem(req)})});
  /* Files in a room, for humans and agents alike.

     Upload is raw bytes with the name and type in the query, rather than multipart: there is one
     file per request, the body is the file, and that removes a parser from the path every uploaded
     byte travels through. Membership is checked inside the service on every one of these. */
  app.post('/v1/companies/:companyId/rooms/:roomId/artifacts',async req=>{
    const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid()}),req.params);
    const q=body(z.object({filename:z.string().min(1).max(255),content_type:z.string().min(1).max(255).optional()}),req.query);
    const bytes=req.body as Buffer;
    if(!Buffer.isBuffer(bytes))throw new DomainError('artifact_empty','Send the file as the request body',400);
    return artifacts.create({companyId:p.companyId,roomId:p.roomId,
      principalId:await principal(req,p.companyId),filename:q.filename,
      contentType:q.content_type??String(req.headers['content-type']??'application/octet-stream'),
      body:new Uint8Array(bytes)});
  });
  app.get('/v1/companies/:companyId/rooms/:roomId/artifacts',async req=>{
    const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid()}),req.params);
    const found=await artifacts.list(p.companyId,p.roomId,await principal(req,p.companyId));
    return {artifacts:found.map(a=>({...a,previewable:isPreviewable(a.content_type)}))};
  });
  app.get('/v1/companies/:companyId/rooms/:roomId/artifacts/:artifactId/content',async (req,reply)=>{
    const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),artifactId:z.string().uuid()}),req.params);
    const file=await artifacts.content(p.companyId,p.roomId,await principal(req,p.companyId),p.artifactId);
    return reply.header('cache-control','no-store').header('x-content-type-options','nosniff')
      .header('content-disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`)
      .type('application/octet-stream').send(Buffer.from(file.bytes));
  });
  /* A short-lived link, minted only after membership is checked. It expires long before it is
     worth passing on, which is the whole reason it can be handed to a browser at all. */
  app.get('/v1/companies/:companyId/rooms/:roomId/artifacts/:artifactId/download',async req=>{
    const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),artifactId:z.string().uuid()}),req.params);
    return artifacts.downloadUrl(p.companyId,p.roomId,await principal(req,p.companyId),p.artifactId);
  });

  app.get('/v1/companies/:companyId/rooms/:roomId/snapshot',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid()}),req.params);return service.snapshot(p.companyId,p.roomId,await principal(req,p.companyId))});
  app.get('/v1/companies/:companyId/rooms/:roomId/events',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid()}),req.params);const q=body(z.object({after_seq:z.coerce.number().int().min(0).default(0),limit:z.coerce.number().int().positive().max(500).default(100)}),req.query);return service.events(p.companyId,p.roomId,await principal(req,p.companyId),q.after_seq,q.limit)});
  registerAgentGatewayRoutes(app,agentGateway,service,agentRuntime,realtime,principal,artifacts);
  app.register(async realtimeRoutes=>{
    realtimeRoutes.get('/v1/companies/:companyId/rooms/:roomId/stream',{websocket:true},(socket,req)=>{
      void (async()=>{ try {
        const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid()}),req.params);
        const q=body(z.object({after_seq:z.coerce.number().int().min(0).optional(),principal_id:z.string().uuid().optional()}),req.query);
        let principalId:string|undefined;
        if(allowHeaderPrincipal){ const header=req.headers['x-principal-id']; principalId=typeof header==='string'?header:q.principal_id; }
        if(!principalId){ const session=await auth.resolveSession(readSessionCookie(req)); principalId=await auth.principalFor(session.userId,p.companyId); }
        await realtime.attach(socket,{companyId:p.companyId,roomId:p.roomId,principalId,afterSeq:q.after_seq});
      } catch(error) {
        const domain=error instanceof DomainError?error:new DomainError('validation_error','Invalid realtime subscription',400);
        socket.send(JSON.stringify({type:'protocol_error',code:domain.code,message:domain.message}));
        socket.close(domain.statusCode===401?4401:4400,'subscription_rejected');
      } })();
    });
  });
  const webRoot=resolve(process.cwd(),'dist/web');
  if(existsSync(webRoot)){
    app.register(fastifyStatic,{root:webRoot,wildcard:false});
    // wildcard:false registers a route per file found at boot, so a web build that lands after the
    // server starts is invisible and every hashed asset 404s into a blank page. Assets are resolved
    // per request instead; sendFile refuses anything that escapes the root.
    app.get('/assets/*',async(request,reply)=>
      reply.sendFile(join('assets',(request.params as {'*':string})['*'])));
    // '/' is already served by the static handler; these are the deep links a refresh must survive.
    for(const route of ['/home','/signup','/signin','/join','/settings','/welcome','/welcome/*','/rooms/*','/fixtures/*'])
      app.get(route,async(_request,reply)=>reply.sendFile('index.html'));
  }
  /* The bucket is checked on every boot, not assumed from the day somebody made it. Public is the
     one setting that decides whether every file in the workspace is readable by anyone who guesses
     a URL, and it can be changed in a dashboard long after this was configured. */
  app.addHook('onReady',async()=>{await storage.verify();await realtime.start()});
  app.addHook('onClose',async()=>{await realtime.stop();await pool.end()});
  return app;
}
