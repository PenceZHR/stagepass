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
const LAYER: Readonly<Record<string, 0 | 1 | 2 | 3 | 4 | 5>> = {
  "domain/phase.ts": 0,
  "domain/change-state.ts": 0,
  "store/change-store.ts": 0,
  "store/project-store.ts": 0,

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
  "codex/invocation.ts": 2,
  "codex/archive.ts": 2,
  // 目录信任。和 archive 同一个形状：读 Codex 自己的状态，整层可注入，只读不写。
  "codex/trust.ts": 2,
  "codex/rollout.ts": 2,
  "codex/tui-transport.ts": 2,
  "codex/turn-runner.ts": 2,

  "domain/round.ts": 4,
  // 十三个阶段各自那一节。纯文本、只 import 一个类型，所以和读它的 round.ts 同层。
  "domain/phase-play.ts": 4,
  "codex/subagent.ts": 4,
  "work/round-runner.ts": 4,
  // 一轮里那两句只写给人看的话（裁判的结论、反方的整体判断）。它只依赖
  // `domain/round.ts` 的来源名单，所以和它同层 —— 它不是 rubric 的东西，
  // 判定归 `rubric_assessments`，这两句谁都不判。
  "store/round-note-store.ts": 4,

  "domain/rubric.ts": 5,
  "domain/rubric-gaps.ts": 5,
  "domain/rubric-edit.ts": 5,
  "domain/rubric-defaults.ts": 5,
  "work/rubric-round.ts": 5,
  "work/round-turn-runner.ts": 5,
  // git。和 `codex/archive.ts` 同一个形状（包一个外部命令、整层可注入），所以同一层。
  // 它不 import 我们自己的任何东西，所以层数只影响「谁可以用它」——2 让 L2 起都能用。
  "work/repo.ts": 2,
  "store/rubric-store.ts": 5,

  // The panel is not a new layer, but its two halves sit at different ones.
  //
  // `pty-session` only carries bytes: that is L2's second launch implementation,
  // the first being osascript + Terminal.app (PRD §6, the L2 row).
  //
  // `panel-server` also puts gate decisions to a person and applies the answer,
  // and that IS L3. It was declared 2 while it only hosted terminals; the guard
  // caught the drift the moment the question path was wired in, which is
  // exactly what this rule is for.
  "web/pty-session.ts": 2,
  // 又提了一层，理由和当初 2 -> 3 一样：它开始承载 rubric 编辑（PRD §1.1 那个
  // 唯一的例外），而 rubric 是 L5。这不是豁免，是把已经发生的事写下来 —— 护栏
  // 在接口写进去的那一刻就会红。
  "web/panel-server.ts": 5,

  "domain/question.ts": 3,
  "domain/brief.ts": 3,
  "store/question-store.ts": 3,
  "plugin/protocol.ts": 3,
  "plugin/server.ts": 3,
  // 「逐条问、只收内容」那套。**和 question 同层，理由也一样**：插件是唯一念它给
  // 模型听的人，而插件在 L3 —— 这两个类型再高一层，L3 就 import 不到了。
  // 名单里装的是 gap（L1）和 criterion（L5），但装的是什么不决定它住哪层，
  // **谁必须够得着它**才决定。
  "domain/worklist.ts": 3,
  "store/worklist-store.ts": 3,

  // The schema is the union of every layer's storage, so it imports each
  // layer's enum constants. Placing it at the top is not an exemption: nothing
  // in production imports it downward -- only tests and the entry script read
  // it -- so the downward-only rule still holds everywhere it is checked.
  //
  // It moves up whenever a new layer adds tables: L5's rubric enums are imported
  // here, so 4 would now be a downward-import violation. If this line looks
  // arbitrary, it is not -- it is "the highest layer with storage".
  "db/schema.ts": 5,
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

describe("standing · 每个按钮的处理器都指向一个真的函数", () => {
  /**
   * 2026-07-29 抓到过两个死按钮：`recordBrief` 和 `waive`。
   *
   * 两次都是同一个原因：用脚本改文件时 `str.replace` 的锚点没匹配上，**它不报错，
   * 原样返回**。于是监听器插进去了，函数没插进去。表现是「按钮看着能点，按下去
   * 什么都不发生」—— 而 `pnpm check` 全绿，`node --check` 也全绿，因为
   * `ReferenceError` 只在**点下去的那一刻**才发生。
   *
   * 这就是老树那种病的活体样本：有标签、有渲染、永远执行不了（PRD §2.3）。
   * 只是这次它长在前端，而前端没有类型检查兜着。
   *
   * 这条护栏是机械的：panel.js 里每个 `addEventListener(..., () => fn())` 里的
   * `fn`，必须在同一个文件里有定义。
   */
  const panel = readFileSync(join(SRC, "web", "panel.js"), "utf-8");

  it("panel.js 里没有指向未定义函数的处理器", () => {
    const defined = new Set<string>();
    for (const match of panel.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(/g)) {
      defined.add(match[1]!);
    }
    // 箭头函数常量也算：`const foo = (x) => …`
    for (const match of panel.matchAll(/const\s+(\w+)\s*=\s*(?:async\s*)?\(/g)) {
      defined.add(match[1]!);
    }

    const dead: string[] = [];
    for (const match of panel.matchAll(
      /addEventListener\(\s*"\w+"\s*,\s*\([^)]*\)\s*=>\s*\{?\s*(?:void\s+)?(\w+)\(/g,
    )) {
      const name = match[1]!;
      if (!defined.has(name)) dead.push(name);
    }
    assert.deepEqual(dead, [], "这些处理器点下去会抛 ReferenceError");
  });

  it("这条护栏不是空转的 —— 它确实找到了处理器", () => {
    // 正则一旦被改坏，上面那条会静默变绿。这里保证它至少匹配到了几个。
    const found = [...panel.matchAll(
      /addEventListener\(\s*"\w+"\s*,\s*\([^)]*\)\s*=>\s*\{?\s*(?:void\s+)?(\w+)\(/g,
    )];
    assert.ok(found.length >= 8, `只匹配到 ${found.length} 个处理器，正则可能坏了`);
  });
});
