import type { AiRunItem } from "./ai-engine-types";

/**
 * Reads a delegated round's sides off the sub-agent threads that produced them.
 *
 * ## Why this exists rather than parsing the judge's reply
 *
 * The judge could simply relay what red and blue said, and the first draft of
 * the design assumed it would. Runtime evidence says that is the one thing it
 * must not do
 * (docs/CODEX-SUBAGENT-RUNTIME-EVIDENCE-2026-07-27.md §4.1): when spawning
 * fails, it fails SILENTLY, and the main agent answers in the sub-agents'
 * place. Observed verbatim, with a prompt that explicitly forbade it:
 *
 *     agent_message      "我会按要求并行启动两个子 Agent，并等待它们各自返回。"
 *     collab_tool_call   tool=wait, receiver_thread_ids=[]     ← zero sub-agents
 *     agent_message      "RED-OK\nBLUE-OK"                     ← the judge wrote both
 *     turn.completed                                           ← success
 *
 * The turn SUCCEEDED. Anything that reads the judge's final text calls that a
 * complete round with both sides reporting.
 *
 * So a side exists only if the app-server said it started, and its output is
 * read from its own `agentThreadId` -- a thread the judge cannot write into.
 * The judge's own text is never consulted here.
 */

/** A side the round requires, and the sub-agent path segment that carries it. */
export interface SubAgentRole {
  /** Stage-facing role, e.g. "red". Matched against the last `agentPath` segment. */
  role: string;
}

export interface AttributedSubAgent {
  role: string;
  agentThreadId: string;
  agentPath: string;
  /** The side's own final message, read from its own thread. */
  output: string;
  /**
   * From the side's own thread, and used only to prove the sides took turns.
   *
   * The unit is whatever the reader supplies -- the app-server reports turn
   * timings in epoch SECONDS, not milliseconds. Nothing here converts or
   * displays them, so only internal consistency matters; a reader that mixes
   * units across sides would break the comparison, and must not.
   */
  startedAt: number;
  completedAt: number;
}

export type SubAgentAttributionViolation =
  /** The app-server never reported this side starting -- it does not exist. */
  | { code: "sub_agent_never_started"; role: string }
  /** Two sub-agents claimed the same role; which one is the side is undecidable. */
  | { code: "sub_agent_role_duplicated"; role: string; agentThreadIds: string[] }
  /** The side started but its thread carries no final message. */
  | { code: "sub_agent_produced_nothing"; role: string; agentThreadId: string }
  /** Its thread could not be read, so its output is unknown -- not empty. */
  | { code: "sub_agent_thread_unreadable"; role: string; agentThreadId: string; detail: string }
  /** Its thread has no usable timing, so turn-taking cannot be proved either way. */
  | { code: "sub_agent_timing_unknown"; role: string; agentThreadId: string }
  /**
   * A side began before the side ahead of it had finished.
   *
   * The round is adversarial in a specific order: blue critiques what red
   * produced. Two sides running at once is not a faster version of that, it is
   * a different and worthless thing -- blue reviewing a draft that did not
   * exist yet. See `orderedRoles`.
   */
  | {
      code: "sub_agent_ran_out_of_turn";
      role: string;
      afterRole: string;
      startedAt: number;
      afterCompletedAt: number;
    }
  /**
   * This side is a sub-agent an earlier round already used.
   *
   * Every round must argue from scratch with fresh sub-agents. A reused one
   * carries its previous round's conversation, so it is not a second
   * adversarial pass -- it is the same critic being asked to look again at
   * work it already blessed, which is exactly the thing an adversarial round
   * exists to avoid.
   *
   * Two ways this happens, and neither is exotic: a completed agent stays open
   * until `close_agent`, and `resume_agent` / `send_input` exist to talk to it
   * again; and a caller that hands over the whole THREAD's items rather than
   * the current turn's would replay the previous round's spawns as if they
   * were this round's.
   */
  | { code: "sub_agent_reused_from_earlier_round"; role: string; agentThreadId: string };

/**
 * `sides` is populated on BOTH branches, deliberately.
 *
 * A round with a missing blue is already dead, but red's output is sitting
 * right there and may ALSO be off-contract. Withholding the sides that did
 * resolve would make the operator fix one violation, re-run the whole round,
 * and only then be told about the next -- one expensive round-trip per problem.
 * `ok` decides whether the round proceeds; `sides` is what is knowable either
 * way.
 */
export type SubAgentAttribution =
  | { ok: true; sides: AttributedSubAgent[]; violations?: undefined }
  | { ok: false; sides: AttributedSubAgent[]; violations: SubAgentAttributionViolation[] };

/**
 * What a sub-agent's own thread says it produced, and when.
 *
 * The timings come from the sub-agent's thread rather than from the judge's
 * account of the order it did things in -- same reason the output does.
 */
export interface SubAgentThreadRead {
  output: string | null;
  /**
   * Null when the thread reports no usable timing. Any unit, as long as every
   * side in a round is read in the same one -- see AttributedSubAgent.
   */
  startedAt: number | null;
  completedAt: number | null;
}

/** Reads a sub-agent thread's own final message and timing. */
export type SubAgentThreadReader = (agentThreadId: string) => Promise<SubAgentThreadRead>;

interface StartedSubAgent {
  agentThreadId: string;
  agentPath: string;
}

/**
 * Sub-agents the turn actually started.
 *
 * `started` only: `interacted` and `interrupted` describe an agent that already
 * exists, and an interrupted one has no settled output to attribute.
 */
export function startedSubAgents(items: readonly AiRunItem[] | undefined): StartedSubAgent[] {
  const started = new Map<string, StartedSubAgent>();
  for (const item of items ?? []) {
    if (item.type !== "sub_agent_activity") continue;
    const record = item as unknown as {
      activity?: unknown;
      agentThreadId?: unknown;
      agentPath?: unknown;
    };
    if (record.activity !== "started") continue;
    if (typeof record.agentThreadId !== "string" || record.agentThreadId.length === 0) continue;
    if (typeof record.agentPath !== "string" || record.agentPath.length === 0) continue;
    // The same start can be observed more than once across snapshot re-reads;
    // the thread id is the identity, so last write wins rather than duplicating.
    started.set(record.agentThreadId, {
      agentThreadId: record.agentThreadId,
      agentPath: record.agentPath,
    });
  }
  return [...started.values()];
}

/**
 * The role a sub-agent path carries: the last segment of `/root/red`.
 *
 * Deliberately the last segment rather than the whole path -- a sub-agent
 * spawned by a sub-agent is `/root/red/checker`, and the role of THAT agent is
 * `checker`, not `red`. Matching on a prefix would file a grandchild's output
 * as its parent's.
 */
export function roleFromAgentPath(agentPath: string): string {
  const segments = agentPath.split("/").filter((segment) => segment.length > 0);
  return segments.at(-1) ?? "";
}

/**
 * Pairs each required role with the output of the sub-agent that filled it, and
 * proves the sides took their turns in the declared order.
 *
 * Every failure is reported rather than thrown, and ALL of them are collected
 * before returning: a round missing both sides should say so once, not send the
 * operator around the loop twice.
 */
export async function attributeSubAgentSides(input: {
  /** The judge turn's items, as observed from the app-server. */
  items: readonly AiRunItem[] | undefined;
  /**
   * The sides this round requires, **in the order they must run**. A role with
   * no sub-agent is a violation, and so is a role that began before the one
   * ahead of it finished.
   *
   * The order is load-bearing, not cosmetic. Blue critiques what red produced,
   * so a blue that started while red was still drafting reviewed a document
   * that did not exist -- and it would still return a confident, well-formed,
   * schema-valid critique of nothing. Asking for turn-taking in the prompt
   * cannot catch that; only the sides' own thread timings can.
   */
  requiredRoles: readonly SubAgentRole[];
  /**
   * Sub-agent threads earlier rounds already used, so this round cannot.
   *
   * Each round argues from scratch. Omitting this does not "default to
   * permissive" by accident -- it means the caller has no earlier rounds,
   * which is true only for round 1.
   */
  usedAgentThreadIds?: ReadonlySet<string>;
  readThread: SubAgentThreadReader;
}): Promise<SubAgentAttribution> {
  const byRole = new Map<string, StartedSubAgent[]>();
  for (const agent of startedSubAgents(input.items)) {
    const role = roleFromAgentPath(agent.agentPath);
    byRole.set(role, [...(byRole.get(role) ?? []), agent]);
  }

  const violations: SubAgentAttributionViolation[] = [];
  const sides: AttributedSubAgent[] = [];
  for (const { role } of input.requiredRoles) {
    const candidates = byRole.get(role) ?? [];
    if (candidates.length === 0) {
      violations.push({ code: "sub_agent_never_started", role });
      continue;
    }
    if (candidates.length > 1) {
      violations.push({
        code: "sub_agent_role_duplicated",
        role,
        agentThreadIds: candidates.map((agent) => agent.agentThreadId),
      });
      continue;
    }
    const agent = candidates[0]!;
    // Checked before the thread is read: a recycled agent's output would be
    // perfectly well-formed, so nothing downstream would notice.
    if (input.usedAgentThreadIds?.has(agent.agentThreadId)) {
      violations.push({
        code: "sub_agent_reused_from_earlier_round",
        role,
        agentThreadId: agent.agentThreadId,
      });
      continue;
    }
    let read: SubAgentThreadRead;
    try {
      read = await input.readThread(agent.agentThreadId);
    } catch (error) {
      // An unreadable thread is NOT an empty one. Treating it as empty would
      // let a transport hiccup settle the round with a side that said nothing.
      violations.push({
        code: "sub_agent_thread_unreadable",
        role,
        agentThreadId: agent.agentThreadId,
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (read.output === null || read.output.trim().length === 0) {
      violations.push({
        code: "sub_agent_produced_nothing",
        role,
        agentThreadId: agent.agentThreadId,
      });
      continue;
    }
    // Without timing there is no way to tell a side that waited its turn from
    // one that did not, and "cannot tell" must not read as "did".
    if (read.startedAt === null || read.completedAt === null) {
      violations.push({
        code: "sub_agent_timing_unknown",
        role,
        agentThreadId: agent.agentThreadId,
      });
      continue;
    }
    sides.push({
      role,
      agentThreadId: agent.agentThreadId,
      agentPath: agent.agentPath,
      output: read.output,
      startedAt: read.startedAt,
      completedAt: read.completedAt,
    });
  }

  violations.push(...turnTakingViolations(input.requiredRoles, sides));

  return violations.length > 0 ? { ok: false, sides, violations } : { ok: true, sides };
}

/**
 * Checks each side began only after the side ahead of it had finished.
 *
 * Compared against the previous side in the DECLARED order, not the previous
 * one that happened to resolve: with red missing entirely, blue has nothing to
 * have waited for, and reporting it as out of turn on top of the missing red
 * would be a second complaint about one problem.
 */
function turnTakingViolations(
  orderedRoles: readonly SubAgentRole[],
  sides: readonly AttributedSubAgent[],
): SubAgentAttributionViolation[] {
  const byRole = new Map(sides.map((side) => [side.role, side]));
  const violations: SubAgentAttributionViolation[] = [];
  for (let index = 1; index < orderedRoles.length; index += 1) {
    const current = byRole.get(orderedRoles[index]!.role);
    const previous = byRole.get(orderedRoles[index - 1]!.role);
    if (!current || !previous) continue;
    if (current.startedAt < previous.completedAt) {
      violations.push({
        code: "sub_agent_ran_out_of_turn",
        role: current.role,
        afterRole: previous.role,
        startedAt: current.startedAt,
        afterCompletedAt: previous.completedAt,
      });
    }
  }
  return violations;
}
