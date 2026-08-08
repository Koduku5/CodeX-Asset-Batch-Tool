import { ASSET_BINDING_MARKERS } from "../prompt_catalog.mjs";
import {
  AGENT_PLACEHOLDER_CONTRACT_VERSION,
  analyzeAgentPromptFields,
  normalizePromptText,
} from "./agent-placeholders.mjs";
import {
  CUSTOM_INPUT_IMAGES_MARKER,
  CUSTOM_PRIMARY_REQUEST_MARKER,
  PROMPT_CATALOG,
  VALIDATED_LEGACY_PROMPT_DEFINITIONS,
  resolveCatalogPromptTemplate,
  validateBuiltinPromptDefinition,
} from "./prompt-context.mjs";
import {
  bindPromptValue,
  normalizeCustomFieldLabels,
  parsePromptFields,
  productionNoteSourceAmbiguities,
  productionNoteSourceRanges,
  promptFieldSchemaMatches,
  renderPromptFields,
} from "./prompt-fields.mjs";
import { cleanText, sha256 } from "./runtime-core.mjs";

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
  const promptText = fieldSchemaValid ? renderPromptFields(fields) : editedPromptText;
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
    defaultRoute.status === "placeholder" && overrideApplied && !liveStylePlaceholder;
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
