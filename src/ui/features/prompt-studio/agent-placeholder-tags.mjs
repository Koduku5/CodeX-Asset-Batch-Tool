export const CANONICAL_AGENT_PLACEHOLDER_EXAMPLE = "【由agent 具体判断说明：<用户填写的需求>】";

const normalizeRequirement = (value) => String(value ?? "").trim();

export const agentRequirementIsValid = (value) => {
  const requirement = normalizeRequirement(value);
  return Boolean(requirement) && !/[\r\n【】]/u.test(requirement);
};

export const makeCanonicalAgentPlaceholder = (requirement) => {
  const normalized = normalizeRequirement(requirement);
  if (!agentRequirementIsValid(normalized)) {
    throw new Error("AI 判断需求必须是非空单行文字，且不能包含全角方括号");
  }
  return `【由agent 具体判断说明：${normalized}】`;
};

export const extractAgentPlaceholders = (value) => {
  const text = String(value ?? "");
  const items = [];
  for (const match of text.matchAll(
    /【由agent 具体判断说明：([^\r\n【】]+)】|【由 Agent ([^\r\n【】]+)】/gu,
  )) {
    items.push({
      marker: match[0],
      start: match.index,
      end: match.index + match[0].length,
      requirement: normalizeRequirement(match[1] ?? match[2]),
    });
  }
  return items;
};

export const applyAgentRequirements = (originalValue, placeholders, requirements) => {
  if (!placeholders.length) return makeCanonicalAgentPlaceholder(requirements[0]);
  if (placeholders.length !== requirements.length) {
    throw new Error("AI 判断需求数量与当前字段占位符不一致");
  }
  let next = String(originalValue ?? "");
  for (let index = placeholders.length - 1; index >= 0; index -= 1) {
    const placeholder = placeholders[index];
    const replacement = makeCanonicalAgentPlaceholder(requirements[index]);
    next = `${next.slice(0, placeholder.start)}${replacement}${next.slice(placeholder.end)}`;
  }
  return next;
};

export const removeAgentPlaceholders = (originalValue, placeholders) => {
  let next = String(originalValue ?? "");
  for (let index = placeholders.length - 1; index >= 0; index -= 1) {
    const placeholder = placeholders[index];
    next = `${next.slice(0, placeholder.start)}${next.slice(placeholder.end)}`;
  }
  return next.trim();
};
