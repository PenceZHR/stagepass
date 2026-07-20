import { NextResponse } from "next/server";
import {
  getProject,
  regenerateProjectContext,
  updateProjectProviders,
} from "@/server/services/project-service";
import { ProviderSelectionInput } from "@/server/types";
import fs from "fs";
import path from "path";

const CONTEXT_DOCS = ["architecture.md", "coding-rules.md", "tech-stack.md", "file-guide.md"];

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const shipDir = path.join(project.repoPath, ".ship");
  const docs: Record<string, string | null> = {};

  for (const doc of CONTEXT_DOCS) {
    const filePath = path.join(shipDir, doc);
    if (fs.existsSync(filePath)) {
      docs[doc] = fs.readFileSync(filePath, "utf-8");
    } else {
      docs[doc] = null;
    }
  }

  let progress = null;
  if (project.contextStatus === "generating") {
    const progressPath = path.join(shipDir, "context-progress.json");
    if (fs.existsSync(progressPath)) {
      try {
        progress = JSON.parse(fs.readFileSync(progressPath, "utf-8"));
      } catch {
        // ignore malformed progress file
      }
    }
  }

  return NextResponse.json({
    contextStatus: project.contextStatus || "pending",
    contextProvider: project.contextProvider || "codex",
    docs,
    progress,
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const parsed = ProviderSelectionInput.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const provider = parsed.data.provider || project.contextProvider || "codex";
    if (parsed.data.saveAsDefault && parsed.data.provider) {
      await updateProjectProviders(id, { contextProvider: parsed.data.provider });
    }

    regenerateProjectContext(id, provider).catch(() => {});
    return NextResponse.json({ status: "generating", provider });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
