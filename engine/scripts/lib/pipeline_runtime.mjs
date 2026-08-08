// Stable public facade. Runtime domains live in ./pipeline-runtime/.
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
} from "./pipeline-runtime/image-validation.mjs";

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
} from "./pipeline-runtime/runtime-core.mjs";

export {
  PIPELINE_LOCK_PROTOCOL_VERSION,
  acquirePipelineLock,
  readPipelineLock,
  releasePipelineLock,
  requirePipelineLock,
  rotatePipelineLock,
} from "./pipeline-runtime/lock-protocol.mjs";

export {
  ASSET_ID_PATTERNS,
  BUILTIN_GENERATION_LIMITS,
  BUILTIN_PROMPT_FIELD_ORDER,
  BUILTIN_REFERENCE_MODE_IDS,
  CUSTOM_INPUT_IMAGES_MARKER,
  CUSTOM_PRIMARY_REQUEST_MARKER,
  CUSTOM_USE_CASE_INSTRUCTION,
  IMAGE_SHEET_ORDER,
  MAX_IMAGE_ATTEMPTS,
  STYLE_REFERENCE_ANALYSIS_MARKER,
  validateBuiltinPromptDefinition,
  validateImageRoutes,
} from "./pipeline-runtime/prompt-context.mjs";

export {
  AGENT_PLACEHOLDER_CONTRACT_VERSION,
  analyzeAgentPromptFields,
  normalizePromptText,
} from "./pipeline-runtime/agent-placeholders.mjs";

export {
  assertConditionMatchingQueueCurrent,
  builtinPromptBatchMatchesCatalog,
  builtinPromptPresetMatchesCatalog,
  builtinSheetIsEnabled,
  getBuiltinCatalogFingerprint,
  getBuiltinGenerationQuotaState,
  getConditionModuleRegistryFingerprint,
  makeBuiltinCatalogRouteFingerprint,
  makeBuiltinRouteFingerprintsBySheet,
  validateApiPromptBatch,
  validateBuiltinPromptBatch,
  validateBuiltinPromptPreset,
} from "./pipeline-runtime/builtin-batch.mjs";

export {
  makeAssetFingerprint,
  makeBuiltinPromptFingerprint,
  makeBuiltinPromptSpec,
} from "./pipeline-runtime/prompt-spec.mjs";
