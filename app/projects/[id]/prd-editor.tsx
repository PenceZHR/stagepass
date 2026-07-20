"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ValidationIssue {
  field: string;
  severity: string;
  message: string;
}

interface PrdEditorProps {
  projectId: string;
  prdStatus: string;
  prdContent: string | null;
  chatHistory: Message[];
  structured: Record<string, unknown> | null;
  validation: { valid: boolean; issues: ValidationIssue[] } | null;
  provider: "codex" | "claude";
  onProviderChange: (provider: "codex" | "claude") => void;
  onConfirm: () => void;
  onStatusChange: () => void;
  onContentUpdate: (content: string | null, newMessages: Message[]) => void;
}

const PRD_TURN_SLOW_NOTICE_MS = 60_000;
const LOCAL_MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\((?:file:\/\/)?(?:\/Users|\/private|\/var)\/[^)]*\)/g;
const LOCAL_ABSOLUTE_PATH_PATTERN = /(?:file:\/\/)?(?:\/Users|\/private|\/var)\/[^\s)\]}>"'`]+/g;

function sanitizePrdAssistantMessage(content: string): string {
  return content
    .replace(LOCAL_MARKDOWN_LINK_PATTERN, "$1（路径已隐藏）")
    .replace(LOCAL_ABSOLUTE_PATH_PATTERN, "[已隐藏路径]");
}

export function PrdEditor({
  projectId,
  prdStatus,
  prdContent,
  chatHistory,
  structured,
  validation,
  provider,
  onProviderChange,
  onConfirm,
  onStatusChange,
  onContentUpdate,
}: PrdEditorProps) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [slowNotice, setSlowNotice] = useState(false);
  const [localMessages, setLocalMessages] = useState<Message[]>([]);
  const [upgrading, setUpgrading] = useState(false);
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  const [activeTab, setActiveTab] = useState<"chat" | "preview">("chat");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const messages = [...chatHistory, ...localMessages];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function handleStart() {
    setLoading(true);
    try {
      await fetch(`/api/projects/${projectId}/prd`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", provider, saveAsDefault }),
      });
      onStatusChange();
    } finally {
      setLoading(false);
    }
  }

  async function handleSend() {
    if (!input.trim() || loading) return;
    const userMsg = input.trim();
    setInput("");
    setLocalMessages((prev) => [...prev, { role: "user", content: userMsg }]);
    setLoading(true);
    setSlowNotice(false);

    const slowNoticeId = setTimeout(() => setSlowNotice(true), PRD_TURN_SLOW_NOTICE_MS);

    try {
      const res = await fetch(`/api/projects/${projectId}/prd`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "turn", message: userMsg, provider, saveAsDefault }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        const message = typeof data.error === "string" && data.error.trim()
          ? data.error
          : "PRD 生成失败，请稍后重试。";
        setLocalMessages((prev) => [...prev, { role: "assistant", content: `错误: ${message}` }]);
      } else {
        setLocalMessages((prev) => [...prev, { role: "assistant", content: data.assistantMessage }]);
        onContentUpdate(data.prdContent || prdContent, [
          { role: "user", content: userMsg },
          { role: "assistant", content: data.assistantMessage },
        ]);
      }
    } catch {
      setLocalMessages((prev) => [...prev, { role: "assistant", content: "请求失败，请重试" }]);
    } finally {
      clearTimeout(slowNoticeId);
      setSlowNotice(false);
      onStatusChange();
      setLoading(false);
    }
  }

  async function handleConfirm() {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/prd/confirm`, { method: "POST" });
      const data = await res.json();
      if (data.error) {
        setLocalMessages((prev) => [...prev, { role: "assistant", content: `确认失败: ${data.error}` }]);
      } else if (data.ok === false && data.validation) {
        const issues = data.validation.issues as ValidationIssue[];
        const msg = "PRD 校验未通过：\n" + issues.map((i) => `- [${i.severity}] ${i.message}`).join("\n");
        setLocalMessages((prev) => [...prev, { role: "assistant", content: msg }]);
      } else {
        setLocalMessages([]);
        onConfirm();
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleStartRevision() {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/prd/revise`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, saveAsDefault }),
      });
      const data = await res.json();
      if (data.error) {
        setLocalMessages((prev) => [...prev, { role: "assistant", content: `启动修改失败: ${data.error}` }]);
      } else {
        setLocalMessages([]);
        onStatusChange();
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleUpgrade() {
    setUpgrading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/prd/upgrade`, { method: "POST" });
      const data = await res.json();
      if (data.error) {
        alert(`升级失败: ${data.error}`);
      } else {
        onStatusChange();
      }
    } finally {
      setUpgrading(false);
    }
  }

  // --- Status: none ---
  if (prdStatus === "none") {
    return (
      <div className="rounded-lg border p-6 text-center">
        <p className="mb-4 text-muted-foreground">项目需要先完成 PRD（产品需求文档）才能创建 Change</p>
        <ProviderSelect provider={provider} onProviderChange={onProviderChange} disabled={loading} />
        <label className="my-3 inline-flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={saveAsDefault} onChange={(event) => setSaveAsDefault(event.target.checked)} disabled={loading} />
          记为项目默认 Provider
        </label>
        <Button onClick={handleStart} disabled={loading}>
          {loading ? "启动中..." : "开始编写 PRD"}
        </Button>
      </div>
    );
  }

  // --- Status: ready ---
  if (prdStatus === "ready") {
    return (
      <div className="flex h-full flex-col rounded-lg border">
        <div className="flex items-center justify-between border-b p-4">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium">PRD（已确认）</h3>
            {structured && (
              <span className="inline-flex items-center rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-700 dark:bg-green-900 dark:text-green-200">
                结构化
              </span>
            )}
            {!structured && prdContent && (
              <Button variant="outline" size="sm" onClick={handleUpgrade} disabled={upgrading}>
                {upgrading ? "升级中..." : "升级为结构化 PRD"}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <ProviderSelect provider={provider} onProviderChange={onProviderChange} disabled={loading} />
            <label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <input type="checkbox" checked={saveAsDefault} onChange={(event) => setSaveAsDefault(event.target.checked)} disabled={loading} />
              记为默认
            </label>
            <Button variant="outline" size="sm" onClick={handleStartRevision} disabled={loading}>
              编辑 PRD
            </Button>
          </div>
        </div>

        {validation && !validation.valid && (
          <div className="border-b bg-yellow-50 p-3 text-xs dark:bg-yellow-900/20">
            <p className="font-medium text-yellow-800 dark:text-yellow-200">校验问题：</p>
            <ul className="mt-1 list-disc pl-4">
              {validation.issues.map((issue, i) => (
                <li key={i} className={issue.severity === "error" ? "text-red-600" : "text-yellow-700"}>
                  {issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex-1 overflow-auto p-4">
          {prdContent ? (
            <pre className="whitespace-pre-wrap text-xs">{prdContent}</pre>
          ) : (
            <p className="text-sm text-muted-foreground">（无内容）</p>
          )}
        </div>
      </div>
    );
  }

  // --- Status: failed ---
  if (prdStatus === "failed") {
    return (
      <div className="flex h-full flex-col rounded-lg border">
        <div className="flex items-center justify-between border-b p-3">
          <div>
            <h3 className="text-sm font-medium">PRD 生成失败</h3>
            <p className="mt-1 text-xs text-muted-foreground">上次失败后可继续发送消息重试，已保存的草稿仍可预览。</p>
          </div>
          <div className="flex items-center gap-2">
            <ProviderSelect provider={provider} onProviderChange={onProviderChange} disabled={loading} />
            <label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <input type="checkbox" checked={saveAsDefault} onChange={(event) => setSaveAsDefault(event.target.checked)} disabled={loading} />
              记为默认
            </label>
            <button
              className={`rounded px-2 py-1 text-xs ${activeTab === "chat" ? "bg-primary text-primary-foreground" : "bg-muted"}`}
              onClick={() => setActiveTab("chat")}
            >
              对话
            </button>
            <button
              className={`rounded px-2 py-1 text-xs ${activeTab === "preview" ? "bg-primary text-primary-foreground" : "bg-muted"}`}
              onClick={() => setActiveTab("preview")}
            >
              预览
            </button>
          </div>
        </div>

        <div className="border-b bg-red-50 p-3 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-200">
          上次 PRD 生成没有完成。请补充要求或直接重试。
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-2">
          <div className={`flex min-h-0 flex-col overflow-hidden border-r ${activeTab === "preview" ? "hidden md:flex" : ""}`}>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              {messages.map((msg, i) => (
                <div key={i} className={`text-sm ${msg.role === "user" ? "text-right" : "text-left"}`}>
                  <span className={`inline-block max-w-[90%] whitespace-pre-wrap rounded-lg px-3 py-2 ${
                    msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"
                  }`}>
                    {msg.role === "assistant" ? sanitizePrdAssistantMessage(msg.content) : msg.content}
                  </span>
                </div>
              ))}
              {loading && (
                <div className="text-left text-sm">
                  <span className="inline-block rounded-lg bg-muted px-3 py-2 text-muted-foreground">
                    {slowNotice ? "仍在生成 PRD，后台可能需要一两分钟..." : "思考中..."}
                  </span>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            <div className="flex gap-2 border-t p-3">
              <input
                className="flex-1 rounded border px-3 py-1.5 text-sm"
                placeholder="输入消息..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
                disabled={loading}
              />
              <Button size="sm" onClick={handleSend} disabled={loading || !input.trim()}>
                发送
              </Button>
            </div>
          </div>

          <div className={`flex min-h-0 flex-col overflow-hidden ${activeTab === "chat" ? "hidden md:flex" : ""}`}>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {prdContent ? (
                <pre className="whitespace-pre-wrap text-xs">{prdContent}</pre>
              ) : (
                <p className="text-sm text-muted-foreground">暂无可预览的 PRD 草稿</p>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // --- Status: drafting / revising (split-pane) ---
  return (
    <div className="flex h-full flex-col rounded-lg border">
      <div className="flex items-center justify-between border-b p-3">
        <h3 className="text-sm font-medium">
          {prdStatus === "drafting" ? "PRD 编写" : "PRD 修改"}
        </h3>
        <div className="flex items-center gap-2">
          <ProviderSelect provider={provider} onProviderChange={onProviderChange} disabled={loading} />
          <label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <input type="checkbox" checked={saveAsDefault} onChange={(event) => setSaveAsDefault(event.target.checked)} disabled={loading} />
            记为默认
          </label>
          <button
            className={`rounded px-2 py-1 text-xs ${activeTab === "chat" ? "bg-primary text-primary-foreground" : "bg-muted"}`}
            onClick={() => setActiveTab("chat")}
          >
            对话
          </button>
          <button
            className={`rounded px-2 py-1 text-xs ${activeTab === "preview" ? "bg-primary text-primary-foreground" : "bg-muted"}`}
            onClick={() => setActiveTab("preview")}
          >
            预览
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-2">
        {/* Left: Chat panel */}
        <div className={`flex min-h-0 flex-col overflow-hidden border-r ${activeTab === "preview" ? "hidden md:flex" : ""}`}>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            {messages.map((msg, i) => (
              <div key={i} className={`text-sm ${msg.role === "user" ? "text-right" : "text-left"}`}>
                <span className={`inline-block max-w-[90%] whitespace-pre-wrap rounded-lg px-3 py-2 ${
                  msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"
                }`}>
                  {msg.role === "assistant" ? sanitizePrdAssistantMessage(msg.content) : msg.content}
                </span>
              </div>
            ))}
            {loading && (
              <div className="text-left text-sm">
                <span className="inline-block rounded-lg bg-muted px-3 py-2 text-muted-foreground">
                  {slowNotice ? "仍在生成 PRD，后台可能需要一两分钟..." : "思考中..."}
                </span>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="flex gap-2 border-t p-3">
            <input
              className="flex-1 rounded border px-3 py-1.5 text-sm"
              placeholder="输入消息..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
              disabled={loading}
            />
            <Button size="sm" onClick={handleSend} disabled={loading || !input.trim()}>
              发送
            </Button>
          </div>
        </div>

        {/* Right: Preview panel */}
        <div className={`flex min-h-0 flex-col overflow-hidden ${activeTab === "chat" ? "hidden md:flex" : ""}`}>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {prdContent ? (
              <pre className="whitespace-pre-wrap text-xs">{prdContent}</pre>
            ) : (
              <p className="text-sm text-muted-foreground">PRD 内容将在对话后自动生成</p>
            )}
          </div>

          {validation && !validation.valid && (
            <div className="border-t p-3">
              <p className="text-xs font-medium text-yellow-800 dark:text-yellow-200">校验问题：</p>
              <ul className="mt-1 list-disc pl-4 text-xs">
                {validation.issues.map((issue, i) => (
                  <li key={i} className={issue.severity === "error" ? "text-red-600" : "text-yellow-700"}>
                    {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-end gap-2 border-t p-3">
        <Button size="sm" variant="outline" onClick={handleConfirm} disabled={loading || !prdContent}>
          确认 PRD
        </Button>
      </div>
    </div>
  );
}

function ProviderSelect({
  provider,
  onProviderChange,
  disabled,
}: {
  provider: "codex" | "claude";
  onProviderChange: (provider: "codex" | "claude") => void;
  disabled?: boolean;
}) {
  return (
    <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      引擎
      <select
        value={provider}
        onChange={(e) => onProviderChange(e.target.value as "codex" | "claude")}
        disabled={disabled}
        className="h-8 rounded-md border bg-background px-2 text-xs text-foreground"
      >
        <option value="codex">Codex</option>
        <option value="claude">Claude Code</option>
      </select>
    </label>
  );
}
