import Fastify from "fastify";
import serve from "@fastify/static";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { seed } from "./seed.js";
import { startRetention } from "./worker/retention.js";
import pg from "pg";
import { ZodError } from "zod";
import { fileURLToPath } from "node:url";
import { modes, type RunMode } from "@driftwatch/contracts";
import { registerApi } from "./api/routes.js";
import { registerSandbox } from "./sandbox/routes.js";
import { Runner } from "./worker/index.js";
import { Store, HttpError } from "./db/store.js";

interface Options {
  databaseUrl?: string | null;
  origin?: string;
  operatorKey?: string;
  corsOrigin?: string;
  rateLimitMax?: number;
  autoSeed?: boolean;
}
export function createApp(mode: RunMode, web = false, options: Options = {}) {
  if (!modes.includes(mode)) throw Error("Unsupported RUN_MODE");
  const hops = z.coerce
    .number()
    .int()
    .min(0)
    .max(3)
    .parse(process.env.TRUST_PROXY_HOPS ?? 0);
  const app = Fastify({
    bodyLimit: 32768,
    logger: true,
    trustProxy: hops ? (_address: string, hop: number) => hop < hops : false,
  });
  const origins = (options.corsOrigin ?? process.env.CORS_ORIGIN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const value of origins) {
    const parsed = new URL(value);
    if (
      !["https:", "http:"].includes(parsed.protocol) ||
      parsed.origin !== value
    )
      throw Error("CORS_ORIGIN requires exact HTTP(S) origins");
  }
  app.register(cors, {
    origin: origins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-DriftWatch-Demo",
      "Last-Event-ID",
    ],
  });
  const positive = z.coerce.number().int().positive().max(10000000);
  app.register(rateLimit, {
    max: positive.parse(
      options.rateLimitMax ?? process.env.RATE_LIMIT_MAX ?? 60,
    ),
    timeWindow: 60000,
    cache: 4096,
    allowList: (req) => ["GET", "HEAD", "OPTIONS"].includes(req.method),
  });
  const url =
    options.databaseUrl === undefined
      ? process.env.DATABASE_URL
      : options.databaseUrl;
  const pool =
    url && mode !== "sandbox"
      ? new pg.Pool({
          connectionString: url,
          max: 10,
          connectionTimeoutMillis: 3000,
          statement_timeout: 5000,
        })
      : undefined;
  pool?.on("error", (err) => app.log.error(err));
  const store = pool ? new Store(pool) : undefined;
  const origin =
    options.origin ??
    process.env.SANDBOX_ORIGIN ??
    "http://127.0.0.1:" + (process.env.PORT ?? "3000");
  const runner = store
    ? new Runner(store, origin, (err) => app.log.error(err))
    : undefined;
  const worker = mode === "all" || mode === "worker";
  const autoSeed =
    options.autoSeed ??
    z.enum(["true", "false"]).parse(process.env.AUTO_SEED_DEMO ?? "false") ===
      "true";
  if (autoSeed && store)
    app.addHook("onReady", async () => {
      await seed(store, true);
    });
  let stopRetention: (() => Promise<void>) | undefined;
  if (worker && store) {
    const policy = {
      days: positive.max(3650).parse(process.env.RETENTION_DAYS ?? 7),
      maxRows: positive.parse(process.env.RETENTION_MAX_ROWS ?? 25000),
      batch: positive
        .max(10000)
        .parse(process.env.RETENTION_BATCH_SIZE ?? 1000),
    };
    app.addHook("onListen", async () => {
      stopRetention = startRetention(store, policy, (err) =>
        app.log.error(err),
      );
    });
  }
  if (worker && runner)
    app.addHook("onListen", async () => {
      runner.start();
    });
  app.addHook("preClose", async () => {
    await runner?.stop();
    await stopRetention?.();
  });
  app.addHook("onClose", async () => {
    await pool?.end();
  });
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError)
      return reply
        .code(400)
        .send({ error: "Validation failed", issues: err.issues });
    if (err instanceof HttpError)
      return reply.code(err.statusCode).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429)
      return reply
        .code(429)
        .send({
          error:
            "Mutation rate limit reached. Retry after the interval in Retry-After.",
        });
    if (status && status >= 400 && status < 500)
      return reply.code(status).send({ error: "Invalid request" });
    req.log.error(err);
    return reply.code(500).send({ error: "Internal server error" });
  });
  app.get("/health", async (_, reply) => {
    let database = pool
      ? "connected"
      : mode === "sandbox"
        ? "not-required"
        : "unconfigured";
    if (pool)
      try {
        await pool.query("SELECT 1");
      } catch {
        database = "unavailable";
      }
    const ready = database === "connected" || database === "not-required";
    return reply
      .code(ready ? 200 : 503)
      .header("cache-control", "no-store")
      .send({
        status: ready ? "ok" : "degraded",
        mode,
        database,
        worker: worker ? (runner ? "running" : "idle") : "disabled",
      });
  });
  if (mode === "api" || mode === "all") {
    registerApi(
      app,
      store,
      runner,
      options.operatorKey ?? process.env.OPERATOR_TOKEN,
    );
    if (web)
      app.register(serve, {
        root: fileURLToPath(new URL("../../web/dist/", import.meta.url)),
      });
  }
  if (mode === "sandbox" || mode === "all") registerSandbox(app);
  return app;
}
