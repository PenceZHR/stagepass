import path from "node:path";

export function defaultDatabasePath(cwd = /* turbopackIgnore: true */ process.cwd()): string {
  return path.resolve(cwd, "server", "db", "ship.db");
}

export function resolveDatabasePath(
  env: { STAGEPASS_DB_PATH?: string } = process.env as unknown as { STAGEPASS_DB_PATH?: string },
  cwd = /* turbopackIgnore: true */ process.cwd(),
): string {
  return path.resolve(cwd, env.STAGEPASS_DB_PATH || defaultDatabasePath(cwd));
}
