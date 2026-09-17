'use strict';

/**
 * Retry policy for the two GoHighLevel calls.
 *
 * Kept OUT of ghl-client.js (that file is transport: one fetch, one endpoint,
 * no policy) and out of pdf-generator.js (requiring it in a test would drag in
 * template.js). The require graph here is upload-retry -> ghl-client, and
 * ghl-client has no require-time side effects, so the unit tests never touch a
 * network stack.
 *
 * 2026-09-17 incident: GHL's API sat behind a Cloudflare 524 for ~30s. A single
 * request-wide watchdog fired and threw away a finished 245KB PDF, which left
 * the `Estimate PDF URL` custom field empty — and "E.2 Calculator Bridge v2"
 * reads that field to decide whether the homeowner finished the calculator. One
 * upstream timeout reclassified a completed lead as abandoned. Retrying the
 * upload is what stops an upstream blip from inverting that classification.
 */

const ghlClient = require('./ghl-client');

function intEnv(name, def) {
  // parseInt('abc') is NaN and setTimeout(NaN) fires immediately, which would
  // turn a typo'd env var into an instant timeout on EVERY request. Fall back
  // on anything that isn't a positive finite number.
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const DEFAULT_MAX_ATTEMPTS = intEnv('GHL_UPLOAD_MAX_ATTEMPTS', 3);
const DEFAULT_UPLOAD_TIMEOUT_MS = intEnv('GHL_UPLOAD_TIMEOUT_MS', 25000);
const DEFAULT_CONTACT_TIMEOUT_MS = intEnv('GHL_CONTACT_TIMEOUT_MS', 25000);
const RETRY_BACKOFF_MAX_MS = intEnv('GHL_RETRY_BACKOFF_MAX_MS', 8000);

// 408 Request Timeout, 425 Too Early, 429 Too Many Requests are the 4xx codes
// that describe a transient condition rather than a malformed request.
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Decide whether a failed attempt is worth repeating.
 *
 * Order matters: the explicit override wins, aborts are checked before status
 * (a timeout carries no status), and status is checked before the TypeError
 * rule so a 500 can never fall through to "network error".
 */
function isRetryable(err) {
  if (!err) return false;

  // 1. Explicit override. Set on 2xx-with-bad-body, where the call SUCCEEDED and
  //    a retry would upload the same PDF again.
  if (typeof err.retryable === 'boolean') return err.retryable;

  // 2. Aborts and timeouts. AbortSignal.timeout() rejects with a
  //    DOMException{name:'TimeoutError'}, but undici can surface it wrapped as
  //    TypeError{cause: <that DOMException>}. Check both, and check before rule
  //    4, or a wrapped timeout gets logged as a network error.
  const causeName = err.cause && err.cause.name;
  if (err.name === 'TimeoutError' || causeName === 'TimeoutError') return true;
  if (err.name === 'AbortError' || causeName === 'AbortError') return true;

  // 3. Upstream answered with a status.
  if (typeof err.status === 'number') {
    return RETRYABLE_STATUS.has(err.status) || err.status >= 500;
  }

  // 4. Node fetch network failure: TypeError('fetch failed') with a .cause
  //    (ECONNRESET, ENOTFOUND, EAI_AGAIN, TLS). A plain programming TypeError
  //    has no .cause, so our own bugs are not retried.
  if (err.name === 'TypeError' && err.cause !== undefined) return true;

  // 5. Unknown — fail fast rather than burn three attempts and ~7s on a bug.
  return false;
}

/** Failure of a GHL stage after every permitted attempt. */
class GhlStageError extends Error {
  constructor(cause, info) {
    super(`GHL ${info.stage} failed after ${info.attempts} attempt(s): ${cause && cause.message}`);
    this.name = 'GhlStageError';
    // A stable string discriminator rather than instanceof: survives a duplicate
    // install or a future bundling step, and costs nothing.
    this.code = 'ghl_upload_failed';
    this.stage = info.stage;
    this.attempts = info.attempts;
    this.contactId = info.contactId;
    this.elapsedMs = info.elapsedMs;
    this.pdfBytes = info.pdfBytes || 0;
    this.status = cause && cause.status;
    this.bodySnippet = cause && cause.bodySnippet;
    this.cause = cause;
  }
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 1-based attempt number: attempt 1 -> ~2s, attempt 2 -> ~4s. */
function backoffMs(attempt, random) {
  const raw = Math.pow(2, attempt) * 1000 + Math.floor(random() * 1000);
  return Math.min(raw, RETRY_BACKOFF_MAX_MS);
}

/**
 * Run `attemptFn` up to maxAttempts times, backing off between tries.
 *
 * @param {(timeoutMs:number) => Promise<*>} attemptFn
 * @param {object} opts  { stage, contactId, timeoutMs, maxAttempts, pdfBytes }
 * @param {object} [deps] { sleep, random, logger }
 * @returns {Promise<{ value:*, attempts:number, elapsedMs:number }>}
 * @throws {GhlStageError}
 */
async function withRetry(attemptFn, opts, deps) {
  const d = deps || {};
  const sleep = d.sleep || realSleep;
  const random = d.random || Math.random;
  const logger = d.logger || console;

  const stage = opts.stage;
  const maxAttempts = opts.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  const timeoutMs = opts.timeoutMs;
  const contactId = opts.contactId || 'none';
  const startedAt = Date.now();

  let lastErr;
  let made = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    made = attempt;
    const attemptStarted = Date.now();
    try {
      const value = await attemptFn(timeoutMs);
      logger.log(
        `[GHL] ${stage} succeeded: contact_id=${contactId}, `
        + `attempt=${attempt}/${maxAttempts}, ms=${Date.now() - attemptStarted}`,
      );
      return { value, attempts: attempt, elapsedMs: Date.now() - startedAt };
    } catch (err) {
      lastErr = err;
      const retryable = isRetryable(err);
      logger.warn(
        `[GHL] ${stage} attempt ${attempt}/${maxAttempts} failed: contact_id=${contactId}, `
        + `ms=${Date.now() - attemptStarted}, status=${err && err.status != null ? err.status : 'none'}, `
        + `name=${err && err.name}, retryable=${retryable}, body=${(err && err.bodySnippet) || ''}`,
      );

      if (!retryable || attempt === maxAttempts) break;

      // A Retry-After longer than our whole budget means the burst window
      // outlasts us. Sleeping the cap instead would just retry straight into the
      // same 429 and burn an attempt, so stop and let the 502 name the real
      // condition. This also keeps the worst case readable off the config:
      // maxAttempts * (timeoutMs + RETRY_BACKOFF_MAX_MS).
      const retryAfterMs = (err && err.retryAfterMs) || 0;
      if (retryAfterMs > RETRY_BACKOFF_MAX_MS) {
        logger.warn(
          `[GHL] ${stage} giving up early: Retry-After ${retryAfterMs}ms exceeds `
          + `the ${RETRY_BACKOFF_MAX_MS}ms backoff cap`,
        );
        break;
      }

      const waitMs = Math.min(
        Math.max(backoffMs(attempt, random), retryAfterMs),
        RETRY_BACKOFF_MAX_MS,
      );
      await sleep(waitMs);
    }
  }

  throw new GhlStageError(lastErr, {
    stage,
    attempts: made,
    contactId: opts.contactId,
    elapsedMs: Date.now() - startedAt,
    pdfBytes: opts.pdfBytes,
  });
}

/**
 * Upload the estimate PDF to GHL media storage, retrying transient failures.
 *
 * Deviates from the work order's `uploadWithRetry(pdfBuffer, contactId)`: the
 * call cannot reach GHL without fileName and ghlApiKey, and the only way to
 * honour a two-arg form is module-level mutable state for the API key.
 */
function uploadWithRetry(pdfBuffer, opts, deps) {
  const d = deps || {};
  const uploadFn = d.uploadFn || ghlClient.uploadMedia;
  return withRetry(
    (timeoutMs) => uploadFn(pdfBuffer, opts.fileName, opts.ghlApiKey, { timeoutMs }),
    {
      stage: 'upload',
      contactId: opts.contactId,
      timeoutMs: opts.timeoutMs || DEFAULT_UPLOAD_TIMEOUT_MS,
      maxAttempts: opts.maxAttempts,
      pdfBytes: pdfBuffer ? pdfBuffer.length : 0,
    },
    deps,
  );
}

/**
 * Write the PDF URL to the contact's `Estimate PDF URL` field, retrying
 * transient failures.
 *
 * Hardened alongside the upload deliberately: this PUT is what the E.2 workflow
 * actually reads. An upload that succeeds while this fails still leaves the lead
 * classified as abandoned, so retrying only the upload would fix half the
 * outage. A PUT of a single custom field is idempotent.
 */
function updateContactWithRetry(contactId, pdfUrl, opts, deps) {
  const d = deps || {};
  const updateFn = d.updateFn || ghlClient.updateContactPdfField;
  return withRetry(
    (timeoutMs) => updateFn(contactId, pdfUrl, opts.ghlApiKey, { timeoutMs }),
    {
      stage: 'contact_update',
      contactId,
      timeoutMs: opts.timeoutMs || DEFAULT_CONTACT_TIMEOUT_MS,
      maxAttempts: opts.maxAttempts,
      pdfBytes: opts.pdfBytes,
    },
    deps,
  );
}

module.exports = {
  withRetry,
  uploadWithRetry,
  updateContactWithRetry,
  isRetryable,
  GhlStageError,
  intEnv,
  RETRY_BACKOFF_MAX_MS,
  DEFAULT_MAX_ATTEMPTS,
};
