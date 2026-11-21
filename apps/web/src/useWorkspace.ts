import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./client.js";
import { nextCursor } from "./display.js";
import type { Workspace, StreamEvent } from "@driftwatch/shared";

export function useWorkspace() {
  const [data, set] = useState<Workspace>(),
    [connection, connect] = useState<
      "Connecting" | "Live" | "Reconnecting" | "Offline"
    >("Connecting");
  const [error, fail] = useState(""),
    [attempt, retry] = useState(0);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let closed = false,
      source: EventSource | undefined,
      pending = false,
      running: Promise<void> | undefined,
      cursor = "0";
    const refresh = () => {
      pending = true;
      if (!running)
        running = (async () => {
          while (pending && !closed) {
            pending = false;
            try {
              const snapshot = await api.workspace();
              if (!closed) {
                set(snapshot);
                fail("");
              }
            } catch (e) {
              if (!closed) {
                fail(e instanceof Error ? e.message : "Workspace unavailable");
                if (e instanceof ApiError && e.status === 401) {
                  source?.close();
                  connect("Offline");
                }
              }
            }
          }
        })().finally(() => {
          running = undefined;
        });
      return running;
    };
    refreshRef.current = refresh;
    connect("Connecting");
    fail("");
    void api
      .session()
      .then((snapshot) => {
        if (closed) return;
        set(snapshot);
        source = new EventSource("/api/events/stream?demo=1");
        source.onopen = () => {
          if (!closed) {
            cursor = "0";
            connect("Live");
            void refresh();
          }
        };
        source.onerror = () => {
          if (!closed) {
            connect("Reconnecting");
            void refresh();
          }
        };
        const event = (e: MessageEvent<string>) => {
          const next = nextCursor(cursor, e.lastEventId);
          if (next === cursor) return;
          cursor = next;
          void refresh();
        };
        for (const name of [
          "probe",
          "incident",
          "status",
        ] satisfies StreamEvent["type"][])
          source.addEventListener(name, event);
      })
      .catch((e) => {
        if (!closed) {
          connect("Offline");
          fail(e.message);
        }
      });
    return () => {
      closed = true;
      source?.close();
    };
  }, [attempt]);
  return {
    data,
    connection,
    error,
    retry: () => retry((n) => n + 1),
    refresh: useCallback(() => refreshRef.current(), []),
  };
}
