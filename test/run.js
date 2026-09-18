'use strict';
/**
 * Window Estimate Calculator — verification suite.
 *
 *   npm test
 *
 * Nothing here touches production. The API is stubbed by a local double, so no
 * GHL contact is created, no Lead Perfection record is written and no SMS or
 * verification email is sent.
 *
 * Covers:
 *   1. every JS file parses
 *   2. legacy paths 301 to / with the query string intact; / is a 200
 *   3. noindex header on the page; JS content type and 5-minute cache on the embed
 *   4. the calculator renders and advances on the standalone page AND on a
 *      foreign origin that mimics WordPress (three pixels, no calculator CSS)
 *   5. exactly one trackSingle Lead to Reece's pixel, zero plain track Leads
 *   6. no corrupted WordPress shortcode output, no pixel init inside the embed
 *   7. the Reece tracker: loaded once by the standalone page and never by the
 *      embed, every calc_* event mirrored in order, one identify after the
 *      contact upsert, no lead details in any mirrored props, and a tracker
 *      that arrives late or never arrives breaking nothing
 */
const { execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP_PORT = 8071;   // the calculator service under test
const HOST_PORT = 5055;  // the pretend-WordPress origin
// localhost counts as a standalone host; 127.0.0.1 does not. Addressing the two
// servers differently is what makes the foreign origin resolve to 'main-domain'
// the way reecewindows.com will.
const APP = 'http://localhost:' + APP_PORT;
const HOST = 'http://127.0.0.1:' + HOST_PORT;
// The embed calls the API at an absolute origin so it works from both host
// pages. Tests intercept that origin rather than letting it reach production.
const API_BASE = 'https://estimate.getreecewindows.com';
// Reece's tracker is a separate service. Nothing in this run may reach it: the
// real script is stubbed out and ReeceTrack is supplied by a local double, so
// no visitor, pageview or identify is ever written to LP Supabase.
const TRACKER_ORIGIN = 'https://track.getreecewindows.com';

// The two non-calc_ events the embed is allowed to mirror: consent-document
// views, named by LP-MCP's visitor tracking contract rather than by this funnel.
const POLICY_EVENTS = ['privacy_policy_viewed', 'terms_viewed'];

// The details the funnel is walked with. Every one of these is something the
// mirrored props must never contain.
const LEAD = {
  name:   'Test Homeowner',
  street: '100 Test St',
  city:   'Tampa',
  zip:    '33601',
  phone:  '9545000000',
  email:  'test@example.com'
};

let passed = 0;
const failures = [];
function check(name, fn) {
  return Promise.resolve().then(fn).then(function () {
    passed++;
    console.log('  ok   ' + name);
  }, function (err) {
    failures.push(name + ' — ' + err.message);
    console.log('  FAIL ' + name + '\n       ' + err.message);
  });
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, what) {
  assert(actual === expected, what + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

function get(url, opts) {
  return new Promise(function (resolve, reject) {
    const req = http.get(url, Object.assign({ headers: {} }, opts), function (res) {
      let body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, body: body }); });
    });
    req.on('error', reject);
  });
}

// http.get cannot issue a POST, and every POST in the browser phases is stubbed
// by Playwright before it reaches the server — so without this nothing ever
// exercised a POST handler server-side.
function post(url, body, opts) {
  opts = opts || {};
  const payload = body == null ? '' : JSON.stringify(body);
  const u = new URL(url);
  return new Promise(function (resolve, reject) {
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }, opts.headers || {})
    }, function (res) {
      let out = '';
      res.on('data', function (c) { out += c; });
      res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, body: out }); });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// ---------------------------------------------------------------------------
// 1. Syntax
// ---------------------------------------------------------------------------
function jsFiles(dir, out) {
  out = out || [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    if (e.name === 'node_modules') return;
    // Every dot-directory, not just .git. A Playwright browser installed into
    // the checkout put three of Chromium's own bundled scripts through
    // node --check — they happened to parse, but nothing here owns them and
    // one ESM file among them would fail the build for no reason.
    if (e.name.charAt(0) === '.') return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) jsFiles(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  });
  return out;
}

async function syntaxChecks() {
  console.log('\nSyntax');
  const files = jsFiles(ROOT);
  assert(files.indexOf(path.join(ROOT, 'public/embed/calculator.js')) !== -1,
    'public/embed/calculator.js was not found');
  for (const f of files) {
    await check('node --check ' + path.relative(ROOT, f), function () {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    });
  }
}

// ---------------------------------------------------------------------------
// 2/3. Routes and headers
// ---------------------------------------------------------------------------
async function httpChecks() {
  console.log('\nRoutes and headers');
  const q = '?utm_source=t&fbclid=x';

  await check('/ serves the page with 200', async function () {
    const r = await get(APP + '/' + q);
    eq(r.status, 200, 'status');
    assert(!r.headers.location, '/ must not redirect — it lost the query string that way before');
    assert(r.body.indexOf('id="reece-calculator"') !== -1, 'mount point missing from the page');
  });

  await check('/ sends X-Robots-Tag: noindex, nofollow', async function () {
    const r = await get(APP + '/');
    eq(r.headers['x-robots-tag'], 'noindex, nofollow', 'x-robots-tag');
    assert(/<meta name="robots" content="noindex, nofollow">/.test(r.body), 'noindex meta tag missing');
  });

  await check('robots.txt does not hide the page from Google', async function () {
    const r = await get(APP + '/robots.txt');
    assert(!/Disallow:\s*\/\s*$/m.test(r.body),
      'robots.txt disallows /, which would stop Google reading the noindex');
  });

  for (const p of ['/index.html', '/window-estimate', '/estimate', '/calculator']) {
    await check(p + ' 301s to / with the query string intact', async function () {
      const r = await get(APP + p + q);
      eq(r.status, 301, 'status');
      eq(r.headers.location, '/' + q, 'location');
    });
  }

  await check('/embed/calculator.js is JS and cached for 5 minutes', async function () {
    const r = await get(APP + '/embed/calculator.js');
    eq(r.status, 200, 'status');
    assert(/^application\/javascript/.test(r.headers['content-type']),
      'content-type is ' + r.headers['content-type']);
    eq(r.headers['cache-control'], 'public, max-age=300', 'cache-control');
  });

  await check('/ loads the Reece tracker exactly once', async function () {
    const r = await get(APP + '/');
    const tags = r.body.match(/<script[^>]*reece-tracker\.js[^>]*>/g) || [];
    eq(tags.length, 1, 'tracker script tags on the served page');
    const lines = r.body.split('\n').filter(function (l) { return l.indexOf('reece-tracker') !== -1; });
    eq(lines.length, 1, 'lines mentioning reece-tracker');
    assert(tags[0].indexOf('src="' + TRACKER_ORIGIN + '/reece-tracker.js"') !== -1,
      'tracker src is not the tracker service: ' + tags[0]);
    assert(/\bdefer\b/.test(tags[0]), 'tracker tag is missing defer');
    assert(tags[0].indexOf('data-reece-tracker') !== -1, 'tracker tag is missing data-reece-tracker');
    assert(tags[0].indexOf('data-sister-domains="reecewindows.com,getreecewindows.com"') !== -1,
      'tracker tag is missing data-sister-domains');
    assert(tags[0].indexOf('data-collector') === -1,
      'tracker tag sets data-collector — the built-in default is the contract');
  });

  await check('nothing in <head> blocks the first paint', async function () {
    const r = await get(APP + '/');
    const head = r.body.slice(0, r.body.indexOf('</head>'));
    // Every external script in <head> must be async or defer, or the parser
    // stops there and the visitor sees nothing.
    const tags = head.match(/<script\b[^>]*\bsrc=[^>]*>/g) || [];
    assert(tags.length > 0, 'no external scripts found in <head> at all');
    tags.forEach(function (t) {
      assert(/\basync\b/.test(t) || /\bdefer\b/.test(t),
        'render-blocking script in <head>: ' + t);
    });
    // Named explicitly: this one is 82 KB over the wire and used to block.
    const ghl = tags.find(function (t) { return t.indexOf('external-tracking.js') !== -1; });
    assert(ghl, 'the GHL tracking script is gone from the page');
    assert(/\basync\b/.test(ghl), 'the GHL tracking script lost its async');
    assert(ghl.indexOf('tk_e546f581cf8f430dad0ec8f0838d01d3') !== -1,
      'the GHL tracking id changed');
  });

  await check('the page shows a placeholder and preloads the embed', async function () {
    const r = await get(APP + '/');
    const mount = r.body.match(/<div id="reece-calculator">([\s\S]*?)<\/div>\s*<script/);
    assert(mount, 'could not find the calculator mount');
    assert(/data-rc-placeholder/.test(mount[1]), 'the mount has no loading placeholder');
    assert(/Loading your estimate tool/.test(mount[1]), 'the placeholder has no message');
    assert(/<link rel="preload" href="\/embed\/calculator\.js" as="script">/.test(r.body),
      'the embed is not preloaded');
  });

  await check('fonts preconnect to gstatic and request the variable axis', async function () {
    const r = await get(APP + '/');
    assert(/<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>/.test(r.body),
      'no crossorigin preconnect to fonts.gstatic.com — the font path pays a full handshake');
    const css = r.body.match(/fonts\.googleapis\.com\/css2\?family=[^"]*/);
    assert(css, 'the Google Fonts stylesheet is gone');
    assert(/wght@\d+\.\.\d+/.test(css[0]),
      'fonts are requested as discrete weights, not the variable axis: ' + css[0]);
    assert(/display=swap/.test(css[0]), 'display=swap was dropped — text would be invisible while fonts load');
  });

  await check('footer images are sized, lazy, and served from this repo', async function () {
    const r = await get(APP + '/');
    const footer = r.body.slice(r.body.indexOf('<footer class="hrir-footer">'));
    const imgs = footer.match(/<img\b[^>]*>/g) || [];
    eq(imgs.length, 4, 'footer images (3 badges + logo)');
    imgs.forEach(function (t) {
      assert(/\bwidth="\d+"/.test(t) && /\bheight="\d+"/.test(t),
        'footer image has no intrinsic size, so its box cannot be reserved: ' + t);
      assert(/loading="lazy"/.test(t), 'below-the-fold image is not lazy: ' + t);
      assert(/decoding="async"/.test(t), 'footer image is not decoding="async": ' + t);
    });
    assert(/<source srcset="\/static\/logo-footer\.webp" type="image\/webp">/.test(footer),
      'the footer logo has no WebP source');
    assert(footer.indexOf('68c8417fa500176c396a096b.png') === -1,
      'the footer still points at the 445 KB logo on storage.googleapis.com');
  });

  for (const f of ['logo-footer.webp', 'logo-footer.png']) {
    await check('/static/' + f + ' is small and cached for a year', async function () {
      const r = await get(APP + '/static/' + f);
      eq(r.status, 200, 'status');
      eq(r.headers['cache-control'], 'public, max-age=31536000, immutable', 'cache-control');
      const bytes = Number(r.headers['content-length']);
      assert(bytes > 0 && bytes < 15360, f + ' is ' + bytes + ' bytes, over the 15 KB budget');
    });
  }

  await check('/health returns ok', async function () {
    const r = await get(APP + '/health');
    eq(JSON.parse(r.body).ok, true, 'ok');
  });

  await check('CORS allows both host pages and refuses others', async function () {
    for (const origin of ['https://reecewindows.com', 'https://www.reecewindows.com',
                          'https://estimate.getreecewindows.com']) {
      const r = await get(APP + '/api/events', { headers: { origin: origin } });
      assert(r.status !== 403, origin + ' was refused');
      eq(r.headers['access-control-allow-origin'], origin, 'ACAO for ' + origin);
    }
    const bad = await get(APP + '/api/events', { headers: { origin: 'https://not-reece.example' } });
    eq(bad.status, 403, 'unknown origin status');
  });

  // The /api origin gate waves through anything with no Origin header (the
  // server-to-server case), so the sweep endpoint's own bearer check is the
  // only thing standing between a curl and a replay of every pending estimate.
  await check('/api/estimate/sweep refuses a request with no token', async function () {
    const r = await post(APP + '/api/estimate/sweep', { limit: 1 });
    eq(r.status, 401, 'no-token status');
  });

  await check('/api/estimate/sweep refuses a wrong token', async function () {
    const r = await post(APP + '/api/estimate/sweep', { limit: 1 },
      { headers: { authorization: 'Bearer ' + 'b'.repeat(64) } });
    eq(r.status, 401, 'wrong-token status');
  });

  await check('/api/estimate/sweep returns 401 (not 500) for a wrong-LENGTH token', async function () {
    // crypto.timingSafeEqual throws on a length mismatch, which would surface
    // as a 500 and leak the secret's length. Hashing both sides first is what
    // keeps this a 401.
    for (const bad of ['x', 'Bearer', 'a'.repeat(500), '']) {
      const r = await post(APP + '/api/estimate/sweep', { limit: 1 },
        { headers: { authorization: 'Bearer ' + bad } });
      assert(r.status === 401, 'token ' + JSON.stringify(bad.slice(0, 12)) + ' gave ' + r.status + ', expected 401');
    }
  });

  await check('/api/estimate/sweep accepts the configured token', async function () {
    const r = await post(APP + '/api/estimate/sweep', { limit: 1 },
      { headers: { authorization: 'Bearer ' + process.env.SWEEP_TOKEN } });
    // Supabase is not configured in the test env, so the auth gate passing is
    // proved by getting past 401 to the dependency check.
    assert(r.status !== 401, 'the right token was refused');
    assert(r.status === 503 || r.status === 200, 'unexpected status ' + r.status + ': ' + r.body.slice(0, 200));
  });
}

// ---------------------------------------------------------------------------
// 6. Source greps
// ---------------------------------------------------------------------------
async function grepChecks() {
  console.log('\nSource');
  const embed = fs.readFileSync(path.join(ROOT, 'public/embed/calculator.js'), 'utf8');

  await check('no WordPress shortcode corruption in any JS file', function () {
    // Split so this file does not match its own check.
    const mangled = '<div class="card-' + 'body">';
    jsFiles(ROOT).forEach(function (f) {
      const s = fs.readFileSync(f, 'utf8');
      assert(s.indexOf(mangled) === -1,
        path.relative(ROOT, f) + ' contains the shortcode output WordPress substituted for [body]');
    });
  });

  await check('the embed never initialises a pixel or loads GHL tracking', function () {
    assert(embed.indexOf("fbq('init'") === -1, "embed calls fbq('init' — the host page owns that");
    assert(embed.indexOf('fbq("init"') === -1, 'embed calls fbq("init"');
    assert(embed.indexOf('external-tracking') === -1, 'embed loads external-tracking.js');
    assert(!/fbq\(\s*'track'\s*,\s*'PageView'/.test(embed), 'embed fires PageView');
  });

  await check('the embed sends Meta events only via trackSingle', function () {
    const plain = embed.match(/fbq\(\s*'track(?:Custom)?'\s*,/g) || [];
    eq(plain.length, 0, "plain fbq('track', ...) calls — they would hit all three WordPress pixels");
  });

  await check('the calculator logic lives in exactly one file', function () {
    const page = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    assert(page.indexOf('PRICE_TABLE') === -1, 'pricing logic is duplicated in public/index.html');
    assert(page.indexOf('/embed/calculator.js') !== -1, 'the page does not load the embed');
  });

  await check('the embed never loads the Reece tracker itself', function () {
    // The host page owns the tag. On WordPress, Socius installs the same line
    // site-wide, so an embed that injected it would run two trackers on a page.
    assert(embed.indexOf('reece-tracker.js') === -1, 'embed references the tracker script file');
    assert(embed.indexOf('track.getreecewindows.com') === -1, 'embed references the tracker origin');
  });

  await check('every tracker call in the embed is guarded', function () {
    // A missing or broken tracker must never break the funnel.
    assert(/typeof window\.ReeceTrack === 'object'/.test(embed),
      'no typeof window.ReeceTrack === \'object\' guard found');
    ['track', 'identify', 'getVisitorId'].forEach(function (fn) {
      const calls = embed.match(new RegExp('window\\.ReeceTrack\\.' + fn + '\\(', 'g')) || [];
      eq(calls.length, 1, 'window.ReeceTrack.' + fn + '() call sites (one guarded site each)');
      assert(new RegExp("typeof window\\.ReeceTrack\\." + fn + " [!=]== 'function'").test(embed),
        'window.ReeceTrack.' + fn + ' is called without a typeof check');
    });
  });

  await check('the consent block is the v2 wording, and only v2 ships', function () {
    // The version string is the audit record on every contact. A wording change
    // that forgets the bump makes v1 contacts and v2 contacts indistinguishable.
    assert(embed.indexOf("'calc-consent-2026-09-17-v2'") !== -1,
      'CONSENT_VERSION is not calc-consent-2026-09-17-v2');
    const stale = embed.match(/calc-consent-2026-08-13-v1/g) || [];
    eq(stale.length, 0, 'references to the superseded consent version');

    // The 10DLC SMS elements. Carriers reject a campaign missing any of these.
    ['I agree to receive SMS messages from Reece Windows &amp; Doors',
     'at the number I entered above',
     'Msg frequency varies',
     'Msg &amp; data rates may apply',
     'Reply HELP for help, STOP to opt out'].forEach(function (phrase) {
      assert(embed.indexOf(phrase) !== -1, 'consent text is missing: ' + phrase);
    });

    // CONSENT_A also collects calling and email consent. Reece dials these leads
    // through Five9, so dropping any of this is a compliance change, not a copy
    // tweak — it fails here rather than being noticed after the first dial.
    ['live agent', 'AI generative voice', 'artificial or prerecorded voice',
     'calls dialed manually or by auto dialer', 'and by email',
     'not required to sign or agree to this as a condition of purchase'].forEach(function (phrase) {
      assert(embed.indexOf(phrase) !== -1, 'calling/email consent is missing: ' + phrase);
    });
  });

  await check('the policy links point at the GHL redirects and open safely', function () {
    [['rc-link-privacy', 'https://landing.reecewindows.com/privacy'],
     ['rc-link-terms',   'https://landing.reecewindows.com/terms']].forEach(function (pair) {
      const tag = (embed.match(new RegExp('<a [^>]*id=\\\\"' + pair[0] + '\\\\"[^>]*>')) || [])[0];
      assert(tag, 'no anchor with id ' + pair[0]);
      // The href must stay on landing.reecewindows.com: that is the GHL URL
      // redirect, which is what puts the click in trigger-link reporting and
      // lets the destination change without a deploy.
      assert(tag.indexOf('href=\\"' + pair[1] + '\\"') !== -1, pair[0] + ' href: ' + tag);
      assert(tag.indexOf('target=\\"_blank\\"') !== -1, pair[0] + ' does not open in a new tab');
      // rel=noopener: without it the opened page gets window.opener on this one.
      assert(tag.indexOf('rel=\\"noopener\\"') !== -1, pair[0] + ' is missing rel=noopener');
    });
  });

  await check('the policy links sit outside the consent <label>', function () {
    // Inside the label that wraps the checkbox, clicking a link also toggles
    // that checkbox — a lead reading the policy would flip their own consent.
    const block = (embed.match(/id=\\"rc-field-consent\\"[\s\S]*?rc-consent-footer[\s\S]*?<\/p>/) || [''])[0];
    assert(block, 'the consent field block was not found');
    const labelEnd = block.indexOf('</label>');
    assert(labelEnd !== -1, 'the consent <label> never closes');
    ['rc-link-privacy', 'rc-link-terms'].forEach(function (id) {
      const at = block.indexOf(id);
      assert(at !== -1, id + ' is not in the consent block');
      assert(at > labelEnd, id + ' sits inside .rc-consent-label');
    });
  });

  await check('policy-link tracking cannot block the navigation', function () {
    const handler = (embed.match(/function watchPolicyLinks[\s\S]*?\n  }\n/) || [''])[0];
    assert(handler, 'watchPolicyLinks is gone');
    assert(handler.indexOf('preventDefault') === -1, 'the policy-link handler calls preventDefault');
    assert(/catch \(err\)/.test(handler), 'the policy-link handler has no catch');
    // Routed through trackerSend, not a second raw ReeceTrack call site — that
    // is what keeps the queue, the PII filter and the one-guarded-site rule
    // above applying to these two events as well.
    assert(handler.indexOf('trackerSend(') !== -1, 'the policy-link handler bypasses trackerSend');
  });

  await check('the embed never sizes anything in rem', function () {
    // rem resolves against the HOST page's <html> font-size. reecewindows.com
    // sets html{font-size:10px}, so a single rem left in here renders that
    // length at 62.5% on the main domain. Use calc(N * var(--rc-rem)) instead.
    const bare = embed.match(/(?<![A-Za-z0-9_$])-?(?:[0-9]*\.)?[0-9]+rem\b/g) || [];
    eq(bare.join(' '), '', 'rem lengths in the embed');
    assert(/"\s*--rc-rem: 16px;\s*"/.test(embed), '--rc-rem is not defined on the mount');
  });

  await check('the embed defines one global', function () {
    const globals = embed.match(/^\s*window\.([A-Za-z_$][\w$]*)\s*=/gm) || [];
    const names = globals.map(function (g) { return g.replace(/.*window\./, '').replace(/\s*=.*/, ''); });
    const unexpected = names.filter(function (n) { return n !== 'ReeceCalculator' && n !== 'dataLayer'; });
    eq(unexpected.join(','), '', 'unexpected globals');
  });
}

// ---------------------------------------------------------------------------
// 4/5. Browser
// ---------------------------------------------------------------------------
function chromiumPath() {
  // Ask Playwright where its own browser is, first. It knows which revision it
  // wants AND the directory layout that revision uses, and the layout has
  // moved: playwright-core 1.63 installs Chrome for Testing to
  // chromium-<rev>/chrome-linux64/chrome, where every older build was
  // chromium-<rev>/chrome-linux/chrome. The hand-rolled list below matched only
  // the old shape, so a freshly installed browser was invisible to it and the
  // whole browser phase skipped itself — on a CI runner that is a green run
  // that verified none of the rendering, tracker or funnel behaviour.
  try {
    const p = require('playwright-core').chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (e) { /* not where Playwright expects it; try the layouts below */ }

  // Fallback for a browser put in place by something other than
  // `playwright install` — a prebuilt CI image, for instance, which may carry a
  // different revision than this playwright-core wants. Passing executablePath
  // explicitly at launch is what makes that mismatch work.
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const candidates = [
    path.join(base, 'chromium', 'chrome-linux', 'chrome'),
    path.join(base, 'chromium', 'chrome-linux64', 'chrome'),
    path.join(base, 'chromium', 'chrome'),
  ];
  try {
    fs.readdirSync(base).filter(function (d) { return /^chromium-/.test(d); }).forEach(function (d) {
      candidates.push(path.join(base, d, 'chrome-linux', 'chrome'));
      candidates.push(path.join(base, d, 'chrome-linux64', 'chrome'));
    });
  } catch (e) { /* no browsers dir */ }
  return candidates.find(function (p) { return fs.existsSync(p); }) || null;
}

// A page that mimics the WordPress target: a foreign origin, three initialised
// pixels, and none of the calculator's own CSS. No ReeceTrack — on this page the
// calculator has to work with the tracker simply absent.
const HOST_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Window Estimate | Reece Windows</title>
<style>
/* The one theme rule that matters: reecewindows.com's style.min.css sets this,
   and it is what used to shrink every rem in the calculator to 62.5%. */
html{font-size:10px}
body{margin:0;background:#fff}
/* The column the mount actually sits in: .col-10 > .entry-content. */
.col-10{width:81.25%;margin:0 auto}
.card{border:9px solid red}.btn{background:lime}.total{font-size:60px}.container{width:120px}
</style>
<script>
window.fbqCalls = [];
window.fbq = function () { window.fbqCalls.push(Array.prototype.slice.call(arguments)); };
fbq('init', '926500861053624');
fbq('init', '111111111111111');
fbq('init', '222222222222222');
fbq('track', 'PageView');
</script>
</head><body>
<header><h1>Theme header</h1></header>
<div class="col-10"><div class="entry-content">
<div id="reece-calculator"></div>
<script src="${APP}/embed/calculator.js" defer></script>
</div></div>
</body></html>`;

// The tracker double. It never talks to the tracker service — it only records
// what the embed asked it to do. Written as source text so it can be injected
// either into a host page or, for the standalone page whose HTML the test does
// not control, through addInitScript.
const TRACKER_STUB = `
window.__rtStart = Date.now();
window.__rtCalls = [];
window.__rtInstall = function () {
  window.ReeceTrack = {
    track: function (name, props) {
      window.__rtCalls.push({ type: 'track', name: name, props: props,
                              at: Date.now() - window.__rtStart });
    },
    identify: function (traits) {
      window.__rtCalls.push({ type: 'identify', traits: traits,
                              at: Date.now() - window.__rtStart });
    },
    getVisitorId: function () { return 'vis-test-0001'; }
  };
};`;

// (b) The foreign-origin page from the handoff: the two-line embed and a stub
// ReeceTrack, nothing else. If the embed injects a tracker script, it shows up
// here with nothing to hide behind.
const HOST_PAGE_EMBED_ONLY = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Embed only</title>
<script>${TRACKER_STUB}
window.__rtInstall();
</script>
</head><body>
<div id="reece-calculator"></div>
<script src="${APP}/embed/calculator.js" defer></script>
</body></html>`;

// ---------------------------------------------------------------------------
// The GHL funnel page, landing.reecewindows.com/instant-window-pricing.
//
// What makes it different from the WordPress stand-in, and why full mode
// exists: it ships its own utility classes over the SAME generic names the
// calculator uses — .card, .btn, .field, .container, .tile, .section — plus
// GHL's .c-section / .c-row / .c-column system. Every one of the rules below
// is hostile on purpose. In the light DOM they would wreck the calculator;
// inside a shadow root they must not reach it.
//
// `mode` is interpolated so one fixture covers "full", "embed", "garbage" and
// the no-attribute case.
function funnelPage(mode, opts) {
  opts = opts || {};
  const attr = mode === null ? '' : ` data-mode="${mode}"`;
  // Tasks 5.10 and 5.11: a page where neither tracker nor pixel exists. The
  // calculator must load and submit normally and log nothing to the console.
  const thirdParty = opts.bare ? '' : `${TRACKER_STUB}
window.__rtInstall();
window.fbqCalls = [];
window.fbq = function () { window.fbqCalls.push(Array.prototype.slice.call(arguments)); };
fbq('init', '926500861053624');
fbq('track', 'PageView');`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Instant Window Pricing</title>
<style>
html{font-size:10px}
body{margin:0;background:#fff}
/* GHL's funnel builder markup */
.c-section{width:100%}.c-row{display:flex}.c-column{flex:1}
/* The collisions. A calculator in the light DOM would inherit every one. */
.card{display:none}
.btn{background:magenta!important;color:magenta!important;font-size:80px!important}
.field{display:none}
.container{width:90px!important}
.tile{display:none}
.section{display:none}
input,select{border:12px dashed magenta!important}
h1,h2,h3{font-size:4px!important;color:magenta!important}
</style>
<script>${thirdParty}</script>
</head><body>
<div class="c-section"><div class="c-row"><div class="c-column">
  <h1>Funnel headline</h1>
  <!-- The funnel page's own elements, carrying the calculator's class names.
       Task 5.9: calculator CSS must not style these. -->
  <div class="card" id="host-card">host card</div>
  <button class="btn" id="host-btn">host button</button>
  <div id="reece-calculator"></div>
  <script src="${APP}/embed/calculator.js"${attr} defer></script>
</div></div></div>
</body></html>`;
}

// Task 5.7: no mount at all. The calculator must warn and exit — never fall
// back to injecting itself into <body>, which on a funnel page would drop the
// whole estimator at the bottom of someone else's layout.
const NO_MOUNT_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>No mount</title></head><body>
<p id="only-child">nothing to mount into</p>
<script src="${APP}/embed/calculator.js" data-mode="full" defer></script>
</body></html>`;

// ---------------------------------------------------------------------------
// Full mode (data-mode="full") and the regression guards that keep it from
// reaching the two pages it must not touch.
//
// Playwright's CSS engine pierces OPEN shadow roots, so the same '#rc-…'
// selectors drive the funnel page and the WordPress stand-in. That is a
// convenience for the suite and nothing more — the assertions below reach for
// ReeceCalculator.shadowRoot explicitly wherever the tree matters.
// ---------------------------------------------------------------------------

// The stub for Google Places. The real Maps script is routed to an empty body
// (the whole suite is offline), so this stands in for it: it records the input
// Autocomplete was attached to, and fires one place_changed on demand.
const PLACES_STUB = `
window.__placesInput = null;
window.__firePlace = null;
window.google = { maps: { places: { Autocomplete: function (input) {
  window.__placesInput = input;
  var listener = null;
  var place = {
    formatted_address: '742 Evergreen Terrace, Springfield, FL 32701, USA',
    address_components: [
      { long_name: '742',              short_name: '742',  types: ['street_number'] },
      { long_name: 'Evergreen Terrace', short_name: 'Evergreen Terrace', types: ['route'] },
      { long_name: 'Springfield',      short_name: 'Springfield', types: ['locality'] },
      { long_name: 'Florida',          short_name: 'FL',   types: ['administrative_area_level_1'] },
      { long_name: '32701',            short_name: '32701', types: ['postal_code'] }
    ]
  };
  this.setFields = function () {};
  this.getPlace = function () { return place; };
  this.addListener = function (name, fn) { if (name === 'place_changed') listener = fn; };
  window.__firePlace = function () { if (listener) listener(); };
  // The real Places library appends its dropdown to document.body, OUTSIDE the
  // shadow root. Reproduce that so the z-index guard is exercised.
  var pac = document.createElement('div');
  pac.className = 'pac-container';
  pac.textContent = '742 Evergreen Terrace';
  document.body.appendChild(pac);
} } } };`;

// Offline routing, identical in shape to the main browser phase: /api/* answered
// by a local double, the tracker service dead, every other third party empty.
async function routeOffline(page, sink) {
  await page.route('**/*', async function (route) {
    const req = route.request();
    const url = req.url();
    const isApi = url.indexOf(API_BASE + '/api/') === 0;
    if (url.indexOf(TRACKER_ORIGIN) === 0) {
      return route.fulfill({ status: 200, body: '', contentType: 'application/javascript' });
    }
    if (!isApi) {
      if (url.indexOf('://localhost:') !== -1 || url.indexOf('://127.0.0.1:') !== -1) return route.continue();
      return route.fulfill({ status: 200, body: '', contentType: 'text/plain' });
    }
    let body = {};
    try { body = JSON.parse(req.postData() || '{}'); } catch (e) { body = {}; }
    if (sink) sink.push({ path: url.slice(API_BASE.length), body: body });
    if (url.indexOf('/api/events') !== -1) {
      return route.fulfill({ status: 204, body: '', headers: { 'access-control-allow-origin': '*' } });
    }
    const json =
      url.indexOf('/api/contact') !== -1 ? { contactId: 'test-contact' } :
      url.indexOf('/api/verify/start') !== -1 ? { verifyId: 'test-verify' } :
      url.indexOf('/api/verify/check') !== -1 ? { verified: true, estimateToken: 'test-token' } :
      { ok: true };
    return route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(json),
      headers: { 'access-control-allow-origin': '*' }
    });
  });
}

// Step 1 through the estimate. Mode-agnostic: Playwright pierces the shadow
// root, so one walk covers both.
async function walkFunnel(page) {
  await page.fill('#rc-full-name', LEAD.name);
  await page.fill('#rc-street-address', LEAD.street);
  await page.fill('#rc-city', LEAD.city);
  await page.fill('#rc-state', 'FL');
  await page.fill('#rc-postal-code', LEAD.zip);
  await page.fill('#rc-phone', LEAD.phone);
  await page.check('#rc-consent-checkbox');
  await page.click('#rc-section-1 button.rc-btn-primary');
  await page.waitForSelector('#rc-section-2.rc-visible', { timeout: 10000 });
  await page.click('#rc-window-style .rc-tile[data-value="single_hung"]');
  await page.click('#rc-window-size .rc-tile[data-value="medium"]');
  await page.click('#rc-section-2 button.rc-btn-accent');
  await page.waitForSelector('#rc-window-list .rc-cart-item', { timeout: 10000 });
  await page.click('#rc-btn-to-step3');
  await page.waitForSelector('#rc-section-3.rc-visible', { timeout: 10000 });
  await page.fill('#rc-email', LEAD.email);
  await page.click('#rc-section-3 button.rc-btn-primary');
  await page.waitForSelector('#rc-verify-email-modal.rc-active', { timeout: 10000 });
  await page.fill('#rc-verify-code-input', '123456');
  await page.click('#rc-verify-submit-btn');
  await page.waitForSelector('#rc-section-4.rc-visible', { timeout: 10000 });
}

async function fullModeChecks(browser) {
  console.log('\nFull mode (data-mode="full")');

  // -------------------------------------------------------------------------
  // Tasks 5.1-5.3: the two modes that must stay in the light DOM.
  //
  // The pixel-level proof that they are unchanged is test/baseline.js, diffed
  // against a capture from main. These assert the structural property that
  // would have to break first: no shadow root, styles in document.head, markup
  // written straight into the mount.
  // -------------------------------------------------------------------------
  for (const variant of [
    { name: 'attribute absent', path: '/funnel-default' },
    { name: 'data-mode="embed"', path: '/funnel-embed' },
    { name: 'data-mode="garbage"', path: '/funnel-garbage' }
  ]) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const warnings = [];
    const consoleErrors = [];
    page.on('console', function (m) {
      if (m.type() === 'warning') warnings.push(m.text());
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', function (e) { consoleErrors.push(String(e)); });
    await routeOffline(page, null);
    await page.goto(HOST + variant.path, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#rc-section-1.rc-visible', { timeout: 10000 });

    await check(variant.name + ': renders into the LIGHT dom, no shadow root', async function () {
      const m = await page.evaluate(function () {
        var host = document.getElementById('reece-calculator');
        return {
          shadow: host.shadowRoot,
          exported: window.ReeceCalculator.shadowRoot,
          mode: window.ReeceCalculator.renderMode,
          // In the light DOM the section is a real descendant of the mount.
          inMount: !!host.querySelector('#rc-section-1'),
          styleInHead: !!document.getElementById('rc-calculator-styles')
        };
      });
      eq(m.shadow, null, 'host.shadowRoot');
      eq(m.exported, null, 'ReeceCalculator.shadowRoot');
      eq(m.mode, 'embed', 'renderMode');
      eq(m.inMount, true, 'the calculator is a light-DOM descendant of the mount');
      eq(m.styleInHead, true, 'the stylesheet is in document.head');
    });

    if (variant.name === 'data-mode="garbage"') {
      // Task 5.6. A typo on someone else's page is not a reason to take the
      // calculator down — it warns, falls back, and carries on.
      await check('data-mode="garbage": warns once and does not throw', async function () {
        const hit = warnings.filter(function (w) { return /Unknown data-mode="garbage"/.test(w); });
        eq(hit.length, 1, 'warnings naming the bad mode (saw: ' + warnings.join(' | ') + ')');
        eq(consoleErrors.join(' | '), '', 'console errors');
        eq(await page.locator('#rc-section-1').isVisible(), true, 'step 1 still renders');
      });
    }
    await ctx.close();
  }

  // -------------------------------------------------------------------------
  // Task 5.7: no mount element.
  // -------------------------------------------------------------------------
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const warnings = [];
    const consoleErrors = [];
    page.on('console', function (m) {
      if (m.type() === 'warning') warnings.push(m.text());
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', function (e) { consoleErrors.push(String(e)); });
    await routeOffline(page, null);
    await page.goto(HOST + '/no-mount', { waitUntil: 'load' });
    await page.waitForTimeout(500);

    await check('no #reece-calculator: warns, exits, never injects into body', async function () {
      const m = await page.evaluate(function () {
        return {
          sections: document.querySelectorAll('.rc-section, #rc-section-1').length,
          bodyChildren: Array.prototype.slice.call(document.body.children)
            .map(function (e) { return e.tagName + (e.id ? '#' + e.id : ''); }).join(','),
          mounted: window.ReeceCalculator.mounted
        };
      });
      eq(m.sections, 0, 'calculator sections anywhere in the document');
      eq(m.mounted, false, 'ReeceCalculator.mounted');
      assert(m.bodyChildren.indexOf('rc-') === -1,
        'something was injected into <body>: ' + m.bodyChildren);
      assert(warnings.some(function (w) { return /No <div id="reece-calculator">/.test(w); }),
        'no warning about the missing mount (saw: ' + warnings.join(' | ') + ')');
      eq(consoleErrors.join(' | '), '', 'console errors');
    });
    await ctx.close();
  }

  // -------------------------------------------------------------------------
  // Tasks 5.5, 5.8, 5.9, 5.12, 5.13, 5.14 — the full-mode funnel page.
  // -------------------------------------------------------------------------
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const consoleErrors = [];
    const events = [];
    page.on('console', function (m) { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', function (e) { consoleErrors.push(String(e)); });
    await routeOffline(page, events);
    await page.addInitScript(PLACES_STUB);

    // Task 5.12/5.13: every prefill param the 14 live trigger links send, plus
    // the attribution the funnel page has to carry through from the ad click.
    const query = '?fullName=Prefill%20Person&streetAddress=12%20Prefill%20Ave' +
      '&city=Sarasota&state=FL&postalCode=34236&phone=9545551234' +
      '&pro_id=9111&lp_source_id=9222' +
      '&utm_source=facebook&utm_medium=cpc&utm_campaign=lg-sept' +
      '&utm_content=ad7&utm_term=windows&fbclid=ABC123';
    await page.goto(HOST + '/funnel-full' + query, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#rc-section-1.rc-visible', { timeout: 10000 });

    // Task 5.5
    await check('full mode: header, calculator and footer all render INSIDE the shadow root',
      async function () {
        const m = await page.evaluate(function () {
          var host = document.getElementById('reece-calculator');
          var root = host.shadowRoot;
          if (!root) return { noShadow: true };
          return {
            mode: window.ReeceCalculator.renderMode,
            exported: root === window.ReeceCalculator.shadowRoot,
            header: !!root.querySelector('.rc-page-header h1'),
            headerText: (root.querySelector('.rc-page-brand') || {}).textContent || '',
            calculator: !!root.getElementById('rc-section-1'),
            siteline: !!root.querySelector('.rc-page-siteline'),
            footer: !!root.querySelector('.rc-page-footer'),
            total: !!root.getElementById('rc-running-total'),
            year: (root.getElementById('rc-page-year') || {}).textContent || '',
            // Nothing the calculator draws may also exist in the document.
            leakedToDocument: document.querySelectorAll('#rc-section-1, .rc-page-header').length,
            styleInHead: !!document.getElementById('rc-calculator-styles'),
            styleInShadow: !!root.getElementById('rc-calculator-styles')
          };
        });
        assert(!m.noShadow, 'full mode did not attach a shadow root');
        eq(m.mode, 'full', 'renderMode');
        eq(m.exported, true, 'ReeceCalculator.shadowRoot is the mount\'s shadow root');
        eq(m.header, true, 'the page header rendered');
        assert(/Reece Windows & Doors . Est. 1972/.test(m.headerText),
          'header brand line: ' + m.headerText);
        eq(m.calculator, true, 'the calculator rendered');
        eq(m.siteline, true, 'the site footer line rendered');
        eq(m.footer, true, 'the brand footer rendered');
        eq(m.total, true, 'the running-total bar rendered');
        eq(m.year, String(new Date().getFullYear()), 'the copyright year');
        eq(m.leakedToDocument, 0, 'calculator nodes found in the document');
        eq(m.styleInHead, false, 'full mode must not inject the calculator CSS into document.head');
        eq(m.styleInShadow, true, 'the stylesheet is inside the shadow root');
      });

    await check('full mode: the webfont is loaded from the LIGHT dom', async function () {
      // @font-face declared only inside a shadow root does not resolve.
      const m = await page.evaluate(function () {
        return {
          font: Array.prototype.slice.call(document.querySelectorAll('link[rel="stylesheet"]'))
            .some(function (l) { return /fonts\.googleapis\.com.*Nunito\+Sans/.test(l.href); }),
          pac: !!document.getElementById('rc-full-light-support')
        };
      });
      eq(m.font, true, 'the Nunito Sans stylesheet is in document.head');
      eq(m.pac, true, 'the .pac-container z-index guard is in document.head');
    });

    // Task 5.8 — the host page hides .card, .field, .tile, .section outright.
    await check('full mode: host CSS hiding .card/.field/.tile cannot reach the calculator',
      async function () {
        const m = await page.evaluate(function () {
          var root = document.getElementById('reece-calculator').shadowRoot;
          function box(sel) {
            var el = root.querySelector(sel);
            if (!el) return null;
            var r = el.getBoundingClientRect();
            return { display: getComputedStyle(el).display, w: Math.round(r.width), h: Math.round(r.height) };
          }
          return {
            hostCardHidden: getComputedStyle(document.getElementById('host-card')).display,
            card: box('#rc-section-1 .rc-card'),
            field: box('#rc-field-city'),
            tile: box('#rc-window-style .rc-tile'),
            section: box('#rc-section-1'),
            container: box('.rc-container')
          };
        });
        // The host rules really are in force on the host's own elements.
        eq(m.hostCardHidden, 'none', 'the funnel page\'s own .card is hidden');
        ['card', 'field', 'section', 'container'].forEach(function (k) {
          assert(m[k], k + ' did not render at all');
          assert(m[k].display !== 'none', k + ' was hidden by the host page');
          assert(m[k].w > 100, k + ' collapsed to ' + m[k].w + 'px');
        });
        // .container is capped at 90px by the host page; the calculator's own
        // .rc-container must be wide.
        assert(m.container.w > 300, 'the calculator container collapsed to ' + m.container.w + 'px');
      });

    // Task 5.9 — and the other direction.
    await check('full mode: calculator CSS does not leak onto the host page', async function () {
      const m = await page.evaluate(function () {
        var btn = getComputedStyle(document.getElementById('host-btn'));
        var h1 = getComputedStyle(document.querySelector('.c-column > h1'));
        return {
          btnBg: btn.backgroundColor,
          btnSize: btn.fontSize,
          h1Size: h1.fontSize,
          h1Colour: h1.color
        };
      });
      // The host's own hostile rules are still exactly what the host set. If
      // any calculator rule had leaked it would have overridden one of these.
      eq(m.btnBg, 'rgb(255, 0, 255)', 'host .btn background');
      eq(m.btnSize, '80px', 'host .btn font-size');
      eq(m.h1Size, '4px', 'host h1 font-size');
      eq(m.h1Colour, 'rgb(255, 0, 255)', 'host h1 colour');
    });

    await check('full mode: the funnel page\'s 10px root font-size cannot shrink the chrome',
      async function () {
        const m = await page.evaluate(function () {
          var root = document.getElementById('reece-calculator').shadowRoot;
          return {
            documentRoot: getComputedStyle(document.documentElement).fontSize,
            h1: getComputedStyle(root.querySelector('.rc-page-header h1')).fontSize,
            brand: getComputedStyle(root.querySelector('.rc-page-brand')).fontSize,
            calc: getComputedStyle(root.getElementById('reece-calculator')).fontSize
          };
        });
        eq(m.documentRoot, '10px', 'the funnel stand-in\'s root font-size');
        eq(m.h1, '32px', 'chrome h1 (2 x 16)');
        eq(m.brand, '16px', 'chrome brand line (1 x 16)');
        eq(m.calc, '17px', 'calculator body text');
      });

    // Task 5.12
    await check('full mode: every prefill param populates its field', async function () {
      const m = await page.evaluate(function () {
        var root = document.getElementById('reece-calculator').shadowRoot;
        function v(id) { var el = root.getElementById(id); return el ? el.value : null; }
        return {
          fullName: v('rc-full-name'),
          street: v('rc-street-address'),
          city: v('rc-city'),
          state: v('rc-state'),
          zip: v('rc-postal-code'),
          phone: v('rc-phone')
        };
      });
      eq(m.fullName, 'Prefill Person', 'fullName');
      eq(m.street, '12 Prefill Ave', 'streetAddress');
      eq(m.city, 'Sarasota', 'city');
      eq(m.state, 'FL', 'state');
      eq(m.zip, '34236', 'postalCode');
      // The formatter runs on the prefilled value, exactly as on the other pages.
      eq(m.phone, '(954) 555-1234', 'phone, formatted');
    });

    // Task 5.14 — the address field is required for the LP push, and the
    // dropdown lives outside the shadow root.
    await check('full mode: Places autocomplete fills city, state and zip', async function () {
      const attached = await page.evaluate(function () {
        // Maps calls this by name once it loads; the suite is offline, so
        // invoke the documented callback the same way the real script does.
        window.ReeceCalculator.initializeAddressForm();
        var root = document.getElementById('reece-calculator').shadowRoot;
        return window.__placesInput === root.getElementById('rc-street-address');
      });
      assert(attached, 'Autocomplete was attached to the wrong input, or to none');

      const m = await page.evaluate(function () {
        window.__firePlace();
        var root = document.getElementById('reece-calculator').shadowRoot;
        var pac = document.querySelector('.pac-container');
        return {
          street: root.getElementById('rc-street-address').value,
          city: root.getElementById('rc-city').value,
          state: root.getElementById('rc-state').value,
          zip: root.getElementById('rc-postal-code').value,
          // The dropdown is in the light DOM, as Google puts it. What matters
          // is that a funnel-page z-index cannot bury it.
          pacInLightDom: !!pac && pac.parentNode === document.body,
          pacZ: pac ? getComputedStyle(pac).zIndex : null
        };
      });
      eq(m.street, '742 Evergreen Terrace', 'street after place_changed');
      eq(m.city, 'Springfield', 'city after place_changed');
      eq(m.state, 'FL', 'state after place_changed');
      eq(m.zip, '32701', 'zip after place_changed');
      eq(m.pacInLightDom, true, 'the Places dropdown is a child of document.body');
      eq(m.pacZ, '2147483647', '.pac-container z-index');
    });

    // Reset the address the stub overwrote, then walk the funnel.
    await page.fill('#rc-street-address', LEAD.street);
    await page.fill('#rc-city', LEAD.city);
    await page.fill('#rc-postal-code', LEAD.zip);
    await walkFunnel(page);

    await check('full mode: the estimate renders', async function () {
      const price = await page.locator('#rc-summary-content .rc-hero-price').textContent();
      assert(/^\$[\d,]+\.\d\d$/.test(price.trim()), 'hero price looks wrong: ' + price);
    });

    // printEstimate clones #rc-host-header for the printed banner. On the
    // standalone page that hook is a light-DOM element the HOST supplies; in
    // full mode this file renders it, inside the shadow root. hostEl() is what
    // makes one call site find both — if it ever stopped, the printed estimate
    // would silently lose its Reece banner rather than fail.
    await check('full mode: the printed estimate still picks up the branded banner',
      async function () {
        const m = await page.evaluate(function () {
          window.print = function () { window.__printed = (window.__printed || 0) + 1; };
          window.ReeceCalculator.printEstimate();
          var root = document.getElementById('reece-calculator').shadowRoot;
          var printRoot = root.getElementById('rc-print-root');
          var header = printRoot.querySelector('.rc-print-header');
          return {
            header: !!header,
            brand: header ? /Est\. 1972/.test(header.textContent) : false,
            disclaimer: !!printRoot.querySelector('.rc-print-disclaimer')
          };
        });
        eq(m.header, true, 'the print banner was not built');
        eq(m.brand, true, 'the print banner lost the Reece brand line');
        eq(m.disclaimer, true, 'the print disclaimer is missing');
        await page.waitForFunction(function () { return window.__printed > 0; }, null, { timeout: 5000 });
      });

    await check('full mode: the running-total bar in the shadow root is filled in', async function () {
      const total = await page.evaluate(function () {
        var root = document.getElementById('reece-calculator').shadowRoot;
        var bar = root.getElementById('rc-running-total');
        return bar ? bar.querySelector('span').textContent : null;
      });
      assert(/^\$[\d,]+\.\d\d$/.test(String(total).trim()),
        'the running total never updated: ' + total);
    });

    // Task 5.13
    await check('full mode: UTMs, fbclid and the prefilled ids reach the submitted payload',
      async function () {
        const contact = events.filter(function (e) { return e.path.indexOf('/api/contact') === 0; });
        assert(contact.length > 0, '/api/contact was never called');
        const body = contact[contact.length - 1].body;
        eq(body.utm.source, 'facebook', 'utm_source');
        eq(body.utm.medium, 'cpc', 'utm_medium');
        eq(body.utm.campaign, 'lg-sept', 'utm_campaign');
        eq(body.utm.content, 'ad7', 'utm_content');
        eq(body.utm.term, 'windows', 'utm_term');
        eq(body.clickIds.fbclid, 'ABC123', 'fbclid');
        // The 14 live trigger links carry these; a default would mean they were
        // read from nowhere.
        eq(body.proId, '9111', 'pro_id');
        eq(body.lpSourceId, '9222', 'lp_source_id');
      });

    await check('full mode: the Meta pixel still fires exactly one trackSingle Lead',
      async function () {
        // fbq is a window global, so the shadow boundary is irrelevant to it —
        // but only because the calculator calls it from its own handlers rather
        // than relying on Meta's automatic form listener.
        const calls = await page.evaluate(function () { return window.fbqCalls || []; });
        const leads = calls.filter(function (c) { return c[0] === 'trackSingle' && c[2] === 'Lead'; });
        eq(leads.length, 1, 'trackSingle Lead calls');
        eq(leads[0][1], '926500861053624', 'Lead pixel id');
      });

    await check('full mode: calc_* events still mirror to ReeceTrack', async function () {
      await page.waitForFunction(function () {
        return (window.__rtCalls || []).some(function (c) { return c.name === 'calc_estimate_completed'; });
      }, null, { timeout: 15000 }).catch(function () { /* asserted below */ });
      const rt = await page.evaluate(function () { return window.__rtCalls || []; });
      const names = rt.filter(function (c) { return c.type === 'track'; }).map(function (c) { return c.name; });
      ['calc_page_view', 'calc_step_view', 'calc_step1_complete', 'calc_estimate_completed']
        .forEach(function (n) {
          assert(names.indexOf(n) !== -1, n + ' was never mirrored (saw: ' + names.join(', ') + ')');
        });
      const identifies = rt.filter(function (c) { return c.type === 'identify'; });
      assert(identifies.length > 0, 'identify was never called in full mode');
    });

    await check('full mode: zero console errors', function () {
      eq(consoleErrors.join(' | '), '', 'console errors');
    });
    await ctx.close();
  }

  // -------------------------------------------------------------------------
  // Tasks 5.10 and 5.11 — no ReeceTrack, no fbq, nothing.
  // -------------------------------------------------------------------------
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const consoleErrors = [];
    const events = [];
    page.on('console', function (m) { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', function (e) { consoleErrors.push(String(e)); });
    await routeOffline(page, events);
    await page.goto(HOST + '/funnel-full-bare', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#rc-section-1.rc-visible', { timeout: 10000 });

    await check('full mode with no tracker and no pixel: the funnel still completes',
      async function () {
        const absent = await page.evaluate(function () {
          return { track: typeof window.ReeceTrack, fbq: typeof window.fbq };
        });
        eq(absent.track, 'undefined', 'typeof window.ReeceTrack');
        eq(absent.fbq, 'undefined', 'typeof window.fbq');
        await walkFunnel(page);
        const price = await page.locator('#rc-summary-content .rc-hero-price').textContent();
        assert(/^\$[\d,]+\.\d\d$/.test(price.trim()), 'hero price looks wrong: ' + price);
        const contact = events.filter(function (e) { return e.path.indexOf('/api/contact') === 0; });
        assert(contact.length > 0, 'the contact was never submitted');
        // Best-effort by design: no tracker means no visitor id, never an error.
        const leaked = contact.filter(function (e) { return e.body.visitor_id; });
        eq(leaked.length, 0, 'payloads carrying visitor_id with no tracker');
        eq(consoleErrors.join(' | '), '', 'console errors');
      });
    await ctx.close();
  }

  // -------------------------------------------------------------------------
  // Task 3.3 / the GHL external-tracking finding.
  //
  // external-tracking.js captures leads by running document.querySelectorAll
  // ("form") and watching for added nodes with a MutationObserver — neither of
  // which sees inside a shadow root. It does not matter here, because the
  // calculator renders NO <form> at all: that capture path has never seen it on
  // any of the three pages. This test is what keeps that answer true. If a
  // <form> is ever added, full mode needs an explicit light-DOM bridge and this
  // failure is the reminder.
  // -------------------------------------------------------------------------
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await routeOffline(page, null);
    await page.goto(HOST + '/funnel-full', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#rc-section-1.rc-visible', { timeout: 10000 });
    await check('the calculator renders no <form>, so GHL form capture has nothing to lose',
      async function () {
        const m = await page.evaluate(function () {
          var root = document.getElementById('reece-calculator').shadowRoot;
          return { inShadow: root.querySelectorAll('form').length, inDocument: document.forms.length };
        });
        eq(m.inShadow, 0, '<form> elements inside the shadow root');
        eq(m.inDocument, 0, '<form> elements in the document');
      });
    await ctx.close();
  }

  // -------------------------------------------------------------------------
  // Task 5.15 — phones.
  // -------------------------------------------------------------------------
  for (const width of [360, 390]) {
    const ctx = await browser.newContext({ viewport: { width: width, height: 780 } });
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('pageerror', function (e) { consoleErrors.push(String(e)); });
    await routeOffline(page, null);
    await page.goto(HOST + '/funnel-full', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#rc-section-1.rc-visible', { timeout: 10000 });

    await check('full mode at ' + width + 'px: the page does not scroll sideways', async function () {
      const m = await page.evaluate(function () {
        return { scrollWidth: document.body.scrollWidth, viewport: window.innerWidth };
      });
      eq(m.scrollWidth, m.viewport, 'body scrollWidth at ' + width + 'px');
    });

    await check('full mode at ' + width + 'px: nothing reaches past the screen edge', async function () {
      const past = await page.evaluate(function () {
        var root = document.getElementById('reece-calculator').shadowRoot;
        var out = [];
        root.querySelectorAll('*').forEach(function (el) {
          var b = el.getBoundingClientRect();
          if (b.width === 0 && b.height === 0) return;
          if (b.right > window.innerWidth + 1 || b.left < -1) {
            out.push((el.id || el.className || el.tagName) + '@' + Math.round(b.left) + '+' + Math.round(b.width));
          }
        });
        return out;
      });
      eq(past.join(', '), '', 'elements past the viewport at ' + width + 'px');
    });

    await check('full mode at ' + width + 'px: header, calculator and footer are all on screen',
      async function () {
        const m = await page.evaluate(function () {
          var root = document.getElementById('reece-calculator').shadowRoot;
          function w(sel) {
            var el = root.querySelector(sel);
            return el ? Math.round(el.getBoundingClientRect().width) : -1;
          }
          return {
            header: w('.rc-page-header'),
            calc: w('.rc-container'),
            footer: w('.rc-page-footer'),
            viewport: window.innerWidth,
            // iOS zooms any focused field under 16px and never zooms back out.
            fieldSize: parseFloat(getComputedStyle(root.getElementById('rc-city')).fontSize)
          };
        });
        eq(m.header, m.viewport, 'header width at ' + width + 'px');
        eq(m.footer, m.viewport, 'footer width at ' + width + 'px');
        assert(m.calc > 0 && m.calc <= m.viewport, 'calculator width at ' + width + 'px: ' + m.calc);
        assert(m.fieldSize >= 16, 'input font-size at ' + width + 'px is ' + m.fieldSize + 'px');
      });

    // :host carries contain:inline-size, which is what stops the funnel page's
    // flex column from stretching to the stepper's min-content width. Size
    // containment must NOT make the host a containing block for fixed-position
    // descendants — if it ever did, the verification modal would be trapped
    // inside the mount instead of covering the screen, and a lead on a phone
    // could not read the code they were sent.
    await check('full mode at ' + width + 'px: the verification modal still covers the viewport',
      async function () {
        const m = await page.evaluate(function () {
          var root = document.getElementById('reece-calculator').shadowRoot;
          var modal = root.getElementById('rc-verify-email-modal');
          modal.classList.add('rc-active');
          var r = modal.getBoundingClientRect();
          var cs = getComputedStyle(modal);
          modal.classList.remove('rc-active');
          return {
            position: cs.position,
            top: Math.round(r.top), left: Math.round(r.left),
            width: Math.round(r.width), height: Math.round(r.height),
            viewport: window.innerWidth, viewportH: window.innerHeight
          };
        });
        eq(m.position, 'fixed', 'modal position');
        eq(m.top, 0, 'modal top at ' + width + 'px');
        eq(m.left, 0, 'modal left at ' + width + 'px');
        eq(m.width, m.viewport, 'modal width at ' + width + 'px');
        eq(m.height, m.viewportH, 'modal height at ' + width + 'px');
      });

    await check('full mode at ' + width + 'px: no console errors', function () {
      eq(consoleErrors.join(' | '), '', 'page errors');
    });
    await ctx.close();
  }
}

async function browserChecks() {
  console.log('\nBrowser');
  const exe = chromiumPath();
  if (!exe) {
    console.log('  SKIP browser tests — no Chromium found under PLAYWRIGHT_BROWSERS_PATH');
    return;
  }
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });

  for (const target of [
    // (a) the real standalone page, tracker present from the first line
    { name: 'standalone page', url: APP + '/?utm_source=test&utm_medium=paid',
      variant: 'standalone', tracker: 'ready', full: true },
    // (c) the WordPress stand-in, tracker absent entirely
    { name: 'foreign origin (WordPress stand-in)', url: HOST + '/',
      variant: 'main-domain', tracker: 'none', full: true },
    // (b) a foreign origin carrying only the embed and a stub tracker
    { name: 'foreign origin, embed only', url: HOST + '/embed-only',
      variant: 'main-domain', tracker: 'ready' },
    // (d) the tracker turns up three seconds after the funnel starts
    { name: 'standalone page, tracker 3s late', url: APP + '/',
      variant: 'standalone', tracker: 'late' }
  ]) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const consoleErrors = [];
    const events = [];
    const trackerRequests = [];
    const policyRequests = [];

    // The policy links open a NEW page, and page.route() below only covers the
    // page it is registered on. Stub the GHL redirect host at the CONTEXT so the
    // suite stays offline — a real landing.reecewindows.com fetch here would
    // both leave the sandbox and log a live pageview against Reece's tracking.
    await ctx.route('https://landing.reecewindows.com/**', function (route) {
      policyRequests.push(route.request().url());
      return route.fulfill({
        status: 200, contentType: 'text/html',
        body: '<!doctype html><title>policy stub</title>'
      });
    });
    page.on('console', function (m) { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', function (e) { consoleErrors.push(String(e)); });

    // One router for the whole run:
    //   - calls to this service's /api/* are answered by a local double, so no
    //     GHL contact, Lead Perfection record, SMS or email is ever created;
    //   - anything else off the two local origins (Google Maps and Fonts, the
    //     Meta pixel loader, GHL tracking, the CDN favicon) is stubbed empty,
    //     so the run is offline and a blocked CDN cannot masquerade as a
    //     calculator error;
    //   - the rest is served for real by the two local servers.
    await page.route('**/*', async function (route) {
      const req = route.request();
      const url = req.url();
      const isApi = url.indexOf(API_BASE + '/api/') === 0;

      // The tracker service is stubbed dead. The real script never runs, so no
      // visitor, pageview or identify can reach LP Supabase from this suite —
      // ReeceTrack comes only from the double above.
      if (url.indexOf(TRACKER_ORIGIN) === 0) {
        trackerRequests.push(url);
        return route.fulfill({ status: 200, body: '', contentType: 'application/javascript' });
      }

      if (!isApi) {
        if (url.indexOf('://localhost:') !== -1 || url.indexOf('://127.0.0.1:') !== -1) return route.continue();
        return route.fulfill({ status: 200, body: '', contentType: 'text/plain' });
      }

      let body = {};
      try { body = JSON.parse(req.postData() || '{}'); } catch (e) { body = {}; }
      events.push({ path: url.slice(API_BASE.length), body: body });
      if (url.indexOf('/api/events') !== -1) {
        return route.fulfill({ status: 204, body: '', headers: { 'access-control-allow-origin': '*' } });
      }
      const json =
        url.indexOf('/api/contact') !== -1 ? { contactId: 'test-contact' } :
        url.indexOf('/api/verify/start') !== -1 ? { verifyId: 'test-verify' } :
        url.indexOf('/api/verify/check') !== -1 ? { verified: true, estimateToken: 'test-token' } :
        { ok: true };
      return route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify(json),
        headers: { 'access-control-allow-origin': '*' }
      });
    });
    // The standalone page has its own real pixel loader; record calls the same
    // way the stand-in host does so both sides are measured identically.
    await page.addInitScript(function () {
      window.fbqCalls = window.fbqCalls || [];
      var real = window.fbq;
      window.fbq = function () {
        window.fbqCalls.push(Array.prototype.slice.call(arguments));
        if (typeof real === 'function') { try { real.apply(this, arguments); } catch (e) {} }
      };
    });

    // The standalone page's HTML is production and not the test's to edit, so
    // its tracker double is injected here instead. The host pages carry their
    // own in markup. 'late' installs ReeceTrack 3s in, which is the case the
    // queue exists for: the real tag is deferred, so the embed runs first.
    if (target.url.indexOf(APP) === 0 && target.tracker !== 'none') {
      const delay = target.tracker === 'late' ? 3000 : 0;
      await page.addInitScript(TRACKER_STUB +
        '\nif (' + delay + ') { setTimeout(window.__rtInstall, ' + delay + '); }' +
        ' else { window.__rtInstall(); }');
    }

    await page.goto(target.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#rc-section-1.rc-visible', { timeout: 10000 });

    await check(target.name + ': step 1 renders', async function () {
      eq(await page.locator('#rc-section-1').isVisible(), true, 'step 1 visible');
      eq(await page.locator('#rc-full-name').count(), 1, 'name field');
    });

    await check(target.name + ': PAGE_VARIANT is ' + target.variant, async function () {
      eq(await page.evaluate(function () { return window.ReeceCalculator.pageVariant; }),
        target.variant, 'pageVariant');
    });

    // The stand-in host sets html{font-size:10px} exactly as the WordPress theme
    // does. Both pages must still size the calculator identically, because every
    // length is calc(N * var(--rc-rem)) and --rc-rem is fixed at 16px.
    await check(target.name + ': the host page\'s root font-size cannot shrink the calculator', async function () {
      const m = await page.evaluate(function () {
        return {
          root: getComputedStyle(document.documentElement).fontSize,
          body: getComputedStyle(document.getElementById('reece-calculator')).fontSize,
          step: getComputedStyle(document.querySelector('#reece-calculator .rc-stepper .rc-step')).fontSize,
          h2: getComputedStyle(document.querySelector('#rc-section-1 .rc-card h2')).fontSize
        };
      });
      if (/WordPress/.test(target.name)) {
        // Guards the stand-in itself: without the theme's 10px root this check
        // would pass on a page that no longer reproduces the bug.
        eq(m.root, '10px', "the WordPress stand-in's root font-size");
      }
      eq(m.body, '17px', 'calculator body text at root ' + m.root);
      eq(m.step, '13.12px', 'stepper label');   // 0.82 x 16
      eq(m.h2, '19.2px', 'card heading');       // 1.20 x 16
    });

    await check(target.name + ': no bare rem survives in the injected CSS', async function () {
      const css = await page.evaluate(function () {
        var s = document.getElementById('rc-calculator-styles');
        return s ? s.textContent : '';
      });
      assert(css.length > 0, 'the calculator stylesheet was never injected');
      const bare = css.match(/(?<![A-Za-z0-9_$])-?(?:[0-9]*\.)?[0-9]+rem\b/g) || [];
      eq(bare.join(' '), '', 'rem lengths left in the stylesheet');
    });

    await check(target.name + ': the embed treatment is applied only off the standalone page', async function () {
      const m = await page.evaluate(function () {
        var mount = document.getElementById('reece-calculator');
        var card = document.querySelector('#rc-section-1 .rc-card');
        return {
          embed: mount.classList.contains('rc-embed'),
          bg: getComputedStyle(mount).backgroundColor,
          border: getComputedStyle(card).borderTopWidth,
          radius: getComputedStyle(card).borderTopLeftRadius,
          shadow: getComputedStyle(card).boxShadow
        };
      });
      if (target.variant === 'standalone') {
        eq(m.embed, false, 'rc-embed on the standalone page');
        eq(m.bg, 'rgb(242, 243, 247)', 'standalone page background');
        eq(m.border, '0px', 'standalone card border');
        eq(m.radius, '0px', 'standalone card radius');
      } else {
        eq(m.embed, true, 'rc-embed on the host page');
        eq(m.bg, 'rgba(0, 0, 0, 0)', 'grey box behind the embed');
        eq(m.border, '1px', 'embedded card border');
        eq(m.radius, '12px', 'embedded card radius');
        assert(/rgba\(11, 31, 58, 0\.06\)/.test(m.shadow), 'embedded card shadow: ' + m.shadow);
      }
    });

    await check(target.name + ': the calculator is as wide as its column allows, up to the cap', async function () {
      const m = await page.evaluate(function () {
        var container = document.querySelector('#reece-calculator .rc-container');
        var card = document.querySelector('#rc-section-1 .rc-card');
        var column = document.getElementById('reece-calculator').parentElement;
        return {
          column: Math.round(column.getBoundingClientRect().width),
          container: Math.round(container.getBoundingClientRect().width),
          card: Math.round(card.getBoundingClientRect().width)
        };
      });
      if (target.variant === 'standalone') {
        eq(m.container, 960, 'standalone container width');
        eq(m.card, 930, 'standalone card width');   // 960 less the 15px gutters
      } else {
        // Embedded, the container drops its gutters and takes the 880px cap, so
        // the card is the full container rather than 30px narrower than it.
        eq(m.container, Math.min(880, m.column), 'embedded container width');
        eq(m.card, m.container, 'embedded card width');
      }
    });

    if (target.variant === 'standalone') {
      await check(target.name + ': the placeholder is replaced, not left behind', async function () {
        const left = await page.evaluate(function () {
          return document.querySelectorAll('#reece-calculator [data-rc-placeholder]').length;
        });
        eq(left, 0, 'placeholders still in the mount after the calculator rendered');
      });

      await check(target.name + ': both third-party scripts still load', async function () {
        const srcs = await page.evaluate(function () {
          return Array.prototype.slice.call(document.querySelectorAll('script[src]'))
            .map(function (s) { return s.src; });
        });
        assert(srcs.some(function (s) { return s.indexOf('external-tracking.js') !== -1; }),
          'the GHL tracking script is not on the page');
        assert(srcs.some(function (s) { return s.indexOf('reece-tracker.js') !== -1; }),
          'the Reece tracker script is not on the page');
      });

      await check(target.name + ': PageView fires exactly once', async function () {
        const calls = await page.evaluate(function () { return window.fbqCalls || []; });
        const views = calls.filter(function (c) {
          return (c[0] === 'track' || c[0] === 'trackSingle') && c[c[0] === 'track' ? 1 : 2] === 'PageView';
        });
        eq(views.length, 1, 'PageView calls');
      });
    }

    await check(target.name + ': the embed injects no tracker script', async function () {
      // Only the standalone page's own <head> may load the tracker. The embed
      // must never inject one, on any origin.
      const injected = await page.evaluate(function () {
        return Array.prototype.slice
          .call(document.querySelectorAll('script[src]'))
          .filter(function (s) { return s.src.indexOf('reece-tracker') !== -1; })
          .map(function (s) { return s.src + '|' + (s.parentNode === document.head ? 'head' : 'other'); });
      });
      const expected = target.variant === 'standalone' ? 1 : 0;
      eq(injected.length, expected, 'tracker script tags in the DOM (' + injected.join(', ') + ')');
      if (expected === 0) eq(trackerRequests.length, 0, 'requests to the tracker origin');
    });

    // -----------------------------------------------------------------------
    // Policy links, clicked BEFORE the form is submitted — which is when a real
    // lead reads them, and why the visitor id is the only thing tying the click
    // to a person until I.STITCH runs.
    // -----------------------------------------------------------------------
    await check(target.name + ': both policy links open the GHL redirect in a new tab', async function () {
      for (const pair of [['#rc-link-privacy', 'https://landing.reecewindows.com/privacy'],
                          ['#rc-link-terms',   'https://landing.reecewindows.com/terms']]) {
        eq(await page.locator(pair[0]).isVisible(), true, pair[0] + ' is not visible');
        // A new page at all proves target=_blank; the recorded request proves it
        // went to the GHL redirect host and not to a policy page directly.
        const before = policyRequests.length;
        const [opened] = await Promise.all([
          ctx.waitForEvent('page', { timeout: 10000 }),
          page.click(pair[0])
        ]);
        await opened.waitForLoadState('domcontentloaded').catch(function () {});
        const fetched = policyRequests.slice(before);
        assert(fetched.some(function (u) { return u.indexOf(pair[1]) === 0; }),
          pair[0] + ' requested ' + (fetched.join(', ') || 'nothing') + ', expected ' + pair[1]);
        await opened.close();
      }
      // The form must be exactly as the lead left it: the links live outside
      // the <label>, so reading a policy cannot toggle consent.
      eq(await page.locator('#rc-consent-checkbox').isChecked(), false,
        'reading a policy toggled the consent checkbox');
    });

    if (target.tracker === 'none') {
      await check(target.name + ': policy links still work with no tracker at all', async function () {
        // Asserted by the zero-console-errors check at the end of this target:
        // the two clicks above ran with window.ReeceTrack undefined and the
        // navigations happened anyway.
        eq(await page.evaluate(function () { return typeof window.ReeceTrack; }),
          'undefined', 'typeof window.ReeceTrack');
        eq(consoleErrors.join(' | '), '', 'console errors after clicking the policy links');
      });
    } else {
      await check(target.name + ': each policy link mirrors its own event once', async function () {
        await page.waitForFunction(function (names) {
          const seen = (window.__rtCalls || []).map(function (c) { return c.name; });
          return names.every(function (n) { return seen.indexOf(n) !== -1; });
        }, POLICY_EVENTS, { timeout: 15000 });

        const rt = await page.evaluate(function () { return window.__rtCalls || []; });
        POLICY_EVENTS.forEach(function (name) {
          const hits = rt.filter(function (c) { return c.type === 'track' && c.name === name; });
          eq(hits.length, 1, name + ' mirror count');
          // Without calc_session_id the click cannot be joined to the session
          // that produced it, which is the whole point of recording it.
          assert(hits[0].props && hits[0].props.calc_session_id, name + ' has no calc_session_id');
          eq(hits[0].props.page, 'estimate-calculator', name + ' page prop');
          eq(hits[0].props.page_variant, target.variant, name + ' page_variant');
        });
      });
    }

    // Walk the whole funnel.
    await page.fill('#rc-full-name', LEAD.name);
    await page.fill('#rc-street-address', LEAD.street);
    await page.fill('#rc-city', LEAD.city);
    await page.fill('#rc-state', 'FL');
    await page.fill('#rc-postal-code', LEAD.zip);
    await page.fill('#rc-phone', LEAD.phone);
    await page.check('#rc-consent-checkbox');
    await page.click('#rc-section-1 button.rc-btn-primary');
    await page.waitForSelector('#rc-section-2.rc-visible', { timeout: 10000 });

    await check(target.name + ': step 2 advances', async function () {
      eq(await page.locator('#rc-section-2').isVisible(), true, 'step 2 visible');
    });

    await page.click('#rc-window-style .rc-tile[data-value="single_hung"]');
    await page.click('#rc-window-size .rc-tile[data-value="medium"]');
    await page.click('#rc-section-2 button.rc-btn-accent');
    await page.waitForSelector('#rc-window-list .rc-cart-item', { timeout: 10000 });
    await page.click('#rc-btn-to-step3');
    await page.waitForSelector('#rc-section-3.rc-visible', { timeout: 10000 });
    await page.fill('#rc-email', LEAD.email);
    await page.click('#rc-section-3 button.rc-btn-primary');
    await page.waitForSelector('#rc-verify-email-modal.rc-active', { timeout: 10000 });
    await page.fill('#rc-verify-code-input', '123456');
    await page.click('#rc-verify-submit-btn');
    await page.waitForSelector('#rc-section-4.rc-visible', { timeout: 10000 });

    await check(target.name + ': the estimate renders', async function () {
      const price = await page.locator('#rc-summary-content .rc-hero-price').textContent();
      assert(/^\$[\d,]+\.\d\d$/.test(price.trim()), 'hero price looks wrong: ' + price);
    });

    // -----------------------------------------------------------------------
    // The Reece tracker mirror
    // -----------------------------------------------------------------------
    if (target.tracker === 'none') {
      await check(target.name + ': the funnel completes with no ReeceTrack at all', async function () {
        const absent = await page.evaluate(function () { return typeof window.ReeceTrack; });
        eq(absent, 'undefined', 'typeof window.ReeceTrack');
        // The estimate rendered above with the tracker missing; the only thing
        // left to prove is that nothing was smuggled into the API payloads.
        const withVisitor = events.filter(function (e) { return e.body && e.body.visitor_id; });
        eq(withVisitor.length, 0, 'payloads carrying visitor_id without a tracker');
      });
    } else {
      // The queue only drains on a 500ms timer, so give the last events room to
      // land before reading. 'late' also has to clear its 3s wait.
      await page.waitForFunction(function () {
        return (window.__rtCalls || []).some(function (c) { return c.name === 'calc_estimate_completed'; });
      }, null, { timeout: 15000 }).catch(function () { /* asserted properly below */ });

      const rt = await page.evaluate(function () { return window.__rtCalls || []; });
      const tracks = rt.filter(function (c) { return c.type === 'track'; });
      const names = tracks.map(function (c) { return c.name; });
      const identifies = rt.filter(function (c) { return c.type === 'identify'; });

      await check(target.name + ': calc_* events mirror to the tracker in order', async function () {
        const pageView = names.indexOf('calc_page_view');
        const stepView = names.indexOf('calc_step_view');
        const completed = names.indexOf('calc_estimate_completed');
        assert(pageView !== -1, 'calc_page_view was never mirrored (saw: ' + names.join(', ') + ')');
        assert(stepView !== -1, 'calc_step_view was never mirrored (saw: ' + names.join(', ') + ')');
        assert(completed !== -1, 'calc_estimate_completed was never mirrored (saw: ' + names.join(', ') + ')');
        assert(pageView < stepView, 'calc_page_view came after calc_step_view');
        assert(stepView < completed, 'calc_step_view came after calc_estimate_completed');
        // Every event the walk passes through, none dropped.
        ['calc_consent_checked', 'calc_step1_complete', 'calc_step3_complete',
         'calc_verify_sent', 'calc_verify_success', 'calc_window_added'].forEach(function (n) {
          assert(names.indexOf(n) !== -1, n + ' was never mirrored (saw: ' + names.join(', ') + ')');
        });
      });

      await check(target.name + ': every mirrored event is a calc_ event carrying its session', async function () {
        tracks.forEach(function (c) {
          // Funnel steps are calc_*. The only exceptions are the two policy-link
          // signals, which are named by LP-MCP's visitor tracking contract and
          // are not steps in estimator_funnel_daily. Anything else is a typo.
          assert(/^calc_[a-z0-9_]+$/.test(c.name) || POLICY_EVENTS.indexOf(c.name) !== -1,
            'unexpected mirrored event name: ' + c.name);
          assert(c.props && c.props.calc_session_id, c.name + ' has no calc_session_id');
          eq(c.props.page_variant, target.variant, c.name + ' page_variant');
        });
        const sessions = new Set(tracks.map(function (c) { return c.props.calc_session_id; }));
        eq(sessions.size, 1, 'distinct calc_session_id values across one session');
      });

      await check(target.name + ': no mirrored props carry the lead\'s details', async function () {
        const pii = /email|phone|name|address|street|zip/i;
        tracks.forEach(function (c) {
          Object.keys(c.props).forEach(function (key) {
            assert(!pii.test(key), c.name + ' mirrors a lead key: ' + key);
          });
          const dump = JSON.stringify(c.props);
          assert(dump.indexOf('@') === -1, c.name + ' props contain an @: ' + dump);
          [LEAD.name, LEAD.street, LEAD.email, LEAD.phone, LEAD.zip,
           '+1' + LEAD.phone, '(954) 500-0000'].forEach(function (secret) {
            assert(dump.indexOf(secret) === -1, c.name + ' props leak "' + secret + '": ' + dump);
          });
        });
      });

      await check(target.name + ': one identify per change, first one after the contact upsert', async function () {
        assert(identifies.length > 0, 'identify was never called');
        // No identify may precede the contact upsert — I.STITCH matches
        // identify rows against contacts that already exist in GHL. Step 1's
        // consent_checked is the last event before submitContact() runs.
        const consent = rt.findIndex(function (c) { return c.name === 'calc_consent_checked'; });
        assert(consent !== -1, 'calc_consent_checked was never mirrored');
        assert(rt.indexOf(identifies[0]) > consent,
          'identify fired before the contact was submitted');
        // Exactly one identify per distinct payload: Step 1 has phone + name,
        // Step 3 adds the email. Verification repeats neither, so it is skipped.
        const payloads = identifies.map(function (c) { return JSON.stringify(c.traits); });
        eq(new Set(payloads).size, payloads.length, 'identify payloads (duplicates are noise for I.STITCH)');
        const withEmail = identifies.filter(function (c) { return c.traits.email === LEAD.email; });
        eq(withEmail.length, 1, 'identify calls carrying the verified email');
        identifies.forEach(function (c) {
          assert(c.traits.email || c.traits.phone, 'identify with nothing to match on');
        });
      });

      // Only meaningful when the tracker existed at submit time. There is no id
      // to read from a tracker that has not loaded, and the payload is not
      // worth delaying for one — visitor_id is best-effort, the identify is not.
      if (target.tracker === 'ready') {
        await check(target.name + ': visitor_id reaches /api/contact and /api/estimate', async function () {
          ['/api/contact', '/api/estimate'].forEach(function (p) {
            const calls = events.filter(function (e) { return e.path.indexOf(p) === 0; });
            assert(calls.length > 0, p + ' was never called');
            assert(calls.some(function (e) { return e.body.visitor_id === 'vis-test-0001'; }),
              p + ' never carried visitor_id');
          });
        });
      }

      if (target.tracker === 'late') {
        await check(target.name + ': events queued before the tracker arrived still send', async function () {
          const pageView = tracks.find(function (c) { return c.name === 'calc_page_view'; });
          assert(pageView, 'calc_page_view was lost while the tracker was loading');
          // It was emitted at load, so a delivery at ~3s proves it waited in the
          // queue rather than being dropped or fired into a missing tracker.
          assert(pageView.at >= 2900,
            'calc_page_view was delivered at ' + pageView.at + 'ms — the tracker only existed from 3000ms');
        });
      }
    }

    if (!target.full) {
      await check(target.name + ': zero console errors', function () {
        eq(consoleErrors.join(' | '), '', 'console errors');
      });
      await ctx.close();
      continue;
    }

    await check(target.name + ': exactly one trackSingle Lead to Reece\'s pixel', async function () {
      const calls = await page.evaluate(function () { return window.fbqCalls; });
      const leads = calls.filter(function (c) { return c[0] === 'trackSingle' && c[2] === 'Lead'; });
      eq(leads.length, 1, 'trackSingle Lead calls');
      eq(leads[0][1], '926500861053624', 'Lead pixel id');
      const plainLeads = calls.filter(function (c) { return c[0] === 'track' && c[1] === 'Lead'; });
      eq(plainLeads.length, 0, "plain fbq('track','Lead') calls");
    });

    await check(target.name + ': page_variant labels every event, contact and estimate', async function () {
      // The three payloads that decide which page a lead came from.
      const labelled = events.filter(function (e) {
        return /^\/api\/(events|contact|estimate)/.test(e.path);
      });
      assert(labelled.length > 0, 'no API calls were observed');
      ['/api/events', '/api/contact', '/api/estimate'].forEach(function (p) {
        assert(labelled.some(function (e) { return e.path.indexOf(p) === 0; }), p + ' was never called');
      });
      const values = new Set();
      labelled.forEach(function (e) {
        const v = e.body.page_variant || e.body.pageVariant;
        assert(v, e.path + ' payload has no page_variant');
        values.add(v);
      });
      eq(Array.from(values).join(','), target.variant, 'page_variant values');
    });

    await check(target.name + ': zero console errors', function () {
      eq(consoleErrors.join(' | '), '', 'console errors');
    });

    await ctx.close();
  }

  // -------------------------------------------------------------------------
  // Phones, on the WordPress stand-in.
  //
  // Everything above runs at Playwright's default 1280x720, which is why a
  // calculator that scrolled sideways by 119px on an iPhone shipped green. The
  // standalone page hides overflow with body{overflow-x:hidden}; the WordPress
  // page has no such guard, so anything too wide becomes real sideways scroll
  // there and only there. Assert the page cannot scroll sideways at all.
  // -------------------------------------------------------------------------
  // 360 is the common Android width and the one the v2 consent block — roughly
  // twice the length of v1 — has to stay legible at.
  for (const width of [320, 360, 390]) {
    const ctx = await browser.newContext({ viewport: { width: width, height: 780 } });
    const page = await ctx.newPage();
    await page.goto(HOST + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('#rc-section-1 .rc-card');

    await check('WordPress stand-in at ' + width + 'px: the page does not scroll sideways', async function () {
      const m = await page.evaluate(function () {
        return { scrollWidth: document.body.scrollWidth, viewport: window.innerWidth };
      });
      eq(m.scrollWidth, m.viewport, 'body scrollWidth at ' + width + 'px');
    });

    await check('WordPress stand-in at ' + width + 'px: nothing reaches past the screen edge', async function () {
      const past = await page.evaluate(function () {
        const out = [];
        document.querySelectorAll('#reece-calculator, #reece-calculator *').forEach(function (el) {
          const b = el.getBoundingClientRect();
          if (b.width === 0 && b.height === 0) return;
          if (b.right > window.innerWidth + 1 || b.left < -1) {
            out.push((el.id || el.tagName) + '@' + Math.round(b.left) + '+' + Math.round(b.width));
          }
        });
        return out;
      });
      eq(past.join(', '), '', 'elements past the viewport at ' + width + 'px');
    });

    await check('WordPress stand-in at ' + width + 'px: fields fill the column and do not zoom iOS', async function () {
      const m = await page.evaluate(function () {
        const city = document.getElementById('rc-city');
        const field = document.getElementById('rc-field-city');
        return {
          input: Math.round(city.getBoundingClientRect().width),
          field: Math.round(field.getBoundingClientRect().width),
          fontSize: parseFloat(getComputedStyle(city).fontSize),
          checkbox: Math.round(document.getElementById('rc-consent-checkbox').getBoundingClientRect().width)
        };
      });
      eq(m.input, m.field, 'city input width matches its field at ' + width + 'px');
      // Under 16px, Safari zooms on focus and never zooms back out.
      assert(m.fontSize >= 16, 'input font-size at ' + width + 'px is ' + m.fontSize + 'px, under the 16px iOS floor');
      // The width rule must not reach the consent checkbox: it is flex-shrink:0,
      // so width:100% would stretch it to the whole field and crush the text.
      assert(m.checkbox < 40, 'consent checkbox stretched to ' + m.checkbox + 'px at ' + width + 'px');
    });

    await check('WordPress stand-in at ' + width + 'px: the consent text is fine print, not a form label', async function () {
      const m = await page.evaluate(function () {
        const cs = getComputedStyle(document.querySelector('#reece-calculator .rc-consent-label'));
        return { fontSize: parseFloat(cs.fontSize), fontWeight: String(cs.fontWeight) };
      });
      eq(m.fontSize, 12, 'consent font-size at ' + width + 'px');
      eq(m.fontWeight, '400', 'consent font-weight at ' + width + 'px');
    });

    await check('WordPress stand-in at ' + width + 'px: the policy links stay legible and tappable', async function () {
      const m = await page.evaluate(function () {
        const p = document.querySelector('#reece-calculator .rc-consent-footer');
        const a = document.getElementById('rc-link-privacy');
        const cs = getComputedStyle(a);
        const box = a.getBoundingClientRect();
        return {
          footer:   p ? Math.round(p.getBoundingClientRect().width) : -1,
          field:    Math.round(document.getElementById('rc-field-consent').getBoundingClientRect().width),
          fontSize: parseFloat(cs.fontSize),
          colour:   cs.color,
          height:   Math.round(box.height),
          width:    Math.round(box.width)
        };
      });
      assert(m.footer > 0, 'the policy-link footer did not render');
      eq(m.footer, m.field, 'footer width matches its field at ' + width + 'px');
      // Fine print, but not unreadable fine print.
      assert(m.fontSize >= 11, 'policy links render at ' + m.fontSize + 'px at ' + width + 'px');
      // Never purple: a visited link left to the browser default is off-brand.
      eq(m.colour, 'rgb(135, 137, 139)', 'policy link colour at ' + width + 'px');
      assert(m.height > 0 && m.width > 0, 'the privacy link has no tappable box at ' + width + 'px');
    });

    await check('WordPress stand-in at ' + width + 'px: the calculator uses the whole screen', async function () {
      const m = await page.evaluate(function () {
        const mount = document.getElementById('reece-calculator').getBoundingClientRect();
        const column = document.getElementById('reece-calculator').parentElement.getBoundingClientRect();
        return { mount: Math.round(mount.width), column: Math.round(column.width), viewport: window.innerWidth };
      });
      // The theme column is only 81.25% wide; the embed breaks out of it on phones.
      assert(m.column < m.viewport, 'the stand-in column should be narrower than the screen, got ' + m.column);
      eq(m.mount, m.viewport, 'mount width at ' + width + 'px');
    });

    await ctx.close();
  }

  // Full mode shares this browser rather than launching a second one.
  await fullModeChecks(browser);

  await browser.close();
}

// ---------------------------------------------------------------------------
async function main() {
  process.env.PORT = String(APP_PORT);
  // server.js reads every env var at module load, so this must precede require.
  process.env.SWEEP_TOKEN = process.env.SWEEP_TOKEN || 'test-sweep-token-' + 'c'.repeat(32);
  process.env.GHL_API_KEY = process.env.GHL_API_KEY || '';
  require(path.join(ROOT, 'server.js'));

  const hostServer = http.createServer(function (req, res) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const u = req.url;
    res.end(
      u.indexOf('/embed-only') === 0 ? HOST_PAGE_EMBED_ONLY :
      u.indexOf('/funnel-full-bare') === 0 ? funnelPage('full', { bare: true }) :
      u.indexOf('/funnel-full') === 0 ? funnelPage('full') :
      u.indexOf('/funnel-embed') === 0 ? funnelPage('embed') :
      u.indexOf('/funnel-default') === 0 ? funnelPage(null) :
      u.indexOf('/funnel-garbage') === 0 ? funnelPage('garbage') :
      u.indexOf('/no-mount') === 0 ? NO_MOUNT_PAGE :
      HOST_PAGE);
  }).listen(HOST_PORT);

  await new Promise(function (r) { setTimeout(r, 500); });

  await syntaxChecks();
  await httpChecks();
  await grepChecks();
  await browserChecks();

  hostServer.close();
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    failures.forEach(function (f) { console.log('  - ' + f); });
    process.exit(1);
  }
  process.exit(0);
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
