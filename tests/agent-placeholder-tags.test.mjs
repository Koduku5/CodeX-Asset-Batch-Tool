import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentRequirementIsValid,
  applyAgentRequirements,
  extractAgentPlaceholders,
  makeCanonicalAgentPlaceholder,
  removeAgentPlaceholders
} from '../src/ui/features/prompt-studio/agent-placeholder-tags.mjs';

test('AI decision tags write the canonical placeholder without making users type syntax', () => {
  assert.equal(
    makeCanonicalAgentPlaceholder('判断室内、室外或地标场景'),
    '【由agent 具体判断说明：判断室内、室外或地标场景】'
  );
  assert.equal(agentRequirementIsValid('单行需求'), true);
  assert.equal(agentRequirementIsValid(''), false);
  assert.equal(agentRequirementIsValid('包含【括号】'), false);
  assert.equal(agentRequirementIsValid('第一行\n第二行'), false);
});

test('existing legacy and canonical placeholders can be edited without losing fixed text', () => {
  const original = '固定前文；【由 Agent 分析参考图共同风格】；固定后文';
  const placeholders = extractAgentPlaceholders(original);
  assert.equal(placeholders.length, 1);
  assert.equal(placeholders[0].requirement, '分析参考图共同风格');

  const updated = applyAgentRequirements(original, placeholders, ['只迁移参考图共同风格']);
  assert.equal(
    updated,
    '固定前文；【由agent 具体判断说明：只迁移参考图共同风格】；固定后文'
  );
  assert.equal(
    removeAgentPlaceholders(updated, extractAgentPlaceholders(updated)),
    '固定前文；；固定后文'
  );
});

test('enabling an untagged field replaces it with one canonical decision requirement', () => {
  assert.equal(
    applyAgentRequirements('原固定字段', [], ['根据制作说明选择道具子类型']),
    '【由agent 具体判断说明：根据制作说明选择道具子类型】'
  );
});

test('UI parsing rejects carriage-return and line-feed placeholders like runtime parsing', () => {
  assert.deepEqual(
    extractAgentPlaceholders('【由agent 具体判断说明：第一段\r第二段】'),
    []
  );
  assert.deepEqual(
    extractAgentPlaceholders('【由 Agent 第一段\n第二段】'),
    []
  );
});

test('legacy lookalikes without the required separator are not AI permissions', () => {
  assert.deepEqual(extractAgentPlaceholders('【由 Agents 提供】'), []);
  assert.deepEqual(extractAgentPlaceholders('【由 AgentSmith 提供】'), []);
});

test('multiple placeholders keep their source order when edited or removed', () => {
  const original = '前【由 Agent 判断光线】中【由agent 具体判断说明：判断材质】后';
  const placeholders = extractAgentPlaceholders(original);
  assert.deepEqual(
    placeholders.map(({ requirement }) => requirement),
    ['判断光线', '判断材质']
  );
  assert.equal(
    applyAgentRequirements(original, placeholders, ['改判光线', '改判材质']),
    '前【由agent 具体判断说明：改判光线】中【由agent 具体判断说明：改判材质】后'
  );
  assert.equal(removeAgentPlaceholders(original, placeholders), '前中后');
});
