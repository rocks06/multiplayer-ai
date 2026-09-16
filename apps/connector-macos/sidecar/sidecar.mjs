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
import { randomUUID, createHash } from 'node:crypto';
// Bundled from the repository's compiled output, so the shipped binary carries the same
// connector core and Hermes adapter the rest of the product is tested against.
import * as core from '../../../dist/packages/connector-core/src/index.js';
import * as hermes from '../../../dist/packages/connector-hermes/src/index.js';
import { AgentDiscovery } from '../../../dist/packages/connector-core/src/discovery.js';
import { hermesDiscovery } from '../../../dist/packages/connector-hermes/src/discovery.js';

/* What an agent may do, and the exact shape it is told to use. The names are what this binary
   dispatches on; the surface strings are what the runtime is shown. */
const VERB_NAMES = ['snapshot', 'tasks', 'task', 'status', 'complete', 'message', 'decision', 'heartbeat', 'attach'];
const COMMAND_SURFACE = [
  'snapshot',
  'tasks',
  'task --id ID',
  'status --id ID --status STATUS --version N --key KEY',
  'complete --id ID --version N --key KEY',
  'message --body TEXT [--to ID] [--task ID] [--reply-to ID] --key KEY',
  'decision --title TEXT --question TEXT --rationale TEXT --proposed-action-json JSON --key KEY',
  'heartbeat --runtime-status idle|working',
  'attach --file PATH [--name NAME] [--type MIME]',
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
    const value = next === undefined || next.startsWith('--') ? 'true' : next;
    /* A flag given more than once collects. Overwriting would silently deliver only the last of
       several files, which is worse than refusing them outright. */
    args[name] = name in args ? [].concat(args[name], value) : value;
    if (value !== 'true') i++;
  }
  /* Text that a shell cannot eat on the way in.

     These verbs are run as shell commands, and a shell expands `$` inside double quotes: an agent
     reporting green fees of "$45-55/round, $39 weekday" delivered "5-55/round, 9 weekday", because
     $4 and $3 are undefined positional parameters. The money was gone before anything of ours saw
     it. A `--<name>-stdin` flag takes that text off argv entirely, which is the only way to be
     certain, and the prompt tells agents to use it for anything a person wrote or will read. */
  const piped = Object.keys(args).some(name => name.endsWith('-stdin'))
    ? await new Promise((resolve) => {
        const chunks = [];
        process.stdin.on('data', chunk => chunks.push(chunk));
        process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/\n$/, '')));
        process.stdin.on('error', () => resolve(''));
      })
    : null;
  const need = (name) => {
    if (args[`${name}-stdin`] !== undefined && piped !== null) return piped;
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
  const output = process.env.MPAI_GENERATED_OUTPUT ? JSON.parse(process.env.MPAI_GENERATED_OUTPUT) : null;
  switch (verb) {
    case 'snapshot': result = await client.snapshot(); break;
    case 'tasks': result = await client.tasks(); break;
    case 'task': result = await client.task(need('id')); break;
    case 'status': result = await client.updateTaskStatus(need('id'), need('status'), version(), need('key')); break;
    case 'complete': result = await client.completeTask(need('id'), version(), need('key')); break;
    case 'heartbeat': result = await client.heartbeat(args['runtime-status'] === 'working' ? 'working' : 'idle'); break;
    /* Put a file into the room and get back its id, which a message then carries.

       Reading the file here rather than taking bytes on a command line is the point: a path is
       how an agent names what it made, and everything after this stops being one. */
    case 'attach': {
      const file = need('file');
      const bytes = fs.readFileSync(file);
      if (!bytes.length) { console.error(`${file} is empty, so there is nothing to deliver.`); process.exit(2); }
      result = await client.uploadArtifact({
        filename: args.name || path.basename(file),
        contentType: args.type || ({'.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.txt':'text/plain','.md':'text/markdown','.csv':'text/csv','.json':'application/json','.zip':'application/zip'}[path.extname(file).toLowerCase()] ?? 'application/octet-stream'),
        body: new Uint8Array(bytes),
      });
      if (output) core.rememberExplicitArtifact(output, file, result.id);
      break;
    }
    case 'message':
      result = await (output ? (input, key) => core.sendGeneratedMessage(client, output, input, key, `${session.baseUrl}/${session.roomId}/${session.agentPrincipalId}`) : (input, key) => client.sendMessage(input, key))({
        body: need('body'),
        addressedPrincipalId: args.to,
        taskId: args.task,
        inReplyToMessageId: args['reply-to'],
        // Repeatable: --artifact <id> --artifact <id>. One flag reads as one file.
        artifactIds: [].concat(args.artifact ?? []).filter(Boolean),
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

/* Where each agent keeps its cursor and session. One file per agent: two agents sharing one file
   would each adopt the other's session and room. */
const AGENTS_DIR = path.join(SUPPORT, 'agents');

/**
 * One agent on this Mac: one runtime profile, one workspace identity, one room session.
 *
 * A Mac used to be exactly one of these, so connecting a second agent replaced the first. The
 * Hermes installation is shared; the agent is not — each profile is its own agent and runs here
 * independently, and stopping, moving or disconnecting one never touches another.
 */
class AgentSlot {
  constructor(host, candidate, runtimeId) {
    this.host = host;
    this.candidate = candidate;
    this.runtimeId = runtimeId;
    this.runtime = null;
    this.config = null;           // { baseUrl, roomId, agentPrincipalId, credential, … }
    this.identity = null;         // { agentDisplayName, roomName, projectName }
    this.lastError = null;
    this.authFailed = false;
    this.superseded = false;
    this.removed = false;
    this.stoppedByRequest = false;
    this.watch = null;
    this.probeCache = null;
    this.stateFile = path.join(AGENTS_DIR, `${runtimeId}.json`);
    // This agent's Hermes sees this agent's session, and only this agent's.
    candidate.adapter.sessionEnvironment = () => this.sessionEnvironment();
  }

  store() { return new core.FileStateStore(this.stateFile); }

  label() { return this.identity?.agentDisplayName || this.candidate.displayName || this.candidate.profile; }

  sessionEnvironment() {
    if (!this.config) return {};
    const state = this.store().load();
    if (!state.session_id || !state.session_token) return {};
    return { [SESSION_ENV]: Buffer.from(JSON.stringify({
      baseUrl: this.config.baseUrl, roomId: this.config.roomId,
      agentPrincipalId: this.config.agentPrincipalId,
      sessionId: state.session_id, sessionToken: state.session_token,
    })).toString('base64') };
  }

  /* A Mac from before agents had files of their own kept one state file. It belongs to exactly one
     agent — the one it names, or, for a build too old to name anyone, the first to claim it — so it
     is moved rather than copied: two agents resuming one cursor would both answer the same events. */
  adoptLegacyState(agentPrincipalId) {
    if (fs.existsSync(this.stateFile) || !fs.existsSync(STATE_FILE)) return;
    let legacy;
    try { legacy = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return; }
    if (legacy?.agent_principal_id && legacy.agent_principal_id !== agentPrincipalId) return;
    fs.mkdirSync(AGENTS_DIR, { recursive: true, mode: 0o700 });
    fs.renameSync(STATE_FILE, this.stateFile);
    log(`adopted this Mac's earlier connector state for ${this.label()}`);
  }

  /** Whether this profile's runtime can actually be driven, asked of the adapter rather than assumed. */
  async runtimeState() {
    if (!this.probeCache || Date.now() - this.probeCache.time > 10000) {
      const candidate = this.candidate;
      this.probeCache = { time: Date.now(), promise: candidate.adapter.detect().then(detection => this.host.runtimeRecord(candidate, detection)) };
    }
    return this.probeCache.promise;
  }

  gateway(state) {
    if (this.authFailed) return 'auth_required';
    if (this.superseded) return 'superseded';
    if (this.removed) return 'removed';
    if (this.runtime) return state.connection ?? 'not_started';
    // Asked to stop is a state of its own. Reporting it as never started hid that it had worked.
    return this.stoppedByRequest && this.config ? 'offline' : 'not_started';
  }

  /* The four truths, kept apart. A live Gateway says nothing about whether Hermes is installed,
     and neither says anything about how much of the room has been read. */
  async snapshot() {
    const state = this.store().load();
    return {
      runtimeSelectionId: this.runtimeId,
      profile: this.candidate.profile,
      agentPrincipalId: this.config?.agentPrincipalId ?? null,
      roomId: this.config?.roomId ?? null,
      enrolled: Boolean(this.config),
      running: Boolean(this.runtime),
      gateway: this.gateway(state),
      runtime: await this.runtimeState(),
      sync: {
        lastContiguousSeq: state.last_contiguous_seq ?? null,
        pending: state.pending_actionable_events?.length ?? 0,
      },
      identity: this.identity,
      lastError: this.lastError ? redact(this.lastError) : null,
    };
  }

  configure(payload) {
    /* Being told to be a different agent, to work in a different room, or to present a different
       credential is not a settings change — it is a different job. A runtime already running is
       still the old one, and `connect` would leave it exactly where it is, so it is stopped here
       rather than left working in a room this Mac has moved on from, or against a key the
       workspace has already replaced. */
    if (core.needsRestart(this.config, payload)) this.disconnect();
    this.adoptLegacyState(payload.agentPrincipalId);
    this.config = {
      runtimeSelectionId: this.runtimeId,
      baseUrl: payload.baseUrl, roomId: payload.roomId,
      agentPrincipalId: payload.agentPrincipalId, credential: payload.credential,
    };
    this.identity = {
      agentDisplayName: payload.agentDisplayName || null,
      roomName: payload.roomName || null,
      projectName: payload.projectName || null,
    };
    this.authFailed = false;
    this.superseded = false;
    this.removed = false;
  }

  async connect() {
    if (!this.config) throw new Error('This agent is not connected to a workspace yet.');
    if (this.runtime) return;
    this.lastError = null;
    this.authFailed = false;
    this.superseded = false;
    this.removed = false;
    this.stoppedByRequest = false;

    const selfPath = process.execPath;
    this.runtime = new core.ConnectorRuntime({
      config: this.config,
      profile: 'macos',
      store: this.store(),
      adapter: this.candidate.adapter,
      commandSurface: { template: `${JSON.stringify(selfPath)} COMMAND`, verbs: COMMAND_SURFACE },
      logPath: LOG_FILE,
    });

    if (this.watch) clearInterval(this.watch);
    this.watch = setInterval(() => { void this.host.publish() }, 2000);
    log(`connector starting for ${this.label()}`);
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
         has to be told which one it is. Being replaced is a third thing and being taken out of the
         room a fourth; neither is a dead credential. The runtime reads `reason` from the error
         rather than searching the sentence, because "Gateway access revoked" contains "revoked"
         and so did being replaced by our own newer connection — which is how a working Mac came
         to ask its owner for a new enrollment code. */
      const reason = failure?.reason;
      this.superseded = reason === 'superseded';
      this.removed = reason === 'removed';
      this.authFailed = reason
        ? reason === 'unauthenticated'
        : /401|403|unauthor|forbidden|revoked|invalid/i.test(message);
      this.lastError = this.superseded || this.removed ? null : message;
      log(`connector stopped for ${this.label()}: ${message}`);
      this.runtime = null;
      if (this.watch) clearInterval(this.watch);
      this.watch = null;
      void this.host.publish();
    });
  }

  disconnect() {
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
    if (this.runtime) {
      this.runtime.stop('offline');
      this.stoppedByRequest = true;
      log(`connector stopped by request for ${this.label()}`);
    }
    this.runtime = null;
  }

  async disconnectSession() {
    const saved = this.store().load();
    const baseUrl = this.config?.baseUrl;
    this.disconnect();
    this.stoppedByRequest = Boolean(this.config);
    if (!baseUrl || !saved.session_id || !saved.session_token) return;
    // Wait for authoritative release, so the room says so now and a move can rely on it.
    let response;
    try {
      response = await fetch(`${baseUrl}/v1/agent-gateway/v1/sessions/${encodeURIComponent(saved.session_id)}/disconnect`, {
        method: 'POST', headers: {authorization: `Bearer ${saved.session_token}`}, signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new Error('The previous room could not be reached to confirm the agent left it.');
    }
    // 401/403: that session is already gone, which is the release we were waiting for.
    if (!response.ok && response.status !== 401 && response.status !== 403) {
      throw new Error(`The previous room did not confirm the agent left it (HTTP ${response.status}).`);
    }
  }

  /** Forget this agent on this Mac, including anything durable it kept about the room. */
  signOut() {
    this.disconnect();
    this.config = null;
    this.identity = null;
    this.stoppedByRequest = false;
    try { fs.rmSync(this.stateFile, { force: true }) } catch { /* nothing to remove */ }
    log(`signed out ${this.label()}; its durable connector state was removed`);
  }
}

class Connector {
  constructor() {
    this.hermesCommand = process.env.HERMES_COMMAND || undefined;
    this.startedAt = new Date().toISOString();
    this.lastError = null;
    this.providers = [hermesDiscovery({command: this.hermesCommand})];
    this.discovery = new AgentDiscovery(this.providers);
    this.defaultAdapter = new hermes.HermesAdapter({ command: this.hermesCommand });
    this.defaultProbe = null;
    this.slots = new Map();       // runtime identity → AgentSlot
    this.primary = null;          // the agent most recently configured; answers commands naming none
    this.detected = new Map();
  }

  runtimeId(candidate) {
    if (candidate.discoveryId === 'hermes:default') return externalRuntimeId;
    const key = createHash('sha256').update(candidate.discoveryId).digest('hex');
    return durableId(path.join(IDENTITY_ROOT, 'runtime-identities', key));
  }

  async discoverAgents() {
    const found = await this.discovery.scan();
    this.detected.clear();
    return found.map(({candidate, detection}) => {
      const id = this.runtimeId(candidate); this.detected.set(id, candidate.discoveryId);
      return this.runtimeRecord(candidate, detection);
    });
  }

  /** Validate a discovery card against the runtime as it is now. Changes nothing that is running. */
  async selectRuntime(id) {
    const discoveryId = this.detected.get(id);
    if (!discoveryId) throw new Error('Select an agent from the current discovery results.');
    const {candidate, detection} = await this.discovery.select(discoveryId);
    return this.runtimeRecord(candidate, detection);
  }

  /**
   * The profile on this Mac that holds a saved agent identity.
   *
   * Answered from what is on disk, never from whether a probe happened to succeed: a Hermes busy
   * enough to miss one status check is still exactly the profile that was saved, and calling it
   * "unavailable" while Hermes was plainly found is the contradiction this replaces.
   */
  async resolve(runtimeId) {
    const candidates = (await Promise.all(this.providers.map(provider => provider.discover()))).flat();
    const found = candidates.find(candidate => this.runtimeId(candidate) === runtimeId);
    if (!found) throw new Error('This agent’s Hermes profile is no longer on this Mac. Detect Agent to choose the profile to connect.');
    return found;
  }

  /** The agent a command is for: by runtime, else by identity, else the most recently configured.
   *  Naming an agent that is not here is an error, never a quiet fall back to a different agent. */
  slotFor(runtimeId, agentPrincipalId) {
    const slot = runtimeId ? this.slots.get(runtimeId)
      : agentPrincipalId ? [...this.slots.values()].find(candidate => candidate.config?.agentPrincipalId === agentPrincipalId)
      : this.slots.get(this.primary);
    if (!slot) throw new Error('That agent is not connected on this Mac yet.');
    return slot;
  }

  async configure(request) {
    // Enrolments from before profile selection belong to the default runtime.
    const runtimeId = request.runtimeSelectionId || externalRuntimeId;
    /* One identity is one agent, live in one place. If it is being given a different profile on
       this Mac, the profile it had stops being it. */
    for (const other of [...this.slots.values()]) {
      if (other.runtimeId !== runtimeId && other.config?.agentPrincipalId === request.agentPrincipalId) {
        other.signOut();
        this.slots.delete(other.runtimeId);
      }
    }
    let slot = this.slots.get(runtimeId);
    if (!slot) {
      slot = new AgentSlot(this, await this.resolve(runtimeId), runtimeId);
      this.slots.set(runtimeId, slot);
    }
    slot.configure(request);
    this.primary = runtimeId;
  }

  signOut(runtimeId) {
    const targets = runtimeId ? [this.slots.get(runtimeId)].filter(Boolean) : [...this.slots.values()];
    for (const slot of targets) { slot.signOut(); this.slots.delete(slot.runtimeId); }
    if (!this.slots.has(this.primary)) this.primary = this.slots.keys().next().value ?? null;
    // A Mac from before per-agent state still has its single file; signing out everything removes it.
    if (!runtimeId) { try { fs.rmSync(STATE_FILE, { force: true }) } catch {} }
  }

  async defaultRuntimeState() {
    if (!this.defaultProbe || Date.now() - this.defaultProbe.time > 10000) {
      const candidate = { discoveryId: 'hermes:default', profile: 'default', adapter: this.defaultAdapter };
      this.defaultProbe = { time: Date.now(), promise: this.defaultAdapter.detect().then(detection => this.runtimeRecord(candidate, detection)) };
    }
    return this.defaultProbe.promise;
  }

  runtimeRecord(candidate, detection) {
    return {
      available: detection.available, name: detection.name,
      version: detection.version ?? null, path: detection.path ?? null,
      adapter: candidate.adapter.id, profile: candidate.profile, discoveryId: candidate.discoveryId,
      displayName: candidate.displayName ?? null,
      runtimeType: candidate.adapter.id,
      runtimeInstallationId: this.runtimeId(candidate),
      externalRuntimeId: this.runtimeId(candidate),
      connectorInstallationId,
      endpoint: detection.endpoint ?? null,
      healthEndpoint: detection.healthEndpoint ?? null,
      transport: detection.transport ?? null,
      processId: detection.processId ?? null,
      configPath: detection.configPath ?? null,
      readiness: detection.readiness,
      serviceRunning: detection.serviceRunning ?? null,
      /* Healthy means the adapter proved it can drive this runtime, and nothing less.
         It used to mean "a file exists", so an installed-but-unusable Hermes was reported as
         healthy and enrolled — and the person was told everything was fine while nothing worked. */
      probeStatus: detection.readiness === 'ready' ? 'healthy' : 'failed',
      reason: detection.reason ?? null,
    };
  }

  /** Every agent on this Mac, plus the most recently configured one at the top level, which is
   *  what a single-agent reader has always read. */
  async snapshot() {
    const agents = await Promise.all([...this.slots.values()].map(slot => slot.snapshot()));
    const primary = agents.find(agent => agent.runtimeSelectionId === this.primary) ?? agents[0];
    return {
      type: 'state',
      startedAt: this.startedAt,
      enrolled: primary?.enrolled ?? false,
      running: primary?.running ?? false,
      gateway: primary?.gateway ?? 'not_started',
      runtime: primary?.runtime ?? await this.defaultRuntimeState(),
      sync: primary?.sync ?? { lastContiguousSeq: null, pending: 0 },
      identity: primary?.identity ?? null,
      lastError: primary?.lastError ?? (this.lastError ? redact(this.lastError) : null),
      agents,
    };
  }

  async publish() { emit(await this.snapshot()); }

  async diagnostics() {
    const slot = this.slots.get(this.primary);
    const state = slot ? slot.store().load() : {};
    const snapshot = await this.snapshot();
    return {
      ...snapshot,
      type: 'diagnostics',
      profile: 'macos',
      baseUrl: slot?.config?.baseUrl ?? null,
      roomId: slot?.config?.roomId ?? null,
      agentPrincipalId: slot?.config?.agentPrincipalId ?? null,
      sessionId: state.session_id ?? null,
      lastContiguousSeq: state.last_contiguous_seq ?? null,
      pendingEvents: state.pending_actionable_events ?? [],
      lastWakeAt: state.last_wake_at ?? null,
      lastHermesExit: state.last_hermes_exit ?? null,
      stateFile: slot?.stateFile ?? STATE_FILE,
      logFile: LOG_FILE,
      pid: process.pid,
      // Deliberately absent: the credential and the session token.
    };
  }

  /** Redeem an enrolment code. The workspace answers with who this Mac now is. */
  async enroll(code, deviceLabel) {
    const base = this.pendingBaseUrl || this.slots.get(this.primary)?.config?.baseUrl;
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
    // Which agent a command is for. Absent means the most recently configured one.
    const agent = request.runtimeSelectionId || undefined;
    const principal = request.agentPrincipalId || undefined;
    try {
      switch (command) {
        case 'ping': return reply(id, true, { startedAt: connector.startedAt });
        case 'discover':
        case 'detect': return reply(id, true, { runtimes: await connector.discoverAgents() });
        case 'select-runtime': return reply(id, true, { runtime: await connector.selectRuntime(request.runtimeInstallationId) });
        case 'enroll': {
          connector.pendingBaseUrl = request.baseUrl;
          const result = await connector.enroll(request.code, request.deviceLabel);
          return reply(id, true, { enrollment: result });
        }
        case 'configure': await connector.configure(request); await connector.publish(); return reply(id, true, { runtimeSelectionId: connector.primary });
        case 'connect': await connector.slotFor(agent, principal).connect(); await connector.publish(); return reply(id, true, {});
        case 'disconnect': {
          const slot = connector.slotFor(agent, principal);
          // The runtime has stopped even when the workspace could not confirm it; say so either way.
          try { await slot.disconnectSession(); } finally { await connector.publish(); }
          return reply(id, true, {});
        }
        case 'reconnect': {
          const slot = connector.slotFor(agent, principal);
          slot.disconnect(); await slot.connect(); await connector.publish(); return reply(id, true, {});
        }
        case 'signout': {
          const target = agent || principal ? connector.slotFor(agent, principal).runtimeId : undefined;
          connector.signOut(target); await connector.publish(); return reply(id, true, {});
        }
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

  const stopAll = () => { for (const slot of connector.slots.values()) slot.disconnect(); process.exit(0) };
  process.on('SIGTERM', stopAll);
  process.on('SIGINT', stopAll);
  connector.publish().catch(error => { connector.lastError = error.message; });
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
