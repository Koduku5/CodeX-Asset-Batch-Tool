import { ASSET_BINDING_MARKERS, bindAssetPromptFields } from "../prompt_catalog.mjs";
import { analyzeAgentPromptFields, normalizePromptText, textRanges } from "./agent-placeholders.mjs";
import { BUILTIN_PROMPT_FIELD_ORDER } from "./prompt-context.mjs";
import { cleanText } from "./runtime-core.mjs";

export const normalizeCustomFieldLabels = (value) => {
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

export const parsePromptFields = (promptText, customFieldLabels = []) => {
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

export const promptFieldSchemaMatches = (route, fields, customFieldLabels = []) => {
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

export const renderPromptFields = (fields) =>
  fields
    .map((field) => {
      const label = normalizePromptText(field.label);
      const value = normalizePromptText(field.value);
      return `${label}:${value ? ` ${value}` : ""}`;
    })
    .join("\n");

export const bindPromptValue = (value, productionNotes) =>
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

export const productionNoteSourceRanges = (fields, unboundPromptFields, productionNotes) => {
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

export const productionNoteSourceAmbiguities = (
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
