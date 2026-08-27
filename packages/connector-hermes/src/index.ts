import fs from "node:fs";
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

  private get command() { return this.options.command ?? "hermes"; }

  async detect(): Promise<RuntimeDetection> {
    const probe = spawnSync(this.command, ["--version"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      return {
        available: false,
        name: "Hermes Agent",
        reason: `Hermes was not found. Install it, or point the connector at its executable. Tried: ${this.command}`,
      };
    }
    const output = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
    const found = parseVersion(output);
    const path = spawnSync("command", ["-v", this.command], { encoding: "utf8", shell: "/bin/sh" }).stdout?.trim() || this.command;
    if (!found) {
      return { available: false, name: "Hermes Agent", path, reason: "Hermes responded but its version could not be read." };
    }
    const version = found.join(".");
    const minimum = (parseVersion(`v${this.options.minimumVersion ?? DEFAULT_MINIMUM}`) ?? [0, 0, 0]) as readonly number[];
    if (compare(found, minimum) < 0) {
      return {
        available: false,
        name: "Hermes Agent",
        version,
        path,
        reason: `Hermes ${version} is older than the supported minimum ${this.options.minimumVersion ?? DEFAULT_MINIMUM}. Update Hermes and try again.`,
      };
    }
    return { available: true, name: "Hermes Agent", version, path };
  }

  async health(): Promise<RuntimeHealth> {
    const detection = await this.detect();
    return detection.available
      ? { ok: true, detail: `${detection.name} ${detection.version}` }
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

    return `You are an external Hermes runtime connected as ${input.profile} to Multiplayer AI Agent Gateway v1.\n\n${workflow}\n\nUse the terminal to call only this narrow connector command:\n${tool}\nAvailable COMMAND values: ${input.commandSurface.verbs.join(", ")}.\nNever read or print the credential file. Never use curl, direct database access, x-principal-id, or any identity other than this configured connector. Treat PostgreSQL room state as authoritative.\n\nWake reason:\n${JSON.stringify(input.trigger).slice(0, 12_000)}`;
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
