import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createCodexSdkStatusService } from '../src/server/codex-sdk-status.mjs';
import { createPrototypeServer } from '../src/server/server.mjs';
import { CodexStatusAdapter, CodexStatusError } from '../src/ui/services/codex-status-adapter.mjs';

const makeStatusChild = ({ output, exitCode }) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  queueMicrotask(() => {
    child.stdout.end(output);
    child.emit('close', exitCode);
  });
  return child;
};

test('Codex status requires both the SDK runtime and an authenticated bundled CLI', async () => {
  const calls = [];
  const connected = createCodexSdkStatusService({
    loadSdk: async () => ({ Codex: class Codex {} }),
    resolveCliPath: () => 'C:\\bundle\\codex.js',
    nodeExecutable: 'C:\\bundle\\node.exe',
    spawnImpl: (...args) => {
      calls.push(args);
      return makeStatusChild({ output: 'Logged in using ChatGPT\n', exitCode: 0 });
    },
    now: () => new Date('2026-08-05T00:00:00.000Z'),
    cacheMs: 0
  });
  assert.deepEqual(await connected.getStatus(), {
    connected: true,
    sdkAvailable: true,
    authorization: 'connected',
    message: '已连接 Codex SDK',
    checkedAt: '2026-08-05T00:00:00.000Z'
  });
  assert.deepEqual(calls[0][1], ['C:\\bundle\\codex.js', 'login', 'status']);
  assert.equal(calls[0][2].shell, false);
  assert.equal(calls[0][2].windowsHide, true);

  const disconnected = createCodexSdkStatusService({
    loadSdk: async () => ({ Codex: class Codex {} }),
    resolveCliPath: () => 'codex.js',
    spawnImpl: () => makeStatusChild({ output: 'Not logged in\n', exitCode: 1 })
  });
  assert.equal((await disconnected.getStatus()).connected, false);

  const unavailable = createCodexSdkStatusService({ loadSdk: async () => { throw new Error('missing'); } });
  const unavailableStatus = await unavailable.getStatus();
  assert.equal(unavailableStatus.sdkAvailable, false);
  assert.equal(unavailableStatus.message, 'Codex SDK 未安装或无法载入');
});

test('Codex login starts only the bundled CLI and reuses its cached login afterward', async () => {
  const calls = [];
  let loginChild = null;
  let loggedIn = false;
  const service = createCodexSdkStatusService({
    loadSdk: async () => ({ Codex: class Codex {} }),
    resolveCliPath: () => 'C:\\bundle\\codex.js',
    nodeExecutable: 'C:\\bundle\\node.exe',
    environment: {
      USERPROFILE: 'C:\\Users\\tester',
      CODEX_HOME: 'C:\\Users\\tester\\.codex',
      KA_DESKTOP_TOKEN: 'must-not-reach-cli'
    },
    spawnImpl: (...args) => {
      calls.push(args);
      if (args[1].at(-1) === 'status') {
        return makeStatusChild({
          output: loggedIn ? 'Logged in using ChatGPT\n' : 'Not logged in\n',
          exitCode: loggedIn ? 0 : 1
        });
      }
      loginChild = new EventEmitter();
      queueMicrotask(() => loginChild.emit('spawn'));
      return loginChild;
    },
    cacheMs: 0
  });

  assert.deepEqual(await service.startLogin(), {
    started: true,
    alreadyConnected: false,
    loginInProgress: true
  });
  assert.deepEqual(calls[1][1], ['C:\\bundle\\codex.js', 'login']);
  assert.equal(calls[1][2].shell, false);
  assert.equal(calls[1][2].windowsHide, true);
  assert.equal(calls[1][2].stdio, 'ignore');
  assert.equal(calls[1][2].env.CODEX_HOME, 'C:\\Users\\tester\\.codex');
  assert.equal(Object.hasOwn(calls[1][2].env, 'KA_DESKTOP_TOKEN'), false);
  assert.deepEqual(await service.startLogin(), {
    started: false,
    alreadyConnected: false,
    loginInProgress: true
  });

  loggedIn = true;
  loginChild.emit('close', 0);
  assert.equal((await service.getStatus({ force: true })).connected, true);
  assert.deepEqual(await service.startLogin(), {
    started: false,
    alreadyConnected: true,
    loginInProgress: false
  });
});

test('Codex authorization route starts the controlled login service', async (context) => {
  let starts = 0;
  const server = createPrototypeServer({
    softwareMode: false,
    installationRoot: process.cwd(),
    codexStatusService: {
      getStatus: async () => ({
        connected: false,
        sdkAvailable: true,
        authorization: 'not_connected',
        message: '未连接 Codex SDK',
        checkedAt: '2026-08-05T00:00:00.000Z'
      }),
      startLogin: async () => {
        starts += 1;
        return { started: true, alreadyConnected: false, loginInProgress: true };
      }
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/codex-agent/authorize`, {
    method: 'POST',
    headers: { accept: 'application/json' }
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    data: { started: true, alreadyConnected: false, loginInProgress: true }
  });
  assert.equal(starts, 1);
});

test('Codex Agent chat routes expose local config and project-bound sessions only', async (context) => {
  const runtimeConfig = {
    model: 'gpt-5.6-sol', reasoningEffort: 'xhigh', modelLabel: 'gpt-5.6-sol',
    reasoningEffortLabel: 'xhigh', source: 'local-codex-config'
  };
  const session = {
    sessionId: 'chat-11111111-1111-4111-8111-111111111111', projectId: 'alpha', status: 'running',
    createdAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:00:01.000Z',
    runtimeConfig, messages: [], activities: [], error: null
  };
  const savedRuntimeConfig = {
    model: 'gpt-5.6-terra', reasoningEffort: 'medium', modelLabel: 'gpt-5.6-terra',
    reasoningEffortLabel: 'medium', source: 'software-settings'
  };
  const calls = [];
  const server = createPrototypeServer({
    softwareMode: false,
    installationRoot: process.cwd(),
    codexAgentChatService: {
      getRuntimeConfig: async () => runtimeConfig,
      updateRuntimeConfig: async (input) => (calls.push(['update', input]), savedRuntimeConfig),
      startMessage: async (input) => (calls.push(['start', input]), session),
      getSession: (input) => (calls.push(['get', input]), session),
      cancelSession: (input) => (calls.push(['cancel', input]), { ...session, status: 'cancelled' }),
      shutdown: async () => {}
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const configResponse = await fetch(`${baseUrl}/api/codex-agent/runtime-config`);
  assert.deepEqual((await configResponse.json()).data, runtimeConfig);
  const updateResponse = await fetch(`${baseUrl}/api/codex-agent/runtime-config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6-terra', reasoningEffort: 'medium' })
  });
  assert.deepEqual((await updateResponse.json()).data, savedRuntimeConfig);
  const startResponse = await fetch(`${baseUrl}/api/projects/alpha/agent-chat/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: null, message: '检查当前状态' })
  });
  assert.equal(startResponse.status, 202);
  assert.equal((await startResponse.json()).data.sessionId, session.sessionId);
  await fetch(`${baseUrl}/api/projects/alpha/agent-chat/sessions/${session.sessionId}`);
  const cancelResponse = await fetch(`${baseUrl}/api/projects/alpha/agent-chat/sessions/${session.sessionId}`, { method: 'DELETE' });
  assert.equal((await cancelResponse.json()).data.status, 'cancelled');
  assert.deepEqual(calls, [
    ['update', { model: 'gpt-5.6-terra', reasoningEffort: 'medium' }],
    ['start', { projectId: 'alpha', sessionId: null, message: '检查当前状态' }],
    ['get', { projectId: 'alpha', sessionId: session.sessionId }],
    ['cancel', { projectId: 'alpha', sessionId: session.sessionId }]
  ]);
});

test('Codex status adapter validates the exact public response contract', async () => {
  const status = {
    connected: true,
    sdkAvailable: true,
    authorization: 'connected',
    message: '已连接 Codex SDK',
    checkedAt: '2026-08-05T00:00:00.000Z'
  };
  const requests = [];
  const adapter = new CodexStatusAdapter({
    fetchImpl: async (url, init) => {
      requests.push([url, init.method]);
      return url.endsWith('/authorize')
        ? { ok: true, json: async () => ({
          ok: true,
          data: { started: true, alreadyConnected: false, loginInProgress: true }
        }) }
        : { ok: true, json: async () => ({ ok: true, data: status }) };
    }
  });
  assert.deepEqual(await adapter.getStatus(), status);
  assert.deepEqual(await adapter.startLogin(), {
    started: true,
    alreadyConnected: false,
    loginInProgress: true
  });
  assert.deepEqual(requests, [
    ['/api/codex-agent/status', 'GET'],
    ['/api/codex-agent/authorize', 'POST']
  ]);

  const invalid = new CodexStatusAdapter({
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, data: { ...status, processId: 42 } }) })
  });
  await assert.rejects(() => invalid.getStatus(), CodexStatusError);
  await assert.rejects(() => invalid.startLogin(), CodexStatusError);
});
