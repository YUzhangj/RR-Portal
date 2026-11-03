'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Pricing = require('../frontend/injection-pricing');
const { buildWorkbook } = require('../backend/services/exportInternal');
const source = fs.readFileSync(require.resolve('../frontend/workbench.js'), 'utf8');
const prices = [{ model: '20A', normal: '200T', price: 2020 },
  { model: '10A-12A', normal: '120T', price: 1210 }];
function sync(payload, molds) {
  const context = { window: { InjectionPricing: Pricing } };
  vm.runInNewContext(source.slice(source.indexOf('function engineeringMoldSyncKey('),
    source.indexOf('function engineeringImagesForInjection(')), context);
  vm.runInNewContext(source.slice(source.indexOf('function syncInjectionMolds('),
    source.indexOf('// 啤机部料价表默认值')), context);
  context.syncInjectionMolds(payload, molds);
}

test('01M目标数、套数、机型、台班价变化均重新计算，不保留旧啤价', () => {
  const row = { machine_model: '20A', target: 2600, sets: 1, shot_price: 0.7769 };
  row.target = 1760; Pricing.reprice(row, prices);
  assert.equal(row.shot_price, 1.1477);
  row.sets = 2; Pricing.reprice(row, prices);
  assert.equal(row.shot_price, 0.5739);
  row.machine_model = '10A'; Pricing.reprice(row, prices);
  assert.equal(row.shot_price, 0.3438);
  Pricing.reprice(row, [{ model: '10A', price: 1408 }]);
  assert.equal(row.shot_price, 0.4);
});

test('无效公式输入清除旧价，0费用有效，同模次行不重复收费', () => {
  for (const patch of [{ target: 0 }, { target: null }, { sets: 0 }, { sets: -1 },
    { machine_model: '未知' }, { machine_model: '200A' }]) {
    const row = { machine_model: '20A', target: 2600, sets: 1, shot_price: 0.7769, ...patch };
    Pricing.reprice(row, prices); assert.equal(row.shot_price, null);
  }
  assert.equal(Pricing.calculate({ machine_model: '20A', target: 1 }, [{ model: '20A', price: 0 }]), 0);
  assert.equal(Pricing.calculate({ mold_part_index: 1 }, prices), 0);
  assert.equal(Pricing.lookupMachinePrice('120A', prices), null);
});

test('共模分阶段成本不被普通套数公式覆盖', () => {
  const row = { catalog_raw_weight: 0, machine_model: '20A', target: 2600, shot_price: 0.1234 };
  Pricing.reprice(row, prices); assert.equal(row.shot_price, 0.1234);
});

test('工程同步保留10月9日已填目标数与啤价，新行按真实费用算价', () => {
  const targets = [2600, 2400, 3400, 3400, 3200, 3500, 3500];
  const injection = targets.map((target, index) => ({ mold_no: `0${index + 1}M`, name: '零件',
    machine_model: '20A', target, sets: 1, shot_price: Pricing.calculate({ machine_model: '20A', target, sets: 1 }, prices) }));
  const payload = { machine_prices: prices, injection: structuredClone(injection) };
  const molds = injection.map((row, index) => ({ ...row, target: index < 4 ? 1760 : 2640, shot_price: null }));
  molds.push({ mold_no: '08M', name: '新零件', machine_model: '20A', target: 2000, sets: 2 });
  sync(payload, molds);
  assert.deepEqual(Array.from(payload.injection.slice(0, 7), row => row.target), targets);
  assert.deepEqual(Array.from(payload.injection.slice(0, 7), row => row.shot_price), injection.map(row => row.shot_price));
  assert.equal(payload.injection[7].shot_price, 0.505);
});

test('同步时机型变动重算啤价，保留目标0且不沿用旧价', () => {
  const payload = { machine_prices: prices, injection: [{ mold_no: '01M', name: '零件',
    machine_model: '20A', target: 2600, sets: 1, shot_price: 0.7769 }] };
  sync(payload, [{ mold_no: '01M', name: '零件', machine_model: '10A', target: 1760 }]);
  assert.equal(payload.injection[0].target, 2600);
  assert.equal(payload.injection[0].shot_price, 0.4654);
  payload.injection[0].target = 0;
  sync(payload, [{ mold_no: '01M', name: '零件', machine_model: '20A', target: 1760 }]);
  assert.equal(payload.injection[0].target, 0);
  assert.equal(payload.injection[0].shot_price, null);
});

test('导出引用真实2020费用且四舍五入与缓存一致；历史手填价不伪造费用', async () => {
  const rows = [
    { mold_no: '01M', machine_model: '20A', sets: 1, target: 2600, shot_price: 0.7769 },
    { mold_no: '02M', machine_model: '20A', sets: 1, target: 1760, shot_price: 0.7769 },
    { mold_no: '03M', machine_model: '20A', sets: 1, target: 1760, shot_price: 1.1477 },
    { mold_no: '04M', machine_model: '20A', sets: 1, target: 1760, shot_price: 0, mold_part_index: 1 },
    { mold_no: '05M', machine_model: '20A', sets: 1, target: 1760, shot_price: 0.5, catalog_raw_weight: 1 },
  ];
  const payload = { machine_prices: prices, injection: rows };
  const before = JSON.stringify(payload);
  const wb = await buildWorkbook({ quote: { qty: 1000 }, sections: [{ dept: 'molding', payload_json: before }] });
  assert.equal(JSON.stringify(payload), before);
  const loaded = new (require('exceljs').Workbook)();
  await loaded.xlsx.load(await wb.xlsx.writeBuffer());
  for (const name of ['报价明细', '啤机明细']) {
    const ws = loaded.getWorksheet(name); let start;
    ws.eachRow(row => { if (row.getCell(1).value === '模号' && row.getCell(2).value === '模具名称') start = row.number + 1; });
    assert.ok(start);
    assert.equal(ws.getCell(start, 9).formula, `ROUND(2020/J${start}/L${start},4)`);
    assert.equal(ws.getCell(start, 9).result, 0.7769);
    assert.equal(ws.getCell(start + 1, 9).value, 0.7769);
    assert.match(ws.getCell(start + 1, 9).note, /固定值/);
    assert.equal(ws.getCell(start + 2, 9).formula, `ROUND(2020/J${start + 2}/L${start + 2},4)`);
    assert.equal(ws.getCell(start + 2, 9).result, 1.1477);
    assert.equal(ws.getCell(start + 3, 9).value, 0);
    assert.equal(ws.getCell(start + 4, 9).value, 0.5);
  }
});
