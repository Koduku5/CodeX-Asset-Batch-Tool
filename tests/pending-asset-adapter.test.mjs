import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PendingAssetAdapter,
  PendingAssetAdapterError
} from '../src/ui/services/pending-asset-adapter.mjs';

const asset = {
  assetId: 'CHAR-001-EP1',
  assetName: '赵媛',
  aliases: ['赵总'],
  faction: '启明集团｜管理层',
  scriptSetting: '第 1 集出场。',
  firstRequiredEpisode: 1,
  firstRequiredOrder: 1
};
const item = {
  pendingId: 'PENDING-CHAR-0123456789abcdef',
  status: 'pending',
  candidate: '《那时的我们》项目赵总',
  proposedCategory: 'characters',
  firstRequiredEpisode: 30,
  firstRequiredOrder: 4,
  issue: '称呼冲突',
  conflicts: [{ assetId: asset.assetId, assetName: asset.assetName, sharedValue: '赵总' }],
  draftAsset: { ...asset, assetName: '《那时的我们》项目赵总', firstRequiredEpisode: 30, firstRequiredOrder: 4 }
};
const state = {
  version: 1,
  projectId: 'project-a',
  ready: true,
  analysisComplete: true,
  overviewComplete: true,
  pendingCount: 1,
  decidedCount: 0,
  items: [item],
  targets: [{ category: 'characters', assetId: asset.assetId, assetName: asset.assetName, record: asset }]
};
const response = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json' }
});

test('pending asset adapter binds reads and decisions to the selected project', async () => {
  const calls = [];
  const adapter = new PendingAssetAdapter({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (init.method === 'POST') {
        return response({ ok: true, data: { projectId: 'project-a', ok: true, finalized: false, remaining: 1 } });
      }
      return response({ ok: true, data: state });
    }
  });
  assert.equal((await adapter.getState({ projectId: 'project-a' })).items[0].candidate, item.candidate);
  const receipt = await adapter.resolve({
    projectId: 'project-a',
    pendingId: item.pendingId,
    decision: 'exclude',
    resolution: '人工排除'
  });
  assert.equal(receipt.finalized, false);
  assert.equal(calls[0].url, '/api/projects/project-a/pending-assets');
  assert.equal(calls[1].url, '/api/projects/project-a/pending-assets/resolve');
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    pendingId: item.pendingId,
    decision: 'exclude',
    resolution: '人工排除'
  });
});

test('pending asset adapter rejects unsafe projects and crossed receipts', async () => {
  const expectCode = async (promise, code) => assert.rejects(promise, (error) => {
    assert.equal(error instanceof PendingAssetAdapterError, true);
    assert.equal(error.code, code);
    return true;
  });
  const adapter = new PendingAssetAdapter({
    fetchImpl: async () => response({ ok: true, data: { projectId: 'project-b', ok: true, finalized: true } })
  });
  await expectCode(adapter.getState({ projectId: '../project' }), 'INVALID_PROJECT_ID');
  await expectCode(adapter.resolve({ projectId: 'project-a', decision: 'exclude' }), 'PROJECT_MISMATCH');
});
