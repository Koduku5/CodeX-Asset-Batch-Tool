import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readLegacyTemplateDrafts,
  readTemplateDraft,
  templateDraftRecords,
  withTemplateDraft,
} from '../src/ui/features/prompt-studio/template-drafts.mjs';

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
