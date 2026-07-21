import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseDeliveryLineProtocol } from "./delivery-line-protocol.ts";

function validText(overrides: {
  howToRun?: string;
  whatChanged?: string;
  knownLimits?: string;
  fileMap?: string[];
  done?: string | null;
} = {}): string {
  const lines: string[] = [];
  lines.push("HOW_TO_RUN<<");
  lines.push(overrides.howToRun ?? "打开 `index.html` 即可，无需安装依赖。");
  lines.push(">>HOW_TO_RUN");
  lines.push("WHAT_CHANGED<<");
  lines.push(overrides.whatChanged ?? "新增了走廊闭塞检测，玩家会看到红色提示。");
  lines.push(">>WHAT_CHANGED");
  for (const line of overrides.fileMap ?? ["FILEMAP: index.html | entry | 游戏入口，双击即可运行"]) {
    lines.push(line);
  }
  lines.push("KNOWN_LIMITS<<");
  lines.push(overrides.knownLimits ?? "本次不做多人联机。");
  lines.push(">>KNOWN_LIMITS");
  if (overrides.done !== null) lines.push(overrides.done ?? "DELIVERY_DONE: true");
  return lines.join("\n");
}

describe("delivery line protocol", () => {
  it("assembles the payload from blocks and FILEMAP records", () => {
    const parsed = parseDeliveryLineProtocol(validText({
      fileMap: [
        "FILEMAP: index.html | entry | 游戏入口，双击即可运行",
        "FILEMAP: src/corridor.ts | internal | 走廊闭塞判定的实现",
      ],
    }));
    assert.equal(parsed.ok, true);
    assert.ok(parsed.ok);
    assert.equal(parsed.payload.howToRun, "打开 `index.html` 即可，无需安装依赖。");
    assert.equal(parsed.payload.whatChanged, "新增了走廊闭塞检测，玩家会看到红色提示。");
    assert.equal(parsed.payload.knownLimitsNarrative, "本次不做多人联机。");
    assert.deepEqual(parsed.payload.fileMap, [
      { path: "index.html", role: "entry", purpose: "游戏入口，双击即可运行" },
      { path: "src/corridor.ts", role: "internal", purpose: "走廊闭塞判定的实现" },
    ]);
  });

  // findStructuralBlockError must be the parser's FIRST statement: an
  // unterminated block swallows every later record, and an off-script block
  // swallows the records between its opener and terminator into a body no field
  // reads. Both look like a short-but-valid document to everything downstream.
  it("rejects an unterminated block before reading anything else", () => {
    const text = validText().replace(">>HOW_TO_RUN\n", "");
    const parsed = parseDeliveryLineProtocol(text);
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok);
    assert.match(parsed.message, /unterminated/);
  });

  it("rejects an off-script block that would swallow FILEMAP records", () => {
    const parsed = parseDeliveryLineProtocol([
      "NOTES<<",
      "FILEMAP: index.html | entry | 入口",
      ">>NOTES",
      validText(),
    ].join("\n"));
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok);
    assert.match(parsed.message, /unexpected NOTES<< block/);
  });

  it("rejects a stray terminator left by a block that closed early", () => {
    const parsed = parseDeliveryLineProtocol(validText({
      howToRun: "先看这一段\n>>HOW_TO_RUN\n再看这一段",
    }));
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok);
    assert.match(parsed.message, /stray ">>HOW_TO_RUN"/);
  });

  for (const block of ["HOW_TO_RUN", "WHAT_CHANGED", "KNOWN_LIMITS"] as const) {
    it(`rejects a missing ${block} block`, () => {
      const text = validText()
        .split("\n")
        .filter((line, index, all) => {
          const openIndex = all.indexOf(`${block}<<`);
          const closeIndex = all.indexOf(`>>${block}`);
          return index < openIndex || index > closeIndex;
        })
        .join("\n");
      const parsed = parseDeliveryLineProtocol(text);
      assert.equal(parsed.ok, false);
      assert.ok(!parsed.ok);
      assert.match(parsed.message, new RegExp(`missing ${block}<< block`));
    });

    it(`rejects a blank ${block} block`, () => {
      const parsed = parseDeliveryLineProtocol(validText({
        [block === "HOW_TO_RUN" ? "howToRun" : block === "WHAT_CHANGED" ? "whatChanged" : "knownLimits"]: "   ",
      }));
      assert.equal(parsed.ok, false);
      assert.ok(!parsed.ok);
      assert.match(parsed.message, new RegExp(`${block}<< block is empty`));
    });
  }

  // Zero FILEMAP lines is NOT legal here, and the judge is rubric-line-protocol's:
  // "does silence have a downstream ledger slot that would block?". It does not.
  // The file map is one of the delivery note's four mandatory sections and no
  // gate reads it, so an empty one ships a delivery note missing a whole section
  // with nothing anywhere recording the omission.
  it("rejects zero FILEMAP records", () => {
    const parsed = parseDeliveryLineProtocol(validText({ fileMap: [] }));
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok);
    assert.match(parsed.message, /at least 1 FILEMAP/);
  });

  it("rejects a FILEMAP record with the wrong field count", () => {
    const parsed = parseDeliveryLineProtocol(validText({
      fileMap: ["FILEMAP: index.html | entry"],
    }));
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok);
    assert.match(parsed.message, /FILEMAP needs exactly 3/);
  });

  it("rejects an unknown FILEMAP role", () => {
    const parsed = parseDeliveryLineProtocol(validText({
      fileMap: ["FILEMAP: index.html | main | 入口"],
    }));
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok);
    assert.match(parsed.message, /FILEMAP role must be/);
  });

  it("rejects a FILEMAP path that escapes the repo or carries JSON garbage", () => {
    for (const badPath of ["../outside.ts", "/etc/passwd", 'a"b.ts']) {
      const parsed = parseDeliveryLineProtocol(validText({
        fileMap: [`FILEMAP: ${badPath} | entry | 入口`],
      }));
      assert.equal(parsed.ok, false, badPath);
      assert.ok(!parsed.ok);
      assert.match(parsed.message, /FILEMAP path/);
    }
  });

  it("rejects duplicate FILEMAP paths", () => {
    const parsed = parseDeliveryLineProtocol(validText({
      fileMap: [
        "FILEMAP: index.html | entry | 入口",
        "FILEMAP: index.html | internal | 又一次",
      ],
    }));
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok);
    assert.match(parsed.message, /duplicate FILEMAP path/);
  });

  // The FILEMAP records and the KNOWN_LIMITS block both trail a potentially very
  // large HOW_TO_RUN/WHAT_CHANGED body, so a reply truncated after them still
  // parses as a structurally complete document. The marker is written last, so
  // truncation takes it too and the stage fails loudly.
  it("requires exactly one DELIVERY_DONE marker", () => {
    const missing = parseDeliveryLineProtocol(validText({ done: null }));
    assert.equal(missing.ok, false);
    assert.ok(!missing.ok);
    assert.match(missing.message, /expected exactly 1 DELIVERY_DONE/);

    const doubled = parseDeliveryLineProtocol(`${validText()}\nDELIVERY_DONE: true`);
    assert.equal(doubled.ok, false);
    assert.ok(!doubled.ok);
    assert.match(doubled.message, /expected exactly 1 DELIVERY_DONE/);
  });

  it("ignores prose around the protocol lines", () => {
    const parsed = parseDeliveryLineProtocol([
      "我先读了仓库，下面是交付单。",
      validText(),
      "以上。",
    ].join("\n"));
    assert.equal(parsed.ok, true);
  });

  // The delivery note has no KNOWN_LIMITS-shaped field that the model may use to
  // author the DB-derived section. This protocol deliberately exposes no block
  // for open gaps / waived P1s: those bytes come from the database at the call
  // site (composeDeliveryMarkdown), never from the reply.
  it("has no protocol slot for the database-derived limits", () => {
    const parsed = parseDeliveryLineProtocol([
      validText(),
      "OPEN_GAPS<<",
      "GAP-1 我编的",
      ">>OPEN_GAPS",
    ].join("\n"));
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok);
    assert.match(parsed.message, /unexpected OPEN_GAPS<< block/);
  });
});
