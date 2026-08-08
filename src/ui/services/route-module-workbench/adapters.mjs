import {
  RouteModuleError,
  normalizeRouteModule,
  validateRouteModule,
} from './core.mjs';

const envelopeData = (value) => {
  if (value?.ok === false) {
    const error = value.error || {};
    throw new RouteModuleError(error.code || 'ADMIN_BRIDGE_FAILED', error.message || '正式提示词库管理接口返回失败', error.details || null);
  }
  return value?.ok === true ? value.data : value;
};

export class RouteClassifierAdapter {
  constructor({ bridge = globalThis.promptStudioClassifierBridge } = {}) {
    this.bridge = bridge;
  }

  getCapabilities() {
    return { classify: typeof this.bridge?.classifyConditionModule === 'function' };
  }

  async classify(request) {
    if (!this.getCapabilities().classify) {
      throw new RouteModuleError('CLASSIFIER_BRIDGE_UNAVAILABLE', '自动判断接口尚未接入；可以展开“开发调试”模拟 Agent 回执');
    }
    const raw = await this.bridge.classifyConditionModule(request);
    if (raw?.ok === false) {
      const error = raw.error || {};
      throw new RouteModuleError(error.code || 'CLASSIFICATION_FAILED', error.message || 'Agent 判断失败', error.details || null);
    }
    const receipt = raw?.ok === true ? raw.data : raw;
    if (!receipt || !Object.hasOwn(receipt, 'selectedId') || (receipt.selectedId !== null && typeof receipt.selectedId !== 'string')) {
      throw new RouteModuleError('INVALID_CLASSIFICATION_RECEIPT', 'Agent 回执必须明确返回分支唯一 ID 或“不命中”');
    }
    const selectedId = receipt.selectedId === null ? null : receipt.selectedId.trim();
    if (selectedId !== null && (!selectedId || !request?.candidates?.some(({ id }) => id === selectedId))) {
      throw new RouteModuleError('CLASSIFICATION_OUT_OF_SCOPE', 'Agent 返回了本次候选范围之外的分支');
    }
    return {
      source: 'core-bridge',
      selectedId,
      reason: typeof receipt.reason === 'string' ? receipt.reason.trim() : ''
    };
  }
}

export class RouteModuleAdminAdapter {
  constructor({
    bridge = globalThis.promptStudioAdminBridge,
    fetchImpl = typeof globalThis.window === 'object' ? globalThis.fetch?.bind(globalThis) : null,
    baseUrl = ''
  } = {}) {
    this.bridge = bridge;
    this.fetchImpl = fetchImpl;
    this.baseUrl = String(baseUrl || '').replace(/\/+$/u, '');
  }

  getCapabilities() {
    const http = typeof this.fetchImpl === 'function';
    return {
      validate: typeof this.bridge?.validateConditionModule === 'function' || http,
      save: typeof this.bridge?.saveConditionModule === 'function' || http,
      importPackage: typeof this.bridge?.importConditionModulePackage === 'function',
      remove: typeof this.bridge?.deleteConditionModule === 'function' || http
    };
  }

  async request(pathname, init, label) {
    if (typeof this.fetchImpl !== 'function') throw new RouteModuleError('WRITE_BRIDGE_UNAVAILABLE', '正式提示词库管理接口尚未接入');
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        ...init,
        headers: { accept: 'application/json', 'content-type': 'application/json', ...(init.headers || {}) }
      });
    } catch (error) {
      throw new RouteModuleError('REGISTRY_NETWORK_ERROR', `${label}请求失败`, { cause: error });
    }
    let payload;
    try { payload = await response.json(); } catch {
      throw new RouteModuleError('INVALID_REGISTRY_RESPONSE', `${label}未返回有效 JSON`);
    }
    if (!response.ok || payload?.ok === false) {
      throw new RouteModuleError(payload?.error?.code || 'REGISTRY_REQUEST_FAILED', payload?.error?.message || `${label}失败`);
    }
    return envelopeData(payload);
  }

  async validate(module) {
    const local = validateRouteModule(module);
    if (!local.valid || !this.getCapabilities().validate) return { source: 'local-validation', ...local };
    const remote = typeof this.bridge?.validateConditionModule === 'function'
      ? envelopeData(await this.bridge.validateConditionModule(local.module))
      : await this.request(
        '/api/prompt/condition-modules/validate',
        { method: 'POST', body: JSON.stringify({ module: local.module }) },
        '正式分支校验'
      );
    return { source: 'core-bridge', local, remote };
  }

  async save(module, options = {}) {
    if (!this.getCapabilities().save) throw new RouteModuleError('WRITE_BRIDGE_UNAVAILABLE', '正式注册表写接口尚未接入；当前只能保留会话草稿或导出模块包');
    const normalized = normalizeRouteModule(module);
    return typeof this.bridge?.saveConditionModule === 'function'
      ? envelopeData(await this.bridge.saveConditionModule(normalized, options))
      : this.request(
        `/api/prompt/condition-modules/${encodeURIComponent(normalized.id)}`,
        {
          method: 'PUT',
          body: JSON.stringify({ module: normalized, expectedCatalogFingerprint: options.expectedCatalogFingerprint })
        },
        '保存正式分支'
      );
  }

  async remove(id, options = {}) {
    const normalizedId = String(id || '').trim();
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalizedId)) throw new RouteModuleError('INVALID_MODULE_ID', '正式分支编号无效，不能执行删除');
    if (!this.getCapabilities().remove) throw new RouteModuleError('DELETE_BRIDGE_UNAVAILABLE', '正式提示词库删除接口尚未接入；当前只能删除会话草稿或移出多人合并区中的文件');
    const expectedCatalogFingerprint = String(options?.expectedCatalogFingerprint || '').trim();
    if (!expectedCatalogFingerprint) throw new RouteModuleError('CATALOG_FINGERPRINT_REQUIRED', '尚未取得正式提示词库版本，不能执行删除');
    const result = typeof this.bridge?.deleteConditionModule === 'function'
      ? envelopeData(await this.bridge.deleteConditionModule(normalizedId, { ...options, expectedCatalogFingerprint }))
      : await this.request(
        `/api/prompt/condition-modules/${encodeURIComponent(normalizedId)}`,
        { method: 'DELETE', body: JSON.stringify({ expectedCatalogFingerprint }) },
        '删除正式分支'
      );
    if (typeof result?.deleted === 'string' && result.deleted !== normalizedId) {
      throw new RouteModuleError('DELETE_TARGET_MISMATCH', '正式提示词库返回的删除目标与当前分支不一致');
    }
    return result;
  }
}
