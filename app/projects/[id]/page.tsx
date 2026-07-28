"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CreateChangeDialog } from "./create-change-dialog";
import { PrdEditor } from "./prd-editor";

interface Project {
  id: string;
  name: string;
  repoPath: string;
  contextStatus?: string;
  prdStatus?: string;
}

interface Change {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface ContextProgress {
  stage: string;
  percent: number;
  currentFile?: string;
  message: string;
}

interface ContextData {
  contextStatus: string;
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
  if (["PLAN_APPROVED", "PLAN_READY", "INTAKE_READY", "SPEC_READY", "TECHSPEC_READY"].includes(status)) return "info";
  // DELIVERY_PENDING pairs with RETRO_PENDING: both mean "the pipeline is
  // parked waiting for a human to press a button", so they must read the same.
  if (["PLANNING", "IMPLEMENTING", "SPECCING", "TECHSPECCING", "TESTPLANNING", "MERGING", "RETRO_PENDING", "DELIVERY_PENDING"].includes(status)) return "default";
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

type NavSection = "changes" | "prd" | "context" | "baseline";

const NAV_ITEMS: { key: NavSection; label: string; icon: string }[] = [
  { key: "changes", label: "Changes", icon: "01" },
  { key: "prd", label: "PRD", icon: "02" },
  { key: "context", label: "上下文", icon: "03" },
  { key: "baseline", label: "基线文档", icon: "04" },
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
  const [prdStructured, setPrdStructured] = useState<Record<string, unknown> | null>(null);
  const [prdValidation, setPrdValidation] = useState<{ valid: boolean; issues: Array<{ field: string; severity: string; message: string }> } | null>(null);
  const [prdCodexThreadId, setPrdCodexThreadId] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<NavSection>("changes");

  const loadProject = useCallback(() => {
    fetch(`/api/projects/${projectId}`).then((r) => r.json()).then((data) => {
      setProject(data);
      setPrdStatus(data.prdStatus || "none");
    });
  }, [projectId]);

  const loadChanges = useCallback(() => {
    fetch(`/api/projects/${projectId}/changes`).then((r) => r.json()).then(setChanges);
  }, [projectId]);

  const loadContext = useCallback(() => {
    fetch(`/api/projects/${projectId}/context`).then((r) => r.json()).then((data) => {
      setContext(data);
    });
  }, [projectId]);

  const loadBaseline = useCallback(() => {
    fetch(`/api/projects/${projectId}/baseline`).then((r) => r.json()).then(setBaseline);
  }, [projectId]);

  const loadPrd = useCallback(() => {
    fetch(`/api/projects/${projectId}/prd`).then((r) => r.json()).then((data) => {
      setPrdStatus(data.status || "none");
      setPrdContent(data.content || null);
      setPrdStructured(data.structured || null);
      setPrdValidation(data.validation || null);
      setPrdCodexThreadId(data.codexThreadId || null);
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
      body: JSON.stringify({}),
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
    <div className="stagepass-page flex min-h-screen flex-col lg:h-screen lg:flex-row">
      {/* Sidebar */}
      <aside className="stagepass-surface-subtle z-10 flex w-full flex-col border-b border-white/10 lg:w-64 lg:shrink-0 lg:border-b-0 lg:border-r">
        <div className="border-b border-white/10 p-5">
          <Link href="/projects" className="stagepass-wordmark">
            stagepass
          </Link>
          {project && (
            <div className="mt-7">
              <p className="stagepass-kicker">Current project</p>
              <h1 className="stagepass-serif mt-2 truncate text-xl">{project.name}</h1>
              <p className="mt-1 truncate font-mono text-[0.68rem] text-primary/75">{project.id}</p>
            </div>
          )}
        </div>

        <nav className="flex gap-1 overflow-x-auto p-2 lg:flex-1 lg:flex-col lg:p-3" aria-label="Project sections">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              onClick={() => setActiveSection(item.key)}
              className={`flex min-h-11 shrink-0 items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors lg:w-full ${
                activeSection === item.key
                  ? "bg-primary/14 text-primary ring-1 ring-primary/25"
                  : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
              }`}
            >
              <span className="font-mono text-[0.62rem] opacity-70">{item.icon}</span>
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
          <div className="hidden border-t border-white/10 p-4 lg:block">
            <p className="truncate text-[0.68rem] text-muted-foreground" title={project.repoPath}>
              {project.repoPath}
            </p>
            <Link href="/projects" className="mt-3 inline-block text-xs text-primary/80 hover:text-primary">
              ← All projects
            </Link>
          </div>
        )}
      </aside>

      {/* Main content */}
      <main className="min-w-0 flex-1 overflow-y-auto">
        {/* Changes Section */}
        {activeSection === "changes" && (
          <div className="mx-auto max-w-5xl px-5 py-10 sm:px-8 lg:py-14">
            <div className="mb-8 flex items-end justify-between gap-4">
              <div>
                <p className="stagepass-kicker">Gate archive</p>
                <h2 className="stagepass-serif mt-2 text-3xl">Changes</h2>
              </div>
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
              <div className="stagepass-surface rounded-xl border-l-2 border-l-primary p-5 text-sm">
                <h3 className="font-medium">先完成项目 PRD</h3>
                <p className="mt-1 text-muted-foreground">
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
              <div className="stagepass-surface rounded-xl px-6 py-14 text-center">
                <p className="stagepass-serif text-xl">No changes found</p>
                <p className="mt-2 text-sm text-muted-foreground">Create a Change to begin its gate orbit.</p>
              </div>
            ) : (
              <div className="stagepass-surface divide-y divide-white/10 overflow-hidden rounded-2xl">
                {changes.map((c) => (
                  <Link key={c.id} href={`/projects/${projectId}/changes/${c.id}`}>
                    <Card className="group rounded-none border-0 bg-transparent shadow-none transition-colors hover:bg-white/[0.045]">
                      <CardHeader className="py-4">
                        <CardTitle className="flex items-center gap-3 text-base">
                          <span className="font-mono text-xs text-primary/70">
                            {c.id}
                          </span>
                          <span className="stagepass-serif text-lg font-normal">{c.title}</span>
                          {!RUNNING_STATES.has(c.status) && (
                            <button
                              className="ml-2 inline-flex items-center gap-1 rounded border border-destructive/25 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
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
          <div className="flex min-h-[calc(100vh-8rem)] flex-col px-5 pb-4 pt-8 sm:px-8 lg:h-[calc(100vh-2rem)]">
            <div className="mb-5 shrink-0">
              <p className="stagepass-kicker">Product boundary</p>
              <h2 className="stagepass-serif mt-2 text-3xl">PRD</h2>
            </div>
            <div className="relative min-h-0 flex-1">
              <div className="absolute inset-0">
              <PrdEditor
              prdStatus={prdStatus}
              prdContent={prdContent}
              structured={prdStructured}
              validation={prdValidation}
              codexThreadId={prdCodexThreadId}
            />
              </div>
            </div>
          </div>
        )}

        {/* Context Section */}
        {activeSection === "context" && context && (
          <div className="mx-auto max-w-5xl px-5 py-10 sm:px-8 lg:py-14">
            <div className="mb-6 flex items-center justify-between">
              <div>
                <p className="stagepass-kicker">Repository evidence</p>
                <h2 className="stagepass-serif mt-2 text-3xl">项目上下文</h2>
              </div>
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
          <div className="mx-auto max-w-5xl px-5 py-10 sm:px-8 lg:py-14">
            <div className="mb-6 flex items-center justify-between">
              <div>
                <p className="stagepass-kicker">Project memory</p>
                <h2 className="stagepass-serif mt-2 text-3xl">基线文档</h2>
              </div>
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

      </main>
    </div>
  );
}
