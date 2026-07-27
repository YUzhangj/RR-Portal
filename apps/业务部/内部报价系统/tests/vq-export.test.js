'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { sectionsToData } = require('../backend/services/exportVQ');

test('TOMY VQ converts internal electronic prices from HKD to USD', () => {
  const data = sectionsToData({
    quote: {
      id: 326,
      quote_no: 'TOMY-ELECTRONIC',
      product_name: 'Electronic Toy',
      customer: 'TOMY',
      qty: 1000,
    },
    sections: [
      {
        dept: 'electronic',
        payload_json: JSON.stringify({
          electronics: [{ name: 'IC', qty: 2, unit_price: 7.8 }],
        }),
      },
      {
        dept: 'sales',
        payload_json: JSON.stringify({
          header: { fx_hkd_usd: 7.8 },
        }),
      },
    ],
  });

  assert.equal(data.electronicItems[0].unit_price_usd, 1);
});
