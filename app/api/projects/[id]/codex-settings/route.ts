import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/server/db";
import { projects } from "@/server/db/schema";
import {
  listCodexModels,
  type CodexModelCatalogEntry,
} from "@/server/services/codex-model-catalog-service";
import {
  CodexSettingsError,
  validateCodexSettings,
  type CodexSettings,
} from "@/server/services/codex-settings-service";

const SETTINGS_SCHEMA = z.object({
  model: z.string().min(1).nullable(),
  reasoningEffort: z.string().min(1).nullable(),
}).strict();

export interface ProjectCodexSettingsDependencies {
  read(projectId: string): CodexSettings | null;
  write(projectId: string, settings: CodexSettings): void;
  listModels(): Promise<CodexModelCatalogEntry[]>;
}

function defaults(): ProjectCodexSettingsDependencies {
  return {
    read(projectId) {
      const row = db.select({
        model: projects.defaultCodexModel,
        reasoningEffort: projects.defaultReasoningEffort,
      }).from(projects).where(eq(projects.id, projectId)).get();
      return row ?? null;
    },
    write(projectId, settings) {
      db.update(projects).set({
        defaultCodexModel: settings.model,
        defaultReasoningEffort: settings.reasoningEffort,
        updatedAt: new Date().toISOString(),
      }).where(eq(projects.id, projectId)).run();
    },
    listModels: () => listCodexModels(),
  };
}

export async function handleProjectCodexSettings(
  request: Request,
  projectId: string,
  dependencies: ProjectCodexSettingsDependencies = defaults(),
): Promise<NextResponse> {
  const current = dependencies.read(projectId);
  if (!current) {
    return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  }
  if (request.method === "GET") return NextResponse.json(current);
  try {
    const requested = SETTINGS_SCHEMA.parse(await request.json());
    const settings = validateCodexSettings(
      await dependencies.listModels(),
      requested,
    );
    dependencies.write(projectId, settings);
    return NextResponse.json(settings);
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
  { params }: { params: Promise<{ id: string }> },
) {
  return handleProjectCodexSettings(request, (await params).id);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleProjectCodexSettings(request, (await params).id);
}
