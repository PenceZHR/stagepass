"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AiProvider,
  type PipelineActionContract,
} from "./pipeline-action-contract";
import {
  pipelineActionResultEffect,
  runPipelineAction,
  type PipelineActionRunResult,
} from "./pipeline-action-runner";

const POST_START_WATCH_MS = 12_000;
const POST_START_REFRESH_MS = 2_000;

export function usePipelineActions(input: {
  projectId: string;
  changeId: string;
  actions?: PipelineActionContract[];
  selectedProvider?: AiProvider;
  refresh: () => void | Promise<void>;
}) {
  const { projectId, changeId, actions, selectedProvider, refresh } = input;
  const [running, setRunning] = useState(false);
  const [actionError, setActionError] = useState("");
  const watchIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const watchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPostStartWatch = useCallback(() => {
    if (watchIntervalRef.current) {
      clearInterval(watchIntervalRef.current);
      watchIntervalRef.current = null;
    }
    if (watchTimeoutRef.current) {
      clearTimeout(watchTimeoutRef.current);
      watchTimeoutRef.current = null;
    }
  }, []);

  const startPostStartWatch = useCallback(() => {
    clearPostStartWatch();
    setRunning(true);
    void refresh();
    watchIntervalRef.current = setInterval(() => {
      void refresh();
    }, POST_START_REFRESH_MS);
    watchTimeoutRef.current = setTimeout(() => {
      clearPostStartWatch();
      setRunning(false);
      void refresh();
    }, POST_START_WATCH_MS);
  }, [clearPostStartWatch, refresh]);

  useEffect(() => clearPostStartWatch, [clearPostStartWatch]);

  const handleAction = useCallback(
    async (actionId: string, providerOrRetry?: AiProvider | boolean) => {
      const providerOverride = typeof providerOrRetry === "string" ? providerOrRetry : undefined;
      const retryAfterDrift = providerOrRetry !== false;

      let result: PipelineActionRunResult;
      try {
        result = await runPipelineAction({
          actionId,
          actions,
          provider: providerOverride ?? selectedProvider,
          retryAfterDrift,
          // Marking the stage busy here rather than before the call keeps the
          // old semantics: an action rejected by its own contract never reached
          // the server, so it must not flash the buttons into a busy state.
          postAction: async (endpoint, payload) => {
            setRunning(true);
            setActionError("");
            const res = await fetch(
              `/api/projects/${projectId}/changes/${changeId}/${endpoint}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
              },
            );
            return { ok: res.ok, body: res.ok ? null : await res.json().catch(() => null) };
          },
        });
      } catch (err) {
        result = { outcome: "rejected", error: String(err) };
      }

      const effect = pipelineActionResultEffect(result);
      setActionError(effect.actionError);
      setRunning(effect.running);
      if (effect.startWatch) startPostStartWatch();
      if (effect.refresh) void refresh();
    },
    [projectId, changeId, actions, selectedProvider, refresh, startPostStartWatch],
  );

  return { running, actionError, handleAction };
}
