#!/usr/bin/env node
/**
 * Losing the network and getting it back.
 *
 * The workspace is stopped underneath a connected Connector and then started again — which is
 * what a dropped Wi-Fi connection or a Mac waking from sleep looks like from in here. What is
 * being checked is that the Connector stops claiming to be connected while it cannot reach the
 * workspace, comes back on its own without anyone pressing anything, and picks the room up from
 * where it left off rather than starting over.
 *
 * Usage: DATABASE_URL=… HERMES_STUB=… node verify-recovery.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const API = 'http://127.0.0.1:4100';
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const BINARY = path.join(here, '..', 'build', 'mpai-connector-sidecar');
const SUPPORT = path.join(os.homedir(), 'Library', 'Application Support', 'Multiplayer AI');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const results = [];
const check = (name, pass, detail) => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) };
const settle = ms => new Promise(r => setTimeout(r, ms));

function helper(env = {}) {
  const child = spawn(BINARY, [], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
  const waiters = new Map();
  let id = 0, buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let payload; try { payload = JSON.parse(line) } catch { continue }
      if (payload.type === 'reply' && waiters.has(payload.id)) { waiters.get(payload.id)(payload); waiters.delete(payload.id) }
    }
  });
  return {
    send(command, args = {}) {
      const requestId = ++id;
      return new Promise(resolve => { waiters.set(requestId, resolve); child.stdin.write(JSON.stringify({ id: requestId, command, ...args }) + '\n') });
    },
    stop() { child.kill('SIGTERM') },
  };
}

async function waitFor(app, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = (await app.send('status')).state;
    if (predicate(last)) return last;
    await settle(500);
  }
  return last;
}

const apiPid = () => {
  try { return execFileSync('/usr/sbin/lsof', ['-tPan', '-i', 'TCP:4100', '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n')[0] }
  catch { return null }
};
const startApi = () => spawn('node', ['dist/apps/api/src/server.js'], {
  cwd: repo, detached: true, stdio: 'ignore',
  env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, PORT: '4100' },
}).unref();

try {
  fs.rmSync(path.join(SUPPORT, 'connector-state.json'), { force: true });
  const room = (await pool.query(`SELECT r.id,r.company_id FROM rooms r JOIN companies c ON c.id=r.company_id WHERE c.name='Northwind' LIMIT 1`)).rows[0];
  const agent = (await pool.query(`SELECT id FROM principals WHERE company_id=$1 AND display_name='Agent B' AND kind='agent'`, [room.company_id])).rows[0];
  const manager = (await pool.query(`SELECT u.id user_id FROM principals p JOIN users u ON u.id=p.user_id WHERE p.company_id=$1 AND p.kind='human' LIMIT 1`, [room.company_id])).rows[0];

  const { AuthService, SilentSignInLinkDelivery } = await import(`${repo}/dist/apps/api/src/auth/auth-service.js`);
  const auth = new AuthService(pool, new SilentSignInLinkDelivery());
  const link = await auth.issueSignInLinkFor({ companyId: room.company_id, actorUserId: manager.user_id, userId: manager.user_id });
  const session = await fetch(`${API}/v1/auth/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: link.token }) });
  const cookie = session.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const issued = await (await fetch(`${API}/v1/companies/${room.company_id}/agents/${agent.id}/enrollments`,
    { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Recovery Mac' }) })).json();

  const app = helper({ HERMES_COMMAND: process.env.HERMES_STUB });
  const enrolled = (await app.send('enroll', { code: issued.enrollment_code, baseUrl: API, deviceLabel: 'Recovery Mac' })).enrollment;
  const configuration = {
    baseUrl: API, roomId: enrolled.rooms[0].id, agentPrincipalId: enrolled.agent_principal_id,
    credential: enrolled.credential_token, agentDisplayName: enrolled.agent_display_name,
    roomName: enrolled.rooms[0].name, projectName: enrolled.rooms[0].project_name,
  };
  await app.send('configure', configuration);
  await app.send('connect');
  const live = await waitFor(app, s => s.gateway === 'live', 12_000);
  check('connected to begin with', live.gateway === 'live', `gateway=${live.gateway}`);
  const seqBefore = live.sync.lastContiguousSeq;

  // ---- the network goes away ------------------------------------------------------
  const pid = apiPid();
  if (!pid) throw new Error('the workspace does not appear to be running on :4100');
  process.kill(Number(pid), 'SIGTERM');
  const dropped = await waitFor(app, s => s.gateway !== 'live', 20_000);
  check('stops claiming to be connected once the workspace is gone', dropped.gateway !== 'live', `gateway=${dropped.gateway}`);
  check('does not mistake a dropped connection for a refused one', dropped.gateway !== 'auth_required', `gateway=${dropped.gateway}`);

  // ---- and comes back -------------------------------------------------------------
  startApi();
  for (let attempt = 0; attempt < 40 && !apiPid(); attempt++) await settle(500);
  const recovered = await waitFor(app, s => s.gateway === 'live', 45_000);
  check('comes back on its own, with nobody pressing anything', recovered.gateway === 'live', `gateway=${recovered.gateway}`);
  check('picks the room up rather than starting it over',
    recovered.sync.lastContiguousSeq !== null && recovered.sync.lastContiguousSeq >= (seqBefore ?? 0),
    `read to ${recovered.sync.lastContiguousSeq}, was ${seqBefore}`);

  const dbSession = (await pool.query(`SELECT status FROM external_agent_sessions WHERE agent_principal_id=$1 ORDER BY connected_at DESC LIMIT 1`, [agent.id])).rows[0];
  check('the workspace agrees it is back', dbSession?.status === 'connected', `session ${dbSession?.status}`);

  await app.send('signout');
  app.stop();

  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exitCode = results.every(Boolean) ? 0 : 1;
} finally {
  await pool.end();
}
