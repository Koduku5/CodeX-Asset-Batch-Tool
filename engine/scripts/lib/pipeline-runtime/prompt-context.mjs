import {
  compileLegacyDefinition,
  loadPromptCatalogSync,
  makeCatalogFingerprint,
  resolvePromptTemplate,
} from "../prompt_catalog.mjs";
import { canonicalJson, cleanText, hasExactKeys, isObject } from "./runtime-core.mjs";

export const PROMPT_CATALOG = loadPromptCatalogSync();
export const COMPILED_LEGACY_PROMPT_DEFINITION = compileLegacyDefinition(PROMPT_CATALOG);
export const BUILTIN_CATALOG_FINGERPRINT = makeCatalogFingerprint(PROMPT_CATALOG);
export const VALIDATED_LEGACY_PROMPT_DEFINITIONS = new WeakSet();
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
  if (!hasExactKeys(config.routes, IMAGE_SHEET_ORDER)) return false;
  return IMAGE_SHEET_ORDER.every((sheetName) => {
    const route = config.routes[sheetName];
    return hasExactKeys(route, ["outputFolder"]) && Boolean(cleanText(route.outputFolder));
  });
};

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

export const resolveCatalogPromptTemplate = ({
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
