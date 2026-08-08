import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import {
  PipelineTaskRunnerError,
  escapesRoot
} from './contracts.mjs';


const MAX_ANALYSIS_RESUME_STATE_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_GATE_BYTES = 16 * 1024 * 1024;
const ANALYSIS_RESUME_ACTIONS = new Set([
  'analyze-screenplay',
  'build-scoped-workbook',
  'run-full-pipeline'
]);

const unresolvedPendingAssetCount = async (projectRoot) => {
  const target = join(projectRoot, 'cache', '待确认记录.json');
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_PENDING_GATE_BYTES) {
    throw new PipelineTaskRunnerError('PENDING_STATE_UNSAFE', '待确认记录不是安全的项目 JSON 文件', { status: 409 });
  }
  let records;
  try {
    records = JSON.parse(await readFile(target, 'utf8'));
  } catch {
    throw new PipelineTaskRunnerError('PENDING_STATE_INVALID', '待确认记录不是有效 JSON', { status: 409 });
  }
  if (!Array.isArray(records)) {
    throw new PipelineTaskRunnerError('PENDING_STATE_INVALID', '待确认记录顶层必须是数组', { status: 409 });
  }
  return records.filter((item) => item && typeof item === 'object' && !Array.isArray(item)
    && (String(item.status ?? '').trim() === 'pending'
      || (item.draftAsset && typeof item.draftAsset === 'object' && !String(item.appliedAt ?? '').trim()))).length;
};

const rootPathFromResolution = (value) => {
  const candidate = typeof value === 'string'
    ? value
    : value && typeof value === 'object'
      ? value.rootPath
      : null;
  if (typeof candidate !== 'string' || !isAbsolute(candidate)) {
    throw new PipelineTaskRunnerError('PROJECT_ROOT_UNAVAILABLE', '无法解析项目运行目录', { status: 503 });
  }
  return resolve(candidate);
};

const canonicalProjectRoot = async (candidate) => {
  let info;
  let canonical;
  try {
    info = await lstat(candidate);
    canonical = await realpath(candidate);
  } catch {
    throw new PipelineTaskRunnerError('PROJECT_ROOT_UNAVAILABLE', '项目运行目录不可用', { status: 503 });
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new PipelineTaskRunnerError('PROJECT_ROOT_UNSAFE', '项目运行目录不安全', { status: 409 });
  }
  return canonical;
};

const readDirectJsonState = async (projectRoot, filename) => {
  try {
    const target = join(projectRoot, 'cache', filename);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()
      || info.size <= 0 || info.size > MAX_ANALYSIS_RESUME_STATE_BYTES) return null;
    const canonical = await realpath(target);
    if (escapesRoot(relative(projectRoot, canonical))) return null;
    const content = await readFile(canonical, 'utf8');
    if (Buffer.byteLength(content, 'utf8') !== info.size) return null;
    const value = JSON.parse(content);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};

const resumableAnalysisEpisode = async (projectRoot) => {
  const [progress, lock] = await Promise.all([
    readDirectJsonState(projectRoot, '阅读进度.json'),
    readDirectJsonState(projectRoot, '.pipeline.lock')
  ]);
  const episode = progress?.currentEpisode;
  const token = progress?.currentSessionToken;
  const discovered = progress?.discoveredEpisodes;
  const completed = progress?.completedEpisodes;
  const validEpisodeLists = Array.isArray(discovered)
    && Array.isArray(completed)
    && discovered.length === new Set(discovered).size
    && completed.length === new Set(completed).size
    && discovered.every((value) => Number.isInteger(value) && value > 0)
    && completed.every((value) => discovered.includes(value));
  const firstIncompleteEpisode = validEpisodeLists
    ? discovered.find((value) => !completed.includes(value))
    : null;
  const exactToken = lock?.token === token;
  const resumedTokenHash = typeof token === 'string' && token.trim()
    ? createHash('sha256').update(token).digest('hex')
    : null;
  const interruptedRotation = typeof lock?.resumedFromTokenHash === 'string'
    && lock.resumedFromTokenHash === resumedTokenHash;
  return progress?.status === 'in_progress'
    && Number.isInteger(episode) && episode > 0
    && typeof token === 'string' && token.trim()
    && validEpisodeLists
    && firstIncompleteEpisode === episode
    && lock?.kind === 'analysis_episode'
    && lock?.key === `episode:${episode}`
    && lock?.protocolVersion === 2
    && lock?.leaseMode === 'durable'
    && (exactToken || interruptedRotation)
    ? episode
    : null;
};

const normalizePipelineSkillPath = (value) => {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new TypeError('pipelineSkillPath must be an absolute path');
  }
  const normalized = resolve(value);
  if (basename(normalized).toLowerCase() !== 'skill.md'
    || basename(resolve(normalized, '..')).toLowerCase() !== 'ka-script-pipeline') {
    throw new TypeError('pipelineSkillPath must identify ka-script-pipeline/SKILL.md');
  }
  return normalized;
};

const canonicalPipelineSkillPath = async (candidate, projectRoot) => {
  const parent = resolve(candidate, '..');
  try {
    const [parentInfo, fileInfo] = await Promise.all([lstat(parent), lstat(candidate)]);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()
      || !fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size <= 0) {
      throw new Error('pipeline skill is not an ordinary file');
    }
    const [canonicalParent, canonicalFile] = await Promise.all([realpath(parent), realpath(candidate)]);
    if (escapesRoot(relative(canonicalParent, canonicalFile))) {
      throw new Error('pipeline skill escapes its software directory');
    }
    const skillContainsProject = !escapesRoot(relative(canonicalParent, projectRoot));
    const projectContainsSkill = !escapesRoot(relative(projectRoot, canonicalFile));
    if (skillContainsProject || projectContainsSkill) {
      throw new PipelineTaskRunnerError(
        'PIPELINE_SKILL_UNSAFE',
        '软件级执行规范不能与项目根重叠',
        { status: 409 }
      );
    }
    return canonicalFile;
  } catch (error) {
    if (error instanceof PipelineTaskRunnerError) throw error;
    throw new PipelineTaskRunnerError(
      'PIPELINE_SKILL_UNAVAILABLE',
      '软件级 ka-script-pipeline 执行规范不可用',
      { status: 503 }
    );
  }
};

const resolveRuntimeFile = async (projectRoot, segments) => {
  const target = resolve(projectRoot, ...segments);
  if (escapesRoot(relative(projectRoot, target))) {
    throw new PipelineTaskRunnerError('RUNTIME_FILE_UNSAFE', '项目运行文件不安全', { status: 409 });
  }
  let cursor = projectRoot;
  try {
    for (const segment of segments) {
      cursor = resolve(cursor, segment);
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        throw new PipelineTaskRunnerError('RUNTIME_FILE_UNSAFE', '项目运行文件不安全', { status: 409 });
      }
    }
    const targetInfo = await lstat(target);
    if (!targetInfo.isFile()) throw new Error('Runtime target is not a file');
    const canonicalTarget = await realpath(target);
    if (escapesRoot(relative(projectRoot, canonicalTarget))) {
      throw new PipelineTaskRunnerError('RUNTIME_FILE_UNSAFE', '项目运行文件不安全', { status: 409 });
    }
    return canonicalTarget;
  } catch (error) {
    if (error instanceof PipelineTaskRunnerError) throw error;
    throw new PipelineTaskRunnerError('RUNTIME_FILE_MISSING', '项目运行文件缺失', { status: 503 });
  }
};


export {
  ANALYSIS_RESUME_ACTIONS,
  canonicalPipelineSkillPath,
  canonicalProjectRoot,
  normalizePipelineSkillPath,
  resumableAnalysisEpisode,
  resolveRuntimeFile,
  rootPathFromResolution,
  unresolvedPendingAssetCount
};

