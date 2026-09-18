# Putting the window estimate calculator on the WordPress page

**For:** whoever maintains reecewindows.com
**Page:** `reecewindows.com/window-estimate/`
**Time needed:** about 10 minutes

---

## What changed and why

The calculator used to be pasted into the WordPress page as one big block of
code. WordPress treated a piece of that code as one of its own shortcodes and
rewrote it, which broke the whole thing — nobody could submit an estimate.

The fix: the calculator now lives on Reece's own server and the page loads it
with a single line. WordPress never sees the code, so it can never rewrite it
again.

---

## Step 1 — Paste these two lines

```html
<div id="reece-calculator"></div>
<script src="https://estimate.getreecewindows.com/embed/calculator.js" defer></script>
```

That is the whole calculator. Nothing else is needed.

**Where to paste it**

Use a **Custom HTML block** (Gutenberg), a **Code / HTML widget** (page
builder), or a child-theme template file.

**Do not** paste it into the classic or visual editor. That editor is what
mangled the code last time — it will do it again.

---

## Step 2 — Delete the old calculator code

Remove the old pasted block completely: all the HTML, all the CSS, and all the
JavaScript. If any of it is left behind, the page will try to run two
calculators at once.

While you are there, check that the page does **not** load these, because the
embed already handles them and the page's own copies would double-count:

- a second copy of the calculator's stylesheet
- anything that loads `external-tracking.js` twice

The Meta pixel and the GoHighLevel tracking script that the page already loads
are correct and should stay. The embed deliberately does not load either one.

---

## Step 3 — Exclude the page from optimisation plugins

This is the step that most often breaks things. In whichever plugin handles
speed (WP Rocket, LiteSpeed, Autoptimize, Perfmatters, SiteGround Optimizer,
Cloudflare APO…), add `/window-estimate/` to the exclusion list for **all** of:

- Minify JavaScript
- Combine / concatenate JavaScript
- Defer JavaScript
- Delay JavaScript ("load on user interaction")
- Lazy-load scripts
- Remove unused CSS

If you can only exclude one thing, exclude **delay JavaScript** — that one stops
the calculator from appearing at all.

---

## Step 4 — Two things that must not change

**Keep query strings intact.** Ad clicks arrive with tags on the end of the
address, like `?utm_source=facebook&fbclid=…`. Those tags are how Reece knows
which ad produced a sale. Any plugin or redirect rule that strips them, or that
redirects `/window-estimate?…` to a clean `/window-estimate/`, breaks the
reporting. Trailing-slash redirects are fine **only** if they carry the query
string through.

**No catch-all redirect for `*.getreecewindows.com`.** That domain hosts the
calculator itself. A redirect rule covering it would take the calculator
offline on both pages.

---

## Step 5 — Check it worked

1. Open `reecewindows.com/window-estimate/` in a private window.
2. The calculator should appear where you pasted the two lines, showing
   "Step 1: Tell Us About Your Home".
3. Right-click → Inspect → Console. It should be clean. If you see
   `No <div id="reece-calculator">`, the div did not survive saving — re-paste
   it in a Custom HTML block.

---

## Updating it later

Nothing to do. The address in the snippet never changes, and the page picks up
new versions within about 5 minutes. Reece deploys the calculator; the page
follows automatically.

---

## Notes for whoever maintains the calculator

- The file is `public/embed/calculator.js` in the `window-calculator` repo, and
  it is the **only** copy of the calculator. The standalone page at
  `estimate.getreecewindows.com` loads the very same file, so one deploy
  updates both pages.
- The two lines in Step 1 are the **embed** mode, and they are unchanged. The
  file also has a `data-mode="full"` mode, added for the GoHighLevel funnel
  page — see `docs/FUNNEL-EMBED.md`. It is opt-in and this page must never use
  it: full mode draws its own header and footer, which on WordPress would put a
  second header inside the page. Leaving the attribute off is what keeps this
  page exactly as it is.
- Everything it draws is scoped under `#reece-calculator`, every id and class it
  creates starts with `rc-`, and the only global it defines is
  `window.ReeceCalculator`. A theme cannot collide with it and it does not need
  jQuery.
- It never initialises a Meta pixel and never fires `PageView` — the host page
  owns those. The one Meta event it sends is a `trackSingle` **Lead** to pixel
  `926500861053624` only, once per session, so a page carrying several pixels
  does not leak the lead to the others.
- Two optional hooks the host page may supply. Both are ignored when absent, so
  WordPress needs neither:
  - `<div id="rc-running-total"><div>…<span>$0</span></div></div>` — the
    running-total bar, filled in and shown only on Step 4.
  - `id="rc-host-header"` on a page banner — cloned into the printed estimate.
- `page_variant` is resolved from the hostname: `standalone` on
  `estimate.getreecewindows.com`, the Railway domain and `localhost`;
  `main-domain` everywhere else. It rides along with every funnel event and
  becomes a `calc-page:standalone` / `calc-page:main-domain` tag on the GHL
  contact. Lead Perfection source ids are unchanged.
