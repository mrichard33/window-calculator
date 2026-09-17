'use strict';

/**
 * Durable outbox for the estimate -> PDF -> GHL pipeline.
 *
 * Before this existed, /api/estimate fired three un-awaited fetches and
 * returned 202, so the payload was garbage collected. If pdf-service was down,
 * or GHL was down longer than pdf-service's internal retries, or the process
 * restarted mid-flight, the estimate was gone with no record it ever existed —
 * and an empty `Estimate PDF URL` field makes "E.2 Calculator Bridge v2"
 * classify a completed lead as abandoned.
 *
 * Everything here takes a `deps` seam ({ fetch, now }) so the retry policy and
 * state transitions unit-test without a live Supabase or a live pdf-service.
 *
 * THE GOVERNING RULE: this module is the retry mechanism, so a replay it sends
 * to pdf-service must ask for ONE attempt (max_attempts: 1). pdf-service has
 * its own 3-attempts-per-stage ladder worth ~218s worst case; nesting that
 * inside a sweep means a single row outlives the caller's timeout, the caller
 * disconnects, Node keeps executing (it does not abort on client disconnect),
 * and the next tick starts an overlapping pass. The claim below makes that
 * safe, but the sweep would look permanently broken while burning attempts
 * invisibly. One ladder, not two.
 */

const TABLE = 'estimate_jobs';

function intEnv(name, def) {
  // parseInt('abc') is NaN, and NaN silently poisons every comparison it
  // touches. Fall back on anything that isn't a positive finite number.
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const MAX_ATTEMPTS = intEnv('ESTIMATE_JOB_MAX_ATTEMPTS', 12);
const RETENTION_DAYS = intEnv('ESTIMATE_JOB_RETENTION_DAYS', 30);
const REPLAY_TIMEOUT_MS = intEnv('SWEEP_REPLAY_TIMEOUT_MS', 45000);
// The "is it already done?" GHL lookup that runs before each replay. Counted
// in the budget below: an unbounded pre-check would blow the pass past the
// hard cap just as surely as an unbounded replay.
const PRECHECK_TIMEOUT_MS = intEnv('SWEEP_PRECHECK_TIMEOUT_MS', 10000);
const HARD_CAP_MS = intEnv('SWEEP_HARD_CAP_MS', 100000);
const LEASE_MS = intEnv('ESTIMATE_JOB_LEASE_MS', 10 * 60 * 1000);

/**
 * Backoff before the next attempt, by attempts already made (1-based).
 *
 * Roughly doubling then flat at 6h: 5m, 15m, 30m, 1h, 2h, 4h, then 6h.
 * With MAX_ATTEMPTS=12 that is a bit over a day before a row goes 'dead' —
 * GHL outages resolve in minutes to hours, so this gives the API a full day
 * to come back before anyone has to look at it.
 */
const BACKOFF_LADDER_MS = [
  5 * 60 * 1000,
  15 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
  2 * 60 * 60 * 1000,
  4 * 60 * 60 * 1000,
];
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

function backoffMs(attempts) {
  if (!Number.isFinite(attempts) || attempts < 1) return BACKOFF_LADDER_MS[0];
  return BACKOFF_LADDER_MS[attempts - 1] || BACKOFF_MAX_MS;
}

/**
 * Where a row goes after one replay attempt.
 *
 * Pure: takes the row and the outcome, returns the PATCH body. No I/O, no
 * clock beyond the injected `now`, so the whole retry policy is testable.
 */
function nextState(row, outcome, deps) {
  const now = new Date((deps && deps.now ? deps.now() : Date.now()));
  const iso = now.toISOString();

  if (outcome.ok) {
    return {
      status: 'complete',
      pdf_url: outcome.pdfUrl || null,
      completed_at: iso,
      last_attempt_at: iso,
      last_error: null,
    };
  }

  const attempts = (row.attempts || 0) + 1;
  const patch = {
    attempts: attempts,
    last_attempt_at: iso,
    // Truncated: a full Cloudflare error page in a DB column is the same
    // mistake as one in a log stream.
    last_error: String(outcome.error || 'unknown').slice(0, 500),
  };

  if (attempts >= MAX_ATTEMPTS) {
    // Give up. Kept (not deleted) because somebody needs to look at it, and
    // the sweep reports the count so n8n can raise a card.
    patch.status = 'dead';
    patch.next_attempt_at = iso;
  } else {
    patch.status = 'pending';
    patch.next_attempt_at = new Date(now.getTime() + backoffMs(attempts)).toISOString();
  }
  return patch;
}

/**
 * Should the sweep start another replay?
 *
 * The budget guard, and the reason n8n never sees a timeout: a new replay only
 * starts while there is room for a whole one inside the hard cap. The cap must
 * stay below the n8n httpRequest timeout (120s) or the disconnect scenario in
 * the header comment comes back.
 */
function shouldKeepGoing(startedAt, touched, limit, deps) {
  const now = deps && deps.now ? deps.now() : Date.now();
  if (touched >= limit) return false;
  // Worst case for one row is pre-check + replay, so reserve both.
  return (now - startedAt) + PRECHECK_TIMEOUT_MS + REPLAY_TIMEOUT_MS <= HARD_CAP_MS;
}

// -------------------- Supabase (PostgREST) --------------------

function sbHeaders(cfg, extra) {
  return Object.assign({
    'apikey': cfg.key,
    'Authorization': 'Bearer ' + cfg.key,
    'Content-Type': 'application/json',
  }, extra || {});
}

/**
 * Write the outbox row. Bounded on purpose.
 *
 * This is awaited by /api/estimate, which must return 202 promptly. An
 * unbounded await on a hanging dependency inside a handler like that is the
 * exact failure class the 2026-09-17 incident was: wrap it, and on timeout log
 * and let the caller carry on. A Supabase blip must never break a homeowner's
 * estimate — it only costs us the safety net for that one lead.
 */
async function insertJob(cfg, row, deps) {
  const f = (deps && deps.fetch) || fetch;
  const resp = await f(cfg.url + '/rest/v1/' + TABLE, {
    method: 'POST',
    headers: sbHeaders(cfg, { 'Prefer': 'return=minimal' }),
    body: JSON.stringify(row),
    signal: AbortSignal.timeout((deps && deps.timeoutMs) || 5000),
  });
  if (!resp.ok) {
    const t = await resp.text();
    const err = new Error('supabase ' + resp.status + ': ' + t.slice(0, 200));
    err.status = resp.status;
    throw err;
  }
  return true;
}

/** Update one row by id. */
async function patchJob(cfg, id, patch, deps) {
  const f = (deps && deps.fetch) || fetch;
  const resp = await f(
    cfg.url + '/rest/v1/' + TABLE + '?id=eq.' + encodeURIComponent(id),
    {
      method: 'PATCH',
      headers: sbHeaders(cfg, { 'Prefer': 'return=minimal' }),
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout((deps && deps.timeoutMs) || 10000),
    }
  );
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error('supabase patch ' + resp.status + ': ' + t.slice(0, 200));
  }
  return true;
}

/**
 * Claim exactly ONE due row, atomically.
 *
 * Goes through a Postgres function rather than PostgREST query params. A
 * filtered PATCH with order+limit would also work on a recent PostgREST, but it
 * depends on a version behaviour we cannot check from here, and it fails as a
 * 400 rather than degrading — which would take the whole retry mechanism out
 * silently. claim_estimate_job() uses FOR UPDATE SKIP LOCKED, the standard
 * queue-claim primitive, so two overlapping sweeps can never take the same row
 * at the row-lock level. That matters because the root server has no SIGTERM
 * handler: a redeploy kills an in-flight sweep with no drain, and the next tick
 * starts while the old one may still be running.
 *
 * The function pushes next_attempt_at forward by the lease before returning the
 * row, so a sweep that dies mid-replay releases it automatically once the lease
 * expires.
 *
 * One row at a time rather than a batch: during an outage a pass only gets
 * through 1-2 replays, and a batch claim would lease 25 rows to process 2 of
 * them, stranding 23 behind a lease they never needed.
 */
async function claimOne(cfg, deps) {
  const f = (deps && deps.fetch) || fetch;
  const resp = await f(cfg.url + '/rest/v1/rpc/claim_estimate_job', {
    method: 'POST',
    headers: sbHeaders(cfg),
    body: JSON.stringify({ lease_seconds: Math.round(LEASE_MS / 1000) }),
    signal: AbortSignal.timeout((deps && deps.timeoutMs) || 10000),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error('supabase claim ' + resp.status + ': ' + t.slice(0, 200));
  }
  const rows = await resp.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/** Delete completed rows past the retention window. Returns how many went. */
async function purgeCompleted(cfg, deps) {
  const f = (deps && deps.fetch) || fetch;
  const now = deps && deps.now ? deps.now() : Date.now();
  const cutoff = new Date(now - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const qs = 'status=eq.complete&completed_at=lt.' + encodeURIComponent(cutoff);
  const resp = await f(cfg.url + '/rest/v1/' + TABLE + '?' + qs, {
    method: 'DELETE',
    headers: sbHeaders(cfg, { 'Prefer': 'return=representation' }),
    signal: AbortSignal.timeout((deps && deps.timeoutMs) || 10000),
  });
  if (!resp.ok) return 0;          // purge is housekeeping; never fail a pass on it
  const rows = await resp.json();
  return Array.isArray(rows) ? rows.length : 0;
}

module.exports = {
  TABLE,
  backoffMs,
  nextState,
  shouldKeepGoing,
  insertJob,
  patchJob,
  claimOne,
  purgeCompleted,
  intEnv,
  MAX_ATTEMPTS,
  RETENTION_DAYS,
  REPLAY_TIMEOUT_MS,
  PRECHECK_TIMEOUT_MS,
  HARD_CAP_MS,
  LEASE_MS,
  BACKOFF_MAX_MS,
};
