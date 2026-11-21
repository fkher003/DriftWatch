import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../apps/server/dist/app.js";
import { modes, faults, samplePath } from "@driftwatch/contracts";
for (const mode of modes)
  test("role mounts without PostgreSQL: " + mode, async (t) => {
    const app = createApp(mode, true, {
      databaseUrl: null,
      operatorKey: "test",
    });
    t.after(() => app.close());
    const api = mode === "all" || mode === "api",
      sandbox = mode === "all" || mode === "sandbox";
    assert.equal((await app.inject("/health")).json().mode, mode);
    assert.equal((await app.inject("/")).statusCode, api ? 200 : 404);
    assert.equal(
      (await app.inject("/api/monitors")).statusCode,
      api ? 503 : 404,
    );
    if (api) {
      assert.equal(
        (await app.inject({ method: "POST", url: "/monitors", payload: {} }))
          .statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/monitors",
            headers: { authorization: "Bearer test" },
            payload: {},
          })
        ).statusCode,
        400,
      );
    }
    for (const fault of faults) {
      const res = await app.inject(samplePath(fault));
      assert.equal(
        res.statusCode,
        sandbox ? (fault === "http500" ? 500 : 200) : 404,
      );
      if (sandbox && fault !== "http500")
        assert.equal(res.json().items, fault === "schema" ? "3" : 3);
    }
  });
