import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const BUILTIN_BATCH_REQUEST_VERSION = 1;
const STYLE_IDS = Object.freeze(['anime', 'cg', 'live-action']);
const SHEET_NAMES = Object.freeze(['角色', '生物', '群演', '场景', '道具']);
const GENERATION_LIMITS = Object.freeze([5, 0, 10]);
const REFERENCE_MODE_MAP = Object.freeze({
  style: 'style',
  'visual-consistency': 'visual_consistency',
  visual_consistency: 'visual_consistency',
  custom: 'custom'
});
const STYLE_SET = new Set(STYLE_IDS);
const SHEET_SET = new Set(SHEET_NAMES);
const CORE_PROMPT_FIELD_LABELS = new Set([
  'Use case', 'Input images', 'Asset type', 'Primary request', 'Scene/backdrop',
  'Style/medium', 'Composition/framing', 'Lighting/mood', 'Color/tonality',
  'Materials/textures', 'Constraints', 'Avoid'
]);
const NORMALIZED_CORE_PROMPT_FIELD_LABELS = new Set(
  [...CORE_PROMPT_FIELD_LABELS].map((label) => label.toLocaleLowerCase('zh-CN'))
);
const MAX_CUSTOM_PROMPT_FIELDS = 24;

export class BuiltinBatchServiceError extends Error {
  constructor(code, message, { status = 400, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'BuiltinBatchServiceError';
    this.code = code;
    this.status = status;
  }
}

const fail = (code, message, options) => {
  throw new BuiltinBatchServiceError(code, message, options);
};

const exactKeys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');

const hasPromptOverrideKeys = (value) => exactKeys(value, ['routeMode', 'promptText'])
  || exactKeys(value, ['routeMode', 'promptText', 'customFieldLabels']);

const normalizeCustomFieldLabels = (value, sheetName) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CUSTOM_PROMPT_FIELDS) {
    fail('INVALID_PROMPT_OVERRIDE', `${sheetName} 的自定义提示词字段无效`);
  }
  const labels = value.map((label) => typeof label === 'string' ? label.trim() : '');
  const normalized = labels.map((label) => label.toLocaleLowerCase('zh-CN'));
  if (
    labels.some((label, index) => !label || label !== value[index] || label.length > 80 || /[:\r\n]/u.test(label) || NORMALIZED_CORE_PROMPT_FIELD_LABELS.has(normalized[index]))
    || new Set(normalized).size !== labels.length
  ) {
    fail('INVALID_PROMPT_OVERRIDE', `${sheetName} 的自定义提示词字段名称无效或重复`);
  }
  return labels;
};

const isInside = (root, target, { allowRoot = false } = {}) => {
  const offset = relative(root, target);
  if (!offset) return allowRoot;
  return offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
};

const rootFromResolution = (value) => {
  const candidate = typeof value === 'string' ? value : value?.rootPath;
  if (typeof candidate !== 'string' || !isAbsolute(candidate)) fail('PROJECT_ROOT_UNAVAILABLE', '无法解析项目运行目录', { status: 503 });
  return resolve(candidate);
};

const canonicalProjectRoot = async (candidate) => {
  try {
    const info = await lstat(candidate);
    const canonical = await realpath(candidate);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('PROJECT_ROOT_UNSAFE', '项目运行目录不安全', { status: 409 });
    return canonical;
  } catch (error) {
    if (error instanceof BuiltinBatchServiceError) throw error;
    fail('PROJECT_ROOT_UNAVAILABLE', '项目运行目录不可用', { status: 503, cause: error });
  }
};

const validateFullSheetObject = (value, label) => {
  if (!exactKeys(value, SHEET_NAMES)) fail('INVALID_BATCH_REQUEST', `${label} 必须完整包含角色、生物、群演、场景、道具`);
  return value;
};

const normalizeEnabledSheets = (value) => {
  if (!Array.isArray(value) || !value.length || new Set(value).size !== value.length || value.some((sheet) => !SHEET_SET.has(sheet))) {
    fail('INVALID_ENABLED_SHEETS', '本次生成类别无效');
  }
  const ordered = SHEET_NAMES.filter((sheet) => value.includes(sheet));
  if (ordered.join('\0') !== value.join('\0')) fail('INVALID_ENABLED_SHEETS', '本次生成类别必须按角色、生物、群演、场景、道具排序');
  return ordered;
};

const normalizeRequest = (value) => {
  if (!exactKeys(value, [
    'version', 'styleId', 'generationLimit', 'enabledSheets', 'referenceModeBySheet',
    'referenceIdsBySheet', 'promptOverridesBySheet'
  ])) fail('INVALID_BATCH_REQUEST', '批次配置字段不完整或包含未知字段');
  if (value.version !== BUILTIN_BATCH_REQUEST_VERSION) fail('INVALID_BATCH_VERSION', '批次请求版本不受支持');
  if (!STYLE_SET.has(value.styleId)) fail('INVALID_BATCH_STYLE', '制作风格无效');
  if (!GENERATION_LIMITS.includes(value.generationLimit)) fail('INVALID_GENERATION_LIMIT', '本次出图数量无效');
  const enabledSheets = normalizeEnabledSheets(value.enabledSheets);
  validateFullSheetObject(value.referenceModeBySheet, '参考图方式');
  validateFullSheetObject(value.referenceIdsBySheet, '参考图选择');
  validateFullSheetObject(value.promptOverridesBySheet, '提示词覆盖');
  const referenceModeBySheet = {};
  const referenceIdsBySheet = {};
  const promptOverridesBySheet = {};
  for (const sheetName of SHEET_NAMES) {
    const rawMode = value.referenceModeBySheet[sheetName];
    const mode = REFERENCE_MODE_MAP[rawMode];
    if (!mode) fail('INVALID_REFERENCE_MODE', `${sheetName} 的参考图方式无效`);
    referenceModeBySheet[sheetName] = mode;
    const ids = value.referenceIdsBySheet[sheetName];
    if (!Array.isArray(ids) || ids.length > 16 || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== 'string' || !/^ref-[a-f0-9]{64}$/u.test(id))) {
      fail('INVALID_REFERENCE_SELECTION', `${sheetName} 的参考图选择无效`);
    }
    referenceIdsBySheet[sheetName] = [...ids];
    const override = value.promptOverridesBySheet[sheetName];
    if (override === null) {
      promptOverridesBySheet[sheetName] = null;
    } else {
      if (!hasPromptOverrideKeys(override) || !['default', 'reference'].includes(override.routeMode) || typeof override.promptText !== 'string' || override.promptText.length > 128 * 1024) {
        fail('INVALID_PROMPT_OVERRIDE', `${sheetName} 的提示词覆盖无效`);
      }
      const customFieldLabels = normalizeCustomFieldLabels(override.customFieldLabels, sheetName);
      promptOverridesBySheet[sheetName] = {
        routeMode: override.routeMode,
        promptText: override.promptText,
        ...(customFieldLabels.length ? { customFieldLabels } : {})
      };
    }
  }
  return {
    styleId: value.styleId,
    generationLimit: value.generationLimit,
    enabledSheets,
    referenceModeBySheet,
    referenceIdsBySheet,
    promptOverridesBySheet
  };
};

const renderFields = (fields) => fields.map(({ label, value }) => `${label}: ${String(value ?? '')}`).join('\n');

const atomicWriteJson = async (target, value) => {
  const temporary = `${target}.tmp-${randomUUID()}`;
  const backup = `${target}.backup-${randomUUID()}`;
  let hasBackup = false;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    try {
      await rename(target, backup);
      hasBackup = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    try {
      await rename(temporary, target);
    } catch (error) {
      if (hasBackup) {
        await rename(backup, target);
        hasBackup = false;
      }
      throw error;
    }
    if (hasBackup) {
      await rm(backup, { force: true });
      hasBackup = false;
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
    if (hasBackup) await rename(backup, target).catch(() => {});
    await rm(backup, { force: true }).catch(() => {});
  }
};

const publicPresetSummary = (preset, referenceEntries = []) => {
  const referenceIdsByFingerprint = new Map(referenceEntries.map((entry) => [
    `${entry.styleId}\0${entry.sheetName}\0${entry.sha256}`,
    entry.referenceId
  ]));
  return {
    version: preset.version,
    confirmedAt: preset.confirmedAt,
    styleId: preset.styleId,
    generationLimit: preset.generationLimit,
    enabledSheets: [...preset.enabledSheets],
    referenceCountsBySheet: Object.fromEntries(SHEET_NAMES.map((sheetName) => [sheetName, preset.referencesBySheet[sheetName].length])),
    selectedReferenceIdsBySheet: Object.fromEntries(SHEET_NAMES.map((sheetName) => [
      sheetName,
      preset.referencesBySheet[sheetName]
        .map((snapshot) => referenceIdsByFingerprint.get(`${preset.styleId}\0${sheetName}\0${snapshot.sha256}`))
        .filter(Boolean)
    ])),
    referenceModeBySheet: { ...preset.referenceModeBySheet },
    catalogFingerprint: preset.catalogFingerprint,
    routeFingerprintsBySheet: { ...preset.routeFingerprintsBySheet }
  };
};

export function createBuiltinBatchService({
  resolveProjectRoot,
  materializeProjectRuntime,
  referenceStore,
  getCatalog,
  getPipelineRuntime,
  makeCatalogFingerprint,
  resolvePromptTemplate,
  compileLegacyDefinition,
  clock = () => new Date()
} = {}) {
  for (const [name, fn] of Object.entries({
    resolveProjectRoot, materializeProjectRuntime, getCatalog, getPipelineRuntime,
    makeCatalogFingerprint, resolvePromptTemplate, compileLegacyDefinition
  })) {
    if (typeof fn !== 'function') throw new TypeError(`${name} must be a function`);
  }
  if (!referenceStore || typeof referenceStore.listImages !== 'function') throw new TypeError('referenceStore is required');
  const writes = new Map();
  const withProjectWrite = async (projectId, operation) => {
    const prior = writes.get(projectId) || Promise.resolve();
    const current = prior.catch(() => {}).then(operation);
    writes.set(projectId, current);
    try { return await current; } finally { if (writes.get(projectId) === current) writes.delete(projectId); }
  };

  const savePreset = ({ projectId, configuration }) => withProjectWrite(projectId, async () => {
    const request = normalizeRequest(configuration);
    await materializeProjectRuntime({ projectId });
    const projectRoot = await canonicalProjectRoot(rootFromResolution(await resolveProjectRoot(projectId)));
    const cacheRoot = join(projectRoot, 'cache');
    if (!isInside(projectRoot, cacheRoot)) fail('PROJECT_ROOT_UNSAFE', '项目 Cache 路径不安全', { status: 409 });
    await mkdir(cacheRoot, { recursive: true });
    const [catalog, runtime, referenceEntries] = await Promise.all([
      getCatalog(),
      getPipelineRuntime(),
      referenceStore.listImages({ projectId, styleId: request.styleId })
    ]);
    const referencesById = new Map(referenceEntries.map((entry) => [entry.referenceId, entry]));
    const referencesBySheet = {};
    for (const sheetName of SHEET_NAMES) {
      referencesBySheet[sheetName] = request.referenceIdsBySheet[sheetName].map((referenceId) => {
        const entry = referencesById.get(referenceId);
        if (!entry || entry.sheetName !== sheetName || entry.styleId !== request.styleId) {
          fail('REFERENCE_SELECTION_MISMATCH', `${sheetName} 中包含不属于当前风格或类别的参考图`, { status: 409 });
        }
        return { path: entry.path, sourceName: entry.sourceName, size: entry.size, sha256: entry.sha256 };
      });
      if (request.referenceModeBySheet[sheetName] === 'visual_consistency' && referencesBySheet[sheetName].length < 2) {
        fail('INSUFFICIENT_REFERENCE_IMAGES', `${sheetName} 使用视觉风格统一时至少需要两张参考图`);
      }
    }
    const promptOverridesBySheet = {};
    for (const sheetName of SHEET_NAMES) {
      const count = referencesBySheet[sheetName].length;
      const routeMode = count > 0 ? 'reference' : 'default';
      const selectedOverride = request.promptOverridesBySheet[sheetName];
      if (selectedOverride !== null && selectedOverride.routeMode !== routeMode) {
        fail('PROMPT_OVERRIDE_MODE_MISMATCH', `${sheetName} 的提示词覆盖与当前参考图状态不一致`);
      }
      if (selectedOverride !== null) {
        promptOverridesBySheet[sheetName] = selectedOverride;
        continue;
      }
      const resolved = resolvePromptTemplate(catalog, {
        style: request.styleId,
        asset: sheetName,
        referenceMode: count > 0 ? request.referenceModeBySheet[sheetName].replaceAll('_', '-') : 'none',
        referenceCount: count
      });
      promptOverridesBySheet[sheetName] = { routeMode, promptText: renderFields(resolved.promptFields) };
    }
    const base = {
      styleId: request.styleId,
      generationLimit: request.generationLimit,
      enabledSheets: request.enabledSheets,
      referencesBySheet,
      referenceModeBySheet: request.referenceModeBySheet,
      promptOverridesBySheet
    };
    const preset = {
      version: 6,
      catalogFingerprint: makeCatalogFingerprint(catalog),
      routeFingerprintsBySheet: runtime.makeBuiltinRouteFingerprintsBySheet(base, catalog),
      confirmedAt: clock().toISOString(),
      ...base
    };
    if (!runtime.validateBuiltinPromptPreset(preset) || !runtime.builtinPromptPresetMatchesCatalog(preset, catalog)) {
      fail('BUILTIN_PRESET_INVALID', '批次配置无法通过正式运行时校验', { status: 422 });
    }
    const definition = compileLegacyDefinition(catalog);
    for (const sheetName of preset.enabledSheets) {
      const promptSpec = runtime.makeBuiltinPromptSpec(definition, preset, {
        sheetName,
        productionNotes: '批次配置校验占位制作说明'
      });
      if (promptSpec.status !== 'configured') {
        fail('BUILTIN_PROMPT_NOT_CONFIGURED', `${sheetName} 的正式提示词尚未配置：${promptSpec.message}`, { status: 422 });
      }
    }
    const target = join(cacheRoot, '内置提示词预设.json');
    if (!isInside(projectRoot, target)) fail('PROJECT_ROOT_UNSAFE', '批次预设路径不安全', { status: 409 });
    await atomicWriteJson(target, preset);
    return publicPresetSummary(preset, referenceEntries);
  });

  const readPreset = async ({ projectId }) => {
    const projectRoot = await canonicalProjectRoot(rootFromResolution(await resolveProjectRoot(projectId)));
    const target = join(projectRoot, 'cache', '内置提示词预设.json');
    if (!isInside(projectRoot, target)) fail('PROJECT_ROOT_UNSAFE', '批次预设路径不安全', { status: 409 });
    try {
      const preset = JSON.parse(await readFile(target, 'utf8'));
      const runtime = await getPipelineRuntime();
      const catalog = await getCatalog();
      if (!runtime.validateBuiltinPromptPreset(preset) || !runtime.builtinPromptPresetMatchesCatalog(preset, catalog)) {
        fail('BUILTIN_PRESET_INVALID', '当前项目的批次预设已失效', { status: 409 });
      }
      const referenceEntries = await referenceStore.listImages({ projectId, styleId: preset.styleId });
      return publicPresetSummary(preset, referenceEntries);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof BuiltinBatchServiceError) throw error;
      fail('BUILTIN_PRESET_INVALID', '当前项目的批次预设无法读取', { status: 409, cause: error });
    }
  };

  return Object.freeze({ savePreset, readPreset });
}
