import { NextRequest, NextResponse } from "next/server";
import {
  startPrd,
  prdTurn,
  getPrdStatus,
  getPrdHistory,
  saveStructuredPrd,
  PrdTurnFailedError,
} from "@/server/services/prd-service";
import { updateProjectProviders } from "@/server/services/project-service";
import { PrdActionInput } from "@/server/types";
import { StructuredPrdSchema } from "@/server/types/prd";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const result = await getPrdStatus(id);
    const history = getPrdHistory(id);
    return NextResponse.json({ ...result, history });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const parsed = PrdActionInput.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { action, message, prd, provider, saveAsDefault } = parsed.data;

  try {
    if (saveAsDefault && provider) {
      await updateProjectProviders(id, { prdProvider: provider });
    }

    if (action === "start") {
      await startPrd(id);
      return NextResponse.json({ ok: true });
    }

    if (action === "turn") {
      if (!message || typeof message !== "string") {
        return NextResponse.json({ error: "message is required" }, { status: 400 });
      }
      const result = await prdTurn(id, message, provider);
      return NextResponse.json(result);
    }

    if (action === "save") {
      const parsed = StructuredPrdSchema.safeParse(prd);
      if (!parsed.success) {
        return NextResponse.json(
          { error: "Invalid PRD structure", details: parsed.error.issues },
          { status: 400 }
        );
      }
      await saveStructuredPrd(id, parsed.data);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err: unknown) {
    if (err instanceof PrdTurnFailedError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode || 502 });
    }
    const message_ = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message_ }, { status: 400 });
  }
}
