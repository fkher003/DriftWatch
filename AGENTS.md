# Working on DriftWatch

Read docs/BACKLOG.md for delivered capabilities, acceptance evidence and remaining milestones. README.md contains the runnable API examples. The repository root owns npm scripts and builds all workspaces.

- Keep the React shell compatible with the original four fixture paths. Put HTTP input schemas and event payloads in packages/contracts. API routes exist at the root and under /api. Operator writes require OPERATOR_TOKEN in a bearer header.
- Keep network I/O outside database transactions. Only engine/probe.ts opens monitor connections, through security/targets.ts. External targets use pinned public addresses and default ports. The sandbox capability constructs its route from closed enums. Only the built-in authenticated flow can forward a fixture token.
- Keep one job per monitor. available_at is its next run time while idle and lease expiry while claimed. Claim with SKIP LOCKED. On completion lock the monitor, then fence by the unexpired job token. Edits invalidate previous leases. Manual runs use the same queue and completion path.
- Commit observations, status, incident counters, alert deliveries, event rows and rescheduling together. Keep the partial unique index and delivery primary key. Serialize event ID allocation at the end of the transaction for cross-process SSE replay.
- Append migrations under db/changes. Run `npm run db:generate` and commit generated SQL. Applied migrations are immutable.
- Run `npm ci`, `npm run typecheck`, `npm run build`, `npm test` and `npm run db:check`. For a single real-Postgres acceptance command run `docker compose run --build --rm verify`. The suite creates and drops its own random schema. The database role needs CREATE SCHEMA privileges.
