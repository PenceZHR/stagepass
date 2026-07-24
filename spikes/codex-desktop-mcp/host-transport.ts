import type {
  Phase0AuthorizedHostDispatch,
} from "./supervisor";

/**
 * Platform boundary evidence for the workspace-locked
 * `@modelcontextprotocol/ext-apps@1.7.4` API:
 *
 * - `dist/src/app.d.ts` exposes `App.sendMessage()` on the view-side App.
 * - `dist/src/spec.types.d.ts` describes the Host capability as receiving
 *   `ui/message` content from the view.
 *
 * There is no MCP Server/supervisor API that directly emits `ui/message`.
 * Consequently this view-owned adapter is the sole Host transport endpoint:
 * business code obtains a one-shot signed dispatch from the private Server
 * tool, this adapter calls App.sendMessage, then the protected ack path lets
 * durable recovery settle or reconcile the dispatch.
 */
export const MCP_EXT_APPS_HOST_TRANSPORT_EVIDENCE = {
  packageVersion: "1.7.4",
  viewApi: "App.sendMessage",
  hostCapability: "receiving content messages (ui/message) from the view",
} as const;

export interface Phase0HostMessageClient {
  sendMessage(input: {
    role: "user";
    content: Array<{ type: "text"; text: string }>;
  }): Promise<{ isError?: boolean }>;
  callServerTool(input: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{ isError?: boolean }>;
}

export function createPhase0HostTransport(client: Phase0HostMessageClient) {
  const acknowledged = new Set<string>();
  return {
    async deliver(dispatch: Phase0AuthorizedHostDispatch): Promise<void> {
      if (acknowledged.has(dispatch.authorizationTag)) return;
      const expected = [
        "STAGEPASS_PHASE0_WAKEUP",
        dispatch.threadId,
        dispatch.nonceId,
        dispatch.wakeupJobId,
        dispatch.wakeupAttemptId,
      ].join(" ");
      if (
        dispatch.markerMessage !== expected
        || !/^[0-9a-f-]{36}$/i.test(dispatch.nonceId)
        || !/^[0-9a-f-]{36}$/i.test(dispatch.wakeupJobId)
        || !/^[0-9a-f-]{36}$/i.test(dispatch.wakeupAttemptId)
        || dispatch.expiresAt <= Date.now()
        || !/^[A-Za-z0-9_-]{32,}$/.test(dispatch.authorizationTag)
      ) {
        throw new Error("authorized Host wake dispatch is invalid");
      }
      const result = await client.sendMessage({
        role: "user",
        content: [{ type: "text", text: dispatch.markerMessage }],
      });
      if (result.isError) {
        throw new Error("authorized Host ui/message was rejected");
      }
      const ack = await client.callServerTool({
        name: "submit_phase0_card",
        arguments: { action: "ack", ...dispatch },
      });
      if (ack.isError) {
        throw new Error("protected Host dispatch acknowledgement was rejected");
      }
      acknowledged.add(dispatch.authorizationTag);
    },
  };
}
