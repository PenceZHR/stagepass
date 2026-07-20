import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import path from "path";
import * as schema from "./schema";
import { runMigrations } from "./migrate";
import { defaultDatabasePath, resolveDatabasePath } from "./config";

export const DEFAULT_DB_PATH = defaultDatabasePath();
export { resolveDatabasePath } from "./config";

function sqliteBusyTimeoutMs(): number {
  const raw = process.env.STAGEPASS_SQLITE_BUSY_TIMEOUT_MS;
  if (!raw) return 10_000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10_000;
}

export interface DatabaseHandle {
  path: string;
  sqlite: Database.Database;
  db: ReturnType<typeof drizzle<typeof schema>>;
  close(): void;
}

export function createDatabaseHandle(options: {
  path?: string;
  sqlite?: Database.Database;
  migrate?: boolean;
} = {}): DatabaseHandle {
  const dbPath = path.resolve(options.path ?? resolveDatabasePath());
  const sqlite = options.sqlite ?? new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma(`busy_timeout = ${sqliteBusyTimeoutMs()}`);
  sqlite.pragma("foreign_keys = ON");

  if (options.migrate === true) runMigrations(sqlite);
  const db = drizzle(sqlite, { schema });
  return {
    path: dbPath,
    sqlite,
    db,
    close: () => sqlite.close(),
  };
}

let defaultHandle: DatabaseHandle | null = null;

export const databasePath = path.resolve(resolveDatabasePath());

export function getDatabaseHandle(): DatabaseHandle {
  defaultHandle ??= createDatabaseHandle({ path: databasePath, migrate: false });
  return defaultHandle;
}

export function closeDatabaseHandle(): void {
  defaultHandle?.close();
  defaultHandle = null;
}

export function migrateDatabase(targetPath = databasePath): { applied: string[] } {
  const handle = createDatabaseHandle({ path: targetPath, migrate: false });
  try {
    return runMigrations(handle.sqlite);
  } finally {
    handle.close();
  }
}

function lazyProxy<T extends object>(resolve: () => T): T {
  return new Proxy({} as T, {
    get(_target, property) {
      const target = resolve();
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(_target, property, value) {
      const target = resolve();
      return Reflect.set(target, property, value, target);
    },
  });
}

export const databaseHandle = lazyProxy<DatabaseHandle>(getDatabaseHandle);
export const sqlite = lazyProxy<Database.Database>(() => getDatabaseHandle().sqlite);
export const db = lazyProxy<ReturnType<typeof drizzle<typeof schema>>>(() => getDatabaseHandle().db);
