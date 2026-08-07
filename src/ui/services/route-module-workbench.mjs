export const ROUTE_MODULE_PACKAGE_KIND = 'ka-prompt-route-module-package';
export const ROUTE_MODULE_PACKAGE_VERSION = 1;
export const ROUTE_BRANCH_FILE_KIND = 'ka-prompt-route-branch-file';
export const ROUTE_BRANCH_FILE_VERSION = 1;
export const ROUTE_PRESET_PACKAGE_KIND = 'ka-prompt-route-preset-package';
export const ROUTE_PRESET_PACKAGE_VERSION = 1;

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

const clone = (value) => JSON.parse(JSON.stringify(value));
const uniqueStrings = (value) => [...new Set((Array.isArray(value) ? value : []).map((item) => String(item).trim()).filter(Boolean))];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const STABLE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

const ARTIFACT_TYPES = Object.freeze({
  [ROUTE_BRANCH_FILE_KIND]: 'branch-file',
  [ROUTE_PRESET_PACKAGE_KIND]: 'preset-package',
  [ROUTE_MODULE_PACKAGE_KIND]: 'legacy-module-package'
});

const ARTIFACT_LABELS = Object.freeze({
  'branch-file': '单个分支文件',
  'preset-package': '整套预设包',
  'legacy-module-package': '旧版分支包'
});

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
const equalModules = routeModulesEqual;

const parseExchangeValue = (input) => {
  try {
    if (typeof input === 'string') return JSON.parse(input);
    if (isObject(input)) return clone(input);
  } catch {
    throw new RouteModuleError('INVALID_JSON', '导入文件不是有效 JSON');
  }
  throw new RouteModuleError('INVALID_JSON', '导入文件不是有效 JSON');
};

const exchangeSource = (source = {}) => ({
  catalogVersion: source.catalogVersion ?? null,
  catalogFingerprint: String(source.catalogFingerprint || ''),
  enhancerId: String(source.enhancerId || ''),
  enhancerVersion: source.enhancerVersion ?? null
});

const presetTemplates = (value = []) => {
  if (!Array.isArray(value) && !isObject(value)) {
    throw new RouteModuleError('INVALID_PRESET_TEMPLATES', '整套预设的 templates 必须是 JSON 数组或对象');
  }
  return clone(value);
};

const canonicalJson = (value) => {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
};

const validatedModules = (modules, emptyMessage = '至少需要一个分支', allowEmpty = false) => {
  const normalized = (Array.isArray(modules) ? modules : []).map((module) => {
    const result = validateRouteModule(module);
    if (!result.valid) throw new RouteModuleError('INVALID_MODULE', `分支 ${result.module.displayName || result.module.id || '（未命名）'} 未通过检查`, result.errors);
    return result.module;
  });
  if (!allowEmpty && !normalized.length) throw new RouteModuleError('EMPTY_PACKAGE', emptyMessage);
  if (new Set(normalized.map(({ id }) => id)).size !== normalized.length) {
    throw new RouteModuleError('DUPLICATE_BRANCH_ID', '同一份文件中不能出现两个相同的分支唯一 ID');
  }
  return normalized;
};

const wrongArtifactKind = (value, expectedType) => {
  const actualType = ARTIFACT_TYPES[value?.kind];
  if (!actualType) throw new RouteModuleError('INVALID_PACKAGE_KIND', '这不是 KA Prompt 可交换文件');
  throw new RouteModuleError(
    'WRONG_ARTIFACT_KIND',
    `这是${ARTIFACT_LABELS[actualType]}，不能从${ARTIFACT_LABELS[expectedType]}入口导入`,
    { actualType, expectedType }
  );
};

export function detectRouteExchangeKind(input) {
  const value = parseExchangeValue(input);
  const type = ARTIFACT_TYPES[value?.kind];
  if (!type) throw new RouteModuleError('INVALID_PACKAGE_KIND', '这不是 KA Prompt 可交换文件');
  return type;
}

export function createRouteBranchFile({ module, source = {}, exportedAt = new Date().toISOString(), author = '' }) {
  const [normalized] = validatedModules(module ? [module] : [], '单分支文件中没有分支');
  return {
    kind: ROUTE_BRANCH_FILE_KIND,
    formatVersion: ROUTE_BRANCH_FILE_VERSION,
    exportedAt,
    author: String(author || '').trim(),
    source: exchangeSource(source),
    module: normalized
  };
}

export function parseRouteBranchFile(input) {
  const value = parseExchangeValue(input);
  if (value.kind !== ROUTE_BRANCH_FILE_KIND) wrongArtifactKind(value, 'branch-file');
  if (value.formatVersion !== ROUTE_BRANCH_FILE_VERSION) {
    throw new RouteModuleError('UNSUPPORTED_BRANCH_FILE_VERSION', `暂不支持单分支文件版本 ${value.formatVersion}`);
  }
  const [module] = validatedModules(value.module ? [value.module] : [], '这份单分支文件中没有分支');
  return { ...clone(value), module };
}

export function createRoutePresetPackage({ preset, modules, templates = [], source = {}, exportedAt = new Date().toISOString(), author = '' }) {
  const id = String(preset?.id || '').trim();
  const name = String(preset?.name || '').trim();
  const revision = Math.max(1, Number.parseInt(preset?.revision || '1', 10) || 1);
  if (!STABLE_ID_PATTERN.test(id)) throw new RouteModuleError('INVALID_PRESET_ID', '整套预设必须提供稳定的预设 ID');
  if (!name) throw new RouteModuleError('INVALID_PRESET_NAME', '整套预设名称不能为空');
  return {
    kind: ROUTE_PRESET_PACKAGE_KIND,
    formatVersion: ROUTE_PRESET_PACKAGE_VERSION,
    preset: { id, name, revision },
    exportedAt,
    author: String(author || '').trim(),
    source: exchangeSource(source),
    templates: presetTemplates(templates),
    modules: validatedModules(modules, '整套预设中没有分支', true)
  };
}

export function parseRoutePresetPackage(input) {
  const value = parseExchangeValue(input);
  if (value.kind !== ROUTE_PRESET_PACKAGE_KIND) wrongArtifactKind(value, 'preset-package');
  if (value.formatVersion !== ROUTE_PRESET_PACKAGE_VERSION) {
    throw new RouteModuleError('UNSUPPORTED_PRESET_PACKAGE_VERSION', `暂不支持整套预设包版本 ${value.formatVersion}`);
  }
  const preset = {
    id: String(value.preset?.id || '').trim(),
    name: String(value.preset?.name || '').trim(),
    revision: Math.max(1, Number.parseInt(value.preset?.revision || '1', 10) || 1)
  };
  if (!STABLE_ID_PATTERN.test(preset.id)) throw new RouteModuleError('INVALID_PRESET_ID', '整套预设的稳定 ID 无效');
  if (!preset.name) throw new RouteModuleError('INVALID_PRESET_NAME', '整套预设名称不能为空');
  return {
    ...clone(value),
    preset,
    templates: presetTemplates(value.templates ?? []),
    modules: validatedModules(value.modules, '整套预设中没有分支', true)
  };
}

export function parseRouteExchangeArtifact(input) {
  const type = detectRouteExchangeKind(input);
  if (type === 'branch-file') return { type, value: parseRouteBranchFile(input) };
  if (type === 'preset-package') return { type, value: parseRoutePresetPackage(input) };
  return { type, value: parseRouteModulePackage(input) };
}

const sortedPresetModules = (routePackage) => [...routePackage.modules].sort((left, right) => left.id.localeCompare(right.id));

export function routePresetContentsEqual(left, right) {
  const leftPackage = parseRoutePresetPackage(left);
  const rightPackage = parseRoutePresetPackage(right);
  const leftModules = sortedPresetModules(leftPackage);
  const rightModules = sortedPresetModules(rightPackage);
  return leftModules.length === rightModules.length
    && leftModules.every((module, index) => routeModulesEqual(module, rightModules[index]))
    && JSON.stringify(canonicalJson(leftPackage.templates)) === JSON.stringify(canonicalJson(rightPackage.templates));
}

export function comparePresetIdentity(left, right) {
  const leftPackage = parseRoutePresetPackage(left?.package || left);
  const rightPackage = parseRoutePresetPackage(right?.package || right);
  const sameId = leftPackage.preset.id === rightPackage.preset.id;
  const sameName = routePresetNamesEqual(leftPackage.preset.name, rightPackage.preset.name);
  const sameContent = routePresetContentsEqual(leftPackage, rightPackage);
  return {
    sameId,
    sameName,
    sameContent,
    status: sameId ? (sameContent ? 'same' : 'conflict') : sameName ? 'same-name' : 'distinct'
  };
}

export function findRoutePresetNameMatches(name, presetPackages) {
  return (Array.isArray(presetPackages) ? presetPackages : []).filter((candidate) => {
    const routePackage = parseRoutePresetPackage(candidate?.package || candidate);
    return routePresetNamesEqual(name, routePackage.preset.name);
  });
}

export function planRoutePresetImport(presetPackage, existingPresetPackages = []) {
  const incoming = parseRoutePresetPackage(presetPackage);
  const existing = (Array.isArray(existingPresetPackages) ? existingPresetPackages : []).map((candidate) => ({
    record: candidate,
    package: parseRoutePresetPackage(candidate?.package || candidate)
  }));
  const current = existing.find(({ package: candidate }) => candidate.preset.id === incoming.preset.id) || null;
  const sameNameMatches = existing.filter(({ package: candidate }) =>
    candidate.preset.id !== incoming.preset.id && routePresetNamesEqual(candidate.preset.name, incoming.preset.name));
  if (current) {
    const sameContent = routePresetContentsEqual(current.package, incoming);
    return {
      id: incoming.preset.id,
      status: sameContent ? 'same' : 'conflict',
      recommendedAction: sameContent ? 'skip' : 'review',
      incoming,
      current: current.record,
      metadataChanged: current.package.preset.name !== incoming.preset.name || current.package.preset.revision !== incoming.preset.revision,
      sameNameMatches: sameNameMatches.map(({ record }) => record)
    };
  }
  return {
    id: incoming.preset.id,
    status: sameNameMatches.length ? 'same-name' : 'new',
    recommendedAction: sameNameMatches.length ? 'rename-or-keep-separate' : 'add',
    incoming,
    current: null,
    metadataChanged: false,
    sameNameMatches: sameNameMatches.map(({ record }) => record)
  };
}

export function createRouteModulePackage({ modules, source = {}, exportedAt = new Date().toISOString(), author = '' }) {
  const normalizedModules = (Array.isArray(modules) ? modules : []).map((module) => {
    const result = validateRouteModule(module);
    if (!result.valid) throw new RouteModuleError('INVALID_MODULE', `分支 ${result.module.displayName || result.module.id || '（未命名）'} 未通过检查`, result.errors);
    return result.module;
  });
  if (!normalizedModules.length) throw new RouteModuleError('EMPTY_PACKAGE', '至少需要一个分支才能导出分支文件');
  if (new Set(normalizedModules.map(({ id }) => id)).size !== normalizedModules.length) {
    throw new RouteModuleError('DUPLICATE_BRANCH_ID', '同一份分支文件中不能出现两个相同的分支唯一 ID');
  }
  return {
    kind: ROUTE_MODULE_PACKAGE_KIND,
    packageVersion: ROUTE_MODULE_PACKAGE_VERSION,
    exportedAt,
    author: String(author || '').trim(),
    source: {
      catalogVersion: source.catalogVersion ?? null,
      catalogFingerprint: String(source.catalogFingerprint || ''),
      enhancerId: String(source.enhancerId || ''),
      enhancerVersion: source.enhancerVersion ?? null
    },
    modules: normalizedModules
  };
}

export function parseRouteModulePackage(text) {
  const value = parseExchangeValue(text);
  if (value.kind !== ROUTE_MODULE_PACKAGE_KIND) wrongArtifactKind(value, 'legacy-module-package');
  if (value.packageVersion !== ROUTE_MODULE_PACKAGE_VERSION) throw new RouteModuleError('UNSUPPORTED_PACKAGE_VERSION', `暂不支持模块包版本 ${value.packageVersion}`);
  if (!Array.isArray(value.modules) || !value.modules.length) throw new RouteModuleError('EMPTY_PACKAGE', '这份文件中没有路由分支');
  const modules = value.modules.map((module) => {
    const result = validateRouteModule(module);
    if (!result.valid) throw new RouteModuleError('INVALID_MODULE', `分支 ${result.module.displayName || result.module.id || '（未命名）'} 未通过检查`, result.errors);
    return result.module;
  });
  if (new Set(modules.map(({ id }) => id)).size !== modules.length) {
    throw new RouteModuleError('DUPLICATE_BRANCH_ID', '这份文件中包含重复的分支唯一 ID');
  }
  return { ...clone(value), modules };
}

const compareIncomingRouteModule = (incomingModule, existingModules) => {
  const incoming = normalizeRouteModule(incomingModule);
  const candidates = (Array.isArray(existingModules) ? existingModules : []).map(normalizeRouteModule);
  const current = candidates.find(({ id }) => id === incoming.id) || null;
  if (current) {
    return {
      id: incoming.id,
      status: equalModules(current, incoming) ? 'same' : 'conflict',
      recommendedAction: equalModules(current, incoming) ? 'skip' : 'stage-update',
      incoming,
      current,
      suspectedMatches: []
    };
  }
  const suspectedMatches = findSuspectedSameRouteModules(incoming, candidates);
  return {
    id: incoming.id,
    status: suspectedMatches.length ? 'suspected-duplicate' : 'new',
    recommendedAction: suspectedMatches.length ? 'review' : 'add',
    incoming,
    current: null,
    suspectedMatches
  };
};

export function planRouteBranchImport(branchFile, existingModules) {
  return compareIncomingRouteModule(parseRouteBranchFile(branchFile).module, existingModules);
}

export function planRouteBranchFileMerge(branchFiles, existingModules = []) {
  const sources = (Array.isArray(branchFiles) ? branchFiles : []).map((entry, index) => ({
    sourceId: String(entry?.id || `branch-file-${index + 1}`),
    sourceName: String(entry?.name || `分支文件 ${index + 1}`),
    module: parseRouteBranchFile(entry?.file || entry?.branchFile || entry).module
  }));
  if (!sources.length) throw new RouteModuleError('NO_BRANCH_FILES_SELECTED', '请至少选择一份单分支文件');

  const currentModules = (Array.isArray(existingModules) ? existingModules : []).map(normalizeRouteModule);
  const currentById = new Map(currentModules.map((module) => [module.id, module]));
  const groups = new Map();
  for (const source of sources) {
    const entries = groups.get(source.module.id) || [];
    entries.push(source);
    groups.set(source.module.id, entries);
  }

  const allIncoming = sources.map(({ module }) => module);
  const items = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, entries]) => {
    const variants = [];
    for (const entry of entries) {
      const variant = variants.find(({ module }) => routeModulesEqual(module, entry.module));
      const source = { sourceId: entry.sourceId, sourceName: entry.sourceName };
      if (variant) variant.sources.push(source);
      else variants.push({ module: entry.module, sources: [source] });
    }
    const current = currentById.get(id) || null;
    const suspectedMatches = current ? [] : findSuspectedSameRouteModules(
      variants[0].module,
      [...currentModules, ...allIncoming.filter((candidate) => candidate.id !== id)]
    );
    let status = 'new';
    if (variants.length > 1 || (current && !variants.every(({ module }) => routeModulesEqual(current, module)))) status = 'id-conflict';
    else if (current) status = 'same';
    else if (suspectedMatches.length) status = 'suspected-duplicate';
    const unresolved = status === 'id-conflict' || status === 'suspected-duplicate';
    return {
      id,
      status,
      current,
      variants,
      suspectedMatches,
      resolutionRequired: unresolved,
      recommendedAction: unresolved ? 'unresolved' : status === 'same' ? 'skip' : 'add'
    };
  });

  return {
    items,
    summary: {
      new: items.filter(({ status }) => status === 'new').length,
      same: items.filter(({ status }) => status === 'same').length,
      idConflict: items.filter(({ status }) => status === 'id-conflict').length,
      suspectedDuplicate: items.filter(({ status }) => status === 'suspected-duplicate').length,
      unresolved: items.filter(({ resolutionRequired }) => resolutionRequired).length
    }
  };
}

export function planRouteModuleImport(routePackage, existingModules) {
  const parsed = parseRouteModulePackage(routePackage);
  return parsed.modules.map((incoming) => compareIncomingRouteModule(incoming, existingModules));
}

export function mergeRouteModulePresets(presets, existingModules = []) {
  const selected = (Array.isArray(presets) ? presets : []).map((preset, index) => ({
    id: String(preset?.id || `preset-${index + 1}`),
    name: String(preset?.name || `分支文件 ${index + 1}`),
    package: parseRouteModulePackage(preset?.package || preset)
  }));
  if (!selected.length) throw new RouteModuleError('NO_PRESETS_SELECTED', '请至少选择一份分支文件');
  const existing = new Map((Array.isArray(existingModules) ? existingModules : []).map((module) => {
    const normalized = normalizeRouteModule(module);
    return [normalized.id, normalized];
  }));
  const groups = new Map();
  for (const preset of selected) {
    for (const module of preset.package.modules) {
      const entries = groups.get(module.id) || [];
      entries.push({ presetId: preset.id, presetName: preset.name, module });
      groups.set(module.id, entries);
    }
  }
  const items = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, sources]) => {
    const variants = [];
    for (const source of sources) {
      const existingVariant = variants.find(({ module }) => equalModules(module, source.module));
      if (existingVariant) existingVariant.sources.push({ presetId: source.presetId, presetName: source.presetName });
      else variants.push({ module: source.module, sources: [{ presetId: source.presetId, presetName: source.presetName }] });
    }
    const current = existing.get(id) || null;
    let status;
    if (variants.length > 1) status = 'conflict';
    else if (!current) status = 'new';
    else status = equalModules(current, variants[0].module) ? 'same' : 'conflict';
    return {
      id,
      status,
      current,
      variants,
      selectedModule: variants.at(-1).module,
      recommendedAction: status === 'same' ? 'skip' : status === 'new' ? 'add' : 'stage-update'
    };
  });
  return {
    selectedPresets: selected.map(({ id, name, package: routePackage }) => ({ id, name, moduleCount: routePackage.modules.length })),
    items,
    summary: {
      new: items.filter(({ status }) => status === 'new').length,
      same: items.filter(({ status }) => status === 'same').length,
      conflict: items.filter(({ status }) => status === 'conflict').length
    }
  };
}

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
    if (!local.valid || !this.getCapabilities().validate) return { source: 'prototype-local', ...local };
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
