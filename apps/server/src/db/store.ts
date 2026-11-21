import pg from "pg";
import { readFileSync } from "node:fs";
import type {
  Monitor,
  MonitorInput,
  Scenario,
  Observation,
  StreamEvent,
  Latency,
} from "@driftwatch/contracts";
import { fingerprint } from "../engine/diff.js";
import { monitorInput, type monitorPatch } from "@driftwatch/contracts";
import type { z } from "zod";
const queryFile = (name: string) =>
  readFileSync(
    new URL("../../../../db/queries/" + name + ".sql", import.meta.url),
    "utf8",
  );
const claimSql = queryFile("claim"),
  latencySql = queryFile("latency");
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export interface Lease {
  monitor_id: string;
  lease_token: string;
}
interface Row {
  id: string;
  name: string;
  external_url: string | null;
  flow: "checkout" | "authenticated" | "orders";
  expected_schema: Monitor["expectedSchema"];
  interval_ms: number;
  latency_sla_ms: number;
  scenario: Scenario;
  status: Monitor["status"];
}
function monitor(r: Row): Monitor {
  return {
    id: r.id,
    name: r.name,
    target: r.external_url
      ? { kind: "external", url: r.external_url }
      : { kind: "sandbox", flow: r.flow },
    expectedSchema: r.expected_schema,
    intervalMs: r.interval_ms,
    latencySlaMs: r.latency_sla_ms,
    scenario: r.scenario,
    status: r.status,
  };
}
function values(m: MonitorInput) {
  return [
    m.name,
    m.target.kind === "external" ? m.target.url : null,
    m.target.kind === "sandbox" ? "healthy" : null,
    m.target.kind === "sandbox" ? m.target.flow : "checkout",
    m.expectedSchema,
    m.intervalMs,
    m.latencySlaMs,
  ];
}
export class Store {
  constructor(readonly pool: pg.Pool) {}
  async transaction<T>(fn: (c: pg.PoolClient) => Promise<T>) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
  }
  async list() {
    return (
      await this.pool.query<Row>(
        "SELECT * FROM monitors WHERE demo_session IS NULL ORDER BY created_at,id",
      )
    ).rows.map(monitor);
  }
  async get(id: string, c: pg.Pool | pg.PoolClient = this.pool, lock = false) {
    const row = (
      await c.query<Row>(
        "SELECT * FROM monitors WHERE id=$1" + (lock ? " FOR UPDATE" : ""),
        [id],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, "Monitor not found");
    return monitor(row);
  }
  async publicMonitor(id: string) {
    const { rows } = await this.pool.query<Row>(
      "SELECT * FROM monitors WHERE id=$1 AND demo_session IS NULL",
      [id],
    );
    if (!rows[0]) throw new HttpError(404, "Monitor not found");
    return monitor(rows[0]);
  }
  async create(input: MonitorInput, seedId?: string) {
    return this.transaction((c) => this.insertMonitor(c, input, seedId));
  }
  async insertMonitor(c: pg.PoolClient, input: MonitorInput, seedId?: string) {
    const { rows } = await c.query<Row>(
      `INSERT INTO monitors(name,external_url,sandbox_fault,flow,expected_schema,interval_ms,latency_sla_ms,id)
        VALUES($1,$2,$3,$4,$5,$6,$7,coalesce($8::uuid,gen_random_uuid())) ON CONFLICT(id) DO NOTHING RETURNING *`,
      [...values(input), seedId ?? null],
    );
    const m = rows[0] ? monitor(rows[0]) : await this.get(seedId!, c);
    await c.query(
      "INSERT INTO probe_jobs(monitor_id) VALUES($1) ON CONFLICT DO NOTHING",
      [m.id],
    );
    return m;
  }
  async update(
    id: string,
    patch: z.infer<typeof monitorPatch>,
    fault?: Scenario,
  ) {
    return this.transaction(async (c) => {
      const old = await this.get(id, c, true);
      const { id: _, status: __, scenario: ___, ...input } = old;
      const m = monitorInput.parse({ ...input, ...patch });
      if (fault && m.target.kind !== "sandbox")
        throw new HttpError(400, "Sandbox monitor required");
      const { rows } = await c.query<Row>(
        `UPDATE monitors SET name=$1,external_url=$2,sandbox_fault=$3,flow=$4,
        expected_schema=$5,interval_ms=$6,latency_sla_ms=$7,scenario=$8 WHERE id=$9 RETURNING *`,
        [...values(m), fault ?? old.scenario, id],
      );
      await c.query(
        "UPDATE probe_jobs SET lease_token=NULL,available_at=now()+$2::int*interval '1 ms' WHERE monitor_id=$1",
        [id,fault ? m.intervalMs : 0],
      );
      return monitor(rows[0]!);
    });
  }
  async remove(id: string) {
    if (
      !(await this.pool.query("DELETE FROM monitors WHERE id=$1", [id]))
        .rowCount
    )
      throw new HttpError(404, "Monitor not found");
  }
  async claim(limit: number) {
    return (await this.pool.query<Lease>(claimSql, [limit, 30000])).rows;
  }
  async manual(id: string) {
    await this.get(id);
    const { rows } = await this.pool.query<Lease>(
      `UPDATE probe_jobs SET lease_token=gen_random_uuid(),available_at=clock_timestamp()+interval '30 seconds'
      WHERE monitor_id=$1 AND EXISTS (SELECT 1 FROM monitors WHERE id=$1 AND active)
      AND (lease_token IS NULL OR available_at<=clock_timestamp()) RETURNING monitor_id,lease_token`,
      [id],
    );
    if (!rows[0]) throw new HttpError(409, "A check is already running");
    return rows[0];
  }
  async latency(
    id: string,
    seconds: number,
    end = new Date(),
  ): Promise<Latency> {
    await this.get(id);
    return (
      await this.pool.query<Latency>(latencySql, [
        id,
        new Date(+end - seconds * 1000),
        end,
      ])
    ).rows[0]!;
  }
  async finish(lease: Lease, result: Observation) {
    return this.transaction(async (c) => {
      const m = await this.get(lease.monitor_id, c, true);
      const done = await c.query(
        `UPDATE probe_jobs SET available_at=clock_timestamp()+$3::int*interval '1 ms',lease_token=NULL
        WHERE monitor_id=$1 AND lease_token=$2 AND available_at>clock_timestamp()`,
        [m.id, lease.lease_token, m.intervalMs],
      );
      if (!done.rowCount)
        throw new HttpError(409, "Probe lease expired or replaced");
      await c.query(
        `INSERT INTO probe_results(monitor_id,lease_token,observed_at,latency_ms,status_code,changes,fingerprint,capture)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          m.id,
          lease.lease_token,
          result.at,
          result.latencyMs,
          result.statusCode,
          JSON.stringify(result.changes),
          result.fingerprint,
          {
            target: m.target,
            scenario: m.scenario,
            expectedSchema: m.expectedSchema,
            latencySlaMs: m.latencySlaMs,
            responseSnippet: result.responseSnippet ?? null,
          },
        ],
      );
      const events: StreamEvent[] = [{ type: "probe", data: result }];
      if (m.status !== result.status) {
        await c.query("UPDATE monitors SET status=$2 WHERE id=$1", [
          m.id,
          result.status,
        ]);
        events.push({
          type: "status",
          data: { monitorId: m.id, status: result.status },
        });
      }
      const active: string[] = [];
      const transition = async (
        id: string,
        fp: string,
        count: number,
        state: "OPENED" | "RESOLVED",
      ) => {
        await c.query(
          "INSERT INTO alert_deliveries(incident_id,transition,payload) VALUES($1,$2,$3)",
          [
            id,
            state,
            {
              incidentId: id,
              monitorId: m.id,
              transition: state,
              fingerprint: fp,
              failureCount: count,
            },
          ],
        );
        events.push({
          type: "incident",
          data: {
            monitorId: m.id,
            id,
            fingerprint: fp,
            transition: state,
            failureCount: count,
          },
        });
      };
      for (const category of new Set(
        result.changes.map((v) => v.classification),
      )) {
        const fp = fingerprint(
          result.changes.filter((v) => v.classification === category),
        )!;
        active.push(fp);
        const kind =
          category === "SLA_BREACH"
            ? "latency"
            : ["BREAKING", "WARNING"].includes(category)
              ? "drift"
              : "availability";
        const { rows } = await c.query<{ id: string; failure_count: number }>(
          `INSERT INTO incidents(monitor_id,kind,fingerprint,status) VALUES($1,$2,$3,'OPEN')
          ON CONFLICT(monitor_id,kind,fingerprint) WHERE status='OPEN' DO UPDATE SET failure_count=incidents.failure_count+1
          RETURNING id,failure_count`,
          [m.id, kind, fp],
        );
        if (rows[0]!.failure_count === 1)
          await transition(rows[0]!.id, fp, 1, "OPENED");
      }
      const resolved = await c.query<{
        id: string;
        fingerprint: string;
        failure_count: number;
      }>(
        `UPDATE incidents SET status='RESOLVED',resolved_at=clock_timestamp()
        WHERE monitor_id=$1 AND status='OPEN' AND NOT(fingerprint=ANY($2::text[])) RETURNING id,fingerprint,failure_count`,
        [m.id, active],
      );
      for (const row of resolved.rows)
        await transition(
          row.id,
          row.fingerprint,
          row.failure_count,
          "RESOLVED",
        );
      // Serialize only the outbox tail so visible sequence IDs follow commit order across monitors.
      await c.query("SELECT pg_advisory_xact_lock(8341296)");
      for (const event of events)
        await c.query(
          "INSERT INTO stream_events(monitor_id,event) VALUES($1,$2)",
          [m.id, event],
        );
      return result;
    });
  }
}
