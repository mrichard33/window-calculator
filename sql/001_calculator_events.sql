-- ============================================================
-- 001_calculator_events.sql
-- Target: HL MCP Supabase (project jtlngmcrtqncimtjjzlz)
-- Execute in the Supabase dashboard SQL editor (DDL is dashboard-only).
-- Single execution is fine: the table is new and empty, so plain
-- CREATE INDEX is safe here (CONCURRENTLY is only required on live tables).
--
-- First-party funnel events for the Window Estimate Calculator.
-- Writer: window-calculator service (service-role key). RLS is enabled
-- with no policies, so anon/authenticated roles have zero access.
-- ============================================================

CREATE TABLE IF NOT EXISTS calculator_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id TEXT NOT NULL,
  ghl_contact_id TEXT,
  event TEXT NOT NULL,
  step SMALLINT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  client_ts TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calc_events_session
  ON calculator_events(session_id);
CREATE INDEX IF NOT EXISTS idx_calc_events_contact
  ON calculator_events(ghl_contact_id) WHERE ghl_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_calc_events_event_created
  ON calculator_events(event, created_at DESC);

ALTER TABLE calculator_events ENABLE ROW LEVEL SECURITY;

-- Event vocabulary (enforced by convention, not constraint, so new events
-- never require DDL): step_view, consent_checked, window_added,
-- verify_sent, verify_failed, verify_success, estimate_viewed
