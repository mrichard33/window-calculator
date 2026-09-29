# Putting the calculator on the GHL funnel page

**For:** Mark, in the GoHighLevel UI
**Page:** `landing.reecewindows.com/instant-window-pricing`
**Time needed:** about 15 minutes, plus the checks at the bottom

---

## What this is

The funnel page currently carries its own inline copy of the calculator. That
copy has to be edited by hand every time the real calculator changes — so the
consent wording, the pricing and the tracking drift apart across three pages.

This replaces the inline copy with the same one-line embed the other two pages
use, in a new **full-page mode**. After this, the funnel page, the WordPress
page and `estimate.getreecewindows.com` all run one file, and a change ships
once.

Nothing about the other two pages changes.

---

## Why not a redirect or an iframe

Both were tried and ruled out:

- **A 301 redirect** to `estimate.getreecewindows.com` loses the ad tags.
  GHL's URL redirects strip the query string, so `utm_source` and `fbclid`
  never arrive and the sale cannot be traced back to the ad that paid for it.
- **An iframe** breaks visitor stitching. Safari treats a framed third-party
  site as cross-site and blocks its cookies, so the visitor's id is lost.

Dropping the calculator into the page itself avoids both: it reads the address
bar directly and its cookies stay first-party.

---

## Step 1 — Replace the inline custom-code block

```html
<!-- Reece first-party tracker -->
<script src="https://track.getreecewindows.com/reece-tracker.js"
        data-reece-tracker
        data-sister-domains="reecewindows.com,getreecewindows.com"
        defer></script>

<!-- GHL external tracking -->
<script src="https://link.reecewindows.com/js/external-tracking.js"
        data-tracking-id="tk_e546f581cf8f430dad0ec8f0838d01d3"
        async></script>

<!-- Calculator, full-page mode -->
<div id="reece-calculator"></div>
<script src="https://estimate.getreecewindows.com/embed/calculator.js"
        data-mode="full" defer></script>
```

`data-mode="full"` is the whole difference. It tells the calculator to draw the
navy header, the calculator, the running-total bar and the Reece footer —
everything the standalone page shows — instead of just the calculator on its
own.

`async` on the GHL tag lets the page keep drawing while that script downloads
(it is 267 KB, 82 KB over the wire). It is safe: the script finds its own tag
through `document.currentScript`, which works with `async`, and nothing else on
the page waits for it. `estimate.getreecewindows.com` has loaded it this way
since 2026-09-10. As of 2026-09-29 the live funnel tag still lacks it — add the
one word and republish.

**How GHL ties a visit to a contact (2026-09-29).** GHL external tracking knows
who a visitor is only from a note it keeps in the browser (`_ud` in local
storage). GHL writes that note when one of its own forms is submitted, and it
never reads the contact from a link. The calculator is not a GHL form, so it
writes the note itself once the lead is saved. Page views before the calculator
is submitted stay anonymous, and GHL has no way to re-tag them. To test it, use
a fresh private window, submit the calculator, then refresh or move on a step.
Those later views should appear on the contact.

**The Meta Pixel is no longer yours to place.** The calculator loads pixel
`926500861053624` itself in full mode. You do not need a pixel block on this
funnel, and you should not add one.

That changed on 2026-09-18, because the hand-placed block went missing from the
live page and nothing caught it: every Meta call in the calculator is guarded on
`fbq` existing, so Lead, CompleteRegistration and the rest simply stopped
reaching Meta, silently, on the page carrying most of the volume. If a block is
pasted back in anyway, the injector stands down rather than double-counting — but
the deploy is the source of truth now.

**One thing that must stay exactly as it is:**

- **Do not add `data-collector` to the tracker tag.** The default collector is
  what is already working live on `reecewindows.com`.

## Step 2 — Keep the old code for a week

Comment the inline calculator out rather than deleting it. If anything is wrong
it is a one-minute rollback. Delete it after a week of clean submissions.

---

## Step 3 — Keep the funnel out of Google

This funnel runs the **same calculator content** as
`reecewindows.com/window-estimate/`. Two indexed copies split the ranking signal
instead of concentrating it, and the funnel sits on a subdomain, which Google
treats as a separate site — so indexing it builds nothing for the main domain.
Every step here is a paid-traffic destination with no organic job to do.

Noindex has **no effect on Google Ads or Meta Ads.** Paid traffic reaches a
noindexed page normally, so the Lead Gurus campaigns are unaffected.

The funnel-level Head tracking code applies to every step, so this is one edit
for the whole funnel. In **Sites → Funnels → Estimate Calculator → Settings →
Tracking & scripts → Head tracking code**, alongside whatever is already there,
add:

```html
<meta name="robots" content="noindex, nofollow">
```

Then **republish the funnel** — GHL serves a cached build, and an unpublished
change never reaches the live page.

GHL also has a per-step SEO panel (the gear icon beside a step's Edit button),
which is where `/confirm-your-pricing` got its own noindex. Either works; the
funnel-level box covers every step in one go. A page carrying both directives is
harmless — Google honours the most restrictive.

**Two things not to do:**

- **Never add `Disallow` to robots.txt to achieve this.** Blocking the crawler
  HIDES the noindex: Google can still index a blocked URL if something links to
  it, and it can never read the directive telling it not to. The standalone page
  serves a deliberately permissive robots.txt for exactly this reason — see the
  comment in `server.js`, and the test in `test/run.js` that stops anyone
  "helpfully" adding a Disallow.
- **Do not repoint the canonical at the WordPress page.** `noindex` plus a
  canonical to a *different* URL is a conflicting signal. Set the noindex and
  leave GHL's self-canonical alone.

A page already in the index drops out on the next crawl, which can take weeks.
`site:landing.reecewindows.com` shows what is indexed today; Search Console's
**URL Inspection → Request Indexing** forces the recrawl that makes Google see
the noindex, and **Removals** hides it within about a day if it is urgent.

---

## Why it cannot break the funnel page's design

In full mode the calculator draws itself inside a **shadow root** — a sealed
box in the page. The funnel page's own styling cannot reach inside it, and the
calculator's styling cannot reach out.

This matters because both use the same everyday class names — `card`, `btn`,
`field`, `container`, `tile`, `section`. On the other two pages there is no
clash and no box is needed, which is why full mode is opt-in and the other two
pages keep working exactly as they do today.

---

## Check it worked, in this order

1. Open the page with `?utm_source=test&utm_medium=cpc&fbclid=ABC123` on the
   end. The calculator should fill the page, header and footer included, and
   the tags should still be in the address bar.
2. Right-click → Inspect. The calculator sits inside `#reece-calculator`'s
   shadow root, and the rest of the funnel page looks untouched.
3. Complete a real test submission. In GHL, confirm the contact was created,
   the Estimate PDF URL field (`WwmVP3sAjdqYQbZyITZT`) is filled, the
   `calc-page` tag is set and the UTMs were stored.
4. Confirm the contact enters E.0 Master Router → E.2 Calculator Bridge v2
   (`8a1819c1-a645-4c88-8235-13bf1b1a56ab`) → S2.1 v3
   (`79cc44ee-e7bd-4bbf-a2da-2bc3d3024143`).
5. Confirm a `site.identity_stitched` event shows up for that visitor in
   `site_events` (LP Supabase) within about five minutes.
6. Confirm the Meta Pixel fires with Meta Pixel Helper — pixel
   `926500861053624`, **PageView on load AND a Lead after Step 1.** The
   calculator injects this itself now, so if the helper shows nothing it means
   the embed failed to load, not that a block is missing: check the console and
   that `data-mode="full"` is still on the script tag. Do not skip this. When
   the pixel is absent the failure is silent — Lead Gurus loses attribution and
   the calculator's own `trackSingle` Lead call does nothing at all, because it
   is guarded on `fbq` existing. That is exactly how it went unnoticed the first
   time round. Also confirm GHL external tracking records the visit.
7. Click one of the 14 trigger links that carry prefill details and confirm the
   name, address and phone fields fill in on the funnel page.
8. View source on each funnel step and confirm
   `<meta name="robots" content="noindex, nofollow">` is present (Step 3). Then
   confirm `reecewindows.com/window-estimate/` still has **no** robots meta —
   that is the one page that must stay indexed.
9. Re-check `estimate.getreecewindows.com` and
   `reecewindows.com/window-estimate/` in production. Both must look and behave
   exactly as before.

---

## Notes for whoever maintains the calculator

- **Mode is read from the script tag.** `data-mode="full"` renders the page
  chrome inside a shadow root. `data-mode="embed"`, or no attribute at all, is
  the original light-DOM path — byte for byte what the other two pages have
  always run. An unrecognised value warns and falls back to `embed`; it never
  throws.
- **All internal DOM lookups go through `$id` / `$one` / `$all`,** which
  resolve against `document` in embed mode and against the shadow root in full
  mode. Never reintroduce a bare `document.getElementById` for a node the
  calculator draws — it will work on two pages and silently return `null` on
  the funnel page.
- **Both optional host hooks — the running-total bar (`#rc-running-total`) and
  the printed banner (`#rc-host-header`) — go through `hostEl()`,** which looks
  in the render root first and then the document. The standalone page supplies
  them from its own markup; full mode draws them itself.
- **The webfont and the Places dropdown live in the light DOM.** An
  `@font-face` declared only inside a shadow root does not resolve, and Google
  appends `.pac-container` to `document.body` and styles it from its own
  `document.head` stylesheet. Both are handled by `injectLightDomSupport()`.
- **`:host` carries `contain: inline-size`.** GHL builds every funnel row as a
  flex container, and a flex item refuses to shrink below its content's
  min-content width — the stepper's is 385px, which made the whole page scroll
  sideways at 360px. Size containment lets the column shrink to the screen. Do
  not remove it without re-running the phone checks in `test/run.js`.
- **Exactly one of the three pages is indexable, and it is the WordPress one.**
  `reecewindows.com/window-estimate/` is the SEO copy;
  `estimate.getreecewindows.com` carries a noindex meta AND an `X-Robots-Tag`
  header (both asserted by `test/run.js`), and this funnel carries a noindex per
  Step 3. That policy used to live only in a comment in `public/index.html`,
  which is how the funnel shipped without one. If a fourth surface ever runs
  this calculator, it is noindex unless someone decides otherwise on purpose.
- **Full mode owns the Meta pixel; embed mode owns nothing.** `injectMetaPixel()`
  runs only from `mountFull()`, so the WordPress page can never gain a pixel from
  the embed — it keeps its own through Socius's GTM container, untouched. The
  injector short-circuits on `window.fbq`, and fires PageView with `trackSingle`
  rather than `track`, so a funnel that later gains a second pixel still never
  receives ours. `test/run.js` proves the embed-mode half on a fixture carrying
  no pixel at all; that test is the one keeping a pixel off `reecewindows.com`.
- **Microsoft Clarity stays host-page-owned.** This funnel loads it through GHL's
  head tracking code and the standalone page loads it from `public/index.html`;
  the embed never injects it, which is what keeps it off the WordPress page.
- **`page_variant` is still resolved from the hostname**, so the funnel page
  reports as `main-domain`, the same value the WordPress page reports. If
  funnel traffic ever needs its own bucket in reporting, that is a deliberate
  change to `PAGE_VARIANT` and to whatever GHL workflows filter on
  `calc-page:main-domain` — not something to slip in.
- **Printing on the funnel page is not the same as printing on the standalone
  page.** The calculator's own print rules travel with it inside the shadow
  root, but `public/index.html`'s page-level `@media print` rules do not exist
  on the funnel page, so the funnel page's own content prints alongside the
  estimate. The emailed PDF is unaffected — it is generated server-side.

## Checking a change did not touch the other two pages

```bash
git stash                                   # or check out main
node test/baseline.js /tmp/base-main
git stash pop                               # back to your branch
node test/baseline.js /tmp/base-branch
diff -r /tmp/base-main /tmp/base-branch      # must print nothing
```

That captures full-page screenshots at 1440px and 390px, plus the rendered DOM,
for the standalone page and a WordPress stand-in. Any difference is a blocker.
`npm test` asserts the same properties automatically.
