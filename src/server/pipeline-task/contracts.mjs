import { isAbsolute } from 'node:path';

import { ACTION_SPECS } from './action-specs.mjs';

const PROJECT_ID_PATTERN = /^(?=.{1,64}$)[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/u;
const WORKBOOK_ASSET_TYPES = Object.freeze([
  'characters', 'creatures', 'extras', 'scenes', 'props'
]);
const WORKBOOK_ASSET_TYPE_SET = new Set(WORKBOOK_ASSET_TYPES);

export const ACTIVE_STATUSES = new Set(['queued', 'running', 'pausing']);
export const DEFAULT_MAX_LOG_CHARACTERS = 16 * 1024;
export const DEFAULT_MAX_RETAINED_TASKS = 256;

export class PipelineTaskRunnerError extends Error {
  constructor(code, message, { status = 400 } = {}) {
    super(message);
    this.name = 'PipelineTaskRunnerError';
    this.code = code;
    this.status = status;
  }
}

export const samePath = (left, right) => process.platform === 'win32'
  ? left.toLowerCase() === right.toLowerCase()
  : left === right;

export const escapesRoot = (value) => value === '..'
  || value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  || isAbsolute(value);

export const isoTimestamp = (clock) => {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError('now() must return a valid date value');
  }
  return date.toISOString();
};

export const assertProjectId = (value) => {
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

export const assertStartInput = (value) => {
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
    if (!Number.isInteger(workbookEpisodeStart)
      || !Number.isInteger(workbookEpisodeEnd)
      || workbookEpisodeStart < 1
      || workbookEpisodeEnd > 10000
      || workbookEpisodeStart > workbookEpisodeEnd
      || !workbookAssetTypes.length) {
      throw new PipelineTaskRunnerError('INVALID_WORKBOOK_SCOPE', '局部资产表集数或类型范围无效');
    }
  } else if (workbookEpisodeStart !== null
    || workbookEpisodeEnd !== null
    || workbookAssetTypes.length) {
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

export const boundedInteger = (value, fallback, minimum, maximum, label) => {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return candidate;
};

const SAFE_ENVIRONMENT_KEYS = Object.freeze([
  'ALLUSERSPROFILE', 'APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMDRIVE', 'SYSTEMROOT',
  'TEMP', 'TMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'
]);

export const safeChildEnvironment = (source) => Object.fromEntries(
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

export const publicTask = (task, maxLogCharacters) => {
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

export const attachOutput = (stream, append) => {
  if (!stream || typeof stream.on !== 'function') return;
  if (typeof stream.setEncoding === 'function') stream.setEncoding('utf8');
  stream.on('data', append);
};
