export class CatalogAdapterError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'CatalogAdapterError';
    this.code = code;
    this.details = details;
  }
}

const asEnvelopeData = (payload) => {
  if (payload?.ok === false) {
    throw new CatalogAdapterError(
      payload.error?.code || 'RESOLUTION_FAILED',
      payload.error?.message || 'Prompt Catalog 解析失败',
      payload.error?.details ?? null
    );
  }
  return payload?.ok === true ? payload.data : payload;
};

export function validateCatalogResult(value) {
  if (!value || typeof value !== 'object') {
    throw new CatalogAdapterError('INVALID_RESPONSE', 'Prompt Catalog 返回了无效结果');
  }
  const requiredStrings = [
    'requestedStyle', 'requestedAsset', 'style', 'asset', 'referenceMode',
    'routeId', 'status', 'referencePolicy', 'activeFieldSchema'
  ];
  for (const key of requiredStrings) {
    if (typeof value[key] !== 'string') {
      throw new CatalogAdapterError('INVALID_RESPONSE', `Prompt Catalog 缺少字段：${key}`);
    }
  }
  if (!Array.isArray(value.promptFields) || !value.promptFields.every((field) =>
    field && typeof field.label === 'string' && typeof field.value === 'string')) {
    throw new CatalogAdapterError('INVALID_RESPONSE', 'Prompt Catalog 的 promptFields 无效');
  }
  if (!Array.isArray(value.activeModifiers) || !value.fingerprints || typeof value.fingerprints !== 'object') {
    throw new CatalogAdapterError('INVALID_RESPONSE', 'Prompt Catalog 的修饰器或指纹信息无效');
  }
  const expectedCount = value.activeFieldSchema === 'withInputImages' ? 12
    : value.activeFieldSchema === 'withoutInputImages' ? 11 : 0;
  if (!expectedCount || value.promptFields.length !== expectedCount) {
    throw new CatalogAdapterError('INVALID_RESPONSE', 'Prompt Catalog 的活动字段数量与 schema 不一致');
  }
  const inputImageIndex = value.promptFields.findIndex((field) => field.label === 'Input images');
  if ((expectedCount === 12 && inputImageIndex !== 1) || (expectedCount === 11 && inputImageIndex !== -1)) {
    throw new CatalogAdapterError('INVALID_RESPONSE', 'Prompt Catalog 的 Input images 字段位置无效');
  }
  return value;
}

export function formatPromptText(result) {
  return result.promptFields.map(({ label, value }) => `${label}: ${value}`).join('\n');
}

export function makeRouteTrace(result) {
  const modifiers = result.activeModifiers.length ? result.activeModifiers.join(' + ') : 'none';
  const enhancer = result.enhancer
    ? `${result.enhancer.id} / ${result.enhancer.modifierId}`
    : 'none';
  return [
    `request/${result.requestedStyle}/${result.requestedAsset}`,
    `base/${result.routeId}`,
    `effective/${result.style}/${result.asset}`,
    `modifier/${modifiers}`,
    `enhancer/${enhancer}`,
    `schema/${result.activeFieldSchema}`
  ];
}

export function deriveResolutionReadiness(result) {
  if (result.status !== 'configured') {
    return { ready: false, code: 'ROUTE_NOT_CONFIGURED', message: result.message || '当前路由尚未配置完成' };
  }
  if (result.referenceMode === 'visual-consistency' && result.referenceCount < 2) {
    return { ready: false, code: 'INSUFFICIENT_REFERENCE_IMAGES', message: '视觉风格统一至少需要 2 张参考图' };
  }
  if (result.referenceMode === 'custom') {
    return { ready: false, code: 'CUSTOM_FIELDS_REQUIRED', message: '自定义模式仍需填写 Input images 与 Primary request' };
  }
  return { ready: true, code: 'READY', message: '正式提示词库已生成' };
}

export class CatalogResolverAdapter {
  constructor({
    bridge = globalThis.promptStudioBridge,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    resolveEndpoint = '/api/prompt/resolve',
    statusEndpoint = '/api/prompt/status',
    apiDefaultsEndpoint = '/api/prompt/api-defaults'
  } = {}) {
    this.bridge = bridge;
    this.fetchImpl = fetchImpl;
    this.resolveEndpoint = resolveEndpoint;
    this.statusEndpoint = statusEndpoint;
    this.apiDefaultsEndpoint = apiDefaultsEndpoint;
  }

  async getStatus() {
    if (typeof this.bridge?.getCatalogStatus === 'function') {
      return asEnvelopeData(await this.bridge.getCatalogStatus());
    }
    if (!this.fetchImpl || globalThis.location?.protocol === 'file:') {
      throw new CatalogAdapterError('BRIDGE_UNAVAILABLE', '请通过本地预览服务或桌面应用打开 Prompt Studio');
    }
    const response = await this.fetchImpl(this.statusEndpoint, { headers: { accept: 'application/json' } });
    const payload = await response.json().catch(() => null);
    if (!response.ok) return asEnvelopeData(payload || { ok: false });
    return asEnvelopeData(payload);
  }

  async getApiDefaultTemplates() {
    if (!this.fetchImpl || globalThis.location?.protocol === 'file:') {
      throw new CatalogAdapterError('BRIDGE_UNAVAILABLE', 'API 提示词模板只能从桌面服务读取');
    }
    const response = await this.fetchImpl(this.apiDefaultsEndpoint, { headers: { accept: 'application/json' } });
    const payload = await response.json().catch(() => null);
    const data = asEnvelopeData(payload || { ok: false });
    if (!response.ok || !data || typeof data !== 'object' || Array.isArray(data)) {
      throw new CatalogAdapterError('INVALID_RESPONSE', 'API 提示词模板读取失败');
    }
    return data;
  }

  async resolve(input) {
    let data;
    if (typeof this.bridge?.resolve === 'function') {
      data = asEnvelopeData(await this.bridge.resolve(input));
    } else {
      if (!this.fetchImpl || globalThis.location?.protocol === 'file:') {
        throw new CatalogAdapterError('BRIDGE_UNAVAILABLE', '真实 Catalog bridge 不可用；不会自动切换到 Mock');
      }
      const response = await this.fetchImpl(this.resolveEndpoint, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(input)
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) return asEnvelopeData(payload || { ok: false });
      data = asEnvelopeData(payload);
    }
    return { ...validateCatalogResult(data), source: 'catalog' };
  }
}
