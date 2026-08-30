import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pg from "pg";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "../apps/api/src/app.js";
import { SilentSignInLinkDelivery } from "../apps/api/src/auth/auth-service.js";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

/**
 * Serving the built web app.
 *
 * The static plugin is registered with `wildcard:false`, which walks the directory once and
 * registers a route per file it finds *at boot*. A web build that lands after the server starts
 * is therefore invisible to it — and because Vite fingerprints its filenames, the index it does
 * serve points at asset names that were never registered. The result is a 200 for the page and a
 * 404 for everything it needs: a blank screen, with nothing in the console to explain it.
 *
 * That is not a hypothetical. It is what the LAN-served app was doing.
 */
describe("The built web app is served", () => {
  const webRoot = join(process.cwd(), "dist/web");
  const assets = join(webRoot, "assets");
  const indexFile = join(webRoot, "index.html");
  let pool: pg.Pool, app: ReturnType<typeof buildApp>;
  let parked: string | null = null;
  // These tests write into the real build output, because that is the directory the server is
  // hard-wired to serve. Whatever was there is put back, so running the suite never leaves a
  // developer with a broken local build.
  let originalIndex: Buffer | null = null;

  beforeEach(async () => {
    mkdirSync(assets, { recursive: true });
    originalIndex = existsSync(indexFile) ? readFileSync(indexFile) : null;
    pool = new Pool({ connectionString });
    app = buildApp(pool, { pollIntervalMs: 50 }, { allowHeaderPrincipal: false, signInDelivery: new SilentSignInLinkDelivery() });
    // Plugins register on ready, not on buildApp. Without this the directory walk happens *after*
    // the test writes its file, and the test passes against the very bug it is meant to catch.
    await app.ready();
  });
  afterEach(async () => {
    if (parked && existsSync(parked)) rmSync(parked);
    parked = null;
    if (originalIndex) writeFileSync(indexFile, originalIndex);
    else if (existsSync(indexFile)) rmSync(indexFile);
    originalIndex = null;
    await app.close();
  });

  it("serves an asset that was built after the server started", async () => {
    // The whole point: this file did not exist when buildApp registered its routes.
    parked = join(assets, `index-TESTHASH.js`);
    writeFileSync(parked, "export const built='after boot';\n");

    const response = await app.inject({ method: "GET", url: "/assets/index-TESTHASH.js" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("after boot");
  });

  it("refuses to serve anything outside the web root", async () => {
    for (const escape of ["/assets/../../../etc/passwd", "/assets/..%2f..%2f..%2fetc%2fpasswd"]) {
      const response = await app.inject({ method: "GET", url: escape });
      expect(response.statusCode).not.toBe(200);
    }
  });

  it("still answers deep links with the page itself", async () => {
    writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>app</title>");
    for (const deep of ["/home", "/settings", "/rooms/a/b"]) {
      const response = await app.inject({ method: "GET", url: deep });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("<!doctype html>");
    }
  });
});
