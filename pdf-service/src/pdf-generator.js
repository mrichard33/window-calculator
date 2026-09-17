'use strict';

/**
 * PDF generator: orchestrates template render -> Puppeteer page.pdf() ->
 * GHL media upload -> GHL contact update.
 *
 * The caller (server.js) owns the Puppeteer browser singleton and passes in its
 * `withPage` helper. We scope the page to GENERATION ONLY and let it close
 * before either GHL call runs — see the note on page lifetime below.
 *
 * Error handling (revised 2026-09-17):
 *   - Missing contact_id/api_key -> skip GHL, return 200 { pdfBase64, pdfUrl: null }
 *   - GHL upload fails after retries   -> throw GhlStageError -> server returns 502
 *   - GHL contact update fails likewise -> throw GhlStageError -> server returns 502
 *   - Puppeteer fails            -> throw (server.js returns 500)
 *
 * The upload and contact-update failures used to be swallowed into a 200 with a
 * `warning` field. Nothing ever read that field — the only caller checks
 * `resp.ok` and discards the body — so a broken upload was logged upstream as
 * "pdf-service accepted". They are hard failures now, and the stage is named in
 * the response so a log read six weeks from now says which half broke.
 */

const { renderEstimateHTML } = require('./template');
const ghlClient = require('./ghl-client');
const retry = require('./upload-retry');

const intEnv = retry.intEnv;

const PDF_GENERATE_TIMEOUT_MS = intEnv('PDF_GENERATE_TIMEOUT_MS', 20000);
const GHL_UPLOAD_TIMEOUT_MS = intEnv('GHL_UPLOAD_TIMEOUT_MS', 25000);
const GHL_CONTACT_TIMEOUT_MS = intEnv('GHL_CONTACT_TIMEOUT_MS', 25000);

/**
 * Bound a promise that has no timeout option of its own.
 *
 * Note this does NOT cancel the underlying work — a Promise.race cannot stop
 * Puppeteer. The only thing that kills a hung page.pdf() is page.close(), which
 * withPage's finally block performs, so this must always be raced INSIDE
 * withPage or a timeout leaks a working page until the browser OOMs.
 */
function withTimeout(promise, ms, label) {
  // Swallow a late rejection from the loser so it cannot surface as an
  // unhandledRejection after the race has already settled.
  promise.catch(() => {});

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`);
      err.name = 'TimeoutError';
      err.stage = 'generate';
      reject(err);
    }, ms);
  });

  // clearTimeout matters: without it every fast request parks a live 20s timer,
  // which keeps the event loop busy and delays process.exit(0) in the SIGTERM
  // handler — a real symptom on Railway redeploys.
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function generatePdfBuffer(page, estimate, renderHtml) {
  const html = renderHtml(estimate);

  // networkidle0 waits for Google Fonts CDN to finish loading before we
  // emit the PDF. Without this, the first request after cold start can
  // render in a fallback font.
  //
  // Same budget as the outer withTimeout on purpose: setContent starts first so
  // its more specific error normally wins, and the outer race only fires when
  // the hang is in evaluate() or pdf(). A LARGER budget here would mean the
  // outer race always fires and the "which stage hung" signal is lost.
  await page.setContent(html, {
    waitUntil: 'networkidle0',
    timeout: PDF_GENERATE_TIMEOUT_MS,
  });

  await page.emulateMediaType('print');

  // Belt-and-braces: also wait for document.fonts.ready
  try {
    await page.evaluate(() => document.fonts && document.fonts.ready);
  } catch (_) {
    // Not all Chromium builds expose document.fonts; non-fatal.
  }

  const pdfBuffer = await page.pdf({
    format: 'Letter',
    printBackground: true,
    preferCSSPageSize: false,
    margin: {
      top: '0.5in',
      right: '0.7in',
      bottom: '0.6in',
      left: '0.7in',
    },
  });

  return pdfBuffer;
}

/**
 * Generate an estimate PDF and push it to GHL.
 *
 * @param {object} args
 * @param {(fn: (page:any) => Promise<*>) => Promise<*>} args.withPage
 * @param {object} args.body - validated request body
 * @param {object} [deps] - { renderHtml, uploadWithRetry, updateContactWithRetry, logger }
 * @returns {Promise<{ response: object, metrics: object }>}
 */
async function generate({ withPage, body }, deps) {
  const d = deps || {};
  const renderHtml = d.renderHtml || renderEstimateHTML;
  const doUpload = d.uploadWithRetry || retry.uploadWithRetry;
  const doUpdateContact = d.updateContactWithRetry || retry.updateContactWithRetry;
  const logger = d.logger || console;

  const estimate = body.estimate;
  const contactId = body.contact_id;
  const ghlApiKey = body.ghl_api_key;

  const totalWindows = (estimate.project && estimate.project.totalWindows) || 0;
  logger.log(`[PDF] Generating PDF: contact_id=${contactId || 'none'}, windows=${totalWindows}, grandTotal=${estimate.costs && estimate.costs.grandTotal}`);

  // --- Stage 1: generation. The page lives only for this block. -------------
  // Holding the page across the GHL stages would pin an open Chromium page for
  // the whole retry window; on a single replica during a GHL outage, concurrent
  // completions would each hold one for minutes. Nothing past this point needs
  // the page — the buffer is all that matters.
  const generateStarted = Date.now();
  const pdfBuffer = await withPage((page) =>
    withTimeout(
      generatePdfBuffer(page, estimate, renderHtml),
      PDF_GENERATE_TIMEOUT_MS,
      'PDF generation',
    ));
  const generateMs = Date.now() - generateStarted;
  logger.log(`[PDF] Puppeteer PDF generated: ${Math.round(pdfBuffer.length / 1024)}KB in ${generateMs}ms`);

  const fileName = `Reece-Windows-Estimate-${Date.now()}.pdf`;

  // --- Skip path: no credentials, nothing to upload to. ---------------------
  // This returns BEFORE any retry is constructed, so it cannot produce a
  // GhlStageError and cannot become a 502. No flag to get wrong.
  if (!contactId || !ghlApiKey) {
    logger.log(`[PDF] Skipping GHL upload (missing ${!contactId ? 'contact_id' : 'ghl_api_key'})`);
    return {
      response: {
        success: true,
        pdfUrl: null,
        pdfBase64: Buffer.from(pdfBuffer).toString('base64'),
        fileName,
        contactUpdated: false,
        warning: 'GHL upload skipped: missing contact_id or ghl_api_key',
      },
      metrics: {
        generateMs,
        uploadMs: 0,
        uploadAttempts: 0,
        contactUpdateMs: 0,
        contactAttempts: 0,
        pdfBytes: pdfBuffer.length,
      },
    };
  }

  // --- Stage 2: upload ------------------------------------------------------
  let upload;
  try {
    upload = await doUpload(
      pdfBuffer,
      { contactId, fileName, ghlApiKey, timeoutMs: GHL_UPLOAD_TIMEOUT_MS },
      deps,
    );
  } catch (err) {
    // Re-stamp from the buffer we STILL HOLD. This is the 2026-09-17 regression
    // made observable: the finished PDF survives an upload failure instead of
    // being destroyed by a request-wide watchdog.
    err.pdfBytes = pdfBuffer.length;
    throw err;
  }
  const pdfUrl = upload.value;

  // --- Stage 3: write the field the E.2 workflow actually reads -------------
  let contactUpdate;
  try {
    contactUpdate = await doUpdateContact(
      contactId,
      pdfUrl,
      { ghlApiKey, timeoutMs: GHL_CONTACT_TIMEOUT_MS, pdfBytes: pdfBuffer.length },
      deps,
    );
  } catch (err) {
    err.pdfBytes = pdfBuffer.length;
    err.pdfUrl = pdfUrl;
    throw err;
  }

  return {
    response: {
      success: true,
      pdfUrl,
      fileName,
      contactUpdated: true,
    },
    metrics: {
      generateMs,
      uploadMs: upload.elapsedMs,
      uploadAttempts: upload.attempts,
      contactUpdateMs: contactUpdate.elapsedMs,
      contactAttempts: contactUpdate.attempts,
      pdfBytes: pdfBuffer.length,
    },
  };
}

module.exports = {
  generate,
  withTimeout,
  PDF_GENERATE_TIMEOUT_MS,
  GHL_UPLOAD_TIMEOUT_MS,
  GHL_CONTACT_TIMEOUT_MS,
};
