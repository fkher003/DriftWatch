import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { createApp } from "../apps/server/dist/app.js";
import { Store } from "../apps/server/dist/db/store.js";

test("cold boot and live HTTP/SSE contract", { timeout: 90000 }, async (t) => {
  assert.ok(
    process.env.DATABASE_URL,
    "Set DATABASE_URL to a disposable PostgreSQL database.",
  );
  const root = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const schema = "dw_e2e_" + randomUUID().replaceAll("-", "");
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("options", "-c search_path=" + schema);
  const env = { ...process.env, DATABASE_URL: url.href };
  await root.query("CREATE SCHEMA " + schema);
  const pool = new pg.Pool({ connectionString: url.href });
  const key = randomUUID(),
    ui = "https://driftwatch.example";
  const sandbox = createApp("sandbox");
  const origin = await sandbox.listen({ port: 0, host: "127.0.0.1" });
  const app = createApp("api", true, {
    databaseUrl: url.href,
    origin,
    operatorKey: key,
    corsOrigin: ui,
  });
  const api = await app.listen({ port: 0, host: "127.0.0.1" });
  t.after(async () => {
    await app.close();
    await sandbox.close();
    await pool.end();
    await root.query("DROP SCHEMA " + schema + " CASCADE");
    await root.end();
  });
  for (let i = 0; i < 2; i++) {
    execFileSync(process.execPath, ["scripts/migration.mjs", "apply"], { env });
    execFileSync(process.execPath, ["scripts/seed.mjs"], { env });
  }
  const send = (method, path, body) =>
    fetch(api + path, {
      method,
      headers: {
        authorization: "Bearer " + key,
        origin: ui,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const list = (await (await send("GET", "/monitors")).json()).monitors;
  assert.equal(list.length, 2);
  await t.test("health checks PostgreSQL", async () => {
    const res = await send("GET", "/health");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).database, "connected");
  });
  await t.test("seed returns the login → orders contract", () =>
    assert.ok(list.some((m) => m.target.flow === "orders")),
  );
  const id = list[0].id;
  await t.test("two simultaneous claims are disjoint", async () => {
    const s = new Store(pool);
    const [[a], [b]] = await Promise.all([s.claim(1), s.claim(1)]);
    assert.notEqual(a.monitor_id, b.monitor_id);
    await pool.query(
      "UPDATE probe_jobs SET lease_token=NULL,available_at=now()",
    );
  });
  await t.test(
    "SSRF rejected at registration with no partial monitor",
    async () => {
      for (const target of [
        "http://169.254.169.254",
        "http://127.0.0.1:3000",
      ]) {
        const res = await send("POST", "/monitors", {
          name: "security check",
          target: { kind: "external", url: target },
          intervalMs: 10000,
          latencySlaMs: 500,
          expectedSchema: {},
        });
        assert.equal(res.status, 400);
        assert.match(JSON.stringify(await res.json()), /SSRF/i);
      }
      assert.equal(
        (await pool.query("SELECT count(*)::int AS n FROM monitors")).rows[0].n,
        2,
      );
    },
  );
  await t.test("explicit CORS preflight and live streamed probe", async () => {
    const pre = await fetch(api + "/monitors", {
      method: "OPTIONS",
      headers: {
        origin: ui,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), ui);
    const denied = await fetch(api + "/health", {
      headers: { origin: "https://untrusted.example" },
    });
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
    assert.equal(
      (
        await fetch(api + "/events/stream", {
          headers: { "last-event-id": "9223372036854775808" },
        })
      ).status,
      400,
    );
    const res = await fetch(api + "/events/stream", {
      headers: { origin: ui, "last-event-id": "9223372036854775807" },
      signal: AbortSignal.timeout(7000),
    });
    const reader = res.body.getReader();
    try {
      assert.equal(res.headers.get("access-control-allow-origin"), ui);
      const run = await send("POST", "/monitors/" + id + "/run");
      assert.equal(run.status, 200);
      let data = "";
      while (!/event: probe\ndata: [^\n]+\n\n/.test(data)) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        data += new TextDecoder().decode(chunk.value);
      }
      const event = JSON.parse(data.match(/event: probe\ndata: ([^\n]+)/)[1]);
      assert.equal(event.monitorId, id);
      assert.equal(event.status, "PASS");
    } finally {
      await reader.cancel();
    }
  });
  await t.test(
    "three identical failures → one opening → one recovery",
    async () => {
      const monitor = list.find((m) => m.target.flow === "orders");
      assert.ok(monitor);
      const path = "/monitors/" + monitor.id;
      assert.equal(
        (
          await send("PUT", path + "/fault", {
            scenario: "SCHEMA_DRIFT_BREAKING",
          })
        ).status,
        200,
      );
      const scheduled=await pool.query("SELECT available_at>clock_timestamp() AS future FROM probe_jobs WHERE monitor_id=$1",[monitor.id]);
      assert.equal(scheduled.rows[0].future,true,"a fault toggle must leave time for the manual trigger");
      for (let i = 0; i < 3; i++) {
        const r = await (await send("POST", path + "/run")).json();
        assert.equal(r.statusCode, 200);
        assert.deepEqual(r.changes, [
          {
            path: "$.orders[0].quantity",
            classification: "BREAKING",
            expected: "integer",
            actual: "string",
          },
        ]);
      }
      const incidents = () =>
        pool.query(
          "SELECT status,failure_count FROM incidents WHERE monitor_id=$1",
          [monitor.id],
        );
      const alerts = () =>
        pool.query(
          "SELECT transition FROM alert_deliveries JOIN incidents ON incident_id=id WHERE monitor_id=$1 ORDER BY created_at",
          [monitor.id],
        );
      assert.deepEqual((await incidents()).rows, [
        { status: "OPEN", failure_count: 3 },
      ]);
      assert.deepEqual((await alerts()).rows, [{ transition: "OPENED" }]);
      await send("PUT", path + "/fault", { scenario: "HEALTHY" });
      assert.equal(
        (await (await send("POST", path + "/run")).json()).status,
        "PASS",
      );
      assert.deepEqual((await incidents()).rows, [
        { status: "RESOLVED", failure_count: 3 },
      ]);
      assert.deepEqual((await alerts()).rows, [
        { transition: "OPENED" },
        { transition: "RESOLVED" },
      ]);
    },
  );
  await t.test(
    "HTTP percentile response matches a known distribution",
    async () => {
      const res = await send("POST", "/monitors", {
        name: "distribution",
        target: { kind: "sandbox", flow: "checkout" },
        expectedSchema: {},
        intervalMs: 60000,
        latencySlaMs: 500,
      });
      assert.equal(res.status, 201);
      const { id } = await res.json();
      await pool.query(
        "INSERT INTO probe_results(monitor_id,lease_token,latency_ms,observed_at) SELECT $1,gen_random_uuid(),n,now()-interval '1 second' FROM generate_series(0,100) n",
        [id],
      );
      assert.deepEqual(
        await (
          await send("GET", "/monitors/" + id + "/latency?windowSeconds=60")
        ).json(),
        { p50: 50, p95: 95, p99: 99 },
      );
    },
  );
});
