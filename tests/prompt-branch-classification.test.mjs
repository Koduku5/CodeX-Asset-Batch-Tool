import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createPromptBranchClassificationSession,
  PromptBranchClassificationError
} from '../src/server/prompt-branch-classification.mjs';

const CATALOG_FINGERPRINT = 'a'.repeat(64);
const REGISTRY_FINGERPRINT = 'b'.repeat(64);
const SHEETS = ['角色', '生物', '群演', '场景', '道具'];

const queuePath = (root) => path.join(root, 'cache', '出图队列.json');
const progressPath = (root) => path.join(root, 'cache', '出图进度.json');
const matchingPath = (root) => path.join(root, 'cache', '提示词分支匹配.json');

const writeJson = (target, value) => writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
const readJson = async (target) => JSON.parse(await readFile(target, 'utf8'));

const makeProjectRoot = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ka-prompt-branch-'));
  await Promise.all([
    mkdir(path.join(root, 'cache'), { recursive: true }),
    mkdir(path.join(root, 'scripts', 'commands'), { recursive: true }),
    mkdir(path.join(root, 'scripts', 'pipeline'), { recursive: true }),
    mkdir(path.join(root, 'scripts', 'lib'), { recursive: true }),
    mkdir(path.join(root, 'assets', '图片生成', 'prompts'), { recursive: true })
  ]);
  await Promise.all([
    writeFile(path.join(root, 'scripts', 'commands', 'node.ps1'), '# fixed runner\n', 'utf8'),
    writeFile(path.join(root, 'scripts', 'pipeline', 'build_image_queue.mjs'), '// fixed builder\n', 'utf8'),
    writeFile(path.join(root, 'scripts', 'lib', 'prompt_catalog.mjs'), '// fixed catalog parser\n', 'utf8'),
    writeJson(path.join(root, 'assets', '图片生成', 'prompts', 'catalog.json'), { version: 1 })
  ]);
  return root;
};

const makeBaseQueue = (items = [{
  key: '场景:SCENE-001',
  sheetName: '场景',
  assetName: '高速公路',
  productionNotes: '夜间的现代高速公路，远处有冷色科技城市灯光。'
}]) => ({
  version: 4,
  builtinPromptBatch: {
    styleId: 'cg',
    referencesBySheet: Object.fromEntries(SHEETS.map((sheet) => [sheet, []])),
    referenceModeBySheet: Object.fromEntries(SHEETS.map((sheet) => [sheet, 'style']))
  },
  items
});

const makeCatalogApi = (modules = []) => {
  const loaded = {
    catalog: {
      enums: {
        styles: ['anime', 'cg', 'live-action'],
        assets: ['character', 'creature', 'crowd', 'scene', 'prop'],
        referenceModes: ['none', 'style', 'subject']
      },
      legacyNames: {
        styles: { anime: '二次元', cg: 'CG', 'live-action': '真人' },
        assets: {
          character: '角色', creature: '生物', crowd: '群演', scene: '场景', prop: '道具'
        },
        referenceModes: { none: '无参考图', style: '风格参考', subject: '主体参考' }
      }
    },
    conditionModules: { modules }
  };
  return {
    loaded,
    catalogFingerprint: CATALOG_FINGERPRINT,
    conditionRegistryFingerprint: REGISTRY_FINGERPRINT,
    resolveSelectedConditionModules(_loaded, selectedIds, context) {
      const selected = selectedIds.map((id) => {
        const module = modules.find((candidate) => candidate.id === id);
        if (!module) throw new Error('unknown module');
        if (!module.scope.styles.includes(context.style)
          || !module.scope.assets.includes(context.asset)
          || !module.scope.referenceModes.includes(context.referenceMode)) {
          throw new Error('module is outside the current route');
        }
        return module;
      });
      if (new Set(selected.map(({ family }) => family)).size !== selected.length) {
        throw new Error('same-family conflict');
      }
      return selected;
    }
  };
};

const makeModule = ({ id = 'scene.environment.highway', family = 'scene.environment' } = {}) => ({
  id,
  displayName: '高速公路',
  family,
  scope: { styles: ['cg'], assets: ['scene'], referenceModes: ['none'] },
  classifier: {
    definition: '制作说明明确描述现代高速公路时选择。',
    selectionPolicy: '仅在语义明确时选择。',
    controlDimensions: ['environment'],
    tieBreak: '优先最具体的场景分支。',
    noDefault: true
  }
});

const makeBuildQueue = ({ baseQueue, failFinal = false, mutateProgress = true } = {}) => {
  let invocation = 0;
  return async ({ projectRoot }) => {
    invocation += 1;
    if (invocation === 1) {
      await writeJson(queuePath(projectRoot), baseQueue);
      if (mutateProgress) await writeJson(progressPath(projectRoot), { stage: 'base-build' });
      return;
    }
    if (failFinal) throw new Error('formal final queue validation failed');
    const matching = await readJson(matchingPath(projectRoot));
    await writeJson(queuePath(projectRoot), {
      ...baseQueue,
      conditionMatching: {
        catalogFingerprint: matching.catalogFingerprint,
        conditionRegistryFingerprint: matching.conditionRegistryFingerprint
      },
      items: baseQueue.items.map((item) => ({ ...item, ...matching.items[item.key] }))
    });
    if (mutateProgress) await writeJson(progressPath(projectRoot), { stage: 'final-build' });
  };
};

const assertSessionArtifactsRemoved = async (root) => {
  const names = await readdir(path.join(root, 'cache'));
  assert.equal(names.some((name) => name.startsWith('.提示词分支分类')), false);
};

test('classification commits strict matching and rebuilds the formal final queue', async (context) => {
  const root = await makeProjectRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const baseQueue = makeBaseQueue();
  const module = makeModule();
  const session = await createPromptBranchClassificationSession(root, {
    createToken: () => 'classification-success-0001',
    loadCatalog: async () => makeCatalogApi([module]),
    runBuildQueue: makeBuildQueue({ baseQueue })
  });

  assert.equal(session.totalItems, 1);
  assert.equal(session.automaticCount, 0);
  assert.equal(session.pages.length, 1);
  assert.equal(session.pages[0].count, 1);
  assert.equal(session.pages[0].relativeRequestPath.startsWith('cache/'), true);
  assert.equal(session.pages[0].outputSchema.additionalProperties, false);
  assert.equal(
    Object.hasOwn(
      session.pages[0].outputSchema.properties.assignments.items.properties.selectedConditionModuleIds,
      'uniqueItems'
    ),
    false
  );

  assert.throws(
    () => session.validatePageResult(session.pages[0], {
      completed: true,
      action: 'classify-prompt-branches',
      summary: 'duplicate selection',
      assignments: [{
        key: '鍦烘櫙:SCENE-001',
        selectedConditionModuleIds: [module.id, module.id]
      }]
    }),
    (error) => error instanceof PromptBranchClassificationError
      && error.code === 'INVALID_CLASSIFICATION_RESULT'
  );

  assert.throws(
    () => session.validatePageResult(session.pages[0], {
      completed: true,
      action: 'classify-prompt-branches',
      summary: 'invalid selection',
      assignments: [{
        key: '场景:SCENE-001',
        selectedConditionModuleIds: ['not-a-candidate']
      }]
    }),
    (error) => error instanceof PromptBranchClassificationError
      && error.code === 'INVALID_CLASSIFICATION_RESULT'
  );

  const validated = session.validatePageResult(session.pages[0], {
    completed: true,
    action: 'classify-prompt-branches',
    summary: 'one explicit highway branch selected',
    assignments: [{
      key: '场景:SCENE-001',
      selectedConditionModuleIds: [module.id]
    }]
  });
  const receipt = await session.commit([validated]);

  assert.deepEqual(receipt, { processedCount: 1, semanticPageCount: 1 });
  assert.equal(session.committed, true);
  assert.deepEqual(await readJson(matchingPath(root)), {
    version: 1,
    catalogFingerprint: CATALOG_FINGERPRINT,
    conditionRegistryFingerprint: REGISTRY_FINGERPRINT,
    items: {
      '场景:SCENE-001': {
        selectedConditionModuleIds: [module.id]
      }
    }
  });
  const finalQueue = await readJson(queuePath(root));
  assert.deepEqual(finalQueue.items[0].selectedConditionModuleIds, [module.id]);
  await assertSessionArtifactsRemoved(root);
});

test('an empty condition registry writes one empty selection for every queue key without Agent pages', async (context) => {
  const root = await makeProjectRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const baseQueue = makeBaseQueue([
    {
      key: '场景:SCENE-001', sheetName: '场景', assetName: '树林',
      productionNotes: '茂密树林中的林间空地。'
    },
    {
      key: '道具:PROP-001', sheetName: '道具', assetName: '手电筒',
      productionNotes: '便携式金属手电筒。'
    }
  ]);
  const session = await createPromptBranchClassificationSession(root, {
    createToken: () => 'classification-empty-0001',
    loadCatalog: async () => makeCatalogApi([]),
    runBuildQueue: makeBuildQueue({ baseQueue })
  });

  assert.equal(session.totalItems, 2);
  assert.equal(session.automaticCount, 2);
  assert.equal(session.pages.length, 0);
  const receipt = await session.commit([]);
  assert.deepEqual(receipt, { processedCount: 2, semanticPageCount: 0 });
  const matching = await readJson(matchingPath(root));
  assert.deepEqual(Object.keys(matching.items), ['场景:SCENE-001', '道具:PROP-001']);
  for (const item of Object.values(matching.items)) {
    assert.deepEqual(item, { selectedConditionModuleIds: [] });
  }
  await assertSessionArtifactsRemoved(root);
});

test('a failed final queue build restores matching, queue and progress byte-for-byte', async (context) => {
  const root = await makeProjectRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const oldState = {
    matching: '{"old":"matching"}\r\n',
    queue: '{"old":"queue"}\r\n',
    progress: '{"old":"progress"}\r\n'
  };
  await Promise.all([
    writeFile(matchingPath(root), oldState.matching, 'utf8'),
    writeFile(queuePath(root), oldState.queue, 'utf8'),
    writeFile(progressPath(root), oldState.progress, 'utf8')
  ]);
  const baseQueue = makeBaseQueue();
  const module = makeModule();
  const session = await createPromptBranchClassificationSession(root, {
    createToken: () => 'classification-rollback-0001',
    loadCatalog: async () => makeCatalogApi([module]),
    runBuildQueue: makeBuildQueue({ baseQueue, failFinal: true })
  });
  const validated = session.validatePageResult(session.pages[0], {
    completed: true,
    action: 'classify-prompt-branches',
    summary: 'select highway',
    assignments: [{
      key: '场景:SCENE-001',
      selectedConditionModuleIds: [module.id]
    }]
  });

  await assert.rejects(
    () => session.commit([validated]),
    /formal final queue validation failed/u
  );
  assert.equal(await readFile(matchingPath(root), 'utf8'), oldState.matching);
  assert.equal(await readFile(queuePath(root), 'utf8'), oldState.queue);
  assert.equal(await readFile(progressPath(root), 'utf8'), oldState.progress);
  assert.equal(session.committed, false);
  await assertSessionArtifactsRemoved(root);
});
