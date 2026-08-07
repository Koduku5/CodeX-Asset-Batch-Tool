import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readLegacyTemplateDrafts,
  readTemplateDraft,
  templateDraftRecords,
  withTemplateDraft,
} from '../src/ui/features/prompt-studio/template-drafts.mjs';
import {
  customTemplateFieldLabelError,
  MAX_CUSTOM_TEMPLATE_FIELDS,
  normalizeTemplateFieldOrder,
  reorderTemplateFields,
  templateFieldReorderIsLocked,
} from '../src/ui/features/prompt-studio/template-field-order.mjs';

test('template drafts migrate valid legacy storage and reject malformed values', () => {
  const valid = { getItem: () => JSON.stringify({ 'anime|prop|none': { promptFields: [] } }) };
  const malformed = { getItem: () => '{not-json' };
  const array = { getItem: () => '[]' };

  assert.deepEqual(readLegacyTemplateDrafts(valid), { 'anime|prop|none': { promptFields: [] } });
  assert.deepEqual(readLegacyTemplateDrafts(malformed), {});
  assert.deepEqual(readLegacyTemplateDrafts(array), {});
  assert.deepEqual(templateDraftRecords(null), {});
});

test('template draft updates are immutable and selected by the complete route key', () => {
  const original = { 'anime|scene|none': { promptFields: [{ label: '旧值', value: '保留' }] } };
  const promptFields = [{ label: '主体', value: '机械道具' }];
  const updated = withTemplateDraft(original, 'cg', 'prop', 'style', promptFields, '2026-08-07T00:00:00.000Z');

  assert.notEqual(updated, original);
  assert.equal(original['cg|prop|style'], undefined);
  assert.deepEqual(readTemplateDraft(updated, 'cg', 'prop', 'style'), {
    promptFields,
    updatedAt: '2026-08-07T00:00:00.000Z',
  });
  assert.equal(readTemplateDraft(updated, 'cg', 'prop', 'none'), null);
  assert.equal(readTemplateDraft({ 'cg|prop|style': { promptFields: 'invalid' } }, 'cg', 'prop', 'style'), null);
});

test('template field order keeps routing fields fixed and preserves valid custom fields', () => {
  const formalFields = [
    { label: 'Use case', value: 'formal use' },
    { label: 'Asset type', value: 'formal type' },
    { label: 'Primary request', value: 'formal request' },
  ];
  const draftFields = [
    { label: 'Camera language', value: 'wide shot' },
    { label: 'Asset type', value: 'prop' },
    { label: 'Use case', value: 'production' },
    { label: 'Primary request', value: 'brass compass' },
    { label: 'camera language', value: 'duplicate' },
    { label: 'Invalid: field', value: 'ignored' },
  ];

  assert.equal(templateFieldReorderIsLocked({ label: ' USE CASE ' }), true);
  assert.equal(templateFieldReorderIsLocked({ label: 'Camera language' }), false);
  assert.deepEqual(normalizeTemplateFieldOrder(formalFields, draftFields), [
    { label: 'Use case', value: 'production' },
    { label: 'Asset type', value: 'prop' },
    { label: 'Camera language', value: 'wide shot' },
    { label: 'Primary request', value: 'brass compass' },
  ]);
});

test('custom template field labels use one bounded validation contract', () => {
  const fields = [{ label: 'Camera language', value: '' }];

  assert.equal(customTemplateFieldLabelError('', fields, 0), '请输入字段名称');
  assert.equal(customTemplateFieldLabelError('x'.repeat(81), fields, 0), '字段名称不能超过 80 个字符');
  assert.equal(customTemplateFieldLabelError('Camera: language', fields, 0), '字段名称不能包含冒号或换行');
  assert.equal(customTemplateFieldLabelError(' camera LANGUAGE ', fields, 0), '字段名称不能与现有字段重复');
  assert.equal(customTemplateFieldLabelError('Lens', fields, MAX_CUSTOM_TEMPLATE_FIELDS), '每套基础提示词最多添加 24 个自定义字段');
  assert.equal(customTemplateFieldLabelError('Lens', fields, 0), '');
});

test('template field reordering cannot move or cross fixed routing fields', () => {
  const fields = [
    { label: 'Use case' },
    { label: 'Asset type' },
    { label: 'Camera' },
    { label: 'Lighting' },
  ];

  assert.equal(reorderTemplateFields(fields, 0, 2), fields);
  assert.equal(reorderTemplateFields(fields, 2, 0), fields);
  assert.equal(reorderTemplateFields(fields, -1, 2), fields);
  assert.deepEqual(reorderTemplateFields(fields, 2, 3), [
    { label: 'Use case' },
    { label: 'Asset type' },
    { label: 'Lighting' },
    { label: 'Camera' },
  ]);
});
