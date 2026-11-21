CREATE INDEX probe_results_retention ON probe_results(observed_at,id);
CREATE INDEX stream_events_retention ON stream_events(created_at,id);
CREATE INDEX alert_deliveries_retention ON alert_deliveries(created_at,incident_id,transition);
CREATE INDEX resolved_incidents_retention ON incidents(resolved_at,id) WHERE status='RESOLVED';
CREATE INDEX demo_sessions_expiry ON demo_sessions(expires_at);
