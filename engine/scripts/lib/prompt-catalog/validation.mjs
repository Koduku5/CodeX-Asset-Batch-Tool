import {
  COMPILATION_PHASES,
  CONDITION_CLASSIFIER_KEYS,
  CONDITION_MODULE_CARDINALITY,
  CONDITION_MODULE_KEYS,
  CONDITION_ORIGIN_KEYS,
  CONDITION_SCOPE_KEYS,
  CONDITION_TEST_KEYS,
  MODIFIER_OPERATIONS,
  PROMPT_CATALOG_VERSION,
  STABLE_ID_PATTERN,
  assert,
  assertUniqueNonEmptyStrings,
  canonicalJson,
  cleanText,
  hasExactKeys,
  isPlainObject,
  own,
  validateAst,
  validateOperation,
} from "./core.mjs";
import {
  applyModifierOperations,
  mergeRouteFragments,
  resolveBaseRoute,
  resolveReferenceModifier,
} from "./resolver.mjs";

const validateConditionModuleOperation = (operation, loaded, label, routeIds) => {
  validateOperation(operation, loaded.catalog, label);
  if (operation.op === "replaceWith") {
    assert(hasExactKeys(operation, ["op", "routeId"]), `${label} 只允许 op 和 routeId`);
    assert(routeIds.has(operation.routeId), `${label} 指向未注册基础路由：${operation.routeId}`);
    return;
  }
  const payloadKey = own(operation, "phrases") ? "phrases" : "value";
  assert(
    hasExactKeys(operation, ["op", "field", payloadKey]),
    `${label} 只允许 op、field 和 ${payloadKey}`,
  );
  assert(
    loaded.conditionModules.allowedTargetFields.includes(operation.field),
    `${label} 试图修改受保护、危险或未知字段：${operation.field}`,
  );
  if (payloadKey === "value") {
    assert(
      typeof operation.value === "string" && cleanText(operation.value),
      `${label}.value 必须是非空字符串`,
    );
  }
  if (Array.isArray(operation.phrases)) {
    operation.phrases.forEach((phrase, index) => {
      assert(
        hasExactKeys(phrase, ["phraseId", "value"]),
        `${label}.phrases[${index}] 只允许 phraseId 和 value`,
      );
      assert(
        typeof phrase.value === "string" && cleanText(phrase.value),
        `${label}.phrases[${index}].value 必须是非空字符串`,
      );
    });
  }
};

const validateConditionModuleRegistry = (loaded, routeIds) => {
  const registry = loaded.conditionModules;
  assert(
    hasExactKeys(registry, ["version", "cardinality", "allowedTargetFields", "modules"]),
    "condition modules registry 必须且只能包含 version、cardinality、allowedTargetFields、modules",
  );
  assert(registry.version === 1, "condition modules registry 版本无效");
  assert(registry.cardinality === CONDITION_MODULE_CARDINALITY, "condition modules cardinality 无效");
  const expectedTargetFields = [
    "Primary request",
    "Scene/backdrop",
    "Style/medium",
    "Composition/framing",
    "Lighting/mood",
    "Color/tonality",
    "Materials/textures",
    "Constraints",
    "Avoid",
  ];
  assert(
    Array.isArray(registry.allowedTargetFields) &&
      registry.allowedTargetFields.join("\0") === expectedTargetFields.join("\0"),
    "condition modules allowedTargetFields 必须使用固定白名单",
  );
  assert(Array.isArray(registry.modules), "condition modules 缺少 modules 数组");
  const moduleIds = new Set();
  for (const [moduleIndex, module] of registry.modules.entries()) {
    const label = `condition module ${moduleIndex + 1}`;
    assert(hasExactKeys(module, CONDITION_MODULE_KEYS), `${label} 字段不完整或包含未知字段`);
    assert(STABLE_ID_PATTERN.test(module.id), `${label}.id 不是稳定 ID`);
    assert(!moduleIds.has(module.id), `condition module id 重复：${module.id}`);
    moduleIds.add(module.id);
    assert(typeof module.displayName === "string" && cleanText(module.displayName), `${label}.displayName 为空`);
    assert(STABLE_ID_PATTERN.test(module.family), `${label}.family 不是稳定 ID`);
    assert(Number.isSafeInteger(module.revision) && module.revision >= 1, `${label}.revision 无效`);
    assert(hasExactKeys(module.scope, CONDITION_SCOPE_KEYS), `${label}.scope 字段无效`);
    const styles = assertUniqueNonEmptyStrings(module.scope.styles, `${label}.scope.styles`);
    const assets = assertUniqueNonEmptyStrings(module.scope.assets, `${label}.scope.assets`);
    const referenceModes = assertUniqueNonEmptyStrings(
      module.scope.referenceModes,
      `${label}.scope.referenceModes`,
    );
    styles.forEach((style) => assert(loaded.catalog.enums.styles.includes(style), `${label} 使用未知风格：${style}`));
    assets.forEach((asset) => assert(loaded.catalog.enums.assets.includes(asset), `${label} 使用未知资产类型：${asset}`));
    referenceModes.forEach((referenceMode) =>
      assert(loaded.catalog.enums.referenceModes.includes(referenceMode), `${label} 使用未知参考图方式：${referenceMode}`),
    );
    assert(hasExactKeys(module.classifier, CONDITION_CLASSIFIER_KEYS), `${label}.classifier 字段无效`);
    assert(typeof module.classifier.definition === "string" && cleanText(module.classifier.definition), `${label}.classifier.definition 为空`);
    assert(module.classifier.selectionPolicy === "single-dominant", `${label} 只支持 single-dominant`);
    assertUniqueNonEmptyStrings(module.classifier.controlDimensions, `${label}.classifier.controlDimensions`);
    assert(typeof module.classifier.tieBreak === "string", `${label}.classifier.tieBreak 必须是字符串`);
    assert(typeof module.classifier.noDefault === "boolean", `${label}.classifier.noDefault 必须是布尔值`);
    assert(Array.isArray(module.operations) && module.operations.length > 0, `${label}.operations 不能为空`);
    module.operations.forEach((operation, operationIndex) =>
      validateConditionModuleOperation(operation, loaded, `${label}.operations[${operationIndex}]`, routeIds),
    );
    assert(Array.isArray(module.tests), `${label}.tests 必须是数组`);
    const testIds = new Set();
    module.tests.forEach((test, testIndex) => {
      const testLabel = `${label}.tests[${testIndex}]`;
      assert(hasExactKeys(test, CONDITION_TEST_KEYS), `${testLabel} 字段无效`);
      assert(typeof test.id === "string" && cleanText(test.id), `${testLabel}.id 为空`);
      assert(!testIds.has(test.id), `${label} 测试 id 重复：${test.id}`);
      testIds.add(test.id);
      assert(typeof test.assetId === "string", `${testLabel}.assetId 必须是字符串`);
      assert(styles.includes(test.style), `${testLabel}.style 不在模块 scope 中`);
      assert(assets.includes(test.asset), `${testLabel}.asset 不在模块 scope 中`);
      assert(typeof test.productionNotes === "string" && cleanText(test.productionNotes), `${testLabel}.productionNotes 为空`);
      assert(test.expectedConditionId === module.id, `${testLabel}.expectedConditionId 必须等于模块 id`);
    });
    assert(isPlainObject(module.origin), `${label}.origin 必须是对象`);
    assert(
      Object.keys(module.origin).every((key) => CONDITION_ORIGIN_KEYS.includes(key)),
      `${label}.origin 包含未知字段`,
    );
    assert(typeof module.origin.kind === "string" && cleanText(module.origin.kind), `${label}.origin.kind 为空`);
    for (const key of ["presetId", "sourcePresetId", "sourceModuleId", "mergeStatus", "updateOf"]) {
      if (own(module.origin, key)) {
        assert(typeof module.origin[key] === "string" && cleanText(module.origin[key]), `${label}.origin.${key} 无效`);
      }
    }
    if (own(module.origin, "baseModuleId")) {
      assert(
        module.origin.baseModuleId === null ||
          (typeof module.origin.baseModuleId === "string" && cleanText(module.origin.baseModuleId)),
        `${label}.origin.baseModuleId 无效`,
      );
    }
    if (own(module.origin, "variantCount")) {
      assert(
        Number.isSafeInteger(module.origin.variantCount) && module.origin.variantCount >= 1,
        `${label}.origin.variantCount 无效`,
      );
    }
    if (own(module.origin, "sources")) {
      assert(Array.isArray(module.origin.sources), `${label}.origin.sources 必须是数组`);
      module.origin.sources.forEach((source, sourceIndex) => {
        assert(
          hasExactKeys(source, ["sourceId", "sourceName"]) &&
            typeof source.sourceId === "string" &&
            cleanText(source.sourceId) &&
            typeof source.sourceName === "string" &&
            cleanText(source.sourceName),
          `${label}.origin.sources[${sourceIndex}] 无效`,
        );
      });
    }
    if (own(module.origin, "reviewRequired")) {
      assert(typeof module.origin.reviewRequired === "boolean", `${label}.origin.reviewRequired 必须是布尔值`);
    }
    const referenceCounts = { none: 0, style: 1, "visual-consistency": 2, custom: 1 };
    for (const style of styles) {
      for (const asset of assets) {
        for (const referenceMode of referenceModes) {
          const baseRoute = resolveBaseRoute(loaded, style, asset);
          const { fragment } = resolveReferenceModifier(loaded, referenceMode);
          applyModifierOperations({
            loaded,
            baseRoute,
            modifiers: [fragment, module],
            slots: { referenceCount: referenceCounts[referenceMode] },
          });
        }
      }
    }
  }
  return true;
};

export const validatePromptCatalog = (loaded) => {
  const { catalog } = loaded;
  assert(catalog.version === PROMPT_CATALOG_VERSION, `不支持的 prompt catalog 版本：${catalog.version}`);
  assert(isPlainObject(catalog.enums), "catalog 缺少 enums");
  assert(isPlainObject(catalog.legacyNames), "catalog 缺少 legacyNames");
  assert(isPlainObject(catalog.fieldSchemas), "catalog 缺少 fieldSchemas");
  assert(isPlainObject(catalog.compilation), "catalog 缺少 compilation");
  assert(catalog.compilation.compilerVersion === 1, "compilation.compilerVersion 无效");
  assert(
    catalog.enums.modifierOperations?.join("\0") === MODIFIER_OPERATIONS.join("\0"),
    `modifierOperations 必须固定为：${MODIFIER_OPERATIONS.join(" → ")}`,
  );
  assert(
    catalog.compilation.phases?.join("\0") === COMPILATION_PHASES.join("\0"),
    `compilation.phases 必须固定为：${COMPILATION_PHASES.join(" → ")}`,
  );
  assert(catalog.compilation.separator === "\n", "compilation.separator 必须为单个换行符");
  assert(
    catalog.compilation.fingerprintAlgorithm === "canonical-json-sha256-v1",
    "compilation.fingerprintAlgorithm 无效",
  );
  const fullOrder = catalog.fieldSchemas.withInputImages;
  const compactOrder = catalog.fieldSchemas.withoutInputImages;
  assert(Array.isArray(fullOrder) && fullOrder.length === 12, "withInputImages 必须固定为 12 个字段");
  assert(Array.isArray(compactOrder) && compactOrder.length === 11, "withoutInputImages 必须固定为 11 个字段");
  assert(
    fullOrder.filter((field) => field !== "Input images").join("\0") === compactOrder.join("\0"),
    "11 字段 schema 必须只移除 Input images",
  );
  assert(loaded.builtinRoutes.version === 1, "builtin routes 版本无效");
  assert(Array.isArray(loaded.builtinRoutes.routes), "builtin routes 缺少 routes");
  assert(loaded.builtinRoutes.routes.length === 15, "基础路由必须恰好 15 条");
  const routeIds = new Set();
  for (const route of loaded.builtinRoutes.routes) {
    assert(cleanText(route.id), "基础路由缺少 id");
    assert(!routeIds.has(route.id), `基础路由 id 重复：${route.id}`);
    routeIds.add(route.id);
    assert(
      isPlainObject(route.when) && Object.keys(route.when).sort().join(",") === "asset,style",
      `基础路由 ${route.id} 只能按 style 与 asset 匹配`,
    );
    assert(catalog.enums.styles.includes(route.when.style), `基础路由 ${route.id} 风格枚举无效`);
    assert(catalog.enums.assets.includes(route.when.asset), `基础路由 ${route.id} 资产枚举无效`);
    assert(Array.isArray(route.compose) && route.compose.length === 3, `基础路由 ${route.id} 必须组合三个片段`);
    route.compose.forEach((fragmentId) => assert(loaded.fragments.has(fragmentId), `基础路由 ${route.id} 缺少片段 ${fragmentId}`));
    const merged = mergeRouteFragments(loaded, route);
    Object.entries(merged.fields).forEach(([field, expression]) => {
      assert(fullOrder.includes(field), `基础路由 ${route.id} 定义未知字段 ${field}`);
      validateAst(expression, `基础路由 ${route.id}.${field}`);
    });
  }
  for (const style of catalog.enums.styles) {
    for (const asset of catalog.enums.assets) {
      resolveBaseRoute(loaded, style, asset);
    }
  }
  validateConditionModuleRegistry(loaded, routeIds);
  assert(loaded.referenceModifiers.version === 1, "参考图条件修饰器版本无效");
  assert(loaded.referenceModifiers.family === "reference-mode", "参考图条件修饰器 family 无效");
  assert(loaded.referenceModifiers.cardinality === "exactly-one", "参考图条件修饰器必须 exactly-one");
  assert(Array.isArray(loaded.referenceModifiers.modifiers), "参考图条件修饰器缺少 modifiers");
  for (const referenceMode of catalog.enums.referenceModes) {
    const { fragment } = resolveReferenceModifier(loaded, referenceMode);
    assert(
      ["withInputImages", "withoutInputImages"].includes(fragment.activeFieldSchema),
      `参考图片段 ${fragment.id} 字段 schema 无效`,
    );
    assert(Array.isArray(fragment.operations), `参考图片段 ${fragment.id} 缺少 operations`);
    fragment.operations.forEach((operation, index) => {
      const label = `参考图片段 ${fragment.id} operation ${index + 1}`;
      validateOperation(operation, catalog, label);
      if (operation.op === "replaceWith") {
        assert(routeIds.has(operation.routeId), `${label} 指向未注册基础路由：${operation.routeId}`);
      }
    });
  }
  const referenceCounts = { none: 0, style: 1, "visual-consistency": 2, custom: 1 };
  for (const style of catalog.enums.styles) {
    for (const asset of catalog.enums.assets) {
      for (const referenceMode of catalog.enums.referenceModes) {
        const baseRoute = resolveBaseRoute(loaded, style, asset);
        const { fragment } = resolveReferenceModifier(loaded, referenceMode);
        applyModifierOperations({
          loaded,
          baseRoute,
          modifiers: [fragment],
          slots: { referenceCount: referenceCounts[referenceMode] },
        });
      }
    }
  }
  const configText = canonicalJson({
    catalog,
    routes: loaded.builtinRoutes,
    referenceModifiers: loaded.referenceModifiers,
    conditionModules: loaded.conditionModules,
  });
  const oldModifierCodePattern = new RegExp("\\bS[A-D]\\b");
  const oldConditionCodePattern = new RegExp("(?:^|[^A-Za-z])[A-D](?:[^A-Za-z]|$)");
  assert(!oldModifierCodePattern.test(configText), "新 prompt catalog 不允许旧的字母修饰器代号");
  assert(!oldConditionCodePattern.test(configText), "新 prompt catalog 不允许旧的单字母环境代号");
  assert(isPlainObject(loaded.apiDefaults.templates), "API 默认提示词缺少 templates");
  assert(loaded.apiDefaults.version === 1, "API 默认模板版本无效");
  for (const asset of catalog.enums.assets) {
    assert(cleanText(loaded.apiDefaults.templates[asset]), `API 默认提示词缺少 ${asset}`);
  }
  return true;
};

export { validateConditionModuleRegistry };
