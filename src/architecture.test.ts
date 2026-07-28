import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The standing guards from the rebuild PRD, §9.3.
 *
 * These are not tests of behaviour. They are the rules that stop this tree from
 * becoming the one it replaces -- where an entire MCP App (1232 lines) and five
 * decision-card options sat in the codebase with nothing calling them, and
 * where nobody could tell by reading which parts were real.
 *
 * They are cheap to keep green while the tree is small. That is exactly why
 * they go in now rather than later.
 */

const SRC = join(process.cwd(), "src");

function sourceFiles(directory = SRC): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const FILES = sourceFiles().map((path) => ({
  path: relative(SRC, path).replaceAll("\\", "/"),
  text: readFileSync(path, "utf-8"),
}));

/**
 * Which layer each module belongs to.
 *
 * Declared rather than derived from the directory names, because the
 * directories say what a module IS (domain, store, work) and the layer says
 * when it was allowed to exist. Both are useful and they are not the same
 * question.
 */
const LAYER: Readonly<Record<string, 0 | 1 | 2>> = {
  "domain/phase.ts": 0,
  "domain/change-state.ts": 0,
  "db/schema.ts": 0,
  "store/change-store.ts": 0,

  "domain/gate.ts": 1,
  "domain/lease.ts": 1,
  "store/evidence-store.ts": 1,
  "store/command-store.ts": 1,
  "work/job-store.ts": 1,
  "work/turn-loop.ts": 1,

  "domain/turn.ts": 2,
  "store/binding-store.ts": 2,
  "store/turn-store.ts": 2,
  "codex/transport.ts": 2,
  "codex/turn-runner.ts": 2,
};

const production = FILES.filter((file) => !file.path.endsWith(".test.ts"));

describe("standing · every module declares its layer", () => {
  /**
   * A file that is in no layer is a file nobody decided the position of. That
   * is how a tree stops having an order at all.
   */
  it("has no unplaced production module", () => {
    const unplaced = production
      .map((file) => file.path)
      .filter((path) => !(path in LAYER));
    assert.deepEqual(unplaced, []);
  });

  it("declares no layer for a module that no longer exists", () => {
    const present = new Set(production.map((file) => file.path));
    const stale = Object.keys(LAYER).filter((path) => !present.has(path));
    assert.deepEqual(stale, []);
  });
});

describe("standing · layers depend downward only", () => {
  /**
   * L1 may build on L0. L0 may not reach up into L1 -- if it could, "L0 is
   * proved before L1 exists" would be untrue by construction, and the gating
   * discipline the whole rebuild rests on would be decorative.
   */
  it("never lets a lower layer import a higher one", () => {
    const violations: string[] = [];
    for (const file of production) {
      const layer = LAYER[file.path]!;
      for (const target of imports(file)) {
        const targetLayer = LAYER[target];
        if (targetLayer === undefined) continue;
        if (targetLayer > layer) {
          violations.push(`L${layer} ${file.path} -> L${targetLayer} ${target}`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });
});

describe("standing · nothing exists without a caller", () => {
  /**
   * The rule the old tree lacked. `mcp/` had zero production callers and lived
   * for months; `request_plan_changes` had a label, a contract entry and a
   * renderer, and no surface that could execute it.
   *
   * Scoped two ways, and both are stated rather than assumed:
   *
   * - Values only (const, function, class). An exported TYPE is usually named
   *   only where it is declared -- a caller passing `{changeId, action, ...}`
   *   never writes `CommandRequest` -- so flagging types would report every
   *   public signature as dead. Types do not create the "is this real?"
   *   ambiguity that killed the old tree; unreachable code does.
   * - "Mentioned anywhere else in src", not "reached from a production entry
   *   point". Tightening comes when L2 gives this tree an entry point that is
   *   not a test. Claiming the stronger rule now would be a lie.
   */
  it("has no export that nothing else mentions", () => {
    const orphans: string[] = [];
    for (const file of production) {
      const others = FILES.filter((other) => other.path !== file.path);
      for (const name of exportedNames(file.text)) {
        const mentioned = others.some((other) =>
          new RegExp(`\\b${name}\\b`).test(other.text));
        if (!mentioned) orphans.push(`${file.path}: ${name}`);
      }
    }
    assert.deepEqual(orphans, []);
  });
});

describe("standing · one name per concept", () => {
  /**
   * The first structurally-impossible check found in the old tree came from one
   * phase having three names. The list below is the ONLY spelling of these
   * phases; anything that reintroduces an alias fails here.
   */
  it("uses no alias for a phase name", () => {
    const aliases = ["Intake", "INTAKE", "intake", "TECHSPEC", "techspec", "test_plan"];
    const found: string[] = [];
    for (const file of production) {
      // Comments are exempt: this file's own explanation of the old tree's
      // three names has to be able to quote them. The rule is about what the
      // code says, not about what the code says about itself.
      const code = withoutComments(file.text);
      for (const alias of aliases) {
        if (new RegExp(`["'\`]${alias}["'\`]`).test(code)) {
          found.push(`${file.path}: ${alias}`);
        }
      }
    }
    assert.deepEqual(found, []);
  });
});

function imports(file: { path: string; text: string }): string[] {
  const directory = file.path.includes("/")
    ? file.path.slice(0, file.path.lastIndexOf("/"))
    : "";
  const found: string[] = [];
  for (const match of file.text.matchAll(/from "(\.[^"]+)"/g)) {
    const specifier = match[1]!;
    const parts = (directory ? `${directory}/${specifier}` : specifier).split("/");
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === "." || part === "") continue;
      if (part === "..") resolved.pop();
      else resolved.push(part);
    }
    found.push(`${resolved.join("/")}.ts`);
  }
  return found;
}

function exportedNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of withoutComments(text).matchAll(
    /export\s+(?:declare\s+)?(?:abstract\s+)?(?:const|function|class|enum)\s+(\w+)/g,
  )) {
    names.add(match[1]!);
  }
  return [...names];
}

function withoutComments(text: string): string {
  return text
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/^\s*\/\/.*$/gm, "");
}
