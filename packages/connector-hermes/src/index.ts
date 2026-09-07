import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  WORKFLOW_STEPS,
  taskStepKey,
  type AgentInvocation,
  type AgentInvocationResult,
  type AgentRuntimeAdapter,
  type RuntimeDetection,
  type RuntimeHealth,
} from "../../connector-core/src/index.js";

export interface HermesAdapterOptions {
  /** Explicit binary path, otherwise resolved from PATH. */
  command?: string;
  /** Lowest Hermes version this connector will drive. */
  minimumVersion?: string;
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
  private get command() {
    if (this.resolved) return this.resolved;
    for (const candidate of this.candidates()) {
      const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
      if (!probe.error && probe.status === 0) { this.resolved = candidate; return candidate; }
    }
    return this.options.command ?? "hermes";
  }

  async detect(): Promise<RuntimeDetection> {
    const probe = spawnSync(this.command, ["--version"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      return {
        available: false,
        readiness: "not_installed",
        name: "Hermes Agent",
        reason: `Hermes was not found on this Mac. Install it, or point the connector at its executable.`,
      };
    }
    const output = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
    const found = parseVersion(output);
    const path = spawnSync("command", ["-v", this.command], { encoding: "utf8", shell: "/bin/sh" }).stdout?.trim() || this.command;
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
    const control = this.probeControl();
    if (!control.ok) {
      return {
        available: true, readiness: "control_unavailable", name: "Hermes Agent", version, path,
        transport: "cli", endpoint: `cli:${path}`,
        reason: control.detail ?? "Hermes is installed but did not answer a status check.",
      };
    }
    const service = this.gatewayState();
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
        reason: "Hermes is installed and answering, but its gateway is not running. Start it with `hermes gateway start`.",
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
  private probeControl(): { ok: boolean; detail?: string } {
    const probe = spawnSync(this.command, ["status"], { encoding: "utf8", timeout: 20_000 });
    if (probe.error) return { ok: false, detail: `Hermes could not be run: ${probe.error.message}` };
    if (probe.status !== 0) {
      const said = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim().split("\n").at(-1);
      return { ok: false, detail: said ? `Hermes status reported: ${said}` : "Hermes status exited non-zero." };
    }
    return { ok: true };
  }

  /**
   * Whether Hermes' own gateway is up.
   *
   * Asked of Hermes rather than inferred from a process listing, because the shape of that listing
   * is not a contract — the gateway runs as a Python module, and pattern-matching somebody's
   * command line is a guess that breaks the day the launcher changes. A process id is still read
   * where one is plainly there, but only as detail to show, never as the answer.
   */
  private gatewayState(): { running: boolean; processId?: number } {
    const probe = spawnSync(this.command, ["gateway", "status"], { encoding: "utf8", timeout: 20_000 });
    const said = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
    const running = !probe.error && probe.status === 0 && !/not running|stopped|inactive/i.test(said);
    const listed = spawnSync("pgrep", ["-f", "hermes.*gateway|gateway.*hermes"], { encoding: "utf8" });
    const processId = Number(listed.stdout?.trim().split(/\s+/)[0] ?? 0) || undefined;
    return { running: running || Boolean(processId && /running|active/i.test(said)), processId };
  }

  /** Where Hermes keeps its configuration, shown as detail when it exists. */
  private configPath(): string | undefined {
    const home = process.env.HERMES_HOME ?? path.join(process.env.HOME ?? "", ".hermes");
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

    return `You are an external Hermes runtime connected as ${input.profile} to Multiplayer AI Agent Gateway v1.\n\n${workflow}\n\nUse the terminal to call only this narrow connector command:\n${tool}\nAvailable COMMAND values: ${input.commandSurface.verbs.join(", ")}.\n\nAnything a person wrote or will read — a message body, a task title or description, a decision question — must be piped in rather than passed as an argument, because this command runs through a shell and a shell eats dollar signs: "$45" becomes "5". Write it as: printf '%s' \"<text>\" | ${tool} --body-stdin <other flags>. Any flag may take its value this way by adding -stdin to its name.\n\nSay one thing once. Post progress only if the work is long enough to need it, and make the last message the complete answer; do not repeat a result you have already sent. Reply to the message you are answering, which is the person's, never to your own earlier message.\n\nNever read or print the credential file. Never use curl, direct database access, x-principal-id, or any identity other than this configured connector. Treat PostgreSQL room state as authoritative.\n\nWake reason:\n${JSON.stringify(input.trigger).slice(0, 12_000)}`;
  }

  async invoke(input: AgentInvocation): Promise<AgentInvocationResult> {
    const log = fs.openSync(input.logPath, "a", 0o600);
    let exitCode = 1;
    try {
      const child = spawn(this.command, [
        "chat", "-q", this.buildPrompt(input),
        "--toolsets", "terminal,file,web",
        "--source", `multiplayer-${input.profile}`,
        "--quiet",
      ], { stdio: ["ignore", log, log], env: { ...process.env } });
      this.child = child;
      exitCode = await new Promise<number>(resolve => {
        let settled = false;
        const finish = (value: number | null) => { if (settled) return; settled = true; resolve(value ?? 1); };
        // A spawn error never produces an exit event, so it must be treated as a failed
        // invocation or the durable marker would be cleared without work having happened.
        child.once("error", error => { fs.writeSync(log, `[connector] Hermes spawn failed: ${error.message}\n`); finish(1); });
        child.once("exit", finish);
      });
    } catch (error) {
      fs.writeSync(log, `[connector] Hermes spawn failed: ${String((error as Error).message)}\n`);
    } finally {
      this.child = null;
      fs.closeSync(log);
    }
    return { ok: exitCode === 0, exitCode };
  }
}
