import assert from 'node:assert/strict';
import test from 'node:test';

import { BatchControlAdapter, BatchControlAdapterError } from '../src/ui/services/batch-control-adapter.mjs';

const reference = {
  referenceId: `ref-${'a'.repeat(64)}`,
  styleId: 'cg',
  sheetName: '场景',
  path: `cache/内置参考图/cg/场景/${'b'.repeat(64)}.png`,
  sourceName: '森林.png',
  size: 120,
  sha256: 'b'.repeat(64),
  createdAt: '2026-08-04T00:00:00.000Z'
};

const summary = {
  version: 6,
  confirmedAt: '2026-08-04T00:00:00.000Z',
  styleId: 'cg',
  generationLimit: 5,
  enabledSheets: ['场景'],
  referenceCountsBySheet: { 角色: 0, 生物: 0, 群演: 0, 场景: 1, 道具: 0 },
  selectedReferenceIdsBySheet: { 角色: [], 生物: [], 群演: [], 场景: [reference.referenceId], 道具: [] },
  referenceModeBySheet: { 角色: 'style', 生物: 'style', 群演: 'style', 场景: 'style', 道具: 'style' },
  catalogFingerprint: 'c'.repeat(64),
  routeFingerprintsBySheet: { 场景: 'd'.repeat(64) }
};

const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json' }
});

test('batch adapter binds reference and preset operations to fixed project routes', async () => {
  const calls = [];
  const adapter = new BatchControlAdapter({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (options.method === 'PUT') return jsonResponse({ ok: true, data: reference }, 201);
      if (options.method === 'DELETE') return jsonResponse({ ok: true, data: { referenceId: reference.referenceId, removed: true } });
      if (url.endsWith('/references')) return jsonResponse({ ok: true, data: [reference] });
      if (options.method === 'POST') return jsonResponse({ ok: true, data: summary }, 201);
      return jsonResponse({ ok: true, data: summary });
    }
  });
  const file = new Blob(['image']);
  Object.defineProperty(file, 'name', { value: '森林.png' });
  assert.equal((await adapter.uploadReference({ projectId: 'project-a', styleId: 'cg', sheetName: '场景', file })).referenceId, reference.referenceId);
  assert.equal((await adapter.listReferences({ projectId: 'project-a' })).length, 1);
  assert.equal((await adapter.removeReference({ projectId: 'project-a', referenceId: reference.referenceId })).removed, true);
  assert.equal((await adapter.saveBuiltinBatch({ projectId: 'project-a', configuration: { version: 1 } })).styleId, 'cg');
  assert.equal((await adapter.getBuiltinBatch({ projectId: 'project-a' })).generationLimit, 5);
  assert.deepEqual((await adapter.getBuiltinBatch({ projectId: 'project-a' })).selectedReferenceIdsBySheet['场景'], [reference.referenceId]);
  assert.equal(adapter.referenceContentUrl({ projectId: 'project-a', referenceId: reference.referenceId }), `/api/projects/project-a/references/${reference.referenceId}/content`);
  assert.equal(calls[0].url, '/api/projects/project-a/references/cg/%E5%9C%BA%E6%99%AF');
  assert.equal(calls[0].options.headers['x-ka-filename'], '%E6%A3%AE%E6%9E%97.png');
  assert.equal(calls.every(({ url }) => !url.includes('..') && !url.includes('D:')), true);
});

test('batch adapter rejects path-like selectors and malformed server receipts', async () => {
  const adapter = new BatchControlAdapter({ fetchImpl: async () => jsonResponse({ ok: true, data: { arbitrary: true } }) });
  const expectCode = async (promise, code) => assert.rejects(promise, (error) => {
    assert.equal(error instanceof BatchControlAdapterError, true);
    assert.equal(error.code, code);
    return true;
  });
  await expectCode(adapter.listReferences({ projectId: '../project' }), 'INVALID_PROJECT_ID');
  await expectCode(adapter.removeReference({ projectId: 'project-a', referenceId: '../file' }), 'INVALID_REFERENCE_ID');
  await expectCode(adapter.getBuiltinBatch({ projectId: 'project-a' }), 'INVALID_BATCH_RECEIPT');
});
