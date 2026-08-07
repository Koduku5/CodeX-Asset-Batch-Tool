import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, posix, relative, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { PROJECT_ID_PATTERN } from './project-root-index.mjs';

export const CODEX_IMAGEGEN_HANDOFF_SUMMARY_VERSION = 1;

const QUEUE_VERSION = 4;
const PRESET_VERSION = 6;
const PROGRESS_VERSION = 3;
const LOCK_PROTOCOL_VERSION = 2;
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const MAX_LOCK_BYTES = 128 * 1024;
const MAX_SKILL_BYTES = 4 * 1024 * 1024;
const MAX_QUEUE_ITEMS = 100_000;
const MAX_TEXT_FIELD = 1024 * 1024;
const SHEET_ORDER = Object.freeze(['角色', '生物', '群演', '场景', '道具']);
const SHEET_SET = new Set(SHEET_ORDER);
const STYLE_SET = new Set(['anime', 'cg', 'live-action']);
const GENERATION_LIMITS = new Set([5, 0, 10]);
const REFERENCE_MODES = new Set(['style', 'visual_consistency', 'custom']);
const PROGRESS_STATUSES = new Set(['generating', 'completed', 'failed']);
const PROGRESS_BACKENDS = new Set(['builtin', 'api']);
const TRANSITIONS = new Set(['claim_pending', 'pause_pending']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DEFAULT_SOFTWARE_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

const REASON_MESSAGES = Object.freeze({
  READY: '项目已具备交给 Codex 执行单项内置出图的基本状态',
  CACHE_NOT_READY: '项目 Cache 尚未建立',
  QUEUE_NOT_BUILT: '项目出图队列尚未建立',
  QUEUE_EMPTY: '项目出图队列没有可检查的资产项',
  QUEUE_MODE_UNSUPPORTED: '当前队列不是普通资产生成队列',
  PRESET_NOT_CONFIGURED: '内置提示词批次尚未确认',
  BATCH_NOT_ATTACHED: '当前队列尚未装填内置提示词批次',
  BATCH_OUT_OF_SYNC: '内置提示词预设与当前队列不一致',
  NO_SELECTED_ITEMS: '当前批次没有勾选任何队列资产类别',
  PROGRESS_NOT_READY: '当前队列的出图进度尚未建立',
  RECOVERY_REQUIRED: '项目存在未完成的状态事务，必须先按正式流程恢复',
  PIPELINE_ACTIVE: '项目流水线当前已有活动任务',
  BUILTIN_ACTIVE: '项目当前已有内置出图任务',
  API_ACTIVE: '项目当前已有 API 出图任务',
  MULTIPLE_ACTIVE: '项目当前存在多个活动出图状态',
  ACTIVE_STATE_UNOWNED: '出图进度显示任务进行中，但无法确认对应流水线锁'
});

export class CodexImagegenHandoffError extends Error {
  constructor(code, message, { status = 409, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CodexImagegenHandoffError';
    this.code = code;
    this.status = status;
  }
}

const fail = (code, message, options) => {
  throw new CodexImagegenHandoffError(code, message, options);
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const cleanText = (value) => typeof value === 'string' ? value.trim() : '';
const exactKeys = (value, expected) => isObject(value)
  && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');

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

const isSafeRelativePath = (value, { prefix = null } = {}) => {
  if (typeof value !== 'string' || !value || value.length > 4096) return false;
  if (/\u0000|[\r\n]/u.test(value) || isAbsolute(value) || win32.isAbsolute(value) || posix.isAbsolute(value)) return false;
  const parts = value.split(/[\\/]/u);
  if (parts.some((part) => !part || part === '.' || part === '..')) return false;
  if (!prefix) return true;
  const prefixParts = prefix.split('/');
  return prefixParts.every((part, index) => pathNameEquals(parts[index] || '', part));
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

const validateQueue = (queue) => {
  if (
    queue.version !== QUEUE_VERSION
    || !Number.isFinite(Date.parse(queue.builtAt))
    || !SHA256_PATTERN.test(cleanText(queue.routingFingerprint))
    || !SHA256_PATTERN.test(cleanText(queue.eligibilityFingerprint))
    || !Array.isArray(queue.items)
    || queue.items.length > MAX_QUEUE_ITEMS
  ) {
    fail('STATE_INVALID', '出图队列结构无效');
  }
  const operation = cleanText(queue.operation) || 'generate';
  const keys = new Set();
  const itemsByKey = new Map();
  for (const item of queue.items) {
    if (
      !isObject(item)
      || !cleanText(item.key)
      || cleanText(item.key).length > 512
      || !SHEET_SET.has(item.sheetName)
      || !cleanText(item.assetId)
      || typeof item.assetName !== 'string'
      || typeof item.productionNotes !== 'string'
      || item.productionNotes.length > MAX_TEXT_FIELD
      || typeof item.prompt !== 'string'
      || item.prompt.length > MAX_TEXT_FIELD
      || !isSafeRelativePath(item.outputPath, { prefix: '输出/资产图' })
      || !SHA256_PATTERN.test(cleanText(item.assetFingerprint))
      || !SHA256_PATTERN.test(cleanText(item.inputFingerprint))
      || keys.has(item.key)
    ) {
      fail('STATE_INVALID', '出图队列包含无效或重复的资产项');
    }
    keys.add(item.key);
    itemsByKey.set(item.key, item);
  }
  return Object.freeze({ operation, keys, itemsByKey });
};

const validatePresetShape = (preset) => {
  if (
    !exactKeys(preset, [
      'version', 'catalogFingerprint', 'routeFingerprintsBySheet', 'confirmedAt',
      'styleId', 'generationLimit', 'enabledSheets', 'referencesBySheet',
      'referenceModeBySheet', 'promptOverridesBySheet'
    ])
    || preset.version !== PRESET_VERSION
    || !SHA256_PATTERN.test(cleanText(preset.catalogFingerprint))
    || !Number.isFinite(Date.parse(preset.confirmedAt))
    || !STYLE_SET.has(preset.styleId)
    || !GENERATION_LIMITS.has(preset.generationLimit)
    || !Array.isArray(preset.enabledSheets)
    || !preset.enabledSheets.length
    || new Set(preset.enabledSheets).size !== preset.enabledSheets.length
    || preset.enabledSheets.some((sheet) => !SHEET_SET.has(sheet))
    || !isDeepStrictEqual(preset.enabledSheets, SHEET_ORDER.filter((sheet) => preset.enabledSheets.includes(sheet)))
    || !exactKeys(preset.routeFingerprintsBySheet, preset.enabledSheets)
    || preset.enabledSheets.some((sheet) => !SHA256_PATTERN.test(cleanText(preset.routeFingerprintsBySheet[sheet])))
    || !exactKeys(preset.referencesBySheet, SHEET_ORDER)
    || !exactKeys(preset.referenceModeBySheet, SHEET_ORDER)
    || !exactKeys(preset.promptOverridesBySheet, SHEET_ORDER)
  ) {
    fail('STATE_INVALID', '内置提示词预设结构无效');
  }
  for (const sheet of SHEET_ORDER) {
    const references = preset.referencesBySheet[sheet];
    const referenceMode = preset.referenceModeBySheet[sheet];
    const override = preset.promptOverridesBySheet[sheet];
    if (
      !Array.isArray(references)
      || references.length > 16
      || !REFERENCE_MODES.has(referenceMode)
      || (references.length === 0 && referenceMode !== 'style')
      || (referenceMode === 'visual_consistency' && references.length < 2)
      || !exactKeys(override, ['routeMode', 'promptText'])
      || !['default', 'reference'].includes(override.routeMode)
      || typeof override.promptText !== 'string'
      || override.promptText.length > MAX_TEXT_FIELD
    ) {
      fail('STATE_INVALID', '内置提示词预设分类配置无效');
    }
    for (const snapshot of references) {
      if (
        !exactKeys(snapshot, ['path', 'sourceName', 'size', 'sha256'])
        || !isSafeRelativePath(snapshot.path, { prefix: 'cache/内置参考图' })
        || !cleanText(snapshot.sourceName)
        || !Number.isSafeInteger(snapshot.size)
        || snapshot.size < 1
        || snapshot.size > 20 * 1024 * 1024
        || !SHA256_PATTERN.test(cleanText(snapshot.sha256))
      ) {
        fail('STATE_INVALID', '内置参考图快照结构无效');
      }
    }
  }
  return preset;
};

const validateBatchShape = (batch) => {
  if (!isObject(batch)) {
    fail('STATE_INVALID', '队列中的内置提示词批次结构无效');
  }
  validatePresetShape(batch);
  return Object.freeze({ presetFields: batch });
};

const emptyCounts = () => ({
  total: 0,
  selected: 0,
  unselected: 0,
  pending: 0,
  completed: 0,
  failed: 0,
  active: 0
});

const validateProgress = (progress, queue, queueInfo) => {
  if (
    progress.version !== PROGRESS_VERSION
    || progress.routingFingerprint !== queue.routingFingerprint
    || !isObject(progress.items)
  ) {
    fail('STATE_INVALID', '出图进度结构或队列绑定无效');
  }
  for (const key of Object.keys(progress.items)) {
    if (!queueInfo.keys.has(key)) fail('STATE_INVALID', '出图进度包含当前队列之外的资产项');
  }
  const counts = emptyCounts();
  counts.total = queue.items.length;
  const enabled = new Set(queue.builtinPromptBatch?.enabledSheets || []);
  const activeBackends = new Set();
  for (const item of queue.items) {
    const selected = enabled.has(item.sheetName);
    if (selected) counts.selected += 1;
    else counts.unselected += 1;
    const state = progress.items[item.key];
    if (state === undefined) {
      counts.pending += 1;
      continue;
    }
    if (!isObject(state)) fail('STATE_INVALID', '出图进度资产状态无效');
    if (state.inputFingerprint !== undefined && state.inputFingerprint !== item.inputFingerprint) {
      fail('STATE_INVALID', '出图进度与当前队列资产指纹不一致');
    }
    if (state.assetFingerprint !== undefined && state.assetFingerprint !== item.assetFingerprint) {
      fail('STATE_INVALID', '出图进度与当前队列资产指纹不一致');
    }
    if (state.transition !== undefined) {
      if (!TRANSITIONS.has(state.transition) || state.backend !== 'builtin') {
        fail('STATE_INVALID', '出图进度转换状态无效');
      }
      counts.active += 1;
      activeBackends.add('builtin');
      continue;
    }
    if (state.status === undefined) {
      counts.pending += 1;
      continue;
    }
    if (!PROGRESS_STATUSES.has(state.status) || !PROGRESS_BACKENDS.has(state.backend)) {
      fail('STATE_INVALID', '出图进度资产状态无效');
    }
    if (state.status === 'completed') counts.completed += 1;
    else if (state.status === 'failed') counts.failed += 1;
    else {
      counts.active += 1;
      activeBackends.add(state.backend);
    }
  }
  return Object.freeze({ counts, activeBackends });
};

const validateLock = (lock, queueInfo = null) => {
  if (
    !isObject(lock)
    || lock.protocolVersion !== LOCK_PROTOCOL_VERSION
    || !['transient', 'durable'].includes(lock.leaseMode)
    || !cleanText(lock.kind)
    || !cleanText(lock.key)
    || !cleanText(lock.token)
    || !Number.isSafeInteger(lock.processId)
    || lock.processId < 1
    || !cleanText(lock.host)
    || !Number.isFinite(Date.parse(lock.createdAt))
    || !Number.isFinite(Date.parse(lock.updatedAt))
  ) {
    fail('STATE_INVALID', '流水线锁结构无效');
  }
  if (lock.kind === 'image_generation' && queueInfo && !queueInfo.keys.has(lock.key)) {
    fail('STATE_INVALID', '内置出图锁无法绑定到当前队列');
  }
  return lock;
};

const publicSummary = ({
  projectId,
  status,
  reasonCode,
  queueEstablished = false,
  presetConfigured = false,
  counts = emptyCounts(),
  quota = { limit: null, claimed: 0, remaining: null },
  activeBackend = null
}) => Object.freeze({
  version: CODEX_IMAGEGEN_HANDOFF_SUMMARY_VERSION,
  projectId,
  status,
  reasonCode,
  message: REASON_MESSAGES[reasonCode],
  queueEstablished,
  presetConfigured,
  counts: Object.freeze({ ...counts }),
  quota: Object.freeze({ ...quota }),
  activeBackend
});

const activeBackendFrom = (backends, locks) => {
  const values = new Set(backends);
  for (const lock of locks) {
    if (!lock) continue;
    if (lock.kind === 'image_generation') values.add('builtin');
    else if (lock.kind === 'image_generation_batch') values.add('api');
    else values.add('other');
  }
  if (values.size > 1) return 'multiple';
  return values.values().next().value || 'other';
};

const activeReason = (backend) => backend === 'builtin'
  ? 'BUILTIN_ACTIVE'
  : backend === 'api'
    ? 'API_ACTIVE'
    : backend === 'multiple'
      ? 'MULTIPLE_ACTIVE'
      : 'PIPELINE_ACTIVE';

const quotaSummary = (batch, progress, queueInfo) => {
  const session = batch.presetFields.confirmedAt;
  const claimed = Object.entries(progress.items).filter(([key, state]) => (
    queueInfo.keys.has(key)
    && isObject(state)
    && state.backend === 'builtin'
    && cleanText(state.builtinGenerationSession) === session
  )).length;
  const limit = batch.presetFields.generationLimit;
  return {
    limit,
    claimed,
    remaining: limit === 0 ? null : Math.max(0, limit - claimed)
  };
};

const makeWorkerPayload = (projectId, projectRoot, builtinImagegenSkillPath) => [
  '<KA_IMAGEGEN_WORKER_PAYLOAD>',
  '模式：worker',
  `软件项目编号：${JSON.stringify(projectId)}`,
  `唯一项目根：${JSON.stringify(projectRoot)}`,
  `软件级通用 Skill：${JSON.stringify(builtinImagegenSkillPath)}`,
  '你是这个软件项目唯一的长期主出图任务。先从头到尾完整读取上述软件级 ka-builtin-imagegen/SKILL.md，再严格按 worker 模式执行。项目目录不保存 Skill 副本，不得寻找或依赖项目根中的 SKILL.md。',
  '把唯一项目根作为所有正式流水线命令的根参数；每次只通过 get_next_image_job.mjs 原子领取一项，不要整体展开队列或全部提示词，不要改用队列中的 API prompt。',
  '只使用该单项正式返回的 productionNotes、promptSpec 与 referenceImages 调用 Codex 内置 image_gen；参考图存在时按 SKILL.md 作为 referenced_image_paths 传入。',
  '每项完成或失败后立即按 SKILL.md 调用 update_image_progress.mjs 回写正式进度；只有落盘校验成功才可报告完成。',
  '桌面宿主、.NET bridge 和任何 SDK 都只负责建立交接，绝不能调用或模拟 image_gen，也不能预先运行领取命令、创建锁或改写进度。',
  '遇到活动锁、指纹不一致、恢复条件不明确、缺文件、项目根不可访问或工具不可用时立即失败关闭；不得删除或伪造锁，不得猜测恢复，不得输出凭据。',
  '</KA_IMAGEGEN_WORKER_PAYLOAD>'
].join('\n');

const makeHandoffText = (projectId, projectRoot, builtinImagegenSkillPath) => {
  const workerTitle = `出图｜${projectId}`;
  const workerDirectoryName = `ka-imagegen-${projectId}`;
  return [
    '模式：dispatch',
    '这是用户明确要求的新任务调度交接。当前任务只负责在 Codex App 中为这个软件项目新建或复用一个用户可见出图任务，不得在当前任务出图。',
    `软件项目编号：${JSON.stringify(projectId)}`,
    `主出图任务标题：${JSON.stringify(workerTitle)}`,
    `独立任务目录名：${JSON.stringify(workerDirectoryName)}`,
    `软件级通用 Skill：${JSON.stringify(builtinImagegenSkillPath)}`,
    '先从头到尾完整读取上述 ka-builtin-imagegen/SKILL.md，并严格执行其中的 dispatch 模式。读取 Codex App 任务列表，只复用标题和独立任务目录名都精确匹配的 projectless 任务；不存在时新建 projectless 任务。不得依赖、注册或进入任何外部 Codex 项目，不得创建 worktree。',
    '新建或复用后，把下面完整的 KA_IMAGEGEN_WORKER_PAYLOAD 原样作为初始指令或后续消息发送，再固定并打开该任务。禁止删改 Payload，禁止在当前调度任务领取队列或调用 image_gen。',
    makeWorkerPayload(projectId, projectRoot, builtinImagegenSkillPath)
  ].join('\n');
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
    const presetMatches = isDeepStrictEqual(batch.presetFields, preset);
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
