'use strict';

/**
 * GHL (GoHighLevel) API client.
 *
 * Two operations:
 *   1. uploadMedia(pdfBuffer, fileName, ghlApiKey) -> pdfUrl
 *   2. updateContactPdfField(contactId, pdfUrl, ghlApiKey) -> true
 *
 * Uses Node 20's built-in fetch and FormData — no third-party form-data
 * or node-fetch dependency needed.
 *
 * CRITICAL GHL API rules (per handoff §6):
 *   - `locationId` must NEVER appear in a PUT body to /contacts/{id}
 *   - `tags` array must NEVER be in a PUT /contacts/{id} body (full replacement)
 *   - Only send `customFields` in the contact update
 */

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';
const PDF_CUSTOM_FIELD_ID = 'WwmVP3sAjdqYQbZyITZT';

async function uploadMedia(pdfBuffer, fileName, ghlApiKey) {
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
  });

  const rawBody = await resp.text();
  if (!resp.ok) {
    throw new Error(`GHL media upload failed: ${resp.status} ${rawBody}`);
  }

  let data;
  try {
    data = JSON.parse(rawBody);
  } catch (err) {
    throw new Error(`GHL media upload returned non-JSON body: ${rawBody}`);
  }

  // Log the full response body so we can verify the shape during testing.
  // The live n8n workflow reads `$json.uploadedFiles.url` (object form), but
  // the API has been observed returning other shapes. The extractor below
  // covers all known paths.
  console.log('[GHL] Media upload response body:', JSON.stringify(data));

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
    throw new Error(
      `GHL media upload succeeded but URL not found in response: ${JSON.stringify(data)}`
    );
  }

  return url;
}

async function updateContactPdfField(contactId, pdfUrl, ghlApiKey) {
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
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`GHL contact update failed: ${resp.status} ${errText}`);
  }

  return true;
}

module.exports = {
  uploadMedia,
  updateContactPdfField,
  PDF_CUSTOM_FIELD_ID,
};
