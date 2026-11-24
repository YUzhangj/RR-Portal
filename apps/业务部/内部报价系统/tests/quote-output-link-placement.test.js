'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../frontend/workbench.js'), 'utf8');

test('汇总与输出从顶部导航移动到部门导航右侧', () => {
  assert.match(source, /const outputLink = \$\('btn-output'\)/);
  assert.match(source, /outputLink\.classList\.add\('quote-output-link'\)/);
  assert.match(source, /tabBar\.appendChild\(outputLink\)/);
  assert.match(source, /tabBar\.appendChild\(sumTab\)[\s\S]*tabBar\.appendChild\(outputLink\)/);
});
