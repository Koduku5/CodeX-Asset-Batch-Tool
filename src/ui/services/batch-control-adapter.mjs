const PROJECT_ID_PATTERN = /^(?=.{1,64}$)[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/u;
const REFERENCE_ID_PATTERN = /^ref-[a-f0-9]{64}$/u;
const STYLES = new Set(['anime', 'cg', 'live-action']);
const SHEETS = new Set(['角色', '生物', '群演', '场景', '道具']);

export class BatchControlAdapterError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'BatchControlAdapterError';
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details) => { throw new BatchControlAdapterError(code, message, details); };
const exactKeys = (value, required) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...required].sort().join('\0');
const projectId = (value) => {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) fail('INVALID_PROJECT_ID', '项目编号格式无效');
  return value;
};
const styleId = (value) => {
  if (typeof value !== 'string' || !STYLES.has(value)) fail('INVALID_REFERENCE_STYLE', '参考图制作风格无效');
  return value;
};
const sheetName = (value) => {
  if (typeof value !== 'string' || !SHEETS.has(value)) fail('INVALID_REFERENCE_SHEET', '参考图资产类别无效');
  return value;
};
const referenceId = (value) => {
  if (typeof value !== 'string' || !REFERENCE_ID_PATTERN.test(value)) fail('INVALID_REFERENCE_ID', '参考图编号无效');
  return value;
};

const referenceDto = (value) => {
  if (!exactKeys(value, ['referenceId', 'styleId', 'sheetName', 'path', 'sourceName', 'size', 'sha256', 'createdAt'])) {
    fail('INVALID_REFERENCE_RECEIPT', '参考图回执字段无效');
  }
  referenceId(value.referenceId);
  styleId(value.styleId);
  sheetName(value.sheetName);
  if (typeof value.path !== 'string' || !value.path.startsWith('cache/内置参考图/') || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value.path)) fail('INVALID_REFERENCE_RECEIPT', '参考图回执路径无效');
  if (typeof value.sourceName !== 'string' || !value.sourceName || value.sourceName.includes('/') || value.sourceName.includes('\\')) fail('INVALID_REFERENCE_RECEIPT', '参考图回执文件名无效');
  if (!Number.isInteger(value.size) || value.size <= 0 || value.size > 20 * 1024 * 1024 || !/^[a-f0-9]{64}$/u.test(value.sha256) || !Number.isFinite(Date.parse(value.createdAt))) {
    fail('INVALID_REFERENCE_RECEIPT', '参考图回执校验字段无效');
  }
  return { ...value };
};

const summaryDto = (value) => {
  if (!exactKeys(value, [
    'version', 'confirmedAt', 'styleId', 'generationLimit', 'enabledSheets',
    'referenceCountsBySheet', 'selectedReferenceIdsBySheet', 'referenceModeBySheet', 'catalogFingerprint', 'routeFingerprintsBySheet'
  ])) fail('INVALID_BATCH_RECEIPT', '批次配置回执字段无效');
  styleId(value.styleId);
  if (value.version !== 6 || !Number.isFinite(Date.parse(value.confirmedAt)) || ![0, 5, 10].includes(value.generationLimit)) fail('INVALID_BATCH_RECEIPT', '批次配置回执无效');
  if (!Array.isArray(value.enabledSheets) || value.enabledSheets.some((sheet) => !SHEETS.has(sheet)) || !/^[a-f0-9]{64}$/u.test(value.catalogFingerprint)) fail('INVALID_BATCH_RECEIPT', '批次配置回执范围无效');
  if (!exactKeys(value.selectedReferenceIdsBySheet, [...SHEETS])) fail('INVALID_BATCH_RECEIPT', '批次参考图选择回执无效');
  for (const sheet of SHEETS) {
    const ids = value.selectedReferenceIdsBySheet?.[sheet];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !REFERENCE_ID_PATTERN.test(id))) fail('INVALID_BATCH_RECEIPT', '批次参考图选择回执无效');
  }
  return structuredClone(value);
};

const envelopeData = (value, validator, label) => {
  if (value?.ok === false) {
    const error = value.error || {};
    fail(error.code || 'BATCH_CONTROL_FAILED', error.message || `${label}失败`, error.details || null);
  }
  const data = value?.ok === true ? value.data : value;
  return validator(data);
};

const parseResponse = async (response, label) => {
  let value;
  try { value = await response.json(); } catch { fail('INVALID_SERVER_RESPONSE', `${label}返回了无效响应`); }
  if (!response.ok || value?.ok === false) {
    const error = value?.error || {};
    fail(error.code || 'HTTP_REQUEST_FAILED', error.message || `${label}失败`);
  }
  return value;
};

export class BatchControlAdapter {
  constructor({ bridge = globalThis.promptStudioBatchBridge ?? null, fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
    this.bridge = bridge;
    this.fetchImpl = fetchImpl;
  }

  async requestJson(path, options, validator, label) {
    if (typeof this.fetchImpl !== 'function') fail('BATCH_CONTROL_UNAVAILABLE', '批次控制接口不可用');
    const envelope = await parseResponse(await this.fetchImpl(path, options), label);
    return envelopeData(envelope, validator, label);
  }

  async listReferences({ projectId: requestedProjectId }) {
    const id = projectId(requestedProjectId);
    const result = typeof this.bridge?.listReferenceImages === 'function'
      ? await this.bridge.listReferenceImages({ projectId: id })
      : await parseResponse(await this.fetchImpl(`/api/projects/${encodeURIComponent(id)}/references`, { method: 'GET' }), '读取参考图');
    const data = result?.ok === true ? result.data : result;
    if (!Array.isArray(data)) fail('INVALID_REFERENCE_RECEIPT', '参考图列表回执无效');
    return data.map(referenceDto);
  }

  async uploadReference({ projectId: requestedProjectId, styleId: requestedStyle, sheetName: requestedSheet, file }) {
    const id = projectId(requestedProjectId);
    const style = styleId(requestedStyle);
    const sheet = sheetName(requestedSheet);
    if (!(file instanceof Blob) || typeof file.name !== 'string' || !file.name) fail('INVALID_REFERENCE_FILE', '请选择参考图片');
    const result = typeof this.bridge?.uploadReferenceImage === 'function'
      ? await this.bridge.uploadReferenceImage({ projectId: id, styleId: style, sheetName: sheet, file })
      : await parseResponse(await this.fetchImpl(
        `/api/projects/${encodeURIComponent(id)}/references/${encodeURIComponent(style)}/${encodeURIComponent(sheet)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream', 'x-ka-filename': encodeURIComponent(file.name) },
          body: file
        }
      ), '上传参考图');
    return envelopeData(result, referenceDto, '上传参考图');
  }

  async removeReference({ projectId: requestedProjectId, referenceId: requestedReferenceId }) {
    const id = projectId(requestedProjectId);
    const ref = referenceId(requestedReferenceId);
    const result = typeof this.bridge?.removeReferenceImage === 'function'
      ? await this.bridge.removeReferenceImage({ projectId: id, referenceId: ref })
      : await parseResponse(await this.fetchImpl(
        `/api/projects/${encodeURIComponent(id)}/references/${encodeURIComponent(ref)}`,
        { method: 'DELETE' }
      ), '移除参考图');
    const data = result?.ok === true ? result.data : result;
    if (!exactKeys(data, ['referenceId', 'removed']) || data.referenceId !== ref || data.removed !== true) fail('INVALID_REFERENCE_RECEIPT', '移除参考图回执无效');
    return data;
  }

  referenceContentUrl({ projectId: requestedProjectId, referenceId: requestedReferenceId }) {
    const id = projectId(requestedProjectId);
    const ref = referenceId(requestedReferenceId);
    return `/api/projects/${encodeURIComponent(id)}/references/${encodeURIComponent(ref)}/content`;
  }

  async saveBuiltinBatch({ projectId: requestedProjectId, configuration }) {
    const id = projectId(requestedProjectId);
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) fail('INVALID_BATCH_REQUEST', '批次配置无效');
    const result = typeof this.bridge?.saveBuiltinBatch === 'function'
      ? await this.bridge.saveBuiltinBatch({ projectId: id, configuration })
      : await parseResponse(await this.fetchImpl(
        `/api/projects/${encodeURIComponent(id)}/builtin-batch`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(configuration) }
      ), '保存批次配置');
    return envelopeData(result, summaryDto, '保存批次配置');
  }

  async getBuiltinBatch({ projectId: requestedProjectId }) {
    const id = projectId(requestedProjectId);
    const result = typeof this.bridge?.getBuiltinBatch === 'function'
      ? await this.bridge.getBuiltinBatch({ projectId: id })
      : await parseResponse(await this.fetchImpl(`/api/projects/${encodeURIComponent(id)}/builtin-batch`, { method: 'GET' }), '读取批次配置');
    const data = result?.ok === true ? result.data : result;
    return data === null ? null : summaryDto(data);
  }
}
