'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('new quote customer is selected only from account-authorized customers', () => {
  const route = fs.readFileSync(path.join(__dirname, '../backend/routes/quotes.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '../frontend/main.js'), 'utf8');
  assert.match(route, /JOIN user_factories uf ON uf\.user_id = uc\.user_id/);
  assert.match(route, /该客户不在当前账号的授权范围内/);
  assert.match(html, /id="q-customer"[^>]+readonly/);
  assert.match(main, /当前账号暂无授权客户，请联系管理员配置/);
  assert.doesNotMatch(main, /＋ 新建客户/);
});
