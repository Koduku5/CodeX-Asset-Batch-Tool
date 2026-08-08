import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { createCodexSdkOptions } from '../codex-sdk-options.mjs';

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SESSION_ID = /^chat-[a-f0-9-]{36}$/u;
export const MAX_MESSAGE_CHARACTERS = 4000;
export const MAX_REPLY_CHARACTERS = 8000;
export const MAX_MESSAGES = 80;
export const MAX_ACTIVITIES = 32;
export const MAX_SESSIONS = 64;
export const DEFAULT_CHAT_IDLE_TIMEOUT_MS = 3 * 60 * 1000;
export const DEFAULT_CHAT_TOTAL_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_NETWORK_RETRY_LIMIT = 3;

const PROPOSAL_ACTIONS = Object.freeze([
  'none',
  'run-full-pipeline',
  'build-scoped-workbook',
  'build-world-overview',
  'validate-and-build-workbook',
  'build-builtin-queue',
  'classify-prompt-branches',
  'pause-current-task',
  'refresh-project'
]);
const PROPOSAL_ACTION_SET = new Set(PROPOSAL_ACTIONS);
const WORKBOOK_ASSET_TYPES = Object.freeze([
  'characters', 'creatures', 'extras', 'scenes', 'props'
]);
const WORKBOOK_ASSET_TYPE_SET = new Set(WORKBOOK_ASSET_TYPES);
const WORKBOOK_ASSET_TYPE_LABELS = Object.freeze({
  characters: '角色',
  creatures: '生物',
  extras: '群演',
  scenes: '场景',
  props: '道具'
});

export const CHAT_RESULT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    reply: { type: 'string', minLength: 1, maxLength: MAX_REPLY_CHARACTERS },
    proposal: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: PROPOSAL_ACTIONS },
        label: { type: 'string', maxLength: 80 },
        reason: { type: 'string', maxLength: 240 },
        workbookEpisodeStart: { type: ['integer', 'null'], minimum: 1, maximum: 10000 },
        workbookEpisodeEnd: { type: ['integer', 'null'], minimum: 1, maximum: 10000 },
        workbookAssetTypes: {
          type: 'array',
          items: { type: 'string', enum: WORKBOOK_ASSET_TYPES },
          maxItems: WORKBOOK_ASSET_TYPES.length
        }
      },
      required: [
        'action', 'label', 'reason', 'workbookEpisodeStart', 'workbookEpisodeEnd',
        'workbookAssetTypes'
      ],
      additionalProperties: false
    }
  },
  required: ['reply', 'proposal'],
  additionalProperties: false
});

export const FIRST_TURN_RULES = `
你是 KA Asset Batch 软件中的项目协作 Agent。你只能读取当前项目并解释状态、定位问题、提出建议。

硬性边界：
1. 当前工作目录是唯一允许读取的项目目录；禁止读取项目外文件、认证信息、环境变量或本机路径。
2. 只读讨论，绝对不得修改文件、执行写入命令、删除或接管锁、启动/暂停任务、调用外部工具或联网。
3. 用户要求改变流程时，只能在 proposal 中提出一个白名单动作；未经过软件界面的“确认执行”，不得声称变更已经生效。
4. 不能展示隐藏思维链；可以给出简短、面向用户的推理摘要、证据和建议。
5. reply 使用简洁中文，不得包含本机绝对路径、令牌、凭据、原始 Prompt 或大段文件内容。
6. 先判断用户意图。只有用户明确询问项目状态、任务流程、项目文件、报错或卡顿时，才允许只读检查当前项目；问候、致谢、确认或通用闲聊必须直接回复，不得读取文件或执行命令。
7. 用户提出“前 N 集/第 A 到 B 集的角色、场景等并出表”时使用 build-scoped-workbook。把闭区间写入 workbookEpisodeStart/workbookEpisodeEnd，把点名的角色、生物、群演、场景、道具写入 workbookAssetTypes；三者都必须明确有效。
8. build-scoped-workbook 仍会完成全剧逐集分析、完整世界观总览和正式校验；集数与资产类型只筛选同一个正式 Excel 中的资产行。确认卡片必须明确说明后台会分析全剧。
9. 软件只允许“无表 → 局部表 → 全剧表”。全剧表已经形成后再要求缩小到几集或几类时，不得提议执行，应直接说明不支持回退。除 build-scoped-workbook 外，workbookEpisodeStart/workbookEpisodeEnd 必须为 null，workbookAssetTypes 必须为空数组。

可提议动作：
- run-full-pipeline：开始或恢复完整流水线
- build-scoped-workbook：完成全剧分析与世界观总览，再按集数和类型筛选同一个资产表
- build-world-overview：只生成世界观总览
- validate-and-build-workbook：校验并生成 Excel
- build-builtin-queue：构建内置出图队列
- classify-prompt-branches：执行提示词分支判断
- pause-current-task：暂停当前任务
- refresh-project：刷新项目状态
- none：仅回答，不提议操作

最终严格返回 output schema 指定的 JSON。没有操作建议时 proposal.action 必须为 none，label 和 reason 使用空字符串，workbookEpisodeStart/workbookEpisodeEnd 使用 null，workbookAssetTypes 使用空数组。
`.trim();

export class CodexAgentChatError extends Error {
  constructor(code, message, { status = 400, cause = null } = {}) {
    super(message);
    this.name = 'CodexAgentChatError';
    this.code = code;
    this.status = status;
    this.cause = cause;
  }
}

export const chatError = (code, message, status = 400, cause = null) => (
  new CodexAgentChatError(code, message, { status, cause })
);

export const safeText = (value, maximum = MAX_REPLY_CHARACTERS, projectRoot = '') => {
  let text = String(value ?? '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ');
  if (projectRoot) {
    const escaped = projectRoot.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    text = text.replace(new RegExp(escaped, 'giu'), '[project]');
  }
  return text
    .replace(/\b(authorization\s*:\s*bearer)\s+[^\s]+/giu, '$1 [redacted]')
    .replace(/\b((?:openai[-_ ]?|codex[-_ ]?)?api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|credential|secret)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[redacted]')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>|]*/gu, '[path]')
    .trim()
    .slice(0, maximum);
};

export const validateProjectId = (value) => {
  if (typeof value !== 'string' || !PROJECT_ID.test(value)) {
    throw chatError('INVALID_PROJECT_ID', '项目编号无效');
  }
  return value;
};

export const validateSessionId = (value) => {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) {
    throw chatError('INVALID_CHAT_SESSION', 'Agent 对话编号无效');
  }
  return value;
};

export const validateMessage = (value) => {
  if (typeof value !== 'string') throw chatError('INVALID_CHAT_MESSAGE', '请输入对话内容');
  const normalized = value.replace(/\r\n?/gu, '\n').trim();
  if (!normalized
    || normalized.length > MAX_MESSAGE_CHARACTERS
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw chatError(
      'INVALID_CHAT_MESSAGE',
      `对话内容必须为 1 到 ${MAX_MESSAGE_CHARACTERS} 个字符`
    );
  }
  return normalized;
};

export const boundedTimeout = (value, fallback, label) => {
  const timeout = value ?? fallback;
  if (!Number.isInteger(timeout) || timeout < 10 || timeout > 24 * 60 * 60 * 1000) {
    throw new TypeError(`${label} must be an integer from 10 through 86400000`);
  }
  return timeout;
};

export const boundedRetryLimit = (value) => {
  const limit = value ?? DEFAULT_NETWORK_RETRY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new TypeError('networkRetryLimit must be an integer from 1 through 10');
  }
  return limit;
};

export const canonicalProject = async (candidate) => {
  if (typeof candidate !== 'string' || !isAbsolute(candidate)) {
    throw chatError('PROJECT_ROOT_UNAVAILABLE', 'Agent 项目目录不可用', 503);
  }
  try {
    const info = await lstat(candidate);
    const canonical = await realpath(candidate);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe project root');
    return canonical;
  } catch (error) {
    throw chatError('PROJECT_ROOT_UNAVAILABLE', 'Agent 项目目录不可用', 503, error);
  }
};

export const loadDefaultCodex = async () => {
  try {
    const module = await import('@openai/codex-sdk');
    if (typeof module.Codex !== 'function') throw new Error('Codex SDK export missing');
    return new module.Codex(createCodexSdkOptions());
  } catch (error) {
    throw chatError('CODEX_SDK_UNAVAILABLE', 'Codex SDK 无法启动', 503, error);
  }
};

export const classifyError = (error) => {
  if (error instanceof CodexAgentChatError) return error;
  const message = String(error?.message || 'Codex Agent 对话失败');
  if (/auth|log[ -]?in|sign[ -]?in|unauthori[sz]ed|forbidden|\b401\b|\b403\b/iu.test(message)) {
    return chatError('CODEX_AUTH_UNAVAILABLE', 'Codex 尚未登录或授权已经失效', 401, error);
  }
  if (/abort|cancel/iu.test(message)) {
    return chatError('CHAT_CANCELLED', 'Agent 对话已停止', 409, error);
  }
  return chatError('CODEX_CHAT_FAILED', 'Codex Agent 对话执行失败', 503, error);
};

const exactObject = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw chatError('INVALID_CHAT_RESULT', `${label}格式无效`, 502);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw chatError('INVALID_CHAT_RESULT', `${label}字段无效`, 502);
  }
};

export const parseResult = (value, projectRoot) => {
  const candidate = String(value ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/giu, '');
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw chatError('INVALID_CHAT_RESULT', 'Agent 没有返回有效对话结果', 502, error);
  }
  exactObject(parsed, ['reply', 'proposal'], 'Agent 对话结果');
  exactObject(parsed.proposal, [
    'action', 'label', 'reason', 'workbookEpisodeStart', 'workbookEpisodeEnd',
    'workbookAssetTypes'
  ], 'Agent 操作建议');
  const action = parsed.proposal.action;
  if (!PROPOSAL_ACTION_SET.has(action)) {
    throw chatError('INVALID_CHAT_RESULT', 'Agent 提出了不允许的操作', 502);
  }
  const workbookEpisodeStart = parsed.proposal.workbookEpisodeStart;
  const workbookEpisodeEnd = parsed.proposal.workbookEpisodeEnd;
  const workbookAssetTypes = parsed.proposal.workbookAssetTypes;
  if (!Array.isArray(workbookAssetTypes)
    || workbookAssetTypes.some((item) => !WORKBOOK_ASSET_TYPE_SET.has(item))
    || new Set(workbookAssetTypes).size !== workbookAssetTypes.length) {
    throw chatError('INVALID_CHAT_RESULT', 'Agent 提出的制表范围无效', 502);
  }
  if (action === 'build-scoped-workbook') {
    if (!Number.isInteger(workbookEpisodeStart)
      || !Number.isInteger(workbookEpisodeEnd)
      || workbookEpisodeStart < 1
      || workbookEpisodeEnd > 10000
      || workbookEpisodeStart > workbookEpisodeEnd
      || !workbookAssetTypes.length) {
      throw chatError('INVALID_CHAT_RESULT', 'Agent 提出的局部表范围无效', 502);
    }
  } else if (workbookEpisodeStart !== null
    || workbookEpisodeEnd !== null
    || workbookAssetTypes.length) {
    throw chatError('INVALID_CHAT_RESULT', '只有局部资产表可以指定集数和资产类型', 502);
  }
  const reply = safeText(parsed.reply, MAX_REPLY_CHARACTERS, projectRoot);
  if (!reply) throw chatError('INVALID_CHAT_RESULT', 'Agent 对话回复为空', 502);
  const label = safeText(parsed.proposal.label, 80, projectRoot);
  const reason = safeText(parsed.proposal.reason, 240, projectRoot);
  if (action === 'none') return { reply, proposal: null };
  if (action === 'build-scoped-workbook') {
    const episodeScope = workbookEpisodeStart === workbookEpisodeEnd
      ? `第 ${workbookEpisodeStart} 集`
      : `第 ${workbookEpisodeStart}～${workbookEpisodeEnd} 集`;
    const typeScope = workbookAssetTypes
      .map((item) => WORKBOOK_ASSET_TYPE_LABELS[item])
      .join('、');
    return {
      reply: safeText(
        `${reply}\n\n执行范围：后台将完成全剧逐集分析、完整世界观总览和正式校验；${episodeScope}与${typeScope}只用于筛选同一个资产表。后续完整流程会把该表补全，不能从全剧表回退为局部表。`,
        MAX_REPLY_CHARACTERS,
        projectRoot
      ),
      proposal: {
        action,
        label: `生成${episodeScope}${typeScope}局部表`,
        reason: '后台会先完成全剧逐集分析、完整世界观总览和正式校验，集数与类型仅筛选资产行。',
        workbookEpisodeStart,
        workbookEpisodeEnd,
        workbookAssetTypes
      }
    };
  }
  if (!label || !reason) {
    throw chatError('INVALID_CHAT_RESULT', 'Agent 操作建议不完整', 502);
  }
  return {
    reply,
    proposal: {
      action,
      label,
      reason,
      workbookEpisodeStart: null,
      workbookEpisodeEnd: null,
      workbookAssetTypes: []
    }
  };
};

export const publicSession = (session) => Object.freeze({
  sessionId: session.sessionId,
  projectId: session.projectId,
  status: session.status,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  runtimeConfig: session.runtimeConfig,
  messages: Object.freeze(session.messages.map((message) => Object.freeze({
    messageId: message.messageId,
    role: message.role,
    text: message.text,
    createdAt: message.createdAt,
    proposal: message.proposal ? Object.freeze({ ...message.proposal }) : null
  }))),
  activities: Object.freeze(session.activities.map((activity) => Object.freeze({ ...activity }))),
  error: session.error
});
