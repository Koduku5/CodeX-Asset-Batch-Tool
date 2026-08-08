import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBuiltinBatchConfiguration } from '../src/ui/features/prompt-studio/batch-configuration.mjs';

const baseOptions = {
  assets: [{ id: 'character', label: '角色' }],
  enabledSheets: ['角色'],
  generationLimit: '5',
  promptTemplates: {},
  references: [{ referenceId: 'ref-1', sheetName: '角色', styleId: 'anime' }],
  selectedReferenceIdsBySheet: { 角色: ['ref-1'] },
  sheets: ['角色'],
  style: 'anime',
};

test('builtin batch configuration injects validated custom reference fields', async () => {
  const configuration = await buildBuiltinBatchConfiguration({
    ...baseOptions,
    customFieldsBySheet: { 角色: { inputImages: '图像 1：正面参考', primaryRequest: '保持服装一致' } },
    referenceModeBySheet: { 角色: 'custom' },
    resolvePrompt: async () => ({ promptFields: [
      { label: 'Input images', value: '' },
      { label: 'Primary request', value: '' },
    ] }),
  });

  assert.deepEqual(configuration.referenceIdsBySheet, { 角色: ['ref-1'] });
  assert.equal(configuration.promptOverridesBySheet.角色.routeMode, 'reference');
  assert.match(configuration.promptOverridesBySheet.角色.promptText, /Input images: 图像 1：正面参考/u);
  assert.match(configuration.promptOverridesBySheet.角色.promptText, /Primary request: 保持服装一致/u);
});

test('builtin batch configuration rejects weak visual consistency before resolving prompts', async () => {
  let resolveCalls = 0;
  await assert.rejects(() => buildBuiltinBatchConfiguration({
    ...baseOptions,
    customFieldsBySheet: {},
    referenceModeBySheet: { 角色: 'visual-consistency' },
    resolvePrompt: async () => { resolveCalls += 1; return { promptFields: [] }; },
  }), /视觉一致至少需要选择两张参考图/u);
  assert.equal(resolveCalls, 0);
});
