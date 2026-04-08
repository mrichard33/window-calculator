'use strict';

/**
 * Reece PDF microservice — Express + Puppeteer.
 *
 * Endpoints:
 *   POST /api/generate-estimate-pdf - render estimate as PDF, upload to GHL
 *   GET  /health                    - liveness probe (verifies Puppeteer)
 *
 * Browser lifecycle:
 *   - One Chromium launched at startup and shared across requests.
 *   - Each request creates a fresh page and closes it in a finally block.
 *   - If the browser disconnects (crash, OOM), we relaunch on the next request.
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
  const started = Date.now();
  const body = req.body || {};

  // 1. Validate
  const { valid, errors } = validatePayload(body);
  if (!valid) {
    console.warn('[PDF] Validation failed:', errors);
    return res.status(400).json({ success: false, errors });
  }

  console.log(`[PDF] Request received: contact_id=${body.contact_id || 'none'}, windows=${(body.estimate.project && body.estimate.project.totalWindows) || 0}`);

  // 2. Render and generate, wrapped in a hard timeout so a hung Chromium
  // doesn't block the response indefinitely.
  try {
    const result = await Promise.race([
      withPage((page) => pdfGenerator.generate({ page, body })),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`PDF generation timed out after ${pdfGenerator.PDF_TIMEOUT_MS}ms`)),
          pdfGenerator.PDF_TIMEOUT_MS
        )
      ),
    ]);

    const elapsed = Date.now() - started;
    console.log(`[PDF] Complete: contact_id=${body.contact_id || 'none'}, pdfUrl=${result.pdfUrl || 'none'}, ${elapsed}ms`);
    return res.json(result);
  } catch (err) {
    console.error('[PDF] Generation failed:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'PDF generation failed',
    });
  }
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
