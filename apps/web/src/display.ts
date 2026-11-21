import type {
  CheckRun,
  DisplayStatus,
  Scenario,
  Change,
  Capture,
} from "@driftwatch/shared";
export const labels: Record<Scenario, string> = {
  HEALTHY: "Healthy",
  SCHEMA_DRIFT_BREAKING: "Breaking drift",
  SCHEMA_DRIFT_ADDITIVE: "Additive drift",
  LATENCY_SPIKE: "Latency spike",
  HTTP_500: "HTTP 500",
};
export function statusOf(
  run: CheckRun | undefined,
  active = true,
): DisplayStatus {
  if (!active) return "PAUSED";
  if (!run) return "PENDING";
  if (
    run.changes.some((c) =>
      ["TIMEOUT", "HTTP_ERROR", "NETWORK_ERROR"].includes(c.classification),
    )
  )
    return "DOWN";
  if (run.changes.some((c) => c.classification === "BREAKING")) return "DRIFT";
  return run.changes.length ? "DEGRADED" : "HEALTHY";
}
export const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour12: false });
export const ms = (n: number | null | undefined) =>
  n == null ? "—" : String(Math.round(n * 10) / 10);
export function nextCursor(current: string, id: string) {
  return /^\d{1,19}$/.test(id) && BigInt(id) > BigInt(current) ? id : current;
}
export function pathKeys(path: string): (string | number)[] {
  if (!path.startsWith("$")) throw Error("Invalid JSONPath");
  const out: (string | number)[] = [];
  let index = 1;
  const parts = /\.([\w$]+)|\[(\d+)\]|\[("(?:\\.|[^"\\])*")\]/gy;
  while (index < path.length) {
    parts.lastIndex = index;
    const m = parts.exec(path);
    if (!m) throw Error("Invalid JSONPath");
    out.push(m[1] ?? (m[2] !== undefined ? Number(m[2]) : JSON.parse(m[3]!)));
    index = parts.lastIndex;
  }
  return out;
}
export function actualValue(change: Change, capture: Capture | null) {
  if (!capture?.responseSnippet || change.path === "$") return change.actual;
  try {
    let v: unknown = JSON.parse(capture.responseSnippet);
    for (const k of pathKeys(change.path)) {
      if (!v || typeof v !== "object" || !Object.hasOwn(v, k))
        return change.actual;
      v = (v as Record<string, unknown>)[k];
    }
    return JSON.stringify(v) ?? change.actual;
  } catch {
    return change.actual;
  }
}
const shell = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
function steps(run: CheckRun, origin: string) {
  const c = run.capture;
  if (!c) throw Error("Request capture unavailable");
  if (c.target.kind === "external") return { url: c.target.url };
  const base = new URL(origin).origin + "/sandbox/v1/";
  return {
    url: base + c.target.flow + "/" + c.scenario,
    ...(c.target.flow === "checkout"
      ? {}
      : { login: base + "login/" + c.scenario }),
  };
}
export function curlFor(run: CheckRun, origin: string) {
  const { url, login } = steps(run, origin);
  const options =
    "curl --silent --show-error --max-time 4 -H 'Accept: application/json'";
  if (!login) return options + " -- " + shell(url);
  return (
    "token=$(" +
    options +
    " --fail -X POST -- " +
    shell(login) +
    " | jq -er '.token') &&\n" +
    options +
    ' -H "Authorization: Bearer ${token}" -- ' +
    shell(url)
  );
}
export function regressionFor(run: CheckRun, origin: string) {
  const { url, login } = steps(run, origin),
    c = run.capture!;
  const warnings = run.changes
    .filter((x) => x.classification === "WARNING")
    .map((x) => pathKeys(x.path));
  return [
    'import { test, expect } from "vitest";',
    'import Ajv from "ajv";',
    "",
    'test("captured API contract and latency budget", async () => {',
    "  const signal = AbortSignal.timeout(4000);",
    '  const headers = { Accept: "application/json" };',
    "  const start = performance.now();",
    ...(login
      ? [
          "  const login = await fetch(" +
            JSON.stringify(login) +
            ', { method: "POST", headers, signal, redirect: "manual" });',
          "  expect(login.status).toBe(200);",
          '  headers.Authorization = "Bearer " + (await login.json()).token;',
        ]
      : []),
    "  const res = await fetch(" +
      JSON.stringify(url) +
      ', { headers, signal, redirect: "manual" });',
    "  expect(res.ok).toBe(true);",
    "  const body = await res.json();",
    "  expect(performance.now() - start).toBeLessThanOrEqual(" +
      c.latencySlaMs +
      ");",
    "  const schema = JSON.parse(" +
      JSON.stringify(JSON.stringify(c.expectedSchema)) +
      ");",
    "  const validate = new Ajv({ allErrors: true, strictTypes: false }).compile(schema);",
    "  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);",
    ...warnings.map(
      (p) => "  expect(body).not.toHaveProperty(" + JSON.stringify(p) + ");",
    ),
    "});",
    "",
  ].join("\n");
}
