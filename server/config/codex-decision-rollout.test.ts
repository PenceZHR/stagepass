import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { describe, it } from "node:test";

import {
  CODEX_DECISION_INTERACTION_KINDS,
  CODEX_DECISION_PHASES,
  INTERACTION_KIND_ALLOWED_PHASES,
  assertCompleteCodexDecisionRollout,
  isCodexDecisionSurfaceEnabled,
  parseCodexDecisionPhases,
} from "./codex-decision-rollout";
import { readCodexNativeFlags } from "./codex-native-flags";

const REPOSITORY_ROOT = resolve(__dirname, "../..");
const ROLLOUT_ENV_KEYS = [
  "STAGEPASS_CODEX_DESKTOP_BRIDGE",
  "STAGEPASS_MCP_INTERACTIONS",
  "STAGEPASS_CODEX_DECISION_SURFACE",
  "STAGEPASS_CODEX_DECISION_PHASES",
] as const;

interface SourceFixture {
  path: string;
  source: string;
}

const EXCLUDED_SOURCE_DIRECTORIES = new Set([
  ".agents",
  ".git",
  ".generated",
  ".next",
  ".stagepass",
  ".temp",
  ".tmp",
  ".turbo",
  "__fixtures__",
  "__tests__",
  "build",
  "coverage",
  "dist",
  "docs",
  "fixtures",
  "generated",
  "node_modules",
  "out",
  "plugins",
  "spikes",
  "temp",
  "temporary",
  "test",
  "tests",
  "tmp",
]);

function isProductionSourcePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  const fileName = segments.at(-1) ?? "";
  return (
    !segments
      .slice(0, -1)
      .some((segment) => EXCLUDED_SOURCE_DIRECTORIES.has(segment)) &&
    [".ts", ".tsx", ".mts", ".cts"].includes(extname(fileName)) &&
    !fileName.endsWith(".d.ts") &&
    !/\.(?:test|spec|generated|gen|temp|tmp)\.[cm]?tsx?$/.test(fileName)
  );
}

function rolloutEnvInventoryFromSources(
  sources: SourceFixture[],
): Record<string, string[]> {
  const inventory = Object.fromEntries(
    ROLLOUT_ENV_KEYS.map((key) => [key, [] as string[]]),
  );
  for (const fixture of sources) {
    if (!isProductionSourcePath(fixture.path)) {
      continue;
    }
    for (const key of ROLLOUT_ENV_KEYS) {
      if (fixture.source.includes(key)) {
        inventory[key].push(fixture.path);
      }
    }
  }
  return inventory;
}

function productionSourceFiles(
  directory: string,
  relativeDirectory = "",
): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    const relativePath = join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_SOURCE_DIRECTORIES.has(entry.name)) {
        return [];
      }
      return productionSourceFiles(path, relativePath);
    }
    if (!entry.isFile() || !isProductionSourcePath(relativePath)) {
      return [];
    }
    return [path];
  });
}

function rolloutEnvInventory(): Record<string, string[]> {
  const sources = productionSourceFiles(REPOSITORY_ROOT).map((file) => ({
    path: relative(REPOSITORY_ROOT, file),
    source: readFileSync(file, "utf8"),
  }));
  return rolloutEnvInventoryFromSources(sources);
}

describe("Codex decision rollout", () => {
  it("requires the master and the exact complete eleven-phase release set", () => {
    const complete = {
      STAGEPASS_CODEX_DECISION_SURFACE: "on",
      STAGEPASS_CODEX_DECISION_PHASES: CODEX_DECISION_PHASES.join(","),
    };
    assert.deepEqual(
      assertCompleteCodexDecisionRollout(complete).phases,
      CODEX_DECISION_PHASES,
    );

    for (const removed of CODEX_DECISION_PHASES) {
      assert.throws(
        () => assertCompleteCodexDecisionRollout({
          ...complete,
          STAGEPASS_CODEX_DECISION_PHASES: CODEX_DECISION_PHASES
            .filter((phase) => phase !== removed)
            .join(","),
        }),
        (error: unknown) =>
          (error as { code?: string }).code
            === "codex_decision_rollout_incomplete",
      );
    }
    for (const phases of ["", "PRD,,Spec", "PRD,Unknown", undefined]) {
      assert.throws(
        () => assertCompleteCodexDecisionRollout({
          STAGEPASS_CODEX_DECISION_SURFACE: "on",
          ...(phases === undefined
            ? {}
            : { STAGEPASS_CODEX_DECISION_PHASES: phases }),
        }),
        /codex_decision_rollout_incomplete/,
      );
    }
    assert.throws(
      () => assertCompleteCodexDecisionRollout({
        STAGEPASS_CODEX_DECISION_PHASES: CODEX_DECISION_PHASES.join(","),
      }),
      /codex_decision_rollout_incomplete/,
    );
  });

  it("parses the exact phase set, trimming and deduplicating valid tokens", () => {
    assert.deepEqual(parseCodexDecisionPhases(undefined), {
      phases: [],
      errorCode: null,
    });
    assert.deepEqual(
      parseCodexDecisionPhases(" PRD, Intake,PRD, Merge "),
      {
        phases: ["PRD", "Intake", "Merge"],
        errorCode: null,
      },
    );
    assert.deepEqual(
      parseCodexDecisionPhases(
        "PRD,Intake,Spec,TechSpec,Plan,TestPlan,Build,Fix,Review,QA,Merge",
      ),
      {
        phases: CODEX_DECISION_PHASES,
        errorCode: null,
      },
    );
  });

  it("fails closed on blank, empty, or unknown phase tokens", () => {
    for (const value of ["", " ", "PRD,,Spec", ",PRD", "PRD,", "PRD,Unknown"]) {
      assert.deepEqual(parseCodexDecisionPhases(value), {
        phases: [],
        errorCode: "codex_decision_rollout_invalid",
      });
    }
  });

  it("requires the master and an allowlisted phase", () => {
    const partial = readCodexNativeFlags({
      STAGEPASS_CODEX_DECISION_SURFACE: "on",
      STAGEPASS_CODEX_DECISION_PHASES: "PRD,Intake",
    });
    assert.equal(isCodexDecisionSurfaceEnabled("PRD", partial), true);
    assert.equal(
      isCodexDecisionSurfaceEnabled(
        { phase: "PRD", kind: "prd_question" },
        partial,
      ),
      true,
    );
    assert.equal(isCodexDecisionSurfaceEnabled("Spec", partial), false);
    assert.equal(
      isCodexDecisionSurfaceEnabled(
        { phase: "Intake", kind: "prd_question" },
        partial,
      ),
      false,
    );
    assert.equal(
      isCodexDecisionSurfaceEnabled("PRD", {
        ...partial,
        codexDecisionSurfaceMaster: false,
      }),
      false,
    );
  });

  it("fails closed when rollout configuration is invalid", () => {
    const invalid = readCodexNativeFlags({
      STAGEPASS_CODEX_DECISION_SURFACE: "on",
      STAGEPASS_CODEX_DECISION_PHASES: "PRD,,Spec",
    });
    assert.deepEqual(invalid.codexDecisionPhases, []);
    assert.equal(
      invalid.codexDecisionRolloutError,
      "codex_decision_rollout_invalid",
    );
    assert.equal(isCodexDecisionSurfaceEnabled("PRD", invalid), false);
  });

  it("defines the sole exhaustive interaction-kind registry", () => {
    assert.deepEqual(CODEX_DECISION_INTERACTION_KINDS, [
      "prd_question",
      "prd_lock",
      "gate_decision",
      "risk_waiver",
      "build_adoption",
      "review_resolution",
      "merge_decision",
    ]);
    assert.deepEqual(Object.keys(INTERACTION_KIND_ALLOWED_PHASES).sort(), [
      ...CODEX_DECISION_INTERACTION_KINDS,
    ].sort());
    assert.deepEqual(INTERACTION_KIND_ALLOWED_PHASES, {
      prd_question: ["PRD"],
      prd_lock: ["PRD"],
      gate_decision: ["Intake", "Spec", "TechSpec", "TestPlan", "QA"],
      risk_waiver: ["Plan"],
      build_adoption: ["Build", "Fix"],
      review_resolution: ["Review"],
      merge_decision: ["Merge"],
    });
  });

  it("rejects runtime-invalid phases, kinds, and kind-phase pairs", () => {
    const allOn = readCodexNativeFlags({
      STAGEPASS_CODEX_DECISION_SURFACE: "on",
      STAGEPASS_CODEX_DECISION_PHASES: CODEX_DECISION_PHASES.join(","),
    });
    assert.equal(
      isCodexDecisionSurfaceEnabled("Unknown" as never, allOn),
      false,
    );
    assert.equal(
      isCodexDecisionSurfaceEnabled(
        { phase: "PRD", kind: "unknown_kind" } as never,
        allOn,
      ),
      false,
    );
    assert.equal(
      isCodexDecisionSurfaceEnabled(
        { phase: "Merge", kind: "prd_lock" },
        allOn,
      ),
      false,
    );
  });

  it("detects rollout env reads in every production source location", () => {
    const envRead = "process.env.STAGEPASS_CODEX_DESKTOP_BRIDGE";
    assert.deepEqual(
      rolloutEnvInventoryFromSources([
        { path: "components/reader.tsx", source: envRead },
        { path: "lib/reader.ts", source: envRead },
        { path: "root-reader.mts", source: envRead },
      ]).STAGEPASS_CODEX_DESKTOP_BRIDGE,
      ["components/reader.tsx", "lib/reader.ts", "root-reader.mts"],
    );
  });

  it("excludes dependencies, generated output, plugins, and test sources", () => {
    const envRead = "process.env.STAGEPASS_CODEX_DESKTOP_BRIDGE";
    const excludedPaths = [
      "node_modules/package/reader.ts",
      ".git/hooks/reader.ts",
      ".next/types/reader.ts",
      "coverage/reader.ts",
      "dist/reader.ts",
      "build/reader.ts",
      ".agents/reader.ts",
      "plugins/example/reader.ts",
      "tests/reader.ts",
      "server/__tests__/reader.ts",
      "server/fixtures/reader.ts",
      "generated/reader.ts",
      "tmp/reader.ts",
      ".temp/reader.ts",
      "server/reader.test.ts",
      "server/reader.spec.tsx",
      "server/reader.generated.mts",
      "next-env.d.ts",
    ];
    assert.deepEqual(
      rolloutEnvInventoryFromSources(
        excludedPaths.map((path) => ({ path, source: envRead })),
      ).STAGEPASS_CODEX_DESKTOP_BRIDGE,
      [],
    );
  });

  it("centralizes every production rollout environment read", () => {
    assert.deepEqual(rolloutEnvInventory(), {
      STAGEPASS_CODEX_DESKTOP_BRIDGE: [
        "server/config/codex-native-flags.ts",
      ],
      STAGEPASS_MCP_INTERACTIONS: [
        "server/config/codex-native-flags.ts",
      ],
      STAGEPASS_CODEX_DECISION_SURFACE: [
        "server/config/codex-decision-rollout.ts",
      ],
      STAGEPASS_CODEX_DECISION_PHASES: [
        "server/config/codex-decision-rollout.ts",
      ],
    });
  });
});
