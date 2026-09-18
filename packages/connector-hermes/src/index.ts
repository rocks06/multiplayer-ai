import fs from "node:fs";
import path from "node:path";
import { verifyGeneratedDelivery } from "../../connector-core/src/generated-artifacts.js";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import {
  WORKFLOW_STEPS,
  taskStepKey,
  type AgentInvocation,
  type AgentInvocationResult,
  type AgentRuntimeAdapter,
  type RuntimeDetection,
  type RuntimeHealth,
  collaborationContributor,
} from "../../connector-core/src/index.js";

export interface HermesAdapterOptions {
  /** Explicit binary path, otherwise resolved from PATH. */
  command?: string;
  /** Lowest Hermes version this connector will drive. */
  minimumVersion?: string;
  home?: string;
  probeTimeoutMs?: number;
}

/** Bounded asynchronous probes keep the helper IPC responsive even if a runtime hangs. */
function probe(command: string, args: string[], options: { encoding: string; timeout?: number; shell?: string; env?: NodeJS.ProcessEnv }) {
  return new Promise<{status: number; stdout: string; stderr: string; error?: Error}>(resolve => {
    execFile(command, args, { encoding: 'utf8', timeout: options.timeout ?? 4000,
      killSignal: 'SIGKILL', maxBuffer: 256 * 1024, env: options.env },
      (error, stdout, stderr) => resolve({ status: error ? 1 : 0, stdout, stderr, ...(error ? {error} : {}) }));
  });
}

/**
 * Whether Hermes' own status output says *this* profile's gateway is up.
 *
 * Only affirmative lines Hermes prints for the current profile count, and the "Other profiles"
 * section it appends is cut off first: a line about another profile is never an answer about this one.
 */
export function gatewayRunningFromStatus(text: string): boolean {
  const own = text.split(/^\s*Other profiles:/m)[0] ?? "";
  if (/✗ Gateway is not running/.test(own)) return false;
  return /✓ Gateway is (running|supervised by)/.test(own)
    || /Detached (fallback|gateway) process is running \(PID/i.test(own)
    || /Active: active \(running\)/.test(own);
}

/** The end of what a command said, without terminal colour codes, short enough to show a person. */
function lastLines(text: string) {
  return text.replace(/\u001b\[[0-9;]*m/g, "").split("\n").map(line => line.trim()).filter(Boolean).slice(-2).join(" ").slice(0, 300);
}

/**
 * What an agent is told about delivering files on this wake.
 *
 * A collaboration's contributor adds to the conversation; its lead produces the one result. Two
 * agents each delivering their own final file is what this prevents, so a contributor is not offered
 * the deliverables directory at all — unless a person asked this agent directly in the same wake.
 */
/**
 * Who this agent is in the room, said outright. The prompt used to name the agent only by its local
 * profile, so an agent reading "@A @B, work this out together" could not tell which of the two it
 * was — and greeted itself by name. Its room name comes from the wake itself, where a person
 * mentioned it; otherwise it is told how to find itself in the snapshot.
 */
export function selfIdentity(input: Pick<AgentInvocation, "trigger" | "agentPrincipalId">) {
  let name: string | undefined;
  for (const marker of input.trigger as Array<{ event?: { payload?: Record<string, any> } }>) {
    const payload = marker.event?.payload;
    const body = payload?.body_text;
    if (typeof body !== "string" || !Array.isArray(payload?.mentions)) continue;
    for (const mention of payload!.mentions) {
      if (mention?.principal_id !== input.agentPrincipalId || !Number.isInteger(mention.start) || !Number.isInteger(mention.end)) continue;
      const token = body.slice(mention.start, mention.end);
      if (token.startsWith("@") && token.length > 1) name = token.slice(1);
    }
  }
  const who = name
    ? `In this room you are ${name} (agent principal id ${input.agentPrincipalId}).`
    : `In this room you are the member whose principal id is ${input.agentPrincipalId}; the snapshot's members give your display name.`;
  const called = name ? `"@${name}" or "Hey ${name}"` : "your own name";
  return `${who} Every other name in the wake reason is someone else. Never address, greet, mention or send a message to yourself — never write ${called}.`;
}

export function deliveryPrompt(input: Pick<AgentInvocation, "trigger" | "agentPrincipalId">, output: { directory: string; manifest: string }) {
  if (collaborationContributor(input.trigger as any, input.agentPrincipalId)) {
    return `\nYou are a contributor in a collaboration led by another agent. Contribute your part in room messages. Do not produce or attach a final deliverable file — the lead produces the single agreed result. When your part is done, send it with --collaboration-done and the lead will finalize.`;
  }
  return `\nGenerated deliverables: write all files for the room directly inside ${output.directory} (flat directory; no symlinks or subdirectories). Do not put scripts, credentials or intermediate files there. Before generating a promised file, add its basename to the expected array in ${output.manifest}, for example {"expected":["report.pdf"]}. The connector automatically uploads these files BEFORE any message command and atomically attaches their ids to that message. You do not need to call attach. Never send the final answer before generation finishes. A missing declared file or failed upload refuses the message. Files outside this directory are NOT auto-delivered. Use the message command for the final answer, not only CLI output.`;
}

const DEFAULT_MINIMUM = "0.18.0";
const VERSION_PATTERN = /v(\d+)\.(\d+)\.(\d+)/;

const parseVersion = (text: string) => {
  const match = VERSION_PATTERN.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
};

const compare = (a: readonly number[], b: readonly number[]) => {
  for (let i = 0; i < 3; i++) {
    const left = a[i] ?? 0, right = b[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
};

/**
 * Hermes Agent as a Multiplayer AI agent runtime.
 *
 * Everything Hermes-shaped lives here: how the binary is found, how its version is read, how
 * a wake becomes a prompt, and how it is executed. The connector core knows none of it, and
 * this adapter never sees the machine credential, the durable cursor, or the marker list.
 */
export class HermesAdapter implements AgentRuntimeAdapter {
  readonly id = "hermes";
  private child: ChildProcess | null = null;

  constructor(private readonly options: HermesAdapterOptions = {}) {}

  /**
   * Where Hermes is looked for.
   *
   * An app launched from the Dock, from Finder, or at login inherits the system PATH, not the
   * one a login shell builds — so a Hermes installed where it installs itself is invisible to a
   * bare `hermes` lookup even though the person plainly has it. The usual install locations are
   * therefore tried directly before giving up.
   */
  private candidates(): string[] {
    if (this.options.command) return [this.options.command];
    const home = process.env.HOME ?? "";
    return [
      "hermes",
      ...(home ? [`${home}/.local/bin/hermes`, `${home}/.hermes/bin/hermes`] : []),
      "/opt/homebrew/bin/hermes",
      "/usr/local/bin/hermes",
      "/Applications/Hermes.app/Contents/MacOS/hermes",
    ];
  }

  /** The first candidate that answers, remembered so later calls do not search again. */
  private resolved: string | null = null;
  /**
   * Environment only this agent's runs may see — its room session.
   *
   * Two agents on one Mac run in one helper process, so a session published into that process's
   * own environment was whichever agent wrote it last: one agent's Hermes could act in the other's
   * room, as the other. Each adapter carries its own instead.
   */
  sessionEnvironment: () => Record<string, string> = () => ({});
  private get environment() {
    return { ...process.env, ...(this.options.home ? { HERMES_HOME: this.options.home } : {}), ...this.sessionEnvironment() };
  }
  private async command() {
    if (this.resolved) return this.resolved;
    for (const candidate of this.candidates()) {
      const result = await probe(candidate, ["--version"], { encoding: "utf8", timeout: this.options.probeTimeoutMs, env: this.environment });
      if (!result.error && result.status === 0) { this.resolved = candidate; return candidate; }
    }
    return this.options.command ?? "hermes";
  }

  async detect(): Promise<RuntimeDetection> {
    const command = await this.command();
    const result = await probe(command, ["--version"], { encoding: "utf8", timeout: this.options.probeTimeoutMs, env: this.environment });
    if (result.error || result.status !== 0) {
      return {
        available: false,
        readiness: "not_installed",
        name: "Hermes Agent",
        reason: `Hermes was not found on this Mac. Install it, or point the connector at its executable.`,
      };
    }
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const found = parseVersion(output);
    const path = command;
    if (!found) {
      return { available: false, readiness: "control_unavailable", name: "Hermes Agent", path,
               reason: "Hermes responded but its version could not be read." };
    }
    const version = found.join(".");
    const minimum = (parseVersion(`v${this.options.minimumVersion ?? DEFAULT_MINIMUM}`) ?? [0, 0, 0]) as readonly number[];
    if (compare(found, minimum) < 0) {
      return {
        available: false,
        readiness: "unsupported_version",
        name: "Hermes Agent",
        version,
        path,
        reason: `Hermes ${version} is older than the supported minimum ${this.options.minimumVersion ?? DEFAULT_MINIMUM}. Update Hermes and try again.`,
      };
    }
    /* How Hermes is actually driven, and therefore what has to be true before it can be enrolled.

       Work is executed by running `hermes chat` (see `invoke`) — a command, not a request. Hermes
       exposes no HTTP endpoint for this, and the connector used to go looking for one anyway:
       reading a port out of config, falling back to a documented-sounding default, and probing
       /health. On a real installation with the gateway plainly running, that probe found nothing,
       because there was never anything there to find. The command line is the transport, so the
       command line is what gets verified. */
    const control = await this.probeControl();
    if (!control.ok) {
      return {
        available: true, readiness: "control_unavailable", name: "Hermes Agent", version, path,
        transport: "cli", endpoint: `cli:${path}`,
        reason: control.detail ?? "Hermes is installed but did not answer a status check.",
      };
    }
    const service = await this.gatewayState();
    return {
      available: true,
      readiness: service.running ? "ready" : "installed_not_running",
      name: "Hermes Agent", version, path,
      transport: "cli",
      endpoint: `cli:${path}`,
      serviceRunning: service.running,
      processId: service.processId,
      configPath: this.configPath(),
      ...(service.running ? {} : {
        reason: "Hermes is installed and answering, but this profile's gateway is not running. Multiplayer AI starts it when you select this agent.",
      }),
    };
  }

  /**
   * Whether this connector can drive the Hermes it just found.
   *
   * `hermes status` is Hermes' own health command and costs nothing. It is a far better question
   * than "does a file exist": a broken install, a half-finished upgrade or a runtime whose
   * environment is wrong all answer the version flag perfectly well and then cannot do any work.
   */
  private async probeControl(): Promise<{ ok: boolean; detail?: string }> {
    const result = await probe(await this.command(), ["status"], { encoding: "utf8", timeout: this.options.probeTimeoutMs, env: this.environment });
    if (result.status !== 0) {
      const said = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n").at(-1);
      return { ok: false, detail: said ? `Hermes status reported: ${said}` : "Hermes status exited non-zero." };
    }
    return { ok: true };
  }

  /** The profile directory this adapter drives. The default profile is the Hermes home itself. */
  private get home() { return this.options.home ?? process.env.HERMES_HOME ?? path.join(process.env.HOME ?? "", ".hermes"); }

  /**
   * Whether this profile's own gateway is up.
   *
   * Hermes' status command is prose, and reading it with a pattern is what reported running
   * gateways as stopped: a launchd-supervised gateway says it is "supervised by launchd", never
   * "running", and the same output lists every *other* profile's gateway too — so one stopped
   * profile, or one phrase, decided the answer for all of them. The evidence Hermes itself trusts
   * comes first: this profile's own `gateway.pid`, naming a live gateway process. Only then is the
   * status command read, and only the part about this profile.
   */
  private async gatewayState(): Promise<{ running: boolean; processId?: number }> {
    const recorded = await this.recordedGateway();
    if (recorded) return { running: true, processId: recorded };
    const result = await probe(await this.command(), ["gateway", "status"], { encoding: "utf8", timeout: this.options.probeTimeoutMs, env: this.environment });
    return { running: !result.error && gatewayRunningFromStatus(`${result.stdout ?? ""}${result.stderr ?? ""}`) };
  }

  /** The live gateway process this profile's pid record names, if there is one. */
  private async recordedGateway(): Promise<number | undefined> {
    const file = path.join(this.home, "gateway.pid");
    if (!fs.existsSync(file)) return undefined;
    let pid: number | undefined;
    try {
      const text = fs.readFileSync(file, "utf8").trim();
      pid = /^\d+$/.test(text) ? Number(text) : Number(JSON.parse(text)?.pid);
    } catch { return undefined; }
    if (!pid || !Number.isInteger(pid) || pid <= 1) return undefined;
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") return undefined; }
    // A recycled pid belongs to something else. Zombies are gone, whatever the table says.
    const listed = await probe("ps", ["-o", "stat=,command=", "-p", String(pid)], { encoding: "utf8", timeout: this.options.probeTimeoutMs });
    const line = (listed.stdout ?? "").trim();
    if (listed.error || !line || line.startsWith("Z") || !/gateway/i.test(line)) return undefined;
    return pid;
  }

  /**
   * Start this profile's gateway, so nobody has to open a terminal to do it.
   *
   * Only a profile that is genuinely stopped is started: a running gateway is left exactly as it is,
   * and a runtime that cannot be controlled at all is not something starting can fix. `hermes gateway
   * start` under this profile's HERMES_HOME starts that profile's own service and no other, and
   * never with `--all`, which would kill every profile's gateway. Readiness is then waited for, for
   * a bounded time, because a started service is not yet an answering one.
   */
  async start(options: { readyTimeoutMs?: number; pollMs?: number; startTimeoutMs?: number } = {}): Promise<RuntimeDetection> {
    const before = await this.detect();
    if (before.readiness !== "installed_not_running") return before;
    const result = await probe(await this.command(), ["gateway", "start"], {
      encoding: "utf8", timeout: options.startTimeoutMs ?? 90_000, env: this.environment,
    });
    const said = lastLines(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    if (result.error) {
      throw new Error(`Hermes could not start this profile's gateway${said ? `: ${said}` : "."}`);
    }
    const deadline = Date.now() + (options.readyTimeoutMs ?? 45_000);
    let latest = before;
    while (Date.now() < deadline) {
      latest = await this.detect();
      if (latest.readiness === "ready") return latest;
      if (latest.readiness !== "installed_not_running") break;
      await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 500));
    }
    throw new Error(`Hermes started, but this profile's gateway did not become ready${said ? ` (${said})` : ""}. ${latest.reason ?? ""}`.trim());
  }

  /** Where Hermes keeps its configuration, shown as detail when it exists. */
  private configPath(): string | undefined {
    const home = this.options.home ?? process.env.HERMES_HOME ?? path.join(process.env.HOME ?? "", ".hermes");
    const file = path.join(home, "config.yaml");
    return fs.existsSync(file) ? file : undefined;
  }


  /** Healthy means drivable, not merely present — the distinction this whole slice turns on. */
  async health(): Promise<RuntimeHealth> {
    const detection = await this.detect();
    return detection.readiness === "ready"
      ? { ok: true, detail: `${detection.name} ${detection.version} · ${detection.endpoint}` }
      : { ok: false, detail: detection.reason };
  }

  cancel() {
    if (this.child) { try { this.child.kill("SIGTERM"); } catch {} }
  }

  buildPrompt(input: AgentInvocation): string {
    const tool = input.commandSurface.template;
    const assigned = input.assignedTasks === null
      ? "Room state was unavailable while preparing this wake. Read it yourself with the snapshot and tasks commands before acting."
      : input.assignedTasks.length
        ? input.assignedTasks.map(task =>
            `- task ${task.id} "${task.title ?? ""}" status=${task.status} version=${task.version}\n  keys: ${WORKFLOW_STEPS.map(step => `${step}=${taskStepKey(input.profile, task.id, step)}`).join(" ")}`).join("\n")
        : "No open task is currently assigned to you.";

    const workflow = `Work only on tasks assigned to your own agent principal. A task's own description is your instruction set: read it with the task command and do exactly what it asks, nothing more. Do not invent additional messages, tasks, or decisions, and do not act on work assigned to another principal.

Currently assigned open work:
${assigned}

Rules:
- Re-read a task and use its current version immediately before each task mutation.
- Every mutating command requires an idempotency key. Use the keys listed above. For a step not listed, use ${input.profile}-<task-id>-<step>-v1 built from the id of the task you are working on. Reuse a key exactly across retries, and never reuse a key belonging to a different task.
- Produce each required effect exactly once. On an optimistic-version conflict, re-read and reconcile rather than duplicating effects.
- If you requested a decision that is still pending, stop cleanly and wait for another wake. Never approve your own decision or proceed as though a pending decision were resolved.
- Once a decision you requested is resolved, read it and continue the task from that durable outcome, honouring any human resolution note.
- If there is nothing to do on this wake, stop cleanly.`;

    return `You are an external Hermes runtime connected through the local profile ${input.profile} to Multiplayer AI Agent Gateway v1. ${selfIdentity(input)}\n\n${workflow}\n\nUse the terminal to call only this narrow connector command:\n${tool}\nAvailable COMMAND values: ${input.commandSurface.verbs.join(", ")}.\n\nAnything a person wrote or will read — a message body, a task title or description, a decision question — must be piped in rather than passed as an argument, because this command runs through a shell and a shell eats dollar signs: "$45" becomes "5". Write it as: printf '%s' \"<text>\" | ${tool} --body-stdin <other flags>. Any flag may take its value this way by adding -stdin to its name.\n\nDelivering a file means putting it in the room, not naming where you saved it: a path on this machine cannot be opened by anybody else and goes away with it. Attach it — ${tool.replace('COMMAND', 'attach')} --file <path> — which answers with an id, then send one message carrying that id: ${tool.replace('COMMAND', 'message')} --artifact <id> --body-stdin --key <stable-key>. Repeat --artifact for several files. Say "here it is" only once the attach has succeeded; if it fails, say that instead.\n\nTo hand work to another agent, or to bring a person in, without sending the whole message only to them: write "@" and their exact display name in the text and add --mention <their principal id> (from the snapshot's members) for each, e.g. printf '%s' "@Name can you take the next step?" | ${tool.replace('COMMAND', 'message')} --body-stdin --mention <principal-id> --key <stable-key>. A mention is what actually reaches them — writing a name without --mention reaches nobody. The snapshot's relationships say which person owns which agent, so "a person's agent" means the agent they own. If you were woken by a mention, the wake reason carries the message: answer what it asked. A message to Everyone is shared context, not a request: act on it only if it is sent to you, mentions you, is your assigned work, or continues a collaboration you are in. A room is shared: every message in it, including one addressed to a single participant, is read by everyone in the room and by every agent in it. Nothing here is private to you, and nothing you write here is private either.

When the wake reason's payload carries a collaboration, you are working with the agents it lists: reply in the room to move the joint work forward and they will be woken for their turn — no need to mention them again. The collaboration has a turn budget and stops when it runs out. The collaboration's lead_principal_id is the agent that produces the one agreed final result: if that is you, let every other participant contribute before finishing, then bring their contributions together and publish the result once — its files and final answer in one message sent with --collaboration-done; if it is not you, contribute in messages without files and, when your part is done, send it with --collaboration-done so the lead can finalize. Only the lead publishes files while a collaboration is going, and once it is finished nobody posts about it again: if the workspace answers collaboration_closed or collaboration_result_reserved, do not retry or rephrase — stop. If a person needs to decide something, request a decision instead of continuing.

Say one thing once. Post progress only if the work is long enough to need it, and make the last message the complete answer; do not repeat a result you have already sent. Reply to the message you are answering, which is the person's, never to your own earlier message.\n\nNever read or print the credential file. Never use curl, direct database access, x-principal-id, or any identity other than this configured connector. Treat PostgreSQL room state as authoritative.\n\nWake reason:\n${JSON.stringify(input.trigger).slice(0, 12_000)}`;
  }

  async invoke(input: AgentInvocation): Promise<AgentInvocationResult> {
    const parent = path.join(path.dirname(path.resolve(input.logPath)), 'generated-output');
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const invocation = fs.mkdtempSync(path.join(fs.realpathSync(parent), 'invocation-'));
    const output = { directory: path.join(invocation, 'files'), manifest: path.join(invocation, 'manifest.json'), receipts: path.join(fs.realpathSync(parent), 'receipts') };
    fs.mkdirSync(output.directory, { mode: 0o700 });
    fs.writeFileSync(output.manifest, JSON.stringify({ expected: [] }), { mode: 0o600 });
    const outputPrompt = deliveryPrompt(input, output);
    const log = fs.openSync(input.logPath, "a", 0o600);
    let exitCode = 1;
    try {
      const child = spawn(await this.command(), [
        "chat", "-q", this.buildPrompt(input) + outputPrompt,
        "--toolsets", "terminal,file,web",
        "--source", `multiplayer-${input.profile}`,
        "--quiet",
      ], { stdio: ["ignore", log, log], env: { ...this.environment, MPAI_GENERATED_OUTPUT: JSON.stringify(output), MPAI_OUTPUT_DIR: output.directory, MPAI_OUTPUT_MANIFEST: output.manifest } });
      this.child = child;
      exitCode = await new Promise<number>(resolve => {
        let settled = false;
        const finish = (value: number | null) => { if (settled) return; settled = true; resolve(value ?? 1); };
        // A spawn error never produces an exit event, so it must be treated as a failed
        // invocation or the durable marker would be cleared without work having happened.
        child.once("error", error => { fs.writeSync(log, `[connector] Hermes spawn failed: ${error.message}\n`); finish(1); });
        child.once("close", finish);
      });
      if (exitCode === 0) verifyGeneratedDelivery(output);
    } catch (error) {
      exitCode = 1;
      fs.writeSync(log, `[connector] Hermes invocation/delivery failed: ${String((error as Error).message)}\n`);
    } finally {
      this.child = null;
      fs.closeSync(log);
    }
    return { ok: exitCode === 0, exitCode };
  }
}
