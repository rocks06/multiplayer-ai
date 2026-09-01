import {afterEach,beforeEach,describe,expect,it} from "vitest";
import * as pg from "pg";
import {buildApp} from "../apps/api/src/app.js";
import type {SignInLink,SignInLinkDelivery} from "../apps/api/src/auth/auth-service.js";
import {RoomService} from "../apps/api/src/room-service.js";
import {seedCompany,seedHuman} from "./support/bootstrap.js";
import {truncateAll} from "./support/database.js";

const {Pool}=pg;
const connectionString=process.env.DATABASE_URL;
if(!connectionString)throw new Error("DATABASE_URL is required for room invite HTTP tests");

class CapturingDelivery implements SignInLinkDelivery {
  readonly delivered:SignInLink[]=[];
  async deliver(link:SignInLink){this.delivered.push(link)}
}

describe("room invitation HTTP authorization",()=>{
  let pool:pg.Pool,app:ReturnType<typeof buildApp>,delivery:CapturingDelivery;
  const call=(method:string,url:string,payload?:unknown,headers:Record<string,string>={})=>
    app.inject({method:method as any,url,payload:payload as any,headers});
  const cookieOf=(response:any)=>String(Array.isArray(response.headers["set-cookie"])?response.headers["set-cookie"][0]:response.headers["set-cookie"]).split(";")[0]!;

  async function signIn(email:string){
    expect((await call("POST","/v1/auth/sign-in-links",{email})).statusCode).toBe(200);
    const link=delivery.delivered.filter(item=>item.email===email).at(-1)!;
    const session=await call("POST","/v1/auth/sessions",{token:link.token});
    expect(session.statusCode).toBe(200);
    const setCookie=String(session.headers["set-cookie"]);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    return cookieOf(session);
  }

  async function setupOwner(){
    const company=await seedCompany(pool,"Scoped Workspace");
    const owner=await seedHuman(pool,company.id,`owner-${crypto.randomUUID()}@example.test`,"Owner");
    const ownerEmail=(await pool.query<{email:string}>("SELECT email FROM users WHERE id=$1",[owner.user_id])).rows[0]!.email;
    const cookie=await signIn(ownerEmail);
    const project=(await call("POST",`/v1/companies/${company.id}/projects`,{name:"Invited Project",objective:"Collaborate"},{cookie})).json();
    const invitedRoom=(await call("POST",`/v1/companies/${company.id}/projects/${project.id}/rooms`,{name:"Invited Room",responsibilities:"Manage"},{cookie})).json();
    const otherProject=(await call("POST",`/v1/companies/${company.id}/projects`,{name:"Private Project",objective:"Private"},{cookie})).json();
    const otherRoom=(await call("POST",`/v1/companies/${company.id}/projects/${otherProject.id}/rooms`,{name:"Private Room",responsibilities:"Manage"},{cookie})).json();
    return {company,owner,cookie,project,invitedRoom,otherProject,otherRoom};
  }

  beforeEach(async()=>{
    const bootstrap=new Pool({connectionString});await truncateAll(bootstrap);await bootstrap.end();
    pool=new Pool({connectionString});delivery=new CapturingDelivery();
    app=buildApp(pool,{pollIntervalMs:20},{allowHeaderPrincipal:false,cookieSecure:false,signInDelivery:delivery});
    await app.ready();
  });
  afterEach(async()=>{await app.close()});

  it("resumes a signed-out new account through a real cookie and grants only the invited room",async()=>{
    const x=await setupOwner();
    expect((await call("POST",`/v1/companies/${x.company.id}/rooms/${x.invitedRoom.id}/invites`,{})).statusCode).toBe(401);
    const issued=await call("POST",`/v1/companies/${x.company.id}/rooms/${x.invitedRoom.id}/invites`,{ttl_hours:2},{cookie:x.cookie});
    expect(issued.statusCode).toBe(200);
    const token=issued.json().invite_token as string;

    // Preview is possession-gated but does not need an account. Acceptance does.
    expect((await call("POST","/v1/room-invites/preview",{token})).json()).toMatchObject({company_name:"Scoped Workspace",room_name:"Invited Room"});
    expect((await call("POST","/v1/room-invites/accept",{token})).statusCode).toBe(401);

    const email=`invitee-${crypto.randomUUID()}@example.test`;
    expect((await call("POST","/v1/auth/sign-up",{name:"Invited Human",email})).statusCode).toBe(200);
    const signupLink=delivery.delivered.filter(item=>item.email===email).at(-1)!;
    const session=await call("POST","/v1/auth/sessions",{token:signupLink.token});
    const cookie=cookieOf(session);
    expect(cookie).toMatch(/^mpai_session=/);

    const accepted=await call("POST","/v1/room-invites/accept",{token},{cookie});
    expect(accepted.statusCode).toBe(200);
    const principalId=accepted.json().principal_id as string;
    const userId=session.json().user.id as string;

    const companyMembership=await pool.query("SELECT status,access_scope FROM company_users WHERE company_id=$1 AND user_id=$2",[x.company.id,userId]);
    expect(companyMembership.rows[0]).toEqual({status:"active",access_scope:"room_only"});
    expect((await call("GET",`/v1/companies/${x.company.id}/rooms/${x.invitedRoom.id}/snapshot`,undefined,{cookie})).statusCode).toBe(200);
    expect((await call("POST",`/v1/companies/${x.company.id}/rooms/${x.invitedRoom.id}/messages`,{body:"I joined"},{cookie,"idempotency-key":crypto.randomUUID()})).statusCode).toBe(200);

    // Room discovery is restricted to memberships, not the company container record.
    const rooms=await call("GET",`/v1/companies/${x.company.id}/rooms`,undefined,{cookie});
    expect(rooms.statusCode).toBe(200);
    expect(rooms.json().rooms.map((room:any)=>room.room_id)).toEqual([x.invitedRoom.id]);
    expect((await call("GET",`/v1/companies/${x.company.id}/rooms/${x.otherRoom.id}/snapshot`,undefined,{cookie})).statusCode).toBe(403);

    // Workspace-wide reads and mutations remain unavailable.
    expect((await call("GET",`/v1/companies/${x.company.id}/agents`,undefined,{cookie})).statusCode).toBe(403);
    expect((await call("POST",`/v1/companies/${x.company.id}/agents`,{name:"Unauthorized Agent"},{cookie})).statusCode).toBe(403);
    expect((await call("POST",`/v1/companies/${x.company.id}/projects`,{name:"Unauthorized",objective:"No"},{cookie})).statusCode).toBe(403);
    expect((await call("POST",`/v1/companies/${x.company.id}/projects/${x.project.id}/rooms`,{name:"Unauthorized Room"},{cookie})).statusCode).toBe(403);
    expect((await call("PATCH",`/v1/companies/${x.company.id}/projects/${x.project.id}/objective`,{objective:"Changed",expected_objective:"Collaborate"},{cookie})).statusCode).toBe(403);
    expect((await call("POST",`/v1/companies/${x.company.id}/users/${userId}/sign-in-links`,{},{cookie})).statusCode).toBe(403);
    expect((await call("POST",`/v1/companies/${x.company.id}/rooms/${x.invitedRoom.id}/invites`,{},{cookie})).statusCode).toBe(403);
    expect((await call("POST",`/v1/companies/${x.company.id}/rooms/${x.invitedRoom.id}/members`,{principal_id:principalId,role:"manager",responsibilities:""},{cookie,"idempotency-key":crypto.randomUUID()})).statusCode).toBe(403);
    // Even if a separate room-level action later promotes this principal, room management alone
    // must never become workspace authority or permission to mint more invitations.
    await pool.query("UPDATE room_members SET role='manager' WHERE company_id=$1 AND room_id=$2 AND principal_id=$3",[x.company.id,x.invitedRoom.id,principalId]);
    expect((await call("POST",`/v1/companies/${x.company.id}/rooms/${x.invitedRoom.id}/invites`,{},{cookie})).statusCode).toBe(403);

    expect((await pool.query("SELECT count(*)::int n FROM projects WHERE company_id=$1",[x.company.id])).rows[0].n).toBe(2);
    expect((await pool.query("SELECT count(*)::int n FROM rooms WHERE company_id=$1",[x.company.id])).rows[0].n).toBe(2);
    expect((await pool.query("SELECT count(*)::int n FROM agents WHERE company_id=$1",[x.company.id])).rows[0].n).toBe(0);
  });

  it("preserves a separately granted active workspace membership but does not revive removed workspace access",async()=>{
    const x=await setupOwner();
    const roomService=new RoomService(pool);
    const active=await roomService.createHuman(x.company.id,`active-${crypto.randomUUID()}@example.test`,"Active Member");
    const activeEmail=(await pool.query<{email:string}>("SELECT email FROM users WHERE id=$1",[active.user_id])).rows[0]!.email;
    const activeCookie=await signIn(activeEmail);
    const activeInvite=(await call("POST",`/v1/companies/${x.company.id}/rooms/${x.invitedRoom.id}/invites`,{},{cookie:x.cookie})).json();
    expect((await call("POST","/v1/room-invites/accept",{token:activeInvite.invite_token},{cookie:activeCookie})).statusCode).toBe(200);
    expect((await pool.query("SELECT access_scope FROM company_users WHERE company_id=$1 AND user_id=$2",[x.company.id,active.user_id])).rows[0].access_scope).toBe("workspace");

    const removed=await roomService.createHuman(x.company.id,`removed-${crypto.randomUUID()}@example.test`,"Removed Member");
    await pool.query("UPDATE company_users SET status='removed' WHERE company_id=$1 AND user_id=$2",[x.company.id,removed.user_id]);
    const removedEmail=(await pool.query<{email:string}>("SELECT email FROM users WHERE id=$1",[removed.user_id])).rows[0]!.email;
    const removedCookie=await signIn(removedEmail);
    const removedInvite=(await call("POST",`/v1/companies/${x.company.id}/rooms/${x.invitedRoom.id}/invites`,{},{cookie:x.cookie})).json();
    expect((await call("POST","/v1/room-invites/accept",{token:removedInvite.invite_token},{cookie:removedCookie})).statusCode).toBe(200);
    expect((await pool.query("SELECT status,access_scope FROM company_users WHERE company_id=$1 AND user_id=$2",[x.company.id,removed.user_id])).rows[0]).toEqual({status:"active",access_scope:"room_only"});
  });
});
