import { NextResponse } from "next/server";
import { getProject } from "@/server/services/project-service";
import fs from "fs";
import path from "path";

const ALLOWED_DOCS = ["architecture.md", "coding-rules.md", "tech-stack.md", "file-guide.md"];

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; docName: string }> }
) {
  const { id, docName } = await params;

  if (!ALLOWED_DOCS.includes(docName)) {
    return NextResponse.json({ error: "Invalid document name" }, { status: 400 });
  }

  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const body = await request.json();
  const content = body.content;

  if (typeof content !== "string") {
    return NextResponse.json({ error: "content must be a string" }, { status: 400 });
  }

  const shipDir = path.join(project.repoPath, ".ship");
  const filePath = path.join(shipDir, docName);

  fs.mkdirSync(shipDir, { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");

  return NextResponse.json({ success: true });
}
