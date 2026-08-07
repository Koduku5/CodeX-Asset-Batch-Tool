import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
  assert.doesNotMatch(episodeAnalysis, /build_workbook|image_gen|asset-type-rules/u);
  assert.match(imagegen, /Codex SDK、Codex CLI、Node sidecar 和 \.NET Bridge 都不得代替/u);
  assert.equal((await stat(path.join(root, 'engine', 'scripts'))).isDirectory(), true);
  assert.equal((await stat(path.join(root, 'engine', 'assets'))).isDirectory(), true);
  assert.match(pipeline, /\.\.\/\.\.\/engine\/references/u);
});
