const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const STATUS = new Set(['ready', 'blocked', 'active']);
const BACKENDS = new Set([null, 'builtin', 'api', 'multiple', 'other']);

export class ImagegenHandoffAdapterError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = 'ImagegenHandoffAdapterError';
    this.code = code;
    this.cause = cause;
  }
}

const fail = (code, message, cause) => { throw new ImagegenHandoffAdapterError(code, message, cause); };
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const projectId = (value) => {
  if (typeof value !== 'string' || !PROJECT_ID.test(value)) fail('INVALID_PROJECT_ID', '项目编号无效');
  return value;
};
const boundedText = (value, label, max = 240) => {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail('INVALID_RESPONSE', `${label}无效`);
  return value;
};
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : fail('INVALID_RESPONSE', '队列数量无效');

const statusDto = (value) => {
  if (!exactKeys(value, [
    'version', 'projectId', 'status', 'reasonCode', 'message', 'queueEstablished',
    'presetConfigured', 'counts', 'quota', 'activeBackend'
  ])) fail('INVALID_RESPONSE', '内置出图交接状态字段无效');
  if (value.version !== 1 || !STATUS.has(value.status) || typeof value.queueEstablished !== 'boolean' || typeof value.presetConfigured !== 'boolean' || !BACKENDS.has(value.activeBackend)) {
    fail('INVALID_RESPONSE', '内置出图交接状态无效');
  }
  if (!exactKeys(value.counts, ['total', 'selected', 'unselected', 'pending', 'completed', 'failed', 'active'])) fail('INVALID_RESPONSE', '内置出图数量字段无效');
  if (!exactKeys(value.quota, ['limit', 'claimed', 'remaining'])) fail('INVALID_RESPONSE', '内置出图额度字段无效');
  const normalizedCounts = Object.fromEntries(Object.entries(value.counts).map(([key, item]) => [key, count(item)]));
  const nullableCount = (item) => item === null ? null : count(item);
  return Object.freeze({
    version: 1,
    projectId: projectId(value.projectId),
    status: value.status,
    reasonCode: boundedText(value.reasonCode, 'reasonCode', 80),
    message: boundedText(value.message, 'message'),
    queueEstablished: value.queueEstablished,
    presetConfigured: value.presetConfigured,
    counts: Object.freeze(normalizedCounts),
    quota: Object.freeze({
      limit: nullableCount(value.quota.limit),
      claimed: count(value.quota.claimed),
      remaining: nullableCount(value.quota.remaining)
    }),
    activeBackend: value.activeBackend
  });
};

const envelope = (payload, validator, label) => {
  if (!exactKeys(payload, ['ok', 'data']) || payload.ok !== true) fail('INVALID_RESPONSE', `${label}响应无效`);
  return validator(payload.data);
};

export class ImagegenHandoffAdapter {
  constructor({
    bridge = globalThis.kaDesktopBridge ?? null,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    baseUrl = ''
  } = {}) {
    this.bridge = bridge;
    this.fetchImpl = fetchImpl;
    this.baseUrl = String(baseUrl || '').replace(/\/+$/u, '');
  }

  async getStatus({ projectId: requestedProjectId }) {
    const id = projectId(requestedProjectId);
    if (typeof this.fetchImpl !== 'function') fail('HANDOFF_UNAVAILABLE', '内置出图状态接口不可用');
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/projects/${encodeURIComponent(id)}/imagegen-handoff`, {
        method: 'GET', headers: { accept: 'application/json' }
      });
    } catch (error) {
      fail('HANDOFF_NETWORK_ERROR', '读取内置出图状态失败', error);
    }
    let payload;
    try { payload = await response.json(); } catch (error) { fail('INVALID_RESPONSE', '内置出图状态不是有效 JSON', error); }
    if (!response.ok || payload?.ok === false) fail(payload?.error?.code || 'HANDOFF_STATUS_FAILED', payload?.error?.message || '读取内置出图状态失败');
    const result = envelope(payload, statusDto, '内置出图状态');
    if (result.projectId !== id) fail('PROJECT_MISMATCH', '内置出图状态不属于当前项目');
    return result;
  }

  async prepare({ projectId: requestedProjectId }) {
    const id = projectId(requestedProjectId);
    if (typeof this.bridge?.prepareBuiltinImagegen !== 'function') {
      fail('DESKTOP_REQUIRED', '请使用桌面版将队列交给 Codex 内置 ImageGen');
    }
    const payload = await this.bridge.prepareBuiltinImagegen({ projectId: id });
    if (payload?.ok === false) fail(payload.error?.code || 'HANDOFF_PREPARE_FAILED', payload.error?.message || '内置出图交接失败');
    const data = payload?.ok === true ? payload.data : payload;
    if (!exactKeys(data, ['projectId', 'copied', 'codexOpened'])
      || projectId(data.projectId) !== id
      || data.copied !== true
      || typeof data.codexOpened !== 'boolean') {
      fail('INVALID_RESPONSE', '内置出图交接回执无效');
    }
    return Object.freeze({ projectId: id, copied: true, codexOpened: data.codexOpened });
  }
}
