const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const MixedSku = require('../frontend/mixed-sku');

// A small DOM fixture exercises the actual upload handlers, with controlled HTTP
// completion order. Browser layout and native file controls are checked separately.
class Element {
  constructor() { this.nodes = {}; this.attributes = {}; this.dataset = {}; this.children = []; this.isConnected = true; this.value = ''; }
  set innerHTML(value) {
    this.html = value; this.nodes = {};
    const node = key => (this.nodes[key] = new Element());
    if (value.includes('mixed-switch')) { node('select'); node('.mixed-help'); node('.mixed-detail'); }
    if (value.includes('data-assembly-preview')) { node('input'); node('[data-assembly-preview]'); }
    if (value.includes('data-assembly-apply')) {
      node('[data-assembly-apply]'); node('[data-assembly-cancel]'); node('[data-fill-qty]'); node('[data-bulk-qty]');
      this.quantityInputs = [...value.matchAll(/data-assembly-qty="(\d+)"[^>]* value="([^"]*)"/g)].map(match => {
        const input = new Element(); input.value = match[2]; input.checkValidity = () => input.value !== '' && Number(input.value) >= 1; return input;
      });
    }
  }
  get innerHTML() { return this.html || ''; }
  set textContent(value) { this.text = value; this.nodes = {}; }
  get textContent() { return this.text || ''; }
  querySelector(key) { return this.nodes[key] || null; }
  querySelectorAll(key) { return key === '[data-assembly-qty]' ? (this.quantityInputs || []) : []; }
  setAttribute(key, value) { this.attributes[key] = value; }
  appendChild(node) { this.children.push(node); }
  insertBefore(node) { this.children.unshift(node); }
}

function setup() {
  const cfg = {enabled:true,mode:'equal',units_per_pack:1,products:[{id:'a',code:'SKU-01',name:'甲款',ratio:1}]};
  const root = {mixed_products:{a:{}},mixed_shared:{}};
  const pending = new Map(), alerts = [];
  let changes = 0, confirmed = true;
  const window = {MixedSku,__data:{quote:{id:931},mixed_quote:cfg,sections:[]}};
  const context = {
    window, document:{createElement:() => new Element()},
    sessionStorage:{getItem:() => 'a',setItem(){}},
    FormData:class { append(key,value) { this[key] = value; } },
    fetch:(url, options) => new Promise(resolve => pending.set(options.body.file.name, resolve)),
    alert:message => alerts.push(message), confirm:() => confirmed,
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../frontend/mixed-quotation.js'), 'utf8'), context);
  const host = new Element();
  window.MixedQuotation.wrap(() => {}, 'assembly')(host, root, true, () => changes++);
  const upload = host.children[0], control = upload.querySelector('input'), preview = upload.querySelector('[data-assembly-preview]');
  const start = name => { control.files = [{name}]; control.value = name; return control.onchange({target:control}); };
  const finish = (name, data, status = 200) => pending.get(name)({ok:status === 200,status,json:async() => data});
  const result = (label = '原始表') => ({sheet_used:label,count:1,groups:[{source_product_code:'SKU-01',kind:'assembly',product:label,qty:12000,work_hours:10.5,team:2,steps:[{name:'安装',count:3,note:'保留备注'}]}]});
  return {cfg,root,window,upload,control,preview,pending,alerts,start,finish,result,get changes(){return changes;},set confirmed(value){confirmed=value;}};
}

test('mixed assembly preview accepts only the newest request and keeps latest busy state', async () => {
  const s = setup(), first = s.start('A.xlsx'), second = s.start('B.xlsx');
  s.finish('A.xlsx', s.result('旧A')); await first;
  assert.equal(s.upload.attributes['aria-busy'], 'true');
  assert.equal(s.preview.querySelector('[data-assembly-apply]'), null);
  s.finish('B.xlsx', s.result('新B')); await second;
  assert.match(s.preview.innerHTML, /新B/);
  s.preview.querySelector('[data-assembly-apply]').onclick();
  assert.equal(s.root.mixed_products.a.assembly_step_groups[0].product, '新B');
  assert.equal(s.changes, 1);
  assert.equal(s.upload.attributes['aria-busy'], 'false');
});

test('mixed assembly data edited while parsing is preserved and invalidates the response', async () => {
  const s = setup(), request = s.start('A.xlsx');
  s.root.mixed_products.a.assembly_step_groups = [{product:'手工新增',qty:20,steps:[{name:'手工',count:1}]}];
  const before = JSON.stringify(s.root);
  s.finish('A.xlsx', s.result()); await request;
  assert.match(s.preview.textContent, /已修改/);
  assert.equal(JSON.stringify(s.root), before);
  assert.equal(s.changes, 0);
});

test('editing after preview or replacing the quote configuration invalidates apply', async () => {
  for (const mutate of [s => { s.root.mixed_products.a.assembly_std_time = 9; }, s => { s.window.__data.mixed_quote = structuredClone(s.cfg); }]) {
    const s = setup(), request = s.start('A.xlsx'); s.finish('A.xlsx', s.result()); await request;
    mutate(s); const before = JSON.stringify(s.root);
    s.preview.querySelector('[data-assembly-apply]').onclick();
    assert.match(s.preview.textContent, /已修改/);
    assert.equal(JSON.stringify(s.root), before);
    assert.equal(s.changes, 0);
  }
});

test('cancel invalidates detached apply handlers and clears busy state', async () => {
  const s = setup(), request = s.start('A.xlsx'); s.finish('A.xlsx', s.result()); await request;
  const apply = s.preview.querySelector('[data-assembly-apply]');
  s.preview.querySelector('[data-assembly-cancel]').onclick(); apply.onclick();
  assert.equal(s.preview.textContent, ''); assert.equal(s.control.value, '');
  assert.equal(s.changes, 0); assert.equal(s.upload.attributes['aria-busy'], 'false');
});

test('valid import preserves metadata and one application is atomic even through an old handler', async () => {
  const s = setup(), request = s.start('A.xlsx'); s.finish('A.xlsx', s.result()); await request;
  const apply = s.preview.querySelector('[data-assembly-apply]'); apply.onclick(); apply.onclick();
  const payload = s.root.mixed_products.a;
  assert.equal(s.changes, 1); assert.equal(payload.assembly_std_time, 10.5);
  assert.equal(payload.assembly_step_groups[0].qty, 12000);
  assert.equal(payload.assembly_step_groups[0].team, 2);
  assert.equal(payload.assembly_step_groups[0].steps[0].note, '保留备注');
});

test('unknown SKU is all-or-nothing and never mutates existing labor data', async () => {
  const s = setup(), request = s.start('A.xlsx'), data = s.result(); data.groups[0].source_product_code = 'UNKNOWN';
  const before = JSON.stringify(s.root); s.finish('A.xlsx', data); await request;
  assert.match(s.preview.textContent, /无法唯一匹配/);
  assert.equal(JSON.stringify(s.root), before); assert.equal(s.changes, 0);
});

test('HTTP and invalid JSON failures recover the upload control without applying data', async () => {
  for (const status of [403,502]) {
    const s = setup(), request = s.start('A.xlsx');
    s.pending.get('A.xlsx')({ok:false,status,json:async() => { throw Error('HTML gateway body'); }}); await request;
    assert.match(s.preview.textContent, new RegExp(String(status)));
    assert.equal(s.control.value, ''); assert.equal(s.upload.attributes['aria-busy'], 'false'); assert.equal(s.changes, 0);
  }
});
