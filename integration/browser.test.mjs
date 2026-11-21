import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import pg from "pg";
import { createApp } from "../apps/server/dist/app.js";

test(
  "recruiter opens dashboard, observes drift and exports executable repro artifacts",
  { timeout: 60000 },
  async (t) => {
    const url = new URL(process.env.DATABASE_URL),
      admin = new pg.Pool({ connectionString: url.href });
    const schema = "dw_browser_" + randomUUID().replaceAll("-", "");
    await admin.query("CREATE SCHEMA " + schema);
    url.searchParams.set("options", "-c search_path=" + schema);
    const dir = await mkdtemp(join(tmpdir(), "dw-browser-"));
    let sandbox, app, browser;
    t.after(async () => {
      await browser?.close();
      await app?.close();
      await sandbox?.close();
      await admin.query("DROP SCHEMA " + schema + " CASCADE");
      await admin.end();
      await rm(dir, { recursive: true, force: true });
    });
    execFileSync(process.execPath, ["scripts/migration.mjs", "apply"], {
      env: { ...process.env, DATABASE_URL: url.href },
    });
    sandbox = createApp("sandbox");
    const origin = await sandbox.listen({ port: 0, host: "127.0.0.1" });
    app = createApp("all", true, { databaseUrl: url.href, origin });
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
      headless: true,
    });
    const page = await browser.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.locator(".live.online").waitFor();
    await page.locator(".monitor").filter({ hasText: "Orders" }).click();
    await page
      .getByRole("button", { name: "Breaking drift", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Run Check Now", exact: true })
      .click();
    await page
      .locator(".diff strong")
      .filter({ hasText: "$.orders[0].quantity" })
      .waitFor();
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: base,
      });
    await page.getByRole("button", { name: "Copy cURL" }).click();
    const curl = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(curl, /orders\/SCHEMA_DRIFT_BREAKING/);
    execFileSync(process.env.BASH_PATH || "bash", ["-n"], { input: curl });
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Export regression test" }).click(),
    ]);
    const regression = join(dir, "capture.test.mjs");
    await download.saveAs(regression);
    execFileSync(process.execPath, ["--check", regression]);
    await page.getByRole("button", { name: "Healthy", exact: true }).click();
    await page
      .getByRole("button", { name: "Run Check Now", exact: true })
      .click();
    await page.locator(".matched").waitFor();
    assert.deepEqual(errors, []);
  },
);
