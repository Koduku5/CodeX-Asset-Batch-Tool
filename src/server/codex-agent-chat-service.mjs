import { randomUUID } from 'node:crypto';

import {
  codexThreadRuntimeOptions,
  readCodexRuntimeConfig
} from './codex-runtime-config.mjs';
import {
  CHAT_RESULT_SCHEMA,
  DEFAULT_CHAT_IDLE_TIMEOUT_MS,
  DEFAULT_CHAT_TOTAL_TIMEOUT_MS,
  FIRST_TURN_RULES,
  MAX_ACTIVITIES,
  MAX_MESSAGES,
  MAX_SESSIONS,
  CodexAgentChatError,
  boundedRetryLimit,
  boundedTimeout,
  canonicalProject,
  chatError,
  classifyError,
  loadDefaultCodex,
  parseResult,
  publicSession,
  safeText,
  validateMessage,
  validateProjectId,
  validateSessionId
} from './codex-agent-chat/contracts.mjs';

export { CodexAgentChatError } from './codex-agent-chat/contracts.mjs';

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
  if (typeof resolveProjectRoot !== 'function'
    || typeof createCodex !== 'function'
    || typeof readRuntimeConfig !== 'function'
    || (writeRuntimeConfig !== null && typeof writeRuntimeConfig !== 'function')
    || typeof now !== 'function'
    || typeof createId !== 'function') {
    throw new TypeError('Agent chat service dependencies must be functions');
  }
  const idleTimeout = boundedTimeout(
    idleTimeoutMs,
    DEFAULT_CHAT_IDLE_TIMEOUT_MS,
    'idleTimeoutMs'
  );
  const totalTimeout = boundedTimeout(
    totalTimeoutMs,
    DEFAULT_CHAT_TOTAL_TIMEOUT_MS,
    'totalTimeoutMs'
  );
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
    session.activities.push({
      activityId: nextId('activity'),
      kind,
      text: safe,
      createdAt: timestamp()
    });
    if (session.activities.length > MAX_ACTIVITIES) {
      session.activities.splice(0, session.activities.length - MAX_ACTIVITIES);
    }
    touch(session);
  };

  const getOwnedSession = (projectIdInput, sessionIdInput) => {
    const projectId = validateProjectId(projectIdInput);
    const sessionId = validateSessionId(sessionIdInput);
    const session = sessions.get(sessionId);
    if (!session || session.projectId !== projectId) {
      throw chatError('CHAT_SESSION_NOT_FOUND', 'Agent 对话不存在', 404);
    }
    return session;
  };

  const pruneSessions = () => {
    if (sessions.size < MAX_SESSIONS) return;
    for (const [sessionId, session] of sessions) {
      if (sessions.size < MAX_SESSIONS) break;
      if (session.status !== 'running') sessions.delete(sessionId);
    }
    if (sessions.size >= MAX_SESSIONS) {
      throw chatError('CHAT_SESSION_LIMIT', '当前 Agent 对话较多，请稍后重试', 503);
    }
  };

  const runTurn = async (session, userMessage, firstTurn, turnController) => {
    let forcedError = null;
    let idleTimer = null;
    let totalTimer = null;
    let abortListener = null;
    const stoppedPromise = new Promise((_, reject) => {
      abortListener = () => reject(
        forcedError ?? chatError('CHAT_CANCELLED', 'Agent 对话已停止', 409)
      );
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
      if (turnController.signal.aborted) {
        throw chatError('CHAT_CANCELLED', 'Agent 对话已停止', 409);
      }
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
            appendActivity(
              session,
              'network',
              `连接短暂中断，正在自动重试（${networkRetryCount}/${retryLimit}）`
            );
            continue;
          }
          resetIdleTimer();
          const item = event?.item;
          if (event?.type === 'thread.started') {
            appendActivity(session, 'status', 'Agent 对话已建立');
          } else if (event?.type === 'turn.started') {
            appendActivity(session, 'status', 'Agent 正在处理本轮消息');
          } else if (item?.type === 'reasoning' && item.text) {
            appendActivity(session, 'reasoning', `推理摘要：${item.text}`);
          } else if (item?.type === 'todo_list' && Array.isArray(item.items)) {
            const pending = item.items
              .filter((entry) => !entry.completed)
              .map((entry) => entry.text)
              .filter(Boolean)
              .slice(0, 3);
            if (pending.length) appendActivity(session, 'plan', `计划：${pending.join('；')}`);
          } else if (item?.type === 'command_execution') {
            appendActivity(
              session,
              'tool',
              item.status === 'failed'
                ? '项目只读检查失败'
                : item.status === 'completed' ? '项目只读检查已完成' : '正在只读检查项目'
            );
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
        if (session.messages.length > MAX_MESSAGES) {
          session.messages.splice(0, session.messages.length - MAX_MESSAGES);
        }
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

  const startMessage = async ({
    projectId: projectIdInput,
    sessionId: sessionIdInput = null,
    message
  }) => {
    if (shuttingDown) {
      throw chatError('CHAT_SERVICE_STOPPING', '软件正在退出，不能开始新对话', 503);
    }
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
    if (session.status === 'running') {
      throw chatError('CHAT_TURN_BUSY', '上一条 Agent 消息仍在处理中', 409);
    }
    if (session.messages.length >= MAX_MESSAGES) {
      throw chatError('CHAT_MESSAGE_LIMIT', '当前对话较长，请新建对话后继续', 409);
    }
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

  const getSession = ({ projectId, sessionId }) => (
    publicSession(getOwnedSession(projectId, sessionId))
  );

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
      throw chatError(
        'CODEX_RUNTIME_CONFIG_READ_ONLY',
        '当前运行方式不能保存 Codex 模型配置',
        503
      );
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
