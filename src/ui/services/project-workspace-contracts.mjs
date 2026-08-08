export const PROJECT_WORKSPACE_SCHEMA_VERSION = 1;
export const PROJECT_DIRECTORY_KINDS = Object.freeze(['project', 'output']);
export const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const STORAGE_MODES = new Set(['isolated-project', 'legacy-root']);
const AVAILABILITY_STATES = new Set(['available', 'unavailable']);
const PROGRESS_MODES = new Set(['none', 'indeterminate', 'determinate']);
const SUMMARY_PHASES = new Set(['split', 'analysis', 'world-overview', 'asset-visual-specs', 'excel', 'generation', 'complete', 'waiting-generation']);
const SUMMARY_STATES = new Set(['active', 'complete', 'waiting', 'warning', 'idle']);
const SUMMARY_BATCH_MODES = new Set(['none', 'idle', 'active', 'complete', 'warning']);
const SUMMARY_BACKENDS = new Set(['none', 'builtin', 'api', 'multiple', 'unknown']);
const SCREENPLAY_STATES = new Set(['empty', 'ready', 'multiple', 'unavailable']);
export const DIRECTORY_KINDS = new Set(PROJECT_DIRECTORY_KINDS);
export const STATE_KEYS = ['schemaVersion', 'projects', 'activeProjectId', 'selectionRevision', 'views', 'projectList'];
export const VIEW_KEYS = ['snapshot', 'stale', 'error', 'batchDraft', 'requestSequence', 'refreshing'];
const PROJECT_LIST_KEYS = ['stale', 'error', 'revision'];

export class ProjectWorkspaceError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = 'ProjectWorkspaceError';
    this.code = code;
    this.cause = cause;
  }
}

export const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const ownKeys = (value) => Object.keys(value);

export const fail = (code, message, cause = null) => {
  throw new ProjectWorkspaceError(code, message, cause);
};

export const exactKeys = (value, required, optional = [], label = 'DTO') => {
  if (!isRecord(value)) fail('INVALID_RESPONSE', `${label} 必须是对象`);
  const allowed = new Set([...required, ...optional]);
  const unknown = ownKeys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length || missing.length) {
    fail(
      'INVALID_RESPONSE',
      `${label} 字段无效${missing.length ? `，缺少：${missing.join(', ')}` : ''}${unknown.length ? `，多出：${unknown.join(', ')}` : ''}`
    );
  }
};

const shortText = (value, label, { max = 160, nullable = false, empty = false } = {}) => {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || (!empty && !value.length) || value.length > max) {
    fail('INVALID_RESPONSE', `${label} 必须是${nullable ? ' null 或' : ''}长度不超过 ${max} 的字符串`);
  }
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('INVALID_RESPONSE', `${label} 含有无效空白或控制字符`);
  }
  return value;
};

const nullableText = (value, label, max = 160) => shortText(value, label, { max, nullable: true });

export const nonNegativeInteger = (value, label, { nullable = false } = {}) => {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_RESPONSE', `${label} 必须是非负安全整数${nullable ? '或 null' : ''}`);
  return value;
};

const positiveInteger = (value, label) => {
  if (!Number.isSafeInteger(value) || value <= 0) fail('INVALID_RESPONSE', `${label} 必须是正安全整数`);
  return value;
};

const nullableTimestamp = (value, label) => {
  if (value === null) return null;
  shortText(value, label, { max: 64 });
  if (!Number.isFinite(Date.parse(value))) fail('INVALID_RESPONSE', `${label} 必须是有效时间戳或 null`);
  return value;
};

const timestamp = (value, label) => {
  shortText(value, label, { max: 64 });
  if (!Number.isFinite(Date.parse(value))) fail('INVALID_RESPONSE', `${label} 必须是有效时间戳`);
  return value;
};

export const cloneDraft = (value) => {
  if (value === null || value === undefined) return value ?? null;
  try {
    if (typeof structuredClone === 'function') return structuredClone(value);
  } catch (error) {
    fail('INVALID_BATCH_DRAFT', '批次草稿必须是可复制的会话数据', error);
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    fail('INVALID_BATCH_DRAFT', '批次草稿必须是可复制的会话数据', error);
  }
};

export const deepFreeze = (value, seen = new WeakSet()) => {
  if ((!isRecord(value) && !Array.isArray(value)) || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};

export function validateProjectId(value, label = 'projectId') {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) {
    fail('INVALID_PROJECT_ID', `${label} 必须匹配 ${PROJECT_ID_PATTERN}`);
  }
  return value;
}

const validateProgress = (value, label = 'progress', { nullableNumbers = false } = {}) => {
  exactKeys(value, ['mode'], ['done', 'total', 'integrity'], label);
  if (!PROGRESS_MODES.has(value.mode)) fail('INVALID_RESPONSE', `${label}.mode 无效`);
  const hasDone = Object.hasOwn(value, 'done');
  const hasTotal = Object.hasOwn(value, 'total');
  if (value.mode === 'determinate') {
    if (!hasDone || !hasTotal) fail('INVALID_RESPONSE', `${label} 的确定进度缺少 done/total`);
    const done = nonNegativeInteger(value.done, `${label}.done`, { nullable: nullableNumbers });
    const total = nonNegativeInteger(value.total, `${label}.total`, { nullable: nullableNumbers });
    if (!nullableNumbers && done > total) fail('INVALID_RESPONSE', `${label}.done 不得大于 total`);
    if (nullableNumbers && ((done === null) !== (total === null) || (done !== null && done > total))) {
      fail('INVALID_RESPONSE', `${label}.done/total 无效`);
    }
  } else if ((hasDone && value.done !== null) || (hasTotal && value.total !== null)) {
    fail('INVALID_RESPONSE', `${label} 的非确定进度不得携带数值`);
  }
  if (Object.hasOwn(value, 'integrity') && value.integrity !== 'status-only') {
    fail('INVALID_RESPONSE', `${label}.integrity 无效`);
  }
  return {
    mode: value.mode,
    ...(hasDone ? { done: value.done } : {}),
    ...(hasTotal ? { total: value.total } : {}),
    ...(Object.hasOwn(value, 'integrity') ? { integrity: value.integrity } : {})
  };
};

const validateTask = (value, label, { scopeRequired = true, defaultScope = null } = {}) => {
  if (value === null) return null;
  const required = ['taskId', 'label', 'backend', 'startedAt', 'progress'];
  if (scopeRequired) required.splice(2, 0, 'scope');
  exactKeys(
    value,
    required,
    [...(!scopeRequired ? ['scope'] : []), 'assetId', 'assetName', 'sheetName', 'remoteStatus', 'queuePosition'],
    label
  );
  const scope = Object.hasOwn(value, 'scope')
    ? shortText(value.scope, `${label}.scope`, { max: 48 })
    : shortText(defaultScope, `${label}.scope`, { max: 48 });
  const task = {
    taskId: shortText(value.taskId, `${label}.taskId`, { max: 128 }),
    label: shortText(value.label, `${label}.label`, { max: 160 }),
    scope,
    backend: nullableText(value.backend, `${label}.backend`, 48),
    startedAt: nullableTimestamp(value.startedAt, `${label}.startedAt`),
    progress: validateProgress(value.progress, `${label}.progress`)
  };
  for (const [key, max] of [['assetId', 64], ['assetName', 128], ['sheetName', 48], ['remoteStatus', 64]]) {
    if (Object.hasOwn(value, key)) task[key] = nullableText(value[key], `${label}.${key}`, max);
  }
  if (Object.hasOwn(value, 'queuePosition')) {
    task.queuePosition = nonNegativeInteger(value.queuePosition, `${label}.queuePosition`, { nullable: true });
  }
  return task;
};

const validateStage = (value, index) => {
  const label = `snapshot.pipeline.stages[${index}]`;
  exactKeys(value, ['id', 'label', 'state', 'progress'], ['currentEpisode'], label);
  const stage = {
    id: shortText(value.id, `${label}.id`, { max: 48 }),
    label: shortText(value.label, `${label}.label`, { max: 80 }),
    state: shortText(value.state, `${label}.state`, { max: 32 }),
    progress: validateProgress(value.progress, `${label}.progress`)
  };
  if (Object.hasOwn(value, 'currentEpisode')) {
    stage.currentEpisode = nonNegativeInteger(value.currentEpisode, `${label}.currentEpisode`, { nullable: true });
  }
  return stage;
};

const validateAssetCounts = (value) => {
  exactKeys(value, ['known', 'byType'], ['total', 'worldFacts'], 'snapshot.assetCounts');
  if (typeof value.known !== 'boolean') fail('INVALID_RESPONSE', 'snapshot.assetCounts.known 必须是布尔值');
  if (!isRecord(value.byType)) fail('INVALID_RESPONSE', 'snapshot.assetCounts.byType 必须是对象');
  const allowedTypes = ['characters', 'creatures', 'crowds', 'scenes', 'props'];
  const unknownTypes = ownKeys(value.byType).filter((key) => !allowedTypes.includes(key));
  if (unknownTypes.length) fail('INVALID_RESPONSE', 'snapshot.assetCounts.byType 含未知分类');
  if (value.known && allowedTypes.some((key) => !Object.hasOwn(value.byType, key))) {
    fail('INVALID_RESPONSE', 'snapshot.assetCounts.byType 缺少资产分类');
  }
  const byType = Object.fromEntries(ownKeys(value.byType).map((key) => [
    key,
    nonNegativeInteger(value.byType[key], `snapshot.assetCounts.byType.${key}`)
  ]));
  if (value.known && !Object.hasOwn(value, 'total')) fail('INVALID_RESPONSE', '已知资产计数缺少 total');
  if (!value.known && Object.hasOwn(value, 'total') && value.total !== null) fail('INVALID_RESPONSE', '未知资产计数不得带 total');
  return {
    known: value.known,
    ...(Object.hasOwn(value, 'total') ? { total: nonNegativeInteger(value.total, 'snapshot.assetCounts.total', { nullable: true }) } : {}),
    byType,
    ...(Object.hasOwn(value, 'worldFacts') ? { worldFacts: nonNegativeInteger(value.worldFacts, 'snapshot.assetCounts.worldFacts', { nullable: true }) } : {})
  };
};

const validateScreenplay = (value) => {
  exactKeys(value, ['known', 'state', 'count', 'files', 'filename', 'label', 'truncated'], [], 'snapshot.screenplay');
  if (typeof value.known !== 'boolean' || !SCREENPLAY_STATES.has(value.state)) {
    fail('INVALID_RESPONSE', 'snapshot.screenplay 状态无效');
  }
  if (!Array.isArray(value.files) || value.files.length > 256 || typeof value.truncated !== 'boolean') {
    fail('INVALID_RESPONSE', 'snapshot.screenplay 文件列表无效');
  }
  const files = value.files.map((filename, index) => {
    const safe = shortText(filename, `snapshot.screenplay.files[${index}]`, { max: 255 });
    if (!/\.(?:txt|docx)$/iu.test(safe) || /[\\/]/u.test(safe)) {
      fail('INVALID_RESPONSE', `snapshot.screenplay.files[${index}] 不是安全的剧本文件名`);
    }
    return safe;
  });
  if (new Set(files.map((filename) => filename.toLocaleLowerCase('zh-CN'))).size !== files.length) {
    fail('INVALID_RESPONSE', 'snapshot.screenplay.files 含重复文件名');
  }
  const count = nonNegativeInteger(value.count, 'snapshot.screenplay.count', { nullable: true });
  const filename = nullableText(value.filename, 'snapshot.screenplay.filename', 255);
  const label = shortText(value.label, 'snapshot.screenplay.label', { max: 300 });
  if (filename !== (files[0] ?? null)) fail('INVALID_RESPONSE', 'snapshot.screenplay.filename 必须指向首个文件');
  if (value.truncated ? count === null || count <= files.length : count !== files.length) {
    fail('INVALID_RESPONSE', 'snapshot.screenplay.count 与文件列表不一致');
  }
  if (value.state === 'unavailable') {
    if (value.known || count !== null || files.length || filename !== null || value.truncated) {
      fail('INVALID_RESPONSE', '不可用的剧本来源不得携带已知文件');
    }
  } else {
    if (!value.known || count === null) fail('INVALID_RESPONSE', '可用的剧本来源必须携带已知计数');
    if (value.state === 'empty' && count !== 0) fail('INVALID_RESPONSE', '空剧本来源的计数必须为 0');
    if (value.state === 'ready' && count !== 1) fail('INVALID_RESPONSE', '单剧本来源的计数必须为 1');
    if (value.state === 'multiple' && count < 2) fail('INVALID_RESPONSE', '多剧本来源的计数必须至少为 2');
  }
  return { known: value.known, state: value.state, count, files, filename, label, truncated: value.truncated };
};

const validateBatchCounts = (value) => {
  exactKeys(value, ['known'], ['total', 'completed', 'active', 'retryable', 'failed', 'pending', 'finished'], 'snapshot.batch.counts');
  if (typeof value.known !== 'boolean') fail('INVALID_RESPONSE', 'snapshot.batch.counts.known 必须是布尔值');
  const numericKeys = ['total', 'completed', 'active', 'retryable', 'failed', 'pending', 'finished'];
  if (value.known && numericKeys.some((key) => !Object.hasOwn(value, key))) {
    fail('INVALID_RESPONSE', '已知批次计数缺少字段');
  }
  const result = { known: value.known };
  for (const key of numericKeys) {
    if (Object.hasOwn(value, key)) result[key] = nonNegativeInteger(value[key], `snapshot.batch.counts.${key}`);
  }
  return result;
};

const validateBatch = (value) => {
  exactKeys(
    value,
    ['scope', 'operation', 'mode', 'integrity', 'counts', 'activeTask', 'backend', 'backendCounts'],
    [],
    'snapshot.batch'
  );
  if (value.integrity !== 'status-only') fail('INVALID_RESPONSE', 'snapshot.batch.integrity 必须为 status-only');
  if (!isRecord(value.backendCounts) || ownKeys(value.backendCounts).length > 16) {
    fail('INVALID_RESPONSE', 'snapshot.batch.backendCounts 无效');
  }
  const backendCounts = {};
  for (const [key, count] of Object.entries(value.backendCounts)) {
    shortText(key, 'snapshot.batch.backendCounts key', { max: 48 });
    backendCounts[key] = nonNegativeInteger(count, `snapshot.batch.backendCounts.${key}`);
  }
  const scope = shortText(value.scope, 'snapshot.batch.scope', { max: 48 });
  return {
    scope,
    operation: nullableText(value.operation, 'snapshot.batch.operation', 48),
    mode: shortText(value.mode, 'snapshot.batch.mode', { max: 32 }),
    integrity: value.integrity,
    counts: validateBatchCounts(value.counts),
    activeTask: validateTask(value.activeTask, 'snapshot.batch.activeTask', { scopeRequired: false, defaultScope: scope }),
    backend: shortText(value.backend, 'snapshot.batch.backend', { max: 48 }),
    backendCounts
  };
};

export function validateWorkbenchSnapshot(value) {
  exactKeys(
    value,
    ['schemaVersion', 'observedAt', 'pollAfterMs', 'pipeline', 'assetCounts', 'screenplay', 'batch', 'pending', 'warnings', 'source'],
    [],
    'snapshot'
  );
  if (value.schemaVersion !== 1) fail('UNSUPPORTED_SCHEMA_VERSION', 'snapshot.schemaVersion 必须为 1');
  exactKeys(value.pipeline, ['phase', 'state', 'startedAt', 'elapsedSeconds', 'stages', 'currentTask'], [], 'snapshot.pipeline');
  if (!Array.isArray(value.pipeline.stages) || value.pipeline.stages.length !== 6) {
    fail('INVALID_RESPONSE', 'snapshot.pipeline.stages 必须包含六个阶段');
  }
  const stages = value.pipeline.stages.map(validateStage);
  const stageIds = stages.map(({ id }) => id);
  if (new Set(stageIds).size !== stageIds.length) fail('INVALID_RESPONSE', 'snapshot.pipeline.stages 的 id 必须唯一');
  exactKeys(value.pending, ['known'], ['count'], 'snapshot.pending');
  if (typeof value.pending.known !== 'boolean') fail('INVALID_RESPONSE', 'snapshot.pending.known 必须是布尔值');
  if (value.pending.known && !Object.hasOwn(value.pending, 'count')) fail('INVALID_RESPONSE', '已知待确认计数缺少 count');
  if (!Array.isArray(value.warnings) || value.warnings.length > 64) fail('INVALID_RESPONSE', 'snapshot.warnings 无效');
  const warnings = value.warnings.map((warning, index) => shortText(warning, `snapshot.warnings[${index}]`, { max: 160 }));
  exactKeys(value.source, ['mode', 'lockPresent', 'files'], [], 'snapshot.source');
  if (value.source.mode !== 'read-only-cache' || typeof value.source.lockPresent !== 'boolean' || !isRecord(value.source.files)) {
    fail('INVALID_RESPONSE', 'snapshot.source 无效');
  }
  if (ownKeys(value.source.files).length > 64) fail('INVALID_RESPONSE', 'snapshot.source.files 过多');
  const files = {};
  for (const [key, entry] of Object.entries(value.source.files)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) fail('INVALID_RESPONSE', 'snapshot.source.files key 无效');
    exactKeys(entry, ['state', 'observedAt'], [], `snapshot.source.files.${key}`);
    files[key] = {
      state: shortText(entry.state, `snapshot.source.files.${key}.state`, { max: 32 }),
      observedAt: nullableTimestamp(entry.observedAt, `snapshot.source.files.${key}.observedAt`)
    };
  }
  const snapshot = {
    schemaVersion: 1,
    observedAt: timestamp(value.observedAt, 'snapshot.observedAt'),
    pollAfterMs: positiveInteger(value.pollAfterMs, 'snapshot.pollAfterMs'),
    pipeline: {
      phase: shortText(value.pipeline.phase, 'snapshot.pipeline.phase', { max: 48 }),
      state: shortText(value.pipeline.state, 'snapshot.pipeline.state', { max: 32 }),
      startedAt: nullableTimestamp(value.pipeline.startedAt, 'snapshot.pipeline.startedAt'),
      elapsedSeconds: nonNegativeInteger(value.pipeline.elapsedSeconds, 'snapshot.pipeline.elapsedSeconds', { nullable: true }),
      stages,
      currentTask: validateTask(value.pipeline.currentTask, 'snapshot.pipeline.currentTask')
    },
    assetCounts: validateAssetCounts(value.assetCounts),
    screenplay: validateScreenplay(value.screenplay),
    batch: validateBatch(value.batch),
    pending: {
      known: value.pending.known,
      ...(Object.hasOwn(value.pending, 'count') ? { count: nonNegativeInteger(value.pending.count, 'snapshot.pending.count') } : {})
    },
    warnings,
    source: { mode: value.source.mode, lockPresent: value.source.lockPresent, files }
  };
  return deepFreeze(snapshot);
}

const validateSummaryProgress = (value, label) => {
  exactKeys(value, ['mode', 'done', 'total'], [], label);
  const progress = validateProgress(value, label, { nullableNumbers: true });
  return { mode: progress.mode, done: value.done, total: value.total };
};

export function validateProjectStatusSummary(value, label = 'statusSummary') {
  exactKeys(
    value,
    ['observedAt', 'phase', 'state', 'currentTaskLabel', 'progress', 'assetTotal', 'batch', 'warningCount'],
    [],
    label
  );
  exactKeys(value.batch, ['mode', 'backend', 'completed', 'total', 'failed'], [], `${label}.batch`);
  const result = {
    observedAt: nullableTimestamp(value.observedAt, `${label}.observedAt`),
    phase: nullableText(value.phase, `${label}.phase`, 48),
    state: nullableText(value.state, `${label}.state`, 32),
    currentTaskLabel: nullableText(value.currentTaskLabel, `${label}.currentTaskLabel`, 160),
    progress: validateSummaryProgress(value.progress, `${label}.progress`),
    assetTotal: nonNegativeInteger(value.assetTotal, `${label}.assetTotal`, { nullable: true }),
    batch: {
      mode: nullableText(value.batch.mode, `${label}.batch.mode`, 32),
      backend: nullableText(value.batch.backend, `${label}.batch.backend`, 48),
      completed: nonNegativeInteger(value.batch.completed, `${label}.batch.completed`, { nullable: true }),
      total: nonNegativeInteger(value.batch.total, `${label}.batch.total`, { nullable: true }),
      failed: nonNegativeInteger(value.batch.failed, `${label}.batch.failed`, { nullable: true })
    },
    warningCount: nonNegativeInteger(value.warningCount, `${label}.warningCount`, { nullable: true })
  };
  if (result.phase !== null && !SUMMARY_PHASES.has(result.phase)) fail('INVALID_RESPONSE', `${label}.phase 无效`);
  if (result.state !== null && !SUMMARY_STATES.has(result.state)) fail('INVALID_RESPONSE', `${label}.state 无效`);
  if (result.batch.mode !== null && !SUMMARY_BATCH_MODES.has(result.batch.mode)) fail('INVALID_RESPONSE', `${label}.batch.mode 无效`);
  if (result.batch.backend !== null && !SUMMARY_BACKENDS.has(result.batch.backend)) fail('INVALID_RESPONSE', `${label}.batch.backend 无效`);
  return deepFreeze(result);
}

const validateProjectIdentity = (value, label = 'project') => {
  exactKeys(value, ['projectId', 'displayName', 'storageMode'], [], label);
  if (!STORAGE_MODES.has(value.storageMode)) fail('INVALID_RESPONSE', `${label}.storageMode 无效`);
  return deepFreeze({
    projectId: validateProjectId(value.projectId, `${label}.projectId`),
    displayName: shortText(value.displayName, `${label}.displayName`, { max: 128 }),
    storageMode: value.storageMode
  });
};

export function validateProjectDto(value, label = 'project') {
  exactKeys(value, ['projectId', 'displayName', 'storageMode', 'availability', 'statusSummary'], [], label);
  const identity = validateProjectIdentity({
    projectId: value.projectId,
    displayName: value.displayName,
    storageMode: value.storageMode
  }, label);
  if (!AVAILABILITY_STATES.has(value.availability)) fail('INVALID_RESPONSE', `${label}.availability 无效`);
  const statusSummary = validateProjectStatusSummary(value.statusSummary, `${label}.statusSummary`);
  return deepFreeze({ ...identity, availability: value.availability, statusSummary });
}

export function validateProjectListDto(value) {
  exactKeys(value, ['schemaVersion', 'projects'], [], 'project list');
  if (value.schemaVersion !== PROJECT_WORKSPACE_SCHEMA_VERSION) {
    fail('UNSUPPORTED_SCHEMA_VERSION', `project list schemaVersion 必须为 ${PROJECT_WORKSPACE_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(value.projects) || value.projects.length > 256) fail('INVALID_RESPONSE', 'projects 必须是最多 256 项的数组');
  const projects = value.projects.map((project, index) => validateProjectDto(project, `projects[${index}]`));
  const ids = projects.map(({ projectId }) => projectId);
  if (new Set(ids).size !== ids.length) fail('INVALID_RESPONSE', 'projects 中的 projectId 必须唯一');
  return deepFreeze({ schemaVersion: PROJECT_WORKSPACE_SCHEMA_VERSION, projects });
}

export function validateProjectSnapshotDto(value) {
  exactKeys(value, ['project', 'snapshot'], [], 'project snapshot');
  return deepFreeze({
    project: validateProjectIdentity(value.project, 'project snapshot.project'),
    snapshot: validateWorkbenchSnapshot(value.snapshot)
  });
}

export const validateErrorDto = (value, label = 'error') => {
  exactKeys(value, ['code', 'message'], [], label);
  return {
    code: shortText(value.code, `${label}.code`, { max: 80 }),
    message: shortText(value.message, `${label}.message`, { max: 300 })
  };
};

export const validateProjectListState = (value) => {
  exactKeys(value, PROJECT_LIST_KEYS, [], 'workspace.projectList');
  if (typeof value.stale !== 'boolean') fail('INVALID_WORKSPACE_STATE', 'workspace.projectList.stale 必须是布尔值');
  if (value.error !== null) validateErrorDto(value.error, 'workspace.projectList.error');
  nonNegativeInteger(value.revision, 'workspace.projectList.revision');
  return value;
};

export const unwrapEnvelope = (payload, validator, label) => {
  if (!isRecord(payload) || typeof payload.ok !== 'boolean') fail('INVALID_ENVELOPE', `${label} 返回了无效信封`);
  if (payload.ok) {
    exactKeys(payload, ['ok', 'data'], [], `${label} envelope`);
    return validator(payload.data);
  }
  exactKeys(payload, ['ok', 'error'], [], `${label} envelope`);
  const error = validateErrorDto(payload.error, `${label} error`);
  fail(error.code, error.message);
};
