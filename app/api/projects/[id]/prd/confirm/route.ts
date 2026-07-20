import { NextRequest, NextResponse } from "next/server";
import { confirmPrd, confirmPrdRevision } from "@/server/services/prd-service";
import { getProject } from "@/server/services/project-service";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const project = await getProject(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    const result = project.prdStatus === "revising"
      ? await confirmPrdRevision(id)
      : await confirmPrd(id);

    if (!result.valid) {
      return NextResponse.json({ ok: false, validation: result }, { status: 422 });
    }

    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
