import { NextRequest, NextResponse } from "next/server";
import { upgradePrd } from "@/server/services/prd-service";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const structured = await upgradePrd(id);
    return NextResponse.json({ ok: true, structured });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
