import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { inspect, fingerprint } from "../apps/server/dist/engine/diff.js";
import { approveTarget } from "../apps/server/dist/security/targets.js";
import { probe, socketOptions } from "../apps/server/dist/engine/probe.js";
import { targetSchema } from "@driftwatch/contracts";
const schema = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        required: ["sku", "qty"],
        properties: { sku: { type: "string" }, qty: { type: "integer" } },
      },
    },
  },
};
test("nested drift includes reversible JSONPath, expectations and severities", () => {
  const changes = inspect(schema, { lines: [{ qty: "two", "a.b": true }] });
  assert.deepEqual(
    changes.map((c) => [c.path, c.classification, c.expected, c.actual]),
    [
      ["$.lines[0].sku", "BREAKING", "required property", "missing"],
      ["$.lines[0].qty", "BREAKING", "integer", "string"],
      ['$.lines[0]["a.b"]', "WARNING", "undeclared property", "boolean"],
    ],
  );
  assert.deepEqual(inspect(schema, { lines: [{ qty: 2, sku: "A" }] }), []);
  assert.equal(
    inspect({ type: "object", additionalProperties: false }, { extra: 1 })[0]
      .classification,
    "BREAKING",
  );
});
test("fingerprint ignores drift order, duplicate paths and changing sample values", () => {
  const changes = inspect(schema, { lines: [{ qty: "x" }] });
  const fp = fingerprint(changes);
  assert.match(fp, /^[a-f0-9]{64}$/);
  assert.equal(
    fp,
    fingerprint(
      [...changes, ...changes]
        .reverse()
        .map((c) => ({ ...c, actual: "other" })),
    ),
  );
  assert.notEqual(
    fp,
    fingerprint([{ path: "$", classification: "HTTP_ERROR" }]),
  );
  assert.equal(fingerprint([]), null);
});
test("deny reserved, metadata and mixed DNS answers; pin the approved IP to a single HTTP socket", async () => {
  const origin = "http://fixture:3000";
  const approve = (url, ips = []) =>
    approveTarget(
      { kind: "external", url },
      origin,
      "HEALTHY",
      false,
      async () => ips.map((address) => ({ address })),
    );
  for (const host of [
    "127.0.0.1",
    "[::1]",
    "169.254.169.254",
    "10.1.1.1",
    "192.168.1.2",
    "172.31.1.1",
    "[fd00::1]",
    "[fe80::1]",
    "[::ffff:127.0.0.1]",
    "168.63.129.16",
    "100.100.100.200",
  ])
    await assert.rejects(approve("http://" + host));
  await assert.rejects(approve("https://api.example", ["8.8.8.8", "10.0.0.1"]));
  const approved = await approve("https://api.example", ["8.8.8.8"]);
  assert.equal(socketOptions(approved).hostname, "8.8.8.8");
  assert.equal(socketOptions(approved).servername, "api.example");
  assert.equal(socketOptions(approved).headers.host, "api.example");
  assert.equal(
    (await approveTarget({ kind: "sandbox", flow: "authenticated" }, origin))
      .url.href,
    origin + "/sandbox/v1/authenticated/HEALTHY",
  );
  assert.equal(
    targetSchema.safeParse({
      kind: "sandbox",
      flow: "checkout",
      url: "http://private",
    }).success,
    false,
  );
});
test("probe refuses redirects, invalid JSON and oversized responses, and honors a wall-clock deadline", async (t) => {
  let mode = "redirect",
    hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    if (mode === "timeout") return;
    if (mode === "redirect") res.writeHead(302, { location: "/unexpected" });
    res.end(mode === "large" ? "x".repeat(300000) : "not JSON");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });
  const m = {
    target: { kind: "sandbox", flow: "checkout" },
    expectedSchema: {},
    scenario: "HEALTHY",
    id: "local",
    latencySlaMs: 10000,
  };
  const run = () =>
    probe(
      m,
      "http://127.0.0.1:" + server.address().port,
      new AbortController().signal,
      mode === "timeout" ? 50 : 1500,
    );
  assert.equal((await run()).changes[0].classification, "HTTP_ERROR");
  assert.equal(hits, 1);
  mode = "invalid";
  assert.equal((await run()).changes[0].classification, "BREAKING");
  mode = "large";
  assert.equal((await run()).changes[0].classification, "NETWORK_ERROR");
  mode = "timeout";
  assert.equal((await run()).changes[0].classification, "TIMEOUT");
});
