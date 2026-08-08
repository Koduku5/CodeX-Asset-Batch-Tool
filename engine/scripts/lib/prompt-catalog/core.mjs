import { createHash } from "node:crypto";

export const PROMPT_CATALOG_VERSION = 1;
export const MODIFIER_OPERATIONS = Object.freeze(["replaceWith", "prepend", "set", "append"]);
export const CONDITION_MODULE_CARDINALITY = "single-dominant-per-family";
export const CONDITION_MODULE_KEYS = Object.freeze([
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
export const CONDITION_SCOPE_KEYS = Object.freeze(["styles", "assets", "referenceModes"]);
export const CONDITION_CLASSIFIER_KEYS = Object.freeze([
  "definition",
  "selectionPolicy",
  "controlDimensions",
  "tieBreak",
  "noDefault",
]);
export const CONDITION_TEST_KEYS = Object.freeze([
  "id",
  "assetId",
  "style",
  "asset",
  "productionNotes",
  "expectedConditionId",
]);
export const CONDITION_ORIGIN_KEYS = Object.freeze([
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
export const STABLE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
export const COMPILATION_PHASES = Object.freeze([
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

export const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export const hasExactKeys = (value, expectedKeys) =>
  isPlainObject(value) &&
  Object.keys(value).length === expectedKeys.length &&
  expectedKeys.every((key) => own(value, key));

export const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

export const cleanText = (value) => String(value ?? "").replace(/\r\n/g, "\n").trim();

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

export const normalizeStyle = (catalog, value) => {
  const text = cleanText(value);
  if (catalog.enums.styles.includes(text)) return text;
  const match = Object.entries(catalog.legacyNames.styles).find(([, legacy]) => legacy === text);
  if (match) return match[0];
  throw new Error(`未知制作风格：${text || "<empty>"}`);
};

export const normalizeAsset = (catalog, value) => {
  const text = cleanText(value);
  if (catalog.enums.assets.includes(text)) return text;
  const match = Object.entries(catalog.legacyNames.assets).find(([, legacy]) => legacy === text);
  if (match) return match[0];
  throw new Error(`未知资产类别：${text || "<empty>"}`);
};

export const normalizeReferenceMode = (catalog, value) => {
  const text = cleanText(value || "none").replaceAll("_", "-");
  if (catalog.enums.referenceModes.includes(text)) return text;
  throw new Error(`未知参考图模式：${text || "<empty>"}`);
};

export const matchFixedCondition = (when, context) =>
  Object.entries(when).every(([key, expected]) => {
    const actual = context[key];
    return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  });

export const ensureExactlyOne = (matches, label) => {
  if (matches.length === 0) throw new Error(`${label}缺少匹配项`);
  if (matches.length > 1) {
    throw new Error(`${label}发生冲突：${matches.map((item) => item.id).join(", ")}`);
  }
  return matches[0];
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

export const validateAst = (expression, label) => {
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

export const fieldsFromPromptFields = (promptFields) =>
  Object.fromEntries(promptFields.map(({ label, value }) => [label, value]));

export const promptFieldsFromFields = (fields, order) =>
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

export const validateOperation = (operation, catalog, label) => {
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

export const assertUniqueNonEmptyStrings = (values, label) => {
  assert(Array.isArray(values) && values.length > 0, `${label} 必须是非空数组`);
  const normalized = values.map((value, index) => {
    assert(typeof value === "string" && cleanText(value), `${label}[${index}] 必须是非空字符串`);
    return cleanText(value);
  });
  assert(new Set(normalized).size === normalized.length, `${label} 不允许重复值`);
  return normalized;
};
