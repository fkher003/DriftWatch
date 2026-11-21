CREATE TABLE monitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  external_url text,
  sandbox_fault text CHECK (sandbox_fault IN ('healthy','schema','latency','http500')),
  CHECK (num_nonnulls(external_url, sandbox_fault) = 1),
  expected_schema jsonb NOT NULL CHECK (jsonb_typeof(expected_schema) = 'object'),
  interval_ms integer NOT NULL CHECK (interval_ms BETWEEN 1000 AND 86400000),
  latency_sla_ms integer NOT NULL CHECK (latency_sla_ms > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One recurring job per monitor. Due time moves to lease expiry during a claim.
CREATE TABLE probe_jobs (
  monitor_id uuid PRIMARY KEY REFERENCES monitors ON DELETE CASCADE,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid
);
CREATE INDEX probe_jobs_due ON probe_jobs (available_at, monitor_id);

CREATE TABLE probe_results (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  monitor_id uuid NOT NULL REFERENCES monitors ON DELETE CASCADE,
  lease_token uuid NOT NULL UNIQUE,
  observed_at timestamptz NOT NULL DEFAULT now(),
  latency_ms double precision NOT NULL CHECK (latency_ms >= 0 AND latency_ms < 'Infinity'),
  status_code smallint CHECK (status_code BETWEEN 100 AND 599),
  changes jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(changes) = 'array')
);
CREATE INDEX probe_results_window ON probe_results (monitor_id, observed_at DESC) INCLUDE (latency_ms);

CREATE TABLE incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  monitor_id uuid NOT NULL REFERENCES monitors ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('drift','availability','latency')),
  fingerprint text NOT NULL CHECK (length(fingerprint) > 0),
  status text NOT NULL CHECK (status IN ('OPEN','RESOLVED')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL)),
  CHECK (resolved_at >= opened_at)
);
CREATE UNIQUE INDEX incidents_one_open ON incidents (monitor_id, kind, fingerprint) WHERE status = 'OPEN';
