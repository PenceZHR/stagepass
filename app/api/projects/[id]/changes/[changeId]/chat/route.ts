import { NextResponse } from "next/server";
import { z } from "zod";
import { refineTurn } from "@/server/services/refine-service";
import { requireProjectChange } from "../route-guard";

const ChatBody = z.object({
  message: z.string().min(1),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  try {
    const guard = await requireProjectChange(projectId, changeId);
    if (guard.response) return guard.response;
    const body = await request.json();
    const parsed = ChatBody.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const result = await refineTurn(projectId, changeId, parsed.data.message);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
