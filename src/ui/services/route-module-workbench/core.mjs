export const DEFAULT_ALLOWED_TARGET_FIELDS = Object.freeze([
  'Primary request',
  'Scene/backdrop',
  'Style/medium',
  'Composition/framing',
  'Lighting/mood',
  'Color/tonality',
  'Materials/textures',
  'Constraints',
  'Avoid'
]);

export const DEFAULT_CONTROL_DIMENSIONS = Object.freeze([
  'main-spatial-structure',
  'subject-recognition',
  'action-zone',
  'passage-path',
  'camera-position'
]);

const SUPPORTED_OPERATIONS = new Set(['append', 'prepend', 'set', 'replaceWith']);
const SUPPORTED_POLICIES = new Set(['single-dominant', 'stack-allowed']);

export class RouteModuleError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'RouteModuleError';
    this.code = code;
    this.details = details;
  }
}

export const clone = (value) => JSON.parse(JSON.stringify(value));
const uniqueStrings = (value) => [...new Set((Array.isArray(value) ? value : []).map((item) => String(item).trim()).filter(Boolean))];
export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const STABLE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function normalizeOperation(operation) {
  const op = String(operation?.op || '').trim();
  if (op === 'replaceWith') return { op, routeId: String(operation?.routeId || '').trim() };
  const normalized = { op, field: String(operation?.field || '').trim() };
  if (Array.isArray(operation?.phrases)) normalized.phrases = clone(operation.phrases);
  else normalized.value = String(operation?.value || '');
  return normalized;
}

export function normalizeRouteModule(module) {
  const classifier = isObject(module?.classifier) ? module.classifier : {};
  const scope = isObject(module?.scope) ? module.scope : {};
  return {
    id: String(module?.id || '').trim(),
    displayName: String(module?.displayName || '').trim(),
    family: String(module?.family || '').trim(),
    revision: Math.max(1, Number.parseInt(module?.revision || '1', 10) || 1),
    scope: {
      styles: uniqueStrings(scope.styles),
      assets: uniqueStrings(scope.assets),
      referenceModes: uniqueStrings(scope.referenceModes)
    },
    classifier: {
      definition: String(classifier.definition || '').trim(),
      selectionPolicy: String(classifier.selectionPolicy || 'single-dominant'),
      controlDimensions: uniqueStrings(classifier.controlDimensions),
      tieBreak: String(classifier.tieBreak || '').trim(),
      noDefault: classifier.noDefault !== false
    },
    operations: (Array.isArray(module?.operations) ? module.operations : []).map(normalizeOperation),
    tests: (Array.isArray(module?.tests) ? module.tests : []).map((test, index) => ({
      id: String(test?.id || `case-${index + 1}`).trim(),
      assetId: String(test?.assetId || '').trim(),
      style: String(test?.style || '').trim(),
      asset: String(test?.asset || '').trim(),
      productionNotes: String(test?.productionNotes || '').trim(),
      expectedConditionId: String(test?.expectedConditionId || module?.id || '').trim()
    })),
    origin: isObject(module?.origin) ? clone(module.origin) : { kind: 'session-draft' }
  };
}

const normalizeDisplayName = (value) => String(value || '')
  .normalize('NFKC')
  .trim()
  .replace(/\s+/g, ' ')
  .toLocaleLowerCase('zh-CN');

const normalizedScopeKey = (module) => {
  const scope = normalizeRouteModule(module).scope;
  const sorted = (items) => [...items].sort((left, right) => left.localeCompare(right));
  return JSON.stringify({
    styles: sorted(scope.styles),
    assets: sorted(scope.assets),
    referenceModes: sorted(scope.referenceModes)
  });
};

export function normalizeRoutePresetName(name) {
  return normalizeDisplayName(name);
}

export function routePresetNamesEqual(left, right) {
  const normalizedLeft = normalizeRoutePresetName(left);
  return Boolean(normalizedLeft) && normalizedLeft === normalizeRoutePresetName(right);
}

export function routeModuleScopesEqual(left, right) {
  return normalizedScopeKey(left) === normalizedScopeKey(right);
}

export function isSuspectedSameRouteModule(left, right) {
  const normalizedLeft = normalizeRouteModule(left);
  const normalizedRight = normalizeRouteModule(right);
  return Boolean(normalizedLeft.id && normalizedRight.id)
    && normalizedLeft.id !== normalizedRight.id
    && Boolean(normalizeDisplayName(normalizedLeft.displayName))
    && normalizeDisplayName(normalizedLeft.displayName) === normalizeDisplayName(normalizedRight.displayName)
    && routeModuleScopesEqual(normalizedLeft, normalizedRight);
}

export function findSuspectedSameRouteModules(incoming, candidates) {
  const matches = (Array.isArray(candidates) ? candidates : [])
    .map(normalizeRouteModule)
    .filter((candidate) => isSuspectedSameRouteModule(incoming, candidate));
  return [...new Map(matches.map((candidate) => [candidate.id, candidate])).values()];
}

export const findSuspectedDuplicateBranches = findSuspectedSameRouteModules;

export function validateRouteModule(module, {
  allowedTargetFields = DEFAULT_ALLOWED_TARGET_FIELDS,
  allowedOperations = [...SUPPORTED_OPERATIONS]
} = {}) {
  const normalized = normalizeRouteModule(module);
  const errors = [];
  const allowedFields = new Set(allowedTargetFields);
  const operationSet = new Set(allowedOperations);
  if (!STABLE_ID_PATTERN.test(normalized.id)) errors.push({ path: 'id', message: '分支唯一 ID 格式无效，请使用系统自动生成的 ID' });
  if (!normalized.displayName) errors.push({ path: 'displayName', message: '分支名称不能为空' });
  if (!normalized.family) errors.push({ path: 'family', message: '系统内部判断分组缺失，请重新新建分支或重新导入文件' });
  if (!normalized.scope.styles.length) errors.push({ path: 'scope.styles', message: '至少选择一种制作风格' });
  if (!normalized.scope.assets.length) errors.push({ path: 'scope.assets', message: '至少选择一种资产类型' });
  if (!normalized.classifier.definition) errors.push({ path: 'classifier.definition', message: '请用日常语言说明什么情况下使用这个分支' });
  if (!SUPPORTED_POLICIES.has(normalized.classifier.selectionPolicy)) errors.push({ path: 'classifier.selectionPolicy', message: '未知的选择策略' });
  if (!normalized.classifier.controlDimensions.length) errors.push({ path: 'classifier.controlDimensions', message: '至少需要一个裁决维度' });
  if (!normalized.operations.length) errors.push({ path: 'operations', message: '至少需要一条 Prompt 操作' });
  normalized.operations.forEach((operation, index) => {
    const path = `operations[${index}]`;
    if (!operationSet.has(operation.op)) errors.push({ path: `${path}.op`, message: `不支持操作 ${operation.op || '（空）'}` });
    if (operation.op === 'replaceWith') {
      if (!operation.routeId) errors.push({ path: `${path}.routeId`, message: 'replaceWith 必须指定目标基础路由' });
      return;
    }
    if (!allowedFields.has(operation.field)) errors.push({ path: `${path}.field`, message: `${operation.field || '空字段'} 不在允许写入白名单` });
    if (!('phrases' in operation) && !String(operation.value || '').trim()) errors.push({ path: `${path}.value`, message: 'Prompt 内容不能为空' });
  });
  normalized.tests.forEach((test, index) => {
    if (!test.productionNotes) errors.push({ path: `tests[${index}].productionNotes`, message: '测试用例缺少制作说明' });
    if (test.expectedConditionId !== normalized.id) errors.push({ path: `tests[${index}].expectedConditionId`, message: '测试期望 ID 必须等于模块稳定 ID' });
  });
  return { valid: errors.length === 0, errors, module: normalized };
}

export function buildClassificationRequest({ style, asset, referenceMode = 'none', assetId, productionNotes, candidates }) {
  const notes = String(productionNotes || '').trim();
  if (!notes) throw new RouteModuleError('PRODUCTION_NOTES_REQUIRED', '必须提供当前资产的完整制作说明');
  const eligible = (Array.isArray(candidates) ? candidates : [])
    .map(normalizeRouteModule)
    .filter((candidate) => candidate.scope.styles.includes(style) && candidate.scope.assets.includes(asset) && candidate.scope.referenceModes.includes(referenceMode));
  if (!eligible.length) throw new RouteModuleError('NO_ELIGIBLE_CANDIDATES', '当前风格、资产类别和参考图方式下没有可供 Agent 判断的分支');
  if (eligible.some((candidate) => candidate.classifier.selectionPolicy !== 'single-dominant')) {
    throw new RouteModuleError('STACK_POLICY_NOT_READY', '当前版本一次只能选择一个主分支；多分支同时生效需等待正式优先级与冲突规则接入');
  }
  return {
    contractVersion: 1,
    task: 'select-registered-condition-module',
    input: { style, asset, referenceMode, assetId: String(assetId || '').trim(), productionNotes: notes },
    rules: {
      output: 'exactly-one-candidate-id-or-null',
      doNotInventIds: true,
      doNotMatchDisplayNameAsKeyword: true,
      promptOperationsExcluded: true
    },
    candidates: eligible.map((candidate) => ({
      id: candidate.id,
      displayName: candidate.displayName,
      family: candidate.family,
      definition: candidate.classifier.definition,
      selectionPolicy: candidate.classifier.selectionPolicy,
      controlDimensions: [...candidate.classifier.controlDimensions],
      tieBreak: candidate.classifier.tieBreak,
      noDefault: candidate.classifier.noDefault
    }))
  };
}

const operationPayload = (operation) => {
  if (typeof operation.value === 'string') return operation.value.trim();
  if (Array.isArray(operation.phrases)) {
    return operation.phrases.map((phrase) => {
      if (typeof phrase?.value === 'string') return phrase.value;
      return phrase?.phraseId ? `[${phrase.phraseId}]` : '[动态短语]';
    }).join('');
  }
  return '';
};

export function applyModuleOperationsPreview(promptFields, module) {
  const before = new Map((Array.isArray(promptFields) ? promptFields : []).map(({ label, value }) => [label, String(value || '')]));
  const after = new Map(before);
  const deferred = [];
  for (const operation of normalizeRouteModule(module).operations) {
    if (operation.op === 'replaceWith') {
      deferred.push({ ...operation, reason: '基础路由替换必须交给正式 Resolver 重新解析' });
      continue;
    }
    const payload = operationPayload(operation);
    const current = after.get(operation.field) || '';
    if (operation.op === 'append') after.set(operation.field, [current, payload].filter(Boolean).join(' '));
    if (operation.op === 'prepend') after.set(operation.field, [payload, current].filter(Boolean).join(' '));
    if (operation.op === 'set') after.set(operation.field, payload);
  }
  const fields = [...after].map(([label, value]) => ({ label, value }));
  const diff = [...after].map(([field, value]) => ({ field, before: before.get(field) || '', after: value }))
    .filter(({ before: previous, after: next }) => previous !== next);
  return { fields, diff, deferred };
}

const comparableModule = (module) => {
  const normalized = normalizeRouteModule(module);
  delete normalized.origin;
  return normalized;
};

export const routeModulesEqual = (left, right) => JSON.stringify(comparableModule(left)) === JSON.stringify(comparableModule(right));
