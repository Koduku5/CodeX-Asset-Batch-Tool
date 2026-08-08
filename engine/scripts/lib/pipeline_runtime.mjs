import {
  ASSET_BINDING_MARKERS,
  bindAssetPromptFields,
  compileLegacyDefinition,
  loadPromptCatalogSync,
  makeCatalogFingerprint,
  makeConditionModuleRegistryFingerprint,
  resolvePromptTemplate,
} from "./prompt_catalog.mjs";
import {
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_REFERENCE_IMAGE_PIXELS,
  MAX_VALIDATED_PNG_BYTES,
  assertSafeOutputPath,
  isPathWithinOrSame,
  readStableFileSnapshot,
  readValidatedPngInfo,
  readValidatedReferenceImageInfo,
  referenceImageDimensionsAreSafe,
  validatePngBytes,
  validateReferenceImageBytes,
} from "./pipeline-runtime/image-validation.mjs";
import {
  IMAGE_BACKENDS,
  MAX_EXCEL_CELL_CHARACTERS,
  assertExcelCellValue,
  attemptEntryFor,
  canonicalJson,
  canonicalSha256,
  canonicalize,
  cleanText,
  hasExactKeys,
  isObject,
  latestJsonMtime,
  neutralizeExcelFormula,
  normalizeAttemptEntry,
  normalizeAttemptLedger,
  parseJsonText,
  readJsonFile,
  requiredFileInfo,
  resolveImageOutputPath,
  sha256,
  stripBom,
  writeJsonAtomic,
} from "./pipeline-runtime/runtime-core.mjs";

export {
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_REFERENCE_IMAGE_PIXELS,
  MAX_VALIDATED_PNG_BYTES,
  assertSafeOutputPath,
  isPathWithinOrSame,
  readStableFileSnapshot,
  readValidatedPngInfo,
  readValidatedReferenceImageInfo,
  referenceImageDimensionsAreSafe,
  validatePngBytes,
  validateReferenceImageBytes,
};
export {
  IMAGE_BACKENDS,
  MAX_EXCEL_CELL_CHARACTERS,
  assertExcelCellValue,
  attemptEntryFor,
  canonicalJson,
  canonicalSha256,
  canonicalize,
  cleanText,
  hasExactKeys,
  isObject,
  latestJsonMtime,
  neutralizeExcelFormula,
  normalizeAttemptEntry,
  normalizeAttemptLedger,
  parseJsonText,
  readJsonFile,
  requiredFileInfo,
  resolveImageOutputPath,
  sha256,
  stripBom,
  writeJsonAtomic,
};
export {
  PIPELINE_LOCK_PROTOCOL_VERSION,
  acquirePipelineLock,
  readPipelineLock,
  releasePipelineLock,
  requirePipelineLock,
  rotatePipelineLock,
} from "./pipeline-runtime/lock-protocol.mjs";

const PROMPT_CATALOG = loadPromptCatalogSync();
const COMPILED_LEGACY_PROMPT_DEFINITION = compileLegacyDefinition(PROMPT_CATALOG);
const BUILTIN_CATALOG_FINGERPRINT = makeCatalogFingerprint(PROMPT_CATALOG);
const VALIDATED_LEGACY_PROMPT_DEFINITIONS = new WeakSet();
const RESOLVED_PROMPT_TEMPLATE_CACHE = new Map();

export const IMAGE_SHEET_ORDER = Object.freeze([
  ...COMPILED_LEGACY_PROMPT_DEFINITION.sheetOrder,
]);
export const BUILTIN_PROMPT_FIELD_ORDER = Object.freeze([
  ...COMPILED_LEGACY_PROMPT_DEFINITION.fieldOrder,
]);
export const BUILTIN_REFERENCE_MODE_IDS = Object.freeze(
  PROMPT_CATALOG.catalog.enums.referenceModes
    .filter((referenceMode) => referenceMode !== "none")
    .map((referenceMode) => referenceMode.replaceAll("-", "_")),
);
export const BUILTIN_GENERATION_LIMITS = Object.freeze([5, 0, 10]);
const CUSTOM_REFERENCE_TEMPLATE = resolvePromptTemplate(PROMPT_CATALOG, {
  style: "anime",
  asset: "character",
  referenceMode: "custom",
  referenceCount: 1,
});
const STYLE_REFERENCE_TEMPLATE = resolvePromptTemplate(PROMPT_CATALOG, {
  style: "anime",
  asset: "character",
  referenceMode: "style",
  referenceCount: 1,
});
const styleReferenceAnalysisMarker =
  STYLE_REFERENCE_TEMPLATE.fields["Primary request"]
    .split("\n")
    .slice(1)
    .join("\n")
    .match(/【[^】]+】/u)?.[0];
if (!styleReferenceAnalysisMarker) {
  throw new Error("风格参考提示词缺少 Agent 共同风格分析占位");
}
export const CUSTOM_INPUT_IMAGES_MARKER =
  CUSTOM_REFERENCE_TEMPLATE.fields["Input images"].split("\n", 1)[0];
export const CUSTOM_PRIMARY_REQUEST_MARKER =
  CUSTOM_REFERENCE_TEMPLATE.fields["Primary request"];
export const CUSTOM_USE_CASE_INSTRUCTION = CUSTOM_REFERENCE_TEMPLATE.fields["Use case"];
export const STYLE_REFERENCE_ANALYSIS_MARKER = styleReferenceAnalysisMarker;
export const ASSET_ID_PATTERNS = Object.freeze({
  角色: /^CHAR-\d{3,}-EP[1-9]\d*$/,
  生物: /^CREATURE-\d{3,}-EP[1-9]\d*$/,
  群演: /^CROWD-\d{3,}-EP[1-9]\d*$/,
  场景: /^SCENE-\d{3,}-EP[1-9]\d*$/,
  道具: /^PROP-\d{3,}-EP[1-9]\d*$/,
});
export const MAX_IMAGE_ATTEMPTS = 2;

export const validateImageRoutes = (config) => {
  if (
    !hasExactKeys(config, ["version", "sheetOrder", "routes"]) ||
    config.version !== 1 ||
    !isObject(config.routes) ||
    !Array.isArray(config.sheetOrder)
  ) {
    return false;
  }
  if (JSON.stringify(config.sheetOrder) !== JSON.stringify(IMAGE_SHEET_ORDER)) return false;
  if (!hasExactKeys(config.routes, IMAGE_SHEET_ORDER)) {
    return false;
  }
  return IMAGE_SHEET_ORDER.every((sheetName) => {
    const route = config.routes[sheetName];
    return (
      hasExactKeys(route, ["outputFolder"]) &&
      Boolean(cleanText(route.outputFolder))
    );
  });
};

export const normalizePromptText = (value) =>
  String(value ?? "").replace(/\r\n?/g, "\n").trim();

export const AGENT_PLACEHOLDER_CONTRACT_VERSION = 1;
const AGENT_PLACEHOLDER_PREFIXES = ["【由agent 具体判断说明：", "【由 Agent "];
const AGENT_PLACEHOLDER_PATTERN =
  /【由agent 具体判断说明：([^\r\n【】]+)】|【由 Agent ([^\r\n【】]+)】/gu;

const textRanges = (text, needle) => {
  const ranges = [];
  if (!needle) return ranges;
  let offset = 0;
  while (offset <= text.length - needle.length) {
    const start = text.indexOf(needle, offset);
    if (start < 0) break;
    ranges.push({ start, end: start + needle.length });
    offset = start + Math.max(needle.length, 1);
  }
  return ranges;
};

const rangeContains = (ranges, start, end = start + 1) =>
  ranges.some((range) => start >= range.start && end <= range.end);

export const analyzeAgentPromptFields = (
  fields,
  { ignoredValues = [], ignoredSourceRanges = [] } = {},
) => {
  const items = [];
  const errors = [];
  if (!Array.isArray(fields)) {
    return {
      version: AGENT_PLACEHOLDER_CONTRACT_VERSION,
      valid: false,
      items,
      errors: ["提示词字段不是数组"],
    };
  }
  for (const [fieldIndex, field] of fields.entries()) {
    const label = normalizePromptText(field?.label);
    const value = normalizePromptText(field?.value);
    const ignoredRanges = [
      ...(Array.isArray(ignoredValues) ? ignoredValues : []).flatMap((ignoredValue) =>
        textRanges(value, normalizePromptText(ignoredValue)),
      ),
      ...(Array.isArray(ignoredSourceRanges) ? ignoredSourceRanges : []).filter(
        (range) =>
          range?.fieldIndex === fieldIndex &&
          Number.isInteger(range.start) &&
          Number.isInteger(range.end) &&
          range.start >= 0 &&
          range.end > range.start &&
          range.end <= value.length,
      ),
    ];
    const validRanges = [];
    let occurrence = 0;
    for (const match of value.matchAll(AGENT_PLACEHOLDER_PATTERN)) {
      const marker = match[0];
      const start = match.index;
      const end = start + marker.length;
      if (rangeContains(ignoredRanges, start, end)) continue;
      validRanges.push({ start, end });
      const instruction = normalizePromptText(match[1] ?? match[2]);
      if (!instruction) {
        errors.push(`${label || "未知字段"} 的 Agent 占位符缺少判断说明`);
        continue;
      }
      occurrence += 1;
      items.push({
        field: label,
        occurrence,
        mode: value === marker ? "field" : "inline",
        marker,
        instruction,
      });
    }
    for (const prefix of AGENT_PLACEHOLDER_PREFIXES) {
      let prefixOffset = 0;
      while (prefixOffset < value.length) {
        const start = value.indexOf(prefix, prefixOffset);
        if (start < 0) break;
        const covered = rangeContains(ignoredRanges, start) || rangeContains(validRanges, start);
        if (!covered) {
          errors.push(`${label || "未知字段"} 含未闭合或不符合格式的 Agent 占位符`);
        }
        prefixOffset = start + prefix.length;
      }
    }
  }
  return {
    version: AGENT_PLACEHOLDER_CONTRACT_VERSION,
    valid: errors.length === 0,
    items,
    errors,
  };
};

const normalizeCustomFieldLabels = (value) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 24) return null;
  const labels = value.map((label) => typeof label === "string" ? normalizePromptText(label) : "");
  const normalized = labels.map((label) => label.toLocaleLowerCase("zh-CN"));
  const reserved = new Set(BUILTIN_PROMPT_FIELD_ORDER.map((label) => label.toLocaleLowerCase("zh-CN")));
  if (
    labels.some((label, index) =>
      !label || label !== value[index] || label.length > 80 || /[:\r\n]/u.test(label) || reserved.has(normalized[index]),
    ) || new Set(normalized).size !== labels.length
  ) return null;
  return labels;
};

const parsePromptFields = (promptText, customFieldLabels = []) => {
  const fields = [];
  const allowedLabels = new Set([...BUILTIN_PROMPT_FIELD_ORDER, ...customFieldLabels]);
  for (const line of normalizePromptText(promptText).split("\n")) {
    const match = line.match(/^([^:\n]{1,80}):\s?(.*)$/);
    const label = match ? normalizePromptText(match[1]) : "";
    if (match && allowedLabels.has(label)) {
      fields.push({ label, value: match[2] });
    } else if (fields.length) {
      fields[fields.length - 1].value += `${fields[fields.length - 1].value ? "\n" : ""}${line}`;
    } else if (line.trim()) {
      fields.push({ label: "Prompt", value: line });
    }
  }
  return fields;
};

const promptFieldSchemaMatches = (route, fields, customFieldLabels = []) => {
  const expectedLabels = [
    ...route.promptFields.map((field) => normalizePromptText(field.label)),
    ...customFieldLabels,
  ];
  const actualLabels = fields.map((field) => field.label);
  const expectedLabelSet = new Set(expectedLabels);
  return (
    actualLabels.length === expectedLabels.length &&
    new Set(actualLabels).size === actualLabels.length &&
    actualLabels.every((label) => expectedLabelSet.has(label))
  );
};

const renderPromptFields = (fields) =>
  fields
    .map((field) => {
      const label = normalizePromptText(field.label);
      const value = normalizePromptText(field.value);
      return `${label}:${value ? ` ${value}` : ""}`;
    })
    .join("\n");

export const validateBuiltinPromptDefinition = (definition) => {
  try {
    const valid =
      canonicalJson(definition) === canonicalJson(COMPILED_LEGACY_PROMPT_DEFINITION);
    if (valid && isObject(definition)) VALIDATED_LEGACY_PROMPT_DEFINITIONS.add(definition);
    return valid;
  } catch {
    return false;
  }
};

const resolveCatalogPromptTemplate = ({
  style,
  asset,
  referenceMode,
  referenceCount,
  productionNotes,
  selectedConditionModuleIds,
}) => {
  const cacheKey = JSON.stringify({
    style,
    asset,
    referenceMode,
    referenceCount,
    productionNotes: String(productionNotes ?? ""),
    selectedConditionModuleIds: selectedConditionModuleIds ?? [],
  });
  if (!RESOLVED_PROMPT_TEMPLATE_CACHE.has(cacheKey)) {
    RESOLVED_PROMPT_TEMPLATE_CACHE.set(
      cacheKey,
      resolvePromptTemplate(PROMPT_CATALOG, {
        style,
        asset,
        referenceMode,
        referenceCount,
        productionNotes,
        selectedConditionModuleIds,
      }),
    );
  }
  return RESOLVED_PROMPT_TEMPLATE_CACHE.get(cacheKey);
};

const bindPromptValue = (value, productionNotes) =>
  bindAssetPromptFields(
    { value: normalizePromptText(value) },
    { productionNotes: cleanText(productionNotes) },
  ).value;

const bindProductionNotesWithRanges = (templateValue, productionNotes) => {
  const template = normalizePromptText(templateValue);
  const notes = String(productionNotes ?? "").replace(/\r\n?/g, "\n");
  const ranges = [];
  let value = "";
  let offset = 0;
  while (offset <= template.length) {
    const markerOffset = template.indexOf(ASSET_BINDING_MARKERS.productionNotes, offset);
    if (markerOffset < 0) {
      value += template.slice(offset);
      break;
    }
    value += template.slice(offset, markerOffset);
    const start = value.length;
    value += notes;
    ranges.push({ start, end: value.length });
    offset = markerOffset + ASSET_BINDING_MARKERS.productionNotes.length;
  }
  const leadingTrim = value.length - value.trimStart().length;
  const normalizedValue = value.trim();
  return {
    value: normalizedValue,
    ranges: ranges
      .map(({ start, end }) => ({
        start: Math.max(0, start - leadingTrim),
        end: Math.min(normalizedValue.length, end - leadingTrim),
      }))
      .filter(({ start, end }) => end > start),
  };
};

const productionNoteSourceRanges = (fields, unboundPromptFields, productionNotes) => {
  const templatesByLabel = new Map(
    unboundPromptFields.map(({ label, value }) => [normalizePromptText(label), value]),
  );
  return fields.flatMap((field, fieldIndex) => {
    const tracked = bindProductionNotesWithRanges(
      templatesByLabel.get(normalizePromptText(field?.label)),
      productionNotes,
    );
    return textRanges(normalizePromptText(field?.value), tracked.value).flatMap(
      ({ start: templateStart }) =>
        tracked.ranges.map(({ start, end }) => ({
          fieldIndex,
          start: templateStart + start,
          end: templateStart + end,
        })),
    );
  });
};

const productionNoteSourceAmbiguities = (
  fields,
  unboundPromptFields,
  productionNotes,
  preciseRanges,
) => {
  const notes = normalizePromptText(productionNotes);
  if (!notes) return [];
  const notesAnalysis = analyzeAgentPromptFields([
    { label: "productionNotes", value: notes },
  ]);
  if (notesAnalysis.items.length === 0 && notesAnalysis.errors.length === 0) return [];
  const templatesByLabel = new Map(
    unboundPromptFields.map(({ label, value }) => [normalizePromptText(label), value]),
  );
  return fields.flatMap((field, fieldIndex) => {
    const label = normalizePromptText(field?.label);
    const template = normalizePromptText(templatesByLabel.get(label));
    const bindingCount = textRanges(
      template,
      ASSET_BINDING_MARKERS.productionNotes,
    ).length;
    const noteCount = textRanges(normalizePromptText(field?.value), notes).length;
    if (!bindingCount || !noteCount) return [];
    const preciseCount = new Set(
      preciseRanges
        .filter((range) => range.fieldIndex === fieldIndex)
        .map((range) => `${range.start}:${range.end}`),
    ).size;
    if (preciseCount >= Math.min(bindingCount, noteCount)) return [];
    return [{
      fieldIndex,
      label,
      error: `${label || "未知字段"} 的 productionNotes 替换来源歧义：制作说明含 Agent 占位符，且编辑后无法精确定位其注入区间`,
    }];
  });
};

const validateReferenceSnapshot = (snapshot) =>
  hasExactKeys(snapshot, ["path", "sourceName", "size", "sha256"]) &&
  cleanText(snapshot.path) &&
  cleanText(snapshot.sourceName) &&
  Number.isInteger(snapshot.size) &&
  snapshot.size > 0 &&
  snapshot.size <= MAX_REFERENCE_IMAGE_BYTES &&
  /^[a-f0-9]{64}$/.test(cleanText(snapshot.sha256));

const validateBuiltinReferencesBySheet = (referencesBySheet) =>
  hasExactKeys(referencesBySheet, IMAGE_SHEET_ORDER) &&
  IMAGE_SHEET_ORDER.every(
    (sheetName) =>
      Array.isArray(referencesBySheet[sheetName]) &&
      referencesBySheet[sheetName].every(validateReferenceSnapshot),
  );

const validateBuiltinReferenceModeBySheet = (referenceModeBySheet, referencesBySheet) =>
  hasExactKeys(referenceModeBySheet, IMAGE_SHEET_ORDER) &&
  IMAGE_SHEET_ORDER.every((sheetName) => {
    const referenceMode = referenceModeBySheet[sheetName];
    const referenceCount = referencesBySheet[sheetName].length;
    return (
      BUILTIN_REFERENCE_MODE_IDS.includes(referenceMode) &&
      (referenceCount > 0 || referenceMode === "style") &&
      (referenceMode !== "visual_consistency" || referenceCount >= 2)
    );
  });

const validateBuiltinPromptOverridesBySheet = (promptOverridesBySheet) =>
  hasExactKeys(promptOverridesBySheet, IMAGE_SHEET_ORDER) &&
  IMAGE_SHEET_ORDER.every((sheetName) => {
    const override = promptOverridesBySheet[sheetName];
    const customFieldLabels = normalizeCustomFieldLabels(override?.customFieldLabels);
    return (
      (hasExactKeys(override, ["routeMode", "promptText"]) ||
        hasExactKeys(override, ["routeMode", "promptText", "customFieldLabels"])) &&
      ["default", "reference"].includes(override.routeMode) &&
      typeof override.promptText === "string" &&
      customFieldLabels !== null
    );
  });

const validateEnabledSheets = (enabledSheets) =>
  Array.isArray(enabledSheets) &&
  enabledSheets.length > 0 &&
  new Set(enabledSheets).size === enabledSheets.length &&
  enabledSheets.every((sheetName) => IMAGE_SHEET_ORDER.includes(sheetName)) &&
  JSON.stringify(enabledSheets) ===
    JSON.stringify(IMAGE_SHEET_ORDER.filter((sheetName) => enabledSheets.includes(sheetName)));

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const validateRouteFingerprintsBySheet = (routeFingerprintsBySheet, enabledSheets) =>
  hasExactKeys(routeFingerprintsBySheet, enabledSheets) &&
  enabledSheets.every((sheetName) =>
    SHA256_PATTERN.test(cleanText(routeFingerprintsBySheet[sheetName])),
  );

export const getBuiltinCatalogFingerprint = () => BUILTIN_CATALOG_FINGERPRINT;

export const getConditionModuleRegistryFingerprint = () =>
  makeConditionModuleRegistryFingerprint(PROMPT_CATALOG);

export const assertConditionMatchingQueueCurrent = (queue) => {
  const items = Array.isArray(queue?.items) ? queue.items : [];
  const carriesAssignments = items.some(
    (item) =>
      isObject(item) &&
      Object.hasOwn(item, "selectedConditionModuleIds"),
  );
  const matching = queue?.conditionMatching;
  if (!matching && !carriesAssignments) return false;
  if (
    !hasExactKeys(matching, [
      "version",
      "source",
      "catalogFingerprint",
      "conditionRegistryFingerprint",
    ]) ||
    matching.version !== 1 ||
    matching.source !== "cache/提示词分支匹配.json" ||
    matching.catalogFingerprint !== getBuiltinCatalogFingerprint() ||
    matching.conditionRegistryFingerprint !== getConditionModuleRegistryFingerprint()
  ) {
    throw new Error("提示词分支匹配与当前 Prompt Catalog 或分支注册表不一致，请重新执行智能匹配并建立队列");
  }
  for (const item of items) {
    if (
      !isObject(item) ||
      !Object.hasOwn(item, "selectedConditionModuleIds") ||
      !Array.isArray(item.selectedConditionModuleIds) ||
      new Set(item.selectedConditionModuleIds).size !== item.selectedConditionModuleIds.length ||
      item.selectedConditionModuleIds.some((id) => !cleanText(id))
    ) {
      throw new Error("出图队列的提示词分支选择不完整或已损坏，请重新建立队列");
    }
  }
  return true;
};

export const makeBuiltinCatalogRouteFingerprint = (
  styleId,
  sheetName,
  referenceMode,
  referenceCount,
  loadedCatalog = PROMPT_CATALOG,
) => {
  const count = Math.max(0, Number(referenceCount) || 0);
  const effectiveReferenceMode = count > 0 ? cleanText(referenceMode || "style") : "none";
  const resolved = resolvePromptTemplate(loadedCatalog, {
    style: styleId,
    asset: sheetName,
    referenceMode: effectiveReferenceMode,
    referenceCount: count,
  });
  const referenceModifierFingerprints = resolved.fingerprints.modifierFingerprints.map(
    ({ id, fingerprint }) => ({ id, fingerprint }),
  );
  if (referenceModifierFingerprints.length !== 1 || resolved.enhancer) {
    throw new Error("内置批次路由指纹只能包含一个参考模式条件修饰器");
  }
  return canonicalSha256({
    version: 1,
    compiler: loadedCatalog.catalog.compilation,
    activeFieldSchema: {
      id: resolved.activeFieldSchema,
      fields: loadedCatalog.catalog.fieldSchemas[resolved.activeFieldSchema],
    },
    baseRouteFingerprint: resolved.fingerprints.baseRouteFingerprint,
    referenceModifierFingerprints,
  });
};

export const makeBuiltinRouteFingerprintsBySheet = (
  batch,
  loadedCatalog = PROMPT_CATALOG,
) => {
  if (!validateEnabledSheets(batch?.enabledSheets)) {
    throw new Error("内置提示词配置缺少有效的 enabledSheets");
  }
  return Object.fromEntries(
    batch.enabledSheets.map((sheetName) => {
      const references = batch?.referencesBySheet?.[sheetName];
      if (!Array.isArray(references)) {
        throw new Error(`内置提示词配置缺少 ${sheetName} 参考图列表`);
      }
      return [
        sheetName,
        makeBuiltinCatalogRouteFingerprint(
          batch.styleId,
          sheetName,
          batch?.referenceModeBySheet?.[sheetName],
          references.length,
          loadedCatalog,
        ),
      ];
    }),
  );
};

export const validateBuiltinPromptPreset = (preset) => {
  return (
    hasExactKeys(preset, [
      "version",
      "catalogFingerprint",
      "routeFingerprintsBySheet",
      "confirmedAt",
      "styleId",
      "generationLimit",
      "enabledSheets",
      "referencesBySheet",
      "referenceModeBySheet",
      "promptOverridesBySheet",
    ]) &&
    preset.version === 6 &&
    SHA256_PATTERN.test(cleanText(preset.catalogFingerprint)) &&
    cleanText(preset.confirmedAt) &&
    cleanText(preset.styleId) &&
    BUILTIN_GENERATION_LIMITS.includes(preset.generationLimit) &&
    validateEnabledSheets(preset.enabledSheets) &&
    validateRouteFingerprintsBySheet(
      preset.routeFingerprintsBySheet,
      preset.enabledSheets,
    ) &&
    Number.isFinite(Date.parse(preset.confirmedAt)) &&
    validateBuiltinReferencesBySheet(preset.referencesBySheet) &&
    validateBuiltinReferenceModeBySheet(
      preset.referenceModeBySheet,
      preset.referencesBySheet,
    ) &&
    validateBuiltinPromptOverridesBySheet(preset.promptOverridesBySheet)
  );
};

export const validateBuiltinPromptBatch = (batch) => {
  return validateBuiltinPromptPreset(batch);
};

export const builtinPromptBatchMatchesCatalog = (
  batch,
  loadedCatalog = PROMPT_CATALOG,
) => {
  if (!validateBuiltinPromptBatch(batch)) return false;
  try {
    return (
      canonicalJson(batch.routeFingerprintsBySheet) ===
      canonicalJson(makeBuiltinRouteFingerprintsBySheet(batch, loadedCatalog))
    );
  } catch {
    return false;
  }
};

export const builtinPromptPresetMatchesCatalog = (
  preset,
  loadedCatalog = PROMPT_CATALOG,
) => {
  if (!validateBuiltinPromptPreset(preset)) return false;
  try {
    return (
      canonicalJson(preset.routeFingerprintsBySheet) ===
      canonicalJson(makeBuiltinRouteFingerprintsBySheet(preset, loadedCatalog))
    );
  } catch {
    return false;
  }
};

export const getBuiltinGenerationQuotaState = (batch, progressItems, queueKeys = null) => {
  const generationLimit = BUILTIN_GENERATION_LIMITS.includes(batch?.generationLimit)
    ? batch.generationLimit
    : 5;
  const generationSession = cleanText(batch?.confirmedAt);
  const allowedKeys = queueKeys instanceof Set ? queueKeys : null;
  const claimedKeys = new Set();
  if (generationSession && isObject(progressItems)) {
    for (const [key, state] of Object.entries(progressItems)) {
      if (
        (!allowedKeys || allowedKeys.has(key)) &&
        isObject(state) &&
        state.backend === "builtin" &&
        cleanText(state.builtinGenerationSession) === generationSession
      ) {
        claimedKeys.add(key);
      }
    }
  }
  const unlimited = generationLimit === 0;
  const claimed = claimedKeys.size;
  return {
    generationLimit,
    generationSession,
    claimedKeys,
    claimed,
    remaining: unlimited ? null : Math.max(0, generationLimit - claimed),
    limitReached: !unlimited && claimed >= generationLimit,
  };
};

export const builtinSheetIsEnabled = (batch, itemOrSheetName) => {
  const sheetName = cleanText(
    typeof itemOrSheetName === "string" ? itemOrSheetName : itemOrSheetName?.sheetName,
  );
  return Array.isArray(batch?.enabledSheets) && batch.enabledSheets.includes(sheetName);
};

export const validateApiPromptBatch = (batch) => {
  if (
    !hasExactKeys(batch, ["version", "confirmedAt", "bySheet"]) ||
    batch.version !== 2 ||
    !cleanText(batch.confirmedAt) ||
    !hasExactKeys(batch.bySheet, IMAGE_SHEET_ORDER)
  ) {
    return false;
  }
  return IMAGE_SHEET_ORDER.every(
    (sheetName) => typeof batch.bySheet[sheetName] === "string",
  );
};

export const makeBuiltinPromptSpec = (definition, batch, item) => {
  if (
    !VALIDATED_LEGACY_PROMPT_DEFINITIONS.has(definition) &&
    !validateBuiltinPromptDefinition(definition)
  ) {
    throw new Error("内置 image_gen 固定字段与 prompt catalog 编译产物不一致");
  }
  const sheetName = cleanText(item?.sheetName);
  const styleId = cleanText(batch?.styleId);
  const legacyStyleName = PROMPT_CATALOG.catalog.legacyNames.styles?.[styleId];
  const style = definition.styles?.[legacyStyleName];
  const defaultRoute = style?.bySheet?.[sheetName];
  if (!defaultRoute) {
    throw new Error(`内置 image_gen 路由不存在：${styleId || "未选择风格"}/${sheetName || "未知资产类型"}`);
  }
  const referenceImages = batch.referencesBySheet[sheetName].map((snapshot) => ({
    path: normalizePromptText(snapshot.path),
    sourceName: normalizePromptText(snapshot.sourceName),
    size: snapshot.size,
    sha256: normalizePromptText(snapshot.sha256),
  }));
  const routeMode = referenceImages.length > 0 ? "reference" : "default";
  const configuredReferenceMode = batch.referenceModeBySheet[sheetName];
  const referenceMode = routeMode === "reference" ? configuredReferenceMode : "none";
  const resolvedTemplate = resolveCatalogPromptTemplate({
    style: styleId,
    asset: sheetName,
    referenceMode,
    referenceCount: referenceImages.length,
    productionNotes: item?.productionNotes,
    selectedConditionModuleIds: item?.selectedConditionModuleIds ?? [],
  });
  const unboundResolvedTemplate = resolveCatalogPromptTemplate({
    style: styleId,
    asset: sheetName,
    referenceMode,
    referenceCount: referenceImages.length,
    productionNotes: ASSET_BINDING_MARKERS.productionNotes,
    selectedConditionModuleIds: item?.selectedConditionModuleIds ?? [],
  });
  const hasConditionResolution =
    Array.isArray(item?.selectedConditionModuleIds) && item.selectedConditionModuleIds.length > 0;
  const unmodifiedTemplate = hasConditionResolution
    ? resolveCatalogPromptTemplate({
        style: styleId,
        asset: sheetName,
        referenceMode,
        referenceCount: referenceImages.length,
        productionNotes: item?.productionNotes,
        selectedConditionModuleIds: [],
      })
    : resolvedTemplate;
  const route = {
    status: resolvedTemplate.status,
    referencePolicy: resolvedTemplate.referencePolicy,
    message: resolvedTemplate.message,
    promptFields: resolvedTemplate.promptFields,
  };
  const missingRequiredReference =
    defaultRoute.referencePolicy === "required" && referenceImages.length === 0;
  const override = batch.promptOverridesBySheet[sheetName];
  const defaultPromptText = renderPromptFields(route.promptFields);
  const unmodifiedPromptText = renderPromptFields(unmodifiedTemplate.promptFields);
  const editedPromptText = normalizePromptText(
    override?.routeMode === routeMode ? override.promptText : defaultPromptText,
  );
  const customFieldLabels = override?.routeMode === routeMode
    ? normalizeCustomFieldLabels(override.customFieldLabels) ?? []
    : [];
  const parsedFields = parsePromptFields(editedPromptText, customFieldLabels);
  const fieldSchemaValid = promptFieldSchemaMatches(route, parsedFields, customFieldLabels);
  const overrideApplied =
    override?.routeMode === routeMode && editedPromptText !== unmodifiedPromptText;
  const managedPrimaryRequestField = route.promptFields.find(
    (field) => field.label === "Primary request",
  );
  const managedUseCaseField = route.promptFields.find((field) => field.label === "Use case");
  const managedInputImagesField = route.promptFields.find(
    (field) => field.label === "Input images",
  );
  const productionNoteBindingSourceFields = referenceMode === "custom"
    ? []
    : [{
        label: "Primary request",
        value: routeMode === "reference"
          ? managedPrimaryRequestField?.value
          : parsedFields.find((field) => field.label === "Primary request")?.value,
      }];
  const insufficientUnificationImages =
    routeMode === "reference" &&
    referenceMode === "visual_consistency" &&
    referenceImages.length < 2;
  let fields = fieldSchemaValid
    ? parsedFields.map((field) => ({
        label: field.label,
        value:
          field.label === "Use case"
            ? managedUseCaseField?.value ?? field.value
            : field.label === "Input images"
              ? referenceMode === "custom"
                ? field.value
                : managedInputImagesField?.value ?? field.value
            : field.label === "Primary request"
              ? referenceMode === "custom"
                ? field.value
                : bindPromptValue(
                    routeMode === "reference"
                      ? managedPrimaryRequestField?.value
                      : field.value,
                    item?.productionNotes,
                  )
              : field.value,
      }))
    : parsedFields;
  if (fieldSchemaValid && hasConditionResolution) {
    const unmodifiedFields = new Map(
      unmodifiedTemplate.promptFields.map(({ label, value }) => [label, normalizePromptText(value)]),
    );
    const modifiedFields = new Map(
      resolvedTemplate.promptFields.map(({ label, value }) => [label, normalizePromptText(value)]),
    );
    fields = fields.map((field) => ({
      ...field,
      value:
        modifiedFields.get(field.label) !== unmodifiedFields.get(field.label)
          ? modifiedFields.get(field.label) ?? field.value
          : field.value,
    }));
  }
  const liveStylePlaceholder = fields.some(
    (field) =>
      field.label === "Style/medium" &&
      normalizePromptText(field.value).includes("【占位：等待填写真人电影风格提示词】"),
  );
  const inputImagesField = fields.find((field) => field.label === "Input images");
  const primaryRequestField = fields.find((field) => field.label === "Primary request");
  const customFieldsRequired =
    routeMode === "reference" &&
    referenceMode === "custom" &&
    (!normalizePromptText(inputImagesField?.value) ||
      normalizePromptText(inputImagesField?.value).includes(CUSTOM_INPUT_IMAGES_MARKER) ||
      !normalizePromptText(primaryRequestField?.value) ||
      normalizePromptText(primaryRequestField?.value).includes(
        CUSTOM_PRIMARY_REQUEST_MARKER,
      ));
  const promptText = fieldSchemaValid
    ? renderPromptFields(fields)
    : editedPromptText;
  const productionNoteRanges = fieldSchemaValid
    ? [
        ...productionNoteSourceRanges(
          fields,
          unboundResolvedTemplate.promptFields,
          cleanText(item?.productionNotes),
        ),
        ...productionNoteSourceRanges(
          fields,
          productionNoteBindingSourceFields,
          cleanText(item?.productionNotes),
        ),
      ]
    : [];
  const productionNoteAmbiguities = fieldSchemaValid
    ? productionNoteSourceAmbiguities(
        fields,
        unboundResolvedTemplate.promptFields,
        item?.productionNotes,
        productionNoteRanges,
      )
    : [];
  const ambiguousLabels = new Set(productionNoteAmbiguities.map(({ label }) => label));
  const analyzedPlaceholders = fieldSchemaValid
    ? analyzeAgentPromptFields(fields, { ignoredSourceRanges: productionNoteRanges })
    : null;
  const agentPlaceholderAnalysis = analyzedPlaceholders
    ? {
        ...analyzedPlaceholders,
        valid: analyzedPlaceholders.valid && productionNoteAmbiguities.length === 0,
        items: analyzedPlaceholders.items.filter(({ field }) => !ambiguousLabels.has(field)),
        errors: [
          ...productionNoteAmbiguities.map(({ error }) => error),
          ...analyzedPlaceholders.errors,
        ],
      }
    : {
        version: AGENT_PLACEHOLDER_CONTRACT_VERSION,
        valid: true,
        items: [],
        errors: [],
      };
  const customPlaceholderReady =
    defaultRoute.status === "placeholder" &&
    overrideApplied &&
    !liveStylePlaceholder;
  const status = missingRequiredReference
    ? "missing_reference"
    : insufficientUnificationImages
      ? "insufficient_reference_images"
      : !fieldSchemaValid
        ? "invalid_field_schema"
        : !agentPlaceholderAnalysis.valid
          ? "invalid_agent_placeholder"
          : customFieldsRequired
            ? "custom_fields_required"
            : !promptText
              ? "empty_prompt"
              : defaultRoute.status === "placeholder" && !customPlaceholderReady
                ? "placeholder"
                : "configured";
  return {
    styleId,
    sheetName,
    routeMode,
    referenceMode,
    status,
    message: missingRequiredReference
      ? "该路由必须添加至少一张参考图片。"
      : insufficientUnificationImages
        ? "视觉风格统一至少需要两张图片：图像 1 为主风格基准，图像 2～N 为待统一素材。"
        : !fieldSchemaValid
          ? `字段名称和数量必须完整，当前应包含：${route.promptFields
            .map((field) => normalizePromptText(field.label))
            .concat(customFieldLabels)
            .join("、")}`
          : !agentPlaceholderAnalysis.valid
            ? agentPlaceholderAnalysis.errors[0]
            : customFieldsRequired
              ? "已选择自定义参考图用途；请填写 Input images 和 Primary request，并删除模板中的中文提示。"
              : customPlaceholderReady
                ? "使用本批次编辑后的自定义提示词。"
                : normalizePromptText(defaultRoute.message),
    referencePolicy: defaultRoute.referencePolicy,
    promptText,
    fields,
    agentPlaceholderContract: {
      version: agentPlaceholderAnalysis.version,
      items: agentPlaceholderAnalysis.items,
    },
    referenceImages,
    ...(hasConditionResolution
      ? {
          conditionResolution: {
            selectedConditionModules: resolvedTemplate.selectedConditionModules ?? [],
            activeModifiers: resolvedTemplate.activeModifiers,
            enhancer: resolvedTemplate.enhancer,
            resolvedFingerprint: resolvedTemplate.fingerprints.resolvedFingerprint,
          },
        }
      : {}),
  };
};

export const makeAssetFingerprint = (item) =>
  sha256(
    JSON.stringify({
      version: 1,
      sheetName: cleanText(item?.sheetName),
      assetId: cleanText(item?.assetId),
      assetName: cleanText(item?.assetName),
      productionNotes: cleanText(item?.productionNotes),
      outputPath: cleanText(item?.outputPath),
    }),
  );

export const makeBuiltinPromptFingerprint = (assetFingerprint, promptSpec) =>
  sha256(JSON.stringify({ version: 1, assetFingerprint, promptSpec }));
