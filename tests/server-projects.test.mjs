import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPrototypeServer } from '../src/server/server.mjs';

const makeRoot = () => mkdtemp(path.join(os.tmpdir(), 'ka-project-server-'));
const writeJson = (root, relativePath, value) => writeFile(
  path.join(root, ...relativePath.split('/')),
  JSON.stringify(value, null, 2),
  'utf8'
);

async function populateSnapshot(root, { episode, assetTotal, secretMarker = '' }) {
  await Promise.all([
    mkdir(path.join(root, 'cache', '累计记录'), { recursive: true }),
    mkdir(path.join(root, 'cache', '单集原文'), { recursive: true }),
    mkdir(path.join(root, 'cache', '单集分析'), { recursive: true }),
    mkdir(path.join(root, 'cache', '批量重绘'), { recursive: true }),
    mkdir(path.join(root, '输出'), { recursive: true })
  ]);
  const characters = Array.from({ length: assetTotal }, (_, index) => ({ assetId: `CHAR-${index + 1}` }));
  await Promise.all([
    writeJson(root, 'cache/阅读进度.json', {
      status: 'in_progress', discoveredEpisodes: [episode], completedEpisodes: [],
      currentEpisode: episode, currentSessionToken: `token-${secretMarker}`
    }),
    writeJson(root, `cache/单集原文/${String(episode).padStart(3, '0')}.json`, {}),
    writeJson(root, 'cache/累计记录/角色记录.json', characters),
    writeJson(root, 'cache/累计记录/生物记录.json', []),
    writeJson(root, 'cache/累计记录/群演记录.json', []),
    writeJson(root, 'cache/累计记录/场景记录.json', []),
    writeJson(root, 'cache/累计记录/道具记录.json', []),
    writeJson(root, 'cache/累计记录/世界观记录.json', { records: [] }),
    writeJson(root, 'cache/出图队列.json', {
      operation: 'generate',
      items: [{
        key: `queue-${episode}`,
        prompt: `super-secret-prompt-${secretMarker}`,
        credential: `credential-${secretMarker}`,
        pid: 987654,
        absolutePath: root
      }]
    }),
    writeJson(root, 'cache/出图进度.json', {
      items: {
        [`queue-${episode}`]: {
          status: 'pending', prompt: `private-progress-prompt-${secretMarker}`, password: `password-${secretMarker}`
        }
      }
    })
  ]);
}

async function startServer(installationRoot, context, options = {}) {
  const server = createPrototypeServer({ installationRoot, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  return { baseUrl: `http://127.0.0.1:${address.port}`, port: address.port };
}

const rawRequest = (port, requestPath, method = 'GET') => new Promise((resolve, reject) => {
  const request = httpRequest({ host: '127.0.0.1', port, path: requestPath, method }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve({ status: response.statusCode, headers: response.headers, text, body: text ? JSON.parse(text) : null });
    });
  });
  request.on('error', reject);
  request.end();
});

test('project APIs isolate two roots, expose summaries, and preserve the legacy snapshot', async (context) => {
  const root = await makeRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const alpha = path.join(root, 'projects', 'alpha');
  const beta = path.join(root, 'projects', 'beta');
  await Promise.all([
    mkdir(alpha, { recursive: true }),
    mkdir(beta, { recursive: true }),
    populateSnapshot(root, { episode: 9, assetTotal: 3, secretMarker: 'legacy' }),
    populateSnapshot(alpha, { episode: 1, assetTotal: 1, secretMarker: 'alpha' }),
    populateSnapshot(beta, { episode: 2, assetTotal: 2, secretMarker: 'beta' })
  ]);
  await Promise.all([
    writeJson(alpha, 'project.json', { displayName: '甲项目', prompt: 'metadata-prompt-alpha', absolutePath: alpha }),
    writeJson(beta, 'project.json', { displayName: '乙项目', password: 'metadata-password-beta', pid: 987654 })
  ]);

  const { baseUrl } = await startServer(root, context);
  const listResponse = await fetch(`${baseUrl}/api/projects`);
  assert.equal(listResponse.status, 200);
  const listEnvelope = await listResponse.json();
  assert.equal(listEnvelope.ok, true);
  assert.equal(listEnvelope.data.schemaVersion, 1);
  assert.deepEqual(listEnvelope.data.projects.map(({ projectId, displayName, storageMode, availability }) => ({
    projectId, displayName, storageMode, availability
  })), [
    { projectId: 'current-package', displayName: '当前安装包项目', storageMode: 'legacy-root', availability: 'available' },
    { projectId: 'alpha', displayName: '甲项目', storageMode: 'isolated-project', availability: 'available' },
    { projectId: 'beta', displayName: '乙项目', storageMode: 'isolated-project', availability: 'available' }
  ]);
  const alphaCard = listEnvelope.data.projects.find(({ projectId }) => projectId === 'alpha');
  const betaCard = listEnvelope.data.projects.find(({ projectId }) => projectId === 'beta');
  assert.equal(alphaCard.statusSummary.assetTotal, 1);
  assert.equal(betaCard.statusSummary.assetTotal, 2);
  assert.equal(alphaCard.statusSummary.currentTaskLabel, '第 1 集分析');
  assert.equal(betaCard.statusSummary.currentTaskLabel, '第 2 集分析');
  assert.deepEqual(Object.keys(alphaCard.statusSummary), [
    'observedAt', 'phase', 'state', 'currentTaskLabel', 'progress', 'assetTotal', 'batch', 'warningCount'
  ]);

  const [alphaResponse, betaResponse, legacyResponse] = await Promise.all([
    fetch(`${baseUrl}/api/projects/alpha/workbench/snapshot`),
    fetch(`${baseUrl}/api/projects/beta/workbench/snapshot`),
    fetch(`${baseUrl}/api/workbench/snapshot`)
  ]);
  assert.deepEqual([alphaResponse.status, betaResponse.status, legacyResponse.status], [200, 200, 200]);
  const [alphaEnvelope, betaEnvelope, legacyEnvelope] = await Promise.all([
    alphaResponse.json(), betaResponse.json(), legacyResponse.json()
  ]);
  assert.deepEqual(alphaEnvelope.data.project, {
    projectId: 'alpha', displayName: '甲项目', storageMode: 'isolated-project'
  });
  assert.equal(alphaEnvelope.data.snapshot.assetCounts.total, 1);
  assert.equal(betaEnvelope.data.snapshot.assetCounts.total, 2);
  assert.equal(legacyEnvelope.data.assetCounts.total, 3);
  assert.equal(alphaEnvelope.data.snapshot.pipeline.currentTask.label, '第 1 集分析');
  assert.equal(betaEnvelope.data.snapshot.pipeline.currentTask.label, '第 2 集分析');
  assert.equal(legacyEnvelope.data.pipeline.currentTask.label, '第 9 集分析');

  const responseText = JSON.stringify({ listEnvelope, alphaEnvelope, betaEnvelope, legacyEnvelope });
  for (const forbidden of [
    root, alpha, beta, 'super-secret-prompt', 'private-progress-prompt', 'credential-',
    'password-', 'metadata-prompt-alpha', 'metadata-password-beta', '987654', 'currentSessionToken'
  ]) assert.equal(responseText.includes(forbidden), false, `response leaked ${forbidden}`);
  assert.equal(responseText.includes('"items"'), false);

  const listWrite = await fetch(`${baseUrl}/api/projects`, { method: 'POST' });
  const snapshotWrite = await fetch(`${baseUrl}/api/projects/alpha/workbench/snapshot`, { method: 'POST' });
  assert.deepEqual([listWrite.status, snapshotWrite.status], [405, 405]);
  assert.equal((await listWrite.json()).error.code, 'METHOD_NOT_ALLOWED');
  assert.equal((await snapshotWrite.json()).error.code, 'METHOD_NOT_ALLOWED');
});

test('path-like task identities are redacted without breaking the snapshot shape', async (context) => {
  const root = await makeRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const alpha = path.join(root, 'projects', 'alpha');
  const embeddedPath = process.platform === 'win32'
    ? '任务：[D:\\outside\\secret.png]'
    : '任务：[/outside/secret.png]';
  await mkdir(alpha, { recursive: true });
  await populateSnapshot(alpha, { episode: 1, assetTotal: 1, secretMarker: 'absolute-task' });
  await Promise.all([
    writeJson(alpha, 'cache/出图队列.json', {
      operation: 'redraw',
      items: [{ key: embeddedPath, sourceRelativePath: embeddedPath }]
    }),
    writeJson(alpha, 'cache/出图进度.json', {
      items: { [embeddedPath]: { status: 'generating', backend: 'credential-secret-backend' } }
    })
  ]);
  const { baseUrl } = await startServer(root, context);
  const projectEnvelope = await (await fetch(`${baseUrl}/api/projects/alpha/workbench/snapshot`)).json();
  assert.equal(projectEnvelope.data.snapshot.batch.activeTask.taskId, '[redacted]');
  assert.equal(projectEnvelope.data.snapshot.batch.activeTask.label, '[redacted]');
  assert.equal(projectEnvelope.data.snapshot.batch.activeTask.backend, '[redacted]');
  assert.equal(projectEnvelope.data.snapshot.batch.backend, '[redacted]');
  assert.deepEqual(projectEnvelope.data.snapshot.batch.backendCounts, {});
  assert.equal(projectEnvelope.data.snapshot.pipeline.currentTask.taskId, '[redacted]');
  assert.equal(JSON.stringify(projectEnvelope).includes(root), false);
  assert.equal(JSON.stringify(projectEnvelope).includes('outside'), false);
  assert.equal(JSON.stringify(projectEnvelope).includes('credential-secret-backend'), false);
  const listEnvelope = await (await fetch(`${baseUrl}/api/projects`)).json();
  const alphaCard = listEnvelope.data.projects.find(({ projectId }) => projectId === 'alpha');
  assert.equal(alphaCard.statusSummary.currentTaskLabel, '[redacted]');
  assert.equal(alphaCard.statusSummary.batch.backend, null);
});

test('raw traversal, absolute paths, dot segments, and non-ASCII ids never select a project', async (context) => {
  const root = await makeRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const alpha = path.join(root, 'projects', 'alpha');
  await mkdir(alpha, { recursive: true });
  await Promise.all([
    populateSnapshot(root, { episode: 9, assetTotal: 9, secretMarker: 'legacy' }),
    populateSnapshot(alpha, { episode: 1, assetTotal: 1, secretMarker: 'alpha' })
  ]);
  const { port } = await startServer(root, context);

  const attempts = [
    '/api/projects/../workbench/snapshot',
    '/api/projects/%2e%2e/workbench/snapshot',
    '/api/projects/alpha%2F..%2Fbeta/workbench/snapshot',
    '/api/projects/C:%5Csecret/workbench/snapshot',
    '/api/projects/%2Ftmp/workbench/snapshot',
    '/api/projects/%E9%A1%B9%E7%9B%AE/workbench/snapshot',
    '/api/projects/%252e%252e/workbench/snapshot'
  ];
  for (const attempt of attempts) {
    const response = await rawRequest(port, attempt);
    assert.notEqual(response.status, 200, attempt);
    assert.equal(response.body.ok, false, attempt);
    assert.equal(response.text.includes(root), false, attempt);
  }
});

test('an installation without projects maps current-package to the unchanged legacy root snapshot', async (context) => {
  const root = await makeRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  await populateSnapshot(root, { episode: 4, assetTotal: 4, secretMarker: 'legacy-only' });
  await writeJson(root, 'project.json', { displayName: '兼容项目', credential: 'must-not-leak' });
  const { baseUrl } = await startServer(root, context);

  const listEnvelope = await (await fetch(`${baseUrl}/api/projects`)).json();
  assert.equal(listEnvelope.data.projects.length, 1);
  assert.deepEqual({
    projectId: listEnvelope.data.projects[0].projectId,
    displayName: listEnvelope.data.projects[0].displayName,
    storageMode: listEnvelope.data.projects[0].storageMode,
    availability: listEnvelope.data.projects[0].availability
  }, {
    projectId: 'current-package', displayName: '兼容项目', storageMode: 'legacy-root', availability: 'available'
  });
  const projectEnvelope = await (await fetch(`${baseUrl}/api/projects/current-package/workbench/snapshot`)).json();
  const legacyEnvelope = await (await fetch(`${baseUrl}/api/workbench/snapshot`)).json();
  assert.deepEqual(projectEnvelope.data.project, {
    projectId: 'current-package', displayName: '兼容项目', storageMode: 'legacy-root'
  });
  assert.deepEqual(
    { ...projectEnvelope.data.snapshot, observedAt: '<dynamic>' },
    { ...legacyEnvelope.data, observedAt: '<dynamic>' }
  );
});

test('a junction project is visible only as unavailable and its target is never read', async (context) => {
  const root = await makeRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const projects = path.join(root, 'projects');
  const external = path.join(root, 'external');
  await Promise.all([mkdir(projects, { recursive: true }), mkdir(external, { recursive: true })]);
  await populateSnapshot(external, { episode: 8, assetTotal: 8, secretMarker: 'external' });
  try {
    await symlink(external, path.join(projects, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      context.skip('当前环境不允许创建目录链接');
      return;
    }
    throw error;
  }
  const { baseUrl } = await startServer(root, context);
  const listEnvelope = await (await fetch(`${baseUrl}/api/projects`)).json();
  const linked = listEnvelope.data.projects.find(({ projectId }) => projectId === 'linked');
  assert.equal(linked.availability, 'unavailable');
  assert.deepEqual(linked.statusSummary, {
    observedAt: null,
    phase: null,
    state: null,
    currentTaskLabel: null,
    progress: { mode: 'none', done: null, total: null },
    assetTotal: null,
    batch: { mode: null, backend: null, completed: null, total: null, failed: null },
    warningCount: null
  });
  const response = await fetch(`${baseUrl}/api/projects/linked/workbench/snapshot`);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'PROJECT_ROOT_UNSAFE');
});

test('project count overflow returns a bounded safe error envelope', async (context) => {
  const root = await makeRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const projects = path.join(root, 'projects');
  await mkdir(projects, { recursive: true });
  await Promise.all(Array.from({ length: 256 }, (_, index) => (
    mkdir(path.join(projects, `project-${String(index).padStart(3, '0')}`))
  )));
  const { baseUrl } = await startServer(root, context);
  const response = await fetch(`${baseUrl}/api/projects`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: { code: 'PROJECT_LIMIT_EXCEEDED', message: '项目数量不得超过 256' }
  });
});

test('static serving rejects linked paths and advertises fixed methods', async (context) => {
  const root = await makeRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const publicRoot = path.join(root, 'public');
  const external = path.join(root, 'external-static');
  await Promise.all([mkdir(publicRoot, { recursive: true }), mkdir(external, { recursive: true })]);
  await Promise.all([
    writeFile(path.join(publicRoot, 'index.html'), '<!doctype html><title>safe</title>', 'utf8'),
    writeFile(path.join(external, 'secret.txt'), 'STATIC_LINK_SECRET', 'utf8')
  ]);
  try {
    await symlink(external, path.join(publicRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      context.skip('当前环境不允许创建目录链接');
      return;
    }
    throw error;
  }

  const { port } = await startServer(root, context, { staticDirectory: publicRoot });
  const linked = await rawRequest(port, '/linked/secret.txt');
  assert.equal(linked.status, 403);
  assert.equal(linked.text.includes('STATIC_LINK_SECRET'), false);

  const postStatic = await rawRequest(port, '/index.html', 'POST');
  assert.equal(postStatic.status, 405);
  assert.equal(postStatic.headers.allow, 'GET, HEAD');
  const deleteResolve = await rawRequest(port, '/api/prompt/resolve', 'DELETE');
  assert.equal(deleteResolve.status, 405);
  assert.equal(deleteResolve.headers.allow, 'POST');
  const head = await rawRequest(port, '/', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.equal(Number(head.headers['content-length']), Buffer.byteLength('<!doctype html><title>safe</title>'));
});
