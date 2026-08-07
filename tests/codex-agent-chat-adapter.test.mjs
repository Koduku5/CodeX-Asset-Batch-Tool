import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CodexAgentChatAdapter,
  CodexAgentChatAdapterError
} from '../src/ui/services/codex-agent-chat-adapter.mjs';

const runtimeConfig = {
  model: 'gpt-5.6-sol',
  reasoningEffort: 'xhigh',
  modelLabel: 'gpt-5.6-sol',
  reasoningEffortLabel: 'xhigh',
  source: 'local-codex-config'
};
const session = {
  sessionId: 'chat-11111111-1111-4111-8111-111111111111',
  projectId: 'alpha',
  status: 'running',
  createdAt: '2026-08-05T00:00:00.000Z',
  updatedAt: '2026-08-05T00:00:01.000Z',
  runtimeConfig,
  messages: [{
    messageId: 'message-22222222-2222-4222-8222-222222222222',
    role: 'user',
    text: '检查当前状态',
    createdAt: '2026-08-05T00:00:01.000Z',
    proposal: null
  }],
  activities: [{
    activityId: 'activity-33333333-3333-4333-8333-333333333333',
    kind: 'status',
    text: '正在分析当前项目状态',
    createdAt: '2026-08-05T00:00:01.000Z'
  }],
  error: null
};
const response = (data, ok = true) => ({ ok, json: async () => ({ ok: true, data }) });

test('Agent chat adapter binds model summary and project conversation routes exactly', async () => {
  const calls = [];
  const adapter = new CodexAgentChatAdapter({
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      return response(url.endsWith('/runtime-config') ? runtimeConfig : session);
    }
  });

  assert.deepEqual(await adapter.getRuntimeConfig(), runtimeConfig);
  assert.deepEqual(await adapter.updateRuntimeConfig({
    model: 'gpt-5.6-terra', reasoningEffort: 'medium'
  }), runtimeConfig);
  assert.equal(calls[1][1].method, 'PUT');
  assert.deepEqual(JSON.parse(calls[1][1].body), {
    model: 'gpt-5.6-terra', reasoningEffort: 'medium'
  });
  const started = await adapter.sendMessage({ projectId: 'alpha', message: ' 检查当前状态 ' });
  assert.equal(started.sessionId, session.sessionId);
  assert.deepEqual(JSON.parse(calls[2][1].body), { sessionId: null, message: '检查当前状态' });
  assert.equal(calls[2][0], '/api/projects/alpha/agent-chat/messages');
  await adapter.getSession({ projectId: 'alpha', sessionId: session.sessionId });
  assert.equal(calls[3][0], `/api/projects/alpha/agent-chat/sessions/${session.sessionId}`);
  await adapter.cancelSession({ projectId: 'alpha', sessionId: session.sessionId });
  assert.equal(calls[4][1].method, 'DELETE');
});

test('Agent chat adapter rejects malformed, cross-project and unsafe payloads', async () => {
  const malformed = new CodexAgentChatAdapter({
    fetchImpl: async () => response({ ...session, privateThreadId: 'secret' })
  });
  await assert.rejects(
    () => malformed.getSession({ projectId: 'alpha', sessionId: session.sessionId }),
    (error) => error instanceof CodexAgentChatAdapterError && error.code === 'INVALID_RESPONSE'
  );

  const mismatch = new CodexAgentChatAdapter({
    fetchImpl: async () => response({ ...session, projectId: 'beta' })
  });
  await assert.rejects(
    () => mismatch.sendMessage({ projectId: 'alpha', message: 'hello' }),
    (error) => error instanceof CodexAgentChatAdapterError && error.code === 'CHAT_SESSION_MISMATCH'
  );

  const adapter = new CodexAgentChatAdapter({ fetchImpl: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(() => adapter.sendMessage({ projectId: '../alpha', message: 'hello' }), CodexAgentChatAdapterError);
  await assert.rejects(() => adapter.sendMessage({ projectId: 'alpha', message: ' '.repeat(20) }), CodexAgentChatAdapterError);
  await assert.rejects(() => adapter.getSession({ projectId: 'alpha', sessionId: '../session' }), CodexAgentChatAdapterError);
});
