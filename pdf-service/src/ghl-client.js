'use strict';

/**
 * GHL (GoHighLevel) API client.
 *
 * Two operations:
 *   1. uploadMedia(pdfBuffer, fileName, ghlApiKey, opts) -> pdfUrl
 *   2. updateContactPdfField(contactId, pdfUrl, ghlApiKey, opts) -> true
 *
 * Uses Node 20's built-in fetch and FormData — no third-party form-data
 * or node-fetch dependency needed.
 *
 * CRITICAL GHL API rules (per handoff §6):
 *   - `locationId` must NEVER appear in a PUT body to /contacts/{id}
 *   - `tags` array must NEVER be in a PUT /contacts/{id} body (full replacement)
 *   - Only send `customFields` in the contact update
 *
 * 2026-09-17: every call is now bounded by AbortSignal.timeout and every thrown
 * error carries `.status` / `.bodySnippet` so the retry layer can tell a 401
 * (fatal) from a 503 (transient). Before this, nothing was attached and a
 * hung upload could only be caught by a request-wide watchdog — which is how a
 * finished 245KB PDF got thrown away during a Cloudflare 524.
 */

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';
const PDF_CUSTOM_FIELD_ID = 'WwmVP3sAjdqYQbZyITZT';

const BODY_SNIPPET_MAX = 200;

/**
 * Trim an upstream response body down to something a log line can carry.
 *
 * Whitespace is collapsed FIRST on purpose: a Cloudflare error page is mostly
 * newlines and indentation, so an uncollapsed 200-char slice is ~40 useful
 * characters. The 2026-09-17 incident dumped a full Cloudflare 524 page into
 * the Railway log stream and buried the actual event.
 */
function snippet(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, BODY_SNIPPET_MAX);
}

/** Parse a Retry-After header. Only the delta-seconds form is honoured. */
function parseRetryAfter(headerValue) {
  if (!headerValue || !/^\d+$/.test(headerValue.trim())) return 0;
  return Number(headerValue.trim()) * 1000;
}

/** Build an error carrying everything isRetryable() needs to classify it. */
function ghlError(label, status, rawBody, headers) {
  const body = snippet(rawBody);
  const err = new Error(`${label}: ${status} ${body}`);
  err.status = status;
  err.bodySnippet = body;
  err.retryAfterMs = headers ? parseRetryAfter(headers.get('retry-after')) : 0;
  return err;
}

async function uploadMedia(pdfBuffer, fileName, ghlApiKey, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 25000;

  const fd = new FormData();
  fd.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), fileName);
  fd.append('name', fileName);

  const resp = await fetch(`${GHL_BASE}/medias/upload-file`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ghlApiKey}`,
      Version: GHL_VERSION,
    },
    body: fd,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const rawBody = await resp.text();
  if (!resp.ok) {
    throw ghlError('GHL media upload failed', resp.status, rawBody, resp.headers);
  }

  let data;
  try {
    data = JSON.parse(rawBody);
  } catch (err) {
    // 2xx with an unparseable body: the upload HAPPENED. Retrying would send the
    // same PDF again and leave duplicate media in the location, so fail closed.
    const e = ghlError('GHL media upload returned non-JSON body', resp.status, rawBody);
    e.retryable = false;
    throw e;
  }

  // The live n8n workflow reads `$json.uploadedFiles.url` (object form), but the
  // API has been observed returning other shapes. The extractor below covers all
  // known paths. Set LOG_GHL_BODIES=1 to dump the raw response while debugging —
  // it used to log unconditionally on every successful request.
  if (process.env.LOG_GHL_BODIES === '1') {
    console.log('[GHL] Media upload response body:', JSON.stringify(data));
  }

  const url =
    // Object form used by the production n8n workflow
    (data && data.uploadedFiles && typeof data.uploadedFiles === 'object' && !Array.isArray(data.uploadedFiles) && data.uploadedFiles.url) ||
    // Array form, defensive
    (data && Array.isArray(data.uploadedFiles) && data.uploadedFiles[0] && data.uploadedFiles[0].url) ||
    // Flat form
    (data && data.url) ||
    // Alternate naming seen in some GHL responses
    (data && data.fileUrl) ||
    null;

  if (!url) {
    // Also a 2xx — same reasoning as the non-JSON case above.
    const e = ghlError('GHL media upload succeeded but URL not found in response', resp.status, JSON.stringify(data));
    e.retryable = false;
    throw e;
  }

  return url;
}

async function updateContactPdfField(contactId, pdfUrl, ghlApiKey, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 25000;

  const body = {
    // CRITICAL: only customFields. No locationId, no tags.
    customFields: [
      {
        id: PDF_CUSTOM_FIELD_ID,
        field_value: pdfUrl,
      },
    ],
  };

  const resp = await fetch(`${GHL_BASE}/contacts/${encodeURIComponent(contactId)}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${ghlApiKey}`,
      Version: GHL_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw ghlError('GHL contact update failed', resp.status, errText, resp.headers);
  }

  return true;
}

module.exports = {
  uploadMedia,
  updateContactPdfField,
  PDF_CUSTOM_FIELD_ID,
  snippet,
  BODY_SNIPPET_MAX,
};
