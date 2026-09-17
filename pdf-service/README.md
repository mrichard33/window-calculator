# Reece PDF Service

Server-side PDF generator for the Reece Windows & Doors estimator. Replaces
the broken client-side `html2pdf.js` flow with Puppeteer + Chromium's native
print engine, which properly respects `@page`, `page-break-inside: avoid`,
and `break-before: page`.

## Why

The landing page at `landing.reecewindows.com` used to generate estimate PDFs
in the browser with `html2pdf.js`. That library is a raster slicer — it has
no concept of layout or page boundaries, so with variable window counts it
produced blank pages, mid-row table splits, and rasterized (fuzzy, huge) text.

This service takes the same estimate data as JSON, renders a purpose-built
HTML template in a headless Chromium, and uses `page.pdf()` to produce a
clean multi-page PDF that Chromium actually paginates correctly.

## Endpoints

### `POST /api/generate-estimate-pdf`

Request body (JSON):

```json
{
  "contact_id": "abc123",
  "contact_name": "Jane Smith",
  "contact_phone": "+14075551234",
  "contact_email": "jane@example.com",
  "ghl_api_key": "pit-...",
  "ghl_location_id": "SsBG7j5KQAIP1SFP2Sca",
  "estimate": {
    "customer": { "name": "...", "address": "...", "city": "...", ... },
    "project": { "totalWindows": 9, "installationType": "Full-Frame Replacement", ... },
    "windows": [ { "label": "...", "qty": 7, "perWindowCost": 2448.69, "totalCost": 17140.83, "breakdown": { ... } }, ... ],
    "costs": { "windowSubtotal": 23402.23, "grandTotal": 22899.08, "lowEstimate": 18319.26, "highEstimate": 27478.90, ... }
  }
}
```

Response (success):

```json
{
  "success": true,
  "pdfUrl": "https://storage.leadconnectorhq.com/...",
  "fileName": "Reece-Windows-Estimate-1712604800000.pdf",
  "contactUpdated": true
}
```

If `contact_id` or `ghl_api_key` is missing, GHL is skipped and the response
includes `pdfBase64` so the caller still has a usable PDF.

Response (GHL failure) — **HTTP 502**, not 500: the failure was upstream, and
the distinction is what makes a log readable six weeks later.

```json
{
  "error": "ghl_upload_failed",
  "stage": "upload",
  "attempts": 3,
  "contact_id": "abc123"
}
```

`stage` is `upload` (media upload) or `contact_update` (writing the
`Estimate PDF URL` custom field). Both are retried — see Resilience below.

### `GET /healthz`

Cheap liveness probe. No Puppeteer, no I/O: `{ ok: true, service: "pdf-service" }`.

### `GET /health`

Deep probe: launches a test page and closes it to verify Puppeteer is alive.
Returns `{ status: "ok", puppeteer: true, timestamp: "..." }` or a 503 if
Chromium is dead. Because it launches a page per call, prefer `/healthz` for
anything that polls.

## Deployment (Railway)

1. Connect Railway to this repo
2. In the service settings, set **Root Directory** to `pdf-service`
3. Railway auto-detects the `Dockerfile`
4. Set environment variables:
   - `PORT=3000`
   - `NODE_ENV=production`
   - `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`
   - `ALLOWED_ORIGINS=https://landing.reecewindows.com,https://reecewindows.com`
   (the `*.msgsndr.com` wildcard is matched in code via regex — don't put
   a wildcard into this env var)
5. Deploy. Copy the generated Railway URL.
6. Set `PDF_SERVICE_URL` on the **root** calculator service to
   `<railway-url>/api/generate-estimate-pdf`. The browser never calls this
   service directly — the root Express server proxies to it server-to-server so
   the GHL key never ships to the client. (An older build had a
   `PDF_SERVICE_CONFIG` constant in the page; it was removed in `7ff81d1`.)

Optional tuning vars are listed in `.env.example` (timeouts, retry attempts).

## Local development

```bash
cd pdf-service
npm install
# Requires a local Chromium/Chrome. On macOS:
PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node server.js
# On Debian/Ubuntu:
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium node server.js
```

Then `curl http://localhost:3000/health` to verify.

## Architecture notes

- **`server.js`** — Express app, CORS, Puppeteer browser singleton, routes
- **`src/pdf-generator.js`** — orchestrates validate → render → pdf → upload → update
- **`src/template.js`** — self-contained HTML template builder (Nunito Sans via Google Fonts)
- **`src/ghl-client.js`** — GHL media upload + contact custom field update
- **`src/validators.js`** — request payload validation
- **Browser lifecycle** — one Chromium launched on startup, reused across requests. New page per request, closed in a finally block. Browser disconnect handler triggers relaunch.
- **`src/upload-retry.js`** — retry policy: which failures are worth repeating, and the backoff
- **GHL API rules** — contact PUT must contain ONLY `customFields`; no `locationId`, no `tags`.

## Resilience

On 2026-09-17 a single 30s watchdog covered PDF generation *and* the GHL upload
together. Puppeteer produced a valid 245KB PDF in under a second, GHL returned a
Cloudflare 524, and the watchdog threw the finished PDF away while reporting
`PDF generation timed out`. The empty `Estimate PDF URL` field then caused the
"E.2 Calculator Bridge v2" workflow to classify a completed lead as abandoned.

What changed:

- **Independent budgets.** Generation gets 20s; each GHL attempt gets 25s. A slow
  upload can no longer discard a finished PDF.
- **The Chromium page is released after generation**, before either GHL call, so
  a retry window never pins a browser page. Page lifetime went *down* (≤20s, from
  up to 30s) even though a worst-case request now runs longer.
- **Both GHL calls retry** — 3 attempts, exponential backoff with jitter — on
  timeouts, 5xx, 429 and network errors. A 4xx fails immediately; a duplicate
  media file is cheaper than a misclassified homeowner. The contact PUT is
  retried too, because it is the call the workflow actually reads.
- **Bounded worst case**, readable off the config:
  `MAX_ATTEMPTS * (TIMEOUT_MS + BACKOFF_MAX_MS)` per stage. A `Retry-After`
  longer than the backoff cap stops the loop rather than extending it.
- **Upstream failures log a status and a 200-char body snippet**, not a full
  Cloudflare error page.

Run the tests with `npm test` (`node --test`, no extra dependencies).
