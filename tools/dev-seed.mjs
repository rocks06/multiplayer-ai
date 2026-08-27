#!/usr/bin/env node
// Seeds a development workspace that exercises every truthful state the room can render:
// two connected agents, agent-to-agent conversation with a stated reply, a task blocked by a
// real dependency, and a pending decision. Writes through the same services the product uses,
// so nothing here is a shape the application could not itself produce.
//
// Usage: DATABASE_URL=... node tools/dev-seed.mjs
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { RoomService } from '../dist/apps/api/src/room-service.js';
import { AgentRuntimeService } from '../dist/apps/api/src/agent-runtime/runtime-service.js';
import { AuthService, SilentSignInLinkDelivery } from '../dist/apps/api/src/auth/auth-service.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const pool = new pg.Pool({ connectionString: url });
const rooms = new RoomService(pool);
const runtime = new AgentRuntimeService(pool, rooms);
const auth = new AuthService(pool, new SilentSignInLinkDelivery());
const key = () => randomUUID();

try {
  await pool.query(`TRUNCATE ${(await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations'`)).rows.map(r => `"${r.tablename}"`).join(',')} CASCADE`);

  // A person, then the workspace they create — the authenticated product path.
  const seed = await rooms.createCompany('bootstrap');
  const human = await rooms.createHuman(seed.id, 'rocco@example.com', 'Rocco Donadon');
  const workspace = await rooms.createWorkspaceForUser(human.user_id, 'Acme');
  const me = workspace.principal_id, company = workspace.company_id;

  const project = await rooms.createProject(company, me, 'Developer API', 'Launch the public developer API');
  const room = await rooms.createRoom(company, project.id, me, 'API Launch', 'Own the launch');

  const agents = {};
  for (const name of ['Coleman', 'JJ']) {
    const agent = await rooms.createAgent(company, human.user_id, name);
    await rooms.addMember({ companyId: company, roomId: room.id, actorId: me, principalId: agent.principal_id, role: 'worker_agent', responsibilities: name === 'Coleman' ? 'Research and technical investigation' : 'Integration and implementation', idempotencyKey: key() });
    agents[name] = agent;
    // A connected connector, exactly as the Gateway records one.
    await pool.query(
      `INSERT INTO external_agent_credentials(id,company_id,agent_principal_id,token_hash,token_prefix,label,created_by_principal_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), company, agent.principal_id, [...randomUUID().replace(/-/g, ''), ...randomUUID().replace(/-/g, '')].join('').slice(0, 64), 'magc_seeded', `${name} runtime`, me]);
    await pool.query(
      `INSERT INTO external_agent_sessions(id,credential_id,company_id,agent_principal_id,room_id,session_token_hash,status,runtime_status,last_ack_room_seq)
       SELECT $1,c.id,$2,$3,$4,$5,'connected',$6,0 FROM external_agent_credentials c WHERE c.agent_principal_id=$3`,
      [randomUUID(), company, agent.principal_id, room.id, [...randomUUID().replace(/-/g, ''), ...randomUUID().replace(/-/g, '')].join('').slice(0, 64), name === 'Coleman' ? 'working' : 'idle']);
  }

  const investigate = await rooms.createTask({ companyId: company, roomId: room.id, actorId: me, title: 'Investigate rate-limit behaviour under burst load', description: 'Establish what the current gateway does when a client exceeds its quota in a short window.', assigneePrincipalId: agents.Coleman.principal_id, idempotencyKey: key() });
  const design = await rooms.createTask({ companyId: company, roomId: room.id, actorId: me, title: 'Design the published quota contract', description: 'Turn the findings into the contract we publish to developers.', assigneePrincipalId: agents.JJ.principal_id, idempotencyKey: key() });
  // JJ genuinely cannot start until Coleman reports: a modelled dependency, not an inference.
  await rooms.addTaskDependency({ companyId: company, roomId: room.id, actorId: me, taskId: design.id, dependsOnTaskId: investigate.id, idempotencyKey: key() });
  await rooms.updateTaskStatus({ companyId: company, roomId: room.id, actorId: agents.Coleman.principal_id, taskId: investigate.id, status: 'in_progress', expectedVersion: 1, idempotencyKey: key() });

  const opening = await rooms.sendMessage({ companyId: company, roomId: room.id, actorId: agents.Coleman.principal_id, addressedPrincipalId: agents.JJ.principal_id, body: 'Starting on the rate-limit investigation. Early signal: the gateway drops the connection rather than returning 429, so the published contract cannot promise a retry header yet.', idempotencyKey: key() });
  const jjHold = await rooms.sendMessage({ companyId: company, roomId: room.id, actorId: agents.JJ.principal_id, addressedPrincipalId: agents.Coleman.principal_id, inReplyToMessageId: opening.id, body: 'Understood. I will hold the contract draft until you confirm whether that is the gateway or the upstream proxy — it changes what we can commit to.', idempotencyKey: key() });
  await rooms.sendMessage({ companyId: company, roomId: room.id, actorId: me, body: 'Agreed. Please establish which layer is dropping before we promise anything publicly.', idempotencyKey: key() });

  // A longer exchange so every relationship the transcript can show actually exists here:
  // agent answering agent, a human interrupting, an agent answering the human, an unaddressed
  // room message, and a reply reaching back to the first message of the conversation.
  const colemanReply = await rooms.sendMessage({ companyId: company, roomId: room.id, actorId: agents.Coleman.principal_id, addressedPrincipalId: agents.JJ.principal_id, inReplyToMessageId: jjHold.id, body: 'Confirmed it is the upstream proxy, not our gateway. It closes the socket at the connection limit before any of our middleware runs, so nothing we do at the gateway can turn that into a 429 today.', idempotencyKey: key() });
  const interruption = await rooms.sendMessage({ companyId: company, roomId: room.id, actorId: me, body: 'Good. Before either of you commits to wording: does the proxy limit apply per client or per region? That changes what we can promise.', idempotencyKey: key() });
  await rooms.sendMessage({ companyId: company, roomId: room.id, actorId: agents.JJ.principal_id, addressedPrincipalId: me, inReplyToMessageId: interruption.id, body: 'Per region, from the configuration Coleman pulled. A single client can be throttled by traffic it did not generate, which we should say plainly in the docs rather than bury.', idempotencyKey: key() });
  await rooms.sendMessage({ companyId: company, roomId: room.id, actorId: agents.Coleman.principal_id, body: 'Noting for the room: the proxy configuration is owned by the platform team, so any fix there needs their sign-off and will not land inside this launch window.', idempotencyKey: key() });
  await rooms.sendMessage({ companyId: company, roomId: room.id, actorId: agents.JJ.principal_id, addressedPrincipalId: agents.Coleman.principal_id, inReplyToMessageId: opening.id, body: 'Coming back to your first point about the retry header — given the per-region limit, a Retry-After we compute at the gateway would be wrong often enough to be worse than omitting it.', idempotencyKey: key() });

  const decision = await runtime.requestExternalDecision({
    companyId: company, roomId: room.id, actorId: agents.Coleman.principal_id,
    title: 'Publish a 429 contract before the proxy is fixed?',
    question: 'The upstream proxy drops bursts before our gateway sees them. Should we publish a 429-with-retry contract now and fix the proxy behind it, or hold the contract until the proxy is corrected?',
    rationale: 'Publishing first unblocks the launch date but means the documented behaviour is briefly untrue under burst load.',
    proposedAction: { action: 'publish_quota_contract', status_code: 429, includes_retry_after: true, defer_proxy_fix: true },
    idempotencyKey: key(),
  });
  await rooms.updateTaskStatus({ companyId: company, roomId: room.id, actorId: agents.Coleman.principal_id, taskId: investigate.id, status: 'awaiting_decision', expectedVersion: 2, idempotencyKey: key() });

  const link = await auth.issueSignInLinkFor({ companyId: company, actorUserId: human.user_id, userId: human.user_id });
  console.log(JSON.stringify({
    workspace: workspace.name,
    company_id: company,
    room_id: room.id,
    room_url: `/rooms/${company}/${room.id}`,
    sign_in_url: `/signin?token=${link.token}`,
    decision_id: decision.decision_id ?? decision.id ?? null,
    agents: Object.fromEntries(Object.entries(agents).map(([name, a]) => [name, a.principal_id])),
  }, null, 2));
} finally {
  await pool.end();
}
