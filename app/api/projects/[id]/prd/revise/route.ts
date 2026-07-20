import { NextRequest, NextResponse } from "next/server";
import { startPrdRevision } from "@/server/services/prd-service";
import { updateProjectProviders } from "@/server/services/project-service";
import { ProviderSelectionInput } from "@/server/types";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = ProviderSelectionInput.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    if (parsed.data.saveAsDefault && parsed.data.provider) {
      await updateProjectProviders(id, { prdProvider: parsed.data.provider });
    }
    await startPrdRevision(id);
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
