SELECT percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms) AS p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95,
       percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms) AS p99
FROM probe_results WHERE monitor_id = $1 AND observed_at >= $2 AND observed_at < $3;
