import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { resolveCodexStageThreadRoute } from "./provider-session-service";

const callerFiles = [
  "pipeline-prd-briefing-stage-service.ts",
  "pipeline-spec-stage-service.ts",
  "pipeline-document-stage-runner-service.ts",
  "pipeline-plan-stage-service.ts",
  "pipeline-build-stage-service.ts",
  "pipeline-review-stage-service.ts",
] as const;

describe("canonical Codex stage caller inventory", () => {
  it("routes all six stage callers through the canonical binding and logical id", () => {
    const sources = callerFiles.map((file) => ({
      file,
      text: fs.readFileSync(path.join(process.cwd(), "server/services", file), "utf8"),
    }));
    for (const source of sources) {
      assert.match(source.text, /resolveCanonicalChangeThread/, source.file);
      assert.match(source.text, /logicalTurnId/, source.file);
      assert.match(
        source.text,
        /resolveCodexStageThreadRoute\(\{/,
        `${source.file} must fail closed when the flag is on without a binding`,
      );
      assert.match(
        source.text,
        /const logicalTurnId = desktopBridgeEnabled\s+\?/,
        `${source.file} must resolve a logical id whenever the flag is on`,
      );
      assert.match(
        source.text,
        /threadId:\s*executableThreadId/,
        `${source.file} must not pass an executable thread id when the flag is on`,
      );
      assert.match(
        source.text,
        /resolveLegacyGeneralThread:\s*\(\) => resolveProviderSession\(\{[\s\S]*?provider:\s*"codex",[\s\S]*?sessionKind:\s*"general"/,
        `${source.file} must use only codex/general for rollback`,
      );
      assert.doesNotMatch(
        source.text,
        /sessionKind:\s*"(spec_writer|spec_critic|build|fix)"/,
        source.file,
      );
    }
    const all = sources.map((source) => source.text).join("\n");
    const spec = sources.find(
      (source) => source.file === "pipeline-spec-stage-service.ts",
    )!.text;
    assert.doesNotMatch(spec, /threadId:\s*latestSpecRetryThread/);
    assert.doesNotMatch(all, /runCorrelationId\s*:/);
    assert.doesNotMatch(
      all,
      /readCodexNativeFlags\(\)\.desktopBridge && canonicalThreadId/,
      "flag-on must not silently fall back when the canonical binding is missing",
    );
  });

  it("keeps binding lazy off, uses general rollback, and fails closed on", () => {
    let canonicalReads = 0;
    let legacyReads = 0;
    const offWithBinding = resolveCodexStageThreadRoute({
      desktopBridgeEnabled: false,
      resolveCanonicalThread: () => {
        canonicalReads += 1;
        return "canonical-shell";
      },
      resolveLegacyGeneralThread: () => {
        legacyReads += 1;
        return "legacy-general";
      },
    });
    assert.deepEqual(offWithBinding, {
      canonicalThreadId: null,
      executableThreadId: "legacy-general",
    });
    assert.equal(canonicalReads, 0);
    assert.equal(legacyReads, 1);

    const offWithoutBinding = resolveCodexStageThreadRoute({
      desktopBridgeEnabled: false,
      resolveCanonicalThread: () => {
        canonicalReads += 1;
        return null;
      },
      resolveLegacyGeneralThread: () => "legacy-general-2",
    });
    assert.equal(offWithoutBinding.executableThreadId, "legacy-general-2");
    assert.equal(canonicalReads, 0);

    assert.throws(
      () => resolveCodexStageThreadRoute({
        desktopBridgeEnabled: true,
        resolveCanonicalThread: () => null,
        resolveLegacyGeneralThread: () => {
          legacyReads += 1;
          return "must-not-run";
        },
      }),
      (error: unknown) =>
        (error as { code?: unknown }).code === "codex_binding_not_ready",
    );
    assert.deepEqual(resolveCodexStageThreadRoute({
      desktopBridgeEnabled: true,
      resolveCanonicalThread: () => "canonical-shell",
      resolveLegacyGeneralThread: () => {
        legacyReads += 1;
        return "must-not-run";
      },
    }), {
      canonicalThreadId: "canonical-shell",
      executableThreadId: undefined,
    });
    assert.equal(legacyReads, 1);
  });
});
