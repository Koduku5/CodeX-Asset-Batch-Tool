import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CodexAgentChatError,
  createCodexAgentChatService
} from '../src/server/codex-agent-chat-service.mjs';

const waitFor = async (read, predicate, timeout = 1500) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for Agent chat state');
};

const resultMessage = (reply, action = 'none', scope = null) => JSON.stringify({
  reply,
  proposal: action === 'none'
    ? {
        action: 'none', label: '', reason: '', workbookEpisodeStart: null,
        workbookEpisodeEnd: null, workbookAssetTypes: []
      }
    : {
        action, label: '执行建议', reason: '按确认范围执行。',
        workbookEpisodeStart: scope?.start ?? null,
        workbookEpisodeEnd: scope?.end ?? null,
        workbookAssetTypes: scope?.assetTypes ?? []
      }
});

test('Agent chat is a read-only multi-turn thread with sanitized summaries and confirmed proposals only', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ka-agent-chat-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const threadOptions = [];
  const turnCalls = [];
  let turn = 0;
  const thread = {
    async runStreamed(input, options) {
      turn += 1;
      turnCalls.push({ input, options });
      return {
        events: (async function* () {
          yield { type: 'thread.started', thread_id: 'private-thread-id' };
          yield { type: 'turn.started' };
          yield { type: 'item.completed', item: { type: 'reasoning', text: `检查 ${root} 的正式状态` } };
          yield { type: 'item.completed', item: { type: 'command_execution', status: 'completed', command: 'private command' } };
          yield {
            type: 'item.completed',
            item: {
              type: 'agent_message',
              text: turn === 1
                ? resultMessage(`当前任务仍在分析。password=do-not-leak ${root}`, 'build-scoped-workbook', {
                    start: 1, end: 3, assetTypes: ['characters', 'scenes']
                  })
                : resultMessage('暂停后可以继续检查。')
            }
          };
          yield { type: 'turn.completed', usage: {} };
        })()
      };
    }
  };
  const service = createCodexAgentChatService({
    resolveProjectRoot: async () => root,
    createCodex: async () => ({
      startThread(options) {
        threadOptions.push(options);
        return thread;
      }
    }),
    readRuntimeConfig: async () => Object.freeze({
      model: 'gpt-test', reasoningEffort: 'high', modelLabel: 'gpt-test',
      reasoningEffortLabel: 'high', source: 'local-codex-config'
    })
  });

  const started = await service.startMessage({ projectId: 'alpha', message: '看看当前为什么卡住了' });
  assert.equal(started.status, 'running');
  const completed = await waitFor(
    () => service.getSession({ projectId: 'alpha', sessionId: started.sessionId }),
    (value) => value.status === 'idle'
  );
  assert.equal(threadOptions.length, 1);
  assert.deepEqual(threadOptions[0], {
    workingDirectory: await realpath(root),
    skipGitRepoCheck: true,
    sandboxMode: 'read-only',
    networkAccessEnabled: false,
    webSearchMode: 'disabled',
    approvalPolicy: 'never',
    model: 'gpt-test',
    modelReasoningEffort: 'high'
  });
  assert.match(turnCalls[0].input, /只读讨论/u);
  assert.match(turnCalls[0].input, /问候、致谢、确认或通用闲聊必须直接回复/u);
  assert.match(turnCalls[0].input, /看看当前为什么卡住了/u);
  assert.deepEqual(turnCalls[0].options.outputSchema.properties.proposal.properties.action.enum.includes('pause-current-task'), true);
  assert.equal(completed.runtimeConfig.modelLabel, 'gpt-test');
  assert.equal(completed.runtimeConfig.reasoningEffortLabel, 'high');
  assert.equal(completed.messages.length, 2);
  assert.equal(completed.messages[1].proposal.action, 'build-scoped-workbook');
  assert.equal(completed.messages[1].proposal.workbookEpisodeStart, 1);
  assert.equal(completed.messages[1].proposal.workbookEpisodeEnd, 3);
  assert.deepEqual(completed.messages[1].proposal.workbookAssetTypes, ['characters', 'scenes']);
  assert.match(completed.messages[1].proposal.reason, /后台会先完成全剧逐集分析/u);
  assert.match(completed.messages[1].text, /第 1～3 集/u);
  assert.match(completed.messages[1].text, /角色、场景/u);
  assert.equal(completed.messages[1].text.includes(root), false);
  assert.equal(completed.messages[1].text.includes('do-not-leak'), false);
  assert.equal(completed.activities.some((activity) => activity.kind === 'reasoning' && !activity.text.includes(root)), true);
  assert.equal(JSON.stringify(completed).includes('private command'), false);
  assert.equal(JSON.stringify(completed).includes('private-thread-id'), false);

  const second = await service.startMessage({
    projectId: 'alpha', sessionId: started.sessionId, message: '暂停以后呢？'
  });
  const secondCompleted = await waitFor(
    () => service.getSession({ projectId: 'alpha', sessionId: started.sessionId }),
    (value) => value.status === 'idle' && value.messages.length === 4
  );
  assert.equal(threadOptions.length, 1);
  assert.match(turnCalls[1].input, /继续严格遵守首轮/u);
  assert.equal(second.sessionId, started.sessionId);
  assert.equal(secondCompleted.messages[3].proposal, null);
});

test('Agent chat blocks write attempts and rejects unsafe inputs', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ka-agent-chat-write-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const service = createCodexAgentChatService({
    resolveProjectRoot: async () => root,
    createCodex: async () => ({
      startThread: () => ({
        runStreamed: async () => ({
          events: (async function* () {
            yield { type: 'item.completed', item: { type: 'file_change', status: 'completed', changes: [] } };
          })()
        })
      })
    }),
    readRuntimeConfig: async () => ({
      model: null, reasoningEffort: null, modelLabel: 'Codex 默认',
      reasoningEffortLabel: 'Codex 默认', source: 'local-codex-config'
    })
  });

  await assert.rejects(
    () => service.startMessage({ projectId: '../alpha', message: 'hello' }),
    (error) => error instanceof CodexAgentChatError && error.code === 'INVALID_PROJECT_ID'
  );
  await assert.rejects(
    () => service.startMessage({ projectId: 'alpha', message: '   ' }),
    (error) => error instanceof CodexAgentChatError && error.code === 'INVALID_CHAT_MESSAGE'
  );

  const started = await service.startMessage({ projectId: 'alpha', message: '直接改文件' });
  const failed = await waitFor(
    () => service.getSession({ projectId: 'alpha', sessionId: started.sessionId }),
    (value) => value.status === 'failed'
  );
  assert.equal(failed.error, '只读对话尝试修改项目，已阻止');
  assert.equal(failed.messages.length, 1);
});

test('a running Agent chat can be cancelled without producing a false assistant reply', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ka-agent-chat-cancel-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const service = createCodexAgentChatService({
    resolveProjectRoot: async () => root,
    createCodex: async () => ({
      startThread: () => ({
        runStreamed: async (_input, { signal }) => ({
          events: (async function* () {
            yield { type: 'turn.started' };
            await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
            throw new Error('aborted');
          })()
        })
      })
    }),
    readRuntimeConfig: async () => ({
      model: 'gpt-test', reasoningEffort: 'xhigh', modelLabel: 'gpt-test',
      reasoningEffortLabel: 'xhigh', source: 'local-codex-config'
    })
  });
  const started = await service.startMessage({ projectId: 'alpha', message: '继续分析' });
  const cancelled = service.cancelSession({ projectId: 'alpha', sessionId: started.sessionId });
  assert.equal(cancelled.status, 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const final = service.getSession({ projectId: 'alpha', sessionId: started.sessionId });
  assert.equal(final.status, 'cancelled');
  assert.equal(final.messages.length, 1);
});

test('Agent chat stops and aborts the SDK after the network retry limit', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ka-agent-chat-retry-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  let sdkSignal = null;
  const service = createCodexAgentChatService({
    resolveProjectRoot: async () => root,
    createCodex: async () => ({
      startThread: () => ({
        runStreamed: async (_input, { signal }) => {
          sdkSignal = signal;
          return {
            events: (async function* () {
              yield { type: 'turn.started' };
              for (let attempt = 1; attempt <= 3; attempt += 1) {
                yield { type: 'error', message: `temporary network error ${attempt}` };
              }
            })()
          };
        }
      })
    }),
    readRuntimeConfig: async () => ({
      model: 'gpt-test', reasoningEffort: 'xhigh', modelLabel: 'gpt-test',
      reasoningEffortLabel: 'xhigh', source: 'local-codex-config'
    }),
    networkRetryLimit: 3,
    totalTimeoutMs: 1000,
    idleTimeoutMs: 500
  });

  const started = await service.startMessage({ projectId: 'alpha', message: '检查当前状态' });
  const failed = await waitFor(
    () => service.getSession({ projectId: 'alpha', sessionId: started.sessionId }),
    (value) => value.status === 'failed'
  );
  assert.equal(sdkSignal?.aborted, true);
  assert.equal(
    failed.error,
    'Codex 网络重试已达到 3 次上限，本轮对话已停止；最近错误：temporary network error 3'
  );
  assert.equal(failed.activities.some((activity) => activity.text === '连接短暂中断，正在自动重试（1/3）'), true);
  assert.equal(failed.activities.some((activity) => activity.text === '连接短暂中断，正在自动重试（2/3）'), true);
  assert.equal(failed.activities.some((activity) => activity.text === '连接短暂中断，正在自动重试（3/3）'), false);
  assert.equal(failed.activities.some((activity) => activity.kind === 'error'), false);
});

test('Agent chat total timeout aborts an SDK call that never returns', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ka-agent-chat-total-timeout-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  let sdkSignal = null;
  const service = createCodexAgentChatService({
    resolveProjectRoot: async () => root,
    createCodex: async () => ({
      startThread: () => ({
        runStreamed: async (_input, { signal }) => {
          sdkSignal = signal;
          return new Promise(() => {});
        }
      })
    }),
    readRuntimeConfig: async () => ({
      model: null, reasoningEffort: null, modelLabel: 'Codex 默认',
      reasoningEffortLabel: 'Codex 默认', source: 'local-codex-config'
    }),
    totalTimeoutMs: 20,
    idleTimeoutMs: 1000
  });

  const started = await service.startMessage({ projectId: 'alpha', message: '检查当前状态' });
  const failed = await waitFor(
    () => service.getSession({ projectId: 'alpha', sessionId: started.sessionId }),
    (value) => value.status === 'failed'
  );
  assert.equal(sdkSignal?.aborted, true);
  assert.equal(failed.error, 'Codex Agent 本轮对话超过 10 分钟总时限，已停止');
});

test('Agent chat idle timeout ignores a silent SDK stream and aborts it', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ka-agent-chat-idle-timeout-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  let sdkSignal = null;
  const service = createCodexAgentChatService({
    resolveProjectRoot: async () => root,
    createCodex: async () => ({
      startThread: () => ({
        runStreamed: async (_input, { signal }) => {
          sdkSignal = signal;
          return { events: (async function* () { await new Promise(() => {}); })() };
        }
      })
    }),
    readRuntimeConfig: async () => ({
      model: null, reasoningEffort: null, modelLabel: 'Codex 默认',
      reasoningEffortLabel: 'Codex 默认', source: 'local-codex-config'
    }),
    totalTimeoutMs: 1000,
    idleTimeoutMs: 20
  });

  const started = await service.startMessage({ projectId: 'alpha', message: '检查当前状态' });
  const failed = await waitFor(
    () => service.getSession({ projectId: 'alpha', sessionId: started.sessionId }),
    (value) => value.status === 'failed'
  );
  assert.equal(sdkSignal?.aborted, true);
  assert.equal(failed.error, 'Codex Agent 3 分钟没有有效响应，本轮对话已停止');
});
