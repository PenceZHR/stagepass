/**
 * Battle round statuses, and the two predicates over them.
 *
 * Deliberately dependency-free. `enums.ts` builds its zod schema from the
 * canonical list below rather than restating it, so this module can be the one
 * client components import. Before the split, `change-phase-map.ts` and
 * `spec-battlefield.tsx` imported `isRunningBattleRoundStatus` as a *value*
 * from `enums.ts`, which pulled zod into a client bundle that had never carried
 * it, to answer a question that is a two-element array membership test.
 *
 * Keep this file free of imports. The moment it gains one, the client bundle
 * gains it too.
 */

/** Every status a battle round row can hold. The zod enum derives from this. */
export const BATTLE_ROUND_STATUSES = [
  "not_started",
  "red_running",
  "red_done",
  "blue_running",
  "blue_done",
  "report_ready",
  "closed",
  "superseded",
  "failed",
] as const;

export type BattleRoundStatus = (typeof BATTLE_ROUND_STATUSES)[number];

/**
 * Single authority for "a battle round is executing right now".
 *
 * The `satisfies` clause binds every member to BattleRoundStatus, so a member
 * that is not a real round status fails to compile instead of silently never
 * matching. (The pipeline UI copy carried a bare "running" that no writer ever
 * writes to battle_rounds.status -- it matched nothing, forever.)
 *
 * This is deliberately NOT the same question as "is the spec battle the active
 * pipeline stage": a `not_started` round makes the spec stage current without
 * anything executing. Keep that predicate separate.
 */
export const RUNNING_BATTLE_ROUND_STATUSES = [
  "red_running",
  "blue_running",
] as const satisfies readonly BattleRoundStatus[];

export function isRunningBattleRoundStatus(status: string | null | undefined): boolean {
  return (RUNNING_BATTLE_ROUND_STATUSES as readonly string[]).includes(status ?? "");
}

/**
 * "A round already occupies the slot, so a new round cannot be created."
 * Derived from the running set rather than restated: a created-but-unclaimed
 * round blocks a new round without executing anything.
 */
export const OCCUPIED_BATTLE_ROUND_STATUSES = [
  "not_started",
  ...RUNNING_BATTLE_ROUND_STATUSES,
] as const satisfies readonly BattleRoundStatus[];

export function isOccupiedBattleRoundStatus(status: string | null | undefined): boolean {
  return (OCCUPIED_BATTLE_ROUND_STATUSES as readonly string[]).includes(status ?? "");
}
