import { NextResponse } from "next/server";

import { createChildLogger } from "@/server/logger";
import {
  GateDecisionCardError,
  openGateDecisionCard,
  type GateDecisionCard,
} from "@/server/services/gate-decision-card-service";

const log = createChildLogger("gate-decision-card");

/**
 * Opens a server-created gate decision card for the Codex plugin to render.
 *
 * POST, not GET: presenting the card moves the interaction `pending ->
 * presented`, and a route that writes must say so in its method.
 *
 * There is no auth here, matching the receipt route it feeds
 * (`/api/codex/card-choice-receipts`) and the trust model that actually runs:
 * anything that can reach localhost can open a card. That is a read of state
 * plus one status flip -- it cannot execute a decision. The only route that can
 * move a gate remains the receipt route, which verifies the logical turn,
 * binding and thread this card hands out.
 */
export interface GateDecisionCardRouteDependencies {
  open(interactionId: string): GateDecisionCard;
}

const defaultDependencies: GateDecisionCardRouteDependencies = {
  open: (interactionId) => openGateDecisionCard(interactionId),
};

export async function handleGateDecisionCardOpen(
  interactionId: string,
  dependencies: GateDecisionCardRouteDependencies = defaultDependencies,
  request?: Request,
): Promise<NextResponse> {
  // Same guard the receipt route carries, for the same reason. Opening a card
  // moves it to `presented`, and `presented` is the record that a human was
  // shown this decision. A page in a browser must not be able to write that
  // about a card nobody saw.
  if (request?.headers.get("origin")) {
    return NextResponse.json(
      { error: "gate_decision_card_browser_origin_forbidden" },
      { status: 403 },
    );
  }
  try {
    return NextResponse.json(dependencies.open(interactionId));
  } catch (error) {
    if (error instanceof GateDecisionCardError) {
      return NextResponse.json(
        { error: error.code, detail: error.message },
        { status: error.status },
      );
    }
    // Name the underlying failure rather than letting the plugin turn an
    // unclassified 500 into 「提交失败，请重试」 on a card that was never shown.
    log.error(
      { err: error, interactionId },
      "Opening the gate decision card failed outside the classified errors",
    );
    return NextResponse.json(
      {
        error: "gate_decision_card_open_failed",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ interactionId: string }> },
) {
  return handleGateDecisionCardOpen(
    (await params).interactionId,
    defaultDependencies,
    request,
  );
}
