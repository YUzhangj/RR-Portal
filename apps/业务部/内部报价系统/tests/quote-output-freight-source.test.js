'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../frontend/quote-output.js'), 'utf8');

test('运费计算参数弹窗显示具体关联字段和单位', () => {
  assert.match(source, /freightParameterLabels/);
  assert.match(source, /运费计算 · \$\{label\}/);
  assert.match(source, /valueLabel: `\$\{label\}（\$\{unit\}）`/);
  assert.match(source, /source-value-title/);
});
