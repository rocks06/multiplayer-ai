#!/usr/bin/env node
/**
 * Publishes the marketing site with the app inside it.
 *
 * The order is the whole point, and getting it wrong is not visible until somebody tries to
 * download the product. `build:marketing` empties `dist/marketing`, so staging the disk image
 * before it runs stages the image into a directory that is about to be deleted. That is what
 * happened: the site went live with `/app/manifest.json` and `/app/Multiplayer AI.dmg` returning
 * 404, and the deploy itself reported success.
 *
 * Two things stop it happening again. The steps run here, in order, rather than being remembered
 * by whoever is deploying — and the upload is prebuilt, so Netlify cannot run `build:marketing`
 * again on its own and empty the directory a second time after the image is in it. Netlify could
 * not rebuild the image anyway: it is a macOS artifact, and their builders are Linux.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(repo, 'dist/marketing');
/* A step that fails has already said why, in its own words and on this terminal. Re-throwing it
   as a Node stack trace buries that under the internals of how it was spawned. */
/* Same as `run`, but the child's stdout is wanted rather than shown. Errors still reach the
   terminal, so a failure explains itself exactly as it would otherwise. */
const capture = (command, args) => {
  try {
    return execFileSync(command, args,
      { cwd: repo, encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'], env: process.env });
  } catch (failure) {
    console.error(`\n✗ ${command} ${args.join(' ')} failed — nothing was published.`);
    process.exit(typeof failure?.status === 'number' ? failure.status : 1);
  }
};

const run = (command, args) => {
  try { execFileSync(command, args, { cwd: repo, stdio: 'inherit', env: process.env }); }
  catch (failure) {
    console.error(`\n✗ ${command} ${args.join(' ')} failed — nothing was published.`);
    process.exit(typeof failure?.status === 'number' ? failure.status : 1);
  }
};

/* Either kind of credential will do: an access token in the environment, or a CLI that has been
   logged in interactively. Requiring the token alone turned `netlify login` into a dead end. */
const cliConfig = path.join(os.homedir(), '.config/netlify/config.json');
const loggedIn = () => {
  try { return Object.keys(JSON.parse(fs.readFileSync(cliConfig, 'utf8')).users ?? {}).length > 0; }
  catch { return false; }
};
if (!process.env.NETLIFY_AUTH_TOKEN && !loggedIn()) {
  console.error('No Netlify credential. Either set NETLIFY_AUTH_TOKEN, or run `npx netlify-cli@17 login`.');
  process.exit(1);
}
const stateFile = path.join(repo, '.netlify/state.json');
if (!fs.existsSync(stateFile)) {
  console.error('No .netlify/state.json, so there is no site to deploy to.');
  process.exit(1);
}
const siteId = JSON.parse(fs.readFileSync(stateFile, 'utf8')).siteId;
if (!siteId) { console.error('.netlify/state.json names no siteId.'); process.exit(1); }

console.log('• building the site (this empties dist/marketing)');
run('pnpm', ['build:marketing']);

console.log('• staging the app into the site');
run('node', ['tools/stage-download.mjs']);

/* Refuse to publish a site whose download does not exist. The failure this exists to prevent was
   silent: a successful deploy, a working front page, and a download that 404s — found only by
   someone trying to install the product. */
const manifestPath = path.join(site, 'app/manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error('No app/manifest.json in the build. Refusing to publish a site with no download.');
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const image = path.join(site, 'app', manifest.file);
if (!fs.existsSync(image)) {
  console.error(`Manifest names ${manifest.file}, which is not in the build. Refusing to publish.`);
  process.exit(1);
}
if (fs.statSync(image).size !== manifest.bytes) {
  console.error('The staged image is not the size its manifest claims. Refusing to publish.');
  process.exit(1);
}
console.log(`  ${manifest.file} · ${manifest.sha256}`);

/* No --build, deliberately, and that is the whole of it.

   This CLI builds only when asked: `--build` is opt-in, and there is no `--no-build` to pass — an
   earlier attempt passed one and the deploy failed on the unknown flag. Leaving it off is what
   stops Netlify running `build:marketing`, which would empty dist/marketing and take the image
   back out after we just put it in. The version is pinned because that is a promise about flags. */
console.log('• deploying to production');
const output = capture('npx', ['-y', 'netlify-cli@17', 'deploy', '--prod', '--json',
                               '--dir', 'dist/marketing', '--site', siteId]);
let live;
try { live = JSON.parse(output).url; } catch { /* fall through to the check below */ }
if (!live) {
  console.error('The deploy returned no site URL, so it cannot be checked. Verify by hand.');
  process.exit(1);
}

/* Check the published site, not the directory that was uploaded.

   The failure this exists to prevent reported success: the deploy worked, the front page worked,
   and the download 404'd. Uploading the right bytes and serving them are two different claims,
   and only the second one matters to somebody installing the product. */
console.log(`• checking ${live}`);
const manifestUrl = `${live}/app/manifest.json`;
const imageUrl = `${live}/app/${encodeURIComponent(manifest.file)}`;
const published = await fetch(manifestUrl, { redirect: 'follow' });
// HEAD, because the question is whether it is served, not what forty megabytes contain.
const downloadable = await fetch(imageUrl, { method: 'HEAD', redirect: 'follow' });
const served = published.ok ? await published.json() : null;

console.log(`  ${published.status}  ${manifestUrl}`);
console.log(`  ${downloadable.status}  ${imageUrl}`);
if (!published.ok || !downloadable.ok) {
  console.error('\n✗ published, but the download is not being served. Do not announce this build.');
  process.exit(1);
}
if (served?.sha256 !== manifest.sha256) {
  console.error(`\n✗ live manifest says ${served?.sha256}, expected ${manifest.sha256}.`);
  process.exit(1);
}

console.log(`\n✓ published and serving ${manifest.file}`);
console.log(`  sha256   ${served.sha256}`);
console.log(`  built_at ${served.built_at}`);
