import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/server/db";
import { codexThreadBindings, projects } from "@/server/db/schema";

const execFileAsync = promisify(execFile);

export interface OpenCodexDependencies {
  readBinding(projectId: string, changeId: string): {
    threadId: string | null;
    title: string;
    status: string;
    repoPath: string;
  } | null;
  openThread(threadId: string): Promise<void>;
}

function defaults(): OpenCodexDependencies {
  return {
    readBinding(projectId, changeId) {
      const binding = db.select().from(codexThreadBindings).where(and(
        eq(codexThreadBindings.scopeKind, "change"),
        eq(codexThreadBindings.scopeId, changeId),
        eq(codexThreadBindings.projectId, projectId),
        eq(codexThreadBindings.changeId, changeId),
      )).get();
      if (!binding) return null;
      const project = db.select({ repoPath: projects.repoPath }).from(projects)
        .where(eq(projects.id, projectId)).get();
      return project ? { ...binding, repoPath: project.repoPath } : null;
    },
    async openThread(threadId) {
      if (!/^[A-Za-z0-9-]+$/.test(threadId)) {
        throw new Error("invalid Codex thread id");
      }
      await execFileAsync(
        "/usr/bin/open",
        [`codex://threads/${threadId}`],
        { timeout: 5_000 },
      );
    },
  };
}

export async function handleOpenCodex(
  projectId: string,
  changeId: string,
  dependencies?: OpenCodexDependencies,
): Promise<NextResponse> {
  try {
    const resolved = dependencies ?? defaults();
    const binding = resolved.readBinding(projectId, changeId);
    if (
      !binding?.threadId
      || !["ready", "running", "waiting_human"].includes(binding.status)
    ) {
      return NextResponse.json(
        { error: "desktop_thread_detached" },
        { status: 409 },
      );
    }
    await resolved.openThread(binding.threadId);
    return NextResponse.json({ opened: true, threadId: binding.threadId });
  } catch {
    return NextResponse.json(
      { error: "desktop_bridge_unavailable" },
      { status: 503 },
    );
  }
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> },
) {
  const { id, changeId } = await params;
  return handleOpenCodex(id, changeId);
}
