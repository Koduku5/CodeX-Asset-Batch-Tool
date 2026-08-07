import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createWorkbenchSnapshotReader, getSnapshot, WORKBENCH_SNAPSHOT_SCHEMA_VERSION } from '../src/server/workbench-snapshot.mjs';

const json = (value) => JSON.stringify(value, null, 2);
const writeJson = (root, relative, value) => writeFile(path.join(root, relative), json(value), 'utf8');
const makeRoot = async () => mkdtemp(path.join(os.tmpdir(), 'ka-workbench-snapshot-'));
const mkdirs = async (root) => Promise.all([
  mkdir(path.join(root, 'cache', '累计记录'), { recursive: true }),
  mkdir(path.join(root, 'cache', '单集原文'), { recursive: true }),
  mkdir(path.join(root, 'cache', '单集分析'), { recursive: true }),
  mkdir(path.join(root, 'cache', '批量重绘'), { recursive: true }),
  mkdir(path.join(root, '输出'), { recursive: true })
]);

async function populateRecords(root) {
  await mkdirs(root);
  await Promise.all([
    writeJson(root, 'cache/累计记录/角色记录.json', [{ id: 'char-1' }]),
    writeJson(root, 'cache/累计记录/生物记录.json', [{ id: 'creature-1' }, { id: 'creature-2' }]),
    writeJson(root, 'cache/累计记录/群演记录.json', []),
    writeJson(root, 'cache/累计记录/场景记录.json', [{ id: 'scene-1' }]),
    writeJson(root, 'cache/累计记录/道具记录.json', [{ id: 'prop-1' }]),
    writeJson(root, 'cache/累计记录/世界观记录.json', { records: [{ id: 'world-1' }] }),
    writeJson(root, 'cache/待确认记录.json', [{ id: 'pending-1' }]),
    writeJson(root, 'cache/世界观分页进度.json', { complete: false }),
    writeJson(root, 'cache/世界观总览.json', { content: '' })
  ]);
}

async function fixtureDigest(root) {
  const entries = [];
  const visit = async (directory, prefix = '') => {
    for (const entry of await (await import('node:fs/promises')).readdir(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, `${relative}/`);
      else entries.push(`${relative}:${createHash('sha256').update(await readFile(absolute)).digest('hex')}`);
    }
  };
  await visit(root);
  return entries.sort();
}

test('empty project produces an explicit unknown snapshot without invented counts', async (context) => {
  const root = await makeRoot(); context.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await getSnapshot(root, { now: () => new Date('2026-08-03T00:00:00.000Z') });
  assert.equal(snapshot.schemaVersion, WORKBENCH_SNAPSHOT_SCHEMA_VERSION);
  assert.equal(snapshot.observedAt, '2026-08-03T00:00:00.000Z');
  assert.equal(snapshot.assetCounts.known, false);
  assert.equal(snapshot.batch.mode, 'none');
  assert.equal(snapshot.batch.counts.known, false);
  assert.equal(snapshot.pipeline.currentTask, null);
  assert.equal(snapshot.pipeline.stages.some((stage) => stage.state === 'active'), false);
  assert.deepEqual(snapshot.screenplay, {
    known: true,
    state: 'empty',
    count: 0,
    files: [],
    filename: null,
    label: '尚未导入剧本',
    truncated: false
  });
  assert.equal(snapshot.source.mode, 'read-only-cache');
  assert.equal(snapshot.source.files.screenplays.state, 'missing');
});

test('screenplay source lists only direct TXT and DOCX names and follows safe reading-source order', async (context) => {
  const root = await makeRoot(); context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '剧本'), { recursive: true });
  await mkdir(path.join(root, 'cache'), { recursive: true });
  await Promise.all([
    writeFile(path.join(root, '剧本', '第一部.txt'), 'private screenplay body one', 'utf8'),
    writeFile(path.join(root, '剧本', '第二部.docx'), 'private screenplay body two', 'utf8'),
    writeFile(path.join(root, '剧本', '说明.md'), 'not a screenplay', 'utf8'),
    mkdir(path.join(root, '剧本', '假文件.txt')),
    writeJson(root, 'cache/阅读进度.json', {
      status: 'not_started',
      sources: ['../outside.txt', '第二部.docx'],
      sourceFingerprint: 'must-not-be-exposed'
    })
  ]);

  const snapshot = await getSnapshot(root);
  assert.deepEqual(snapshot.screenplay, {
    known: true,
    state: 'multiple',
    count: 2,
    files: ['第二部.docx', '第一部.txt'],
    filename: '第二部.docx',
    label: '第二部.docx 等 2 个文件',
    truncated: false
  });
  assert.equal(snapshot.source.files.screenplays.state, 'directory');
  const serialized = JSON.stringify(snapshot);
  for (const secret of ['private screenplay body one', 'private screenplay body two', 'must-not-be-exposed', '../outside.txt']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('screenplay source rejects an escaping symlink without reading its target', async (context) => {
  const root = await makeRoot(); context.after(() => rm(root, { recursive: true, force: true }));
  const outside = await makeRoot(); context.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(path.join(root, '剧本'), { recursive: true });
  await writeFile(path.join(root, '剧本', '安全剧本.txt'), 'safe body', 'utf8');
  const target = path.join(outside, '越界剧本.txt');
  await writeFile(target, 'outside secret body', 'utf8');
  try {
    await symlink(target, path.join(root, '剧本', '链接剧本.txt'), 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'UNKNOWN'].includes(error?.code)) {
      context.skip(`symbolic links unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const snapshot = await getSnapshot(root);
  assert.deepEqual(snapshot.screenplay.files, ['安全剧本.txt']);
  assert.equal(snapshot.screenplay.count, 1);
  assert.equal(snapshot.screenplay.known, true);
  assert.ok(snapshot.warnings.includes('SOURCE_LINK_REJECTED:screenplays'));
  const serialized = JSON.stringify(snapshot);
  for (const secret of ['链接剧本.txt', '越界剧本.txt', 'outside secret body', outside]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('analysis snapshot reports real episode and registry counts without a fabricated per-item percentage', async (context) => {
  const root = await makeRoot(); context.after(() => rm(root, { recursive: true, force: true }));
  await populateRecords(root);
  await writeJson(root, 'cache/阅读进度.json', {
    status: 'in_progress', discoveredEpisodes: [1, 2, 3], completedEpisodes: [1, 2],
    currentEpisode: 3, currentStartedAt: '2026-08-03T00:00:00.000Z', currentSessionToken: 'do-not-expose'
  });
  await Promise.all([1, 2, 3].map((episode) => writeJson(root, `cache/单集原文/${String(episode).padStart(3, '0')}.json`, {})));
  await Promise.all([1, 2].map((episode) => writeJson(root, `cache/单集分析/${String(episode).padStart(3, '0')}.json`, {})));
  const snapshot = await getSnapshot(root);
  assert.deepEqual(snapshot.assetCounts, { known: true, total: 5, byType: { characters: 1, creatures: 2, crowds: 0, scenes: 1, props: 1 }, worldFacts: 1 });
  assert.equal(snapshot.pending.count, 1);
  assert.deepEqual(snapshot.pipeline.stages.map((stage) => stage.id), ['split', 'analysis', 'world-overview', 'asset-visual-specs', 'excel', 'generation']);
  assert.deepEqual(snapshot.pipeline.stages.find((stage) => stage.id === 'split').progress, { mode: 'determinate', done: 3, total: 3 });
  assert.equal(snapshot.pipeline.stages.find((stage) => stage.id === 'analysis').state, 'active');
  assert.deepEqual(snapshot.pipeline.stages.find((stage) => stage.id === 'analysis').progress, { mode: 'determinate', done: 2, total: 3 });
  assert.equal(snapshot.pipeline.currentTask.label, '第 3 集分析');
  assert.deepEqual(snapshot.pipeline.currentTask.progress, { mode: 'indeterminate' });
  assert.equal(JSON.stringify(snapshot).includes('do-not-expose'), false);
  assert.equal(JSON.stringify(snapshot).includes('percent'), false);
});

test('visual specification progress exposes only the current asset identity below total progress', async (context) => {
  const root = await makeRoot(); context.after(() => rm(root, { recursive: true, force: true }));
  await populateRecords(root);
  await writeJson(root, 'cache/阅读进度.json', {
    status: 'complete', discoveredEpisodes: [1], completedEpisodes: [1], currentEpisode: null,
    pipelineStartedAt: '2026-08-03T00:00:00.000Z'
  });
  await writeJson(root, 'cache/单集原文/第001集.json', {});
  await writeJson(root, 'cache/单集分析/第001集.json', {});
  await writeJson(root, 'cache/世界观分页进度.json', { complete: true });
  await writeJson(root, 'cache/世界观总览.json', { content: '完整世界观总览' });
  await writeJson(root, 'cache/视觉规格回填进度.json', {
    version: 1,
    status: 'in_progress',
    overviewFingerprint: 'private-overview-fingerprint',
    assetFactsFingerprint: 'private-asset-fingerprint',
    total: 5,
    completedAssetIds: ['CHAR-001-EP1', 'CREATURE-001-EP1'],
    current: {
      category: 'characters', categoryLabel: '角色', assetId: 'CHAR-008-EP3',
      assetName: '不可公开到日志的角色名', requestToken: 'private-request-token',
      startedAt: '2026-08-03T00:02:00.000Z'
    },
    startedAt: '2026-08-03T00:01:00.000Z',
    updatedAt: '2026-08-03T00:02:00.000Z',
    completedAt: null
  });

  const snapshot = await getSnapshot(root);
  const stage = snapshot.pipeline.stages.find((item) => item.id === 'asset-visual-specs');
  assert.equal(snapshot.pipeline.phase, 'asset-visual-specs');
  assert.equal(stage.state, 'active');
  assert.deepEqual(stage.progress, { mode: 'determinate', done: 2, total: 5 });
  assert.equal(snapshot.pipeline.currentTask.label, '角色 CHAR-008-EP3');
  assert.equal(snapshot.pipeline.currentTask.assetId, 'CHAR-008-EP3');
  assert.equal(snapshot.pipeline.currentTask.sheetName, '角色');
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('private-request-token'), false);
  assert.equal(serialized.includes('private-overview-fingerprint'), false);
  assert.equal(serialized.includes('private-asset-fingerprint'), false);
});

test('generation reports one indeterminate active task and status-only counts', async (context) => {
  const root = await makeRoot(); context.after(() => rm(root, { recursive: true, force: true }));
  await populateRecords(root);
  await writeJson(root, 'cache/出图队列.json', { version: 4, operation: 'generate', items: [{ key: 'asset-001' }, { key: 'asset-002', assetId: 'PROP-002', assetName: '折叠终端', sheetName: '道具' }, { key: 'asset-003' }] });
  await writeJson(root, 'cache/出图进度.json', { version: 3, items: {
    'asset-001': { status: 'completed', backend: 'builtin' },
    'asset-002': { status: 'generating', backend: 'api', token: 'secret-token', prompt: 'private prompt' },
    'asset-003': { status: 'failed', backend: 'api', terminal: true, error: 'secret failure details' }
  } });
  const snapshot = await getSnapshot(root);
  assert.equal(snapshot.batch.mode, 'active');
  assert.equal(snapshot.batch.integrity, 'status-only');
  assert.deepEqual(snapshot.batch.counts, { known: true, total: 3, completed: 1, active: 1, retryable: 0, failed: 1, pending: 0, finished: 2 });
  assert.equal(snapshot.batch.activeTask.label, 'PROP-002 折叠终端');
  assert.equal(snapshot.batch.activeTask.backend, 'api');
  assert.deepEqual(snapshot.batch.activeTask.progress, { mode: 'indeterminate' });
  assert.equal(snapshot.pipeline.stages.find((stage) => stage.id === 'generation').state, 'active');
  const text = JSON.stringify(snapshot);
  for (const secret of ['secret-token', 'private prompt', 'secret failure details', root]) assert.equal(text.includes(secret), false);
});

test('invalid JSON is retried, redacted, and downgraded to a warning', async (context) => {
  const root = await makeRoot(); context.after(() => rm(root, { recursive: true, force: true }));
  await mkdirs(root);
  await writeFile(path.join(root, 'cache', '出图队列.json'), '{broken', 'utf8');
  await writeJson(root, 'cache/出图进度.json', { version: 3, items: {} });
  const snapshot = await createWorkbenchSnapshotReader(root, { retryDelayMs: 0 }).getSnapshot();
  assert.equal(snapshot.batch.mode, 'none');
  assert.ok(snapshot.warnings.includes('SOURCE_INVALID_JSON:mainQueue'));
  assert.equal(snapshot.source.files.mainQueue.state, 'invalid');
  assert.equal(JSON.stringify(snapshot).includes('出图队列.json'), false);
});

test('reader never writes fixture files and reuses stable source state', async (context) => {
  const root = await makeRoot(); context.after(() => rm(root, { recursive: true, force: true }));
  await populateRecords(root);
  await writeJson(root, 'cache/阅读进度.json', { status: 'not_started' });
  await writeJson(root, 'cache/.pipeline.lock', { token: 'top-secret-lock-token', key: 'private-work-item' });
  const before = await fixtureDigest(root);
  const reader = createWorkbenchSnapshotReader(root);
  const first = await reader.getSnapshot();
  const second = await reader.getSnapshot();
  assert.deepEqual(await fixtureDigest(root), before);
  assert.equal(first.source.lockPresent, true);
  assert.equal(JSON.stringify(second).includes('top-secret-lock-token'), false);
  assert.equal(typeof reader.start, 'undefined');
  assert.equal(typeof reader.setQueue, 'undefined');
  assert.equal(typeof reader.write, 'undefined');
});
