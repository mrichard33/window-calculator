'use strict';

/**
 * HTML template builder for the Reece Windows estimate PDF.
 *
 * Produces a self-contained HTML string rendered by Puppeteer. Uses proper
 * CSS paged-media directives (`@page`, `page-break-inside: avoid`,
 * `break-before: page`) that Chromium's native print engine respects —
 * unlike html2pdf.js which slices pixels and splits tables mid-row.
 *
 * The content and copy mirror the current (broken) client-side output
 * produced by `generateEstimatePDF()` in index.html, ported 1:1 and
 * data-driven from the `estimate` JSON payload.
 */

// ---- helpers -------------------------------------------------------------

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmt(n) {
  const v = Number(n) || 0;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function storiesLabel(storiesValue) {
  if (storiesValue === '1' || storiesValue === 1) return '1 Story';
  if (storiesValue === '2' || storiesValue === 2) return '2 Stories';
  return '3+ Stories';
}

// ---- sections ------------------------------------------------------------

function renderHeaderBar() {
  return `
    <div class="header-bar">
      <h1>Reece Windows &amp; Doors</h1>
    </div>
  `;
}

function renderPriceBlock(costs, windowCount) {
  const grandTotal = costs.grandTotal;
  const lowPrice = costs.lowEstimate;
  const highPrice = costs.highEstimate;
  const monthlyLow = costs.monthlyLow != null ? costs.monthlyLow : Math.round(lowPrice * 0.0107);
  const monthlyAvg = costs.monthlyAvg != null ? costs.monthlyAvg : Math.round(grandTotal * 0.0107);

  return `
    <div class="price-block">
      <h3 class="section-header">Estimated Project Investment</h3>
      <p class="hero-price">${fmt(grandTotal)}</p>
      <p class="hero-descriptor">Full-Frame Replacement | ${windowCount} Impact-Rated Windows</p>
      <p class="hero-credibility">Florida-Engineered | Impact-Rated | In-House Installation</p>
      <p class="monthly-amount">Estimated $${monthlyLow.toLocaleString()}&ndash;$${monthlyAvg.toLocaleString()} per month*</p>
      <p class="monthly-sub">Payment options available. No traditional credit score required.</p>
      <p class="monthly-footnote">*Example based on estimated project total. Final terms are confirmed during verification.</p>
      <div class="hero-divider"></div>
      <p class="range-label">Estimated Range</p>
      <p class="range-values">${fmt(lowPrice)} &ndash; ${fmt(highPrice)}</p>
      <p class="range-sub">Most verified projects remain within this range.</p>
      <p class="range-sub">Final pricing is confirmed during professional verification.</p>
      <p class="range-sub">This range reflects final measurement confirmation, installation method adjustments, and Florida code requirements.</p>
    </div>
  `;
}

function renderStructuredStartingPoint() {
  return `
    <div class="starting-point">
      <h3 class="sub-header">Your Estimate Is Structured and Verifiable</h3>
      <p>This estimate reflects the window selections and preliminary measurements you provided.</p>
      <p>Before materials are ordered, we verify:</p>
      <ul>
        <li>Exact opening dimensions</li>
        <li>Installation conditions</li>
        <li>Florida code compliance requirements</li>
        <li>Geographic scheduling zone eligibility</li>
      </ul>
      <p>This protects you from unexpected changes &mdash; up or down.</p>
    </div>
  `;
}

function renderProjectSummary(customer, project) {
  const addrParts = [customer.address, customer.city, customer.state, customer.postalCode]
    .filter(Boolean)
    .join(', ');
  return `
    <h3 class="section-header project-summary-header">Project Summary</h3>
    <div class="summary-section">
      <h3 class="sub-header">Customer Information</h3>
      <table class="summary-table">
        <tr><td>Name</td><td>${escapeHtml(customer.name)}</td></tr>
        <tr><td>Address</td><td>${escapeHtml(addrParts)}</td></tr>
        <tr><td>Phone</td><td>${escapeHtml(customer.phone || '')}</td></tr>
        ${customer.email ? `<tr><td>Email</td><td>${escapeHtml(customer.email)}</td></tr>` : ''}
      </table>
    </div>
    <div class="summary-section">
      <h3 class="sub-header">Project Overview</h3>
      <table class="summary-table">
        <tr><td>Total Windows</td><td>${project.totalWindows}</td></tr>
        <tr><td>Installation Type</td><td>${escapeHtml(project.installationType || 'Full-Frame Replacement')}</td></tr>
        <tr><td>Building Stories</td><td>${escapeHtml(project.buildingStories || storiesLabel(project.storiesValue))}</td></tr>
      </table>
    </div>
  `;
}

function renderWindowGroup(w, index) {
  const label = escapeHtml(w.label || '');
  const qtyTimes = w.qty > 1 ? `&times; ${w.qty}` : '';
  const impactTag = w.isImpact ? ' <span class="impact-tag">(Impact)</span>' : '';
  const bd = w.breakdown || {};

  const lineItems = [];

  // Base price
  const baseLabel = `Base Price (${escapeHtml(w.styleLabel || '')}${w.isImpact ? ', Impact' : ''}, ${w.unitedInches || ''} UI)`;
  lineItems.push({
    label: baseLabel,
    perUnit: bd.chartPrice || 0,
    total: (bd.chartPrice || 0) * w.qty,
  });

  if (bd.frameMult && bd.frameMult !== 0) {
    lineItems.push({
      label: `Frame Adj. (${escapeHtml(w.frameLabel || '')})`,
      perUnit: bd.frameMult,
      total: bd.frameMult * w.qty,
    });
  }
  if (bd.glassPanes && bd.glassPanes !== 0) {
    lineItems.push({
      label: escapeHtml(w.panesLabel || ''),
      perUnit: bd.glassPanes,
      total: bd.glassPanes * w.qty,
    });
  }
  if (bd.gasFill && bd.gasFill > 0) {
    lineItems.push({
      label: escapeHtml(w.gasLabel || ''),
      perUnit: bd.gasFill,
      total: bd.gasFill * w.qty,
    });
  }
  if (bd.grid && bd.grid > 0) {
    lineItems.push({
      label: escapeHtml(w.gridLabel || ''),
      perUnit: bd.grid,
      total: bd.grid * w.qty,
    });
  }
  if (bd.upgrades && bd.upgrades > 0) {
    const upgradeLabels = Array.isArray(w.upgradeLabels) ? w.upgradeLabels.join(', ') : '';
    lineItems.push({
      label: `Upgrades (${escapeHtml(upgradeLabels)})`,
      perUnit: bd.upgrades,
      total: bd.upgrades * w.qty,
    });
  }
  if (bd.storySurcharge && bd.storySurcharge > 0) {
    lineItems.push({
      label: 'Story Surcharge',
      perUnit: bd.storySurcharge,
      total: bd.storySurcharge * w.qty,
    });
  }

  const lineRows = lineItems.map((item) => `
    <tr>
      <td class="indent">${item.label}</td>
      <td>${fmt(item.perUnit)}</td>
      <td>&times; ${w.qty}</td>
      <td class="num">${fmt(item.total)}</td>
    </tr>
  `).join('');

  const subtotalRow = `
    <tr class="window-subtotal">
      <td class="indent">Subtotal</td>
      <td>${fmt(w.perWindowCost || 0)}</td>
      <td>&times; ${w.qty}</td>
      <td class="num">${fmt(w.totalCost || 0)}</td>
    </tr>
  `;

  const headerRow = `
    <tr class="window-header">
      <td colspan="4">#${index + 1} ${label} ${qtyTimes}${impactTag}</td>
    </tr>
  `;

  // Wrap in a <tbody class="window-group"> so the entire group stays on one page.
  // Chromium respects page-break-inside: avoid on tbody.
  return `
    <tbody class="window-group">
      ${headerRow}
      ${lineRows}
      ${subtotalRow}
    </tbody>
  `;
}

function renderItemizedBreakdown(windows) {
  const groups = windows.map((w, i) => renderWindowGroup(w, i)).join('');
  return `
    <div class="itemized-section">
      <h3 class="sub-header">Itemized Breakdown</h3>
      <table class="summary-table itemized-table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Per Unit</th>
            <th>Qty</th>
            <th class="num">Total</th>
          </tr>
        </thead>
        ${groups}
      </table>
    </div>
  `;
}

function renderProjectCosts(costs, totalWindows) {
  const bulkRow = (costs.bulkDiscountAmount && costs.bulkDiscountAmount > 0)
    ? `<tr>
         <td>Project Efficiency Adjustment (${totalWindows}-Window Scope)</td>
         <td class="num negative">-${fmt(costs.bulkDiscountAmount)}</td>
       </tr>`
    : '';

  return `
    <div class="project-costs-section">
      <h3 class="sub-header">Project Costs</h3>
      <table class="summary-table two-col-table">
        <tr>
          <td>Windows Subtotal (incl. installation)</td>
          <td class="num">${fmt(costs.windowSubtotal)}</td>
        </tr>
        ${bulkRow}
        <tr>
          <td>Permit Fee (3%)</td>
          <td class="num">${fmt(costs.permitFee)}</td>
        </tr>
        <tr class="total-row">
          <td>Estimated Total</td>
          <td class="num">${fmt(costs.grandTotal)}</td>
        </tr>
      </table>
    </div>
  `;
}

function renderCostRange(costs) {
  return `
    <div class="cost-range">
      <h3 class="sub-header-small">Cost Range</h3>
      <table class="summary-table two-col-table">
        <tr>
          <td>Projected Low (-20%)</td>
          <td class="num">${fmt(costs.lowEstimate)}</td>
        </tr>
        <tr class="verified-avg">
          <td>Verified Average</td>
          <td class="num">${fmt(costs.grandTotal)}</td>
        </tr>
        <tr>
          <td>Projected High (+20%)</td>
          <td class="num">${fmt(costs.highEstimate)}</td>
        </tr>
      </table>
      <p class="caption">This range reflects final measurement confirmation, installation conditions, and code compliance requirements.</p>
    </div>
  `;
}

function renderPotentialSavings(costs) {
  const energyStarCredit = Math.min((costs.grandTotal || 0) * 0.30, 600);
  return `
    <div class="potential-savings">
      <h3 class="sub-header-small">Potential Savings</h3>
      <table class="summary-table two-col-table">
        <tr>
          <td>ENERGY STAR Tax Credit (up to 30%, max $600/yr Federal Tax Credit)</td>
          <td class="num negative">Up to -${fmt(energyStarCredit)}</td>
        </tr>
        <tr>
          <td>Energy Savings (est. 12% on heating/cooling bills annually)</td>
          <td class="num negative">Varies by home</td>
        </tr>
      </table>
    </div>
  `;
}

function renderRouting() {
  return `
    <div class="routing-section">
      <h3 class="section-header">How Installation Scheduling Can Influence Final Pricing</h3>
      <p>We organize installations by geographic zones.</p>
      <p>When multiple homes in the same area are completed during the same installation cycle, we reduce:</p>
      <ul>
        <li>Crew travel time</li>
        <li>Equipment staging costs</li>
        <li>Material handling inefficiencies</li>
      </ul>
      <p>When routing efficiencies apply, they are reflected in final pricing.</p>
      <p>Routing eligibility is confirmed during professional measurement verification.</p>
      <p>Early verification improves access to the most efficient installation cycle.</p>
    </div>
  `;
}

function renderClose() {
  return `
    <div class="close-divider"></div>
    <div class="close-section">
      <h3 class="section-header">Next Step: Confirm and Finalize</h3>
      <p>A brief professional measurement allows us to:</p>
      <ul>
        <li>Secure your exact price</li>
        <li>Confirm material allocation</li>
        <li>Determine routing efficiencies</li>
        <li>Finalize installation scheduling</li>
      </ul>
      <p>There is no obligation.</p>
      <p>No sales presentation.</p>
      <p class="close-emphasis">Just precision.</p>
    </div>
  `;
}

function renderFooter() {
  return `
    <div class="footer">
      Installation schedules are organized by geographic zone and material availability.<br>
      Early verification ensures access to the most efficient installation cycle.
    </div>
  `;
}

// ---- top-level ----------------------------------------------------------

function renderEstimateHTML(estimate) {
  const customer = estimate.customer || {};
  const project = estimate.project || {};
  const windows = estimate.windows || [];
  const costs = estimate.costs || {};

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Reece Windows Estimate</title>
<link href="https://fonts.googleapis.com/css2?family=Nunito+Sans:wght@400;600;700;900&family=Montserrat:wght@700&display=swap" rel="stylesheet">
<style>
  @page {
    size: letter;
    margin: 0.5in 0.7in 0.6in 0.7in;
  }

  * { box-sizing: border-box; }

  html, body {
    margin: 0;
    padding: 0;
    font-family: 'Nunito Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    color: #626060;
    font-size: 11px;
    line-height: 1.35;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* ===== Header bar ===== */
  .header-bar {
    background: #122739;
    padding: 14px 20px;
    margin: 0 -0.2in 16px -0.2in;
    text-align: center;
    page-break-inside: avoid;
  }
  .header-bar h1 {
    margin: 0;
    font-family: 'Montserrat', sans-serif;
    font-size: 20px;
    font-weight: 700;
    color: #FFFFFF;
    letter-spacing: 0.5px;
  }

  /* ===== Section headers ===== */
  .section-header {
    margin: 0 0 8px 0;
    padding-left: 12px;
    font-size: 14px;
    font-weight: 700;
    color: #122739;
    border-left: 3px solid #ED1E24;
    line-height: 1.3;
  }
  .sub-header {
    margin: 0 0 4px 0;
    font-size: 12px;
    font-weight: 700;
    color: #0C2340;
  }
  .sub-header-small {
    margin: 0 0 4px 0;
    font-size: 11px;
    font-weight: 700;
    color: #0C2340;
  }

  /* ===== Price hero block ===== */
  .price-block {
    margin-bottom: 12px;
    padding: 10px 0;
    page-break-inside: avoid;
  }
  .price-block .hero-price {
    margin: 0 0 4px 0;
    font-size: 28px;
    font-weight: 700;
    color: #122739;
    text-align: center;
    line-height: 1.2;
  }
  .price-block .hero-descriptor {
    margin: 2px 0 0 0;
    font-size: 11px;
    color: #626060;
    text-align: center;
    letter-spacing: 0.3px;
  }
  .price-block .hero-credibility {
    margin: 1px 0 0 0;
    font-size: 10px;
    color: #87898B;
    text-align: center;
    letter-spacing: 0.5px;
  }
  .price-block .monthly-amount {
    margin: 6px 0 0 0;
    font-size: 16px;
    font-weight: 900;
    color: #2e7d32;
    text-align: center;
    line-height: 1.1;
  }
  .price-block .monthly-sub {
    margin: 2px 0 0 0;
    font-size: 10px;
    font-weight: 700;
    color: #122739;
    text-align: center;
  }
  .price-block .monthly-footnote {
    margin: 3px 0 0 0;
    font-size: 10px;
    color: #626060;
    text-align: center;
    line-height: 1.35;
  }
  .price-block .hero-divider {
    border-top: 1px solid #C1D5DB;
    margin: 8px 0;
  }
  .price-block .range-label {
    margin: 0 0 1px 0;
    font-size: 10px;
    font-weight: 700;
    color: #0C2340;
    text-align: center;
  }
  .price-block .range-values {
    margin: 0 0 4px 0;
    font-size: 12px;
    font-weight: 700;
    color: #0C2340;
    text-align: center;
  }
  .price-block .range-sub {
    margin: 0 0 4px 0;
    font-size: 10px;
    color: #626060;
    text-align: center;
    line-height: 1.4;
  }

  /* ===== Structured starting point ===== */
  .starting-point {
    border-top: 1px solid #C1D5DB;
    margin-top: 6px;
    padding-top: 12px;
    margin-bottom: 10px;
    page-break-inside: avoid;
  }
  .starting-point p {
    margin: 0 0 3px 0;
    font-size: 10px;
    color: #626060;
    line-height: 1.4;
  }
  .starting-point ul {
    margin: 2px 0 5px 0;
    padding-left: 20px;
    font-size: 10px;
    color: #626060;
    line-height: 1.5;
  }
  .starting-point li { margin-bottom: 2px; }

  /* ===== Generic summary section ===== */
  .project-summary-header {
    margin: 0 0 10px 0;
  }
  .summary-section {
    margin: 0 0 8px 0;
    page-break-inside: avoid;
  }

  /* ===== Tables ===== */
  .summary-table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 12px;
    font-size: 11px;
    table-layout: auto;
  }
  .summary-table th,
  .summary-table td {
    padding: 6px 8px;
    border-bottom: 1px solid #e0e0e0;
    text-align: left;
    vertical-align: top;
  }
  .summary-table th {
    font-weight: 700;
    color: #0C2340;
    background: #F2F3F7;
  }
  .summary-table td.num { text-align: right; font-weight: 500; }
  .summary-table th.num { text-align: right; }
  .summary-table td.indent { padding-left: 1.5rem; }

  /* Chromium repeats thead on every page */
  thead { display: table-header-group; }
  /* Never split a row across pages */
  tr { page-break-inside: avoid; }

  /* ===== Itemized table: window groups must not split ===== */
  .itemized-section {
    break-before: page;
    page-break-before: always;
    margin: 0 0 8px 0;
  }
  .itemized-table tbody.window-group {
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .itemized-table .window-header td {
    font-weight: 700;
    background: #F2F3F7;
    color: #0D2240;
  }
  .itemized-table .window-header .impact-tag {
    letter-spacing: 0.3px;
    font-weight: 700;
  }
  .itemized-table .window-subtotal td {
    font-weight: 600;
  }

  /* ===== Project costs section ===== */
  .project-costs-section {
    break-before: page;
    page-break-before: always;
    margin: 0 0 8px 0;
    page-break-inside: avoid;
  }
  .two-col-table td:first-child { width: 70%; }
  .two-col-table td:last-child { text-align: right; white-space: nowrap; }
  .total-row td {
    font-weight: 700;
    font-size: 14px;
    border-top: 2px solid #1a2a3a;
    color: #122738;
  }
  .verified-avg td {
    font-weight: 600;
    color: #122738;
  }
  .negative { color: #ED1F24; }

  .cost-range,
  .potential-savings {
    margin: 0 0 8px 0;
    page-break-inside: avoid;
  }
  .caption {
    font-size: 10px;
    color: #87898B;
    margin-top: 4px;
    line-height: 1.4;
  }

  /* ===== Routing / close / footer ===== */
  .routing-section {
    padding: 20px 0 0 0;
    margin-bottom: 20px;
    page-break-inside: avoid;
  }
  .routing-section p,
  .close-section p {
    margin: 0 0 4px 0;
    font-size: 11px;
    color: #626060;
    line-height: 1.5;
  }
  .routing-section ul,
  .close-section ul {
    margin: 4px 0 8px 0;
    padding-left: 20px;
    font-size: 11px;
    color: #626060;
    line-height: 1.6;
  }
  .close-divider {
    border-top: 1px solid #C1D5DB;
    margin: 24px -0.2in 0 -0.2in;
  }
  .close-section {
    padding-top: 18px;
    margin-bottom: 20px;
    page-break-inside: avoid;
  }
  .close-emphasis {
    font-weight: 600;
  }
  .footer {
    margin-top: 50px;
    padding-top: 20px;
    border-top: 1px solid #C1D5DB;
    font-size: 11px;
    font-weight: 700;
    color: #4A4A4A;
    text-align: center;
    line-height: 1.6;
    page-break-inside: avoid;
  }
</style>
</head>
<body>
  ${renderHeaderBar()}
  ${renderPriceBlock(costs, project.totalWindows || 0)}
  ${renderStructuredStartingPoint()}
  ${renderProjectSummary(customer, project)}
  ${renderItemizedBreakdown(windows)}
  ${renderProjectCosts(costs, project.totalWindows || 0)}
  ${renderCostRange(costs)}
  ${renderPotentialSavings(costs)}
  ${renderRouting()}
  ${renderClose()}
  ${renderFooter()}
</body>
</html>`;
}

module.exports = { renderEstimateHTML };
