#!/usr/bin/env tsx
import fs from "node:fs";

const evidencePath =
  process.env.STAGEPASS_REAL_CODEX_NATIVE_E2E_EVIDENCE?.trim();

if (!evidencePath) {
  console.error(
    "CODEX-NATIVE E2E SKIP: STAGEPASS_REAL_CODEX_NATIVE_E2E_EVIDENCE is not set; no real-client result was claimed.",
  );
  process.exitCode = 2;
} else {
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as {
    realClient?: boolean;
    completedChange?: number;
    appServerManagedTurnStarts?: number;
    duplicateLogicalTurnDispatches?: number;
    protocolFingerprint?: string;
  };
  const valid =
    evidence.realClient === true
    && evidence.completedChange === 1
    && evidence.appServerManagedTurnStarts === 0
    && evidence.duplicateLogicalTurnDispatches === 0
    && typeof evidence.protocolFingerprint === "string"
    && evidence.protocolFingerprint.length > 0;
  if (!valid) {
    console.error(
      "CODEX-NATIVE E2E FAIL: supplied evidence is incomplete or not real-client attested.",
    );
    process.exitCode = 1;
  } else {
    console.log("CODEX-NATIVE E2E PASS");
    console.log(`protocol_fingerprint: ${evidence.protocolFingerprint}`);
    console.log("completed_change: 1");
    console.log("app_server_managed_turn_starts: 0");
    console.log("duplicate_logical_turn_dispatches: 0");
  }
}
