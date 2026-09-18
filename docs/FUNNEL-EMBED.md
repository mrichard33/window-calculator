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
        data-tracking-id="tk_e546f581cf8f430dad0ec8f0838d01d3"></script>

<!-- Calculator, full-page mode -->
<div id="reece-calculator"></div>
<script src="https://estimate.getreecewindows.com/embed/calculator.js"
        data-mode="full" defer></script>
```

`data-mode="full"` is the whole difference. It tells the calculator to draw the
navy header, the calculator, the running-total bar and the Reece footer —
everything the standalone page shows — instead of just the calculator on its
own.

**Two things must stay exactly as they are:**

- **Leave the Meta Pixel `926500861053624` block on the page.** That is the
  pixel the Lead Gurus ads optimise against. Remove it and ad attribution
  stops.
- **Do not add `data-collector` to the tracker tag.** The default collector is
  what is already working live on `reecewindows.com`.

## Step 2 — Keep the old code for a week

Comment the inline calculator out rather than deleting it. If anything is wrong
it is a one-minute rollback. Delete it after a week of clean submissions.

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
6. Confirm the Meta Pixel fires (Meta Pixel Helper) and GHL external tracking
   records the visit.
7. Click one of the 14 trigger links that carry prefill details and confirm the
   name, address and phone fields fill in on the funnel page.
8. Re-check `estimate.getreecewindows.com` and
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
