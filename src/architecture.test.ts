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
const LAYER: Readonly<Record<string, 0 | 1 | 2 | 3 | 4>> = {
  "domain/phase.ts": 0,
  "domain/change-state.ts": 0,
  "store/change-store.ts": 0,

  "domain/gate.ts": 1,
  "domain/lease.ts": 1,
  "domain/gap.ts": 1,
  "store/evidence-store.ts": 1,
  "store/gap-store.ts": 1,
  "store/command-store.ts": 1,
  "work/job-store.ts": 1,
  "work/turn-loop.ts": 1,

  "domain/turn.ts": 2,
  "store/binding-store.ts": 2,
  "store/turn-store.ts": 2,
  "codex/transport.ts": 2,
  "codex/rollout.ts": 2,
  "codex/tui-transport.ts": 2,
  "codex/turn-runner.ts": 2,

  "domain/round.ts": 4,
  "codex/subagent.ts": 4,
  "work/round-runner.ts": 4,

  // The panel is not a new layer: it is L2's second launch implementation,
  // the first being osascript + Terminal.app (PRD §6, the L2 row).
  "web/pty-session.ts": 2,
  "web/panel-server.ts": 2,

  "domain/question.ts": 3,
  "store/question-store.ts": 3,
  "plugin/protocol.ts": 3,
  "plugin/server.ts": 3,

  // The schema is the union of every layer's storage, so it imports each
  // layer's enum constants. Placing it at the top is not an exemption: nothing
  // in production imports it downward -- only tests and the entry script read
  // it -- so the downward-only rule still holds everywhere it is checked.
  "db/schema.ts": 4,
};

const production = FILES.filter((file) => !file.path.endsWith(".test.ts"));

/**
 * Entry points that live outside `src` but are production callers all the same
 * -- `pnpm verify:rebuild` is how a person runs this tree. Counted when looking
 * for orphans, so a module reachable only from a command still counts as
 * reached, and one reachable from nowhere still does not.
 */
const ENTRY_POINTS = [
  "scripts/verify-rebuild.ts",
  "scripts/verify-decision.ts",
  "scripts/verify-round.ts",
  "scripts/panel.ts",
].map((path) => ({
  path,
  text: readFileSync(join(process.cwd(), path), "utf-8"),
}));

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
      const others = [...FILES, ...ENTRY_POINTS]
        .filter((other) => other.path !== file.path);
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

describe("standing · pty output is never interpreted", () => {
  /**
   * The fifth guard, and the precondition the terminal panel was accepted on
   * (PRD §9.3).
   *
   * It replaces "there is no rendering code in `src/`", which stopped being
   * checkable once Codex began drawing inside a browser. The replacement has to
   * be just as mechanical, because the thing it prevents is a slide, not a
   * decision: first a highlight when a turn ends, then a hint when the selector
   * scrolls away, and by then StagePass is parsing Codex's stream and drawing
   * its own interface -- the approach the user rejected outright (§2.4, third
   * row). The ONLY difference between the panel and that approach is "does not
   * interpret", so it cannot be left to judgement.
   *
   * Whoever has to relax this: you are reopening a settled decision, not
   * loosening a style rule.
   */
  const ptyModules = production.filter((file) => file.path.startsWith("web/"));

  it("has pty modules at all, so this guard is not vacuously green", () => {
    assert.ok(
      ptyModules.length >= 2,
      "expected the panel's modules under src/web -- a guard with nothing to guard is not a guard",
    );
  });

  it("turns bytes into text nowhere on the pty path", () => {
    // Each of these is a way to get a string out of bytes. None has a use in a
    // module whose whole job is to forward them.
    const forbidden = ["TextDecoder", ".toString(", "JSON.parse", "String.fromCharCode"];
    const found: string[] = [];
    for (const file of ptyModules) {
      const code = withoutComments(file.text);
      for (const token of forbidden) {
        if (code.includes(token)) found.push(`${file.path}: ${token}`);
      }
    }
    assert.deepEqual(found, []);
  });

  it("asks node-pty for bytes rather than the string it defaults to", () => {
    const session = production.find((file) => file.path === "web/pty-session.ts");
    assert.ok(session, "web/pty-session.ts is missing");
    const code = withoutComments(session.text);
    // Without this, onData yields a decoded string -- which both hands callers
    // the thing this rule withholds and corrupts any multi-byte character that
    // happens to straddle a chunk boundary.
    assert.match(code, /encoding:\s*null/);
    // And the type it hands out is the narrow one.
    assert.match(code, /onBytes\(listener:\s*\(bytes:\s*Uint8Array\)/);
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
