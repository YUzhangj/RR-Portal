'use strict';
const fs = require('node:fs'), vm = require('node:vm');
const Pricing = require('../../frontend/injection-pricing');
const source = fs.readFileSync(require.resolve('../../frontend/workbench.js'), 'utf8');
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.dataset = {};
    this.classList = { add() {} }; this.value = ''; this.textContent = ''; }
  set innerHTML(value) { this.html = value; this.children = []; }
  get innerHTML() { return this.html || ''; }
  set value(value) { this.inputValue = String(value); }
  get value() { return this.inputValue; }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(key, value) { this[key] = value; }
  setCustomValidity(value) { this.validationMessage = value; }
  querySelectorAll(selector) { return this.children.flatMap(child => [
    ...(child.tagName === selector ? [child] : []), ...child.querySelectorAll(selector)]); }
}
module.exports = function structureUi(rows) {
  const alerts = [], changes = [];
  const context = vm.createContext({ window: { InjectionPricing: Pricing },
    document: { createElement: tag => new Element(tag) }, setTimeout() {},
    num: value => Number(value) || 0, alert: message => alerts.push(message) });
  vm.runInContext(source.slice(source.indexOf('function renderTable('), source.indexOf('// 辅助/包装材料 类别')), context);
  vm.runInContext(source.slice(source.indexOf('function formatNum('), source.indexOf('function legacyFormulaAmount(')), context);
  vm.runInContext(source.slice(source.indexOf('function changeInjectionStructure('), source.indexOf('function engineeringMoldSyncKey(')), context);
  const container = new Element('div');
  context.renderTable(container, [{ key: 'name', label: 'Name' }], rows, {
    onStructureChange: context.changeInjectionStructure, onChange: () => changes.push(JSON.stringify(rows)), showRowNumber: false,
  });
  return { alerts, changes, action(title, index = 0) {
    const tr = container.querySelectorAll('tbody')[0].children[index];
    const button = tr.children.at(-1).children.find(item => item.title === title);
    if (!button) throw new Error('Missing production action: ' + title);
    button.onclick();
  } };
};

// Use the same production pricing-cell input handlers for API round trips.
module.exports.pricing = function pricingUi(payload) {
  const context = vm.createContext({ payload, window: { InjectionPricing: Pricing },
    document: { createElement: tag => new Element(tag) }, setTimeout() {},
    num: value => Number(value) || 0, onChange() {}, refMolds: [], engineeringImagesForInjection: () => [] });
  vm.runInContext(source.slice(source.indexOf('function renderTable('), source.indexOf('// 辅助/包装材料 类别')), context);
  vm.runInContext(source.slice(source.indexOf('function formatNum('), source.indexOf('function legacyFormulaAmount(')), context);
  const start = source.indexOf('function renderMolding('), pricing = source.indexOf('  const shotRefreshers =', start);
  const columns = source.indexOf('  const cols = [', start);
  vm.runInContext(source.slice(pricing, source.indexOf("  renderTable(host.querySelector('#wb-material-prices')", pricing)) +
    source.slice(columns, source.indexOf('  const wrappedOnChange =', columns)) + '\nglobalThis.columns = cols;', context);
  const container = new Element('div');
  context.renderTable(container, context.columns, payload.injection, { onChange() {}, showRowNumber: false });
  const input = (key, index) => container.querySelectorAll('tbody')[0].children[index].children[
    context.columns.findIndex(column => column.key === key)].children[0];
  return { input, edit(key, value, index = 0) { const node = input(key, index); node.value = value; node.oninput(); } };
};
