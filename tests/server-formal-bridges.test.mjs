import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createPrototypeServer } from '../src/server/server.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineRoot = path.join(projectRoot, 'engine');
const SHEETS = ['角色', '生物', '群演', '场景', '道具'];
const PNG_SIGNATURE = '89504e470d0a1a0a';

const snapshotTree = async (root) => {
  const records = [];
  const visit = async (directory, prefix = '') => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target, relativePath);
      else if (entry.isFile()) {
        const bytes = await readFile(target);
        records.push({
          path: relativePath,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex')
        });
      } else records.push({ path: relativePath, type: 'non-file' });
    }
  };
  await visit(root);
  return records;
};

const assertNoPrivateResponseData = (value, label) => {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(engineRoot), false, `${label} leaked engineRoot`);
  const inspect = (item, key = null) => {
    if (key !== null) {
      assert.equal(/prompt/iu.test(key.replaceAll('-', '').replaceAll('_', '')), false, `${label} exposed ${key}`);
    }
    if (typeof item === 'string') {
      assert.equal(path.isAbsolute(item), false, `${label} exposed an absolute path`);
      assert.equal(path.win32.isAbsolute(item), false, `${label} exposed a Windows absolute path`);
      assert.equal(/^file:\/\//iu.test(item), false, `${label} exposed a file URL`);
    } else if (Array.isArray(item)) {
      for (const member of item) inspect(member);
    } else if (item && typeof item === 'object') {
      for (const [memberKey, member] of Object.entries(item)) inspect(member, memberKey);
    }
  };
  inspect(value);
};

const jsonRequest = async (url, init = {}) => {
  const response = await fetch(url, {
    ...init,
    headers: { accept: 'application/json', ...(init.headers || {}) }
  });
  return { response, body: await response.json() };
};

const assertError = (result, status, code, label) => {
  assert.equal(result.response.status, status, label);
  assert.equal(result.body.ok, false, label);
  assert.equal(result.body.error.code, code, label);
  assertNoPrivateResponseData(result.body, label);
};

const startFixture = async (context) => {
  const relativeEngineRoot = path.relative(projectRoot, engineRoot);
  assert.equal(relativeEngineRoot.startsWith('..'), false, 'integration engineRoot must stay inside this software tree');
  assert.equal(path.isAbsolute(relativeEngineRoot), false);
  const sourceBefore = await snapshotTree(engineRoot);
  const softwareRoot = await mkdtemp(path.join(os.tmpdir(), 'ka-formal-bridges-'));
  const server = createPrototypeServer({ softwareMode: true, softwareRoot, engineRoot });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(async () => {
    server.closeIdleConnections?.();
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await rm(softwareRoot, { recursive: true, force: true });
    assert.deepEqual(await snapshotTree(engineRoot), sourceBefore, 'formal server bridges must not mutate engine sources');
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, softwareRoot };
};

const createProject = async (baseUrl, displayName) => {
  const result = await jsonRequest(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName })
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.body.ok, true);
  assertNoPrivateResponseData(result.body, 'create project response');
  return result.body.data;
};

const makeBmp = () => {
  const width = 2;
  const height = 2;
  const rowSize = 8;
  const pixelBytes = rowSize * height;
  const bytes = Buffer.alloc(54 + pixelBytes);
  bytes.write('BM', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18);
  bytes.writeInt32LE(height, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  bytes.writeUInt32LE(pixelBytes, 34);
  Buffer.from([
    0x00, 0x00, 0xff, 0x00, 0xff, 0x00, 0x00, 0x00,
    0xff, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0x00
  ]).copy(bytes, 54);
  return bytes;
};

const makeBatchConfiguration = (sceneReferenceId = null) => ({
  version: 1,
  styleId: 'cg',
  generationLimit: 5,
  enabledSheets: [...SHEETS],
  referenceModeBySheet: Object.fromEntries(SHEETS.map((sheet) => [sheet, 'style'])),
  referenceIdsBySheet: Object.fromEntries(SHEETS.map((sheet) => [sheet, sheet === '场景' && sceneReferenceId ? [sceneReferenceId] : []])),
  promptOverridesBySheet: Object.fromEntries(SHEETS.map((sheet) => [sheet, null]))
});

const validConditionModule = () => ({
  id: 'integration-forest-highway',
  displayName: '集成测试森林高速公路',
  family: 'scene-environment',
  revision: 1,
  scope: { styles: ['cg'], assets: ['scene'], referenceModes: ['none'] },
  classifier: {
    definition: '森林植被与高速公路共同控制主要空间时使用',
    selectionPolicy: 'single-dominant',
    controlDimensions: ['main-spatial-structure'],
    tieBreak: '优先保留道路通行轴线',
    noDefault: true
  },
  operations: [{ op: 'append', field: 'Scene/backdrop', value: '森林高速公路分支已生效。' }],
  tests: [],
  origin: { kind: 'prompt-studio' }
});

test('formal reference-image and builtin-batch HTTP bridges isolate projects and return safe receipts', async (context) => {
  const { baseUrl, softwareRoot } = await startFixture(context);
  const [alpha, beta] = await Promise.all([
    createProject(baseUrl, '正式接口甲项目'),
    createProject(baseUrl, '正式接口乙项目')
  ]);

  for (const project of [alpha, beta]) {
    const empty = await jsonRequest(`${baseUrl}/api/projects/${project.projectId}/references`);
    assert.equal(empty.response.status, 200);
    assert.deepEqual(empty.body.data, []);
    assertNoPrivateResponseData(empty.body, 'empty reference list');
    const noPreset = await jsonRequest(`${baseUrl}/api/projects/${project.projectId}/builtin-batch`);
    assert.equal(noPreset.response.status, 200);
    assert.equal(noPreset.body.data, null);
    assertNoPrivateResponseData(noPreset.body, 'empty builtin batch');
  }

  const image = makeBmp();
  const uploaded = await jsonRequest(`${baseUrl}/api/projects/${alpha.projectId}/references/cg/${encodeURIComponent('场景')}`, {
    method: 'PUT',
    headers: {
      'content-type': 'image/bmp',
      'content-length': String(image.length),
      'x-ka-filename': encodeURIComponent('森林参考图.bmp')
    },
    body: image
  });
  assert.equal(uploaded.response.status, 201);
  assert.equal(uploaded.body.ok, true);
  assert.match(uploaded.body.data.referenceId, /^ref-[a-f0-9]{64}$/u);
  assert.equal(uploaded.body.data.path.startsWith('cache/内置参考图/cg/场景/'), true);
  assert.equal(uploaded.body.data.path.endsWith('.png'), true);
  assertNoPrivateResponseData(uploaded.body, 'reference upload');
  const referenceId = uploaded.body.data.referenceId;

  const [alphaList, betaList] = await Promise.all([
    jsonRequest(`${baseUrl}/api/projects/${alpha.projectId}/references`),
    jsonRequest(`${baseUrl}/api/projects/${beta.projectId}/references`)
  ]);
  assert.deepEqual(alphaList.body.data, [uploaded.body.data]);
  assert.deepEqual(betaList.body.data, []);
  assertNoPrivateResponseData(alphaList.body, 'alpha reference list');

  const content = await fetch(`${baseUrl}/api/projects/${alpha.projectId}/references/${referenceId}/content`);
  const contentBytes = Buffer.from(await content.arrayBuffer());
  assert.equal(content.status, 200);
  assert.equal(content.headers.get('content-type'), 'image/png');
  assert.equal(content.headers.get('cache-control'), 'no-store');
  assert.equal(contentBytes.subarray(0, 8).toString('hex'), PNG_SIGNATURE);
  const crossProjectContent = await jsonRequest(`${baseUrl}/api/projects/${beta.projectId}/references/${referenceId}/content`);
  assertError(crossProjectContent, 404, 'REFERENCE_NOT_FOUND', 'cross-project reference content');

  const batchConfiguration = makeBatchConfiguration(referenceId);
  const savedBatch = await jsonRequest(`${baseUrl}/api/projects/${alpha.projectId}/builtin-batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(batchConfiguration)
  });
  assert.equal(savedBatch.response.status, 200, JSON.stringify(savedBatch.body));
  assert.equal(savedBatch.body.data.referenceCountsBySheet['场景'], 1);
  assert.deepEqual(savedBatch.body.data.selectedReferenceIdsBySheet['场景'], [referenceId]);
  assertNoPrivateResponseData(savedBatch.body, 'builtin batch save receipt');

  const presetPath = path.join(softwareRoot, 'workspace', 'projects', alpha.projectId, 'cache', '内置提示词预设.json');
  const persistedPreset = JSON.parse(await readFile(presetPath, 'utf8'));
  assert.equal(typeof persistedPreset.promptOverridesBySheet['场景'].promptText, 'string');
  assert.equal(persistedPreset.promptOverridesBySheet['场景'].promptText.length > 0, true);
  assert.equal(JSON.stringify(savedBatch.body).includes(persistedPreset.promptOverridesBySheet['场景'].promptText), false);

  const loadedBatch = await jsonRequest(`${baseUrl}/api/projects/${alpha.projectId}/builtin-batch`);
  assert.equal(loadedBatch.response.status, 200);
  assert.deepEqual(loadedBatch.body.data, savedBatch.body.data);
  assertNoPrivateResponseData(loadedBatch.body, 'builtin batch read receipt');
  const betaStillEmpty = await jsonRequest(`${baseUrl}/api/projects/${beta.projectId}/builtin-batch`);
  assert.equal(betaStillEmpty.body.data, null);

  const crossProjectBatch = await jsonRequest(`${baseUrl}/api/projects/${beta.projectId}/builtin-batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(batchConfiguration)
  });
  assertError(crossProjectBatch, 409, 'REFERENCE_SELECTION_MISMATCH', 'cross-project reference selection');
  const invalidBatch = await jsonRequest(`${baseUrl}/api/projects/${alpha.projectId}/builtin-batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...makeBatchConfiguration(), arbitraryCommand: 'not-allowed' })
  });
  assertError(invalidBatch, 400, 'INVALID_BATCH_REQUEST', 'invalid builtin batch');
  const wrongBatchMethod = await jsonRequest(`${baseUrl}/api/projects/${alpha.projectId}/builtin-batch`, { method: 'PUT' });
  assertError(wrongBatchMethod, 405, 'METHOD_NOT_ALLOWED', 'wrong builtin batch method');

  const invalidImage = Buffer.from('not-a-png', 'utf8');
  const rejectedUpload = await jsonRequest(`${baseUrl}/api/projects/${alpha.projectId}/references/cg/${encodeURIComponent('道具')}`, {
    method: 'PUT',
    headers: {
      'content-type': 'image/png',
      'content-length': String(invalidImage.length),
      'x-ka-filename': encodeURIComponent('损坏.png')
    },
    body: invalidImage
  });
  assertError(rejectedUpload, 422, 'INVALID_REFERENCE_IMAGE', 'invalid reference image');
  const wrongReferenceMethod = await jsonRequest(`${baseUrl}/api/projects/${alpha.projectId}/references` , { method: 'POST' });
  assertError(wrongReferenceMethod, 405, 'METHOD_NOT_ALLOWED', 'wrong reference list method');

  const crossProjectDelete = await jsonRequest(`${baseUrl}/api/projects/${beta.projectId}/references/${referenceId}`, { method: 'DELETE' });
  assertError(crossProjectDelete, 404, 'REFERENCE_NOT_FOUND', 'cross-project reference delete');
  const removed = await jsonRequest(`${baseUrl}/api/projects/${alpha.projectId}/references/${referenceId}`, { method: 'DELETE' });
  assert.equal(removed.response.status, 200);
  assert.deepEqual(removed.body.data, { referenceId, removed: true });
  assertNoPrivateResponseData(removed.body, 'reference delete receipt');
  const deletedContent = await jsonRequest(`${baseUrl}/api/projects/${alpha.projectId}/references/${referenceId}/content`);
  assertError(deletedContent, 404, 'REFERENCE_NOT_FOUND', 'deleted reference content');
});

test('formal condition-module HTTP bridge validates and enforces save/delete catalog CAS', async (context) => {
  const { baseUrl, softwareRoot } = await startFixture(context);
  const status = await jsonRequest(`${baseUrl}/api/prompt/status`);
  assert.equal(status.response.status, 200);
  assert.match(status.body.data.catalogFingerprint, /^[a-f0-9]{64}$/u);
  assertNoPrivateResponseData(status.body, 'prompt status');
  const initialFingerprint = status.body.data.catalogFingerprint;
  const module = validConditionModule();

  const validated = await jsonRequest(`${baseUrl}/api/prompt/condition-modules/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ module })
  });
  assert.equal(validated.response.status, 200);
  assert.deepEqual(validated.body.data, { valid: true, module });
  assertNoPrivateResponseData(validated.body, 'condition module validation');

  const invalidModule = structuredClone(module);
  invalidModule.operations[0].field = 'Use case';
  const rejected = await jsonRequest(`${baseUrl}/api/prompt/condition-modules/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ module: invalidModule })
  });
  assertError(rejected, 422, 'INVALID_CONDITION_MODULE', 'invalid condition module');
  const wrongMediaType = await jsonRequest(`${baseUrl}/api/prompt/condition-modules/validate`, {
    method: 'POST',
    body: JSON.stringify({ module })
  });
  assertError(wrongMediaType, 415, 'UNSUPPORTED_MEDIA_TYPE', 'condition validation media type');

  const saved = await jsonRequest(`${baseUrl}/api/prompt/condition-modules/${module.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ module, expectedCatalogFingerprint: initialFingerprint })
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.data.saved, module.id);
  assert.deepEqual(saved.body.data.module, module);
  assert.notEqual(saved.body.data.catalogFingerprint, initialFingerprint);
  assertNoPrivateResponseData(saved.body, 'condition module save');

  const staleSave = await jsonRequest(`${baseUrl}/api/prompt/condition-modules/${module.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ module, expectedCatalogFingerprint: initialFingerprint })
  });
  assertError(staleSave, 409, 'CATALOG_CONFLICT', 'stale condition module save');
  const idMismatch = await jsonRequest(`${baseUrl}/api/prompt/condition-modules/different-id`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ module, expectedCatalogFingerprint: saved.body.data.catalogFingerprint })
  });
  assertError(idMismatch, 400, 'MODULE_ID_MISMATCH', 'condition module id mismatch');

  const changed = structuredClone(module);
  changed.operations[0].value = '更新后的集成测试森林高速公路字段。';
  const updated = await jsonRequest(`${baseUrl}/api/prompt/condition-modules/${module.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ module: changed, expectedCatalogFingerprint: saved.body.data.catalogFingerprint })
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.data.module.revision, 2);
  assert.equal(updated.body.data.module.operations[0].value, changed.operations[0].value);
  assertNoPrivateResponseData(updated.body, 'condition module update');

  const staleDelete = await jsonRequest(`${baseUrl}/api/prompt/condition-modules/${module.id}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedCatalogFingerprint: saved.body.data.catalogFingerprint })
  });
  assertError(staleDelete, 409, 'CATALOG_CONFLICT', 'stale condition module delete');
  const removed = await jsonRequest(`${baseUrl}/api/prompt/condition-modules/${module.id}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedCatalogFingerprint: updated.body.data.catalogFingerprint })
  });
  assert.equal(removed.response.status, 200);
  assert.equal(removed.body.data.deleted, module.id);
  assertNoPrivateResponseData(removed.body, 'condition module delete');

  const missingDelete = await jsonRequest(`${baseUrl}/api/prompt/condition-modules/${module.id}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedCatalogFingerprint: removed.body.data.catalogFingerprint })
  });
  assertError(missingDelete, 404, 'MODULE_NOT_FOUND', 'missing condition module delete');
  const wrongItemMethod = await jsonRequest(`${baseUrl}/api/prompt/condition-modules/${module.id}`, { method: 'POST' });
  assertError(wrongItemMethod, 405, 'METHOD_NOT_ALLOWED', 'wrong condition module method');

  const workspaceRegistry = JSON.parse(await readFile(path.join(
    softwareRoot,
    'workspace',
    'shared-assets',
    '图片生成',
    'prompts',
    'modifiers',
    'condition-modules-v1.json'
  ), 'utf8'));
  assert.equal(workspaceRegistry.modules.some(({ id }) => id === module.id), false);
});
