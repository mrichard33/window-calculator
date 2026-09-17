'use strict';

/**
 * Retry policy and state machine for the estimate outbox.
 *
 * All I/O goes through the deps seam, so nothing here touches Supabase,
 * pdf-service or GHL.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const jobs = require('../../lib/estimate-jobs');

const T0 = Date.parse('2026-09-17T18:00:00.000Z');
const at = (ms) => ({ now: () => T0 + ms });

// --- backoff ----------------------------------------------------------------

test('backoff climbs then flattens, and never returns NaN', () => {
  assert.equal(jobs.backoffMs(1), 5 * 60 * 1000);
  assert.equal(jobs.backoffMs(2), 15 * 60 * 1000);
  assert.equal(jobs.backoffMs(3), 30 * 60 * 1000);
  assert.equal(jobs.backoffMs(4), 60 * 60 * 1000);
  assert.equal(jobs.backoffMs(6), 4 * 60 * 60 * 1000);
  assert.equal(jobs.backoffMs(7), jobs.BACKOFF_MAX_MS, 'flattens at 6h');
  assert.equal(jobs.backoffMs(50), jobs.BACKOFF_MAX_MS);

  // A NaN delay silently becomes "retry immediately, forever".
  assert.equal(jobs.backoffMs(NaN), 5 * 60 * 1000);
  assert.equal(jobs.backoffMs(0), 5 * 60 * 1000);
  assert.equal(jobs.backoffMs(undefined), 5 * 60 * 1000);
});

test('the full ladder gives GHL more than a day before a row dies', () => {
  let total = 0;
  for (let i = 1; i < jobs.MAX_ATTEMPTS; i++) total += jobs.backoffMs(i);
  assert.ok(total > 24 * 60 * 60 * 1000, 'expected >24h, got ' + Math.round(total / 3600000) + 'h');
});

// --- state transitions ------------------------------------------------------

test('success completes the row and records the URL', () => {
  const patch = jobs.nextState({ attempts: 2 }, { ok: true, pdfUrl: 'https://cdn/x.pdf' }, at(0));
  assert.equal(patch.status, 'complete');
  assert.equal(patch.pdf_url, 'https://cdn/x.pdf');
  assert.equal(patch.completed_at, new Date(T0).toISOString());
  assert.equal(patch.last_error, null, 'a completed row must not keep a stale error');
});

test('failure increments attempts and schedules the next one', () => {
  const patch = jobs.nextState({ attempts: 0 }, { ok: false, error: 'HTTP 502' }, at(0));
  assert.equal(patch.status, 'pending');
  assert.equal(patch.attempts, 1);
  assert.equal(patch.last_error, 'HTTP 502');
  assert.equal(patch.next_attempt_at, new Date(T0 + 5 * 60 * 1000).toISOString());
});

test('the final failure marks the row dead, not pending', () => {
  const patch = jobs.nextState({ attempts: jobs.MAX_ATTEMPTS - 1 }, { ok: false, error: 'nope' }, at(0));
  assert.equal(patch.attempts, jobs.MAX_ATTEMPTS);
  assert.equal(patch.status, 'dead', 'otherwise it retries forever and nobody is told');
});

test('a huge upstream body is truncated before it reaches the database', () => {
  const cloudflarePage = '<html>' + 'x'.repeat(50000) + '</html>';
  const patch = jobs.nextState({ attempts: 0 }, { ok: false, error: cloudflarePage }, at(0));
  assert.ok(patch.last_error.length <= 500, 'got ' + patch.last_error.length);
});

test('a missing error message still produces a storable value', () => {
  const patch = jobs.nextState({ attempts: 0 }, { ok: false }, at(0));
  assert.equal(patch.last_error, 'unknown');
});

// --- the budget guard (the anti-nesting protection) -------------------------

test('the pass stops in time to finish a whole row inside the hard cap', () => {
  const perRow = jobs.PRECHECK_TIMEOUT_MS + jobs.REPLAY_TIMEOUT_MS;

  assert.equal(jobs.shouldKeepGoing(T0, 0, 25, at(0)), true, 'starts');
  assert.equal(
    jobs.shouldKeepGoing(T0, 1, 25, at(jobs.HARD_CAP_MS - perRow)), true,
    'the last moment a full row still fits',
  );
  assert.equal(
    jobs.shouldKeepGoing(T0, 1, 25, at(jobs.HARD_CAP_MS - perRow + 1)), false,
    'one ms later there is no room, so do not start',
  );
});

test('worst-case pass stays under the n8n timeout it is called with', () => {
  // n8n's httpRequest node is configured at 120s. A pass that can exceed it
  // makes the sweep look permanently broken while it burns attempts unseen.
  const worst = jobs.HARD_CAP_MS;
  assert.ok(worst < 120000, 'hard cap ' + worst + 'ms must stay under n8n 120000ms');
});

test('limit is a ceiling — the pass stops once it is reached', () => {
  assert.equal(jobs.shouldKeepGoing(T0, 25, 25, at(0)), false);
  assert.equal(jobs.shouldKeepGoing(T0, 24, 25, at(0)), true);
});

// --- claim ------------------------------------------------------------------

test('claim goes through the SKIP LOCKED function, not a filtered PATCH', async () => {
  let seen;
  const fakeFetch = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, json: async () => ([{ id: 'row-1', attempts: 0 }]) };
  };

  const row = await jobs.claimOne(
    { url: 'https://sb.example', key: 'k' },
    { fetch: fakeFetch, now: () => T0 },
  );

  assert.equal(row.id, 'row-1');
  // A filtered PATCH with order+limit depends on a PostgREST version we cannot
  // check from the app, and fails with a 400 rather than degrading.
  assert.ok(seen.url.endsWith('/rest/v1/rpc/claim_estimate_job'), 'got ' + seen.url);
  assert.equal(seen.opts.method, 'POST');

  // The lease must outlast the worst-case pass, or a second sweep re-claims a
  // row that is still being replayed.
  assert.equal(JSON.parse(seen.opts.body).lease_seconds, jobs.LEASE_MS / 1000);
  assert.ok(jobs.LEASE_MS > jobs.HARD_CAP_MS, 'lease must exceed the hard cap');
});

test('an empty queue claims nothing rather than throwing', async () => {
  const row = await jobs.claimOne(
    { url: 'https://sb.example', key: 'k' },
    { fetch: async () => ({ ok: true, json: async () => ([]) }), now: () => T0 },
  );
  assert.equal(row, null);
});

// --- insert -----------------------------------------------------------------

test('the outbox insert is bounded, so it cannot hang the 202', async () => {
  let signal;
  await jobs.insertJob(
    { url: 'https://sb.example', key: 'k' },
    { id: 'j1', estimate: {}, status: 'pending' },
    { fetch: async (url, opts) => { signal = opts.signal; return { ok: true, text: async () => '' }; } },
  );
  assert.ok(signal, 'an unbounded await here is the 2026-09-17 failure class');
  assert.equal(typeof signal.aborted, 'boolean');
});

test('a failed insert throws so the caller can log and carry on', async () => {
  await assert.rejects(
    () => jobs.insertJob(
      { url: 'https://sb.example', key: 'k' },
      { id: 'j1' },
      { fetch: async () => ({ ok: false, status: 401, text: async () => 'no' }) },
    ),
    (err) => { assert.equal(err.status, 401); return true; },
  );
});

// --- purge ------------------------------------------------------------------

test('purge deletes only completed rows past the retention window', async () => {
  let seen;
  const n = await jobs.purgeCompleted(
    { url: 'https://sb.example', key: 'k' },
    {
      fetch: async (url, opts) => { seen = { url, opts }; return { ok: true, json: async () => ([{}, {}]) }; },
      now: () => T0,
    },
  );
  assert.equal(n, 2);
  assert.equal(seen.opts.method, 'DELETE');
  assert.ok(seen.url.includes('status=eq.complete'), 'must never delete pending or dead rows');
  assert.ok(seen.url.includes('completed_at=lt.'));
  const cutoff = decodeURIComponent(seen.url.split('completed_at=lt.')[1]);
  assert.equal(Date.parse(cutoff), T0 - jobs.RETENTION_DAYS * 24 * 60 * 60 * 1000);
});

test('a failed purge returns 0 rather than failing the whole pass', async () => {
  const n = await jobs.purgeCompleted(
    { url: 'https://sb.example', key: 'k' },
    { fetch: async () => ({ ok: false, status: 500, text: async () => 'boom' }), now: () => T0 },
  );
  assert.equal(n, 0, 'housekeeping must never take down the retry');
});
