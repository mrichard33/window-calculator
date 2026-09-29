/**
 * Reece Windows & Doors — Window Estimate Calculator (embeddable build)
 *
 * One file, two pages. It renders the whole calculator — markup, styles and
 * logic — inside <div id="reece-calculator"></div> on whatever page includes
 * it, so estimate.getreecewindows.com and reecewindows.com/window-estimate run
 * exactly the same code and one deploy updates both.
 *
 * Host page contract (see docs/EMBED.md):
 *   <div id="reece-calculator"></div>
 *   <script src="https://estimate.getreecewindows.com/embed/calculator.js" defer></script>
 *
 * Trackers are the HOST PAGE's, with one deliberate exception:
 *   - the GHL external tracking script is never loaded here, on any page
 *   - the Reece visitor tracker is never loaded here, on any page
 *   - the Meta pixel is loaded here ONLY in full mode (see injectMetaPixel),
 *     because full mode is the GHL funnel page and that page's hand-placed
 *     pixel block went missing in production. Embed mode still initialises
 *     nothing, which is what keeps a pixel off reecewindows.com.
 * Every Meta event this file sends is a trackSingle to Reece's pixel only, so a
 * host page carrying several pixels does not leak the lead to the others.
 *
 * Every id and class it creates is prefixed rc-, every style rule is scoped
 * under #reece-calculator, and the only global it defines is
 * window.ReeceCalculator — a WordPress theme cannot collide with it and it
 * does not need jQuery.
 *
 * TWO RENDER MODES (2026-09-18), selected by data-mode on the script tag:
 *
 *   embed  (the default, and what an absent attribute means)
 *     Today's behaviour, unchanged. Light DOM, styles in document.head, the
 *     markup written straight into #reece-calculator. This is what
 *     estimate.getreecewindows.com and reecewindows.com/window-estimate run,
 *     and neither page may change by so much as a pixel.
 *
 *   full   (opt-in: data-mode="full")
 *     Page chrome + calculator + footer rendered inside a SHADOW ROOT on the
 *     mount. Added for the GHL funnel page landing.reecewindows.com, which
 *     ships its own .card / .btn / .container utility classes that collide
 *     with the calculator's generic names. Isolation is needed there and
 *     nowhere else, which is why it is opt-in rather than the new default.
 *
 * Everything full mode needs is an ADDITIVE branch. Read the embed path and
 * nothing in it has moved.
 */
(function (window, document) {
  'use strict';

  var MOUNT_ID = 'reece-calculator';
  var STYLE_ID = 'rc-calculator-styles';
  var META_PIXEL_ID = '926500861053624';
  // Optional host-page hooks. Present on the standalone shell, absent on
  // WordPress; every use of them is guarded.
  var HOST_TOTAL_ID = 'rc-running-total';
  var HOST_HEADER_ID = 'rc-host-header';
  var MAPS_SRC = 'https://maps.googleapis.com/maps/api/js' +
    '?key=AIzaSyDHEXJFX600__uKskBl1RVs2wensuUW4c4' +
    '&libraries=places&callback=ReeceCalculator.initializeAddressForm';

  // ==========================================================================
  //  RENDER MODE + QUERY ROOT
  // ==========================================================================
  // Which of the two modes above this page asked for. Resolved once, at parse
  // time, from the script tag that loaded this file.
  //
  // An unknown value falls back to 'embed' and warns. It must never throw: the
  // WordPress page and the standalone page both run this line, and a typo on a
  // third page is not a reason to take the calculator off the other two.
  var RENDER_MODE = (function () {
    var tag = document.currentScript;
    if (!tag) {
      // currentScript is null inside a module or when something re-executes
      // this file. Fall back to finding our own tag by src.
      tag = document.querySelector('script[src*="calculator.js"][data-mode]');
    }
    var requested = (tag && tag.getAttribute('data-mode') || '').trim().toLowerCase();
    if (!requested || requested === 'embed') return 'embed';
    if (requested === 'full') return 'full';
    console.warn('[ReeceCalculator] Unknown data-mode="' + requested +
      '" — rendering in embed mode. Valid values are "embed" and "full".');
    return 'embed';
  })();

  // The node every calculator-INTERNAL query resolves against.
  //
  // In embed mode this is `document`, which is literally what all 111 call
  // sites said before this branch — so the embed and standalone paths resolve
  // exactly the nodes they always did. In full mode the calculator's markup is
  // not in the document at all, so it is the shadow root instead.
  //
  // Reassigned at mount rather than defaulted differently: a shared helper
  // whose DEFAULT moved would change the standalone page, which this branch
  // must not touch.
  var queryRoot = document;
  function $id(id) { return queryRoot.getElementById(id); }
  function $one(sel) { return queryRoot.querySelector(sel); }
  function $all(sel) { return queryRoot.querySelectorAll(sel); }

  // The two OPTIONAL host-page hooks (the running-total bar and the banner
  // cloned into the printed estimate) are a different question from the
  // calculator's own nodes: in embed mode the HOST page supplies them, in full
  // mode this file renders them itself, inside the shadow root. Look in the
  // render root first, then the document — so the standalone page keeps finding
  // its own bar and header exactly as it does today.
  function hostEl(id) {
    var found = queryRoot.getElementById ? queryRoot.getElementById(id) : null;
    return found || document.getElementById(id);
  }

  // The element the calculator was mounted into, and the per-session state that
  // used to hang off window.
  var mountEl = null;
  // The shadow root in full mode, null in embed mode. Exported for debugging
  // and asserted against in the suite: embed mode must never create one.
  var shadowRootEl = null;
  var state = {
    contactId: '',
    verifyId: '',
    estimateToken: '',
    estimateSent: false,
    leadFired: false,
    latestEstimateTotal: '',
    latestWindowCount: 0,
    latestEstimateLow: 0,
    latestEstimateHigh: 0,
    latestMonthlyLow: 0,
    latestMonthlyAvg: 0
  };

  // ==========================================================================
  //  STYLES — injected from here so the host page has no second file to load
  // ==========================================================================
  var CSS = [
    "/* =============================================================",
    "   Reece Windows & Doors — Window Cost Estimator",
    "   All visual styling (inlined for standalone use)",
    "   ============================================================= */",
    "#reece-calculator, #reece-calculator *, #reece-calculator *::before, #reece-calculator *::after { box-sizing: border-box; margin: 0; padding: 0; }",
    "#reece-calculator {",
    "  --reece-red: #9B2E2C;",
    "  --cta-red: #ED1F24;",
    "  --deep-navy: #0D2240;",
    "  --dark-navy: #122738;",
    "  --steel-blue: #6488A0;",
    "  --mist: #C1D5DB;",
    "  --text-gray: #87898B;",
    "  --light-bg: #F2F3F7;",
    "  --deep-red: #A00000;",
    "  --charcoal: #636060;",
    "  --powder-blue: #C7DAE4;",
    "  --white: #FFFFFF;",
    "  --shadow: 0 2px 12px rgba(13,34,64,0.10);",
    "  /* Every length below is written as calc(N * var(--rc-rem)) rather than",
    "     Nrem. rem resolves against the HOST page's <html> font-size, and the",
    "     WordPress theme sets html{font-size:10px} — which rendered the whole",
    "     calculator at 62.5% on reecewindows.com. Pinning the scale here makes",
    "     both pages render identically. em would compound through nesting; a",
    "     custom property does not. */",
    "  --rc-rem: 16px;",
    "}",
    "#reece-calculator {",
    "  font-family: 'Nunito Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;",
    "  background: var(--light-bg);",
    "  color: var(--charcoal);",
    "  line-height: 1.6;",
    "  font-size: 17px;",
    "  font-weight: 400;",
    "}",
    "/* ===== CONTAINER ===== */",
    "#reece-calculator .rc-container {",
    "  max-width: 960px;",
    "  margin: 0 auto;",
    "  padding: calc(1.5 * var(--rc-rem)) 15px calc(3 * var(--rc-rem));",
    "}",
    "/* ===== STEPPER ===== */",
    "#reece-calculator .rc-stepper {",
    "  display: flex;",
    "  justify-content: center;",
    "  gap: calc(0.25 * var(--rc-rem));",
    "  margin-bottom: calc(2 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-stepper .rc-step {",
    "  display: flex;",
    "  align-items: center;",
    "  gap: calc(0.4 * var(--rc-rem));",
    "  font-size: calc(0.82 * var(--rc-rem));",
    "  color: var(--text-gray);",
    "  font-weight: 400;",
    "}",
    "#reece-calculator .rc-stepper .rc-step.rc-active { color: var(--deep-navy); font-weight: 700; }",
    "#reece-calculator .rc-stepper .rc-step.rc-done { color: var(--cta-red); }",
    "#reece-calculator .rc-stepper .rc-step .rc-num {",
    "  width: 28px;",
    "  height: 28px;",
    "  border-radius: 50%;",
    "  display: flex;",
    "  align-items: center;",
    "  justify-content: center;",
    "  font-size: calc(0.75 * var(--rc-rem));",
    "  border: 2px solid var(--mist);",
    "  background: var(--white);",
    "  flex-shrink: 0;",
    "  font-weight: 600;",
    "}",
    "#reece-calculator .rc-stepper .rc-step.rc-active .rc-num { border-color: var(--deep-navy); background: var(--deep-navy); color: var(--white); }",
    "#reece-calculator .rc-stepper .rc-step.rc-done .rc-num { border-color: var(--cta-red); background: var(--cta-red); color: var(--white); }",
    "#reece-calculator .rc-stepper .rc-connector {",
    "  width: 30px;",
    "  height: 2px;",
    "  background: var(--mist);",
    "  align-self: center;",
    "}",
    "#reece-calculator .rc-stepper .rc-step.rc-done + .rc-connector { background: var(--cta-red); }",
    "@media (max-width: 600px) {",
    "  #reece-calculator .rc-stepper { gap: calc(0.15 * var(--rc-rem)); }",
    "  #reece-calculator .rc-stepper .rc-step { font-size: calc(0.72 * var(--rc-rem)); gap: calc(0.25 * var(--rc-rem)); }",
    "  #reece-calculator .rc-stepper .rc-connector { width: 16px; }",
    "}",
    "/* ===== CARDS ===== */",
    "#reece-calculator .rc-card {",
    "  background: var(--white);",
    "  border-radius: 0;",
    "  box-shadow: var(--shadow);",
    "  padding: calc(1.5 * var(--rc-rem));",
    "  margin-bottom: calc(1.25 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-card h2 {",
    "  font-size: calc(1.2 * var(--rc-rem));",
    "  font-weight: 700;",
    "  margin-bottom: calc(1 * var(--rc-rem));",
    "  padding-bottom: calc(0.6 * var(--rc-rem));",
    "  border-bottom: 2px solid var(--light-bg);",
    "  color: var(--deep-navy);",
    "}",
    "#reece-calculator .rc-card h3 {",
    "  font-size: calc(0.95 * var(--rc-rem));",
    "  font-weight: 700;",
    "  margin: calc(0.5 * var(--rc-rem)) 0 calc(0.5 * var(--rc-rem));",
    "  color: var(--deep-navy);",
    "}",
    "/* ===== FORM ELEMENTS ===== */",
    "#reece-calculator .rc-form-row {",
    "  display: grid;",
    "  grid-template-columns: 1fr 1fr;",
    "  gap: calc(1 * var(--rc-rem));",
    "  margin-bottom: calc(0.75 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-form-row.rc-three { grid-template-columns: 1fr 1fr 1fr; }",
    "#reece-calculator .rc-form-row.rc-full { grid-template-columns: 1fr; }",
    "#reece-calculator .rc-form-row.rc-four { grid-template-columns: 1fr 1fr 1fr 1fr; }",
    "@media (max-width: 600px) {",
    "  #reece-calculator .rc-form-row,",
    "  #reece-calculator .rc-form-row.rc-three,",
    "  #reece-calculator .rc-form-row.rc-four { grid-template-columns: 1fr; }",
    "}",
    "#reece-calculator .rc-field {",
    "  display: flex;",
    "  flex-direction: column;",
    "  /* A grid item defaults to min-width:auto, which refuses to shrink below",
    "     its content. An <input> with no width carries the browser's size=20",
    "     intrinsic width (~210px), so a two-column row demanded ~440px inside a",
    "     ~295px phone column and pushed the State field off the screen. */",
    "  min-width: 0;",
    "}",
    "#reece-calculator .rc-field label {",
    "  font-size: calc(0.82 * var(--rc-rem));",
    "  font-weight: 600;",
    "  margin-bottom: calc(0.3 * var(--rc-rem));",
    "  color: var(--deep-navy);",
    "}",
    "#reece-calculator .rc-field label .rc-hint {",
    "  font-weight: 400;",
    "  color: var(--text-gray);",
    "  font-size: calc(0.78 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-field select,",
    "#reece-calculator .rc-field input[type=\"number\"],",
    "#reece-calculator .rc-field input[type=\"text\"],",
    "#reece-calculator .rc-field input[type=\"tel\"],",
    "#reece-calculator .rc-field input[type=\"email\"] {",
    "  /* Fill the column instead of the size=20 intrinsic width. Without this",
    "     the field cannot shrink and overflows narrow columns. */",
    "  width: 100%;",
    "  min-width: 0;",
    "  max-width: 100%;",
    "  padding: calc(0.55 * var(--rc-rem)) calc(0.7 * var(--rc-rem));",
    "  border: 1.5px solid var(--mist);",
    "  border-radius: 0;",
    "  font-size: calc(0.9 * var(--rc-rem));",
    "  font-family: 'Nunito Sans', sans-serif;",
    "  color: var(--charcoal);",
    "  background: var(--white);",
    "  transition: border-color 0.2s;",
    "}",
    "#reece-calculator .rc-field select:focus,",
    "#reece-calculator .rc-field input:focus {",
    "  outline: none;",
    "  border-color: var(--steel-blue);",
    "  box-shadow: 0 0 0 3px rgba(100,136,160,0.15);",
    "}",
    "/* iOS Safari zooms the page whenever a focused field is under 16px, and it",
    "   never zooms back out. The standalone page hides the resulting overflow",
    "   with body{overflow-x:hidden}; the WordPress page has no such guard, so on",
    "   the main site the page is left zoomed and scrolled sideways. The selector",
    "   list has to match the base rule above or that rule's specificity wins. */",
    "@media (max-width: 600px) {",
    "  #reece-calculator .rc-field select,",
    "  #reece-calculator .rc-field input[type=\"number\"],",
    "  #reece-calculator .rc-field input[type=\"text\"],",
    "  #reece-calculator .rc-field input[type=\"tel\"],",
    "  #reece-calculator .rc-field input[type=\"email\"] {",
    "    font-size: calc(1 * var(--rc-rem));",
    "  }",
    "}",
    "#reece-calculator .rc-field-hint {",
    "  font-size: calc(0.75 * var(--rc-rem));",
    "  color: var(--text-gray);",
    "  margin-top: calc(0.2 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-reassurance-note {",
    "  font-size: calc(0.75 * var(--rc-rem));",
    "  color: var(--text-gray);",
    "  text-align: center;",
    "  margin-top: calc(1 * var(--rc-rem));",
    "  margin-bottom: calc(-0.5 * var(--rc-rem));",
    "}",
    "/* ===== TILE SELECTORS ===== */",
    "#reece-calculator .rc-tile-group {",
    "  display: grid;",
    "  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));",
    "  gap: calc(0.6 * var(--rc-rem));",
    "  margin-bottom: calc(0.75 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-style-section {",
    "  display: flex;",
    "  gap: calc(1.5 * var(--rc-rem));",
    "  align-items: start;",
    "  margin-bottom: calc(0.25 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-tile-grid-wrapper {",
    "  flex: 1;",
    "  min-width: 0;",
    "  display: grid;",
    "  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));",
    "  gap: calc(0.6 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-tile-grid-wrapper > .rc-tile-group {",
    "  display: contents;",
    "}",
    "#reece-calculator .rc-tile-grid-wrapper > h3 {",
    "  grid-column: 1 / -1;",
    "  margin: calc(0.25 * var(--rc-rem)) 0;",
    "}",
    "#reece-calculator .rc-style-section .rc-config-video {",
    "  width: 280px;",
    "  flex-shrink: 0;",
    "  max-width: 100%;",
    "}",
    "#reece-calculator .rc-tile {",
    "  border: 2px solid var(--mist);",
    "  border-radius: 0;",
    "  padding: calc(0.7 * var(--rc-rem)) calc(0.5 * var(--rc-rem));",
    "  text-align: center;",
    "  cursor: pointer;",
    "  transition: all 0.3s ease;",
    "  background: var(--white);",
    "  font-size: calc(0.82 * var(--rc-rem));",
    "  color: var(--charcoal);",
    "}",
    "#reece-calculator .rc-tile:hover { border-color: var(--steel-blue); background: #f0f5f8; }",
    "#reece-calculator .rc-tile.rc-selected { border-color: var(--deep-navy); background: var(--light-bg); font-weight: 600; color: var(--deep-navy); }",
    "#reece-calculator .rc-tile .rc-tile-icon { display: block; margin-bottom: calc(0.3 * var(--rc-rem)); line-height: 1; }",
    "#reece-calculator .rc-tile .rc-tile-icon svg { width: 56px; height: 56px; display: inline-block; }",
    "#reece-calculator .rc-tile .rc-tile-price { font-size: calc(0.72 * var(--rc-rem)); color: var(--text-gray); margin-top: calc(0.2 * var(--rc-rem)); display: block; }",
    "/* ===== CHECKBOX GROUP ===== */",
    "#reece-calculator .rc-check-group {",
    "  display: grid;",
    "  grid-template-columns: 1fr 1fr;",
    "  gap: calc(0.5 * var(--rc-rem));",
    "}",
    "@media (max-width: 600px) {",
    "  #reece-calculator .rc-check-group { grid-template-columns: 1fr; }",
    "}",
    "@media (max-width: 600px) {",
    "  #reece-calculator .rc-btn-row {",
    "    flex-direction: column;",
    "  }",
    "  #reece-calculator .rc-btn {",
    "    width: 100%;",
    "    padding: 12px calc(1 * var(--rc-rem));",
    "  }",
    "}",
    "#reece-calculator .rc-check-item {",
    "  display: flex;",
    "  align-items: flex-start;",
    "  gap: calc(0.5 * var(--rc-rem));",
    "  padding: calc(0.6 * var(--rc-rem));",
    "  border: 1.5px solid var(--mist);",
    "  border-radius: 0;",
    "  cursor: pointer;",
    "  transition: all 0.3s ease;",
    "  font-size: calc(0.85 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-check-item:hover { border-color: var(--steel-blue); }",
    "#reece-calculator .rc-check-item.rc-checked { border-color: var(--deep-navy); background: var(--light-bg); }",
    "#reece-calculator .rc-check-item input { margin-top: 2px; accent-color: var(--cta-red); }",
    "#reece-calculator .rc-check-item .rc-check-label { font-weight: 600; color: var(--deep-navy); }",
    "#reece-calculator .rc-check-item .rc-check-desc { font-size: calc(0.75 * var(--rc-rem)); color: var(--text-gray); }",
    "/* ===== SECTION VISIBILITY ===== */",
    "#reece-calculator .rc-section { display: none; }",
    "#reece-calculator .rc-section.rc-visible { display: block; }",
    "/* ===== BUTTONS ===== */",
    "#reece-calculator .rc-btn-row {",
    "  display: flex;",
    "  justify-content: space-between;",
    "  margin-top: calc(1.5 * var(--rc-rem));",
    "  gap: calc(0.75 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-btn {",
    "  padding: 12px 60px;",
    "  border: none;",
    "  border-radius: 0;",
    "  font-size: calc(0.9 * var(--rc-rem));",
    "  font-family: 'Nunito Sans', sans-serif;",
    "  font-weight: 600;",
    "  cursor: pointer;",
    "  transition: all 0.3s ease;",
    "  text-transform: uppercase;",
    "  letter-spacing: 0.5px;",
    "}",
    "#reece-calculator .rc-btn-primary { background: var(--cta-red); color: var(--white); }",
    "#reece-calculator .rc-btn-primary:hover { background: var(--deep-navy); }",
    "#reece-calculator .rc-btn-secondary { background: var(--deep-navy); color: var(--white); }",
    "#reece-calculator .rc-btn-secondary:hover { background: var(--steel-blue); }",
    "#reece-calculator .rc-btn-accent { background: var(--cta-red); color: var(--white); }",
    "#reece-calculator .rc-btn-accent:hover { background: var(--deep-navy); }",
    "#reece-calculator .rc-btn:disabled { opacity: 0.5; cursor: not-allowed; }",
    "/* ===== WINDOW LIST / CART ===== */",
    "#reece-calculator .rc-window-list { margin-top: calc(1 * var(--rc-rem)); }",
    "#reece-calculator .rc-cart-item {",
    "  padding: calc(0.8 * var(--rc-rem));",
    "  border: 1.5px solid var(--mist);",
    "  margin-bottom: calc(0.5 * var(--rc-rem));",
    "  background: var(--white);",
    "}",
    "#reece-calculator .rc-cart-item-header {",
    "  display: flex;",
    "  justify-content: space-between;",
    "  align-items: flex-start;",
    "  margin-bottom: calc(0.4 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-cart-item-title {",
    "  font-size: calc(0.88 * var(--rc-rem));",
    "  color: var(--deep-navy);",
    "  font-weight: 600;",
    "}",
    "#reece-calculator .rc-cart-item-title strong {",
    "  color: var(--cta-red);",
    "  margin-right: calc(0.3 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-cart-qty {",
    "  font-weight: 700;",
    "  color: var(--cta-red);",
    "  margin-left: calc(0.3 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-cart-item-details {",
    "  display: flex;",
    "  flex-wrap: wrap;",
    "  gap: calc(0.3 * var(--rc-rem));",
    "  margin-bottom: calc(0.4 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-cart-tag {",
    "  display: inline-block;",
    "  padding: calc(0.15 * var(--rc-rem)) calc(0.5 * var(--rc-rem));",
    "  background: var(--light-bg);",
    "  font-size: calc(0.75 * var(--rc-rem));",
    "  color: var(--charcoal);",
    "}",
    "#reece-calculator .rc-cart-tag-upgrade {",
    "  background: #e8f4e8;",
    "  color: #2e7d32;",
    "}",
    "#reece-calculator .rc-cart-tag-modifier {",
    "  background: #fff3e0;",
    "  color: #e65100;",
    "}",
    "#reece-calculator .rc-cart-item-cost {",
    "  font-size: calc(0.92 * var(--rc-rem));",
    "  font-weight: 700;",
    "  color: var(--deep-navy);",
    "  text-align: right;",
    "}",
    "#reece-calculator .rc-we-actions { display: flex; gap: calc(0.4 * var(--rc-rem)); }",
    "#reece-calculator .rc-btn-sm {",
    "  padding: calc(0.3 * var(--rc-rem)) calc(0.6 * var(--rc-rem));",
    "  font-size: calc(0.78 * var(--rc-rem));",
    "  border: none;",
    "  border-radius: 0;",
    "  cursor: pointer;",
    "  font-weight: 600;",
    "  font-family: 'Nunito Sans', sans-serif;",
    "  text-transform: uppercase;",
    "  letter-spacing: 0.3px;",
    "  transition: all 0.3s ease;",
    "}",
    "#reece-calculator .rc-btn-edit { background: var(--powder-blue); color: var(--deep-navy); }",
    "#reece-calculator .rc-btn-edit:hover { background: var(--steel-blue); color: var(--white); }",
    "#reece-calculator .rc-btn-delete { background: #fdecea; color: var(--deep-red); }",
    "#reece-calculator .rc-btn-delete:hover { background: var(--deep-red); color: var(--white); }",
    "/* ===== SUMMARY TABLE ===== */",
    "#reece-calculator .rc-summary-table {",
    "  width: 100%;",
    "  border-collapse: collapse;",
    "}",
    "#reece-calculator .rc-summary-table th,",
    "#reece-calculator .rc-summary-table td {",
    "  padding: calc(0.55 * var(--rc-rem)) calc(0.75 * var(--rc-rem));",
    "  text-align: left;",
    "  border-bottom: 1px solid var(--mist);",
    "  font-size: calc(0.88 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-summary-table th { background: var(--light-bg); font-weight: 700; color: var(--deep-navy); }",
    "#reece-calculator .rc-summary-table td:last-child { text-align: right; font-weight: 500; }",
    "#reece-calculator .rc-summary-table tr.rc-total td {",
    "  font-weight: 700;",
    "  font-size: calc(1 * var(--rc-rem));",
    "  border-top: 2px solid var(--deep-navy);",
    "  border-bottom: none;",
    "  color: var(--deep-navy);",
    "}",
    "#reece-calculator .rc-summary-table tr.rc-subtotal td {",
    "  font-weight: 600;",
    "  color: var(--dark-navy);",
    "}",
    "#reece-calculator .rc-summary-section { margin-bottom: calc(1.5 * var(--rc-rem)); }",
    "#reece-calculator .rc-summary-section h3 {",
    "  font-size: calc(0.9 * var(--rc-rem));",
    "  color: var(--deep-navy);",
    "  font-weight: 700;",
    "  margin-bottom: calc(0.5 * var(--rc-rem));",
    "}",
    "/* ===== STRUCTURED STARTING POINT ===== */",
    "#reece-calculator .rc-structured-starting-point {",
    "  padding-top: calc(1.5 * var(--rc-rem));",
    "  margin-top: 0;",
    "}",
    "#reece-calculator .rc-structured-starting-point h3 {",
    "  font-size: calc(1.05 * var(--rc-rem));",
    "  color: var(--deep-navy);",
    "  font-weight: 700;",
    "  margin-bottom: calc(0.6 * var(--rc-rem));",
    "}",
    "/* ===== SECTION DIVIDER ===== */",
    "#reece-calculator .rc-section-divider {",
    "  margin: calc(2.5 * var(--rc-rem)) 0;",
    "  border-top: 1px solid var(--mist);",
    "}",
    "/* ===== ESTIMATE HERO (Price Authority Block) ===== */",
    "#reece-calculator .rc-estimate-hero {",
    "  text-align: center;",
    "  padding: calc(1.25 * var(--rc-rem)) 0;",
    "  margin-bottom: calc(2 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-estimate-hero h3 {",
    "  font-size: calc(0.9 * var(--rc-rem));",
    "  font-weight: 700;",
    "  color: var(--deep-navy);",
    "  border-left: 3px solid var(--cta-red);",
    "  padding-left: calc(0.75 * var(--rc-rem));",
    "  margin-bottom: calc(0.75 * var(--rc-rem));",
    "  text-align: left;",
    "}",
    "#reece-calculator .rc-estimate-hero .rc-hero-price {",
    "  font-size: calc(2.5 * var(--rc-rem));",
    "  font-weight: 800;",
    "  color: var(--deep-navy);",
    "  margin: calc(0.25 * var(--rc-rem)) 0;",
    "}",
    "#reece-calculator .rc-estimate-hero .rc-hero-descriptor {",
    "  font-size: calc(0.85 * var(--rc-rem));",
    "  color: #3a3a3a;",
    "  letter-spacing: 0.3px;",
    "}",
    "#reece-calculator .rc-estimate-hero .rc-hero-credibility {",
    "  font-size: calc(0.75 * var(--rc-rem));",
    "  color: var(--charcoal);",
    "  letter-spacing: 0.5px;",
    "  margin-top: calc(0.15 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-estimate-hero .rc-hero-financing {",
    "  font-size: calc(0.72 * var(--rc-rem));",
    "  color: var(--text-gray);",
    "  margin-top: calc(0.35 * var(--rc-rem));",
    "  line-height: 1.4;",
    "}",
    "#reece-calculator .rc-estimate-hero .rc-hero-footnote {",
    "  font-size: calc(0.62 * var(--rc-rem));",
    "  margin-top: calc(0.15 * var(--rc-rem));",
    "}",
    "/* ===== MONTHLY PAYMENT (inside estimate-hero) ===== */",
    "#reece-calculator .rc-estimate-hero .rc-monthly-amount {",
    "  font-size: calc(1.8 * var(--rc-rem));",
    "  font-weight: 900;",
    "  color: #2e7d32;",
    "  line-height: 1.05;",
    "  margin: calc(0.4 * var(--rc-rem)) 0 0;",
    "}",
    "#reece-calculator .rc-estimate-hero .rc-monthly-sub {",
    "  font-size: calc(0.95 * var(--rc-rem));",
    "  font-weight: 700;",
    "  color: var(--deep-navy);",
    "  margin-top: calc(0.25 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-estimate-hero .rc-monthly-footnote {",
    "  font-size: calc(0.62 * var(--rc-rem));",
    "  color: var(--text-gray);",
    "  margin-top: calc(0.25 * var(--rc-rem));",
    "  line-height: 1.35;",
    "}",
    "/* Mobile tuning */",
    "@media (max-width: 600px) {",
    "  #reece-calculator .rc-estimate-hero .rc-monthly-amount { font-size: calc(1.5 * var(--rc-rem)); }",
    "  #reece-calculator .rc-estimate-hero .rc-monthly-sub { font-size: calc(0.9 * var(--rc-rem)); }",
    "}",
    "/* ===== ESTIMATE RANGE BLOCK ===== */",
    "#reece-calculator .rc-estimate-range {",
    "  text-align: center;",
    "  padding: calc(1 * var(--rc-rem)) 0;",
    "  margin-top: calc(0.75 * var(--rc-rem));",
    "  margin-bottom: calc(1.25 * var(--rc-rem));",
    "  border-top: 1px solid var(--mist);",
    "  border-bottom: 1px solid var(--mist);",
    "}",
    "#reece-calculator .rc-estimate-range .rc-range-label {",
    "  font-size: calc(0.8 * var(--rc-rem));",
    "  font-weight: 700;",
    "  color: var(--deep-navy);",
    "  margin-bottom: calc(0.25 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-estimate-range .rc-range-values {",
    "  font-size: calc(1.1 * var(--rc-rem));",
    "  font-weight: 700;",
    "  color: var(--deep-navy);",
    "  margin-bottom: calc(0.5 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-estimate-range p {",
    "  font-size: calc(0.82 * var(--rc-rem));",
    "  color: var(--charcoal);",
    "  margin: calc(0.25 * var(--rc-rem)) 0;",
    "  line-height: 1.5;",
    "}",
    "/* ===== PROJECT SUMMARY HEADER ===== */",
    "#reece-calculator .rc-project-summary-header {",
    "  font-size: calc(1 * var(--rc-rem));",
    "  font-weight: 700;",
    "  color: var(--deep-navy);",
    "  border-left: 3px solid var(--cta-red);",
    "  padding-left: calc(0.75 * var(--rc-rem));",
    "  margin: calc(1.25 * var(--rc-rem)) 0 calc(0.75 * var(--rc-rem)) 0;",
    "}",
    "/* ===== ROUTING SECTION ===== */",
    "#reece-calculator .rc-routing-section {",
    "  margin-bottom: calc(1.5 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-routing-section h3 {",
    "  font-size: calc(0.9 * var(--rc-rem));",
    "  color: var(--deep-navy);",
    "  font-weight: 700;",
    "  margin-bottom: calc(0.5 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-routing-section p {",
    "  font-size: calc(0.85 * var(--rc-rem));",
    "  color: var(--charcoal);",
    "  margin: calc(0.35 * var(--rc-rem)) 0;",
    "  line-height: 1.5;",
    "}",
    "#reece-calculator .rc-routing-section ul {",
    "  padding-left: calc(1.25 * var(--rc-rem));",
    "  margin: calc(0.35 * var(--rc-rem)) 0;",
    "}",
    "#reece-calculator .rc-routing-section li {",
    "  font-size: calc(0.85 * var(--rc-rem));",
    "  color: var(--charcoal);",
    "  line-height: 1.6;",
    "}",
    "/* ===== VERIFY CTA SECONDARY LINK ===== */",
    "#reece-calculator .rc-verify-secondary {",
    "  margin-top: calc(0.75 * var(--rc-rem));",
    "  text-align: center;",
    "}",
    "#reece-calculator .rc-verify-secondary a {",
    "  color: var(--steel-blue);",
    "  font-size: calc(0.85 * var(--rc-rem));",
    "  text-decoration: underline;",
    "}",
    "/* ===== DISCLAIMER ===== */",
    "#reece-calculator .rc-disclaimer {",
    "  background: var(--light-bg);",
    "  border-left: 4px solid var(--reece-red);",
    "  padding: calc(0.8 * var(--rc-rem)) calc(1 * var(--rc-rem));",
    "  font-size: calc(0.8 * var(--rc-rem));",
    "  color: var(--charcoal);",
    "  border-radius: 0;",
    "  margin-top: calc(1 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-disclaimer strong { color: var(--deep-navy); }",
    "/* ===== VERIFY CTA ===== */",
    "#reece-calculator .rc-verify-cta {",
    "  margin: calc(1.25 * var(--rc-rem)) 0;",
    "  padding: calc(1.25 * var(--rc-rem));",
    "  border-radius: 12px;",
    "  background: var(--white);",
    "  border: 1px solid rgba(0,0,0,0.08);",
    "}",
    "#reece-calculator .rc-verify-cta h3 {",
    "  margin-top: 0;",
    "  margin-bottom: calc(0.5 * var(--rc-rem));",
    "  color: var(--deep-navy);",
    "}",
    "#reece-calculator .rc-verify-cta p {",
    "  margin: calc(0.5 * var(--rc-rem)) 0;",
    "}",
    "#reece-calculator .rc-verify-cta ul {",
    "  margin: calc(0.5 * var(--rc-rem)) 0 calc(0.5 * var(--rc-rem)) calc(1.25 * var(--rc-rem));",
    "  padding: 0;",
    "}",
    "#reece-calculator .rc-verify-cta li {",
    "  margin: calc(0.25 * var(--rc-rem)) 0;",
    "  color: var(--text-gray);",
    "  font-size: calc(0.88 * var(--rc-rem));",
    "  line-height: 1.5;",
    "}",
    "#reece-calculator .rc-verify-micro {",
    "  margin-top: calc(0.75 * var(--rc-rem));",
    "  font-size: calc(0.9 * var(--rc-rem));",
    "  opacity: 0.8;",
    "}",
    "#reece-calculator .rc-cta-micro {",
    "  font-size: calc(0.8 * var(--rc-rem));",
    "  font-weight: 600;",
    "  color: var(--deep-navy);",
    "  margin-bottom: calc(0.4 * var(--rc-rem));",
    "  text-align: left;",
    "}",
    "#reece-calculator .rc-cta-subtext {",
    "  font-size: calc(0.75 * var(--rc-rem));",
    "  font-weight: 400;",
    "  color: var(--text-gray);",
    "  margin-top: calc(0.5 * var(--rc-rem));",
    "  text-align: left;",
    "}",
    "/* ===== HOW THIS WORKS ===== */",
    "#reece-calculator .rc-how-it-works {",
    "  background: var(--white);",
    "  box-shadow: var(--shadow);",
    "  padding: calc(1.25 * var(--rc-rem)) calc(1.5 * var(--rc-rem));",
    "  margin-bottom: calc(1.25 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-how-it-works h2 {",
    "  font-size: calc(1.1 * var(--rc-rem));",
    "  font-weight: 700;",
    "  color: var(--deep-navy);",
    "  margin-bottom: calc(0.75 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-how-steps {",
    "  list-style: none;",
    "  padding: 0;",
    "  margin: 0 0 calc(0.6 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-how-steps li {",
    "  display: flex;",
    "  align-items: center;",
    "  gap: calc(0.5 * var(--rc-rem));",
    "  font-size: calc(0.9 * var(--rc-rem));",
    "  color: var(--charcoal);",
    "  padding: calc(0.25 * var(--rc-rem)) 0;",
    "}",
    "#reece-calculator .rc-how-check {",
    "  color: var(--cta-red);",
    "  font-weight: 700;",
    "  font-size: calc(1 * var(--rc-rem));",
    "  flex-shrink: 0;",
    "}",
    "#reece-calculator .rc-how-tagline {",
    "  font-size: calc(0.85 * var(--rc-rem));",
    "  font-weight: 600;",
    "  color: var(--deep-navy);",
    "  font-style: italic;",
    "}",
    "/* ===== REASSURANCE NOTE ===== */",
    "#reece-calculator .rc-reassurance-note {",
    "  font-size: calc(0.78 * var(--rc-rem));",
    "  color: var(--text-gray);",
    "  line-height: 1.4;",
    "  margin-top: calc(1 * var(--rc-rem));",
    "  margin-bottom: 0;",
    "}",
    "/* ===== CONSENT CHECKBOX ===== */",
    "#reece-calculator .rc-consent-label {",
    "  display: flex;",
    "  align-items: flex-start;",
    "  gap: calc(0.5 * var(--rc-rem));",
    "  font-size: calc(0.75 * var(--rc-rem));",
    "  color: var(--text-gray);",
    "  line-height: 1.4;",
    "  cursor: pointer;",
    "}",
    "#reece-calculator .rc-consent-label input[type=\"checkbox\"] {",
    "  margin-top: calc(0.2 * var(--rc-rem));",
    "  flex-shrink: 0;",
    "  cursor: pointer;",
    "}",
    "/* .rc-consent-label sits inside .rc-field, where '#reece-calculator",
    "   .rc-field label' (1-1-1) outranks '#reece-calculator .rc-consent-label'",
    "   (1-1-0) and rendered this fine print as a bold navy form label. Match the",
    "   winning specificity to hand the disclaimer back its own typography. */",
    "#reece-calculator .rc-field label.rc-consent-label {",
    "  font-size: calc(0.75 * var(--rc-rem));",
    "  font-weight: 400;",
    "  color: var(--text-gray);",
    "}",
    "#reece-calculator .rc-field-error .rc-consent-label input[type=\"checkbox\"] {",
    "  outline: 2px solid var(--cta-red);",
    "  outline-offset: 1px;",
    "}",
    "/* ===== POLICY LINKS UNDER THE CONSENT BOX ===== */",
    "#reece-calculator .rc-consent-footer {",
    "  font-size: calc(0.72 * var(--rc-rem));",
    "  color: var(--text-gray);",
    "  line-height: 1.4;",
    "  margin: calc(0.5 * var(--rc-rem)) 0 0;",
    "}",
    "/* Colour both states explicitly. Left to the browser, a visited policy link",
    "   renders in the default purple, which is off-brand for Reece. */",
    "#reece-calculator .rc-consent-footer a,",
    "#reece-calculator .rc-consent-footer a:visited {",
    "  color: var(--text-gray);",
    "  text-decoration: underline;",
    "}",
    "/* ===== PRICING STABILITY NOTE ===== */",
    "#reece-calculator .rc-pricing-stability-note {",
    "  background: var(--light-bg);",
    "  padding: calc(0.8 * var(--rc-rem)) calc(1 * var(--rc-rem));",
    "  font-size: calc(0.85 * var(--rc-rem));",
    "  color: var(--charcoal);",
    "  line-height: 1.5;",
    "  margin-top: calc(1 * var(--rc-rem));",
    "  border-left: 4px solid var(--steel-blue);",
    "}",
    "/* ===== PRINT BUTTON ===== */",
    "#reece-calculator .rc-btn-print { background: transparent; color: var(--dark-navy); border: 1.5px solid var(--mist); }",
    "#reece-calculator .rc-btn-print:hover { background: var(--light-bg); color: var(--deep-navy); }",
    "/* printRoot is invisible on-screen */",
    "#reece-calculator #rc-print-root { display: none; }",
    "@media print {",
    "  /* ===== PAGE SETUP ===== */",
    "  @page { size: letter; margin: 0.5in 0.7in 0.6in 0.7in; }",
    "  #reece-calculator, #reece-calculator *, #reece-calculator *::before, #reece-calculator *::after {",
    "    -webkit-print-color-adjust: exact !important;",
    "    print-color-adjust: exact !important;",
    "    color-adjust: exact !important;",
    "  }",
    "  #reece-calculator { background: #fff !important; font-size: 11pt; color: #333; }",
    "  /* ===== HIDE UI CHROME & INTERACTIVE ELEMENTS ONLY ===== */",
    "  #reece-calculator .rc-stepper,",
    "  #reece-calculator .rc-btn-row,",
    "  #reece-calculator .rc-btn-print,",
    "  #reece-calculator .rc-btn,",
    "  #reece-calculator #rc-section-1,",
    "  #reece-calculator #rc-section-2,",
    "  #reece-calculator #rc-section-3,",
    "  #reece-calculator .rc-config-video,",
    "  #reece-calculator .rc-how-it-works,",
    "  #reece-calculator .rc-verify-cta,",
    "  #reece-calculator .rc-verify-secondary,",
    "  #reece-calculator .rc-pricing-stability-note,",
    "  #reece-calculator #rc-print-root { display: none !important; }",
    "  /* Hide all sections, then show only Step 4 */",
    "  #reece-calculator .rc-section { display: none !important; }",
    "  #reece-calculator #rc-section-4 { display: block !important; }",
    "  /* ===== CONTAINER & CARD ===== */",
    "  #reece-calculator .rc-container { max-width: 100%; padding: 0 !important; margin: 0; }",
    "  #reece-calculator .rc-card {",
    "    box-shadow: none !important; padding: 0 !important;",
    "    margin-bottom: 0 !important; border: none !important;",
    "  }",
    "  #reece-calculator .rc-card h2 {",
    "    font-size: 14pt; color: #0D2240 !important;",
    "    border-bottom: 2pt solid #ED1F24 !important;",
    "    padding-bottom: 4pt; margin-bottom: 10pt;",
    "  }",
    "  /* ===== SUMMARY SECTIONS ===== */",
    "  #reece-calculator .rc-summary-section { margin-bottom: 0.08in !important; page-break-inside: auto; }",
    "  #reece-calculator .rc-summary-section h3 {",
    "    font-size: 11pt; color: #0D2240 !important; font-weight: 700;",
    "    margin-bottom: 4pt; padding: 3pt 6pt;",
    "    background: #F2F3F7 !important; border-left: 3pt solid #ED1F24 !important;",
    "  }",
    "  /* ===== SUMMARY TABLES ===== */",
    "  #reece-calculator .rc-summary-table { width: 100%; border-collapse: collapse; table-layout: fixed; overflow-wrap: break-word; }",
    "  #reece-calculator .rc-summary-table thead { display: table-header-group; }",
    "  #reece-calculator .rc-summary-table th {",
    "    background: #0D2240 !important; color: #fff !important;",
    "    font-size: 9pt; font-weight: 600; padding: 5pt 8pt; text-align: left; border: none;",
    "  }",
    "  #reece-calculator .rc-summary-table td {",
    "    padding: 4pt 8pt; font-size: 9.5pt;",
    "    border-bottom: 0.5pt solid #C1D5DB !important; color: #333;",
    "  }",
    "  #reece-calculator .rc-summary-table td:last-child { text-align: right; font-weight: 500; }",
    "  #reece-calculator .rc-summary-table tr { break-inside: avoid; page-break-inside: avoid; }",
    "  #reece-calculator .rc-summary-table tr.rc-total td {",
    "    font-weight: 700; font-size: 11pt; color: #0D2240 !important;",
    "    border-top: 2pt solid #0D2240 !important; border-bottom: none; padding-top: 6pt;",
    "  }",
    "  #reece-calculator .rc-summary-table tr.rc-subtotal td { font-weight: 600; color: #122738 !important; }",
    "  /* ===== ROUTING SECTION ===== */",
    "  #reece-calculator .rc-routing-section { margin-bottom: 0.1in !important; page-break-inside: avoid; }",
    "  #reece-calculator .rc-routing-section h3 { font-size: 11pt; color: #0D2240 !important; font-weight: 700; margin-bottom: 3pt; }",
    "  #reece-calculator .rc-routing-section p { font-size: 10.5pt; color: #636060; line-height: 1.4; margin-bottom: 2pt; }",
    "  #reece-calculator .rc-routing-section ul { padding-left: 16pt; margin: 2pt 0 4pt 0; }",
    "  #reece-calculator .rc-routing-section li { font-size: 10.5pt; color: #636060; line-height: 1.4; }",
    "  /* ===== DISCLAIMER ===== */",
    "  #reece-calculator .rc-disclaimer {",
    "    background: #F2F3F7 !important; border-left: 3pt solid #ED1F24 !important;",
    "    padding: 8pt 10pt !important; font-size: 8pt; color: #636060 !important;",
    "    margin-top: 0.15in; page-break-inside: avoid;",
    "  }",
    "  #reece-calculator .rc-disclaimer strong { color: #0D2240 !important; }",
    "  /* ===== ESTIMATE HERO — COMPACT FOR PAGE 1 ===== */",
    "  #reece-calculator .rc-estimate-hero {",
    "    padding: 4pt 0 2pt 0 !important;",
    "    margin-bottom: 2pt !important;",
    "    text-align: center;",
    "  }",
    "  #reece-calculator .rc-estimate-hero h3 { font-size: 10pt !important; margin-bottom: 2pt !important; padding: 2pt 6pt !important; }",
    "  #reece-calculator .rc-estimate-hero .rc-hero-price { font-size: 20pt !important; margin: 1pt 0 !important; }",
    "  #reece-calculator .rc-estimate-hero .rc-hero-descriptor { font-size: 8.5pt !important; margin: 1pt 0 !important; }",
    "  #reece-calculator .rc-estimate-hero .rc-hero-credibility { font-size: 8pt !important; margin: 0 !important; }",
    "  #reece-calculator .rc-estimate-hero .rc-monthly-amount { font-size: 12pt !important; margin: 2pt 0 0 !important; }",
    "  #reece-calculator .rc-estimate-hero .rc-monthly-sub { font-size: 8.5pt !important; margin: 1pt 0 !important; }",
    "  #reece-calculator .rc-estimate-hero .rc-monthly-footnote { font-size: 7pt !important; margin: 1pt 0 0 !important; }",
    "  /* ===== SECTION DIVIDER — MINIMAL ===== */",
    "  #reece-calculator .rc-section-divider { margin: 4pt 0 !important; }",
    "  /* ===== STRUCTURED STARTING POINT — COMPACT ===== */",
    "  #reece-calculator .rc-structured-starting-point { padding-top: 4pt !important; margin-top: 0 !important; margin-bottom: 6pt !important; }",
    "  #reece-calculator .rc-structured-starting-point h3 { font-size: 10pt !important; margin-bottom: 2pt !important; }",
    "  #reece-calculator .rc-structured-starting-point p { font-size: 8.5pt !important; line-height: 1.3 !important; margin-bottom: 2pt !important; }",
    "  #reece-calculator .rc-structured-starting-point ul { margin: 1pt 0 3pt 0 !important; }",
    "  #reece-calculator .rc-structured-starting-point li { font-size: 8.5pt !important; line-height: 1.35 !important; }",
    "  /* ===== PROJECT SUMMARY HEADER — TIGHTEN ===== */",
    "  #reece-calculator .rc-project-summary-header { font-size: 11pt !important; margin: 6pt 0 4pt 0 !important; }",
    "  /* ===== ESTIMATE RANGE — TIGHTEN FOR PAGE 1 FIT ===== */",
    "  #reece-calculator .rc-estimate-range { padding: 6pt 0 !important; margin-top: 4pt !important; margin-bottom: 4pt !important; }",
    "  #reece-calculator .rc-estimate-range p { margin: 1pt 0 !important; font-size: 9pt; line-height: 1.3; }",
    "  #reece-calculator .rc-estimate-range .rc-range-label { font-size: 9pt !important; margin-bottom: 1pt !important; }",
    "  #reece-calculator .rc-estimate-range .rc-range-values { font-size: 12pt !important; margin-bottom: 3pt !important; }",
    "  /* ===== LEFT/RIGHT PADDING ON CONTENT ===== */",
    "  #reece-calculator #rc-section-4 { padding: 0 0.15in !important; }",
    "  /* ===== PAGE BREAKS ===== */",
    "  #reece-calculator #rc-print-break-itemized {",
    "    page-break-before: always !important;",
    "    padding-top: 0.3in !important;",
    "  }",
    "  #reece-calculator #rc-print-break-costs {",
    "    page-break-before: always !important;",
    "    padding-top: 0.3in !important;",
    "  }",
    "}",
    "/* ===== INFO TOOLTIP ===== */",
    "#reece-calculator .rc-info-tip {",
    "  display: inline-block;",
    "  width: 16px;",
    "  height: 16px;",
    "  border-radius: 50%;",
    "  background: var(--mist);",
    "  color: var(--deep-navy);",
    "  font-size: calc(0.68 * var(--rc-rem));",
    "  text-align: center;",
    "  line-height: 16px;",
    "  cursor: help;",
    "  margin-left: 4px;",
    "  position: relative;",
    "  vertical-align: middle;",
    "  font-weight: 700;",
    "}",
    "#reece-calculator .rc-info-tip:hover::after {",
    "  content: attr(data-tip);",
    "  position: absolute;",
    "  bottom: 120%;",
    "  left: 50%;",
    "  transform: translateX(-50%);",
    "  background: var(--dark-navy);",
    "  color: var(--white);",
    "  padding: calc(0.5 * var(--rc-rem)) calc(0.7 * var(--rc-rem));",
    "  border-radius: 0;",
    "  font-size: calc(0.75 * var(--rc-rem));",
    "  white-space: normal;",
    "  width: 220px;",
    "  text-align: left;",
    "  font-weight: 400;",
    "  z-index: 999;",
    "  line-height: 1.4;",
    "}",
    "/* ===== QUANTITY STEPPER ===== */",
    "#reece-calculator .rc-qty-control {",
    "  display: flex;",
    "  align-items: center;",
    "  gap: calc(0.3 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-qty-control button {",
    "  width: 30px;",
    "  height: 30px;",
    "  border: 1.5px solid var(--mist);",
    "  border-radius: 0;",
    "  background: var(--white);",
    "  font-size: calc(1.1 * var(--rc-rem));",
    "  cursor: pointer;",
    "  display: flex;",
    "  align-items: center;",
    "  justify-content: center;",
    "  color: var(--deep-navy);",
    "  font-weight: 700;",
    "  transition: all 0.3s ease;",
    "}",
    "#reece-calculator .rc-qty-control button:hover { background: var(--light-bg); border-color: var(--steel-blue); }",
    "#reece-calculator .rc-qty-control input {",
    "  width: 50px;",
    "  text-align: center;",
    "  padding: calc(0.35 * var(--rc-rem));",
    "  border: 1.5px solid var(--mist);",
    "  border-radius: 0;",
    "  font-size: calc(0.9 * var(--rc-rem));",
    "  font-family: 'Nunito Sans', sans-serif;",
    "}",
    "#reece-calculator .rc-empty-state {",
    "  text-align: center;",
    "  padding: calc(2 * var(--rc-rem));",
    "  color: var(--text-gray);",
    "  font-size: calc(0.9 * var(--rc-rem));",
    "}",
    "/* ===== DIMENSION ROW ===== */",
    "#reece-calculator .rc-dim-row {",
    "  display: flex;",
    "  align-items: end;",
    "  gap: calc(0.5 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-dim-row .rc-field { flex: 1; }",
    "#reece-calculator .rc-dim-row .rc-dim-x { font-size: calc(1.1 * var(--rc-rem)); font-weight: 600; align-self: center; padding-top: calc(1.2 * var(--rc-rem)); color: var(--text-gray); }",
    "/* ===== CUSTOM SIZE BADGE ===== */",
    "#reece-calculator .rc-custom-size-badge { color: var(--reece-red); font-size: calc(0.75 * var(--rc-rem)); }",
    "/* ===== SUCCESS COLOR ===== */",
    "#reece-calculator .rc-text-success { color: var(--cta-red); }",
    "/* ===== VALIDATION ===== */",
    "#reece-calculator .rc-field-error input,",
    "#reece-calculator .rc-field-error select {",
    "  border-color: var(--cta-red) !important;",
    "}",
    "#reece-calculator .rc-field-error-msg {",
    "  color: var(--cta-red);",
    "  font-size: calc(0.75 * var(--rc-rem));",
    "  margin-top: calc(0.2 * var(--rc-rem));",
    "  display: none;",
    "}",
    "#reece-calculator .rc-field-error .rc-field-error-msg {",
    "  display: block;",
    "}",
    "/* ===== LOCKED INSTALL TYPE ===== */",
    "#reece-calculator .rc-install-type-display {",
    "  padding: calc(0.55 * var(--rc-rem)) calc(0.7 * var(--rc-rem));",
    "  background: var(--light-bg);",
    "  border: 1.5px solid var(--mist);",
    "  font-size: calc(0.9 * var(--rc-rem));",
    "  color: var(--deep-navy);",
    "  font-weight: 600;",
    "}",
    "/* ===== CONFIG LAYOUT (VIDEO BESIDE FORM IN GREY AREA) ===== */",
    "#reece-calculator .rc-config-layout {",
    "  display: block;",
    "}",
    "#reece-calculator .rc-config-form {",
    "  min-width: 0;",
    "}",
    "#reece-calculator .rc-config-video {",
    "  padding-top: 0;",
    "  transition: width 0.3s ease, margin 0.3s ease;",
    "}",
    "#reece-calculator .rc-config-video video {",
    "  width: 100%;",
    "  display: block;",
    "  border: 2px solid var(--mist);",
    "  background: #000;",
    "  box-shadow: var(--shadow);",
    "}",
    "#reece-calculator .rc-video-caption {",
    "  font-size: calc(0.78 * var(--rc-rem));",
    "  color: var(--text-gray);",
    "  text-align: center;",
    "  margin-top: calc(0.5 * var(--rc-rem));",
    "  font-weight: 600;",
    "}",
    "@media (max-width: 900px) {",
    "  #reece-calculator .rc-card--config {",
    "    display: flex;",
    "    flex-direction: column;",
    "  }",
    "  #reece-calculator .rc-style-section {",
    "    display: contents;",
    "  }",
    "  #reece-calculator .rc-config-video {",
    "    order: -1;",
    "    width: 100%;",
    "    max-width: 100%;",
    "    margin: 0 auto calc(1 * var(--rc-rem));",
    "    padding: 0;",
    "    position: static;",
    "    box-sizing: border-box;",
    "  }",
    "  #reece-calculator .rc-tile-grid-wrapper {",
    "    grid-template-columns: repeat(3, 1fr);",
    "    gap: calc(0.5 * var(--rc-rem));",
    "  }",
    "  #reece-calculator .rc-tile .rc-tile-icon svg {",
    "    width: 40px;",
    "    height: 40px;",
    "  }",
    "  #reece-calculator .rc-tile {",
    "    padding: calc(0.5 * var(--rc-rem)) calc(0.3 * var(--rc-rem));",
    "    font-size: calc(0.75 * var(--rc-rem));",
    "  }",
    "}",
    "@media (max-width: 480px) {",
    "  #reece-calculator .rc-tile-grid-wrapper {",
    "    grid-template-columns: repeat(2, 1fr);",
    "  }",
    "}",
    "/* ===== CONTACT STEP ===== */",
    "#reece-calculator .rc-contact-note {",
    "  font-size: calc(0.88 * var(--rc-rem));",
    "  color: var(--charcoal);",
    "  margin-bottom: calc(1.25 * var(--rc-rem));",
    "  line-height: 1.5;",
    "}",
    "@media (max-width: 600px) {",
    "  #reece-calculator .rc-form-row.rc-four { grid-template-columns: 1fr 1fr; }",
    "}",
    "/* ===== STICKY MOBILE CTA ===== */",
    "#reece-calculator .rc-sticky-cta { display: none; }",
    "@media (max-width: 768px) {",
    "  #reece-calculator .rc-sticky-cta.rc-visible {",
    "    display: block;",
    "    position: fixed;",
    "    bottom: 0;",
    "    left: 0;",
    "    width: 100%;",
    "    background: var(--cta-red);",
    "    color: #FFFFFF;",
    "    padding: calc(1 * var(--rc-rem));",
    "    text-align: center;",
    "    font-weight: 700;",
    "    font-size: calc(1 * var(--rc-rem));",
    "    z-index: 1000;",
    "    border: none;",
    "    cursor: pointer;",
    "    box-shadow: 0 -2px 8px rgba(0,0,0,0.15);",
    "  }",
    "  #reece-calculator.rc-step-4-active { padding-bottom: calc(3.5 * var(--rc-rem)); }",
    "}",
    "/* ===== KEEP-ESTIMATE MODAL ===== */",
    "#reece-calculator .rc-modal-overlay {",
    "  display: none;",
    "  position: fixed;",
    "  top: 0;",
    "  left: 0;",
    "  width: 100%;",
    "  height: 100%;",
    "  background: rgba(0, 0, 0, 0.55);",
    "  z-index: 10000;",
    "  justify-content: center;",
    "  align-items: center;",
    "}",
    "#reece-calculator .rc-modal-overlay.rc-active {",
    "  display: flex;",
    "}",
    "#reece-calculator .rc-modal-dialog {",
    "  background: var(--white);",
    "  border-radius: 12px;",
    "  padding: calc(2 * var(--rc-rem)) calc(1.75 * var(--rc-rem));",
    "  max-width: 420px;",
    "  width: 90%;",
    "  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);",
    "  text-align: center;",
    "  animation: rc-modalFadeIn 0.2s ease;",
    "}",
    "@keyframes rc-modalFadeIn {",
    "  from { opacity: 0; transform: translateY(-16px); }",
    "  to { opacity: 1; transform: translateY(0); }",
    "}",
    "#reece-calculator .rc-modal-dialog h3 {",
    "  color: var(--deep-navy);",
    "  font-size: calc(1.2 * var(--rc-rem));",
    "  font-weight: 700;",
    "  margin-bottom: calc(0.75 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-modal-dialog p {",
    "  color: var(--charcoal);",
    "  font-size: calc(0.9 * var(--rc-rem));",
    "  line-height: 1.6;",
    "  margin-bottom: calc(1.25 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-modal-dialog .rc-btn {",
    "  display: block;",
    "  width: 100%;",
    "  margin-bottom: calc(0.5 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-modal-dialog .rc-btn-link {",
    "  background: none;",
    "  border: none;",
    "  color: var(--steel-blue);",
    "  font-size: calc(0.85 * var(--rc-rem));",
    "  text-decoration: underline;",
    "  cursor: pointer;",
    "  padding: calc(0.5 * var(--rc-rem));",
    "  display: block;",
    "  width: 100%;",
    "}",
    "/* ===== EMAIL VERIFICATION MODAL ===== */",
    "#reece-calculator .rc-verify-code-input {",
    "  width: 100%;",
    "  padding: calc(0.85 * var(--rc-rem)) calc(0.7 * var(--rc-rem));",
    "  border: 2px solid var(--mist);",
    "  border-radius: 0;",
    "  font-size: calc(1.5 * var(--rc-rem));",
    "  font-family: 'Courier New', monospace;",
    "  font-weight: 700;",
    "  text-align: center;",
    "  letter-spacing: calc(0.5 * var(--rc-rem));",
    "  color: var(--deep-navy);",
    "  background: var(--white);",
    "  margin-bottom: calc(0.5 * var(--rc-rem));",
    "}",
    "#reece-calculator .rc-verify-code-input:focus {",
    "  outline: none;",
    "  border-color: var(--steel-blue);",
    "  box-shadow: 0 0 0 3px rgba(100,136,160,0.15);",
    "}",
    "#reece-calculator .rc-verify-code-input.rc-field-error {",
    "  border-color: var(--cta-red);",
    "}",
    "#reece-calculator .rc-verify-spam-note {",
    "  font-size: calc(0.78 * var(--rc-rem));",
    "  color: var(--text-gray);",
    "  margin-bottom: calc(1 * var(--rc-rem));",
    "  font-style: italic;",
    "}",
    "#reece-calculator .rc-verify-error-msg {",
    "  color: var(--cta-red);",
    "  font-size: calc(0.82 * var(--rc-rem));",
    "  font-weight: 600;",
    "  margin-top: calc(0.25 * var(--rc-rem));",
    "  margin-bottom: calc(0.75 * var(--rc-rem));",
    "  display: none;",
    "}",
    "#reece-calculator .rc-verify-error-msg.rc-visible {",
    "  display: block;",
    "}",
    "#reece-calculator .rc-verify-success-msg {",
    "  color: #2e7d32;",
    "  font-size: calc(0.82 * var(--rc-rem));",
    "  font-weight: 600;",
    "  margin-top: calc(0.25 * var(--rc-rem));",
    "  margin-bottom: calc(0.75 * var(--rc-rem));",
    "  display: none;",
    "}",
    "#reece-calculator .rc-verify-success-msg.rc-visible {",
    "  display: block;",
    "}",
    "#reece-calculator .rc-modal-dialog .rc-btn-resend {",
    "  background: var(--white);",
    "  color: var(--deep-navy);",
    "  border: 1.5px solid var(--mist);",
    "}",
    "#reece-calculator .rc-modal-dialog .rc-btn-resend:hover:not(:disabled) {",
    "  background: var(--light-bg);",
    "  border-color: var(--steel-blue);",
    "}",
    "#reece-calculator .rc-modal-dialog .rc-btn-resend:disabled {",
    "  opacity: 0.5;",
    "  cursor: not-allowed;",
    "}",
    "#reece-calculator .rc-verify-email-display {",
    "  font-weight: 700;",
    "  color: var(--deep-navy);",
    "  word-break: break-all;",
    "}",
    "/* =============================================================",
    "   MAIN-DOMAIN EMBED",
    "   .rc-embed is added to the mount at mount() time when PAGE_VARIANT",
    "   is 'main-domain'. Everything below is scoped to that class, so the",
    "   standalone page keeps its full-page treatment untouched. Screen only:",
    "   the print sheet already reshapes the estimate for letter paper and must",
    "   keep doing so on both pages.",
    "   ============================================================= */",
    "@media screen {",
    "/* The grey ground is right when the calculator IS the page. Inside a",
    "   white WordPress article it reads as a grey box bolted onto the page. */",
    "#reece-calculator.rc-embed {",
    "  background: transparent;",
    "}",
    "/* The 960px well plus 15px gutters was set for a page the calculator owns.",
    "   Inside the theme column the gutters are already there, so the container",
    "   drops its own and takes a readable cap instead — the cap goes on the",
    "   container, not on .rc-card, so the intro band, the reassurance note and",
    "   the button rows (all siblings of the cards) line up with them. Narrower",
    "   columns are unaffected: the cap only bites above 880px. */",
    "#reece-calculator.rc-embed .rc-container {",
    "  max-width: 880px;",
    "  padding-left: 0;",
    "  padding-right: 0;",
    "}",
    "/* The theme drops the calculator into a Bootstrap .col-10 (81.25%), which",
    "   costs a phone about a quarter of its screen before the form starts. 50%",
    "   resolves against that column and 50vw against the viewport, so this",
    "   cancels the inset exactly, whatever width the theme column happens to be.",
    "   The container gutters zeroed above have to come back with it: once the",
    "   calculator leaves the column, nothing else supplies its side padding.",
    "   Phones only — tablets keep the column. */",
    "@media (max-width: 600px) {",
    "  #reece-calculator.rc-embed {",
    "    margin-left: calc(50% - 50vw);",
    "    margin-right: calc(50% - 50vw);",
    "  }",
    "  #reece-calculator.rc-embed .rc-container {",
    "    padding-left: calc(1 * var(--rc-rem));",
    "    padding-right: calc(1 * var(--rc-rem));",
    "  }",
    "}",
    "/* With no grey ground behind them, white cards on a white page need an",
    "   edge of their own. */",
    "#reece-calculator.rc-embed .rc-card {",
    "  border: 1px solid #E3E6EE;",
    "  border-radius: 12px;",
    "  box-shadow: 0 4px 20px rgba(11,31,58,0.06);",
    "}",
    "}"
  ].join('\n');

  // ==========================================================================
  //  MARKUP
  // ==========================================================================
  var HTML = [
    "  <div class=\"rc-container\">",
    "    <!-- Stepper — 4 Steps -->",
    "    <div class=\"rc-stepper\" id=\"rc-stepper\">",
    "      <div class=\"rc-step rc-active\" data-step=\"1\"><span class=\"rc-num\">1</span> Home Details</div>",
    "      <div class=\"rc-connector\"></div>",
    "      <div class=\"rc-step\" data-step=\"2\"><span class=\"rc-num\">2</span> Window Selection</div>",
    "      <div class=\"rc-connector\"></div>",
    "      <div class=\"rc-step\" data-step=\"3\"><span class=\"rc-num\">3</span> Get Pricing</div>",
    "      <div class=\"rc-connector\"></div>",
    "      <div class=\"rc-step\" data-step=\"4\"><span class=\"rc-num\">4</span> Your Estimate</div>",
    "    </div>",
    "    <!-- HOW THIS WORKS -->",
    "    <div class=\"rc-how-it-works\" id=\"rc-how-it-works\">",
    "      <h2>How This Works</h2>",
    "      <ul class=\"rc-how-steps\">",
    "        <li><span class=\"rc-how-check\">&#10003;</span> Enter your project details</li>",
    "        <li><span class=\"rc-how-check\">&#10003;</span> Select your window types</li>",
    "        <li><span class=\"rc-how-check\">&#10003;</span> Instantly see your estimated investment range</li>",
    "        <li><span class=\"rc-how-check\">&#10003;</span> Decide if you'd like to explore next steps</li>",
    "      </ul>",
    "      <p class=\"rc-how-tagline\">No appointment. No pressure. Just clarity.</p>",
    "    </div>",
    "    <!-- ========== STEP 1: PROJECT DETAILS ========== -->",
    "    <div class=\"rc-section rc-visible\" id=\"rc-section-1\">",
    "      <div class=\"rc-card\">",
    "        <h2>Step 1: Tell Us About Your Home</h2>",
    "        <div class=\"rc-form-row rc-full\">",
    "          <div class=\"rc-field\" id=\"rc-field-full-name\">",
    "            <label>Name <span style=\"color:var(--cta-red);\">*</span></label>",
    "            <input type=\"text\" id=\"rc-full-name\" placeholder=\"Name\">",
    "            <div class=\"rc-field-error-msg\">Name is required.</div>",
    "          </div>",
    "        </div>",
    "        <div class=\"rc-form-row rc-full\">",
    "          <div class=\"rc-field\" id=\"rc-field-street-address\">",
    "            <label>Street Address <span style=\"color:var(--cta-red);\">*</span></label>",
    "            <input type=\"text\" id=\"rc-street-address\" placeholder=\"Start typing your address...\">",
    "            <div class=\"rc-field-error-msg\">Street address is required.</div>",
    "          </div>",
    "        </div>",
    "        <div class=\"rc-form-row rc-four\">",
    "          <div class=\"rc-field\" id=\"rc-field-city\">",
    "            <label>City <span style=\"color:var(--cta-red);\">*</span></label>",
    "            <input type=\"text\" id=\"rc-city\" placeholder=\"City\">",
    "            <div class=\"rc-field-error-msg\">City is required.</div>",
    "          </div>",
    "          <div class=\"rc-field\" id=\"rc-field-state\">",
    "            <label>State <span style=\"color:var(--cta-red);\">*</span></label>",
    "            <input type=\"text\" id=\"rc-state\" placeholder=\"FL\">",
    "            <div class=\"rc-field-error-msg\">State is required.</div>",
    "          </div>",
    "          <div class=\"rc-field\" id=\"rc-field-postal-code\">",
    "            <label>Postal Code <span style=\"color:var(--cta-red);\">*</span></label>",
    "            <input type=\"text\" id=\"rc-postal-code\" placeholder=\"33601\">",
    "            <div class=\"rc-field-error-msg\">Postal code is required.</div>",
    "          </div>",
    "        </div>",
    "        <div class=\"rc-form-row rc-full\">",
    "          <div class=\"rc-field\" id=\"rc-field-phone\">",
    "            <label>Phone Number <span style=\"color:var(--cta-red);\">*</span></label>",
    "            <input type=\"tel\" id=\"rc-phone\" placeholder=\"(555) 555-5555\" inputmode=\"numeric\">",
    "            <div class=\"rc-field-error-msg\">A valid 10-digit phone number is required.</div>",
    "            <p class=\"rc-field-hint\">We'll text your estimate to this number.</p>",
    "          </div>",
    "        </div>",
    "        <div class=\"rc-form-row rc-full\">",
    "          <div class=\"rc-field\" id=\"rc-field-consent\">",
    "            <label class=\"rc-consent-label\">",
    "              <input type=\"checkbox\" id=\"rc-consent-checkbox\">",
    "              <span>By checking this box, I agree to receive SMS messages from Reece Windows &amp; Doors at the number I entered above, including appointment reminders, account notifications, and promotional offers. Msg frequency varies. Msg &amp; data rates may apply. Reply HELP for help, STOP to opt out.<br><br>I also agree by electronic signature to be contacted by Reece Windows &amp; Doors at that number through a live agent, AI generative voice, artificial or prerecorded voice, and automated technology, including calls dialed manually or by auto dialer, and by email. I understand I am not required to sign or agree to this as a condition of purchase.</span>",
    "            </label>",
    "            <div class=\"rc-field-error-msg\">You must agree to the consent terms to continue.</div>",
    // The policy links sit OUTSIDE .rc-consent-label deliberately: a link inside
    // the <label> that wraps the checkbox toggles that checkbox on click, so a
    // lead reading the policy would silently flip their own consent.
    //
    // Both hrefs are GHL URL redirects, not the policy pages themselves. They
    // resolve to link.reecewindows.com/r/2/<token>, which is what puts the click
    // in GHL trigger-link reporting and lets the destination move without a
    // deploy. Never "simplify" these to the direct policy URLs.
    "            <p class=\"rc-consent-footer\">By submitting this form you agree to our <a href=\"https://landing.reecewindows.com/privacy\" id=\"rc-link-privacy\" target=\"_blank\" rel=\"noopener\">Privacy Policy</a> &amp; <a href=\"https://landing.reecewindows.com/terms\" id=\"rc-link-terms\" target=\"_blank\" rel=\"noopener\">Terms &amp; Conditions</a>.</p>",
    "          </div>",
    "        </div>",
    "      </div>",
    "      <div class=\"rc-card\">",
    "        <h2>Project Details</h2>",
    "        <div class=\"rc-form-row\">",
    "          <div class=\"rc-field\">",
    "            <label>Installation Type</label>",
    "            <div class=\"rc-install-type-display\">Full-Frame Replacement</div>",
    "          </div>",
    "          <div class=\"rc-field\">",
    "            <label>Building Stories <span class=\"rc-info-tip\" data-tip=\"Upper-story windows cost more due to scaffolding, ladders, and added labor time. 2-story adds $35/window, 3+ story adds $65/window.\">?</span></label>",
    "            <select id=\"rc-stories\">",
    "              <option value=\"1\">1 Story (Ground Floor)</option>",
    "              <option value=\"2\">2 Stories (+$35/window)</option>",
    "              <option value=\"3\">3+ Stories (+$65/window)</option>",
    "            </select>",
    "          </div>",
    "        </div>",
    "        <p style=\"font-size:calc(0.8 * var(--rc-rem)); color:var(--text-gray); margin-top:calc(0.5 * var(--rc-rem));\">A 3% permit fee and disposal of old windows are automatically included in every estimate.</p>",
    "      </div>",
    "      <p class=\"rc-reassurance-note\">We will NOT send a salesperson to your home unless you request it. Your information is only used to generate your estimate.</p>",
    "      <div class=\"rc-btn-row\">",
    "        <div></div>",
    "        <button class=\"rc-btn rc-btn-primary\" onclick=\"ReeceCalculator.validateAndGoToStep2()\">Start My Estimate &rarr;</button>",
    "      </div>",
    "    </div>",
    "    <!-- ========== STEP 2: WINDOW CONFIGURATION ========== -->",
    "    <div class=\"rc-section\" id=\"rc-section-2\">",
    "      <div class=\"rc-config-layout\">",
    "      <div class=\"rc-config-form\">",
    "      <div class=\"rc-card rc-card--config\">",
    "        <h2>Window Configuration</h2>",
    "        <!-- Window Style -->",
    "        <h3>Window Style</h3>",
    "        <div class=\"rc-style-section\">",
    "        <div class=\"rc-tile-grid-wrapper\">",
    "        <div class=\"rc-tile-group\" id=\"rc-window-style\">",
    "          <!-- Single-Hung -->",
    "          <div class=\"rc-tile rc-selected\" data-value=\"single_hung\" onclick=\"ReeceCalculator.selectTile(this)\">",
    "            <span class=\"rc-tile-icon\"><svg viewBox=\"0 0 80 80\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">",
    "              <rect x=\"10\" y=\"5\" width=\"60\" height=\"70\" rx=\"1\"/>",
    "              <rect x=\"14\" y=\"9\" width=\"52\" height=\"62\" stroke-width=\"1\"/>",
    "              <line x1=\"14\" y1=\"40\" x2=\"66\" y2=\"40\" stroke-width=\"2.5\"/>",
    "              <line x1=\"40\" y1=\"9\" x2=\"40\" y2=\"40\" stroke-width=\"0.8\" opacity=\"0.3\" stroke-dasharray=\"3 2\"/>",
    "              <line x1=\"14\" y1=\"24\" x2=\"66\" y2=\"24\" stroke-width=\"0.8\" opacity=\"0.3\" stroke-dasharray=\"3 2\"/>",
    "              <path d=\"M35 54 L40 46 L45 54\" stroke-width=\"2.5\" fill=\"none\"/>",
    "              <line x1=\"40\" y1=\"46\" x2=\"40\" y2=\"64\" stroke-width=\"2\"/>",
    "              <rect x=\"37\" y=\"37\" width=\"6\" height=\"6\" rx=\"1\" fill=\"currentColor\" opacity=\"0.4\"/>",
    "            </svg></span>",
    "            Single-Hung",
    "          </div>",
    "          <!-- Double-Hung -->",
    "          <div class=\"rc-tile\" data-value=\"double_hung\" onclick=\"ReeceCalculator.selectTile(this)\">",
    "            <span class=\"rc-tile-icon\"><svg viewBox=\"0 0 80 80\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">",
    "              <rect x=\"10\" y=\"5\" width=\"60\" height=\"70\" rx=\"1\"/>",
    "              <rect x=\"14\" y=\"9\" width=\"52\" height=\"62\" stroke-width=\"1\"/>",
    "              <line x1=\"14\" y1=\"40\" x2=\"66\" y2=\"40\" stroke-width=\"2.5\"/>",
    "              <path d=\"M35 28 L40 20 L45 28\" stroke-width=\"2\" fill=\"none\"/>",
    "              <line x1=\"40\" y1=\"20\" x2=\"40\" y2=\"12\" stroke-width=\"2\"/>",
    "              <path d=\"M35 52 L40 60 L45 52\" stroke-width=\"2\" fill=\"none\"/>",
    "              <line x1=\"40\" y1=\"60\" x2=\"40\" y2=\"68\" stroke-width=\"2\"/>",
    "              <rect x=\"37\" y=\"37\" width=\"6\" height=\"6\" rx=\"1\" fill=\"currentColor\" opacity=\"0.4\"/>",
    "            </svg></span>",
    "            Double-Hung",
    "          </div>",
    "          <!-- Casement -->",
    "          <div class=\"rc-tile\" data-value=\"casement\" onclick=\"ReeceCalculator.selectTile(this)\">",
    "            <span class=\"rc-tile-icon\"><svg viewBox=\"0 0 80 80\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">",
    "              <rect x=\"10\" y=\"5\" width=\"60\" height=\"70\" rx=\"1\"/>",
    "              <rect x=\"14\" y=\"9\" width=\"52\" height=\"62\" stroke-width=\"1\"/>",
    "              <circle cx=\"14\" cy=\"18\" r=\"2.5\" fill=\"currentColor\" opacity=\"0.5\"/>",
    "              <circle cx=\"14\" cy=\"40\" r=\"2.5\" fill=\"currentColor\" opacity=\"0.5\"/>",
    "              <circle cx=\"14\" cy=\"62\" r=\"2.5\" fill=\"currentColor\" opacity=\"0.5\"/>",
    "              <path d=\"M60 22 Q72 40 60 58\" stroke-width=\"1.5\" stroke-dasharray=\"4 2\" fill=\"none\" opacity=\"0.5\"/>",
    "              <path d=\"M56 38 L62 40 L56 42\" stroke-width=\"1.5\" fill=\"none\"/>",
    "              <circle cx=\"62\" cy=\"40\" r=\"2\" fill=\"currentColor\" opacity=\"0.4\"/>",
    "              <line x1=\"56\" y1=\"68\" x2=\"62\" y2=\"68\" stroke-width=\"2.5\"/>",
    "              <circle cx=\"64\" cy=\"68\" r=\"2\" fill=\"currentColor\" opacity=\"0.4\"/>",
    "            </svg></span>",
    "            Casement",
    "          </div>",
    "          <!-- Sliding -->",
    "          <div class=\"rc-tile\" data-value=\"sliding\" onclick=\"ReeceCalculator.selectTile(this)\">",
    "            <span class=\"rc-tile-icon\"><svg viewBox=\"0 0 80 80\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">",
    "              <rect x=\"10\" y=\"5\" width=\"60\" height=\"70\" rx=\"1\"/>",
    "              <rect x=\"14\" y=\"9\" width=\"52\" height=\"62\" stroke-width=\"1\"/>",
    "              <line x1=\"40\" y1=\"9\" x2=\"40\" y2=\"71\" stroke-width=\"2.5\"/>",
    "              <path d=\"M50 36 L58 40 L50 44\" stroke-width=\"2.5\" fill=\"none\"/>",
    "              <line x1=\"44\" y1=\"40\" x2=\"58\" y2=\"40\" stroke-width=\"2\"/>",
    "              <line x1=\"14\" y1=\"68\" x2=\"66\" y2=\"68\" stroke-width=\"1\" opacity=\"0.3\"/>",
    "              <line x1=\"14\" y1=\"70\" x2=\"66\" y2=\"70\" stroke-width=\"1\" opacity=\"0.3\"/>",
    "            </svg></span>",
    "            Sliding",
    "          </div>",
    "          <!-- Three Lite Slider -->",
    "          <div class=\"rc-tile\" data-value=\"three_lite\" onclick=\"ReeceCalculator.selectTile(this)\">",
    "            <span class=\"rc-tile-icon\"><svg viewBox=\"0 0 80 80\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">",
    "              <rect x=\"6\" y=\"8\" width=\"68\" height=\"60\" rx=\"1\"/>",
    "              <rect x=\"10\" y=\"12\" width=\"60\" height=\"52\" stroke-width=\"1\"/>",
    "              <line x1=\"30\" y1=\"12\" x2=\"30\" y2=\"64\" stroke-width=\"2\"/>",
    "              <line x1=\"50\" y1=\"12\" x2=\"50\" y2=\"64\" stroke-width=\"2\"/>",
    "              <path d=\"M16 36 L22 38 L16 40\" stroke-width=\"2\" fill=\"none\"/>",
    "              <line x1=\"12\" y1=\"38\" x2=\"22\" y2=\"38\" stroke-width=\"1.5\"/>",
    "              <path d=\"M64 36 L58 38 L64 40\" stroke-width=\"2\" fill=\"none\"/>",
    "              <line x1=\"58\" y1=\"38\" x2=\"68\" y2=\"38\" stroke-width=\"1.5\"/>",
    "            </svg></span>",
    "            Three Lite Slider",
    "          </div>",
    "          <!-- Custom Shape -->",
    "          <div class=\"rc-tile\" data-value=\"custom_shape\" onclick=\"ReeceCalculator.selectTile(this)\">",
    "            <span class=\"rc-tile-icon\"><svg viewBox=\"0 0 80 80\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">",
    "              <path d=\"M40 8 L68 28 L68 68 L12 68 L12 28 Z\" stroke-width=\"2\"/>",
    "              <path d=\"M40 14 L62 30 L62 62 L18 62 L18 30 Z\" stroke-width=\"1\"/>",
    "              <line x1=\"40\" y1=\"14\" x2=\"40\" y2=\"62\" stroke-width=\"0.8\" opacity=\"0.3\" stroke-dasharray=\"3 2\"/>",
    "              <line x1=\"18\" y1=\"46\" x2=\"62\" y2=\"46\" stroke-width=\"0.8\" opacity=\"0.3\" stroke-dasharray=\"3 2\"/>",
    "              <rect x=\"36\" y=\"44\" width=\"8\" height=\"8\" rx=\"1\" stroke-width=\"1.5\" opacity=\"0.4\"/>",
    "              <line x1=\"40\" y1=\"45\" x2=\"40\" y2=\"51\" stroke-width=\"1\" opacity=\"0.4\"/>",
    "              <line x1=\"37\" y1=\"48\" x2=\"43\" y2=\"48\" stroke-width=\"1\" opacity=\"0.4\"/>",
    "            </svg></span>",
    "            Custom Shape",
    "          </div>",
    "          <!-- Awning -->",
    "          <div class=\"rc-tile\" data-value=\"awning\" onclick=\"ReeceCalculator.selectTile(this)\">",
    "            <span class=\"rc-tile-icon\"><svg viewBox=\"0 0 80 80\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">",
    "              <rect x=\"10\" y=\"5\" width=\"60\" height=\"70\" rx=\"1\"/>",
    "              <rect x=\"14\" y=\"9\" width=\"52\" height=\"62\" stroke-width=\"1\"/>",
    "              <circle cx=\"26\" cy=\"9\" r=\"2.5\" fill=\"currentColor\" opacity=\"0.5\"/>",
    "              <circle cx=\"40\" cy=\"9\" r=\"2.5\" fill=\"currentColor\" opacity=\"0.5\"/>",
    "              <circle cx=\"54\" cy=\"9\" r=\"2.5\" fill=\"currentColor\" opacity=\"0.5\"/>",
    "              <path d=\"M22 62 Q40 78 58 62\" stroke-width=\"1.5\" stroke-dasharray=\"4 2\" fill=\"none\" opacity=\"0.5\"/>",
    "              <path d=\"M36 60 L40 66 L44 60\" stroke-width=\"2\" fill=\"none\"/>",
    "              <line x1=\"40\" y1=\"52\" x2=\"40\" y2=\"66\" stroke-width=\"2\"/>",
    "              <line x1=\"36\" y1=\"68\" x2=\"44\" y2=\"68\" stroke-width=\"2.5\"/>",
    "              <circle cx=\"40\" cy=\"70\" r=\"1.5\" fill=\"currentColor\" opacity=\"0.4\"/>",
    "            </svg></span>",
    "            Awning",
    "          </div>",
    "          <!-- Picture (Fixed) -->",
    "          <div class=\"rc-tile\" data-value=\"picture\" onclick=\"ReeceCalculator.selectTile(this)\">",
    "            <span class=\"rc-tile-icon\"><svg viewBox=\"0 0 80 80\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">",
    "              <rect x=\"8\" y=\"4\" width=\"64\" height=\"72\" rx=\"1\" stroke-width=\"3\"/>",
    "              <rect x=\"14\" y=\"10\" width=\"52\" height=\"60\" stroke-width=\"2\"/>",
    "              <rect x=\"18\" y=\"14\" width=\"44\" height=\"52\" stroke-width=\"0.8\" opacity=\"0.2\"/>",
    "              <line x1=\"20\" y1=\"14\" x2=\"56\" y2=\"56\" stroke-width=\"0.5\" opacity=\"0.15\"/>",
    "              <line x1=\"24\" y1=\"14\" x2=\"60\" y2=\"54\" stroke-width=\"0.5\" opacity=\"0.1\"/>",
    "              <rect x=\"36\" y=\"36\" width=\"8\" height=\"8\" rx=\"1\" stroke-width=\"1.5\" opacity=\"0.4\"/>",
    "              <line x1=\"40\" y1=\"37\" x2=\"40\" y2=\"43\" stroke-width=\"1\" opacity=\"0.4\"/>",
    "              <line x1=\"37\" y1=\"40\" x2=\"43\" y2=\"40\" stroke-width=\"1\" opacity=\"0.4\"/>",
    "            </svg></span>",
    "            Picture (Fixed)",
    "          </div>",
    "        </div>",
    "        <!-- Frame Material -->",
    "        <h3>Frame Material</h3>",
    "        <div class=\"rc-tile-group\" id=\"rc-frame-material\">",
    "          <div class=\"rc-tile\" data-value=\"aluminum\" onclick=\"ReeceCalculator.selectTile(this)\">",
    "            <span class=\"rc-tile-icon\"><svg viewBox=\"0 0 40 40\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><rect x=\"6\" y=\"6\" width=\"28\" height=\"28\" rx=\"1\"/><rect x=\"10\" y=\"10\" width=\"20\" height=\"20\" rx=\"0\"/><line x1=\"6\" y1=\"6\" x2=\"10\" y2=\"10\"/><line x1=\"34\" y1=\"6\" x2=\"30\" y2=\"10\"/><line x1=\"6\" y1=\"34\" x2=\"10\" y2=\"30\"/><line x1=\"34\" y1=\"34\" x2=\"30\" y2=\"30\"/></svg></span>",
    "            Aluminum",
    "          </div>",
    "          <div class=\"rc-tile rc-selected\" data-value=\"vinyl\" onclick=\"ReeceCalculator.selectTile(this)\">",
    "            <span class=\"rc-tile-icon\"><svg viewBox=\"0 0 40 40\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><rect x=\"6\" y=\"6\" width=\"28\" height=\"28\" rx=\"2\"/><rect x=\"10\" y=\"10\" width=\"20\" height=\"20\" rx=\"1\"/><line x1=\"6\" y1=\"6\" x2=\"10\" y2=\"10\"/><line x1=\"34\" y1=\"6\" x2=\"30\" y2=\"10\"/><line x1=\"6\" y1=\"34\" x2=\"10\" y2=\"30\"/><line x1=\"34\" y1=\"34\" x2=\"30\" y2=\"30\"/></svg></span>",
    "            Vinyl",
    "          </div>",
    "          <div class=\"rc-tile\" data-value=\"composite\" onclick=\"ReeceCalculator.selectTile(this)\">",
    "            <span class=\"rc-tile-icon\"><svg viewBox=\"0 0 40 40\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><rect x=\"6\" y=\"6\" width=\"28\" height=\"28\" rx=\"1\"/><rect x=\"10\" y=\"10\" width=\"20\" height=\"20\" rx=\"0\"/><line x1=\"6\" y1=\"6\" x2=\"10\" y2=\"10\"/><line x1=\"34\" y1=\"6\" x2=\"30\" y2=\"10\"/><line x1=\"6\" y1=\"34\" x2=\"10\" y2=\"30\"/><line x1=\"34\" y1=\"34\" x2=\"30\" y2=\"30\"/><line x1=\"10\" y1=\"20\" x2=\"30\" y2=\"20\" stroke-dasharray=\"2 2\"/><line x1=\"20\" y1=\"10\" x2=\"20\" y2=\"30\" stroke-dasharray=\"2 2\"/></svg></span>",
    "            Composite",
    "          </div>",
    "        </div>",
    "        </div>",
    "        <div class=\"rc-config-video\">",
    "          <video id=\"rc-intro-video\" controls preload=\"metadata\">",
    "            <source src=\"https://storage.googleapis.com/msgsndr/SsBG7j5KQAIP1SFP2Sca/media/698df13124813c50d4832586.mp4\" type=\"video/mp4\">",
    "            Your browser does not support the video tag.",
    "          </video>",
    "          <p class=\"rc-video-caption\">How to Measure Your Windows</p>",
    "        </div>",
    "        </div>",
    "        <!-- Glass Type -->",
    "        <h3>Glass Configuration</h3>",
    "        <div class=\"rc-form-row rc-three\">",
    "          <div class=\"rc-field\">",
    "            <label>Panes</label>",
    "            <select id=\"rc-glass-panes\" onchange=\"ReeceCalculator.handlePaneChange()\">",
    "              <option value=\"single\">Single Pane</option>",
    "              <option value=\"double\" selected>Double Pane</option>",
    "            </select>",
    "          </div>",
    "          <div class=\"rc-field\" id=\"rc-gas-fill-field\">",
    "            <label>Gas Fill</label>",
    "            <select id=\"rc-gas-fill\">",
    "              <option value=\"air\" selected>Air (Standard)</option>",
    "            </select>",
    "          </div>",
    "          <div class=\"rc-field\">",
    "            <label>Grid Pattern</label>",
    "            <select id=\"rc-grid-pattern\">",
    "              <option value=\"none\">No Grids</option>",
    "              <option value=\"colonial\">Colonial</option>",
    "              <option value=\"prairie\">Prairie</option>",
    "              <option value=\"custom\">Custom Grids</option>",
    "            </select>",
    "          </div>",
    "        </div>",
    "        <!-- Glass Add-ons -->",
    "        <h3>Glass Upgrades <span class=\"rc-hint\">(select all that apply)</span></h3>",
    "        <div class=\"rc-check-group\" id=\"rc-glass-upgrades\">",
    "          <label class=\"rc-check-item rc-checked\" onclick=\"ReeceCalculator.toggleCheck(this)\">",
    "            <input type=\"checkbox\" value=\"low_e\" checked>",
    "            <div>",
    "              <div class=\"rc-check-label\">Low-E Coating</div>",
    "              <div class=\"rc-check-desc\">Reflects heat, blocks UV.</div>",
    "            </div>",
    "          </label>",
    "          <label class=\"rc-check-item\" onclick=\"ReeceCalculator.toggleCheck(this)\">",
    "            <input type=\"checkbox\" value=\"tempered\">",
    "            <div>",
    "              <div class=\"rc-check-label\">Tempered Glass</div>",
    "              <div class=\"rc-check-desc\">Safety glass, 4x stronger.</div>",
    "            </div>",
    "          </label>",
    "          <label class=\"rc-check-item\" onclick=\"ReeceCalculator.toggleCheck(this)\">",
    "            <input type=\"checkbox\" value=\"tinted\">",
    "            <div>",
    "              <div class=\"rc-check-label\">Tinted Glass</div>",
    "              <div class=\"rc-check-desc\">Reduces glare &amp; solar heat.</div>",
    "            </div>",
    "          </label>",
    "          <label class=\"rc-check-item\" onclick=\"ReeceCalculator.toggleCheck(this)\">",
    "            <input type=\"checkbox\" value=\"impact\">",
    "            <div>",
    "              <div class=\"rc-check-label\">Impact Resistant</div>",
    "              <div class=\"rc-check-desc\">Hurricane/security rated.</div>",
    "            </div>",
    "          </label>",
    "          <label class=\"rc-check-item\" onclick=\"ReeceCalculator.toggleCheck(this)\">",
    "            <input type=\"checkbox\" value=\"obscure\">",
    "            <div>",
    "              <div class=\"rc-check-label\">Obscure / Privacy</div>",
    "              <div class=\"rc-check-desc\">Frosted or textured.</div>",
    "            </div>",
    "          </label>",
    "          <label class=\"rc-check-item\" onclick=\"ReeceCalculator.toggleCheck(this)\">",
    "            <input type=\"checkbox\" value=\"sound\">",
    "            <div>",
    "              <div class=\"rc-check-label\">Sound Reduction</div>",
    "              <div class=\"rc-check-desc\">Laminated acoustic glass.</div>",
    "            </div>",
    "          </label>",
    "        </div>",
    "        <!-- Window Size -->",
    "        <h3>Window Size</h3>",
    "        <div class=\"rc-tile-group\" id=\"rc-window-size\">",
    "          <div class=\"rc-tile\" data-value=\"small\" onclick=\"ReeceCalculator.selectTile(this)\">",
    "            <span class=\"rc-tile-icon\"><svg viewBox=\"0 0 80 80\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><rect x=\"22\" y=\"22\" width=\"36\" height=\"36\" rx=\"1\"/><rect x=\"26\" y=\"26\" width=\"28\" height=\"28\" stroke-width=\"1\"/></svg></span>",
    "            Small",
    "            <span class=\"rc-tile-price\">~36&Prime;&times;36&Prime;</span>",
    "          </div>",
    "          <div class=\"rc-tile rc-selected\" data-value=\"medium\" onclick=\"ReeceCalculator.selectTile(this)\">",
    "            <span class=\"rc-tile-icon\"><svg viewBox=\"0 0 80 80\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><rect x=\"18\" y=\"14\" width=\"44\" height=\"52\" rx=\"1\"/><rect x=\"22\" y=\"18\" width=\"36\" height=\"44\" stroke-width=\"1\"/></svg></span>",
    "            Medium",
    "            <span class=\"rc-tile-price\">~36&Prime;&times;48&Prime;</span>",
    "          </div>",
    "          <div class=\"rc-tile\" data-value=\"large\" onclick=\"ReeceCalculator.selectTile(this)\">",
    "            <span class=\"rc-tile-icon\"><svg viewBox=\"0 0 80 80\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><rect x=\"10\" y=\"6\" width=\"60\" height=\"68\" rx=\"1\"/><rect x=\"14\" y=\"10\" width=\"52\" height=\"60\" stroke-width=\"1\"/></svg></span>",
    "            Large",
    "            <span class=\"rc-tile-price\">~48&Prime;&times;60&Prime;</span>",
    "          </div>",
    "        </div>",
    "        <p style=\"font-size:calc(0.78 * var(--rc-rem)); color:var(--text-gray); margin-top:calc(0.3 * var(--rc-rem));\">Exact measurements are confirmed during professional verification.</p>",
    "        <!-- Quantity -->",
    "        <h3>Quantity</h3>",
    "        <div class=\"rc-qty-control\">",
    "          <button onclick=\"ReeceCalculator.adjustQty(-1)\">&#8722;</button>",
    "          <input type=\"number\" id=\"rc-win-qty\" value=\"1\" min=\"1\" max=\"50\">",
    "          <button onclick=\"ReeceCalculator.adjustQty(1)\">+</button>",
    "        </div>",
    "        <div class=\"rc-btn-row\">",
    "          <button class=\"rc-btn rc-btn-secondary\" onclick=\"ReeceCalculator.goToStep(1)\">&larr; Back</button>",
    "          <div style=\"display:flex; gap:calc(0.5 * var(--rc-rem));\">",
    "            <button class=\"rc-btn rc-btn-accent\" onclick=\"ReeceCalculator.addWindow()\">Add Window to Estimate</button>",
    "          </div>",
    "        </div>",
    "      </div>",
    "      <!-- Cart Summary -->",
    "      <div class=\"rc-card\">",
    "        <h2>Windows in Estimate</h2>",
    "        <div id=\"rc-window-list\" class=\"rc-window-list\">",
    "          <div class=\"rc-empty-state\">No windows added yet. Configure a window above and click \"Add Window to Estimate\".</div>",
    "        </div>",
    "        <div class=\"rc-btn-row\">",
    "          <button class=\"rc-btn rc-btn-secondary\" onclick=\"ReeceCalculator.goToStep(1)\">&larr; Project Details</button>",
    "          <button class=\"rc-btn rc-btn-primary\" id=\"rc-btn-to-step3\" onclick=\"ReeceCalculator.goToStep(3)\" disabled>Show My Window Pricing &rarr;</button>",
    "        </div>",
    "      </div>",
    "      </div><!-- /.config-form -->",
    "      </div><!-- /.config-layout -->",
    "    </div>",
    "    <!-- ========== STEP 3: CONTACT INFORMATION ========== -->",
    "    <div class=\"rc-section\" id=\"rc-section-3\">",
    "      <div class=\"rc-card\">",
    "        <h2>Where Should We Email Your Estimate?</h2>",
    "        <p class=\"rc-contact-note\">Enter your email address below to receive a PDF copy of your estimate.</p>",
    "        <div class=\"rc-form-row rc-full\">",
    "          <div class=\"rc-field\" id=\"rc-field-email\">",
    "            <label>Email Address <span style=\"color:var(--cta-red);\">*</span></label>",
    "            <input type=\"email\" id=\"rc-email\" placeholder=\"you@example.com\" inputmode=\"email\" required>",
    "            <div class=\"rc-field-error-msg\">Please enter a valid email address.</div>",
    "            <p class=\"rc-field-hint\">We'll email a PDF copy of your estimate.</p>",
    "          </div>",
    "        </div>",
    "        <p class=\"rc-reassurance-note\">We respect your privacy. No spam. No surprise visits.</p>",
    "        <div class=\"rc-btn-row\">",
    "          <button class=\"rc-btn rc-btn-secondary\" onclick=\"ReeceCalculator.goToStep(2)\">&larr; Edit Windows</button>",
    "          <button class=\"rc-btn rc-btn-primary\" onclick=\"ReeceCalculator.validateAndGoToStep4()\">Calculate My Estimate &rarr;</button>",
    "        </div>",
    "      </div>",
    "    </div>",
    "    <!-- ========== STEP 4: ESTIMATE SUMMARY ========== -->",
    "    <div class=\"rc-section\" id=\"rc-section-4\">",
    "      <div class=\"rc-card\">",
    "        <div id=\"rc-summary-content\"></div>",
    "      </div>",
    "      <!-- Secure Your Exact Price CTA -->",
    "      <div class=\"rc-verify-cta\">",
    "        <h3>Secure Your Exact Price</h3>",
    "        <p>This estimate is based on preliminary measurements.</p>",
    "        <p>A brief professional verification allows us to:</p>",
    "        <ul>",
    "          <li>Confirm final dimensions</li>",
    "          <li>Finalize installation method</li>",
    "          <li>Determine routing efficiencies</li>",
    "          <li>Allocate materials</li>",
    "          <li>Remove uncertainty</li>",
    "        </ul>",
    "        <p class=\"rc-cta-micro\">Verification assigns your project to a scheduling zone and confirms final pricing.</p>",
    "        <button class=\"rc-btn rc-btn-primary\" id=\"rc-btn-verify-measurement\" onclick=\"ReeceCalculator.openMeasurementVerification()\">",
    "          Secure My Exact Price &rarr;",
    "        </button>",
    "        <p class=\"rc-cta-subtext\">There is no obligation. No sales presentation. <span style=\"font-weight:600;\">Just precision.</span></p>",
    "        <p class=\"rc-verify-secondary\">",
    "          <a href=\"#\" onclick=\"event.preventDefault(); ReeceCalculator.showKeepEstimateModal();\">Keep My Estimate for Now</a>",
    "        </p>",
    "      </div>",
    "      <div class=\"rc-disclaimer\">",
    "        This estimate reflects current material pricing and standard installation conditions. Final pricing is confirmed following professional on-site verification.",
    "      </div>",
    "      <div class=\"rc-btn-row\">",
    "        <button class=\"rc-btn rc-btn-secondary\" onclick=\"ReeceCalculator.goToStep(3)\">&larr; Back</button>",
    "        <button class=\"rc-btn rc-btn-print\" onclick=\"window.print()\">Print Estimate</button>",
    "      </div>",
    "    </div>",
    "  </div>",
    "  <!-- Sticky Mobile CTA -->",
    "  <button class=\"rc-sticky-cta\" onclick=\"ReeceCalculator.openMeasurementVerification()\">",
    "    Secure My Exact Price &rarr;",
    "  </button>",
    "  <!-- Keep Estimate Modal -->",
    "  <div class=\"rc-modal-overlay\" id=\"rc-keep-estimate-modal\" onclick=\"if(event.target===this) ReeceCalculator.hideKeepEstimateModal()\">",
    "    <div class=\"rc-modal-dialog\">",
    "      <h3>Leave Estimate Unverified?</h3>",
    "      <p>Your estimate will remain available, but final pricing and scheduling priority are confirmed during verification.</p>",
    "      <button class=\"rc-btn rc-btn-primary\" onclick=\"ReeceCalculator.openMeasurementVerification()\">Secure My Exact Price &rarr;</button>",
    "      <button class=\"rc-btn-link\" onclick=\"ReeceCalculator.sendEvent('left_unverified'); window.location.href='https://reecewindows.com/';\">Leave Unverified</button>",
    "    </div>",
    "  </div>",
    "  <!-- Email Verification Modal -->",
    "  <div class=\"rc-modal-overlay\" id=\"rc-verify-email-modal\">",
    "    <div class=\"rc-modal-dialog\">",
    "      <h3>Verify Your Email</h3>",
    "      <p>We just sent a 6-digit verification code to<br><span class=\"rc-verify-email-display\" id=\"rc-verify-email-display\"></span></p>",
    "      <p class=\"rc-verify-spam-note\">Don't see it? Check your spam or junk folder.</p>",
    "      <input type=\"text\"",
    "             class=\"rc-verify-code-input\"",
    "             id=\"rc-verify-code-input\"",
    "             placeholder=\"######\"",
    "             maxlength=\"6\"",
    "             inputmode=\"numeric\"",
    "             autocomplete=\"one-time-code\">",
    "      <div class=\"rc-verify-error-msg\" id=\"rc-verify-error-msg\">Incorrect code. Please try again.</div>",
    "      <div class=\"rc-verify-success-msg\" id=\"rc-verify-success-msg\">Verified! Loading your estimate...</div>",
    "      <button class=\"rc-btn rc-btn-primary\" id=\"rc-verify-submit-btn\" onclick=\"ReeceCalculator.verifyEnteredCode()\">Verify &amp; See My Estimate</button>",
    "      <button class=\"rc-btn rc-btn-resend\" id=\"rc-verify-resend-btn\" onclick=\"ReeceCalculator.resendVerificationCode()\">Resend Code</button>",
    "      <button class=\"rc-btn-link\" onclick=\"ReeceCalculator.changeEmail()\">Use a different email address</button>",
    "    </div>",
    "  </div>",
    "<div id=\"rc-print-root\"></div>"
  ].join('\n');

  // ==========================================================================
  //  FULL-MODE PAGE CHROME — data-mode="full" ONLY
  //
  //  The navy banner, the running-total bar and the site footer that
  //  public/index.html gives the standalone page, rebuilt here so the GHL
  //  funnel page gets the same full-page treatment from the same deploy.
  //  Nothing below is reachable in embed mode.
  //
  //  Every selector is scoped under .rc-page-*, and the whole thing renders
  //  inside the shadow root, so the funnel page's own utility classes cannot
  //  reach it and it cannot reach them.
  // ==========================================================================
  var FULL_CSS = [
    // The shadow HOST, styled from inside. :host is the weakest selector there
    // is, so the funnel page can still override any of this.
    //
    // contain:inline-size is the load-bearing line. GHL builds every funnel row
    // as a flex container (.c-row > .c-column), and a flex item's automatic
    // minimum size is its CONTENT's min-content width. The stepper is a
    // no-wrap flex row whose min-content is 385px, so the funnel column
    // stretched to 385px and the whole page scrolled sideways by 25px at
    // 360px — the common Android width. Size containment makes this box size
    // from its container instead of from its contents, so the column shrinks
    // to the screen.
    //
    // overflow-x:hidden then clips what no longer fits, the same guard the
    // standalone page applies with body{overflow-x:hidden}. On its own it was
    // NOT enough: Chromium still propagated the min-content width out through
    // the scroll container. Both lines are needed.
    //
    // Size containment does not create a containing block for fixed-position
    // descendants (only layout/paint containment does), so both modals and the
    // sticky CTA still cover the viewport — asserted in test/run.js.
    //
    // It does mean the mount takes its width from its parent rather than from
    // its contents, so full mode wants a parent with a real width — a GHL
    // column, a section, a body. That is every funnel page; a floated or
    // shrink-to-fit parent would collapse it, which is why display:block and
    // max-width are pinned here too.
    ":host {",
    "  display: block;",
    "  max-width: 100%;",
    "  contain: inline-size;",
    "  overflow-x: hidden;",
    "}",
    // The host page's own font-size and font-family DO inherit through a shadow
    // boundary — only styles are blocked, not inheritance. Pin both on the root
    // so a funnel-page body rule cannot resize the chrome, the same defect
    // --rc-rem already fixes inside the calculator.
    ".rc-page {",
    // Same reason as the calculator's own --rc-rem, and the same reason it
    // still applies behind a shadow boundary: shadow DOM blocks the host page's
    // STYLE RULES, not inheritance and not rem. rem resolves against the host
    // document's <html> font-size no matter which tree the element is in, so a
    // funnel page with html{font-size:10px} would render this chrome at 62.5%.
    "  --rc-rem: 16px;",
    "  font-family: 'Nunito Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;",
    "  font-size: 17px;",
    "  font-weight: 400;",
    "  line-height: 1.6;",
    "  color: #636060;",
    "  background: #F2F3F7;",
    "  text-align: left;",
    "}",
    ".rc-page *, .rc-page *::before, .rc-page *::after { box-sizing: border-box; margin: 0; padding: 0; }",
    "/* ===== HEADER ===== */",
    ".rc-page-header {",
    "  background: #0D2240;",
    "  color: #FFFFFF;",
    "  padding: calc(2.2 * var(--rc-rem)) calc(1 * var(--rc-rem)) calc(2.5 * var(--rc-rem));",
    "  text-align: center;",
    "  position: relative;",
    "  overflow: hidden;",
    "}",
    ".rc-page-header::after {",
    "  content: '';",
    "  position: absolute;",
    "  top: 0;",
    "  right: 0;",
    "  width: 50%;",
    "  height: 100%;",
    "  background: #9B2E2C;",
    "  opacity: 1;",
    "  clip-path: polygon(45% 0, 100% 0, 100% 100%, 0 100%);",
    "  pointer-events: none;",
    "}",
    ".rc-page-header .rc-page-header-content { position: relative; z-index: 1; }",
    ".rc-page-header .rc-page-brand {",
    "  font-size: calc(1 * var(--rc-rem));",
    "  font-weight: 300;",
    "  letter-spacing: 2px;",
    "  text-transform: uppercase;",
    "  opacity: 0.85;",
    "  margin-bottom: calc(0.3 * var(--rc-rem));",
    "}",
    ".rc-page-header h1 {",
    "  font-size: calc(2 * var(--rc-rem));",
    "  font-weight: 700;",
    "  color: #FFFFFF;",
    "  letter-spacing: -0.5px;",
    "}",
    ".rc-page-header p {",
    "  color: #C1D5DB;",
    "  margin-top: calc(0.4 * var(--rc-rem));",
    "  font-size: calc(0.95 * var(--rc-rem));",
    "  font-weight: 400;",
    "}",
    ".rc-page-header .rc-page-authority {",
    "  font-size: calc(1.05 * var(--rc-rem));",
    "  font-weight: 600;",
    "  color: #FFFFFF;",
    "  margin-top: calc(0.2 * var(--rc-rem));",
    "  letter-spacing: 0.3px;",
    "}",
    ".rc-page-header .rc-page-intro {",
    "  max-width: 640px;",
    "  margin: calc(0.6 * var(--rc-rem)) auto 0;",
    "  font-size: calc(0.88 * var(--rc-rem));",
    "  line-height: 1.5;",
    "  color: rgba(255,255,255,0.82);",
    "  font-weight: 300;",
    "}",
    "@media (max-width: 600px) {",
    "  .rc-page-header { padding: calc(1.6 * var(--rc-rem)) calc(1 * var(--rc-rem)) calc(1.8 * var(--rc-rem)); }",
    "  .rc-page-header h1 { font-size: calc(1.45 * var(--rc-rem)); }",
    "}",
    "/* ===== THIN SITE FOOTER ===== */",
    ".rc-page-siteline {",
    "  text-align: center;",
    "  padding: calc(1.25 * var(--rc-rem)) calc(1 * var(--rc-rem));",
    "  font-size: calc(0.82 * var(--rc-rem));",
    "  color: #87898B;",
    "  background: #FFFFFF;",
    "  border-top: 1px solid #C1D5DB;",
    "}",
    "/* ===== RUNNING TOTAL BAR =====",
    "   position:sticky is deliberately NOT used here. On the standalone page the",
    "   calculator is the document and the bar sticks to the viewport; inside a",
    "   shadow root on a funnel page it would stick to the wrong scroll container",
    "   and float over the page's own content. Static keeps it where it belongs. */",
    ".rc-page-total {",
    "  background: #0D2240;",
    "  color: #FFFFFF;",
    "  text-align: center;",
    "  padding: calc(0.75 * var(--rc-rem)) calc(1 * var(--rc-rem));",
    "  font-size: calc(0.95 * var(--rc-rem));",
    "  font-weight: 600;",
    "  position: relative;",
    "  overflow: hidden;",
    "}",
    ".rc-page-total::after {",
    "  content: '';",
    "  position: absolute;",
    "  top: 0;",
    "  right: 0;",
    "  width: 40%;",
    "  height: 100%;",
    "  background: #9B2E2C;",
    "  opacity: 1;",
    "  clip-path: polygon(45% 0, 100% 0, 100% 100%, 0 100%);",
    "  pointer-events: none;",
    "}",
    ".rc-page-total .rc-page-total-content { position: relative; z-index: 1; }",
    ".rc-page-total span { font-size: calc(1.15 * var(--rc-rem)); }",
    "/* ===== BRAND FOOTER ===== */",
    ".rc-page-footer {",
    "  width: 100%;",
    "  background: #122739;",
    "  color: #FFFFFF;",
    "  text-align: center;",
    "  padding: 40px 20px;",
    "  overflow-x: hidden;",
    "}",
    ".rc-page-footer-inner { width: 100%; max-width: 1200px; margin: 0 auto; }",
    ".rc-page-trust {",
    "  margin-bottom: 22px;",
    "  display: flex;",
    "  justify-content: center;",
    "  align-items: center;",
    "  gap: 30px;",
    "  flex-wrap: wrap;",
    "}",
    ".rc-page-trust img { height: 38px; width: auto; display: block; }",
    ".rc-page-locations {",
    "  display: flex;",
    "  justify-content: center;",
    "  align-items: center;",
    "  gap: 34px;",
    "  flex-wrap: wrap;",
    "  margin-bottom: 56px;",
    "}",
    ".rc-page-locations span {",
    "  color: #FFFFFF;",
    "  font-size: 13px;",
    "  font-weight: 700;",
    "  letter-spacing: 2px;",
    "  text-transform: uppercase;",
    "}",
    ".rc-page-logo { margin-bottom: 20px; }",
    ".rc-page-logo img { height: 64px; width: auto; display: inline-block; }",
    ".rc-page-policies { margin-bottom: 20px; }",
    ".rc-page-policies a, .rc-page-policies span {",
    "  color: #FFFFFF;",
    "  font-size: 14px;",
    "  font-weight: 700;",
    "  text-decoration: none;",
    "}",
    ".rc-page-copy {",
    "  width: 100%;",
    "  text-align: center;",
    "  font-size: 14px;",
    "  color: #C1D5DB;",
    "  margin: 0 auto 15px;",
    "  padding: 0 15px;",
    "}",
    ".rc-page-disclaimer {",
    "  display: block;",
    "  width: 100%;",
    "  max-width: 800px;",
    "  margin: 0 auto;",
    "  padding: 0 20px;",
    "  font-size: 12px;",
    "  line-height: 1.6;",
    "  color: #C1D5DB;",
    "  text-align: center;",
    "  overflow-wrap: anywhere;",
    "  word-break: break-word;",
    "}",
    "@media screen and (max-width: 768px) {",
    "  .rc-page-footer { padding: 36px 18px; }",
    "  .rc-page-trust { gap: 16px; }",
    "  .rc-page-trust img { height: 34px; }",
    "  .rc-page-locations { gap: 18px 24px; margin-bottom: 46px; }",
    "  .rc-page-locations span { font-size: 12px; letter-spacing: 1.5px; }",
    "  .rc-page-logo img { height: 60px; }",
    "}",
    "@media screen and (max-width: 640px) {",
    "  .rc-page-trust { gap: 10px; }",
    "  .rc-page-trust img { height: 30px; max-width: 100%; }",
    "  .rc-page-locations { gap: 16px 22px; margin-bottom: 42px; }",
    "  .rc-page-logo img { height: 58px; }",
    "}",
    "@media screen and (max-width: 420px) {",
    "  .rc-page-trust { gap: 8px; }",
    "  .rc-page-trust img { height: 27px; }",
    "  .rc-page-locations { flex-direction: column; gap: 13px; }",
    "  .rc-page-disclaimer { padding: 0 15px; }",
    "}"
  ].join('\n');

  // Assets the chrome loads. Absolute against this service, because in full
  // mode the host page is landing.reecewindows.com and a root-relative path
  // would resolve against THAT origin and 404.
  var ASSET_BASE = 'https://estimate.getreecewindows.com';

  var FULL_HTML = [
    // id="rc-host-header" is the same hook the standalone page uses: the
    // printed estimate clones it for the banner. hostEl() finds it in here.
    "<header class=\"rc-page-header\" id=\"rc-host-header\">",
    "  <div class=\"rc-page-header-content\">",
    "    <div class=\"rc-page-brand\">Reece Windows &amp; Doors &bull; Est. 1972</div>",
    "    <h1>Get Your Window Replacement Estimate &mdash; No Sales Visit Required</h1>",
    "    <p>Family-Owned Since 1972. Trusted by Thousands of Florida Homeowners.</p>",
    "    <p class=\"rc-page-authority\">No in-home appointment required to see pricing.</p>",
    "    <p class=\"rc-page-intro\">New windows don't just improve how your home looks. They lower energy bills, increase storm protection, reduce outside noise, and raise your home's value.<br>This quick estimator shows you what that upgrade could realistically cost, before you commit to anything.</p>",
    "  </div>",
    "</header>",
    // The wrapper deliberately carries id="reece-calculator" — the SAME id as
    // the shadow host outside it. Every one of the calculator's ~400 style
    // rules is scoped "#reece-calculator .rc-…", so reusing the id means the
    // stylesheet below is the byte-identical string embed mode injects, with
    // no selector rewriting and therefore no specificity drift between the two
    // modes. Ids are scoped per node tree: document.getElementById() still
    // returns the host, shadowRoot.getElementById() returns this wrapper, and
    // the two never collide.
    "<div id=\"reece-calculator\" class=\"rc-full-inner\">",
    "  <!-- calculator markup is written in here at mount -->",
    "</div>",
    "<div class=\"rc-page-siteline\">Serving Homeowners Since 1972 &bull; Licensed, Insured, Hurricane Code Compliant</div>",
    "<div class=\"rc-page-total\" id=\"rc-running-total\">",
    "  <div class=\"rc-page-total-content\">Estimated Total: <span>$0</span></div>",
    "</div>",
    "<footer class=\"rc-page-footer\">",
    "  <div class=\"rc-page-footer-inner\">",
    "    <div class=\"rc-page-trust\">",
    "      <img src=\"https://storage.googleapis.com/msgsndr/SsBG7j5KQAIP1SFP2Sca/media/68cd79e3fb98c8859da49752.png\" alt=\"Trusted 50 plus years\" width=\"600\" height=\"266\" loading=\"lazy\" decoding=\"async\">",
    "      <img src=\"https://storage.googleapis.com/msgsndr/SsBG7j5KQAIP1SFP2Sca/media/68cd7dc3e8e00983775f45ab.webp\" alt=\"BBB A plus rating\" width=\"326\" height=\"323\" loading=\"lazy\" decoding=\"async\">",
    "      <img src=\"https://storage.googleapis.com/msgsndr/SsBG7j5KQAIP1SFP2Sca/media/68cd79e327afc809f37b5868.png\" alt=\"Double lifetime warranty\" width=\"492\" height=\"200\" loading=\"lazy\" decoding=\"async\">",
    "    </div>",
    // Plain spans, not links. The standalone page's location list points at
    // href="#", which inside a shadow root on a funnel page would scroll the
    // HOST document to the top mid-funnel. A label that never navigated is not
    // worth a navigation bug.
    "    <div class=\"rc-page-locations\" aria-label=\"Service areas\">",
    "      <span>Fort Lauderdale</span><span>Tampa</span><span>Orlando</span><span>Sarasota</span>",
    "      <span>Fort Myers</span><span>Jacksonville</span><span>Lakeland</span><span>St. Petersburg</span>",
    "    </div>",
    "    <div class=\"rc-page-logo\">",
    "      <picture>",
    "        <source srcset=\"" + ASSET_BASE + "/static/logo-footer.webp\" type=\"image/webp\">",
    "        <img src=\"" + ASSET_BASE + "/static/logo-footer.png\" alt=\"Reece Windows &amp; Doors\" width=\"160\" height=\"160\" loading=\"lazy\" decoding=\"async\">",
    "      </picture>",
    "    </div>",
    "    <div class=\"rc-page-policies\">",
    "      <a href=\"https://landing.reecewindows.com/privacy\" target=\"_blank\" rel=\"noopener\">Privacy Policy</a>",
    "      <span>|</span>",
    "      <a href=\"https://landing.reecewindows.com/terms\" target=\"_blank\" rel=\"noopener\">Terms &amp; Conditions</a>",
    "    </div>",
    "    <p class=\"rc-page-copy\">&copy; <span id=\"rc-page-year\"></span> Reece Windows &amp; Doors All Rights Reserved</p>",
    "    <p class=\"rc-page-disclaimer\">Reece Windows &amp; Doors is an independent entity and is not affiliated with, endorsed by, or sponsored by Meta Platforms, Inc. or Google LLC. The information provided is for informational purposes only. Client testimonials reflect individual experiences and do not guarantee future results. This content is not a substitute for professional legal, financial, or insurance advice.</p>",
    "  </div>",
    "</footer>"
  ].join('\n');

  // =============================================================
  //  Reece Windows & Doors — Window Cost Estimator
  //  All application logic (inlined for standalone use)
  // =============================================================
  // ============================================================
  //  CENTRALIZED DEFAULTS
  // ============================================================
  const DEFAULTS = {
    installType: 'fullframe'
  };
  // ============================================================
  //  BACKEND API CLIENT
  //  All GHL, PDF, and verification traffic goes through the
  //  same-origin Express server. No tokens ever ship to the browser.
  // ============================================================
  // Stamped onto the contact as calc_consent_version (GHL field
  // H2NXVp74G1kf6gHjiUvN) by POST /api/contact. Bump this whenever the wording
  // of the consent block changes, and NEVER backfill contacts carrying an older
  // value — that value is the record of what those leads actually agreed to.
  // v2 (2026-09-17): 10DLC SMS block split out, calling and email consent kept.
  var CONSENT_VERSION = 'calc-consent-2026-09-17-v2';
  var CALC_SESSION_ID = (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : String(Date.now()) + '-' + Math.random().toString(16).slice(2);

  // Absolute base so the page works when served from reecewindows.com.
  // Same-origin deploys are unaffected — the origin resolves to itself.
  var API_BASE = 'https://estimate.getreecewindows.com';

  // Identifies THIS form as a source inside Lead Perfection. Constant regardless
  // of how the visitor arrived — a URL value still overrides (canvasser pro_id).
  // Without a default, organic arrivals on the main domain reach LP with no
  // source and route as generic.
  var DEFAULT_PRO_ID = '5862';
  var DEFAULT_LP_SOURCE_ID = '842';

  // Which page the visitor is on. The standalone landing page and the WordPress
  // SEO page run this same file, so the hostname is what separates them in
  // reporting — nothing about the build differs.
  var STANDALONE_HOSTS = /^(estimate\.getreecewindows\.com|localhost|.*\.up\.railway\.app)$/i;
  var PAGE_VARIANT = STANDALONE_HOSTS.test(window.location.hostname) ? 'standalone' : 'main-domain';

  // Attribution resolved once at load and reused for every event and the
  // contact upsert, so a mid-session URL change cannot split one session
  // across two sources.
  var ATTRIBUTION = (function () {
    var q = new URLSearchParams(window.location.search);
    var a = {
      utm_source:   q.get('utm_source')   || '',
      utm_medium:   q.get('utm_medium')   || '',
      utm_campaign: q.get('utm_campaign') || '',
      utm_content:  q.get('utm_content')  || '',
      utm_term:     q.get('utm_term')     || '',
      gclid:        q.get('gclid')    || q.get('wbraid') || q.get('gbraid') || '',
      fbclid:       q.get('fbclid')   || '',
      msclkid:      q.get('msclkid')  || '',
      referrer:     document.referrer || '',
      landing_path: window.location.pathname || ''
    };

    // Click IDs imply the channel even when the UTMs are missing.
    if (!a.utm_source && a.gclid)  { a.utm_source = 'google';   a.utm_medium = a.utm_medium || 'cpc'; }
    if (!a.utm_source && a.fbclid) { a.utm_source = 'facebook'; a.utm_medium = a.utm_medium || 'paidsocial'; }
    if (!a.utm_source && a.msclkid){ a.utm_source = 'bing';     a.utm_medium = a.utm_medium || 'cpc'; }

    // No UTMs and no click ID: classify from the referrer. Honest buckets only —
    // never invent a campaign name.
    if (!a.utm_source) {
      var host = '';
      try { host = a.referrer ? new URL(a.referrer).hostname.toLowerCase() : ''; } catch (e) { host = ''; }
      if (!host) {
        a.utm_source = 'direct';  a.utm_medium = 'none';
      } else if (/(^|\.)reecewindows\.com$/.test(host) || /(^|\.)getreecewindows\.com$/.test(host)) {
        a.utm_source = 'website'; a.utm_medium = 'internal';
      } else if (/google\.|bing\.|duckduckgo\.|yahoo\.|search\.brave/.test(host)) {
        a.utm_source = 'organic'; a.utm_medium = 'organic';
      } else {
        a.utm_source = host;      a.utm_medium = 'referral';
      }
    }
    return a;
  })();

  function apiPost(path, payload) {
    return fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    }).then(function(resp) {
      if (resp.status === 204) return null;
      return resp.json().catch(function() { return null; }).then(function(body) {
        if (!resp.ok) {
          var err = new Error((body && body.error) || ('API ' + path + ' failed (' + resp.status + ')'));
          err.status = resp.status;
          err.body = body || {};
          throw err;
        }
        return body;
      });
    });
  }

  // ============================================================
  //  REECE TRACKER BRIDGE
  //  Mirrors this calculator's funnel into Reece's own visitor tracker, so a
  //  calculator session shows up in LP Supabase site_events under the same
  //  visitor id as the rest of the visitor's browsing — that is what lets
  //  I.STITCH tie the visit to a GHL contact.
  //
  //  The host page loads the tracker, and it loads with `defer`, so this file
  //  can and does run first. Everything below therefore assumes ReeceTrack may
  //  be missing, may never arrive, and may throw. Analytics must never break
  //  the funnel: nothing in here is allowed to escape as an exception.
  // ============================================================
  var TRACKER_QUEUE_MAX = 50;      // events held while the tracker loads
  var TRACKER_WAIT_MS   = 10000;   // give up on a tracker that never arrives
  var TRACKER_POLL_MS   = 500;     // how often to look for it

  // Keys and values that must never leave this page as tracker props. The
  // tracker's identify() carries the lead's details deliberately; a funnel
  // event never should.
  var TRACKER_PII_KEY = /email|phone|name|address|street|zip/i;

  var trackerQueue    = [];
  var trackerTimer    = null;
  var trackerDeadline = 0;
  var trackerGaveUp   = false;

  function trackerReady() {
    return typeof window.ReeceTrack === 'object' && window.ReeceTrack !== null;
  }

  // Returns true when the tracker was present, whether or not the call itself
  // worked. A tracker that is loaded but throwing must not requeue forever.
  // One call handles both kinds so a track and an identify cannot be reordered
  // relative to each other.
  function trackerDeliver(entry) {
    if (!trackerReady()) return false;
    try {
      if (entry.kind === 'identify') {
        if (typeof window.ReeceTrack.identify === 'function') {
          window.ReeceTrack.identify(entry.traits);
        }
      } else if (typeof window.ReeceTrack.track === 'function') {
        window.ReeceTrack.track(entry.name, entry.props);
      }
    } catch (e) { /* never throw from analytics */ }
    return true;
  }

  function trackerFlush() {
    if (!trackerReady()) return false;
    var pending = trackerQueue;
    trackerQueue = [];
    for (var i = 0; i < pending.length; i++) trackerDeliver(pending[i]);
    return true;
  }

  function trackerWatch() {
    if (trackerTimer || trackerGaveUp) return;
    // The 10s budget starts at the FIRST queued event, not at each one, so a
    // late funnel step cannot keep extending a tracker that is never coming.
    trackerDeadline = Date.now() + TRACKER_WAIT_MS;
    trackerTimer = setInterval(function () {
      try {
        if (trackerFlush()) {
          clearInterval(trackerTimer);
          trackerTimer = null;
          return;
        }
        if (Date.now() >= trackerDeadline) {
          clearInterval(trackerTimer);
          trackerTimer = null;
          trackerGaveUp = true;
          trackerQueue  = [];   // drop it; the /api/events beacon still has these
        }
      } catch (e) {
        clearInterval(trackerTimer);
        trackerTimer = null;
      }
    }, TRACKER_POLL_MS);
  }

  function trackerEnqueue(entry) {
    if (trackerGaveUp) return;
    // Keep the FIRST 50. Dropping the tail preserves the order of what does
    // send, and the head of a funnel is the part worth having.
    if (trackerQueue.length >= TRACKER_QUEUE_MAX) return;
    trackerQueue.push(entry);
    trackerWatch();
  }

  // Deliver now if the tracker is up, otherwise queue. Anything already waiting
  // wins: this joins the back of the queue rather than overtaking it, so a call
  // made between the tracker arriving and the next poll tick cannot land first.
  function trackerSend(entry) {
    if (trackerQueue.length) {
      trackerEnqueue(entry);
      trackerFlush();
      return;
    }
    if (!trackerDeliver(entry)) trackerEnqueue(entry);
  }

  // Copy of extra.meta minus anything that identifies the lead.
  function trackerProps(extra) {
    var props = {
      page_variant:    PAGE_VARIANT,
      calc_session_id: CALC_SESSION_ID
    };
    if (extra && typeof extra.step === 'number') props.step = extra.step;
    var meta = extra && extra.meta;
    if (meta && typeof meta === 'object') {
      Object.keys(meta).forEach(function (key) {
        if (TRACKER_PII_KEY.test(key)) return;
        var value = meta[key];
        var asText = '';
        try { asText = value == null ? '' : String(value); } catch (e) { return; }
        if (asText.indexOf('@') !== -1) return;   // an address that slipped a key check
        props[key] = value;
      });
    }
    return props;
  }

  function trackerMirror(eventName, extra) {
    try {
      trackerSend({ kind: 'track', name: 'calc_' + eventName, props: trackerProps(extra) });
    } catch (e) { /* never throw from analytics */ }
  }

  // Policy-link clicks, mirrored as site-wide consent signals.
  //
  // Unprefixed on purpose. Every funnel step goes out as calc_*, because those
  // are steps in estimator_funnel_daily; these two are not funnel steps, they
  // are the named events LP-MCP's visitor tracking contract already reports on
  // (docs/visitor_tracking_install.md). Renaming them breaks that reporting.
  //
  // The click almost always lands BEFORE the form is submitted, so no GHL
  // contact exists yet. The value carried here is the visitor id the tracker
  // attaches; I.STITCH resolves it to a contact on its next pass once the lead
  // identifies. That is why the GHL trigger link alone is not enough — it can
  // count the click but cannot name the person.
  var POLICY_LINK_EVENTS = {
    'rc-link-privacy': 'privacy_policy_viewed',
    'rc-link-terms':   'terms_viewed'
  };

  // Delegated from the mount rather than from document, so a host page that
  // happens to carry its own policy links cannot fire these, and so the handler
  // survives the innerHTML render that builds the form.
  //
  // This never calls preventDefault and never throws: the link opens whether or
  // not anything was recorded. Analytics must never block a navigation.
  function watchPolicyLinks(root) {
    if (!root) return;
    root.addEventListener('click', function (e) {
      try {
        var el = e.target;
        if (!el || typeof el.closest !== 'function') return;
        var link = el.closest('#rc-link-privacy, #rc-link-terms');
        if (!link) return;
        var name = POLICY_LINK_EVENTS[link.id];
        if (!name) return;
        trackerSend({
          kind:  'track',
          name:  name,
          props: trackerProps({ meta: {
            page:    'estimate-calculator',
            surface: window.location.hostname
          } })
        });
      } catch (err) { /* never block the navigation */ }
    });
  }

  // The visitor id the tracker assigned this browser. Sent alongside the lead
  // so the two systems can be joined server-side later; '' whenever the tracker
  // is absent, which is always a normal outcome, never an error.
  function trackerVisitorId() {
    try {
      if (trackerReady() && typeof window.ReeceTrack.getVisitorId === 'function') {
        var id = window.ReeceTrack.getVisitorId();
        if (typeof id === 'string' && id) return id;
      }
    } catch (e) { /* never throw from analytics */ }
    return '';
  }

  // Last identify payload sent, so the same details are not re-sent. Step 1 and
  // Step 3 both upsert the contact and verification can follow, but only a
  // CHANGED set of details is worth another identify row for I.STITCH to match.
  var lastIdentity = '';

  // Ties this browser's visitor id to the person. Queued like the funnel events
  // when the tracker has not loaded yet: a lead who fills Step 1 faster than a
  // slow network delivers the script is exactly the lead worth identifying.
  function trackerIdentify() {
    try {
      var data = gatherContactData();
      var traits = {};
      if (data.email) traits.email = data.email;
      if (data.phone) traits.phone = data.phone;
      var fullName = (data.firstName + ' ' + data.lastName).trim();
      if (fullName) traits.name = fullName;
      // Nothing to match on — I.STITCH keys on cid, then email, then phone.
      if (!traits.email && !traits.phone) return;
      var signature = JSON.stringify(traits);
      if (signature === lastIdentity) return;
      lastIdentity = signature;
      trackerSend({ kind: 'identify', traits: traits });
    } catch (e) { /* never throw from analytics */ }
  }

  // Tells GHL external tracking who this visitor is (2026-09-29). A test contact
  // who used the funnel showed no page views in GHL. The script was loading
  // fine. It attaches a visit to a contact only through localStorage `_ud`
  // ({ customer_id }), which GHL writes when one of ITS forms is submitted.
  // It never reads the link, and this calculator renders no <form> for it to
  // capture. So every calculator lead stayed an anonymous GHL visitor. Writing
  // the id we already hold makes later GHL events from this browser carry the
  // contact. Page views before the submit stay anonymous; GHL has no way to
  // re-tag them. `_ud` is GHL's internal format, not a documented API. If they
  // rename it, visits simply go back to anonymous, which is why this only ever
  // writes and never reads anything back that the funnel depends on.
  var GHL_USER_DATA_KEY = '_ud';
  function ghlRememberContact(contactId) {
    try {
      if (!contactId || !window.localStorage) return;
      var existing = null;
      try { existing = JSON.parse(window.localStorage.getItem(GHL_USER_DATA_KEY) || 'null'); } catch (e) { existing = null; }
      // A GHL form already identified this browser, and wrote a richer record
      // than ours. Leave it alone.
      if (existing && typeof existing === 'object' && existing.customer_id) return;
      window.localStorage.setItem(GHL_USER_DATA_KEY, JSON.stringify({ customer_id: String(contactId) }));
    } catch (e) { /* storage can be blocked (private mode); never throw from analytics */ }
  }

  // First-party funnel events. Analytics must never break the funnel.
  function sendEvent(eventName, extra) {
    try {
      // Mirror to GTM so GA4 sees the funnel. Never let this throw.
      try {
        window.dataLayer = window.dataLayer || [];
        var dl = { event: 'calc_' + eventName, calc_page_variant: PAGE_VARIANT };
        if (extra && typeof extra.step === 'number') dl.calc_step = extra.step;
        if (extra && extra.meta && typeof extra.meta === 'object') {
          // estimate_total is the current key; total is kept so any older caller
          // still populates the GTM variable rather than dropping it silently.
          var dlTotal = extra.meta.estimate_total || extra.meta.total;
          if (dlTotal) dl.calc_estimate_total = dlTotal;
          if (extra.meta.window_count) dl.calc_window_count = extra.meta.window_count;
        }
        window.dataLayer.push(dl);
      } catch (e) {}
      var payload = {
        session_id: CALC_SESSION_ID,
        contact_id: state.contactId || null,
        event: eventName,
        client_ts: new Date().toISOString(),
        page_variant: PAGE_VARIANT,
        utm_source: ATTRIBUTION.utm_source,
        utm_medium: ATTRIBUTION.utm_medium,
        utm_campaign: ATTRIBUTION.utm_campaign,
        utm_content: ATTRIBUTION.utm_content,
        utm_term: ATTRIBUTION.utm_term
      };
      if (extra && typeof extra === 'object') {
        if (typeof extra.step === 'number') payload.step = extra.step;
        if (extra.meta && typeof extra.meta === 'object') payload.meta = extra.meta;
      }
      var body = JSON.stringify(payload);
      // text/plain keeps this a CORS-simple request. application/json forces a
      // preflight, and sendBeacon cannot perform one — cross-origin the event
      // would be dropped silently. server.js parses text/plain on /api/events.
      if (navigator.sendBeacon) {
        navigator.sendBeacon(API_BASE + '/api/events', new Blob([body], { type: 'text/plain' }));
      } else {
        fetch(API_BASE + '/api/events', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: body,
          keepalive: true
        }).catch(function() {});
      }
      // Mirror the same event into Reece's visitor tracker. This is additive:
      // the beacon above remains the calculator's own funnel table, and the
      // mirror is what puts the funnel next to the visitor's wider session.
      trackerMirror(eventName, extra);
    } catch (e) { /* never throw from analytics */ }
  }

  // Step 1 is visible from markup (section-1 carries "visible"), so goToStep(1)
  // never runs on load and no step_view was ever emitted for it — the funnel had
  // no denominator. Emit it once at init instead. The flag is shared with
  // goToStep() so the Back buttons, which DO call goToStep(1), cannot fire a
  // second one and inflate the denominator.
  // page_view is the funnel's top in estimator_funnel_daily and shares this same
  // one-shot guard: the view counts distinct sessions, and a Back button firing a
  // second page_view would not double-count but would add noise to detail queries.
  var _step1ViewSent = false;
  function sendStep1View() {
    if (_step1ViewSent) return;
    _step1ViewSent = true;
    sendEvent('page_view');
    sendEvent('step_view', { step: 1 });
  }
  // ============================================================
  //  GATHER CONTACT DATA FROM FORM FIELDS
  // ============================================================
  function gatherContactData() {
    var fullName = ($id("rc-full-name")?.value || "").trim();
    var nameParts = fullName.split(/\s+/);
    var firstName = nameParts[0] || "";
    var lastName = nameParts.slice(1).join(" ") || "";
    var phone = ($id("rc-phone")?.value || "").replace(/\D/g, '');
    var email = ($id("rc-email")?.value || "").trim();
    var street = ($id("rc-street-address")?.value || "").trim();
    var city = ($id("rc-city")?.value || "").trim();
    var state = ($id("rc-state")?.value || "").trim();
    var zip = ($id("rc-postal-code")?.value || "").trim();
    if (phone.length === 10) {
      phone = '+1' + phone;
    } else if (phone.length === 11 && phone.charAt(0) === '1') {
      phone = '+' + phone;
    }
    var params = new URLSearchParams(window.location.search);
    return {
      firstName: firstName,
      lastName: lastName,
      phone: phone,
      email: email,
      address1: street,
      city: city,
      state: state,
      postalCode: zip,
      utm: {
        source: ATTRIBUTION.utm_source,
        medium: ATTRIBUTION.utm_medium,
        campaign: ATTRIBUTION.utm_campaign,
        content: ATTRIBUTION.utm_content,
        term: ATTRIBUTION.utm_term
      },
      clickIds: {
        gclid: ATTRIBUTION.gclid,
        fbclid: ATTRIBUTION.fbclid,
        msclkid: ATTRIBUTION.msclkid
      },
      referrer: ATTRIBUTION.referrer,
      // URL wins; the default only fills the gap for untagged arrivals.
      lpSourceId: params.get("lp_source_id") || DEFAULT_LP_SOURCE_ID,
      proId: params.get("pro_id") || DEFAULT_PRO_ID,
      pageVariant: PAGE_VARIANT
    };
  }
  // ============================================================
  //  CONTACT SUBMIT (server-side GHL upsert)
  //  Step 1 sends without email; Step 3 re-sends with email.
  //  The server enforces consent and stamps the consent audit fields.
  // ============================================================
  function submitContact(includeEmail) {
    var data = gatherContactData();
    var payload = {
      firstName: data.firstName,
      lastName: data.lastName,
      phone: data.phone,
      address1: data.address1,
      city: data.city,
      state: data.state,
      postalCode: data.postalCode,
      utm: data.utm,
      clickIds: data.clickIds,
      referrer: data.referrer,
      lpSourceId: data.lpSourceId,
      proId: data.proId,
      pageVariant: PAGE_VARIANT,
      consent: !!($id('rc-consent-checkbox') && $id('rc-consent-checkbox').checked),
      consentVersion: CONSENT_VERSION
    };
    if (includeEmail && data.email) payload.email = data.email;
    // Server-side this is logged only. It exists so the visitor's browsing and
    // their GHL contact can be joined without waiting on a GHL custom field.
    var visitorId = trackerVisitorId();
    if (visitorId) payload.visitor_id = visitorId;
    return apiPost('/api/contact', payload).then(function(result) {
      if (result && result.contactId) {
        state.contactId = result.contactId;
        console.log('Contact upserted via server:', result.contactId);
        ghlRememberContact(result.contactId);
      }
      // Only once the upsert succeeded: I.STITCH matches identify rows against
      // GHL contacts, so identifying before the contact exists gives it nothing
      // to find on the next 5-minute pass.
      trackerIdentify();
      return result;
    });
  }
  // ============================================================
  //  GOOGLE PLACES ADDRESS AUTOCOMPLETE
  // ============================================================
  function initializeAddressForm() {
    var input = $id('rc-street-address');
    var autocomplete = new google.maps.places.Autocomplete(input, {
      types: ['address'],
      componentRestrictions: { country: 'us' }
    });
    autocomplete.setFields(['address_components', 'formatted_address']);
    autocomplete.addListener('place_changed', function() {
      var place = autocomplete.getPlace();
      if (!place.address_components) return;
      var streetNumber = '';
      var route = '';
      var city = '';
      var state = '';
      var postalCode = '';
      for (var i = 0; i < place.address_components.length; i++) {
        var component = place.address_components[i];
        var types = component.types;
        if (types.indexOf('street_number') !== -1) {
          streetNumber = component.long_name;
        }
        if (types.indexOf('route') !== -1) {
          route = component.long_name;
        }
        if (types.indexOf('locality') !== -1) {
          city = component.long_name;
        }
        if (types.indexOf('administrative_area_level_1') !== -1) {
          state = component.short_name;
        }
        if (types.indexOf('postal_code') !== -1) {
          postalCode = component.long_name;
        }
      }
      $id('rc-street-address').value = (streetNumber + ' ' + route).trim();
      $id('rc-city').value = city;
      $id('rc-state').value = state;
      $id('rc-postal-code').value = postalCode;
      // Clear validation errors on autofilled fields
      ['rc-field-street-address', 'rc-field-city', 'rc-field-state', 'rc-field-postal-code'].forEach(function(id) {
        $id(id).classList.remove('rc-field-error');
      });
    });
  }
  // ============================================================
  //  PRICE TABLE — united-inches lookup (width + height)
  //  Prices are total installed cost per window (vinyl frame).
  //  Categories: DH 2LS Pic, Case Awn, 3LS, HR Specialty
  // ============================================================
  const PRICE_TABLE = {
    dh_2ls_pic: [
      {min:0,max:72,nonImpact:1229,impact:1820},
      {min:73,max:78,nonImpact:1331,impact:1971},
      {min:79,max:84,nonImpact:1434,impact:2123},
      {min:85,max:90,nonImpact:1536,impact:2275},
      {min:91,max:96,nonImpact:1639,impact:2426},
      {min:97,max:102,nonImpact:1741,impact:2578},
      {min:103,max:108,nonImpact:1843,impact:2730},
      {min:109,max:114,nonImpact:1946,impact:2881},
      {min:115,max:120,nonImpact:2048,impact:3033},
      {min:121,max:126,nonImpact:2151,impact:3185},
      {min:127,max:132,nonImpact:2253,impact:3336},
      {min:133,max:138,nonImpact:2355,impact:3488},
      {min:139,max:144,nonImpact:2458,impact:3640},
      {min:145,max:150,nonImpact:2560,impact:3791},
      {min:151,max:156,nonImpact:2663,impact:3943},
      {min:157,max:162,nonImpact:2765,impact:4095},
      {min:163,max:168,nonImpact:2868,impact:4246},
      {min:169,max:174,nonImpact:2970,impact:4398}
    ],
    three_ls: [
      {min:0,max:72,nonImpact:1418,impact:2836},
      {min:73,max:78,nonImpact:1536,impact:3072},
      {min:79,max:84,nonImpact:1654,impact:3309},
      {min:85,max:90,nonImpact:1773,impact:3545},
      {min:91,max:96,nonImpact:1891,impact:3781},
      {min:97,max:102,nonImpact:2009,impact:4018},
      {min:103,max:108,nonImpact:2127,impact:4254},
      {min:109,max:114,nonImpact:2245,impact:4490},
      {min:115,max:120,nonImpact:2363,impact:4727},
      {min:121,max:126,nonImpact:2482,impact:4963},
      {min:127,max:132,nonImpact:2600,impact:5199},
      {min:133,max:138,nonImpact:2718,impact:5436},
      {min:139,max:144,nonImpact:2836,impact:5672},
      {min:145,max:150,nonImpact:2954,impact:5908},
      {min:151,max:156,nonImpact:3072,impact:6145},
      {min:157,max:162,nonImpact:3191,impact:6381},
      {min:163,max:168,nonImpact:3309,impact:6617},
      {min:169,max:174,nonImpact:3427,impact:6854}
    ],
    case_awn: [
      {min:0,max:72,nonImpact:1323,impact:2009},
      {min:73,max:78,nonImpact:1434,impact:2176},
      {min:79,max:84,nonImpact:1544,impact:2344},
      {min:85,max:90,nonImpact:1654,impact:2511},
      {min:91,max:96,nonImpact:1765,impact:2678},
      {min:97,max:102,nonImpact:1875,impact:2846},
      {min:103,max:108,nonImpact:1985,impact:3013},
      {min:109,max:114,nonImpact:2096,impact:3181},
      {min:115,max:120,nonImpact:2206,impact:3348},
      {min:121,max:126,nonImpact:2316,impact:3515},
      {min:127,max:132,nonImpact:2426,impact:3683},
      {min:133,max:138,nonImpact:2537,impact:3850},
      {min:139,max:144,nonImpact:2647,impact:4018},
      {min:145,max:150,nonImpact:2757,impact:4185},
      {min:151,max:156,nonImpact:2868,impact:4353},
      {min:157,max:162,nonImpact:2978,impact:4520},
      {min:163,max:168,nonImpact:3088,impact:4687},
      {min:169,max:174,nonImpact:3198,impact:4855}
    ],
    hr_specialty: [
      {min:0,max:72,nonImpact:1891,impact:2836},
      {min:73,max:78,nonImpact:2048,impact:3072},
      {min:79,max:84,nonImpact:2206,impact:3309},
      {min:85,max:90,nonImpact:2363,impact:3545},
      {min:91,max:96,nonImpact:2521,impact:3781},
      {min:97,max:102,nonImpact:2678,impact:4018},
      {min:103,max:108,nonImpact:2836,impact:4254},
      {min:109,max:114,nonImpact:2994,impact:4490},
      {min:115,max:120,nonImpact:3151,impact:4727},
      {min:121,max:126,nonImpact:3309,impact:4963},
      {min:127,max:132,nonImpact:3466,impact:5199},
      {min:133,max:138,nonImpact:3624,impact:5436},
      {min:139,max:144,nonImpact:3781,impact:5672},
      {min:145,max:150,nonImpact:3939,impact:5908},
      {min:151,max:156,nonImpact:4096,impact:6145},
      {min:157,max:162,nonImpact:4254,impact:6381},
      {min:163,max:168,nonImpact:4412,impact:6617},
      {min:169,max:174,nonImpact:4569,impact:6854}
    ]
  };
  // Style-to-category mapping for price table lookup
  const STYLE_CATEGORY = {
    single_hung: 'dh_2ls_pic',
    double_hung: 'dh_2ls_pic',
    sliding:     'dh_2ls_pic',
    picture:     'dh_2ls_pic',
    casement:    'case_awn',
    awning:      'case_awn',
    three_lite:  'three_ls',
    custom_shape:'hr_specialty'
  };
  // Size category mapping for S/M/L tile selector
  const SIZE_MAP = {
    small:  { width: 36, height: 36, label: 'Small',  desc: '~36\u2033\u00d736\u2033' },
    medium: { width: 36, height: 48, label: 'Medium', desc: '~36\u2033\u00d748\u2033' },
    large:  { width: 48, height: 60, label: 'Large',  desc: '~48\u2033\u00d760\u2033' }
  };
  // Add-ons, surcharges, and multipliers applied on top of chart prices
  const PRICING = {
    // Frame material multipliers (relative to base price)
    frameMaterial: {
      aluminum:   { mult: 0.70, label: 'Aluminum'   },
      vinyl:      { mult: 1.00, label: 'Vinyl'      },
      fiberglass: { mult: 1.35, label: 'Fiberglass' },
      wood:       { mult: 1.75, label: 'Wood'       },
      composite:  { mult: 1.45, label: 'Composite'  },
      clad_wood:  { mult: 2.00, label: 'Clad Wood'  }
    },
    // Glass pane costs (added to base)
    glassPanes: {
      single: { add: -80, label: 'Single Pane' },
      double: { add: 0,   label: 'Double Pane' },
      triple: { add: 200, label: 'Triple Pane' }
    },
    // Gas fill (added per window)
    gasFill: {
      air:     { add: 0,   label: 'Air (Standard)' },
      argon:   { add: 50,  label: 'Argon Gas Fill'  },
      krypton: { add: 100, label: 'Krypton Gas Fill' }
    },
    // Grid pattern (added per window)
    gridPattern: {
      none:     { add: 0,   label: 'No Grids'     },
      colonial: { add: 35,  label: 'Colonial Grid' },
      prairie:  { add: 40,  label: 'Prairie Grid'  },
      custom:   { add: 80,  label: 'Custom Grid'   }
    },
    // Glass upgrades (added per window)
    glassUpgrades: {
      low_e:    { add: 0, pct: 0.15, label: 'Low-E Coating'     },
      tempered: { add: 75,  pct: 0,  label: 'Tempered Glass'    },
      tinted:   { add: 115, pct: 0,  label: 'Tinted Glass'      },
      impact:   { add: 0, pct: 0,  label: 'Impact Resistant'  },
      obscure:  { add: 45,  pct: 0,  label: 'Obscure / Privacy' },
      sound:    { add: 150, pct: 0,  label: 'Sound Reduction'   }
    },
    // (Labor is included in the PRICE_TABLE chart prices)
    // Story surcharge (per window)
    stories: {
      '1': 0,
      '2': 35,
      '3': 65
    },
    // Permits
    permits: {
      none:     0,
      basic:    75,
      standard: 150,
      full:     250
    },
    // Disposal
    disposal: {
      included:   0,
      per_window: 40,
      dumpster:   400,
      self:       0
    },
  };
  // ============================================================
  //  STATE
  // ============================================================
  let windows = [];
  let editingIndex = -1;
  let videoPlayTimer = null;
  // ============================================================
  //  UI HELPERS
  // ============================================================
  function selectTile(el) {
    const group = el.parentElement;
    group.querySelectorAll('.rc-tile').forEach(t => t.classList.remove('rc-selected'));
    el.classList.add('rc-selected');
  }
  function toggleCheck(el) {
    setTimeout(() => {
      const cb = el.querySelector('input[type="checkbox"]');
      el.classList.toggle('rc-checked', cb.checked);
    }, 0);
  }
  function adjustQty(delta) {
    const inp = $id('rc-win-qty');
    let v = parseInt(inp.value) + delta;
    if (v < 1) v = 1;
    if (v > 50) v = 50;
    inp.value = v;
  }
  function handlePaneChange() {
    const panes = $id('rc-glass-panes').value;
    const gasFillField = $id('rc-gas-fill-field');
    const gasFill = $id('rc-gas-fill');
    if (panes === 'single') {
      // Single pane: hide gas fill, reset to Standard
      gasFill.innerHTML = '<option value="air" selected>Air (Standard)<\/option>';
      gasFillField.style.display = 'none';
    } else {
      // Double pane: show gas fill with Argon option
      gasFill.innerHTML =
        '<option value="air" selected>Air (Standard)<\/option>' +
        '<option value="argon">Argon Gas<\/option>';
      gasFillField.style.display = '';
    }
  }
  // ============================================================
  //  STEP 1 VALIDATION
  // ============================================================
  function validateAndGoToStep2() {
    const fields = [
      { id: 'rc-full-name', fieldId: 'rc-field-full-name' },
      { id: 'rc-street-address', fieldId: 'rc-field-street-address' },
      { id: 'rc-city', fieldId: 'rc-field-city' },
      { id: 'rc-state', fieldId: 'rc-field-state' },
      { id: 'rc-postal-code', fieldId: 'rc-field-postal-code' }
    ];
    let valid = true;
    fields.forEach(f => {
      const el = $id(f.id);
      const wrapper = $id(f.fieldId);
      if (!el.value.trim()) {
        wrapper.classList.add('rc-field-error');
        valid = false;
      } else {
        wrapper.classList.remove('rc-field-error');
      }
    });
    // Phone is required, must be at least 10 digits
    const phoneRaw = $id('rc-phone').value.replace(/\D/g, '');
    if (phoneRaw.length < 10) {
      $id('rc-field-phone').classList.add('rc-field-error');
      valid = false;
    } else {
      $id('rc-field-phone').classList.remove('rc-field-error');
    }
    // Consent is required before the phone number leaves this page
    var consentBox = $id('rc-consent-checkbox');
    if (!consentBox || !consentBox.checked) {
      $id('rc-field-consent').classList.add('rc-field-error');
      valid = false;
    } else {
      $id('rc-field-consent').classList.remove('rc-field-error');
    }
    if (!valid) {
      const firstError = $one('#rc-section-1 .rc-field-error input');
      if (firstError) firstError.focus();
      return;
    }
    sendEvent('consent_checked');
    // The GHL contact is created here — this is the lead, not Step 4. Always
    // trackSingle, never the untargeted form: the WordPress page initialises
    // three pixels, and an untargeted Lead would be reported to all of them.
    // The one-shot guard keeps Back -> Next from counting the same lead twice.
    if (!state.leadFired) {
      state.leadFired = true;
      if (typeof fbq === 'function') {
        fbq('trackSingle', META_PIXEL_ID, 'Lead', { page_variant: PAGE_VARIANT });
      }
    }
    submitContact(false).then(function() {
      sendEvent('step1_complete');
      goToStep(2);
    }).catch(function(err) {
      console.error('Contact submit failed:', err);
      sendEvent('contact_failed', { meta: { reason: String((err && err.status) || 'network') } });
      // The funnel continues; the Step 3 re-submit retries the upsert.
      goToStep(2);
    });
  }
  // ============================================================
  //  STEP 3 (CONTACT) VALIDATION
  // ============================================================
  function validateAndGoToStep4() {
    const phoneRaw = $id('rc-phone').value.replace(/\D/g, '');
    const email = $id('rc-email').value.trim();
    let valid = true;
    // Phone is required, must be at least 10 digits
    if (phoneRaw.length < 10) {
      $id('rc-field-phone').classList.add('rc-field-error');
      valid = false;
    } else {
      $id('rc-field-phone').classList.remove('rc-field-error');
    }
    // Email is required and must be valid format
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      $id('rc-field-email').classList.add('rc-field-error');
      valid = false;
    } else {
      $id('rc-field-email').classList.remove('rc-field-error');
    }
    if (!valid) {
      const firstError = $one('#rc-section-3 .rc-field-error input');
      if (firstError) firstError.focus();
      return;
    }
    sendEvent('step3_complete');
    // Consent was captured on Step 1. Re-upsert the contact with email attached,
    // then start server-side email verification. Step 4 is unreachable until the
    // server confirms the 6-digit code.
    submitContact(true).catch(function(err) {
      console.error('Contact upsert with email failed:', err);
    }).finally(function() {
      startEmailVerification();
    });
  }
  // ============================================================
  //  EMAIL VERIFICATION FLOW
  // ============================================================

  function startEmailVerification() {
    var email = $id('rc-email').value.trim();
    var data = gatherContactData();
    showVerificationModal(email);
    sendEvent('verify_sent');
    apiPost('/api/verify/start', {
      email: email,
      contactId: state.contactId || '',
      contactName: (data.firstName + ' ' + data.lastName).trim()
    }).then(function(result) {
      if (result && result.verifyId) state.verifyId = result.verifyId;
    }).catch(function(err) {
      console.error('[Verify] start failed:', err);
      var errorMsg = $id('rc-verify-error-msg');
      errorMsg.textContent = (err.status === 429)
        ? 'Too many codes requested. Please wait a bit and try Resend Code.'
        : 'We could not send the code. Please click Resend Code to try again.';
      errorMsg.classList.add('rc-visible');
    });
  }

  function showVerificationModal(email) {
    var modal = $id('rc-verify-email-modal');
    var display = $id('rc-verify-email-display');
    var input = $id('rc-verify-code-input');
    var errorMsg = $id('rc-verify-error-msg');
    var successMsg = $id('rc-verify-success-msg');
    display.textContent = email;
    input.value = '';
    input.classList.remove('rc-field-error');
    errorMsg.classList.remove('rc-visible');
    successMsg.classList.remove('rc-visible');
    modal.classList.add('rc-active');
    setTimeout(function() { input.focus(); }, 100);
  }

  function hideVerificationModal() {
    $id('rc-verify-email-modal').classList.remove('rc-active');
  }

  function verifyEnteredCode() {
    var input = $id('rc-verify-code-input');
    var entered = (input.value || '').trim();
    var errorMsg = $id('rc-verify-error-msg');
    var successMsg = $id('rc-verify-success-msg');
    if (entered.length !== 6 || !/^\d{6}$/.test(entered)) {
      input.classList.add('rc-field-error');
      errorMsg.textContent = 'Please enter the 6-digit code from your email.';
      errorMsg.classList.add('rc-visible');
      successMsg.classList.remove('rc-visible');
      return;
    }
    var btn = $id('rc-verify-submit-btn');
    if (btn) btn.disabled = true;
    apiPost('/api/verify/check', {
      verifyId: state.verifyId || '',
      code: entered
    }).then(function(result) {
      state.estimateToken = (result && result.estimateToken) || '';
      input.classList.remove('rc-field-error');
      errorMsg.classList.remove('rc-visible');
      successMsg.textContent = 'Verified! Loading your estimate...';
      successMsg.classList.add('rc-visible');
      sendEvent('verify_success');
      // Re-identify: the phone can be corrected during verification, and the
      // email is confirmed real only now. Skipped internally if nothing changed.
      trackerIdentify();
      if (typeof fbq === 'function') { fbq('trackSingleCustom', META_PIXEL_ID, 'CalcVerified'); }
      setTimeout(function() {
        hideVerificationModal();
        goToStep(4);
      }, 600);
    }).catch(function(err) {
      sendEvent('verify_failed', { meta: { reason: (err.body && err.body.error) || String(err.status || 'network') } });
      input.classList.add('rc-field-error');
      if (err.status === 503) {
        // Server can't issue the token — the code was fine, so don't say otherwise.
        errorMsg.textContent = 'Verification is temporarily unavailable. Please try again in a moment.';
      } else if (err.status === 410) {
        errorMsg.textContent = 'That code has expired. Click Resend Code for a fresh one.';
      } else if (err.status === 429) {
        errorMsg.textContent = 'Too many attempts. Click Resend Code to get a new code.';
      } else if (err.body && err.body.attemptsRemaining !== undefined) {
        errorMsg.textContent = 'Incorrect code. ' + err.body.attemptsRemaining + ' attempt' + (err.body.attemptsRemaining === 1 ? '' : 's') + ' remaining, or click Resend Code.';
      } else {
        errorMsg.textContent = 'Incorrect code. Please try again or click Resend Code.';
      }
      errorMsg.classList.add('rc-visible');
      successMsg.classList.remove('rc-visible');
      input.select();
    }).finally(function() {
      if (btn) btn.disabled = false;
    });
  }

  function resendVerificationCode() {
    var btn = $id('rc-verify-resend-btn');
    var email = $id('rc-email').value.trim();
    var data = gatherContactData();
    // Ask the server for a fresh code (new verifyId invalidates the old one)
    apiPost('/api/verify/start', {
      email: email,
      contactId: state.contactId || '',
      contactName: (data.firstName + ' ' + data.lastName).trim()
    }).then(function(result) {
      if (result && result.verifyId) state.verifyId = result.verifyId;
    }).catch(function(err) {
      console.error('[Verify] resend failed:', err);
    });
    sendEvent('verify_sent', { meta: { resend: true } });
    // 30-second cooldown
    btn.disabled = true;
    var seconds = 30;
    var originalText = 'Resend Code';
    btn.textContent = 'Resend Code (' + seconds + 's)';
    // Show success indicator for the resend action
    var errorMsg = $id('rc-verify-error-msg');
    var successMsg = $id('rc-verify-success-msg');
    errorMsg.classList.remove('rc-visible');
    successMsg.textContent = 'New code sent. Check your email (and spam folder).';
    successMsg.classList.add('rc-visible');
    setTimeout(function() {
      successMsg.classList.remove('rc-visible');
      successMsg.textContent = 'Verified! Loading your estimate...';
    }, 4000);
    var interval = setInterval(function() {
      seconds--;
      if (seconds <= 0) {
        clearInterval(interval);
        btn.disabled = false;
        btn.textContent = originalText;
      } else {
        btn.textContent = 'Resend Code (' + seconds + 's)';
      }
    }, 1000);
  }

  function changeEmail() {
    hideVerificationModal();
    var emailInput = $id('rc-email');
    emailInput.focus();
    emailInput.select();
  }
  // ============================================================
  //  PHONE AUTO-FORMATTER
  // ============================================================
  function setupPhoneFormatter() {
    const phoneInput = $id('rc-phone');
    if (!phoneInput) return;
    phoneInput.addEventListener('input', function(e) {
      let digits = e.target.value.replace(/\D/g, '');
      if (digits.length > 10) digits = digits.substring(0, 10);
      const match = digits.match(/(\d{0,3})(\d{0,3})(\d{0,4})/);
      if (!match) return;
      e.target.value = !match[2] ? match[1]
        : '(' + match[1] + ') ' + match[2] + (match[3] ? '-' + match[3] : '');
    });
  }
  // ============================================================
  //  STEP NAVIGATION — 4 STEPS
  // ============================================================
  function goToStep(n) {
    if (n === 1) { sendStep1View(); } else { sendEvent('step_view', { step: n }); }
    if (typeof fbq === 'function' && n >= 2) { fbq('trackSingleCustom', META_PIXEL_ID, 'CalcStep' + n); }
    $all('.rc-section').forEach(s => s.classList.remove('rc-visible'));
    $id('rc-section-' + n).classList.add('rc-visible');
    $all('.rc-stepper .rc-step').forEach(s => {
      const sn = parseInt(s.dataset.step);
      s.classList.remove('rc-active', 'rc-done');
      if (sn < n) s.classList.add('rc-done');
      if (sn === n) s.classList.add('rc-active');
    });
    // Show running total only on the estimate step (step 4). The bar belongs to
    // the host page, so it is optional — WordPress does not supply one.
    const runningTotal = hostEl(HOST_TOTAL_ID);
    if (runningTotal) runningTotal.style.display = (n === 4) ? '' : 'none';
    // Show sticky mobile CTA only on step 4
    var stickyCta = $one('.rc-sticky-cta');
    if (stickyCta) {
      if (n === 4) {
        stickyCta.classList.add('rc-visible');
        mountEl.classList.add('rc-step-4-active');
      } else {
        stickyCta.classList.remove('rc-visible');
        mountEl.classList.remove('rc-step-4-active');
      }
    }
    // Show "How This Works" only on step 1
    $id('rc-how-it-works').style.display = (n === 1) ? '' : 'none';
    // Build summary and auto-send PDF to GHL when arriving at estimate step
  if (n === 4) {
      buildSummary();
      // Only fire webhooks and PDF on first arrival at Step 4
      if (!state.estimateSent) {
        state.estimateSent = true;
        // Fire Facebook Lead event (once per session)
        if (typeof fbq === 'function') {
          fbq('trackSingle', META_PIXEL_ID, 'CompleteRegistration');
        }
        // Update contact with estimate data immediately (independent of PDF generation)
        var estimateTotal = state.latestEstimateTotal || "";
        var windowCount = state.latestWindowCount || 0;
        var contactId = state.contactId || null;
        var data = gatherContactData();
        var contactName = (data.firstName + ' ' + data.lastName).trim();
        sendEvent('estimate_completed', { meta: { estimate_total: estimateTotal, window_count: windowCount } });
        // One server call replaces the contact update, estimate webhook, and
        // PDF chain. Requires the token issued by /api/verify/check.
        var estimatePayload = {
          estimateToken: state.estimateToken || '',
          contactId: contactId || '',
          contactName: contactName,
          contactPhone: data.phone,
          contactEmail: data.email,
          estimateTotal: estimateTotal,
          windowCount: windowCount,
          pageVariant: PAGE_VARIANT,
          estimate: buildEstimatePayload()
        };
        // Logged server-side only, same as on /api/contact.
        var estimateVisitorId = trackerVisitorId();
        if (estimateVisitorId) estimatePayload.visitor_id = estimateVisitorId;
        apiPost('/api/estimate', estimatePayload).catch(function(err) {
          console.error('[Estimate] server submit failed, enabling retry:', err);
          state.estimateSent = false;
        });
      }
    }
    // Video playback: play on Step 2, pause on all other steps
    var video = $id('rc-intro-video');
    if (video) {
      if (n === 2) {
        // Entering Step 2: wait 2s then play once with sound
        if (videoPlayTimer) clearTimeout(videoPlayTimer);
        videoPlayTimer = setTimeout(function() {
          video.muted = false;
          video.loop = false;
          var playAttempt = video.play();
          if (playAttempt !== undefined) {
            playAttempt.catch(function() {
              video.muted = true;
              video.play().catch(function() {});
            });
          }
        }, 2000);
      } else {
        // Leaving Step 2: cancel pending play and pause
        if (videoPlayTimer) {
          clearTimeout(videoPlayTimer);
          videoPlayTimer = null;
        }
        video.pause();
      }
    }
    scrollToCalculator();
  }
  function getSelectedTile(groupId) {
    const sel = $one('#' + groupId + ' .rc-tile.rc-selected');
    return sel ? sel.dataset.value : null;
  }
  function getCheckedUpgrades() {
    const upgrades = [];
    $all('#glassUpgrades .check-item input[type="checkbox"]').forEach(cb => {
      if (cb.checked && !upgrades.includes(cb.value)) upgrades.push(cb.value);
    });
    return upgrades;
  }
  // ============================================================
  //  COST CALCULATION ENGINE
  // ============================================================
  // Look up base installed price from the chart by united inches
  function lookupBasePrice(unitedInches, category, isImpact) {
    const table = PRICE_TABLE[category];
    for (var i = 0; i < table.length; i++) {
      if (unitedInches >= table[i].min && unitedInches <= table[i].max) {
        return isImpact ? table[i].impact : table[i].nonImpact;
      }
    }
    // Above max bracket — use last row
    var last = table[table.length - 1];
    return isImpact ? last.impact : last.nonImpact;
  }
  function calculateWindowCost(config) {
    const frame = PRICING.frameMaterial[config.frame];
    const panes = PRICING.glassPanes[config.panes];
    const gas   = PRICING.gasFill[config.gas];
    const grid  = PRICING.gridPattern[config.grid];
    const storySurcharge = PRICING.stories[config.stories];
    // 1) United inches and category lookup
    const unitedInches = config.width + config.height;
    const category = STYLE_CATEGORY[config.style];
    const isImpact = config.upgrades.includes('impact');
    // 2) Base installed price from chart (includes labor)
    const chartPrice = lookupBasePrice(unitedInches, category, isImpact);
    // 3) Apply frame material multiplier (vinyl = 1.0 baseline)
    let windowCost = chartPrice * frame.mult;
    // 4) Glass panes add-on
    const glassCost = panes.add;
    windowCost += glassCost;
    // 5) Gas fill
    windowCost += gas.add;
    // 6) Grid pattern
    windowCost += grid.add;
    // 7) Glass upgrades (skip impact — it's in the chart column)
    let upgradesCost = 0;
    config.upgrades.forEach(u => {
      if (u === 'impact') return; // handled by chart column
      const up = PRICING.glassUpgrades[u];
      if (!up) return;
      if (u === 'low_e') {
        upgradesCost += windowCost * up.pct;
      } else {
        upgradesCost += up.add;
      }
    });
    windowCost += upgradesCost;
    // 8) Story surcharge
    windowCost += storySurcharge;
    const perWindowCost = windowCost;
    return {
      perWindowCost: round2(perWindowCost),
      totalCost: round2(perWindowCost * config.qty),
      qty: config.qty,
      unitedInches,
      isImpact,
      breakdown: {
        chartPrice: chartPrice,
        frameMult: round2(chartPrice * frame.mult - chartPrice),
        glassPanes: glassCost,
        gasFill: gas.add,
        grid: grid.add,
        upgrades: round2(upgradesCost),
        storySurcharge: storySurcharge
      }
    };
  }
  function isStandardSize(style, w, h) {
    const standards = {
      single_hung: { w: [24,28,32,36,40,44,48], h: [36,44,48,52,54,60,62,72] },
      double_hung: { w: [24,28,32,36,40,44,48], h: [36,44,48,52,54,60,62,72] },
      casement:    { w: [16,20,24,28,32,36,40,44,48], h: [24,36,48,54,60,72,84] },
      sliding:     { w: [36,48,60,72,84], h: [24,36,48,60] },
      awning:      { w: [20,24,28,32,36,40,48,60], h: [20,24,28,36,48] },
      picture:     { w: [24,36,48,60,72,96], h: [24,36,48,60,72,96] },
      three_lite:  { w: [36,48,60,72,84,96,108,120], h: [36,48,60,72] },
      custom_shape:{ w: [24,36,48,60,72,96], h: [24,36,48,60,72,96] }
    };
    const s = standards[style];
    if (!s) return false;
    return s.w.includes(w) && s.h.includes(h);
  }
  function round2(n) { return Math.round(n * 100) / 100; }
  function fmt(n) { return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  // ============================================================
  //  WINDOW LIST MANAGEMENT
  // ============================================================
  function getWindowConfig() {
    var size = getSelectedTile('rc-window-size') || 'medium';
    var dims = SIZE_MAP[size];
    return {
      style: getSelectedTile('rc-window-style') || 'single_hung',
      frame: getSelectedTile('rc-frame-material') || 'vinyl',
      panes: $id('rc-glass-panes').value,
      gas: $id('rc-gas-fill').value,
      grid: $id('rc-grid-pattern').value,
      upgrades: getCheckedUpgrades(),
      size: size,
      width: dims.width,
      height: dims.height,
      qty: parseInt($id('rc-win-qty').value) || 1,
      installType: DEFAULTS.installType,
      stories: $id('rc-stories').value
    };
  }
  function getWindowLabel(config) {
    const styleLabels = {
      single_hung: 'Single-Hung', double_hung: 'Double-Hung', casement: 'Casement',
      sliding: 'Sliding', awning: 'Awning', picture: 'Picture', three_lite: 'Three Lite Slider', custom_shape: 'Custom Shape'
    };
    const frameLabels = PRICING.frameMaterial[config.frame].label;
    const sizeLabel = SIZE_MAP[config.size] ? SIZE_MAP[config.size].label : (config.width + '\u2033x' + config.height + '\u2033');
    return styleLabels[config.style] + ' - ' + frameLabels + ' - ' + sizeLabel;
  }
  function addWindow() {
    const config = getWindowConfig();
    const cost = calculateWindowCost(config);
    sendEvent('window_added', { meta: { size: config.size, style: config.style, qty: config.qty } });
    if (editingIndex >= 0) {
      windows[editingIndex] = { config, cost };
      editingIndex = -1;
    } else {
      windows.push({ config, cost });
    }
    renderWindowList();
    updateRunningTotal();
    $id('rc-win-qty').value = 1;
  }
  function editWindow(idx) {
    const w = windows[idx];
    const c = w.config;
    editingIndex = idx;
    $all('#rc-window-style .rc-tile').forEach(t => {
      t.classList.toggle('rc-selected', t.dataset.value === c.style);
    });
    $all('#rc-frame-material .rc-tile').forEach(t => {
      t.classList.toggle('rc-selected', t.dataset.value === c.frame);
    });
    $id('rc-glass-panes').value = c.panes;
    handlePaneChange();
    $id('rc-gas-fill').value = c.gas;
    $id('rc-grid-pattern').value = c.grid;
    $all('#rc-window-size .rc-tile').forEach(t => {
      t.classList.toggle('rc-selected', t.dataset.value === c.size);
    });
    $id('rc-win-qty').value = c.qty;
    $all('#rc-glass-upgrades .rc-check-item').forEach(item => {
      const cb = item.querySelector('input[type="checkbox"]');
      const checked = c.upgrades.includes(cb.value);
      cb.checked = checked;
      item.classList.toggle('rc-checked', checked);
    });
    scrollToCalculator();
  }
  function removeWindow(idx) {
    windows.splice(idx, 1);
    renderWindowList();
    updateRunningTotal();
  }
  // ============================================================
  //  ENHANCED CART RENDERING
  // ============================================================
  function renderWindowList() {
    const list = $id('rc-window-list');
    if (windows.length === 0) {
      list.innerHTML = '<div class="rc-empty-state">No windows added yet. Configure a window above and click "Add Window to Estimate".<\/div>';
      $id('rc-btn-to-step3').disabled = true;
      return;
    }
    $id('rc-btn-to-step3').disabled = false;
    let html = '';
    windows.forEach((w, i) => {
      const c = w.config;
      const cost = w.cost;
      const label = getWindowLabel(c);
      // Configuration details tags
      const detailTags = [];
      detailTags.push(PRICING.glassPanes[c.panes].label);
      if (c.gas !== 'air') detailTags.push(PRICING.gasFill[c.gas].label);
      if (c.grid !== 'none') detailTags.push(PRICING.gridPattern[c.grid].label);
      // Upgrade tags
      const upgradeTags = c.upgrades
        .map(u => PRICING.glassUpgrades[u] ? PRICING.glassUpgrades[u].label : null)
        .filter(Boolean);
      // Modifier tags
      const modifierTags = [];
      if (c.stories !== '1') {
        modifierTags.push(c.stories === '2' ? '2-Story' : '3+ Story');
      }
      if (cost.isImpact) {
        modifierTags.push('Impact Rated');
      }
      html += '<div class="rc-cart-item">' +
        '<div class="rc-cart-item-header">' +
          '<div class="rc-cart-item-title">' +
            '<strong>#' + (i + 1) + '<\/strong> ' + label +
            (c.qty > 1 ? ' <span class="rc-cart-qty">&times; ' + c.qty + '<\/span>' : '') +
          '<\/div>' +
          '<div class="rc-we-actions">' +
            '<button class="rc-btn-sm rc-btn-edit" onclick="ReeceCalculator.editWindow(' + i + ')">Edit<\/button>' +
            '<button class="rc-btn-sm rc-btn-delete" onclick="ReeceCalculator.removeWindow(' + i + ')">Remove<\/button>' +
          '<\/div>' +
        '<\/div>' +
        '<div class="rc-cart-item-details">';
      detailTags.forEach(tag => {
        html += '<span class="rc-cart-tag">' + tag + '<\/span>';
      });
      upgradeTags.forEach(tag => {
        html += '<span class="rc-cart-tag rc-cart-tag-upgrade">' + tag + '<\/span>';
      });
      modifierTags.forEach(tag => {
        html += '<span class="rc-cart-tag rc-cart-tag-modifier">' + tag + '<\/span>';
      });
      html += '<\/div>' +
      '<\/div>';
    });
    list.innerHTML = html;
  }
  function updateRunningTotal() {
    let windowTotal = 0;
    windows.forEach(w => { windowTotal += w.cost.totalCost; });
    const permitFee = round2(windowTotal * 0.03);
    const total = windowTotal + permitFee;
    var totalBar = hostEl(HOST_TOTAL_ID);
    var totalEl = totalBar && totalBar.querySelector('span');
    if (totalEl) totalEl.textContent = fmt(total);
  }
  function getProjectCosts() {
    const totalWindowCount = windows.reduce((sum, w) => sum + w.config.qty, 0);
    let bulkDiscount = 0;
    if (totalWindowCount >= 10) {
      bulkDiscount = 0.10;
    } else if (totalWindowCount >= 6) {
      bulkDiscount = 0.05;
    }
    let windowSubtotal = 0;
    windows.forEach(w => { windowSubtotal += w.cost.totalCost; });
    const permitCost = round2(windowSubtotal * 0.03);
    return {
      permit: permitCost,
      bulkDiscountRate: bulkDiscount,
      total: permitCost,
      windowCount: totalWindowCount
    };
  }
  // ============================================================
  //  BUILD ESTIMATE PAYLOAD FOR PDF MICROSERVICE
  //  Serializes the current estimate state (windows[], form fields,
  //  PRICING labels) into the JSON structure the Railway Puppeteer
  //  service expects. Replaces DOM-scraping + html2pdf.
  // ============================================================
  function buildEstimatePayload() {
    var custName = ($id('rc-full-name').value || '').trim();
    var custAddress = ($id('rc-street-address').value || '').trim();
    var custCity = ($id('rc-city').value || '').trim();
    var custState = ($id('rc-state').value || '').trim();
    var custPostal = ($id('rc-postal-code').value || '').trim();
    var custPhone = ($id('rc-phone').value || '').trim();
    var custEmail = ($id('rc-email').value || '').trim();
    var storiesVal = $id('rc-stories').value;
    var storiesLabel = storiesVal === '1' ? '1 Story' : storiesVal === '2' ? '2 Stories' : '3+ Stories';

    var project = getProjectCosts();
    var windowSubtotal = 0;
    var totalWindows = 0;

    var windowData = windows.map(function(w, i) {
      var c = w.config;
      var cost = w.cost;
      windowSubtotal += cost.totalCost;
      totalWindows += c.qty;

      var sizeInfo = SIZE_MAP[c.size] || { label: 'Custom', desc: c.width + '\u2033x' + c.height + '\u2033' };

      var upgradeLabels = (c.upgrades || [])
        .filter(function(u) { return u !== 'impact'; })
        .map(function(u) {
          return PRICING.glassUpgrades[u] ? PRICING.glassUpgrades[u].label : u;
        });

      return {
        index: i + 1,
        label: getWindowLabel(c),
        style: c.style,
        styleLabel: getStyleLabel(c.style),
        frame: c.frame,
        frameLabel: PRICING.frameMaterial[c.frame].label,
        size: c.size,
        sizeLabel: sizeInfo.label,
        width: c.width,
        height: c.height,
        unitedInches: cost.unitedInches,
        qty: c.qty,
        isImpact: cost.isImpact,
        panes: c.panes,
        panesLabel: PRICING.glassPanes[c.panes].label,
        gas: c.gas,
        gasLabel: PRICING.gasFill[c.gas].label,
        grid: c.grid,
        gridLabel: PRICING.gridPattern[c.grid].label,
        upgrades: c.upgrades,
        upgradeLabels: upgradeLabels,
        perWindowCost: cost.perWindowCost,
        totalCost: cost.totalCost,
        breakdown: cost.breakdown
      };
    });

    var bulkDiscountAmt = project.bulkDiscountRate > 0 ? round2(windowSubtotal * project.bulkDiscountRate) : 0;
    var subtotalBeforePermit = round2(windowSubtotal - bulkDiscountAmt);
    var permitFee = round2(subtotalBeforePermit * 0.03);
    var grandTotal = round2(subtotalBeforePermit + permitFee);
    var lowEstimate = round2(grandTotal * 0.80);
    var highEstimate = round2(grandTotal * 1.20);

    return {
      customer: {
        name: custName,
        address: custAddress,
        city: custCity,
        state: custState,
        postalCode: custPostal,
        phone: custPhone,
        email: custEmail
      },
      project: {
        totalWindows: totalWindows,
        installationType: 'Full-Frame Replacement',
        buildingStories: storiesLabel,
        storiesValue: storiesVal
      },
      windows: windowData,
      costs: {
        windowSubtotal: round2(windowSubtotal),
        bulkDiscountRate: project.bulkDiscountRate,
        bulkDiscountAmount: bulkDiscountAmt,
        subtotalBeforePermit: subtotalBeforePermit,
        permitFee: permitFee,
        grandTotal: grandTotal,
        lowEstimate: lowEstimate,
        highEstimate: highEstimate,
        monthlyLow: Math.round(lowEstimate * 0.0107),
        monthlyAvg: Math.round(grandTotal * 0.0107)
      }
    };
  }
  // ============================================================
  //  SUMMARY BUILDER
  // ============================================================
  function buildSummary() {
    const project = getProjectCosts();
    let windowSubtotal = 0;
    let totalWindows = 0;
    let windowRows = '';
    windows.forEach((w, i) => {
      const c = w.config;
      const cost = w.cost;
      const label = getWindowLabel(c);
      windowSubtotal += cost.totalCost;
      totalWindows += c.qty;
      const impactLabel = cost.isImpact ? ' <span style="letter-spacing:0.3px;">(Impact)<\/span>' : '';
      windowRows += '<tr>' +
        '<td colspan="4" style="font-weight:700; background:#F2F3F7; color:#0D2240;">' +
          '#' + (i + 1) + ' ' + label + ' ' + (c.qty > 1 ? '&times; ' + c.qty : '') +
          impactLabel +
        '<\/td>' +
      '<\/tr>';
      var sizeDesc = SIZE_MAP[c.size] ? SIZE_MAP[c.size].label : (cost.unitedInches + ' UI');
      windowRows += '<tr><td style="padding-left:calc(1.5 * var(--rc-rem));">Base Price (' + getStyleLabel(c.style) + (cost.isImpact ? ', Impact' : '') + ', ' + sizeDesc + ')<\/td><td>' + fmt(cost.breakdown.chartPrice) + '<\/td><td>&times; ' + c.qty + '<\/td><td>' + fmt(cost.breakdown.chartPrice * c.qty) + '<\/td><\/tr>';
      if (cost.breakdown.frameMult !== 0) {
        windowRows += '<tr><td style="padding-left:calc(1.5 * var(--rc-rem));">Frame Adj. (' + PRICING.frameMaterial[c.frame].label + ')<\/td><td>' + fmt(cost.breakdown.frameMult) + '<\/td><td>&times; ' + c.qty + '<\/td><td>' + fmt(cost.breakdown.frameMult * c.qty) + '<\/td><\/tr>';
      }
      if (cost.breakdown.glassPanes !== 0) {
        windowRows += '<tr><td style="padding-left:calc(1.5 * var(--rc-rem));">' + PRICING.glassPanes[c.panes].label + '<\/td><td>' + fmt(cost.breakdown.glassPanes) + '<\/td><td>&times; ' + c.qty + '<\/td><td>' + fmt(cost.breakdown.glassPanes * c.qty) + '<\/td><\/tr>';
      }
      if (cost.breakdown.gasFill > 0) {
        windowRows += '<tr><td style="padding-left:calc(1.5 * var(--rc-rem));">' + PRICING.gasFill[c.gas].label + '<\/td><td>' + fmt(cost.breakdown.gasFill) + '<\/td><td>&times; ' + c.qty + '<\/td><td>' + fmt(cost.breakdown.gasFill * c.qty) + '<\/td><\/tr>';
      }
      if (cost.breakdown.grid > 0) {
        windowRows += '<tr><td style="padding-left:calc(1.5 * var(--rc-rem));">' + PRICING.gridPattern[c.grid].label + '<\/td><td>' + fmt(cost.breakdown.grid) + '<\/td><td>&times; ' + c.qty + '<\/td><td>' + fmt(cost.breakdown.grid * c.qty) + '<\/td><\/tr>';
      }
      if (cost.breakdown.upgrades > 0) {
        const upgradeLabels = c.upgrades.filter(u => u !== 'impact').map(u => PRICING.glassUpgrades[u] ? PRICING.glassUpgrades[u].label : u).join(', ');
        windowRows += '<tr><td style="padding-left:calc(1.5 * var(--rc-rem));">Upgrades (' + upgradeLabels + ')<\/td><td>' + fmt(cost.breakdown.upgrades) + '<\/td><td>&times; ' + c.qty + '<\/td><td>' + fmt(cost.breakdown.upgrades * c.qty) + '<\/td><\/tr>';
      }
      if (cost.breakdown.storySurcharge > 0) {
        windowRows += '<tr><td style="padding-left:calc(1.5 * var(--rc-rem));">Story Surcharge<\/td><td>' + fmt(cost.breakdown.storySurcharge) + '<\/td><td>&times; ' + c.qty + '<\/td><td>' + fmt(cost.breakdown.storySurcharge * c.qty) + '<\/td><\/tr>';
      }
      windowRows += '<tr class="rc-subtotal"><td style="padding-left:calc(1.5 * var(--rc-rem));">Subtotal<\/td><td>' + fmt(cost.perWindowCost) + '<\/td><td>&times; ' + c.qty + '<\/td><td>' + fmt(cost.totalCost) + '<\/td><\/tr>';
    });
    // Bulk discount
    let bulkDiscountAmt = 0;
    if (project.bulkDiscountRate > 0) {
      bulkDiscountAmt = round2(windowSubtotal * project.bulkDiscountRate);
    }
    const subtotalBeforePermit = round2(windowSubtotal - bulkDiscountAmt);
    const permitFee = round2(subtotalBeforePermit * 0.03);
    const grandTotal = round2(subtotalBeforePermit + permitFee);
    state.latestEstimateTotal = grandTotal;
    state.latestWindowCount = totalWindows;
    // Cost range
    const lowEstimate = round2(grandTotal * 0.80);
    const highEstimate = round2(grandTotal * 1.20);
    // Customer info
    const custName = $id('rc-full-name').value.trim();
    const custAddress = $id('rc-street-address').value.trim();
    const custCity = $id('rc-city').value.trim();
    const custState = $id('rc-state').value.trim();
    const custPostal = $id('rc-postal-code').value.trim();
    // Contact info from step 3
    const custPhone = $id('rc-phone').value.trim();
    const custEmail = $id('rc-email').value.trim();
    // ===== PRICE HERO BLOCK =====
    var estMonthlyLow = Math.round(lowEstimate * 0.0107);
    var estMonthlyAvg = Math.round(grandTotal * 0.0107);
    // Expose range + monthly for webhook payload
    state.latestEstimateLow = lowEstimate;
    state.latestEstimateHigh = highEstimate;
    state.latestMonthlyLow = estMonthlyLow;
    state.latestMonthlyAvg = estMonthlyAvg;

    let html = '<div class="rc-estimate-hero">' +
      '<h3>Estimated Project Investment<\/h3>' +
      '<p class="rc-hero-price">' + fmt(grandTotal) + '<\/p>' +
      '<p class="rc-hero-descriptor">Full-Frame Replacement | ' + totalWindows + ' Impact-Rated Windows<\/p>' +
      '<p class="rc-hero-credibility">Florida-Engineered | Impact-Rated | In-House Installation<\/p>' +
      '<p class="rc-monthly-amount">Estimated $' + estMonthlyLow.toLocaleString() + '\u2013$' + estMonthlyAvg.toLocaleString() + ' per month*<\/p>' +
      '<p class="rc-monthly-sub">Payment options available.<\/p>' +
      '<p class="rc-monthly-sub">No traditional credit score required.<\/p>' +
      '<p class="rc-monthly-footnote">*Example based on estimated project total. Final terms are confirmed during verification.<\/p>' +
    '<\/div>';

    // ===== SECTION DIVIDER =====
    html += '<div class="rc-section-divider"><\/div>';

    // ===== STRUCTURED STARTING POINT =====
    html += '<div class="rc-summary-section rc-structured-starting-point">' +
      '<h3>Your Estimate Is Structured and Verifiable<\/h3>' +
      '<p style="font-size:calc(0.85 * var(--rc-rem)); color:var(--charcoal); margin-bottom:calc(0.5 * var(--rc-rem));">This estimate reflects the window selections and preliminary measurements you provided.<\/p>' +
      '<p style="font-size:calc(0.85 * var(--rc-rem)); color:var(--charcoal); margin-bottom:calc(0.35 * var(--rc-rem));">Before materials are ordered, we verify:<\/p>' +
      '<ul style="padding-left:calc(1.25 * var(--rc-rem)); margin:calc(0.25 * var(--rc-rem)) 0 calc(0.5 * var(--rc-rem)) 0;">' +
        '<li style="font-size:calc(0.85 * var(--rc-rem)); color:var(--charcoal); line-height:1.6;">Exact opening dimensions<\/li>' +
        '<li style="font-size:calc(0.85 * var(--rc-rem)); color:var(--charcoal); line-height:1.6;">Installation conditions<\/li>' +
        '<li style="font-size:calc(0.85 * var(--rc-rem)); color:var(--charcoal); line-height:1.6;">Florida code compliance requirements<\/li>' +
        '<li style="font-size:calc(0.85 * var(--rc-rem)); color:var(--charcoal); line-height:1.6;">Geographic scheduling zone eligibility<\/li>' +
      '<\/ul>' +
      '<p style="font-size:calc(0.85 * var(--rc-rem)); color:var(--charcoal);">This protects you from unexpected changes \u2014 up or down.<\/p>' +
    '<\/div>';
    // ===== ESTIMATED RANGE BLOCK =====
    html += '<div class="rc-estimate-range">' +
      '<p class="rc-range-label">Estimated Range<\/p>' +
      '<p class="rc-range-values">' + fmt(lowEstimate) + ' \u2013 ' + fmt(highEstimate) + '<\/p>' +
      '<p>Most verified projects remain within this range.<\/p>' +
      '<p>Final pricing is confirmed during professional verification.<\/p>' +
      '<p style="margin-top:calc(0.5 * var(--rc-rem)); font-size:calc(0.78 * var(--rc-rem)); color:var(--text-gray);">This range reflects final measurement confirmation, installation conditions, and code compliance requirements.<\/p>' +
    '<\/div>';
    // ===== PROJECT SUMMARY HEADER =====
    html += '<h3 class="rc-project-summary-header">Project Summary<\/h3>';
    // ===== CUSTOMER INFORMATION =====
    html += '<div class="rc-summary-section">' +
      '<h3>Customer Information<\/h3>' +
      '<table class="rc-summary-table">' +
        '<tr><td>Name<\/td><td>' + custName + '<\/td><\/tr>' +
        '<tr><td>Address<\/td><td>' + custAddress + ', ' + custCity + ', ' + custState + ' ' + custPostal + '<\/td><\/tr>' +
        '<tr><td>Phone<\/td><td>' + custPhone + '<\/td><\/tr>' +
        (custEmail ? '<tr><td>Email<\/td><td>' + custEmail + '<\/td><\/tr>' : '') +
      '<\/table>' +
    '<\/div>';
    // ===== PROJECT OVERVIEW =====
    html += '<div class="rc-summary-section">' +
      '<h3>Project Overview<\/h3>' +
      '<table class="rc-summary-table">' +
        '<tr><td>Total Windows<\/td><td>' + totalWindows + '<\/td><\/tr>' +
        '<tr><td>Installation Type<\/td><td>Full-Frame Replacement<\/td><\/tr>' +
        '<tr><td>Building Stories<\/td><td>' + ($id('rc-stories').value === '1' ? '1 Story' : $id('rc-stories').value === '2' ? '2 Stories' : '3+ Stories') + '<\/td><\/tr>' +
      '<\/table>' +
    '<\/div>';
    // ===== ITEMIZED BREAKDOWN =====
    html += '<div class="rc-summary-section" id="rc-print-break-itemized">' +
      '<h3>Itemized Breakdown<\/h3>' +
      '<table class="rc-summary-table">' +
        '<thead><tr><th>Item<\/th><th>Per Unit<\/th><th>Qty<\/th><th style="text-align:right;">Total<\/th><\/tr><\/thead>' +
        '<tbody>' + windowRows + '<\/tbody>' +
      '<\/table>' +
    '<\/div>';
    // ===== PROJECT COSTS =====
    html += '<div class="rc-summary-section" id="rc-print-break-costs">' +
      '<h3>Project Costs<\/h3>' +
      '<table class="rc-summary-table">' +
        '<tr><td>Windows Subtotal (incl. installation)<\/td><td>' + fmt(windowSubtotal) + '<\/td><\/tr>';
    if (bulkDiscountAmt > 0) {
      html += '<tr><td>Project Efficiency Adjustment (' + totalWindows + '-Window Scope)<\/td><td style="color:var(--cta-red);">-' + fmt(bulkDiscountAmt) + '<\/td><\/tr>';
    }
    html += '<tr><td>Permit Fee (3%)<\/td><td>' + fmt(permitFee) + '<\/td><\/tr>';
    html += '<tr class="rc-total"><td>Estimated Total<\/td><td>' + fmt(grandTotal) + '<\/td><\/tr>' +
      '<\/table>' +
    '<\/div>';
    // ===== POTENTIAL SAVINGS =====
    html += '<div class="rc-summary-section">' +
      '<h3>Potential Savings<\/h3>' +
      '<ul style="padding-left:calc(1.25 * var(--rc-rem)); margin:calc(0.25 * var(--rc-rem)) 0 calc(0.5 * var(--rc-rem)) 0;">' +
        '<li style="font-size:calc(0.85 * var(--rc-rem)); color:var(--charcoal); line-height:1.6;">Estimated 12% annual heating/cooling efficiency improvement (varies by home)<\/li>' +
      '<\/ul>' +
      '<p style="font-size:calc(0.82 * var(--rc-rem)); color:var(--text-gray); margin-top:calc(0.35 * var(--rc-rem));">Savings eligibility is confirmed during professional verification.<\/p>' +
    '<\/div>';
    // ===== HOW SCHEDULING CAN INFLUENCE FINAL PRICING =====
    html += '<div class="rc-routing-section">' +
      '<h3>How Scheduling Can Influence Final Pricing<\/h3>' +
      '<p>We organize installations by geographic zones.<\/p>' +
      '<p>When multiple homes in the same area are completed during the same installation cycle, operational efficiencies may apply.<\/p>' +
      '<p>These efficiencies can reduce:<\/p>' +
      '<ul>' +
        '<li>Crew travel time<\/li>' +
        '<li>Equipment staging costs<\/li>' +
        '<li>Material handling redundancies<\/li>' +
      '<\/ul>' +
      '<p>When routing efficiencies apply, they are reflected in final pricing.<\/p>' +
      '<p>Unverified estimates are not assigned to an installation zone.<\/p>' +
      '<p>Early confirmation improves access to the most efficient installation cycle.<\/p>' +
    '<\/div>';
    $id('rc-summary-content').innerHTML = html;
    updateRunningTotal();
  }
  function printEstimate() {
    var printRoot = $id('rc-print-root');
    printRoot.innerHTML = '';

    // 1. Clone the host page's banner, when it offers one — WordPress does not.
    var siteHeader = hostEl(HOST_HEADER_ID);
    if (siteHeader) {
      var headerDiv = document.createElement('div');
      headerDiv.className = 'rc-print-header';
      headerDiv.innerHTML = siteHeader.innerHTML;
      printRoot.appendChild(headerDiv);
    }

    // 2. Clone summary content
    var summaryEl = $id('rc-summary-content');
    var contentClone = summaryEl.cloneNode(true);
    contentClone.removeAttribute('id');

    // 3. Build Page 1 content wrapper
    var page1 = document.createElement('div');
    page1.className = 'rc-print-page-1-content';

    var heroEl = contentClone.querySelector('.rc-estimate-hero');
    if (heroEl) page1.appendChild(heroEl);
    var dividerEl = contentClone.querySelector('.rc-section-divider');
    if (dividerEl) page1.appendChild(dividerEl);
    var startingPt = contentClone.querySelector('.rc-structured-starting-point');
    if (startingPt) page1.appendChild(startingPt);
    var rangeEl = contentClone.querySelector('.rc-estimate-range');
    if (rangeEl) page1.appendChild(rangeEl);

    var projHeader = contentClone.querySelector('.rc-project-summary-header');
    if (projHeader) page1.appendChild(projHeader);
    var sections = contentClone.querySelectorAll('.rc-summary-section');
    if (sections[0]) page1.appendChild(sections[0]); // Customer Information
    if (sections[1]) page1.appendChild(sections[1]); // Project Overview

    printRoot.appendChild(page1);

    // 4. Itemized Breakdown — direct child with forced page break
    var itemized = contentClone.querySelector('.rc-summary-section');
    if (itemized) {
      itemized.classList.add('rc-print-break');
      printRoot.appendChild(itemized);
    }

    // 5. Project Costs — direct child with forced page break
    var projectCosts = contentClone.querySelector('.rc-summary-section');
    if (projectCosts) {
      projectCosts.classList.add('rc-print-break');
      printRoot.appendChild(projectCosts);
    }

    // 6. Remaining sections — direct children, flow naturally
    while (contentClone.firstChild) {
      printRoot.appendChild(contentClone.firstChild);
    }

    // 7. Add disclaimer
    var disclaimer = document.createElement('div');
    disclaimer.className = 'rc-print-disclaimer';
    disclaimer.innerHTML = '<strong>Disclaimer:</strong> This estimate reflects current material pricing and standard installation conditions. Final pricing is confirmed following professional on-site verification. This document is not a contract or binding agreement.';
    printRoot.appendChild(disclaimer);

    // 8. Print after render
    requestAnimationFrame(function() { window.print(); });
  }
  function getStyleLabel(style) {
    const labels = {
      single_hung: 'Single-Hung', double_hung: 'Double-Hung', casement: 'Casement',
      sliding: 'Sliding', awning: 'Awning', picture: 'Picture', three_lite: 'Three Lite Slider', custom_shape: 'Custom Shape'
    };
    return labels[style] || style;
  }
  function getInstallLabel(type) {
    const labels = { retrofit: 'Retrofit', fullframe: 'Full-Frame', new: 'New Construction' };
    return labels[type] || type;
  }
  // ============================================================
  //  INIT
  // ============================================================
  function init() {
    // Ensure initial check-item states match checkboxes
    $all('#rc-glass-upgrades .rc-check-item').forEach(item => {
      const cb = item.querySelector('input[type="checkbox"]');
      item.classList.toggle('rc-checked', cb.checked);
    });
    // Hide running total on load (only visible on step 4)
    var hostTotal = hostEl(HOST_TOTAL_ID);
    if (hostTotal) hostTotal.style.display = 'none';
    // Set up phone formatter
    setupPhoneFormatter();
    // Initialize gas fill options based on default pane selection
    handlePaneChange();

    // ============================================================
    //  URL PARAMETER PRE-FILL (for re-engagement SMS links)
    // ============================================================
    (function prefillFromURL() {
      var params = new URLSearchParams(window.location.search);

      // URL parameter name -> element id inside the mount.
      var fieldMap = {
        'fullName':      'rc-full-name',
        'streetAddress': 'rc-street-address',
        'city':          'rc-city',
        'state':         'rc-state',
        'postalCode':    'rc-postal-code',
        'phone':         'rc-phone',
        'email':         'rc-email'
      };

      Object.keys(fieldMap).forEach(function(paramName) {
        var value = params.get(paramName);
        if (value) {
          var el = $id(fieldMap[paramName]);
          if (el) {
            el.value = value;
            var wrapper = $id(fieldMap[paramName].replace('rc-', 'rc-field-'));
            if (wrapper) wrapper.classList.remove('rc-field-error');
          }
        }
      });

      // Run the phone formatter so pre-filled numbers display as (954) 500-0000
      var phoneParam = params.get('phone');
      if (phoneParam) {
        var phoneEl = $id('rc-phone');
        if (phoneEl) {
          phoneEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
  })();

    // ============================================================
    //  VERIFICATION CODE INPUT — Enter to submit, digits-only filter
    // ============================================================
    (function setupVerifyCodeInput() {
      var codeInput = $id('rc-verify-code-input');
      if (!codeInput) return;
      codeInput.addEventListener('input', function(e) {
        // Strip any non-digit characters as user types
        var cleaned = (e.target.value || '').replace(/\D/g, '').slice(0, 6);
        if (e.target.value !== cleaned) e.target.value = cleaned;
        // Clear error styling once user starts typing again
        if (cleaned.length > 0) {
          e.target.classList.remove('rc-field-error');
          $id('rc-verify-error-msg').classList.remove('rc-visible');
        }
      });
      codeInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          verifyEnteredCode();
        }
      });
    })();

    updateRunningTotal();

    // Registered once per mount, after innerHTML has built the form.
    watchPolicyLinks(mountEl);

    // Step 1 is already on screen by the time init() runs — this is the moment it
    // first becomes visible to the lead, so this is where its step_view belongs.
    sendStep1View();
  }
  // ============================================================
  //  KEEP ESTIMATE MODAL
  // ============================================================
  function showKeepEstimateModal() {
    sendEvent('keep_estimate_shown');
    $id('rc-keep-estimate-modal').classList.add('rc-active');
  }
  function hideKeepEstimateModal() {
    $id('rc-keep-estimate-modal').classList.remove('rc-active');
  }
  function openMeasurementVerification() {
    sendEvent('verify_cta_clicked');
    if (typeof fbq === 'function') {
      fbq('trackSingleCustom', META_PIXEL_ID, 'CalcBookingIntent');
    }
    var data = gatherContactData();
    var url = 'https://landing.reecewindows.com/confirm-your-pricing?' +
      'first_name=' + encodeURIComponent(data.firstName) +
      '&last_name=' + encodeURIComponent(data.lastName) +
      '&phone=' + encodeURIComponent(data.phone) +
      '&email=' + encodeURIComponent(data.email);
    // Forward the RESOLVED attribution, not the raw query string. Reading params
    // here would hand the landing page nothing for an untagged organic arrival —
    // the same blank-source defect this branch fixes, one hop later.
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach(function(key) {
      var val = ATTRIBUTION[key];
      if (val) url += '&' + key + '=' + encodeURIComponent(val);
    });
    // Click IDs travel with the lead so offline conversion matching survives the hop.
    ['gclid', 'fbclid', 'msclkid'].forEach(function(key) {
      if (ATTRIBUTION[key]) url += '&' + key + '=' + encodeURIComponent(ATTRIBUTION[key]);
    });
    // Append pro_id and lp_source_id
    if (data.proId) url += '&pro_id=' + encodeURIComponent(data.proId);
    if (data.lpSourceId) url += '&lp_source_id=' + encodeURIComponent(data.lpSourceId);
    window.location.href = url;
  }

  // ==========================================================================
  //  MOUNTING
  // ==========================================================================
  function scrollToCalculator() {
    // On the standalone page the calculator is the page. Embedded in a longer
    // WordPress page, scrolling the document to 0 would throw the visitor up
    // into the site header instead of the step they just opened.
    // Full mode is the standalone case again — chrome, calculator and footer
    // are the whole of what the visitor came for — so it scrolls to the top
    // even though its PAGE_VARIANT is main-domain.
    if (RENDER_MODE === 'full' || PAGE_VARIANT === 'standalone' || !mountEl) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      mountEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.appendChild(document.createTextNode(CSS));
    (document.head || document.documentElement).appendChild(style);
  }

  // Full mode only. The same CSS string, plus the page chrome's, placed INSIDE
  // the shadow root — where document.head styles cannot reach and the funnel
  // page's .card / .btn / .container rules cannot reach either.
  function injectShadowStyles(root) {
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.appendChild(document.createTextNode(FULL_CSS + '\n' + CSS));
    root.appendChild(style);
  }

  // Full mode only. Two things that have to live in the LIGHT dom:
  //
  //  1. The webfont. An @font-face declared only inside a shadow root does not
  //     resolve — the font has to be loaded by the document. Once it is, the
  //     shadow content inherits it like any other page font.
  //  2. A z-index floor for Google Places. Its .pac-container dropdown is
  //     appended to document.body, outside the shadow root, and Google styles
  //     it from its own document.head stylesheet — so it renders correctly, but
  //     a funnel-page section with a z-index of its own can cover it. This rule
  //     puts it above everything. See initializeAddressForm.
  function injectLightDomSupport() {
    if (document.getElementById('rc-full-light-support')) return;
    var head = document.head || document.documentElement;

    ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'].forEach(function (href) {
      var pre = document.createElement('link');
      pre.rel = 'preconnect';
      pre.href = href;
      if (href.indexOf('gstatic') !== -1) pre.crossOrigin = '';
      head.appendChild(pre);
    });

    var font = document.createElement('link');
    font.rel = 'stylesheet';
    font.href = 'https://fonts.googleapis.com/css2?family=Nunito+Sans:wght@300..900&display=swap';
    head.appendChild(font);

    var style = document.createElement('style');
    style.id = 'rc-full-light-support';
    style.appendChild(document.createTextNode(
      '.pac-container { z-index: 2147483647 !important; }'
    ));
    head.appendChild(style);
  }

  // Full mode only. The Meta pixel base code, injected into the light DOM.
  //
  // This is the ONE place this file initialises a pixel, and it is deliberate.
  // Everywhere else the host page owns its trackers — the standalone page
  // carries its own block in public/index.html, and the WordPress page has its
  // own through Socius's GTM container, which this must never touch. Embed mode
  // therefore never calls this. Full mode means the GHL funnel page, and that
  // page is the reason the rule has an exception:
  //
  // The funnel's pixel was a block someone pasted into GHL's head tracking
  // code, and on 2026-09-18 it was found missing from the live page — no
  // connect.facebook.net, no fbq, nothing. Every fbq call in this file is
  // guarded on `typeof fbq === 'function'`, so nothing errored: Lead,
  // CompleteRegistration, CalcVerified, CalcStep2/3/4 and CalcBookingIntent
  // simply went nowhere, on the page carrying ~95% of calculator volume, for an
  // unknown length of time. A tracker that fails silently is worse than one
  // that fails loudly, so ownership moved into the deploy where it cannot be
  // forgotten.
  //
  // Two properties keep it safe:
  //   - window.fbq short-circuit. The same re-entry guard Meta's own base code
  //     uses. If a pixel block is ever pasted into GHL as well, this no-ops
  //     rather than initialising a second time and double-counting PageView.
  //   - trackSingle for the PageView, never the untargeted form, matching the
  //     rule the Lead call already follows: if the funnel ever gains a second
  //     pixel, our PageView still reports only to ours.
  //
  // No <noscript> fallback image. The calculator does not run without
  // JavaScript, so a noscript pixel would only ever record people who could not
  // have used the page anyway.
  function injectMetaPixel() {
    if (window.fbq) return;
    var head = document.head || document.documentElement;

    /* eslint-disable */
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () {
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0';
      n.queue = []; t = b.createElement(e); t.async = !0; t.src = v;
      s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */

    try {
      fbq('init', META_PIXEL_ID);
      fbq('trackSingle', META_PIXEL_ID, 'PageView');
    } catch (e) { /* analytics must never break the funnel */ }

    // A marker the suite and a console session can both see, so "did the embed
    // put this here, or did the host page?" is answerable without guessing.
    var mark = document.createElement('meta');
    mark.setAttribute('data-rc-pixel', META_PIXEL_ID);
    head.appendChild(mark);
  }

  function loadGoogleMaps() {
    if (document.querySelector('script[data-rc-maps]')) return;
    var s = document.createElement('script');
    s.src = MAPS_SRC;
    s.async = true;
    s.defer = true;
    s.setAttribute('data-rc-maps', '1');
    document.head.appendChild(s);
  }

  function mount() {
    var el = document.getElementById(MOUNT_ID);
    if (!el) {
      console.warn('[ReeceCalculator] No <div id="' + MOUNT_ID + '"> on this page — nothing to mount.');
      return;
    }
    if (el.getAttribute('data-rc-mounted') === '1') return;
    el.setAttribute('data-rc-mounted', '1');

    if (RENDER_MODE === 'full') {
      mountFull(el);
    } else {
      mountEmbed(el);
    }
    init();
    loadGoogleMaps();
    ReeceCalculator.mounted = true;
  }

  // Today's path, byte for byte. estimate.getreecewindows.com and
  // reecewindows.com/window-estimate both land here and nothing in it moved
  // when full mode was added — queryRoot is still document, the styles still
  // go to document.head, the markup still goes straight into the mount.
  function mountEmbed(el) {
    mountEl = el;
    // Embedded in the WordPress page the calculator is a block INSIDE an
    // article, not the page itself: no grey page background, cards carry their
    // own border, and the container fills the theme column. The standalone page
    // keeps the full-page treatment and is untouched by .rc-embed.
    if (PAGE_VARIANT === 'main-domain') el.classList.add('rc-embed');
    injectStyles();
    // Assigning innerHTML REPLACES whatever the host put in the mount. The
    // standalone page relies on that to clear its loading placeholder; the
    // WordPress snippet is an empty div and is unaffected. Never switch this
    // to appendChild/insertAdjacentHTML — the placeholder would survive and
    // sit above the calculator.
    el.innerHTML = HTML;
  }

  // data-mode="full": chrome + calculator + footer inside a shadow root.
  //
  // 'open', never 'closed': closed blocks devtools inspection and would also
  // block the light-DOM bridging the trackers need.
  function mountFull(el) {
    var root = el.attachShadow({ mode: 'open' });
    shadowRootEl = root;
    // Everything the calculator queries from here on lives in the shadow root,
    // not the document. This one line is what makes all 111 internal lookups
    // resolve — which is why they go through $id/$one/$all rather than naming
    // document directly.
    queryRoot = root;

    injectLightDomSupport();
    injectMetaPixel();
    injectShadowStyles(root);

    var page = document.createElement('div');
    page.className = 'rc-page';
    page.innerHTML = FULL_HTML;
    root.appendChild(page);

    // The inner wrapper, NOT the shadow host: the calculator's stylesheet is
    // scoped under #reece-calculator, and policy-link clicks have to be
    // delegated from inside the shadow tree — a listener on the host would see
    // the retargeted event and never match #rc-link-privacy.
    mountEl = root.getElementById(MOUNT_ID);
    // No .rc-embed here even though PAGE_VARIANT is main-domain on the funnel
    // page: full mode IS the full-page treatment, which is the whole point of
    // the mode. .rc-embed is the WordPress in-article treatment.
    mountEl.innerHTML = HTML;

    var year = root.getElementById('rc-page-year');
    if (year) year.textContent = String(new Date().getFullYear());
  }

  // Only the functions the rendered markup and Google Maps call by name are
  // exported. Everything else stays inside this closure.
  var ReeceCalculator = {
    mount: mount,
    mounted: false,
    version: '3.1.0',
    pageVariant: PAGE_VARIANT,
    renderMode: RENDER_MODE,
    // The shadow root in full mode, null in embed mode. Exported so the suite
    // can assert the isolation actually happened, and so a console session on
    // the funnel page has a handle on the tree.
    get shadowRoot() { return shadowRootEl; },
    initializeAddressForm: initializeAddressForm,
    sendEvent: sendEvent,
    goToStep: goToStep,
    selectTile: selectTile,
    toggleCheck: toggleCheck,
    adjustQty: adjustQty,
    handlePaneChange: handlePaneChange,
    validateAndGoToStep2: validateAndGoToStep2,
    validateAndGoToStep4: validateAndGoToStep4,
    addWindow: addWindow,
    editWindow: editWindow,
    removeWindow: removeWindow,
    verifyEnteredCode: verifyEnteredCode,
    resendVerificationCode: resendVerificationCode,
    changeEmail: changeEmail,
    showKeepEstimateModal: showKeepEstimateModal,
    hideKeepEstimateModal: hideKeepEstimateModal,
    openMeasurementVerification: openMeasurementVerification,
    printEstimate: printEstimate
  };
  window.ReeceCalculator = ReeceCalculator;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})(window, document);
