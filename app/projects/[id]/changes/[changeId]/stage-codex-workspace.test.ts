import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  STAGE_CLARIFICATION_ORDER,
  STAGE_CLARIFICATION_POLICIES,
} from "@/lib/stage-clarification-policy";
import { StageCodexWorkspace } from "./stage-codex-workspace";

describe("shared all-stage Codex workspace", () => {
  it("renders the same question-batch contract for every stage", () => {
    for (const stageId of STAGE_CLARIFICATION_ORDER) {
      const policy = STAGE_CLARIFICATION_POLICIES[stageId];
      const html = renderToStaticMarkup(
        createElement(
          StageCodexWorkspace,
          {
            stageId,
            isFuture: false,
            isWaitingForInput: false,
          },
          createElement("button", null, "Open"),
        ),
      );

      assert.match(html, new RegExp(`data-stage-policy="${stageId}"`));
      assert.match(html, /每批最多 10 个具体问题/);
      assert.ok(html.includes(policy.label), stageId);
      assert.ok(html.includes(policy.webSummary), stageId);
      assert.match(html, /直到没有阻塞项/);
      assert.match(html, />Open<\/button>/);
    }
  });

  it("shows waiting and future states without adding Web decision controls", () => {
    const waiting = renderToStaticMarkup(
      createElement(
        StageCodexWorkspace,
        {
          stageId: "review",
          isFuture: false,
          isWaitingForInput: true,
        },
        null,
      ),
    );
    const future = renderToStaticMarkup(
      createElement(
        StageCodexWorkspace,
        {
          stageId: "qa",
          isFuture: true,
          isWaitingForInput: false,
        },
        null,
      ),
    );

    assert.match(waiting, /Codex 正在等待你逐题选择/);
    assert.match(future, /尚未进入该阶段/);
    assert.doesNotMatch(waiting + future, /<input|<textarea|<select/);
  });
});
