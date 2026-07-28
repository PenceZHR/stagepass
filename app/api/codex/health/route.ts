import { NextResponse } from "next/server";

import { readCodexNativeFlags } from "@/server/config/codex-native-flags";
import { db } from "@/server/db";
import {
  codexFollowerStartAttempts,
  codexInteractions,
  codexThreadBindings,
  codexTurnExecutions,
} from "@/server/db/schema";
import {
  REQUIRED_APP_SERVER_SHELL_CAPABILITIES,
  REQUIRED_DESKTOP_FOLLOWER_CAPABILITIES,
  type CodexDesktopProbe,
} from "@/server/services/codex-desktop-bridge-types";
import { getProductionCodexDesktopBridge } from "@/server/services/codex-desktop-engine";
import { readMcpHostEvidence } from "@/mcp/supervisor";

export interface CodexHealthDependencies {
  flags: ReturnType<typeof readCodexNativeFlags>;
  probe(): Promise<CodexDesktopProbe>;
  hostEvidence: ReturnType<typeof readMcpHostEvidence>;
  now(): number;
}

function defaults(): CodexHealthDependencies {
  return {
    flags: readCodexNativeFlags(),
    probe: async () => (await getProductionCodexDesktopBridge()).probe(),
    hostEvidence: readMcpHostEvidence(),
    now: Date.now,
  };
}

function counts<T extends { status: string }>(
  rows: T[],
  statuses: readonly string[],
): Record<string, number> {
  return Object.fromEntries(
    statuses.map((status) => [
      status,
      rows.filter((row) => row.status === status).length,
    ]),
  );
}

export async function handleCodexHealth(
  dependencies: CodexHealthDependencies = defaults(),
): Promise<NextResponse> {
  const attempts = db.select().from(codexFollowerStartAttempts).all();
  const bindings = counts(
    db.select().from(codexThreadBindings).all(),
    ["ready", "running", "detached"],
  );
  const interactions = counts(
    db.select().from(codexInteractions).all(),
    ["pending", "expired", "failed"],
  );
  const executions = db.select().from(codexTurnExecutions).all();
  const ambiguous = attempts.filter((row) => row.state === "ambiguous");
  const lastResults = attempts
    .filter((row) =>
      row.lastResult === "no-client-found"
      || row.lastResult === "started"
      || row.lastResult === "ambiguous"
    )
    .sort((left, right) => right.preparedAt.localeCompare(left.preparedAt))
    .slice(0, 20)
    .map((row) => ({
      at: row.completedAt ?? row.dispatchedAt ?? row.preparedAt,
      result: row.lastResult as "no-client-found" | "started" | "ambiguous",
    }));

  let status: "ready" | "disabled" | "unavailable" | "unsupported" =
    dependencies.flags.desktopBridge ? "unavailable" : "disabled";
  let probe: CodexDesktopProbe | null = null;
  if (dependencies.flags.desktopBridge) {
    try {
      probe = await dependencies.probe();
      status = "ready";
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
      status = code.includes("unsupported") ? "unsupported" : "unavailable";
    }
  }

  return NextResponse.json({
    status,
    appServerVersion: probe?.appServerVersion ?? null,
    appServerProtocolFingerprint:
      probe?.appServerProtocolFingerprint ?? null,
    desktopClientVersion: probe?.desktopClientVersion ?? null,
    desktopFollowerProtocolFingerprint:
      probe?.desktopFollowerProtocolFingerprint ?? null,
    shellCapabilities: {
      required: [...REQUIRED_APP_SERVER_SHELL_CAPABILITIES],
      available: probe?.shellProtocolCapabilities ?? [],
    },
    followerCapabilities: {
      required: [...REQUIRED_DESKTOP_FOLLOWER_CAPABILITIES],
      available: probe?.followerProtocolCapabilities ?? [],
    },
    followerStart: {
      lastResults,
      readinessProbeSupported: false,
    },
    mcpHostEvidence: dependencies.hostEvidence,
    followerStartAttempts: {
      prepared: attempts.filter((row) => row.state === "prepared").length,
      dispatching: attempts.filter((row) => row.state === "dispatching").length,
      quarantined: attempts.filter((row) => row.state === "quarantined").length,
      oldestAmbiguousAgeMs: ambiguous.length === 0
        ? null
        : Math.max(
            0,
            dependencies.now() - Math.min(
              ...ambiguous.map((row) => Date.parse(row.preparedAt)),
            ),
          ),
    },
    turnObservation: {
      notYetVisible: executions.reduce(
        (total, row) => total + row.notYetVisibleCount,
        0,
      ),
      lastSemanticCursor: executions.length === 0
        ? null
        : Math.max(...executions.map((row) => row.lastObservationCursor)),
      invalidSnapshotCount:
        executions.filter((row) => row.status === "invalid_snapshot").length,
    },
    decisionRollout: {
      masterEnabled: dependencies.flags.codexDecisionSurfaceMaster,
      phases: dependencies.flags.codexDecisionPhases,
      errorCode: dependencies.flags.codexDecisionRolloutError,
    },
    bindings: {
      ready: bindings.ready,
      running: bindings.running,
      detached: bindings.detached,
    },
    interactions: {
      pending: interactions.pending,
      expired: interactions.expired,
      failed: interactions.failed,
    },
  });
}

export async function GET() {
  return handleCodexHealth();
}
