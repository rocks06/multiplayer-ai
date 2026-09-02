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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(repo, 'dist/marketing');
/* A step that fails has already said why, in its own words and on this terminal. Re-throwing it
   as a Node stack trace buries that under the internals of how it was spawned. */
const run = (command, args) => {
  try { execFileSync(command, args, { cwd: repo, stdio: 'inherit', env: process.env }); }
  catch (failure) {
    console.error(`\n✗ ${command} ${args.join(' ')} failed — nothing was published.`);
    process.exit(typeof failure?.status === 'number' ? failure.status : 1);
  }
};

const token = process.env.NETLIFY_AUTH_TOKEN;
if (!token) {
  console.error('NETLIFY_AUTH_TOKEN is not set. Add it to .env, or export it, and run again.');
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

/* --no-build, deliberately. Netlify has a build command configured, and running it here would
   empty dist/marketing and take the image back out again — which is exactly the bug. */
console.log('• deploying to production');
run('npx', ['-y', 'netlify-cli@17', 'deploy', '--prod', '--no-build',
            '--dir', 'dist/marketing', '--site', siteId]);

console.log(`\n✓ published ${manifest.file}`);
console.log(`  sha256   ${manifest.sha256}`);
console.log(`  built_at ${manifest.built_at}`);
