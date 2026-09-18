'use strict';
/**
 * Regression baseline capture for the two pages that must NOT change.
 *
 *   node test/baseline.js <out-dir>
 *
 * Writes, for the standalone page and the WordPress stand-in, at 1440px and
 * 390px:
 *   <label>-<width>.png       full-page screenshot
 *   <label>.dom.txt           the mount's outerHTML, normalised
 *   <label>.meta.json         shadowRoot presence, mount classes, page variant
 *
 * Run it once on main, once on the branch, and diff the directories. A visual
 * or structural difference on either page is a blocker, not a nit — the whole
 * point of full mode being additive is that these two outputs are byte-identical.
 *
 * It is a tool, not a test: `npm test` does not run it. The assertions that
 * guard the same property automatically live in test/run.js.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP_PORT = 8073;
const HOST_PORT = 5057;
const APP = 'http://localhost:' + APP_PORT;
const HOST = 'http://127.0.0.1:' + HOST_PORT;
const API_BASE = 'https://estimate.getreecewindows.com';
const TRACKER_ORIGIN = 'https://track.getreecewindows.com';

const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'baseline'));

// The same WordPress stand-in test/run.js uses: foreign origin, the theme's
// 10px root font-size, colliding generic class names, no calculator CSS.
const HOST_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Window Estimate | Reece Windows</title>
<style>
html{font-size:10px}
body{margin:0;background:#fff}
.col-10{width:81.25%;margin:0 auto}
.card{border:9px solid red}.btn{background:lime}.total{font-size:60px}.container{width:120px}
</style>
</head><body>
<header><h1>Theme header</h1></header>
<div class="col-10"><div class="entry-content">
<div id="reece-calculator"></div>
<script src="${APP}/embed/calculator.js" defer></script>
</div></div>
</body></html>`;

// The GHL funnel page, with the class collisions that made full mode
// necessary. Captured for eyeballing, not for diffing.
const FUNNEL_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Instant Window Pricing</title>
<style>
html{font-size:10px}
body{margin:0;background:#fff}
.c-section{width:100%}.c-row{display:flex}.c-column{flex:1}
.card{display:none}.btn{background:magenta}.field{display:none}
.container{width:90px}.tile{display:none}.section{display:none}
</style>
</head><body>
<div class="c-section"><div class="c-row"><div class="c-column">
<div id="reece-calculator"></div>
<script src="${APP}/embed/calculator.js" data-mode="full" defer></script>
</div></div></div>
</body></html>`;

// Kept in step with chromiumPath() in test/run.js, and for the same reason:
// playwright-core 1.63 installs Chrome for Testing to
// chromium-<rev>/chrome-linux64/chrome, where older builds were
// chromium-<rev>/chrome-linux/chrome. This file only matched the old shape, so
// against a freshly installed browser it printed "No Chromium … cannot capture"
// and exited — the regression-comparison tool quietly unable to compare
// anything. Ask Playwright first, then fall back to scanning both layouts.
function chromiumPath() {
  try {
    const p = require('playwright-core').chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (e) { /* not where Playwright expects it; try the layouts below */ }

  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const candidates = [];
  try {
    fs.readdirSync(base).filter(function (d) { return /^chromium-/.test(d); }).forEach(function (d) {
      candidates.push(path.join(base, d, 'chrome-linux', 'chrome'));
      candidates.push(path.join(base, d, 'chrome-linux64', 'chrome'));
    });
  } catch (e) { /* no browsers dir */ }
  return candidates.find(function (p) { return fs.existsSync(p); }) || null;
}

// The mount's markup carries a session id and a handful of generated ids that
// differ run to run. Strip them so a diff shows real structural change only.
function normalise(html) {
  return String(html)
    .replace(/\s+/g, ' ')
    .replace(/> </g, '>\n<')
    .trim();
}

async function capture(browser, label, url, widths) {
  const meta = {};
  for (const width of widths) {
    const ctx = await browser.newContext({ viewport: { width: width, height: 900 } });
    const page = await ctx.newPage();

    // Offline: the API is stubbed, the tracker service is dead, every other
    // third party returns empty. Identical to the routing in test/run.js so the
    // captured pixels match what the suite exercises.
    await page.route('**/*', async function (route) {
      const url = route.request().url();
      if (url.indexOf(TRACKER_ORIGIN) === 0) {
        return route.fulfill({ status: 200, body: '', contentType: 'application/javascript' });
      }
      if (url.indexOf(API_BASE + '/api/') === 0) {
        return route.fulfill({
          status: 200, contentType: 'application/json', body: '{"ok":true}',
          headers: { 'access-control-allow-origin': '*' }
        });
      }
      if (url.indexOf('://localhost:') !== -1 || url.indexOf('://127.0.0.1:') !== -1) return route.continue();
      return route.fulfill({ status: 200, body: '', contentType: 'text/plain' });
    });

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#rc-section-1.rc-visible', { timeout: 15000 });

    // The footer's trust badges and logo are loading="lazy", and a full-page
    // screenshot scrolls the page — which starts those loads DURING the
    // capture. Two runs of identical code then differ by whether a broken-image
    // icon had painted yet. Scroll the whole page first, wait for every image
    // and the webfont to settle, then scroll back and shoot. Without this the
    // comparison this file exists for reports differences that are not there.
    await page.evaluate(async function () {
      const step = window.innerHeight;
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise(function (r) { setTimeout(r, 60); });
      }
      window.scrollTo(0, 0);
      await Promise.all(Array.prototype.slice.call(document.images).map(function (img) {
        if (img.complete) return null;
        return new Promise(function (r) { img.addEventListener('load', r); img.addEventListener('error', r); });
      }));
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
    });
    await page.waitForTimeout(600);

    await page.screenshot({
      path: path.join(OUT, label + '-' + width + '.png'),
      fullPage: true
    });

    if (!meta.captured) {
      const snap = await page.evaluate(function () {
        var mount = document.getElementById('reece-calculator');
        // Full mode's tree is behind the shadow boundary; capture that instead.
        if (mount.shadowRoot) {
          return {
            shadowRoot: 'present',
            mountClass: mount.className,
            pageVariant: window.ReeceCalculator.pageVariant,
            renderMode: window.ReeceCalculator.renderMode,
            styleInHead: !!document.getElementById('rc-calculator-styles'),
            html: mount.shadowRoot.innerHTML
          };
        }
        // Deliberately does NOT record renderMode: this is the snapshot that
        // gets diffed against a capture from main, and main has no such
        // export. Adding a key here would report a difference on the two pages
        // whose whole point is that they have none.
        return {
          shadowRoot: null,
          mountClass: mount.className,
          pageVariant: window.ReeceCalculator.pageVariant,
          styleInHead: !!document.getElementById('rc-calculator-styles'),
          html: mount.outerHTML
        };
      });
      fs.writeFileSync(path.join(OUT, label + '.dom.txt'), normalise(snap.html) + '\n');
      delete snap.html;
      snap.captured = true;
      Object.assign(meta, snap);
    }
    await ctx.close();
  }
  fs.writeFileSync(path.join(OUT, label + '.meta.json'), JSON.stringify(meta, null, 2) + '\n');
  console.log('  captured ' + label);
}

async function main() {
  const exe = chromiumPath();
  if (!exe) {
    console.error('No Chromium under PLAYWRIGHT_BROWSERS_PATH — cannot capture.');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });

  process.env.PORT = String(APP_PORT);
  process.env.SWEEP_TOKEN = process.env.SWEEP_TOKEN || 'test-sweep-token-' + 'c'.repeat(32);
  process.env.GHL_API_KEY = process.env.GHL_API_KEY || '';
  require(path.join(ROOT, 'server.js'));

  const hostServer = http.createServer(function (req, res) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(req.url.indexOf('/full') === 0 ? FUNNEL_PAGE : HOST_PAGE);
  }).listen(HOST_PORT);

  await new Promise(function (r) { setTimeout(r, 500); });

  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });

  console.log('Capturing into ' + OUT);
  await capture(browser, 'standalone', APP + '/', [1440, 390]);
  await capture(browser, 'wordpress', HOST + '/', [1440, 390]);
  // Not a regression target — main cannot produce it. Captured so full mode's
  // chrome can be eyeballed next to the standalone page it is copied from.
  await capture(browser, 'funnel-full', HOST + '/full', [1440, 390]);

  await browser.close();
  hostServer.close();
  process.exit(0);
}

main().catch(function (err) { console.error(err); process.exit(1); });
