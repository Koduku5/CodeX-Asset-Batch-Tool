import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import {
  codexThreadRuntimeOptions,
  readCodexRuntimeConfig
} from './codex-runtime-config.mjs';
import { createCodexSdkOptions } from './codex-sdk-options.mjs';

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SESSION_ID = /^chat-[a-f0-9-]{36}$/u;
const MAX_MESSAGE_CHARACTERS = 4000;
const MAX_REPLY_CHARACTERS = 8000;
const MAX_MESSAGES = 80;
const MAX_ACTIVITIES = 32;
const MAX_SESSIONS = 64;
const DEFAULT_CHAT_IDLE_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_CHAT_TOTAL_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_NETWORK_RETRY_LIMIT = 3;
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
const WORKBOOK_ASSET_TYPES = Object.freeze(['characters', 'creatures', 'extras', 'scenes', 'props']);
const WORKBOOK_ASSET_TYPE_SET = new Set(WORKBOOK_ASSET_TYPES);
const WORKBOOK_ASSET_TYPE_LABELS = Object.freeze({
  characters: '角色', creatures: '生物', extras: '群演', scenes: '场景', props: '道具'
});

const CHAT_RESULT_SCHEMA = Object.freeze({
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
        'action', 'label', 'reason', 'workbookEpisodeStart', 'workbookEpisodeEnd', 'workbookAssetTypes'
      ],
      additionalProperties: false
    }
  },
  required: ['reply', 'proposal'],
  additionalProperties: false
});

const FIRST_TURN_RULES = `
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

const chatError = (code, message, status = 400, cause = null) => new CodexAgentChatError(
  code,
  message,
  { status, cause }
);

const safeText = (value, maximum = MAX_REPLY_CHARACTERS, projectRoot = '') => {
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

const validateProjectId = (value) => {
  if (typeof value !== 'string' || !PROJECT_ID.test(value)) {
    throw chatError('INVALID_PROJECT_ID', '项目编号无效');
  }
  return value;
};

const validateSessionId = (value) => {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) {
    throw chatError('INVALID_CHAT_SESSION', 'Agent 对话编号无效');
  }
  return value;
};

const validateMessage = (value) => {
  if (typeof value !== 'string') throw chatError('INVALID_CHAT_MESSAGE', '请输入对话内容');
  const normalized = value.replace(/\r\n?/gu, '\n').trim();
  if (!normalized || normalized.length > MAX_MESSAGE_CHARACTERS
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw chatError('INVALID_CHAT_MESSAGE', `对话内容必须为 1 到 ${MAX_MESSAGE_CHARACTERS} 个字符`);
  }
  return normalized;
};

const boundedTimeout = (value, fallback, label) => {
  const timeout = value ?? fallback;
  if (!Number.isInteger(timeout) || timeout < 10 || timeout > 24 * 60 * 60 * 1000) {
    throw new TypeError(`${label} must be an integer from 10 through 86400000`);
  }
  return timeout;
};

const boundedRetryLimit = (value) => {
  const limit = value ?? DEFAULT_NETWORK_RETRY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new TypeError('networkRetryLimit must be an integer from 1 through 10');
  }
  return limit;
};

const canonicalProject = async (candidate) => {
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

const loadDefaultCodex = async () => {
  try {
    const module = await import('@openai/codex-sdk');
    if (typeof module.Codex !== 'function') throw new Error('Codex SDK export missing');
    return new module.Codex(createCodexSdkOptions());
  } catch (error) {
    throw chatError('CODEX_SDK_UNAVAILABLE', 'Codex SDK 无法启动', 503, error);
  }
};

const classifyError = (error) => {
  if (error instanceof CodexAgentChatError) return error;
  const message = String(error?.message || 'Codex Agent 对话失败');
  if (/auth|log[ -]?in|sign[ -]?in|unauthori[sz]ed|forbidden|\b401\b|\b403\b/iu.test(message)) {
    return chatError('CODEX_AUTH_UNAVAILABLE', 'Codex 尚未登录或授权已经失效', 401, error);
  }
  if (/abort|cancel/iu.test(message)) return chatError('CHAT_CANCELLED', 'Agent 对话已停止', 409, error);
  return chatError('CODEX_CHAT_FAILED', 'Codex Agent 对话执行失败', 503, error);
};

const exactObject = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw chatError('INVALID_CHAT_RESULT', `${label}格式无效`, 502);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw chatError('INVALID_CHAT_RESULT', `${label}字段无效`, 502);
  }
};

const parseResult = (value, projectRoot) => {
  const candidate = String(value ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/giu, '');
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw chatError('INVALID_CHAT_RESULT', 'Agent 没有返回有效对话结果', 502, error);
  }
  exactObject(parsed, ['reply', 'proposal'], 'Agent 对话结果');
  exactObject(parsed.proposal, [
    'action', 'label', 'reason', 'workbookEpisodeStart', 'workbookEpisodeEnd', 'workbookAssetTypes'
  ], 'Agent 操作建议');
  const action = parsed.proposal.action;
  if (!PROPOSAL_ACTION_SET.has(action)) throw chatError('INVALID_CHAT_RESULT', 'Agent 提出了不允许的操作', 502);
  const workbookEpisodeStart = parsed.proposal.workbookEpisodeStart;
  const workbookEpisodeEnd = parsed.proposal.workbookEpisodeEnd;
  const workbookAssetTypes = parsed.proposal.workbookAssetTypes;
  if (!Array.isArray(workbookAssetTypes)
    || workbookAssetTypes.some((value) => !WORKBOOK_ASSET_TYPE_SET.has(value))
    || new Set(workbookAssetTypes).size !== workbookAssetTypes.length) {
    throw chatError('INVALID_CHAT_RESULT', 'Agent 提出的制表范围无效', 502);
  }
  if (action === 'build-scoped-workbook') {
    if (!Number.isInteger(workbookEpisodeStart) || !Number.isInteger(workbookEpisodeEnd)
      || workbookEpisodeStart < 1 || workbookEpisodeEnd > 10000
      || workbookEpisodeStart > workbookEpisodeEnd || !workbookAssetTypes.length) {
      throw chatError('INVALID_CHAT_RESULT', 'Agent 提出的局部表范围无效', 502);
    }
  } else if (workbookEpisodeStart !== null || workbookEpisodeEnd !== null || workbookAssetTypes.length) {
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
    const typeScope = workbookAssetTypes.map((value) => WORKBOOK_ASSET_TYPE_LABELS[value]).join('、');
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
  if (!label || !reason) throw chatError('INVALID_CHAT_RESULT', 'Agent 操作建议不完整', 502);
  return {
    reply,
    proposal: {
      action, label, reason, workbookEpisodeStart: null, workbookEpisodeEnd: null, workbookAssetTypes: []
    }
  };
};

const publicSession = (session) => Object.freeze({
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

export function createCodexAgentChatService({
  resolveProjectRoot,
  createCodex = loadDefaultCodex,
  readRuntimeConfig = readCodexRuntimeConfig,
  writeRuntimeConfig = null,
  now = () => new Date(),
  createId = () => randomUUID(),
  idleTimeoutMs,
  totalTimeoutMs,
  networkRetryLimit
} = {}) {
  if (typeof resolveProjectRoot !== 'function' || typeof createCodex !== 'function'
    || typeof readRuntimeConfig !== 'function'
    || (writeRuntimeConfig !== null && typeof writeRuntimeConfig !== 'function')
    || typeof now !== 'function' || typeof createId !== 'function') {
    throw new TypeError('Agent chat service dependencies must be functions');
  }
  const idleTimeout = boundedTimeout(idleTimeoutMs, DEFAULT_CHAT_IDLE_TIMEOUT_MS, 'idleTimeoutMs');
  const totalTimeout = boundedTimeout(totalTimeoutMs, DEFAULT_CHAT_TOTAL_TIMEOUT_MS, 'totalTimeoutMs');
  const retryLimit = boundedRetryLimit(networkRetryLimit);
  const sessions = new Map();
  let shuttingDown = false;

  const timestamp = () => {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError('now() must return a valid date');
    return date.toISOString();
  };

  const nextId = (prefix) => `${prefix}-${createId()}`;

  const touch = (session) => { session.updatedAt = timestamp(); };

  const appendActivity = (session, kind, text) => {
    const safe = safeText(text, 500, session.projectRoot);
    if (!safe) return;
    const previous = session.activities.at(-1);
    if (previous?.kind === kind && previous.text === safe) return;
    session.activities.push({ activityId: nextId('activity'), kind, text: safe, createdAt: timestamp() });
    if (session.activities.length > MAX_ACTIVITIES) session.activities.splice(0, session.activities.length - MAX_ACTIVITIES);
    touch(session);
  };

  const getOwnedSession = (projectIdInput, sessionIdInput) => {
    const projectId = validateProjectId(projectIdInput);
    const sessionId = validateSessionId(sessionIdInput);
    const session = sessions.get(sessionId);
    if (!session || session.projectId !== projectId) throw chatError('CHAT_SESSION_NOT_FOUND', 'Agent 对话不存在', 404);
    return session;
  };

  const pruneSessions = () => {
    if (sessions.size < MAX_SESSIONS) return;
    for (const [sessionId, session] of sessions) {
      if (sessions.size < MAX_SESSIONS) break;
      if (session.status !== 'running') sessions.delete(sessionId);
    }
    if (sessions.size >= MAX_SESSIONS) throw chatError('CHAT_SESSION_LIMIT', '当前 Agent 对话较多，请稍后重试', 503);
  };

  const runTurn = async (session, userMessage, firstTurn, turnController) => {
    let forcedError = null;
    let idleTimer = null;
    let totalTimer = null;
    let abortListener = null;
    const stoppedPromise = new Promise((_, reject) => {
      abortListener = () => reject(forcedError ?? chatError('CHAT_CANCELLED', 'Agent 对话已停止', 409));
      turnController.signal.addEventListener('abort', abortListener, { once: true });
      if (turnController.signal.aborted) queueMicrotask(abortListener);
    });
    const forceStop = (error) => {
      if (forcedError || turnController.signal.aborted) return;
      forcedError = error;
      turnController.abort(error);
    };
    const throwIfStopped = () => {
      if (forcedError) throw forcedError;
      if (turnController.signal.aborted) throw chatError('CHAT_CANCELLED', 'Agent 对话已停止', 409);
    };
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => forceStop(chatError(
        'CHAT_IDLE_TIMEOUT',
        'Codex Agent 3 分钟没有有效响应，本轮对话已停止',
        504
      )), idleTimeout);
    };
    const executeTurn = async () => {
      resetIdleTimer();
      try {
        if (!session.codex) session.codex = await createCodex();
        throwIfStopped();
        resetIdleTimer();
        if (!session.codex || typeof session.codex.startThread !== 'function') {
          throw chatError('CODEX_SDK_UNAVAILABLE', 'Codex SDK 对话能力不可用', 503);
        }
        if (!session.thread) {
          session.thread = session.codex.startThread({
            workingDirectory: session.projectRoot,
            skipGitRepoCheck: true,
            sandboxMode: 'read-only',
            networkAccessEnabled: false,
            webSearchMode: 'disabled',
            approvalPolicy: 'never',
            ...codexThreadRuntimeOptions(session.runtimeConfig)
          });
        }
        if (!session.thread || typeof session.thread.runStreamed !== 'function') {
          throw chatError('CODEX_SDK_UNAVAILABLE', 'Codex SDK 对话线程不可用', 503);
        }
        const input = firstTurn
          ? `${FIRST_TURN_RULES}\n\n用户消息：\n${userMessage}`
          : `继续严格遵守首轮的只读边界和 output schema。\n\n用户消息：\n${userMessage}`;
        const streamed = await session.thread.runStreamed(input, {
          outputSchema: CHAT_RESULT_SCHEMA,
          signal: turnController.signal
        });
        throwIfStopped();
        resetIdleTimer();
        if (!streamed?.events || typeof streamed.events[Symbol.asyncIterator] !== 'function') {
          throw chatError('CODEX_SDK_UNAVAILABLE', 'Codex SDK 没有返回事件流', 503);
        }
        let finalMessage = '';
        let completed = false;
        let lastStreamError = '';
        let networkRetryCount = 0;
        for await (const event of streamed.events) {
          throwIfStopped();
          if (event?.type === 'error') {
            lastStreamError = String(event.message || 'Codex stream error');
            networkRetryCount += 1;
            if (networkRetryCount >= retryLimit) {
              const detail = safeText(lastStreamError, 180, session.projectRoot)
                .replace(/\s+/gu, ' ');
              const error = chatError(
                'CHAT_NETWORK_RETRY_EXHAUSTED',
                `Codex 网络重试已达到 ${retryLimit} 次上限，本轮对话已停止${detail ? `；最近错误：${detail}` : ''}`,
                504
              );
              forceStop(error);
              throw error;
            }
            appendActivity(session, 'network', `连接短暂中断，正在自动重试（${networkRetryCount}/${retryLimit}）`);
            continue;
          }
          resetIdleTimer();
          const item = event?.item;
          if (event?.type === 'thread.started') appendActivity(session, 'status', 'Agent 对话已建立');
          else if (event?.type === 'turn.started') appendActivity(session, 'status', 'Agent 正在处理本轮消息');
          else if (item?.type === 'reasoning' && item.text) appendActivity(session, 'reasoning', `推理摘要：${item.text}`);
          else if (item?.type === 'todo_list' && Array.isArray(item.items)) {
            const pending = item.items.filter((entry) => !entry.completed).map((entry) => entry.text).filter(Boolean).slice(0, 3);
            if (pending.length) appendActivity(session, 'plan', `计划：${pending.join('；')}`);
          } else if (item?.type === 'command_execution') {
            appendActivity(session, 'tool', item.status === 'failed' ? '项目只读检查失败' : item.status === 'completed' ? '项目只读检查已完成' : '正在只读检查项目');
          } else if (item?.type === 'file_change') {
            throw chatError('CHAT_WRITE_ATTEMPT', '只读对话尝试修改项目，已阻止', 409);
          } else if (item?.type === 'mcp_tool_call' || item?.type === 'web_search') {
            throw chatError('CHAT_EXTERNAL_TOOL_ATTEMPT', '只读对话尝试调用外部工具，已阻止', 409);
          } else if (event?.type === 'item.completed' && item?.type === 'agent_message') {
            finalMessage = item.text;
          } else if (event?.type === 'turn.failed') {
            throw new Error(event.error?.message || 'Codex turn failed');
          }
          if (event?.type === 'turn.completed') completed = true;
        }
        throwIfStopped();
        if (!completed) {
          if (lastStreamError) throw new Error(lastStreamError);
          throw chatError('CODEX_CHAT_FAILED', 'Agent 对话没有正常结束', 503);
        }
        const result = parseResult(finalMessage, session.projectRoot);
        throwIfStopped();
        session.messages.push({
          messageId: nextId('message'),
          role: 'assistant',
          text: result.reply,
          createdAt: timestamp(),
          proposal: result.proposal
        });
        if (session.messages.length > MAX_MESSAGES) session.messages.splice(0, session.messages.length - MAX_MESSAGES);
        session.status = 'idle';
        session.error = null;
        appendActivity(session, 'status', '本轮对话已完成');
      } finally {
        clearTimeout(idleTimer);
      }
    };

    totalTimer = setTimeout(() => forceStop(chatError(
      'CHAT_TOTAL_TIMEOUT',
      'Codex Agent 本轮对话超过 10 分钟总时限，已停止',
      504
    )), totalTimeout);
    try {
      await Promise.race([executeTurn(), stoppedPromise]);
    } catch (rawError) {
      const error = forcedError ?? classifyError(rawError);
      if (session.controller !== turnController || session.status === 'cancelled') return;
      session.status = error.code === 'CHAT_CANCELLED' ? 'cancelled' : 'failed';
      session.error = error.message;
    } finally {
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      if (abortListener) turnController.signal.removeEventListener('abort', abortListener);
      if (session.controller === turnController) session.controller = null;
      touch(session);
    }
  };

  const startMessage = async ({ projectId: projectIdInput, sessionId: sessionIdInput = null, message }) => {
    if (shuttingDown) throw chatError('CHAT_SERVICE_STOPPING', '软件正在退出，不能开始新对话', 503);
    const projectId = validateProjectId(projectIdInput);
    const userMessage = validateMessage(message);
    let session;
    let firstTurn = false;
    if (sessionIdInput === null) {
      pruneSessions();
      const projectRoot = await canonicalProject(await resolveProjectRoot(projectId));
      const createdAt = timestamp();
      session = {
        sessionId: nextId('chat'),
        projectId,
        projectRoot,
        status: 'idle',
        createdAt,
        updatedAt: createdAt,
        runtimeConfig: await readRuntimeConfig(),
        messages: [],
        activities: [],
        error: null,
        codex: null,
        thread: null,
        controller: null,
        activePromise: null
      };
      sessions.set(session.sessionId, session);
      firstTurn = true;
    } else {
      session = getOwnedSession(projectId, sessionIdInput);
    }
    if (session.status === 'running') throw chatError('CHAT_TURN_BUSY', '上一条 Agent 消息仍在处理中', 409);
    if (session.messages.length >= MAX_MESSAGES) throw chatError('CHAT_MESSAGE_LIMIT', '当前对话较长，请新建对话后继续', 409);
    session.messages.push({
      messageId: nextId('message'),
      role: 'user',
      text: userMessage,
      createdAt: timestamp(),
      proposal: null
    });
    session.activities = [];
    session.status = 'running';
    session.error = null;
    const controller = new AbortController();
    session.controller = controller;
    touch(session);
    session.activePromise = runTurn(session, userMessage, firstTurn, controller);
    return publicSession(session);
  };

  const getSession = ({ projectId, sessionId }) => publicSession(getOwnedSession(projectId, sessionId));

  const cancelSession = ({ projectId, sessionId }) => {
    const session = getOwnedSession(projectId, sessionId);
    if (session.status === 'running') {
      session.status = 'cancelled';
      session.error = null;
      session.controller?.abort();
      appendActivity(session, 'status', 'Agent 对话已由用户停止');
    }
    return publicSession(session);
  };

  const getRuntimeConfig = async () => readRuntimeConfig();

  const updateRuntimeConfig = async (input) => {
    if (!writeRuntimeConfig) {
      throw chatError('CODEX_RUNTIME_CONFIG_READ_ONLY', '当前运行方式不能保存 Codex 模型配置', 503);
    }
    return writeRuntimeConfig(input);
  };

  const shutdown = async () => {
    shuttingDown = true;
    const pending = [];
    for (const session of sessions.values()) {
      if (session.status === 'running') {
        session.status = 'cancelled';
        session.controller?.abort();
      }
      if (session.activePromise) pending.push(session.activePromise);
    }
    await Promise.allSettled(pending);
  };

  return Object.freeze({
    startMessage,
    getSession,
    cancelSession,
    getRuntimeConfig,
    updateRuntimeConfig,
    shutdown
  });
}
