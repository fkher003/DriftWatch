import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import type { Monitor, Observation, Change } from "@driftwatch/contracts";
import { approveTarget, type ApprovedTarget } from "../security/targets.js";
import { inspect, fingerprint } from "./diff.js";

const MAX_BYTES = 256 * 1024;
interface Sample {
  status: number;
  body: unknown;
  validJson: boolean;
}
export function socketOptions(target: ApprovedTarget) {
  const original = target.url.hostname.replace(/^\[|\]$/g, "");
  return {
    hostname: target.address ?? original,
    port: target.url.port || undefined,
    path: target.url.pathname + target.url.search,
    servername: isIP(original) ? undefined : original,
    headers: { host: target.url.host, accept: "application/json" },
    agent: false as const,
  };
}
async function request(
  target: ApprovedTarget,
  signal: AbortSignal,
  login: boolean,
  token?: string,
): Promise<Sample> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const options = socketOptions(target);
    const transport = target.url.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        ...options,
        signal,
        method: login ? "POST" : "GET",
        headers: {
          ...options.headers,
          ...(token ? { authorization: "Bearer " + token } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (buf: Buffer) => {
          size += buf.length;
          if (size > MAX_BYTES) req.destroy(Error("Body limit exceeded"));
          else chunks.push(buf);
        });
        res.on("error", reject);
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          try {
            resolve({
              status,
              body: JSON.parse(Buffer.concat(chunks).toString()),
              validJson: true,
            });
          } catch {
            resolve({ status, body: null, validJson: false });
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}
export async function probe(
  monitor: Monitor,
  origin: string,
  shutdown: AbortSignal,
  timeoutMs = 4000,
): Promise<Observation> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([deadline, shutdown]);
  const start = performance.now();
  let latencyMs = 0;
  let statusCode: number | null = null;
  let responseSnippet: string | undefined;
  const changes: Change[] = [];
  async function step(login: boolean, token?: string) {
    const target = await approveTarget(
      monitor.target,
      origin,
      monitor.scenario,
      login,
    );
    return request(target, signal, login, token);
  }
  async function sample() {
    if (
      monitor.target.kind === "sandbox" &&
      monitor.target.flow !== "checkout"
    ) {
      const auth = await step(true);
      if (auth.status !== 200) return auth;
      const token = (auth.body as { token?: unknown } | null)?.token;
      if (typeof token !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(token))
        throw Error("Invalid sandbox session");
      return step(false, token);
    }
    return step(false);
  }
  let abort!: () => void;
  try {
    signal.throwIfAborted();
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    const response = await Promise.race([sample(), stopped]);
    latencyMs = Math.round(performance.now() - start);
    statusCode = response.status;
    if (monitor.target.kind === "sandbox" && response.validJson) {
      // Capture only the final synthetic fixture, never the login response.
      if (!(
        response.body &&
        typeof response.body === "object" &&
        "token" in response.body
      ))
        responseSnippet = JSON.stringify(response.body, null, 2).slice(0, 2048);
    }
    if (statusCode < 200 || statusCode >= 300)
      changes.push({
        classification: "HTTP_ERROR",
        path: "$",
        expected: "2xx",
        actual: String(statusCode),
      });
    else if (!response.validJson)
      changes.push({
        classification: "BREAKING",
        path: "$",
        expected: "JSON",
        actual: "invalid JSON",
      });
    else changes.push(...inspect(monitor.expectedSchema, response.body));
  } catch {
    latencyMs = Math.round(performance.now() - start);
    shutdown.throwIfAborted();
    changes.push({
      classification: deadline.aborted ? "TIMEOUT" : "NETWORK_ERROR",
      path: "$",
      expected: "completed response",
      actual: deadline.aborted ? "deadline exceeded" : "request failed",
    });
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
  if (statusCode !== null && latencyMs > monitor.latencySlaMs)
    changes.push({
      classification: "SLA_BREACH",
      path: "$",
      expected: monitor.latencySlaMs + " ms",
      actual: latencyMs + " ms",
    });
  return {
    monitorId: monitor.id,
    ...(responseSnippet !== undefined ? { responseSnippet } : {}),
    at: new Date().toISOString(),
    latencyMs,
    statusCode,
    changes,
    status: changes.length ? "FAIL" : "PASS",
    fingerprint: fingerprint(changes),
  };
}
