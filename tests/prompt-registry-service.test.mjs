import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  loadPromptCatalog,
  makeCatalogFingerprint,
  validatePromptCatalog
} from '../engine/scripts/lib/prompt_catalog.mjs';
import {
  createPromptRegistryService,
  PromptRegistryServiceError
} from '../src/server/prompt-registry-service.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageAssets = path.resolve(projectRoot, 'engine', 'assets');

const validModule = () => ({
  id: 'forest-highway',
  displayName: '森林高速公路',
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

const fixture = async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ka-prompt-registry-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sharedAssetsRoot = path.join(root, 'shared-assets');
  await cp(packageAssets, sharedAssetsRoot, { recursive: true, errorOnExist: true });
  const catalogPath = path.join(sharedAssetsRoot, '图片生成', 'prompts', 'catalog.json');
  let catalogPromise = null;
  const getCatalog = () => {
    if (catalogPromise === null) catalogPromise = loadPromptCatalog(catalogPath);
    return catalogPromise;
  };
  const invalidateCatalog = () => { catalogPromise = null; };
  const service = createPromptRegistryService({
    sharedAssetsRoot,
    getCatalog,
    invalidateCatalog,
    makeCatalogFingerprint,
    validatePromptCatalog
  });
  return { sharedAssetsRoot, getCatalog, service };
};

test('formal condition modules use catalog CAS, revision bump, reload and deletion', async (context) => {
  const { service, getCatalog } = await fixture(context);
  const initial = await getCatalog();
  const initialFingerprint = makeCatalogFingerprint(initial);
  assert.equal((await service.validateModule(validModule())).valid, true);

  const saved = await service.saveModule({ module: validModule(), expectedCatalogFingerprint: initialFingerprint });
  assert.equal(saved.saved, 'forest-highway');
  assert.equal(saved.module.revision, 1);
  assert.notEqual(saved.catalogFingerprint, initialFingerprint);
  assert.equal((await getCatalog()).conditionModules.modules.length, 1);

  await assert.rejects(
    service.saveModule({ module: validModule(), expectedCatalogFingerprint: initialFingerprint }),
    (error) => error instanceof PromptRegistryServiceError && error.code === 'CATALOG_CONFLICT'
  );

  const changed = validModule();
  changed.operations[0].value = '更新后的森林高速公路字段。';
  const updated = await service.saveModule({ module: changed, expectedCatalogFingerprint: saved.catalogFingerprint });
  assert.equal(updated.module.revision, 2);
  assert.equal((await getCatalog()).conditionModules.modules[0].operations[0].value, changed.operations[0].value);

  const removed = await service.deleteModule({ id: 'forest-highway', expectedCatalogFingerprint: updated.catalogFingerprint });
  assert.equal(removed.deleted, 'forest-highway');
  assert.deepEqual((await getCatalog()).conditionModules.modules, []);
});

test('invalid modules fail before the formal registry file changes', async (context) => {
  const { sharedAssetsRoot, service, getCatalog } = await fixture(context);
  const registryPath = path.join(sharedAssetsRoot, '图片生成', 'prompts', 'modifiers', 'condition-modules-v1.json');
  const before = await readFile(registryPath, 'utf8');
  const invalid = validModule();
  invalid.operations[0].field = 'Use case';
  await assert.rejects(
    service.saveModule({ module: invalid, expectedCatalogFingerprint: makeCatalogFingerprint(await getCatalog()) }),
    (error) => error instanceof PromptRegistryServiceError && error.code === 'INVALID_CONDITION_MODULE'
  );
  assert.equal(await readFile(registryPath, 'utf8'), before);
});
