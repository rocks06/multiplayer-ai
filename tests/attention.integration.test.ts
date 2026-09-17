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

  it("a person mentions an agent: only that agent wakes; Everyone without a mention and a hand-typed name wake no agent", async () => {
    const f = await fixture();
    const body = `${token("Fixture Agent One")} please draft the outline`;
    const sent = (await say(f, f.owner.principal_id, body, { mentions: [mention(body, f.first.principal_id, "Fixture Agent One")] })).json();
    const [event] = await messageEvent(f, sent.id);
    expect(event.payload.mentions).toEqual([{ principal_id: f.first.principal_id, kind: "agent", start: 0, end: token("Fixture Agent One").length }]);
    expect(await isRelevantActionable(asMarker(event), f.first.principal_id, noLookups)).toBe(true);
    expect(await isRelevantActionable(asMarker(event), f.second.principal_id, noLookups)).toBe(false);
    expect(event.payload.wake_principal_ids).toEqual([f.first.principal_id]);
    // To Everyone with no agent mentioned: context for every agent, a prompt for none.
    const plain = (await say(f, f.owner.principal_id, "Everyone, a general update")).json();
    const [broadcast] = await messageEvent(f, plain.id);
    expect(broadcast.payload.wake_principal_ids).toEqual([]);
    for (const a of [f.first, f.second]) expect(messageWakes(broadcast, a.principal_id)).toBe(false);
    // "@Name" typed by hand, never chosen, is plain text: no mention stored, nobody woken.
    const typed = (await say(f, f.owner.principal_id, `${token("Fixture Agent One")} typed by hand`)).json();
    const [handTyped] = await messageEvent(f, typed.id);
    expect(handTyped.payload.mentions).toEqual([]);
    expect(handTyped.payload.wake_principal_ids).toEqual([]);
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

describe("who a message wakes", () => {
  const wakes = async (f: Fixture, messageId: string) => (await messageEvent(f, messageId))[0].payload.wake_principal_ids;

  it("a person mentioning a person wakes no agent; an agent mentioning a person wakes no agent and tells that person", async () => {
    const f = await fixture();
    const body = `${token("Fixture Colleague")} over to you`;
    const human = (await say(f, f.owner.principal_id, body, { mentions: [mention(body, f.colleague.principal_id, "Fixture Colleague")] })).json();
    expect(await wakes(f, human.id)).toEqual([]);
    const cursor = (await notificationsFor(f.owner.principal_id)).cursor;
    const agent = await (await agentSays(f.first, `${token("Fixture Owner")} the draft is ready`, { mentions: [{ principal_id: f.owner.principal_id }] })).json();
    expect(await wakes(f, agent.id)).toEqual([]);
    expect(await roomFor(f, f.owner.principal_id)).toMatchObject({ mention_count: 1 });
    expect((await notificationsFor(f.owner.principal_id, cursor)).notifications.map((n: any) => n.kind)).toEqual(["mention"]);
  });

  it("an agent mentioning an agent wakes that agent exactly once; Send to plus a mention of the same agent is one wake", async () => {
    const f = await fixture();
    const handoff = await (await agentSays(f.first, `${token("Fixture Agent Two")} please check the numbers`, { mentions: [{ principal_id: f.second.principal_id }] })).json();
    expect(await messageEvent(f, handoff.id)).toHaveLength(1);
    expect(await wakes(f, handoff.id)).toEqual([f.second.principal_id]);
    const body = `${token("Fixture Agent One")} this is yours`;
    const direct = (await say(f, f.owner.principal_id, body, { addressed_principal_id: f.first.principal_id, mentions: [mention(body, f.first.principal_id, "Fixture Agent One")] })).json();
    expect(await wakes(f, direct.id)).toEqual([f.first.principal_id]);
  });
});

describe("bounded agent collaboration", () => {
  const collaboration = async (f: Fixture) => (await pool.query(`SELECT * FROM agent_collaborations WHERE room_id=$1 ORDER BY created_at DESC LIMIT 1`, [f.room.id])).rows[0];
  const turn = async (a: Fixture["first"], body: string, extra: Record<string, unknown> = {}) => {
    const sent = await (await agentSays(a, body, extra)).json();
    return (await pool.query(`SELECT payload FROM room_events WHERE entity_id=$1 AND event_type='message.sent'`, [sent.id])).rows[0].payload;
  };

  it("continues without re-mentioning, every turn a persisted message, and stops when its turn budget is spent", async () => {
    const f = await fixture();
    const opened = await turn(f.first, `${token("Fixture Agent Two")} let us work this out`, { mentions: [{ principal_id: f.second.principal_id }] });
    expect(opened.wake_principal_ids).toEqual([f.second.principal_id]);
    expect(opened.collaboration).toMatchObject({ status: "active", turn: 1, max_turns: 12 });
    // The reply mentions nobody, and still reaches the other participant: the conversation goes on.
    const reply = await turn(f.second, "Numbers checked, one correction needed");
    expect(reply.wake_principal_ids).toEqual([f.first.principal_id]);
    expect(reply.collaboration).toMatchObject({ id: opened.collaboration.id, turn: 2 });
    let last = reply;
    for (let i = 3; i <= 12; i++) last = await turn(i % 2 ? f.first : f.second, `Turn ${i}`);
    // The budget's last turn wakes nobody, and the collaboration is over.
    expect(last.collaboration).toMatchObject({ status: "exhausted", turn: 12 });
    expect(last.wake_principal_ids).toEqual([]);
    expect(await collaboration(f)).toMatchObject({ status: "exhausted", ended_reason: "max_turns", turn_count: 12 });
    const after = await turn(f.first, "Anything else?");
    expect(after.wake_principal_ids).toEqual([]);
    expect((await pool.query(`SELECT count(*)::int n FROM room_events WHERE room_id=$1 AND event_type='message.sent'`, [f.room.id])).rows[0].n).toBe(13);
  });

  it("converges on one result: a contributor finishing wakes only the lead, and only the lead ends it", async () => {
    const f = await fixture();
    const opened = await turn(f.first, `${token("Fixture Agent Two")} please check my draft`, { mentions: [{ principal_id: f.second.principal_id }] });
    // The agent that started it leads.
    expect(opened.collaboration).toMatchObject({ lead_principal_id: f.first.principal_id, finalizing: false });
    const contributorDone = await turn(f.second, "Checked: two corrections, otherwise ready", { collaboration_done: true });
    expect(contributorDone.wake_principal_ids).toEqual([f.first.principal_id]);
    expect(contributorDone.collaboration).toMatchObject({ status: "active", finalizing: true });
    const final = await turn(f.first, "Final version attached", { collaboration_done: true });
    expect(final.wake_principal_ids).toEqual([]);
    expect(final.collaboration).toMatchObject({ status: "completed" });
    expect((await turn(f.second, "Thanks")).wake_principal_ids).toEqual([]);
  });

  it("a person bringing several agents together makes the first one named the lead", async () => {
    const f = await fixture();
    const body = `${token("Fixture Agent Two")} and ${token("Fixture Agent One")}, agree on one plan`;
    const sent = (await say(f, f.owner.principal_id, body, { mentions: [mention(body, f.second.principal_id, "Fixture Agent Two"), mention(body, f.first.principal_id, "Fixture Agent One")] })).json();
    const [event] = await messageEvent(f, sent.id);
    expect(event.payload.collaboration).toMatchObject({ lead_principal_id: f.second.principal_id, turn: 0 });
    expect([...event.payload.wake_principal_ids].sort()).toEqual([f.first.principal_id, f.second.principal_id].sort());
  });

  it("an agent cannot mention itself: the mention is dropped, starts nothing and wakes nobody", async () => {
    const f = await fixture();
    const own = await turn(f.first, `${token("Fixture Agent One")} noting this for myself`, { mentions: [{ principal_id: f.first.principal_id }] });
    expect(own.mentions).toEqual([]);
    expect(own.wake_principal_ids).toEqual([]);
    expect(own.collaboration).toBeNull();
    expect(await collaboration(f)).toBeUndefined();
  });

  it("waits while a person is asked to decide, and resumes once they answer", async () => {
    const f = await fixture();
    await turn(f.first, `${token("Fixture Agent Two")} can you prepare the release?`, { mentions: [{ principal_id: f.second.principal_id }] });
    const asked = await f.second.client.requestDecision({ title: "Release now", question: "Publish the release?", proposed_action: { type: "publish" } }, "collab-decision");
    expect(asked.status).toBe(200);
    expect(await collaboration(f)).toMatchObject({ status: "waiting_for_human" });
    expect((await turn(f.first, "Any update?")).wake_principal_ids).toEqual([]);
    const decision = (await pool.query(`SELECT id,version,proposed_action_digest FROM decisions WHERE room_id=$1`, [f.room.id])).rows[0];
    const approved = await call("POST", f.url(`/rooms/${f.room.id}/decisions/${decision.id}/approve`), f.owner.principal_id, { proposed_action_digest: decision.proposed_action_digest, expected_version: decision.version });
    expect(approved.statusCode).toBe(200);
    expect(await collaboration(f)).toMatchObject({ status: "active" });
    expect((await turn(f.second, "Published")).wake_principal_ids).toEqual([f.first.principal_id]);
  });

  it("expires after a long silence rather than waking anyone later", async () => {
    const f = await fixture();
    await turn(f.first, `${token("Fixture Agent Two")} start when ready`, { mentions: [{ principal_id: f.second.principal_id }] });
    await pool.query(`UPDATE agent_collaborations SET updated_at=now()-interval '31 minutes' WHERE room_id=$1`, [f.room.id]);
    expect((await turn(f.second, "Starting now")).wake_principal_ids).toEqual([]);
    expect(await collaboration(f)).toMatchObject({ status: "expired", ended_reason: "idle" });
  });
});

describe("read receipts", () => {
  it("shows which people have read a message, and which agents only had it delivered", async () => {
    const f = await fixture();
    f.first.client.roomId = f.room.id; await f.first.client.connect(0);
    const sent = (await say(f, f.owner.principal_id, "Please look at the plan")).json();
    const snapshot = (await call("GET", f.url(`/rooms/${f.room.id}/snapshot`), f.owner.principal_id)).json();
    expect(snapshot.messages.at(-1)).toMatchObject({ id: sent.id, room_seq: sent.room_seq });
    const positions = async () => (await call("GET", f.url(`/rooms/${f.room.id}/read-positions`), f.owner.principal_id)).json().read_positions;
    expect((await positions()).find((p: any) => p.principal_id === f.colleague.principal_id)).toMatchObject({ kind: "human", last_read_seq: 0, delivered_seq: null });
    await call("POST", f.url(`/rooms/${f.room.id}/read`), f.colleague.principal_id, { room_seq: sent.room_seq });
    expect((await positions()).find((p: any) => p.principal_id === f.colleague.principal_id)).toMatchObject({ last_read_seq: sent.room_seq });
    // An agent is never "seen": its connector acknowledged delivery, reported as its own thing.
    await f.first.client.waitFor((x: any) => x.type === "room.event" && x.event.entity_id === sent.id);
    const deadline = Date.now() + 3000;
    let agent: any;
    while (Date.now() < deadline) { agent = (await positions()).find((p: any) => p.principal_id === f.first.principal_id); if ((agent.delivered_seq ?? 0) >= sent.room_seq) break; await new Promise(r => setTimeout(r, 50)); }
    expect(agent).toMatchObject({ kind: "agent", last_read_seq: null });
    expect(agent.delivered_seq).toBeGreaterThanOrEqual(sent.room_seq);
    const outsider = await seedHuman(pool, f.company.id, `${crypto.randomUUID()}@example.test`, "Fixture Non Member");
    expect((await call("GET", f.url(`/rooms/${f.room.id}/read-positions`), outsider.principal_id)).statusCode).toBe(403);
  });

  it("reports which server build is running, so a stale deploy is visible", async () => {
    const config = (await app.inject({ method: "GET", url: "/v1/app-config" })).json();
    expect(config).toHaveProperty("build_commit");
  });
});
