import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

/**
 * Money surviving the trip from an agent to a room.
 *
 * The connector command surface is run by the agent through a shell, and a shell expands `$`
 * inside double quotes. An agent reporting green fees of "$45-55/round, $39 weekday" delivered
 * "5-55/round, 9 weekday" — $4 and $3 are undefined positional parameters, so they expanded to
 * nothing and took the following digit's meaning with them. The money was gone before the API,
 * the database or React ever saw it, which is why none of them showed a bug.
 */
describe("text an agent sends through a shell", () => {
  const throughShell = (command: string) =>
    execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" }).replace(/\n$/, "");
  const money = "Green fees $45-55/round, $39 weekday, $55 weekend, ~$20/person";

  it("is destroyed by a shell when it is an argument", () => {
    // Reproducing the reported symptom exactly, so the fix is measured against the real thing.
    expect(throughShell(`printf '%s' "${money}"`)).toBe("Green fees 5-55/round, 9 weekday, 5 weekend, ~0/person");
  });

  it("survives when it is piped instead", () => {
    // What the connector now accepts, and what the prompt tells agents to use.
    expect(throughShell(`printf '%s' '${money}' | cat`)).toBe(money);
  });
});

/**
 * The connector has to offer that route, and agents have to be told to take it.
 */
describe("what the connector and its prompt promise", () => {
  const read = (path: string) =>
    execFileSync("cat", [path], { encoding: "utf8" });

  it("accepts any flag's value on stdin", () => {
    const sidecar = read("apps/connector-macos/sidecar/sidecar.mjs");
    expect(sidecar).toContain("-stdin");
    // The value read from stdin has to win over anything left on argv.
    expect(sidecar).toMatch(/args\[`\$\{name\}-stdin`\][\s\S]{0,60}return piped/);
  });

  it("tells agents to pipe anything a person wrote or will read", () => {
    const prompt = read("packages/connector-hermes/src/index.ts");
    expect(prompt).toContain("--body-stdin");
    expect(prompt).toMatch(/a shell eats dollar signs/);
    // And to stop repeating themselves, which is the other half of one task, five messages.
    expect(prompt).toMatch(/Say one thing once/);
    expect(prompt).toMatch(/never to your own earlier message/);
  });
});
