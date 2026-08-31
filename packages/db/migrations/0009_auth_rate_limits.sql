-- Rate limiting for the two authentication routes that send email.
--
-- Kept in Postgres rather than in each process's memory: the limit has to hold across every
-- instance serving the public origin, and an in-memory counter simply multiplies the allowance by
-- however many instances happen to be running. One row per bucket, rewritten in place.
CREATE TABLE IF NOT EXISTS auth_rate_limits(
  bucket        text PRIMARY KEY,
  window_start  timestamptz NOT NULL DEFAULT now(),
  count         integer     NOT NULL DEFAULT 0
);

-- Old buckets are worthless once their window has passed; this keeps a sweep cheap.
CREATE INDEX IF NOT EXISTS auth_rate_limits_window_idx ON auth_rate_limits(window_start);
