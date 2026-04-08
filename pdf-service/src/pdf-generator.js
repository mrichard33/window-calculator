'use strict';

/**
 * PDF generator: orchestrates template render -> Puppeteer page.pdf() ->
 * optional GHL media upload -> optional GHL contact update.
 *
 * The caller (server.js) owns the Puppeteer browser singleton and passes
 * in a fresh `page` via `getPage()`. This keeps pdf-generator unit-testable
 * and lets the server handle browser lifecycle separately.
 *
 * Error handling per handoff §9:
 *   - Missing contact_id      -> skip GHL, return { pdfBase64, pdfUrl: null }
 *   - GHL upload fails        -> return { pdfBase64, pdfUrl: null, warning }
 *   - Contact update fails    -> return { pdfUrl, contactUpdated: false } (PDF still uploaded)
 *   - Puppeteer fails         -> throw (server.js returns 500)
 */

const { renderEstimateHTML } = require('./template');
const { uploadMedia, updateContactPdfField } = require('./ghl-client');

const PDF_TIMEOUT_MS = 30_000;

async function generatePdfBuffer(page, estimate) {
  const html = renderEstimateHTML(estimate);

  // networkidle0 waits for Google Fonts CDN to finish loading before we
  // emit the PDF. Without this, the first request after cold start can
  // render in a fallback font.
  await page.setContent(html, {
    waitUntil: 'networkidle0',
    timeout: PDF_TIMEOUT_MS,
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
 * Generate an estimate PDF and optionally upload it to GHL.
 *
 * @param {object} args
 * @param {import('puppeteer-core').Page} args.page - fresh Puppeteer page
 * @param {object} args.body - validated request body
 * @returns {Promise<object>} response payload for the caller
 */
async function generate({ page, body }) {
  const estimate = body.estimate;
  const contactId = body.contact_id;
  const ghlApiKey = body.ghl_api_key;

  const totalWindows = (estimate.project && estimate.project.totalWindows) || 0;
  console.log(`[PDF] Generating PDF: contact_id=${contactId || 'none'}, windows=${totalWindows}, grandTotal=${estimate.costs && estimate.costs.grandTotal}`);

  const pdfBuffer = await generatePdfBuffer(page, estimate);
  console.log(`[PDF] Puppeteer PDF generated: ${Math.round(pdfBuffer.length / 1024)}KB`);

  const fileName = `Reece-Windows-Estimate-${Date.now()}.pdf`;
  const pdfBase64 = Buffer.from(pdfBuffer).toString('base64');

  // If we can't upload to GHL, return the base64 so the browser still has
  // something to offer the user.
  if (!contactId || !ghlApiKey) {
    console.log(`[PDF] Skipping GHL upload (missing ${!contactId ? 'contact_id' : 'ghl_api_key'})`);
    return {
      success: true,
      pdfUrl: null,
      pdfBase64,
      fileName,
      contactUpdated: false,
      warning: 'GHL upload skipped: missing contact_id or ghl_api_key',
    };
  }

  // Try to upload the media. If this fails we still return 200 + base64
  // so the client has a usable PDF (per handoff §9 #2).
  let pdfUrl;
  try {
    pdfUrl = await uploadMedia(pdfBuffer, fileName, ghlApiKey);
    console.log(`[GHL] Media uploaded: ${pdfUrl}`);
  } catch (err) {
    console.error('[GHL] Media upload failed:', err.message);
    return {
      success: true,
      pdfUrl: null,
      pdfBase64,
      fileName,
      contactUpdated: false,
      warning: `GHL media upload failed: ${err.message}`,
    };
  }

  // Try to update the contact. If this fails we still return success
  // with the pdfUrl (per handoff §9 #3 — PDF was uploaded, field update is secondary).
  let contactUpdated = false;
  let contactUpdateWarning;
  try {
    await updateContactPdfField(contactId, pdfUrl, ghlApiKey);
    contactUpdated = true;
    console.log(`[GHL] Contact ${contactId} updated with PDF URL`);
  } catch (err) {
    console.error('[GHL] Contact update failed:', err.message);
    contactUpdateWarning = `GHL contact update failed: ${err.message}`;
  }

  const response = {
    success: true,
    pdfUrl,
    fileName,
    contactUpdated,
  };
  if (contactUpdateWarning) response.warning = contactUpdateWarning;

  return response;
}

module.exports = { generate, PDF_TIMEOUT_MS };
