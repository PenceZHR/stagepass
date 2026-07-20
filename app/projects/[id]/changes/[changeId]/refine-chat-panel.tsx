"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { EventItem } from "./change-event-types";
import { ProviderPicker } from "./provider-picker";
import type { AiProvider } from "./pipeline-action-contract";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

interface Requirement {
  id: string;
  category: "functional" | "non-functional" | "constraint";
  title: string;
  description: string;
  status: "confirmed" | "uncertain" | "new";
}

const CATEGORY_LABELS: Record<string, string> = {
  functional: "功能",
  "non-functional": "非功能",
  constraint: "约束",
};

const STATUS_BADGE: Record<string, string> = {
  confirmed: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  uncertain: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  new: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
};

export function RefineChatPanel({
  projectId,
  changeId,
  onSpecReady,
  selectedProvider,
  onProviderChange,
}: {
  projectId: string;
  changeId: string;
  onSpecReady: () => void;
  selectedProvider?: AiProvider;
  onProviderChange?: (provider: AiProvider) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [localProvider, setLocalProvider] = useState<AiProvider>("codex");
  const bottomRef = useRef<HTMLDivElement>(null);
  const provider = selectedProvider ?? localProvider;

  // Load existing chat history and requirements from events
  useEffect(() => {
    fetch(`/api/projects/${projectId}/changes/${changeId}/events`)
      .then((r) => r.json())
      .then((evts: EventItem[]) => {
        const chatMsgs: ChatMessage[] = evts
          .filter((e) => e.type === "chat_user" || e.type === "chat_assistant")
          .map((e) => ({
            role: e.type === "chat_user" ? "user" : "assistant",
            content: e.type === "chat_assistant" && e.rawJson
              ? JSON.parse(e.rawJson).fullReply || e.message || ""
              : e.message || "",
            createdAt: e.createdAt,
          }));
        setMessages(chatMsgs);

        // Get latest requirements from last assistant message
        const asstEvents = evts.filter((e) => e.type === "chat_assistant" && e.rawJson);
        if (asstEvents.length > 0) {
          const last = asstEvents[asstEvents.length - 1];
          try {
            const parsed = JSON.parse(last.rawJson ?? "{}");
            if (parsed.requirements?.length) {
              setRequirements(parsed.requirements);
            }
          } catch { /* ignore */ }
        }
      });
  }, [projectId, changeId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = async () => {
    if (!input.trim() || sending) return;
    const userMsg = input.trim();
    setInput("");
    setSending(true);

    setMessages((prev) => [...prev, { role: "user", content: userMsg, createdAt: new Date().toISOString() }]);

    try {
      const res = await fetch(`/api/projects/${projectId}/changes/${changeId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMsg, provider }),
      });
      if (res.ok) {
        const data = await res.json();
        setMessages((prev) => [...prev, { role: "assistant", content: data.reply, createdAt: new Date().toISOString() }]);
        if (data.requirements?.length) {
          // Deduplicate by id, keeping the latest version
          const map = new Map<string, Requirement>();
          for (const r of data.requirements) map.set(r.id, r);
          setRequirements(Array.from(map.values()));
        }
      } else {
        const data = await res.json();
        setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${data.error}`, createdAt: new Date().toISOString() }]);
      }
    } catch (err) {
      setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${String(err)}`, createdAt: new Date().toISOString() }]);
    } finally {
      setSending(false);
    }
  };

  const confirmReqs = async () => {
    if (requirements.length === 0 || confirming) return;
    setConfirming(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/changes/${changeId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requirements }),
      });
      if (res.ok) {
        onSpecReady();
      } else {
        const data = await res.json();
        alert(`确认失败: ${data.error}`);
      }
    } catch (err) {
      alert(`确认失败: ${String(err)}`);
    } finally {
      setConfirming(false);
    }
  };

  const allConfirmed = requirements.length > 0 && requirements.every(r => r.status === "confirmed");

  return (
    <div className="grid h-full grid-cols-5 gap-4">
      {/* Left: Chat */}
      <div className="col-span-3 flex flex-col rounded-lg border">
        <div className="border-b px-4 py-3">
          <h3 className="font-medium">对话</h3>
          <p className="text-xs text-muted-foreground">描述你的想法，AI 会帮你梳理成结构化需求</p>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 && (
            <p className="text-sm text-muted-foreground">发送消息开始对话...</p>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                msg.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-muted text-foreground"
              }`}>
                {msg.content}
              </div>
            </div>
          ))}
          {sending && (
            <div className="flex justify-start">
              <div className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
                <span className="inline-block animate-pulse">思考中...</span>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
        <div className="border-t p-3">
          <div className="mb-2">
            <ProviderPicker
              value={provider}
              onChange={onProviderChange ?? setLocalProvider}
              disabled={sending}
              id="refine-provider-picker"
            />
          </div>
          <form onSubmit={(e) => { e.preventDefault(); sendMessage(); }} className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="描述你的想法，或回答 AI 的问题..."
              className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
              disabled={sending}
            />
            <Button type="submit" size="sm" disabled={sending || !input.trim()}>
              发送
            </Button>
          </form>
        </div>
      </div>

      {/* Right: Requirements */}
      <div className="col-span-2 flex flex-col rounded-lg border">
        <div className="border-b px-4 py-3">
          <h3 className="font-medium">需求列表</h3>
          <p className="text-xs text-muted-foreground">
            {requirements.length === 0
              ? "对话中提炼的需求会显示在这里"
              : `${requirements.filter(r => r.status === "confirmed").length}/${requirements.length} 已确认`}
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {requirements.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <p>开始对话后，AI 会在这里列出提炼的需求</p>
            </div>
          ) : (
            requirements.map((req) => (
              <div key={req.id} className="group relative rounded-md border p-3">
                <button
                  className="absolute right-2 top-2 hidden group-hover:block rounded p-0.5 text-muted-foreground hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
                  onClick={() => setRequirements((prev) => prev.filter((r) => r.id !== req.id))}
                  title="删除此需求"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-mono text-muted-foreground">{req.id}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_BADGE[req.status]}`}>
                    {req.status === "confirmed" ? "已确认" : req.status === "uncertain" ? "待确认" : "新增"}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {CATEGORY_LABELS[req.category] || req.category}
                  </span>
                </div>
                <p className="text-sm font-medium">{req.title}</p>
                <p className="text-xs text-muted-foreground mt-1">{req.description}</p>
              </div>
            ))
          )}
        </div>
        <div className="border-t p-3">
          <Button
            className="w-full"
            disabled={requirements.length === 0 || confirming}
            onClick={confirmReqs}
          >
            {confirming
              ? "生成 Spec 中..."
              : allConfirmed
                ? "确认需求，进入 Spec"
                : `确认需求 (${requirements.filter(r => r.status !== "confirmed").length} 项待确认)`}
          </Button>
          {!allConfirmed && requirements.length > 0 && (
            <p className="mt-2 text-center text-[10px] text-muted-foreground">
              有待确认条目时也可以直接确认
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
