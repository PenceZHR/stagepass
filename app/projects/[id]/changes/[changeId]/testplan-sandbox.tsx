"use client";

import { AlertTriangle, CheckCircle2, ClipboardCheck, TerminalSquare } from "lucide-react";

import type {
  TestPlanCoverageItem,
  TestPlanSandboxState,
} from "./testplan-sandbox-types";

interface TestPlanSandboxProps {
  state: TestPlanSandboxState | null;
  loading?: boolean;
}

function metaValue(value: string | null | undefined): string {
  return value && value.length > 0 ? value : "-";
}

function priorityGroups(items: TestPlanCoverageItem[]) {
  return items.reduce<Record<string, TestPlanCoverageItem[]>>((groups, item) => {
    const key = item.priority || "P?";
    groups[key] = [...(groups[key] ?? []), item];
    return groups;
  }, {});
}

function formatBlocker(blocker: unknown): string {
  if (typeof blocker === "string") return blocker;
  if (blocker && typeof blocker === "object" && "title" in blocker) {
    const title = (blocker as { title?: unknown }).title;
    if (typeof title === "string") return title;
  }
  return JSON.stringify(blocker);
}

export function TestPlanSandbox({ state, loading = false }: TestPlanSandboxProps) {
  if (loading && !state) {
    return <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">TestPlan snapshot loading.</p>;
  }

  if (!state?.snapshot) {
    return (
      <div className="rounded-md border border-dashed p-4">
        <h2 className="text-sm font-semibold">No TestPlan snapshot</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Generate the TestPlan phase to populate coverage, risk mappings, required commands, and manual checks.
        </p>
      </div>
    );
  }

  const groupedCoverage = priorityGroups(state.coverageItems);
  const blockers = state.gate.blockers.map(formatBlocker);

  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[1fr_1fr]">
      <section className="lg:col-span-2">
        <div className="grid gap-3 rounded-md border p-4 md:grid-cols-4">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Snapshot</p>
            <p className="mt-1 break-all font-mono text-xs">{state.snapshot.id}</p>
          </div>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Status</p>
            <p className="mt-1 text-sm font-semibold">{state.status}</p>
          </div>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Approval</p>
            <p className="mt-1 text-sm font-semibold">{state.snapshot.approvalState}</p>
          </div>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Gate</p>
            <p className="mt-1 text-sm font-semibold">{metaValue(state.gate.status)}</p>
          </div>
        </div>
      </section>

      <section className="rounded-md border p-4 lg:col-span-2">
        <div className="mb-3 flex items-center gap-2">
          <ClipboardCheck className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-sm font-semibold">Test Intent</h2>
        </div>
        <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{state.testIntent}</p>
      </section>

      <section className="rounded-md border p-4">
        <h2 className="text-sm font-semibold">Coverage Items</h2>
        <div className="mt-3 space-y-4">
          {Object.entries(groupedCoverage).map(([priority, items]) => (
            <div key={priority}>
              <p className="mb-2 text-xs font-semibold text-muted-foreground">{priority}</p>
              <div className="space-y-2">
                {items.map((item) => (
                  <div key={item.id} className="rounded-md border bg-muted/20 p-3">
                    <p className="break-words text-sm font-medium">{item.itemKey}: {item.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.testType} / {metaValue(item.requirementRef)} / {item.status}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {state.coverageItems.length === 0 && (
            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">No coverage items.</p>
          )}
        </div>
      </section>

      <section className="rounded-md border p-4">
        <h2 className="text-sm font-semibold">Risk Mappings</h2>
        <div className="mt-3 space-y-2">
          {state.riskMappings.map((mapping) => (
            <div key={mapping.id} className="rounded-md border bg-muted/20 p-3">
              <p className="break-words text-sm font-medium">
                {mapping.coverageItemKey}{" -> "}{mapping.riskRef}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{mapping.severity}: {mapping.mitigation}</p>
            </div>
          ))}
          {state.riskMappings.length === 0 && (
            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">No risk mappings.</p>
          )}
        </div>
      </section>

      <section className="rounded-md border p-4">
        <div className="mb-3 flex items-center gap-2">
          <TerminalSquare className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-sm font-semibold">Required Commands</h2>
        </div>
        <div className="space-y-2">
          {state.requiredCommands.map((command) => (
            <div key={command.id} className="rounded-md border bg-muted/20 p-3">
              <p className="break-all font-mono text-xs">{command.command}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                order {command.commandOrder} / {command.required === 1 ? "required" : "optional"}
              </p>
            </div>
          ))}
          {state.requiredCommands.length === 0 && (
            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">No required commands.</p>
          )}
        </div>
      </section>

      <section className="rounded-md border p-4">
        <h2 className="text-sm font-semibold">Manual Checks</h2>
        <div className="mt-3 space-y-2">
          {state.manualChecks.map((check) => (
            <div key={check.id} className="rounded-md border bg-muted/20 p-3">
              <p className="text-sm font-medium">{check.title}</p>
              {check.description && (
                <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{check.description}</p>
              )}
              <p className="mt-1 text-[11px] text-muted-foreground">
                {check.required === 1 ? "required" : "optional"}
              </p>
            </div>
          ))}
          {state.manualChecks.length === 0 && (
            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">No manual checks.</p>
          )}
        </div>
      </section>

      <section className="rounded-md border p-4 lg:col-span-2">
        {blockers.length > 0 ? (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-red-900">
            <div className="mb-2 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              <h2 className="text-sm font-semibold">Gate blockers</h2>
            </div>
            <div className="space-y-1">
              {blockers.map((blocker) => (
                <p key={blocker} className="break-words text-xs leading-5">{blocker}</p>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-emerald-900">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              <h2 className="text-sm font-semibold">Gate has no blockers</h2>
            </div>
          </div>
        )}
        <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">
          sourceDbHash {metaValue(state.gate.sourceDbHash)}
        </p>
      </section>
    </div>
  );
}
