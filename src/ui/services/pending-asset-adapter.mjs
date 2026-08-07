const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const DECISIONS = new Set(['independent', 'merge', 'exclude']);
const CATEGORIES = new Set(['characters', 'creatures', 'extras', 'scenes', 'props']);

export class PendingAssetAdapterError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = 'PendingAssetAdapterError';
    this.code = code;
    this.cause = cause;
  }
}

const fail = (code, message, cause) => { throw new PendingAssetAdapterError(code, message, cause); };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const projectId = (value) => {
  if (typeof value !== 'string' || !PROJECT_ID.test(value)) fail('INVALID_PROJECT_ID', '项目编号无效');
  return value;
};
const text = (value, label, max = 32767) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail('INVALID_RESPONSE', `${label}无效`);
  return value;
};
const count = (value, label) => Number.isSafeInteger(value) && value >= 0 ? value : fail('INVALID_RESPONSE', `${label}无效`);

const validateAsset = (value, label, { requireId = false } = {}) => {
  if (!isObject(value)) fail('INVALID_RESPONSE', `${label}必须是对象`);
  for (const field of ['assetName', 'scriptSetting']) text(value[field], `${label}.${field}`);
  if (requireId) text(value.assetId, `${label}.assetId`, 96);
  if (!Array.isArray(value.aliases) || value.aliases.some((item) => typeof item !== 'string' || !item.trim())) {
    fail('INVALID_RESPONSE', `${label}.aliases无效`);
  }
  for (const field of ['firstRequiredEpisode', 'firstRequiredOrder']) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 1) fail('INVALID_RESPONSE', `${label}.${field}无效`);
  }
  return value;
};

const validateState = (value) => {
  if (!isObject(value) || value.version !== 1 || typeof value.ready !== 'boolean'
    || typeof value.analysisComplete !== 'boolean' || typeof value.overviewComplete !== 'boolean'
    || !Array.isArray(value.items) || !Array.isArray(value.targets)) {
    fail('INVALID_RESPONSE', '待确认窗口状态无效');
  }
  const id = projectId(value.projectId);
  const items = value.items.map((item, index) => {
    if (!isObject(item)) fail('INVALID_RESPONSE', `待确认项 ${index + 1} 无效`);
    text(item.pendingId, `待确认项 ${index + 1}.pendingId`, 96);
    text(item.candidate, `待确认项 ${index + 1}.candidate`);
    if (!CATEGORIES.has(item.proposedCategory)) fail('INVALID_RESPONSE', `待确认项 ${index + 1}.proposedCategory无效`);
    validateAsset(item.draftAsset, `待确认项 ${index + 1}.draftAsset`);
    if (!Array.isArray(item.conflicts)) fail('INVALID_RESPONSE', `待确认项 ${index + 1}.conflicts无效`);
    return item;
  });
  const targets = value.targets.map((target, index) => {
    if (!isObject(target) || !CATEGORIES.has(target.category)) fail('INVALID_RESPONSE', `合并目标 ${index + 1} 无效`);
    text(target.assetId, `合并目标 ${index + 1}.assetId`, 96);
    text(target.assetName, `合并目标 ${index + 1}.assetName`);
    validateAsset(target.record, `合并目标 ${index + 1}.record`, { requireId: true });
    return target;
  });
  return Object.freeze({
    version: 1,
    projectId: id,
    ready: value.ready,
    analysisComplete: value.analysisComplete,
    overviewComplete: value.overviewComplete,
    pendingCount: count(value.pendingCount, 'pendingCount'),
    decidedCount: count(value.decidedCount, 'decidedCount'),
    items: Object.freeze(items),
    targets: Object.freeze(targets)
  });
};

const validateReceipt = (value) => {
  if (!isObject(value) || value.ok !== true || typeof value.finalized !== 'boolean') {
    fail('INVALID_RESPONSE', '人工确认回执无效');
  }
  return { ...value, projectId: projectId(value.projectId) };
};

const unwrap = (payload, validator, label) => {
  if (!isObject(payload) || payload.ok !== true || !Object.hasOwn(payload, 'data')) fail('INVALID_RESPONSE', `${label}响应无效`);
  return validator(payload.data);
};

export class PendingAssetAdapter {
  constructor({ fetchImpl = globalThis.fetch?.bind(globalThis), baseUrl = '' } = {}) {
    this.fetchImpl = fetchImpl;
    this.baseUrl = String(baseUrl || '').replace(/\/+$/u, '');
  }

  async request(pathname, init, validator, label) {
    if (typeof this.fetchImpl !== 'function') fail('CAPABILITY_UNAVAILABLE', '人工确认接口不可用');
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        ...init,
        headers: {
          accept: 'application/json',
          ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {})
        }
      });
    } catch (error) {
      fail('NETWORK_ERROR', `${label}请求失败`, error);
    }
    let payload;
    try { payload = await response.json(); } catch (error) { fail('INVALID_RESPONSE', `${label}未返回有效 JSON`, error); }
    if (!response.ok) fail(payload?.error?.code || 'HTTP_ERROR', payload?.error?.message || `${label}失败`);
    return unwrap(payload, validator, label);
  }

  async getState({ projectId: requestedProjectId }) {
    const id = projectId(requestedProjectId);
    const state = await this.request(
      `/api/projects/${encodeURIComponent(id)}/pending-assets`,
      { method: 'GET' },
      validateState,
      '读取待确认资产'
    );
    if (state.projectId !== id) fail('PROJECT_MISMATCH', '待确认状态不属于当前项目');
    return state;
  }

  async resolve({ projectId: requestedProjectId, ...decision }) {
    const id = projectId(requestedProjectId);
    if (!DECISIONS.has(decision.decision)) fail('INVALID_DECISION', '人工决定无效');
    const receipt = await this.request(
      `/api/projects/${encodeURIComponent(id)}/pending-assets/resolve`,
      { method: 'POST', body: JSON.stringify(decision) },
      validateReceipt,
      '提交人工确认'
    );
    if (receipt.projectId !== id) fail('PROJECT_MISMATCH', '人工确认回执不属于当前项目');
    return receipt;
  }
}
