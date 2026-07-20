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

export interface ActionReasonDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  required?: boolean;
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string) => void | Promise<void>;
}

export function ActionReasonDialog({
  open,
  title,
  description,
  confirmLabel = "确认",
  required = false,
  busy = false,
  onOpenChange,
  onConfirm,
}: ActionReasonDialogProps) {
  const [reason, setReason] = useState("");
  const trimmedReason = reason.trim();
  const updateOpen = (nextOpen: boolean) => {
    if (!nextOpen) setReason("");
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (busy) return;
      updateOpen(nextOpen);
    }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
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
