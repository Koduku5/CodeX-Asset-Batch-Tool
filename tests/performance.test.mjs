import test from 'node:test';
import assert from 'node:assert/strict';
import { filterAssets, paginateAssets } from '../src/ui/services/list-model.mjs';

const CATEGORIES = ['角色', '生物', '群演', '场景', '道具'];
const STYLES = ['二次元', 'CG', '真人'];
const makeAssets = (count) => Array.from({ length: count }, (_, index) => ({
  id: `asset-${String(index + 1).padStart(5, '0')}`,
  name: index % 13 === 0 ? `雨夜站台 ${index + 1}` : `资产 ${index + 1}`,
  category: CATEGORIES[index % CATEGORIES.length],
  style: STYLES[index % STYLES.length]
}));

test('10k filtering remains bounded and the UI page never exceeds 100 rows', () => {
  const assets = makeAssets(10000);
  const timings = [];

  for (let index = 0; index < 25; index += 1) {
    const started = performance.now();
    const filtered = filterAssets(assets, {
      category: index % 3 === 0 ? '道具' : '全部',
      style: index % 4 === 0 ? '二次元' : 'all',
      query: index % 2 === 0 ? '000' : '雨夜站台'
    });
    const page = paginateAssets(filtered, index % 5, 100);
    timings.push(performance.now() - started);
    assert.ok(page.length <= 100);
  }

  timings.sort((left, right) => left - right);
  const p95 = timings[Math.ceil(timings.length * 0.95) - 1];
  assert.ok(p95 < 250, `10k filter/paginate p95 was ${p95.toFixed(1)}ms`);
});

test('pagination clamps unsafe inputs without duplicating data', () => {
  const assets = makeAssets(250);
  assert.deepEqual(paginateAssets(assets, -4, 100), assets.slice(0, 100));
  assert.deepEqual(paginateAssets(assets, 2, 100), assets.slice(200, 250));
});
