// =============================================================
//  Reece Windows & Doors — Window Cost Estimator
//  estimator.js — All application logic
// =============================================================

// ============================================================
//  CENTRALIZED DEFAULTS
// ============================================================
const DEFAULTS = {
  installType: 'fullframe'
};

// ============================================================
//  GHL API v2 CONFIGURATION
// ============================================================
var GHL_CONFIG = {
  baseUrl: 'https://services.leadconnectorhq.com',
  pit: 'pit-57cd2e37-3b0f-4d5d-8bdc-9f3780ea7e77',
  locationId: 'SsBG7j5KQAIP1SFP2Sca',
  apiVersion: '2021-07-28',
  workflowWebhookUrl: 'https://services.leadconnectorhq.com/hooks/SsBG7j5KQAIP1SFP2Sca/webhook-trigger/f089d6ac-5aaa-425d-a109-300ec44fd8de'
};

// ============================================================
//  GHL API v2 FETCH HELPER
// ============================================================
function ghlApiFetch(path, options) {
  var url = GHL_CONFIG.baseUrl + path;
  var headers = {
    'Authorization': 'Bearer ' + GHL_CONFIG.pit,
    'Version': GHL_CONFIG.apiVersion,
    'Content-Type': 'application/json'
  };
  if (options.headers) {
    Object.keys(options.headers).forEach(function(k) {
      headers[k] = options.headers[k];
    });
  }
  return fetch(url, {
    method: options.method || 'POST',
    headers: headers,
    body: options.body || null
  }).then(function(response) {
    if (!response.ok) {
      return response.text().then(function(text) {
        throw new Error('GHL API ' + path + ' failed (' + response.status + '): ' + text);
      });
    }
    return response.json();
  });
}

// ============================================================
//  GATHER CONTACT DATA FROM FORM FIELDS
// ============================================================
function gatherContactData() {
  var fullName = (document.getElementById("fullName")?.value || "").trim();
  var nameParts = fullName.split(/\s+/);
  var firstName = nameParts[0] || "";
  var lastName = nameParts.slice(1).join(" ") || "";
  var phone = (document.getElementById("phone")?.value || "").replace(/\D/g, '');
  var email = (document.getElementById("email")?.value || "").trim();
  var street = (document.getElementById("streetAddress")?.value || "").trim();
  var city = (document.getElementById("city")?.value || "").trim();
  var state = (document.getElementById("state")?.value || "").trim();
  var zip = (document.getElementById("postalCode")?.value || "").trim();

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
      source: params.get("utm_source") || "",
      medium: params.get("utm_medium") || "",
      campaign: params.get("utm_campaign") || "",
      content: params.get("utm_content") || "",
      term: params.get("utm_term") || ""
    }
  };
}

// ============================================================
//  GHL API v2: CREATE CONTACT (Step 1 — name + address only)
// ============================================================
function createContactInGHL() {
  var data = gatherContactData();

  var body = {
    locationId: GHL_CONFIG.locationId,
    firstName: data.firstName,
    lastName: data.lastName,
    address1: data.address1,
    city: data.city,
    state: data.state,
    postalCode: data.postalCode,
    source: 'Window Estimator',
    tags: ['window-estimator']
  };

  if (data.utm.source) body.tags.push('utm_source:' + data.utm.source);
  if (data.utm.medium) body.tags.push('utm_medium:' + data.utm.medium);
  if (data.utm.campaign) body.tags.push('utm_campaign:' + data.utm.campaign);

  return ghlApiFetch('/contacts/', {
    method: 'POST',
    body: JSON.stringify(body)
  }).then(function(result) {
    if (result && result.contact && result.contact.id) {
      window.ghlContactId = result.contact.id;
      console.log('GHL contact created:', window.ghlContactId);
    }
    return result;
  }).catch(function(err) {
    console.error('GHL contact creation failed:', err);
  });
}

// ============================================================
//  GHL API v2: UPDATE CONTACT PHONE/EMAIL (Step 3)
// ============================================================
function updateContactPhone() {
  var data = gatherContactData();

  // If we have a contactId from Step 1, update the existing contact
  if (window.ghlContactId) {
    var body = { phone: data.phone };
    if (data.email) body.email = data.email;

    return ghlApiFetch('/contacts/' + window.ghlContactId, {
      method: 'PUT',
      body: JSON.stringify(body)
    }).then(function(result) {
      console.log('GHL contact updated with phone/email:', window.ghlContactId);
      return result;
    }).catch(function(err) {
      console.error('GHL contact update failed:', err);
    });
  }

  // Fallback: Step 1 API failed, so upsert a new contact matching on phone
  var body = {
    locationId: GHL_CONFIG.locationId,
    firstName: data.firstName,
    lastName: data.lastName,
    phone: data.phone,
    address1: data.address1,
    city: data.city,
    state: data.state,
    postalCode: data.postalCode,
    source: 'Window Estimator',
    tags: ['window-estimator']
  };
  if (data.email) body.email = data.email;

  return ghlApiFetch('/contacts/upsert', {
    method: 'POST',
    body: JSON.stringify(body)
  }).then(function(result) {
    if (result && result.contact && result.contact.id) {
      window.ghlContactId = result.contact.id;
      console.log('GHL contact upserted (fallback):', window.ghlContactId);
    }
    return result;
  }).catch(function(err) {
    console.error('GHL contact upsert failed:', err);
  });
}

// ============================================================
//  GHL API v2: UPDATE CONTACT WITH ESTIMATE DATA (Step 4)
// ============================================================
function updateContactEstimate(contactId, estimateTotal, pdfUrl) {
  if (!contactId) {
    console.warn('No GHL contactId available, skipping estimate update');
    return Promise.resolve(null);
  }

  var body = {
    tags: ['estimate-completed'],
    customFields: []
  };

  if (estimateTotal) {
    body.customFields.push({ key: 'estimate_total', field_value: String(estimateTotal) });
  }
  if (pdfUrl) {
    body.customFields.push({ key: 'estimate_pdf_url', field_value: pdfUrl });
  }

  return ghlApiFetch('/contacts/' + contactId, {
    method: 'PUT',
    body: JSON.stringify(body)
  }).then(function(result) {
    console.log('GHL contact updated with estimate data:', contactId);
    return result;
  }).catch(function(err) {
    console.error('GHL contact estimate update failed:', err);
  });
}

// ============================================================
//  GHL: LIGHTWEIGHT WORKFLOW TRIGGER (webhook with contactId)
// ============================================================
function triggerGHLWorkflow(contactId, eventType) {
  if (!GHL_CONFIG.workflowWebhookUrl) return Promise.resolve(null);

  return fetch(GHL_CONFIG.workflowWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contact_id: contactId || '',
      event: eventType || 'estimate_completed'
    })
  }).catch(function(err) {
    console.warn('GHL workflow trigger failed:', err);
  });
}

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
      '<option value="argon">Argon Gas</option>';
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
  createContactInGHL();
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

  updateContactPhone().finally(function() {
    goToStep(4);
  });
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

  // Show "How This Works" only on step 1
  document.getElementById('howItWorks').style.display = (n === 1) ? '' : 'none';

  // Build summary and auto-send PDF to GHL when arriving at estimate step
  if (n === 4) {
    buildSummary();
    sendPDFToGHL();
  }

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
    stories: document.getElementById('stories').value
  };
}

function getWindowLabel(config) {
  const styleLabels = {
    single_hung: 'Single-Hung', double_hung: 'Double-Hung', casement: 'Casement',
    sliding: 'Sliding', awning: 'Awning', picture: 'Picture', three_lite: 'Three Lite Slider', custom_shape: 'Custom Shape'
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
      modifierTags.push(c.stories === '2' ? '2-Story' : '3+ Story');
    }
    if (cost.isImpact) {
      modifierTags.push('Impact Rated');
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
  let windowSubtotal = 0;
  let totalWindows = 0;

  let windowRows = '';
  windows.forEach((w, i) => {
    const c = w.config;
    const cost = w.cost;
    const label = getWindowLabel(c);

    windowSubtotal += cost.totalCost;
    totalWindows += c.qty;

    const impactLabel = cost.isImpact ? ' (Impact)' : '';
    windowRows += '<tr>' +
      '<td colspan="4" style="font-weight:700; background:var(--light-bg); color:var(--deep-navy);">' +
        '#' + (i + 1) + ' ' + label + ' ' + (c.qty > 1 ? '&times; ' + c.qty : '') +
        impactLabel +
      '</td>' +
    '</tr>';
    windowRows += '<tr><td style="padding-left:1.5rem;">Base Price (' + getStyleLabel(c.style) + (cost.isImpact ? ', Impact' : '') + ', ' + cost.unitedInches + ' UI)</td><td>' + fmt(cost.breakdown.chartPrice) + '</td><td>&times; ' + c.qty + '</td><td>' + fmt(cost.breakdown.chartPrice * c.qty) + '</td></tr>';

    if (cost.breakdown.frameMult !== 0) {
      windowRows += '<tr><td style="padding-left:1.5rem;">Frame Adj. (' + PRICING.frameMaterial[c.frame].label + ')</td><td>' + fmt(cost.breakdown.frameMult) + '</td><td>&times; ' + c.qty + '</td><td>' + fmt(cost.breakdown.frameMult * c.qty) + '</td></tr>';
    }
    if (cost.breakdown.glassPanes !== 0) {
      windowRows += '<tr><td style="padding-left:1.5rem;">' + PRICING.glassPanes[c.panes].label + '</td><td>' + fmt(cost.breakdown.glassPanes) + '</td><td>&times; ' + c.qty + '</td><td>' + fmt(cost.breakdown.glassPanes * c.qty) + '</td></tr>';
    }
    if (cost.breakdown.gasFill > 0) {
      windowRows += '<tr><td style="padding-left:1.5rem;">' + PRICING.gasFill[c.gas].label + '</td><td>' + fmt(cost.breakdown.gasFill) + '</td><td>&times; ' + c.qty + '</td><td>' + fmt(cost.breakdown.gasFill * c.qty) + '</td></tr>';
    }
    if (cost.breakdown.grid > 0) {
      windowRows += '<tr><td style="padding-left:1.5rem;">' + PRICING.gridPattern[c.grid].label + '</td><td>' + fmt(cost.breakdown.grid) + '</td><td>&times; ' + c.qty + '</td><td>' + fmt(cost.breakdown.grid * c.qty) + '</td></tr>';
    }
    if (cost.breakdown.upgrades > 0) {
      const upgradeLabels = c.upgrades.filter(u => u !== 'impact').map(u => PRICING.glassUpgrades[u] ? PRICING.glassUpgrades[u].label : u).join(', ');
      windowRows += '<tr><td style="padding-left:1.5rem;">Upgrades (' + upgradeLabels + ')</td><td>' + fmt(cost.breakdown.upgrades) + '</td><td>&times; ' + c.qty + '</td><td>' + fmt(cost.breakdown.upgrades * c.qty) + '</td></tr>';
    }
    if (cost.breakdown.storySurcharge > 0) {
      windowRows += '<tr><td style="padding-left:1.5rem;">Story Surcharge</td><td>' + fmt(cost.breakdown.storySurcharge) + '</td><td>&times; ' + c.qty + '</td><td>' + fmt(cost.breakdown.storySurcharge * c.qty) + '</td></tr>';
    }
    windowRows += '<tr class="subtotal"><td style="padding-left:1.5rem;">Subtotal</td><td>' + fmt(cost.perWindowCost) + '</td><td>&times; ' + c.qty + '</td><td>' + fmt(cost.totalCost) + '</td></tr>';
  });

  // Bulk discount
  let bulkDiscountAmt = 0;
  if (project.bulkDiscountRate > 0) {
    bulkDiscountAmt = round2(windowSubtotal * project.bulkDiscountRate);
  }

  const subtotalBeforePermit = round2(windowSubtotal - bulkDiscountAmt);
  const permitFee = round2(subtotalBeforePermit * 0.03);
  const grandTotal = round2(subtotalBeforePermit + permitFee);
  window.latestEstimateTotal = grandTotal;

  // Cost range
  const lowEstimate = round2(grandTotal * 0.80);
  const highEstimate = round2(grandTotal * 1.20);

  // Customer info
  const custName = document.getElementById('fullName').value.trim();
  const custAddress = document.getElementById('streetAddress').value.trim();
  const custCity = document.getElementById('city').value.trim();
  const custState = document.getElementById('state').value.trim();
  const custPostal = document.getElementById('postalCode').value.trim();
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
      '<tr><td>Windows Subtotal (incl. installation)</td><td>' + fmt(windowSubtotal) + '</td></tr>';

  if (bulkDiscountAmt > 0) {
    html += '<tr><td>Bulk Discount (' + Math.round(project.bulkDiscountRate * 100) + '% for ' + totalWindows + ' windows)</td><td style="color:var(--cta-red);">-' + fmt(bulkDiscountAmt) + '</td></tr>';
  }
  html += '<tr><td>Permit Fee (3%)</td><td>' + fmt(permitFee) + '</td></tr>';

  html += '<tr class="total"><td>Estimated Total</td><td>' + fmt(grandTotal) + '</td></tr>' +
    '</table>' +
  '</div>';

  html += '<div class="summary-section">' +
    '<h3>Cost Range</h3>' +
    '<table class="summary-table">' +
      '<tr><td>Low Estimate (-20%)</td><td>' + fmt(lowEstimate) + '</td></tr>' +
      '<tr class="subtotal"><td>Mid Estimate</td><td>' + fmt(grandTotal) + '</td></tr>' +
      '<tr><td>High Estimate (+20%)</td><td>' + fmt(highEstimate) + '</td></tr>' +
    '</table>' +
    '<p style="font-size:0.78rem; color:var(--text-gray); margin-top:0.5rem;">' +
      'Range accounts for brand variance, local market conditions, and contractor pricing differences.' +
    '</p>' +
  '</div>';

  html += '<div class="summary-section">' +
    '<h3>Potential Savings</h3>' +
    '<table class="summary-table">' +
      '<tr><td>ENERGY STAR Tax Credit (up to 30%, max $600/yr)</td><td style="color:var(--cta-red);">Up to -' + fmt(Math.min(windowSubtotal * 0.30, 600)) + '</td></tr>' +
      '<tr><td>Energy Savings (est. 12% on heating/cooling bills annually)</td><td style="color:var(--cta-red);">Varies by home</td></tr>' +
    '</table>' +
  '</div>';

  document.getElementById('summaryContent').innerHTML = html;
  updateRunningTotal();
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

// ============================================================
//  PDF GENERATION & SEND TO GHL
// ============================================================

function generateEstimatePDF() {
  return new Promise(function(resolve, reject) {
    var summaryEl = document.getElementById('summaryContent');
    if (!summaryEl || !summaryEl.innerHTML.trim()) {
      reject(new Error('No estimate content to generate PDF from.'));
      return;
    }

    // Build a self-contained HTML element for the PDF
    var pdfContainer = document.createElement('div');
    pdfContainer.style.cssText = 'padding:20px; font-family:Nunito Sans,sans-serif; color:#1a2a3a; font-size:12px;';

    // Header
    var header = document.createElement('div');
    header.style.cssText = 'text-align:center; margin-bottom:20px; padding-bottom:15px; border-bottom:2px solid #c0392b;';
    header.innerHTML =
      '<h1 style="margin:0 0 4px 0; font-size:22px; color:#1a2a3a;">Reece Windows & Doors</h1>' +
      '<p style="margin:0 0 4px 0; font-size:11px; color:#6b7b8d;">Family-Owned Since 1972 &bull; Licensed &amp; Insured</p>' +
      '<p style="margin:0; font-size:11px; color:#6b7b8d;">Window Replacement Estimate &mdash; ' + new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' }) + '</p>';
    pdfContainer.appendChild(header);

    // Clone summary content
    var contentClone = summaryEl.cloneNode(true);
    // Style tables for PDF readability
    contentClone.querySelectorAll('table').forEach(function(table) {
      table.style.cssText = 'width:100%; border-collapse:collapse; margin-bottom:12px; font-size:11px;';
    });
    contentClone.querySelectorAll('td, th').forEach(function(cell) {
      cell.style.cssText += '; padding:6px 8px; border-bottom:1px solid #e0e0e0;';
    });
    contentClone.querySelectorAll('.total td').forEach(function(cell) {
      cell.style.cssText += '; font-weight:700; font-size:14px; border-top:2px solid #1a2a3a;';
    });
    pdfContainer.appendChild(contentClone);

    // Disclaimer footer
    var footer = document.createElement('div');
    footer.style.cssText = 'margin-top:20px; padding-top:10px; border-top:1px solid #e0e0e0; font-size:9px; color:#6b7b8d;';
    footer.innerHTML = '<strong>Disclaimer:</strong> This estimate is based on current industry pricing and typical installation conditions. Final pricing may vary after on-site verification.';
    pdfContainer.appendChild(footer);

    var opt = {
      margin:       [0.5, 0.5, 0.5, 0.5],
      filename:     'Reece-Windows-Estimate.pdf',
      image:        { type: 'jpeg', quality: 0.95 },
      html2canvas:  { scale: 2, useCORS: true, logging: false },
      jsPDF:        { unit: 'in', format: 'letter', orientation: 'portrait' },
      pagebreak:    { mode: ['avoid-all', 'css', 'legacy'] }
    };

    var worker = html2pdf().set(opt).from(pdfContainer);
    Promise.all([
      worker.outputPdf('datauristring'),
      worker.outputPdf('blob')
    ]).then(function(results) {
      var dataUri = results[0];
      var blob = results[1];
      var base64 = dataUri.split(',')[1];
      resolve({
        base64: base64,
        dataUri: dataUri,
        blob: blob
      });
    }).catch(function(err) {
      reject(err);
    });
  });
}

function uploadPDFToGHL(blob) {
  var formData = new FormData();
  var fileName = 'Reece-Windows-Estimate-' + Date.now() + '.pdf';
  formData.append('file', blob, fileName);

  return fetch(GHL_CONFIG.baseUrl + "/medias/upload-file", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + GHL_CONFIG.pit,
      "Version": GHL_CONFIG.apiVersion
    },
    body: formData
  }).then(function(response) {
    if (!response.ok) {
      return response.text().then(function(text) {
        throw new Error('GHL media upload failed (' + response.status + '): ' + text);
      });
    }
    return response.json();
  }).then(function(data) {
    console.log('GHL media upload response:', JSON.stringify(data));
    return data.url || data.fileUrl || data.altId || null;
  });
}

function sendPDFToGHL() {
  generateEstimatePDF().then(function(pdf) {
    var estimateTotal = window.latestEstimateTotal || "";
    var contactId = window.ghlContactId || null;

    return uploadPDFToGHL(pdf.blob).then(function(fileUrl) {
      console.log('PDF uploaded to GHL media library:', fileUrl);
      return updateContactEstimate(contactId, estimateTotal, fileUrl);
    }).catch(function(uploadErr) {
      console.warn('PDF upload failed, updating contact without PDF URL:', uploadErr);
      return updateContactEstimate(contactId, estimateTotal, null);
    }).then(function() {
      return triggerGHLWorkflow(contactId, 'estimate_completed');
    });
  }).catch(function(err) {
    console.error('PDF generation/send failed:', err);
  });
}

function openMeasurementVerification() {
  var fullName = (document.getElementById("fullName")?.value || "").trim();
  var nameParts = fullName.split(/\s+/);
  var firstName = nameParts[0] || "";
  var lastName = nameParts.slice(1).join(" ") || "";
  var phone = (document.getElementById("phone")?.value || "").trim();
  var email = (document.getElementById("email")?.value || "").trim();

  const url =
    `https://landing.reecewindows.com/confirm-your-pricing?` +
    `first_name=${encodeURIComponent(firstName)}&last_name=${encodeURIComponent(lastName)}&phone=${encodeURIComponent(phone)}&email=${encodeURIComponent(email)}`;

  window.location.href = url;
}
