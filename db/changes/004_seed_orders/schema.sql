-- Upgrade the original, unmodified authenticated portfolio fixture.
WITH migrated AS (
  UPDATE monitors SET flow='orders', name='Orders · auth chain', status='UNKNOWN',
    expected_schema='{"type":"object","required":["orders"],"properties":{"orders":{"type":"array","items":{"type":"object","required":["id","quantity"],"properties":{"id":{"type":"string"},"quantity":{"type":"integer","minimum":0}}}}}}'
  WHERE id='00000000-0000-4000-8000-000000000002' AND demo_session IS NULL
    AND name='Checkout · authenticated session' AND flow='authenticated' AND external_url IS NULL
    AND expected_schema='{"type":"object","required":["service","items"],"properties":{"service":{"const":"checkout"},"items":{"type":"integer","minimum":0}}}'::jsonb
  RETURNING id
)
UPDATE probe_jobs SET lease_token=NULL,available_at=now() FROM migrated WHERE monitor_id=migrated.id;
