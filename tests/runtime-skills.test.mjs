import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { visualSpecPrompt } from '../src/server/codex-agent/complete-asset-visual-specs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillRoot = path.join(root, 'skills');

test('software-level skills are separate, fingerprinted and keep ImageGen out of the SDK skill', async () => {
  const registry = JSON.parse(await readFile(path.join(skillRoot, 'registry.json'), 'utf8'));
  assert.equal(registry.version, 1);
  assert.deepEqual(Object.keys(registry.skills).sort(), [
    'ka-builtin-imagegen',
    'ka-episode-asset-analysis',
    'ka-script-pipeline'
  ]);
  for (const [name, record] of Object.entries(registry.skills)) {
    const entry = path.resolve(skillRoot, record.entry);
    assert.equal(entry.startsWith(`${skillRoot}${path.sep}`), true);
    const bytes = await readFile(entry);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256);
    assert.match(bytes.toString('utf8'), new RegExp(`name: ${name}`, 'u'));
  }
  const pipeline = await readFile(path.join(skillRoot, 'ka-script-pipeline', 'SKILL.md'), 'utf8');
  const episodeAnalysis = await readFile(
    path.join(skillRoot, 'ka-episode-asset-analysis', 'SKILL.md'),
    'utf8'
  );
  const imagegen = await readFile(path.join(skillRoot, 'ka-builtin-imagegen', 'SKILL.md'), 'utf8');
  assert.match(pipeline, /禁止领取内置出图任务/u);
  assert.match(pipeline, /ka-episode-asset-analysis/u);
  assert.doesNotMatch(pipeline, /asset-type-rules\.md|prompt-writing\.md/u);
  assert.match(episodeAnalysis, /name: ka-episode-asset-analysis/u);
  assert.match(episodeAnalysis, /本契约只用于一集剧本的语义分析/u);
  assert.match(episodeAnalysis, /characters.*creatures.*extras.*scenes.*props/su);
  assert.match(episodeAnalysis, /重要配角.*换一张脸.*characters/u);
  assert.match(episodeAnalysis, /前台、服务员、保安甲乙、学生甲乙、工作人员.*extras/u);
  assert.match(episodeAnalysis, /只有纯背景、无法辨识且不需要控制外观的人员才排除/u);
  assert.doesNotMatch(episodeAnalysis, /build_workbook|image_gen|asset-type-rules/u);
  assert.match(imagegen, /Codex SDK、Codex CLI、Node sidecar 和 \.NET Bridge 都不得代替/u);
  assert.match(imagegen, /promptSpec\.agentPlaceholderContract/u);
  assert.match(imagegen, /即使为空也不得补写、润色或重算/u);
  assert.equal((await stat(path.join(root, 'engine', 'scripts'))).isDirectory(), true);
  assert.equal((await stat(path.join(root, 'engine', 'assets'))).isDirectory(), true);
  assert.match(pipeline, /\]\(references\/worldbuilding-analysis\.md\)/u);
  assert.match(imagegen, /\]\(references\/asset-type-rules\.md\)/u);
  assert.doesNotMatch(`${pipeline}\n${imagegen}`, /engine\/references/u);
});

test('ordinary single NPCs use extras without being forced into a group-only visual spec', async () => {
  const prompt = visualSpecPrompt({
    requestToken: 'npc-rule-test',
    worldOverview: { content: '现代城市' },
    asset: { assetId: 'CROWD-001-EP1', category: 'extras', assetName: '酒店前台' }
  });
  assert.match(prompt, /普通单人 NPC.*岗位、功能和场合/u);
  assert.match(prompt, /不把普通面孔固化成专属身份/u);

  const crowdFragment = await readFile(path.join(
    root, 'engine', 'assets', '图片生成', 'prompts', 'fragments', 'asset-types', 'crowd.json'
  ), 'utf8');
  assert.match(crowdFragment, /可替换背景人物或群体视觉体系/u);
  assert.match(crowdFragment, /普通单人 NPC.*不固定专属面孔/u);
});
