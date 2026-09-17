'use strict';

/**
 * Regression suite for the 2026-09-17 incident.
 *
 * Puppeteer produced a valid 245KB PDF in under a second; GHL's API then sat
 * behind a Cloudflare 524; a single request-wide 30s watchdog fired and threw
 * the finished PDF away. The `Estimate PDF URL` field stayed empty, so "E.2
 * Calculator Bridge v2" classified a completed lead as abandoned.
 *
 * Everything here runs with stubbed I/O — no network, no Chromium.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  uploadWithRetry,
  isRetryable,
  GhlStageError,
  RETRY_BACKOFF_MAX_MS,
} = require('../src/upload-retry');
const pdfGenerator = require('../src/pdf-generator');

const OPTS = { contactId: 'jdYPvu4OxWyPmJBcLXgt', fileName: 'estimate.pdf', ghlApiKey: 'pit-test' };
const QUIET = { log() {}, warn() {}, error() {} };

// --- error factories mirroring what ghl-client actually throws ---------------
const timeoutErr = () =>
  Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
const netErr = () =>
  Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }),
  });
const httpErr = (status, body, extra) =>
  Object.assign(new Error(`GHL media upload failed: ${status}`), {
    status,
    bodySnippet: String(body || '').slice(0, 200),
  }, extra || {});

/** Records every call so a test can assert what each attempt actually received. */
function spy(impls) {
  const calls = [];
  const fn = async (buf, fileName, key, opts) => {
    calls.push({
      fileName,
      key,
      opts,
      byteLength: buf ? buf.length : 0,
      sha: buf ? crypto.createHash('sha256').update(buf).digest('hex') : null,
    });
    return impls[calls.length - 1]();
  };
  fn.calls = calls;
  return fn;
}

/** No-op sleep that records the schedule, so the suite runs in milliseconds. */
function recordingSleep() {
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); };
  sleep.slept = slept;
  return sleep;
}

const PDF = Buffer.from('%PDF-1.4\n' + 'A'.repeat(4096));

// ---------------------------------------------------------------------------

test('succeeds on the first attempt and calls upload exactly once', async () => {
  const uploadFn = spy([async () => 'https://storage.leadconnectorhq.com/x.pdf']);
  const sleep = recordingSleep();

  const r = await uploadWithRetry(PDF, OPTS, { uploadFn, sleep, logger: QUIET });

  assert.equal(uploadFn.calls.length, 1);
  assert.equal(r.value, 'https://storage.leadconnectorhq.com/x.pdf');
  assert.equal(r.attempts, 1);
  assert.equal(sleep.slept.length, 0, 'must not back off when the first attempt succeeds');
});

test('retries through two timeouts and succeeds on the third attempt', async () => {
  const uploadFn = spy([
    async () => { throw timeoutErr(); },
    async () => { throw timeoutErr(); },
    async () => 'https://storage.leadconnectorhq.com/x.pdf',
  ]);
  const sleep = recordingSleep();

  const r = await uploadWithRetry(PDF, OPTS, {
    uploadFn, sleep, random: () => 0, logger: QUIET,
  });

  assert.equal(uploadFn.calls.length, 3);
  assert.equal(r.attempts, 3);
  assert.deepEqual(sleep.slept, [2000, 4000], 'exponential backoff, jitter pinned to 0');
});

test('throws GhlStageError after exactly three failed attempts', async () => {
  const uploadFn = spy([
    async () => { throw httpErr(503, 'upstream unavailable'); },
    async () => { throw netErr(); },
    async () => { throw httpErr(500, 'boom'); },
  ]);

  await assert.rejects(
    () => uploadWithRetry(PDF, OPTS, { uploadFn, sleep: recordingSleep(), logger: QUIET }),
    (err) => {
      assert.ok(err instanceof GhlStageError);
      assert.equal(err.code, 'ghl_upload_failed');
      assert.equal(err.stage, 'upload');
      assert.equal(err.attempts, 3);
      assert.equal(err.contactId, OPTS.contactId);
      return true;
    },
  );
  assert.equal(uploadFn.calls.length, 3, 'exactly 3 — no off-by-one in the loop bound');
});

test('does not retry a 401 and calls upload exactly once', async () => {
  const uploadFn = spy([async () => { throw httpErr(401, '{"message":"Invalid token"}'); }]);
  const sleep = recordingSleep();

  await assert.rejects(
    () => uploadWithRetry(PDF, OPTS, { uploadFn, sleep, logger: QUIET }),
    (err) => {
      assert.equal(err.attempts, 1);
      assert.equal(err.status, 401);
      return true;
    },
  );
  assert.equal(uploadFn.calls.length, 1, 'a bad API key will not heal — do not burn attempts');
  assert.equal(sleep.slept.length, 0, 'a fail-fast path must never sleep');
});

test('regression: every attempt receives the full PDF, and it survives total failure', async () => {
  const shaBefore = crypto.createHash('sha256').update(PDF).digest('hex');
  const lenBefore = PDF.length;

  const uploadFn = spy([
    async () => { throw timeoutErr(); },
    async () => { throw timeoutErr(); },
    async () => { throw timeoutErr(); },
  ]);

  await assert.rejects(
    () => uploadWithRetry(PDF, OPTS, { uploadFn, sleep: recordingSleep(), logger: QUIET }),
  );

  // (a) Every attempt — not just the first — got the full, identical buffer.
  //     Guards against a future switch to a stream body silently sending an
  //     empty payload on retries while the retry appears to "work".
  assert.equal(uploadFn.calls.length, 3);
  uploadFn.calls.forEach((c, i) => {
    assert.equal(c.byteLength, lenBefore, `attempt ${i + 1} received a truncated buffer`);
    assert.equal(c.sha, shaBefore, `attempt ${i + 1} received mutated bytes`);
  });

  // (b) The caller's buffer is byte-identical afterwards.
  assert.equal(PDF.length, lenBefore);
  assert.equal(crypto.createHash('sha256').update(PDF).digest('hex'), shaBefore);
});

test('isRetryable classifies transient and fatal failures correctly', () => {
  assert.equal(isRetryable(httpErr(429, 'slow down')), true, '429 is transient');
  assert.equal(isRetryable(httpErr(408, 'timeout')), true);
  assert.equal(isRetryable(httpErr(503, '')), true);
  assert.equal(isRetryable(httpErr(524, 'cloudflare')), true, 'the incident status');
  assert.equal(isRetryable(timeoutErr()), true);
  assert.equal(isRetryable(netErr()), true);

  assert.equal(isRetryable(httpErr(400, '')), false);
  assert.equal(isRetryable(httpErr(401, '')), false);
  assert.equal(isRetryable(httpErr(403, '')), false);
  assert.equal(isRetryable(httpErr(404, '')), false);

  // A 2xx with an unreadable body: the upload HAPPENED, so a retry would
  // duplicate the media. The explicit flag must beat the status rule.
  assert.equal(isRetryable(httpErr(503, '', { retryable: false })), false);
  assert.equal(isRetryable(new Error('some bug of ours')), false);
  assert.equal(isRetryable(new TypeError('x is not a function')), false, 'our own bug, no .cause');
  assert.equal(isRetryable(null), false);
});

test('a Retry-After longer than the backoff cap stops the retry loop', async () => {
  const uploadFn = spy([
    async () => { throw httpErr(429, 'slow down', { retryAfterMs: RETRY_BACKOFF_MAX_MS + 1000 }); },
    async () => 'never reached',
  ]);
  const sleep = recordingSleep();

  await assert.rejects(
    () => uploadWithRetry(PDF, OPTS, { uploadFn, sleep, logger: QUIET }),
    (err) => {
      assert.equal(err.attempts, 1);
      return true;
    },
  );
  assert.equal(uploadFn.calls.length, 1);
  assert.equal(sleep.slept.length, 0, 'worst case must stay bounded by the config');
});

// --- generator-level regressions -------------------------------------------

/** Fake withPage that records when the page was released. */
function fakeWithPage(pdfBuffer, events) {
  return async (fn) => {
    events.push('page:open');
    const page = {
      setContent: async () => {},
      emulateMediaType: async () => {},
      evaluate: async () => {},
      pdf: async () => pdfBuffer,
    };
    try {
      return await fn(page);
    } finally {
      events.push('page:close');
    }
  };
}

const BODY = {
  contact_id: 'C1',
  ghl_api_key: 'pit-test',
  estimate: { project: { totalWindows: 3 }, costs: { grandTotal: 13367.29 } },
};

test('regression: generate() still holds the PDF buffer when the upload fails', async () => {
  const pdf = Buffer.from('%PDF-1.4\n' + 'B'.repeat(8192));

  await assert.rejects(
    () => pdfGenerator.generate({ withPage: fakeWithPage(pdf, []), body: BODY }, {
      renderHtml: () => '<html></html>',
      // Seeded with pdfBytes: 0 — the assertion below can only pass if generate()
      // re-stamps it from the buffer it still holds, so this cannot pass vacuously.
      uploadWithRetry: async () => {
        throw new GhlStageError(timeoutErr(), {
          stage: 'upload', attempts: 3, contactId: 'C1', elapsedMs: 1, pdfBytes: 0,
        });
      },
      logger: QUIET,
    }),
    (err) => {
      assert.equal(err.code, 'ghl_upload_failed');
      assert.equal(err.pdfBytes, pdf.length, 'the finished PDF must survive an upload failure');
      return true;
    },
  );
});

test('regression: the Chromium page is released before the GHL upload begins', async () => {
  const events = [];
  const pdf = Buffer.from('%PDF-1.4\nC');

  await pdfGenerator.generate({ withPage: fakeWithPage(pdf, events), body: BODY }, {
    renderHtml: () => '<html></html>',
    uploadWithRetry: async () => {
      events.push('upload:start');
      return { value: 'https://storage/x.pdf', attempts: 1, elapsedMs: 5 };
    },
    updateContactWithRetry: async () => {
      events.push('contact:start');
      return { value: true, attempts: 1, elapsedMs: 5 };
    },
    logger: QUIET,
  });

  // Holding the page across a multi-minute retry window would pin an open
  // Chromium page per concurrent completion during a GHL outage.
  assert.deepEqual(events, ['page:open', 'page:close', 'upload:start', 'contact:start']);
});

test('missing credentials still return 200-shaped JSON with base64, never a 502', async () => {
  const pdf = Buffer.from('%PDF-1.4\nD');
  const { response, metrics } = await pdfGenerator.generate(
    { withPage: fakeWithPage(pdf, []), body: { estimate: BODY.estimate } },
    { renderHtml: () => '<html></html>', logger: QUIET },
  );

  assert.equal(response.success, true);
  assert.equal(response.pdfUrl, null);
  assert.equal(response.contactUpdated, false);
  assert.equal(Buffer.from(response.pdfBase64, 'base64').length, pdf.length);
  assert.equal(metrics.uploadAttempts, 0);
});

test('a successful run reports real timings and keeps the response shape', async () => {
  const pdf = Buffer.from('%PDF-1.4\nE');
  const { response, metrics } = await pdfGenerator.generate(
    { withPage: fakeWithPage(pdf, []), body: BODY },
    {
      renderHtml: () => '<html></html>',
      uploadWithRetry: async () => ({ value: 'https://storage/x.pdf', attempts: 2, elapsedMs: 42 }),
      updateContactWithRetry: async () => ({ value: true, attempts: 1, elapsedMs: 7 }),
      logger: QUIET,
    },
  );

  assert.deepEqual(Object.keys(response).sort(), ['contactUpdated', 'fileName', 'pdfUrl', 'success']);
  assert.equal(response.pdfUrl, 'https://storage/x.pdf');
  assert.equal(response.contactUpdated, true);
  assert.equal(metrics.uploadAttempts, 2);
  assert.equal(metrics.uploadMs, 42);
  assert.equal(metrics.pdfBytes, pdf.length);
});
