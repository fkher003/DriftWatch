import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createInterface } from "node:readline";
import pg from "pg";
import { createApp } from "../apps/server/dist/app.js";
import { Store } from "../apps/server/dist/db/store.js";
import { sweep } from "../apps/server/dist/worker/retention.js";

test("deployment hardening", { timeout: 60000 }, async (t) => {
  const base = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const schema = "dw_ops_" + randomUUID().replaceAll("-", "");
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("options", "-c search_path=" + schema);
  await base.query("CREATE SCHEMA " + schema);
  const databaseUrl = url.href,
    env = { ...process.env, DATABASE_URL: databaseUrl };
  const pool = new pg.Pool({ connectionString: databaseUrl }),
    store = new Store(pool);
  t.after(async () => {
    await pool.end();
    await base.query("DROP SCHEMA " + schema + " CASCADE");
    await base.end();
  });
  execFileSync(process.execPath, ["scripts/migration.mjs", "apply"], { env });

  await t.test(
    "concurrent cold starts seed once; a partial registry is preserved",
    async () => {
      const apps = [
        createApp("api", false, { databaseUrl, autoSeed: true }),
        createApp("api", false, { databaseUrl, autoSeed: true }),
      ];
      try {
        await Promise.all(apps.map((a) => a.ready()));
        assert.equal((await store.list()).length, 2);
      } finally {
        await Promise.all(apps.map((a) => a.close()));
      }
      await store.remove("00000000-0000-4000-8000-000000000002");
      const restart = createApp("api", false, { databaseUrl, autoSeed: true });
      try {
        await restart.ready();
        assert.equal((await store.list()).length, 1);
      } finally {
        await restart.close();
      }
    },
  );

  const id = (await store.list())[0].id;
  await t.test(
    "mutation budget returns 429 and Retry-After; reads remain available",
    async () => {
      const key = randomUUID(),
        api = createApp("api", false, {
          databaseUrl,
          operatorKey: key,
          rateLimitMax: 2,
        });
      const baseUrl = await api.listen({ port: 0, host: "127.0.0.1" });
      try {
        const change = () =>
          fetch(baseUrl + "/monitors/" + id + "/fault", {
            method: "PUT",
            headers: {
              authorization: "Bearer " + key,
              "content-type": "application/json",
            },
            body: JSON.stringify({ scenario: "HEALTHY" }),
          });
        assert.equal((await change()).status, 200);
        assert.equal((await change()).status, 200);
        const limited = await change();
        assert.equal(limited.status, 429);
        assert.ok(Number(limited.headers.get("retry-after")) > 0);
        assert.equal((await fetch(baseUrl + "/health")).status, 200);
      } finally {
        await api.close();
      }
    },
  );

  await t.test(
    "sweeper bounds history, removes expired rows and preserves open incidents",
    async () => {
      await pool.query(
        "INSERT INTO probe_results(monitor_id,lease_token,observed_at,latency_ms) SELECT $1,gen_random_uuid(),now()-n*interval '1 minute',n FROM generate_series(0,8) n",
        [id],
      );
      await pool.query(
        "INSERT INTO stream_events(monitor_id,event,created_at) SELECT $1,'{}',now()-n*interval '1 minute' FROM generate_series(0,8) n",
        [id],
      );
      await pool.query(
        `INSERT INTO incidents(monitor_id,kind,fingerprint,status,opened_at,resolved_at)
      SELECT $1,'drift','fp'||n,'RESOLVED',now()-interval '30 days',now()-n*interval '2 days' FROM generate_series(0,8)n`,
        [id],
      );
      await pool.query(
        "INSERT INTO incidents(monitor_id,kind,fingerprint,status,opened_at) VALUES($1,'drift','live','OPEN',now()-interval '30 days')",
        [id],
      );
      await pool.query(
        "INSERT INTO alert_deliveries(incident_id,transition,created_at) SELECT id,'OPENED',opened_at FROM incidents",
      );
      const policy = { days: 7, maxRows: 3, batch: 2 };
      for (let i = 0; i < 9; i++) await sweep(store, policy);
      assert.deepEqual(
        (
          await pool.query(
            "SELECT latency_ms FROM probe_results ORDER BY latency_ms",
          )
        ).rows.map((x) => x.latency_ms),
        [0, 1, 2],
      );
      assert.equal(
        (await pool.query("SELECT id FROM stream_events")).rowCount,
        3,
      );
      assert.equal(
        (await pool.query("SELECT id FROM incidents WHERE status='RESOLVED'"))
          .rowCount,
        3,
      );
      assert.equal(
        (await pool.query("SELECT id FROM incidents WHERE status='OPEN'"))
          .rowCount,
        1,
      );
      assert.equal(
        (await pool.query("SELECT incident_id FROM alert_deliveries")).rowCount,
        0,
      );
      await pool.query("UPDATE monitors SET active=false");
      await pool.query(
        "UPDATE probe_results SET observed_at=now()-interval '9 days'",
      );
      const worker = createApp("worker", false, { databaseUrl });
      try {
        await worker.listen({ port: 0, host: "127.0.0.1" });
        for (
          let n = 0;
          n < 80 &&
          (await pool.query("SELECT id FROM probe_results LIMIT 1")).rowCount;
          n++
        )
          await delay(50);
        assert.equal(
          (await pool.query("SELECT id FROM probe_results")).rowCount,
          0,
        );
      } finally {
        await worker.close();
      }
    },
  );

  await t.test(
    "unreachable PostgreSQL makes readiness return 503",
    async () => {
      const failed = new URL(databaseUrl);
      failed.hostname = "127.0.0.1";
      failed.port = "1";
      const api = createApp("api", false, {
        databaseUrl: failed.href,
        autoSeed: false,
      });
      try {
        const res = await api.inject("/health");
        assert.equal(res.statusCode, 503);
        assert.equal(res.json().database, "unavailable");
      } finally {
        await api.close();
      }
    },
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    await t.test(
      "Node entrypoint drains live SSE on " + signal,
      {
        skip:
          process.platform === "win32"
            ? "Windows does not deliver POSIX signals; run in Linux Compose"
            : false,
      },
      async () => {
        const child = spawn(process.execPath, ["apps/server/dist/main.js"], {
          env: { ...env, PORT: "0", RUN_MODE: "all" },
          stdio: ["ignore", "pipe", "inherit"],
        });
        const exited = once(child, "exit");
        const guard = setTimeout(() => child.kill("SIGKILL"), 12000);
        try {
          let origin;
          for await (const line of createInterface({ input: child.stdout })) {
            const msg = JSON.parse(line).msg;
            const match = /Server listening at http:\/\/[^:]+:(\d+)/.exec(
              msg ?? "",
            );
            if (match) {
              origin = "http://127.0.0.1:" + match[1];
              break;
            }
          }
          assert.ok(origin);
          const res = await fetch(origin + "/events/stream", {
            signal: AbortSignal.timeout(8000),
          });
          const reader = res.body.getReader();
          await reader.read();
          child.kill(signal);
          while (!(await reader.read()).done) {}
          assert.deepEqual(await exited, [0, null]);
        } finally {
          clearTimeout(guard);
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
            await exited;
          }
        }
      },
    );
});
