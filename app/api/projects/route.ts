import { NextResponse } from "next/server";
import { CreateProjectInput } from "@/server/types";
import { createProject, listProjects } from "@/server/services/project-service";

export async function GET() {
  const projects = await listProjects();
  return NextResponse.json(projects);
}

export async function POST(request: Request) {
  const body = await request.json();
  const parsed = CreateProjectInput.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const project = await createProject(parsed.data);
    return NextResponse.json(project, { status: 201 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.startsWith("Path does not exist:") ? 400 : 409;
    return NextResponse.json({ error: message }, { status });
  }
}
