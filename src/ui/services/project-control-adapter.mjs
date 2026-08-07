export const PROJECT_CONTROL_ACTIONS = Object.freeze([
  'environment-check',
  'split',
  'validate-and-build-workbook',
  'build-builtin-queue',
  'analyze-screenplay',
  'build-scoped-workbook',
  'build-world-overview',
  'complete-asset-visual-specs',
  'classify-prompt-branches',
  'finalize-after-confirmation',
  'run-full-pipeline'
]);
export const MAX_SCREENPLAY_BYTES = 200 * 1024 * 1024;

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ACTIONS = new Set(PROJECT_CONTROL_ACTIONS);
const WORKBOOK_ASSET_TYPES = new Set(['characters', 'creatures', 'extras', 'scenes', 'props']);
const STATUSES = new Set(['queued', 'running', 'pausing', 'succeeded', 'failed', 'paused']);

export class ProjectControlError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = 'ProjectControlError';
    this.code = code;
    this.cause = cause;
  }
}

const fail = (code, message, cause = null) => {
  throw new ProjectControlError(code, message, cause);
};
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, required, optional = [], label = '响应') => {
  if (!isRecord(value)) fail('INVALID_RESPONSE', `${label} 必须是对象`);
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length || unknown.length) fail('INVALID_RESPONSE', `${label} 字段不符合接口约定`);
};
const shortText = (value, label, max = 160, { nullable = false } = {}) => {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('INVALID_RESPONSE', `${label} 无效`);
  }
  return value;
};
const projectId = (value) => {
  if (typeof value !== 'string' || !PROJECT_ID.test(value)) fail('INVALID_PROJECT_ID', '项目编号无效');
  return value;
};
const taskId = (value) => {
  if (typeof value !== 'string' || !TASK_ID.test(value)) fail('INVALID_TASK_ID', '任务编号无效');
  return value;
};
const timestamp = (value, label, { nullable = false } = {}) => {
  if (nullable && value === null) return null;
  shortText(value, label, 64);
  if (!Number.isFinite(Date.parse(value))) fail('INVALID_RESPONSE', `${label} 不是有效时间`);
  return value;
};
const isSafeDisplayName = (value) => typeof value === 'string'
  && value.length >= 1
  && value.length <= 80
  && value === value.normalize('NFC')
  && value === value.trim()
  && value !== '.'
  && value !== '..'
  && !/[\u0000-\u001f\u007f<>:"/\\|?*]/u.test(value)
  && !/[. ]$/u.test(value);
const projectDto = (value) => {
  exactKeys(value, ['projectId', 'displayName', 'storageMode', 'availability'], [], 'project');
  if (
    value.storageMode !== 'isolated-project'
    || value.availability !== 'available'
    || !isSafeDisplayName(value.displayName)
  ) {
    fail('INVALID_RESPONSE', '项目必须是名称安全且可用的隔离项目');
  }
  return Object.freeze({
    projectId: projectId(value.projectId),
    displayName: value.displayName,
    storageMode: value.storageMode,
    availability: value.availability
  });
};
const deletedProjectDto = (value) => {
  exactKeys(value, ['projectId', 'deleted'], [], 'deletedProject');
  if (value.deleted !== true) fail('INVALID_RESPONSE', '删除项目回执无效');
  return Object.freeze({ projectId: projectId(value.projectId), deleted: true });
};
const screenplayDto = (value) => {
  exactKeys(value, ['projectId', 'filename', 'size'], [], 'screenplay');
  const filename = shortText(value.filename, 'filename', 180);
  if (!/\.(?:txt|docx)$/iu.test(filename) || /[\\/]/u.test(filename)) fail('INVALID_RESPONSE', '剧本文件名无效');
  if (!Number.isSafeInteger(value.size) || value.size <= 0 || value.size > MAX_SCREENPLAY_BYTES) {
    fail('INVALID_RESPONSE', '剧本大小无效');
  }
  return Object.freeze({ projectId: projectId(value.projectId), filename, size: value.size });
};
const taskDto = (value) => {
  exactKeys(value, [
    'taskId', 'projectId', 'action', 'status', 'queuedAt', 'startedAt', 'finishedAt', 'exitCode', 'log'
  ], [], 'task');
  if (!ACTIONS.has(value.action) || !STATUSES.has(value.status)) fail('INVALID_RESPONSE', '任务动作或状态无效');
  if (value.exitCode !== null && !Number.isSafeInteger(value.exitCode)) fail('INVALID_RESPONSE', '任务退出码无效');
  exactKeys(value.log, ['text', 'truncated'], [], 'task.log');
  if (typeof value.log.text !== 'string' || value.log.text.length > 100_000 || typeof value.log.truncated !== 'boolean') {
    fail('INVALID_RESPONSE', '任务日志无效');
  }
  return Object.freeze({
    taskId: taskId(value.taskId),
    projectId: projectId(value.projectId),
    action: value.action,
    status: value.status,
    queuedAt: timestamp(value.queuedAt, 'queuedAt'),
    startedAt: timestamp(value.startedAt, 'startedAt', { nullable: true }),
    finishedAt: timestamp(value.finishedAt, 'finishedAt', { nullable: true }),
    exitCode: value.exitCode,
    log: Object.freeze({ text: value.log.text, truncated: value.log.truncated })
  });
};
const taskListDto = (value) => {
  exactKeys(value, ['tasks'], [], 'taskList');
  if (!Array.isArray(value.tasks) || value.tasks.length > 2048) fail('INVALID_RESPONSE', '任务列表无效');
  return Object.freeze({ tasks: Object.freeze(value.tasks.map(taskDto)) });
};

const envelopeData = (value, validator, label) => {
  exactKeys(value, ['ok', 'data'], [], `${label} envelope`);
  if (value.ok !== true) fail('INVALID_RESPONSE', `${label} 响应信封无效`);
  return validator(value.data);
};
const normalizeBaseUrl = (value) => String(value || '').replace(/\/+$/u, '');
const defaultBridge = () => globalThis.promptStudioProjectBridge ?? globalThis.kaProjectBridge ?? null;
const asTransportError = (error, code, message) => error instanceof ProjectControlError
  ? error
  : new ProjectControlError(code, error?.message || message, error);

const displayNameInput = (value) => {
  if (typeof value !== 'string') fail('INVALID_DISPLAY_NAME', '请输入项目名称');
  const normalized = value.normalize('NFC').replace(/[\r\n\t]+/gu, ' ').trim();
  if (!isSafeDisplayName(normalized)) {
    fail('INVALID_DISPLAY_NAME', '项目名称必须为 1 到 80 个字符，且不能包含路径字符');
  }
  return normalized;
};

const screenplayInput = (file) => {
  if (!file || typeof file !== 'object') fail('INVALID_SCREENPLAY', '请选择剧本文件');
  const filename = String(file.name || '');
  if (!filename || filename.length > 180 || /[\\/\u0000-\u001f\u007f]/u.test(filename) || !/\.(?:txt|docx)$/iu.test(filename)) {
    fail('INVALID_SCREENPLAY', '只允许导入文件名安全的 TXT 或 DOCX 剧本');
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_SCREENPLAY_BYTES) {
    fail('INVALID_SCREENPLAY', '剧本必须非空且不超过 200 MiB');
  }
  return { filename, file };
};

export class ProjectControlAdapter {
  constructor({ bridge = defaultBridge(), fetchImpl = globalThis.fetch?.bind(globalThis), baseUrl = '' } = {}) {
    this.bridge = bridge;
    this.fetchImpl = fetchImpl;
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  async createProject({ displayName }) {
    const request = { displayName: displayNameInput(displayName) };
    try {
      if (typeof this.bridge?.createProject === 'function') {
        return envelopeData(await this.bridge.createProject(request), projectDto, 'createProject');
      }
      return this.requestJson('/api/projects', { method: 'POST', body: JSON.stringify(request) }, projectDto, 'createProject');
    } catch (error) {
      throw asTransportError(error, 'CREATE_PROJECT_FAILED', '新建项目失败');
    }
  }

  async renameProject({ projectId: requestedProjectId, displayName }) {
    const id = projectId(requestedProjectId);
    const normalizedName = displayNameInput(displayName);
    const request = { displayName: normalizedName };
    try {
      const result = typeof this.bridge?.renameProject === 'function'
        ? envelopeData(await this.bridge.renameProject({ projectId: id, ...request }), projectDto, 'renameProject')
        : await this.requestJson(
          `/api/projects/${encodeURIComponent(id)}`,
          { method: 'PATCH', body: JSON.stringify(request) },
          projectDto,
          'renameProject'
        );
      if (result.projectId !== id || result.displayName !== normalizedName) {
        fail('PROJECT_MISMATCH', '重命名结果与请求项目不一致');
      }
      return result;
    } catch (error) {
      throw asTransportError(error, 'RENAME_PROJECT_FAILED', '重命名项目失败');
    }
  }

  async deleteProject({ projectId: requestedProjectId }) {
    const id = projectId(requestedProjectId);
    try {
      const result = typeof this.bridge?.deleteProject === 'function'
        ? envelopeData(await this.bridge.deleteProject({ projectId: id }), deletedProjectDto, 'deleteProject')
        : await this.requestJson(
          `/api/projects/${encodeURIComponent(id)}`,
          { method: 'DELETE' },
          deletedProjectDto,
          'deleteProject'
        );
      if (result.projectId !== id) fail('PROJECT_MISMATCH', '删除结果不属于请求项目');
      return result;
    } catch (error) {
      throw asTransportError(error, 'DELETE_PROJECT_FAILED', '删除项目失败');
    }
  }

  async uploadScreenplay({ projectId: requestedProjectId, file, overwrite = false }) {
    const id = projectId(requestedProjectId);
    const source = screenplayInput(file);
    if (typeof overwrite !== 'boolean') fail('INVALID_OVERWRITE', 'overwrite 必须是布尔值');
    try {
      if (typeof this.bridge?.uploadScreenplay === 'function') {
        const result = envelopeData(
          await this.bridge.uploadScreenplay({ projectId: id, file: source.file, overwrite }),
          screenplayDto,
          'uploadScreenplay'
        );
        if (result.projectId !== id) fail('PROJECT_MISMATCH', '上传结果不属于请求项目');
        return result;
      }
      const result = await this.requestJson(
        `/api/projects/${encodeURIComponent(id)}/screenplay`,
        {
          method: 'PUT',
          headers: {
            'content-type': source.file.type || 'application/octet-stream',
            'x-ka-filename': encodeURIComponent(source.filename),
            'x-ka-overwrite': overwrite ? 'true' : 'false'
          },
          body: source.file
        },
        screenplayDto,
        'uploadScreenplay'
      );
      if (result.projectId !== id) fail('PROJECT_MISMATCH', '上传结果不属于请求项目');
      return result;
    } catch (error) {
      throw asTransportError(error, 'UPLOAD_SCREENPLAY_FAILED', '导入剧本失败');
    }
  }

  async startTask({
    projectId: requestedProjectId,
    action,
    workbookEpisodeStart,
    workbookEpisodeEnd,
    workbookAssetTypes
  }) {
    const id = projectId(requestedProjectId);
    if (!ACTIONS.has(action)) fail('INVALID_ACTION', `只允许任务：${PROJECT_CONTROL_ACTIONS.join(', ')}`);
    workbookEpisodeStart ??= null;
    workbookEpisodeEnd ??= null;
    workbookAssetTypes ??= [];
    if (!Array.isArray(workbookAssetTypes)
      || workbookAssetTypes.some((item) => !WORKBOOK_ASSET_TYPES.has(item))
      || new Set(workbookAssetTypes).size !== workbookAssetTypes.length) {
      fail('INVALID_WORKBOOK_SCOPE', '资产表类型范围无效');
    }
    if (action === 'build-scoped-workbook') {
      if (!Number.isInteger(workbookEpisodeStart) || !Number.isInteger(workbookEpisodeEnd)
        || workbookEpisodeStart < 1 || workbookEpisodeEnd > 10000
        || workbookEpisodeStart > workbookEpisodeEnd || !workbookAssetTypes.length) {
        fail('INVALID_WORKBOOK_SCOPE', '局部资产表必须指定有效的闭区间集数和至少一种资产类型');
      }
    } else if (workbookEpisodeStart !== null || workbookEpisodeEnd !== null || workbookAssetTypes.length) {
      fail('INVALID_TASK_INPUT', '只有局部资产表任务可以指定集数和资产类型');
    }
    const hasWorkbookScope = action === 'build-scoped-workbook';
    const taskInput = hasWorkbookScope
      ? { projectId: id, action, workbookEpisodeStart, workbookEpisodeEnd, workbookAssetTypes }
      : { projectId: id, action };
    const requestBody = hasWorkbookScope
      ? { action, workbookEpisodeStart, workbookEpisodeEnd, workbookAssetTypes }
      : { action };
    try {
      const result = typeof this.bridge?.startProjectTask === 'function'
        ? envelopeData(await this.bridge.startProjectTask(taskInput), taskDto, 'startProjectTask')
        : await this.requestJson(
          `/api/projects/${encodeURIComponent(id)}/tasks`,
          { method: 'POST', body: JSON.stringify(requestBody) },
          taskDto,
          'startProjectTask'
        );
      if (result.projectId !== id || result.action !== action) fail('TASK_MISMATCH', '启动结果与请求任务不一致');
      return result;
    } catch (error) {
      throw asTransportError(error, 'START_TASK_FAILED', '启动任务失败');
    }
  }

  async getTask({ projectId: requestedProjectId, taskId: requestedTaskId }) {
    const id = projectId(requestedProjectId);
    const requested = taskId(requestedTaskId);
    try {
      const result = typeof this.bridge?.getProjectTask === 'function'
        ? envelopeData(await this.bridge.getProjectTask({ projectId: id, taskId: requested }), taskDto, 'getProjectTask')
        : await this.requestJson(
          `/api/projects/${encodeURIComponent(id)}/tasks/${encodeURIComponent(requested)}`,
          { method: 'GET' },
          taskDto,
          'getProjectTask'
        );
      if (result.projectId !== id || result.taskId !== requested) fail('TASK_MISMATCH', '任务状态与请求不一致');
      return result;
    } catch (error) {
      throw asTransportError(error, 'GET_TASK_FAILED', '读取任务状态失败');
    }
  }

  async listTasks({ projectId: requestedProjectId }) {
    const id = projectId(requestedProjectId);
    try {
      const result = typeof this.bridge?.listProjectTasks === 'function'
        ? envelopeData(await this.bridge.listProjectTasks({ projectId: id }), taskListDto, 'listProjectTasks')
        : await this.requestJson(
          `/api/projects/${encodeURIComponent(id)}/tasks`,
          { method: 'GET' },
          taskListDto,
          'listProjectTasks'
        );
      if (result.tasks.some((task) => task.projectId !== id)) fail('TASK_MISMATCH', '任务列表包含其他项目');
      return result;
    } catch (error) {
      throw asTransportError(error, 'LIST_TASKS_FAILED', '读取任务列表失败');
    }
  }

  async pauseTask({ projectId: requestedProjectId, taskId: requestedTaskId }) {
    const id = projectId(requestedProjectId);
    const requested = taskId(requestedTaskId);
    try {
      const result = typeof this.bridge?.pauseProjectTask === 'function'
        ? envelopeData(await this.bridge.pauseProjectTask({ projectId: id, taskId: requested }), taskDto, 'pauseProjectTask')
        : await this.requestJson(
          `/api/projects/${encodeURIComponent(id)}/tasks/${encodeURIComponent(requested)}`,
          { method: 'DELETE' },
          taskDto,
          'pauseProjectTask'
        );
      if (result.projectId !== id || result.taskId !== requested) fail('TASK_MISMATCH', '暂停结果与请求任务不一致');
      return result;
    } catch (error) {
      throw asTransportError(error, 'PAUSE_TASK_FAILED', '暂停任务失败');
    }
  }

  async requestJson(pathname, init, validator, label) {
    if (typeof this.fetchImpl !== 'function') fail('CAPABILITY_UNAVAILABLE', '桌面接口与本地服务均不可用');
    const headers = { accept: 'application/json', ...(init.headers || {}) };
    if (typeof init.body === 'string') headers['content-type'] = 'application/json';
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${pathname}`, { ...init, headers });
    } catch (error) {
      fail('NETWORK_ERROR', `${label} 请求失败`, error);
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      fail('INVALID_RESPONSE', `${label} 未返回有效 JSON`, error);
    }
    if (!response.ok) {
      fail(payload?.error?.code || 'HTTP_ERROR', payload?.error?.message || `${label} 请求失败`);
    }
    return envelopeData(payload, validator, label);
  }
}
