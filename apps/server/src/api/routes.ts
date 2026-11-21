import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  monitorInput,
  monitorPatch,
  monitorParams,
  windowQuery,
  faultControl,
} from "@driftwatch/contracts";
import { Store, HttpError } from "../db/store.js";
import { compileSchema } from "../engine/diff.js";
import type { Runner } from "../worker/index.js";
import { registerStream } from "./events.js";
import { registerDemo } from "./demo.js";
import { approveTarget } from "../security/targets.js";
import type { Target } from "@driftwatch/contracts";

export function registerApi(
  app: FastifyInstance,
  store: Store | undefined,
  runner: Runner | undefined,
  key: string | undefined,
) {
  const db = () => {
    if (!store) throw new HttpError(503, "Configure DATABASE_URL");
    return store;
  };
  function operator(req: FastifyRequest) {
    const digest = (s: string) => createHash("sha256").update(s).digest();
    if (
      !key ||
      !timingSafeEqual(
        digest(req.headers.authorization ?? ""),
        digest("Bearer " + key),
      )
    )
      throw new HttpError(403, "Operator credential required");
  }
  function validate(schema: Record<string, unknown> | undefined) {
    if (!schema) return;
    try {
      compileSchema(schema);
    } catch {
      throw new HttpError(400, "Invalid synchronous JSON Schema (draft-07)");
    }
  }
  async function routes(api: FastifyInstance) {
    async function validateTarget(target?: Target) {
      if (target?.kind !== "external") return;
      try {
        await approveTarget(target, "");
      } catch {
        throw new HttpError(
          400,
          "SSRF guard requires a publicly routable hostname or IP.",
        );
      }
    }
    api.get("/monitors", async () => ({ monitors: await db().list() }));
    api.get("/monitors/:id", (req) =>
      db().publicMonitor(monitorParams.parse(req.params).id),
    );
    api.post(
      "/monitors",
      { preHandler: async (req) => operator(req) },
      async (req, reply) => {
        const m = monitorInput.parse(req.body);
        await validateTarget(m.target);
        validate(m.expectedSchema);
        return reply.code(201).send(await db().create(m));
      },
    );
    for (const method of ["PUT", "PATCH"] as const)
      api.route({
        method,
        url: "/monitors/:id",
        preHandler: async (req) => operator(req),
        handler: async (req) => {
          const id = monitorParams.parse(req.params).id;
          const m = (method === "PUT" ? monitorInput : monitorPatch).parse(
            req.body,
          );
          validate(m.expectedSchema);
          await validateTarget(m.target);
          return db().update(id, m);
        },
      });
    api.delete("/monitors/:id", async (req, reply) => {
      operator(req);
      await db().remove(monitorParams.parse(req.params).id);
      return reply.code(204).send();
    });
    api.post("/monitors/:id/run", async (req) => {
      operator(req);
      const id = monitorParams.parse(req.params).id;
      if (!runner) throw new HttpError(503, "Configure DATABASE_URL");
      return runner.manual(id);
    });
    api.put("/monitors/:id/fault", async (req) => {
      operator(req);
      return db().update(
        monitorParams.parse(req.params).id,
        {},
        faultControl.parse(req.body).scenario,
      );
    });
    api.get("/monitors/:id/latency", async (req) => {
      const { id } = monitorParams.parse(req.params);
      await db().publicMonitor(id);
      return db().latency(id, windowQuery.parse(req.query).windowSeconds);
    });
    registerStream(api, db);
  }
  app.register(routes);
  app.register(routes, { prefix: "/api" });
  app.register(async (api) => registerDemo(api, db, runner), {
    prefix: "/api/demo",
  });
  app.get("/api/events", (_, reply) =>
    reply
      .type("text/event-stream")
      .send('event: ready\ndata: {"stream":"/api/events/stream"}\n\n'),
  );
}
