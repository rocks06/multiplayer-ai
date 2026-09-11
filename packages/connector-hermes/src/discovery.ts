import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentDiscoveryProvider } from '../../connector-core/src/discovery.js';
import { HermesAdapter } from './index.js';

/** Only enumerate conventional runtime profile directories, never arbitrary user files. */
export function hermesDiscovery(options: { command?: string; home?: string; probeTimeoutMs?: number } = {}): AgentDiscoveryProvider {
  const home = options.home ?? process.env.HERMES_HOME ?? path.join(process.env.HOME ?? '', '.hermes');
  return { id: 'hermes', async discover() {
    // Preserve the historical default binding; named profiles use directory identity instead.
    const profiles = [{name: 'default', home, discoveryId: 'hermes:default'}];
    try {
      for (const entry of fs.readdirSync(path.join(home, 'profiles'), {withFileTypes: true})) {
        if (entry.isDirectory() && /^[a-zA-Z0-9_-]{1,64}$/.test(entry.name)) {
          const profileHome = path.join(home, 'profiles', entry.name);
          let stat: fs.BigIntStats;
          try { stat = fs.lstatSync(profileHome, {bigint: true}); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
          if (!stat.isDirectory()) continue;
          // No path/name, mtime or ctime: same-volume renames and config edits retain identity.
          // Birth time disambiguates recreated directories even when the inode is recycled.
          const identity = createHash('sha256').update(`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`).digest('hex');
          profiles.push({name: entry.name, home: profileHome, discoveryId: `hermes:profile:${identity}`});
        }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Local agent profiles could not be read. Check their permissions.'); }
    if (profiles.length > 32) throw new Error('Too many local profiles to scan safely. Select a runtime home under Advanced.');
    return profiles.map(profile => ({ discoveryId: profile.discoveryId, profile: profile.name,
      adapter: new HermesAdapter({command: options.command, home: profile.home, probeTimeoutMs: options.probeTimeoutMs}) }));
  } };
}
