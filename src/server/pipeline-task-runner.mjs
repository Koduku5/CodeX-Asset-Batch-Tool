import { createHash, randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import {
  ACTION_SPECS,
  DEFAULT_PIPELINE_SKILL_PATH,
  PIPELINE_TASK_ACTIONS
} from './pipeline-task/action-specs.mjs';
import { readCodexRuntimeConfig } from './codex-runtime-config.mjs';

export { DEFAULT_PIPELINE_SKILL_PATH, PIPELINE_TASK_ACTIONS };

const PROJECT_ID_PATTERN = /^(?=.{1,64}$)[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/u;
const ACTIVE_STATUSES = new Set(['queued', 'running', 'pausing']);
const WORKBOOK_ASSET_TYPES = Object.freeze(['characters', 'creatures', 'extras', 'scenes', 'props']);
const WORKBOOK_ASSET_TYPE_SET = new Set(WORKBOOK_ASSET_TYPES);
const DEFAULT_MAX_LOG_CHARACTERS = 16 * 1024;
const DEFAULT_MAX_RETAINED_TASKS = 256;
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

export class PipelineTaskRunnerError extends Error {
  constructor(code, message, { status = 400 } = {}) {
    super(message);
    this.name = 'PipelineTaskRunnerError';
    this.code = code;
    this.status = status;
  }
}

const samePath = (left, right) => process.platform === 'win32'
  ? left.toLowerCase() === right.toLowerCase()
  : left === right;

const escapesRoot = (value) => value === '..'
  || value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  || isAbsolute(value);

const isoTimestamp = (clock) => {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('now() must return a valid date value');
  return date.toISOString();
};

const assertProjectId = (value) => {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) {
    throw new PipelineTaskRunnerError('INVALID_PROJECT_ID', '项目编号格式无效');
  }
  return value;
};

const assertAction = (value) => {
  if (typeof value !== 'string' || !Object.hasOwn(ACTION_SPECS, value)) {
    throw new PipelineTaskRunnerError('ACTION_NOT_ALLOWED', '不允许执行该项目操作');
  }
  return value;
};

const assertStartInput = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PipelineTaskRunnerError('INVALID_TASK_REQUEST', '任务请求必须是对象');
  }
  const unexpected = Object.keys(value).filter((key) => ![
    'projectId', 'action', 'workbookEpisodeStart', 'workbookEpisodeEnd', 'workbookAssetTypes'
  ].includes(key));
  if (unexpected.length) {
    throw new PipelineTaskRunnerError('TASK_INPUT_NOT_ALLOWED', '任务请求包含不允许的字段');
  }
  const action = assertAction(value.action);
  const workbookEpisodeStart = value.workbookEpisodeStart ?? null;
  const workbookEpisodeEnd = value.workbookEpisodeEnd ?? null;
  const workbookAssetTypes = value.workbookAssetTypes ?? [];
  if (!Array.isArray(workbookAssetTypes)
    || workbookAssetTypes.some((item) => !WORKBOOK_ASSET_TYPE_SET.has(item))
    || new Set(workbookAssetTypes).size !== workbookAssetTypes.length) {
    throw new PipelineTaskRunnerError('INVALID_WORKBOOK_SCOPE', '局部资产表类型范围无效');
  }
  if (action === 'build-scoped-workbook') {
    if (!Number.isInteger(workbookEpisodeStart) || !Number.isInteger(workbookEpisodeEnd)
      || workbookEpisodeStart < 1 || workbookEpisodeEnd > 10000
      || workbookEpisodeStart > workbookEpisodeEnd || !workbookAssetTypes.length) {
      throw new PipelineTaskRunnerError('INVALID_WORKBOOK_SCOPE', '局部资产表集数或类型范围无效');
    }
  } else if (workbookEpisodeStart !== null || workbookEpisodeEnd !== null || workbookAssetTypes.length) {
    throw new PipelineTaskRunnerError('TASK_INPUT_NOT_ALLOWED', '只有局部资产表任务可以指定筛选范围');
  }
  return {
    projectId: assertProjectId(value.projectId),
    action,
    workbookEpisodeStart,
    workbookEpisodeEnd,
    workbookAssetTypes: Object.freeze([...workbookAssetTypes])
  };
};

const boundedInteger = (value, fallback, minimum, maximum, label) => {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return candidate;
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

const SAFE_ENVIRONMENT_KEYS = Object.freeze([
  'ALLUSERSPROFILE', 'APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMDRIVE', 'SYSTEMROOT',
  'TEMP', 'TMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'
]);

const safeChildEnvironment = (source) => Object.fromEntries(
  SAFE_ENVIRONMENT_KEYS.flatMap((name) => {
    const matched = Object.keys(source).find((key) => key.toUpperCase() === name);
    return matched && typeof source[matched] === 'string' ? [[matched, source[matched]]] : [];
  })
);

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const redactLog = (value, projectRoot) => {
  let text = String(value || '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
  if (projectRoot) {
    text = text.replace(new RegExp(escapeRegExp(projectRoot), 'giu'), '[project]');
  }
  return text
    .replace(/\b(authorization\s*:\s*bearer)\s+[^\s]+/giu, '$1 [redacted]')
    .replace(/\b(api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|credential|secret)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[redacted]')
    .replace(/\b(pid|process[-_ ]?id)\s*[:=#]?\s*\d+\b/giu, '$1=[redacted]')
    .replace(/(?:^|[\s("'=])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>|]*/gmu, (match) => `${match[0].trim() ? '' : match[0]}[path]`)
    .replace(/(?:^|[\s("'=])\/(?:[^\s"'<>/]+\/)*[^\s"'<>/]*/gmu, (match) => `${match[0].trim() ? '' : match[0]}[path]`);
};

const publicTask = (task, maxLogCharacters) => {
  const safeLog = redactLog(task.rawLog, task.projectRoot);
  const wasTruncated = task.rawLogTruncated || safeLog.length > maxLogCharacters;
  const log = safeLog.length > maxLogCharacters
    ? safeLog.slice(-maxLogCharacters)
    : safeLog;
  return {
    taskId: task.taskId,
    projectId: task.projectId,
    action: task.action,
    status: task.status,
    queuedAt: task.queuedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    exitCode: task.exitCode,
    log: {
      text: wasTruncated ? `[早期日志已截断]\n${log}` : log,
      truncated: wasTruncated
    }
  };
};

const attachOutput = (stream, append) => {
  if (!stream || typeof stream.on !== 'function') return;
  if (typeof stream.setEncoding === 'function') stream.setEncoding('utf8');
  stream.on('data', append);
};

export function createPipelineTaskRunner({
  resolveProjectRoot,
  materializeProjectRuntime,
  pipelineSkillPath = DEFAULT_PIPELINE_SKILL_PATH,
  spawnImpl = nodeSpawn,
  now = () => new Date(),
  createTaskId = () => `task-${randomUUID()}`,
  maxLogCharacters,
  maxRetainedTasks,
  readRuntimeConfig = readCodexRuntimeConfig,
  environment = process.env
} = {}) {
  if (typeof resolveProjectRoot !== 'function') throw new TypeError('resolveProjectRoot must be a function');
  if (typeof materializeProjectRuntime !== 'function') throw new TypeError('materializeProjectRuntime must be a function');
  if (typeof spawnImpl !== 'function') throw new TypeError('spawnImpl must be a function');
  if (typeof readRuntimeConfig !== 'function') throw new TypeError('readRuntimeConfig must be a function');
  if (typeof now !== 'function' || typeof createTaskId !== 'function') throw new TypeError('clock and task id factory must be functions');
  const configuredPipelineSkillPath = normalizePipelineSkillPath(pipelineSkillPath);
  const logLimit = boundedInteger(maxLogCharacters, DEFAULT_MAX_LOG_CHARACTERS, 256, 64 * 1024, 'maxLogCharacters');
  const taskLimit = boundedInteger(maxRetainedTasks, DEFAULT_MAX_RETAINED_TASKS, 8, 2048, 'maxRetainedTasks');
  const tasks = new Map();
  const activeByProject = new Map();
  const projectOperationLocks = new Set();
  let shuttingDown = false;

  const appendLog = (task, chunk) => {
    task.rawLog += String(chunk ?? '');
    const rawLimit = logLimit * 4;
    if (task.rawLog.length > rawLimit) {
      task.rawLog = task.rawLog.slice(-rawLimit);
      task.rawLogTruncated = true;
    }
  };

  const pruneFinishedTasks = () => {
    if (tasks.size < taskLimit) return;
    for (const [taskId, task] of tasks) {
      if (tasks.size < taskLimit) break;
      if (!ACTIVE_STATUSES.has(task.status)) tasks.delete(taskId);
    }
  };

  const finalize = (task, status, exitCode) => {
    if (!ACTIVE_STATUSES.has(task.status)) return;
    task.status = status;
    task.exitCode = Number.isInteger(exitCode) ? exitCode : null;
    task.finishedAt = isoTimestamp(now);
    if (activeByProject.get(task.projectId) === task.taskId) activeByProject.delete(task.projectId);
  };

  const terminateChild = (task, child) => {
    if (!child || typeof child.kill !== 'function') return;
    try {
      child.kill('SIGTERM');
    } catch (error) {
      appendLog(task, `\n任务进程未能正常停止：${error?.message || 'unknown error'}\n`);
    }
    const forceTimer = setTimeout(() => {
      if (task.child !== child) return;
      try {
        child.kill('SIGKILL');
      } catch {
        // The process may already have exited between the identity check and kill.
      }
    }, 500);
    forceTimer.unref?.();
  };

  const pauseInternal = (task, message) => {
    if (!ACTIVE_STATUSES.has(task.status)) return;
    task.pauseRequested = true;
    appendLog(task, `\n${message}\n`);
    const child = task.child;
    if (!child) finalize(task, 'paused', null);
    else task.status = 'pausing';
    terminateChild(task, child);
  };

  const executeCommand = (task, command) => {
    const commandPromise = new Promise((resolveCommand, rejectCommand) => {
      let child;
      try {
        child = spawnImpl(command.executable, command.arguments, {
          cwd: command.cwd,
          env: safeChildEnvironment(environment),
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        rejectCommand(new PipelineTaskRunnerError(
          'TASK_START_FAILED',
          `任务进程启动失败：${error?.message || 'unknown error'}`,
          { status: 503 }
        ));
        return;
      }
      if (!child || typeof child.once !== 'function') {
        rejectCommand(new PipelineTaskRunnerError('TASK_START_FAILED', '任务进程启动失败', { status: 503 }));
        return;
      }
      attachOutput(child.stdout, (chunk) => appendLog(task, chunk));
      attachOutput(child.stderr, (chunk) => appendLog(task, chunk));
      let settled = false;
      const settle = (succeeded, exitCode, error) => {
        if (settled) return;
        settled = true;
        if (error) appendLog(task, `\n${error.message || '任务进程异常'}\n`);
        resolveCommand({ succeeded, exitCode: Number.isInteger(exitCode) ? exitCode : null });
      };
      task.child = child;
      child.once('error', (error) => settle(false, null, error));
      child.once('close', (code) => settle(code === 0, code));
      if (task.status === 'queued') {
        task.status = 'running';
        task.startedAt = isoTimestamp(now);
      }
      if (task.pauseRequested) terminateChild(task, child);
    });
    task.commandPromise = commandPromise;
    return commandPromise.finally(() => {
      task.child = null;
      task.commandPromise = null;
      if (task.pauseRequested) finalize(task, 'paused', null);
    });
  };

  const run = async (task) => {
    try {
      const initialRoot = await canonicalProjectRoot(rootPathFromResolution(
        await resolveProjectRoot(task.projectId)
      ));
      await materializeProjectRuntime({ projectId: task.projectId, projectRoot: initialRoot });
      const verifiedRoot = await canonicalProjectRoot(rootPathFromResolution(
        await resolveProjectRoot(task.projectId)
      ));
      if (!samePath(initialRoot, verifiedRoot)) {
        throw new PipelineTaskRunnerError('PROJECT_ROOT_CHANGED', '项目运行目录在准备期间发生变化', { status: 409 });
      }
      task.projectRoot = verifiedRoot;
      const spec = ACTION_SPECS[task.action];
      task.runtimeConfig = spec.requiresPipelineSkill ? await readRuntimeConfig() : null;
      const runtimeFiles = [];
      for (const segments of spec.requiredFiles) {
        runtimeFiles.push(await resolveRuntimeFile(verifiedRoot, segments));
      }
      const pipelineSkill = spec.requiresPipelineSkill
        ? await canonicalPipelineSkillPath(configuredPipelineSkillPath, verifiedRoot)
        : null;
      const resumeAnalysisEpisode = ANALYSIS_RESUME_ACTIONS.has(task.action)
        ? await resumableAnalysisEpisode(verifiedRoot)
        : null;
      if (Number.isInteger(resumeAnalysisEpisode)) {
        appendLog(task, `检测到第 ${resumeAnalysisEpisode} 集分析恢复状态，跳过剧本拆分并继续逐集分析\n`);
      }
      const commands = spec.makeCommands(verifiedRoot, runtimeFiles, pipelineSkill, {
        workbookEpisodeStart: task.workbookEpisodeStart,
        workbookEpisodeEnd: task.workbookEpisodeEnd,
        workbookAssetTypes: task.workbookAssetTypes,
        runtimeConfig: task.runtimeConfig,
        resumeAnalysisEpisode
      });
      for (const command of commands) {
        if (task.pauseRequested) return;
        if (command.checkpoint === 'pending-assets') {
          const pendingCount = await unresolvedPendingAssetCount(verifiedRoot);
          if (pendingCount > 0) {
            appendLog(task, `检测到 ${pendingCount} 项待确认资产；已完成全部单集分析和世界观总览，流水线在资产设定与制表前安全等待人工确认。\n`);
            finalize(task, 'paused', null);
            return;
          }
          continue;
        }
        const result = await executeCommand(task, command);
        if (task.pauseRequested) return;
        if (!result.succeeded) {
          finalize(task, 'failed', result.exitCode);
          return;
        }
      }
      finalize(task, 'succeeded', 0);
    } catch (error) {
      if (task.pauseRequested) return;
      appendLog(task, `${error?.message || '任务准备失败'}\n`);
      finalize(task, 'failed', null);
    }
  };

  const startTask = (input) => {
    const {
      projectId, action, workbookEpisodeStart, workbookEpisodeEnd, workbookAssetTypes
    } = assertStartInput(input);
    if (shuttingDown) {
      throw new PipelineTaskRunnerError('TASK_RUNNER_STOPPING', '软件正在退出，不能启动新任务', { status: 503 });
    }
    if (activeByProject.has(projectId) || projectOperationLocks.has(projectId)) {
      throw new PipelineTaskRunnerError('PROJECT_TASK_BUSY', '该项目已有任务正在运行', { status: 409 });
    }
    pruneFinishedTasks();
    if (tasks.size >= taskLimit) {
      throw new PipelineTaskRunnerError('TASK_HISTORY_FULL', '任务记录已满，请稍后重试', { status: 503 });
    }
    const taskId = createTaskId();
    if (typeof taskId !== 'string' || !/^task-[A-Za-z0-9-]{1,80}$/u.test(taskId) || tasks.has(taskId)) {
      throw new TypeError('createTaskId() returned an invalid or duplicate task id');
    }
    const task = {
      taskId,
      projectId,
      action,
      workbookEpisodeStart,
      workbookEpisodeEnd,
      workbookAssetTypes,
      status: 'queued',
      queuedAt: isoTimestamp(now),
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      rawLog: '',
      rawLogTruncated: false,
      projectRoot: null,
      runtimeConfig: null,
      pauseRequested: false,
      child: null,
      commandPromise: null
    };
    tasks.set(taskId, task);
    activeByProject.set(projectId, taskId);
    queueMicrotask(() => void run(task));
    return publicTask(task, logLimit);
  };

  const getTask = (taskId) => {
    if (typeof taskId !== 'string' || !/^task-[A-Za-z0-9-]{1,80}$/u.test(taskId)) {
      throw new PipelineTaskRunnerError('INVALID_TASK_ID', '任务编号格式无效');
    }
    const task = tasks.get(taskId);
    if (!task) throw new PipelineTaskRunnerError('TASK_NOT_FOUND', '任务不存在', { status: 404 });
    return publicTask(task, logLimit);
  };

  const listTasks = ({ projectId } = {}) => {
    const selectedProjectId = projectId === undefined ? null : assertProjectId(projectId);
    return [...tasks.values()]
      .filter((task) => !selectedProjectId || task.projectId === selectedProjectId)
      .map((task) => publicTask(task, logLimit));
  };

  const pauseTask = async (taskId) => {
    if (typeof taskId !== 'string' || !/^task-[A-Za-z0-9-]{1,80}$/u.test(taskId)) {
      throw new PipelineTaskRunnerError('INVALID_TASK_ID', '任务编号格式无效');
    }
    const task = tasks.get(taskId);
    if (!task) throw new PipelineTaskRunnerError('TASK_NOT_FOUND', '任务不存在', { status: 404 });
    pauseInternal(task, '任务已由用户暂停');
    return publicTask(task, logLimit);
  };

  const shutdown = async ({ timeoutMs = 600 } = {}) => {
    shuttingDown = true;
    for (const task of tasks.values()) {
      pauseInternal(task, '软件正在退出，任务已安全中断');
    }
    const pending = [...tasks.values()].map((task) => task.commandPromise).filter(Boolean);
    if (pending.length) {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise((resolveTimeout) => setTimeout(resolveTimeout, timeoutMs))
      ]);
    }
    for (const task of tasks.values()) {
      if (task.child) terminateChild(task, task.child);
    }
  };

  const hasActiveTask = (projectId) => activeByProject.has(assertProjectId(projectId));

  const withProjectIdle = async (projectId, operation) => {
    const selectedProjectId = assertProjectId(projectId);
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    if (activeByProject.has(selectedProjectId) || projectOperationLocks.has(selectedProjectId)) {
      throw new PipelineTaskRunnerError('PROJECT_TASK_BUSY', '该项目已有任务正在运行', { status: 409 });
    }
    projectOperationLocks.add(selectedProjectId);
    try {
      return await operation();
    } finally {
      projectOperationLocks.delete(selectedProjectId);
    }
  };

  return Object.freeze({ startTask, getTask, listTasks, pauseTask, shutdown, hasActiveTask, withProjectIdle });
}
