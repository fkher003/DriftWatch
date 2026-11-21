import { checkout, orders } from "./sandbox/contracts.js";
import pg from "pg";
import { Store } from "./db/store.js";
import { monitorInput } from "@driftwatch/contracts";
export async function seed(store: Store, onlyIfEmpty = false) {
  await store.transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(8341299)");
    if (
      onlyIfEmpty &&
      (
        await c.query(
          "SELECT 1 FROM monitors WHERE demo_session IS NULL LIMIT 1",
        )
      ).rowCount
    )
      return;
    for (const [id, name, flow] of [
      ["00000000-0000-4000-8000-000000000001", "Checkout API", "checkout"],
      ["00000000-0000-4000-8000-000000000002", "Orders · auth chain", "orders"],
    ] as const)
      await store.insertMonitor(
        c,
        monitorInput.parse({
          name,
          target: { kind: "sandbox", flow },
          expectedSchema: flow === "orders" ? orders : checkout,
          intervalMs: 10000,
          latencySlaMs: 500,
        }),
        id,
      );
  });
}
export async function seedDatabase() {
  if (!process.env.DATABASE_URL) throw Error("Set DATABASE_URL");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await seed(new Store(pool));
  } finally {
    await pool.end();
  }
}
