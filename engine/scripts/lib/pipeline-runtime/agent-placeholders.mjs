export const normalizePromptText = (value) =>
  String(value ?? "").replace(/\r\n?/g, "\n").trim();

export const AGENT_PLACEHOLDER_CONTRACT_VERSION = 1;
const AGENT_PLACEHOLDER_PREFIXES = ["【由agent 具体判断说明：", "【由 Agent "];
const AGENT_PLACEHOLDER_PATTERN =
  /【由agent 具体判断说明：([^\r\n【】]+)】|【由 Agent ([^\r\n【】]+)】/gu;

export const textRanges = (text, needle) => {
  const ranges = [];
  if (!needle) return ranges;
  let offset = 0;
  while (offset <= text.length - needle.length) {
    const start = text.indexOf(needle, offset);
    if (start < 0) break;
    ranges.push({ start, end: start + needle.length });
    offset = start + Math.max(needle.length, 1);
  }
  return ranges;
};

const rangeContains = (ranges, start, end = start + 1) =>
  ranges.some((range) => start >= range.start && end <= range.end);

export const analyzeAgentPromptFields = (
  fields,
  { ignoredValues = [], ignoredSourceRanges = [] } = {},
) => {
  const items = [];
  const errors = [];
  if (!Array.isArray(fields)) {
    return {
      version: AGENT_PLACEHOLDER_CONTRACT_VERSION,
      valid: false,
      items,
      errors: ["提示词字段不是数组"],
    };
  }
  for (const [fieldIndex, field] of fields.entries()) {
    const label = normalizePromptText(field?.label);
    const value = normalizePromptText(field?.value);
    const ignoredRanges = [
      ...(Array.isArray(ignoredValues) ? ignoredValues : []).flatMap((ignoredValue) =>
        textRanges(value, normalizePromptText(ignoredValue)),
      ),
      ...(Array.isArray(ignoredSourceRanges) ? ignoredSourceRanges : []).filter(
        (range) =>
          range?.fieldIndex === fieldIndex &&
          Number.isInteger(range.start) &&
          Number.isInteger(range.end) &&
          range.start >= 0 &&
          range.end > range.start &&
          range.end <= value.length,
      ),
    ];
    const validRanges = [];
    let occurrence = 0;
    for (const match of value.matchAll(AGENT_PLACEHOLDER_PATTERN)) {
      const marker = match[0];
      const start = match.index;
      const end = start + marker.length;
      if (rangeContains(ignoredRanges, start, end)) continue;
      validRanges.push({ start, end });
      const instruction = normalizePromptText(match[1] ?? match[2]);
      if (!instruction) {
        errors.push(`${label || "未知字段"} 的 Agent 占位符缺少判断说明`);
        continue;
      }
      occurrence += 1;
      items.push({
        field: label,
        occurrence,
        mode: value === marker ? "field" : "inline",
        marker,
        instruction,
      });
    }
    for (const prefix of AGENT_PLACEHOLDER_PREFIXES) {
      let prefixOffset = 0;
      while (prefixOffset < value.length) {
        const start = value.indexOf(prefix, prefixOffset);
        if (start < 0) break;
        const covered = rangeContains(ignoredRanges, start) || rangeContains(validRanges, start);
        if (!covered) {
          errors.push(`${label || "未知字段"} 含未闭合或不符合格式的 Agent 占位符`);
        }
        prefixOffset = start + prefix.length;
      }
    }
  }
  return {
    version: AGENT_PLACEHOLDER_CONTRACT_VERSION,
    valid: errors.length === 0,
    items,
    errors,
  };
};
