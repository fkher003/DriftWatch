import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { createApp } from "../apps/server/dist/app.js";
import { Store } from "../apps/server/dist/db/store.js";
import { seed } from "../apps/server/dist/seed.js";

test("PostgreSQL backend acceptance", { timeout: 90000 }, async (t) => {
  assert.ok(
    process.env.DATABASE_URL,
    "Set DATABASE_URL or run the Compose verify service",
  );
  const base = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const schema = "dw_test_" + randomUUID().replaceAll("-", "");
  await base.query("CREATE SCHEMA " + schema);
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("options", "-c search_path=" + schema);
  const databaseUrl = url.href;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const other = new pg.Pool({ connectionString: databaseUrl });
  const store = new Store(pool);
  const sandbox = createApp("sandbox");
  const origin = await sandbox.listen({ port: 0, host: "127.0.0.1" });
  const api = createApp("api", false, {
    databaseUrl,
    origin,
    operatorKey: "test",
  });
  const apiUrl = await api.listen({ port: 0, host: "127.0.0.1" });
  t.after(async () => {
    await api.close();
    await sandbox.close();
    await other.end();
    await pool.end();
    await base.query("DROP SCHEMA " + schema + " CASCADE");
    await base.end();
  });
  const call = (method, url, payload) =>
    api.inject({
      method,
      url,
      headers: { authorization: "Bearer test" },
      ...(payload ? { payload } : {}),
    });
  const run = async (id) => {
    const response = await call("POST", "/monitors/" + id + "/run");
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const fault = async (id, scenario) =>
    assert.equal(
      (await call("PUT", "/monitors/" + id + "/fault", { scenario }))
        .statusCode,
      200,
    );
  const checkout = "00000000-0000-4000-8000-000000000001",
    auth = "00000000-0000-4000-8000-000000000002";
  await t.test("apply twice and seed twice", async () => {
    for (let i = 0; i < 2; i++) {
      execFileSync(process.execPath, ["scripts/migration.mjs", "apply"], {
        env: { ...process.env, DATABASE_URL: databaseUrl },
      });
      await seed(store);
    }
    assert.equal((await store.list()).length, 2);
    assert.equal((await pool.query("SELECT * FROM probe_jobs")).rowCount, 2);
  });
  await t.test(
    "independent workers claim disjoint monitors, reclaim expiry and fence stale completion",
    async () => {
      const locked = await pool.connect();
      try {
        await locked.query("BEGIN");
        await locked.query(
          "SELECT * FROM probe_jobs WHERE monitor_id=$1 FOR UPDATE",
          [checkout],
        );
        const [skipped] = await new Store(other).claim(1);
        assert.equal(skipped.monitor_id, auth);
      } finally {
        await locked.query("ROLLBACK");
        locked.release();
      }
      await pool.query(
        "UPDATE probe_jobs SET lease_token=NULL,available_at=now()",
      );
      const [[a], [b]] = await Promise.all([
        store.claim(1),
        new Store(other).claim(1),
      ]);
      assert.notEqual(a.monitor_id, b.monitor_id);
      assert.deepEqual(await store.claim(2), []);
      await pool.query(
        "UPDATE probe_jobs SET available_at=now()-interval '1 second' WHERE monitor_id=$1",
        [a.monitor_id],
      );
      const [fresh] = await store.claim(1);
      assert.equal(fresh.monitor_id, a.monitor_id);
      assert.notEqual(a.lease_token, fresh.lease_token);
      const pass = {
        monitorId: a.monitor_id,
        at: new Date().toISOString(),
        changes: [],
        fingerprint: null,
        status: "PASS",
        latencyMs: 10,
        statusCode: 200,
      };
      await assert.rejects(store.finish(a, pass), { statusCode: 409 });
      const completions = await Promise.allSettled([
        store.finish(fresh, pass),
        new Store(other).finish(fresh, pass),
      ]);
      assert.equal(
        completions.filter((r) => r.status === "fulfilled").length,
        1,
      );
      assert.equal(
        (
          await pool.query("SELECT * FROM probe_results WHERE monitor_id=$1", [
            a.monitor_id,
          ])
        ).rowCount,
        1,
      );
      await pool.query("UPDATE probe_jobs SET lease_token=NULL");
    },
  );
  await t.test(
    "CRUD and validation, including rollback when scheduling fails",
    async () => {
      const input = {
        name: "Inventory",
        target: { kind: "sandbox", flow: "checkout" },
        expectedSchema: { type: "object" },
        intervalMs: 10000,
        latencySlaMs: 1000,
      };
      assert.equal(
        (await call("POST", "/monitors", { ...input, intervalMs: 0 }))
          .statusCode,
        400,
      );
      assert.equal(
        (
          await call("POST", "/monitors", {
            ...input,
            expectedSchema: { type: "typo" },
          })
        ).statusCode,
        400,
      );
      await pool.query(
        "CREATE FUNCTION fail_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rollback'; END $$",
      );
      await pool.query(
        "CREATE TRIGGER fail_job BEFORE INSERT ON probe_jobs FOR EACH ROW EXECUTE FUNCTION fail_job()",
      );
      try {
        assert.equal((await call("POST", "/monitors", input)).statusCode, 500);
      } finally {
        await pool.query("DROP TRIGGER fail_job ON probe_jobs");
      }
      assert.equal((await store.list()).length, 2);
      const res = await call("POST", "/api/monitors", input);
      assert.equal(res.statusCode, 201);
      const path = "/monitors/" + res.json().id;
      assert.equal(
        (await call("PATCH", path, { name: "Renamed" })).json().name,
        "Renamed",
      );
      assert.equal((await call("PUT", path, input)).json().name, "Inventory");
      assert.equal((await call("GET", path)).json().intervalMs, 10000);
      assert.equal((await call("DELETE", path)).statusCode, 204);
      assert.equal((await call("GET", path)).statusCode, 404);
    },
  );
  await t.test(
    "two-step authenticated run and atomic alert lifecycle",
    async () => {
      assert.equal(
        (await sandbox.inject("/sandbox/v1/authenticated/HEALTHY")).statusCode,
        401,
      );
      assert.equal((await run(auth)).status, "PASS");
      await fault(auth, "SCHEMA_DRIFT_BREAKING");
      const first = await run(auth),
        second = await run(auth);
      assert.equal(first.fingerprint, second.fingerprint);
      assert.equal(first.changes[0].path, "$.orders[0].quantity");
      const incidents = () =>
        pool.query(
          "SELECT id,status,failure_count FROM incidents WHERE monitor_id=$1",
          [auth],
        );
      const alerts = () =>
        pool.query(
          "SELECT transition FROM alert_deliveries JOIN incidents ON id=incident_id WHERE monitor_id=$1 ORDER BY created_at",
          [auth],
        );
      const { rows } = await incidents();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "OPEN");
      assert.equal(rows[0].failure_count, 2);
      assert.deepEqual((await alerts()).rows, [{ transition: "OPENED" }]);
      await fault(auth, "HEALTHY");
      assert.equal((await run(auth)).status, "PASS");
      await run(auth);
      assert.equal((await incidents()).rows[0].status, "RESOLVED");
      assert.deepEqual((await alerts()).rows, [
        { transition: "OPENED" },
        { transition: "RESOLVED" },
      ]);
    },
  );
  await t.test(
    "all sandbox scenarios, manual exclusion and SQL percentiles",
    async () => {
      for (const [mode, classification] of [
        ["SCHEMA_DRIFT_ADDITIVE", "WARNING"],
        ["HTTP_500", "HTTP_ERROR"],
        ["LATENCY_SPIKE", "SLA_BREACH"],
      ]) {
        await fault(checkout, mode);
        if (mode === "LATENCY_SPIKE") {
          const responses = await Promise.all([
            call("POST", "/monitors/" + checkout + "/run"),
            call("POST", "/monitors/" + checkout + "/run"),
          ]);
          assert.deepEqual(
            responses.map((r) => r.statusCode).sort(),
            [200, 409],
          );
          assert.equal(
            responses.find((r) => r.statusCode === 200).json().changes[0]
              .classification,
            classification,
          );
        } else
          assert.equal(
            (await run(checkout)).changes[0].classification,
            classification,
          );
      }
      const p = (
        await call(
          "GET",
          "/monitors/" + checkout + "/latency?windowSeconds=120",
        )
      ).json();
      assert.ok(p.p50 <= p.p95 && p.p95 <= p.p99 && p.p99 > 500);
      assert.equal(
        (
          await call(
            "GET",
            "/monitors/" + checkout + "/latency?windowSeconds=-1",
          )
        ).statusCode,
        400,
      );
      await fault(checkout, "HEALTHY");
    },
  );
  await t.test(
    "SSE publishes live probe, status and incident events and resumes from cursor",
    async () => {
      const signal = AbortSignal.timeout(8000);
      const stream = await fetch(apiUrl + "/events/stream", { signal });
      const reader = stream.body.getReader();
      let content = "";
      try {
        await run(checkout);
        while (!content.includes("event: incident")) {
          const chunk = await reader.read();
          assert.equal(chunk.done, false);
          content += new TextDecoder().decode(chunk.value);
        }
        assert.match(content, /event: probe/);
        assert.match(content, /event: status/);
      } finally {
        await reader.cancel();
      }
      const id = content.match(/id: (\d+)/)[1];
      const replay = await fetch(apiUrl + "/events/stream", {
        headers: { "last-event-id": id },
        signal,
      });
      const rr = replay.body.getReader();
      let data = "";
      try {
        while (!/id: (\d+)/.test(data)) {
          const chunk = await rr.read();
          assert.equal(chunk.done, false);
          data += new TextDecoder().decode(chunk.value);
        }
        assert.ok(BigInt(data.match(/id: (\d+)/)[1]) > BigInt(id));
      } finally {
        await rr.cancel();
      }
    },
  );
  for (const mode of ["worker", "all"])
    await t.test(
      "scheduled worker persists results and stops: " + mode,
      async () => {
        const worker = createApp(mode, false, { databaseUrl, origin });
        const count = async () =>
          Number(
            (await pool.query("SELECT count(*) FROM probe_results")).rows[0]
              .count,
          );
        const before = await count();
        await pool.query("UPDATE probe_jobs SET available_at=now()");
        await worker.listen({ port: 0, host: "127.0.0.1" });
        try {
          for (let i = 0; i < 100 && (await count()) === before; i++)
            await sleep(50);
          assert.ok((await count()) > before);
        } finally {
          await worker.close();
        }
      },
    );
  await t.test(
    "private dashboard sessions, frozen repro data, deliveries, pause and SSRF feedback",
    async () => {
      const open = () =>
        api.inject({
          method: "POST",
          url: "/api/demo/session",
          headers: { "x-driftwatch-demo": "1" },
        });
      const one = await open(),
        two = await open();
      assert.equal(one.statusCode, 200, one.body);
      const cookie = one.headers["set-cookie"].split(";")[0],
        otherCookie = two.headers["set-cookie"].split(";")[0];
      const act = (method, path, payload, who = cookie) =>
        api.inject({
          method,
          url: "/api/demo/" + path,
          headers: { cookie: who, "x-driftwatch-demo": "1" },
          ...(payload ? { payload } : {}),
        });
      const m = one.json().monitors.find((m) => m.target.flow === "orders"),
        path = "monitors/" + m.id;
      assert.equal(
        (
          await act(
            "PUT",
            path + "/fault",
            { scenario: "HTTP_500" },
            otherCookie,
          )
        ).statusCode,
        404,
      );
      await act("PUT", path + "/fault", { scenario: "SCHEMA_DRIFT_BREAKING" });
      for (let i = 0; i < 2; i++)
        assert.equal(
          (await act("POST", path + "/run")).json().changes[0].path,
          "$.orders[0].quantity",
        );
      await act("PUT", path + "/fault", { scenario: "HEALTHY" });
      await act("POST", path + "/run");
      const data = (await act("GET", "workspace")).json();
      assert.equal(data.runs[1].capture.scenario, "SCHEMA_DRIFT_BREAKING");
      assert.equal(
        JSON.parse(data.runs[1].capture.responseSnippet).orders[0].quantity,
        "3",
      );
      assert.equal(data.incidents[0].failureCount, 2);
      assert.deepEqual(
        data.alerts.map((a) => a.payload.transition),
        ["RESOLVED", "OPENED"],
      );
      assert.deepEqual(
        (await act("GET", "workspace", undefined, otherCookie)).json().runs,
        [],
      );
      const form = {
        name: m.name,
        target: m.target,
        intervalMs: 5000,
        latencySlaMs: 500,
        active: false,
      };
      assert.equal((await act("PUT", path, form)).statusCode, 200);
      assert.equal((await act("POST", path + "/run")).statusCode, 409);
      assert.match(
        (
          await act("POST", "monitors", {
            ...form,
            target: { kind: "external", url: "http://127.0.0.1" },
          })
        ).json().error,
        /SSRF guard/,
      );
      assert.equal((await act("DELETE", path)).statusCode, 204);
    },
  );
  await t.test(
    "quiet SSE stream emits a heartbeat and releases its connection on shutdown",
    async () => {
      const app = createApp("api", false, { databaseUrl, origin });
      const address = await app.listen({ port: 0, host: "127.0.0.1" });
      const stream = await fetch(address + "/events/stream", {
        signal: AbortSignal.timeout(22000),
      });
      const reader = stream.body.getReader();
      let data = "";
      try {
        while (!data.includes(": heartbeat")) {
          const chunk = await reader.read();
          assert.equal(chunk.done, false);
          data += new TextDecoder().decode(chunk.value);
        }
        await app.close();
        assert.equal((await reader.read()).done, true);
      } finally {
        await reader.cancel();
        await app.close();
      }
    },
  );
});
