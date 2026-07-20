"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  createPipelinePreflightPayload,
  type PipelineActionContract,
} from "./changes/[changeId]/pipeline-action-contract";

interface FileEntry {
  path: string;
  status: "A" | "M" | "D" | "R" | "?";
}

interface WorkspaceStatus {
  clean: boolean;
  staged: FileEntry[];
  unstaged: FileEntry[];
  ahead: number;
  behind: number;
  branch: string | null;
  /**
   * getWorkingTreeStatus answers `clean: true` for a path that is not a
   * repository, which is indistinguishable from a genuinely clean tree, so this
   * has to be carried separately. Without it the panel reported "工作区干净" on
   * exactly the projects that were stuck at "Path is not a git repository."
   */
  isRepo: boolean;
  hasCommits: boolean;
}

const STATUS_LABELS: Record<string, string> = {
  A: "新增",
  M: "修改",
  D: "删除",
  R: "重命名",
  "?": "未追踪",
};

const STATUS_COLORS: Record<string, string> = {
  A: "text-green-600",
  M: "text-blue-600",
  D: "text-red-600",
  R: "text-purple-600",
  "?": "text-gray-500",
};

function normalizeWorkspaceStatus(data: Partial<WorkspaceStatus>): WorkspaceStatus {
  return {
    clean: Boolean(data.clean),
    staged: Array.isArray(data.staged) ? data.staged : [],
    unstaged: Array.isArray(data.unstaged) ? data.unstaged : [],
    ahead: typeof data.ahead === "number" ? data.ahead : 0,
    behind: typeof data.behind === "number" ? data.behind : 0,
    branch: typeof data.branch === "string" ? data.branch : null,
    // Absent field defaults to true: an older/failed response must not make an
    // existing repository look uninitialised and offer to `git init` over it.
    isRepo: data.isRepo !== false,
    hasCommits: data.hasCommits !== false,
  };
}

/**
 * This is the one Git surface that follows the user around: it is mounted on the
 * project page and, through StageGitPanel, on every phase of every change page.
 * Everything a stalled repository needs has to be reachable from here, because
 * the alternative is what it used to be -- notice the problem on a change's Fix
 * stage, navigate to the project page, open its Git tab, click 初始化 in
 * GitSetupPanel, navigate back.
 *
 * `changeId` is optional because the project page has no change in scope. When it
 * *is* in scope the panel routes through the change's contract actions instead of
 * the project-level git endpoint, so the operation is preflighted, attributed to
 * the change, and refused if HEAD moved since the contract was issued.
 */
export function GitWorkspacePanel({
  projectId,
  changeId,
  commitAction,
  initAction,
}: {
  projectId: string;
  changeId?: string;
  commitAction?: PipelineActionContract | null;
  initAction?: PipelineActionContract | null;
}) {
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadStatus = useCallback((showResult = false) => {
    fetch(`/api/projects/${projectId}/git/workspace`)
      .then((r) => r.json())
      .then((data: Partial<WorkspaceStatus>) => {
        const nextStatus = normalizeWorkspaceStatus(data);
        setStatus(nextStatus);
        if (showResult) setResult("Git 状态已刷新");
        if (!nextStatus.clean) {
          const allPaths = [...nextStatus.staged, ...nextStatus.unstaged].map((f) => f.path);
          setSelectedPaths((prev) => {
            if (prev.size === 0) return new Set(allPaths);
            return prev;
          });
        }
      })
      .catch(() => {
        if (showResult) setResult("刷新 Git 状态失败");
      });
  }, [projectId]);

  useEffect(() => {
    loadStatus();
    intervalRef.current = setInterval(() => loadStatus(), 8000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [loadStatus]);

  /**
   * `git init` in place, from wherever the user happens to be standing. The same
   * capability exists in GitSetupPanel, but that panel lives only in the project
   * page's Git section -- unreachable from a change without leaving the change.
   */
  async function handleInit() {
    setInitializing(true);
    setResult(null);
    try {
      const contractInit = changeId && initAction
        ? {
            url: `/api/projects/${projectId}/changes/${changeId}/git`,
            body: createPipelinePreflightPayload(initAction),
          }
        : null;
      const res = await fetch(contractInit?.url ?? `/api/projects/${projectId}/git`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(contractInit?.body ?? { action: "init" }),
      });
      const data = await res.json();
      if (res.ok) {
        setResult("已初始化 Git 仓库");
        loadStatus();
      } else {
        setResult(`初始化失败: ${data.action?.reason ?? data.reasonCode ?? data.error}`);
      }
    } catch {
      setResult("初始化请求失败");
    } finally {
      setInitializing(false);
    }
  }

  async function handleSuggest() {
    setSuggesting(true);
    setResult(null);
    try {
      // suggestCommitMessage has always accepted change context; nothing ever
      // passed it, so every suggestion was written as if the diff had no owner.
      const res = await fetch(`/api/projects/${projectId}/git/suggest-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changeId ? { changeId } : {}),
      });
      const data = await res.json();
      if (data.message) {
        setCommitMsg(data.message);
      } else {
        setResult(`AI 建议失败: ${data.error || "unknown"}`);
      }
    } catch {
      setResult("AI 建议请求失败");
    } finally {
      setSuggesting(false);
    }
  }

  async function handleCommit(andPush = false) {
    if (!commitMsg.trim()) return;
    setCommitting(true);
    setResult(null);
    try {
      const contractCommit = changeId && commitAction
        ? {
            url: `/api/projects/${projectId}/changes/${changeId}/git`,
            body: createPipelinePreflightPayload(commitAction, {
              message: commitMsg,
              paths: Array.from(selectedPaths),
            }),
          }
        : null;
      const res = await fetch(contractCommit?.url ?? `/api/projects/${projectId}/git`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(contractCommit?.body ?? {
          action: "commit_changes",
          message: commitMsg,
          paths: Array.from(selectedPaths),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setResult(`已提交: ${data.sha}`);
        setCommitMsg("");
        setSelectedPaths(new Set());

        if (andPush) {
          setPushing(true);
          const pushRes = await fetch(`/api/projects/${projectId}/git`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "push" }),
          });
          const pushData = await pushRes.json();
          if (pushRes.ok) {
            setResult(`已提交并推送: ${data.sha}`);
          } else {
            setResult(`已提交 ${data.sha}，但推送失败: ${pushData.error}`);
          }
          setPushing(false);
        }

        loadStatus();
      } else {
        // A contract refusal answers the 409 envelope, where `error` is only
        // "action_not_allowed" and the readable cause is on `action.reason`.
        setResult(`提交失败: ${data.action?.reason ?? data.reasonCode ?? data.error}`);
      }
    } catch {
      setResult("提交请求失败");
    } finally {
      setCommitting(false);
    }
  }

  async function handlePushOnly() {
    setPushing(true);
    setResult(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/git`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "push" }),
      });
      const data = await res.json();
      if (res.ok) {
        setResult("推送成功");
        loadStatus();
      } else {
        setResult(`推送失败: ${data.error}`);
      }
    } catch {
      setResult("推送请求失败");
    } finally {
      setPushing(false);
    }
  }

  function togglePath(path: string) {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleAll() {
    if (!status) return;
    const allPaths = [...status.staged, ...status.unstaged].map((f) => f.path);
    if (selectedPaths.size === allPaths.length) {
      setSelectedPaths(new Set());
    } else {
      setSelectedPaths(new Set(allPaths));
    }
  }

  if (!status) {
    return (
      <div className="rounded-lg border p-4">
        <p className="text-sm text-muted-foreground">加载工作区状态...</p>
      </div>
    );
  }

  /**
   * A path that is not a repository has no working tree to show, and showing the
   * ordinary clean-tree copy for it is what made this state invisible. The pipeline
   * refuses run_build here (build_base_camp_blocked / "Path is not a git
   * repository."), so this branch has to name the fault and offer the one action
   * that clears it, on whatever page the panel happens to be mounted.
   */
  if (!status.isRepo) {
    return (
      <div className="rounded-lg border p-4" data-git-repo-missing>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold">工作区</h2>
          <Button size="sm" variant="outline" onClick={() => loadStatus(true)}>
            刷新
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          该路径不是 Git 仓库，流水线的 Build 阶段会因此阻塞（Path is not a git repository）。
        </p>
        <div className="mt-3">
          <Button size="sm" onClick={handleInit} disabled={initializing}>
            {initializing ? "初始化中..." : "初始化 Git 仓库"}
          </Button>
        </div>
        {result && <p className="mt-3 text-sm text-muted-foreground">{result}</p>}
      </div>
    );
  }

  const allFiles = [...status.staged, ...status.unstaged];
  const uniqueFiles = Array.from(new Map(allFiles.map((f) => [f.path, f])).values());

  return (
    <div className="rounded-lg border p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">工作区</h2>
          {status.branch && (
            <span className="text-sm text-muted-foreground">{status.branch}</span>
          )}
          {status.ahead > 0 && (
            <span className="inline-flex items-center rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700 dark:bg-blue-900 dark:text-blue-200">
              ↑{status.ahead} 待推送
            </span>
          )}
          {status.behind > 0 && (
            <span className="inline-flex items-center rounded bg-orange-100 px-1.5 py-0.5 text-xs text-orange-700 dark:bg-orange-900 dark:text-orange-200">
              ↓{status.behind} 待拉取
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => loadStatus(true)}>
            刷新
          </Button>
          {status.ahead > 0 && status.clean && (
            <Button size="sm" variant="outline" onClick={handlePushOnly} disabled={pushing}>
              {pushing ? "推送中..." : "推送到远程"}
            </Button>
          )}
        </div>
      </div>

      {status.clean && status.ahead === 0 && (
        <p className="text-sm text-muted-foreground">工作区干净，没有未提交的改动。</p>
      )}

      {!status.clean && (
        <>
          {/* File list */}
          <div className="mb-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium">
                未提交改动 ({uniqueFiles.length})
              </span>
              <button className="text-xs text-muted-foreground hover:text-foreground" onClick={toggleAll}>
                {selectedPaths.size === uniqueFiles.length ? "取消全选" : "全选"}
              </button>
            </div>
            <div className="max-h-48 overflow-auto rounded border">
              {uniqueFiles.map((file) => (
                <label
                  key={file.path}
                  className="flex cursor-pointer items-center gap-2 border-b px-3 py-1.5 text-xs last:border-b-0 hover:bg-muted/50"
                >
                  <input
                    type="checkbox"
                    checked={selectedPaths.has(file.path)}
                    onChange={() => togglePath(file.path)}
                    className="h-3 w-3"
                  />
                  <span className={`w-4 font-mono ${STATUS_COLORS[file.status] || ""}`}>
                    {file.status}
                  </span>
                  <span className="flex-1 truncate font-mono">{file.path}</span>
                  <span className="text-muted-foreground">{STATUS_LABELS[file.status]}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Commit message */}
          <div className="mb-3">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-sm font-medium">Commit message</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleSuggest}
                disabled={suggesting}
                className="h-6 text-xs"
              >
                {suggesting ? "生成中..." : "AI 建议"}
              </Button>
            </div>
            <textarea
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              placeholder="feat(scope): describe your change"
              className="w-full rounded border bg-background px-3 py-2 font-mono text-sm"
              rows={3}
            />
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => handleCommit(false)}
              disabled={committing || !commitMsg.trim() || selectedPaths.size === 0}
            >
              {committing ? "提交中..." : "Commit"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleCommit(true)}
              disabled={committing || pushing || !commitMsg.trim() || selectedPaths.size === 0}
            >
              {pushing ? "推送中..." : "Commit & Push"}
            </Button>
          </div>
        </>
      )}

      {result && (
        <p className="mt-3 text-sm text-muted-foreground">{result}</p>
      )}
    </div>
  );
}
