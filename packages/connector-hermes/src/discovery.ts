import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentDiscoveryProvider } from '../../connector-core/src/discovery.js';
import { HermesAdapter } from './index.js';

/**
 * Where Hermes keeps its profiles, by Hermes' own rule.
 *
 * `HERMES_HOME` may itself be one profile (`<root>/profiles/<id>`), and the profiles beside it
 * belong to the same root. Reading only `HERMES_HOME` would show one agent and hide the others.
 */
export function hermesRoot(env: NodeJS.ProcessEnv = process.env): string {
  const native = path.join(env.HOME ?? '', '.hermes');
  const configured = env.HERMES_HOME;
  if (!configured) return native;
  const home = path.resolve(configured);
  const inside = path.relative(native, home);
  if (inside === '' || (!inside.startsWith('..') && !path.isAbsolute(inside))) return native;
  return path.basename(path.dirname(home)) === 'profiles' ? path.dirname(path.dirname(home)) : home;
}

/**
 * The name a person gave a profile, from Hermes' `profile.yaml`.
 *
 * Presentation only: identity never comes from it. Read with a single-key parse rather than a YAML
 * library because it is one scalar Hermes writes itself, and an unreadable file is just "no name".
 */
export function profileDisplayName(home: string): string | null {
  let text: string;
  try { text = fs.readFileSync(path.join(home, 'profile.yaml'), 'utf8'); } catch { return null; }
  const match = /^display_name:[ \t]*(.*)$/m.exec(text);
  if (!match) return null;
  let value = match[1]!.trim();
  if (value.length >= 2 && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))) {
    value = value.slice(1, -1);
  }
  const clean = Array.from(value).filter(character => character >= ' ' && character !== '\u007f').join('').trim();
  return clean ? clean.slice(0, 64) : null;
}

/** Only enumerate conventional runtime profile directories, never arbitrary user files. */
export function hermesDiscovery(options: { command?: string; home?: string; probeTimeoutMs?: number } = {}): AgentDiscoveryProvider {
  const root = options.home ?? hermesRoot();
  return { id: 'hermes', async discover() {
    // Preserve the historical default binding; named profiles use directory identity instead.
    const profiles = [{name: 'default', home: root, discoveryId: 'hermes:default', displayName: profileDisplayName(root)}];
    const profilesDir = path.join(root, 'profiles');
    try {
      for (const entry of fs.readdirSync(profilesDir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
        // `default` is never a named profile, and a tombstone beside the directory means Hermes
        // deleted it: listing either offers an agent that does not exist.
        if (!entry.isDirectory() || entry.name === 'default' || !/^[a-zA-Z0-9_-]{1,64}$/.test(entry.name)) continue;
        if (fs.existsSync(path.join(profilesDir, '.deleted', entry.name))) continue;
        const profileHome = path.join(profilesDir, entry.name);
        let stat: fs.BigIntStats;
        try { stat = fs.lstatSync(profileHome, {bigint: true}); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        if (!stat.isDirectory()) continue;
        // No path/name, mtime or ctime: same-volume renames and config edits retain identity.
        // Birth time disambiguates recreated directories even when the inode is recycled.
        const identity = createHash('sha256').update(`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`).digest('hex');
        profiles.push({name: entry.name, home: profileHome, discoveryId: `hermes:profile:${identity}`, displayName: profileDisplayName(profileHome)});
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Local agent profiles could not be read. Check their permissions.'); }
    if (profiles.length > 32) throw new Error('Too many local profiles to scan safely. Select a runtime home under Advanced.');
    return profiles.map(profile => ({ discoveryId: profile.discoveryId, profile: profile.name, displayName: profile.displayName,
      adapter: new HermesAdapter({command: options.command, home: profile.home, probeTimeoutMs: options.probeTimeoutMs}) }));
  } };
}
