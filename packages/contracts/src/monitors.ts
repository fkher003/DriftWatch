import { z } from "zod";
export const scenario = z.enum([
  "HEALTHY",
  "SCHEMA_DRIFT_BREAKING",
  "SCHEMA_DRIFT_ADDITIVE",
  "LATENCY_SPIKE",
  "HTTP_500",
]);
export type Scenario = z.infer<typeof scenario>;
export const targetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("sandbox"),
    flow: z.enum(["checkout", "authenticated", "orders"]),
  }),
  z.strictObject({
    kind: z.literal("external"),
    url: z
      .url({ protocol: /^https?$/ })
      .max(2048)
      .refine((value) => {
        if (!URL.canParse(value)) return false;
        const url = new URL(value);
        return !url.username && !url.password && !url.port && !url.hash;
      }, "SSRF guard: use a public HTTP(S) URL on its default port without credentials or fragment"),
  }),
]);
export type Target = z.infer<typeof targetSchema>;
export const monitorInput = z.strictObject({
  name: z.string().trim().min(1).max(120),
  target: targetSchema,
  expectedSchema: z.record(z.string(), z.unknown()),
  intervalMs: z.int().min(1000).max(86400000),
  latencySlaMs: z.int().positive().max(86400000),
});
export const monitorPatch = monitorInput
  .partial()
  .refine((v) => Object.keys(v).length > 0);
export const monitorParams = z.strictObject({ id: z.uuid() });
export const windowQuery = z.strictObject({
  windowSeconds: z.coerce.number().int().min(1).max(604800).default(3600),
});
export const faultControl = z.strictObject({ scenario });
export type MonitorInput = z.infer<typeof monitorInput>;
export type MonitorStatus = "UNKNOWN" | "PASS" | "FAIL";
export interface Monitor extends MonitorInput {
  id: string;
  scenario: Scenario;
  status: MonitorStatus;
}
export type Failure =
  | "BREAKING"
  | "WARNING"
  | "SLA_BREACH"
  | "HTTP_ERROR"
  | "TIMEOUT"
  | "NETWORK_ERROR";
export interface Change {
  path: string;
  classification: Failure;
  expected: string;
  actual: string;
}
export interface Observation {
  responseSnippet?: string;
  monitorId: string;
  at: string;
  latencyMs: number;
  statusCode: number | null;
  changes: Change[];
  status: "PASS" | "FAIL";
  fingerprint: string | null;
}
export interface Latency {
  p50: number | null;
  p95: number | null;
  p99: number | null;
}
export type StreamEvent =
  | { type: "probe"; data: Observation }
  | { type: "status"; data: { monitorId: string; status: MonitorStatus } }
  | {
      type: "incident";
      data: {
        monitorId: string;
        id: string;
        fingerprint: string;
        transition: "OPENED" | "RESOLVED";
        failureCount: number;
      };
    };
