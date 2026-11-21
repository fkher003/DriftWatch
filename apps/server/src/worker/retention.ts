import type { Store } from "../db/store.js";

export interface RetentionPolicy {
  days: number;
  maxRows: number;
  batch: number;
}
const histories = [
  {
    table: "probe_results",
    time: "observed_at",
    keys: ["id"],
    eligible: "true",
  },
  {
    table: "stream_events",
    time: "created_at",
    keys: ["id"],
    eligible: "true",
  },
  {
    table: "alert_deliveries",
    time: "created_at",
    keys: ["incident_id", "transition"],
    eligible: "true",
  },
  {
    table: "incidents",
    time: "resolved_at",
    keys: ["id"],
    eligible: "status='RESOLVED'",
  },
] as const;

// Table and column names come exclusively from the fixed list above.
// Each transaction removes at most one batch per history. Preserve the newest maxRows
// even when many rows share the same timestamp by ordering on their unique keys.
export async function sweep(store: Store, policy: RetentionPolicy) {
  return store.transaction(async (client) => {
    const lock = await client.query(
      "SELECT pg_try_advisory_xact_lock(8341298) AS acquired",
    );
    if (!lock.rows[0].acquired) return 0;
    let count = 0;
    for (const { table, time, keys, eligible } of histories) {
      const columns = [time, ...keys];
      const order = columns.map((column) => column + " DESC").join(",");
      const tuple = columns.join(",");
      const result = await client.query(
        `
        WITH cutoff AS (
          SELECT ${tuple} FROM ${table} WHERE ${eligible} ORDER BY ${order} OFFSET $2 LIMIT 1
        ), expired AS (
          SELECT ctid FROM ${table} WHERE ${eligible} AND (
            ${time}<now()-$1::int*interval '1 day' OR (${tuple})<(SELECT ${tuple} FROM cutoff)
          ) ORDER BY ${tuple} LIMIT $3 FOR UPDATE SKIP LOCKED
        ) DELETE FROM ${table} h USING expired WHERE h.ctid=expired.ctid`,
        [policy.days, policy.maxRows - 1, policy.batch],
      );
      count += result.rowCount ?? 0;
    }
    await client.query(
      "DELETE FROM demo_sessions WHERE id IN (SELECT id FROM demo_sessions WHERE expires_at<=now() ORDER BY expires_at LIMIT 8 FOR UPDATE SKIP LOCKED)",
    );
    return count;
  });
}

export function startRetention(
  store: Store,
  policy: RetentionPolicy,
  report: (error: unknown) => void,
) {
  let stopped = false,
    timer: NodeJS.Timeout | undefined,
    running: Promise<void> | undefined;
  function tick() {
    running = sweep(store, policy).then(
      (n) => {
        schedule(n >= policy.batch ? 1000 : 60000);
      },
      (error) => {
        report(error);
        schedule(60000);
      },
    );
  }
  function schedule(delay: number) {
    if (!stopped) timer = setTimeout(tick, delay);
  }
  schedule(0);
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}
