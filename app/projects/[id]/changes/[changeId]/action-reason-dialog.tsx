"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { severityTone, type ActionReasonContext } from "./action-reason-context";

export interface ActionReasonDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  required?: boolean;
  busy?: boolean;
  /**
   * Findings the human is ruling on, shown beside the textarea so the judgement
   * is not written blind. Domain-neutral on purpose: any call site can build one
   * (see action-reason-context.ts). Omit it — or pass an empty item list — and
   * the dialog renders exactly as it did before.
   */
  context?: ActionReasonContext | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string) => void | Promise<void>;
}

export function ActionReasonContextPanel({ context }: { context?: ActionReasonContext | null }) {
  if (!context || context.items.length === 0) return null;

  return (
    <section className="rounded-md border bg-muted/30" aria-label={context.heading}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-3 py-2">
        <p className="text-xs font-medium text-muted-foreground">{context.heading}</p>
        {context.summary && (
          <p className="text-[11px] text-muted-foreground">{context.summary}</p>
        )}
      </div>
      <ul className="max-h-56 space-y-2 overflow-y-auto overscroll-contain p-3">
        {context.items.map((item) => (
          <li key={item.id} className={cn("rounded-md border p-2", severityTone(item.severity))}>
            <div className="flex flex-wrap items-center gap-2">
              {item.severity && (
                <span className="rounded bg-background/70 px-1.5 py-0.5 text-[10px] font-semibold">
                  {item.severity}
                </span>
              )}
              {item.reference && (
                <span className="rounded bg-background/70 px-1.5 py-0.5 font-mono text-[10px]">
                  {item.reference}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm font-semibold">{item.title}</p>
            {item.detail && (
              <p className="mt-1 whitespace-pre-wrap text-xs leading-5 opacity-80">{item.detail}</p>
            )}
            {item.note && (
              <p className="mt-1 whitespace-pre-wrap text-xs leading-5 opacity-80">{item.note}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ActionReasonDialog({
  open,
  title,
  description,
  confirmLabel = "确认",
  required = false,
  busy = false,
  context,
  onOpenChange,
  onConfirm,
}: ActionReasonDialogProps) {
  const [reason, setReason] = useState("");
  const trimmedReason = reason.trim();
  const hasContext = Boolean(context && context.items.length > 0);
  const updateOpen = (nextOpen: boolean) => {
    if (!nextOpen) setReason("");
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (busy) return;
      updateOpen(nextOpen);
    }}>
      {/* With context the dialog gets taller, so cap it and let it scroll rather
          than spill past the popup on a short viewport. */}
      <DialogContent
        className={cn("sm:max-w-lg", hasContext && "max-h-[85vh] overflow-y-auto sm:max-w-2xl")}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <ActionReasonContextPanel context={context} />
        <textarea
          className="min-h-32 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          value={reason}
          disabled={busy}
          onChange={(event) => setReason(event.target.value)}
          aria-label={title}
        />
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => updateOpen(false)}>
            取消
          </Button>
          <Button
            type="button"
            disabled={busy || (required && !trimmedReason)}
            onClick={() => {
              const submittedReason = required ? trimmedReason : reason;
              setReason("");
              void onConfirm(submittedReason);
            }}
          >
            {busy ? "提交中..." : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
