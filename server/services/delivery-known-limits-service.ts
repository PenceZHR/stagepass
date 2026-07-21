import { and, eq, inArray } from "drizzle-orm";

import { db } from "../db";
import { findings, humanDecisions, requirementGaps } from "../db/schema";

/**
 * The deterministic half of the delivery note's fourth section (design §3.2).
 *
 * ## Why this is code and not a prompt
 *
 * §3.2 gives the reason in one line: 「模型自述『我没做什么』正是它最不可靠的方向」.
 * The stronger reason is falsifiability. Nothing downstream reads delivery.md --
 * no gate, no mirror, no hash -- so a model that omits an open gap from its own
 * account of what it left undone produces a delivery note that is wrong in
 * exactly the way nobody can detect. Every other line-protocol stage in this
 * repo can be checked by a later stage; this one cannot, so the part that must
 * be true is the part the model never touches.
 *
 * The design offered a middle option: hand these facts to the model as prompt
 * input and let it write the prose. That was rejected because it moves the
 * guarantee from "these bytes came from the database" to "the model was told
 * and probably repeated it", and the only test that can distinguish the two is
 * one that mocks the model into repeating them -- i.e. a test that passes for
 * reasons unrelated to production. The narrative half the DB genuinely does not
 * know (explicit non-goals, pitfalls hit along the way) is still the model's,
 * and arrives through the KNOWN_LIMITS<< block.
 *
 * Every category prints an explicit 「没有…」 line when empty, because a missing
 * bullet and "there were none" must not look the same to a reader.
 */

export interface DeliveryOpenGapFact {
  canonicalGapId: string;
  severity: string;
  title: string;
  category: string;
}

export interface DeliveryWaivedGapFact {
  canonicalGapId: string;
  status: string;
  severity: string;
  originalSeverity: string;
  title: string;
  reason: string | null;
}

export interface DeliveryWaivedFindingFact {
  id: string;
  severity: string;
  title: string;
  file: string | null;
  waivedBy: string | null;
}

export interface DeliveryHumanDecisionFact {
  gate: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
  createdBy: string;
  createdAt: string;
}

export interface DeliveryKnownLimitsFacts {
  openGaps: DeliveryOpenGapFact[];
  waivedGaps: DeliveryWaivedGapFact[];
  waivedFindings: DeliveryWaivedFindingFact[];
  humanDecisions: DeliveryHumanDecisionFact[];
}

type KnownLimitsDb = Pick<typeof db, "select">;

/** Stable output ordering, so re-running the stage cannot reshuffle the section. */
function byText(left: string, right: string): number {
  return left.localeCompare(right);
}

export function readDeliveryKnownLimitsFacts(
  changeId: string,
  factsDb: KnownLimitsDb = db,
): DeliveryKnownLimitsFacts {
  const gaps = factsDb.select().from(requirementGaps)
    .where(eq(requirementGaps.changeId, changeId)).all();

  const openGaps = gaps
    .filter((gap) => gap.status === "open")
    .map((gap) => ({
      canonicalGapId: gap.canonicalGapId,
      severity: gap.severity,
      title: gap.title,
      category: gap.category,
    }))
    .sort((left, right) => byText(left.canonicalGapId, right.canonicalGapId));

  // `downgraded` and `overridden` belong here with `waived`: all three are a
  // human deciding the pipeline may proceed with something unresolved, which is
  // precisely what "被豁免" means to the reader of a delivery note.
  const waivedGaps = gaps
    .filter((gap) => ["waived", "downgraded", "overridden"].includes(gap.status))
    .map((gap) => ({
      canonicalGapId: gap.canonicalGapId,
      status: gap.status,
      severity: gap.downgradedTo ?? gap.severity,
      originalSeverity: gap.originalSeverity,
      title: gap.title,
      reason: gap.waiverReason ?? gap.downgradeReason ?? gap.overrideReason ?? null,
    }))
    .sort((left, right) => byText(left.canonicalGapId, right.canonicalGapId));

  const waivedFindings = factsDb.select().from(findings)
    .where(and(eq(findings.changeId, changeId), eq(findings.status, "waived"))).all()
    .filter((finding) => finding.severity === "P0" || finding.severity === "P1")
    .map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      title: finding.title,
      file: finding.file,
      waivedBy: finding.waivedBy,
    }))
    .sort((left, right) => byText(left.id, right.id));

  const decisions = factsDb.select().from(humanDecisions)
    .where(and(
      eq(humanDecisions.changeId, changeId),
      inArray(humanDecisions.action, ["waive_p1", "request_changes", "return_to_spec"]),
    )).all()
    .map((decision) => ({
      gate: decision.gate,
      action: decision.action,
      targetType: decision.targetType,
      targetId: decision.targetId,
      reason: decision.reason,
      createdBy: decision.createdBy,
      createdAt: decision.createdAt,
    }))
    .sort((left, right) => byText(left.createdAt, right.createdAt) || byText(left.action, right.action));

  return { openGaps, waivedGaps, waivedFindings, humanDecisions: decisions };
}

/** Keeps a stray newline or pipe in a DB row from breaking the bullet it sits in. */
function inline(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export const DELIVERY_KNOWN_LIMITS_PROVENANCE =
  "以下内容由 stagepass 直接从本项目数据库生成（requirement_gaps / findings / human_decisions），"
  + "不经过模型转述。";

export function renderDeliveryKnownLimitsSection(facts: DeliveryKnownLimitsFacts): string {
  const lines: string[] = [];
  lines.push("### 4.1 库中记录的未关闭项");
  lines.push("");
  lines.push(DELIVERY_KNOWN_LIMITS_PROVENANCE);
  lines.push("");

  lines.push("**未关闭的需求 gap（requirement_gaps.status = open）**");
  lines.push("");
  if (facts.openGaps.length === 0) {
    lines.push("- 没有未关闭的需求 gap。");
  } else {
    for (const gap of facts.openGaps) {
      lines.push(`- \`${gap.canonicalGapId}\`（${gap.severity} / ${inline(gap.category)}）：${inline(gap.title)}`);
    }
  }
  lines.push("");

  lines.push("**已豁免 / 已降级 / 已覆盖的需求 gap**");
  lines.push("");
  if (facts.waivedGaps.length === 0) {
    lines.push("- 没有被豁免、降级或覆盖的需求 gap。");
  } else {
    for (const gap of facts.waivedGaps) {
      const severity = gap.severity === gap.originalSeverity
        ? gap.severity
        : `${gap.originalSeverity} → ${gap.severity}`;
      const reason = gap.reason ? `，理由：${inline(gap.reason)}` : "，未填写理由";
      lines.push(`- \`${gap.canonicalGapId}\`（${gap.status} / ${severity}）：${inline(gap.title)}${reason}`);
    }
  }
  lines.push("");

  lines.push("**被豁免的阻断级 finding（P0 / P1，findings.status = waived）**");
  lines.push("");
  if (facts.waivedFindings.length === 0) {
    lines.push("- 没有被豁免的 P0/P1 finding。");
  } else {
    for (const finding of facts.waivedFindings) {
      const where = finding.file ? `（${inline(finding.file)}）` : "";
      const who = finding.waivedBy ? `，豁免人：${inline(finding.waivedBy)}` : "";
      lines.push(`- \`${finding.id}\`（${finding.severity}）：${inline(finding.title)}${where}${who}`);
    }
  }
  lines.push("");

  lines.push("**人工决定记录（human_decisions）**");
  lines.push("");
  if (facts.humanDecisions.length === 0) {
    lines.push("- 没有豁免或打回类的人工决定记录。");
  } else {
    for (const decision of facts.humanDecisions) {
      const target = decision.targetId
        ? `，对象：${inline(decision.targetType ?? "")} ${inline(decision.targetId)}`.trimEnd()
        : "";
      const reason = decision.reason ? `，理由：${inline(decision.reason)}` : "";
      lines.push(
        `- ${decision.createdAt} · ${decision.gate} · ${decision.action}`
        + `（由 ${inline(decision.createdBy)}）${target}${reason}`,
      );
    }
  }

  return lines.join("\n");
}

export function buildDeliveryKnownLimits(
  changeId: string,
  factsDb: KnownLimitsDb = db,
): { facts: DeliveryKnownLimitsFacts; markdown: string } {
  const facts = readDeliveryKnownLimitsFacts(changeId, factsDb);
  return { facts, markdown: renderDeliveryKnownLimitsSection(facts) };
}
