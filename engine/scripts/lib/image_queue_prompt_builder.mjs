import {
  cleanText,
  hasExactKeys,
  normalizePromptText,
  parseJsonText,
  sha256,
} from "./pipeline_runtime.mjs";

export const readRequestedApiPromptTemplates = ({ enabled, encoded, sheetOrder }) => {
  if (!enabled) return null;
  const payload = cleanText(encoded);
  if (!payload) throw new Error("API 批量模式缺少窗口提示词模板传值");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    throw new Error("API 提示词模板传值不是有效 Base64");
  }
  const decoded = Buffer.from(payload, "base64").toString("utf8");
  const templates = parseJsonText(decoded, "API 提示词模板");
  if (
    !hasExactKeys(templates, sheetOrder) ||
    !sheetOrder.every((sheetName) => typeof templates[sheetName] === "string")
  ) {
    throw new Error("API 提示词模板必须且只能包含角色、生物、群演、场景、道具五个字符串");
  }
  return Object.fromEntries(
    sheetOrder.map((sheetName) => [sheetName, normalizePromptText(templates[sheetName])]),
  );
};

export const composeApiPrompt = (template, productionNotes) =>
  [template, productionNotes].map(normalizePromptText).filter(Boolean).join("\n\n");

export const makeApiRouteFingerprints = ({ sheetOrder, routes, promptTemplates }) =>
  new Map(
    sheetOrder.map((sheetName) => [
      sheetName,
      sha256(JSON.stringify({
        sheetName,
        route: routes[sheetName],
        promptTemplate: promptTemplates[sheetName],
      })),
    ]),
  );
