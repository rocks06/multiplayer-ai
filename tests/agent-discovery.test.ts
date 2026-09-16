import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentDiscovery } from '../packages/connector-core/src/discovery.js';
import type { AgentRuntimeAdapter } from '../packages/connector-core/src/types.js';
import { HermesAdapter } from '../packages/connector-hermes/src/index.js';
import { hermesDiscovery, hermesRoot, profileDisplayName } from '../packages/connector-hermes/src/discovery.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => fs.rm(p, {recursive: true, force: true}))); });
const adapter = (id: string, available = true): AgentRuntimeAdapter => ({id, detect: async () => ({name: id, available, readiness: available ? 'ready' : 'not_installed'}), health:async()=>({ok:available}), invoke: async () => ({ok:true,exitCode:0})});
describe('adapter-neutral discovery', () => {
 it('fresh user: discovers and selects one runtime without an enrollment code', async () => {
  const candidate = {discoveryId:'other:default', profile:'default', adapter:adapter('other')};
  const discovery = new AgentDiscovery([{id:'other',discover:async()=>[candidate]}]);
  expect(await discovery.scan()).toHaveLength(1);
  expect((await discovery.select(candidate.discoveryId)).candidate).toBe(candidate);
 });
 it('returns an explicit empty result and supports Retry', async () => {
  let available = false;
  const discovery = new AgentDiscovery([{id:'other',discover:async()=>[{discoveryId:'other:default',profile:'default',adapter:adapter('other',available)}]}]);
  expect(await discovery.scan()).toEqual([]);
  available = true; expect(await discovery.scan()).toHaveLength(1);
 });
 it('does not infer adapter identity from its presentation and rejects unknown selections', async () => {
  const discovery = new AgentDiscovery([{id:'future',discover:async()=>[{discoveryId:'future:research',profile:'research',adapter:adapter('future')}]}]);
  expect((await discovery.scan())[0]!.candidate.adapter.id).toBe('future');
  await expect(discovery.select('invented')).rejects.toThrow('Scan again');
 });
 it('enumerates installed profiles read-only and keeps default identity namespace stable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'mpai-discovery-'));roots.push(root);
  await fs.mkdir(path.join(root,'profiles','research'),{recursive:true});
  await fs.writeFile(path.join(root,'profiles','research','config.yaml'),'model: fixture\n');
  const candidates = await hermesDiscovery({home:root,command:'/missing-fixture'}).discover();
  expect(candidates.map(x=>x.profile)).toEqual(['default','research']);
  expect(candidates[0]!.discoveryId).toBe('hermes:default');
  expect(candidates[1]!.discoveryId).toMatch(/^hermes:profile:[a-f0-9]{64}$/);
  expect(await fs.readdir(path.join(root,'profiles','research'))).toEqual(['config.yaml']);
  expect(await fs.readFile(path.join(root,'profiles','research','config.yaml'),'utf8')).toBe('model: fixture\n');
 });
 it('preserves named-profile identity across same-volume rename and config changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'mpai-discovery-'));roots.push(root);
  const original = path.join(root,'profiles','research');
  const renamed = path.join(root,'profiles','renamed');
  await fs.mkdir(original,{recursive:true});
  const provider = hermesDiscovery({home:root,command:'/missing-fixture'});
  const before = (await provider.discover())[1]!;
  await fs.rename(original,renamed);
  await fs.writeFile(path.join(renamed,'config.yaml'),'model: changed-fixture\n');
  const after = (await provider.discover())[1]!;
  expect(after.profile).toBe('renamed');
  expect(after.discoveryId).toBe(before.discoveryId);
  expect((await hermesDiscovery({home:root,command:'/missing-fixture'}).discover())[1]!.discoveryId).toBe(before.discoveryId);
 });
 it('assigns a new identity when a named-profile directory is deleted and recreated', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'mpai-discovery-'));roots.push(root);
  const profile = path.join(root,'profiles','research');
  await fs.mkdir(profile,{recursive:true});
  const provider = hermesDiscovery({home:root,command:'/missing-fixture'});
  const before = (await provider.discover())[1]!;
  await fs.rm(profile,{recursive:true});
  await fs.mkdir(profile);
  const after = (await provider.discover())[1]!;
  expect(after.profile).toBe(before.profile);
  expect(after.discoveryId).not.toBe(before.discoveryId);
 });
 it('distinguishes identically named profiles in different homes, and never lists a directory named default twice', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'mpai-discovery-'));roots.push(root);
  const homes = [path.join(root,'one'),path.join(root,'two')];
  for (const home of homes) {
   await fs.mkdir(path.join(home,'profiles','research'),{recursive:true});
   await fs.mkdir(path.join(home,'profiles','default'));
  }
  const scans = await Promise.all(homes.map(home=>hermesDiscovery({home,command:'/missing-fixture'}).discover()));
  for (const scan of scans) {
   expect(scan[0]!.discoveryId).toBe('hermes:default');
   // Hermes' default profile is the home itself; a stray profiles/default is not a second agent.
   expect(scan.map(candidate=>candidate.profile)).toEqual(['default','research']);
  }
  const namedIds = scans.flatMap(scan=>scan.slice(1).map(candidate=>candidate.discoveryId));
  expect(new Set(namedIds).size).toBe(2);
  expect(namedIds).not.toContain('hermes:default');
 });
 /* The MacBook Air: one Hermes, two agents — JJ is the default profile and AXON a named one. Each
    is its own card with its own name, and a profile Hermes deleted is not offered at all. */
 it('lists every real Hermes profile with the name Hermes gives it, and skips deleted ones', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'mpai-discovery-'));roots.push(root);
  await fs.writeFile(path.join(root,'profile.yaml'),'display_name: JJ\n');
  await fs.mkdir(path.join(root,'profiles','axon'),{recursive:true});
  await fs.writeFile(path.join(root,'profiles','axon','profile.yaml'),"description: research lead\ndisplay_name: 'AXON'\n");
  await fs.mkdir(path.join(root,'profiles','scratch'),{recursive:true});
  await fs.mkdir(path.join(root,'profiles','gone'),{recursive:true});
  await fs.mkdir(path.join(root,'profiles','.deleted','gone'),{recursive:true});
  await fs.writeFile(path.join(root,'profiles','notes.txt'),'not a profile');
  const candidates = await hermesDiscovery({home:root,command:'/missing-fixture'}).discover();
  expect(candidates.map(c=>[c.profile,c.displayName])).toEqual([['default','JJ'],['axon','AXON'],['scratch',null]]);
  expect(new Set(candidates.map(c=>c.discoveryId)).size).toBe(3);
 });
 it('finds the whole Hermes root when HERMES_HOME points at one profile', () => {
  expect(hermesRoot({HOME:'/Users/someone'})).toBe('/Users/someone/.hermes');
  expect(hermesRoot({HOME:'/Users/someone',HERMES_HOME:'/Users/someone/.hermes/profiles/axon'})).toBe('/Users/someone/.hermes');
  expect(hermesRoot({HOME:'/Users/someone',HERMES_HOME:'/opt/data/profiles/axon'})).toBe('/opt/data');
  expect(hermesRoot({HOME:'/Users/someone',HERMES_HOME:'/opt/data'})).toBe('/opt/data');
 });
 it('reads a display name defensively: quoted, missing, empty or unreadable is never a blank name', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'mpai-discovery-'));roots.push(root);
  expect(profileDisplayName(root)).toBeNull();
  await fs.writeFile(path.join(root,'profile.yaml'),'display_name: ""\n');
  expect(profileDisplayName(root)).toBeNull();
  await fs.writeFile(path.join(root,'profile.yaml'),'display_name: "Research \u0007Lead"\n');
  expect(profileDisplayName(root)).toBe('Research Lead');
 });
 it('a stalled runtime probe is bounded and does not block the helper event loop', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'mpai-probe-'));roots.push(root);
  const command=path.join(root,'fixture');
  await fs.writeFile(command,'#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Hermes Agent v0.20.5"; exit 0; fi\nexec /bin/sleep 30\n',{mode:0o755});
  const runtime = new HermesAdapter({command,home:root,probeTimeoutMs:100});
  const start=Date.now(); let heartbeat=false;
  setTimeout(()=>{heartbeat=true;},20);
  await runtime.detect();
  expect(heartbeat).toBe(true);expect(Date.now()-start).toBeLessThan(2000);
 });
});
