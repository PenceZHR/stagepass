import { createChildLogger } from "../logger";

const log = createChildLogger("sqlite-write-boundary");

export interface SqliteWriteRetryOptions {
  maxAttempts?: number;
  delaysMs?: number[];
}

export type SqliteWriteLockCode = "SQLITE_BUSY" | "SQLITE_LOCKED" | "UNKNOWN_LOCK";

export class SqliteWriteBusyError extends Error {
  readonly code = "sqlite_write_busy";

  constructor(
    message: string,
    public readonly cause: unknown,
    public readonly attempts: number,
    public readonly label: string,
    public readonly elapsedMs = 0,
    public readonly sqliteCode: SqliteWriteLockCode =
      sqliteWriteLockCode(cause) ?? "UNKNOWN_LOCK",
    public readonly sqliteExtendedCode: string | null = extractSqliteExtendedCode(cause),
  ) {
    super(message);
    this.name = "SqliteWriteBusyError";
  }
}

const defaultDelaysMs = [50, 100, 200, 400, 800];

function extractSqliteExtendedCode(error: unknown): string | null {
  if (!(error instanceof Error) || !("code" in error)) return null;
  const code = String(error.code);
  return code.startsWith("SQLITE_") ? code : null;
}

function sqliteWriteLockCode(error: unknown): SqliteWriteLockCode | null {
  if (!(error instanceof Error)) return null;
  const code = "code" in error ? String(error.code) : "";
  if (code === "SQLITE_BUSY" || code.startsWith("SQLITE_BUSY_")) return "SQLITE_BUSY";
  if (code === "SQLITE_LOCKED" || code.startsWith("SQLITE_LOCKED_")) return "SQLITE_LOCKED";
  if (
    error.message.includes("database is locked") ||
    error.message.includes("database table is locked")
  ) {
    return "UNKNOWN_LOCK";
  }
  return null;
}

export function isRetryableSqliteWriteError(error: unknown): boolean {
  return sqliteWriteLockCode(error) !== null;
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withSqliteWriteRetry<T>(
  label: string,
  write: () => T,
  options: SqliteWriteRetryOptions = {},
): T {
  const delaysMs = options.delaysMs ?? defaultDelaysMs;
  const maxAttempts = Math.max(1, options.maxAttempts ?? delaysMs.length + 1);
  let lastError: unknown = null;
  let lastSqliteCode: SqliteWriteLockCode = "UNKNOWN_LOCK";
  let lastSqliteExtendedCode: string | null = null;
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return write();
    } catch (error) {
      lastError = error;
      const sqliteCode = sqliteWriteLockCode(error);
      if (sqliteCode === null) {
        throw error;
      }
      lastSqliteCode = sqliteCode;
      lastSqliteExtendedCode = extractSqliteExtendedCode(error);
      if (attempt >= maxAttempts) {
        break;
      }
      const delayMs = delaysMs[Math.min(attempt - 1, delaysMs.length - 1)] ?? 0;
      log.warn(
        {
          label,
          attempt,
          maxAttempts,
          delayMs,
          elapsedMs: Date.now() - startedAt,
          sqliteCode,
          sqliteExtendedCode: lastSqliteExtendedCode,
        },
        "SQLite write locked; retrying",
      );
      sleepSync(delayMs);
    }
  }

  throw new SqliteWriteBusyError(
    `SQLite write failed after ${maxAttempts} attempts: ${label}`,
    lastError,
    maxAttempts,
    label,
    Date.now() - startedAt,
    lastSqliteCode,
    lastSqliteExtendedCode,
  );
}
