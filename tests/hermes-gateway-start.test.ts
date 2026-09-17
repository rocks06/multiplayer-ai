import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HermesAdapter, deliveryPrompt } from '../packages/connector-hermes/src/index.js';

/**
 * Starting a stopped agent, without sending anybody to a terminal.
 *
 * These run real processes: a fixture `hermes` that behaves like Hermes does on macOS — a gateway
 * records itself in its own profile's `gateway.pid`, and `gateway start` starts only the profile
 * named by HERMES_HOME. Profile names here are fixtures, nothing more.
 */
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    for (const file of walk(root).filter(f => f.endsWith('gateway.pid'))) {
      try { process.kill(Number(JSON.parse(fs.readFileSync(file, 'utf8')).pid), 'SIGKILL'); } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);

function installation() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mpai-gateway-start-'));
  roots.push(root);
  const command = path.join(root, 'hermes');
  fs.writeFileSync(command, `#!/bin/bash
home="\${HERMES_HOME:?}"
echo "$*" >> "$home/calls.log"
case "$1" in
  --version) echo "Hermes Agent v0.21.0";;
  status) echo "ok";;
  gateway) case "$2" in
    status) echo "Launchd plist: $home/ai.hermes.gateway.plist"; echo "✗ Gateway service is not loaded";
            echo; echo "Other profiles:"; echo "  ✓ elsewhere        — PID 1";;
    start)
      if [ -f "$home/start-fails" ]; then echo "↻ launchd job was unloaded; reloading service definition"; echo "launchctl bootstrap failed: 5: Input/output error" >&2; exit 1; fi
      if [ -f "$home/never-ready" ]; then echo "✓ Service started"; exit 0; fi
      nohup bash -c 'exec -a "hermes gateway run --external-supervisor" sleep 300' >/dev/null 2>&1 &
      echo "{\\"pid\\": $!, \\"kind\\": \\"hermes-gateway\\"}" > "$home/gateway.pid"
      echo "✓ Service started";;
    *) exit 1;;
  esac;;
  *) exit 1;;
esac
`, { mode: 0o700 });
  const profile = (name: string) => { const home = name === 'default' ? root : path.join(root, 'profiles', name); fs.mkdirSync(home, { recursive: true }); return home; };
  const adapter = (home: string) => new HermesAdapter({ command, home, probeTimeoutMs: 4000 });
  const calls = (home: string) => fs.existsSync(path.join(home, 'calls.log')) ? fs.readFileSync(path.join(home, 'calls.log'), 'utf8') : '';
  const starts = (home: string) => calls(home).split('\n').filter(line => line === 'gateway start').length;
  return { root, profile, adapter, starts };
}

describe('starting a stopped Hermes profile', () => {
  it('a stopped default profile is started, becomes ready, and can be connected', async () => {
    const hermes = installation();
    const home = hermes.profile('default');
    const runtime = hermes.adapter(home);
    // Another profile running is listed by Hermes, and must not make this one look running.
    expect((await runtime.detect()).readiness).toBe('installed_not_running');
    const started = await runtime.start!({ pollMs: 50, readyTimeoutMs: 5000 });
    expect(started.readiness).toBe('ready');
    expect(started.serviceRunning).toBe(true);
    expect(hermes.starts(home)).toBe(1);
  });

  it('a stopped named profile is started with its own HERMES_HOME', async () => {
    const hermes = installation();
    const home = hermes.profile('fixture-named');
    const started = await hermes.adapter(home).start!({ pollMs: 50, readyTimeoutMs: 5000 });
    expect(started.readiness).toBe('ready');
    expect(fs.existsSync(path.join(home, 'gateway.pid'))).toBe(true);
    expect(fs.existsSync(path.join(hermes.root, 'gateway.pid'))).toBe(false);
  });

  it('starting one profile never starts, stops or changes another, and each starts on its own', async () => {
    const hermes = installation();
    const first = hermes.profile('default'), second = hermes.profile('fixture-second');
    await hermes.adapter(first).start!({ pollMs: 50, readyTimeoutMs: 5000 });
    expect((await hermes.adapter(second).detect()).readiness).toBe('installed_not_running');
    expect(hermes.starts(second)).toBe(0);
    const firstPid = fs.readFileSync(path.join(first, 'gateway.pid'), 'utf8');
    await hermes.adapter(second).start!({ pollMs: 50, readyTimeoutMs: 5000 });
    expect((await hermes.adapter(first).detect()).readiness).toBe('ready');
    expect((await hermes.adapter(second).detect()).readiness).toBe('ready');
    expect(fs.readFileSync(path.join(first, 'gateway.pid'), 'utf8')).toBe(firstPid);
    expect([hermes.starts(first), hermes.starts(second)]).toEqual([1, 1]);
  });

  it('an already-running profile is left exactly as it is', async () => {
    const hermes = installation();
    const home = hermes.profile('default');
    await hermes.adapter(home).start!({ pollMs: 50, readyTimeoutMs: 5000 });
    const pid = fs.readFileSync(path.join(home, 'gateway.pid'), 'utf8');
    const again = await hermes.adapter(home).start!({ pollMs: 50, readyTimeoutMs: 5000 });
    expect(again.readiness).toBe('ready');
    expect(hermes.starts(home)).toBe(1);
    expect(fs.readFileSync(path.join(home, 'gateway.pid'), 'utf8')).toBe(pid);
  });

  it('a failed start reports what Hermes said, and leaves the profile stopped for a retry', async () => {
    const hermes = installation();
    const home = hermes.profile('fixture-broken');
    fs.writeFileSync(path.join(home, 'start-fails'), '');
    await expect(hermes.adapter(home).start!({ pollMs: 50, readyTimeoutMs: 2000 }))
      .rejects.toThrow(/could not start this profile's gateway: .*Input\/output error/);
    expect((await hermes.adapter(home).detect()).readiness).toBe('installed_not_running');
    // Retry once the cause is gone.
    fs.rmSync(path.join(home, 'start-fails'));
    expect((await hermes.adapter(home).start!({ pollMs: 50, readyTimeoutMs: 5000 })).readiness).toBe('ready');
  });

  it('a start that never becomes ready is bounded, and says so', async () => {
    const hermes = installation();
    const home = hermes.profile('fixture-slow');
    fs.writeFileSync(path.join(home, 'never-ready'), '');
    const began = Date.now();
    await expect(hermes.adapter(home).start!({ pollMs: 50, readyTimeoutMs: 600 })).rejects.toThrow(/did not become ready/);
    expect(Date.now() - began).toBeLessThan(10_000);
  });

  it('a gateway.pid naming a process that is gone is not a running gateway', async () => {
    const hermes = installation();
    const home = hermes.profile('default');
    fs.writeFileSync(path.join(home, 'gateway.pid'), JSON.stringify({ pid: 999_999, kind: 'hermes-gateway' }));
    expect((await hermes.adapter(home).detect()).readiness).toBe('installed_not_running');
  });
});

describe('delivering files in a collaboration', () => {
  const output = { directory: '/tmp/fixture-output', manifest: '/tmp/fixture-output/manifest.json' };
  const collaborationTurn = (lead: string) => [{ type: 'room.event', event: { id: 'e', room_seq: 1, event_type: 'message.sent', actor_principal_id: 'other', actor_kind: 'agent', payload: { collaboration: { id: 'c', lead_principal_id: lead } } } }];

  it('the lead is offered the deliverables directory; a contributor is told to contribute in messages instead', () => {
    const lead = deliveryPrompt({ trigger: collaborationTurn('me') as any, agentPrincipalId: 'me' }, output);
    expect(lead).toContain(output.directory);
    const contributor = deliveryPrompt({ trigger: collaborationTurn('other') as any, agentPrincipalId: 'me' }, output);
    expect(contributor).not.toContain(output.directory);
    expect(contributor).toMatch(/lead produces the single agreed result/);
    expect(contributor).toContain('--collaboration-done');
  });
});
