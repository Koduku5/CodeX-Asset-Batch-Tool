import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PROMPT_CATALOG_VERSION = 1;
const MODIFIER_OPERATIONS = Object.freeze(["replaceWith", "prepend", "set", "append"]);
const CONDITION_MODULE_CARDINALITY = "single-dominant-per-family";
const CONDITION_MODULE_KEYS = Object.freeze([
  "id",
  "displayName",
  "family",
  "revision",
  "scope",
  "classifier",
  "operations",
  "tests",
  "origin",
]);
const CONDITION_SCOPE_KEYS = Object.freeze(["styles", "assets", "referenceModes"]);
const CONDITION_CLASSIFIER_KEYS = Object.freeze([
  "definition",
  "selectionPolicy",
  "controlDimensions",
  "tieBreak",
  "noDefault",
]);
const CONDITION_TEST_KEYS = Object.freeze([
  "id",
  "assetId",
  "style",
  "asset",
  "productionNotes",
  "expectedConditionId",
]);
const CONDITION_ORIGIN_KEYS = Object.freeze([
  "kind",
  "presetId",
  "sourcePresetId",
  "sourceModuleId",
  "reviewRequired",
  "mergeStatus",
  "sources",
  "baseModuleId",
  "variantCount",
  "updateOf",
]);
const STABLE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const COMPILATION_PHASES = Object.freeze([
  "base-route",
  "route-replacement",
  "field-prepend",
  "field-set",
  "field-append",
  "active-field-schema",
]);
export const ASSET_BINDING_MARKERS = Object.freeze({
  productionNotes: "【Excel“制作说明”原文】",
});

const DEFAULT_CATALOG_URL = new URL(
  "../../assets/%E5%9B%BE%E7%89%87%E7%94%9F%E6%88%90/prompts/catalog.json",
  import.meta.url,
);

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

const hasExactKeys = (value, expectedKeys) =>
  isPlainObject(value) &&
  Object.keys(value).length === expectedKeys.length &&
  expectedKeys.every((key) => own(value, key));

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const cleanText = (value) => String(value ?? "").replace(/\r\n/g, "\n").trim();

const asCatalogPath = (value) => {
  if (!value) return fileURLToPath(DEFAULT_CATALOG_URL);
  if (value instanceof URL) return fileURLToPath(value);
  const text = String(value);
  return text.startsWith("file:") ? fileURLToPath(new URL(text)) : path.resolve(text);
};

const readJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));
const readJsonSync = (filePath) => JSON.parse(readFileSync(filePath, "utf8"));

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
};

export const canonicalJson = (value) => JSON.stringify(canonicalize(value));

export const semanticFingerprint = (value) =>
  createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

const normalizeStyle = (catalog, value) => {
  const text = cleanText(value);
  if (catalog.enums.styles.includes(text)) return text;
  const match = Object.entries(catalog.legacyNames.styles).find(([, legacy]) => legacy === text);
  if (match) return match[0];
  throw new Error(`未知制作风格：${text || "<empty>"}`);
};

const normalizeAsset = (catalog, value) => {
  const text = cleanText(value);
  if (catalog.enums.assets.includes(text)) return text;
  const match = Object.entries(catalog.legacyNames.assets).find(([, legacy]) => legacy === text);
  if (match) return match[0];
  throw new Error(`未知资产类别：${text || "<empty>"}`);
};

const normalizeReferenceMode = (catalog, value) => {
  const text = cleanText(value || "none").replaceAll("_", "-");
  if (catalog.enums.referenceModes.includes(text)) return text;
  throw new Error(`未知参考图模式：${text || "<empty>"}`);
};

const matchFixedCondition = (when, context) =>
  Object.entries(when).every(([key, expected]) => {
    const actual = context[key];
    return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  });

const ensureExactlyOne = (matches, label) => {
  if (matches.length === 0) throw new Error(`${label}缺少匹配项`);
  if (matches.length > 1) {
    throw new Error(`${label}发生冲突：${matches.map((item) => item.id).join(", ")}`);
  }
  return matches[0];
};

const collectConfiguredFiles = async (catalogPath, catalog) => {
  const rootDir = path.dirname(catalogPath);
  const configuredPaths = [
    catalog.paths.commonFragment,
    ...catalog.paths.styleFragments,
    ...catalog.paths.assetFragments,
    ...catalog.paths.referenceFragments,
    catalog.paths.builtinRoutes,
    catalog.paths.referenceModifiers,
    catalog.paths.conditionModules,
    catalog.paths.apiDefaults,
  ];
  const records = new Map();
  records.set("catalog.json", catalog);
  for (const relativePath of configuredPaths) {
    assert(typeof relativePath === "string" && relativePath, "catalog paths 中存在空路径");
    assert(!records.has(relativePath), `catalog paths 重复注册：${relativePath}`);
    records.set(relativePath, await readJson(path.resolve(rootDir, relativePath)));
  }
  return { rootDir, records };
};

const collectConfiguredFilesSync = (catalogPath, catalog) => {
  const rootDir = path.dirname(catalogPath);
  const configuredPaths = [
    catalog.paths.commonFragment,
    ...catalog.paths.styleFragments,
    ...catalog.paths.assetFragments,
    ...catalog.paths.referenceFragments,
    catalog.paths.builtinRoutes,
    catalog.paths.referenceModifiers,
    catalog.paths.conditionModules,
    catalog.paths.apiDefaults,
  ];
  const records = new Map();
  records.set("catalog.json", catalog);
  for (const relativePath of configuredPaths) {
    assert(typeof relativePath === "string" && relativePath, "catalog paths 中存在空路径");
    assert(!records.has(relativePath), `catalog paths 重复注册：${relativePath}`);
    records.set(relativePath, readJsonSync(path.resolve(rootDir, relativePath)));
  }
  return { rootDir, records };
};

const assembleLoadedCatalog = (catalogPath, catalog, rootDir, records) => {
  const fragments = new Map();
  const fragmentPaths = [
    catalog.paths.commonFragment,
    ...catalog.paths.styleFragments,
    ...catalog.paths.assetFragments,
    ...catalog.paths.referenceFragments,
  ];
  for (const relativePath of fragmentPaths) {
    const fragment = records.get(relativePath);
    assert(isPlainObject(fragment) && cleanText(fragment.id), `片段缺少 id：${relativePath}`);
    assert(!fragments.has(fragment.id), `片段 id 重复：${fragment.id}`);
    fragments.set(fragment.id, { ...fragment, sourcePath: relativePath });
  }
  const loaded = {
    catalogPath,
    rootDir,
    catalog,
    records,
    fragments,
    builtinRoutes: records.get(catalog.paths.builtinRoutes),
    referenceModifiers: records.get(catalog.paths.referenceModifiers),
    conditionModules: records.get(catalog.paths.conditionModules),
    apiDefaults: records.get(catalog.paths.apiDefaults),
  };
  validatePromptCatalog(loaded);
  return loaded;
};

export const loadPromptCatalog = async (catalogLocation = DEFAULT_CATALOG_URL) => {
  const catalogPath = asCatalogPath(catalogLocation);
  const catalog = await readJson(catalogPath);
  const { rootDir, records } = await collectConfiguredFiles(catalogPath, catalog);
  return assembleLoadedCatalog(catalogPath, catalog, rootDir, records);
};

export const loadPromptCatalogSync = (catalogLocation = DEFAULT_CATALOG_URL) => {
  const catalogPath = asCatalogPath(catalogLocation);
  const catalog = readJsonSync(catalogPath);
  const { rootDir, records } = collectConfiguredFilesSync(catalogPath, catalog);
  return assembleLoadedCatalog(catalogPath, catalog, rootDir, records);
};

const allowedCalls = Object.freeze({
  styleReferenceInputImages: (referenceCount) => {
    const count = Math.max(1, Number(referenceCount) || 0);
    return count === 1
      ? "Image 1 is a style-only reference."
      : `Images 1–${count} are style-only references.`;
  },
  styleReferenceRequestSuffix: (referenceCount) => {
    const count = Math.max(1, Number(referenceCount) || 0);
    const transfer =
      count === 1
        ? "分析图像 1 并仅迁移其风格：【由 Agent 分析参考图并填写共同风格】。"
        : `分析图像 1～${count} 并仅迁移这些参考图的共同风格：【由 Agent 分析参考图并填写共同风格】。`;
    return `${transfer}\n不得复制参考图中的主体、身份、服装、道具、姿态、构图、环境或叙事内容。`;
  },
  visualConsistencyInputImages: (referenceCount) => {
    const count = Math.max(2, Number(referenceCount) || 0);
    const targets = count === 2 ? "图像 2" : `图像 2～${count}`;
    return `图像 1：主风格基准；${targets}：需要统一的素材。`;
  },
  visualConsistencyPrimaryRequest: (referenceCount) => {
    const count = Math.max(2, Number(referenceCount) || 0);
    const targets = count === 2 ? "图像 2" : `图像 2～${count}`;
    return `将${targets}统一为图像 1 的视觉语言。\n需要迁移：配色、对比度、纹理、边缘、细节密度和渲染方式。\n必须保留：每张素材的主体、构图、文字和功能。`;
  },
  customInputImages: (referenceCount) => {
    const count = Math.max(1, Number(referenceCount) || 0);
    return [
      "【请填写每张输入图像的用途，并删除本提示】",
      ...Array.from({ length: count }, (_, index) => `图像 ${index + 1}：`),
    ].join("\n");
  },
});

export const renderPromptAst = (expression, slots = {}) => {
  if (typeof expression === "string") return expression;
  if (typeof expression === "number" || typeof expression === "boolean") {
    return String(expression);
  }
  assert(isPlainObject(expression), "提示词 AST 必须是字符串、数字、布尔值或对象节点");
  const keys = Object.keys(expression);
  if (keys.length === 1 && own(expression, "text")) {
    assert(typeof expression.text === "string", "text 节点必须包含字符串");
    return expression.text;
  }
  if (keys.length === 1 && own(expression, "slot")) {
    assert(typeof expression.slot === "string" && expression.slot, "slot 节点缺少名称");
    assert(own(slots, expression.slot), `缺少命名 slot：${expression.slot}`);
    const value = slots[expression.slot];
    assert(
      typeof value === "string" || typeof value === "number" || typeof value === "boolean",
      `slot 只允许标量值：${expression.slot}`,
    );
    return String(value);
  }
  if (keys.length === 1 && own(expression, "concat")) {
    assert(Array.isArray(expression.concat), "concat 节点必须包含数组");
    return expression.concat.map((part) => renderPromptAst(part, slots)).join("");
  }
  if (keys.every((key) => ["call", "args"].includes(key)) && own(expression, "call")) {
    assert(typeof expression.call === "string" && own(allowedCalls, expression.call), `不支持的命名调用：${expression.call}`);
    assert(Array.isArray(expression.args), `命名调用 ${expression.call} 的 args 必须是数组`);
    return allowedCalls[expression.call](
      ...expression.args.map((argument) => renderPromptAst(argument, slots)),
    );
  }
  throw new Error(`非法提示词 AST 节点：${JSON.stringify(expression)}`);
};

const validateAst = (expression, label) => {
  if (["string", "number", "boolean"].includes(typeof expression)) return;
  assert(isPlainObject(expression), `${label} 不是合法 AST`);
  const keys = Object.keys(expression);
  if (keys.length === 1 && own(expression, "text")) {
    assert(typeof expression.text === "string", `${label} 的 text 不是字符串`);
    return;
  }
  if (keys.length === 1 && own(expression, "slot")) {
    assert(typeof expression.slot === "string" && expression.slot, `${label} 的 slot 为空`);
    return;
  }
  if (keys.length === 1 && own(expression, "concat")) {
    assert(Array.isArray(expression.concat), `${label} 的 concat 不是数组`);
    expression.concat.forEach((part, index) => validateAst(part, `${label}.concat[${index}]`));
    return;
  }
  if (keys.every((key) => ["call", "args"].includes(key)) && own(expression, "call")) {
    assert(own(allowedCalls, expression.call), `${label} 使用未注册调用：${expression.call}`);
    assert(Array.isArray(expression.args), `${label} 的 args 不是数组`);
    expression.args.forEach((argument, index) => validateAst(argument, `${label}.args[${index}]`));
    return;
  }
  throw new Error(`${label} 包含非法 AST 节点`);
};

const fieldsFromPromptFields = (promptFields) =>
  Object.fromEntries(promptFields.map(({ label, value }) => [label, value]));

const promptFieldsFromFields = (fields, order) =>
  order.map((label) => ({ label, value: String(fields[label] ?? "") }));

export const bindAssetPromptFields = (fieldsOrPromptFields, bindings = {}) => {
  const productionNotes = String(bindings.productionNotes ?? "");
  const bindValue = (value) =>
    String(value ?? "").replaceAll(ASSET_BINDING_MARKERS.productionNotes, productionNotes);
  if (Array.isArray(fieldsOrPromptFields)) {
    return fieldsOrPromptFields.map((field) => ({
      label: String(field.label ?? ""),
      value: bindValue(field.value),
    }));
  }
  assert(isPlainObject(fieldsOrPromptFields), "asset binding 需要字段对象或 promptFields 数组");
  return Object.fromEntries(
    Object.entries(fieldsOrPromptFields).map(([field, value]) => [field, bindValue(value)]),
  );
};

const validateOperation = (operation, catalog, label) => {
  assert(isPlainObject(operation), `${label} 不是对象`);
  assert(MODIFIER_OPERATIONS.includes(operation.op), `${label} 使用未知操作：${operation.op}`);
  if (operation.op === "replaceWith") {
    assert(
      Object.keys(operation).every((key) => ["op", "routeId"].includes(key)),
      `${label} 的 replaceWith 只允许声明 routeId`,
    );
    assert(
      typeof operation.routeId === "string" && cleanText(operation.routeId),
      `${label} 的 replaceWith 目标必须是已注册基础路由 id`,
    );
    return;
  }
  assert(catalog.fieldSchemas.withInputImages.includes(operation.field), `${label} 指向未知字段：${operation.field}`);
  const hasValue = own(operation, "value");
  const hasPhrases = own(operation, "phrases");
  assert(hasValue !== hasPhrases, `${label} 必须且只能提供 value 或 phrases`);
  if (hasValue) {
    validateAst(operation.value, `${label}.value`);
    return;
  }
  assert(["append", "prepend"].includes(operation.op), `${label} 只有 append/prepend 支持 phrases`);
  assert(Array.isArray(operation.phrases) && operation.phrases.length > 0, `${label}.phrases 必须是非空数组`);
  const phraseIds = new Set();
  operation.phrases.forEach((phrase, index) => {
    assert(isPlainObject(phrase), `${label}.phrases[${index}] 不是对象`);
    assert(
      typeof phrase.phraseId === "string" && cleanText(phrase.phraseId),
      `${label}.phrases[${index}] 缺少 phraseId`,
    );
    assert(!phraseIds.has(phrase.phraseId), `${label} 的 phraseId 重复：${phrase.phraseId}`);
    phraseIds.add(phrase.phraseId);
    assert(own(phrase, "value"), `${label}.phrases[${index}] 缺少 value`);
    validateAst(phrase.value, `${label}.phrases[${index}].value`);
  });
};

const assertUniqueNonEmptyStrings = (values, label) => {
  assert(Array.isArray(values) && values.length > 0, `${label} 必须是非空数组`);
  const normalized = values.map((value, index) => {
    assert(typeof value === "string" && cleanText(value), `${label}[${index}] 必须是非空字符串`);
    return cleanText(value);
  });
  assert(new Set(normalized).size === normalized.length, `${label} 不允许重复值`);
  return normalized;
};

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

const resolveReferenceModifier = (loaded, referenceMode) => {
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

export const compileLegacyDefinition = (loaded) => {
  const { catalog } = loaded;
  const sheetOrder = catalog.enums.assets.map((asset) => catalog.legacyNames.assets[asset]);
  const styleOrder = catalog.enums.styles.map((style) => catalog.legacyNames.styles[style]);
  const styles = {};
  for (const style of catalog.enums.styles) {
    const styleName = catalog.legacyNames.styles[style];
    const bySheet = {};
    for (const asset of catalog.enums.assets) {
      const assetName = catalog.legacyNames.assets[asset];
      const base = resolveBaseRoute(loaded, style, asset);
      bySheet[assetName] = {
        status: base.status,
        referencePolicy: base.referencePolicy,
        message: base.message,
        promptFields: base.promptFields,
      };
    }
    styles[styleName] = { displayName: styleName, bySheet };
  }
  return {
    version: catalog.legacy.definitionVersion,
    sheetOrder,
    styleOrder,
    fieldOrder: [...catalog.fieldSchemas.withInputImages],
    styles,
  };
};

export const serializeLegacyDefinition = (definition) => {
  const quote = (value) => JSON.stringify(value);
  const lines = [
    "{",
    `  \"version\": ${definition.version},`,
    `  \"sheetOrder\": [${definition.sheetOrder.map(quote).join(", ")}],`,
    `  \"styleOrder\": [${definition.styleOrder.map(quote).join(", ")}],`,
    "  \"fieldOrder\": [",
    ...definition.fieldOrder.map(
      (field, index) => `    ${quote(field)}${index + 1 < definition.fieldOrder.length ? "," : ""}`,
    ),
    "  ],",
    "  \"styles\": {",
  ];
  definition.styleOrder.forEach((styleName, styleIndex) => {
    const style = definition.styles[styleName];
    lines.push(`    ${quote(styleName)}: {`);
    lines.push(`      \"displayName\": ${quote(style.displayName)},`);
    lines.push("      \"bySheet\": {");
    definition.sheetOrder.forEach((sheetName, sheetIndex) => {
      const route = style.bySheet[sheetName];
      lines.push(`        ${quote(sheetName)}: {`);
      lines.push(`          \"status\": ${quote(route.status)},`);
      lines.push(`          \"referencePolicy\": ${quote(route.referencePolicy)},`);
      lines.push(`          \"message\": ${quote(route.message)},`);
      lines.push("          \"promptFields\": [");
      route.promptFields.forEach((field, fieldIndex) => {
        lines.push(
          `            { \"label\": ${quote(field.label)}, \"value\": ${quote(field.value)} }${
            fieldIndex + 1 < route.promptFields.length ? "," : ""
          }`,
        );
      });
      lines.push("          ]");
      lines.push(`        }${sheetIndex + 1 < definition.sheetOrder.length ? "," : ""}`);
    });
    lines.push("      }");
    lines.push(`    }${styleIndex + 1 < definition.styleOrder.length ? "," : ""}`);
  });
  lines.push("  }");
  lines.push("}");
  return `${lines.join("\n")}\n`;
};

export const getApiDefaultTemplates = (loaded, { legacyNames = false } = {}) => {
  const templates = loaded.apiDefaults.templates;
  if (!legacyNames) return { ...templates };
  return Object.fromEntries(
    loaded.catalog.enums.assets.map((asset) => [loaded.catalog.legacyNames.assets[asset], templates[asset]]),
  );
};

export const getLegacyDefinitionPath = (loaded) =>
  path.resolve(loaded.rootDir, loaded.catalog.legacy.definitionPath);

export const getCatalogUrl = (loaded) => pathToFileURL(loaded.catalogPath);

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
