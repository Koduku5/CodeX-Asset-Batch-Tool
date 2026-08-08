import {
  RouteModuleError,
  STABLE_ID_PATTERN,
  clone,
  findSuspectedSameRouteModules,
  isObject,
  normalizeRouteModule,
  routeModulesEqual,
  routePresetNamesEqual,
  validateRouteModule,
} from './core.mjs';

export const ROUTE_MODULE_PACKAGE_KIND = 'ka-prompt-route-module-package';
export const ROUTE_MODULE_PACKAGE_VERSION = 1;
export const ROUTE_BRANCH_FILE_KIND = 'ka-prompt-route-branch-file';
export const ROUTE_BRANCH_FILE_VERSION = 1;
export const ROUTE_PRESET_PACKAGE_KIND = 'ka-prompt-route-preset-package';
export const ROUTE_PRESET_PACKAGE_VERSION = 1;

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
    source: exchangeSource(source),
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
      status: routeModulesEqual(current, incoming) ? 'same' : 'conflict',
      recommendedAction: routeModulesEqual(current, incoming) ? 'skip' : 'stage-update',
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
      const existingVariant = variants.find(({ module }) => routeModulesEqual(module, source.module));
      if (existingVariant) existingVariant.sources.push({ presetId: source.presetId, presetName: source.presetName });
      else variants.push({ module: source.module, sources: [{ presetId: source.presetId, presetName: source.presetName }] });
    }
    const current = existing.get(id) || null;
    let status;
    if (variants.length > 1) status = 'conflict';
    else if (!current) status = 'new';
    else status = routeModulesEqual(current, variants[0].module) ? 'same' : 'conflict';
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
