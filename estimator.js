// =============================================================
//  Reece Windows & Doors — Window Cost Estimator
//  estimator.js — All application logic
// =============================================================

// ============================================================
//  CENTRALIZED DEFAULTS
// ============================================================
const DEFAULTS = {
  region: 'south',
  season: 'peak',
  installType: 'fullframe'
};

// ============================================================
//  GOOGLE PLACES ADDRESS AUTOCOMPLETE
// ============================================================
window.initializeAddressForm = function() {
  var input = document.getElementById('streetAddress');
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

    document.getElementById('streetAddress').value = (streetNumber + ' ' + route).trim();
    document.getElementById('city').value = city;
    document.getElementById('state').value = state;
    document.getElementById('postalCode').value = postalCode;

    // Clear validation errors on autofilled fields
    ['field-streetAddress', 'field-city', 'field-state', 'field-postalCode'].forEach(function(id) {
      document.getElementById(id).classList.remove('field-error');
    });
  });
};

// ============================================================
//  PRICING DATABASE — based on 2025-2026 industry research
// ============================================================

const PRICING = {
  // Window style base costs (materials only, per window at standard 36x48 size, +$1,000 modifier)
  windowStyle: {
    single_hung:  { min: 750,  max: 1100, base: 880  },
    double_hung:  { min: 850,  max: 1350, base: 1020 },
    casement:     { min: 850,  max: 1500, base: 1075 },
    sliding:      { min: 800,  max: 1300, base: 950  },
    awning:       { min: 900,  max: 1450, base: 1080 },
    picture:      { min: 700,  max: 1200, base: 850  },
    bay:          { min: 1700, max: 5000, base: 2900 },
    bow:          { min: 2000, max: 6000, base: 3500 }
  },

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
    impact:   { add: 350, pct: 0,  label: 'Impact Resistant'  },
    obscure:  { add: 45,  pct: 0,  label: 'Obscure / Privacy' },
    sound:    { add: 150, pct: 0,  label: 'Sound Reduction'   }
  },

  // Labor base cost ranges per window by installation type
  labor: {
    retrofit:  { min: 100, max: 225, base: 160 },
    fullframe: { min: 250, max: 600, base: 380 },
    new:       { min: 200, max: 450, base: 300 }
  },

  // Regional labor multipliers
  region: {
    midwest:      { mult: 1.00, label: 'Midwest'          },
    south:        { mult: 0.90, label: 'South'            },
    northeast:    { mult: 1.18, label: 'Northeast'        },
    westcoast:    { mult: 1.22, label: 'West Coast'       },
    hawaii_alaska:{ mult: 1.35, label: 'Hawaii / Alaska'  }
  },

  // Story surcharge (per window)
  stories: {
    '1': 0,
    '2': 35,
    '3': 65
  },

  // Season discount (applied to labor)
  season: {
    peak:      { mult: 1.00, label: 'Peak Season'      },
    shoulder:  { mult: 0.95, label: 'Shoulder Season'   },
    offseason: { mult: 0.90, label: 'Off-Season'        }
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

  // Standard reference size (sq inches) for scaling
  standardArea: 36 * 48  // 1,728 sq in
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
  group.querySelectorAll('.tile').forEach(t => t.classList.remove('selected'));
  el.classList.add('selected');
}

function toggleCheck(el) {
  setTimeout(() => {
    const cb = el.querySelector('input[type="checkbox"]');
    el.classList.toggle('checked', cb.checked);
  }, 0);
}

function adjustQty(delta) {
  const inp = document.getElementById('winQty');
  let v = parseInt(inp.value) + delta;
  if (v < 1) v = 1;
  if (v > 50) v = 50;
  inp.value = v;
}

function handlePaneChange() {
  const panes = document.getElementById('glassPanes').value;
  const gasFillField = document.getElementById('gasFillField');
  const gasFill = document.getElementById('gasFill');

  if (panes === 'single') {
    // Single pane: hide gas fill, reset to Standard
    gasFill.innerHTML = '<option value="air" selected>Air (Standard)</option>';
    gasFillField.style.display = 'none';
  } else {
    // Double pane: show gas fill with Argon option
    gasFill.innerHTML =
      '<option value="air" selected>Air (Standard)</option>' +
      '<option value="argon">Argon Gas (+$50)</option>';
    gasFillField.style.display = '';
  }
}

// ============================================================
//  STEP 1 VALIDATION
// ============================================================

function validateAndGoToStep2() {
  const fields = [
    { id: 'fullName', fieldId: 'field-fullName' },
    { id: 'streetAddress', fieldId: 'field-streetAddress' },
    { id: 'city', fieldId: 'field-city' },
    { id: 'state', fieldId: 'field-state' },
    { id: 'postalCode', fieldId: 'field-postalCode' }
  ];

  let valid = true;
  fields.forEach(f => {
    const el = document.getElementById(f.id);
    const wrapper = document.getElementById(f.fieldId);
    if (!el.value.trim()) {
      wrapper.classList.add('field-error');
      valid = false;
    } else {
      wrapper.classList.remove('field-error');
    }
  });

  if (!valid) {
    const firstError = document.querySelector('.field-error input');
    if (firstError) firstError.focus();
    return;
  }
  goToStep(2);
}

// ============================================================
//  STEP 3 (CONTACT) VALIDATION
// ============================================================

function validateAndGoToStep4() {
  const phoneRaw = document.getElementById('phone').value.replace(/\D/g, '');
  const email = document.getElementById('email').value.trim();
  let valid = true;

  // Phone is required, must be at least 10 digits
  if (phoneRaw.length < 10) {
    document.getElementById('field-phone').classList.add('field-error');
    valid = false;
  } else {
    document.getElementById('field-phone').classList.remove('field-error');
  }

  // Email is optional, but if provided must be valid format
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    document.getElementById('field-email').classList.add('field-error');
    valid = false;
  } else {
    document.getElementById('field-email').classList.remove('field-error');
  }

  if (!valid) {
    const firstError = document.querySelector('#section-3 .field-error input');
    if (firstError) firstError.focus();
    return;
  }

  goToStep(4);
}

// ============================================================
//  PHONE AUTO-FORMATTER
// ============================================================

function setupPhoneFormatter() {
  const phoneInput = document.getElementById('phone');
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
  document.querySelectorAll('.section').forEach(s => s.classList.remove('visible'));
  document.getElementById('section-' + n).classList.add('visible');

  document.querySelectorAll('.stepper .step').forEach(s => {
    const sn = parseInt(s.dataset.step);
    s.classList.remove('active', 'done');
    if (sn < n) s.classList.add('done');
    if (sn === n) s.classList.add('active');
  });

  // Show running total only on the estimate step (step 4)
  const runningTotal = document.getElementById('runningTotal');
  runningTotal.style.display = (n === 4) ? '' : 'none';

  // Build summary when arriving at estimate step
  if (n === 4) buildSummary();

  // Video playback: play on Step 2, pause on all other steps
  var video = document.getElementById('introVideo');
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

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function getSelectedTile(groupId) {
  const sel = document.querySelector('#' + groupId + ' .tile.selected');
  return sel ? sel.dataset.value : null;
}

function getCheckedUpgrades() {
  const upgrades = [];
  document.querySelectorAll('#glassUpgrades .check-item input[type="checkbox"]').forEach(cb => {
    if (cb.checked && !upgrades.includes(cb.value)) upgrades.push(cb.value);
  });
  return upgrades;
}

// ============================================================
//  COST CALCULATION ENGINE
// ============================================================

function calculateWindowCost(config) {
  const style = PRICING.windowStyle[config.style];
  const frame = PRICING.frameMaterial[config.frame];
  const panes = PRICING.glassPanes[config.panes];
  const gas   = PRICING.gasFill[config.gas];
  const grid  = PRICING.gridPattern[config.grid];
  const labor = PRICING.labor[config.installType];
  const region = PRICING.region[config.region];
  const storySurcharge = PRICING.stories[config.stories];
  const seasonMult = PRICING.season[config.season].mult;

  // 1) Base material cost from style
  let materialCost = style.base;

  // 2) Apply frame material multiplier
  materialCost *= frame.mult;

  // 3) Size scaling: scale cost relative to standard 36x48
  const area = config.width * config.height;
  const sizeRatio = area / PRICING.standardArea;
  materialCost *= sizeRatio;

  // 4) Custom size surcharge (non-standard dims)
  const isStandard = isStandardSize(config.style, config.width, config.height);
  if (!isStandard) {
    materialCost *= 1.20; // 20% custom surcharge
  }

  // 5) Glass panes add-on
  let glassCost = panes.add;
  if (panes.add > 0) {
    glassCost *= sizeRatio;
  }
  materialCost += glassCost;

  // 6) Gas fill
  materialCost += gas.add;

  // 7) Grid pattern
  materialCost += grid.add;

  // 8) Glass upgrades
  let upgradesCost = 0;
  let lowEApplied = false;
  config.upgrades.forEach(u => {
    const up = PRICING.glassUpgrades[u];
    if (!up) return;
    if (u === 'low_e' && !lowEApplied) {
      upgradesCost += materialCost * up.pct;
      lowEApplied = true;
    } else if (u !== 'low_e') {
      let addCost = up.add;
      if (['impact', 'tempered', 'sound'].includes(u)) {
        addCost *= Math.max(0.8, sizeRatio);
      }
      upgradesCost += addCost;
    }
  });

  const totalMaterial = materialCost + upgradesCost;

  // 9) Labor cost
  let laborCost = labor.base;
  if (sizeRatio > 1.3) {
    laborCost *= 1 + (sizeRatio - 1.3) * 0.3;
  }
  if (['bay', 'bow'].includes(config.style)) {
    laborCost *= 2.2;
  }
  laborCost += storySurcharge;
  laborCost *= region.mult;
  laborCost *= seasonMult;
  if (!isStandard) {
    laborCost *= 1.10;
  }

  const perWindowTotal = totalMaterial + laborCost;

  return {
    materialCost: round2(totalMaterial),
    laborCost: round2(laborCost),
    perWindowCost: round2(perWindowTotal),
    totalCost: round2(perWindowTotal * config.qty),
    qty: config.qty,
    isStandard,
    sizeRatio: round2(sizeRatio),
    breakdown: {
      baseStyle: round2(style.base * frame.mult * sizeRatio * (isStandard ? 1 : 1.20)),
      glassPanes: round2(Math.max(0, glassCost)),
      gasFill: gas.add,
      grid: grid.add,
      upgrades: round2(upgradesCost),
      laborBase: round2(labor.base),
      laborAdjusted: round2(laborCost)
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
    bay:         { w: [36,48,60,72,84,96,108,120], h: [36,48,60,72] },
    bow:         { w: [48,60,72,84,96,108,120], h: [36,48,60,72] }
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
  return {
    style: getSelectedTile('windowStyle') || 'single_hung',
    frame: getSelectedTile('frameMaterial') || 'vinyl',
    panes: document.getElementById('glassPanes').value,
    gas: document.getElementById('gasFill').value,
    grid: document.getElementById('gridPattern').value,
    upgrades: getCheckedUpgrades(),
    width: parseInt(document.getElementById('winWidth').value) || 36,
    height: parseInt(document.getElementById('winHeight').value) || 48,
    qty: parseInt(document.getElementById('winQty').value) || 1,
    installType: DEFAULTS.installType,
    region: DEFAULTS.region,
    stories: document.getElementById('stories').value,
    season: DEFAULTS.season
  };
}

function getWindowLabel(config) {
  const styleLabels = {
    single_hung: 'Single-Hung', double_hung: 'Double-Hung', casement: 'Casement',
    sliding: 'Sliding', awning: 'Awning', picture: 'Picture', bay: 'Bay', bow: 'Bow'
  };
  const frameLabels = PRICING.frameMaterial[config.frame].label;
  return styleLabels[config.style] + ' - ' + frameLabels + ' - ' + config.width + '"x' + config.height + '"';
}

function addWindow() {
  const config = getWindowConfig();
  const cost = calculateWindowCost(config);

  if (editingIndex >= 0) {
    windows[editingIndex] = { config, cost };
    editingIndex = -1;
  } else {
    windows.push({ config, cost });
  }

  renderWindowList();
  updateRunningTotal();
  document.getElementById('winQty').value = 1;
}

function editWindow(idx) {
  const w = windows[idx];
  const c = w.config;
  editingIndex = idx;

  document.querySelectorAll('#windowStyle .tile').forEach(t => {
    t.classList.toggle('selected', t.dataset.value === c.style);
  });
  document.querySelectorAll('#frameMaterial .tile').forEach(t => {
    t.classList.toggle('selected', t.dataset.value === c.frame);
  });
  document.getElementById('glassPanes').value = c.panes;
  handlePaneChange();
  document.getElementById('gasFill').value = c.gas;
  document.getElementById('gridPattern').value = c.grid;
  document.getElementById('winWidth').value = c.width;
  document.getElementById('winHeight').value = c.height;
  document.getElementById('winQty').value = c.qty;

  document.querySelectorAll('#glassUpgrades .check-item').forEach(item => {
    const cb = item.querySelector('input[type="checkbox"]');
    const checked = c.upgrades.includes(cb.value);
    cb.checked = checked;
    item.classList.toggle('checked', checked);
  });

  window.scrollTo({ top: 0, behavior: 'smooth' });
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
  const list = document.getElementById('windowList');
  if (windows.length === 0) {
    list.innerHTML = '<div class="empty-state">No windows added yet. Configure a window above and click "Add Window to Estimate".</div>';
    document.getElementById('btnToStep3').disabled = true;
    return;
  }

  document.getElementById('btnToStep3').disabled = false;
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
      modifierTags.push(c.stories === '2' ? '2-Story (+$35/ea)' : '3+ Story (+$65/ea)');
    }
    if (!cost.isStandard) {
      modifierTags.push('Custom Size (+20%)');
    }

    html += '<div class="cart-item">' +
      '<div class="cart-item-header">' +
        '<div class="cart-item-title">' +
          '<strong>#' + (i + 1) + '</strong> ' + label +
          (c.qty > 1 ? ' <span class="cart-qty">&times; ' + c.qty + '</span>' : '') +
        '</div>' +
        '<div class="we-actions">' +
          '<button class="btn-sm btn-edit" onclick="editWindow(' + i + ')">Edit</button>' +
          '<button class="btn-sm btn-delete" onclick="removeWindow(' + i + ')">Remove</button>' +
        '</div>' +
      '</div>' +
      '<div class="cart-item-details">';

    detailTags.forEach(tag => {
      html += '<span class="cart-tag">' + tag + '</span>';
    });
    upgradeTags.forEach(tag => {
      html += '<span class="cart-tag cart-tag-upgrade">' + tag + '</span>';
    });
    modifierTags.forEach(tag => {
      html += '<span class="cart-tag cart-tag-modifier">' + tag + '</span>';
    });

    html += '</div>' +
      '<div class="cart-item-cost">' + fmt(cost.totalCost) + '</div>' +
    '</div>';
  });

  list.innerHTML = html;
}

function updateRunningTotal() {
  let windowTotal = 0;
  windows.forEach(w => { windowTotal += w.cost.totalCost; });
  const permitFee = round2(windowTotal * 0.03);
  const total = windowTotal + permitFee;
  document.querySelector('#runningTotal span').textContent = fmt(total);
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
//  SUMMARY BUILDER
// ============================================================

function buildSummary() {
  const project = getProjectCosts();
  let totalMaterials = 0;
  let totalLabor = 0;
  let totalWindows = 0;

  let windowRows = '';
  windows.forEach((w, i) => {
    const c = w.config;
    const cost = w.cost;
    const label = getWindowLabel(c);
    const matPerUnit = cost.materialCost;
    const labPerUnit = cost.laborCost;
    const matTotal = matPerUnit * c.qty;
    const labTotal = labPerUnit * c.qty;

    totalMaterials += matTotal;
    totalLabor += labTotal;
    totalWindows += c.qty;

    windowRows += '<tr>' +
      '<td colspan="4" style="font-weight:700; background:var(--light-bg); color:var(--deep-navy);">' +
        '#' + (i + 1) + ' ' + label + ' ' + (c.qty > 1 ? '&times; ' + c.qty : '') +
        (!cost.isStandard ? ' <span class="custom-size-badge">(Custom)</span>' : '') +
      '</td>' +
    '</tr>';
    windowRows += '<tr><td style="padding-left:1.5rem;">Base (' + PRICING.frameMaterial[c.frame].label + ' ' + getStyleLabel(c.style) + ')</td><td>' + fmt(cost.breakdown.baseStyle) + '</td><td>&times; ' + c.qty + '</td><td>' + fmt(cost.breakdown.baseStyle * c.qty) + '</td></tr>';

    if (cost.breakdown.glassPanes > 0) {
      windowRows += '<tr><td style="padding-left:1.5rem;">' + PRICING.glassPanes[c.panes].label + ' Upgrade</td><td>' + fmt(cost.breakdown.glassPanes) + '</td><td>&times; ' + c.qty + '</td><td>' + fmt(cost.breakdown.glassPanes * c.qty) + '</td></tr>';
    }
    if (cost.breakdown.gasFill > 0) {
      windowRows += '<tr><td style="padding-left:1.5rem;">' + PRICING.gasFill[c.gas].label + '</td><td>' + fmt(cost.breakdown.gasFill) + '</td><td>&times; ' + c.qty + '</td><td>' + fmt(cost.breakdown.gasFill * c.qty) + '</td></tr>';
    }
    if (cost.breakdown.grid > 0) {
      windowRows += '<tr><td style="padding-left:1.5rem;">' + PRICING.gridPattern[c.grid].label + '</td><td>' + fmt(cost.breakdown.grid) + '</td><td>&times; ' + c.qty + '</td><td>' + fmt(cost.breakdown.grid * c.qty) + '</td></tr>';
    }
    if (cost.breakdown.upgrades > 0) {
      const upgradeLabels = c.upgrades.map(u => PRICING.glassUpgrades[u] ? PRICING.glassUpgrades[u].label : u).join(', ');
      windowRows += '<tr><td style="padding-left:1.5rem;">Upgrades (' + upgradeLabels + ')</td><td>' + fmt(cost.breakdown.upgrades) + '</td><td>&times; ' + c.qty + '</td><td>' + fmt(cost.breakdown.upgrades * c.qty) + '</td></tr>';
    }
    windowRows += '<tr><td style="padding-left:1.5rem;">Labor (' + getInstallLabel(c.installType) + ')</td><td>' + fmt(cost.breakdown.laborAdjusted) + '</td><td>&times; ' + c.qty + '</td><td>' + fmt(cost.breakdown.laborAdjusted * c.qty) + '</td></tr>';
    windowRows += '<tr class="subtotal"><td style="padding-left:1.5rem;">Subtotal</td><td>' + fmt(cost.perWindowCost) + '</td><td>&times; ' + c.qty + '</td><td>' + fmt(cost.totalCost) + '</td></tr>';
  });

  // Bulk discount
  let bulkDiscountAmt = 0;
  if (project.bulkDiscountRate > 0) {
    bulkDiscountAmt = round2(totalMaterials * project.bulkDiscountRate);
  }

  const subtotalBeforePermit = round2(totalMaterials + totalLabor - bulkDiscountAmt);
  const permitFee = round2(subtotalBeforePermit * 0.03);
  const grandTotal = round2(subtotalBeforePermit + permitFee);

  // Cost range
  const lowEstimate = round2(grandTotal * 0.85);
  const highEstimate = round2(grandTotal * 1.18);

  // Customer info
  const custName = document.getElementById('fullName').value.trim();
  const custAddress = document.getElementById('streetAddress').value.trim();
  const custCity = document.getElementById('city').value.trim();
  const custState = document.getElementById('state').value.trim();
  const custPostal = document.getElementById('postalCode').value.trim();
  const regionEl = document.getElementById('serviceRegion');
  const regionLabel = regionEl.selectedIndex > 0 ? regionEl.options[regionEl.selectedIndex].text : '';

  // Contact info from step 3
  const custPhone = document.getElementById('phone').value.trim();
  const custEmail = document.getElementById('email').value.trim();

  let html = '<div class="summary-section">' +
    '<h3>Customer</h3>' +
    '<table class="summary-table">' +
      '<tr><td>Name</td><td>' + custName + '</td></tr>' +
      '<tr><td>Address</td><td>' + custAddress + ', ' + custCity + ', ' + custState + ' ' + custPostal + '</td></tr>' +
      '<tr><td>Phone</td><td>' + custPhone + '</td></tr>' +
      (custEmail ? '<tr><td>Email</td><td>' + custEmail + '</td></tr>' : '') +
      (regionLabel ? '<tr><td>Region</td><td>' + regionLabel + '</td></tr>' : '') +
    '</table>' +
  '</div>';

  html += '<div class="summary-section">' +
    '<h3>Project Overview</h3>' +
    '<table class="summary-table">' +
      '<tr><td>Total Windows</td><td>' + totalWindows + '</td></tr>' +
      '<tr><td>Installation Type</td><td>Full-Frame Replacement</td></tr>' +
      '<tr><td>Building Stories</td><td>' + (document.getElementById('stories').value === '1' ? '1 Story' : document.getElementById('stories').value === '2' ? '2 Stories' : '3+ Stories') + '</td></tr>' +
    '</table>' +
  '</div>';

  html += '<div class="summary-section">' +
    '<h3>Itemized Breakdown</h3>' +
    '<table class="summary-table">' +
      '<thead><tr><th>Item</th><th>Per Unit</th><th>Qty</th><th>Total</th></tr></thead>' +
      '<tbody>' + windowRows + '</tbody>' +
    '</table>' +
  '</div>';

  html += '<div class="summary-section">' +
    '<h3>Project Costs</h3>' +
    '<table class="summary-table">' +
      '<tr><td>Total Materials</td><td>' + fmt(totalMaterials) + '</td></tr>' +
      '<tr><td>Total Labor</td><td>' + fmt(totalLabor) + '</td></tr>';

  if (bulkDiscountAmt > 0) {
    html += '<tr><td>Bulk Discount (' + Math.round(project.bulkDiscountRate * 100) + '% off materials for ' + totalWindows + ' windows)</td><td style="color:var(--cta-red);">-' + fmt(bulkDiscountAmt) + '</td></tr>';
  }
  html += '<tr><td>Permit Fee (3%)</td><td>' + fmt(permitFee) + '</td></tr>';

  html += '<tr class="total"><td>Estimated Total</td><td>' + fmt(grandTotal) + '</td></tr>' +
    '</table>' +
  '</div>';

  html += '<div class="summary-section">' +
    '<h3>Cost Range</h3>' +
    '<table class="summary-table">' +
      '<tr><td>Low Estimate (-15%)</td><td>' + fmt(lowEstimate) + '</td></tr>' +
      '<tr class="subtotal"><td>Mid Estimate</td><td>' + fmt(grandTotal) + '</td></tr>' +
      '<tr><td>High Estimate (+18%)</td><td>' + fmt(highEstimate) + '</td></tr>' +
    '</table>' +
    '<p style="font-size:0.78rem; color:var(--text-gray); margin-top:0.5rem;">' +
      'Range accounts for brand variance, local market conditions, and contractor pricing differences.' +
    '</p>' +
  '</div>';

  html += '<div class="summary-section">' +
    '<h3>Potential Savings</h3>' +
    '<table class="summary-table">' +
      '<tr><td>ENERGY STAR Tax Credit (up to 30%, max $600/yr)</td><td style="color:var(--cta-red);">Up to -' + fmt(Math.min(totalMaterials * 0.30, 600)) + '</td></tr>' +
      '<tr><td>Energy Savings (est. 12% on heating/cooling bills annually)</td><td style="color:var(--cta-red);">Varies by home</td></tr>' +
    '</table>' +
  '</div>';

  document.getElementById('summaryContent').innerHTML = html;
  updateRunningTotal();
}

function getStyleLabel(style) {
  const labels = {
    single_hung: 'Single-Hung', double_hung: 'Double-Hung', casement: 'Casement',
    sliding: 'Sliding', awning: 'Awning', picture: 'Picture', bay: 'Bay', bow: 'Bow'
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
(function init() {
  // Ensure initial check-item states match checkboxes
  document.querySelectorAll('#glassUpgrades .check-item').forEach(item => {
    const cb = item.querySelector('input[type="checkbox"]');
    item.classList.toggle('checked', cb.checked);
  });

  // Hide running total on load (only visible on step 4)
  document.getElementById('runningTotal').style.display = 'none';

  // Set up phone formatter
  setupPhoneFormatter();

  // Initialize gas fill options based on default pane selection
  handlePaneChange();

  updateRunningTotal();
})();
