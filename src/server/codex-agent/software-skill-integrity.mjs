import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { workerError } from './worker-errors.mjs';

const MAX_PIPELINE_SKILL_BYTES = 1024 * 1024;
const MAX_EPISODE_ASSET_SKILL_BYTES = 256 * 1024;

export const SOFTWARE_PIPELINE_SKILL_PATH = fileURLToPath(
  new URL('../../../skills/ka-script-pipeline/SKILL.md', import.meta.url)
);
export const SOFTWARE_EPISODE_ASSET_SKILL_PATH = fileURLToPath(
  new URL('../../../skills/ka-episode-asset-analysis/SKILL.md', import.meta.url)
);

const isOutside = (root, candidate) => {
  const value = relative(root, candidate);
  return value === '..' || value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(value);
};

export const inspectSoftwarePipelineSkill = async (pipelineSkillPathInput) => {
  if (typeof pipelineSkillPathInput !== 'string' || !isAbsolute(pipelineSkillPathInput)) {
    throw workerError('SKILL_UNAVAILABLE', '软件级 ka-script-pipeline 执行规范路径无效');
  }
  const configuredPath = resolve(pipelineSkillPathInput);
  const configuredRoot = resolve(configuredPath, '..');
  const configuredSkillsRoot = resolve(configuredRoot, '..');
  const configuredEpisodeAssetRoot = join(configuredSkillsRoot, 'ka-episode-asset-analysis');
  const configuredEpisodeAssetSkillPath = join(configuredEpisodeAssetRoot, 'SKILL.md');
  if (basename(configuredPath).toLowerCase() !== 'skill.md'
    || basename(configuredRoot).toLowerCase() !== 'ka-script-pipeline') {
    throw workerError('SKILL_UNAVAILABLE', '软件级 ka-script-pipeline 执行规范路径无效');
  }
  try {
    const [rootInfo, skillInfo, episodeAssetRootInfo, episodeAssetSkillInfo] = await Promise.all([
      lstat(configuredRoot),
      lstat(configuredPath),
      lstat(configuredEpisodeAssetRoot),
      lstat(configuredEpisodeAssetSkillPath)
    ]);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('unsafe skill directory');
    if (!skillInfo.isFile() || skillInfo.isSymbolicLink()) throw new Error('unsafe skill file');
    if (!episodeAssetRootInfo.isDirectory() || episodeAssetRootInfo.isSymbolicLink()) {
      throw new Error('unsafe episode asset skill directory');
    }
    if (!episodeAssetSkillInfo.isFile() || episodeAssetSkillInfo.isSymbolicLink()) {
      throw new Error('unsafe episode asset skill file');
    }
    if (skillInfo.size <= 0 || skillInfo.size > MAX_PIPELINE_SKILL_BYTES) throw new Error('invalid skill size');
    if (episodeAssetSkillInfo.size <= 0 || episodeAssetSkillInfo.size > MAX_EPISODE_ASSET_SKILL_BYTES) {
      throw new Error('invalid episode asset skill size');
    }
    const [canonicalSkillsRoot, canonicalRoot, canonicalPath, canonicalEpisodeAssetRoot, canonicalEpisodeAssetSkillPath] = await Promise.all([
      realpath(configuredSkillsRoot),
      realpath(configuredRoot),
      realpath(configuredPath),
      realpath(configuredEpisodeAssetRoot),
      realpath(configuredEpisodeAssetSkillPath)
    ]);
    if (isOutside(canonicalSkillsRoot, canonicalRoot) || isOutside(canonicalSkillsRoot, canonicalEpisodeAssetRoot)) {
      throw new Error('software skill escapes skills directory');
    }
    if (isOutside(canonicalRoot, canonicalPath)) throw new Error('skill file escapes software skill directory');
    if (isOutside(canonicalEpisodeAssetRoot, canonicalEpisodeAssetSkillPath)) {
      throw new Error('episode asset skill file escapes software skill directory');
    }
    const [content, episodeAssetSkillContent] = await Promise.all([
      readFile(canonicalPath),
      readFile(canonicalEpisodeAssetSkillPath)
    ]);
    if (content.length !== skillInfo.size || episodeAssetSkillContent.length !== episodeAssetSkillInfo.size) {
      throw new Error('skill changed while being inspected');
    }
    const sha256 = createHash('sha256')
      .update('ka-script-pipeline/SKILL.md\0').update(content)
      .update('\0ka-episode-asset-analysis/SKILL.md\0').update(episodeAssetSkillContent)
      .digest('hex');
    return Object.freeze({
      id: 'ka-script-pipeline',
      configuredPath,
      root: canonicalRoot,
      path: canonicalPath,
      episodeAssetSkillRoot: canonicalEpisodeAssetRoot,
      episodeAssetSkillPath: canonicalEpisodeAssetSkillPath,
      fileIdentity: `${skillInfo.dev}:${skillInfo.ino}|${episodeAssetSkillInfo.dev}:${episodeAssetSkillInfo.ino}`,
      sha256,
    });
  } catch (error) {
    throw workerError('SKILL_UNAVAILABLE', '软件级 ka-script-pipeline 执行规范不可用', error);
  }
};

export const verifySoftwarePipelineSkill = async (snapshot) => {
  const current = await inspectSoftwarePipelineSkill(snapshot.configuredPath);
  if (current.fileIdentity !== snapshot.fileIdentity || current.sha256 !== snapshot.sha256) {
    throw workerError('SKILL_CHANGED', '软件级 ka-script-pipeline 执行规范在任务期间发生变化');
  }
};

export const publicSkillReceipt = (snapshot) => Object.freeze({
  id: snapshot.id,
  sha256: snapshot.sha256
});
