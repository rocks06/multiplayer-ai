import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { GatewayClient } from "./gateway-client.js";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const types: Record<string, string> = { '.pdf':'application/pdf', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.gif':'image/gif', '.txt':'text/plain', '.md':'text/markdown', '.csv':'text/csv', '.json':'application/json', '.zip':'application/zip' };
export const generatedContentType = (file: string) => types[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
export interface GeneratedOutput { directory: string; manifest: string; receipts: string }

/** Only this fresh invocation's flat output directory is discoverable. Never parse paths from prose.
 * Links (including hard links), directories, empty/oversize files and missing declared outputs fail closed.
 * This is a delivery boundary, not a sandbox for an agent that already has terminal access. */
export function generatedFiles(output: GeneratedOutput) {
  const root = fs.realpathSync(output.directory);
  if (root !== path.resolve(output.directory)) throw new Error('Output directory must not be a symlink');
  const names = fs.readdirSync(root).sort();
  const manifest = JSON.parse(fs.readFileSync(output.manifest, 'utf8')) as { expected: string[] };
  if (!Array.isArray(manifest.expected) || manifest.expected.some(name => typeof name !== 'string' || path.basename(name) !== name || !names.includes(name))) throw new Error('A declared generated artifact is missing');
  if (names.length > 20) throw new Error('Too many generated artifacts');
  return names.map(name => {
    const fd = fs.openSync(path.join(root, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 25 * 1024 * 1024) throw new Error('Invalid generated artifact');
      const bytes = fs.readFileSync(fd);
      return { name, bytes, hash: digest(bytes) };
    } finally { fs.closeSync(fd); }
  });
}

/** Disk receipt is written BEFORE upload. An ambiguous/crashed upload is refused, not retransmitted.
 * Once prepared, retries send exactly the same atomic message payload with the same gateway key.
 * The exclusive receipt also fences concurrent command processes. */
export async function sendGeneratedMessage(client: GatewayClient, output: GeneratedOutput,
  input: Parameters<GatewayClient['sendMessage']>[0], key: string, scope: string) {
  // Validate before reserving a key: a missing file can be generated and retried safely.
  const files = generatedFiles(output);
  let body = input.body;
  for (const file of files) body = body.split(path.join(output.directory, file.name)).join(file.name);
  if (!input.artifactIds?.length && /(?:\/(?:Users|home|tmp|private|var|Volumes)\/|~\/|[A-Za-z]:\\)[^\n]*\.(?:pdf|png|jpe?g|webp|gif|txt|md|csv|json|zip|docx?|xlsx?|pptx?)\b/i.test(body)) {
    throw new Error(`Local file paths are not delivery. Write the deliverable inside ${output.directory}, then retry the message with the same key. No outside file was read or uploaded.`);
  }
  fs.mkdirSync(output.receipts, { recursive: true, mode: 0o700 });
  const receipt = path.join(output.receipts, digest(`${scope}\n${key}`) + '.json');
  const fingerprint = digest(JSON.stringify(input));
  let record: any;
  try {
    const fd = fs.openSync(receipt, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ fingerprint, status: 'preparing' }));
    fs.closeSync(fd);
  } catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    record = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    if (record.fingerprint !== fingerprint) throw new Error('Delivery key reused for a different message');
    if (record.status !== 'prepared') throw new Error('Previous artifact delivery incomplete; refusing retransmission');
  }
  if (!record) {
    const explicitPath = output.manifest + '.uploaded';
    const explicit = fs.existsSync(explicitPath) ? JSON.parse(fs.readFileSync(explicitPath, 'utf8')) : {};
    const ids = [...(input.artifactIds ?? [])];
    for (const file of files) {
      const uploaded = explicit[file.hash] ?? await client.uploadArtifact({ filename: file.name, contentType: generatedContentType(file.name), body: file.bytes });
      if (!uploaded.id) throw new Error('Artifact upload returned no id');
      ids.push(uploaded.id);
    }
    record = { fingerprint, status: 'prepared', input: { ...input, body, artifactIds: [...new Set(ids)] }, files: files.map(f => f.hash) };
    const temporary = receipt + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temporary, receipt);
  }
  const result = await client.sendMessage(record.input, key);
  fs.writeFileSync(output.manifest + '.delivered', JSON.stringify(record.files), { mode: 0o600 });
  return result;
}

export function verifyGeneratedDelivery(output: GeneratedOutput) {
  const files = generatedFiles(output);
  const delivered = fs.existsSync(output.manifest + '.delivered') ? JSON.parse(fs.readFileSync(output.manifest + '.delivered', 'utf8')) as string[] : [];
  if (files.some(file => !delivered.includes(file.hash))) throw new Error('Generated artifacts were not delivered in a room message');
}

export function rememberExplicitArtifact(output: GeneratedOutput, file: string, id: string) {
  // Explicit attach retains its historical arbitrary-path semantics; only cache files in this invocation.
  if (path.dirname(path.resolve(file)) !== output.directory) return;
  const found = generatedFiles(output).find(item => item.name === path.basename(file));
  if (!found) return;
  const target = output.manifest + '.uploaded';
  const records = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : {};
  records[found.hash] = { id };
  fs.writeFileSync(target, JSON.stringify(records), { mode: 0o600 });
}
