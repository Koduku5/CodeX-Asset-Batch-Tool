import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROJECT_ID_PATTERN } from './project-root-index.mjs';
import {
  MAX_LOCK_BYTES,
  MAX_SKILL_BYTES,
  MAX_STATE_BYTES,
  CodexImagegenHandoffError,
  activeBackendFrom,
  activeReason,
  batchMatchesPreset,
  emptyCounts,
  fail,
  isObject,
  makeHandoffText,
  publicSummary,
  quotaSummary,
  validateBatchShape,
  validateLock,
  validatePresetShape,
  validateProgress,
  validateQueue
} from './codex-imagegen-handoff/contracts.mjs';

export {
  CODEX_IMAGEGEN_HANDOFF_SUMMARY_VERSION,
  CodexImagegenHandoffError
} from './codex-imagegen-handoff/contracts.mjs';

const DEFAULT_SOFTWARE_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

const pathNameEquals = (left, right) => process.platform === 'win32'
  ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
  : left === right;

const isDirectChild = (parent, target, expectedName) => {
  const child = relative(parent, target);
  return Boolean(child)
    && !child.startsWith('..')
    && !isAbsolute(child)
    && !child.includes('/')
    && !child.includes('\\')
    && pathNameEquals(child, expectedName);
};

const sameIdentity = (left, right) => left.dev === right.dev
  && left.ino === right.ino
  && left.birthtimeMs === right.birthtimeMs;

const sameSnapshot = (left, right) => sameIdentity(left, right)
  && left.size === right.size
  && left.mtimeMs === right.mtimeMs;

const isWithin = (root, target) => {
  const offset = relative(root, target);
  return Boolean(offset) && offset !== '..' && !offset.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(offset);
};

const skillFingerprint = (contents) => createHash('sha256').update(contents).digest('hex');

const captureBuiltinSkillSnapshot = ({ builtinImagegenSkillPath, softwareRoot }) => {
  if (
    typeof builtinImagegenSkillPath !== 'string'
    || !isAbsolute(builtinImagegenSkillPath)
    || typeof softwareRoot !== 'string'
    || !isAbsolute(softwareRoot)
  ) {
    fail('BUILTIN_SKILL_PATH_INVALID', '内置 ImageGen 通用 Skill 路径配置无效', { status: 500 });
  }
  const configuredRoot = resolve(softwareRoot);
  const configuredSkill = resolve(builtinImagegenSkillPath);
  if (!isWithin(configuredRoot, configuredSkill) || basename(configuredSkill) !== 'SKILL.md') {
    fail('BUILTIN_SKILL_UNTRUSTED', '内置 ImageGen 通用 Skill 不在受信任的软件目录内', { status: 500 });
  }
  try {
    const rootBefore = lstatSync(configuredRoot);
    if (rootBefore.isSymbolicLink() || !rootBefore.isDirectory()) {
      fail('BUILTIN_SKILL_UNTRUSTED', '软件目录不安全', { status: 500 });
    }
    const canonicalRoot = realpathSync(configuredRoot);
    const before = lstatSync(configuredSkill);
    if (before.isSymbolicLink() || !before.isFile() || before.size < 1 || before.size > MAX_SKILL_BYTES) {
      fail('BUILTIN_SKILL_UNTRUSTED', '内置 ImageGen 通用 Skill 不是安全的普通文件', { status: 500 });
    }
    const canonicalSkill = realpathSync(configuredSkill);
    if (!isWithin(canonicalRoot, canonicalSkill)) {
      fail('BUILTIN_SKILL_UNTRUSTED', '内置 ImageGen 通用 Skill 越出软件目录', { status: 500 });
    }
    const contents = readFileSync(configuredSkill);
    const after = lstatSync(configuredSkill);
    const verifiedRoot = lstatSync(configuredRoot);
    const verifiedCanonicalRoot = realpathSync(configuredRoot);
    const verifiedCanonicalSkill = realpathSync(configuredSkill);
    if (
      after.isSymbolicLink()
      || !after.isFile()
      || !sameSnapshot(before, after)
      || !sameIdentity(rootBefore, verifiedRoot)
      || !isWithin(verifiedCanonicalRoot, verifiedCanonicalSkill)
    ) {
      fail('BUILTIN_SKILL_CHANGED', '内置 ImageGen 通用 Skill 在检查期间发生变化', { status: 409 });
    }
    return Object.freeze({
      path: configuredSkill,
      softwareRoot: configuredRoot,
      softwareIdentity: rootBefore,
      info: after,
      fingerprint: skillFingerprint(contents)
    });
  } catch (error) {
    if (error instanceof CodexImagegenHandoffError) throw error;
    fail('BUILTIN_SKILL_UNAVAILABLE', '内置 ImageGen 通用 Skill 不可读取', { status: 503, cause: error });
  }
};

const verifyBuiltinSkillSnapshot = async (snapshot) => {
  try {
    const rootBefore = await lstat(snapshot.softwareRoot);
    const canonicalRoot = await realpath(snapshot.softwareRoot);
    const before = await lstat(snapshot.path);
    if (
      rootBefore.isSymbolicLink()
      || !rootBefore.isDirectory()
      || !sameIdentity(snapshot.softwareIdentity, rootBefore)
      || before.isSymbolicLink()
      || !before.isFile()
      || before.size < 1
      || before.size > MAX_SKILL_BYTES
      || !sameSnapshot(snapshot.info, before)
    ) {
      fail('BUILTIN_SKILL_CHANGED', '内置 ImageGen 通用 Skill 已发生变化，请重启软件', { status: 409 });
    }
    const canonicalSkill = await realpath(snapshot.path);
    if (!isWithin(canonicalRoot, canonicalSkill)) {
      fail('BUILTIN_SKILL_CHANGED', '内置 ImageGen 通用 Skill 已发生变化，请重启软件', { status: 409 });
    }
    const contents = await readFile(snapshot.path);
    const after = await lstat(snapshot.path);
    if (!sameSnapshot(before, after) || skillFingerprint(contents) !== snapshot.fingerprint) {
      fail('BUILTIN_SKILL_CHANGED', '内置 ImageGen 通用 Skill 已发生变化，请重启软件', { status: 409 });
    }
    return snapshot;
  } catch (error) {
    if (error instanceof CodexImagegenHandoffError) throw error;
    fail('BUILTIN_SKILL_UNAVAILABLE', '内置 ImageGen 通用 Skill 不可读取', { status: 503, cause: error });
  }
};

const missing = (error) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';

const inspectDirectory = async (parent, expectedName, { required = true } = {}) => {
  const candidate = resolve(parent, expectedName);
  let found = false;
  try {
    const info = await lstat(candidate);
    found = true;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      fail('STATE_PATH_UNSAFE', '项目状态目录不安全', { status: 403 });
    }
    const canonical = await realpath(candidate);
    if (!isDirectChild(parent, canonical, expectedName)) {
      fail('STATE_PATH_UNSAFE', '项目状态目录不安全', { status: 403 });
    }
    return Object.freeze({ path: canonical, identity: info });
  } catch (error) {
    if (!required && !found && missing(error)) return null;
    if (error instanceof CodexImagegenHandoffError) throw error;
    fail('STATE_UNAVAILABLE', '项目状态目录不可读取', { status: 503, cause: error });
  }
};

const inspectDirectFile = async (parent, expectedName, {
  required = true,
  maxBytes = MAX_STATE_BYTES,
  read = true
} = {}) => {
  const candidate = resolve(parent, expectedName);
  let found = false;
  try {
    const before = await lstat(candidate);
    found = true;
    if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes) {
      fail('STATE_FILE_UNSAFE', '项目状态文件不安全或超过读取上限', { status: 403 });
    }
    const canonical = await realpath(candidate);
    if (!isDirectChild(parent, canonical, expectedName)) {
      fail('STATE_FILE_UNSAFE', '项目状态文件越出项目边界', { status: 403 });
    }
    const contents = read ? await readFile(candidate, 'utf8') : null;
    const after = await lstat(candidate);
    const verifiedCanonical = await realpath(candidate);
    if (
      after.isSymbolicLink()
      || !after.isFile()
      || !sameSnapshot(before, after)
      || !isDirectChild(parent, verifiedCanonical, expectedName)
      || !pathNameEquals(canonical, verifiedCanonical)
    ) {
      fail('STATE_CHANGED_DURING_READ', '项目状态在检查期间发生变化，请重试', { status: 409 });
    }
    return Object.freeze({ contents, info: after });
  } catch (error) {
    if (!required && !found && missing(error)) return null;
    if (error instanceof CodexImagegenHandoffError) throw error;
    fail('STATE_UNAVAILABLE', '项目状态文件不可读取', { status: 503, cause: error });
  }
};

const verifyDirectFileSnapshot = async (parent, expectedName, snapshot, options = {}) => {
  const current = await inspectDirectFile(parent, expectedName, { ...options, required: true, read: false });
  if (!sameSnapshot(snapshot.info, current.info)) {
    fail('STATE_CHANGED_DURING_READ', '项目状态在检查期间发生变化，请重试', { status: 409 });
  }
};

const parseJsonFile = (file, label) => {
  try {
    const parsed = JSON.parse(file.contents);
    if (!isObject(parsed)) fail('STATE_INVALID', `${label}结构无效`);
    return parsed;
  } catch (error) {
    if (error instanceof CodexImagegenHandoffError) throw error;
    fail('STATE_INVALID', `${label}无法安全解析`, { cause: error });
  }
};

const validateProjectRoot = async (projectId, resolveProjectRoot) => {
  if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) {
    fail('INVALID_PROJECT_ID', 'projectId 无效', { status: 400 });
  }
  let resolution;
  try {
    resolution = await resolveProjectRoot(projectId);
  } catch (error) {
    fail('PROJECT_ROOT_UNAVAILABLE', '项目根不可用', { status: 404, cause: error });
  }
  if (
    resolution?.metadata?.projectId !== undefined
    && resolution.metadata.projectId !== projectId
  ) {
    fail('PROJECT_ROOT_UNSAFE', '项目根与 projectId 不一致', { status: 403 });
  }
  if (
    resolution?.metadata?.storageMode !== undefined
    && resolution.metadata.storageMode !== 'isolated-project'
  ) {
    fail('PROJECT_NOT_ISOLATED', '内置出图交接只接受隔离项目', { status: 403 });
  }
  const candidate = typeof resolution === 'string' ? resolution : resolution?.rootPath;
  if (typeof candidate !== 'string' || !isAbsolute(candidate)) {
    fail('PROJECT_ROOT_UNAVAILABLE', '项目根不可用', { status: 503 });
  }
  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      fail('PROJECT_ROOT_UNSAFE', '项目根不安全', { status: 403 });
    }
    const canonical = await realpath(candidate);
    return Object.freeze({ path: canonical, identity: info });
  } catch (error) {
    if (error instanceof CodexImagegenHandoffError) throw error;
    fail('PROJECT_ROOT_UNAVAILABLE', '项目根不可读取', { status: 503, cause: error });
  }
};

const verifyDirectoryIdentity = async ({ path, identity }, code, message) => {
  try {
    const current = await lstat(path);
    const canonical = await realpath(path);
    if (current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(identity, current) || !pathNameEquals(path, canonical)) {
      fail(code, message, { status: 409 });
    }
  } catch (error) {
    if (error instanceof CodexImagegenHandoffError) throw error;
    fail(code, message, { status: 409, cause: error });
  }
};

export function createCodexImagegenHandoffService({
  resolveProjectRoot,
  builtinImagegenSkillPath,
  softwareRoot = DEFAULT_SOFTWARE_ROOT
} = {}) {
  if (typeof resolveProjectRoot !== 'function') throw new TypeError('resolveProjectRoot must be a function');
  const builtinSkill = captureBuiltinSkillSnapshot({ builtinImagegenSkillPath, softwareRoot });

  const inspect = async ({ projectId } = {}) => {
    await verifyBuiltinSkillSnapshot(builtinSkill);
    const project = await validateProjectRoot(projectId, resolveProjectRoot);
    const cache = await inspectDirectory(project.path, 'cache', { required: false });
    if (!cache) {
      return {
        project,
        summary: publicSummary({ projectId, status: 'blocked', reasonCode: 'CACHE_NOT_READY' })
      };
    }

    const [queueFile, presetFile, progressFile, lockFile, operationLockFile, transactionFile] = await Promise.all([
      inspectDirectFile(cache.path, '出图队列.json', { required: false }),
      inspectDirectFile(cache.path, '内置提示词预设.json', { required: false }),
      inspectDirectFile(cache.path, '出图进度.json', { required: false }),
      inspectDirectFile(cache.path, '.pipeline.lock', { required: false, maxBytes: MAX_LOCK_BYTES }),
      inspectDirectFile(cache.path, '.pipeline.operation.lock', { required: false, maxBytes: MAX_LOCK_BYTES }),
      inspectDirectFile(cache.path, '.pipeline.transaction.json', { required: false, maxBytes: MAX_STATE_BYTES, read: false })
    ]);

    const mainLock = lockFile ? validateLock(parseJsonFile(lockFile, '流水线锁')) : null;
    const operationLock = operationLockFile
      ? validateLock(parseJsonFile(operationLockFile, '流水线操作锁'))
      : null;
    const locks = [mainLock, operationLock].filter(Boolean);

    if (!queueFile) {
      const backend = locks.length ? activeBackendFrom(new Set(), locks) : null;
      const summary = publicSummary({
        projectId,
        status: locks.length ? 'active' : 'blocked',
        reasonCode: locks.length ? activeReason(backend) : 'QUEUE_NOT_BUILT',
        activeBackend: backend
      });
      return { project, summary };
    }

    const queue = parseJsonFile(queueFile, '出图队列');
    const queueInfo = validateQueue(queue);
    for (const lock of locks) validateLock(lock, queueInfo);

    let counts = emptyCounts();
    counts.total = queue.items.length;
    let progress = null;
    let progressInfo = null;
    if (progressFile) {
      progress = parseJsonFile(progressFile, '出图进度');
      progressInfo = validateProgress(progress, queue, queueInfo);
      counts = progressInfo.counts;
    }

    const base = {
      projectId,
      queueEstablished: true,
      counts,
      activeBackend: null
    };

    if (transactionFile) {
      return { project, summary: publicSummary({ ...base, status: 'blocked', reasonCode: 'RECOVERY_REQUIRED' }) };
    }
    if (queueInfo.operation !== 'generate') {
      return { project, summary: publicSummary({ ...base, status: 'blocked', reasonCode: 'QUEUE_MODE_UNSUPPORTED' }) };
    }
    if (queue.items.length === 0) {
      return { project, summary: publicSummary({ ...base, status: 'blocked', reasonCode: 'QUEUE_EMPTY' }) };
    }
    if (!presetFile) {
      return { project, summary: publicSummary({ ...base, status: 'blocked', reasonCode: 'PRESET_NOT_CONFIGURED' }) };
    }
    const preset = validatePresetShape(parseJsonFile(presetFile, '内置提示词预设'));
    if (!queue.builtinPromptBatch) {
      return { project, summary: publicSummary({ ...base, status: 'blocked', reasonCode: 'BATCH_NOT_ATTACHED' }) };
    }
    const batch = validateBatchShape(queue.builtinPromptBatch);
    const presetMatches = batchMatchesPreset(batch, preset);
    if (!presetMatches) {
      return { project, summary: publicSummary({ ...base, status: 'blocked', reasonCode: 'BATCH_OUT_OF_SYNC' }) };
    }
    base.presetConfigured = true;
    if (!progressFile || !progress || !progressInfo) {
      return { project, summary: publicSummary({ ...base, status: 'blocked', reasonCode: 'PROGRESS_NOT_READY' }) };
    }
    base.quota = quotaSummary(batch, progress, queueInfo);
    if (counts.selected === 0) {
      return { project, summary: publicSummary({ ...base, status: 'blocked', reasonCode: 'NO_SELECTED_ITEMS' }) };
    }

    const activeBackends = progressInfo.activeBackends;
    if (locks.length || activeBackends.size) {
      const backend = activeBackendFrom(activeBackends, locks);
      return {
        project,
        summary: publicSummary({
          ...base,
          status: 'active',
          reasonCode: activeReason(backend),
          activeBackend: backend
        })
      };
    }

    const [lateLock, lateOperationLock, lateTransaction] = await Promise.all([
      inspectDirectFile(cache.path, '.pipeline.lock', { required: false, maxBytes: MAX_LOCK_BYTES, read: false }),
      inspectDirectFile(cache.path, '.pipeline.operation.lock', { required: false, maxBytes: MAX_LOCK_BYTES, read: false }),
      inspectDirectFile(cache.path, '.pipeline.transaction.json', { required: false, maxBytes: MAX_STATE_BYTES, read: false })
    ]);
    if (lateLock || lateOperationLock || lateTransaction) {
      fail('STATE_CHANGED_DURING_READ', '项目状态在检查期间发生变化，请重试', { status: 409 });
    }
    await Promise.all([
      verifyDirectFileSnapshot(cache.path, '出图队列.json', queueFile),
      verifyDirectFileSnapshot(cache.path, '内置提示词预设.json', presetFile),
      verifyDirectFileSnapshot(cache.path, '出图进度.json', progressFile)
    ]);
    await verifyBuiltinSkillSnapshot(builtinSkill);
    await verifyDirectoryIdentity(cache, 'STATE_CHANGED_DURING_READ', '项目 Cache 在检查期间发生变化，请重试');
    await verifyDirectoryIdentity(project, 'PROJECT_ROOT_CHANGED', '项目根在检查期间发生变化，请重试');
    return {
      project,
      summary: publicSummary({ ...base, status: 'ready', reasonCode: 'READY' })
    };
  };

  const getStatus = async (request) => (await inspect(request)).summary;

  /**
   * Native-host-only payload. Do not expose this method through HTTP or to the renderer:
   * unlike getStatus(), its text deliberately contains the canonical project root and
   * the trusted software-level ImageGen Skill path.
   */
  const createNativeBridgeHandoffText = async (request) => {
    const { project, summary } = await inspect(request);
    if (summary.status !== 'ready') {
      fail('HANDOFF_NOT_READY', summary.message || '项目尚不能交给 Codex 执行内置出图');
    }
    return makeHandoffText(request.projectId, project.path, builtinSkill.path);
  };

  return Object.freeze({ getStatus, createNativeBridgeHandoffText });
}
