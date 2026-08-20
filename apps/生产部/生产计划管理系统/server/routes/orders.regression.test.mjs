import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./orders.js', import.meta.url), 'utf8');

// ===== 2026-08-20 「待定」拉（新产品未定拉临时挂，不参与记忆） =====

test('every workshop has a 待定 parking line', () => {
  const matches = source.match(/\{ key: '待定', name: '待定'/g) || [];
  assert.equal(matches.length, 3, 'A/B/C 三个车间都应有「待定」拉');
});

test('待定 is never written into the item-line memory map', () => {
  // PUT /item-line-map 直接跳过待定
  assert.match(source, /String\(e\.line\)\.trim\(\) === '待定'\) continue/);
});

test('auto-assign neither learns nor applies 待定', () => {
  // 学习阶段：待定不投票
  assert.match(source, /if \(key && key !== '待定'\) votes\[key\]/);
  // 应用阶段：映射到待定按未分配处理（待在待定不动）
  assert.match(source, /if \(!line \|\| line === '待定'\) \{ unmapped \+= list\.length; continue; \}/);
});
