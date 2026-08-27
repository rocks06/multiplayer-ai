#!/usr/bin/env node
/**
 * Drives the shipped Connector helper against a running workspace, the way the Mac app does.
 *
 * Everything here goes through the same binary the .app carries and the same Gateway routes the
 * product uses: no state is written by hand, and no result is simulated.
 *
 * Usage: DATABASE_URL=… node verify-connector.mjs
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const API = process.env.API ?? 'http://127.0.0.1:4100';
const here = path.dirname(fileURLToPath(import.meta.url));
const BINARY = path.join(here, '..', 'build', 'mpai-connector-sidecar');
const SUPPORT = path.join(os.homedir(), 'Library', 'Application Support', 'Multiplayer AI');
const LOG = path.join(SUPPORT, 'connector.log');
const HERMES_STUB = process.env.HERMES_STUB;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** One Connector helper, spoken to exactly as the app speaks to it. */
function helper(env = {}) {
  const child = spawn(BINARY, [], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiters = new Map();
  let states = [];
  let id = 0, buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let payload; try { payload = JSON.parse(line) } catch { continue }
      if (payload.type === 'state') states.push(payload);
      if (payload.type === 'reply' && waiters.has(payload.id)) {
        waiters.get(payload.id)(payload); waiters.delete(payload.id);
      }
    }
  });
  return {
    child,
    send(command, args = {}) {
      const requestId = ++id;
      return new Promise(resolve => {
        waiters.set(requestId, resolve);
        child.stdin.write(JSON.stringify({ id: requestId, command, ...args }) + '\n');
      });
    },
    get latest() { return states.at(-1) },
    stop() { child.kill('SIGTERM') },
  };
}

const settle = (ms = 1200) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(helper, predicate, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reply = await helper.send('status');
    if (reply.ok && predicate(reply.state)) return reply.state;
    await settle(500);
  }
  return (await helper.send('status')).state;
}

try {
  if (!fs.existsSync(BINARY)) { console.error('Build the helper first: scripts/build-app.sh'); process.exit(1) }
  fs.rmSync(path.join(SUPPORT, 'connector-state.json'), { force: true });

  const room = (await pool.query(`SELECT r.id,r.company_id FROM rooms r JOIN companies c ON c.id=r.company_id WHERE c.name='Northwind' LIMIT 1`)).rows[0];
  const agent = (await pool.query(`SELECT p.id FROM principals p WHERE p.company_id=$1 AND p.display_name='JJ' AND p.kind='agent'`, [room.company_id])).rows[0];
  const manager = (await pool.query(`SELECT p.id,u.id user_id FROM principals p JOIN users u ON u.id=p.user_id WHERE p.company_id=$1 AND p.kind='human' LIMIT 1`, [room.company_id])).rows[0];

  const { AuthService, SilentSignInLinkDelivery } = await import(`${process.cwd()}/dist/apps/api/src/auth/auth-service.js`);
  const auth = new AuthService(pool, new SilentSignInLinkDelivery());
  const link = await auth.issueSignInLinkFor({ companyId: room.company_id, actorUserId: manager.user_id, userId: manager.user_id });
  const session = await fetch(`${API}/v1/auth/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: link.token }) });
  const cookie = session.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const codeFor = async () => (await (await fetch(`${API}/v1/companies/${room.company_id}/agents/${agent.id}/enrollments`,
    { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Verification Mac' }) })).json()).enrollment_code;

  // ---- Hermes missing, then present ------------------------------------------------
  {
    const missing = helper({ PATH: '/usr/bin:/bin', HERMES_COMMAND: '/nonexistent/hermes' });
    const reply = await missing.send('detect');
    check('Hermes missing is reported, not assumed', reply.ok && reply.runtime.available === false && Boolean(reply.runtime.reason), reply.runtime?.reason?.slice(0, 48));
    missing.stop();
  }
  const withHermes = { HERMES_COMMAND: HERMES_STUB };
  {
    const present = helper(withHermes);
    const reply = await present.send('detect');
    check('Hermes present is detected with its version', reply.ok && reply.runtime.available === true && reply.runtime.version, `${reply.runtime?.name} ${reply.runtime?.version}`);
    present.stop();
  }

  // ---- enrolment ------------------------------------------------------------------
  {
    const app = helper(withHermes);
    const bad = await app.send('enroll', { code: 'MPAI-0000-0000-0000', baseUrl: API });
    check('an unrecognised code is refused in plain words', !bad.ok && /not recognised|used already|expired/i.test(bad.error), bad.error);
    app.stop();
  }

  const app = helper(withHermes);
  const code = await codeFor();
  const enrolled = await app.send('enroll', { code, baseUrl: API, deviceLabel: 'Verification Mac' });
  check('a valid code enrols this Mac', enrolled.ok && Boolean(enrolled.enrollment?.credential_token), enrolled.ok ? `agent ${enrolled.enrollment.agent_display_name}` : enrolled.error);

  const reused = await app.send('enroll', { code, baseUrl: API });
  check('the same code cannot be used twice', !reused.ok, reused.error);

  const credential = enrolled.enrollment.credential_token;
  const roomEntry = enrolled.enrollment.rooms[0];
  const configuration = {
    baseUrl: API, roomId: roomEntry.id, agentPrincipalId: enrolled.enrollment.agent_principal_id,
    credential, agentDisplayName: enrolled.enrollment.agent_display_name,
    roomName: roomEntry.name, projectName: roomEntry.project_name,
  };

  // ---- connecting -----------------------------------------------------------------
  await app.send('configure', configuration);
  await app.send('connect');
  const live = await waitFor(app, state => state.gateway === 'live');
  check('the workspace connection reaches live', live.gateway === 'live', `gateway=${live.gateway}`);
  check('the room is reported separately from the connection', live.sync !== undefined && live.runtime !== undefined,
    `sync=${JSON.stringify(live.sync)} runtime=${live.runtime.available}`);
  const dbSession = (await pool.query(`SELECT status FROM external_agent_sessions WHERE agent_principal_id=$1 ORDER BY connected_at DESC LIMIT 1`, [agent.id])).rows[0];
  check('the workspace agrees a session is open', dbSession?.status === 'connected', `session ${dbSession?.status}`);

  // ---- the connection dropping ----------------------------------------------------
  await app.send('disconnect');
  const stopped = await waitFor(app, state => state.running === false, 5000);
  check('disconnecting stops claiming a connection', stopped.running === false && stopped.gateway !== 'live', `running=${stopped.running} gateway=${stopped.gateway}`);

  // ---- an unreachable workspace ---------------------------------------------------
  {
    const unreachable = helper(withHermes);
    await unreachable.send('configure', { ...configuration, baseUrl: 'http://127.0.0.1:9' });
    await unreachable.send('connect');
    const state = await waitFor(unreachable, s => s.gateway !== 'live' && s.gateway !== 'not_started', 8000);
    check('an unreachable workspace never reads as connected', state.gateway !== 'live', `gateway=${state.gateway}`);
    unreachable.stop();
  }

  // ---- a revoked credential -------------------------------------------------------
  {
    await pool.query(`UPDATE external_agent_credentials SET status='revoked' WHERE agent_principal_id=$1`, [agent.id]);
    const revoked = helper(withHermes);
    await revoked.send('configure', configuration);
    await revoked.send('connect');
    const state = await waitFor(revoked, s => s.gateway === 'auth_required' || s.lastError, 10_000);
    check('a revoked credential is told apart from a network problem',
      state.gateway === 'auth_required' || /401|403|unauthor|forbidden|revoked|invalid/i.test(state.lastError ?? ''),
      `gateway=${state.gateway} error=${(state.lastError ?? '').slice(0, 40)}`);
    revoked.stop();
    await pool.query(`UPDATE external_agent_credentials SET status='active' WHERE agent_principal_id=$1`, [agent.id]);
  }

  // ---- signing out ----------------------------------------------------------------
  {
    await app.send('configure', configuration);
    await app.send('signout');
    const state = (await app.send('status')).state;
    check('signing out leaves nothing behind that could reconnect',
      state.enrolled === false && !fs.existsSync(path.join(SUPPORT, 'connector-state.json')),
      `enrolled=${state.enrolled}`);
  }
  app.stop();

  // ---- logs ------------------------------------------------------------------------
  {
    const text = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
    const leaked = [credential, code].filter(secret => secret && text.includes(secret));
    check('nothing secret reaches the log', leaked.length === 0, leaked.length ? 'a secret appeared in the log' : `${text.split('\n').length} lines checked`);
  }

  console.log(`\n${results.filter(r => r.pass).length}/${results.length} passed`);
  process.exitCode = results.every(r => r.pass) ? 0 : 1;
} finally {
  await pool.end();
}
