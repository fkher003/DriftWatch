# DriftWatch Maintenance & Operations Plan

**Owner:** Repository maintainer (`fkher003`)  
**Scope:** Free-tier portfolio deployment (`Vercel Hobby` → `Render Free` → `Neon Free`), keeping `keep-alive.yml` disabled by default. Only add scheduled automation when explicitly requested.

## 1. Maintenance Schedule

### On every PR / before merge
- Document the affected user flow, reproduction test (for bug fixes), CI status, migration impact, and rollback path.
- Never modify applied migrations; append new schema changes under `db/changes/` and run `npm run db:generate`.
- After deployment, verify `GET /health` (`status=ok`, `database=connected`, `worker=running`) and run one UI check. For SSE or incident changes, run the full `Breaking drift` → repeat → `Healthy` recovery flow.

### Before sharing CV or interviewing
- Open the [README](../README.md) in a fresh unauthenticated browser window and follow the **Live Demo** link.
- Confirm the README GIF renders, the dashboard connects with `LIVE · SSE`, one contract diff (`$.orders[0].quantity`) renders, and one deduplicated alert delivery appears.
- If the demo is unavailable, prioritize restoring it before any feature work; update the README if the public URL changes.

### Monthly (while the demo is actively used)
- Review GitHub Actions CI health, Render runtime logs/errors, Neon compute-hour and storage consumption, retention sweeper behavior (`RETENTION_DAYS=7`, `RETENTION_MAX_ROWS=25000`), and dependency security advisories (`npm audit`).
- Group related dependency updates into small PRs and verify with the full E2E suite before merging.
- Record each review in a short log: **Date (UTC) | Findings | Action taken | Owner**.

### Quarterly or before risky migrations
- Run a restore drill on a disposable/branch PostgreSQL database: apply migrations (`npm run db:migrate`), run the smoke test, and record duration and outcome. Keep the production database isolated.
- Review supported Node.js (currently `22.x` in CI) and PostgreSQL (`16`) versions along with Vercel Hobby, Render Free, and Neon Free plan limits.

## 2. Incident Response Runbook

1. **Triage & record:** Log UTC timestamp, affected URL, minimal reproduction steps, latest deployed commit SHA, and user impact.
2. **Isolate the layer:**
   - **Frontend / rewrites:** Compare `https://drift-watch-two.vercel.app/health` vs direct `https://driftwatch-api-v601.onrender.com/health` and inspect `vercel.json`.
   - **API / worker:** Check Render service status, cold-start wake-up (after 15 min idle), and runtime logs.
   - **Database:** Check Neon project status, compute quota, TLS connection parameters, and `/health` (`database=connected`).
   - **SSE:** Check `GET /api/events/stream?demo=1`, `CORS_ORIGIN` exact match, and snapshot reconciliation on reconnect.
3. **Mitigate / rollback:**
   - Roll back the app to the previous compatible commit/image on Render or Vercel if a regression was deployed.
   - For database corruption or bad migrations, test restore on a Neon branch/copy first before pointing `DATABASE_URL` to it.
4. **Verify & prevent:** Confirm recovery using the exact flow that failed and add a regression test before closing the incident.

## 3. Backlog Prioritization Rules

| Priority | Target | Criteria |
| --- | --- | --- |
| **P0** | Immediate | Demo unreachable, wrong diff/incident data, cross-session leak, or exposed secret. Blocks all feature work. |
| **P1** | `v1.0.x` | Reproducible bug with evidence, inaccurate docs, dependency security patch, or UX friction obstructing reviewers. |
| **P2** | `v1.1+` | New capability with a concrete user need and acceptance criteria (e.g., external webhook delivery adapter only when needed, proving retry idempotency with `incident_id + transition` and zero duplicate sends on repeated failures). |

### Backlog Item Template

```text
Issue | Impact | Priority | Owner | Done Criteria | Evidence | Target Version
```
