import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * The Codex-native surface for StagePass gate decisions.
 *
 * ## Why this plugin exists
 *
 * A settled design round produces a decision only a human can make: approve the
 * gate, reject it, waive a P1, or send it back for another adversarial round.
 * The web deliberately refuses to route those (NON_POST_ROUTED_ACTION_IDS) on
 * the grounds that they belong on the Codex decision surface -- and nothing was
 * ever built on that surface, so the decision existed on neither. Changes sat at
 * SPEC_READY with one button that did not move them forward.
 *
 * ## Why it points at the repo instead of bundling a copy
 *
 * `cwd` is the stagepass checkout and the entry is a path inside it, so this
 * server IS the repo's code, always. The plugin that shipped before this one
 * (`stagepass-ui-spike`) was a frozen snapshot from 2026-07-23: the repo grew
 * `present_stagepass_interaction`, the installed bundle never did, and the model
 * correctly reported the tool did not exist while the repo insisted it did.
 * A plugin that can go stale relative to the server it speaks for will.
 *
 * ## What this deliberately does NOT do
 *
 * It never decides. The present tool returns the decision and its legal options
 * and stops; the record tool refuses any action the change's own action contract
 * has not enabled, so a stale card cannot push a verdict the pipeline would have
 * rejected. The contract is re-read at record time rather than trusted from the
 * card, because the two are separated by however long the human took to think.
 *
 * ## Trust model, stated out loud
 *
 * Plain localhost HTTP, no signature -- the same model the working
 * `stagepass-card` plugin uses (`POST /api/codex/card-choice-receipts`, no auth
 * of any kind). The repo also contains a host-attested MCP path that requires a
 * broker FD and a `com.openai.codex` bundle check; it has never been deployed,
 * and a Codex plugin manifest has nowhere to supply either. So this matches what
 * actually runs rather than what was designed, and the gap is a known
 * limitation: anything that can reach localhost:3000 can record a verdict.
 */

const BASE_URL = process.env.STAGEPASS_API_BASE_URL ?? "http://127.0.0.1:3000";

async function api(path, init) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 400) };
  }
  return { ok: response.ok, status: response.status, body };
}

function textResult(value) {
  return { content: [{ type: "text", text: value }] };
}

/** The change this interaction belongs to, needed to reach its action contract. */
async function resolveChange(interactionId) {
  const read = await api(`/api/interactions/${encodeURIComponent(interactionId)}`);
  if (!read.ok) {
    throw new Error(
      read.status === 404
        ? `No StagePass interaction with id ${interactionId}`
        : `StagePass returned ${read.status} for interaction ${interactionId}`,
    );
  }
  return read.body;
}

async function liveContract(projectId, changeId) {
  const gate = await api(
    `/api/projects/${encodeURIComponent(projectId)}/changes/${encodeURIComponent(changeId)}/gate`,
  );
  if (!gate.ok) throw new Error(`StagePass returned ${gate.status} for the action contract`);
  return Array.isArray(gate.body?.actions) ? gate.body.actions : [];
}

const server = new McpServer({ name: "stagepass-gate", version: "0.1.0" });

server.registerTool(
  "present_stagepass_interaction",
  {
    title: "Show a StagePass gate decision",
    description:
      "Read a pending StagePass interaction and show the human what has to be decided. "
      + "Never chooses; returns the decision and the options that are currently legal.",
    inputSchema: { interactionId: z.string().min(1) },
    annotations: { readOnlyHint: true },
  },
  async ({ interactionId }) => {
    const interaction = await resolveChange(interactionId);
    const actions = await liveContract(interaction.projectId, interaction.changeId);
    const offered = (interaction.actionIds ?? []).map((actionId) => {
      const live = actions.find((action) => action.actionId === actionId);
      return {
        actionId,
        label: live?.label ?? actionId,
        // Recomputed rather than taken from the card: the human has been
        // thinking, and the contract may have moved while they did.
        available: Boolean(live?.enabled),
        unavailableBecause: live?.enabled ? null : live?.reasonCode ?? "unknown",
      };
    });

    return textResult(JSON.stringify({
      interactionId,
      changeId: interaction.changeId,
      phase: interaction.phase,
      title: interaction.title,
      summary: interaction.summary,
      blockers: interaction.payload?.blockers ?? [],
      openGaps: interaction.payload?.openGaps ?? [],
      options: offered,
      instruction:
        "Show these options to the human and stop. Do not pick one, and do not "
        + "describe a decision as made -- record_stagepass_gate_decision is the only "
        + "thing that makes a decision real, and only the human may ask for it.",
    }, null, 2));
  },
);

server.registerTool(
  "record_stagepass_gate_decision",
  {
    title: "Record the human's StagePass gate decision",
    description:
      "Submit the decision the HUMAN chose. Call only after they have said which option they want.",
    inputSchema: {
      interactionId: z.string().min(1),
      actionId: z.string().min(1),
      reason: z.string().optional(),
    },
  },
  async ({ interactionId, actionId, reason }) => {
    const interaction = await resolveChange(interactionId);
    if (!(interaction.actionIds ?? []).includes(actionId)) {
      throw new Error(
        `${actionId} is not one of this decision's options (${(interaction.actionIds ?? []).join(", ")})`,
      );
    }
    const actions = await liveContract(interaction.projectId, interaction.changeId);
    const live = actions.find((action) => action.actionId === actionId);
    // The card is a snapshot; the contract is the authority. Submitting against
    // a moved gate is what `gate_version_drift` exists to refuse, and refusing
    // here gives the human a sentence instead of a stack trace.
    if (!live?.enabled) {
      throw new Error(
        `${actionId} is no longer available: ${live?.reasonCode ?? "not in the current contract"}. `
        + "The gate moved while this card was open; ask StagePass for the current decision.",
      );
    }

    const submitted = await api(
      `/api/projects/${encodeURIComponent(interaction.projectId)}`
      + `/changes/${encodeURIComponent(interaction.changeId)}/commands`,
      {
        method: "POST",
        body: JSON.stringify({
          actionId,
          reason: reason ?? null,
          interactionId,
          expectedGateVersion: live.gateVersion,
          expectedSourceDbHash: live.sourceDbHash,
          idempotencyKey: `gate-decision:${interactionId}:${actionId}`,
        }),
      },
    );
    if (!submitted.ok) {
      throw new Error(
        `StagePass refused the decision (${submitted.status}): ${JSON.stringify(submitted.body)}`,
      );
    }
    return textResult(JSON.stringify({
      recorded: true,
      actionId,
      changeId: interaction.changeId,
      result: submitted.body,
    }, null, 2));
  },
);

await server.connect(new StdioServerTransport());
