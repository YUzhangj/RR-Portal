'use strict';

const SPIN_MASTER_INDONESIA = 'SPINMASTER-毛绒（印尼）';

function normalizedCustomer(customer) {
  return String(customer || '').trim().toUpperCase();
}

function isSpinCustomer(customer) {
  const normalized = normalizedCustomer(customer);
  // 保留旧名称兼容历史报价；新报价使用业务客户全称。
  return normalized === 'SPIN' || normalized === SPIN_MASTER_INDONESIA;
}

function vqCustomerProfile(customer) {
  if (isSpinCustomer(customer)) return 'SPIN';
  if (normalizedCustomer(customer) === 'TOMY') return 'TOMY';
  return null;
}

module.exports = { isSpinCustomer, vqCustomerProfile };
