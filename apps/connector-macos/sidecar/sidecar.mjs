#!/usr/bin/env node
/**
 * The Connector's working half, driven by the Mac app over stdin/stdout.
 *
 * It owns nothing the app owns: the machine credential arrives in a `configure` command and
 * stays in memory, the app keeps it in the Keychain, and it is never written to disk or logged.
 * What this process contributes is the four things only it can know — whether it is alive,
 * what the Gateway connection is doing, whether the agent runtime is usable, and how far the
 * room has been read — reported separately so the app never has to guess one from another.
 *
 * Also runs as the command surface Hermes itself calls (`sidecar message …`), using the
 * room-scoped session rather than the machine credential.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
// Bundled from the repository's compiled output, so the shipped binary carries the same
// connector core and Hermes adapter the rest of the product is tested against.
import * as core from '../../../dist/packages/connector-core/src/index.js';
import * as hermes from '../../../dist/packages/connector-hermes/src/index.js';

/* What an agent may do, and the exact shape it is told to use. The names are what this binary
   dispatches on; the surface strings are what the runtime is shown. */
const VERB_NAMES = ['snapshot', 'tasks', 'task', 'status', 'complete', 'message', 'decision', 'heartbeat'];
const COMMAND_SURFACE = [
  'snapshot',
  'tasks',
  'task --id ID',
  'status --id ID --status STATUS --version N --key KEY',
  'complete --id ID --version N --key KEY',
  'message --body TEXT [--to ID] [--task ID] [--reply-to ID] --key KEY',
  'decision --title TEXT --question TEXT --rationale TEXT --proposed-action-json JSON --key KEY',
  'heartbeat --runtime-status idle|working',
];
/* Where this app keeps what it must not lose. The app names it, because only the app knows
   which Multiplayer AI it is; the fixed path remains the default so a helper run on its own
   behaves exactly as it always did. Two builds sharing one of these can destroy each other's
   session, so they are kept apart. */
const SUPPORT = process.env.MPAI_SUPPORT_DIR
  || path.join(os.homedir(), 'Library', 'Application Support', 'Multiplayer AI');
const STATE_FILE = path.join(SUPPORT, 'connector-state.json');
const LOG_FILE = path.join(SUPPORT, 'connector.log');
// Runtime identity deliberately lives outside a build-specific support directory. Credentials,
// app builds and connector state may all be replaced without turning this Mac's Hermes into JJ2.
const IDENTITY_ROOT = process.env.MPAI_IDENTITY_DIR
  || path.join(os.homedir(), 'Library', 'Application Support', 'Multiplayer AI');
const RUNTIME_ID_FILE = path.join(IDENTITY_ROOT, 'runtime-installation-id');
const CONNECTOR_ID_FILE = path.join(SUPPORT, 'connector-installation-id');
const SESSION_ENV = 'MPAI_SESSION';

const emit = (payload) => process.stdout.write(JSON.stringify(payload) + '\n');

function durableId(file) {
  try { const value=fs.readFileSync(file,'utf8').trim(); if(/^[0-9a-f-]{36}$/i.test(value))return value; } catch {}
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const value=randomUUID();
  fs.writeFileSync(file,`${value}\n`,{mode:0o600});
  return value;
}
const externalRuntimeId=durableId(RUNTIME_ID_FILE);
const connectorInstallationId=durableId(CONNECTOR_ID_FILE);

/* Logs are read by people and attached to reports, so nothing secret may reach them. Anything
   that looks like a credential, a session token, or an enrollment code is masked on the way out. */
const SECRETS = /\b(mag[cs]_[A-Za-z0-9_-]+|mpsi_[A-Za-z0-9_-]+|MPAI-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})\b/g;
export const redact = (text) => String(text).replace(SECRETS, (match) => `${match.slice(0, 4)}…redacted`);

function log(line) {
  fs.mkdirSync(SUPPORT, { recursive: true, mode: 0o700 });
  fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${redact(line)}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------- verb mode

async function runVerb(verb, argv) {
  const raw = process.env[SESSION_ENV];
  if (!raw) { console.error('No open session. The Connector opens one when it connects.'); process.exit(2); }
  const session = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));

  const client = new core.GatewayClient({
    baseUrl: session.baseUrl, roomId: session.roomId,
    agentPrincipalId: session.agentPrincipalId, credential: '',
  });
  /* The room-scoped session the Connector already opened is adopted rather than a new one being
     negotiated: this process never sees the machine credential and could not open one anyway. */
  client.adoptSession({ sessionId: session.sessionId, sessionToken: session.sessionToken });

  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const name = argv[i].slice(2);
    const next = argv[i + 1];
    args[name] = next === undefined || next.startsWith('--') ? 'true' : next;
    if (args[name] !== 'true') i++;
  }
  const need = (name) => {
    const value = args[name];
    if (value === undefined) { console.error(`Missing --${name}`); process.exit(2); }
    return value;
  };
  const version = () => {
    const value = Number(need('version'));
    if (!Number.isInteger(value)) { console.error('--version must be a whole number'); process.exit(2); }
    return value;
  };

  let result;
  switch (verb) {
    case 'snapshot': result = await client.snapshot(); break;
    case 'tasks': result = await client.tasks(); break;
    case 'task': result = await client.task(need('id')); break;
    case 'status': result = await client.updateTaskStatus(need('id'), need('status'), version(), need('key')); break;
    case 'complete': result = await client.completeTask(need('id'), version(), need('key')); break;
    case 'heartbeat': result = await client.heartbeat(args['runtime-status'] === 'working' ? 'working' : 'idle'); break;
    case 'message':
      result = await client.sendMessage({
        body: need('body'),
        addressedPrincipalId: args.to,
        taskId: args.task,
        inReplyToMessageId: args['reply-to'],
      }, need('key'));
      break;
    case 'decision': {
      let proposedAction;
      try { proposedAction = JSON.parse(need('proposed-action-json')) }
      catch { console.error('--proposed-action-json must be valid JSON'); process.exit(2) }
      result = await client.requestDecision({
        title: need('title'), question: need('question'),
        rationale: args.rationale, proposedAction,
      }, need('key'));
      break;
    }
    default: console.error(`Unknown command ${verb}`); process.exit(2);
  }
  console.log(JSON.stringify(result));
}

// ------------------------------------------------------------- daemon mode

class Connector {
  constructor() {
    this.runtime = null;
    this.config = null;           // { baseUrl, roomId, agentPrincipalId, credential, … }
    this.identity = null;         // { agentDisplayName, roomName, projectName }
    this.hermesCommand = process.env.HERMES_COMMAND || undefined;
    this.startedAt = new Date().toISOString();
    this.lastError = null;
    this.authFailed = false;
    this.superseded = false;
    this.adapter = new hermes.HermesAdapter({ command: this.hermesCommand });
  }

  store() { return new core.FileStateStore(STATE_FILE); }

  /** Whether the agent runtime can actually be driven, asked of the adapter rather than assumed. */
  async runtimeState() {
    const detection = await this.adapter.detect();
    return {
      available: detection.available, name: detection.name,
      version: detection.version ?? null, path: detection.path ?? null,
      runtimeType: this.adapter.id,
      externalRuntimeId,
      connectorInstallationId,
      endpoint: detection.endpoint ?? null,
      healthEndpoint: detection.healthEndpoint ?? null,
      transport: detection.transport ?? null,
      processId: detection.processId ?? null,
      configPath: detection.configPath ?? null,
      probeStatus: detection.available ? 'healthy' : 'failed',
      reason: detection.reason ?? null,
    };
  }

  /* The four truths, kept apart. A live Gateway says nothing about whether Hermes is installed,
     and neither says anything about how much of the room has been read. */
  async snapshot() {
    const state = this.store().load();
    const runtime = await this.runtimeState();
    const connection = this.runtime ? (state.connection ?? 'not_started') : 'not_started';
    return {
      type: 'state',
      enrolled: Boolean(this.config),
      running: Boolean(this.runtime),
      startedAt: this.startedAt,
      gateway: this.authFailed ? 'auth_required' : this.superseded ? 'superseded' : connection,
      runtime,
      sync: {
        lastContiguousSeq: state.last_contiguous_seq ?? null,
        pending: state.pending_actionable_events?.length ?? 0,
      },
      identity: this.identity,
      lastError: this.lastError ? redact(this.lastError) : null,
    };
  }

  async publish() { emit(await this.snapshot()); }

  configure(payload) {
    /* Being told to be a different agent, to work in a different room, or to present a different
       credential is not a settings change — it is a different job. A runtime already running is
       still the old one, and `connect` would leave it exactly where it is, so it is stopped here
       rather than left working in a room this Mac has moved on from, or against a key the
       workspace has already replaced. */
    const moved = core.needsRestart(this.config, payload);
    if (moved) this.disconnect();

    this.config = {
      baseUrl: payload.baseUrl, roomId: payload.roomId,
      agentPrincipalId: payload.agentPrincipalId, credential: payload.credential,
    };
    this.identity = {
      agentDisplayName: payload.agentDisplayName ?? null,
      roomName: payload.roomName ?? null,
      projectName: payload.projectName ?? null,
    };
    this.authFailed = false;
    this.superseded = false;
  }

  async connect() {
    if (!this.config) throw new Error('This Mac is not connected to a workspace yet.');
    if (this.runtime) return;
    this.lastError = null;
    this.authFailed = false;
    this.superseded = false;

    const selfPath = process.execPath;
    this.runtime = new core.ConnectorRuntime({
      config: this.config,
      profile: 'macos',
      store: this.store(),
      adapter: this.adapter,
      commandSurface: { template: `${JSON.stringify(selfPath)} COMMAND`, verbs: COMMAND_SURFACE },
      logPath: LOG_FILE,
    });

    // The room-scoped session is what Hermes acts through; the machine credential never leaves
    // this process.
    const publishSession = () => {
      const state = this.store().load();
      if (!state.session_id || !state.session_token) return;
      process.env[SESSION_ENV] = Buffer.from(JSON.stringify({
        baseUrl: this.config.baseUrl, roomId: this.config.roomId,
        agentPrincipalId: this.config.agentPrincipalId,
        sessionId: state.session_id, sessionToken: state.session_token,
      })).toString('base64');
    };

    this.watch = setInterval(() => { publishSession(); void this.publish() }, 2000);
    log('connector starting');
    /* Whose failure this is.

       A runtime that ends terminally does so asynchronously, and by the time it does the sidecar
       may already have started its replacement — a rebind is exactly that sequence. Without this
       check the outgoing runtime's rejection cleared `this.runtime` out from under the incoming
       one and published its state, leaving a live runtime nobody was holding. */
    const mine = this.runtime;
    void this.runtime.start().catch((failure) => {
      if (this.runtime !== mine) return;
      const message = String(failure?.message ?? failure);
      /* A refused credential is a different problem from a network that is down, and the person
         has to be told which one it is. Being replaced is a third thing and belongs to neither:
         the runtime read `reason` from the error rather than searching the sentence, because
         "Gateway access revoked" contains "revoked" and so did being replaced by our own newer
         connection — which is how a working Mac came to ask its owner for a new enrollment code. */
      const reason = failure?.reason;
      this.superseded = reason === 'superseded';
      this.authFailed = reason
        ? reason === 'unauthenticated'
        : /401|403|unauthor|forbidden|revoked|invalid/i.test(message);
      this.lastError = this.superseded ? null : message;
      log(`connector stopped: ${message}`);
      this.runtime = null;
      void this.publish();
    });
  }

  disconnect() {
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
    this.runtime?.stop('offline');
    this.runtime = null;
    delete process.env[SESSION_ENV];
    log('connector stopped by request');
  }

  /** Forget this Mac's enrolment entirely, including anything durable it kept about the room. */
  signOut() {
    this.disconnect();
    this.config = null;
    this.identity = null;
    try { fs.rmSync(STATE_FILE, { force: true }) } catch { /* nothing to remove */ }
    log('signed out; durable connector state removed');
  }

  async diagnostics() {
    const state = this.store().load();
    const snapshot = await this.snapshot();
    return {
      ...snapshot,
      type: 'diagnostics',
      profile: 'macos',
      baseUrl: this.config?.baseUrl ?? null,
      roomId: this.config?.roomId ?? null,
      agentPrincipalId: this.config?.agentPrincipalId ?? null,
      sessionId: state.session_id ?? null,
      lastContiguousSeq: state.last_contiguous_seq ?? null,
      pendingEvents: state.pending_actionable_events ?? [],
      lastWakeAt: state.last_wake_at ?? null,
      lastHermesExit: state.last_hermes_exit ?? null,
      stateFile: STATE_FILE,
      logFile: LOG_FILE,
      pid: process.pid,
      // Deliberately absent: the credential and the session token.
    };
  }

  /** Redeem an enrolment code. The workspace answers with who this Mac now is. */
  async enroll(code, deviceLabel) {
    const base = (this.config?.baseUrl) || this.pendingBaseUrl;
    if (!base) throw new Error('No workspace address was provided.');
    const response = await fetch(`${base}/v1/agent-gateway/v1/enroll`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.trim().toUpperCase(), device_label: deviceLabel || os.hostname() }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = body?.error?.code === 'enrollment_invalid' || response.status === 404
        ? 'That code was not recognised. It may have been used already, or expired.'
        : body?.error?.message || 'The workspace refused that code.';
      throw new Error(reason);
    }
    log('enrolled with workspace');
    return body;
  }
}

async function daemon() {
  const connector = new Connector();
  const reply = (id, ok, payload) => emit({ type: 'reply', id, ok, ...payload });

  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    if (!line.trim()) return;
    let request;
    try { request = JSON.parse(line) } catch { return }
    const { id, command } = request;
    try {
      switch (command) {
        case 'ping': return reply(id, true, { startedAt: connector.startedAt });
        case 'detect': return reply(id, true, { runtime: await connector.runtimeState() });
        case 'enroll': {
          connector.pendingBaseUrl = request.baseUrl;
          const result = await connector.enroll(request.code, request.deviceLabel);
          return reply(id, true, { enrollment: result });
        }
        case 'configure': connector.configure(request); await connector.publish(); return reply(id, true, {});
        case 'connect': await connector.connect(); await connector.publish(); return reply(id, true, {});
        case 'disconnect': connector.disconnect(); await connector.publish(); return reply(id, true, {});
        case 'reconnect': connector.disconnect(); await connector.connect(); await connector.publish(); return reply(id, true, {});
        case 'signout': connector.signOut(); await connector.publish(); return reply(id, true, {});
        case 'status': return reply(id, true, { state: await connector.snapshot() });
        case 'diagnostics': return reply(id, true, { diagnostics: await connector.diagnostics() });
        default: return reply(id, false, { error: `Unknown command ${command}` });
      }
    } catch (failure) {
      const message = redact(String(failure?.message ?? failure));
      log(`command ${command} failed: ${message}`);
      reply(id, false, { error: message });
    }
  });

  process.on('SIGTERM', () => { connector.disconnect(); process.exit(0) });
  process.on('SIGINT', () => { connector.disconnect(); process.exit(0) });
  await connector.publish();
}

async function main() {
  const [verb, ...rest] = process.argv.slice(2);
  if (verb && VERB_NAMES.includes(verb)) await runVerb(verb, rest);
  else await daemon();
}

main().catch((failure) => {
  console.error(redact(String(failure?.message ?? failure)));
  process.exit(1);
});
