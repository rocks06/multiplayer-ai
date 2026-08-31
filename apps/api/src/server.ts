import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildApp } from "./app.js";
import { DeliveryConfigurationError } from "./auth/delivery-config.js";

/* Configuration lives in a .env file that is never committed, loaded here rather than by a
   dependency: Node reads one itself, and the alternative is trusting another package with the
   API key. Anything already set in the environment wins, so a deployment that injects its own
   variables is unaffected. */
const envFile = resolve(process.cwd(), process.env.ENV_FILE ?? ".env");
if (existsSync(envFile)) {
  try { process.loadEnvFile(envFile); }
  catch { console.warn(`[startup] ${envFile} could not be read; using the environment as it is`); }
}

let app;
try {
  app = buildApp();
} catch (failure) {
  if (failure instanceof DeliveryConfigurationError) {
    // The one startup failure worth spelling out: it is a configuration mistake with an obvious
    // fix, and continuing would mean sign-in links going nowhere anybody would look.
    console.error(`\n  Multiplayer AI cannot start.\n  ${failure.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  throw failure;
}

const port=Number(process.env.PORT??4100); const host=process.env.HOST??'127.0.0.1';
await app.listen({port,host});
console.log(`Room Engine API listening on http://${host}:${port}`);
