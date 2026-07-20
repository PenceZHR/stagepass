import { NextResponse } from "next/server";
import { z } from "zod";
import { AiProvider } from "@/server/types/enums";
import {
  createChange,
  listChangesByProject,
} from "@/server/services/change-service";

const CreateChangeBody = z.object({
  title: z.string().min(1),
  specMarkdown: z.string().optional(),
  provider: AiProvider.default("codex"),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const list = await listChangesByProject(id);
  return NextResponse.json(list);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  const parsed = CreateChangeBody.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const change = await createChange({
      projectId: id,
      title: parsed.data.title,
      specMarkdown: parsed.data.specMarkdown,
      provider: parsed.data.provider,
    });
    return NextResponse.json(change, { status: 201 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
