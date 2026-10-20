const test = require('node:test');
const assert = require('node:assert/strict');
const {reconcileProductSelections} = require('../backend/services/mixedPartImport');

test('新增正式货号关联已有零件，保留啤机参数及手动取消的旧关联', () => {
  const config = {products:[{id:'a',code:'SKU-037'}, {id:'b',code:'SKU-038'}]};
  const parts = [
    {id:'shared',name:'共用盖',source_product_code:'SKU-037/SKU-038',production_demand:1234,shot_price:0.5},
    {id:'new',name:'38-瓶身',weight_g:3},
    {id:'manual-off',name:'37-瓶身'},
  ];
  const engineering = {mixed_imported_parts:parts,mixed_part_selections:{a:[{part_id:'shared',usage:2}]}};
  const molding = {parts_catalog:{parts:structuredClone(parts),selections:structuredClone(engineering.mixed_part_selections)}};
  const before = JSON.stringify({engineering,molding});
  const result = reconcileProductSelections(config,engineering,molding,{updatedProductIds:['b']});
  assert.deepEqual(result.engineering.mixed_part_selections.b,[{part_id:'shared',usage:2},{part_id:'new',usage:1}]);
  assert.deepEqual(result.engineering.mixed_part_selections.a,engineering.mixed_part_selections.a);
  assert.deepEqual(result.molding.parts_catalog.parts,parts);
  assert.deepEqual(result.molding.parts_catalog.selections,result.engineering.mixed_part_selections);
  assert.equal(JSON.stringify({engineering,molding}),before);
  assert.equal(reconcileProductSelections(config,result.engineering,result.molding,{updatedProductIds:['b']}).changes.length,0);
  const ratioOnly = reconcileProductSelections(config,engineering,molding);
  assert.equal(ratioOnly.engineering.mixed_part_selections.b?.some(ref=>ref.part_id==='new') || false,false);
});

test('新增小产品的已有共用零件用量冲突时不改动资料', () => {
  const config = {products:[{id:'a',code:'SKU-001'},{id:'b',code:'SKU-002'},{id:'c',code:'SKU-003'}]};
  // Numbered shared parts retain manual links, so additions must independently
  // check that the existing links agree on usage.
  const engineering = {mixed_imported_parts:[{id:'shared',name:'1/2/3-共用盖'}],
    mixed_part_selections:{a:[{part_id:'shared',usage:2}],b:[{part_id:'shared',usage:3}]}};
  const before = JSON.stringify(engineering);
  assert.throws(()=>reconcileProductSelections(config,engineering,{}, {updatedProductIds:['c']}),/用量不同/);
  assert.equal(JSON.stringify(engineering),before);
});
