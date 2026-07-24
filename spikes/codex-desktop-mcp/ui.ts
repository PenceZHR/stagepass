import {
  App,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  createPhase0HostTransport,
} from "./host-transport";
import type {
  Phase0AuthorizedHostDispatch,
} from "./supervisor";

export interface Phase0UiPrivateState {
  threadId: string;
  nonceId: string;
  nonce: string;
  verificationRunId?: string;
}

export interface Phase0UiClient {
  callServerTool(input: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<CallToolResult>;
}

export async function requestPhase0Continuation(
  client: Phase0UiClient,
  state: Phase0UiPrivateState,
): Promise<Phase0AuthorizedHostDispatch> {
  const submitted = await client.callServerTool({
    name: "submit_phase0_card",
    arguments: {
      threadId: state.threadId,
      nonceId: state.nonceId,
      nonce: state.nonce,
      ...(state.verificationRunId
        ? { verificationRunId: state.verificationRunId }
        : {}),
    },
  });
  if (submitted.isError) {
    throw new Error("private Phase 0 submit was rejected");
  }
  const hostDispatch = (
    typeof submitted.structuredContent === "object"
    && submitted.structuredContent !== null
    && "hostDispatch" in submitted.structuredContent
  )
    ? submitted.structuredContent.hostDispatch as Phase0AuthorizedHostDispatch
    : undefined;
  if (!hostDispatch) {
    throw new Error("private Phase 0 submit omitted Host dispatch authority");
  }
  return hostDispatch;
}

export async function mountPhase0Ui(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>(
    "#phase0-ui-message",
  );
  const status = document.querySelector<HTMLElement>("#phase0-status");
  if (!button || !status) return;

  const app = new App(
    { name: "stagepass-phase0-card", version: "1.0.0" },
    {},
    { autoResize: true, strict: true },
  );
  let privateState: Phase0UiPrivateState | null = null;
  app.ontoolresult = (result) => {
    const state = result._meta?.stagepassPhase0 as
      | Phase0UiPrivateState
      | undefined;
    if (!state) return;
    privateState = state;
    button.disabled = false;
    status.textContent = "Ready for the verified user click.";
  };
  await app.connect(
    new PostMessageTransport(window.parent, window.parent),
  );
  const hostTransport = createPhase0HostTransport(app);

  button.addEventListener("click", async () => {
    if (!privateState) return;
    button.disabled = true;
    status.textContent = "Submitting through protected App channel…";
    try {
      // Business handling ends with the private continuation tool. The
      // returned one-shot dispatch then crosses the platform-defined,
      // view-owned App.sendMessage transport boundary in exactly one adapter.
      const dispatch = await requestPhase0Continuation(app, privateState);
      await hostTransport.deliver(dispatch);
      status.textContent = "Same-thread message sent.";
    } catch {
      status.textContent = "Protected submit failed.";
      button.disabled = false;
    }
  });
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  void mountPhase0Ui();
}
