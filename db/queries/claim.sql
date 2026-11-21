WITH due AS (
  SELECT monitor_id FROM probe_jobs j WHERE available_at <= statement_timestamp()
  AND EXISTS (SELECT 1 FROM monitors m LEFT JOIN demo_sessions s ON s.id=m.demo_session
    WHERE m.id=j.monitor_id AND m.active AND (m.demo_session IS NULL OR s.expires_at>statement_timestamp()))
  ORDER BY available_at, monitor_id LIMIT $1 FOR UPDATE SKIP LOCKED
)
UPDATE probe_jobs j SET lease_token = gen_random_uuid(),
  available_at = statement_timestamp() + $2::integer * interval '1 millisecond'
FROM due WHERE j.monitor_id = due.monitor_id
RETURNING j.monitor_id, j.lease_token, j.available_at;
