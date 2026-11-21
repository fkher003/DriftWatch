import { describe, it, expect } from "vitest";
import type { CheckRun } from "@driftwatch/shared";
import {
  curlFor,
  regressionFor,
  statusOf,
  nextCursor,
  pathKeys,
  actualValue,
} from "../src/display.js";
const run: CheckRun = {
  id: "9",
  monitorId: "x",
  at: "2026-01-01T00:00:00Z",
  latencyMs: 15,
  statusCode: 200,
  changes: [],
  status: "PASS",
  fingerprint: null,
  capture: {
    target: { kind: "sandbox", flow: "orders" },
    scenario: "SCHEMA_DRIFT_BREAKING",
    latencySlaMs: 500,
    expectedSchema: { type: "object" },
    responseSnippet: '{"orders":[{"quantity":"3"}]}',
  },
};
describe("captured request", () => {
  it("uses the recorded fault and freshly extracted token in the correct order", () => {
    const cmd = curlFor(run, "https://demo.example");
    expect(cmd).toContain(
      " -X POST -- 'https://demo.example/sandbox/v1/login/SCHEMA_DRIFT_BREAKING'",
    );
    expect(cmd).toContain("jq -er '.token'");
    expect(cmd).toContain(
      "https://demo.example/sandbox/v1/orders/SCHEMA_DRIFT_BREAKING",
    );
  });
  it("quotes shell metacharacters inside a single URL argument", () => {
    const cmd = curlFor(
      {
        ...run,
        capture: {
          ...run.capture!,
          target: { kind: "external", url: "https://example.org/?x='&a=$HOME" },
        },
      },
      "https://demo.example",
    );
    expect(cmd).toContain(`-- 'https://example.org/?x='"'"'&a=$HOME'`);
    expect(cmd).not.toContain("jq ");
  });
  it("exports executable JavaScript with baseline, auth, SLA and additive assertions", () => {
    const code = regressionFor(
      {
        ...run,
        changes: [
          {
            classification: "WARNING",
            path: '$.orders[0]["a.b"]',
            actual: "string",
            expected: "undeclared",
          },
        ],
      },
      "https://demo.example",
    );
    expect(code).toContain("headers.Authorization");
    expect(code).toContain("toBeLessThanOrEqual(500)");
    expect(code).toContain("validate(body)");
    expect(code).toContain('["orders",0,"a.b"]');
    expect(() => new Function(code.replace(/^import .*$/gm, ""))).not.toThrow();
  });
  it("treats old runs without captures explicitly", () =>
    expect(() =>
      curlFor({ ...run, capture: null }, "https://demo.example"),
    ).toThrow("unavailable"));
});
describe("stream and run presentation", () => {
  it("ignores replayed and out-of-order event IDs without rounding bigint", () => {
    expect(nextCursor("9007199254740993", "9007199254740992")).toBe(
      "9007199254740993",
    );
    expect(nextCursor("4", "4")).toBe("4");
    expect(nextCursor("4", "invalid")).toBe("4");
    expect(nextCursor("4", "5")).toBe("5");
  });
  it("reads exact snapshot values through nested and quoted JSONPaths", () => {
    expect(pathKeys('$.orders[0]["a.b"]')).toEqual(["orders", 0, "a.b"]);
    expect(
      actualValue(
        {
          path: "$.orders[0].quantity",
          expected: "integer",
          actual: "string",
          classification: "BREAKING",
        },
        run.capture,
      ),
    ).toBe('"3"');
  });
  it("prioritizes HTTP failure over drift and preserves paused/pending states", () => {
    expect(statusOf(undefined)).toBe("PENDING");
    expect(statusOf(run, false)).toBe("PAUSED");
    expect(statusOf(run)).toBe("HEALTHY");
    expect(
      statusOf({
        ...run,
        changes: ["BREAKING", "HTTP_ERROR"].map((classification) => ({
          classification,
          path: "$",
          expected: "",
          actual: "",
        })) as CheckRun["changes"],
      }),
    ).toBe("DOWN");
  });
});
