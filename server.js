'use strict';
/**
 * Reece Windows & Doors — Window Estimate Calculator v2
 *
 * Serves the S/M/L calculator page and a thin API that owns everything the
 * browser used to do directly against GoHighLevel. The browser never holds a
 * credential: the GHL Private Integration Token lives in GHL_API_KEY (Railway
 * env var) and every GHL call happens here.
 *
 * It serves two things: the standalone landing page at / (the destination for
 * paid, SMS, email, QR and vendor traffic) and /embed/calculator.js, the single
 * copy of the calculator that both that page and the WordPress SEO page at
 * reecewindows.com/window-estimate load.
 *
 * Endpoints:
 *   GET  /health, /healthz   — liveness (also proves the PORT fix)
 *   GET  /embed/calculator.js — the calculator, for any allowed host page
 *   POST /api/contact        — GHL upsert; refuses without consent:true;
 *                              stamps calc_consent_at + calc_consent_version
 *   POST /api/verify/start   — issues a 6-digit code server-side, delivers it
 *                              via the existing GHL verification workflow
 *   POST /api/verify/check   — validates the code (TTL + attempt cap) and
 *                              returns a signed estimate token
 *   POST /api/estimate       — token-gated; contact estimate update +
 *                              estimate webhook + pdf-service, all server-side
 *   POST /api/events         — first-party funnel events -> HL Supabase
 *
 * Node 18+ (global fetch). Only dependency: express.
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 8080;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const GHL_BASE_URL = process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com';
const GHL_API_KEY = process.env.GHL_API_KEY || '';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || '';
const GHL_API_VERSION = process.env.GHL_API_VERSION || '2021-07-28';
const GHL_ESTIMATE_WEBHOOK_URL = process.env.GHL_ESTIMATE_WEBHOOK_URL || '';
const GHL_VERIFY_WEBHOOK_URL = process.env.GHL_VERIFY_WEBHOOK_URL || '';
const PDF_SERVICE_URL = process.env.PDF_SERVICE_URL || '';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ESTIMATE_TOKEN_SECRET = process.env.ESTIMATE_TOKEN_SECRET || '';
// The two host pages plus the Railway domain. Baked in as the default so the
// WordPress page cannot be broken by an env var edit; ALLOWED_ORIGINS still
// overrides it when a new origin needs adding.
const DEFAULT_ALLOWED_ORIGINS = [
  'https://reecewindows.com',
  'https://www.reecewindows.com',
  'https://estimate.getreecewindows.com'
];
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(function (s) { return s.trim(); }).filter(Boolean)
  .concat(DEFAULT_ALLOWED_ORIGINS)
  .filter(function (o, i, all) { return all.indexOf(o) === i; });

// Paths a link in an old ad, text or printed QR code might still point at.
// git history shows this service has only ever served the page at / and
// /index.html, so these are insurance rather than a known break — but a lead
// who lands on one must still reach the calculator, with their attribution
// intact.
const LEGACY_PAGE_PATHS = [
  '/index.html',
  '/window-estimate', '/window-estimate/',
  '/estimate', '/estimate/',
  '/calculator', '/calculator/'
];

const VERIFY_TTL_MS = (parseInt(process.env.VERIFY_CODE_TTL_MINUTES, 10) || 10) * 60 * 1000;
const VERIFY_MAX_ATTEMPTS = parseInt(process.env.VERIFY_MAX_ATTEMPTS, 10) || 5;
const VERIFY_MAX_SENDS_PER_HOUR = parseInt(process.env.VERIFY_MAX_SENDS_PER_HOUR, 10) || 6;
const ESTIMATE_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour to reach step 4

// Boot-time sanity: warn loudly, never crash — the page must still serve.
[['GHL_API_KEY', GHL_API_KEY], ['GHL_LOCATION_ID', GHL_LOCATION_ID],
 ['GHL_ESTIMATE_WEBHOOK_URL', GHL_ESTIMATE_WEBHOOK_URL],
 ['GHL_VERIFY_WEBHOOK_URL', GHL_VERIFY_WEBHOOK_URL],
 ['PDF_SERVICE_URL', PDF_SERVICE_URL], ['SUPABASE_URL', SUPABASE_URL],
 ['SUPABASE_SERVICE_ROLE_KEY', SUPABASE_SERVICE_ROLE_KEY],
 ['ESTIMATE_TOKEN_SECRET', ESTIMATE_TOKEN_SECRET]
].forEach(function (pair) {
  if (!pair[1]) console.warn('[boot] WARNING: env var ' + pair[0] + ' is not set');
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.disable('x-powered-by');
app.set('trust proxy', true); // Railway sits behind a proxy
app.use(express.json({ limit: '1mb' }));
// sendBeacon cannot issue a preflight, so cross-origin it must post a
// CORS-simple content type. /api/events accepts text/plain and parses it in
// the handler; express.json still serves application/json callers unchanged.
app.use(express.text({ type: 'text/plain', limit: '64kb' }));

app.use(function (req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Origin gate + CORS for the API. The page now ships from
// reecewindows.com/window-estimate while this service stays on Railway, so
// API calls are genuinely cross-origin and the browser requires real CORS
// headers. The allow list is authoritative: an empty ALLOWED_ORIGINS now
// DENIES every cross-origin caller rather than allowing all of them.
app.use('/api', function (req, res, next) {
  const origin = req.get('origin');

  // Caches must never serve one origin's ACAO header to another.
  res.set('Vary', 'Origin');

  // No Origin header: server-to-server, curl, same-origin navigation.
  if (!origin) return next();

  if (ALLOWED_ORIGINS.indexOf(origin) === -1) {
    return res.status(403).json({ error: 'ORIGIN_NOT_ALLOWED' });
  }

  // Echo the specific origin, never '*' — these endpoints write to GHL.
  // Credentials stay off: auth is a body token (estimateToken) and no
  // endpoint issues Set-Cookie.
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
});

// Small in-memory per-IP rate limiter. Single replica; resets on deploy.
const rlBuckets = new Map();
function rateLimit(max, windowMs) {
  return function (req, res, next) {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    const key = req.path + '|' + ip;
    const now = Date.now();
    let bucket = rlBuckets.get(key);
    if (!bucket || now > bucket.reset) {
      bucket = { count: 0, reset: now + windowMs };
      rlBuckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > max) {
      res.set('Retry-After', String(Math.ceil((bucket.reset - now) / 1000)));
      return res.status(429).json({ error: 'RATE_LIMITED' });
    }
    next();
  };
}
setInterval(function () {
  const now = Date.now();
  rlBuckets.forEach(function (b, k) { if (now > b.reset) rlBuckets.delete(k); });
}, 60 * 1000).unref();

// ---------------------------------------------------------------------------
// GHL helper
// ---------------------------------------------------------------------------
async function ghl(pathname, options) {
  options = options || {};
  const resp = await fetch(GHL_BASE_URL + pathname, {
    method: options.method || 'POST',
    headers: {
      'Authorization': 'Bearer ' + GHL_API_KEY,
      'Version': GHL_API_VERSION,
      'Content-Type': 'application/json'
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON body */ }
  if (!resp.ok) {
    const err = new Error('GHL ' + pathname + ' -> ' + resp.status + ': ' + text.slice(0, 300));
    err.status = resp.status;
    throw err;
  }
  return json;
}

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.charAt(0) === '1') return '+' + digits;
  return null;
}

function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 200); }

// Every redirect in this app goes through here. A plain res.redirect drops the
// query string, and that query string is the whole attribution chain: utm_*,
// fbclid, gclid. Losing it turns a paid click into an unattributed lead.
function redirectKeepQuery(req, res, target) {
  const qs = req.originalUrl.indexOf('?');
  return res.redirect(301, qs === -1 ? target : target + req.originalUrl.slice(qs));
}

// Which page produced this lead. Only these two values are ever accepted —
// anything else is a client that got creative, and gets ignored.
const PAGE_VARIANTS = ['standalone', 'main-domain'];
function pageVariant(p) {
  const v = str(p.pageVariant || p.page_variant, 40);
  return PAGE_VARIANTS.indexOf(v) === -1 ? null : v;
}

// ---------------------------------------------------------------------------
// POST /api/contact — consent-gated GHL upsert
// ---------------------------------------------------------------------------
app.post('/api/contact', rateLimit(20, 10 * 60 * 1000), async function (req, res) {
  const p = req.body || {};

  // The hard gate: no consent, no contact record. The client blocks this
  // locally too, but the server is the enforcement point.
  if (p.consent !== true) {
    return res.status(400).json({ error: 'CONSENT_REQUIRED' });
  }
  const phone = normalizePhone(p.phone);
  if (!phone) return res.status(400).json({ error: 'PHONE_INVALID' });
  const firstName = str(p.firstName, 100);
  const lastName = str(p.lastName, 100);
  if (!firstName && !lastName) return res.status(400).json({ error: 'NAME_REQUIRED' });

  try {
    // Preserve the legacy behavior: if the phone matches an existing contact
    // under a different name, save the old identity to notes before overwrite.
    let matched = null;
    try {
      const search = await ghl(
        '/contacts/search/duplicate?locationId=' + encodeURIComponent(GHL_LOCATION_ID) +
        '&number=' + encodeURIComponent(phone),
        { method: 'GET' }
      );
      matched = (search && search.contacts && search.contacts[0]) || (search && search.contact) || null;
    } catch (e) {
      console.warn('[contact] duplicate search failed (continuing to upsert):', e.message);
    }

    if (matched && matched.id) {
      const formName = (firstName + ' ' + lastName).toLowerCase().trim();
      const existingName = (((matched.firstName || '') + ' ' + (matched.lastName || ''))).toLowerCase().trim();
      if (existingName && formName !== existingName) {
        const stamp = new Date().toISOString();
        const parts = ['[Previous contact info overwritten via estimate calculator on ' + stamp + ']'];
        if (matched.firstName || matched.lastName) parts.push('Name: ' + (matched.firstName || '') + ' ' + (matched.lastName || ''));
        if (matched.phone) parts.push('Phone: ' + matched.phone);
        if (matched.email) parts.push('Email: ' + matched.email);
        try {
          await ghl('/contacts/' + matched.id, {
            method: 'PUT',
            body: { notes: parts.join('\n') + (matched.notes ? '\n\n' + matched.notes : '') }
          });
        } catch (e) {
          console.warn('[contact] notes preservation failed (continuing):', e.message);
        }
      }
    }

    const customFields = [];
    const utm = p.utm || {};
    if (utm.source) customFields.push({ key: 'utm_source', field_value: str(utm.source) });
    if (utm.medium) customFields.push({ key: 'utm_medium', field_value: str(utm.medium) });
    if (utm.campaign) customFields.push({ key: 'utm_campaign', field_value: str(utm.campaign) });
    if (utm.content) customFields.push({ key: 'utm_content', field_value: str(utm.content) });
    if (utm.term) customFields.push({ key: 'utm_term', field_value: str(utm.term) });
    // Click IDs and referrer — without these, Google Ads and Meta offline
    // conversion matching is impossible. Keys match the existing GHL click-ID
    // field family (fbclid, msclkid, ttclid, last_referrer).
    const clickIds = p.clickIds || {};
    if (clickIds.gclid) customFields.push({ key: 'gclid', field_value: str(clickIds.gclid, 400) });
    if (clickIds.fbclid) customFields.push({ key: 'fbclid', field_value: str(clickIds.fbclid, 400) });
    if (clickIds.msclkid) customFields.push({ key: 'msclkid', field_value: str(clickIds.msclkid, 400) });
    if (p.referrer) customFields.push({ key: 'last_referrer', field_value: str(p.referrer, 400) });
    if (p.lpSourceId) customFields.push({ key: 'lp_source_id', field_value: str(p.lpSourceId) });
    if (p.proId) customFields.push({ key: 'pro_id', field_value: str(p.proId) });
    // Consent audit trail — timestamps are UTC ISO 8601 by design.
    customFields.push({ key: 'calc_consent_at', field_value: new Date().toISOString() });
    customFields.push({ key: 'calc_consent_version', field_value: str(p.consentVersion || 'unknown', 64) });

    // Which of the two pages produced this lead. It is appended to the tag list
    // this endpoint already sent, so nothing that was being kept is dropped.
    // LP source, sub-source, pro_id and srs_id are untouched — page comparison
    // happens in GHL, not by minting a second Lead Perfection source.
    const variant = pageVariant(p);
    const tags = ['window-estimator'];
    if (variant) tags.push('calc-page:' + variant);

    const body = {
      locationId: GHL_LOCATION_ID,
      firstName: firstName,
      lastName: lastName,
      phone: phone,
      address1: str(p.address1),
      city: str(p.city, 100),
      state: str(p.state, 50),
      postalCode: str(p.postalCode, 20),
      source: 'Window Estimator',
      tags: tags,
      customFields: customFields
    };
    const email = str(p.email, 200);
    if (email) body.email = email;

    const result = await ghl('/contacts/upsert', { body: body });
    const contactId = (result && result.contact && result.contact.id) || (matched && matched.id) || null;
    return res.json({ contactId: contactId });
  } catch (err) {
    console.error('[contact] upsert failed:', err.message);
    return res.status(502).json({ error: 'CONTACT_UPSERT_FAILED' });
  }
});

// ---------------------------------------------------------------------------
// Email verification — codes are born and die on the server
// ---------------------------------------------------------------------------
const verifyStore = new Map();   // verifyId -> { codeHash, expiresAt, attempts, email, contactId }
const sendCounters = new Map();  // email -> { count, reset }

function sha256(s) { return crypto.createHash('sha256').update(s).digest(); }

setInterval(function () {
  const now = Date.now();
  verifyStore.forEach(function (rec, id) { if (now > rec.expiresAt) verifyStore.delete(id); });
  sendCounters.forEach(function (c, k) { if (now > c.reset) sendCounters.delete(k); });
}, 60 * 1000).unref();

app.post('/api/verify/start', rateLimit(12, 10 * 60 * 1000), function (req, res) {
  const p = req.body || {};
  const email = str(p.email, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'EMAIL_INVALID' });
  }

  const now = Date.now();
  let counter = sendCounters.get(email);
  if (!counter || now > counter.reset) {
    counter = { count: 0, reset: now + 60 * 60 * 1000 };
    sendCounters.set(email, counter);
  }
  counter.count++;
  if (counter.count > VERIFY_MAX_SENDS_PER_HOUR) {
    return res.status(429).json({ error: 'RESEND_LIMIT' });
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const verifyId = crypto.randomUUID();
  verifyStore.set(verifyId, {
    codeHash: sha256(code + '|' + verifyId),
    expiresAt: now + VERIFY_TTL_MS,
    attempts: 0,
    email: email,
    contactId: str(p.contactId, 64)
  });

  // Delivery rides the existing GHL verification workflow — same payload
  // shape the workflow's Send Email step already merges from.
  if (GHL_VERIFY_WEBHOOK_URL) {
    fetch(GHL_VERIFY_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email,
        code: code,
        contact_name: str(p.contactName, 200),
        contact_id: str(p.contactId, 64)
      })
    }).then(function (resp) {
      if (!resp.ok) console.warn('[verify] webhook responded', resp.status);
    }).catch(function (err) {
      console.warn('[verify] webhook send failed:', err.message);
    });
  } else {
    console.warn('[verify] GHL_VERIFY_WEBHOOK_URL not set — code cannot be delivered');
  }

  return res.json({ verifyId: verifyId, ttlSeconds: Math.floor(VERIFY_TTL_MS / 1000) });
});

app.post('/api/verify/check', rateLimit(40, 10 * 60 * 1000), function (req, res) {
  const p = req.body || {};
  const rec = p.verifyId ? verifyStore.get(String(p.verifyId)) : null;
  if (!rec || Date.now() > rec.expiresAt) {
    if (p.verifyId) verifyStore.delete(String(p.verifyId));
    return res.status(410).json({ error: 'CODE_EXPIRED' });
  }
  if (rec.attempts >= VERIFY_MAX_ATTEMPTS) {
    verifyStore.delete(String(p.verifyId));
    return res.status(429).json({ error: 'TOO_MANY_ATTEMPTS' });
  }
  rec.attempts++;

  const code = String(p.code || '');
  const ok = /^\d{6}$/.test(code) &&
    crypto.timingSafeEqual(sha256(code + '|' + String(p.verifyId)), rec.codeHash);

  if (!ok) {
    const remaining = VERIFY_MAX_ATTEMPTS - rec.attempts;
    if (remaining <= 0) {
      verifyStore.delete(String(p.verifyId));
      return res.status(429).json({ error: 'TOO_MANY_ATTEMPTS' });
    }
    return res.status(400).json({ error: 'CODE_INCORRECT', attemptsRemaining: remaining });
  }

  verifyStore.delete(String(p.verifyId));
  let estimateToken;
  try {
    estimateToken = signToken({
      cid: rec.contactId || '',
      email: rec.email,
      exp: Date.now() + ESTIMATE_TOKEN_TTL_MS
    });
  } catch (err) {
    // Misconfiguration, not a bad code — say so rather than blaming the lead.
    console.error('[verify] cannot issue estimate token:', err.message);
    return res.status(503).json({ error: 'VERIFY_UNAVAILABLE' });
  }
  return res.json({ verified: true, estimateToken: estimateToken });
});

// ---------------------------------------------------------------------------
// Estimate token — HMAC-signed, proves the email verification happened
// ---------------------------------------------------------------------------
// Without a secret the HMAC would be keyed on '' — tokens anyone could forge, and
// the estimate gate would silently stand open. Fail closed instead: refuse to mint
// tokens, and treat every presented token as invalid.
function signToken(payload) {
  if (!ESTIMATE_TOKEN_SECRET) throw new Error('ESTIMATE_TOKEN_SECRET is not configured');
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', ESTIMATE_TOKEN_SECRET).update(b).digest('base64url');
  return b + '.' + sig;
}
function readToken(token) {
  if (!ESTIMATE_TOKEN_SECRET) return null;
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const want = crypto.createHmac('sha256', ESTIMATE_TOKEN_SECRET).update(parts[0]).digest();
    const got = Buffer.from(parts[1], 'base64url');
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// POST /api/estimate — the step-4 pipeline, server-side
// ---------------------------------------------------------------------------
app.post('/api/estimate', rateLimit(10, 10 * 60 * 1000), async function (req, res) {
  const p = req.body || {};
  const token = readToken(p.estimateToken);
  if (!token) return res.status(401).json({ error: 'VERIFY_REQUIRED' });

  const contactId = str(p.contactId, 64) || token.cid || '';
  const contactName = str(p.contactName, 200);
  const estimateTotal = p.estimateTotal != null ? String(p.estimateTotal) : '';
  const windowCount = parseInt(p.windowCount, 10) || 0;

  // 1) Contact estimate update (mirrors the old client-side PUT)
  const variant = pageVariant(p);
  if (contactId) {
    try {
      const customFields = [];
      if (estimateTotal) customFields.push({ key: 'estimate_total', field_value: estimateTotal });
      if (windowCount) customFields.push({ key: 'window_count', field_value: String(windowCount) });
      // Carry calc-page through this update too. Whether GHL merges or replaces
      // the tag list here, the contact ends up with the page it came from.
      const tags = ['window-estimator', 'estimator-completed'];
      if (variant) tags.push('calc-page:' + variant);
      await ghl('/contacts/' + contactId, {
        method: 'PUT',
        body: {
          tags: tags,
          customFields: customFields
        }
      });
    } catch (err) {
      console.error('[estimate] contact update failed:', err.message);
    }
  }

  // 2) Estimate webhook (same field shape the workflow expects — minus the
  //    API key, which no longer travels in payloads)
  if (GHL_ESTIMATE_WEBHOOK_URL) {
    fetch(GHL_ESTIMATE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contact_id: contactId,
        contact_name: contactName,
        event: 'estimate_completed',
        estimate_total: estimateTotal,
        window_count: windowCount,
        page_variant: variant || '',
        ghl_location_id: GHL_LOCATION_ID
      })
    }).then(function (resp) {
      if (!resp.ok) console.warn('[estimate] webhook responded', resp.status);
    }).catch(function (err) {
      console.warn('[estimate] webhook failed:', err.message);
    });
  }

  // 3) PDF microservice — server-to-server; key from env, never from a client
  if (PDF_SERVICE_URL && p.estimate) {
    fetch(PDF_SERVICE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contact_id: contactId,
        contact_name: contactName,
        contact_phone: str(p.contactPhone, 30),
        contact_email: str(p.contactEmail, 200),
        ghl_api_key: GHL_API_KEY,
        ghl_location_id: GHL_LOCATION_ID,
        estimate: p.estimate
      })
    }).then(async function (resp) {
      if (!resp.ok) {
        const body = await resp.text();
        console.error('[estimate] pdf-service HTTP ' + resp.status + ': ' + body.slice(0, 300));
      } else {
        console.log('[estimate] pdf-service accepted for contact', contactId || '(none)');
      }
    }).catch(function (err) {
      console.error('[estimate] pdf-service failed:', err.message);
    });
  }

  // The lead already sees their estimate; PDF and webhook complete in the
  // background. 202 = accepted.
  return res.status(202).json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/events — first-party funnel analytics -> HL Supabase
// ---------------------------------------------------------------------------
app.post('/api/events', rateLimit(120, 60 * 1000), function (req, res) {
  let p = req.body || {};
  // text/plain bodies (sendBeacon) arrive as a raw string.
  if (typeof p === 'string') {
    try { p = JSON.parse(p); } catch (e) { return res.status(400).json({ error: 'BAD_EVENT' }); }
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return res.status(400).json({ error: 'BAD_EVENT' });
  }
  // estimator_events is the table estimator_funnel_daily reads. Its column
  // names differ from the old calculator_events shape (contact_id not
  // ghl_contact_id, event_type not event, payload not meta) and it has no
  // client_ts column — an unknown column makes PostgREST reject the whole row.
  // page_variant, event_type and payload are NOT NULL; the defaults satisfy all three.
  const row = {
    session_id: str(p.session_id, 64),
    contact_id: p.contact_id ? str(p.contact_id, 64) : null,
    page_variant: str(p.page_variant, 40) || 'unknown',
    event_type: str(p.event, 64),
    step: Number.isInteger(p.step) ? p.step : null,
    payload: (p.meta && typeof p.meta === 'object' && !Array.isArray(p.meta)) ? p.meta : {},
    utm_source: p.utm_source ? str(p.utm_source, 120) : null,
    utm_medium: p.utm_medium ? str(p.utm_medium, 120) : null,
    utm_campaign: p.utm_campaign ? str(p.utm_campaign, 200) : null,
    utm_content: p.utm_content ? str(p.utm_content, 200) : null,
    utm_term: p.utm_term ? str(p.utm_term, 200) : null,
    user_agent: str(req.get('user-agent') || '', 400) || null
  };
  if (!row.session_id || !row.event_type) return res.status(400).json({ error: 'BAD_EVENT' });

  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    fetch(SUPABASE_URL + '/rest/v1/estimator_events', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(row)
    }).then(function (resp) {
      if (!resp.ok) {
        resp.text().then(function (t) {
          console.warn('[events] supabase ' + resp.status + ': ' + t.slice(0, 200));
        });
      }
    }).catch(function (err) {
      console.warn('[events] supabase insert failed:', err.message);
    });
  }
  // Analytics is fire-and-forget for the client either way.
  return res.status(204).end();
});

// ---------------------------------------------------------------------------
// Health + static
// ---------------------------------------------------------------------------
// /health is what uptime monitoring asks for; /healthz stays for anything
// already pointed at it.
app.get(['/health', '/healthz'], function (req, res) {
  res.json({
    ok: true,
    service: 'window-calculator',
    commit: process.env.RAILWAY_GIT_COMMIT_SHA || 'dev'
  });
});

// Google has to be allowed in to READ the noindex. Disallowing the page here
// would hide the directive, and a disallowed URL can still be indexed if
// something links to it — which is the opposite of what we want.
app.get('/robots.txt', function (req, res) {
  res.type('text/plain').send('User-agent: *\nAllow: /\n');
});

// The one copy of the calculator, served to both host pages. A fixed 5-minute
// cache means an update reaches the WordPress page without Socius editing
// anything, and the URL never changes so the snippet they paste is permanent.
app.get('/embed/calculator.js', function (req, res) {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=300');
  res.set('Access-Control-Allow-Origin', '*'); // a script tag any allowed page may load
  res.sendFile(path.join(__dirname, 'public/embed/calculator.js'));
});

// Old page paths keep working, and keep their query string. utm_*, fbclid and
// gclid are the whole attribution chain; a redirect that strips them turns a
// paid click into an unattributed lead.
app.get(LEGACY_PAGE_PATHS, function (req, res) {
  return redirectKeepQuery(req, res, '/');
});

app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  setHeaders: function (res, filePath) {
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-cache'); // always revalidate the page itself
      // Authoritative in a way robots.txt is not: a disallowed URL can still
      // be indexed if linked, but a noindex header cannot.
      res.set('X-Robots-Tag', 'noindex, nofollow');
    } else {
      res.set('Cache-Control', 'public, max-age=300');
    }
  }
}));

app.listen(PORT, '0.0.0.0', function () {
  console.log('[boot] window-calculator v2 listening on ' + PORT);
});
