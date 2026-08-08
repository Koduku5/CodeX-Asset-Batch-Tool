import { resultSchema } from './contracts.mjs';
import { sanitizeAgentText, workerError } from './worker-errors.mjs';

const MAX_ANALYSIS_RESULT_BYTES = 1024 * 1024;
const ASSET_CATEGORIES = Object.freeze(['characters', 'creatures', 'extras', 'scenes', 'props']);

const resultSchemaError = (path, message) => {
  throw workerError('INVALID_AGENT_RESULT', `Codex Agent 完成回执 ${path} ${message}`);
};

export const validateSchemaValue = (value, schema, path = '$') => {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const matchesType = types.some((type) => {
    if (type === 'null') return value === null;
    if (type === 'array') return Array.isArray(value);
    if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    if (type === 'integer') return Number.isInteger(value);
    return typeof value === type;
  });
  if (!matchesType) resultSchemaError(path, `必须是 ${types.join(' 或 ')}`);
  if (schema.enum && !schema.enum.includes(value)) resultSchemaError(path, '不在允许值中');
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) resultSchemaError(path, '不能为空');
    if (schema.maxLength !== undefined && value.length > schema.maxLength) resultSchemaError(path, '长度超出限制');
  }
  if (Number.isInteger(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) resultSchemaError(path, '小于允许的最小值');
    if (schema.maximum !== undefined && value > schema.maximum) resultSchemaError(path, '大于允许的最大值');
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) resultSchemaError(path, '条目数超出限制');
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      resultSchemaError(path, '包含重复条目');
    }
    value.forEach((item, index) => validateSchemaValue(item, schema.items, `${path}[${index}]`));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) resultSchemaError(`${path}.${required}`, '缺失');
    }
    if (schema.additionalProperties === false) {
      const unknown = keys.find((key) => !Object.hasOwn(schema.properties, key));
      if (unknown) resultSchemaError(`${path}.${unknown}`, '是未定义字段');
    }
    for (const key of keys) {
      if (Object.hasOwn(schema.properties ?? {}, key)) {
        validateSchemaValue(value[key], schema.properties[key], `${path}.${key}`);
      }
    }
  }
};

const normalizeAliasKey = (value) => value.replace(/\s+/gu, '').toLowerCase();

const normalizeAnalysisAliases = (analysis) => {
  for (const type of ['characters', 'creatures', 'extras', 'scenes', 'props']) {
    analysis.assets[type].forEach((record) => {
      const seen = new Set();
      const assetNameKey = normalizeAliasKey(record.assetName);
      record.aliases = record.aliases.reduce((aliases, alias) => {
        const text = alias.trim();
        const key = normalizeAliasKey(text);
        if (!key || key === assetNameKey || seen.has(key)) return aliases;
        seen.add(key);
        aliases.push(text);
        return aliases;
      }, []);
    });
  }
  return analysis;
};

const prepareAnalysisForFormalWriter = (analysis) => ({
  ...analysis,
  assets: Object.fromEntries(
    ['characters', 'creatures', 'extras', 'scenes', 'props'].map((type) => [
      type,
      analysis.assets[type].map((record) => {
        if (record.assetId !== null) return record;
        const { assetId: _newAssetMarker, ...formalRecord } = record;
        return formalRecord;
      })
    ])
  )
});

export const reconcileAnalysisAssetIdentities = (analysis, registries) => ({
  ...analysis,
  assets: Object.fromEntries(ASSET_CATEGORIES.map((category) => {
    const byName = new Map();
    const byId = new Map();
    for (const record of registries[category] ?? []) {
      const name = typeof record.assetName === 'string' ? record.assetName.trim() : '';
      const assetId = typeof record.assetId === 'string' ? record.assetId.trim() : '';
      if (!name || !assetId || byName.has(name) || byId.has(assetId)) {
        throw workerError('ANALYSIS_ASSET_REGISTRY_INVALID', `累计资产身份存在缺失或重复：${category}`);
      }
      byName.set(name, record);
      byId.set(assetId, record);
    }
    return [category, analysis.assets[category].map((record) => {
      const nameMatch = byName.get(String(record.assetName ?? '').trim());
      const idMatch = byId.get(String(record.assetId ?? '').trim());
      if (nameMatch && idMatch && nameMatch !== idMatch) {
        throw workerError('INVALID_AGENT_RESULT', `资产名称与 ID 指向不同旧记录：${record.assetName}`);
      }
      const existing = idMatch ?? nameMatch;
      if (!existing) return { ...record };
      return {
        ...record, assetId: existing.assetId, assetName: existing.assetName,
        firstRequiredEpisode: existing.firstRequiredEpisode,
        firstRequiredOrder: existing.firstRequiredOrder
      };
    })];
  }))
});

export const parseFinalResult = (text, action, projectRoot, episode = null) => {
  const candidate = String(text ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/giu, '');
  let value;
  try {
    value = JSON.parse(candidate);
  } catch (error) {
    throw workerError('INVALID_AGENT_RESULT', 'Codex Agent 未返回有效完成回执', error);
  }
  validateSchemaValue(value, resultSchema(action, episode));
  let analysis = null;
  if (action === 'analyze-screenplay') {
    const normalizedAnalysis = normalizeAnalysisAliases(value.analysis);
    if (Buffer.byteLength(JSON.stringify(normalizedAnalysis), 'utf8') > MAX_ANALYSIS_RESULT_BYTES) {
      throw workerError('INVALID_AGENT_RESULT', 'Codex Agent 单集分析大小超出限制');
    }
    analysis = prepareAnalysisForFormalWriter(normalizedAnalysis);
  }
  const result = Object.freeze({
    completed: value.completed,
    action,
    summary: sanitizeAgentText(value.summary, projectRoot).slice(0, 240) || '动作未提供可显示说明',
    processedCount: value.processedCount,
    ...(analysis ? { analysis } : {}),
    ...(action === 'build-world-overview' ? { worldOverview: value.worldOverview } : {})
  });
  if (!result.completed) throw workerError('AGENT_REPORTED_INCOMPLETE', result.summary);
  return result;
};

export const parseAgentJson = (text, label) => {
  const candidate = String(text ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/giu, '');
  try {
    return JSON.parse(candidate);
  } catch (error) {
    throw workerError('INVALID_AGENT_RESULT', `${label}未返回有效结构化回执`, error);
  }
};
