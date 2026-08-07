import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import {
  createPendingAssetService,
  PendingAssetServiceError
} from '../src/server/pending-asset-service.mjs';

const writeJson = async (root, parts, value) => {
  const target = join(root, ...parts);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, JSON.stringify(value), 'utf8');
};

const makeProject = async () => {
  const root = await mkdtemp(join(tmpdir(), 'ka-pending-service-'));
  const draft = {
    assetName: '《那时的我们》项目赵总', aliases: ['赵总'], faction: '项目组｜管理层',
    scriptSetting: '第 30 集出场。', firstRequiredEpisode: 30, firstRequiredOrder: 4
  };
  await Promise.all([
    writeJson(root, ['cache', '待确认记录.json'], [{
      pendingId: 'PENDING-CHAR-0123456789abcdef', status: 'pending', candidate: draft.assetName,
      proposedCategory: 'characters', firstRequiredEpisode: 30, firstRequiredOrder: 4,
      issue: '称呼冲突', conflicts: [{ assetId: 'CHAR-001-EP1', assetName: '赵媛', sharedValue: '赵总' }],
      draftAsset: draft
    }]),
    writeJson(root, ['cache', '阅读进度.json'], {
      status: 'complete', discoveredEpisodes: [1, 30], completedEpisodes: [1, 30]
    }),
    writeJson(root, ['cache', '世界观总览.json'], { content: '完整世界观' }),
    writeJson(root, ['cache', '累计记录', '角色记录.json'], [{
      assetId: 'CHAR-001-EP1', assetName: '赵媛', aliases: ['赵总'], faction: '启明集团｜管理层',
      scriptSetting: '第 1 集出场。', firstRequiredEpisode: 1, firstRequiredOrder: 1
    }])
  ]);
  return root;
};

const fakeChild = (receipt, captured) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      captured.push(chunk.toString('utf8'));
      callback();
    }
  });
  child.kill = () => true;
  process.nextTick(() => {
    child.stdout.write(JSON.stringify(receipt));
    child.stdout.end();
    child.emit('close', 0);
  });
  return child;
};

test('pending asset service exposes ready drafts and submits through the project runtime', async (t) => {
  const root = await makeProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const captured = [];
  const materialized = [];
  const guarded = [];
  const service = createPendingAssetService({
    resolveProjectRoot: async () => root,
    materializeProjectRuntime: async ({ projectId }) => { materialized.push(projectId); },
    withProjectIdle: async (projectId, operation) => { guarded.push(projectId); return operation(); },
    spawnImpl: () => fakeChild({ ok: true, finalized: false, remaining: 0 }, captured)
  });
  const state = await service.getState({ projectId: 'project-a' });
  assert.equal(state.ready, true);
  assert.equal(state.pendingCount, 1);
  assert.equal(state.items[0].draftAsset.firstRequiredEpisode, 30);
  assert.equal(state.targets[0].assetId, 'CHAR-001-EP1');
  const receipt = await service.resolvePending({
    projectId: 'project-a',
    decision: { pendingId: state.items[0].pendingId, decision: 'exclude', resolution: '人工排除' }
  });
  assert.equal(receipt.projectId, 'project-a');
  assert.deepEqual(materialized, ['project-a']);
  assert.deepEqual(guarded, ['project-a']);
  assert.equal(JSON.parse(captured.join('')).decision, 'exclude');
});

test('pending asset service refuses confirmation while the project task is active', async (t) => {
  const root = await makeProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = createPendingAssetService({
    resolveProjectRoot: async () => root,
    materializeProjectRuntime: async () => {},
    withProjectIdle: async () => { const error = new Error('busy'); error.code = 'PROJECT_TASK_BUSY'; throw error; },
    spawnImpl: () => { throw new Error('must not spawn'); }
  });
  await assert.rejects(service.resolvePending({
    projectId: 'project-a',
    decision: { pendingId: 'PENDING-CHAR-0123456789abcdef', decision: 'exclude', resolution: '人工排除' }
  }), (error) => {
    assert.equal(error instanceof PendingAssetServiceError, true);
    assert.equal(error.code, 'PROJECT_TASK_BUSY');
    return true;
  });
});
