import fs from "node:fs";
import path from "node:path";

/**
 * Where a delegated round's prompts and outputs live inside the target repo.
 *
 * ## Why files at all
 *
 * The three roles WRITE their results rather than typing them into the chat.
 * Two things follow, both good:
 *
 *  - the judge, red and blue are validated by one path. A sub-agent can never
 *    be given a runtime `outputSchema` (`spawn_agent` has no such parameter),
 *    so as long as the judge answered in chat there were two different
 *    enforcement stories for one contract. Now there is one.
 *  - the round leaves an auditable artifact per side, at a fixed path, that a
 *    human can open without replaying a conversation.
 *
 * ## Why the role briefs are files the server writes
 *
 * The judge is told to point its sub-agents at `roles/red.md`; it never retypes
 * the brief. A judge that quotes a brief is a judge that can quietly relax its
 * sub-agent's schema. Pointing at a path removes that entirely -- and it is why
 * the briefs live under a directory the round's writable scope does NOT cover.
 *
 * The Codex task's cwd is the TARGET repo, so stagepass's own
 * `server/templates/prompts` is unreachable from there. These are materialised
 * copies, rewritten every round so a template edit takes effect immediately.
 */

/** Round directory: `.ship/changes/<changeId>/rounds/<phase>`. */
export function roundPhaseDir(changeId: string, phase: string): string {
  return path.join(".ship", "changes", changeId, "rounds", phase.toLowerCase());
}

/** Server-owned role briefs. Read by the agents, never written by them. */
export function roleBriefPath(changeId: string, phase: string, role: "judge" | "red" | "blue"): string {
  return path.join(roundPhaseDir(changeId, phase), "roles", `${role}.md`);
}

/**
 * Where a side writes its result. One file per side per round, so a later round
 * can never be settled by an earlier round's leftovers.
 */
export function roundOutputPath(
  changeId: string,
  phase: string,
  roundNo: number,
  role: "red" | "blue" | "verdict",
): string {
  return path.join(
    roundPhaseDir(changeId, phase),
    `round-${String(roundNo).padStart(2, "0")}`,
    `${role}.json`,
  );
}

/**
 * The only paths a delegated round may write.
 *
 * Deliberately narrow. These stages ran read-only until the round started
 * producing files, so the sandbox is now the looser of the two guards and
 * `validatePlannedChanges` is what actually holds the line: anything outside
 * this glob is a stage boundary violation and blocks the round. Widening it to
 * `.ship/changes/**` would hand a design stage the ability to rewrite every
 * other artifact of the change.
 *
 * The `roles/` briefs are excluded on purpose -- the server owns them, and a
 * round that could rewrite its own brief could rewrite its own schema.
 */
export function roundWritableGlobs(changeId: string, phase: string): string[] {
  return [path.join(roundPhaseDir(changeId, phase), "round-*", "*.json")];
}

export interface MaterialisedRoleBriefs {
  judge: string;
  red: string;
  blue: string;
}

/**
 * Writes the three role briefs into the repo and returns their repo-relative
 * paths.
 *
 * Rewritten every round rather than written once: a template edit must take
 * effect on the next round, and a brief left over from an older version of the
 * schema is worse than no brief -- it would ask a side for a document the
 * server no longer accepts, and the round would fail as "side output invalid"
 * with nothing pointing at the stale file.
 */
export function materialiseRoleBriefs(input: {
  repoPath: string;
  changeId: string;
  phase: string;
  briefs: MaterialisedRoleBriefs;
}): { judge: string; red: string; blue: string } {
  const written: Record<string, string> = {};
  for (const role of ["judge", "red", "blue"] as const) {
    const relative = roleBriefPath(input.changeId, input.phase, role);
    const absolute = path.join(input.repoPath, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, input.briefs[role], "utf-8");
    written[role] = relative;
  }
  return { judge: written.judge!, red: written.red!, blue: written.blue! };
}

/**
 * Clears a round's output files before the round runs.
 *
 * Without this a round that fails after red wrote its file, then retries and
 * fails before red writes again, would be settled from the FIRST attempt's red
 * output -- a stale document that no side produced in this round, carrying a
 * provenance window that no longer matches any thread.
 */
export function clearRoundOutputs(input: {
  repoPath: string;
  changeId: string;
  phase: string;
  roundNo: number;
}): void {
  for (const role of ["red", "blue", "verdict"] as const) {
    const absolute = path.join(
      input.repoPath,
      roundOutputPath(input.changeId, input.phase, input.roundNo, role),
    );
    fs.rmSync(absolute, { force: true });
  }
}

export type RoundOutputRead =
  | { ok: true; text: string; writtenAtMs: number }
  | { ok: false; code: "missing" | "unreadable"; detail: string };

/**
 * Reads one side's output file along with WHEN it was written.
 *
 * The timestamp is evidence, not metadata. Files alone cannot say who wrote
 * them: a judge that never spawned anything could write all three. Pairing the
 * write time with the side's own thread window -- which the judge does not
 * control -- is what keeps the file form as strong as reading each side's
 * thread was. See `writtenDuringOwnTurn`.
 */
export function readRoundOutput(input: {
  repoPath: string;
  changeId: string;
  phase: string;
  roundNo: number;
  role: "red" | "blue" | "verdict";
}): RoundOutputRead {
  const absolute = path.join(
    input.repoPath,
    roundOutputPath(input.changeId, input.phase, input.roundNo, input.role),
  );
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return {
      ok: false,
      code: "missing",
      detail: roundOutputPath(input.changeId, input.phase, input.roundNo, input.role),
    };
  }
  try {
    return { ok: true, text: fs.readFileSync(absolute, "utf-8"), writtenAtMs: stat.mtimeMs };
  } catch (error) {
    return {
      ok: false,
      code: "unreadable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Clock skew allowance between the app-server's turn timings and the local
 * filesystem's mtime. Seconds, not minutes: the point is to tolerate a coarse
 * clock, not to admit a file written by a different turn.
 */
const PROVENANCE_SLACK_MS = 10_000;

/**
 * Whether a file was written inside the window its author's own turn occupied.
 *
 * A judge writing red's file for it does so before or after red's turn, not
 * during it -- and it cannot move red's thread timings, which come from the
 * app-server. This is the file form's answer to the failure the whole design is
 * built against: a side that never really ran.
 */
export function writtenDuringOwnTurn(input: {
  writtenAtMs: number;
  startedAtMs: number;
  completedAtMs: number;
}): boolean {
  return input.writtenAtMs >= input.startedAtMs - PROVENANCE_SLACK_MS
    && input.writtenAtMs <= input.completedAtMs + PROVENANCE_SLACK_MS;
}
