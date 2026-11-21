import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import pg from "pg";
const command = process.argv[2];
if (!["generate", "check", "apply"].includes(command)) throw Error("Unknown migration command");
const names = (await readdir("db/changes")).sort();
await mkdir("db/migrations", { recursive: true });
const migrations = [];
for (const name of names) {
  if (!/^\d{3}_[a-z_]+$/.test(name)) throw Error("Invalid migration name " + name);
  const sql = (await readFile("db/changes/" + name + "/schema.sql", "utf8")).trimEnd().replaceAll("\r\n", "\n") + "\n";
  const path = "db/migrations/" + name + ".sql";
  if (command === "generate") await writeFile(path, sql);
  if ((await readFile(path, "utf8")).replaceAll("\r\n", "\n") !== sql) throw Error("Stale migration " + name);
  migrations.push({ name, sql, digest: createHash("sha256").update(sql).digest("hex") });
}
if (command === "apply") {
  if (!process.env.DATABASE_URL) throw Error("Set DATABASE_URL");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(8341295)");
    await client.query("CREATE TABLE IF NOT EXISTS driftwatch_migrations (name text PRIMARY KEY, digest text NOT NULL)");
    for (const { name, sql, digest } of migrations) {
      const { rows } = await client.query("SELECT digest FROM driftwatch_migrations WHERE name=$1", [name]);
      if (rows.length && rows[0].digest !== digest) throw Error("Applied migration changed: " + name);
      if (rows.length) continue;
      await client.query(sql);
      await client.query("INSERT INTO driftwatch_migrations VALUES ($1,$2)", [name, digest]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { await client.end(); }
}
