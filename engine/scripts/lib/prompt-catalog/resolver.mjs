import {
  PROMPT_CATALOG_VERSION,
  assert,
  bindAssetPromptFields,
  cleanText,
  ensureExactlyOne,
  fieldsFromPromptFields,
  isPlainObject,
  matchFixedCondition,
  normalizeAsset,
  normalizeReferenceMode,
  normalizeStyle,
  own,
  promptFieldsFromFields,
  renderPromptAst,
  semanticFingerprint,
  validateOperation,
} from "./core.mjs";

const mergeRouteFragments = (loaded, route) => {
  const fields = {};
  const slots = {};
  let status;
  let message;
  let referencePolicy;
  for (const fragmentId of route.compose) {
    const fragment = loaded.fragments.get(fragmentId);
    assert(fragment, `基础路由 ${route.id} 引用了不存在的片段：${fragmentId}`);
    for (const [slot, value] of Object.entries(fragment.slots ?? {})) {
      assert(!own(slots, slot) || slots[slot] === value, `基础路由 ${route.id} 的 slot 冲突：${slot}`);
      slots[slot] = value;
    }
    for (const [field, expression] of Object.entries(fragment.fields ?? {})) {
      assert(!own(fields, field), `基础路由 ${route.id} 重复定义字段：${field}`);
      fields[field] = expression;
    }
    if (fragment.routeState) {
      assert(status === undefined, `基础路由 ${route.id} 重复定义 routeState`);
      status = fragment.routeState.status;
      message = fragment.routeState.message;
    }
    if (fragment.referencePolicy !== undefined) {
      assert(referencePolicy === undefined, `基础路由 ${route.id} 重复定义 referencePolicy`);
      referencePolicy = fragment.referencePolicy;
    }
  }
  return { fields, slots, status, message, referencePolicy };
};

const routeById = (loaded, routeId) => {
  const matches = loaded.builtinRoutes.routes.filter((route) => route.id === routeId);
  return ensureExactlyOne(matches, `基础路由 id ${routeId}`);
};

export const resolveBaseRoute = (loaded, styleValue, assetValue) => {
  const style = normalizeStyle(loaded.catalog, styleValue);
  const asset = normalizeAsset(loaded.catalog, assetValue);
  const route = ensureExactlyOne(
    loaded.builtinRoutes.routes.filter((candidate) =>
      matchFixedCondition(candidate.when, { style, asset }),
    ),
    `基础路由 ${style}/${asset}`,
  );
  const composed = mergeRouteFragments(loaded, route);
  const renderedFields = Object.fromEntries(
    Object.entries(composed.fields).map(([field, expression]) => [
      field,
      renderPromptAst(expression, composed.slots),
    ]),
  );
  const order = loaded.catalog.fieldSchemas.withInputImages;
  const missing = order.filter((field) => !own(renderedFields, field));
  const extra = Object.keys(renderedFields).filter((field) => !order.includes(field));
  assert(missing.length === 0, `基础路由 ${route.id} 缺少字段：${missing.join(", ")}`);
  assert(extra.length === 0, `基础路由 ${route.id} 包含未知字段：${extra.join(", ")}`);
  assert(["configured", "placeholder"].includes(composed.status), `基础路由 ${route.id} 状态无效`);
  assert(["optional", "required"].includes(composed.referencePolicy), `基础路由 ${route.id} 参考图策略无效`);
  return {
    id: route.id,
    style,
    asset,
    status: composed.status,
    referencePolicy: composed.referencePolicy,
    message: String(composed.message ?? ""),
    slots: composed.slots,
    fields: renderedFields,
    promptFields: promptFieldsFromFields(renderedFields, order),
    route,
  };
};

const loadBaseRouteFieldsById = (loaded, routeId) => {
  const route = routeById(loaded, routeId);
  return resolveBaseRoute(loaded, route.when.style, route.when.asset);
};

const modifierId = (modifier, index) => cleanText(modifier.id) || `modifier-${index + 1}`;

export const applyModifierOperations = ({
  loaded,
  baseRoute,
  modifiers,
  slots = {},
  separator,
  suppressedPhraseIds = [],
}) => {
  assert(loaded?.catalog, "applyModifierOperations 缺少 loaded catalog");
  assert(baseRoute?.id && baseRoute?.fields, "applyModifierOperations 缺少基础路由");
  assert(Array.isArray(modifiers), "modifiers 必须是数组");
  assert(Array.isArray(suppressedPhraseIds), "suppressedPhraseIds 必须是数组");
  const requestedSuppression = new Set();
  for (const phraseId of suppressedPhraseIds) {
    assert(typeof phraseId === "string" && cleanText(phraseId), "suppressedPhraseIds 只能包含非空字符串");
    assert(!requestedSuppression.has(phraseId), `suppressedPhraseIds 重复：${phraseId}`);
    requestedSuppression.add(phraseId);
  }
  const joiner = separator ?? loaded.catalog.compilation.separator;
  let activeBase = baseRoute;
  let activeSlots = { ...(baseRoute.slots ?? {}), ...slots };
  let fields = { ...baseRoute.fields };
  const visitedRouteIds = new Set([baseRoute.id]);
  const replacementOperations = [];
  const fieldOperations = [];
  const activePhraseIds = new Set();
  modifiers.forEach((modifier, modifierIndex) => {
    assert(isPlainObject(modifier), `modifier ${modifierIndex + 1} 不是对象`);
    assert(Array.isArray(modifier.operations), `modifier ${modifierId(modifier, modifierIndex)} 缺少 operations`);
    modifier.operations.forEach((operation, operationIndex) => {
      validateOperation(
        operation,
        loaded.catalog,
        `modifier ${modifierId(modifier, modifierIndex)} operation ${operationIndex + 1}`,
      );
      let effectiveOperation = operation;
      if (Array.isArray(operation.phrases)) {
        for (const phrase of operation.phrases) {
          assert(!activePhraseIds.has(phrase.phraseId), `active phraseId 重复：${phrase.phraseId}`);
          activePhraseIds.add(phrase.phraseId);
        }
        const activePhrases = operation.phrases.filter(
          (phrase) => !requestedSuppression.has(phrase.phraseId),
        );
        if (activePhrases.length === 0) return;
        effectiveOperation = {
          ...Object.fromEntries(
            Object.entries(operation).filter(([key]) => key !== "phrases"),
          ),
          value: { concat: activePhrases.map((phrase) => phrase.value) },
        };
      }
      const record = {
        modifier,
        modifierIndex,
        operation: effectiveOperation,
        operationIndex,
      };
      if (operation.op === "replaceWith") replacementOperations.push(record);
      else fieldOperations.push(record);
    });
  });
  const unknownSuppression = [...requestedSuppression].filter(
    (phraseId) => !activePhraseIds.has(phraseId),
  );
  assert(
    unknownSuppression.length === 0,
    `suppressedPhraseIds 不属于当前语义修饰器：${unknownSuppression.join(", ")}`,
  );
  assert(replacementOperations.length <= 1, "replaceWith 每次解析最多只能重新加载一套提示词");
  for (const record of replacementOperations) {
    const { operation } = record;
    const targetRouteId = cleanText(operation.routeId);
    if (visitedRouteIds.has(targetRouteId)) {
      throw new Error(`replaceWith 检测到循环路由：${targetRouteId}`);
    }
    visitedRouteIds.add(targetRouteId);
    activeBase = loadBaseRouteFieldsById(loaded, targetRouteId);
    activeSlots = { ...(activeBase.slots ?? {}), ...slots };
    fields = { ...activeBase.fields };
  }
  const setOwners = new Map();
  for (const record of fieldOperations.filter(({ operation }) => operation.op === "set")) {
    const field = record.operation.field;
    if (setOwners.has(field)) {
      throw new Error(
        `set 操作冲突：${field} 同时由 ${setOwners.get(field)} 与 ${modifierId(record.modifier, record.modifierIndex)} 写入`,
      );
    }
    setOwners.set(field, modifierId(record.modifier, record.modifierIndex));
  }
  const phaseOrder = loaded.catalog.compilation.phases
    .filter((phase) => phase.startsWith("field-"))
    .map((phase) => phase.slice("field-".length));
  for (const phase of phaseOrder) {
    for (const { operation } of fieldOperations.filter((record) => record.operation.op === phase)) {
      assert(own(fields, operation.field), `${phase} 指向基础路由中不存在的字段：${operation.field}`);
      const value = renderPromptAst(operation.value, activeSlots);
      const current = String(fields[operation.field] ?? "");
      if (phase === "set") fields[operation.field] = value;
      if (phase === "prepend") fields[operation.field] = current && value ? `${value}${joiner}${current}` : value || current;
      if (phase === "append") fields[operation.field] = current && value ? `${current}${joiner}${value}` : current || value;
    }
  }
  return {
    baseRoute: activeBase,
    fields,
    replacedRouteId: replacementOperations.length ? activeBase.id : null,
    visitedRouteIds: [...visitedRouteIds],
  };
};

export const resolveReferenceModifier = (loaded, referenceMode) => {
  const modifier = ensureExactlyOne(
    loaded.referenceModifiers.modifiers.filter((candidate) =>
      matchFixedCondition(candidate.when, { referenceMode }),
    ),
    `参考图条件修饰器 ${referenceMode}`,
  );
  const fragment = loaded.fragments.get(modifier.fragment);
  assert(fragment, `参考图条件修饰器 ${modifier.id} 缺少片段：${modifier.fragment}`);
  return { modifier, fragment };
};

export const makeCatalogFingerprint = (loaded) =>
  semanticFingerprint({
    version: PROMPT_CATALOG_VERSION,
    files: Object.fromEntries(
      [...loaded.records.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([file, contents]) => [file, contents]),
    ),
  });

export const makeConditionModuleRegistryFingerprint = (loaded) =>
  semanticFingerprint({
    version: PROMPT_CATALOG_VERSION,
    registry: loaded.conditionModules,
  });

export const makeConditionModuleFingerprint = (loaded, module) =>
  semanticFingerprint({
    version: PROMPT_CATALOG_VERSION,
    compiler: loaded.catalog.compilation,
    registry: {
      version: loaded.conditionModules.version,
      cardinality: loaded.conditionModules.cardinality,
      allowedTargetFields: loaded.conditionModules.allowedTargetFields,
    },
    module,
  });

export const resolveSelectedConditionModules = (loaded, selectedIds = [], context = {}) => {
  assert(Array.isArray(selectedIds), "selectedConditionModuleIds 必须是数组");
  const style = normalizeStyle(loaded.catalog, context.style);
  const asset = normalizeAsset(loaded.catalog, context.asset);
  const referenceMode = normalizeReferenceMode(loaded.catalog, context.referenceMode);
  const normalizedIds = selectedIds.map((value, index) => {
    assert(typeof value === "string" && cleanText(value), `selectedConditionModuleIds[${index}] 必须是非空字符串`);
    return cleanText(value);
  });
  assert(new Set(normalizedIds).size === normalizedIds.length, "selectedConditionModuleIds 不允许重复 ID");
  const byId = new Map(loaded.conditionModules.modules.map((module) => [module.id, module]));
  const modules = normalizedIds.map((id) => {
    const module = byId.get(id);
    assert(module, `selectedConditionModuleIds 包含未注册 ID：${id}`);
    assert(module.scope.styles.includes(style), `condition module ${id} 不适用于风格 ${style}`);
    assert(module.scope.assets.includes(asset), `condition module ${id} 不适用于资产 ${asset}`);
    assert(
      module.scope.referenceModes.includes(referenceMode),
      `condition module ${id} 不适用于参考图方式 ${referenceMode}`,
    );
    return module;
  });
  const familyOwners = new Map();
  for (const module of modules) {
    if (familyOwners.has(module.family)) {
      throw new Error(
        `condition module family 冲突：${module.family} 同时选择 ${familyOwners.get(module.family)} 与 ${module.id}`,
      );
    }
    familyOwners.set(module.family, module.id);
  }
  modules.sort((left, right) =>
    left.family.localeCompare(right.family) || left.id.localeCompare(right.id),
  );
  return modules.map((module) => ({
    module,
    id: module.id,
    family: module.family,
    fingerprint: makeConditionModuleFingerprint(loaded, module),
  }));
};

export const makeBaseRouteFingerprint = (loaded, baseRoute) =>
  semanticFingerprint({
    version: PROMPT_CATALOG_VERSION,
    compiler: loaded.catalog.compilation,
    fieldOrder: loaded.catalog.fieldSchemas.withInputImages,
    legacyNames: {
      style: loaded.catalog.legacyNames.styles[baseRoute.style],
      asset: loaded.catalog.legacyNames.assets[baseRoute.asset],
    },
    route: baseRoute.route,
    fragments: baseRoute.route.compose.map((fragmentId) => {
      const fragment = loaded.fragments.get(fragmentId);
      return { id: fragmentId, fragment: Object.fromEntries(Object.entries(fragment).filter(([key]) => key !== "sourcePath")) };
    }),
  });

export const makeModifierFingerprint = (loaded, family, modifier, fragment) =>
  semanticFingerprint({
    version: PROMPT_CATALOG_VERSION,
    compiler: loaded.catalog.compilation,
    family: {
      id: family.family,
      cardinality: family.cardinality,
    },
    modifier,
    fragment: Object.fromEntries(Object.entries(fragment).filter(([key]) => key !== "sourcePath")),
  });

export const makeResolvedFingerprintInputs = ({
  baseRouteFingerprint,
  modifierFingerprints,
  referenceMode,
  referenceCount,
  assetBindings,
}) => ({
  version: PROMPT_CATALOG_VERSION,
  baseRouteFingerprint,
  modifierFingerprints,
  dynamicInputs: {
    referenceMode,
    referenceCount,
    assetBindings: assetBindings || null,
  },
});

export const resolvePromptTemplate = (loaded, options = {}) => {
  const requestedStyle = normalizeStyle(loaded.catalog, options.style);
  const requestedAsset = normalizeAsset(loaded.catalog, options.asset);
  const referenceMode = normalizeReferenceMode(loaded.catalog, options.referenceMode);
  const referenceCount = Math.max(0, Number(options.referenceCount) || 0);
  const initialBaseRoute = resolveBaseRoute(loaded, requestedStyle, requestedAsset);
  const referenceMatch = resolveReferenceModifier(loaded, referenceMode);
  const conditionMatches = resolveSelectedConditionModules(
    loaded,
    options.selectedConditionModuleIds ?? [],
    { style: requestedStyle, asset: requestedAsset, referenceMode },
  );
  const referenceApplied = applyModifierOperations({
    loaded,
    baseRoute: initialBaseRoute,
    modifiers: [referenceMatch.fragment, ...conditionMatches.map(({ module }) => module)],
    slots: { referenceCount },
  });
  const style = referenceApplied.baseRoute.style;
  const asset = referenceApplied.baseRoute.asset;
  const fields = referenceApplied.fields;
  const activeFieldSchema = referenceMatch.fragment.activeFieldSchema;
  const fieldOrder = loaded.catalog.fieldSchemas[activeFieldSchema];
  assert(Array.isArray(fieldOrder), `参考图片段指定了未知字段 schema：${activeFieldSchema}`);
  const baseRouteFingerprint = makeBaseRouteFingerprint(loaded, referenceApplied.baseRoute);
  const modifierFingerprints = [
    {
      id: referenceMatch.modifier.id,
      fingerprint: makeModifierFingerprint(
        loaded,
        loaded.referenceModifiers,
        referenceMatch.modifier,
        referenceMatch.fragment,
      ),
    },
    ...conditionMatches.map(({ id, fingerprint }) => ({ id, fingerprint })),
  ];
  const assetBindings = own(options, "productionNotes")
    ? { productionNotes: String(options.productionNotes ?? "") }
    : null;
  const resolvedFingerprintInputs = makeResolvedFingerprintInputs({
    baseRouteFingerprint,
    modifierFingerprints,
    referenceMode,
    referenceCount,
    assetBindings,
  });
  const unboundPromptFields = promptFieldsFromFields(fields, fieldOrder);
  const promptFields = assetBindings
    ? bindAssetPromptFields(unboundPromptFields, assetBindings)
    : unboundPromptFields;
  return {
    requestedStyle,
    requestedAsset,
    style,
    asset,
    referenceMode,
    referenceCount,
    routeId: referenceApplied.baseRoute.id,
    status: referenceApplied.baseRoute.status,
    referencePolicy: referenceApplied.baseRoute.referencePolicy,
    message: referenceApplied.baseRoute.message,
    activeFieldSchema,
    promptFields,
    fields: fieldsFromPromptFields(promptFields),
    activeModifiers: modifierFingerprints.map(({ id }) => id),
    ...(conditionMatches.length
      ? {
          selectedConditionModules: conditionMatches.map(({ id, family, fingerprint }) => ({
            id,
            family,
            fingerprint,
          })),
        }
      : {}),
    fingerprints: {
      catalogFingerprint: makeCatalogFingerprint(loaded),
      baseRouteFingerprint,
      modifierFingerprints,
      resolvedFingerprintInputs,
      resolvedFingerprint: semanticFingerprint(resolvedFingerprintInputs),
    },
  };
};

export { mergeRouteFragments };
