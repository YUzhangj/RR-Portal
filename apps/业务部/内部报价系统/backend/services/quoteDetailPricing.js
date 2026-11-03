'use strict';

const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const rounded = value => +num(value).toFixed(4);
const valueOr = (value, fallback) => value == null || value === '' ? fallback : num(value);
const sum = (rows, fn) => (rows || []).reduce((total, row) => total + num(fn(row)), 0);

// Match renderSummaryPane/renderShipping: base and shares are rounded only where
// the detail page stores shipping.top; subsequent calculations keep precision.
function calculateDetailPricing({ quote, sales, engineering, mainBase, sewingHkd, electronicHkd }) {
  const fx = num(sales.header?.fx_hkd_usd) || 7.8;
  const shipping = sales.shipping || {};
  const markup = valueOr(shipping.markup_x, 1.2);
  const divisor = valueOr(shipping.divisor, 0.98);
  const sewingMarkup = valueOr(shipping.sew_markup_x, markup);
  const electronicMarkup = valueOr(shipping.elec_markup_x, markup);
  const surtaxMarkup = valueOr(shipping.surtax_markup_x, markup);
  const freightPct = valueOr(shipping.freight_pct, 48);
  const liftingPct = valueOr(shipping.lifting_pct, 52);
  const carton = engineering.carton_calc || {};
  const fc = sales.freight_calc || {
    cap_10t: 1166, cap_5t: 750, cap_40: 1980, cap_20: 883,
    hk40: 8000, hk20: 7100, yt40: 7200, yt20: 6000,
    hk10t: 14900, yt10t: 11500, hk5t: 12500, yt5t: 11000,
  };
  const cuft = num(carton.cuft) || num(carton.cl) * num(carton.cw) * num(carton.ch) / 1728;
  const pcs = Math.max(num(carton.qty) || 1, 1);
  const rateFor = scenario => {
    if (scenario.is_factory) return 0;
    const name = String(scenario.name || '');
    const prefix = /印尼|indo|indonesia/i.test(name) ? 'indo' : /盐田|YT|yt/.test(name) ? 'yt' : /香港|HK|hk/.test(name) ? 'hk' : null;
    const type = /40\s*柜|40['"\s]*[尺呎]?|40hq/i.test(name) ? '40'
      : /20\s*柜|20['"\s]*[尺呎]?|20hq/i.test(name) ? '20'
      : /10\s*吨/.test(name) ? '10t' : /5\s*吨/.test(name) ? '5t' : null;
    if (prefix && prefix !== 'indo' && type) {
      return num(fc[prefix + type]) / Math.max(Math.round(num(fc['cap_' + type]) / (cuft > 0 ? cuft : 1)), 1) / pcs;
    }
    return num(scenario.base_rmb);
  };
  const mc = engineering.mold_costs || {};
  const amortQty = Math.max(num(mc.amortization_qty) || num(sales.pricing?.mold_amortization_qty) || num(quote.qty), 1);
  const moldFx = num(mc.fx_rmb_usd) || 7.75;
  const moldShare = rounded((sum(mc.items, row => row.price_rmb) / 0.85 / moldFx - num(mc.customer_subsidy_usd)) / amortQty);
  const prototypeShare = rounded(num(mc.prototype_fee_usd ?? mc.prototype_fee_rmb) / Math.max(num(mc.prototype_amortization_qty) || 50000, 1));
  const testingShare = rounded(num(mc.testing_fee_usd ?? mc.testing_fee_rmb) / Math.max(num(mc.testing_amortization_qty) || 2000, 1));
  const supplied = sum(shipping.customer_supplied_products, row => row.amount_usd);
  const scenarios = Array.isArray(shipping.scenarios) ? shipping.scenarios : [{ name: '盐田40柜' }, { name: '盐田5吨车' }];
  const customer = scenarios.find(row => !row.is_factory) || { is_factory: true };
  const rate = rateFor(customer);
  const marked = (rounded(mainBase) + rate * (freightPct + liftingPct) / 100) * markup
    + rounded(sewingHkd) * sewingMarkup + rounded(electronicHkd) * electronicMarkup;
  const finalUsd = marked / divisor / fx + moldShare + prototypeShare + testingShare + supplied;
  const surtaxUsd = finalUsd * 0.004;
  const quotedUsd = finalUsd + surtaxUsd * surtaxMarkup / divisor;
  // The detail page's tax analysis uses TOTAL USD × divisor × FX, not TOTAL USD × FX.
  const taxScenario = scenarios.find(row => /盐田.*40/i.test(row.name || ''));
  const taxRate = taxScenario ? rateFor(taxScenario) : 0;
  return { quotedPrice: quotedUsd * divisor * fx, quotedUsd, surtaxHkd: surtaxUsd * fx,
    freight: taxRate * freightPct / 100, cabinet: taxRate * liftingPct / 100,
    moldShare, prototypeShare, testingShare, scenarioRates: scenarios.map(rateFor) };
}

module.exports = { calculateDetailPricing };
