import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { db } from "@/server/db";
import { projects } from "@/server/db/schema";
import { requireProjectChange } from "../route-guard";
import {
  resolveChangeFilePath,
  type ResolveChangeFileError,
} from "@/server/services/change-file-access";

/** View cap so a huge generated file can't blow up the response/browser. */
const MAX_BYTES = 1_000_000;

const ERROR_STATUS: Record<ResolveChangeFileError, number> = {
  invalid_input: 400,
  not_found: 404,
  outside_repo: 403,
  not_a_file: 400,
};

/**
 * GET ?path=<repo-relative-or-absolute>
 *
 * Serves the content of a produced file that lives inside the project repo, so
 * the pipeline UI can make path-only file references clickable (the sibling
 * artifacts/[artifactId]/content route already covers id-keyed artifacts). All
 * path safety is delegated to resolveChangeFilePath — reads are confined to repoPath.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> },
) {
  const { id: projectId, changeId } = await params;
  const guard = await requireProjectChange(projectId, changeId);
  if (guard.response) return guard.response;

  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const inputPath = new URL(request.url).searchParams.get("path");
  const resolved = resolveChangeFilePath(inputPath, project.repoPath);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: ERROR_STATUS[resolved.error] });
  }

  const { absolutePath, relativePath } = resolved.file;
  const size = fs.statSync(absolutePath).size;
  const truncated = size > MAX_BYTES;

  let content: string;
  if (truncated) {
    const fd = fs.openSync(absolutePath, "r");
    try {
      const buf = Buffer.alloc(MAX_BYTES);
      const bytes = fs.readSync(fd, buf, 0, MAX_BYTES, 0);
      content = buf.subarray(0, bytes).toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } else {
    content = fs.readFileSync(absolutePath, "utf-8");
  }

  const mimeType = path.extname(absolutePath).toLowerCase() === ".json"
    ? "application/json"
    : "text/plain";

  return NextResponse.json({
    content,
    mimeType,
    path: relativePath,
    name: path.basename(relativePath),
    truncated,
  });
}
