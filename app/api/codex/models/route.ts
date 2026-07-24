import { NextResponse } from "next/server";

import {
  listCodexModels,
  type CodexModelCatalogEntry,
} from "@/server/services/codex-model-catalog-service";

export interface CodexModelsRouteDependencies {
  listModels(): Promise<CodexModelCatalogEntry[]>;
}

export async function handleCodexModelsGet(
  dependencies: CodexModelsRouteDependencies = {
    listModels: () => listCodexModels(),
  },
): Promise<NextResponse> {
  try {
    return NextResponse.json({ models: await dependencies.listModels() });
  } catch (error) {
    return NextResponse.json(
      {
        error: "codex_model_catalog_unavailable",
        message: error instanceof Error ? error.message : "Model catalog unavailable",
      },
      { status: 503 },
    );
  }
}

export async function GET() {
  return handleCodexModelsGet();
}
