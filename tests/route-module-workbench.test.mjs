import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RouteClassifierAdapter,
  RouteModuleAdminAdapter,
  applyModuleOperationsPreview,
  buildClassificationRequest,
  comparePresetIdentity,
  createRouteBranchFile,
  createRouteModulePackage,
  createRoutePresetPackage,
  detectRouteExchangeKind,
  findRoutePresetNameMatches,
  findSuspectedDuplicateBranches,
  mergeRouteModulePresets,
  parseRouteBranchFile,
  parseRouteExchangeArtifact,
  parseRouteModulePackage,
  parseRoutePresetPackage,
  planRouteBranchImport,
  planRouteBranchFileMerge,
  planRoutePresetImport,
  validateRouteModule
} from '../src/ui/services/route-module-workbench.mjs';

const makeModule = (id, value = '增加可信细节。', overrides = {}) => ({
  id,
  displayName: overrides.displayName || id,
  family: 'scene-environment',
  revision: 1,
  scope: { styles: ['cg'], assets: ['scene'], referenceModes: ['none', 'style'] },
  classifier: {
    definition: overrides.definition || '此类结构控制画面主要空间。',
    selectionPolicy: 'single-dominant',
    controlDimensions: ['main-spatial-structure', 'subject-recognition'],
    tieBreak: '主体大轮廓优先。',
    noDefault: true
  },
  operations: [{ op: 'append', field: 'Scene/backdrop', value }],
  tests: [],
  origin: { kind: 'session-draft' }
});

test('route branch validation accepts plain-language conditions and rejects protected fields', () => {
  const valid = validateRouteModule(makeModule('forest-vegetation'));
  assert.equal(valid.valid, true);
  const invalid = makeModule('bad branch');
  invalid.classifier.definition = '';
  invalid.operations[0].field = 'Use case';
  const result = validateRouteModule(invalid);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map(({ path }) => path), ['id', 'classifier.definition', 'operations[0].field']);
});

test('classification request contains full production notes and candidate descriptions but no prompt operations', () => {
  const forest = makeModule('forest-vegetation');
  const prop = { ...makeModule('technology-prop'), scope: { styles: ['anime'], assets: ['prop'], referenceModes: ['none'] } };
  const request = buildClassificationRequest({
    style: 'cg',
    asset: 'scene',
    referenceMode: 'none',
    assetId: 'SCENE-014',
    productionNotes: '巨型板根和树冠控制主要空间。',
    candidates: [forest, prop]
  });
  assert.equal(request.input.assetId, 'SCENE-014');
  assert.equal(request.input.referenceMode, 'none');
  assert.equal(request.input.productionNotes, '巨型板根和树冠控制主要空间。');
  assert.deepEqual(request.candidates.map(({ id }) => id), ['forest-vegetation']);
  assert.equal(JSON.stringify(request).includes('增加可信细节'), false);
  assert.equal(JSON.stringify(request).includes('semanticTag'), false);
});

test('classification request rejects unfinished multi-branch stacking policy', () => {
  const stacked = makeModule('stacked-branch');
  stacked.classifier.selectionPolicy = 'stack-allowed';
  assert.throws(
    () => buildClassificationRequest({
      style: 'cg', asset: 'scene', referenceMode: 'none', assetId: 'SCENE-014',
      productionNotes: '树林与山体都控制画面主要空间。', candidates: [stacked]
    }),
    /当前版本一次只能选择一个主分支/
  );
});

test('classification request excludes branches for a different reference mode', () => {
  const styleReferenceOnly = makeModule('style-reference-only');
  styleReferenceOnly.scope.referenceModes = ['style'];
  assert.throws(
    () => buildClassificationRequest({
      style: 'cg', asset: 'scene', referenceMode: 'none', assetId: 'SCENE-014',
      productionNotes: '树林控制画面主要空间。', candidates: [styleReferenceOnly]
    }),
    /参考图方式下没有可供 Agent 判断的分支/
  );
});

test('classifier bridge accepts only a candidate ID or null', async () => {
  const forest = makeModule('forest-vegetation');
  const request = buildClassificationRequest({
    style: 'cg', asset: 'scene', referenceMode: 'none', assetId: 'SCENE-014',
    productionNotes: '树林控制画面主要空间。', candidates: [forest]
  });
  const adapter = new RouteClassifierAdapter({
    bridge: { classifyConditionModule: async () => ({ ok: true, data: { selectedId: forest.id, reason: '树林控制主要空间' } }) }
  });
  assert.deepEqual(await adapter.classify(request), {
    source: 'core-bridge', selectedId: forest.id, reason: '树林控制主要空间'
  });
  const invalid = new RouteClassifierAdapter({
    bridge: { classifyConditionModule: async () => ({ selectedId: 'invented-branch' }) }
  });
  await assert.rejects(() => invalid.classify(request), /候选范围之外/);
});

test('local effect preview only changes declared prompt fields and defers whole-route replacement', () => {
  const module = makeModule('forest-vegetation');
  module.operations.push({ op: 'replaceWith', routeId: 'builtin.cg.scene' });
  const preview = applyModuleOperationsPreview([
    { label: 'Scene/backdrop', value: '基础背景。' },
    { label: 'Avoid', value: '避免文字。' }
  ], module);
  assert.deepEqual(preview.diff, [{ field: 'Scene/backdrop', before: '基础背景。', after: '基础背景。 增加可信细节。' }]);
  assert.equal(preview.fields.find(({ label }) => label === 'Avoid').value, '避免文字。');
  assert.equal(preview.deferred.length, 1);
});

test('field operations preview append, prepend and replace only their selected target', () => {
  const baseFields = [
    { label: 'Scene/backdrop', value: '基础场景' },
    { label: 'Avoid', value: '基础禁用' },
    { label: 'Lighting/mood', value: '基础光线' }
  ];
  const cases = [
    [{ op: 'append', field: 'Scene/backdrop', value: '末尾内容' }, { field: 'Scene/backdrop', before: '基础场景', after: '基础场景 末尾内容' }],
    [{ op: 'prepend', field: 'Avoid', value: '开头内容' }, { field: 'Avoid', before: '基础禁用', after: '开头内容 基础禁用' }],
    [{ op: 'set', field: 'Lighting/mood', value: '替换内容' }, { field: 'Lighting/mood', before: '基础光线', after: '替换内容' }]
  ];
  for (const [operation, expected] of cases) {
    const module = makeModule('field-preview');
    module.operations = [operation];
    assert.deepEqual(applyModuleOperationsPreview(baseFields, module).diff, [expected]);
  }
});

test('multiple operations on one field produce one cumulative final field change', () => {
  const module = makeModule('cumulative-preview');
  module.operations = [
    { op: 'prepend', field: 'Scene/backdrop', value: '前置内容' },
    { op: 'append', field: 'Scene/backdrop', value: '末尾内容' }
  ];
  const preview = applyModuleOperationsPreview([
    { label: 'Scene/backdrop', value: '基础场景' },
    { label: 'Avoid', value: '基础禁用' }
  ], module);
  assert.deepEqual(preview.diff, [{
    field: 'Scene/backdrop',
    before: '基础场景',
    after: '前置内容 基础场景 末尾内容'
  }]);
  assert.equal(preview.diff.some(({ field }) => field === 'Avoid'), false);
});

test('preset export and import round-trip preserves branch tests and source version', () => {
  const module = makeModule('forest-vegetation');
  module.tests.push({
    id: 'case-1', assetId: 'SCENE-014', style: 'cg', asset: 'scene',
    productionNotes: '森林结构控制主要空间。', expectedConditionId: 'forest-vegetation'
  });
  const routePackage = createRouteModulePackage({
    modules: [module],
    source: { catalogVersion: 2, catalogFingerprint: 'abc' },
    exportedAt: '2026-08-03T00:00:00.000Z'
  });
  const parsed = parseRouteModulePackage(JSON.stringify(routePackage));
  assert.equal(parsed.source.catalogVersion, 2);
  assert.equal(parsed.modules[0].tests[0].expectedConditionId, 'forest-vegetation');
  assert.throws(
    () => createRouteModulePackage({ modules: [module, { ...module }] }),
    /不能出现两个相同的分支唯一 ID/
  );
});

test('explicit branch files and preset packages are distinguishable while legacy v1 stays readable', () => {
  const module = makeModule('forest-vegetation');
  const branchFile = createRouteBranchFile({
    module,
    source: { catalogVersion: 2 },
    exportedAt: '2026-08-04T00:00:00.000Z'
  });
  assert.equal(detectRouteExchangeKind(branchFile), 'branch-file');
  assert.equal(parseRouteBranchFile(JSON.stringify(branchFile)).module.id, module.id);
  assert.equal(parseRouteExchangeArtifact(branchFile).type, 'branch-file');
  assert.throws(
    () => parseRoutePresetPackage(branchFile),
    (error) => error.code === 'WRONG_ARTIFACT_KIND' && /单个分支文件/.test(error.message)
  );

  const presetPackage = createRoutePresetPackage({
    preset: { id: 'environment-pack', name: '环境分支预设', revision: 3 },
    modules: [module],
    templates: { drafts: [{ style: 'cg', asset: 'scene', fields: { 'Scene/backdrop': '基础场景' } }] },
    source: { catalogVersion: 2 },
    exportedAt: '2026-08-04T00:00:00.000Z'
  });
  assert.equal(detectRouteExchangeKind(presetPackage), 'preset-package');
  assert.equal(parseRouteExchangeArtifact(presetPackage).type, 'preset-package');
  assert.deepEqual(parseRoutePresetPackage(JSON.stringify(presetPackage)).templates, presetPackage.templates);
  const emptyPreset = createRoutePresetPackage({
    preset: { id: 'empty-local-preset', name: '空白本机预设', revision: 1 },
    modules: [],
    templates: {}
  });
  assert.deepEqual(parseRoutePresetPackage(emptyPreset).modules, []);
  assert.throws(
    () => parseRouteBranchFile(presetPackage),
    (error) => error.code === 'WRONG_ARTIFACT_KIND' && /整套预设包/.test(error.message)
  );

  const legacy = createRouteModulePackage({ modules: [module] });
  assert.equal(detectRouteExchangeKind(legacy), 'legacy-module-package');
  assert.equal(parseRouteExchangeArtifact(legacy).value.modules[0].id, module.id);
  assert.equal(parseRouteModulePackage(JSON.stringify(legacy)).modules[0].id, module.id);
});

test('preset identity comparison separates stable ID, normalized name and complete content', () => {
  const module = makeModule('forest-vegetation');
  const makePreset = (id, name, value = '基础模板') => createRoutePresetPackage({
    preset: { id, name, revision: 1 },
    modules: [module],
    templates: { cg: { scene: value } }
  });
  const original = makePreset('environment-pack', '森林　预设');
  const renamedCopy = makePreset('environment-copy', '  森林 预设  ');
  assert.deepEqual(comparePresetIdentity(original, renamedCopy), {
    sameId: false,
    sameName: true,
    sameContent: true,
    status: 'same-name'
  });
  assert.equal(findRoutePresetNameMatches('森林 预设', [original, renamedCopy]).length, 2);
  const sameIdChanged = makePreset('environment-pack', '环境预设', '修改后的模板');
  assert.equal(comparePresetIdentity(original, sameIdChanged).status, 'conflict');
  assert.equal(planRoutePresetImport(renamedCopy, [original]).status, 'same-name');
  assert.equal(planRoutePresetImport(sameIdChanged, [original]).recommendedAction, 'review');
});

test('single branch import keeps same ID conflicts separate from different-ID suspected duplicates', () => {
  const existing = makeModule('forest-v1', '当前内容。', { displayName: '森林植被' });
  const sameIdSame = createRouteBranchFile({ module: existing });
  assert.equal(planRouteBranchImport(sameIdSame, [existing]).status, 'same');

  const changed = makeModule('forest-v1', '修改内容。', { displayName: '森林植被' });
  assert.equal(planRouteBranchImport(createRouteBranchFile({ module: changed }), [existing]).status, 'conflict');

  const separatelyCreated = makeModule('forest-v2', '另一位开发者的内容。', { displayName: ' 森林植被 ' });
  separatelyCreated.scope = { styles: ['cg'], assets: ['scene'], referenceModes: ['style', 'none'] };
  const suspected = findSuspectedDuplicateBranches(separatelyCreated, [existing]);
  assert.deepEqual(suspected.map(({ id }) => id), ['forest-v1']);
  const suspectedPlan = planRouteBranchImport(createRouteBranchFile({ module: separatelyCreated }), [existing]);
  assert.equal(suspectedPlan.status, 'suspected-duplicate');
  assert.equal(suspectedPlan.recommendedAction, 'review');

  const differentScope = makeModule('forest-prop', '道具内容。', { displayName: '森林植被' });
  differentScope.scope = { styles: ['cg'], assets: ['prop'], referenceModes: ['none', 'style'] };
  assert.equal(planRouteBranchImport(createRouteBranchFile({ module: differentScope }), [existing]).status, 'new');
});

test('branch-file merge preserves every source and requires explicit resolution for conflicts', () => {
  const current = makeModule('current-branch', '当前内容。');
  const same = createRouteBranchFile({ module: current });
  const newBranch = makeModule('new-branch', '新增内容。');
  const conflictA = makeModule('conflict-branch', '版本 A。');
  const conflictB = makeModule('conflict-branch', '版本 B。');
  const suspected = makeModule('possible-copy', '疑似副本。', { displayName: current.displayName });
  const merge = planRouteBranchFileMerge([
    { id: 'same', name: '相同文件', file: same },
    { id: 'new-a', name: '新增 A', file: createRouteBranchFile({ module: newBranch }) },
    { id: 'new-b', name: '新增 B', file: createRouteBranchFile({ module: newBranch }) },
    { id: 'conflict-a', name: '冲突 A', file: createRouteBranchFile({ module: conflictA }) },
    { id: 'conflict-b', name: '冲突 B', file: createRouteBranchFile({ module: conflictB }) },
    { id: 'suspected', name: '疑似副本', file: createRouteBranchFile({ module: suspected }) }
  ], [current]);
  assert.deepEqual(merge.summary, { new: 1, same: 1, idConflict: 1, suspectedDuplicate: 1, unresolved: 2 });
  assert.equal(merge.items.find(({ id }) => id === 'new-branch').variants[0].sources.length, 2);
  const conflict = merge.items.find(({ id }) => id === 'conflict-branch');
  assert.equal(conflict.variants.length, 2);
  assert.equal(conflict.resolutionRequired, true);
  assert.equal(Object.hasOwn(conflict, 'selectedModule'), false);
  assert.equal(merge.items.find(({ id }) => id === 'possible-copy').recommendedAction, 'unresolved');
});

test('merging selected presets reports new, same and conflict by stable branch ID', () => {
  const current = makeModule('current-branch', '当前内容。');
  const sharedNew = makeModule('new-branch', '新增内容。');
  const conflictA = makeModule('conflict-branch', '版本 A。');
  const conflictB = makeModule('conflict-branch', '版本 B。');
  const presetA = createRouteModulePackage({ modules: [current, sharedNew, conflictA], exportedAt: '2026-08-03T00:00:00.000Z' });
  const presetB = createRouteModulePackage({ modules: [sharedNew, conflictB], exportedAt: '2026-08-03T00:00:00.000Z' });
  const merged = mergeRouteModulePresets([
    { id: 'a', name: '开发者 A', package: presetA },
    { id: 'b', name: '开发者 B', package: presetB }
  ], [current]);
  assert.deepEqual(merged.summary, { new: 1, same: 1, conflict: 1 });
  assert.equal(merged.items.find(({ id }) => id === 'new-branch').variants[0].sources.length, 2);
  assert.equal(merged.items.find(({ id }) => id === 'conflict-branch').recommendedAction, 'stage-update');
});

test('admin adapter keeps formal prompt library writes locked when the host bridge is absent', async () => {
  const adapter = new RouteModuleAdminAdapter({ bridge: null });
  assert.deepEqual(adapter.getCapabilities(), { validate: false, save: false, importPackage: false, remove: false });
  const result = await adapter.validate(makeModule('forest-vegetation'));
  assert.equal(result.source, 'local-validation');
  await assert.rejects(() => adapter.save(makeModule('forest-vegetation')), /正式注册表写接口尚未接入/);
  await assert.rejects(() => adapter.remove('forest-vegetation'), /正式提示词库删除接口尚未接入/);
});

test('admin adapter only forwards formal branch deletion through the protected host bridge', async () => {
  let received = null;
  const adapter = new RouteModuleAdminAdapter({
    bridge: {
      async deleteConditionModule(id, options) {
        received = { id, options };
        return { ok: true, data: { deleted: id } };
      }
    }
  });
  assert.equal(adapter.getCapabilities().remove, true);
  const result = await adapter.remove('forest-vegetation', { expectedCatalogFingerprint: 'fingerprint-1' });
  assert.deepEqual(received, { id: 'forest-vegetation', options: { expectedCatalogFingerprint: 'fingerprint-1' } });
  assert.deepEqual(result, { deleted: 'forest-vegetation' });
  await assert.rejects(() => adapter.remove('../catalog'), /正式分支编号无效/);
  await assert.rejects(() => adapter.remove('forest-vegetation'), /尚未取得正式提示词库版本/);
});

test('admin adapter rejects failed or mismatched formal delete receipts', async () => {
  const failed = new RouteModuleAdminAdapter({
    bridge: { async deleteConditionModule() { return { ok: false, error: { code: 'CATALOG_STALE', message: '词库版本已变化' } }; } }
  });
  await assert.rejects(
    () => failed.remove('forest-vegetation', { expectedCatalogFingerprint: 'fingerprint-1' }),
    (error) => error.code === 'CATALOG_STALE' && error.message === '词库版本已变化'
  );
  const mismatched = new RouteModuleAdminAdapter({
    bridge: { async deleteConditionModule() { return { ok: true, data: { deleted: 'rock-terrain' } }; } }
  });
  await assert.rejects(
    () => mismatched.remove('forest-vegetation', { expectedCatalogFingerprint: 'fingerprint-1' }),
    /删除目标与当前分支不一致/
  );
});
