import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { DomainError } from "../../domain/src/index.js";

export interface TestingResetInput {
  companyId: string;
  managerPrincipalId: string;
  humanPrincipalIds: string[];
  agentPrincipalIds: string[];
  roomName: string;
  projectName?: string;
  objective?: string;
  apply?: boolean;
}

export interface TestingResetPlan {
  mode: "dry_run" | "applied";
  company_id: string;
  company_name: "TESTING";
  preserved_human_principal_ids: string[];
  preserved_agent_principal_ids: string[];
  remove: Record<string, number>;
  created: null | { project_id: string; room_id: string; room_name: string };
}

const unique = (values: string[]) => [...new Set(values)];

async function count(client: PoolClient, sql: string, values: unknown[]) {
  const result = await client.query<{ count: number }>(sql, values);
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * Destructively resets one explicitly named TESTING workspace and nothing else.
 *
 * This is deliberately a library/CLI primitive, not an HTTP route. It requires the exact company
 * id, exact protected principal ids, and defaults to a rolled-back dry run. The transaction locks
 * the company before counting or deleting so the plan cannot drift while it is being applied.
 */
export async function resetTestingWorkspace(pool: Pool, input: TestingResetInput): Promise<TestingResetPlan> {
  const humans = unique([input.managerPrincipalId, ...input.humanPrincipalIds]);
  const agents = unique(input.agentPrincipalIds);
  if (!agents.length) throw new DomainError("testing_reset_agents_required", "At least one physical agent principal must be preserved", 400);
  if (!input.roomName.trim()) throw new DomainError("testing_reset_room_required", "The clean room needs a name", 400);

  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const company = await client.query<{ name: string }>("SELECT name FROM companies WHERE id=$1 FOR UPDATE", [input.companyId]);
    if (!company.rowCount) throw new DomainError("testing_reset_workspace_not_found", "Workspace not found", 404);
    if (company.rows[0]!.name !== "TESTING") {
      throw new DomainError("testing_reset_workspace_refused", "Reset is restricted to the workspace named exactly TESTING", 403);
    }

    const protectedIds = [...humans, ...agents];
    const protectedRows = await client.query<{ id: string; kind: string; status: string }>(
      "SELECT id,kind,status FROM principals WHERE company_id=$1 AND id=ANY($2::uuid[])",
      [input.companyId, protectedIds],
    );
    const byId = new Map(protectedRows.rows.map(row => [row.id, row]));
    for (const id of humans) {
      const principal = byId.get(id);
      if (!principal || principal.kind !== "human" || principal.status !== "active") {
        throw new DomainError("testing_reset_human_invalid", `Protected human principal is not active in TESTING: ${id}`, 409);
      }
    }
    for (const id of agents) {
      const principal = byId.get(id);
      if (!principal || principal.kind !== "agent" || principal.status !== "active") {
        throw new DomainError("testing_reset_agent_invalid", `Protected agent principal is not active in TESTING: ${id}`, 409);
      }
    }

    const manager = byId.get(input.managerPrincipalId);
    if (manager?.kind !== "human") throw new DomainError("testing_reset_manager_invalid", "Manager must be a protected human", 409);

    const remove: Record<string, number> = {
      rooms: await count(client, "SELECT count(*)::int count FROM rooms WHERE company_id=$1", [input.companyId]),
      room_memberships: await count(client, "SELECT count(*)::int count FROM room_members WHERE company_id=$1", [input.companyId]),
      room_events: await count(client, "SELECT count(*)::int count FROM room_events WHERE company_id=$1", [input.companyId]),
      messages: await count(client, "SELECT count(*)::int count FROM messages WHERE company_id=$1", [input.companyId]),
      tasks: await count(client, "SELECT count(*)::int count FROM tasks WHERE company_id=$1", [input.companyId]),
      external_credentials: await count(client, "SELECT count(*)::int count FROM external_agent_credentials WHERE company_id=$1", [input.companyId]),
      external_sessions: await count(client, "SELECT count(*)::int count FROM external_agent_sessions WHERE company_id=$1", [input.companyId]),
      enrollment_tokens: await count(client, "SELECT count(*)::int count FROM agent_enrollment_tokens WHERE company_id=$1", [input.companyId]),
      room_invites: await count(client, "SELECT count(*)::int count FROM room_invites WHERE company_id=$1", [input.companyId]),
      unprotected_agent_principals: await count(client, "SELECT count(*)::int count FROM principals WHERE company_id=$1 AND kind='agent' AND NOT (id=ANY($2::uuid[]))", [input.companyId, agents]),
    };

    if (!input.apply) {
      await client.query("ROLLBACK");
      return {
        mode: "dry_run", company_id: input.companyId, company_name: "TESTING",
        preserved_human_principal_ids: humans, preserved_agent_principal_ids: agents,
        remove, created: null,
      };
    }

    // Credential/token order matters: consumed enrollment tokens point at credentials, and
    // sessions point at both credentials and memberships.
    await client.query("DELETE FROM agent_enrollment_tokens WHERE company_id=$1", [input.companyId]);
    await client.query("DELETE FROM external_agent_sessions WHERE company_id=$1", [input.companyId]);
    await client.query("DELETE FROM external_agent_credentials WHERE company_id=$1", [input.companyId]);
    await client.query("DELETE FROM room_invites WHERE company_id=$1", [input.companyId]);

    // Hosted runs and decisions have a deliberate resume reference in both directions.
    await client.query("UPDATE agent_runs SET waiting_decision_id=NULL WHERE company_id=$1", [input.companyId]);
    await client.query("DELETE FROM decisions WHERE company_id=$1", [input.companyId]);
    await client.query("DELETE FROM agent_runs WHERE company_id=$1", [input.companyId]);

    await client.query("DELETE FROM command_receipts WHERE company_id=$1", [input.companyId]);
    await client.query("DELETE FROM room_events WHERE company_id=$1", [input.companyId]);
    // Mentions and read positions hang off messages and rooms, so they go before them.
    await client.query("DELETE FROM message_mentions WHERE company_id=$1", [input.companyId]);
    await client.query("DELETE FROM room_read_cursors WHERE company_id=$1", [input.companyId]);
    await client.query("DELETE FROM messages WHERE company_id=$1", [input.companyId]);
    await client.query("DELETE FROM task_dependencies WHERE company_id=$1", [input.companyId]);
    await client.query("DELETE FROM tasks WHERE company_id=$1", [input.companyId]);
    await client.query("DELETE FROM room_members WHERE company_id=$1", [input.companyId]);
    await client.query("DELETE FROM rooms WHERE company_id=$1", [input.companyId]);
    await client.query("DELETE FROM projects WHERE company_id=$1", [input.companyId]);

    const staleAgents = await client.query<{ id: string }>(
      "SELECT agent_id id FROM principals WHERE company_id=$1 AND kind='agent' AND NOT (id=ANY($2::uuid[]))",
      [input.companyId, agents],
    );
    // Ownership of an agent being removed goes with it; a preserved agent keeps its owners.
    await client.query("DELETE FROM agent_human_relationships WHERE company_id=$1 AND NOT (agent_principal_id=ANY($2::uuid[]))", [input.companyId, agents]);
    await client.query("DELETE FROM principals WHERE company_id=$1 AND kind='agent' AND NOT (id=ANY($2::uuid[]))", [input.companyId, agents]);
    if (staleAgents.rowCount) await client.query("DELETE FROM agents WHERE company_id=$1 AND id=ANY($2::uuid[])", [input.companyId, staleAgents.rows.map(row => row.id)]);

    const projectId = randomUUID(), roomId = randomUUID();
    await client.query(
      "INSERT INTO projects(id,company_id,name,objective,created_by_principal_id) VALUES($1,$2,$3,$4,$5)",
      [projectId, input.companyId, input.projectName?.trim() || "Acceptance", input.objective?.trim() || "Autonomous multi-agent acceptance", input.managerPrincipalId],
    );
    await client.query(
      "INSERT INTO rooms(id,company_id,project_id,name,created_by_principal_id) VALUES($1,$2,$3,$4,$5)",
      [roomId, input.companyId, projectId, input.roomName.trim(), input.managerPrincipalId],
    );
    for (const principalId of humans) {
      await client.query(
        "INSERT INTO room_members(id,company_id,room_id,principal_id,role,responsibilities) VALUES($1,$2,$3,$4,$5,$6)",
        [randomUUID(), input.companyId, roomId, principalId, principalId === input.managerPrincipalId ? "manager" : "contributor", "Acceptance participant"],
      );
    }
    for (const principalId of agents) {
      await client.query(
        "INSERT INTO room_members(id,company_id,room_id,principal_id,role,responsibilities) VALUES($1,$2,$3,$4,'worker_agent',$5)",
        [randomUUID(), input.companyId, roomId, principalId, "Autonomously coordinate on the room objective"],
      );
    }

    await client.query("COMMIT");
    return {
      mode: "applied", company_id: input.companyId, company_name: "TESTING",
      preserved_human_principal_ids: humans, preserved_agent_principal_ids: agents,
      remove, created: { project_id: projectId, room_id: roomId, room_name: input.roomName.trim() },
    };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}
