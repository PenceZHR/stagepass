import { NextResponse } from "next/server";

import { TECH_SPEC_DELEGATED_ROUND } from "@/server/services/delegated-round-phases";
import { handleDelegatedNextRoundRequest } from "@/server/services/delegated-round-next-round-route";
import type { DelegatedPhaseDescriptor } from "@/server/services/pipeline-delegated-phase-stage";
import { requireProjectChange } from "../../route-guard";
import {
  actionPreflightErrorResponse,
  assertRequestActionAllowed,
  assertRequestProviderNotApplicable,
} from "../../action-preflight";

/**
 * Starts another adversarial TechSpec round on a settled one.
 *
 * The counterpart of `/spec-battle/next-round`, one phase over. Without a route
 * the action would have a contract entry, an availability rule computed on every
 * request, and no way to be clicked -- `selectRoutableStageRunActions` hides
 * anything unroutable, so the next round would be unreachable from the web.
 *
 * All the logic is shared (delegated-round-next-round-route.ts); this file exists
 * because Next.js routes are files.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> },
): Promise<NextResponse> {
  const { id: projectId, changeId } = await params;
  return handleDelegatedNextRoundRequest({
    request,
    projectId,
    changeId,
    actionId: "request_tech_spec_changes",
    descriptor: TECH_SPEC_DELEGATED_ROUND as DelegatedPhaseDescriptor,
    requireProjectChange,
    assertRequestProviderNotApplicable,
    assertRequestActionAllowed,
    actionPreflightErrorResponse,
  });
}
