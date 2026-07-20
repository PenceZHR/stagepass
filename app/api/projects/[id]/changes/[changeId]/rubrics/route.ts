import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/server/db";
import { changes } from "@/server/db/schema";
import { isRubricPhase, isRubricRole } from "@/server/services/rubric-assessment";
import { buildRubricPanelState } from "@/server/services/rubric-panel-service";
import { RubricError, saveRubricVersion } from "@/server/services/rubric-service";

/**
 * Read and edit one phase's three rubrics.
 *
 * GET  ?phase=Spec              -> the whole drawer: three role panels plus this round's verdicts
 * PUT  { phase, role, scope, criteria } -> appends a new version and makes it current
 *
 * There is no DELETE. An empty criteria array already means "this phase does no
 * rubric judging" (§4.5), and it means it as a new VERSION, so the history of
 * what earlier runs were judged against survives. A real delete would take that
 * history with it.
 */

function resolveChange(projectId: string, changeId: string) {
  return db
    .select()
    .from(changes)
    .where(and(eq(changes.id, changeId), eq(changes.projectId, projectId)))
    .get();
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> },
) {
  const { id: projectId, changeId } = await params;
  if (!resolveChange(projectId, changeId)) {
    return NextResponse.json({ error: "Change not found" }, { status: 404 });
  }

  const phase = new URL(request.url).searchParams.get("phase") ?? "";
  if (!isRubricPhase(phase)) {
    return NextResponse.json({ error: `Unknown rubric phase: ${phase}` }, { status: 400 });
  }

  return NextResponse.json(buildRubricPanelState({ projectId, changeId, phase }));
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> },
) {
  const { id: projectId, changeId } = await params;
  if (!resolveChange(projectId, changeId)) {
    return NextResponse.json({ error: "Change not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "JSON object body required" }, { status: 400 });
  }

  const payload = body as {
    phase?: unknown;
    role?: unknown;
    scope?: unknown;
    criteria?: unknown;
  };
  if (typeof payload.phase !== "string" || !isRubricPhase(payload.phase)) {
    return NextResponse.json({ error: `Unknown rubric phase: ${payload.phase}` }, { status: 400 });
  }
  if (typeof payload.role !== "string" || !isRubricRole(payload.role)) {
    return NextResponse.json({ error: `Unknown rubric role: ${payload.role}` }, { status: 400 });
  }
  if (payload.scope !== "project" && payload.scope !== "change") {
    return NextResponse.json({ error: "scope must be 'project' or 'change'" }, { status: 400 });
  }
  if (!Array.isArray(payload.criteria)) {
    return NextResponse.json({ error: "criteria array required" }, { status: 400 });
  }

  const criteria: Array<{ text: string; blocking: boolean; criterionKey: string | null }> = [];
  for (const [index, raw] of payload.criteria.entries()) {
    if (!raw || typeof raw !== "object") {
      return NextResponse.json({ error: `criteria[${index}] must be an object` }, { status: 400 });
    }
    const entry = raw as { text?: unknown; blocking?: unknown; criterionKey?: unknown };
    if (typeof entry.text !== "string" || !entry.text.trim()) {
      return NextResponse.json(
        { error: `criteria[${index}].text must be a non-empty string` },
        { status: 400 },
      );
    }
    if (entry.blocking !== undefined && typeof entry.blocking !== "boolean") {
      return NextResponse.json(
        { error: `criteria[${index}].blocking must be a boolean` },
        { status: 400 },
      );
    }
    criteria.push({
      text: entry.text,
      // Absent means blocking, matching the column default and §4.3's
      // fail-closed direction: a standard nobody marked advisory is one that
      // stops the pipeline.
      blocking: entry.blocking !== false,
      criterionKey: typeof entry.criterionKey === "string" ? entry.criterionKey : null,
    });
  }

  try {
    saveRubricVersion({
      projectId,
      // §4.5: the project-level row is the default and the change-level row
      // overrides it. Which one this request edits is explicit in the payload,
      // never inferred, so a UI showing "project default" cannot silently write
      // a change-level override.
      changeId: payload.scope === "change" ? changeId : null,
      phase: payload.phase,
      role: payload.role,
      criteria,
    });
  } catch (err) {
    if (err instanceof RubricError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json(
    buildRubricPanelState({ projectId, changeId, phase: payload.phase }),
  );
}
