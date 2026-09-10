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

// ---------------------------------------------------------------------------
// 1. Syntax
// ---------------------------------------------------------------------------
function jsFiles(dir, out) {
  out = out || [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    if (e.name === 'node_modules' || e.name === '.git') return;
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
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const candidates = [
    path.join(base, 'chromium', 'chrome-linux', 'chrome'),
    path.join(base, 'chromium', 'chrome'),
  ];
  try {
    fs.readdirSync(base).filter(function (d) { return /^chromium-/.test(d); }).forEach(function (d) {
      candidates.push(path.join(base, d, 'chrome-linux', 'chrome'));
    });
  } catch (e) { /* no browsers dir */ }
  return candidates.find(function (p) { return fs.existsSync(p); }) || null;
}

// A page that mimics the WordPress target: a foreign origin, three initialised
// pixels, and none of the calculator's own CSS.
const HOST_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Window Estimate | Reece Windows</title>
<style>.card{border:9px solid red}.btn{background:lime}.total{font-size:60px}.container{width:120px}</style>
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
<div id="reece-calculator"></div>
<script src="${APP}/embed/calculator.js" defer></script>
</body></html>`;

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
    { name: 'standalone page', url: APP + '/?utm_source=test&utm_medium=paid', variant: 'standalone' },
    { name: 'foreign origin (WordPress stand-in)', url: HOST + '/', variant: 'main-domain' }
  ]) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const consoleErrors = [];
    const events = [];
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

    // Walk the whole funnel.
    await page.fill('#rc-full-name', 'Test Homeowner');
    await page.fill('#rc-street-address', '100 Test St');
    await page.fill('#rc-city', 'Tampa');
    await page.fill('#rc-state', 'FL');
    await page.fill('#rc-postal-code', '33601');
    await page.fill('#rc-phone', '9545000000');
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
    await page.fill('#rc-email', 'test@example.com');
    await page.click('#rc-section-3 button.rc-btn-primary');
    await page.waitForSelector('#rc-verify-email-modal.rc-active', { timeout: 10000 });
    await page.fill('#rc-verify-code-input', '123456');
    await page.click('#rc-verify-submit-btn');
    await page.waitForSelector('#rc-section-4.rc-visible', { timeout: 10000 });

    await check(target.name + ': the estimate renders', async function () {
      const price = await page.locator('#rc-summary-content .rc-hero-price').textContent();
      assert(/^\$[\d,]+\.\d\d$/.test(price.trim()), 'hero price looks wrong: ' + price);
    });

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
  await browser.close();
}

// ---------------------------------------------------------------------------
async function main() {
  process.env.PORT = String(APP_PORT);
  process.env.GHL_API_KEY = process.env.GHL_API_KEY || '';
  require(path.join(ROOT, 'server.js'));

  const hostServer = http.createServer(function (req, res) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HOST_PAGE);
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
