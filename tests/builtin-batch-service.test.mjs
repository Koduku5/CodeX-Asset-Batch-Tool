import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BuiltinBatchServiceError,
  createBuiltinBatchService
} from '../src/server/builtin-batch-service.mjs';

const SHEETS = ['角色', '生物', '群演', '场景', '道具'];
const makeRequest = () => ({
  version: 1,
  styleId: 'cg',
  generationLimit: 5,
  enabledSheets: [...SHEETS],
  referenceModeBySheet: Object.fromEntries(SHEETS.map((sheet) => [sheet, 'style'])),
  referenceIdsBySheet: Object.fromEntries(SHEETS.map((sheet) => [sheet, []])),
  promptOverridesBySheet: Object.fromEntries(SHEETS.map((sheet) => [sheet, null]))
});

const makeFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'ka-batch-service-'));
  const projects = new Map();
  for (const projectId of ['project-a', 'project-b']) {
    const projectRoot = join(root, projectId);
    await mkdir(join(projectRoot, 'cache'), { recursive: true });
    projects.set(projectId, projectRoot);
  }
  const references = [{
    referenceId: `ref-${'a'.repeat(64)}`,
    styleId: 'cg',
    sheetName: '场景',
    path: `cache/内置参考图/cg/场景/${'b'.repeat(64)}.png`,
    sourceName: '森林.png',
    size: 100,
    sha256: 'b'.repeat(64)
  }];
  const runtime = {
    makeBuiltinRouteFingerprintsBySheet: (batch) => Object.fromEntries(batch.enabledSheets.map((sheet) => [sheet, 'c'.repeat(64)])),
    validateBuiltinPromptPreset: (preset) => preset.version === 6,
    builtinPromptPresetMatchesCatalog: () => true,
    makeBuiltinPromptSpec: (_definition, _preset, item) => ({ status: 'configured', message: '', sheetName: item.sheetName })
  };
  const service = createBuiltinBatchService({
    resolveProjectRoot: async (projectId) => ({ rootPath: projects.get(projectId) }),
    materializeProjectRuntime: async () => {},
    referenceStore: { listImages: async ({ projectId }) => projectId === 'project-a' ? references : [] },
    getCatalog: async () => ({ catalog: true }),
    getPipelineRuntime: async () => runtime,
    makeCatalogFingerprint: () => 'd'.repeat(64),
    resolvePromptTemplate: (_catalog, { asset }) => ({ promptFields: [{ label: 'Asset type', value: asset }] }),
    compileLegacyDefinition: () => ({ definition: true }),
    clock: () => new Date('2026-08-04T01:02:03.000Z')
  });
  return { root, projects, references, service };
};

test('builtin batch configuration writes a valid v6 preset only inside the selected project', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const request = makeRequest();
  request.referenceIdsBySheet['场景'] = [fixture.references[0].referenceId];
  const summary = await fixture.service.savePreset({ projectId: 'project-a', configuration: request });
  assert.deepEqual(summary.referenceCountsBySheet, { 角色: 0, 生物: 0, 群演: 0, 场景: 1, 道具: 0 });
  assert.deepEqual(summary.selectedReferenceIdsBySheet, { 角色: [], 生物: [], 群演: [], 场景: [fixture.references[0].referenceId], 道具: [] });
  assert.equal(summary.confirmedAt, '2026-08-04T01:02:03.000Z');
  assert.equal(Object.hasOwn(summary, 'promptOverridesBySheet'), false);

  const preset = JSON.parse(await readFile(join(fixture.projects.get('project-a'), 'cache', '内置提示词预设.json'), 'utf8'));
  assert.equal(preset.version, 6);
  assert.equal(preset.referencesBySheet['场景'][0].path, fixture.references[0].path);
  assert.equal(preset.promptOverridesBySheet['场景'].routeMode, 'reference');
  assert.match(preset.promptOverridesBySheet['场景'].promptText, /^Asset type: 场景$/u);
  assert.equal(await fixture.service.readPreset({ projectId: 'project-b' }), null);
  const loaded = await fixture.service.readPreset({ projectId: 'project-a' });
  assert.equal(loaded.styleId, 'cg');
  assert.deepEqual(loaded.selectedReferenceIdsBySheet['场景'], [fixture.references[0].referenceId]);
});

test('builtin batch configuration rejects cross-style references, weak visual unification and unknown fields', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const expectCode = async (configuration, code) => assert.rejects(
    fixture.service.savePreset({ projectId: 'project-a', configuration }),
    (error) => {
      assert.equal(error instanceof BuiltinBatchServiceError, true);
      assert.equal(error.code, code);
      return true;
    }
  );
  const mismatch = makeRequest();
  mismatch.referenceIdsBySheet['角色'] = [fixture.references[0].referenceId];
  await expectCode(mismatch, 'REFERENCE_SELECTION_MISMATCH');

  const insufficient = makeRequest();
  insufficient.referenceModeBySheet['场景'] = 'visual-consistency';
  insufficient.referenceIdsBySheet['场景'] = [fixture.references[0].referenceId];
  await expectCode(insufficient, 'INSUFFICIENT_REFERENCE_IMAGES');

  const unknown = { ...makeRequest(), arbitraryCommand: 'rm -rf' };
  await expectCode(unknown, 'INVALID_BATCH_REQUEST');

  const duplicateCustomFields = makeRequest();
  duplicateCustomFields.promptOverridesBySheet['场景'] = {
    routeMode: 'default',
    promptText: 'Asset type: 场景\nCamera language: 广角',
    customFieldLabels: ['Camera language', 'camera language']
  };
  await expectCode(duplicateCustomFields, 'INVALID_PROMPT_OVERRIDE');
});

test('builtin batch configuration preserves validated custom prompt fields', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const request = makeRequest();
  request.promptOverridesBySheet['场景'] = {
    routeMode: 'default',
    promptText: 'Asset type: 场景\nCamera language: 85mm telephoto',
    customFieldLabels: ['Camera language']
  };

  await fixture.service.savePreset({ projectId: 'project-a', configuration: request });
  const preset = JSON.parse(await readFile(join(fixture.projects.get('project-a'), 'cache', '内置提示词预设.json'), 'utf8'));
  assert.deepEqual(preset.promptOverridesBySheet['场景'].customFieldLabels, ['Camera language']);
  assert.match(preset.promptOverridesBySheet['场景'].promptText, /Camera language: 85mm telephoto/u);
});
