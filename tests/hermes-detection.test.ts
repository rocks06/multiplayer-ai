import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";

/* The adapter shells out, so the shell is what gets replaced. Spying on an ESM export is not
   possible, and mocking the module is closer to the truth anyway: these tests are about what the
   adapter concludes from what the commands said. */
const answered = { fn: (_file: string, _args: string[]) => ({ status: 0, stdout: "", stderr: "" }) as any };
vi.mock("node:child_process", () => ({
  spawnSync: (file: string, args: string[]) => answered.fn(file, args),
  spawn: () => { throw new Error("no invocation in these tests"); },
}));
const { HermesAdapter } = await import("../packages/connector-hermes/src/index.js");

/**
 * Finding a Hermes, and telling the truth about it.
 *
 * The detector assumed a running Hermes exposes an HTTP endpoint: it read a port out of config,
 * fell back to a default when it found none, and probed /health. A real installation with the
 * gateway plainly running answered none of that, because Hermes does not speak HTTP here — work is
 * executed by running `hermes chat`. The command line is the transport, so the command line is
 * what gets verified, and "a binary exists" is no longer reported as healthy.
 */
describe("detecting the Hermes runtime", () => {
  const BIN = "/somewhere/hermes";
  /** Answers for the three commands the adapter runs, so no real Hermes is needed. */
  const runtime = (answers: {
    version?: string | null; status?: number; statusText?: string;
    gateway?: number; gatewayText?: string; pgrep?: string;
  }) => {
    answered.fn = (file: any, args: any) => {
      const argv = (args ?? []) as string[];
      if (file === "pgrep") return { status: 0, stdout: answers.pgrep ?? "", stderr: "" } as any;
      // `command -v <x>` resolves whichever executable was asked for, as the real one would.
      if (file === "command") return { status: 0, stdout: argv[1] ?? BIN, stderr: "" } as any;
      if (argv[0] === "--version") {
        return answers.version === null
          ? { status: 1, stdout: "", stderr: "", error: new Error("ENOENT") } as any
          : { status: 0, stdout: answers.version ?? "Hermes Agent v0.20.5", stderr: "" } as any;
      }
      if (argv[0] === "status") return { status: answers.status ?? 0, stdout: answers.statusText ?? "ok", stderr: "" } as any;
      if (argv[0] === "gateway") return { status: answers.gateway ?? 0, stdout: answers.gatewayText ?? "running", stderr: "" } as any;
      return { status: 0, stdout: "", stderr: "" } as any;
    };
  };

  beforeEach(() => { vi.spyOn(fs, "existsSync").mockReturnValue(false); });
  afterEach(() => vi.restoreAllMocks());


  it("is ready when it answers and its gateway is up", async () => {
    runtime({ pgrep: "901" });
    const found = await new HermesAdapter({ command: BIN }).detect();
    expect(found.readiness).toBe("ready");
    expect(found.version).toBe("0.20.5");
    expect(found.serviceRunning).toBe(true);
    // The transport is the command line, not an invented address.
    expect(found.transport).toBe("cli");
    expect(found.endpoint).toBe(`cli:${BIN}`);
  });

  it("says so when nothing is installed", async () => {
    runtime({ version: null });
    const found = await new HermesAdapter({ command: BIN }).detect();
    expect(found.readiness).toBe("not_installed");
    expect(found.available).toBe(false);
  });

  it("distinguishes installed but not running from ready", async () => {
    runtime({ gateway: 1, gatewayText: "gateway is not running", pgrep: "" });
    const found = await new HermesAdapter({ command: BIN }).detect();
    expect(found.readiness).toBe("installed_not_running");
    expect(found.available).toBe(true);           // it is there
    expect(found.serviceRunning).toBe(false);      // it is just not up
    expect(found.reason).toMatch(/gateway is not running/i);
  });

  /** Answering `--version` proves a file exists. It does not prove the thing can do any work. */
  it("says so when it answers but cannot be controlled", async () => {
    runtime({ status: 1, statusText: "configuration is broken" });
    const found = await new HermesAdapter({ command: BIN }).detect();
    expect(found.readiness).toBe("control_unavailable");
    expect(found.reason).toMatch(/configuration is broken/);
  });

  it("refuses a version older than it can drive", async () => {
    runtime({ version: "Hermes Agent v0.9.0" });
    const found = await new HermesAdapter({ command: BIN }).detect();
    expect(found.readiness).toBe("unsupported_version");
  });

  it("says so when it answers but its version cannot be read", async () => {
    runtime({ version: "some other program entirely" });
    const found = await new HermesAdapter({ command: BIN }).detect();
    expect(found.readiness).toBe("control_unavailable");
  });

  /** Healthy has to mean drivable. It used to mean a file was present. */
  it("reports health from readiness, not from a file existing", async () => {
    runtime({ gateway: 1, gatewayText: "not running", pgrep: "" });
    expect((await new HermesAdapter({ command: BIN }).health()).ok).toBe(false);
    runtime({ pgrep: "901" });
    expect((await new HermesAdapter({ command: BIN }).health()).ok).toBe(true);
  });

  /**
   * A stale bridge from an earlier test is a process, and processes are not identity.
   *
   * The Air still had an old multiplayer-agent-bridge running against a previous identity file.
   * Nothing about detection may read it: not its name, not its arguments, not the identity file it
   * was started with. Detection answers about the runtime, and the runtime alone.
   */
  it("is unaffected by an unrelated bridge process left running", async () => {
    runtime({ pgrep: "901\n4242" });
    const found = await new HermesAdapter({ command: BIN }).detect();
    expect(found.readiness).toBe("ready");
    // Nothing a process listing said is carried into what identifies this runtime.
    expect(JSON.stringify(found)).not.toMatch(/bridge|\.env|identities/i);
  });

  /** No user, machine, port or profile may be baked into a generic adapter. */
  it("carries nothing machine-specific", async () => {
    runtime({ pgrep: "901" });
    const found = await new HermesAdapter({ command: BIN }).detect();
    const text = JSON.stringify(found);
    for (const specific of ["8642", "roccodonadon", "jj", "coleman", "127.0.0.1"]) {
      expect(text.toLowerCase()).not.toContain(specific);
    }
  });

  /** The one manual input a command-line runtime can need: where its executable is. */
  it("accepts an explicit executable when discovery cannot find one", async () => {
    runtime({ pgrep: "901" });
    const found = await new HermesAdapter({ command: "/opt/custom/hermes" }).detect();
    expect(found.readiness).toBe("ready");
    expect(found.endpoint).toBe("cli:/opt/custom/hermes");
  });
});
