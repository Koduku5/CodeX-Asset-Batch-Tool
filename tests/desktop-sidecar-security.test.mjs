import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createPrototypeServer } from '../src/server/server.mjs';

const TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const NATIVE_TOKEN = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_ROOT = path.join(TEST_ROOT, 'skills');
const ENGINE_ROOT = path.join(TEST_ROOT, 'engine');
const SHEETS = ['角色', '生物', '群演', '场景', '道具'];

const request = (port, requestPath, { method = 'GET', headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
  const outgoing = httpRequest({
    host: '127.0.0.1',
    port,
    path: requestPath,
    method,
    headers
  }, (incoming) => {
    const chunks = [];
    incoming.on('data', (chunk) => chunks.push(chunk));
    incoming.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body = null;
      if (text && String(incoming.headers['content-type'] || '').includes('application/json')) body = JSON.parse(text);
      resolve({ status: incoming.statusCode, body, text });
    });
  });
  outgoing.on('error', reject);
  outgoing.end(body);
});

const hex = (character) => character.repeat(64);
const writeJson = (filename, value) => writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

const makeReadyImagegenState = () => {
  const preset = {
    version: 6,
    catalogFingerprint: hex('a'),
    routeFingerprintsBySheet: { '场景': hex('b') },
    confirmedAt: '2026-08-04T01:02:03.000Z',
    styleId: 'cg',
    generationLimit: 5,
    enabledSheets: ['场景'],
    referencesBySheet: Object.fromEntries(SHEETS.map((sheet) => [sheet, []])),
    referenceModeBySheet: Object.fromEntries(SHEETS.map((sheet) => [sheet, 'style'])),
    promptOverridesBySheet: Object.fromEntries(SHEETS.map((sheet) => [sheet, {
      routeMode: 'default',
      promptText: sheet === '场景' ? 'PRIVATE PROMPT OPENAI_API_KEY=must-not-leak' : ''
    }]))
  };
  const queue = {
    version: 4,
    builtAt: '2026-08-04T01:03:00.000Z',
    routingConfig: 'assets/图片生成/出图路由.json',
    routingFingerprint: hex('d'),
    routingResourceFingerprints: {},
    eligibilityFingerprint: hex('e'),
    items: [{
      key: '场景:SCENE-0001',
      sheetName: '场景',
      rowNumber: 2,
      assetId: 'SCENE-0001',
      assetName: 'PRIVATE ASSET NAME',
      productionNotes: 'PRIVATE PRODUCTION NOTES must-not-leak',
      prompt: 'PRIVATE API PROMPT must-not-leak',
      outputPath: '输出/资产图/场景/SCENE-0001_PRIVATE.png',
      assetFingerprint: hex('f'),
      inputFingerprint: hex('1')
    }],
    builtinPromptBatch: structuredClone(preset)
  };
  const progress = {
    version: 3,
    routingFingerprint: hex('d'),
    items: {
      '场景:SCENE-0001': {
        attemptLedger: {
          builtin: {
            inputFingerprint: hex('2'),
            attempts: 0,
            lastError: '',
            updatedAt: ''
          }
        }
      }
    }
  };
  return { preset, queue, progress };
};

const assertNoHandoffDisclosure = (response, forbiddenRoots = []) => {
  const serialized = response.text || JSON.stringify(response.body);
  assert.equal(serialized.includes('handoffText'), false);
  assert.equal(serialized.includes('PRIVATE PROMPT'), false);
  assert.equal(serialized.includes('PRIVATE ASSET NAME'), false);
  assert.equal(serialized.includes('PRIVATE PRODUCTION NOTES'), false);
  assert.equal(serialized.includes('must-not-leak'), false);
  assert.equal(serialized.includes('OPENAI_API_KEY'), false);
  for (const root of forbiddenRoots) assert.equal(serialized.includes(root), false);
  const inspect = (value) => {
    if (typeof value === 'string') {
      assert.equal(path.isAbsolute(value), false);
      assert.equal(path.win32.isAbsolute(value), false);
      assert.equal(/^file:\/\//iu.test(value), false);
      return;
    }
    if (Array.isArray(value)) {
      for (const member of value) inspect(member);
      return;
    }
    if (value && typeof value === 'object') {
      for (const member of Object.values(value)) inspect(member);
    }
  };
  inspect(response.body);
};

const startDesktopServer = async (context, options = {}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ka-desktop-sidecar-'));
  const staticRoot = path.join(root, 'static');
  await mkdir(staticRoot);
  await writeFile(path.join(staticRoot, 'index.html'), '<!doctype html><title>desktop</title>', 'utf8');
  const server = createPrototypeServer({
    installationRoot: root,
    staticDirectory: staticRoot,
    desktopMode: true,
    capabilityToken: TOKEN,
    ...options
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  context.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { root, server, port, origin: `http://127.0.0.1:${port}` };
};

const startReadyImagegenDesktopServer = async (context, options = {}) => {
  const softwareRoot = await mkdtemp(path.join(os.tmpdir(), 'ka-desktop-imagegen-'));
  const staticRoot = path.join(softwareRoot, 'static');
  await mkdir(staticRoot, { recursive: true });
  await writeFile(path.join(staticRoot, 'index.html'), '<!doctype html><title>desktop imagegen</title>', 'utf8');
  const server = createPrototypeServer({
    softwareMode: true,
    softwareRoot,
    engineRoot: ENGINE_ROOT,
    skillsRoot: SKILLS_ROOT,
    staticDirectory: staticRoot,
    desktopMode: true,
    capabilityToken: TOKEN,
    nativeCapabilityToken: NATIVE_TOKEN,
    ...options
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  context.after(async () => {
    server.closeIdleConnections?.();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(softwareRoot, { recursive: true, force: true });
  });

  const createBody = JSON.stringify({ displayName: '内置出图安全测试' });
  const created = await request(port, '/api/projects', {
    method: 'POST',
    headers: {
      origin,
      'x-ka-desktop-token': TOKEN,
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(createBody))
    },
    body: createBody
  });
  assert.equal(created.status, 201, created.text);
  const projectId = created.body.data.projectId;
  const projectRoot = path.join(softwareRoot, 'workspace', 'projects', projectId);
  const cacheRoot = path.join(projectRoot, 'cache');
  const state = makeReadyImagegenState();
  await Promise.all([
    writeJson(path.join(cacheRoot, '内置提示词预设.json'), state.preset),
    writeJson(path.join(cacheRoot, '出图队列.json'), state.queue),
    writeJson(path.join(cacheRoot, '出图进度.json'), state.progress)
  ]);
  return { softwareRoot, projectRoot, projectId, port, origin };
};

test('desktop opens the formal Infinite Canvas API runner for one materialized project without exposing paths', async (context) => {
  const launches = [];
  const fixture = await startReadyImagegenDesktopServer(context, {
    desktopOpenApiSettings: async (request) => { launches.push(request); }
  });
  const endpoint = `/desktop/projects/${fixture.projectId}/open-api-settings`;
  const webHeaders = { origin: fixture.origin, 'x-ka-desktop-token': TOKEN };
  const apiConfiguration = JSON.stringify({
    baseUrl: 'https://canvas.dopamine.video',
    username: 'batch-user',
    password: 'not-persisted-secret',
    maxWorkers: 2,
    aspectRatio: '1:1',
    imageSize: '1K'
  });

  const rejected = await request(fixture.port, endpoint, {
    method: 'POST',
    headers: webHeaders
  });
  assert.equal(rejected.status, 401);
  assert.equal(rejected.body.error.code, 'NATIVE_BRIDGE_TOKEN_REQUIRED');

  const accepted = await request(fixture.port, endpoint, {
    method: 'POST',
    headers: {
      ...webHeaders,
      'x-ka-native-token': NATIVE_TOKEN,
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(apiConfiguration))
    },
    body: apiConfiguration
  });
  assert.equal(accepted.status, 200, accepted.text);
  assert.deepEqual(accepted.body.data, { projectId: fixture.projectId, opened: true });
  assert.equal(accepted.text.includes(fixture.projectRoot), false);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].configuration.baseUrl, 'https://canvas.dopamine.video');
  assert.equal(launches[0].configuration.password, 'not-persisted-secret');
  assert.equal(accepted.text.includes('not-persisted-secret'), false);
  assert.equal(launches[0].projectRoot, await realpath(fixture.projectRoot));
  assert.equal(
    launches[0].scriptPath,
    await realpath(path.join(fixture.projectRoot, 'scripts', 'commands', 'start_api_batch.ps1'))
  );
});

test('desktop mode requires a strong capability token', () => {
  assert.throws(
    () => createPrototypeServer({ desktopMode: true, capabilityToken: 'short' }),
    /32/u
  );
});

test('desktop mode protects privileged routes and rejects rebinding/cross-origin requests', async (context) => {
  const { port, origin } = await startDesktopServer(context);

  const navigation = await request(port, '/');
  assert.equal(navigation.status, 200);

  const missingToken = await request(port, '/api/projects', { headers: { origin } });
  assert.equal(missingToken.status, 401);
  assert.equal(missingToken.body.error.code, 'DESKTOP_TOKEN_REQUIRED');

  const badToken = await request(port, '/health', {
    headers: { origin, 'x-ka-desktop-token': `${TOKEN}x` }
  });
  assert.equal(badToken.status, 401);

  const missingOrigin = await request(port, '/health', {
    headers: { 'x-ka-desktop-token': TOKEN }
  });
  assert.equal(missingOrigin.status, 403);
  assert.equal(missingOrigin.body.error.code, 'DESKTOP_ORIGIN_REQUIRED');

  const wrongOrigin = await request(port, '/health', {
    headers: { origin: 'http://evil.invalid', 'x-ka-desktop-token': TOKEN }
  });
  assert.equal(wrongOrigin.status, 403);
  assert.equal(wrongOrigin.body.error.code, 'INVALID_DESKTOP_ORIGIN');

  const wrongHost = await request(port, '/health', {
    headers: { host: 'evil.invalid', origin, 'x-ka-desktop-token': TOKEN }
  });
  assert.equal(wrongHost.status, 403);
  assert.equal(wrongHost.body.error.code, 'INVALID_DESKTOP_HOST');

  const health = await request(port, '/health', {
    headers: { origin, 'x-ka-desktop-token': TOKEN }
  });
  assert.equal(health.status, 200);
  assert.deepEqual(health.body.data, { status: 'ready', protocolVersion: 1 });
});

test('desktop project opener resolves a project id and fixed directory kind server-side without returning paths', async (context) => {
  const openedRoots = [];
  const setupRoot = await mkdtemp(path.join(os.tmpdir(), 'ka-desktop-project-'));
  await mkdir(path.join(setupRoot, 'projects', 'alpha', '\u8f93\u51fa'), { recursive: true });
  await writeFile(
    path.join(setupRoot, 'projects', 'alpha', 'project.json'),
    `${JSON.stringify({ displayName: 'Alpha' })}\n`,
    'utf8'
  );
  const staticRoot = path.join(setupRoot, 'static');
  await mkdir(staticRoot);
  await writeFile(path.join(staticRoot, 'index.html'), '<!doctype html>', 'utf8');
  const server = createPrototypeServer({
    installationRoot: setupRoot,
    staticDirectory: staticRoot,
    desktopMode: true,
    capabilityToken: TOKEN,
    desktopOpenDirectory: async (value) => { openedRoots.push(value); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(setupRoot, { recursive: true, force: true });
  });
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  const response = await request(port, '/desktop/projects/alpha/open-directory/project', {
    method: 'POST',
    headers: { origin, 'x-ka-desktop-token': TOKEN }
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.projectId, 'alpha');
  assert.equal(response.body.data.kind, 'project');
  assert.equal(response.body.data.opened, true);
  assert.equal(response.text.includes(setupRoot), false);
  assert.equal(openedRoots[0], await realpath(path.join(setupRoot, 'projects', 'alpha')));

  const outputResponse = await request(port, '/desktop/projects/alpha/open-directory/output', {
    method: 'POST',
    headers: { origin, 'x-ka-desktop-token': TOKEN }
  });
  assert.equal(outputResponse.status, 200);
  assert.equal(outputResponse.body.data.kind, 'output');
  assert.equal(outputResponse.text.includes(setupRoot), false);
  assert.equal(openedRoots[1], await realpath(path.join(setupRoot, 'projects', 'alpha', '\u8f93\u51fa')));
});

test('desktop ImageGen handoff exposes only a safe summary and requires both web and native capabilities for handoff text', async (context) => {
  const fixture = await startReadyImagegenDesktopServer(context);
  const webHeaders = { origin: fixture.origin, 'x-ka-desktop-token': TOKEN };
  const endpoint = `/desktop/projects/${fixture.projectId}/prepare-imagegen-handoff`;
  const forbiddenRoots = [fixture.softwareRoot, fixture.projectRoot, SKILLS_ROOT, ENGINE_ROOT];

  const status = await request(
    fixture.port,
    `/api/projects/${fixture.projectId}/imagegen-handoff`,
    { headers: webHeaders }
  );
  assert.equal(status.status, 200, status.text);
  assert.equal(status.body.ok, true);
  assert.equal(status.body.data.projectId, fixture.projectId);
  assert.equal(status.body.data.status, 'ready');
  assert.equal(status.body.data.reasonCode, 'READY');
  assert.equal(status.body.data.queueEstablished, true);
  assert.equal(status.body.data.presetConfigured, true);
  assert.equal(status.body.data.counts.total, 1);
  assert.equal(status.body.data.counts.pending, 1);
  assertNoHandoffDisclosure(status, forbiddenRoots);

  const rejectedRequests = [
    {
      label: 'missing web token',
      expectedStatus: 401,
      expectedCode: 'DESKTOP_TOKEN_REQUIRED',
      headers: { origin: fixture.origin, 'x-ka-native-token': NATIVE_TOKEN }
    },
    {
      label: 'missing origin',
      expectedStatus: 403,
      expectedCode: 'DESKTOP_ORIGIN_REQUIRED',
      headers: { 'x-ka-desktop-token': TOKEN, 'x-ka-native-token': NATIVE_TOKEN }
    },
    {
      label: 'wrong origin',
      expectedStatus: 403,
      expectedCode: 'INVALID_DESKTOP_ORIGIN',
      headers: {
        origin: 'http://evil.invalid',
        'x-ka-desktop-token': TOKEN,
        'x-ka-native-token': NATIVE_TOKEN
      }
    },
    {
      label: 'missing native token',
      expectedStatus: 401,
      expectedCode: 'NATIVE_BRIDGE_TOKEN_REQUIRED',
      headers: webHeaders
    },
    {
      label: 'wrong native token',
      expectedStatus: 401,
      expectedCode: 'NATIVE_BRIDGE_TOKEN_REQUIRED',
      headers: { ...webHeaders, 'x-ka-native-token': `${NATIVE_TOKEN}x` }
    }
  ];
  for (const rejected of rejectedRequests) {
    const response = await request(fixture.port, endpoint, {
      method: 'POST',
      headers: rejected.headers
    });
    assert.equal(response.status, rejected.expectedStatus, rejected.label);
    assert.equal(response.body.ok, false, rejected.label);
    assert.equal(response.body.error.code, rejected.expectedCode, rejected.label);
    assertNoHandoffDisclosure(response, forbiddenRoots);
  }

  const accepted = await request(fixture.port, endpoint, {
    method: 'POST',
    headers: { ...webHeaders, 'x-ka-native-token': NATIVE_TOKEN }
  });
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.body.ok, true);
  assert.equal(accepted.body.data.projectId, fixture.projectId);
  assert.equal(typeof accepted.body.data.handoffText, 'string');
  assert.equal(accepted.body.data.handoffText.includes(JSON.stringify(await realpath(fixture.projectRoot))), true);
  assert.equal(
    accepted.body.data.handoffText.includes(JSON.stringify(path.join(
      SKILLS_ROOT,
      'ka-builtin-imagegen',
      'SKILL.md'
    ))),
    true
  );
  for (const secret of [
    'PRIVATE PROMPT',
    'PRIVATE ASSET NAME',
    'PRIVATE PRODUCTION NOTES',
    'must-not-leak',
    'OPENAI_API_KEY'
  ]) assert.equal(accepted.body.data.handoffText.includes(secret), false);
});

test('desktop shutdown is token-protected and closes the listener after one accepted request', async (context) => {
  let callbackCount = 0;
  const { server, port, origin } = await startDesktopServer(context, {
    onShutdown: () => { callbackCount += 1; }
  });

  const rejected = await request(port, '/shutdown', { method: 'POST', headers: { origin } });
  assert.equal(rejected.status, 401);
  assert.equal(server.listening, true);

  const closed = once(server, 'close');
  const accepted = await request(port, '/shutdown', {
    method: 'POST',
    headers: { origin, 'x-ka-desktop-token': TOKEN }
  });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.data.shuttingDown, true);
  await closed;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callbackCount, 1);
});

test('desktop entry binds a random loopback port, emits one bounded ready record, and shuts down cleanly', async (context) => {
  const softwareRoot = await mkdtemp(path.join(os.tmpdir(), 'ka-desktop-entry-'));
  const entry = fileURLToPath(new URL('../src/server/desktop-entry.mjs', import.meta.url));
  const child = spawn(process.execPath, [entry], {
    cwd: path.dirname(entry),
    env: {
      ...process.env,
      KA_DESKTOP_SOFTWARE_ROOT: softwareRoot,
      KA_DESKTOP_ENGINE_ROOT: ENGINE_ROOT,
      KA_DESKTOP_SKILLS_ROOT: SKILLS_ROOT,
      KA_DESKTOP_TOKEN: TOKEN,
      KA_DESKTOP_NATIVE_TOKEN: NATIVE_TOKEN
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  context.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await rm(softwareRoot, { recursive: true, force: true });
  });
  const readyLine = await Promise.race([
    new Promise((resolve, reject) => {
      let buffered = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffered += chunk;
        const newline = buffered.indexOf('\n');
        if (newline >= 0) resolve(buffered.slice(0, newline));
      });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`desktop entry exited before ready: ${code}`)));
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('desktop entry ready timeout')), 10_000).unref())
  ]);
  assert.equal(typeof readyLine, 'string');
  assert.ok(Buffer.byteLength(readyLine, 'utf8') <= 512);
  assert.equal(readyLine.includes(TOKEN), false);
  assert.equal(readyLine.includes(NATIVE_TOKEN), false);
  const ready = JSON.parse(readyLine);
  assert.equal(ready.type, 'ka-prompt-studio-ready');
  assert.equal(ready.protocolVersion, 1);
  assert.equal(ready.pid, child.pid);
  assert.match(ready.origin, /^http:\/\/127\.0\.0\.1:\d+$/u);

  const headers = { origin: ready.origin, 'x-ka-desktop-token': TOKEN };
  const health = await fetch(`${ready.origin}/health`, { headers });
  assert.equal(health.status, 200);
  const shutdown = await fetch(`${ready.origin}/shutdown`, { method: 'POST', headers });
  assert.equal(shutdown.status, 202);
  const [exitCode] = await Promise.race([
    once(child, 'exit'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('desktop entry shutdown timeout')), 5_000).unref())
  ]);
  assert.equal(exitCode, 0);
});
