import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AiRunResult } from "./ai-engine-types";
import {
  classifyStageConvergence,
  STAGE_APPROVAL_QUESTION_ID,
} from "./stage-convergence-service";

function result(overrides: Partial<AiRunResult> = {}): AiRunResult {
  return {
    threadId: "THREAD-1",
    runId: "ATTEMPT-1",
    summary: "正式 PRD 内容",
    success: true,
    changedFiles: [],
    items: [{ type: "agent_message", text: "正式 PRD 内容", id: "ITEM-1" }],
    ...overrides,
  } as AiRunResult;
}

describe("stage convergence", () => {
  it("treats a turn that asked another batch as unconverged", () => {
    const classified = classifyStageConvergence(result({
      items: [
        { type: "agent_message", text: "本批确认…", id: "ITEM-1" },
        {
          type: "mcp_tool_call",
          name: "stagepass-card/present_stagepass_choices",
          status: "completed",
          id: "ITEM-2",
        },
        { type: "agent_message", text: "已展示下一批问题", id: "ITEM-3" },
      ],
    }));

    assert.deepEqual(classified, { kind: "asked_again" });
  });

  it("recognizes the legacy card tool as another batch", () => {
    const classified = classifyStageConvergence(result({
      items: [{
        type: "mcp_tool_call",
        name: "stagepass-card/show_stagepass_card",
        status: "completed",
        id: "ITEM-1",
      }],
    }));

    assert.deepEqual(classified, { kind: "asked_again" });
  });

  it("converges when a completed turn asked nothing further", () => {
    const classified = classifyStageConvergence(result());

    assert.deepEqual(classified, {
      kind: "converged",
      text: "正式 PRD 内容",
    });
  });

  // A turn the provider never finished proves nothing about convergence. Its
  // last words are not a stage result, and adopting them would persist a
  // truncated document as the authoritative artifact.
  it("refuses to converge on a turn that did not complete", () => {
    const classified = classifyStageConvergence(result({
      success: false,
      providerErrorCode: "interrupted",
    }));

    assert.deepEqual(classified, {
      kind: "inconclusive",
      reason: "turn_not_completed",
    });
  });

  it("refuses to converge on a completed turn that said nothing", () => {
    const classified = classifyStageConvergence(result({
      summary: "   ",
      items: [],
    }));

    assert.deepEqual(classified, {
      kind: "inconclusive",
      reason: "empty_reply",
    });
  });

  it("reads a card call whatever MCP host prefix carries it", () => {
    const classified = classifyStageConvergence(result({
      items: [{
        type: "mcp_tool_call",
        name: "present_stagepass_choices",
        status: "completed",
        id: "ITEM-1",
      }],
    }));

    assert.deepEqual(classified, { kind: "asked_again" });
  });
});

describe("stage approval card", () => {
  // The last card a converged stage shows is not another question: it is the
  // approval the human gives before the next stage starts. Counting it as a
  // question would hold the stage open forever, since nothing further is
  // coming.
  it("does not treat the approval card as another batch", () => {
    const classified = classifyStageConvergence({
      threadId: "T", runId: "R", summary: "正式 PRD", success: true,
      changedFiles: [],
      items: [
        { type: "agent_message", text: "正式 PRD", id: "ITEM-1" },
        {
          type: "mcp_tool_call",
          name: "stagepass-card/present_stagepass_choices",
          status: "completed",
          result: JSON.stringify({
            structuredContent: { answers: [{ questionId: STAGE_APPROVAL_QUESTION_ID }] },
          }),
          id: "ITEM-2",
        },
      ],
    } as never);

    assert.deepEqual(classified, { kind: "converged", text: "正式 PRD" });
  });

  // The shape above is what a COMPLETED card reports. Presenting one returns
  // the batch it rendered, under `questions` keyed by `id` -- and that is the
  // only shape a stage turn ever produces, because the turn ends while the card
  // is still awaiting selection. Reading only `answers` meant this returned
  // false for every real card, so an approving stage was classified as having
  // asked another batch and could never converge: no gate opened, and the
  // approval click failed with nothing to fence.
  it("does not treat a presented approval card as another batch", () => {
    const classified = classifyStageConvergence({
      threadId: "T", runId: "R", summary: "正式 PRD", success: true,
      changedFiles: [],
      items: [{
        type: "mcp_tool_call",
        name: "stagepass-card/present_stagepass_choices",
        status: "completed",
        result: JSON.stringify({
          structuredContent: {
            schemaVersion: "stagepass.requirement-choice/v2",
            status: "awaiting_selection",
            questions: [{ id: STAGE_APPROVAL_QUESTION_ID, question: "批准本阶段？" }],
          },
        }),
        id: "ITEM-1",
      }],
    } as never);

    assert.deepEqual(classified, { kind: "converged", text: "正式 PRD" });
  });

  it("treats a presented batch that hides approval among questions as unconverged", () => {
    const classified = classifyStageConvergence({
      threadId: "T", runId: "R", summary: "…", success: true, changedFiles: [],
      items: [{
        type: "mcp_tool_call",
        name: "stagepass-card/present_stagepass_choices",
        status: "completed",
        result: JSON.stringify({
          structuredContent: {
            status: "awaiting_selection",
            questions: [
              { id: STAGE_APPROVAL_QUESTION_ID, question: "批准本阶段？" },
              { id: "session_duration", question: "会话多久过期？" },
            ],
          },
        }),
        id: "ITEM-1",
      }],
    } as never);

    assert.deepEqual(classified, { kind: "asked_again" });
  });

  it("still treats a mixed batch as unconverged", () => {
    const classified = classifyStageConvergence({
      threadId: "T", runId: "R", summary: "…", success: true, changedFiles: [],
      items: [{
        type: "mcp_tool_call",
        name: "stagepass-card/present_stagepass_choices",
        status: "completed",
        result: JSON.stringify({
          structuredContent: {
            answers: [
              { questionId: STAGE_APPROVAL_QUESTION_ID },
              { questionId: "session_duration" },
            ],
          },
        }),
        id: "ITEM-1",
      }],
    } as never);

    assert.deepEqual(classified, { kind: "asked_again" });
  });
});

describe("stage runner clarification guard", () => {
  // A stage turn that ended by calling the card produced an acknowledgement.
  // Ingesting it wrote "I have shown you ten questions" as the stage artifact
  // and cleared the gate on it -- a silent false pass.
  it("refuses to ingest a reply whose turn asked another batch", async () => {
    const { StageAwaitingClarificationError } = await import(
      "./pipeline-document-stage-runner-service"
    );
    const asked = classifyStageConvergence({
      threadId: "T", runId: "R", summary: "已展示首批 10 个问题", success: true,
      changedFiles: [],
      items: [{
        type: "mcp_tool_call",
        name: "stagepass-card/present_stagepass_choices",
        status: "completed",
        id: "ITEM-1",
      }],
    } as never);

    assert.equal(asked.kind, "asked_again");
    assert.equal(
      new StageAwaitingClarificationError("intake").code,
      "stage_awaiting_clarification",
    );
  });
});
