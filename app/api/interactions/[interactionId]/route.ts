import { NextResponse } from "next/server";

import { db } from "@/server/db";
import { createCodexInteractionRepository } from "@/server/repositories/codex-interaction-repository";
import { publicInteractionEnvelope } from "@/server/services/mcp-presentation-auth-service";

export interface PublicInteractionRouteDependencies {
  getInteraction: ReturnType<
    typeof createCodexInteractionRepository
  >["getInteraction"];
}

const defaultDependencies: PublicInteractionRouteDependencies = {
  getInteraction: createCodexInteractionRepository(db).getInteraction.bind(
    createCodexInteractionRepository(db),
  ),
};

export async function handlePublicInteractionGet(
  interactionId: string,
  dependencies: PublicInteractionRouteDependencies = defaultDependencies,
): Promise<NextResponse> {
  const interaction = dependencies.getInteraction(interactionId);
  if (!interaction) {
    return NextResponse.json(
      { error: "interaction_not_found" },
      { status: 404 },
    );
  }
  return NextResponse.json(publicInteractionEnvelope(interaction));
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ interactionId: string }> },
) {
  return handlePublicInteractionGet((await params).interactionId);
}
