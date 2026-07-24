import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/server/db";
import { events } from "@/server/db/schema";
import { advanceStreamCursor } from "@/server/services/change-event-stream-cursor";
import { requireProjectChange } from "../../route-guard";

/**
 * SQLite's bound-parameter ceiling is far higher than this, but a poll that
 * found thousands of new rows at once would build one enormous statement for no
 * gain; the steady state is a handful of ids.
 */
const ID_FETCH_CHUNK = 500;

function readEventsByIds(ids: string[]): Map<string, typeof events.$inferSelect> {
  const byId = new Map<string, typeof events.$inferSelect>();
  for (let start = 0; start < ids.length; start += ID_FETCH_CHUNK) {
    const chunk = ids.slice(start, start + ID_FETCH_CHUNK);
    for (const row of db.select().from(events).where(inArray(events.id, chunk)).all()) {
      byId.set(row.id, row);
    }
  }
  return byId;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  const guard = await requireProjectChange(projectId, changeId);
  if (guard.response) return guard.response;

  const encoder = new TextEncoder();
  let closed = false;
  let cleanedUp = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  let keepAlive: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const closeStream = (error?: unknown) => {
        if (cleanedUp) return;
        cleanedUp = true;
        closed = true;
        if (interval) clearInterval(interval);
        if (keepAlive) clearInterval(keepAlive);
        if (error) {
          console.error("Change event stream failed", error);
        }
        try {
          controller.close();
        } catch {}
      };

      // Send existing events first. The explicit order matters: without it
      // SQLite is free to return rows however the chosen plan produces them,
      // and idx_events_change_created_id makes an index scan the likely plan,
      // so replay order would quietly stop matching insertion order.
      const existing = db
        .select()
        .from(events)
        .where(eq(events.changeId, changeId))
        .orderBy(asc(events.createdAt), asc(events.id))
        .all();

      for (const evt of existing) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(evt)}\n\n`)
        );
      }

      // Track which events were sent, not how many. See
      // change-event-stream-cursor.ts for why a count (or a (created_at, id)
      // comparison) loses events here.
      let delivered = new Set(existing.map((evt) => evt.id));
      interval = setInterval(() => {
        try {
          if (closed) {
            closeStream();
            return;
          }
          // Ids only -- idx_events_change_created_id covers this, so the poll
          // never touches the table and never re-reads raw_json.
          const currentIds = db
            .select({ id: events.id })
            .from(events)
            .where(eq(events.changeId, changeId))
            .orderBy(asc(events.createdAt), asc(events.id))
            .all()
            .map((row) => row.id);

          const { newIds, nextDelivered } = advanceStreamCursor(currentIds, delivered);
          if (newIds.length > 0) {
            const byId = readEventsByIds(newIds);
            for (const id of newIds) {
              const evt = byId.get(id);
              // A row deleted between the id scan and this read has nothing to
              // send; leaving it out of `delivered` lets a re-created id
              // through on a later poll.
              if (!evt) {
                nextDelivered.delete(id);
                continue;
              }
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(evt)}\n\n`)
              );
            }
          }
          // Assigned every poll, not only when something new arrived: this is
          // what drops deleted ids and keeps the cursor from growing for the
          // life of the connection.
          delivered = nextDelivered;
        } catch (err) {
          closeStream(err);
        }
      }, 2000);

      // Keep alive
      keepAlive = setInterval(() => {
        try {
          if (closed) {
            closeStream();
            return;
          }
          controller.enqueue(encoder.encode(`: keepalive\n\n`));
        } catch (err) {
          closeStream(err);
        }
      }, 15000);
    },
    cancel() {
      closed = true;
      if (interval) clearInterval(interval);
      if (keepAlive) clearInterval(keepAlive);
      cleanedUp = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
