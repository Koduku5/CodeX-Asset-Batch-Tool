import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { isOutside } from './path-safety.mjs';
import { workerError } from './worker-errors.mjs';

const MAX_ANALYSIS_PROGRESS_BYTES = 4 * 1024 * 1024;
const MAX_ASSET_REGISTRY_BYTES = 16 * 1024 * 1024;
const ASSET_REGISTRY_FILES = Object.freeze({
  characters: '角色记录.json', creatures: '生物记录.json', extras: '群演记录.json', scenes: '场景记录.json',
  props: '道具记录.json'
});

export const readAnalysisProgressFile = async (projectRoot) => {
  const target = join(projectRoot, 'cache', '阅读进度.json');
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_ANALYSIS_PROGRESS_BYTES) {
      throw new Error('unsafe analysis progress file');
    }
    const canonical = await realpath(target);
    if (isOutside(projectRoot, canonical)) throw new Error('analysis progress escapes project root');
    const content = await readFile(canonical, 'utf8');
    if (Buffer.byteLength(content, 'utf8') !== info.size) throw new Error('analysis progress changed while reading');
    return JSON.parse(content);
  } catch (error) {
    throw workerError('ANALYSIS_PROGRESS_UNAVAILABLE', '逐集分析进度不可用', error);
  }
};

export const readAssetRegistries = async (projectRoot) => Object.fromEntries(await Promise.all(
  Object.entries(ASSET_REGISTRY_FILES).map(async ([category, filename]) => {
    const target = join(projectRoot, 'cache', '累计记录', filename);
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_ASSET_REGISTRY_BYTES) {
        throw new Error('unsafe asset registry file');
      }
      const canonical = await realpath(target);
      if (isOutside(projectRoot, canonical)) throw new Error('asset registry escapes project root');
      const content = await readFile(canonical, 'utf8');
      if (Buffer.byteLength(content, 'utf8') !== info.size) throw new Error('asset registry changed while reading');
      const records = JSON.parse(content.replace(/^\uFEFF/u, ''));
      if (!Array.isArray(records) || records.some((record) => !record || typeof record !== 'object' || Array.isArray(record))) {
        throw new Error('asset registry must contain record objects');
      }
      return [category, records];
    } catch (error) {
      throw workerError('ANALYSIS_ASSET_REGISTRY_UNAVAILABLE', `累计${filename}不可用`, error);
    }
  })
));

const normalizeEpisodeList = (value, label) => {
  if (!Array.isArray(value) || value.some((episode) => !Number.isInteger(episode) || episode <= 0)) {
    throw workerError('ANALYSIS_PROGRESS_INVALID', `逐集分析进度的 ${label} 无效`);
  }
  if (new Set(value).size !== value.length) {
    throw workerError('ANALYSIS_PROGRESS_INVALID', `逐集分析进度的 ${label} 存在重复集数`);
  }
  return Object.freeze([...value]);
};

export const normalizeAnalysisProgress = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw workerError('ANALYSIS_PROGRESS_INVALID', '逐集分析进度格式无效');
  }
  const discoveredEpisodes = normalizeEpisodeList(value.discoveredEpisodes, 'discoveredEpisodes');
  const completedEpisodes = normalizeEpisodeList(value.completedEpisodes, 'completedEpisodes');
  const discovered = new Set(discoveredEpisodes);
  if (completedEpisodes.some((episode) => !discovered.has(episode))) {
    throw workerError('ANALYSIS_PROGRESS_INVALID', '已完成集不属于当前切分结果');
  }
  const currentEpisode = value.currentEpisode == null ? null : value.currentEpisode;
  if (currentEpisode !== null && (!Number.isInteger(currentEpisode) || !discovered.has(currentEpisode))) {
    throw workerError('ANALYSIS_PROGRESS_INVALID', '当前分析集无效');
  }
  if (currentEpisode !== null && (typeof value.currentSessionToken !== 'string' || !value.currentSessionToken.trim())) {
    throw workerError('ANALYSIS_PROGRESS_INVALID', '当前逐集分析会话缺少持久令牌');
  }
  return Object.freeze({ discoveredEpisodes, completedEpisodes, currentEpisode });
};

export const nextAnalysisEpisode = (progress) => {
  const completed = new Set(progress.completedEpisodes);
  const next = progress.discoveredEpisodes.find((episode) => !completed.has(episode)) ?? null;
  if (progress.currentEpisode !== null && progress.currentEpisode !== next) {
    throw workerError('ANALYSIS_PROGRESS_INVALID', '当前分析集不是首个未完成集');
  }
  return next;
};

export const verifyEpisodeCommit = (before, after, episode) => {
  if (before.discoveredEpisodes.length !== after.discoveredEpisodes.length
    || before.discoveredEpisodes.some((value, index) => value !== after.discoveredEpisodes[index])) {
    throw workerError('ANALYSIS_SOURCE_CHANGED', '剧本切分结果在单集分析期间发生变化');
  }
  const beforeCompleted = new Set(before.completedEpisodes);
  if (before.completedEpisodes.some((value) => !after.completedEpisodes.includes(value))) {
    throw workerError('ANALYSIS_PROGRESS_INVALID', '单集分析完成后已有进度发生回退');
  }
  const newlyCompleted = after.completedEpisodes.filter((value) => !beforeCompleted.has(value));
  if (newlyCompleted.length !== 1 || newlyCompleted[0] !== episode || after.currentEpisode !== null) {
    throw workerError('ANALYSIS_EPISODE_NOT_COMMITTED', `第 ${episode} 集未完成原子累计与完成标记`);
  }
};
