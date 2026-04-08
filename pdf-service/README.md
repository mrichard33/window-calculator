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

If `contact_id` is missing or the GHL media upload fails, the response
includes `pdfBase64` so the browser still has a usable PDF.

### `GET /health`

Launches a test page and closes it to verify Puppeteer is alive. Returns
`{ status: "ok", puppeteer: true, timestamp: "..." }` or a 503 if Chromium
is dead.

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
6. Update `PDF_SERVICE_CONFIG.url` in `../index.html` with the real Railway URL.

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
- **GHL API rules** — contact PUT must contain ONLY `customFields`; no `locationId`, no `tags`.
