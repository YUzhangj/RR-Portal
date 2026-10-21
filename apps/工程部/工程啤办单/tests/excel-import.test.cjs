const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const puppeteer = require('puppeteer');
const XLSX = require('../public/vendor/xlsx.full.min.js');

const APP_DIR = path.resolve(__dirname, '..');

test('Excel import uses local assets and preserves all supported order types', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-excel-import-'));
  const dataFile = path.join(dir, 'data.json');
  fs.writeFileSync(dataFile, JSON.stringify({
    injection_orders: [], injection_items: [], slush_orders: [], slush_items: [],
    spray_orders: [], spray_items: [], assembly_orders: [], assembly_items: [],
    material_prices: [], material_requisitions: [], assembly_users: [], problems: [], nextId: 1
  }));
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(APP_DIR, 'server.js')], {
    cwd: APP_DIR, env: { ...process.env, DATA_PATH: dir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverOutput = '';
  child.stdout.on('data', c => { serverOutput += c; });
  child.stderr.on('data', c => { serverOutput += c; });
  let browser;
  let proxy;
  try {
    for (let i = 0; ; i++) {
      if (child.exitCode != null || i > 100) throw new Error(serverOutput || 'local server failed');
      try { if ((await fetch(base + '/health')).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    // Server startup seeds auth/client defaults; compare storage after that initialization.
    await fetch(base + '/api/clients');
    await fetch(base + '/api/roles');
    const originalData = fs.readFileSync(dataFile, 'utf8');
    // Match nginx's /rr/ rewrite without starting or contacting deployed services.
    proxy = http.createServer((req, res) => {
      const upstream = http.request(base + req.url.replace(/^\/rr\//, '/'), {
        method: req.method, headers: req.headers
      }, response => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      });
      upstream.on('error', () => { res.writeHead(502); res.end(); });
      req.pipe(upstream);
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const proxied = `http://127.0.0.1:${proxy.address().port}/rr`;
    browser = await puppeteer.launch({
      headless: true,
      ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
      args: ['--no-sandbox']
    });
    const errors = [];
    const externalRequests = [];
    async function open(pageName, prefix = base) {
      const page = await browser.newPage();
      page.on('pageerror', e => errors.push(e.message));
      await page.setRequestInterception(true);
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.protocol === 'data:' || url.protocol === 'blob:') return request.continue();
        if (url.hostname !== '127.0.0.1') {
          externalRequests.push(request.url());
          return request.abort();
        }
        if (request.method() !== 'GET') return request.abort();
        return request.continue();
      });
      await page.evaluateOnNewDocument(() => sessionStorage.setItem('eng_user', '合成测试工程师'));
      await page.goto(`${prefix}/${pageName}`, { waitUntil: 'networkidle0' });
      return page;
    }
    function fixture(rows, extension = 'xlsx') {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
      const filename = path.join(dir, `${fs.readdirSync(dir).length}.${extension}`);
      fs.writeFileSync(filename, XLSX.write(wb, { type: 'buffer', bookType: extension === 'xls' ? 'biff8' : extension }));
      return filename;
    }
    async function importRows(page, type, rows, extension = 'xlsx') {
      await page.evaluate(type => {
        _excelImportType = type;
        _excelInput.value = '';
        document.getElementById('toastMsg').textContent = '';
      }, type);
      const input = await page.evaluateHandle(() => _excelInput);
      await input.uploadFile(fixture(rows, extension));
      await page.waitForFunction(() => document.getElementById('toastMsg').textContent !== '');
      const bodyId = { injection: 'injItemsBody', slush: 'slushItemsBody', spray: 'sprayItemsBody' }[type];
      return page.evaluate(bodyId => ({
        rows: [...document.querySelectorAll(`#${bodyId} tr`)].map(tr =>
          Object.fromEntries([...tr.querySelectorAll('[name]')].map(el => [el.name, el.value]))),
        toast: document.getElementById('toastMsg').textContent
      }), bodyId);
    }

    await t.test('local library loads at root and /rr with internet requests blocked; static cache revalidates', async () => {
      for (const prefix of [base, proxied]) {
        for (const pageName of ['engineering.html', 'assembly.html']) {
          const page = await open(pageName, prefix);
          await page.evaluate(() => loadXLSX());
          assert.equal(await page.evaluate(() => XLSX.version), '0.20.3');
          const url = await page.evaluate(() => [...document.scripts].find(s => s.src.endsWith('/vendor/xlsx.full.min.js')).src);
          assert.equal(url, `${prefix}/vendor/xlsx.full.min.js`);
          await page.close();
        }
      }
      const response = await fetch(base + '/vendor/xlsx.full.min.js');
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /javascript/);
      assert.match(response.headers.get('cache-control'), /max-age=3600/);
      assert.equal(Buffer.compare(Buffer.from(await response.arrayBuffer()), fs.readFileSync(path.join(APP_DIR, 'public/vendor/xlsx.full.min.js'))), 0);
      const conditionalStatus = await new Promise((resolve, reject) => {
        http.get(base + '/vendor/xlsx.full.min.js', { headers: { 'If-None-Match': response.headers.get('etag') } }, res => {
          res.resume(); resolve(res.statusCode);
        }).on('error', reject);
      });
      assert.equal(conditionalStatus, 304);
      assert.match((await fetch(base + '/engineering.html')).headers.get('cache-control'), /no-store/);
    });

    await t.test('spray current form columns work without per-row customer and preserve product, part and process', async () => {
      const page = await open('engineering.html');
      const result = await importRows(page, 'spray', [
        ['产品名称', '零件名称', '工序', '样板数量', '工程师'],
        ['合成娃娃', '头部', '移印', 3, '合成工程师'],
        ['合成玩具', '手臂', 'UV', 4, '合成工程师乙']
      ]);
      assert.equal(result.rows.length, 2, result.toast);
      assert.deepEqual(result.rows.map(r => [r.product_name, r.part_name, r.process, r.sample_qty, r.engineer]), [
        ['合成娃娃', '头部', '移印', '3', '合成工程师'],
        ['合成玩具', '手臂', 'UV', '4', '合成工程师乙']
      ]);
      await page.close();
    });

    await t.test('spray metadata with overlapping customer/name keywords is not mistaken for a header', async () => {
      const page = await open('engineering.html');
      const result = await importRows(page, 'spray', [
        ['客户名称：合成客户'],
        ['客户名称：合成客户', '产品名称：合成总产品'],
        ['客名', '名称', '样板数量', '工程师'],
        ['合成客户', '合成产品甲', 2, '合成工程师'],
        ['', '合成产品乙', 5, '合成工程师']
      ]);
      assert.equal(result.rows.length, 2, result.toast);
      assert.deepEqual(result.rows.map(r => r.product_name), ['合成产品甲', '合成产品乙']);
      await page.close();
    });

    await t.test('spray part-name column does not overwrite product name and process is imported', async () => {
      const page = await open('engineering.html');
      const result = await importRows(page, 'spray', [
        ['客名', '名称', '零件名称', '工序', '样板数量'],
        ['合成客户', '合成产品', '合成零件', 'UV', 3]
      ]);
      assert.equal(result.rows.length, 1, result.toast);
      assert.deepEqual([result.rows[0].product_name, result.rows[0].part_name, result.rows[0].process], ['合成产品', '合成零件', 'UV']);
      await page.close();
    });

    await t.test('spray supports legacy customer/name files in XLSX, XLS and CSV', async () => {
      for (const extension of ['xlsx', 'xls', 'csv']) {
        const page = await open('engineering.html', proxied);
        const result = await importRows(page, 'spray', [
          ['客名', '名称', '样板数量', '工程师'],
          ['合成客户', '合成产品甲', '2件', '合成工程师'],
          ['合成客户', '合成产品乙', 5, '合成工程师']
        ], extension);
        assert.equal(result.rows.length, 2, `${extension}: ${result.toast}`);
        assert.deepEqual(result.rows.map(r => [r.product_name, r.sample_qty]), [['合成产品甲', '2'], ['合成产品乙', '5']]);
        await page.close();
      }
    });

    await t.test('injection and slush keep field mapping, unit cleanup and injection subrows across XLSX/XLS/CSV', async () => {
      for (const type of ['injection', 'slush']) {
        for (const extension of ['xlsx', 'xls', 'csv']) {
          const page = await open('engineering.html');
          const input = type === 'injection' ? [
            ['产品编号：SYNTHETIC-001'],
            ['工模编号', '工模名称', '原料', '颜色', '件数/套数', '数量(啤)', '整啤毛重(g)', '所需用料(kg)'],
            ['M001', '合成模具', '合成ABS', '红', '28/1', '20啤', '5.6g', '1.5kg'],
            ['', '合成子件', '合成ABS', '蓝', '2/1', 3, 4, 5]
          ] : [
            ['序号', '产品编号', '工模编号', '工模名称', '原料', '颜色/编号', '每啤毛重(g)', '数量'],
            [1, 'SYNTHETIC-002', 'M002', '合成模具', 'PVC', '红', '1.2g', 4]
          ];
          const result = await importRows(page, type, input, extension);
          assert.equal(result.rows.length, type === 'injection' ? 2 : 1, `${type}/${extension}: ${result.toast}`);
          if (type === 'injection') {
            assert.deepEqual(result.rows.map(r => r.mold_id), ['M001', 'M001']);
            assert.equal(result.rows[0].quantity, '28/1');
            assert.equal(result.rows[0].shoot_qty, '20');
            assert.equal(result.rows[0].gross_weight_g, '5.6');
            assert.equal(result.rows[0].required_material_kg, '1.5');
            assert.equal(await page.$eval('#inj-order_number', el => el.value), 'SYNTHETIC-001');
          } else {
            assert.equal(result.rows[0].product_id, 'SYNTHETIC-002');
            assert.equal(result.rows[0].color_code, '红');
            assert.equal(result.rows[0].unit_weight, '1.2');
          }
          await page.close();
        }
      }
    });

    await t.test('fixture imports both engineering and fixture pages through /rr, with order number and two rows', async () => {
      for (const pageName of ['engineering.html', 'assembly.html']) {
        for (const extension of ['xlsx', 'xls', 'csv']) {
          const page = await open(pageName, proxied);
          await page.evaluate(() => { document.getElementById('toastMsg').textContent = ''; });
          const input = await page.evaluateHandle(() => _asmExcelInput);
          await input.uploadFile(fixture([
            ['货号：SYNTHETIC-FIXTURE'],
            ['序号', '名称', '数量', '日期'],
            [1, '合成夹具甲', 2, '2026-10-21'],
            [2, '合成夹具乙', 3, '2026-10-22'],
            ['', '申请人：合成工程师']
          ], extension));
          await page.waitForFunction(() => document.getElementById('toastMsg').textContent !== '');
          assert.equal(await page.$eval('#asm-order_number', el => el.value), 'SYNTHETIC-FIXTURE');
          const rows = await page.$$eval('#asmItemsBody tr', rows => rows.map(tr =>
            Object.fromEntries([...tr.querySelectorAll('[name]')].map(el => [el.name, el.value]))));
          assert.equal(rows.length, 2);
          assert.deepEqual(rows.map(r => [r.product_name, r.quantity]), [['合成夹具甲', '2'], ['合成夹具乙', '3']]);
          await page.close();
        }
      }
    });
    assert.deepEqual(errors, [], 'browser script errors');
    assert.deepEqual(externalRequests, [], 'pages must not require external resources');
    assert.equal(fs.readFileSync(dataFile, 'utf8'), originalData, 'import must only populate the form');
  } finally {
    if (browser) await browser.close();
    if (proxy) await new Promise(resolve => proxy.close(resolve));
    if (child.exitCode == null) { const exit = once(child, 'exit'); child.kill(); await exit; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
