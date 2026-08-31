'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadAccounts } = require('../backend/db/accountSeed');

test('configured account seed contains local account scopes without passwords', () => {
  const accounts = loadAccounts();
  assert.equal(accounts.length, 89);
  assert.equal(accounts.some(account => account.username === '谢建国' && account.allCustomers), true);
  assert.equal(accounts.some(account => account.username === '梁广才' && account.customers.includes('ZURU')), true);
  assert.equal(accounts.filter(account => account.dept !== 'sales' && account.role !== 'staff').length, 0);
  assert.equal(Object.values(accounts[0]).some(value => String(value).includes('888888')), false);
});
