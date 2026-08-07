import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const STAGE_TIMING_VERSION = 1;
export const STAGE_TIMING_FILENAME = '阶段用时.json';
const STAGE_IDS = Object.freeze(['split', 'analysis', 'world-overview', 'asset-visual-specs', 'excel', 'generation']);
const STAGE_ID_SET = new Set(STAGE_IDS);
const MAX_STAGE_ELAPSED_SECONDS = 365 * 24 * 60 * 60;

export class StageTimingServiceError extends Error {
  constructor(code, message, { status = 400, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'StageTimingServiceError';
    this.code = code;
    this.status = status;
  }
}

const fail = (code, message, options) => {
  throw new StageTimingServiceError(code, message, options);
};

const isInside = (root, target, { allowRoot = false } = {}) => {
  const offset = relative(root, target);
  if (!offset) return allowRoot;
  return offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
};

const rootFromResolution = (value) => {
  const candidate = typeof value === 'string' ? value : value?.rootPath;
  if (typeof candidate !== 'string' || !isAbsolute(candidate)) fail('PROJECT_ROOT_UNAVAILABLE', '无法解析项目运行目录', { status: 503 });
  return resolve(candidate);
};

const canonicalProjectRoot = async (candidate) => {
  try {
    const info = await lstat(candidate);
    const canonical = await realpath(candidate);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('PROJECT_ROOT_UNSAFE', '项目运行目录不安全', { status: 409 });
    return canonical;
  } catch (error) {
    if (error instanceof StageTimingServiceError) throw error;
    fail('PROJECT_ROOT_UNAVAILABLE', '项目运行目录不可用', { status: 503, cause: error });
  }
};

const normalizeStages = (value, code = 'INVALID_STAGE_TIMINGS') => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, '阶段用时必须是对象');
  const unknown = Object.keys(value).filter((stageId) => !STAGE_ID_SET.has(stageId));
  if (unknown.length) fail(code, '阶段用时包含未知阶段');
  const stages = {};
  for (const stageId of STAGE_IDS) {
    if (!Object.hasOwn(value, stageId)) continue;
    const seconds = value[stageId];
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_STAGE_ELAPSED_SECONDS) {
      fail(code, `${stageId} 的用时无效`);
    }
    stages[stageId] = seconds;
  }
  return stages;
};

const atomicWriteJson = async (target, value) => {
  const temporary = `${target}.tmp-${randomUUID()}`;
  const backup = `${target}.backup-${randomUUID()}`;
  let hasBackup = false;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    try {
      await rename(target, backup);
      hasBackup = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    try {
      await rename(temporary, target);
    } catch (error) {
      if (hasBackup) {
        await rename(backup, target);
        hasBackup = false;
      }
      throw error;
    }
    if (hasBackup) {
      await rm(backup, { force: true });
      hasBackup = false;
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
    if (hasBackup) await rename(backup, target).catch(() => {});
    await rm(backup, { force: true }).catch(() => {});
  }
};

export function createStageTimingService({ resolveProjectRoot, clock = () => new Date() } = {}) {
  if (typeof resolveProjectRoot !== 'function') throw new TypeError('resolveProjectRoot must be a function');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  const writes = new Map();

  const resolveTarget = async (projectId, { createCache = false } = {}) => {
    const projectRoot = await canonicalProjectRoot(rootFromResolution(await resolveProjectRoot(projectId)));
    const cacheRoot = join(projectRoot, 'cache');
    if (!isInside(projectRoot, cacheRoot)) fail('PROJECT_ROOT_UNSAFE', '项目 Cache 路径不安全', { status: 409 });
    if (createCache) await mkdir(cacheRoot, { recursive: true });
    try {
      const cacheInfo = await lstat(cacheRoot);
      if (!cacheInfo.isDirectory() || cacheInfo.isSymbolicLink()) fail('PROJECT_ROOT_UNSAFE', '项目 Cache 目录不安全', { status: 409 });
      const canonicalCache = await realpath(cacheRoot);
      if (!isInside(projectRoot, canonicalCache)) fail('PROJECT_ROOT_UNSAFE', '项目 Cache 目录越界', { status: 409 });
    } catch (error) {
      if (error?.code === 'ENOENT' && !createCache) return { projectRoot, target: null };
      if (error instanceof StageTimingServiceError) throw error;
      fail('STAGE_TIMING_UNAVAILABLE', '阶段用时目录不可用', { status: 503, cause: error });
    }
    const target = join(cacheRoot, STAGE_TIMING_FILENAME);
    if (!isInside(projectRoot, target)) fail('PROJECT_ROOT_UNSAFE', '阶段用时文件路径不安全', { status: 409 });
    return { projectRoot, target };
  };

  const read = async ({ projectId }) => {
    const { target } = await resolveTarget(projectId);
    if (target === null) return { version: STAGE_TIMING_VERSION, projectId, stages: {} };
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) fail('STAGE_TIMING_INVALID', '阶段用时文件不安全', { status: 409 });
      const value = JSON.parse(await readFile(target, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || value.version !== STAGE_TIMING_VERSION
        || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
        || !Object.hasOwn(value, 'stages')
        || Object.keys(value).some((key) => !['version', 'updatedAt', 'stages'].includes(key))) {
        fail('STAGE_TIMING_INVALID', '阶段用时文件格式无效', { status: 409 });
      }
      return { version: STAGE_TIMING_VERSION, projectId, stages: normalizeStages(value.stages, 'STAGE_TIMING_INVALID') };
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: STAGE_TIMING_VERSION, projectId, stages: {} };
      if (error instanceof StageTimingServiceError) throw error;
      fail('STAGE_TIMING_INVALID', '阶段用时文件无法读取', { status: 409, cause: error });
    }
  };

  const save = ({ projectId, stages }) => {
    const normalized = normalizeStages(stages);
    const prior = writes.get(projectId) ?? Promise.resolve();
    const current = prior.catch(() => {}).then(async () => {
      const { target } = await resolveTarget(projectId, { createCache: true });
      await atomicWriteJson(target, {
        version: STAGE_TIMING_VERSION,
        updatedAt: clock().toISOString(),
        stages: normalized
      });
      return { version: STAGE_TIMING_VERSION, projectId, stages: normalized };
    });
    writes.set(projectId, current);
    return current.finally(() => { if (writes.get(projectId) === current) writes.delete(projectId); });
  };

  return Object.freeze({ read, save });
}
