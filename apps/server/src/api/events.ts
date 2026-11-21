import type { FastifyInstance } from "fastify";
import type { ServerResponse } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import type { Store } from "../db/store.js";
import { HttpError } from "../db/store.js";
import type { StreamEvent } from "@driftwatch/contracts";
import { sessionId } from "./demo.js";

export function registerStream(app: FastifyInstance, getStore: () => Store) {
  const clients = new Set<ServerResponse>();
  app.addHook("preClose", async () => {
    for (const client of clients) client.end();
  });
  app.get("/events/stream", async (req, reply) => {
    const db = getStore();
    const scope =
      (req.query as { demo?: string }).demo === "1"
        ? await sessionId(req, db)
        : null;
    if (clients.size >= 64)
      throw new HttpError(429, "Stream capacity exhausted");
    const last = req.headers["last-event-id"];
    if (
      last !== undefined &&
      (typeof last !== "string" ||
        !/^\d{1,19}$/.test(last) ||
        BigInt(last) > 9223372036854775807n)
    )
      throw new HttpError(400, "Invalid event cursor");
    const highWater = (
      await db.pool.query<{ id: string }>(
        "SELECT coalesce(max(id),0)::text AS id FROM stream_events",
      )
    ).rows[0]!.id;
    // A restored database can have a lower sequence than the browser's previous cursor.
    let cursor =
      last !== undefined && BigInt(last) <= BigInt(highWater)
        ? last
        : highWater;
    const out = reply.raw;
    reply.hijack();
    for (const [name, value] of Object.entries(reply.getHeaders()))
      if (value !== undefined) out.setHeader(name, value);
    out.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    });
    clients.add(out);
    const stop = new AbortController();
    out.once("close", () => {
      clients.delete(out);
      stop.abort();
    });
    out.write(": connected\n\n");
    let beat = Date.now();
    try {
      while (!stop.signal.aborted && !out.writableEnded) {
        const { rows } = await db.pool.query<{
          id: string;
          event: StreamEvent;
        }>(
          `SELECT e.id,e.event FROM stream_events e JOIN monitors m ON m.id=e.monitor_id
           WHERE e.id>$1 AND m.demo_session IS NOT DISTINCT FROM $2::uuid ORDER BY e.id LIMIT 64`,
          [cursor, scope],
        );
        for (const { id, event } of rows) {
          if (
            !out.write(
              "id: " +
                id +
                "\nevent: " +
                event.type +
                "\ndata: " +
                JSON.stringify(event.data) +
                "\n\n",
            )
          ) {
            await once(out, "drain", {
              signal: AbortSignal.any([stop.signal, AbortSignal.timeout(5000)]),
            });
          }
          cursor = id;
        }
        if (Date.now() - beat >= 15000) {
          if (
            scope &&
            !(
              await db.pool.query(
                "SELECT 1 FROM demo_sessions WHERE id=$1 AND expires_at>now()",
                [scope],
              )
            ).rowCount
          )
            break;
          out.write(": heartbeat\n\n");
          beat = Date.now();
        }
        if (rows.length < 64)
          await delay(300, undefined, { signal: stop.signal });
      }
    } catch (err) {
      if (!stop.signal.aborted) req.log.error(err);
    } finally {
      clients.delete(out);
      out.end();
    }
  });
}
