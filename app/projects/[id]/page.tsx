"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CreateChangeDialog } from "./create-change-dialog";
import { PrdEditor } from "./prd-editor";
import { GitSetupPanel } from "./git-setup-panel";
import { GitWorkspacePanel } from "./git-workspace-panel";

interface Project {
  id: string;
  name: string;
  repoPath: string;
  contextStatus?: string;
  contextProvider?: "codex" | "claude";
  prdStatus?: string;
  prdProvider?: "codex" | "claude";
  gitEnabled?: number;
  gitDefaultBranch?: string | null;
}

interface Change {
  id: string;
  title: string;
  status: string;
  provider?: string;
  createdAt: string;
  updatedAt: string;
}

interface ContextProgress {
  stage: string;
  percent: number;
  currentFile?: string;
  message: string;
  provider?: "codex" | "claude";
}

interface ContextData {
  contextStatus: string;
  contextProvider?: "codex" | "claude";
  docs: Record<string, string | null>;
  progress?: ContextProgress | null;
}

interface BaselineDoc {
  name: string;
  title: string;
  status: "present" | "missing";
  size: number;
  updatedAt: string | null;
  content?: string;
}

interface BaselineData {
  docs: BaselineDoc[];
}

function statusVariant(status: string): "default" | "success" | "warning" | "destructive" | "info" | "pending" | "blocked" | "outline" {
  if (["DONE", "TESTPLAN_DONE", "IMPLEMENTED", "SPEC_DONE", "TECH_SPEC_DONE", "LOCAL_READY", "MERGE_READY"].includes(status)) return "success";
  if (["BLOCKED"].includes(status)) return "blocked";
  if (["CHECKING", "FIXING", "FIX_REVIEW", "REVIEWING"].includes(status)) return "pending";
  if (["REFINING", "PLAN_APPROVED", "PLAN_READY", "INTAKE_READY", "SPEC_READY", "TECHSPEC_READY"].includes(status)) return "info";
  if (["DRAFT", "PLANNING", "IMPLEMENTING", "SPECCING", "TECHSPECCING", "TESTPLANNING", "MERGING", "RETRO_PENDING"].includes(status)) return "default";
  if (["CANCELLED", "CHECK_FAILED", "SCOPE_FAILED"].includes(status)) return "destructive";
  return "outline";
}

const RUNNING_STATES = new Set([
  "PLANNING",
  "IMPLEMENTING",
  "REVIEWING",
  "CHECKING",
  "FIXING",
  "SPECCING",
  "TECHSPECCING",
  "TESTPLANNING",
  "MERGING",
  "RETRO_PENDING",
]);

type NavSection = "changes" | "prd" | "context" | "baseline" | "git";

const NAV_ITEMS: { key: NavSection; label: string; icon: string }[] = [
  { key: "changes", label: "Changes", icon: "⚡" },
  { key: "prd", label: "PRD", icon: "📋" },
  { key: "context", label: "上下文", icon: "🧠" },
  { key: "baseline", label: "基线文档", icon: "📚" },
  { key: "git", label: "Git", icon: "🔀" },
];

export default function ProjectDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const [project, setProject] = useState<Project | null>(null);
  const [changes, setChanges] = useState<Change[]>([]);
  const [context, setContext] = useState<ContextData | null>(null);
  const [baseline, setBaseline] = useState<BaselineData | null>(null);
  const [editingDoc, setEditingDoc] = useState<string | null>(null);
  const [editContent, setEditContent] = useState<string>("");
  const [expandedDoc, setExpandedDoc] = useState<string | null>(null);
  const [expandedBaselineDoc, setExpandedBaselineDoc] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [prdStatus, setPrdStatus] = useState<string>("none");
  const [prdContent, setPrdContent] = useState<string | null>(null);
  const [prdHistory, setPrdHistory] = useState<Array<{role: "user"|"assistant"; content: string}>>([]);
  const [prdStructured, setPrdStructured] = useState<Record<string, unknown> | null>(null);
  const [prdValidation, setPrdValidation] = useState<{ valid: boolean; issues: Array<{ field: string; severity: string; message: string }> } | null>(null);
  const [contextProvider, setContextProvider] = useState<"codex" | "claude">("codex");
  const [prdProvider, setPrdProvider] = useState<"codex" | "claude">("codex");
  const [activeSection, setActiveSection] = useState<NavSection>("changes");

  const loadProject = useCallback(() => {
    fetch(`/api/projects/${projectId}`).then((r) => r.json()).then((data) => {
      setProject(data);
      setPrdStatus(data.prdStatus || "none");
      setContextProvider(data.contextProvider || "codex");
      setPrdProvider(data.prdProvider || "codex");
    });
  }, [projectId]);

  const loadChanges = useCallback(() => {
    fetch(`/api/projects/${projectId}/changes`).then((r) => r.json()).then(setChanges);
  }, [projectId]);

  const loadContext = useCallback(() => {
    fetch(`/api/projects/${projectId}/context`).then((r) => r.json()).then((data) => {
      setContext(data);
      setContextProvider(data.contextProvider || "codex");
    });
  }, [projectId]);

  const loadBaseline = useCallback(() => {
    fetch(`/api/projects/${projectId}/baseline`).then((r) => r.json()).then(setBaseline);
  }, [projectId]);

  const loadPrd = useCallback(() => {
    fetch(`/api/projects/${projectId}/prd`).then((r) => r.json()).then((data) => {
      setPrdStatus(data.status || "none");
      setPrdContent(data.content || null);
      setPrdHistory(data.history || []);
      setPrdStructured(data.structured || null);
      setPrdValidation(data.validation || null);
      setPrdProvider(data.prdProvider || "codex");
    });
  }, [projectId]);

  async function handleDelete(e: React.MouseEvent, changeId: string) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`确定删除 ${changeId}？相关文件也会被清除。`)) return;
    const res = await fetch(`/api/projects/${projectId}/changes/${changeId}`, { method: "DELETE" });
    if (res.ok) {
      loadChanges();
    } else {
      const data = await res.json();
      alert(`删除失败: ${data.error}`);
    }
  }

  function handleChangeCreated(change: { id: string }) {
    router.push(`/projects/${projectId}/changes/${change.id}`);
  }

  async function handleInitContext() {
    await fetch(`/api/projects/${projectId}/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: contextProvider, saveAsDefault: true }),
    });
    loadContext();
    loadProject();
  }

  async function handleSaveDoc(docName: string) {
    setSaving(true);
    await fetch(`/api/projects/${projectId}/context/${docName}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: editContent }),
    });
    setSaving(false);
    setEditingDoc(null);
    loadContext();
  }

  async function handleToggleBaselineDoc(docName: string) {
    const nextDoc = expandedBaselineDoc === docName ? null : docName;
    setExpandedBaselineDoc(nextDoc);
    if (!nextDoc || baselineDocs.find((doc) => doc.name === docName)?.content) return;

    const res = await fetch(`/api/projects/${projectId}/baseline/${docName}`);
    if (!res.ok) return;
    const doc = await res.json();
    setBaseline((current) => {
      if (!current) return current;
      return {
        docs: (current.docs ?? []).map((item) =>
          item.name === docName ? { ...item, ...doc } : item
        ),
      };
    });
  }

  useEffect(() => {
    loadProject();
    loadChanges();
    loadContext();
    loadBaseline();
    loadPrd();
  }, [projectId, loadProject, loadChanges, loadContext, loadBaseline, loadPrd]);

  useEffect(() => {
    if (context?.contextStatus !== "generating") return;
    const interval = setInterval(loadContext, 3000);
    return () => clearInterval(interval);
  }, [context?.contextStatus, loadContext]);

  const contextDocs = context?.docs ?? {};
  const baselineDocs = baseline?.docs ?? [];
  const canCreateChange = prdStatus === "ready" || project?.prdStatus === "ready";
  const prdStatusLoading = !project;
  const newChangeDisabled = prdStatusLoading || !canCreateChange;
  const needsPrdBeforeChange = !prdStatusLoading && !canCreateChange;

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="flex w-56 flex-col border-r bg-muted/30">
        <div className="border-b p-4">
          <Link href="/projects" className="text-xs text-muted-foreground hover:text-foreground">
            ← 项目列表
          </Link>
          {project && (
            <div className="mt-2">
              <h1 className="truncate text-sm font-bold">{project.name}</h1>
              <p className="truncate text-xs text-muted-foreground">{project.id}</p>
            </div>
          )}
        </div>

        <nav className="flex-1 p-2">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              onClick={() => setActiveSection(item.key)}
              className={`mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                activeSection === item.key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <span className="text-base">{item.icon}</span>
              {item.label}
              {item.key === "changes" && changes.length > 0 && (
                <span className="ml-auto rounded-full bg-muted-foreground/20 px-1.5 py-0.5 text-xs">
                  {changes.length}
                </span>
              )}
            </button>
          ))}
        </nav>

        {/* Sidebar footer: project path */}
        {project && (
          <div className="border-t p-3">
            <p className="truncate text-xs text-muted-foreground" title={project.repoPath}>
              {project.repoPath}
            </p>
            {project.gitEnabled ? (
              <Badge variant="success" className="mt-1">
                Git {project.gitDefaultBranch && `(${project.gitDefaultBranch})`}
              </Badge>
            ) : null}
          </div>
        )}
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        {/* Changes Section */}
        {activeSection === "changes" && (
          <div className="mx-auto max-w-4xl px-8 py-10">
            <div className="mb-6 flex items-center justify-between">
              <h2 className="text-xl font-semibold">Changes</h2>
              {canCreateChange ? (
                <CreateChangeDialog projectId={projectId} onCreated={handleChangeCreated} />
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  disabled={newChangeDisabled}
                  title={needsPrdBeforeChange ? "先完成项目 PRD 后才能新建 Change" : undefined}
                >
                  New Change
                </Button>
              )}
            </div>

            {needsPrdBeforeChange ? (
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-5 text-sm text-blue-950 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-100">
                <h3 className="font-medium">先完成项目 PRD</h3>
                <p className="mt-1 text-blue-800 dark:text-blue-200">
                  Change 需要基于已确认的项目 PRD 执行。先到 PRD 阶段确认产品边界，再回来创建 Change。
                </p>
                <Button
                  type="button"
                  size="sm"
                  className="mt-4"
                  onClick={() => setActiveSection("prd")}
                >
                  去写 PRD
                </Button>
              </div>
            ) : changes.length === 0 ? (
              <p className="text-muted-foreground">No changes found.</p>
            ) : (
              <div className="grid gap-3">
                {changes.map((c) => (
                  <Link key={c.id} href={`/projects/${projectId}/changes/${c.id}`}>
                    <Card className="group transition-colors hover:bg-muted/50">
                      <CardHeader className="py-4">
                        <CardTitle className="flex items-center gap-3 text-base">
                          <span className="font-mono text-sm text-muted-foreground">
                            {c.id}
                          </span>
                          {c.title}
                          {!RUNNING_STATES.has(c.status) && (
                            <button
                              className="ml-2 inline-flex items-center gap-1 rounded border border-red-200 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950"
                              onClick={(e) => handleDelete(e, c.id)}
                              aria-label={`删除 ${c.id}`}
                              title="删除"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                              删除
                            </button>
                          )}
                          <Badge variant={statusVariant(c.status)} className="ml-auto">
                            {c.status}
                          </Badge>
                          {c.provider && (
                            <span
                              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                                c.provider === "claude"
                                  ? "bg-orange-100 text-orange-700"
                                  : "bg-blue-100 text-blue-700"
                              }`}
                            >
                              {c.provider === "claude" ? "Claude" : "Codex"}
                            </span>
                          )}
                        </CardTitle>
                        <CardDescription className="text-xs">
                          Created {new Date(c.createdAt).toLocaleString()}
                        </CardDescription>
                      </CardHeader>
                    </Card>
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}

        {/* PRD Section */}
        {activeSection === "prd" && project && (
          <div className="flex h-[calc(100vh-2rem)] flex-col px-8 pt-6 pb-4">
            <h2 className="mb-4 shrink-0 text-xl font-semibold">PRD</h2>
            <div className="relative min-h-0 flex-1">
              <div className="absolute inset-0">
              <PrdEditor
              projectId={projectId}
              prdStatus={prdStatus}
              prdContent={prdContent}
              chatHistory={prdHistory}
              structured={prdStructured}
              validation={prdValidation}
              provider={prdProvider}
              onProviderChange={setPrdProvider}
              onConfirm={() => { loadPrd(); loadContext(); }}
              onStatusChange={loadPrd}
              onContentUpdate={(content) => {
                if (content) setPrdContent(content);
              }}
            />
              </div>
            </div>
          </div>
        )}

        {/* Context Section */}
        {activeSection === "context" && context && (
          <div className="mx-auto max-w-4xl px-8 py-10">
            <div className="mb-6 flex items-center justify-between">
              <h2 className="text-xl font-semibold">项目上下文</h2>
              <div className="flex items-center gap-2">
                {context.contextStatus === "generating" && (
                  <div className="flex items-center gap-2">
                    <span className="animate-pulse text-sm text-yellow-600">生成中...</span>
                    {context.progress && (
                      <span className="text-xs text-muted-foreground">
                        [{context.progress.stage}] {context.progress.message}
                      </span>
                    )}
                  </div>
                )}
                {context.contextStatus === "failed" && (
                  <span className="text-sm text-red-600">生成失败</span>
                )}
                {context.contextStatus === "ready" && (
                  <span className="text-sm text-green-600">已就绪</span>
                )}
                <select
                  value={contextProvider}
                  onChange={(e) => setContextProvider(e.target.value as "codex" | "claude")}
                  className="h-8 rounded-md border bg-background px-2 text-xs"
                  disabled={context.contextStatus === "generating"}
                  title="Context 引擎"
                >
                  <option value="codex">Codex</option>
                  <option value="claude">Claude Code</option>
                </select>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleInitContext}
                  disabled={context.contextStatus === "generating"}
                >
                  {context.contextStatus === "pending" ? "初始化文档" : "重新生成"}
                </Button>
              </div>
            </div>

            {context.contextStatus !== "pending" && (
              <div className="grid gap-2">
                {context.contextStatus === "generating" && context.progress && (
                  <div className="mb-2 space-y-1">
                    <div className="h-2 w-full rounded-full bg-muted">
                      <div
                        className="h-2 rounded-full bg-primary transition-all"
                        style={{ width: `${context.progress.percent}%` }}
                      />
                    </div>
                    {context.progress.currentFile && (
                      <p className="font-mono text-xs text-muted-foreground">
                        正在分析 {context.progress.currentFile}
                      </p>
                    )}
                  </div>
                )}
                {Object.entries(contextDocs).map(([name, content]) => (
                  <div key={name} className="rounded border">
                    <button
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium hover:bg-muted/50"
                      onClick={() => setExpandedDoc(expandedDoc === name ? null : name)}
                    >
                      <span>{name}</span>
                      <span className="text-xs text-muted-foreground">
                        {content ? `${content.length} chars` : "空"}
                      </span>
                    </button>

                    {expandedDoc === name && (
                      <div className="border-t px-3 py-2">
                        {editingDoc === name ? (
                          <div className="space-y-2">
                            <textarea
                              className="h-64 w-full rounded border bg-background p-2 font-mono text-xs"
                              value={editContent}
                              onChange={(e) => setEditContent(e.target.value)}
                            />
                            <div className="flex gap-2">
                              <Button size="sm" onClick={() => handleSaveDoc(name)} disabled={saving}>
                                {saving ? "保存中..." : "保存"}
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => setEditingDoc(null)}>
                                取消
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div>
                            <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">
                              {content || "（无内容）"}
                            </pre>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="mt-2"
                              onClick={() => {
                                setEditingDoc(name);
                                setEditContent(content || "");
                              }}
                            >
                              编辑
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Baseline Section */}
        {activeSection === "baseline" && baseline && (
          <div className="mx-auto max-w-4xl px-8 py-10">
            <div className="mb-6 flex items-center justify-between">
              <h2 className="text-xl font-semibold">基线文档</h2>
              <span className="text-sm text-muted-foreground">{baselineDocs.length} docs</span>
            </div>

            <div className="grid gap-2">
              {baselineDocs.map((doc) => (
                <div key={doc.name} className="rounded border">
                  <button
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm font-medium hover:bg-muted/50"
                    onClick={() => handleToggleBaselineDoc(doc.name)}
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{doc.title}</span>
                      <span className="block truncate font-mono text-xs text-muted-foreground">
                        {doc.name}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {doc.status === "present" ? `${doc.size} bytes` : "missing"}
                    </span>
                  </button>

                  {expandedBaselineDoc === doc.name && (
                    <div className="border-t px-3 py-2">
                      <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-xs">
                        {doc.content || "Loading..."}
                      </pre>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Git Section */}
        {activeSection === "git" && project && (
          <div className="mx-auto max-w-4xl space-y-6 px-8 py-10">
            <h2 className="text-xl font-semibold">Git</h2>
            <GitSetupPanel projectId={projectId} />
            <GitWorkspacePanel projectId={projectId} />
          </div>
        )}
      </main>
    </div>
  );
}
