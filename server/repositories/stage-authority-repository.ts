import { and, eq } from "drizzle-orm";

import { db } from "../db";
import { changes, stageGates, stageReports, stageRuns, stageStates } from "../db/schema";
import { withSqliteWriteRetry } from "../db/write-boundary";

/** One more than the highest of `existingVersions`, or 1 if there are none. */
export function computeNextGateVersion(existingVersions: number[]): number {
  return existingVersions.reduce((max, version) => Math.max(max, version), 0) + 1;
}

export type StageAuthorityDb = typeof db;
type StageAuthorityConnection = Pick<StageAuthorityDb, "select" | "insert" | "update">;

export type StageRunRecord = typeof stageRuns.$inferSelect;
export type StageReportRecord = typeof stageReports.$inferSelect;
export type StageGateRecord = typeof stageGates.$inferSelect;
export type StageStateRecord = typeof stageStates.$inferSelect;

export type StageRunInsert = typeof stageRuns.$inferInsert;
export type StageReportInsert = typeof stageReports.$inferInsert;
export type StageGateInsert = typeof stageGates.$inferInsert;
export type StageStateUpsert = typeof stageStates.$inferInsert;
export type StageRunPatch = Partial<typeof stageRuns.$inferInsert>;

let stageAuthorityRepositoryDbForTest: StageAuthorityDb | null = null;

export function setStageAuthorityRepositoryDbForTest(nextDb: StageAuthorityDb): () => void {
  const previous = stageAuthorityRepositoryDbForTest;
  stageAuthorityRepositoryDbForTest = nextDb;
  return () => {
    stageAuthorityRepositoryDbForTest = previous;
  };
}

function getStageAuthorityDb(): StageAuthorityDb {
  return stageAuthorityRepositoryDbForTest ?? db;
}

function nextPrefixedId(ids: string[], prefix: string): string {
  const used = new Set(ids);
  let maxNum = 0;
  for (const id of ids) {
    const match = id.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (match) maxNum = Math.max(maxNum, Number.parseInt(match[1], 10));
  }

  let nextNum = maxNum + 1;
  let candidate = `${prefix}-${String(nextNum).padStart(3, "0")}`;
  while (used.has(candidate)) {
    nextNum += 1;
    candidate = `${prefix}-${String(nextNum).padStart(3, "0")}`;
  }
  return candidate;
}

function timeMs(value: string | null): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function createStageAuthorityRepository(connection: StageAuthorityConnection) {
  return {
    changeExists(changeId: string): boolean {
      return Boolean(
        connection.select({ id: changes.id }).from(changes).where(eq(changes.id, changeId)).get(),
      );
    },

    getStageRun(runId: string): StageRunRecord | undefined {
      return connection.select().from(stageRuns).where(eq(stageRuns.id, runId)).get();
    },

    listStageRuns(changeId: string, phase?: string): StageRunRecord[] {
      return connection
        .select()
        .from(stageRuns)
        .where(
          phase === undefined
            ? eq(stageRuns.changeId, changeId)
            : and(eq(stageRuns.changeId, changeId), eq(stageRuns.phase, phase)),
        )
        .all();
    },

    insertStageRun(row: StageRunInsert): void {
      connection.insert(stageRuns).values(row).run();
    },

    completeStageRun(runId: string, patch: StageRunPatch): void {
      connection.update(stageRuns).set(patch).where(eq(stageRuns.id, runId)).run();
    },

    listStageReports(changeId: string, phase?: string): StageReportRecord[] {
      return connection
        .select()
        .from(stageReports)
        .where(
          phase === undefined
            ? eq(stageReports.changeId, changeId)
            : and(eq(stageReports.changeId, changeId), eq(stageReports.phase, phase)),
        )
        .all();
    },

    insertStageReport(row: StageReportInsert): void {
      connection.insert(stageReports).values(row).run();
    },

    listStageGates(changeId: string, phase?: string): StageGateRecord[] {
      return connection
        .select()
        .from(stageGates)
        .where(
          phase === undefined
            ? eq(stageGates.changeId, changeId)
            : and(eq(stageGates.changeId, changeId), eq(stageGates.phase, phase)),
        )
        .all();
    },

    insertStageGate(row: StageGateInsert): void {
      connection.insert(stageGates).values(row).run();
    },

    getStageState(changeId: string, phase: string): StageStateRecord | null {
      return (
        connection
          .select()
          .from(stageStates)
          .where(and(eq(stageStates.changeId, changeId), eq(stageStates.phase, phase)))
          .all()
          .sort((a, b) => {
            const updatedDiff = timeMs(b.updatedAt) - timeMs(a.updatedAt);
            if (updatedDiff !== 0) return updatedDiff;
            if (b.version !== a.version) return b.version - a.version;
            return b.id.localeCompare(a.id);
          })[0] ?? null
      );
    },

    upsertStageState(row: StageStateUpsert, expectedVersion?: number): StageStateRecord {
      const existing = connection
        .select()
        .from(stageStates)
        .where(eq(stageStates.id, row.id))
        .get();
      if (!existing) {
        connection.insert(stageStates).values(row).run();
        return row as StageStateRecord;
      }

      const updateWhere =
        expectedVersion === undefined
          ? eq(stageStates.id, row.id)
          : and(eq(stageStates.id, row.id), eq(stageStates.version, expectedVersion));
      const result = connection.update(stageStates).set(row).where(updateWhere).run();
      if (expectedVersion !== undefined && result.changes === 0) {
        throw new Error(`Stage state version mismatch: ${row.id}`);
      }
      return { ...existing, ...row };
    },

    nextStageReportId(): string {
      return nextPrefixedId(
        connection.select({ id: stageReports.id }).from(stageReports).all().map((row) => row.id),
        "STG-RPT",
      );
    },

    nextStageGateId(): string {
      return nextPrefixedId(
        connection.select({ id: stageGates.id }).from(stageGates).all().map((row) => row.id),
        "STG-GATE",
      );
    },

    nextStageStateId(): string {
      return nextPrefixedId(
        connection.select({ id: stageStates.id }).from(stageStates).all().map((row) => row.id),
        "STG-STATE",
      );
    },

    /**
     * One more than the highest gateVersion already recorded for this
     * (changeId, phase). Every gate for a phase used to default to 1, so two
     * gates could tie on (gateVersion, computedAt) and the action-contract
     * fence's gateVersion comparison was a permanent no-op. Called inside the
     * same transaction as the insert it feeds, so concurrent writers can't
     * observe a stale max (SQLite's single-writer lock plus withSqliteWriteRetry
     * retrying the whole transaction on SQLITE_BUSY).
     */
    nextGateVersion(changeId: string, phase: string): number {
      const versions = connection
        .select({ gateVersion: stageGates.gateVersion })
        .from(stageGates)
        .where(and(eq(stageGates.changeId, changeId), eq(stageGates.phase, phase)))
        .all();
      return computeNextGateVersion(versions.map((row) => row.gateVersion));
    },
  };
}

export type StageAuthorityRepository = ReturnType<typeof createStageAuthorityRepository>;

export function withStageAuthorityTransaction<T>(
  callback: (repository: StageAuthorityRepository) => T,
): T {
  return withSqliteWriteRetry("stage-authority.transaction", () =>
    getStageAuthorityDb().transaction((tx) =>
      callback(createStageAuthorityRepository(tx as StageAuthorityConnection)),
    ),
  );
}

export const stageAuthorityRepository: StageAuthorityRepository = {
  changeExists: (...args) =>
    createStageAuthorityRepository(getStageAuthorityDb()).changeExists(...args),
  getStageRun: (...args) => createStageAuthorityRepository(getStageAuthorityDb()).getStageRun(...args),
  listStageRuns: (...args) =>
    createStageAuthorityRepository(getStageAuthorityDb()).listStageRuns(...args),
  insertStageRun: (...args) =>
    createStageAuthorityRepository(getStageAuthorityDb()).insertStageRun(...args),
  completeStageRun: (...args) =>
    createStageAuthorityRepository(getStageAuthorityDb()).completeStageRun(...args),
  listStageReports: (...args) =>
    createStageAuthorityRepository(getStageAuthorityDb()).listStageReports(...args),
  insertStageReport: (...args) =>
    createStageAuthorityRepository(getStageAuthorityDb()).insertStageReport(...args),
  listStageGates: (...args) =>
    createStageAuthorityRepository(getStageAuthorityDb()).listStageGates(...args),
  insertStageGate: (...args) =>
    createStageAuthorityRepository(getStageAuthorityDb()).insertStageGate(...args),
  getStageState: (...args) =>
    createStageAuthorityRepository(getStageAuthorityDb()).getStageState(...args),
  upsertStageState: (...args) =>
    createStageAuthorityRepository(getStageAuthorityDb()).upsertStageState(...args),
  nextStageReportId: (...args) =>
    createStageAuthorityRepository(getStageAuthorityDb()).nextStageReportId(...args),
  nextStageGateId: (...args) =>
    createStageAuthorityRepository(getStageAuthorityDb()).nextStageGateId(...args),
  nextStageStateId: (...args) =>
    createStageAuthorityRepository(getStageAuthorityDb()).nextStageStateId(...args),
  nextGateVersion: (...args) =>
    createStageAuthorityRepository(getStageAuthorityDb()).nextGateVersion(...args),
};
