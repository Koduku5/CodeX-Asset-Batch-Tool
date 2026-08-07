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
const DIRECTORY_KINDS = new Set(PROJECT_DIRECTORY_KINDS);
const STATE_KEYS = ['schemaVersion', 'projects', 'activeProjectId', 'selectionRevision', 'views', 'projectList'];
const VIEW_KEYS = ['snapshot', 'stale', 'error', 'batchDraft', 'requestSequence', 'refreshing'];
const PROJECT_LIST_KEYS = ['stale', 'error', 'revision'];

export class ProjectWorkspaceError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = 'ProjectWorkspaceError';
    this.code = code;
    this.cause = cause;
  }
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const ownKeys = (value) => Object.keys(value);

const fail = (code, message, cause = null) => {
  throw new ProjectWorkspaceError(code, message, cause);
};

const exactKeys = (value, required, optional = [], label = 'DTO') => {
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

const nonNegativeInteger = (value, label, { nullable = false } = {}) => {
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

const cloneDraft = (value) => {
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

const deepFreeze = (value, seen = new WeakSet()) => {
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

const validateErrorDto = (value, label = 'error') => {
  exactKeys(value, ['code', 'message'], [], label);
  return {
    code: shortText(value.code, `${label}.code`, { max: 80 }),
    message: shortText(value.message, `${label}.message`, { max: 300 })
  };
};

const validateProjectListState = (value) => {
  exactKeys(value, PROJECT_LIST_KEYS, [], 'workspace.projectList');
  if (typeof value.stale !== 'boolean') fail('INVALID_WORKSPACE_STATE', 'workspace.projectList.stale 必须是布尔值');
  if (value.error !== null) validateErrorDto(value.error, 'workspace.projectList.error');
  nonNegativeInteger(value.revision, 'workspace.projectList.revision');
  return value;
};

const unwrapEnvelope = (payload, validator, label) => {
  if (!isRecord(payload) || typeof payload.ok !== 'boolean') fail('INVALID_ENVELOPE', `${label} 返回了无效信封`);
  if (payload.ok) {
    exactKeys(payload, ['ok', 'data'], [], `${label} envelope`);
    return validator(payload.data);
  }
  exactKeys(payload, ['ok', 'error'], [], `${label} envelope`);
  const error = validateErrorDto(payload.error, `${label} error`);
  fail(error.code, error.message);
};

const defaultView = () => deepFreeze({
  snapshot: null,
  stale: true,
  error: null,
  batchDraft: null,
  requestSequence: 0,
  refreshing: false
});

const validateView = (value, label) => {
  exactKeys(value, VIEW_KEYS, [], label);
  if (typeof value.stale !== 'boolean' || typeof value.refreshing !== 'boolean') fail('INVALID_WORKSPACE_STATE', `${label} 状态无效`);
  return value;
};

const validateWorkspaceState = (state) => {
  exactKeys(state, STATE_KEYS, [], 'workspace state');
  if (state.schemaVersion !== PROJECT_WORKSPACE_SCHEMA_VERSION || !Array.isArray(state.projects) || !isRecord(state.views)) {
    fail('INVALID_WORKSPACE_STATE', 'workspace state 无效');
  }
  if (state.activeProjectId !== null) validateProjectId(state.activeProjectId, 'workspace.activeProjectId');
  nonNegativeInteger(state.selectionRevision, 'workspace.selectionRevision');
  validateProjectListState(state.projectList);
  for (const project of state.projects) {
    validateProjectId(project.projectId);
    validateView(state.views[project.projectId], `workspace.views.${project.projectId}`);
  }
  return state;
};

const makeState = ({ projects, activeProjectId, selectionRevision, views, projectList }) => deepFreeze({
  schemaVersion: PROJECT_WORKSPACE_SCHEMA_VERSION,
  projects: [...projects],
  activeProjectId,
  selectionRevision,
  views: { ...views },
  projectList: { ...projectList }
});

const resolveActiveId = (projects, candidate) => {
  if (typeof candidate === 'string' && PROJECT_ID_PATTERN.test(candidate) && projects.some(({ projectId }) => projectId === candidate)) {
    return candidate;
  }
  return projects[0]?.projectId ?? null;
};

export function createWorkspaceState({
  projects = [],
  activeProjectId = null,
  selectionRevision = 0
} = {}) {
  const validated = validateProjectListDto({ schemaVersion: PROJECT_WORKSPACE_SCHEMA_VERSION, projects }).projects;
  nonNegativeInteger(selectionRevision, 'selectionRevision');
  const active = resolveActiveId(validated, activeProjectId);
  const views = Object.fromEntries(validated.map(({ projectId }) => [projectId, defaultView()]));
  return makeState({
    projects: validated,
    activeProjectId: active,
    selectionRevision,
    views,
    projectList: { stale: false, error: null, revision: 0 }
  });
}

export function replaceProjects(state, projects) {
  validateWorkspaceState(state);
  const validated = validateProjectListDto({ schemaVersion: PROJECT_WORKSPACE_SCHEMA_VERSION, projects }).projects;
  const activeProjectId = resolveActiveId(validated, state.activeProjectId);
  const views = Object.fromEntries(validated.map(({ projectId }) => [projectId, state.views[projectId] ?? defaultView()]));
  return makeState({
    projects: validated,
    activeProjectId,
    selectionRevision: state.selectionRevision + (activeProjectId !== state.activeProjectId ? 1 : 0),
    views,
    projectList: { stale: false, error: null, revision: state.projectList.revision + 1 }
  });
}

export function failProjectListRequest(state, error) {
  validateWorkspaceState(state);
  const normalized = validateErrorDto(error instanceof ProjectWorkspaceError
    ? { code: error.code, message: error.message }
    : { code: 'PROJECT_LIST_UNAVAILABLE', message: error?.message || '项目列表不可用' }, 'project list error');
  return makeState({
    projects: state.projects,
    activeProjectId: state.activeProjectId,
    selectionRevision: state.selectionRevision,
    views: state.views,
    projectList: { ...state.projectList, stale: true, error: normalized }
  });
}

export function selectProject(state, projectId) {
  validateWorkspaceState(state);
  validateProjectId(projectId);
  const activeProjectId = resolveActiveId(state.projects, projectId);
  return makeState({
    projects: state.projects,
    activeProjectId,
    selectionRevision: state.selectionRevision + (activeProjectId !== state.activeProjectId ? 1 : 0),
    views: state.views,
    projectList: state.projectList
  });
}

export function updateProjectViewState(state, projectId, patch) {
  validateWorkspaceState(state);
  validateProjectId(projectId);
  if (!state.projects.some((project) => project.projectId === projectId)) fail('PROJECT_NOT_FOUND', `项目不存在：${projectId}`);
  const allowed = new Set(VIEW_KEYS);
  if (!isRecord(patch) || ownKeys(patch).some((key) => !allowed.has(key))) {
    fail('INVALID_VIEW_PATCH', '项目视图 patch 含有未知字段');
  }
  const current = state.views[projectId];
  const touchesRequest = Object.hasOwn(patch, 'snapshot') || Object.hasOwn(patch, 'error') || Object.hasOwn(patch, 'stale');
  const requestSequence = Object.hasOwn(patch, 'requestSequence')
    ? nonNegativeInteger(patch.requestSequence, 'requestSequence')
    : touchesRequest ? current.requestSequence + 1 : current.requestSequence;
  if (requestSequence < current.requestSequence) {
    return makeState({ projects: state.projects, activeProjectId: state.activeProjectId, selectionRevision: state.selectionRevision, views: state.views, projectList: state.projectList });
  }
  const next = {
    ...current,
    requestSequence,
    ...(Object.hasOwn(patch, 'snapshot') ? { snapshot: patch.snapshot === null ? null : validateWorkbenchSnapshot(patch.snapshot) } : {}),
    ...(Object.hasOwn(patch, 'stale') ? { stale: Boolean(patch.stale) } : {}),
    ...(Object.hasOwn(patch, 'error') ? { error: patch.error === null ? null : validateErrorDto(patch.error, 'view.error') } : {}),
    ...(Object.hasOwn(patch, 'batchDraft') ? { batchDraft: cloneDraft(patch.batchDraft) } : {}),
    ...(Object.hasOwn(patch, 'refreshing') ? { refreshing: Boolean(patch.refreshing) } : {})
  };
  if (Object.hasOwn(patch, 'snapshot') && patch.snapshot !== null) {
    if (!Object.hasOwn(patch, 'stale')) next.stale = false;
    if (!Object.hasOwn(patch, 'error')) next.error = null;
  }
  return makeState({
    projects: state.projects,
    activeProjectId: state.activeProjectId,
    selectionRevision: state.selectionRevision,
    views: { ...state.views, [projectId]: deepFreeze(next) },
    projectList: state.projectList
  });
}

export function beginProjectSnapshotRequest(state, projectId) {
  validateWorkspaceState(state);
  const current = state.views[validateProjectId(projectId)];
  if (!current) fail('PROJECT_NOT_FOUND', `项目不存在：${projectId}`);
  const requestSequence = current.requestSequence + 1;
  const nextState = updateProjectViewState(state, projectId, { requestSequence, refreshing: true });
  return deepFreeze({
    state: nextState,
    request: { projectId, requestSequence, selectionRevision: state.selectionRevision }
  });
}

const validateRequestToken = (request) => {
  exactKeys(request, ['projectId', 'requestSequence', 'selectionRevision'], [], 'snapshot request token');
  return {
    projectId: validateProjectId(request.projectId),
    requestSequence: nonNegativeInteger(request.requestSequence, 'requestSequence'),
    selectionRevision: nonNegativeInteger(request.selectionRevision, 'selectionRevision')
  };
};

export function completeProjectSnapshotRequest(state, request, result) {
  const token = validateRequestToken(request);
  const data = result?.project && result?.snapshot
    ? validateProjectSnapshotDto({ project: result.project, snapshot: result.snapshot })
    : fail('INVALID_RESPONSE', '项目快照结果无效');
  if (data.project.projectId !== token.projectId) fail('PROJECT_MISMATCH', '项目快照与请求项目不一致');
  return updateProjectViewState(state, token.projectId, {
    requestSequence: token.requestSequence,
    snapshot: data.snapshot,
    stale: false,
    error: null,
    refreshing: false
  });
}

export function failProjectSnapshotRequest(state, request, error) {
  const token = validateRequestToken(request);
  const normalized = error instanceof ProjectWorkspaceError
    ? { code: error.code, message: error.message }
    : { code: 'SNAPSHOT_UNAVAILABLE', message: error?.message || '项目快照不可用' };
  return updateProjectViewState(state, token.projectId, {
    requestSequence: token.requestSequence,
    stale: true,
    error: normalized,
    refreshing: false
  });
}

export function getActiveProject(state) {
  validateWorkspaceState(state);
  const project = state.projects.find(({ projectId }) => projectId === state.activeProjectId);
  return project ? deepFreeze({ ...project, view: state.views[project.projectId] }) : null;
}

const emptySummary = () => ({
  observedAt: null,
  phase: null,
  state: null,
  currentTaskLabel: null,
  progress: { mode: 'none', done: null, total: null },
  assetTotal: null,
  batch: { mode: null, backend: null, completed: null, total: null, failed: null },
  warningCount: null
});

const stageForPhase = (snapshot) => {
  const phase = snapshot.pipeline.phase;
  const mapped = phase === 'waiting-generation' || phase === 'complete' ? 'generation' : phase;
  return snapshot.pipeline.stages.find(({ id }) => id === mapped)
    ?? snapshot.pipeline.stages.find(({ state }) => state === 'active')
    ?? null;
};

export function summarizeProject(projectOrSnapshot) {
  if (projectOrSnapshot?.statusSummary !== undefined && projectOrSnapshot?.projectId) {
    return validateProjectDto(projectOrSnapshot).statusSummary ?? deepFreeze(emptySummary());
  }
  const candidate = projectOrSnapshot?.snapshot ?? projectOrSnapshot;
  if (candidate === null || candidate === undefined) return deepFreeze(emptySummary());
  const snapshot = validateWorkbenchSnapshot(candidate);
  const stage = stageForPhase(snapshot);
  const progress = stage?.progress ?? { mode: 'none' };
  const counts = snapshot.batch.counts;
  return deepFreeze({
    observedAt: snapshot.observedAt,
    phase: snapshot.pipeline.phase,
    state: snapshot.pipeline.state,
    currentTaskLabel: snapshot.pipeline.currentTask?.label ?? null,
    progress: {
      mode: progress.mode,
      done: progress.mode === 'determinate' ? progress.done : null,
      total: progress.mode === 'determinate' ? progress.total : null
    },
    assetTotal: snapshot.assetCounts.known ? snapshot.assetCounts.total : null,
    batch: {
      mode: snapshot.batch.mode,
      backend: snapshot.batch.backend,
      completed: counts.known ? counts.completed : null,
      total: counts.known ? counts.total : null,
      failed: counts.known ? counts.failed : null
    },
    warningCount: snapshot.warnings.length
  });
}

export function deriveProjectStatus(state, projectId) {
  validateWorkspaceState(state);
  const id = validateProjectId(projectId);
  const project = state.projects.find((candidate) => candidate.projectId === id);
  if (!project) fail('PROJECT_NOT_FOUND', `项目不存在：${id}`);
  const view = state.views[id];
  const useSnapshot = id === state.activeProjectId && view.snapshot !== null;
  return deepFreeze({
    summary: useSnapshot ? summarizeProject(view.snapshot) : project.statusSummary,
    stale: useSnapshot ? view.stale : state.projectList.stale,
    error: useSnapshot ? view.error : state.projectList.error,
    source: useSnapshot ? 'snapshot' : 'project-list'
  });
}

const generationEntries = (value) => {
  if (value?.schemaVersion === PROJECT_WORKSPACE_SCHEMA_VERSION && Array.isArray(value.projects) && isRecord(value.views)) {
    validateWorkspaceState(value);
    return value.projects.map((project) => {
      const status = deriveProjectStatus(value, project.projectId);
      return {
        projectId: project.projectId,
        displayName: project.displayName,
        availability: project.availability,
        stale: status.stale,
        error: status.error,
        summary: status.summary
      };
    });
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (item?.projectId && item?.statusSummary !== undefined) {
        const project = validateProjectDto(item, `projects[${index}]`);
        return { ...project, stale: false, error: null, summary: project.statusSummary };
      }
      return { projectId: null, displayName: null, availability: 'available', stale: false, error: null, summary: summarizeProject(item) };
    });
  }
  return [{ projectId: null, displayName: null, availability: 'available', stale: false, error: null, summary: summarizeProject(value) }];
};

export function deriveGenerationGate(value) {
  const entries = generationEntries(value);
  const listUnavailable = value?.schemaVersion === PROJECT_WORKSPACE_SCHEMA_VERSION
    && Array.isArray(value.projects)
    && isRecord(value.views)
    && (value.projectList.stale || value.projectList.error !== null);
  const active = entries.filter(({ summary }) => summary?.batch?.mode === 'active');
  const conflicts = entries.filter(({ summary }) => summary?.batch?.mode === 'warning' || summary?.batch?.backend === 'multiple');
  const unavailable = entries.filter(({ availability, stale, error, summary }) => availability === 'unavailable' || stale || error || !summary);
  let result;
  if (active.length > 1) {
    result = { state: 'active', code: 'CONCURRENT_GENERATION_ACTIVE', message: `${active.length} 个项目正在并行出图`, projectId: null, backend: 'multiple' };
  } else if (conflicts.length) {
    result = { state: 'error', code: 'GENERATION_STATE_CONFLICT', message: '出图通道状态冲突，需要先检查后台任务', projectId: conflicts[0].projectId, backend: conflicts[0].summary?.batch?.backend ?? null };
  } else if (active.length === 1) {
    const item = active[0];
    result = {
      state: 'active',
      code: 'GENERATION_ACTIVE',
      message: `${item.displayName || '当前项目'}正在出图`,
      projectId: item.projectId,
      backend: item.summary.batch.backend
    };
  } else if (listUnavailable) {
    result = { state: 'unknown', code: 'GENERATION_STATE_UNKNOWN', message: '项目列表状态已过期，无法确认并行任务状态', projectId: null, backend: null };
  } else if (!entries.length || unavailable.length === entries.length) {
    result = { state: 'unknown', code: 'GENERATION_STATE_UNKNOWN', message: '尚不能确认项目出图状态', projectId: null, backend: null };
  } else if (unavailable.length) {
    result = { state: 'warning', code: 'PROJECT_STATUS_INCOMPLETE', message: '部分项目状态不可用，并行任务统计可能不完整', projectId: unavailable[0].projectId, backend: null };
  } else {
    result = { state: 'idle', code: 'GENERATION_IDLE', message: '当前没有项目正在出图', projectId: null, backend: null };
  }
  return deepFreeze({ ...result, readOnly: true });
}

const defaultBridge = () => globalThis.window?.kaDesktopBridge ?? globalThis.kaDesktopBridge;

const normalizeBaseUrl = (value) => {
  if (typeof value !== 'string' || /[\r\n]/u.test(value)) throw new TypeError('baseUrl must be a string without control characters');
  return value.replace(/\/+$/u, '');
};

const validateSelectionInput = (value) => {
  exactKeys(value, ['projectId', 'expectedRevision'], [], 'selectProject input');
  return {
    projectId: validateProjectId(value.projectId),
    expectedRevision: nonNegativeInteger(value.expectedRevision, 'expectedRevision')
  };
};

const validateSelectionResult = (value, request) => {
  exactKeys(value, ['projectId', 'selectionRevision'], [], 'selectProject result');
  const result = {
    projectId: validateProjectId(value.projectId),
    selectionRevision: nonNegativeInteger(value.selectionRevision, 'selectionRevision')
  };
  if (result.projectId !== request.projectId || result.selectionRevision !== request.expectedRevision + 1) {
    fail('INVALID_RESPONSE', 'selectProject 返回的项目或版本不匹配');
  }
  return deepFreeze(result);
};

const validateOpenInput = (value) => {
  exactKeys(value, ['projectId', 'kind'], [], 'openProjectDirectory input');
  const projectId = validateProjectId(value.projectId);
  if (!DIRECTORY_KINDS.has(value.kind)) fail('INVALID_DIRECTORY_KIND', `kind 只允许：${PROJECT_DIRECTORY_KINDS.join(', ')}`);
  return { projectId, kind: value.kind };
};

const validateOpenResult = (value, request) => {
  exactKeys(value, ['projectId', 'kind', 'opened'], [], 'openProjectDirectory result');
  if (typeof value.opened !== 'boolean' || value.projectId !== request.projectId || value.kind !== request.kind) {
    fail('INVALID_RESPONSE', 'openProjectDirectory 返回的项目或目录类型不匹配');
  }
  return deepFreeze({ projectId: validateProjectId(value.projectId), kind: value.kind, opened: value.opened });
};

const asTransportError = (error, fallbackCode, fallbackMessage) => error instanceof ProjectWorkspaceError
  ? error
  : new ProjectWorkspaceError(fallbackCode, error?.message || fallbackMessage, error);

export class ProjectWorkspaceAdapter {
  constructor({
    bridge = defaultBridge(),
    fetchImpl = globalThis.fetch?.bind(globalThis),
    baseUrl = ''
  } = {}) {
    this.bridge = bridge;
    this.fetchImpl = fetchImpl;
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  async listProjects() {
    try {
      if (typeof this.bridge?.listProjects === 'function') {
        const data = unwrapEnvelope(await this.bridge.listProjects(), validateProjectListDto, 'listProjects');
        return deepFreeze({ ...data, source: 'desktop-bridge' });
      }
      const data = await this.getJson('/api/projects', validateProjectListDto, 'listProjects');
      return deepFreeze({ ...data, source: 'http' });
    } catch (error) {
      throw asTransportError(error, 'PROJECT_LIST_UNAVAILABLE', '项目列表不可用');
    }
  }

  async getSnapshot(input) {
    exactKeys(input, ['projectId'], ['selectionRevision'], 'getSnapshot input');
    const projectId = validateProjectId(input.projectId);
    const selectionRevision = Object.hasOwn(input, 'selectionRevision')
      ? nonNegativeInteger(input.selectionRevision, 'selectionRevision')
      : undefined;
    try {
      if (typeof this.bridge?.getWorkbenchSnapshot === 'function') {
        const request = { projectId, ...(selectionRevision !== undefined ? { selectionRevision } : {}) };
        const data = unwrapEnvelope(
          await this.bridge.getWorkbenchSnapshot(request),
          validateProjectSnapshotDto,
          'getWorkbenchSnapshot'
        );
        if (data.project.projectId !== projectId) fail('PROJECT_MISMATCH', '快照项目与请求项目不一致');
        return deepFreeze({ ...data, source: 'desktop-bridge' });
      }
      const data = await this.getJson(
        `/api/projects/${encodeURIComponent(projectId)}/workbench/snapshot`,
        validateProjectSnapshotDto,
        'getWorkbenchSnapshot'
      );
      if (data.project.projectId !== projectId) fail('PROJECT_MISMATCH', '快照项目与请求项目不一致');
      return deepFreeze({ ...data, source: 'http' });
    } catch (error) {
      throw asTransportError(error, 'SNAPSHOT_UNAVAILABLE', '项目快照不可用');
    }
  }

  async selectProject(input) {
    const request = validateSelectionInput(input);
    if (typeof this.bridge?.selectProject !== 'function') {
      fail('CAPABILITY_UNAVAILABLE', '当前只读 HTTP 模式不支持写入项目选择');
    }
    try {
      const data = unwrapEnvelope(
        await this.bridge.selectProject(request),
        (value) => validateSelectionResult(value, request),
        'selectProject'
      );
      return deepFreeze({ ...data, source: 'desktop-bridge' });
    } catch (error) {
      throw asTransportError(error, 'PROJECT_SELECTION_FAILED', '项目选择失败');
    }
  }

  async openProjectDirectory(input) {
    const request = validateOpenInput(input);
    if (typeof this.bridge?.openProjectDirectory !== 'function') {
      fail('CAPABILITY_UNAVAILABLE', '当前只读 HTTP 模式不支持打开本地目录');
    }
    try {
      const data = unwrapEnvelope(
        await this.bridge.openProjectDirectory(request),
        (value) => validateOpenResult(value, request),
        'openProjectDirectory'
      );
      return deepFreeze({ ...data, source: 'desktop-bridge' });
    } catch (error) {
      throw asTransportError(error, 'OPEN_DIRECTORY_FAILED', '打开目录失败');
    }
  }

  async getJson(pathname, validator, label) {
    if (typeof this.fetchImpl !== 'function') fail('CAPABILITY_UNAVAILABLE', '桌面 bridge 与只读 HTTP 均不可用');
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method: 'GET',
        headers: { accept: 'application/json' }
      });
    } catch (error) {
      fail('NETWORK_ERROR', `${label} 请求失败`, error);
    }
    if (!response || typeof response.ok !== 'boolean' || typeof response.json !== 'function') {
      fail('INVALID_RESPONSE', `${label} HTTP 响应无效`);
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      fail('INVALID_RESPONSE', `${label} 未返回有效 JSON`, error);
    }
    if (!response.ok && payload?.ok === true) fail('INVALID_ENVELOPE', `${label} 的 HTTP 状态与信封冲突`);
    return unwrapEnvelope(payload, validator, label);
  }
}
