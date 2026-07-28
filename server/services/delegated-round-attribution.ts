import type { CodexSubAgentThread } from "./codex-desktop-bridge-types";
import type { SubAgentThreadRead } from "./codex-subagent-attribution";
import { writtenDuringOwnTurn } from "./delegated-round-workspace";

/**
 * Works out which sub-agent produced which side of a round, using only
 * evidence the judge cannot control.
 *
 * ## Why roles are not read off a label
 *
 * The obvious approach -- spawn with `task_name: "red"` and read `agent_path`
 * back -- does not survive contact with the durable record. On a real round the
 * two children came back with `agent_path: null`, `agent_role: null` and
 * auto-generated nicknames ("Linnaeus", "Raman"). The label exists on the live
 * notification stream and nowhere else, and nothing that reads persisted state
 * can see it.
 *
 * So the role is DERIVED: each side's output file was written while exactly one
 * child was running, and that child is that side. Three facts do the work, none
 * of them the judge's to write:
 *
 *  - `parent_thread_id`, written by the app-server, says these children are
 *    this judge's;
 *  - each child's turn window, from its own thread;
 *  - each output file's write time, from the filesystem.
 *
 * A judge that spawned nothing this round has no fresh children. A judge that
 * wrote the files itself wrote them outside any child's window. A judge that
 * ran both sides at once produces overlapping windows. Each is refused with its
 * own reason.
 *
 * "This round" is load-bearing: the judge thread is continuous, so its child
 * list only grows. See `usedAgentThreadIds` for how earlier rounds' children
 * are kept out of the pool.
 */

export interface SubAgentCandidate {
  thread: CodexSubAgentThread;
  read: SubAgentThreadRead;
}

export interface RoundSideFile {
  role: string;
  /** Epoch ms the side's output file was written. */
  writtenAtMs: number;
}

export type RoundAttributionViolation =
  /** No child of this judge is new this round. */
  | { code: "no_sub_agents"; parentThreadId: string }
  | { code: "sub_agent_count_unexpected"; expected: number; found: number }
  | { code: "sub_agent_timing_unknown"; threadId: string }
  /** No child was running when this side's file was written. */
  | { code: "side_output_foreign"; role: string; writtenAtMs: number }
  /** Two sides' files landed inside the same child's window. */
  | { code: "side_output_ambiguous"; roles: string[]; threadId: string }
  /**
   * Two children were running at the same time.
   *
   * Distinct from `sub_agent_ran_out_of_turn`, which is about the ORDER the
   * attributed sides spoke in. This one is about the raw windows and is checked
   * first, because overlapping windows make the attribution itself unsound --
   * every containment answer after that point is a guess wearing a fact's
   * clothes.
   */
  | { code: "sub_agents_overlapped"; startedAt: number; afterCompletedAt: number }
  /** The sides overlapped, so the later one reviewed a draft that did not exist. */
  | {
      code: "sub_agent_ran_out_of_turn";
      role: string;
      afterRole: string;
      startedAt: number;
      afterCompletedAt: number;
    };

export interface AttributedRoundSide {
  role: string;
  agentThreadId: string;
  agentNickname: string | null;
  startedAt: number;
  completedAt: number;
  /** The side's own final message. Kept for the audit trail, not for content. */
  reply: string | null;
}

export type RoundAttribution =
  | { ok: true; sides: AttributedRoundSide[] }
  | { ok: false; violations: RoundAttributionViolation[] };

/**
 * `orderedSides` is the order the sides must have run in, and it is the
 * contract: blue critiques what red produced, so a blue that started before red
 * finished reviewed a draft that did not exist yet -- and would still return a
 * confident, schema-valid critique of nothing.
 */
export function attributeRoundSides(input: {
  parentThreadId: string;
  candidates: readonly SubAgentCandidate[];
  /**
   * Side roles in required execution order, e.g. ["red", "blue"]. A side whose
   * output file is missing is absent here -- its own violation is reported by
   * the caller, and attributing the sides that DID write still tells the
   * operator everything else that is wrong in one pass.
   */
  orderedSides: readonly RoundSideFile[];
  /**
   * How many sides the round requires, independent of how many wrote a file.
   *
   * Deliberately not `orderedSides.length`: a round missing red's file would
   * then "expect" one side, find two children, and report a spurious count
   * mismatch on top of the real missing-file problem.
   */
  expectedSideCount: number;
  /**
   * Sub-agent threads earlier rounds of this change already spent. They are
   * EXCLUDED from this round's pool, not treated as a violation.
   *
   * The judge thread is continuous across rounds -- that is the design -- so
   * the parent still lists every child it ever spawned. Round 2's children are
   * therefore always among round 3's candidates, and calling that "the judge
   * reused a sub-agent" refused every continuation round by construction: on
   * CHG-006 round 3 spawned two fresh children, both sides wrote their file on
   * time, and the round was thrown away naming round 2's threads.
   *
   * Excluding them costs no teeth. A judge that points at a spent child gets it
   * removed from the pool, so no side's write time can land in its window --
   * reported as `side_output_foreign`, or `no_sub_agents` when nothing fresh
   * was spawned at all. Both are truer descriptions than "reused" was.
   */
  usedAgentThreadIds?: ReadonlySet<string>;
}): RoundAttribution {
  const violations: RoundAttributionViolation[] = [];

  const fresh = input.usedAgentThreadIds
    ? input.candidates.filter((candidate) => !input.usedAgentThreadIds!.has(candidate.thread.threadId))
    : input.candidates;
  if (fresh.length === 0) {
    return { ok: false, violations: [{ code: "no_sub_agents", parentThreadId: input.parentThreadId }] };
  }

  const usable: Array<{ thread: CodexSubAgentThread; startedAt: number; completedAt: number; reply: string | null }> = [];
  for (const candidate of fresh) {
    // Without timing there is no way to tell a side that waited its turn from
    // one that did not, and "cannot tell" must never read as "did".
    if (candidate.read.startedAt === null || candidate.read.completedAt === null) {
      violations.push({ code: "sub_agent_timing_unknown", threadId: candidate.thread.threadId });
      continue;
    }
    usable.push({
      thread: candidate.thread,
      startedAt: candidate.read.startedAt,
      completedAt: candidate.read.completedAt,
      reply: candidate.read.output,
    });
  }

  if (usable.length !== input.expectedSideCount) {
    violations.push({
      code: "sub_agent_count_unexpected",
      expected: input.expectedSideCount,
      found: usable.length,
    });
    return { ok: false, violations };
  }

  // Overlapping windows are checked BEFORE containment, because containment
  // cannot tell the two cases apart and reports the wrong one.
  //
  // With two children running in parallel, both output files fall inside the
  // first child's window, and the containment pass below reports
  // `side_output_ambiguous` -- "the two sides were really one agent". That is
  // false and it is expensive: it sends whoever reads it looking for a judge
  // that failed to delegate, when the judge delegated correctly and merely ran
  // the two at once. Observed on CHG-006 round 5, where exactly two sub-agents
  // existed (the count check above had already passed) and the report still
  // said they were the same one.
  //
  // Overlap is also the more serious finding on its own terms: blue reviewing
  // red's output while red is still writing it is blue reviewing a draft that
  // does not exist.
  const ordered = [...usable].sort((left, right) => left.startedAt - right.startedAt);
  for (let index = 1; index < ordered.length; index += 1) {
    const current = ordered[index]!;
    const previous = ordered[index - 1]!;
    if (current.startedAt < previous.completedAt) {
      violations.push({
        code: "sub_agents_overlapped",
        startedAt: current.startedAt,
        afterCompletedAt: previous.completedAt,
      });
    }
  }
  if (violations.length > 0) return { ok: false, violations };

  // Each side belongs to the child that was running when its file was written.
  const sides: AttributedRoundSide[] = [];
  const claimedBy = new Map<string, string[]>();
  for (const side of input.orderedSides) {
    // Exact containment first, clock skew only as a fallback. Taking the first
    // slack-tolerant match instead would let one child's window swallow a file
    // written during the NEXT child's turn whenever the two ran close together
    // -- reported as "one agent wrote both sides", on a round that was fine.
    const owner = usable.find((candidate) =>
      side.writtenAtMs >= candidate.startedAt && side.writtenAtMs <= candidate.completedAt)
      ?? usable.find((candidate) => writtenDuringOwnTurn({
        writtenAtMs: side.writtenAtMs,
        startedAtMs: candidate.startedAt,
        completedAtMs: candidate.completedAt,
      }));
    if (!owner) {
      violations.push({ code: "side_output_foreign", role: side.role, writtenAtMs: side.writtenAtMs });
      continue;
    }
    claimedBy.set(owner.thread.threadId, [...(claimedBy.get(owner.thread.threadId) ?? []), side.role]);
    sides.push({
      role: side.role,
      agentThreadId: owner.thread.threadId,
      agentNickname: owner.thread.agentNickname,
      startedAt: owner.startedAt,
      completedAt: owner.completedAt,
      reply: owner.reply,
    });
  }
  // Two sides inside one child's window means one child wrote both files, so
  // neither attribution is safe -- and the "two sides" the round reports would
  // be one agent talking to itself.
  for (const [threadId, roles] of claimedBy) {
    if (roles.length > 1) {
      violations.push({ code: "side_output_ambiguous", roles, threadId });
    }
  }

  if (violations.length === 0) {
    for (let index = 1; index < sides.length; index += 1) {
      const current = sides[index]!;
      const previous = sides[index - 1]!;
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
  }

  return violations.length > 0 ? { ok: false, violations } : { ok: true, sides };
}

export function describeRoundAttributionViolation(violation: RoundAttributionViolation): string {
  switch (violation.code) {
    case "no_sub_agents":
      return "本轮没有启动任何新的子 Agent（裁决者可能自己代答了两方，或想沿用上一轮的子 Agent）";
    case "sub_agent_count_unexpected":
      return `子 Agent 数量不对：需要 ${violation.expected} 个，实际可用 ${violation.found} 个`;
    case "sub_agent_timing_unknown":
      return `子 Agent ${violation.threadId} 没有可用的运行时间，无法证明它按顺序发言`;
    case "side_output_foreign":
      return `${violation.role} 方的产出文件不是任何子 Agent 在运行时写的（写入时间落在所有子 Agent 的运行区间之外）`;
    case "side_output_ambiguous":
      return `${violation.roles.join(" 和 ")} 方的产出落在同一个子 Agent 的运行区间内——两方其实是同一个 Agent`;
    case "sub_agents_overlapped":
      return "两个子 Agent 的运行区间重叠了：红蓝并行跑了，蓝方评审的是一份还没写完的草稿。"
        + "必须等红方结束（wait_agent）再启动蓝方";
    case "sub_agent_ran_out_of_turn":
      return `${violation.role} 方在 ${violation.afterRole} 方完成前就开始了（并行对抗无效）`;
  }
}
