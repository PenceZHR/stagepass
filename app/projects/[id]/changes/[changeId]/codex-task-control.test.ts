import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CodexTaskControl } from "./codex-task-control";

const directory = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(directory, "codex-task-control.tsx"), "utf8");
const dataHookSource = readFileSync(
  resolve(directory, "use-change-detail-data.ts"),
  "utf8",
);
const control = {
  bindingTitle: "Spec task",
  bindingStatus: "running",
  threadId: "thread-1",
  lastTurnId: "turn-7",
  lastObservationCursor: 4,
  lastSeenAt: "2026-07-24T00:00:00.000Z",
  lastErrorCode: null,
  currentInteractionId: null,
  codexDecisionEnabled: true,
  model: "gpt-5.4",
  reasoningEffort: "high",
};
const noop = async () => {};

function renderControlLabelled(startLabel: string) {
  return renderToStaticMarkup(
    createElement(CodexTaskControl, {
      control: { ...control, bindingStatus: "ready" },
      health: { status: "ready" as const },
      readOnly: false,
      startLabel,
      onOpen: noop,
      onStart: noop,
    }),
  );
}

function renderControl(
  readOnly: boolean,
  patch: Partial<typeof control> = {},
  health: { status: "ready" | "unavailable" } | null = { status: "ready" },
) {
  return renderToStaticMarkup(
    createElement(CodexTaskControl, {
      control: { ...control, ...patch },
      health,
      readOnly,
      onOpen: noop,
      onStart: noop,
    }),
  );
}

describe("Codex task control", () => {
  it("keeps only the start/open bridge into Codex", () => {
    assert.match(source, /打开 Codex/);
    assert.match(source, /开始本阶段/);
    assert.match(source, /Codex App/);
    assert.doesNotMatch(
      source,
      /Retry|重试|中断当前执行|查看证据|保存设置|修复连接|推理强度|更多操作与诊断/,
    );
    assert.doesNotMatch(source, /<input|<details/);
  });

  it("keeps open and rerun as separate actions for a bound writable stage", () => {
    const markup = renderControl(false, { bindingStatus: "ready" });
    assert.match(markup, /打开 Codex/);
    assert.match(markup, /重新运行本阶段/);
    assert.equal((markup.match(/<button/g) ?? []).length, 2);
    assert.doesNotMatch(markup, /turn-7|gpt-5\.4|high/);
  });

  /**
   * The button used to be hardcoded to "重新运行本阶段" whatever action the stage
   * had selected. Once a Spec round settles, that action becomes another
   * adversarial round -- which supersedes the finished round and spends a whole
   * red/blue cycle -- and the button still said "重新运行". A control that
   * misnames a destructive action is worse than one that is missing.
   */
  it("names the start button after the action it will actually run", () => {
    const markup = renderControlLabelled("继续对抗（另开一轮）");

    assert.match(markup, /继续对抗（另开一轮）/);
    assert.doesNotMatch(markup, /重新运行本阶段/);
  });

  it("falls back to its own copy only when no action names the button", () => {
    assert.match(renderControl(false, { bindingStatus: "ready" }), /重新运行本阶段/);
  });

  it("opens a bound task when the stage cannot be started", () => {
    const markup = renderControl(true);
    assert.match(markup, /Codex 正在运行/);
    assert.match(markup, /查看 Codex 运行/);
    assert.equal((markup.match(/<button/g) ?? []).length, 1);
    assert.doesNotMatch(markup, /turn-7|gpt-5\.4|high/);
  });

  it("routes pending choices to Codex and never adds a Web fallback", () => {
    const needsInputMarkup = renderControl(true, {
      currentInteractionId: "INT-1",
      bindingStatus: "idle",
    });
    assert.match(needsInputMarkup, /data-codex-stage-status="needs_input"/);
    assert.match(needsInputMarkup, /有问题等待你选择/);
    assert.match(needsInputMarkup, /去 Codex 选择/);
    assert.equal((needsInputMarkup.match(/<button/g) ?? []).length, 1);
  });

  it("shows start only for an unbound current stage", () => {
    const writableMarkup = renderControl(false, { threadId: null });
    const readOnlyMarkup = renderControl(true, { threadId: null });

    assert.match(writableMarkup, /开始本阶段/);
    assert.doesNotMatch(readOnlyMarkup, /<button/);
  });

  it("shows a neutral connection check before health is known and refreshes it", () => {
    const markup = renderControl(false, {}, null);

    assert.match(markup, /连接检测中/);
    assert.doesNotMatch(markup, /Codex App 未连接/);
    assert.match(dataHookSource, /setInterval/);
    assert.match(dataHookSource, /getCodexHealth/);
    assert.match(dataHookSource, /clearInterval/);
  });
});
