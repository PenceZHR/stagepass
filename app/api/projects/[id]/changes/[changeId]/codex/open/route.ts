import path from "node:path";

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/server/db";
import { codexThreadBindings, projects } from "@/server/db/schema";
import type { CodexPersistentShell } from "@/server/services/codex-desktop-bridge-types";
import { createCodexAppServerShellControl } from "@/server/services/codex-app-server-shell-control";
import {
  defaultCodexDesktopDiscoveryDependencies,
  discoverCodexDesktopIpcEndpoint,
} from "@/server/services/codex-desktop-ipc-discovery";
import { createObservedCodexDesktopFollowerTransport } from "@/server/services/codex-desktop-ipc-transport";

export interface OpenCodexDependencies {
  readBinding(projectId: string, changeId: string): {
    threadId: string | null;
    title: string;
    status: string;
    repoPath: string;
  } | null;
  readShell(threadId: string): Promise<CodexPersistentShell | null>;
  openThread(threadId: string): Promise<void>;
}

function defaults(): OpenCodexDependencies {
  let controls: Promise<{
    shell: ReturnType<typeof createCodexAppServerShellControl>;
    follower: ReturnType<typeof createObservedCodexDesktopFollowerTransport>;
  }> | null = null;
  const getControls = () => {
    controls ??= (async () => {
      const endpoint = await discoverCodexDesktopIpcEndpoint(
        defaultCodexDesktopDiscoveryDependencies(),
      );
      return {
        shell: createCodexAppServerShellControl({
          appServerBinary: endpoint.appServerBinary,
        }),
        follower: createObservedCodexDesktopFollowerTransport(endpoint),
      };
    })();
    return controls;
  };
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
    readShell: async (threadId) =>
      (await getControls()).shell.readPersistentShell(threadId),
    openThread: async (threadId) =>
      (await getControls()).follower.openThreadDeepLink({
        url: `codex://threads/${threadId}`,
      }),
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
    const shell = await resolved.readShell(binding.threadId);
    if (
      !shell
      || shell.threadId !== binding.threadId
      || shell.ephemeral !== false
      || shell.title !== binding.title
      || path.resolve(shell.cwd) !== path.resolve(binding.repoPath)
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
