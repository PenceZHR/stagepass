import assert from "node:assert/strict";
import tsc from "typescript";

import {
  closureOf as graphClosureOf, dependenciesOf, parseModuleGraph,
} from "./graph/module-graph";
import { ingredientsFor, renderIngredients } from "./graph/ingredients";
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
  /*
   * 真依赖图的解析器（H 档第一块）。它**只 import `typescript`**，我们自己的
   * 东西一个都不碰 —— 所以放最低层，谁都够得着。
   *
   * 它同时是这条护栏自己的地基：图错了，下面「谁不许 import 谁」和「闭包别吃掉
   * 全树」两条一起变成假的。所以它的层数不是随手放的，是「它不能依赖任何会被
   * 它审判的东西」。
   */
  "graph/module-graph.ts": 0,
  // 配料单（H 档第二块）。只依赖上面那个解析器，所以同一层 —— 它俩是同一族
  // 工具：一个把树读成图，一个按图切出「这次改动该看见什么」。
  "graph/ingredients.ts": 0,
  // 两张图的对账（H 档第三块）。同一族工具，同一层：它只读图，不读代码。
  "graph/reconcile.ts": 0,
  // 只依赖 phase 的纯路径生成（E：产物的家）。
  "domain/artifact-home.ts": 0,
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
  // 「接受一条已知风险」这个用例（§4.1·J 从 `handle()` 里搬出来的第一个）。
  // 它够得着的最高一层是 `domain/round.ts`（轮次算法），所以住这儿 —— 层数是
  // 它的依赖顶出来的，不是挑的。
  "app/waive.ts": 4,
  // 跳转表 = 账本投影（§5.9.2）。轮次算法在 round.ts（一份实现），所以同层。
  "domain/journey.ts": 4,
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
  // 「把这一轮的裁决交给人」这个用例 —— 三条问人的路里最绕的一条。它够得着
  // `domain/rubric.ts`（把这一轮判成什么样写进题面），所以住 5。
  "app/decide-gate.ts": 5,
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
  /*
   * **应用层的第一块**（BACKLOG §4.1·J）：把一道题交给人、等他答。
   *
   * 和 `question` 同层，理由也一样 —— 它就是「问人」这件事本身，够得着的东西
   * 不超过 question / question-store / binding-store。它**不认识 HTTP**，所以
   * `web/`（L5）在它上面，而不是它的一部分。
   */
  "app/ask-human.ts": 3,
  // 「把这次改动要什么问出来」这个用例。够得着的最高一层是 `domain/brief.ts`（3），
  // 所以和它同层 —— 它连 Codex 都不认识（「跑一次 turn」是注进来的）。
  "app/record-brief.ts": 3,
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

const production = FILES.filter((file) =>
  !file.path.endsWith(".test.ts")
  // `.d.ts` 只是声明，没有实现、没有运行时依赖 —— 分层说的是「谁可以用谁」，
  // 而一个环境声明（xterm 挂成全局的那两个类）不参与任何依赖关系。
  // 2026-08-05 给 panel.js 上类型检查时加的：panel-globals.d.ts 是它的伴生声明。
  && !file.path.endsWith(".d.ts"));

/**
 * 这一整棵树的**真依赖图**，用真编译器解析（`graph/module-graph.ts`）。
 *
 * 分层护栏和闭包护栏原来各自数一遍 `from "…"` 的正则 —— §5.10 早就写着那个
 * 「只够量结构，不够当护栏」。2026-08-05 换过来时先做了对照：**今天这棵树上
 * 两者逐条一致**（48 模块 152 边，0 差异、0 落空边）。
 *
 * 所以换它的理由不是「正则今天算错了」，是**正则明天会算错而没人知道**：树里
 * 现在恰好没有副作用 import、没有动态 import、注释里也没有假的 `from "./x"`，
 * 而这三样任何一样出现，正则都会静默给出错的图 —— 一条护栏建在错的图上，
 * 比没有护栏更糟。
 */
const GRAPH = parseModuleGraph(production);

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
      for (const target of dependenciesOf(GRAPH, file.path)) {
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

/**
 * 两条**棘轮**护栏（BACKLOG §4.1）：单函数行数、单模块依赖闭包占比。
 *
 * ## 为什么是棘轮，不是干净的上限
 *
 * `handle()` 现在 1463 行、`panel-server.ts` 的闭包够得着全树 91% —— 定一条干净的
 * 上限它们当场就红，而「先把违例修完再装护栏」的顺序等于永远装不上。棘轮反过来：
 * **现行违例逐个钉死在例外表里，只许缩、不许涨**；其余所有函数/模块从今天起受
 * 干净上限管。修掉一个违例，就把它从表里删掉（有一条护栏盯着表不许留死条目，
 * 和 `LAYER` 那张表同一个道理）。
 *
 * ## 为什么这两个数
 *
 * 上限取的是「现状第二名再留点余量」：函数第二名 279 行（`runRound`）→ 上限 300；
 * 闭包第二名 57%（`round-turn-runner`）→ 上限 60%。**不是审美数字，是「别再长出
 * 第二个 handle()」的机械底线** —— 分层护栏防住了「下层依赖上层」，没防住
 * 「某一层长出一个吃掉一切的模块」，这两条补的就是那个盲区。
 */
const FUNCTION_LINES_CAP = 300;
const FUNCTION_RATCHET: Readonly<Record<string, number>> = {
  // §4.1 的主角。拆应用层（BACKLOG §四 J 批）每拆走一块就把这个数往下钉。
  // 2026-08-05：抽 launchAskPrompt（1463 → 1462）、askFollowUp（→ 1453）、
  // phasesFor（→ 1410）、waitForAnswer 收掉四份手写的等答案循环（→ 1329）、
  // `app/waive.ts` —— 应用层的第一个真用例（→ 1225）、`app/record-brief.ts`（→ 1093）、
  // `app/decide-gate.ts`（→ 875）。三条问人的路现在全在应用层，`handle()` 只剩转发。
  "web/panel-server.ts#handle": 875,
};
const CLOSURE_SHARE_CAP = 0.6;
const CLOSURE_RATCHET: Readonly<Record<string, number>> = {
  // 91% —— 它一个模块够得着全树。同上，拆一块钉一块。
  "web/panel-server.ts": 0.92,
};

describe("standing · 没有一个函数长成一层", () => {
  /** 用真编译器量，不用正则猜函数边界 —— 边界猜错一次这条护栏就静默失效。 */
  const measured: { key: string; lines: number }[] = [];
  for (const file of production) {
    const source = tsc.createSourceFile(
      file.path, file.text, tsc.ScriptTarget.ES2022, true);
    const visit = (node: tsc.Node): void => {
      if (
        tsc.isFunctionDeclaration(node) || tsc.isMethodDeclaration(node)
        || tsc.isArrowFunction(node) || tsc.isFunctionExpression(node)
      ) {
        const lines = source.getLineAndCharacterOfPosition(node.getEnd()).line
          - source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const name = (tsc.isFunctionDeclaration(node) || tsc.isMethodDeclaration(node))
          && node.name !== undefined ? node.name.getText()
          : tsc.isVariableDeclaration(node.parent) && tsc.isIdentifier(node.parent.name)
            ? node.parent.name.getText() : "(anon)";
        measured.push({ key: `${file.path}#${name}`, lines });
      }
      tsc.forEachChild(node, visit);
    };
    visit(source);
  }

  it("**超过上限的只有例外表里那几个，而且没涨**", () => {
    const over = measured
      .filter(({ key, lines }) =>
        lines > (FUNCTION_RATCHET[key] ?? FUNCTION_LINES_CAP))
      .map(({ key, lines }) => `${key} = ${lines} 行`);
    assert.deepEqual(over, [], "要么拆它，要么（仅当它在缩）更新例外表");
  });

  it("例外表里没有已经修好的死条目", () => {
    // 修到上限以下还留在表里，下一个人会以为它还是雷。和 LAYER 那条同一个形状。
    const stale = Object.keys(FUNCTION_RATCHET).filter((key) => {
      const now = measured.find((entry) => entry.key === key);
      return now === undefined || now.lines <= FUNCTION_LINES_CAP;
    });
    assert.deepEqual(stale, [], "把它从 FUNCTION_RATCHET 里删掉");
  });
});

/**
 * standing · 配料单**真的只带一小片树**（§5.4.1 / §5.7）。
 *
 * 「只给签名不给实现」这个机关的收益是可以量的：改一个模块时，喂进去的东西
 * 占全树多少。2026-08-05 第一次量（49 个模块 / 502 KB）：
 *
 * ```
 * domain/gap.ts               18.0 KB   3.6%   28×
 * domain/journey.ts           18.7 KB   3.7%   27×
 * work/round-turn-runner.ts   32.2 KB   6.4%   16×
 * web/panel-server.ts        145.9 KB  29.0%    3×   ← 说明问题的那一个
 * ```
 *
 * **收益和「这棵树拆得好不好」成正比**：一个划得干净的模块拿到 28×，而那个
 * 1410 行的 `handle()` 只有 3× —— 它自己正文就 94.6 KB，还牵着 33 个依赖。
 * 换句话说，J 批（拆 handle）不只是好看，它直接决定这套机关值不值钱。
 *
 * **J 批把三条问人的路搬进应用层之后（2026-08-05 晚，54 个模块 / 520.6 KB）** ——
 * 这不是预测，是搬完量出来的：
 *
 * ```
 * web/panel-server.ts        113.2 KB  21.7%    5×   ← 29.0% / 3× 搬下来的
 * app/decide-gate.ts          32.2 KB   6.2%   16×   ← 裁决
 * app/waive.ts                20.8 KB   4.0%   25×   ← 接受风险
 * app/record-brief.ts         16.6 KB   3.2%   31×   ← 录需求
 * app/ask-human.ts            11.7 KB   2.2%   45×   ← 三条路共用的那段
 * ```
 *
 * 同一段逻辑，待在 `handle()` 里是 3×，搬进应用层就是 16~45×。**这是「拆它直接
 * 提升整套机关的收益」这句话的实测值**，不是一句好听的话。
 *
 * 这条护栏钉的是**别再退步**：除了例外表里那个，谁的配料单都不许超过全树三成。
 */
const INGREDIENT_SHARE_CAP = 0.3;

describe("standing · 配料单只带一小片树", () => {
  /**
   * **依赖那半份里一个注释都不许有。**
   *
   * 这条是在真树上看输出才发现要写的：第一版用 `getText()` 取签名，它把花括号里
   * 的注释一起带出来 —— `ChangeState` 那个接口的成员上挂着十几行讲不变量和历史
   * 的 JSDoc，整段漏进了配料单。而「只给签名不给实现」这个机关的全部价值就在于
   * **看不见实现**，注释里恰恰装着实现（这棵树尤其如此）。
   *
   * 玩具夹具测不出这个 —— 它的注释太短、太干净。所以护栏放在真树上。
   */
  it("**依赖的签名里没有注释** —— 注释装着实现，漏一行机关就少一分", () => {
    const leaking: string[] = [];
    for (const file of production) {
      const list = ingredientsFor({ graph: GRAPH, files: production, group: [file.path] });
      for (const dependency of list.dependencies) {
        const text = dependency.signatures.join("\n");
        if (/\/\*|\/\//.test(text)) leaking.push(`${file.path} -> ${dependency.path}`);
      }
    }
    assert.deepEqual(leaking, []);
  });

  it("**没有模块的配料单吃掉全树三成以上**", () => {
    const whole = production.reduce((sum, file) => sum + file.text.length, 0);
    const over = production
      .map((file) => ({
        path: file.path,
        share: renderIngredients(
          ingredientsFor({ graph: GRAPH, files: production, group: [file.path] }),
        ).length / whole,
      }))
      .filter(({ share }) => share > INGREDIENT_SHARE_CAP)
      .map(({ path, share }) => `${path} = ${(share * 100).toFixed(0)}%`);
    assert.deepEqual(over, [], "改它一次就要读小半棵树 —— 拆它");
  });
});

describe("standing · 没有一个模块的依赖闭包吃掉全树", () => {
  it("**闭包占比超线的只有例外表里那几个，而且没涨**", () => {
    const total = production.length;
    const over = production
      .map((file) => ({
        path: file.path,
        share: (graphClosureOf(GRAPH, file.path).length - 1) / total,
      }))
      .filter(({ path, share }) => share > (CLOSURE_RATCHET[path] ?? CLOSURE_SHARE_CAP))
      .map(({ path, share }) => `${path} = ${(share * 100).toFixed(0)}%`);
    assert.deepEqual(over, [], "它正在变成第二个 panel-server —— 拆，别喂");
  });

  it("例外表里没有已经修好的死条目", () => {
    const total = production.length;
    const stale = Object.keys(CLOSURE_RATCHET).filter((path) =>
      !production.some((file) => file.path === path)
      || (graphClosureOf(GRAPH, path).length - 1) / total <= CLOSURE_SHARE_CAP);
    assert.deepEqual(stale, [], "把它从 CLOSURE_RATCHET 里删掉");
  });
});


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
