import type { FastifyInstance } from "fastify";
import { setTimeout as delay } from "node:timers/promises";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import {
  faults,
  scenario,
  type Fault,
  type Scenario,
} from "@driftwatch/contracts";

export function registerSandbox(app: FastifyInstance) {
  const secret = process.env.SANDBOX_TOKEN_SECRET || randomBytes(32);
  const sign = (expires: string) =>
    createHmac("sha256", secret)
      .update("fixture:" + expires)
      .digest("hex");
  function valid(header: string | undefined) {
    const match = /^Bearer (\d{13})\.([0-9a-f]{64})$/.exec(header ?? "");
    return (
      !!match &&
      Number(match[1]) >= Date.now() &&
      timingSafeEqual(Buffer.from(sign(match[1]!)), Buffer.from(match[2]!))
    );
  }
  const legacy = {
    healthy: "HEALTHY",
    schema: "SCHEMA_DRIFT_BREAKING",
    latency: "LATENCY_SPIKE",
    http500: "HTTP_500",
  } as const;
  const payload = async (mode: Scenario) => {
    if (mode === "LATENCY_SPIKE") await delay(800);
    return {
      service: "checkout",
      items: mode === "SCHEMA_DRIFT_BREAKING" ? "3" : 3,
      ...(mode === "SCHEMA_DRIFT_ADDITIVE" ? { currency: "USD" } : {}),
    };
  };
  app.get<{ Params: { fault: Fault } }>(
    "/sandbox/sample/:fault",
    async ({ params }, reply) => {
      if (!faults.includes(params.fault))
        return reply.code(400).send({ error: "Unknown fixture" });
      reply.header("cache-control", "no-store");
      if (params.fault === "http500")
        return reply.code(500).send({ error: "Fixture failure" });
      return payload(legacy[params.fault]);
    },
  );
  app.post<{ Params: { scenario: string } }>(
    "/sandbox/v1/login/:scenario",
    async ({ params }, reply) => {
      scenario.parse(params.scenario);
      const expires = String(Date.now() + 15000);
      return reply
        .header("cache-control", "no-store")
        .send({ token: expires + "." + sign(expires) });
    },
  );
  for (const flow of ["checkout", "authenticated", "orders"]) {
    app.get<{ Params: { scenario: string } }>(
      "/sandbox/v1/" + flow + "/:scenario",
      async (req, reply) => {
        const mode = scenario.parse(req.params.scenario);
        reply.header("cache-control", "no-store");
        if (flow !== "checkout" && !valid(req.headers.authorization))
          return reply.code(401).send({ error: "Fixture session required" });
        if (mode === "HTTP_500")
          return reply.code(500).send({ error: "Fixture failure" });
        const item = await payload(mode);
        return flow === "orders"
          ? {
              orders: [
                {
                  id: "DW-1042",
                  quantity: item.items,
                  ...("currency" in item ? { currency: item.currency } : {}),
                },
              ],
            }
          : item;
      },
    );
  }
}
