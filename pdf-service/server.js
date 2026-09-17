'use strict';

/**
 * Reece PDF microservice — Express + Puppeteer.
 *
 * Endpoints:
 *   POST /api/generate-estimate-pdf - render estimate as PDF, upload to GHL
 *   GET  /health                    - deep probe (launches a Puppeteer page)
 *   GET  /healthz                   - cheap liveness probe (no I/O)
 *
 * Browser lifecycle:
 *   - One Chromium launched at startup and shared across requests.
 *   - Each request creates a fresh page and closes it in a finally block.
 *   - If the browser disconnects (crash, OOM), we relaunch on the next request.
 *   - `withPage` is handed to pdf-generator, which scopes it to PDF generation
 *     only so no page is held open while we talk to GHL.
 */

const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-core');

const { validatePayload } = require('./src/validators');
const pdfGenerator = require('./src/pdf-generator');

const PORT = Number(process.env.PORT) || 3000;
const PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

// -------------------- CORS --------------------

// Exact-match origins from env var (comma-separated), plus a hardcoded regex
// for any *.msgsndr.com subdomain (GHL funnel hosting).
const envOrigins = (process.env.ALLOWED_ORIGINS || 'https://landing.reecewindows.com,https://reecewindows.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const MSGSNDR_REGEX = /^https:\/\/([a-z0-9-]+\.)*msgsndr\.com$/i;
const LOCALHOST_REGEX = /^https?:\/\/localhost(:\d+)?$/i;

function corsOriginCheck(origin, callback) {
  // Requests with no Origin header (curl, server-to-server, /health probes)
  // are always allowed.
  if (!origin) return callback(null, true);

  if (envOrigins.includes(origin)) return callback(null, true);
  if (MSGSNDR_REGEX.test(origin)) return callback(null, true);
  if (process.env.NODE_ENV !== 'production' && LOCALHOST_REGEX.test(origin)) {
    return callback(null, true);
  }

  console.warn(`[CORS] Rejected origin: ${origin}`);
  return callback(new Error(`Origin ${origin} not allowed by CORS`));
}

// -------------------- Browser singleton --------------------

let browserPromise = null;

async function launchBrowser() {
  console.log('[Puppeteer] Launching Chromium...');
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: PUPPETEER_EXECUTABLE_PATH,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--font-render-hinting=none',
    ],
  });

  browser.on('disconnected', () => {
    console.warn('[Puppeteer] Browser disconnected; will relaunch on next request');
    browserPromise = null;
  });

  console.log('[Puppeteer] Chromium launched');
  return browser;
}

function getBrowser() {
  if (!browserPromise) {
    browserPromise = launchBrowser().catch((err) => {
      console.error('[Puppeteer] Failed to launch:', err);
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

async function withPage(fn) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    return await fn(page);
  } finally {
    try {
      await page.close();
    } catch (err) {
      console.warn('[Puppeteer] page.close() failed:', err.message);
    }
  }
}

// -------------------- Express --------------------

const app = express();

app.use(cors({
  origin: corsOriginCheck,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

// Large JSON bodies are fine — estimate payloads are ~5-20KB, but we allow
// a generous ceiling for safety.
app.use(express.json({ limit: '2mb' }));

// -------------------- Routes --------------------

app.get('/health', async (req, res) => {
  try {
    await withPage(async (page) => {
      await page.setContent('<html><body>ok</body></html>');
    });
    res.json({
      status: 'ok',
      puppeteer: true,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Health] Puppeteer check failed:', err);
    res.status(503).json({
      status: 'error',
      puppeteer: false,
      error: err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

app.post('/api/generate-estimate-pdf', async (req, res) => {
  const body = req.body || {};

  // 1. Validate
  const { valid, errors } = validatePayload(body);
  if (!valid) {
    console.warn('[PDF] Validation failed:', errors);
    return res.status(400).json({ success: false, errors });
  }

  const contactId = body.contact_id || 'none';
  console.log(`[PDF] Request received: contact_id=${contactId}, windows=${(body.estimate.project && body.estimate.project.totalWindows) || 0}`);

  // 2. Generate and deliver.
  //
  // There is deliberately NO request-wide watchdog here any more. The old one
  // raced the whole handler against 30s; on 2026-09-17 it fired while a healthy
  // 245KB PDF waited on a Cloudflare 524 from GHL, threw the PDF away, and
  // reported it as "PDF generation timed out". Each stage now carries its own
  // budget (generation 20s, each GHL attempt 25s) and pdf-generator scopes the
  // Chromium page to generation alone.
  try {
    const { response, metrics } = await pdfGenerator.generate({ withPage, body });

    console.log(
      `[PDF] Complete: contact_id=${contactId}, generate_ms=${metrics.generateMs}, `
      + `upload_ms=${metrics.uploadMs}, attempts=${metrics.uploadAttempts}`
    );
    return res.json(response);
  } catch (err) {
    if (err && err.code === 'ghl_upload_failed') {
      // 502, not 500: this was upstream, not our bug. The distinction is what
      // makes a log read six weeks from now interpretable.
      console.error(
        `[PDF] ${err.stage} failed: contact_id=${err.contactId || contactId}, `
        + `attempts=${err.attempts}, status=${err.status != null ? err.status : 'none'}, `
        + `pdf_bytes=${err.pdfBytes}, body=${err.bodySnippet || ''}`
      );
      return res.status(502).json({
        error: 'ghl_upload_failed',
        stage: err.stage,
        attempts: err.attempts,
        contact_id: body.contact_id || null,
      });
    }

    console.error('[PDF] Generation failed:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'PDF generation failed',
    });
  }
});

// Cheap liveness probe: no Puppeteer, no I/O. GET / used to 404, so there was
// no way to check the service was up without submitting a real estimate.
app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true, service: 'pdf-service' });
});

// 404 fallback for unknown routes
app.use((req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
});

// -------------------- Startup --------------------

const server = app.listen(PORT, () => {
  console.log(`[Server] Reece PDF service listening on :${PORT}`);
  console.log(`[Server] Allowed origins: ${envOrigins.join(', ')} + *.msgsndr.com`);
  // Warm the browser so the first real request doesn't pay launch cost.
  getBrowser().catch((err) => console.error('[Server] Initial browser launch failed:', err));
});

// -------------------- Graceful shutdown --------------------

async function shutdown(signal) {
  console.log(`[Server] ${signal} received, shutting down...`);
  server.close(() => console.log('[Server] HTTP server closed'));
  if (browserPromise) {
    try {
      const browser = await browserPromise;
      await browser.close();
      console.log('[Puppeteer] Browser closed');
    } catch (err) {
      console.warn('[Puppeteer] Shutdown close failed:', err.message);
    }
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
