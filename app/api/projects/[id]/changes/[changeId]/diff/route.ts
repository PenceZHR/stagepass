import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { db } from "@/server/db";
import { projects } from "@/server/db/schema";
import { requireProjectChange } from "../route-guard";

type DiffItem = { file: string; diff: string; isNew: boolean };

function toSafeRelativePath(file: unknown, repoPath: string): string | null {
  if (typeof file !== "string" || file.trim() === "" || file.includes("\0")) {
    return null;
  }
  if (path.isAbsolute(file)) {
    return null;
  }

  const normalized = path.normalize(file);
  if (normalized === "." || normalized.startsWith("..") || path.isAbsolute(normalized)) {
    return null;
  }

  const repoRoot = path.resolve(repoPath);
  const absolute = path.resolve(repoRoot, normalized);
  const relative = path.relative(repoRoot, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  return relative;
}

function readChangedFiles(changedFilesPath: string, repoPath: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(changedFilesPath, "utf-8"));
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) {
    return null;
  }

  const files: string[] = [];
  for (const file of parsed) {
    const safePath = toSafeRelativePath(file, repoPath);
    if (!safePath) {
      return null;
    }
    files.push(safePath);
  }
  return files;
}

function readRepoFile(repoPath: string, relativePath: string): string {
  const repoRoot = fs.realpathSync(repoPath);
  const absolutePath = path.resolve(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    return "";
  }

  const stat = fs.lstatSync(absolutePath);
  if (!stat.isFile()) {
    return "";
  }

  const realPath = fs.realpathSync(absolutePath);
  const relativeRealPath = path.relative(repoRoot, realPath);
  if (relativeRealPath.startsWith("..") || path.isAbsolute(relativeRealPath)) {
    throw new Error("Invalid changed file path");
  }

  return fs.readFileSync(realPath, "utf-8");
}

function newFileDiff(file: string, content: string): DiffItem {
  return {
    file,
    diff: `+++ ${file}\n` + content.split("\n").map((line) => `+ ${line}`).join("\n"),
    isNew: true,
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  const guard = await requireProjectChange(projectId, changeId);
  if (guard.response) return guard.response;

  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const changedFilesPath = path.join(
    project.repoPath,
    ".ship",
    "changes",
    changeId,
    "changed-files.json"
  );

  if (!fs.existsSync(changedFilesPath)) {
    return NextResponse.json({ files: [] });
  }

  const changedFiles = readChangedFiles(changedFilesPath, project.repoPath);
  if (!changedFiles) {
    return NextResponse.json({ error: "Invalid changed-files.json" }, { status: 400 });
  }

  const diffs: DiffItem[] = [];

  for (const file of changedFiles) {
    try {
      const diff = execFileSync("git", ["diff", "HEAD", "--", file], {
        cwd: project.repoPath,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10000,
      });

      if (diff.trim()) {
        diffs.push({ file, diff, isNew: false });
      } else {
        const content = readRepoFile(project.repoPath, file);
        diffs.push(newFileDiff(file, content));
      }
    } catch (err) {
      if (err instanceof Error && err.message === "Invalid changed file path") {
        return NextResponse.json({ error: "Invalid changed-files.json" }, { status: 400 });
      }
      // Not a git repo or file not found — show content as new
      try {
        const content = readRepoFile(project.repoPath, file);
        diffs.push(newFileDiff(file, content));
      } catch (fallbackErr) {
        if (fallbackErr instanceof Error && fallbackErr.message === "Invalid changed file path") {
          return NextResponse.json({ error: "Invalid changed-files.json" }, { status: 400 });
        }
        throw fallbackErr;
      }
    }
  }

  return NextResponse.json({ files: diffs });
}
