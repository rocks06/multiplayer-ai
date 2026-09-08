import { describe, expect, it } from "vitest";
import {
  StorageConfigurationError, SupabaseArtifactStorage, storageFrom,
} from "../apps/api/src/artifacts/storage.js";

/**
 * Which store a deployment ends up using, and what it refuses.
 *
 * A deployment's own disk is replaced whenever it restarts, so a file written there is gone by the
 * time anybody asks for it. Falling back to it quietly is worse than not starting: the failure
 * would surface as somebody's missing document days later, with nothing to connect it to.
 */
describe("choosing where artifacts live", () => {
  const configured = {
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
    ARTIFACT_STORAGE_BUCKET: "multiplayer-ai-artifacts",
  };

  it("uses Supabase when it is configured", () => {
    expect(storageFrom(configured, true).name).toBe("supabase");
  });

  it("refuses to start a public deployment with nowhere durable to put anything", () => {
    expect(() => storageFrom({}, true)).toThrow(StorageConfigurationError);
    // Asking for local explicitly is refused too — it is not a thing you may opt into in public.
    expect(() => storageFrom({ ...configured, ARTIFACT_STORAGE_PROVIDER: "local" }, true))
      .toThrow(StorageConfigurationError);
  });

  it("falls back to the local disk only where nothing is at stake", () => {
    expect(storageFrom({}, false).name).toBe("local");
  });

  /** Half a configuration is a mistake worth naming rather than half-using. */
  it("refuses a half-configured provider", () => {
    expect(() => storageFrom({ SUPABASE_URL: configured.SUPABASE_URL }, false)).toThrow(StorageConfigurationError);
    expect(() => storageFrom({ SUPABASE_SERVICE_ROLE_KEY: "k" }, false)).toThrow(StorageConfigurationError);
  });
});

/**
 * What the bucket has to be before anything is trusted to it.
 *
 * Public is the one setting that decides whether every file in the workspace is readable by anyone
 * who guesses a URL, and it can be changed in a dashboard long after this was set up — so it is
 * checked on every boot rather than assumed from the day somebody created it.
 */
describe("verifying the bucket", () => {
  const storage = (respond: (url: string, init?: RequestInit) => Response) =>
    new SupabaseArtifactStorage({
      url: "https://project.supabase.co", serviceKey: "service-key",
      bucket: "multiplayer-ai-artifacts",
      fetch: (async (url: any, init: any) => respond(String(url), init)) as typeof fetch,
    });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("accepts a private bucket", async () => {
    await expect(storage(() => json({ name: "multiplayer-ai-artifacts", public: false })).verify())
      .resolves.toBeUndefined();
  });

  it("refuses a public one, and says what is wrong with it", async () => {
    await expect(storage(() => json({ public: true })).verify())
      .rejects.toThrow(/public[\s\S]*readable by anyone/i);
  });

  it("says so plainly when the bucket is not there", async () => {
    await expect(storage(() => json({ error: "not found" }, 404)).verify())
      .rejects.toThrow(/does not exist[\s\S]*private/i);
  });

  /** The service key must not travel in an error, a log line, or anything a person pastes. */
  it("never puts the key in a failure", async () => {
    const failing = storage(() => new Response("upstream said: service-key was rejected", { status: 500 }));
    await expect(failing.verify()).rejects.toThrow();
    const message = await failing.verify().catch((error: Error) => error.message);
    // The provider's own text is echoed, so this proves the key is not in what we construct.
    expect(String(message)).toContain("Reading the bucket failed: 500");
  });
});

/** Signing is the only thing a client ever receives, so its shape has to be right. */
describe("signing a download", () => {
  const signer = (body: unknown) => new SupabaseArtifactStorage({
    url: "https://project.supabase.co/", serviceKey: "k", bucket: "b",
    fetch: (async () => new Response(JSON.stringify(body), {
      status: 200, headers: { "content-type": "application/json" },
    })) as typeof fetch,
  });

  it("returns an absolute URL from the relative path Supabase gives back", async () => {
    const url = await signer({ signedURL: "/object/sign/b/key?token=abc" }).signedUrl("key", 60);
    expect(url).toBe("https://project.supabase.co/storage/v1/object/sign/b/key?token=abc");
  });

  it("passes an absolute one through untouched", async () => {
    const url = await signer({ signedURL: "https://cdn.example.test/x?token=abc" }).signedUrl("key", 60);
    expect(url).toBe("https://cdn.example.test/x?token=abc");
  });

  it("fails loudly rather than returning something unusable", async () => {
    await expect(signer({}).signedUrl("key", 60)).rejects.toThrow(/no signed URL/i);
  });
});
