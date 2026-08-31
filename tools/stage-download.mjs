#!/usr/bin/env node
/**
 * Puts the app into the site's deploy, and writes down exactly what went in.
 *
 * The disk image is a 40 MB binary that is rebuilt on every change: it belongs in the artifact
 * that gets deployed, never in the repository. This copies the one that was actually built and
 * records its digest, size, version and architecture beside it — so the download page states
 * facts read from the file rather than numbers somebody typed once and stopped updating.
 *
 * Run after `pnpm build:marketing`, which empties the output directory.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const image = path.join(repo, 'apps/connector-macos/build/Multiplayer AI.dmg');
const app = path.join(repo, 'apps/connector-macos/build/staged/Multiplayer AI.app');
const site = path.join(repo, 'dist/marketing');
/* Deliberately not /download: that path serves the page. Keeping the page and the file
   on separate routes removes any question of which one a request means. */
const out = path.join(site, 'app');

if (!fs.existsSync(image)) {
  console.error('No disk image. Build the app first: apps/connector-macos/scripts/build-app.sh');
  process.exit(1);
}
if (!fs.existsSync(site)) {
  console.error('No site build. Run "pnpm build:marketing" first — it empties this directory.');
  process.exit(1);
}

/* Read what shipped out of the image itself. A version the page states and a version the file
   carries have to be the same number, and the only way to be sure is to look. */
const facts = () => {
  const mount = fs.mkdtempSync('/tmp/mpai-dmg-');
  try {
    execFileSync('hdiutil', ['attach', '-nobrowse', '-quiet', '-readonly', image, '-mountpoint', mount]);
    const bundle = path.join(mount, 'Multiplayer AI.app');
    const plist = path.join(bundle, 'Contents/Info.plist');
    const read = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).trim();
    const arches = execFileSync('lipo', ['-archs', path.join(bundle, 'Contents/MacOS/Multiplayer AI')], { encoding: 'utf8' }).trim();
    return {
      version: read('CFBundleShortVersionString'),
      minimum_macos: read('LSMinimumSystemVersion'),
      scheme: read('CFBundleURLTypes:0:CFBundleURLSchemes:0'),
      architectures: arches.split(/\s+/),
    };
  } finally {
    try { execFileSync('hdiutil', ['detach', mount, '-quiet']) } catch { /* already gone */ }
    try { fs.rmSync(mount, { recursive: true, force: true }) } catch { /* nothing to remove */ }
  }
};

const bytes = fs.readFileSync(image);
const manifest = {
  file: 'Multiplayer AI.dmg',
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  built_at: new Date().toISOString(),
  ...facts(),
};

fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(image, path.join(out, manifest.file));
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`✓ staged ${manifest.file} (${(manifest.bytes / 1e6).toFixed(1)} MB)`);
console.log(`  version ${manifest.version} · macOS ${manifest.minimum_macos}+ · ${manifest.architectures.join(', ')}`);
console.log(`  sha256  ${manifest.sha256}`);
