import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/server/db";
import { changes, projects } from "@/server/db/schema";
import {
  listCodexModels,
  type CodexModelCatalogEntry,
} from "@/server/services/codex-model-catalog-service";
import {
  CodexSettingsError,
  resolveCodexSettings,
  validateCodexSettings,
  type CodexSettings,
} from "@/server/services/codex-settings-service";

const SETTINGS_SCHEMA = z.object({
  model: z.string().min(1).nullable(),
  reasoningEffort: z.string().min(1).nullable(),
}).strict();

interface ChangeSettingsRecord extends CodexSettings {
  project: {
    defaultCodexModel: string | null;
    defaultReasoningEffort: string | null;
  };
}

export interface ChangeCodexSettingsDependencies {
  read(projectId: string, changeId: string): ChangeSettingsRecord | null;
  write(changeId: string, settings: CodexSettings): void;
  listModels(): Promise<CodexModelCatalogEntry[]>;
}

function defaults(): ChangeCodexSettingsDependencies {
  return {
    read(projectId, changeId) {
      const change = db.select({
        model: changes.codexModel,
        reasoningEffort: changes.reasoningEffort,
        projectId: changes.projectId,
      }).from(changes).where(and(
        eq(changes.id, changeId),
        eq(changes.projectId, projectId),
      )).get();
      if (!change) return null;
      const project = db.select({
        defaultCodexModel: projects.defaultCodexModel,
        defaultReasoningEffort: projects.defaultReasoningEffort,
      }).from(projects).where(eq(projects.id, projectId)).get();
      return project ? { ...change, project } : null;
    },
    write(changeId, settings) {
      db.update(changes).set({
        codexModel: settings.model,
        reasoningEffort: settings.reasoningEffort,
        updatedAt: new Date().toISOString(),
      }).where(eq(changes.id, changeId)).run();
    },
    listModels: () => listCodexModels(),
  };
}

function response(record: ChangeSettingsRecord) {
  return {
    model: record.model,
    reasoningEffort: record.reasoningEffort,
    effective: resolveCodexSettings({
      change: record,
      project: record.project,
    }),
  };
}

export async function handleChangeCodexSettings(
  request: Request,
  projectId: string,
  changeId: string,
  dependencies: ChangeCodexSettingsDependencies = defaults(),
): Promise<NextResponse> {
  const current = dependencies.read(projectId, changeId);
  if (!current) {
    return NextResponse.json({ error: "change_not_found" }, { status: 404 });
  }
  if (request.method === "GET") return NextResponse.json(response(current));
  try {
    const requested = SETTINGS_SCHEMA.parse(await request.json());
    const effective = resolveCodexSettings({
      change: requested,
      project: current.project,
    });
    validateCodexSettings(await dependencies.listModels(), effective);
    dependencies.write(changeId, requested);
    return NextResponse.json(response({ ...current, ...requested }));
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return NextResponse.json({ error: "invalid_codex_settings" }, { status: 422 });
    }
    if (error instanceof CodexSettingsError) {
      return NextResponse.json({ error: error.code }, { status: 422 });
    }
    return NextResponse.json({ error: "codex_settings_failed" }, { status: 503 });
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> },
) {
  const { id, changeId } = await params;
  return handleChangeCodexSettings(request, id, changeId);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> },
) {
  const { id, changeId } = await params;
  return handleChangeCodexSettings(request, id, changeId);
}
