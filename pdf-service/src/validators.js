'use strict';

/**
 * Validate the incoming /api/generate-estimate-pdf payload.
 * Returns { valid: boolean, errors: string[] }.
 *
 * We only validate the fields the template actually reads. Missing optional
 * fields (contact_id, ghl_api_key) are handled downstream — a missing
 * contact_id means "skip GHL upload and return base64 to the browser".
 */
function validatePayload(body) {
  const errors = [];

  if (!body || typeof body !== 'object') {
    return { valid: false, errors: ['Request body must be a JSON object'] };
  }

  const estimate = body.estimate;
  if (!estimate || typeof estimate !== 'object') {
    errors.push('estimate object is required');
    return { valid: false, errors };
  }

  // Customer
  const customer = estimate.customer;
  if (!customer || typeof customer !== 'object') {
    errors.push('estimate.customer object is required');
  } else {
    if (!customer.name || typeof customer.name !== 'string') {
      errors.push('estimate.customer.name is required');
    }
    // address is expected but we don't hard-fail on it — some users skip it
    // and the template handles missing values gracefully.
  }

  // Project
  if (!estimate.project || typeof estimate.project !== 'object') {
    errors.push('estimate.project object is required');
  }

  // Windows
  if (!Array.isArray(estimate.windows) || estimate.windows.length === 0) {
    errors.push('estimate.windows must be a non-empty array');
  } else {
    estimate.windows.forEach((w, i) => {
      if (typeof w !== 'object' || w === null) {
        errors.push(`estimate.windows[${i}] must be an object`);
        return;
      }
      if (typeof w.qty !== 'number' || w.qty < 1) {
        errors.push(`estimate.windows[${i}].qty must be a positive number`);
      }
      if (typeof w.totalCost !== 'number') {
        errors.push(`estimate.windows[${i}].totalCost must be a number`);
      }
      if (!w.breakdown || typeof w.breakdown !== 'object') {
        errors.push(`estimate.windows[${i}].breakdown object is required`);
      }
    });
  }

  // Costs
  const costs = estimate.costs;
  if (!costs || typeof costs !== 'object') {
    errors.push('estimate.costs object is required');
  } else {
    if (typeof costs.grandTotal !== 'number') {
      errors.push('estimate.costs.grandTotal must be a number');
    }
    if (typeof costs.windowSubtotal !== 'number') {
      errors.push('estimate.costs.windowSubtotal must be a number');
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { validatePayload };
