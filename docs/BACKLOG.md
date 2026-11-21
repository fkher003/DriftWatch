# Backend delivery and remaining work

| Delivered | Implementation | Executable proof |
| --- | --- | --- |
| [x] Registry, manual probes and seed | Shared Zod schemas, transactional monitor + job creation, full and partial updates, idempotent checkout and authenticated seeds | Integration CRUD, rollback, reseed, manual contention and auth flow |
| [x] Structural drift and SLA | Synchronous Ajv draft-07 validation, JSONPath changes, bounded validator cache, SHA-256 over sorted unique classification/path pairs | Unit nested array, required, type, additive, forbidden extra, reordered and repeated paths |
| [x] Outbound boundary | Check every DNS answer, pin a public address as socket host, preserve original Host and TLS name, refuse redirects, cap each response at 256 KiB and bound the entire chain to 4 s | Unit private/metadata/mixed answers, pinned socket options, redirect, oversized/invalid body and timeout |
| [x] Chaos fixtures | Per-monitor durable scenario control, signed 15 s demo token, two fixed sandbox steps, backward-compatible web fixture routes | HTTP tests exercise five scenarios, authenticated success and unauthorized access |
| [x] Scheduling | Bounded concurrency, expiring leases, token fencing, manual and scheduled runs, abortable shutdown | Independent PostgreSQL pools, held-row skip, concurrent claims and duplicate completion, both worker-bearing modes |
| [x] Incidents and alerts | One open incident per category/path fingerprint, increment on recurrence, one durable delivery per transition | PostgreSQL checks repeated failure, exact counters, recovery and repeated pass |
| [x] Analytics and events | Indexed half-open latency window, SQL continuous percentiles, durable ordered SSE cursor, heartbeats and reconnect | Embedded SQL distribution, live PostgreSQL HTTP window, SSE transitions, resume and idle heartbeat |

## Architectural refinements

The original available_at column doubles as next run time and lease expiry. The completion transaction advances it from completion time, avoiding catch-up storms. A crashed worker can repeat a read-only probe after expiry. The unique token and fencing checks admit one persisted completion per lease.

The check fingerprint summarizes the whole observation. Incidents group by failure classification and affected paths, so a new latency breach can coexist with an existing drift incident. Each check reconciles the current failure set. An absent fingerprint closes its open incident. WARNING marks additive schema drift and participates in this lifecycle. Values stay out of fingerprints. Diff output uses type descriptions for strings and objects to avoid recording arbitrary response bodies.

alert_deliveries is the durable local alert sink. OPENED and RESOLVED each have a database uniqueness guarantee. SSE reads the same committed transaction across process boundaries. An advisory lock serializes only event inserts through commit. Polling the event table trades a small read load for durable replay on free-tier PostgreSQL. Existing subscribers receive committed events within a polling interval under normal load.

## M3 · Interactive dashboard

- [x] Anonymous, isolated PostgreSQL-backed workspaces seed checkout and login → orders monitors. A same-site HttpOnly cookie scopes mutations, snapshots and SSE. Each workspace lasts 30 minutes and supports six monitors. Expired work is excluded from claiming.
- [x] Five fault modes, immediate manual checks, create/edit/pause/delete, and server-side SSRF feedback in the form. Public visitors can validate external targets and run the built-in fixtures. Operator credentials remain server-side.
- [x] SQL percentile and pass-rate KPIs use the selected time window. The chart displays up to 60 recent samples with the SLA line and selectable outcomes. Run history uses immutable fixture response, scenario and baseline captures.
- [x] Contract inspection, Bash cURL generation (jq for two-step flows), and downloadable Vitest/Ajv regression tests. The exported test targets the captured scenario and asserts healthy behavior, so a reproduced regression fails the test.
- [x] Incident counts and recorded transition payloads, session-filtered SSE with native reconnect, snapshot reconciliation, offline state and retry. Fetching on every probe updates failure counts even when a repeat emits no new incident transition.
- [x] Vitest covers reproduction tools, JSONPath and cursor handling. PostgreSQL acceptance covers viewer isolation and immutable captures. The end-to-end recruiter flow was exercised locally in Edge against a real PostgreSQL server.

### Local click-through

1. From the repository root run `docker compose up --build -d`. Open http://localhost:3000. Wait for **LIVE · SSE** and two monitors in the sidebar.
2. Select **Orders · auth chain → Breaking drift → Run Check Now**. Inspect `$.orders[0].quantity`, the HTTP status and the captured JSON. Run again. Open **Incidents** and **Alert inbox**. Expect one open incident with a rising failure count and one OPENED payload.
3. Select **Healthy → Run Check Now**. Check the RESOLVED delivery. Select **Latency spike → Run Check Now** and open **Overview** to see the point cross the 500 ms SLA.
4. Open **Check history**, select the earlier failing run, choose **Copy cURL** or **Export regression test**. Run the downloaded `.test.mjs` with Vitest in a project with Ajv installed. The captured fault is part of the fixture URL.
5. Click the **+** beside Monitors. Enter a name, choose **External URL**, enter `http://127.0.0.1`, and click **Validate target**. Then choose **Checkout API** and save. Use **Edit monitor** to pause, resume or delete it.
6. Open a private browser window to start a second independent workspace.

## M4 · Production verification and hardening

- [x] Cold boot over real HTTP and PostgreSQL. Migrate/seed twice, probe login → orders, reproduce three identical failures, assert one OPENED delivery, then recover and assert one RESOLVED delivery.
- [x] Reject private/metadata targets before saving, return DB-aware HTTP readiness, validate exact-origin preflight and preserve CORS on hijacked SSE responses.
- [x] Resume SSE after cursor gaps or database restore. The UI reconciles its workspace on each connection. Replay includes retained event rows; older run detail is subject to retention.
- [x] Run the history sweeper in worker-bearing modes with an advisory lock, bounded batches, age and row-count limits. Cover retained open incidents, rate limiting, transactional startup seeding and shutdown with open SSE clients.
- [x] Run headless browser checks against real fixtures and DB. Verify downloaded JS syntax, clipboard shell syntax, page errors and console errors.
- [x] Ship production Docker and Compose, Render Blueprint, Vercel rewrites, opt-in health-ping workflow and a 20-second recording from the actual Compose stack. See README for commands, environment variables and hosting limits.

Final local gate: clean install, strict typecheck, migration check and Vite build passed. The workspace reported 9 backend smoke/SQL checks and 7 frontend Vitest checks. Linux Compose with PostgreSQL 16 passed all 26 integration/E2E checks, including both real POSIX signals. On Windows the same suite passed 24 with the two POSIX cases skipped. Edge passed the browser suite. A fresh database also passed a production-image smoke test using the exact Render startup command, including workspace import, Secure demo cookie and allowed origin. Public cloud deployment is live at https://drift-watch-two.vercel.app (Vercel Hobby -> Render Free `driftwatch-api-v601.onrender.com` -> Neon Free PostgreSQL 16).

## Remaining

- [x] Publish to the chosen host and repeat the browser checklist using its public HTTPS URL (`https://drift-watch-two.vercel.app`: `/health` 200 `database=connected`, `LIVE · SSE`, `$.orders[0].quantity` `"3"` vs integer, deduplicated `failure_count` + 1 `OPENED`, recovery 1 `RESOLVED`, incognito workspace isolation verified, 0 console/HTTP errors).
- [ ] Add an external delivery adapter if email or webhook notifications are required. Use incident ID and transition as the provider idempotency key.
