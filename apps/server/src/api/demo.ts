import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  monitorInput,
  monitorParams,
  windowQuery,
  faultControl,
  type Workspace,
  type DemoForm,
  type DemoMonitor,
} from "@driftwatch/shared";
import { Store, HttpError } from "../db/store.js";
import type { Runner } from "../worker/index.js";
import { approveTarget } from "../security/targets.js";
import type pg from "pg";

const schema = monitorInput
  .omit({ expectedSchema: true })
  .extend({ active: z.boolean(), intervalMs: z.int().min(5000).max(86400000) });
import { checkout, orders } from "../sandbox/contracts.js";
const forms: DemoForm[] = [
  {
    name: "Checkout API",
    target: { kind: "sandbox", flow: "checkout" },
    intervalMs: 10000,
    latencySlaMs: 500,
    active: true,
  },
  {
    name: "Orders · auth chain",
    target: { kind: "sandbox", flow: "orders" },
    intervalMs: 15000,
    latencySlaMs: 500,
    active: true,
  },
];
const cookieId = (req: FastifyRequest) =>
  req.headers.cookie?.match(/(?:^|;\s*)dw_demo=([0-9a-f-]{36})(?:;|$)/)?.[1];
export async function sessionId(req: FastifyRequest, db: Store) {
  const id = cookieId(req);
  if (
    !id ||
    !z.uuid().safeParse(id).success ||
    !(
      await db.pool.query(
        "SELECT 1 FROM demo_sessions WHERE id=$1 AND expires_at>now()",
        [id],
      )
    ).rowCount
  )
    throw new HttpError(
      401,
      "Demo session expired. Reconnect to start a new workspace.",
    );
  return id;
}
async function save(
  c: pg.PoolClient,
  sid: string,
  input: DemoForm,
  id?: string,
) {
  if (input.target.kind !== "sandbox")
    throw new HttpError(
      403,
      "Public demos can schedule built-in sandbox targets only.",
    );
  const { flow } = input.target;
  const args = [
    sid,
    input.name,
    flow,
    flow === "orders" ? orders : checkout,
    input.intervalMs,
    input.latencySlaMs,
    input.active,
    id ?? randomUUID(),
  ];
  if (id) {
    const saved = await c.query(
      `UPDATE monitors SET name=$2,flow=$3,expected_schema=$4,interval_ms=$5,latency_sla_ms=$6,active=$7
      WHERE demo_session=$1 AND id=$8`,
      args,
    );
    if (!saved.rowCount) throw new HttpError(404, "Monitor not found");
  } else {
    await c.query("SELECT id FROM demo_sessions WHERE id=$1 FOR UPDATE", [sid]);
    if (
      Number(
        (
          await c.query("SELECT count(*) FROM monitors WHERE demo_session=$1", [
            sid,
          ])
        ).rows[0].count,
      ) >= 6
    )
      throw new HttpError(409, "This demo supports six monitors.");
    await c.query(
      `INSERT INTO monitors(demo_session,name,flow,expected_schema,interval_ms,latency_sla_ms,active,id,sandbox_fault)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'healthy')`,
      args,
    );
  }
  await c.query(
    `INSERT INTO probe_jobs(monitor_id) VALUES($1) ON CONFLICT(monitor_id) DO UPDATE SET available_at=now(),lease_token=NULL`,
    [args[7]],
  );
  return args[7] as string;
}
async function snapshot(db: Store, sid: string): Promise<Workspace> {
  return db.transaction(async (c) => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const monitors = (
      await c.query<DemoMonitor>(
        `SELECT id,name,jsonb_build_object('kind','sandbox','flow',flow) AS target,
      expected_schema AS "expectedSchema", interval_ms AS "intervalMs",latency_sla_ms AS "latencySlaMs",active,scenario,status
      FROM monitors WHERE demo_session=$1 ORDER BY created_at,name`,
        [sid],
      )
    ).rows;
    const runs = (
      await c.query<Workspace["runs"][number]>(
        `SELECT r.id::text, m.id AS "monitorId", observed_at AS at, latency_ms AS "latencyMs",status_code AS "statusCode",
      changes,fingerprint,case when fingerprint IS NULL THEN 'PASS' ELSE 'FAIL' END AS status,capture
      FROM monitors m CROSS JOIN LATERAL (SELECT * FROM probe_results WHERE monitor_id=m.id ORDER BY observed_at DESC,id DESC LIMIT 60) r
      WHERE m.demo_session=$1 ORDER BY observed_at DESC,r.id DESC`,
        [sid],
      )
    ).rows;
    const incidents = (
      await c.query<Workspace["incidents"][number]>(
        `SELECT i.id,monitor_id AS "monitorId",kind,fingerprint,i.status,failure_count AS "failureCount",
      opened_at AS "openedAt",resolved_at AS "resolvedAt" FROM incidents i JOIN monitors m ON m.id=i.monitor_id WHERE m.demo_session=$1 ORDER BY opened_at DESC`,
        [sid],
      )
    ).rows;
    const alerts = (
      await c.query<Workspace["alerts"][number]>(
        `SELECT incident_id AS "incidentId",monitor_id AS "monitorId",transition,a.created_at AS at,payload
      FROM alert_deliveries a JOIN incidents i ON i.id=a.incident_id JOIN monitors m ON m.id=i.monitor_id WHERE m.demo_session=$1 ORDER BY a.created_at DESC`,
        [sid],
      )
    ).rows;
    return { monitors, runs, incidents, alerts };
  });
}
export function registerDemo(
  app: FastifyInstance,
  getStore: () => Store,
  runner: Runner | undefined,
) {
  app.addHook("onRequest", async (_req, reply) => {
    reply.header("cache-control", "private, no-store").header("vary", "Cookie");
  });
  app.addHook("preHandler", async (req) => {
    if (req.method !== "GET" && req.headers["x-driftwatch-demo"] !== "1")
      throw new HttpError(403, "Same-origin demo client required");
  });
  app.post("/session", async (req, reply) => {
    const db = getStore();
    const sid = await db.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(8341297)");
      await c.query("DELETE FROM demo_sessions WHERE expires_at<=now()");
      const saved = cookieId(req);
      if (
        saved &&
        z.uuid().safeParse(saved).success &&
        (await c.query("SELECT id FROM demo_sessions WHERE id=$1", [saved]))
          .rowCount
      )
        return saved;
      if (
        Number(
          (await c.query("SELECT count(*) FROM demo_sessions")).rows[0].count,
        ) >= 64
      )
        throw new HttpError(
          429,
          "Demo workspaces are at capacity. Try again later.",
        );
      const id = randomUUID();
      await c.query(
        "INSERT INTO demo_sessions(id,expires_at) VALUES($1,now()+interval '30 minutes')",
        [id],
      );
      for (const input of forms) await save(c, id, input);
      return id;
    });
    reply
      .header("cache-control", "no-store")
      .header(
        "set-cookie",
        "dw_demo=" +
          sid +
          "; Path=/; HttpOnly; SameSite=Strict; Max-Age=1800" +
          (req.protocol === "https" || process.env.COOKIE_SECURE === "true"
            ? "; Secure"
            : ""),
      );
    return snapshot(db, sid);
  });
  const scope = async (req: FastifyRequest) => {
    const db = getStore(),
      sid = await sessionId(req, db),
      { id } = monitorParams.parse(req.params);
    if (
      !(
        await db.pool.query(
          "SELECT 1 FROM monitors WHERE id=$1 AND demo_session=$2",
          [id, sid],
        )
      ).rowCount
    )
      throw new HttpError(404, "Monitor not found");
    return { db, id, sid };
  };
  app.get("/workspace", async (req) =>
    snapshot(getStore(), await sessionId(req, getStore())),
  );
  for (const method of ["POST", "PUT"] as const)
    app.route({
      method,
      url: method === "POST" ? "/monitors" : "/monitors/:id",
      handler: async (req, reply) => {
        const db = getStore(),
          sid = await sessionId(req, db);
        const input = schema.parse(req.body);
        if (input.target.kind === "external") {
          try {
            await approveTarget(input.target, "");
          } catch {
            throw new HttpError(
              400,
              "SSRF guard rejected this target. Use a publicly routable address; private, loopback, metadata and unresolved hosts are blocked.",
            );
          }
          throw new HttpError(
            403,
            "Public target passed the SSRF guard. External monitoring requires an operator; choose a sandbox flow for this demo.",
          );
        }
        const id = await db.transaction((c) =>
          save(
            c,
            sid,
            input,
            method === "PUT" ? monitorParams.parse(req.params).id : undefined,
          ),
        );
        return reply.code(method === "POST" ? 201 : 200).send({ id });
      },
    });
  app.delete("/monitors/:id", async (req, reply) => {
    const { db, id, sid } = await scope(req);
    await db.pool.query(
      "DELETE FROM monitors WHERE id=$1 AND demo_session=$2",
      [id, sid],
    );
    return reply.code(204).send();
  });
  app.put("/monitors/:id/fault", async (req) => {
    const { db, id, sid } = await scope(req),
      { scenario } = faultControl.parse(req.body);
    return db.transaction(async (c) => {
      const updated = await c.query(
        "UPDATE monitors SET scenario=$3 WHERE id=$1 AND demo_session=$2 RETURNING interval_ms",
        [id, sid, scenario],
      );
      if (!updated.rowCount) throw new HttpError(404, "Monitor not found");
      await c.query(
        "UPDATE probe_jobs SET lease_token=NULL,available_at=now()+$2::int*interval '1 ms' WHERE monitor_id=$1",
        [id, updated.rows[0].interval_ms],
      );
      return { scenario };
    });
  });
  app.post("/monitors/:id/run", async (req) => {
    const { id } = await scope(req);
    if (!runner) throw new HttpError(503, "Worker unavailable");
    return runner.manual(id);
  });
  app.get("/monitors/:id/latency", async (req) => {
    const { db, id } = await scope(req),
      seconds = windowQuery.parse(req.query).windowSeconds,
      end = new Date();
    const [latency, rate] = await Promise.all([
      db.latency(id, seconds, end),
      db.pool.query(
        "SELECT avg((fingerprint IS NULL)::int)::float8*100 AS rate FROM probe_results WHERE monitor_id=$1 AND observed_at>=$2 AND observed_at<$3",
        [id, new Date(+end - seconds * 1000), end],
      ),
    ]);
    return { ...latency, passRate: rate.rows[0].rate };
  });
}
