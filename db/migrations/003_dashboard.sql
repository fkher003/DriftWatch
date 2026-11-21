CREATE TABLE demo_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), expires_at timestamptz NOT NULL);
ALTER TABLE monitors ADD COLUMN demo_session uuid REFERENCES demo_sessions ON DELETE CASCADE,
  ADD COLUMN active boolean NOT NULL DEFAULT true;
CREATE INDEX monitors_demo_session ON monitors(demo_session);
ALTER TABLE probe_results ADD COLUMN capture jsonb;
ALTER TABLE alert_deliveries ADD COLUMN payload jsonb;
ALTER TABLE monitors DROP CONSTRAINT monitors_flow_check;
ALTER TABLE monitors ADD CHECK(flow IN ('checkout','authenticated','orders'));
CREATE INDEX stream_events_monitor_cursor ON stream_events(monitor_id,id);
