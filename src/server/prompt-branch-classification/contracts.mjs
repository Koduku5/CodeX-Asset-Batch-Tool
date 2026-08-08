export const CLASSIFICATION_VERSION = 1;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const MAX_QUEUE_ITEMS = 50_000;
const VALID_SHEETS = new Set(['角色', '生物', '群演', '场景', '道具']);

export class PromptBranchClassificationError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = 'PromptBranchClassificationError';
    this.code = code;
    this.cause = cause;
  }
}

export const fail = (code, message, cause = null) => {
  throw new PromptBranchClassificationError(code, message, cause);
};

export const exactKeys = (value, keys) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));

const normalizeEnum = (value, allowed, legacy = {}) => {
  const text = String(value ?? '').trim().replaceAll('_', '-');
  if (allowed.includes(text)) return text;
  return Object.entries(legacy).find(([, label]) => label === text)?.[0] ?? null;
};

export const validateBaseQueue = (queue, catalog) => {
  if (!queue
    || typeof queue !== 'object'
    || Array.isArray(queue)
    || queue.version !== 4
    || !Array.isArray(queue.items)) {
    fail('BASE_QUEUE_INVALID', '基础出图队列结构无效');
  }
  if (queue.operation === 'reference_redraw') {
    fail('UNSUPPORTED_QUEUE_MODE', '目录重绘队列不执行提示词分支分类');
  }
  if (queue.conditionMatching
    || queue.items.some((item) => Object.hasOwn(item ?? {}, 'selectedConditionModuleIds'))) {
    fail('BASE_QUEUE_NOT_REFRESHED', '基础队列没有在无分支匹配状态下完成刷新');
  }
  if (queue.items.length > MAX_QUEUE_ITEMS) {
    fail('CLASSIFICATION_TOO_LARGE', '提示词分支分类项超过 50000 条限制');
  }
  const batch = queue.builtinPromptBatch;
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) {
    fail('BUILTIN_PROMPT_BATCH_REQUIRED', '请先确认内置提示词风格、生成类型与参考图方式');
  }
  const style = normalizeEnum(batch.styleId, catalog.enums.styles, catalog.legacyNames.styles);
  if (!style) fail('BUILTIN_PROMPT_BATCH_INVALID', '内置提示词批次风格无效');
  const keys = new Set();
  const items = queue.items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      fail('BASE_QUEUE_INVALID', `基础队列第 ${index + 1} 项无效`);
    }
    const key = String(item.key ?? '').trim();
    const sheetName = String(item.sheetName ?? '').trim();
    const assetName = String(item.assetName ?? '').trim();
    const productionNotes = String(item.productionNotes ?? '').trim();
    if (!key
      || key.length > 200
      || /[\\/\u0000-\u001f\u007f]/u.test(key)
      || keys.has(key)) {
      fail('BASE_QUEUE_INVALID', `基础队列第 ${index + 1} 项 key 无效或重复`);
    }
    if (!VALID_SHEETS.has(sheetName) || !assetName || !productionNotes) {
      fail('BASE_QUEUE_INVALID', `基础队列第 ${index + 1} 项缺少资产或制作说明`);
    }
    keys.add(key);
    const asset = normalizeEnum(sheetName, catalog.enums.assets, catalog.legacyNames.assets);
    const references = batch.referencesBySheet?.[sheetName];
    if (!Array.isArray(references)) {
      fail('BUILTIN_PROMPT_BATCH_INVALID', `内置提示词批次缺少 ${sheetName} 参考图配置`);
    }
    const configuredMode = normalizeEnum(
      batch.referenceModeBySheet?.[sheetName],
      catalog.enums.referenceModes,
      catalog.legacyNames.referenceModes
    );
    const referenceMode = references.length === 0 ? 'none' : configuredMode;
    if (!asset || !referenceMode) {
      fail('BUILTIN_PROMPT_BATCH_INVALID', `内置提示词批次的 ${sheetName} 路由无效`);
    }
    return { key, sheetName, assetName, productionNotes, style, asset, referenceMode };
  });
  return { items, batch };
};

export const candidateForRequest = (module) => ({
  id: module.id,
  displayName: module.displayName,
  family: module.family,
  definition: module.classifier.definition,
  selectionPolicy: module.classifier.selectionPolicy,
  controlDimensions: [...module.classifier.controlDimensions],
  tieBreak: module.classifier.tieBreak,
  noDefault: module.classifier.noDefault
});

export const pageSchema = (pageItems) => {
  const candidateIds = [
    ...new Set(pageItems.flatMap((item) => item.candidates.map(({ id }) => id)))
  ];
  return {
    type: 'object',
    properties: {
      completed: { type: 'boolean' },
      action: { type: 'string', enum: ['classify-prompt-branches'] },
      summary: { type: 'string', minLength: 1, maxLength: 240 },
      assignments: {
        type: 'array',
        minItems: pageItems.length,
        maxItems: pageItems.length,
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', enum: pageItems.map(({ key }) => key) },
            selectedConditionModuleIds: {
              type: 'array',
              items: candidateIds.length
                ? { type: 'string', enum: candidateIds }
                : { type: 'string' }
            }
          },
          required: ['key', 'selectedConditionModuleIds'],
          additionalProperties: false
        }
      }
    },
    required: ['completed', 'action', 'summary', 'assignments'],
    additionalProperties: false
  };
};
