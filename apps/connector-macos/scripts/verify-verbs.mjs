#!/usr/bin/env node
/**
 * The commands an agent actually runs.
 *
 * The Connector tells the runtime it may run `message`, `status`, `complete`, `decision` and the
 * rest, and hands it a room-scoped session to run them with. Stage 8 proved the Connector could
 * enrol and connect but never once ran one of these, and they were broken the whole time: every
 * command came back 401 because the session was never adopted. This exercises each verb through
 * the shipped binary, against a real workspace, the way the runtime invokes it.
 *
 * Usage: DATABASE_URL=… node verify-verbs.mjs
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const API = process.env.API ?? 'http://127.0.0.1:4100';
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const BINARY = path.join(here, '..', 'build', 'mpai-connector-sidecar');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const results = [];
const check = (name, pass, detail) => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) };

/** Run a verb exactly as the runtime does: the binary, with the session in the environment. */
function verb(session, args) {
  const env = { ...process.env, MPAI_SESSION: Buffer.from(JSON.stringify(session)).toString('base64') };
  try {
    return { ok: true, out: JSON.parse(execFileSync(BINARY, args, { encoding: 'utf8', env }).trim() || '{}') };
  } catch (failure) {
    return { ok: false, error: `${failure.stderr ?? ''}${failure.stdout ?? ''}`.trim() || failure.message };
  }
}

try {
  if (!fs.existsSync(BINARY)) { console.error('Build the helper first: scripts/build-app.sh'); process.exit(1) }

  // ---- a workspace, an agent, a room: all through the product's own routes ----------
  const { AuthService } = await import(`${repo}/dist/apps/api/src/auth/auth-service.js`);
  const email = `verbs-${randomUUID()}@example.com`;
  // Signing up the way a person does. This used to POST /v1/companies and /humans, two routes
  // that needed no credentials at all — they are gone from normal configuration now, and a
  // harness that still reached for them was quietly checking a door that no longer exists.
  const created = await fetch(`${API}/v1/auth/sign-up`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Verb Check', email }) });
  if (!created.ok) { console.error(`sign-up failed: ${created.status}`); process.exit(1) }
  const user = (await pool.query('SELECT id FROM users WHERE lower(email)=lower($1)', [email])).rows[0];
  if (!user) { console.error('sign-up did not create a user'); process.exit(1) }
  // A brand-new account belongs to no company yet, so the member-to-member issuing route does
  // not apply. This is the same single-use link the product mails, captured rather than sent.
  const mailbox = [];
  const auth = new AuthService(pool, { deliver: async delivered => { mailbox.push(delivered) } });
  await auth.requestSignInLink(email);
  const link = mailbox.at(-1);
  if (!link) { console.error('no sign-in link was issued'); process.exit(1) }
  const session0 = await fetch(`${API}/v1/auth/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: link.token }) });
  const cookie = session0.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const post = (url, body, extra = {}) => fetch(`${API}${url}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) }).then(r => r.json());

  const workspace = await post('/v1/workspaces', { name: 'Verb Check' });
  const company = workspace.company_id;
  const project = await post(`/v1/companies/${company}/projects`, { name: 'Verbs', objective: 'Prove the commands work' });
  const room = await post(`/v1/companies/${company}/projects/${project.id}/rooms`, { name: 'Verbs' });
  const agent = await post(`/v1/companies/${company}/agents`, { name: 'Agent A' });
  await post(`/v1/companies/${company}/rooms/${room.id}/members`, { principal_id: agent.principal_id, role: 'worker_agent', responsibilities: '' }, { 'idempotency-key': randomUUID() });
  const peer = await post(`/v1/companies/${company}/agents`, { name: 'Agent B' });
  await post(`/v1/companies/${company}/rooms/${room.id}/members`, { principal_id: peer.principal_id, role: 'worker_agent', responsibilities: '' }, { 'idempotency-key': randomUUID() });
  const task = await post(`/v1/companies/${company}/rooms/${room.id}/tasks`, { title: 'Investigate', description: '' , assignee_principal_id: agent.principal_id }, { 'idempotency-key': randomUUID() });

  // ---- enrol and open a session, as the Connector does ------------------------------
  const issued = await post(`/v1/companies/${company}/agents/${agent.principal_id}/enrollments`, { label: 'Verb Check Mac' });
  const enrolled = await (await fetch(`${API}/v1/agent-gateway/v1/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: issued.enrollment_code }) })).json();
  const opened = await (await fetch(`${API}/v1/agent-gateway/v1/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${enrolled.credential_token}` },
    body: JSON.stringify({ room_id: room.id, runtime_status: 'idle' }),
  })).json();
  const session = {
    baseUrl: API, roomId: room.id, agentPrincipalId: agent.principal_id,
    sessionId: opened.session_id, sessionToken: opened.session_token,
  };

  // ---- every verb the runtime is told it may use -----------------------------------
  const snapshot = verb(session, ['snapshot']);
  check('snapshot reads the room', snapshot.ok && Array.isArray(snapshot.out?.members), snapshot.ok ? `${snapshot.out.members?.length} members` : snapshot.error);

  const tasks = verb(session, ['tasks']);
  check('tasks lists assigned work', tasks.ok, tasks.ok ? `${(tasks.out.tasks ?? tasks.out).length ?? '?'} returned` : tasks.error);

  const one = verb(session, ['task', '--id', task.id]);
  check('task reads one piece of work', one.ok && one.out?.id === task.id, one.ok ? one.out.title : one.error);

  const started = verb(session, ['status', '--id', task.id, '--status', 'in_progress', '--version', String(task.version), '--key', `verb-start-${randomUUID()}`]);
  check('status moves work forward', started.ok && started.out?.status === 'in_progress', started.ok ? started.out.status : started.error);

  const spoke = verb(session, ['message', '--body', 'Findings ready for review.', '--to', peer.principal_id, '--key', `verb-msg-${randomUUID()}`]);
  check('message reaches another agent', spoke.ok && Boolean(spoke.out?.id), spoke.ok ? 'sent' : spoke.error);

  const replied = verb(session, ['message', '--body', 'Following up on that.', '--reply-to', spoke.out?.id ?? '', '--key', `verb-reply-${randomUUID()}`]);
  check('message can reply to another message', replied.ok && Boolean(replied.out?.id), replied.ok ? 'replied' : replied.error);

  const asked = verb(session, ['decision', '--title', 'Publish?', '--question', 'May I publish the policy?', '--rationale', 'It changes what callers can rely on.', '--proposed-action-json', '{"action":"publish"}', '--key', `verb-dec-${randomUUID()}`]);
  check('decision asks a human for authority', asked.ok && Boolean(asked.out?.decision_id ?? asked.out?.id), asked.ok ? 'requested' : asked.error);

  const beat = verb(session, ['heartbeat', '--runtime-status', 'working']);
  check('heartbeat reports the runtime', beat.ok, beat.ok ? 'working' : beat.error);

  const current = (await (await fetch(`${API}/v1/companies/${company}/rooms/${room.id}/snapshot`, { headers: { cookie } })).json()).tasks.find(t => t.id === task.id);
  const done = verb(session, ['complete', '--id', task.id, '--version', String(current.version), '--key', `verb-done-${randomUUID()}`]);
  check('complete finishes the work', done.ok && done.out?.status === 'completed', done.ok ? done.out.status : done.error);

  // ---- and the failures a runtime must be told about clearly ------------------------
  const noSession = (() => { try { execFileSync(BINARY, ['snapshot'], { encoding: 'utf8', env: { ...process.env, MPAI_SESSION: '' } }); return null } catch (f) { return `${f.stderr ?? ''}`.trim() } })();
  check('without a session it says so instead of failing obscurely', /no open session/i.test(noSession ?? ''), (noSession ?? '').slice(0, 52));

  const missing = verb(session, ['status', '--id', task.id, '--status', 'in_progress']);
  check('a missing argument is named', !missing.ok && /Missing --version|Missing --key/.test(missing.error), missing.error?.slice(0, 40));

  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exitCode = results.every(Boolean) ? 0 : 1;
} finally {
  await pool.end();
}
