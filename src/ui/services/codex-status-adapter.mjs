const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export class CodexStatusError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = 'CodexStatusError';
    this.code = code;
    this.cause = cause;
  }
}

const validateStatus = (value) => {
  if (!isRecord(value)) throw new CodexStatusError('INVALID_RESPONSE', 'Codex 状态响应无效');
  const keys = Object.keys(value).sort();
  const expected = ['authorization', 'checkedAt', 'connected', 'message', 'sdkAvailable'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new CodexStatusError('INVALID_RESPONSE', 'Codex 状态字段无效');
  }
  if (
    typeof value.connected !== 'boolean'
    || typeof value.sdkAvailable !== 'boolean'
    || !['connected', 'not_connected'].includes(value.authorization)
    || value.authorization === 'connected' !== value.connected
    || typeof value.message !== 'string'
    || value.message.length < 1
    || value.message.length > 120
    || !Number.isFinite(Date.parse(value.checkedAt))
  ) {
    throw new CodexStatusError('INVALID_RESPONSE', 'Codex 状态内容无效');
  }
  return Object.freeze({ ...value });
};

const validateLoginReceipt = (value) => {
  if (!isRecord(value)) throw new CodexStatusError('INVALID_RESPONSE', 'Codex 登录响应无效');
  const keys = Object.keys(value).sort();
  const expected = ['alreadyConnected', 'loginInProgress', 'started'];
  if (
    keys.length !== expected.length
    || keys.some((key, index) => key !== expected[index])
    || typeof value.started !== 'boolean'
    || typeof value.alreadyConnected !== 'boolean'
    || typeof value.loginInProgress !== 'boolean'
    || (value.alreadyConnected && (value.started || value.loginInProgress))
    || (value.started && !value.loginInProgress)
  ) {
    throw new CodexStatusError('INVALID_RESPONSE', 'Codex 登录响应字段无效');
  }
  return Object.freeze({ ...value });
};

export class CodexStatusAdapter {
  constructor({ fetchImpl = globalThis.fetch?.bind(globalThis), baseUrl = '' } = {}) {
    this.fetchImpl = fetchImpl;
    this.baseUrl = String(baseUrl || '').replace(/\/+$/u, '');
  }

  async getStatus() {
    return this.request('/api/codex-agent/status', { method: 'GET' }, validateStatus, 'Codex 状态检测');
  }

  async startLogin() {
    return this.request(
      '/api/codex-agent/authorize',
      { method: 'POST' },
      validateLoginReceipt,
      'Codex 登录'
    );
  }

  async request(pathname, init, validate, label) {
    if (typeof this.fetchImpl !== 'function') {
      throw new CodexStatusError('CAPABILITY_UNAVAILABLE', `${label}不可用`);
    }
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        ...init,
        headers: { accept: 'application/json' }
      });
    } catch (error) {
      throw new CodexStatusError('NETWORK_ERROR', `${label}请求失败`, error);
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new CodexStatusError('INVALID_RESPONSE', 'Codex 状态检测未返回有效 JSON', error);
    }
    if (!response.ok || payload?.ok !== true) {
      throw new CodexStatusError(
        payload?.error?.code || 'HTTP_ERROR',
        payload?.error?.message || `${label}失败`
      );
    }
    return validate(payload.data);
  }
}
