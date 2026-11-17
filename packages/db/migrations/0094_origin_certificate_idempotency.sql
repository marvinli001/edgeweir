DELETE FROM idempotency_key
WHERE method = 'POST'
  AND split_part(path, '?', 1) IN ('/api/v1/origin-certificates', '/api/v1/origin-certificates/');
