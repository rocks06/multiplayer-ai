#!/usr/bin/env node
/**
 * Builds the Connector's working half into one self-contained executable.
 *
 * Nobody installing the app should have to install Node, so the sidecar ships as a Node
 * single-executable: the connector core, the Hermes adapter, and the sidecar itself are bundled
 * into one script and injected into a copy of the Node binary. The result runs on a Mac that
 * has never seen Node, and is what the app spawns.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const connector = path.resolve(here, '..');
const repo = path.resolve(connector, '../..');
const out = path.join(connector, 'build');
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: repo, ...options });

const nodeBinary = process.env.MPAI_NODE_BINARY || process.execPath;
// Homebrew Node can be a tiny dynamically linked launcher, not a redistributable runtime.
// Reject it before touching old artifacts: otherwise a build can work only on its author's Mac.
const dependencies = execFileSync('otool', ['-L', nodeBinary], { encoding: 'utf8' })
  .split('\n').slice(1).map(line => line.trim().split(' (')[0]).filter(Boolean);
const external = dependencies.filter(file => !file.startsWith('/usr/lib/') && !file.startsWith('/System/Library/'));
if (external.length) {
  throw new Error('The SEA runtime has non-system dynamic dependencies. Set MPAI_NODE_BINARY to an official standalone Node macOS binary. Dependencies: ' + external.join(', '));
}
if (!fs.existsSync(path.join(repo, 'dist/packages/connector-core/src/index.js'))) {
  console.error('Compiled connector core not found. Run "pnpm build:server" first.');
  process.exit(1);
}
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// One CommonJS file: single-executable applications do not take ES modules.
console.log('• bundling sidecar');
run(path.join(repo, 'node_modules/.bin/esbuild'), [
  path.join(connector, 'sidecar/sidecar.mjs'),
  '--bundle', '--platform=node', '--target=node22', '--format=cjs',
  `--outfile=${path.join(out, 'sidecar.cjs')}`,
]);

fs.writeFileSync(path.join(out, 'sea-config.json'), JSON.stringify({
  main: path.join(out, 'sidecar.cjs'),
  output: path.join(out, 'sidecar.blob'),
  disableExperimentalSEAWarning: true,
}, null, 2));

console.log('• preparing the executable');
run(nodeBinary, ['--experimental-sea-config', path.join(out, 'sea-config.json')]);

const binary = path.join(out, 'mpai-connector-sidecar');
fs.copyFileSync(nodeBinary, binary);
// Distribution/package-manager binaries may be mode 0555. Injection needs a writable copy.
fs.chmodSync(binary, 0o755);
// The copied Node binary carries Node's own signature, which injection invalidates.
try { run('codesign', ['--remove-signature', binary]) } catch { /* unsigned already */ }

run(path.join(repo, 'node_modules/.bin/postject'), [
  binary, 'NODE_SEA_BLOB', path.join(out, 'sidecar.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  '--macho-segment-name', 'NODE_SEA',
]);
fs.chmodSync(binary, 0o755);
// Ad-hoc signing so macOS will run it; the app bundle is signed properly at packaging time.
run('codesign', ['--sign', '-', '--force', binary]);

const size = (fs.statSync(binary).size / 1_000_000).toFixed(1);
console.log(`✓ ${path.relative(repo, binary)} (${size} MB)`);
