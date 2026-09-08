import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Where an artifact's bytes actually live.
 *
 * Kept behind an interface with nothing provider-shaped in it, so moving to S3 or R2 later is a
 * new file and a configuration change rather than a search through the product for assumptions.
 * Nothing above this layer knows what a bucket is, and the storage key is opaque to all of it.
 */
export interface ArtifactStorage {
  readonly name: string;
  /** Put the bytes somewhere. The key is ours; the provider only has to honour it. */
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /**
   * A URL the holder may download from, for a short time and nothing else.
   *
   * Short because a signed URL is authorization that has already left the building: once minted
   * nothing can check membership again, so it is issued per request, after that check, and expires
   * before it can be usefully passed around.
   */
  signedUrl(key: string, seconds: number): Promise<string>;
  remove(key: string): Promise<void>;
  /** Prove the destination is real and private, before anything is trusted to it. */
  verify(): Promise<void>;
}

export class StorageConfigurationError extends Error {}

/**
 * Supabase Storage, over its REST API.
 *
 * The service key is held here and never leaves: it is not logged, not returned, and never sent to
 * a browser. Everything a client receives is a signed URL that expires.
 */
export class SupabaseArtifactStorage implements ArtifactStorage {
  readonly name = "supabase";
  private readonly base: string;

  constructor(private readonly options: {
    url: string; serviceKey: string; bucket: string;
    fetch?: typeof globalThis.fetch;
  }) {
    this.base = `${options.url.replace(/\/+$/, "")}/storage/v1`;
  }

  private get send() { return this.options.fetch ?? globalThis.fetch; }
  private get headers() {
    return { authorization: `Bearer ${this.options.serviceKey}`, apikey: this.options.serviceKey };
  }
  /** Provider errors must never carry the key, and Supabase echoes request context in some. */
  private async fail(what: string, response: Response): Promise<never> {
    const detail = await response.text().catch(() => "");
    throw new Error(`${what} failed: ${response.status} ${detail.slice(0, 200)}`);
  }

  async put(key: string, body: Uint8Array, contentType: string) {
    const response = await this.send(`${this.base}/object/${this.options.bucket}/${key}`, {
      method: "POST",
      headers: { ...this.headers, "content-type": contentType, "cache-control": "3600" },
      body: body as unknown as BodyInit,
    });
    if (!response.ok) await this.fail("Uploading the artifact", response);
  }

  async signedUrl(key: string, seconds: number) {
    const response = await this.send(`${this.base}/object/sign/${this.options.bucket}/${key}`, {
      method: "POST",
      headers: { ...this.headers, "content-type": "application/json" },
      body: JSON.stringify({ expiresIn: seconds }),
    });
    if (!response.ok) await this.fail("Signing a download", response);
    const body = await response.json() as { signedURL?: string; signedUrl?: string };
    const path = body.signedURL ?? body.signedUrl;
    if (!path) throw new Error("Supabase returned no signed URL");
    return path.startsWith("http") ? path : `${this.base}${path.startsWith("/") ? "" : "/"}${path}`;
  }

  async remove(key: string) {
    const response = await this.send(`${this.base}/object/${this.options.bucket}/${key}`,
      { method: "DELETE", headers: this.headers });
    if (!response.ok && response.status !== 404) await this.fail("Removing the artifact", response);
  }

  /**
   * The bucket exists, and it is private.
   *
   * Public is the one setting that decides whether every file in the workspace is readable by
   * anyone who guesses a URL, and it can be changed in a dashboard long after this was set up. It
   * is checked on every boot rather than assumed from the day somebody created it.
   */
  async verify() {
    const response = await this.send(`${this.base}/bucket/${this.options.bucket}`, { headers: this.headers });
    if (response.status === 404) {
      throw new StorageConfigurationError(
        `The bucket "${this.options.bucket}" does not exist. Create it in Supabase Storage, private, before deploying.`);
    }
    if (!response.ok) await this.fail("Reading the bucket", response);
    const bucket = await response.json() as { public?: boolean };
    if (bucket.public) {
      throw new StorageConfigurationError(
        `The bucket "${this.options.bucket}" is public. Every artifact in it is readable by anyone with the URL. Make it private.`);
    }
  }
}

/**
 * The local filesystem, for development and tests only.
 *
 * Explicitly not durable: a deployment's disk is replaced whenever it restarts, so an artifact
 * written here would be gone by the time somebody asked for it. Choosing this in production is
 * refused at startup rather than discovered by a person whose file has vanished.
 */
export class LocalArtifactStorage implements ArtifactStorage {
  readonly name = "local";
  constructor(private readonly root: string, private readonly baseUrl = "/v1/local-artifacts") {}

  private path(key: string) {
    const full = resolve(this.root, key);
    // The key is ours, but resolving it is what makes that a fact rather than an intention.
    if (!full.startsWith(resolve(this.root))) throw new Error("Refusing a key that escapes the store");
    return full;
  }

  async put(key: string, body: Uint8Array, _contentType: string) {
    const file = this.path(key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
  }
  async signedUrl(key: string, seconds: number) {
    return `${this.baseUrl}/${encodeURIComponent(key)}?expires_in=${seconds}`;
  }
  async remove(key: string) { await rm(this.path(key), { force: true }); }
  async verify() { await mkdir(this.root, { recursive: true }); }
  /** Only this provider can be read back directly; the API uses it to serve local downloads. */
  async read(key: string) { return readFile(this.path(key)); }
}

export interface StorageEnvironment {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  ARTIFACT_STORAGE_BUCKET?: string;
  ARTIFACT_STORAGE_PROVIDER?: string;
  ARTIFACT_LOCAL_DIR?: string;
}

/**
 * Which store this deployment uses, decided once, from configuration.
 *
 * A production deployment that cannot reach real storage does not quietly write to a disk that is
 * about to be replaced: it refuses to start. That is the same rule the rest of this service
 * follows for settings that are safe locally and dangerous in public.
 */
export function storageFrom(environment: StorageEnvironment, production: boolean,
                            fetchImpl?: typeof globalThis.fetch): ArtifactStorage {
  const bucket = environment.ARTIFACT_STORAGE_BUCKET?.trim() || "multiplayer-ai-artifacts";
  const url = environment.SUPABASE_URL?.trim();
  const key = environment.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const asked = environment.ARTIFACT_STORAGE_PROVIDER?.trim().toLowerCase();

  /* Half a configuration is somebody who plainly meant Supabase and mistyped or forgot one line.
     Quietly using the local disk there hides the mistake until a file goes missing, so it is named
     here — in development too, where it is cheap to notice and free to fix. */
  if (!asked && Boolean(url) !== Boolean(key)) {
    throw new StorageConfigurationError(
      "Artifact storage is half configured: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are both "
      + "required, or neither, and neither means the local disk for development only.");
  }
  if (asked === "local" || (!asked && !(url && key))) {
    if (production) {
      throw new StorageConfigurationError(
        "Artifact storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY; a "
        + "deployment's own disk is replaced on every restart and cannot hold anybody's files.");
    }
    return new LocalArtifactStorage(environment.ARTIFACT_LOCAL_DIR?.trim()
      || join(process.cwd(), ".artifacts"));
  }
  if (!url || !key) {
    throw new StorageConfigurationError(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are both required for Supabase artifact storage.");
  }
  return new SupabaseArtifactStorage({ url, serviceKey: key, bucket, fetch: fetchImpl });
}
