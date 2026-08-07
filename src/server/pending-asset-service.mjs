import { spawn as nodeSpawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

const PROJECT_ID_PATTERN = /^(?=.{1,64}$)[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/u;
const MAX_CACHE_JSON_BYTES = 16 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DECISIONS = new Set(['independent', 'merge', 'exclude']);
const CATEGORY_FILES = Object.freeze({
  characters: '角色记录.json',
  creatures: '生物记录.json',
  extras: '群演记录.json',
  scenes: '场景记录.json',
  props: '道具记录.json'
});
const SAFE_ENVIRONMENT_KEYS = Object.freeze([
  'ALLUSERSPROFILE', 'APPDATA', 'CHOCOLATEYINSTALL', 'COMSPEC', 'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'HOMEDRIVE', 'HOMEPATH',
  'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'PROGRAMDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP',
  'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'
]);

export class PendingAssetServiceError extends Error {
  constructor(code, message, { status = 400 } = {}) {
    super(message);
    this.name = 'PendingAssetServiceError';
    this.code = code;
    this.status = status;
  }
}

const fail = (code, message, status = 400) => {
  throw new PendingAssetServiceError(code, message, { status });
};

const cleanText = (value) => typeof value === 'string' ? value.trim() : '';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const escapesRoot = (value) => value === '..' || value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(value);
const safeEnvironment = (source) => Object.fromEntries(SAFE_ENVIRONMENT_KEYS.flatMap((name) => {
  const matched = Object.keys(source).find((key) => key.toUpperCase() === name);
  return matched && typeof source[matched] === 'string' ? [[matched, source[matched]]] : [];
}));

const assertProjectId = (value) => {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) {
    fail('INVALID_PROJECT_ID', '项目编号格式无效');
  }
  return value;
};

const canonicalProjectRoot = async (value) => {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    fail('PROJECT_ROOT_UNAVAILABLE', '项目运行目录不可用', 503);
  }
  const root = resolve(value);
  let info;
  let canonical;
  try {
    [info, canonical] = await Promise.all([lstat(root), realpath(root)]);
  } catch {
    fail('PROJECT_ROOT_UNAVAILABLE', '项目运行目录不可用', 503);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail('PROJECT_ROOT_UNSAFE', '项目运行目录不安全', 409);
  }
  return canonical;
};

const readProjectJson = async (projectRoot, relativePath, label, { optional = false } = {}) => {
  const target = join(projectRoot, ...relativePath);
  let info;
  let canonical;
  try {
    info = await lstat(target);
    canonical = await realpath(target);
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    fail('PENDING_STATE_UNAVAILABLE', `${label}暂时不可读取`, 503);
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_CACHE_JSON_BYTES
    || escapesRoot(relative(projectRoot, canonical))) {
    fail('PENDING_STATE_UNSAFE', `${label}不是安全的项目 JSON 文件`, 409);
  }
  let raw;
  try {
    raw = await readFile(canonical, 'utf8');
  } catch {
    fail('PENDING_STATE_UNAVAILABLE', `${label}暂时不可读取`, 503);
  }
  if (Buffer.byteLength(raw, 'utf8') !== info.size) {
    fail('PENDING_STATE_CHANGED', `${label}在读取期间发生变化，请重试`, 409);
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail('PENDING_STATE_INVALID', `${label}不是有效 JSON`, 409);
  }
};

const validateDecisionInput = (value) => {
  if (!isObject(value)) fail('INVALID_PENDING_DECISION', '人工确认提交必须是对象');
  const allowed = new Set(['pendingId', 'decision', 'resolution', 'targetAssetId', 'finalAsset']);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length) fail('INVALID_PENDING_DECISION', `人工确认提交包含不允许的字段：${extra.join('、')}`);
  const pendingId = cleanText(value.pendingId);
  const decision = cleanText(value.decision);
  const resolution = cleanText(value.resolution);
  if (!pendingId || pendingId.length > 96) fail('INVALID_PENDING_DECISION', 'pendingId 无效');
  if (!DECISIONS.has(decision)) fail('INVALID_PENDING_DECISION', 'decision 无效');
  if (!resolution || resolution.length > 32767) fail('INVALID_PENDING_DECISION', 'resolution 无效');
  const targetAssetId = cleanText(value.targetAssetId);
  if (decision === 'merge' && (!targetAssetId || targetAssetId.length > 96)) {
    fail('INVALID_PENDING_DECISION', '合并决定必须提供有效 targetAssetId');
  }
  if (decision === 'exclude' && (Object.hasOwn(value, 'targetAssetId') || Object.hasOwn(value, 'finalAsset'))) {
    fail('INVALID_PENDING_DECISION', '排除决定不得提供目标资产或最终记录');
  }
  if (decision !== 'exclude' && !isObject(value.finalAsset)) {
    fail('INVALID_PENDING_DECISION', '独立建档或合并决定必须提供最终完整记录');
  }
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    fail('INVALID_PENDING_DECISION', '人工确认提交无法序列化');
  }
  if (Buffer.byteLength(encoded, 'utf8') > 128 * 1024) {
    fail('INVALID_PENDING_DECISION', '人工确认提交超过大小上限', 413);
  }
  return JSON.parse(encoded);
};

const collectProcess = (child, { timeoutMs, projectRoot }) => new Promise((resolvePromise, rejectPromise) => {
  let stdout = '';
  let stderr = '';
  let outputBytes = 0;
  let settled = false;
  let timer = null;
  const finish = (callback) => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeout(timer);
    callback();
  };
  const append = (channel, chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
      child.kill();
      finish(() => rejectPromise(new PendingAssetServiceError(
        'PENDING_RESOLUTION_OUTPUT_TOO_LARGE',
        '待确认处理脚本输出超过安全上限',
        { status: 500 }
      )));
      return;
    }
    if (channel === 'stdout') stdout += chunk.toString('utf8');
    else stderr += chunk.toString('utf8');
  };
  child.stdout?.on('data', (chunk) => append('stdout', chunk));
  child.stderr?.on('data', (chunk) => append('stderr', chunk));
  child.once('error', () => finish(() => rejectPromise(new PendingAssetServiceError(
    'PENDING_RESOLUTION_UNAVAILABLE',
    '待确认处理脚本无法启动',
    { status: 503 }
  ))));
  child.once('close', (code) => finish(() => {
    if (code !== 0) {
      const publicMessage = (stderr || stdout)
        .replaceAll(projectRoot, '<project>')
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1)
        ?.replace(/^错误：待确认资产处理失败：/u, '')
        .slice(0, 2000);
      rejectPromise(new PendingAssetServiceError(
        'PENDING_RESOLUTION_FAILED',
        publicMessage || '人工确认提交未通过固定脚本校验',
        { status: 409 }
      ));
      return;
    }
    try {
      const receipt = JSON.parse(stdout);
      if (!isObject(receipt) || receipt.ok !== true) throw new Error('invalid receipt');
      resolvePromise(receipt);
    } catch {
      rejectPromise(new PendingAssetServiceError(
        'PENDING_RESOLUTION_INVALID_RECEIPT',
        '待确认处理脚本没有返回有效回执',
        { status: 500 }
      ));
    }
  }));
  timer = setTimeout(() => {
    child.kill();
    finish(() => rejectPromise(new PendingAssetServiceError(
      'PENDING_RESOLUTION_TIMEOUT',
      '待确认处理超时，请检查项目锁后重试',
      { status: 504 }
    )));
  }, timeoutMs);
});

export function createPendingAssetService({
  resolveProjectRoot,
  materializeProjectRuntime,
  withProjectIdle = async (_projectId, operation) => operation(),
  spawnImpl = nodeSpawn,
  environment = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (
    typeof resolveProjectRoot !== 'function'
    || typeof materializeProjectRuntime !== 'function'
    || typeof withProjectIdle !== 'function'
  ) {
    throw new TypeError('resolveProjectRoot, materializeProjectRuntime, and withProjectIdle are required');
  }

  const prepare = async (projectId) => {
    const id = assertProjectId(projectId);
    await materializeProjectRuntime({ projectId: id });
    return canonicalProjectRoot(await resolveProjectRoot(id));
  };

  const getState = async ({ projectId } = {}) => {
    const id = assertProjectId(projectId);
    const projectRoot = await canonicalProjectRoot(await resolveProjectRoot(id));
    const [pending, progress, overview, ...groups] = await Promise.all([
      readProjectJson(projectRoot, ['cache', '待确认记录.json'], '待确认记录', { optional: true }),
      readProjectJson(projectRoot, ['cache', '阅读进度.json'], '阅读进度', { optional: true }),
      readProjectJson(projectRoot, ['cache', '世界观总览.json'], '世界观总览', { optional: true }),
      ...Object.values(CATEGORY_FILES).map((filename) => (
        readProjectJson(projectRoot, ['cache', '累计记录', filename], filename, { optional: true })
      ))
    ]);
    const pendingRecords = pending === null ? [] : pending;
    if (!Array.isArray(pendingRecords)) fail('PENDING_STATE_INVALID', '待确认记录顶层必须是数组', 409);
    const items = pendingRecords.filter((item) => isObject(item)
      && isObject(item.draftAsset)
      && (cleanText(item.status) === 'pending' || !cleanText(item.appliedAt)));
    const targets = [];
    Object.keys(CATEGORY_FILES).forEach((category, index) => {
      const records = groups[index];
      if (records === null) return;
      if (!Array.isArray(records)) fail('PENDING_STATE_INVALID', `${CATEGORY_FILES[category]} 顶层必须是数组`, 409);
      records.forEach((record) => {
        if (isObject(record) && cleanText(record.assetId) && cleanText(record.assetName)) {
          targets.push({ category, assetId: record.assetId, assetName: record.assetName, record });
        }
      });
    });
    const discovered = Array.isArray(progress?.discoveredEpisodes) ? progress.discoveredEpisodes : [];
    const analysisComplete = progress?.status === 'complete'
      && Array.isArray(progress?.completedEpisodes)
      && JSON.stringify(progress.completedEpisodes) === JSON.stringify(discovered)
      && discovered.length > 0;
    const overviewComplete = isObject(overview) && cleanText(overview.content).length > 0;
    return {
      version: 1,
      projectId: id,
      ready: analysisComplete && overviewComplete,
      analysisComplete,
      overviewComplete,
      pendingCount: items.filter((item) => cleanText(item.status) === 'pending').length,
      decidedCount: items.filter((item) => cleanText(item.status) === 'resolved').length,
      items,
      targets
    };
  };

  const resolvePending = async ({ projectId, decision } = {}) => {
    const id = assertProjectId(projectId);
    const input = validateDecisionInput(decision);
    try {
      return await withProjectIdle(id, async () => {
        const projectRoot = await prepare(id);
        const pythonRunner = join(projectRoot, 'scripts', 'commands', 'python.ps1');
        const resolver = join(projectRoot, 'scripts', 'pipeline', 'resolve_pending_asset.py');
        const child = spawnImpl('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
          pythonRunner, resolver, projectRoot
        ], {
          cwd: projectRoot,
          env: safeEnvironment(environment),
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        });
        child.stdin.end(JSON.stringify(input));
        const receipt = await collectProcess(child, { timeoutMs, projectRoot });
        return { projectId: id, ...receipt };
      });
    } catch (error) {
      if (error instanceof PendingAssetServiceError) throw error;
      if (error?.code === 'PROJECT_TASK_BUSY') {
        fail('PROJECT_TASK_BUSY', '流水线仍在运行，请等待当前步骤安全停止后再提交人工决定', 409);
      }
      throw error;
    }
  };

  return Object.freeze({ getState, resolvePending });
}
