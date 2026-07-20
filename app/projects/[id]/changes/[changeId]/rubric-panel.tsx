"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  RUBRIC_ROLES,
  RUBRIC_ROLE_HINTS,
  RUBRIC_ROLE_LABELS,
  type RubricPanelState,
  type RubricPhase,
  type RubricRole,
  type RubricRolePanel,
  type RubricVerdict,
} from "./rubric-types";

/**
 * One phase's rubric drawer: three editable checklists and this round's
 * verdicts (§7).
 *
 * ## Why this is not inside the stage's "原始记录" disclosure
 *
 * It renders in the stage frame's own body, above the collapsed evidence
 * `<details>`. Twice already in this project a capability existed in the
 * backend and was unreachable in practice because the UI tucked it away
 * (`retry_spec` had no button; the git panel sat 4.7 screens down), and a rubric
 * nobody can find is a rubric nobody edits — which turns a user-owned checklist
 * back into a constant in the code. §7.3 makes that a requirement, not taste.
 *
 * ## Why `not_assessed` looks exactly as alarming as `no`
 *
 * Both resolve to the same `block` tone, deliberately sharing one class string
 * rather than two that happen to match today. `not_assessed` means the model
 * was asked and did not answer; §4.3 blocks on it regardless of the criterion's
 * `blocking` flag, because silence is how a model would otherwise skip the
 * questions it expects to fail. Rendering it as a quiet grey dash would show a
 * blocking state as an absence — the single most dangerous thing this panel
 * could do, and precisely the failure the whole mechanism exists to prevent.
 */

interface DraftCriterion {
  criterionKey: string | null;
  text: string;
  blocking: boolean;
}

type VerdictTone = "pass" | "block";

const VERDICT_PRESENTATION: Record<
  RubricVerdict,
  { glyph: string; label: string; tone: VerdictTone }
> = {
  yes: { glyph: "✓", label: "是", tone: "pass" },
  no: { glyph: "✗", label: "否", tone: "block" },
  // Same tone as `no`, from the same table, so the two cannot drift apart.
  not_assessed: { glyph: "—", label: "未评估", tone: "block" },
};

const VERDICT_TONE_CLASS: Record<VerdictTone, string> = {
  pass: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  block: "border-destructive/50 bg-destructive/10 text-destructive",
};

export function verdictTone(verdict: RubricVerdict): VerdictTone {
  return VERDICT_PRESENTATION[verdict].tone;
}

export function verdictToneClass(verdict: RubricVerdict): string {
  return VERDICT_TONE_CLASS[verdictTone(verdict)];
}

export function rubricScopeLabel(source: "change" | "project" | null): string {
  if (source === "change") return "本 Change 覆盖";
  if (source === "project") return "项目默认";
  return "尚未设置";
}

function toDraft(panel: RubricRolePanel): DraftCriterion[] {
  return panel.criteria.map((criterion) => ({
    // Carried back on save so a reworded criterion keeps its identity (§5.1).
    // Losing this here is exactly how an edit would orphan an open gap.
    criterionKey: criterion.criterionKey,
    text: criterion.text,
    blocking: criterion.blocking,
  }));
}

export function RubricPanel({
  projectId,
  changeId,
  phase,
  initialState = null,
}: {
  projectId: string;
  changeId: string;
  phase: RubricPhase;
  /** Server state. Tests render with this; the browser fetches it. */
  initialState?: RubricPanelState | null;
}) {
  const [state, setState] = useState<RubricPanelState | null>(initialState);
  const [activeRole, setActiveRole] = useState<RubricRole>("producer");
  // The tab an edit belongs to, not a bare boolean. Switching tab or phase must
  // abandon the draft -- saving criteria typed for the producer into the critic
  // rubric would append a version nobody asked for -- and deriving that from
  // the key is exact where an effect that resets a flag races the render that
  // already used it.
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftCriterion[]>([]);
  const [draftScope, setDraftScope] = useState<"project" | "change">("project");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);

  useEffect(() => {
    if (initialState) return;
    let cancelled = false;
    fetch(`/api/projects/${projectId}/changes/${changeId}/rubrics?phase=${encodeURIComponent(phase)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: RubricPanelState | null) => {
        if (!cancelled && data) setState(data);
      })
      // A rubric drawer that cannot load must not take the stage page with it.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [initialState, projectId, changeId, phase]);

  const visibleRoles = useMemo(
    () => (state?.roles ?? []).filter((role) => role.applicable),
    [state],
  );
  const panel = useMemo(
    () => visibleRoles.find((role) => role.role === activeRole) ?? visibleRoles[0] ?? null,
    [visibleRoles, activeRole],
  );

  if (!state || !panel) return null;

  const tabKey = `${phase}:${panel.role}`;
  const editing = editingKey === tabKey;
  const tabError = error?.key === tabKey ? error.message : "";

  const startEditing = () => {
    setDraft(toDraft(panel));
    setDraftScope(panel.source === "change" ? "change" : "project");
    setError(null);
    setEditingKey(tabKey);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/changes/${changeId}/rubrics`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phase,
          role: panel.role,
          scope: draftScope,
          criteria: draft
            .filter((criterion) => criterion.text.trim().length > 0)
            .map((criterion) => ({
              criterionKey: criterion.criterionKey,
              text: criterion.text.trim(),
              blocking: criterion.blocking,
            })),
        }),
      });
      const data = (await res.json()) as RubricPanelState & { error?: string };
      if (!res.ok) {
        setError({ key: tabKey, message: data.error ?? "保存失败" });
        return;
      }
      setState(data);
      setEditingKey(null);
    } catch (err) {
      setError({ key: tabKey, message: err instanceof Error ? err.message : "保存失败" });
    } finally {
      setSaving(false);
    }
  };

  // Every draft mutation is a functional update. Found in a real browser: two
  // clicks on "新增一条标准" inside one React batch both read the same captured
  // `draft`, so the second overwrote the first and only one row appeared.
  const move = (index: number, delta: number) => {
    setDraft((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved!);
      return next;
    });
  };

  return (
    <section
      className="rounded-lg border bg-background p-4"
      data-rubric-panel
      data-rubric-phase={phase}
      aria-label={`${phase} 评判标准`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">评判标准 · {phase}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            每条标准由 AI 明确回答是或否；漏答记为未评估，同样阻断。
          </p>
        </div>
        <span
          className="rounded-md border px-2 py-1 text-xs font-medium"
          data-rubric-scope-source={panel.source ?? "none"}
        >
          当前生效：{rubricScopeLabel(panel.source)}
          {panel.version === null ? "" : ` v${panel.version}`}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-1" role="tablist" aria-label="rubric roles">
        {visibleRoles.map((role) => (
          <button
            key={role.role}
            type="button"
            role="tab"
            aria-selected={role.role === panel.role}
            data-rubric-role-tab={role.role}
            onClick={() => setActiveRole(role.role)}
            className={`rounded-md border px-3 py-1 text-xs font-medium ${
              role.role === panel.role ? "bg-muted" : "bg-background text-muted-foreground"
            }`}
          >
            {RUBRIC_ROLE_LABELS[role.role]}
            {role.blocked ? (
              <span className="ml-1 text-destructive" aria-label="有阻断判定">
                ●
              </span>
            ) : null}
          </button>
        ))}
      </div>

      <p className="mt-2 text-xs text-muted-foreground">{RUBRIC_ROLE_HINTS[panel.role]}</p>

      <div role="tabpanel" data-rubric-role-panel={panel.role} className="mt-3 space-y-3">
        <RubricVerdictList panel={panel} roundId={state.roundId} />
        {editing ? (
          <RubricEditor
            draft={draft}
            draftScope={draftScope}
            saving={saving}
            error={tabError}
            hasChangeOverride={panel.hasChangeOverride}
            onChangeText={(index, text) =>
              setDraft((current) =>
                current.map((row, i) => (i === index ? { ...row, text } : row)),
              )
            }
            onToggleBlocking={(index) =>
              setDraft((current) =>
                current.map((row, i) => (i === index ? { ...row, blocking: !row.blocking } : row)),
              )
            }
            onRemove={(index) => setDraft((current) => current.filter((_row, i) => i !== index))}
            onMove={move}
            onAdd={() =>
              setDraft((current) => [...current, { criterionKey: null, text: "", blocking: true }])
            }
            onScopeChange={setDraftScope}
            onCancel={() => setEditingKey(null)}
            onSave={save}
          />
        ) : (
          <RubricCriteriaList panel={panel} onEdit={startEditing} />
        )}
      </div>
    </section>
  );
}

function RubricVerdictList({
  panel,
  roundId,
}: {
  panel: RubricRolePanel;
  roundId: string | null;
}) {
  if (panel.verdicts.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-rubric-verdicts="none">
        本轮还没有这一方的判定。
      </p>
    );
  }
  return (
    <div className="space-y-2" data-rubric-verdicts="present">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          本次判定
          {roundId ? <span className="ml-1 font-normal normal-case">（本轮）</span> : null}
        </h4>
        {panel.judgedByOutdatedVersion ? (
          // Same language as a stale war report: the judgment is real, it just
          // answers a checklist that is no longer the one in force (§7.6).
          <span
            className="rounded-md border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400"
            data-rubric-stale-verdicts
          >
            判定来自旧版本 rubric
            {panel.judgedVersion === null ? "" : ` v${panel.judgedVersion}`}，当前已是 v
            {panel.version ?? "?"}
          </span>
        ) : null}
      </div>
      <ul className="space-y-1.5">
        {panel.verdicts.map((verdict) => {
          const presentation = VERDICT_PRESENTATION[verdict.verdict];
          return (
            <li
              key={verdict.criterionKey}
              className={`rounded-md border px-2 py-1.5 text-xs ${VERDICT_TONE_CLASS[presentation.tone]}`}
              data-rubric-verdict={verdict.verdict}
              data-rubric-tone={presentation.tone}
              data-rubric-criterion-key={verdict.criterionKey}
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-semibold">
                  {presentation.glyph} {presentation.label}
                </span>
                <span className="min-w-0 flex-1 text-foreground">{verdict.text}</span>
                {presentation.tone === "block" ? (
                  <span
                    className="rounded border border-current px-1 text-[10px] font-semibold"
                    data-rubric-blocks-gate
                  >
                    阻断
                  </span>
                ) : null}
                {verdict.blocking ? null : (
                  <span className="text-[10px] text-muted-foreground">非阻断</span>
                )}
                {verdict.stillCurrent ? null : (
                  <span className="text-[10px] text-muted-foreground" data-rubric-criterion-dropped>
                    该标准已从当前 rubric 移除
                  </span>
                )}
              </div>
              {verdict.evidence ? (
                <p className="mt-1 text-muted-foreground">{verdict.evidence}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RubricCriteriaList({
  panel,
  onEdit,
}: {
  panel: RubricRolePanel;
  onEdit: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          标准清单（{panel.criteria.length}）
        </h4>
        {/* Always rendered, never behind a disclosure — §7.3. */}
        <Button type="button" variant="outline" size="sm" onClick={onEdit} data-rubric-edit-open>
          编辑评判标准
        </Button>
      </div>
      {panel.criteria.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-rubric-criteria="empty">
          还没有标准。空 rubric 是合法的，等于这一阶段不做 rubric 判定。
        </p>
      ) : (
        <ol className="space-y-1 text-xs" data-rubric-criteria="present">
          {panel.criteria.map((criterion, index) => (
            <li
              key={criterion.criterionKey}
              className="flex gap-2 rounded-md border bg-muted/20 px-2 py-1.5"
              data-rubric-criterion-key={criterion.criterionKey}
            >
              <span className="text-muted-foreground">{index + 1}.</span>
              <span className="min-w-0 flex-1">{criterion.text}</span>
              <span
                className="shrink-0 text-[10px] text-muted-foreground"
                data-rubric-blocking={criterion.blocking ? "true" : "false"}
              >
                {criterion.blocking ? "阻断" : "非阻断"}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function RubricEditor({
  draft,
  draftScope,
  saving,
  error,
  hasChangeOverride,
  onChangeText,
  onToggleBlocking,
  onRemove,
  onMove,
  onAdd,
  onScopeChange,
  onCancel,
  onSave,
}: {
  draft: DraftCriterion[];
  draftScope: "project" | "change";
  saving: boolean;
  error: string;
  hasChangeOverride: boolean;
  onChangeText: (index: number, text: string) => void;
  onToggleBlocking: (index: number) => void;
  onRemove: (index: number) => void;
  onMove: (index: number, delta: number) => void;
  onAdd: () => void;
  onScopeChange: (scope: "project" | "change") => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="space-y-2" data-rubric-editor>
      <ol className="space-y-1.5">
        {draft.map((criterion, index) => (
          <li key={index} className="flex flex-wrap items-center gap-1.5">
            <input
              type="text"
              value={criterion.text}
              onChange={(event) => onChangeText(index, event.target.value)}
              placeholder="一条可以用是/否回答的标准"
              aria-label={`标准 ${index + 1}`}
              data-rubric-criterion-input
              data-rubric-criterion-key={criterion.criterionKey ?? ""}
              className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs"
            />
            <button
              type="button"
              onClick={() => onToggleBlocking(index)}
              aria-pressed={criterion.blocking}
              data-rubric-blocking-toggle={criterion.blocking ? "true" : "false"}
              className={`rounded-md border px-2 py-1 text-[10px] font-medium ${
                criterion.blocking ? "border-destructive/50 text-destructive" : "text-muted-foreground"
              }`}
            >
              {criterion.blocking ? "阻断" : "非阻断"}
            </button>
            <button
              type="button"
              onClick={() => onMove(index, -1)}
              disabled={index === 0}
              aria-label={`上移标准 ${index + 1}`}
              data-rubric-move-up
              className="rounded-md border px-1.5 py-1 text-[10px] disabled:opacity-40"
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => onMove(index, 1)}
              disabled={index === draft.length - 1}
              aria-label={`下移标准 ${index + 1}`}
              data-rubric-move-down
              className="rounded-md border px-1.5 py-1 text-[10px] disabled:opacity-40"
            >
              ↓
            </button>
            <button
              type="button"
              onClick={() => onRemove(index)}
              aria-label={`删除标准 ${index + 1}`}
              data-rubric-remove
              className="rounded-md border px-1.5 py-1 text-[10px] text-destructive"
            >
              ✕
            </button>
          </li>
        ))}
      </ol>

      <Button type="button" variant="outline" size="sm" onClick={onAdd} data-rubric-add>
        + 新增一条标准
      </Button>

      <fieldset className="rounded-md border p-2" data-rubric-scope-picker>
        <legend className="px-1 text-[10px] font-medium text-muted-foreground">保存到</legend>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => onScopeChange("project")}
            aria-pressed={draftScope === "project"}
            data-rubric-scope-option="project"
            className={`rounded-md border px-2 py-1 text-[11px] ${
              draftScope === "project" ? "bg-muted font-medium" : "text-muted-foreground"
            }`}
          >
            项目默认（所有 Change 共用）
          </button>
          <button
            type="button"
            onClick={() => onScopeChange("change")}
            aria-pressed={draftScope === "change"}
            data-rubric-scope-option="change"
            className={`rounded-md border px-2 py-1 text-[11px] ${
              draftScope === "change" ? "bg-muted font-medium" : "text-muted-foreground"
            }`}
          >
            本 Change 覆盖{hasChangeOverride ? "（已存在）" : ""}
          </button>
        </div>
      </fieldset>

      {error ? (
        <p className="text-xs text-destructive" role="alert" data-rubric-error>
          {error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={onSave} disabled={saving} data-rubric-save>
          {saving ? "保存中…" : "保存新版本"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          取消
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground">
        保存会追加一个新版本，不改动旧版本，也不会让任何已盖章的门禁失效。
      </p>
    </div>
  );
}

export const RUBRIC_PANEL_ROLE_ORDER = RUBRIC_ROLES;
