const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SESSION_ID = /^chat-[a-f0-9-]{36}$/u;
const ITEM_ID = /^(?:message|activity)-[a-f0-9-]{36}$/u;
const STATUSES = new Set(['idle', 'running', 'failed', 'cancelled']);
const ROLES = new Set(['user', 'assistant']);
const ACTIVITY_KINDS = new Set(['status', 'reasoning', 'plan', 'tool', 'network', 'error']);
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);
const PROPOSAL_ACTIONS = new Set([
  'run-full-pipeline', 'build-scoped-workbook', 'build-world-overview',
  'validate-and-build-workbook', 'build-builtin-queue', 'classify-prompt-branches',
  'pause-current-task', 'refresh-project'
]);
const WORKBOOK_ASSET_TYPES = new Set(['characters', 'creatures', 'extras', 'scenes', 'props']);

export class CodexAgentChatAdapterError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = 'CodexAgentChatAdapterError';
    this.code = code;
    this.cause = cause;
  }
}

const fail = (code, message, cause = null) => { throw new CodexAgentChatAdapterError(code, message, cause); };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, required, label) => {
  if (!isObject(value)) fail('INVALID_RESPONSE', `${label}必须是对象`);
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('INVALID_RESPONSE', `${label}字段无效`);
  }
};
const text = (value, label, maximum, { empty = false, nullable = false } = {}) => {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || (!empty && !value.length) || value.length > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    fail('INVALID_RESPONSE', `${label}无效`);
  }
  return value;
};
const timestamp = (value, label) => {
  text(value, label, 64);
  if (!Number.isFinite(Date.parse(value))) fail('INVALID_RESPONSE', `${label}无效`);
  return value;
};
const projectId = (value) => {
  if (typeof value !== 'string' || !PROJECT_ID.test(value)) fail('INVALID_PROJECT_ID', '项目编号无效');
  return value;
};
const sessionId = (value) => {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) fail('INVALID_CHAT_SESSION', 'Agent 对话编号无效');
  return value;
};

const runtimeConfigDto = (value) => {
  exactKeys(value, ['model', 'reasoningEffort', 'modelLabel', 'reasoningEffortLabel', 'source'], 'Codex 配置');
  const model = text(value.model, '模型', 128, { nullable: true });
  const reasoningEffort = text(value.reasoningEffort, '思考等级', 32, { nullable: true });
  const modelLabel = text(value.modelLabel, '模型显示名', 128);
  const reasoningEffortLabel = text(value.reasoningEffortLabel, '思考等级显示名', 32);
  if (!['local-codex-config', 'software-settings'].includes(value.source)) {
    fail('INVALID_RESPONSE', 'Codex 配置来源无效');
  }
  return Object.freeze({ model, reasoningEffort, modelLabel, reasoningEffortLabel, source: value.source });
};

const proposalDto = (value) => {
  if (value === null) return null;
  exactKeys(value, [
    'action', 'label', 'reason', 'workbookEpisodeStart', 'workbookEpisodeEnd', 'workbookAssetTypes'
  ], 'Agent 操作建议');
  if (!PROPOSAL_ACTIONS.has(value.action)) fail('INVALID_RESPONSE', 'Agent 操作建议不在白名单');
  if (!Array.isArray(value.workbookAssetTypes)
    || value.workbookAssetTypes.some((item) => !WORKBOOK_ASSET_TYPES.has(item))
    || new Set(value.workbookAssetTypes).size !== value.workbookAssetTypes.length) {
    fail('INVALID_RESPONSE', 'Agent 制表范围无效');
  }
  if (value.action === 'build-scoped-workbook') {
    if (!Number.isInteger(value.workbookEpisodeStart) || !Number.isInteger(value.workbookEpisodeEnd)
      || value.workbookEpisodeStart < 1 || value.workbookEpisodeEnd > 10000
      || value.workbookEpisodeStart > value.workbookEpisodeEnd || !value.workbookAssetTypes.length) {
      fail('INVALID_RESPONSE', 'Agent 局部表范围无效');
    }
  } else if (value.workbookEpisodeStart !== null || value.workbookEpisodeEnd !== null
    || value.workbookAssetTypes.length) {
    fail('INVALID_RESPONSE', 'Agent 操作参数无效');
  }
  return Object.freeze({
    action: value.action,
    label: text(value.label, '操作名称', 80),
    reason: text(value.reason, '操作原因', 240),
    workbookEpisodeStart: value.workbookEpisodeStart,
    workbookEpisodeEnd: value.workbookEpisodeEnd,
    workbookAssetTypes: Object.freeze([...value.workbookAssetTypes])
  });
};

const messageDto = (value) => {
  exactKeys(value, ['messageId', 'role', 'text', 'createdAt', 'proposal'], 'Agent 消息');
  if (typeof value.messageId !== 'string' || !ITEM_ID.test(value.messageId) || !ROLES.has(value.role)) {
    fail('INVALID_RESPONSE', 'Agent 消息身份无效');
  }
  if (value.role === 'user' && value.proposal !== null) fail('INVALID_RESPONSE', '用户消息不能携带操作建议');
  return Object.freeze({
    messageId: value.messageId,
    role: value.role,
    text: text(value.text, 'Agent 消息内容', 8000),
    createdAt: timestamp(value.createdAt, 'Agent 消息时间'),
    proposal: proposalDto(value.proposal)
  });
};

const activityDto = (value) => {
  exactKeys(value, ['activityId', 'kind', 'text', 'createdAt'], 'Agent 活动');
  if (typeof value.activityId !== 'string' || !ITEM_ID.test(value.activityId) || !ACTIVITY_KINDS.has(value.kind)) {
    fail('INVALID_RESPONSE', 'Agent 活动身份无效');
  }
  return Object.freeze({
    activityId: value.activityId,
    kind: value.kind,
    text: text(value.text, 'Agent 活动内容', 500),
    createdAt: timestamp(value.createdAt, 'Agent 活动时间')
  });
};

const sessionDto = (value) => {
  exactKeys(value, [
    'sessionId', 'projectId', 'status', 'createdAt', 'updatedAt', 'runtimeConfig',
    'messages', 'activities', 'error'
  ], 'Agent 对话');
  if (!STATUSES.has(value.status) || !Array.isArray(value.messages) || value.messages.length > 80
    || !Array.isArray(value.activities) || value.activities.length > 32) {
    fail('INVALID_RESPONSE', 'Agent 对话状态无效');
  }
  return Object.freeze({
    sessionId: sessionId(value.sessionId),
    projectId: projectId(value.projectId),
    status: value.status,
    createdAt: timestamp(value.createdAt, 'Agent 对话创建时间'),
    updatedAt: timestamp(value.updatedAt, 'Agent 对话更新时间'),
    runtimeConfig: runtimeConfigDto(value.runtimeConfig),
    messages: Object.freeze(value.messages.map(messageDto)),
    activities: Object.freeze(value.activities.map(activityDto)),
    error: text(value.error, 'Agent 对话错误', 500, { nullable: true })
  });
};

const envelope = (value, validator, label) => {
  exactKeys(value, ['ok', 'data'], `${label}响应`);
  if (value.ok !== true) fail('INVALID_RESPONSE', `${label}响应无效`);
  return validator(value.data);
};

export class CodexAgentChatAdapter {
  constructor({ fetchImpl = globalThis.fetch?.bind(globalThis), baseUrl = '' } = {}) {
    this.fetchImpl = fetchImpl;
    this.baseUrl = String(baseUrl || '').replace(/\/+$/u, '');
  }

  async getRuntimeConfig() {
    return this.request('/api/codex-agent/runtime-config', { method: 'GET' }, runtimeConfigDto, '读取 Codex 配置');
  }

  async updateRuntimeConfig({ model, reasoningEffort } = {}) {
    if (typeof model !== 'string' || !MODEL_NAME.test(model) || !REASONING_EFFORTS.has(reasoningEffort)) {
      fail('INVALID_CODEX_RUNTIME_CONFIG', '请选择有效的模型和思考等级');
    }
    return this.request(
      '/api/codex-agent/runtime-config',
      { method: 'PUT', body: JSON.stringify({ model, reasoningEffort }) },
      runtimeConfigDto,
      '保存 Codex 配置'
    );
  }

  async sendMessage({ projectId: requestedProjectId, sessionId: requestedSessionId = null, message }) {
    const id = projectId(requestedProjectId);
    const selectedSession = requestedSessionId === null ? null : sessionId(requestedSessionId);
    if (typeof message !== 'string' || !message.trim() || message.trim().length > 4000) {
      fail('INVALID_CHAT_MESSAGE', '请输入 1 到 4000 个字符的对话内容');
    }
    const result = await this.request(
      `/api/projects/${encodeURIComponent(id)}/agent-chat/messages`,
      { method: 'POST', body: JSON.stringify({ sessionId: selectedSession, message: message.trim() }) },
      sessionDto,
      '发送 Agent 消息'
    );
    if (result.projectId !== id || (selectedSession && result.sessionId !== selectedSession)) {
      fail('CHAT_SESSION_MISMATCH', 'Agent 对话响应不属于当前项目');
    }
    return result;
  }

  async getSession({ projectId: requestedProjectId, sessionId: requestedSessionId }) {
    const id = projectId(requestedProjectId);
    const selectedSession = sessionId(requestedSessionId);
    const result = await this.request(
      `/api/projects/${encodeURIComponent(id)}/agent-chat/sessions/${encodeURIComponent(selectedSession)}`,
      { method: 'GET' },
      sessionDto,
      '读取 Agent 对话'
    );
    if (result.projectId !== id || result.sessionId !== selectedSession) fail('CHAT_SESSION_MISMATCH', 'Agent 对话不属于当前项目');
    return result;
  }

  async cancelSession({ projectId: requestedProjectId, sessionId: requestedSessionId }) {
    const id = projectId(requestedProjectId);
    const selectedSession = sessionId(requestedSessionId);
    const result = await this.request(
      `/api/projects/${encodeURIComponent(id)}/agent-chat/sessions/${encodeURIComponent(selectedSession)}`,
      { method: 'DELETE' },
      sessionDto,
      '停止 Agent 对话'
    );
    if (result.projectId !== id || result.sessionId !== selectedSession) fail('CHAT_SESSION_MISMATCH', 'Agent 对话不属于当前项目');
    return result;
  }

  async request(pathname, init, validator, label) {
    if (typeof this.fetchImpl !== 'function') fail('CHAT_UNAVAILABLE', 'Agent 对话接口不可用');
    const headers = { accept: 'application/json', ...(init.headers || {}) };
    if (typeof init.body === 'string') headers['content-type'] = 'application/json';
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${pathname}`, { ...init, headers });
    } catch (error) {
      fail('CHAT_NETWORK_ERROR', `${label}失败`, error);
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      fail('INVALID_RESPONSE', `${label}没有返回有效 JSON`, error);
    }
    if (!response.ok) fail(payload?.error?.code || 'CHAT_HTTP_ERROR', payload?.error?.message || `${label}失败`);
    return envelope(payload, validator, label);
  }
}
