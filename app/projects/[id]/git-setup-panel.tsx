"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

interface GitStatus {
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  ghUser: string | null;
  isRepo: boolean;
  hasCommits: boolean;
  hasRemote: boolean;
  remoteUrl: string | null;
  currentBranch: string | null;
  gitEnabled: boolean;
  defaultBranch: string | null;
}

export function GitSetupPanel({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [repoName, setRepoName] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");

  const loadStatus = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/git`);
      const data = await res.json();
      setStatus(data);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${projectId}/git`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  async function doAction(action: string) {
    setActionLoading(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/git`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, repoName: repoName || undefined, visibility }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage(data.message);
        loadStatus();
      } else {
        setMessage(`错误: ${data.error}`);
      }
    } finally {
      setActionLoading(false);
    }
  }

  if (loading && !status) {
    return (
      <div className="rounded-lg border p-4">
        <h2 className="text-lg font-semibold">Git 集成</h2>
        <p className="mt-2 text-sm text-muted-foreground">加载中...</p>
      </div>
    );
  }

  if (!status) return null;

  const allDone = status.isRepo && status.hasCommits && status.hasRemote;

  return (
    <div className="rounded-lg border p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Git 集成</h2>
        {allDone && status.remoteUrl && (
          <a
            href={status.remoteUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-600 hover:underline"
          >
            {status.remoteUrl}
          </a>
        )}
      </div>

      {/* Steps */}
      <div className="space-y-3">
        {/* Step 1: gh CLI */}
        <StepRow
          done={status.ghInstalled}
          label="gh CLI 已安装"
          failLabel="gh CLI 未安装 — 在终端运行: brew install gh"
        />

        {/* Step 2: gh auth */}
        <StepRow
          done={status.ghAuthenticated}
          label={`GitHub 已登录${status.ghUser ? ` (${status.ghUser})` : ""}`}
          failLabel="GitHub 未登录 — 在终端运行: gh auth login"
        />

        {/* Step 3: git init */}
        <StepRow done={status.isRepo} label="Git 仓库已初始化">
          {!status.isRepo && (
            <Button size="sm" disabled={actionLoading} onClick={() => doAction("init")}>
              初始化
            </Button>
          )}
        </StepRow>

        {/* Step 4: initial commit */}
        <StepRow done={status.hasCommits} label={`已有提交${status.currentBranch ? ` (${status.currentBranch})` : ""}`}>
          {status.isRepo && !status.hasCommits && (
            <Button size="sm" disabled={actionLoading} onClick={() => doAction("commit")}>
              创建初始提交
            </Button>
          )}
        </StepRow>

        {/* Step 5: remote */}
        <StepRow done={status.hasRemote} label={status.hasRemote ? `远程仓库已连接` : "远程仓库"}>
          {status.isRepo && status.hasCommits && !status.hasRemote && status.ghAuthenticated && (
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="仓库名"
                value={repoName}
                onChange={(e) => setRepoName(e.target.value)}
                className="h-8 w-40 rounded border bg-background px-2 text-sm"
              />
              <select
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as "private" | "public")}
                className="h-8 rounded border bg-background px-2 text-sm"
              >
                <option value="private">私有</option>
                <option value="public">公开</option>
              </select>
              <Button size="sm" disabled={actionLoading} onClick={() => doAction("create_remote")}>
                创建并推送
              </Button>
            </div>
          )}
        </StepRow>
      </div>

      {/* One-click full setup */}
      {!allDone && status.ghAuthenticated && (
        <div className="mt-4 border-t pt-3">
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="仓库名 (可选)"
              value={repoName}
              onChange={(e) => setRepoName(e.target.value)}
              className="h-8 w-40 rounded border bg-background px-2 text-sm"
            />
            <Button disabled={actionLoading} onClick={() => doAction("full_setup")}>
              {actionLoading ? "执行中..." : "一键完成所有步骤"}
            </Button>
          </div>
        </div>
      )}

      {/* Push button when everything is set up */}
      {allDone && (
        <div className="mt-3 border-t pt-3">
          <Button size="sm" variant="outline" disabled={actionLoading} onClick={() => doAction("push")}>
            {actionLoading ? "推送中..." : "推送到远程"}
          </Button>
        </div>
      )}

      {message && (
        <p className="mt-3 text-sm text-muted-foreground">{message}</p>
      )}
    </div>
  );
}

function StepRow({
  done,
  label,
  failLabel,
  children,
}: {
  done: boolean;
  label: string;
  failLabel?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${done ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-400"}`}>
        {done ? "✓" : "○"}
      </span>
      <span className={`text-sm ${done ? "text-foreground" : "text-muted-foreground"}`}>
        {done ? label : failLabel || label}
      </span>
      {children}
    </div>
  );
}
