import type * as pg from "pg";
import { RoomService } from "../../apps/api/src/room-service.js";

/**
 * Creating a company and a person for a test.
 *
 * This used to happen over HTTP, through two routes that needed no credentials at all. Those are
 * gone from normal configuration, because a product that lets anyone create a company and a user
 * anonymously has a hole in it. Tests still need to arrange a world, so they call the services
 * directly here — no route, nothing reachable from outside, and nothing a deployment can expose
 * by accident.
 *
 * Anything a test wants to *prove* about signing up or signing in should go through the real
 * routes instead; this only sets the stage.
 */
export async function seedCompany(pool: pg.Pool, name = "Acme") {
  return new RoomService(pool).createCompany(name);
}

export async function seedHuman(pool: pg.Pool, companyId: string, email: string, displayName: string) {
  return new RoomService(pool).createHuman(companyId, email, displayName);
}
