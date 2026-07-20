import { NextResponse } from "next/server";
import type { Change } from "@/server/types";
import { getChangeForProject } from "@/server/services/change-service";

type ProjectChangeGuard =
  | { change: Change; response?: never }
  | { change?: never; response: NextResponse };

export async function requireProjectChange(
  projectId: string,
  changeId: string
): Promise<ProjectChangeGuard> {
  const change = await getChangeForProject(projectId, changeId);
  if (!change) {
    return {
      response: NextResponse.json({ error: "Change not found" }, { status: 404 }),
    };
  }
  return { change };
}
