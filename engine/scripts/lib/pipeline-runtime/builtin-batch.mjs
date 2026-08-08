import {
  makeConditionModuleRegistryFingerprint,
  resolvePromptTemplate,
} from "../prompt_catalog.mjs";
import { MAX_REFERENCE_IMAGE_BYTES } from "./image-validation.mjs";
import {
  BUILTIN_CATALOG_FINGERPRINT,
  BUILTIN_GENERATION_LIMITS,
  BUILTIN_REFERENCE_MODE_IDS,
  IMAGE_SHEET_ORDER,
  PROMPT_CATALOG,
} from "./prompt-context.mjs";
import { normalizeCustomFieldLabels } from "./prompt-fields.mjs";
import {
  canonicalJson,
  canonicalSha256,
  cleanText,
  hasExactKeys,
  isObject,
} from "./runtime-core.mjs";

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
    (item) => isObject(item) && Object.hasOwn(item, "selectedConditionModuleIds"),
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

export const validateBuiltinPromptPreset = (preset) => (
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
  validateRouteFingerprintsBySheet(preset.routeFingerprintsBySheet, preset.enabledSheets) &&
  Number.isFinite(Date.parse(preset.confirmedAt)) &&
  validateBuiltinReferencesBySheet(preset.referencesBySheet) &&
  validateBuiltinReferenceModeBySheet(preset.referenceModeBySheet, preset.referencesBySheet) &&
  validateBuiltinPromptOverridesBySheet(preset.promptOverridesBySheet)
);

export const validateBuiltinPromptBatch = (batch) => validateBuiltinPromptPreset(batch);

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
