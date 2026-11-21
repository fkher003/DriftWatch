ALTER TABLE monitors ADD COLUMN flow text NOT NULL DEFAULT 'checkout' CHECK(flow IN ('checkout','authenticated')),
  ADD COLUMN scenario text NOT NULL DEFAULT 'HEALTHY' CHECK(scenario IN ('HEALTHY','SCHEMA_DRIFT_BREAKING','SCHEMA_DRIFT_ADDITIVE','LATENCY_SPIKE','HTTP_500')),
  ADD COLUMN status text NOT NULL DEFAULT 'UNKNOWN' CHECK(status IN ('UNKNOWN','PASS','FAIL'));
UPDATE monitors SET scenario = CASE sandbox_fault WHEN 'schema' THEN 'SCHEMA_DRIFT_BREAKING'
  WHEN 'latency' THEN 'LATENCY_SPIKE' WHEN 'http500' THEN 'HTTP_500' ELSE 'HEALTHY' END;
ALTER TABLE incidents ADD COLUMN failure_count integer NOT NULL DEFAULT 1 CHECK(failure_count > 0);
ALTER TABLE probe_results ADD COLUMN fingerprint text;
CREATE TABLE alert_deliveries (
  incident_id uuid NOT NULL REFERENCES incidents ON DELETE CASCADE,
  transition text NOT NULL CHECK(transition IN ('OPENED','RESOLVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(incident_id,transition)
);
CREATE TABLE stream_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  monitor_id uuid NOT NULL REFERENCES monitors ON DELETE CASCADE,
  event jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
