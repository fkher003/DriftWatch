import { createApp } from "./app.js";
import type { RunMode } from "@driftwatch/contracts";
const app = createApp((process.env.RUN_MODE ?? "all") as RunMode, true);
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 3000) });
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => void app.close());
