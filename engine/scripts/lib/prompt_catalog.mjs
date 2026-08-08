// Stable public facade. Domain implementations live in ./prompt-catalog/.
export {
  ASSET_BINDING_MARKERS,
  PROMPT_CATALOG_VERSION,
  bindAssetPromptFields,
  canonicalJson,
  renderPromptAst,
  semanticFingerprint,
} from "./prompt-catalog/core.mjs";

export { loadPromptCatalog, loadPromptCatalogSync } from "./prompt-catalog/loader.mjs";

export {
  applyModifierOperations,
  makeBaseRouteFingerprint,
  makeCatalogFingerprint,
  makeConditionModuleFingerprint,
  makeConditionModuleRegistryFingerprint,
  makeModifierFingerprint,
  makeResolvedFingerprintInputs,
  resolveBaseRoute,
  resolvePromptTemplate,
  resolveSelectedConditionModules,
} from "./prompt-catalog/resolver.mjs";

export {
  compileLegacyDefinition,
  getApiDefaultTemplates,
  getCatalogUrl,
  getLegacyDefinitionPath,
  serializeLegacyDefinition,
} from "./prompt-catalog/legacy.mjs";

export { validatePromptCatalog } from "./prompt-catalog/validation.mjs";
