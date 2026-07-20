import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import { events } from "@/server/db/schema";
import { requireProjectChange } from "../route-guard";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  const guard = await requireProjectChange(projectId, changeId);
  if (guard.response) return guard.response;
  const list = db
    .select()
    .from(events)
    .where(eq(events.changeId, changeId))
    .all();
  return NextResponse.json(list);
}
