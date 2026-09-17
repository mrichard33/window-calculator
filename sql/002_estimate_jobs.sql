-- ============================================================
-- 002_estimate_jobs.sql
-- Target: HL MCP Supabase (project jtlngmcrtqncimtjjzlz)
-- Execute in the Supabase dashboard SQL editor (DDL is dashboard-only).
-- MUST be applied BEFORE the code that writes it is merged — /api/estimate
-- degrades to a logged warning without this table, which is survivable but
-- means the safety net is not actually there.
--
-- NOTE ON DRIFT: 001 creates `calculator_events`, but the live analytics
-- writer targets `estimator_events` (see server.js /api/events). 001 is
-- stale. This file describes the table the code actually writes.
--
-- Durable outbox for the estimate -> PDF -> GHL pipeline.
--
-- Why this exists: before it, /api/estimate fired three un-awaited fetches
-- and returned 202, so the payload was garbage collected. If pdf-service was
-- down, or GHL was down longer than pdf-service's internal retries (~3.5 min),
-- or the process restarted mid-flight, the estimate was gone with no record
-- it ever existed. The `Estimate PDF URL` field then stayed empty and
-- "E.2 Calculator Bridge v2" classified a completed lead as abandoned.
--
-- We store the PAYLOAD, not the PDF: ~15x smaller, no file serving, no PII
-- on disk, and it regenerates faithfully because the payload carries the
-- COMPUTED prices (costs.grandTotal, per-window totalCost), not just inputs.
--
-- Writer: window-calculator service (service-role key). RLS is enabled with
-- no policies, so anon/authenticated roles have zero access.
-- ============================================================

CREATE TABLE IF NOT EXISTS estimate_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Everything pdf-service needs to replay the request.
  contact_id      TEXT,
  contact_name    TEXT,
  contact_phone   TEXT,
  contact_email   TEXT,
  estimate        JSONB NOT NULL,

  -- pending -> complete | dead
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        SMALLINT NOT NULL DEFAULT 0,
  last_error      TEXT,
  last_attempt_at TIMESTAMPTZ,

  -- Drives the claim query AND doubles as the lease: claiming pushes this
  -- forward by ESTIMATE_JOB_LEASE_MS so a second sweep cannot take the same
  -- row while the first is still replaying it.
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The ledger.
  pdf_url         TEXT,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The claim query: status = 'pending' AND next_attempt_at <= now(),
-- ordered by created_at.
CREATE INDEX IF NOT EXISTS idx_estimate_jobs_claim
  ON estimate_jobs(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_estimate_jobs_contact
  ON estimate_jobs(contact_id) WHERE contact_id IS NOT NULL;
-- Retention purge: completed rows older than ESTIMATE_JOB_RETENTION_DAYS.
CREATE INDEX IF NOT EXISTS idx_estimate_jobs_completed
  ON estimate_jobs(completed_at) WHERE status = 'complete';

ALTER TABLE estimate_jobs ENABLE ROW LEVEL SECURITY;

-- RETENTION: `estimate` holds PII — customer name, address, phone, email and
-- pricing. The sweep deletes completed rows older than
-- ESTIMATE_JOB_RETENTION_DAYS (default 30) on every pass, so PII stays
-- bounded without a second moving part. Rows in 'dead' are kept: somebody
-- needs to look at those.

-- ============================================================
-- claim_estimate_job(lease_seconds)
--
-- The sweep's claim primitive. FOR UPDATE SKIP LOCKED is the standard queue
-- claim: two overlapping sweeps can never take the same row, which matters
-- because the root server has no SIGTERM handler — a Railway redeploy kills an
-- in-flight sweep with no drain and the next tick starts while the old one may
-- still be running.
--
-- Why a function and not a filtered PATCH with order+limit: PostgREST supports
-- that only on recent versions and fails with a 400 rather than degrading,
-- which would take the whole retry mechanism out silently.
--
-- Pushing next_attempt_at forward IS the lease, so a sweep that dies mid-replay
-- releases the row automatically when it expires. Must exceed the sweep's hard
-- cap (ESTIMATE_JOB_LEASE_MS vs SWEEP_HARD_CAP_MS).
--
-- SECURITY INVOKER (the default) on purpose: RLS is enabled with no policies,
-- so even if the function were reachable by anon it would update nothing. The
-- REVOKE below makes that explicit rather than relying on it.
-- ============================================================

CREATE OR REPLACE FUNCTION claim_estimate_job(lease_seconds INT DEFAULT 600)
RETURNS SETOF estimate_jobs
LANGUAGE sql
AS $$
  UPDATE estimate_jobs
     SET next_attempt_at = now() + make_interval(secs => lease_seconds)
   WHERE id = (
     SELECT id FROM estimate_jobs
      WHERE status = 'pending' AND next_attempt_at <= now()
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
   )
  RETURNING *;
$$;

REVOKE ALL ON FUNCTION claim_estimate_job(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_estimate_job(INT) TO service_role;
