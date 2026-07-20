import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import { events } from "@/server/db/schema";
import { requireProjectChange } from "../../route-guard";

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

      // Send existing events first
      const existing = db
        .select()
        .from(events)
        .where(eq(events.changeId, changeId))
        .all();

      for (const evt of existing) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(evt)}\n\n`)
        );
      }

      // Poll for new events every 2 seconds
      let lastCount = existing.length;
      interval = setInterval(() => {
        try {
          if (closed) {
            closeStream();
            return;
          }
          const all = db
            .select()
            .from(events)
            .where(eq(events.changeId, changeId))
            .all();

          if (all.length > lastCount) {
            const newEvents = all.slice(lastCount);
            for (const evt of newEvents) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(evt)}\n\n`)
              );
            }
            lastCount = all.length;
          }
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
