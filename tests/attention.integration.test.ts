import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pg from "pg";
import { buildApp } from "../apps/api/src/app.js";
import { RoomInviteService } from "../apps/api/src/invites/room-invite-service.js";
import { isRelevantActionable, messageWakes } from "../packages/connector-core/src/relevance.js";
import { FakeExternalAgentClient } from "./fake-external-agent.js";
import { seedCompany, seedHuman } from "./support/bootstrap.js";
import { truncateAll } from "./support/database.js";

/**
 * Mentions, unread state, notifications and ownership, against a real database and the real routes.
 * Every name here is a fixture.
 */
const connectionString = process.env.DATABASE_URL!;
let pool: pg.Pool, app: ReturnType<typeof buildApp>, baseUrl: string;
const clients = new Set<FakeExternalAgentClient>();

beforeEach(async () => {
  const bootstrap = new pg.Pool({ connectionString }); await truncateAll(bootstrap); await bootstrap.end();
  pool = new pg.Pool({ connectionString });
  app = buildApp(pool, { pollIntervalMs: 20 }, { allowHeaderPrincipal: true, notificationSettleSeconds: 0 });
  baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
});
afterEach(async () => { for (const client of clients) client.close(); clients.clear(); await app.close(); });

let keys = 0;
const as = (principalId: string, extra: Record<string, string> = {}) => ({ "x-principal-id": principalId, ...extra });
const call = async (method: string, url: string, principalId: string, payload?: unknown) =>
  app.inject({ method: method as any, url, payload: payload as any, headers: as(principalId, method === "GET" ? {} : { "idempotency-key": `k-${++keys}` }) });

async function fixture() {
  const company = await seedCompany(pool, "Fixture Workspace");
  const owner = await seedHuman(pool, company.id, `${crypto.randomUUID()}@example.test`, "Fixture Owner");
  const colleague = await seedHuman(pool, company.id, `${crypto.randomUUID()}@example.test`, "Fixture Colleague");
  const project = (await call("POST", `/v1/companies/${company.id}/projects`, owner.principal_id, { name: "Project", objective: "Coordinate" })).json();
  const room = (await call("POST", `/v1/companies/${company.id}/projects/${project.id}/rooms`, owner.principal_id, { name: "Fixture Room" })).json();
  const url = (path: string) => `/v1/companies/${company.id}${path}`;
  await call("POST", url(`/rooms/${room.id}/members`), owner.principal_id, { principal_id: colleague.principal_id, role: "contributor", responsibilities: "" });
  const agent = async (name: string, join = true) => {
    const created = (await call("POST", url(`/agents`), owner.principal_id, { name })).json();
    if (join) await call("POST", url(`/rooms/${room.id}/members`), owner.principal_id, { principal_id: created.principal_id, role: "worker_agent", responsibilities: "" });
    const credential = (await call("POST", url(`/agents/${created.principal_id}/gateway-credentials`), owner.principal_id, { label: name })).json();
    const client = new FakeExternalAgentClient(baseUrl); clients.add(client);
    if (join) expect((await client.open(credential.credential_token, room.id)).status).toBe(200);
    return { ...created, credential, client };
  };
  const first = await agent("Fixture Agent One"), second = await agent("Fixture Agent Two");
  return { company, owner, colleague, project, room, url, first, second, agent };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const token = (name: string) => `@${name}`;
const mention = (body: string, principalId: string, name: string) => {
  const start = body.indexOf(token(name));
  return { principal_id: principalId, start, end: start + token(name).length };
};
const say = (f: Fixture, from: string, body: string, extra: Record<string, unknown> = {}) =>
  call("POST", f.url(`/rooms/${f.room.id}/messages`), from, { body, ...extra });
const agentSays = (a: Fixture["first"], body: string, extra: Record<string, unknown>, key = `agent-${++keys}`) =>
  fetch(`${baseUrl}/v1/agent-gateway/v1/sessions/${a.client.sessionId}/messages`, {
    method: "POST", headers: { authorization: `Bearer ${a.client.sessionToken}`, "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ body, ...extra }) });
const roomFor = async (f: Fixture, principalId: string, companyId = f.company.id, roomId = f.room.id) =>
  (await call("GET", `/v1/companies/${companyId}/rooms`, principalId)).json().rooms.find((r: any) => r.room_id === roomId);
const notificationsFor = async (principalId: string, after?: string) =>
  (await app.inject({ method: "GET", url: `/v1/me/notifications${after ? `?after=${after}` : ""}`, headers: as(principalId) })).json();
const messageEvent = async (f: Fixture, messageId: string) =>
  (await pool.query(`SELECT * FROM room_events WHERE room_id=$1 AND entity_id=$2 AND event_type='message.sent'`, [f.room.id, messageId])).rows;
const asMarker = (event: any) => ({ key: String(event.id), type: "room.event" as const, event: { ...event, room_seq: Number(event.room_seq) } });
const noLookups = { getDecision: async () => null, listTasks: async () => [] };

describe("structured mentions", () => {
  it("a person mentions a person: stored as structure, counted for them, notified once", async () => {
    const f = await fixture();
    const cursor = (await notificationsFor(f.colleague.principal_id)).cursor;
    const body = `${token("Fixture Colleague")} can you review this?`;
    const sent = await say(f, f.owner.principal_id, body, { mentions: [mention(body, f.colleague.principal_id, "Fixture Colleague")] });
    expect(sent.statusCode).toBe(200);
    // Said to a person: no agent is prompted to answer it.
    const [event] = await messageEvent(f, sent.json().id);
    for (const a of [f.first, f.second]) expect(messageWakes(event, a.principal_id)).toBe(false);
    expect(sent.json().mentioned_principal_ids).toEqual([f.colleague.principal_id]);
    const snapshot = (await call("GET", f.url(`/rooms/${f.room.id}/snapshot`), f.owner.principal_id)).json();
    expect(snapshot.messages.at(-1).mentions).toEqual([{ principal_id: f.colleague.principal_id, start: 0, end: token("Fixture Colleague").length, display_name: "Fixture Colleague", kind: "human" }]);
    expect(await roomFor(f, f.colleague.principal_id)).toMatchObject({ unread_count: 1, mention_count: 1, action_count: 0 });
    const feed = await notificationsFor(f.colleague.principal_id, cursor);
    expect(feed.notifications).toEqual([expect.objectContaining({ kind: "mention", category: "mention", room_id: f.room.id,
      link: `multiplayerai://room?company=${f.company.id}&room=${f.room.id}&focus=${encodeURIComponent(`message:${sent.json().id}`)}` })]);
    expect((await notificationsFor(f.colleague.principal_id, feed.cursor)).notifications).toEqual([]);
    expect((await notificationsFor(f.owner.principal_id, cursor)).notifications).toEqual([]);
  });

  it("a person mentions an agent: only the mentioned agent wakes, and a message naming no agent still reaches every agent", async () => {
    const f = await fixture();
    const body = `${token("Fixture Agent One")} please draft the outline`;
    const sent = (await say(f, f.owner.principal_id, body, { mentions: [mention(body, f.first.principal_id, "Fixture Agent One")] })).json();
    const [event] = await messageEvent(f, sent.id);
    expect(event.payload.mentions).toEqual([{ principal_id: f.first.principal_id, kind: "agent", start: 0, end: token("Fixture Agent One").length }]);
    expect(await isRelevantActionable(asMarker(event), f.first.principal_id, noLookups)).toBe(true);
    expect(await isRelevantActionable(asMarker(event), f.second.principal_id, noLookups)).toBe(false);
    const plain = (await say(f, f.owner.principal_id, "Everyone, a general update")).json();
    const [broadcast] = await messageEvent(f, plain.id);
    for (const a of [f.first, f.second]) expect(messageWakes(broadcast, a.principal_id)).toBe(true);
  });

  it("an agent mentions a person by writing @Name and naming them; the server places the mention", async () => {
    const f = await fixture();
    const cursor = (await notificationsFor(f.owner.principal_id)).cursor;
    const response = await agentSays(f.first, `Draft is ready. ${token("Fixture Owner")} please approve the scope.`, { mentions: [{ principal_id: f.owner.principal_id }] });
    expect(response.status).toBe(200);
    const sent = await response.json();
    const snapshot = (await call("GET", f.url(`/rooms/${f.room.id}/snapshot`), f.owner.principal_id)).json();
    expect(snapshot.messages.at(-1).mentions[0]).toMatchObject({ principal_id: f.owner.principal_id, start: "Draft is ready. ".length, kind: "human" });
    expect((await notificationsFor(f.owner.principal_id, cursor)).notifications).toEqual([expect.objectContaining({ id: expect.any(String), kind: "mention", title: "Fixture Agent One mentioned you" })]);
    expect(sent.mentioned_principal_ids).toEqual([f.owner.principal_id]);
  });

  it("an agent mentions an agent: a real, persisted handoff that wakes that agent once, and not the sender", async () => {
    const f = await fixture();
    f.second.client.roomId = f.room.id; await f.second.client.connect(0);
    const response = await agentSays(f.first, `${token("Fixture Agent Two")} take the next step`, { mentions: [{ principal_id: f.second.principal_id }] });
    const sent = await response.json();
    const events = await messageEvent(f, sent.id);
    expect(events).toHaveLength(1);
    expect(events[0].actor_principal_id).toBe(f.first.principal_id);
    expect(await isRelevantActionable(asMarker(events[0]), f.second.principal_id, noLookups)).toBe(true);
    expect(await isRelevantActionable(asMarker(events[0]), f.first.principal_id, noLookups)).toBe(false);
    const frame = await f.second.client.waitFor((x: any) => x.type === "room.event" && x.event.entity_id === sent.id);
    expect(frame.event.payload.mentions[0]).toMatchObject({ principal_id: f.second.principal_id, kind: "agent" });
    // A retry of the same send is the same event: nothing to wake twice.
    await agentSays(f.first, `${token("Fixture Agent Two")} take the next step`, { mentions: [{ principal_id: f.second.principal_id }] }, "same-key");
    await agentSays(f.first, `${token("Fixture Agent Two")} take the next step`, { mentions: [{ principal_id: f.second.principal_id }] }, "same-key");
    expect((await pool.query(`SELECT count(*)::int n FROM room_events WHERE room_id=$1 AND event_type='message.sent' AND actor_principal_id=$2`, [f.room.id, f.first.principal_id])).rows[0].n).toBe(2);
  });

  it("sent to an agent and mentioning the same agent is one event and one wake", async () => {
    const f = await fixture();
    const body = `${token("Fixture Agent One")} this one is yours`;
    const sent = (await say(f, f.owner.principal_id, body, { addressed_principal_id: f.first.principal_id, mentions: [mention(body, f.first.principal_id, "Fixture Agent One")] })).json();
    const events = await messageEvent(f, sent.id);
    expect(events).toHaveLength(1);
    const markers = new Map(events.map((event: any) => [asMarker(event).key, asMarker(event)]));
    expect(markers.size).toBe(1);
    expect(messageWakes(events[0], f.first.principal_id)).toBe(true);
    expect(messageWakes(events[0], f.second.principal_id)).toBe(false);
  });

  it("refuses a mention of anyone outside the room, a spoofed range, or a name that is not written", async () => {
    const f = await fixture();
    const outsider = await f.agent("Fixture Outsider", false);
    const other = await seedCompany(pool, "Other Workspace");
    const stranger = await seedHuman(pool, other.id, `${crypto.randomUUID()}@example.test`, "Fixture Stranger");
    const cases = [
      { body: "@Fixture Outsider hello", mentions: [{ principal_id: outsider.principal_id, start: 0, end: 17 }] },
      { body: "@Fixture Stranger hello", mentions: [{ principal_id: stranger.principal_id, start: 0, end: 17 }] },
      // A real member's id over somebody else's name.
      { body: "@Fixture Colleague hello", mentions: [{ principal_id: f.first.principal_id, start: 0, end: 18 }] },
      { body: "@Fixture Colleague", mentions: [{ principal_id: f.colleague.principal_id, start: 0, end: 99 }] },
      { body: "hello there", mentions: [{ principal_id: f.colleague.principal_id }] },
    ];
    for (const attempt of cases) {
      const response = await say(f, f.owner.principal_id, attempt.body, { mentions: attempt.mentions });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("invalid_mentions");
    }
    expect((await pool.query(`SELECT count(*)::int n FROM messages WHERE room_id=$1`, [f.room.id])).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int n FROM message_mentions`)).rows[0].n).toBe(0);
  });
});

describe("unread room state", () => {
  it("counts what others said since this person last read, clears on read, and never goes backwards", async () => {
    const f = await fixture();
    expect(await roomFor(f, f.colleague.principal_id)).toMatchObject({ unread_count: 0, latest: null });
    await say(f, f.owner.principal_id, "First update");
    const second = (await say(f, f.owner.principal_id, "Second update")).json();
    const room = await roomFor(f, f.colleague.principal_id);
    expect(room).toMatchObject({ unread_count: 2, mention_count: 0 });
    expect(room.latest).toMatchObject({ event_type: "message.sent", actor_display_name: "Fixture Owner", text: "Second update" });
    // Own messages are never unread to their sender.
    expect(await roomFor(f, f.owner.principal_id)).toMatchObject({ unread_count: 0 });
    const read = await call("POST", f.url(`/rooms/${f.room.id}/read`), f.colleague.principal_id, { room_seq: second.room_seq });
    expect(read.json().last_read_seq).toBe(second.room_seq);
    expect(await roomFor(f, f.colleague.principal_id)).toMatchObject({ unread_count: 0 });
    await call("POST", f.url(`/rooms/${f.room.id}/read`), f.colleague.principal_id, { room_seq: 1 });
    expect((await roomFor(f, f.colleague.principal_id)).last_read_seq).toBe(second.room_seq);
    await call("POST", f.url(`/rooms/${f.room.id}/read`), f.colleague.principal_id, { room_seq: 1_000_000 });
    expect((await roomFor(f, f.colleague.principal_id)).last_read_seq).toBe((await roomFor(f, f.colleague.principal_id)).last_event_seq);
    await say(f, f.owner.principal_id, "Third update");
    expect(await roomFor(f, f.colleague.principal_id)).toMatchObject({ unread_count: 1 });
  });

  it("keeps a separate read position for each person", async () => {
    const f = await fixture();
    const sent = (await agentSays(f.first, "Findings are in", {}).then(r => r.json()));
    for (const person of [f.owner, f.colleague]) expect(await roomFor(f, person.principal_id)).toMatchObject({ unread_count: 1 });
    await call("POST", f.url(`/rooms/${f.room.id}/read`), f.owner.principal_id, { room_seq: sent.room_seq });
    expect(await roomFor(f, f.owner.principal_id)).toMatchObject({ unread_count: 0 });
    expect(await roomFor(f, f.colleague.principal_id)).toMatchObject({ unread_count: 1 });
    const outsider = await seedHuman(pool, f.company.id, `${crypto.randomUUID()}@example.test`, "Fixture Non Member");
    expect((await call("POST", f.url(`/rooms/${f.room.id}/read`), outsider.principal_id, { room_seq: 1 })).statusCode).toBe(403);
  });

  it("works for a room shared from another workspace, and for that person's notifications", async () => {
    const f = await fixture();
    const user = await pool.query<{ id: string }>(`INSERT INTO users(id,email,display_name) VALUES(gen_random_uuid(),$1,'Fixture Guest') RETURNING id`, [`${crypto.randomUUID()}@example.test`]);
    const invites = new RoomInviteService(pool);
    const invite = await invites.issue({ companyId: f.company.id, roomId: f.room.id, actorId: f.owner.principal_id, ttlHours: 1 });
    const guest = await invites.accept(invite.invite_token, user.rows[0]!.id);
    const cursor = (await notificationsFor(guest.principal_id)).cursor;
    const body = `${token("Fixture Guest")} welcome, here is the brief`;
    await say(f, f.owner.principal_id, body, { mentions: [mention(body, guest.principal_id, "Fixture Guest")] });
    expect(await roomFor(f, guest.principal_id)).toMatchObject({ unread_count: 1, mention_count: 1 });
    expect((await notificationsFor(guest.principal_id, cursor)).notifications).toEqual([expect.objectContaining({ kind: "mention", room_id: f.room.id })]);
  });

  it("presence and session changes alone are not unread", async () => {
    const f = await fixture();
    await f.first.client.connect(0);
    await f.first.client.heartbeat("working");
    await f.first.client.disconnect();
    expect(await roomFor(f, f.owner.principal_id)).toMatchObject({ unread_count: 0, latest: null });
  });
});

describe("notifications", () => {
  it("are produced once however often the same send is retried or the feed is read", async () => {
    const f = await fixture();
    const cursor = (await notificationsFor(f.colleague.principal_id)).cursor;
    const body = `${token("Fixture Colleague")} once only`;
    const payload = { body, mentions: [mention(body, f.colleague.principal_id, "Fixture Colleague")] };
    for (let i = 0; i < 3; i++) await app.inject({ method: "POST", url: f.url(`/rooms/${f.room.id}/messages`), payload, headers: as(f.owner.principal_id, { "idempotency-key": "retried-send" }) });
    const first = await notificationsFor(f.colleague.principal_id, cursor);
    expect(first.notifications).toHaveLength(1);
    // Reading from the same cursor again (a reconnect) returns the same notification id, never a second one.
    expect((await notificationsFor(f.colleague.principal_id, cursor)).notifications.map((n: any) => n.id)).toEqual(first.notifications.map((n: any) => n.id));
    expect((await notificationsFor(f.colleague.principal_id, first.cursor)).notifications).toEqual([]);
  });

  it("are not produced for what the person has already read", async () => {
    const f = await fixture();
    const cursor = (await notificationsFor(f.colleague.principal_id)).cursor;
    const body = `${token("Fixture Colleague")} already seen`;
    const sent = (await say(f, f.owner.principal_id, body, { mentions: [mention(body, f.colleague.principal_id, "Fixture Colleague")] })).json();
    await call("POST", f.url(`/rooms/${f.room.id}/read`), f.colleague.principal_id, { room_seq: sent.room_seq });
    expect((await notificationsFor(f.colleague.principal_id, cursor)).notifications).toEqual([]);
  });

  it("a direct message is its own kind; an ordinary message to everyone notifies nobody", async () => {
    const f = await fixture();
    const cursor = (await notificationsFor(f.colleague.principal_id)).cursor;
    await say(f, f.owner.principal_id, "Just for you", { addressed_principal_id: f.colleague.principal_id });
    await say(f, f.owner.principal_id, "General chatter");
    expect((await notificationsFor(f.colleague.principal_id, cursor)).notifications.map((n: any) => n.kind)).toEqual(["direct_message"]);
  });

  it("keeps Needs You for real authority: a decision is action required for managers only, a mention is not", async () => {
    const f = await fixture();
    const ownerCursor = (await notificationsFor(f.owner.principal_id)).cursor;
    const colleagueCursor = (await notificationsFor(f.colleague.principal_id)).cursor;
    const body = `${token("Fixture Owner")} fyi`;
    await say(f, f.colleague.principal_id, body, { mentions: [mention(body, f.owner.principal_id, "Fixture Owner")] });
    const decision = await f.first.client.requestDecision({ title: "Publish the draft", question: "Publish now?", proposed_action: { type: "publish" } }, "decision-1");
    expect(decision.status).toBe(200);
    const snapshot = (await call("GET", f.url(`/rooms/${f.room.id}/snapshot`), f.owner.principal_id)).json();
    expect(snapshot.briefing.unresolved_decisions.map((d: any) => d.title)).toEqual(["Publish the draft"]);
    const owner = await notificationsFor(f.owner.principal_id, ownerCursor);
    expect(owner.notifications.map((n: any) => [n.kind, n.category])).toEqual([["mention", "mention"], ["decision_requested", "action_required"]]);
    expect(owner.notifications[1].link).toContain(encodeURIComponent(`decision:${decision.body.id ?? decision.body.decision_id}`));
    expect((await notificationsFor(f.colleague.principal_id, colleagueCursor)).notifications).toEqual([]);
    expect(await roomFor(f, f.owner.principal_id)).toMatchObject({ mention_count: 1, action_count: 1 });
    expect(await roomFor(f, f.colleague.principal_id)).toMatchObject({ action_count: 0 });
  });

  it("tells a manager when an agent finishes or is blocked, and nobody about bookkeeping", async () => {
    const f = await fixture();
    const cursor = (await notificationsFor(f.owner.principal_id)).cursor;
    const task = (await call("POST", f.url(`/rooms/${f.room.id}/tasks`), f.owner.principal_id, { title: "Write the summary", description: "", assignee_principal_id: f.first.principal_id })).json();
    const started = await f.first.client.updateTask(task.id, "in_progress", task.version, "start");
    const blocked = await f.first.client.updateTask(task.id, "blocked", started.body.version, "block");
    const resumed = await f.first.client.updateTask(task.id, "in_progress", blocked.body.version, "resume");
    expect((await f.first.client.completeTask(task.id, resumed.body.version, "complete")).status).toBe(200);
    const feed = await notificationsFor(f.owner.principal_id, cursor);
    expect(feed.notifications.map((n: any) => [n.kind, n.category, n.body])).toEqual([
      ["agent_blocked", "action_required", "Write the summary"],
      ["agent_finished", "informational", "Write the summary"],
    ]);
  });
});

describe("human and agent ownership", () => {
  it("records who owns which agents, supports several per person, and never implies room membership", async () => {
    const f = await fixture();
    const agents = (await call("GET", f.url(`/agents`), f.owner.principal_id)).json().agents;
    const owners = (principalId: string) => agents.find((a: any) => a.principal_id === principalId).owners.map((o: any) => o.principal_id);
    expect(owners(f.first.principal_id)).toEqual([f.owner.principal_id]);
    expect(owners(f.second.principal_id)).toEqual([f.owner.principal_id]);
    // A person claims an agent for themselves; an agent can have more than one owner.
    const claimed = await call("POST", f.url(`/agents/${f.first.principal_id}/owners`), f.colleague.principal_id, { human_principal_id: f.colleague.principal_id });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().owners.map((o: any) => o.display_name)).toEqual(["Fixture Colleague", "Fixture Owner"]);
    // Naming somebody else takes being an owner already.
    expect((await call("POST", f.url(`/agents/${f.second.principal_id}/owners`), f.colleague.principal_id, { human_principal_id: f.owner.principal_id })).statusCode).toBe(403);
    expect((await call("POST", f.url(`/agents/${f.owner.principal_id}/owners`), f.owner.principal_id, { human_principal_id: f.owner.principal_id })).statusCode).toBe(400);
    const snapshot = (await call("GET", f.url(`/rooms/${f.room.id}/snapshot`), f.first.principal_id)).json();
    expect(snapshot.relationships.filter((r: any) => r.human_principal_id === f.owner.principal_id).map((r: any) => r.agent_principal_id).sort())
      .toEqual([f.first.principal_id, f.second.principal_id].sort());
    // Owning an agent does not put it in a room.
    const unjoined = await f.agent("Fixture Agent Three", false);
    expect((await call("GET", f.url(`/agents`), f.owner.principal_id)).json().agents.find((a: any) => a.principal_id === unjoined.principal_id)).toMatchObject({ rooms: [], owners: [expect.objectContaining({ principal_id: f.owner.principal_id })] });
    expect((await call("DELETE", f.url(`/agents/${f.first.principal_id}/owners/${f.colleague.principal_id}`), f.owner.principal_id)).json().owners.map((o: any) => o.principal_id)).toEqual([f.owner.principal_id]);
  });
});
