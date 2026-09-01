import pg from "pg";
import { resetTestingWorkspace } from "./index.js";

function values(flag: string) {
  const output: string[] = [];
  for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === flag && process.argv[i + 1]) output.push(process.argv[++i]!);
  return output;
}
const value = (flag: string) => values(flag).at(-1);
const present = (flag: string) => process.argv.slice(2).includes(flag);
const required = (flag: string) => {
  const found = value(flag);
  if (!found) throw new Error(`Missing ${flag}`);
  return found;
};

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const companyId = required("--company-id");
const apply = present("--apply");
if (apply && value("--confirm") !== `TESTING:${companyId}`) {
  throw new Error(`Apply refused. Repeat with --confirm TESTING:${companyId}`);
}

const pool = new pg.Pool({ connectionString });
try {
  const result = await resetTestingWorkspace(pool, {
    companyId,
    managerPrincipalId: required("--manager-principal-id"),
    humanPrincipalIds: values("--human-principal-id"),
    agentPrincipalIds: values("--agent-principal-id"),
    roomName: value("--room-name") ?? "Acceptance Room",
    projectName: value("--project-name"),
    objective: value("--objective"),
    apply,
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.end();
}
