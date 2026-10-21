const test = require('node:test');
const assert = require('node:assert/strict');
const sku = require('../frontend/mixed-sku');
const { importParts, reconcileProductSelections } = require('../backend/services/mixedPartImport');
const product = (id, code, source_number) => ({ id, code, source_number, name: code, ratio: 1, na_ratio: .25 });
const config = () => ({ enabled: true, mode: 'equal', units_per_pack: 1, na_direct: true, products: [
  product('p59', 'BEAUTYM-S3-059', '56'), product('p60', 'BEAUTYM-S3-060', '57'),
  product('p24', 'BEAUTYM-S3-024-excl', '58'), product('p40', 'BEAUTYM-S3-040-excl', '59'),
  product('p48', 'BEAUTYM-S3-048-excl', '60'),
] });

test('独家款编号来自正式货号，NO59不能让040-excl认领59零件', () => {
  const cfg = config();
  assert.equal(sku.productSerial(cfg.products[3]), '59', '排序与供应商别名仍可使用NO');
  assert.deepEqual(cfg.products.map(sku.productPartNumber), ['59', '60', '24', '40', '48']);
  for (const [number, id] of [['59','p59'], ['60','p60'], ['24','p24'], ['40','p40'], ['48','p48']]) {
    assert.deepEqual(sku.productsForPartCode(cfg, number).map(p => p.id), [id]);
  }
  assert.equal(sku.productPartNumber(product('other', 'ACME-SPECIAL', '59')), 'ACME-SPECIAL');
});

test('独家款导入按正式编号更新占位，已有ID、比例和排序NO均保留', () => {
  const records = config().products.map(p => ({ code: p.code, name: p.name, source_number: p.source_number }));
  const original = { ...config(), products: ['59','60','24','40','48'].map(n => product('number_'+n, n, n)) };
  const next = sku.apply(original, records);
  assert.equal(next.added, 0); assert.equal(next.matched, 5);
  assert.deepEqual(next.config.products.map(p => p.id), ['number_59','number_60','number_24','number_40','number_48']);
  assert.deepEqual(next.config.products.map(p => p.source_number), ['56','57','58','59','60']);
  assert.ok(next.config.products.every(p => p.na_ratio === .25));
});

test('独家款模具导入和产品更新不再与59/60冲突，旧NO误关联自动移到正式款并保留用量价格', () => {
  const cfg = config();
  for (const mode of ['append','replace']) {
    const imported = importParts(cfg, {}, [{ mold_no:'M', parts:[{name:'59-管盖'},{name:'40-瓶身'},{name:'48-罐盖'},{name:'60-瓶盖'}] }], { mode });
    const names = new Map(imported.engineering.mixed_imported_parts.map(p => [p.id,p.name]));
    for (const [id,name] of [['p59','59-管盖'],['p40','40-瓶身'],['p48','48-罐盖'],['p60','60-瓶盖']]) {
      assert.equal(names.get(imported.engineering.mixed_part_selections[id][0].part_id), name);
    }
  }
  const parts = [{id:'cap59',name:'59-管盖',shot_price:.5,material_unit_price:.02}, {id:'body40',name:'40-瓶身'}];
  const refs = {p40:[{part_id:'cap59',usage:2}]};
  const eng = {mixed_imported_parts:parts,mixed_part_selections:refs};
  const molding = {parts_catalog:{parts:structuredClone(parts),selections:structuredClone(refs)}};
  const before = JSON.stringify({cfg,eng,molding});
  const result = reconcileProductSelections(cfg,eng,molding,{updatedProductIds:cfg.products.map(p=>p.id)});
  assert.deepEqual(result.engineering.mixed_part_selections.p59,[{part_id:'cap59',usage:2}]);
  assert.deepEqual(result.engineering.mixed_part_selections.p40,[{part_id:'body40',usage:1}]);
  assert.deepEqual(result.molding.parts_catalog.parts,parts);
  assert.deepEqual(result.molding.parts_catalog.selections,result.engineering.mixed_part_selections);
  assert.equal(JSON.stringify({cfg,eng,molding}),before);
  assert.equal(reconcileProductSelections(cfg,result.engineering,result.molding,{updatedProductIds:cfg.products.map(p=>p.id)}).changes.length,0);
});

test('完整独家货号精确匹配；同编号确有两款时仍拒绝猜测', () => {
  const cfg = config(); cfg.products.push(product('regular40','BEAUTYM-S3-040','39'));
  assert.deepEqual(sku.productsForPartCode(cfg,'BEAUTYM-S3-040-excl').map(p=>p.id),['p40']);
  assert.throws(()=>importParts(cfg,{},[{mold_no:'M',parts:[{name:'40-瓶身'}]}]),/多个现有小产品/);
  const imported = importParts(cfg,{},[{mold_no:'M',parts:[{name:'40-瓶身',source_product_code:'BEAUTYM-S3-040-excl'}]}]);
  assert.equal(imported.engineering.mixed_part_selections.p40.length,1);
  assert.equal(imported.engineering.mixed_part_selections.regular40,undefined);
});
