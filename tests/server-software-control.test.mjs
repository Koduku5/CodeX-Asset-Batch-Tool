import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createPrototypeServer } from '../src/server/server.mjs';

const softwareDirectory = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.resolve(softwareDirectory, '..', 'engine');
const makeRoot = () => mkdtemp(path.join(os.tmpdir(), 'ka-software-server-'));

const snapshotSourceTree = async (root) => {
  const records = [];
  const visit = async (directory, prefix = '') => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target, relativePath);
      else if (entry.isFile()) {
        const [info, bytes] = await Promise.all([stat(target), readFile(target)]);
        records.push({
          relativePath,
          size: info.size,
          mtimeMs: info.mtimeMs,
          hash: createHash('sha256').update(bytes).digest('hex')
        });
      } else records.push({ relativePath, unsafeType: true });
    }
  };
  await visit(root);
  return records;
};

const startSoftwareServer = async (softwareRoot, context) => {
  const server = createPrototypeServer({ softwareMode: true, softwareRoot, engineRoot });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${server.address().port}`;
};

const jsonRequest = async (url, init = {}) => {
  const response = await fetch(url, {
    ...init,
    headers: { accept: 'application/json', ...(init.headers || {}) }
  });
  const body = await response.json();
  return { response, body };
};

const createProject = async (baseUrl, displayName) => {
  const result = await jsonRequest(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName })
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.body.ok, true);
  return result.body.data;
};

const uploadText = async (baseUrl, projectId, filename, text) => {
  const bytes = Buffer.from(text, 'utf8');
  const result = await jsonRequest(`${baseUrl}/api/projects/${projectId}/screenplay`, {
    method: 'PUT',
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': String(bytes.length),
      'x-ka-filename': encodeURIComponent(filename)
    },
    body: bytes
  });
  assert.equal(result.response.status, 201);
  assert.deepEqual(result.body.data, { projectId, filename, size: bytes.length });
};

const runSplit = async (baseUrl, projectId) => {
  const started = await jsonRequest(`${baseUrl}/api/projects/${projectId}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'split' })
  });
  assert.equal(started.response.status, 202);
  assert.equal(started.body.data.projectId, projectId);
  assert.equal(started.body.data.action, 'split');
  const taskId = started.body.data.taskId;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const current = await jsonRequest(`${baseUrl}/api/projects/${projectId}/tasks/${taskId}`);
    if (current.body.data.status === 'succeeded' || current.body.data.status === 'failed') return current.body.data;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail('split task did not finish in 30 seconds');
};

test('stage timing API persists readable elapsed seconds inside the selected project Cache', async (context) => {
  const softwareRoot = await makeRoot();
  context.after(() => rm(softwareRoot, { recursive: true, force: true }));
  const baseUrl = await startSoftwareServer(softwareRoot, context);
  const project = await createProject(baseUrl, '计时项目');

  const initial = await jsonRequest(`${baseUrl}/api/projects/${project.projectId}/stage-timings`);
  assert.deepEqual(initial.body.data, { version: 1, projectId: project.projectId, stages: {} });
  const saved = await jsonRequest(`${baseUrl}/api/projects/${project.projectId}/stage-timings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stages: { analysis: 5673, 'world-overview': 473 } })
  });
  assert.equal(saved.response.status, 200);
  assert.deepEqual(saved.body.data.stages, { analysis: 5673, 'world-overview': 473 });
  const projectFile = path.join(
    softwareRoot, 'workspace', 'projects', project.projectId, 'cache', '阶段用时.json'
  );
  assert.deepEqual(JSON.parse(await readFile(projectFile, 'utf8')).stages, {
    analysis: 5673,
    'world-overview': 473
  });
  const restored = await jsonRequest(`${baseUrl}/api/projects/${project.projectId}/stage-timings`);
  assert.deepEqual(restored.body.data.stages, { analysis: 5673, 'world-overview': 473 });
});

test('software mode creates isolated projects, imports scripts, runs real split, and leaves package sources unchanged', async (context) => {
  const softwareRoot = await makeRoot();
  context.after(() => rm(softwareRoot, { recursive: true, force: true }));
  const sourceRoots = [path.join(engineRoot, 'assets'), path.join(engineRoot, 'scripts')];
  const before = await Promise.all(sourceRoots.map(snapshotSourceTree));
  const baseUrl = await startSoftwareServer(softwareRoot, context);

  const initial = await jsonRequest(`${baseUrl}/api/projects`);
  assert.deepEqual(initial.body.data.projects, []);

  const [alpha, beta] = await Promise.all([
    createProject(baseUrl, '甲项目'),
    createProject(baseUrl, '乙项目')
  ]);
  assert.notEqual(alpha.projectId, beta.projectId);
  assert.equal(alpha.storageMode, 'isolated-project');
  await Promise.all([
    uploadText(baseUrl, alpha.projectId, '甲剧本.txt', '第一集 起点\n甲项目内容\n第二集 继续\n甲项目第二集\n'),
    uploadText(baseUrl, beta.projectId, '乙剧本.txt', '第一集 起点\n乙项目独有内容\n')
  ]);
  const alphaTiming = await jsonRequest(`${baseUrl}/api/projects/${alpha.projectId}/stage-timings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stages: { split: 1 } })
  });
  assert.equal(alphaTiming.response.status, 200);
  const alphaCacheRoot = path.join(softwareRoot, 'workspace', 'projects', alpha.projectId, 'cache');
  await Promise.all([
    writeFile(path.join(alphaCacheRoot, '阶段用时.json.tmp-regression'), '{"temporary":true}\n', 'utf8'),
    writeFile(path.join(alphaCacheRoot, '阶段用时.json.backup-regression'), '{"backup":true}\n', 'utf8')
  ]);

  const [alphaTask, betaTask] = await Promise.all([
    runSplit(baseUrl, alpha.projectId),
    runSplit(baseUrl, beta.projectId)
  ]);
  assert.equal(alphaTask.status, 'succeeded', alphaTask.log.text);
  assert.equal(betaTask.status, 'succeeded', betaTask.log.text);
  assert.equal(JSON.stringify(alphaTask).includes(engineRoot), false);
  assert.equal(JSON.stringify(betaTask).includes(engineRoot), false);

  const projectsRoot = path.join(softwareRoot, 'workspace', 'projects');
  const alphaRoot = path.join(projectsRoot, alpha.projectId);
  const betaRoot = path.join(projectsRoot, beta.projectId);
  const [alphaProgress, betaProgress, alphaEpisode, betaEpisode] = await Promise.all([
    readFile(path.join(alphaRoot, 'cache', '阅读进度.json'), 'utf8').then(JSON.parse),
    readFile(path.join(betaRoot, 'cache', '阅读进度.json'), 'utf8').then(JSON.parse),
    readFile(path.join(alphaRoot, 'cache', '单集原文', '第001集.json'), 'utf8'),
    readFile(path.join(betaRoot, 'cache', '单集原文', '第001集.json'), 'utf8')
  ]);
  assert.deepEqual(alphaProgress.discoveredEpisodes, [1, 2]);
  assert.deepEqual(betaProgress.discoveredEpisodes, [1]);
  assert.match(alphaEpisode, /甲项目内容/u);
  assert.doesNotMatch(alphaEpisode, /乙项目独有内容/u);
  assert.match(betaEpisode, /乙项目独有内容/u);
  assert.doesNotMatch(betaEpisode, /甲项目内容/u);
  for (const projectRoot of [alphaRoot, betaRoot]) {
    await Promise.all([
      stat(path.join(projectRoot, '剧本')).then((info) => assert.equal(info.isDirectory(), true)),
      stat(path.join(projectRoot, 'cache')).then((info) => assert.equal(info.isDirectory(), true)),
      stat(path.join(projectRoot, '输出')).then((info) => assert.equal(info.isDirectory(), true)),
      stat(path.join(projectRoot, 'scripts')).then((info) => assert.equal(info.isDirectory(), true)),
      stat(path.join(projectRoot, 'assets')).then((info) => assert.equal(info.isDirectory(), true))
    ]);
  }

  const listed = await jsonRequest(`${baseUrl}/api/projects`);
  assert.equal(listed.body.data.projects.length, 2);
  assert.equal(listed.body.data.projects.some(({ projectId }) => projectId === 'current-package'), false);
  const after = await Promise.all(sourceRoots.map(snapshotSourceTree));
  assert.deepEqual(after, before);
});

test('fixed project PATCH and DELETE routes rename and remove only the bound isolated project', async (context) => {
  const softwareRoot = await makeRoot();
  context.after(() => rm(softwareRoot, { recursive: true, force: true }));
  const baseUrl = await startSoftwareServer(softwareRoot, context);
  const alpha = await createProject(baseUrl, '待修改项目');
  const beta = await createProject(baseUrl, '保留项目');
  const projectsRoot = path.join(softwareRoot, 'workspace', 'projects');
  const alphaRoot = path.join(projectsRoot, alpha.projectId);
  const betaRoot = path.join(projectsRoot, beta.projectId);
  const sharedMarker = path.join(softwareRoot, 'workspace', 'shared-assets', 'keep-shared.txt');
  await writeFile(path.join(betaRoot, '输出', 'keep.txt'), 'keep project\n');
  await writeFile(sharedMarker, 'keep shared\n');
  const metadataBefore = JSON.parse(await readFile(path.join(alphaRoot, 'project.json'), 'utf8'));

  const wrongMethod = await jsonRequest(`${baseUrl}/api/projects/${alpha.projectId}`, { method: 'POST' });
  assert.equal(wrongMethod.response.status, 405);
  assert.equal(wrongMethod.response.headers.get('allow'), 'PATCH, DELETE');
  const extraField = await jsonRequest(`${baseUrl}/api/projects/${alpha.projectId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: '不应采用', projectId: beta.projectId })
  });
  assert.equal(extraField.response.status, 400);
  assert.equal(extraField.body.error.code, 'INVALID_REQUEST');

  const renamed = await jsonRequest(`${baseUrl}/api/projects/${alpha.projectId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: '已重命名项目' })
  });
  assert.equal(renamed.response.status, 200);
  assert.deepEqual(renamed.body, {
    ok: true,
    data: {
      projectId: alpha.projectId,
      displayName: '已重命名项目',
      storageMode: 'isolated-project',
      availability: 'available'
    }
  });
  assert.deepEqual(JSON.parse(await readFile(path.join(alphaRoot, 'project.json'), 'utf8')), {
    ...metadataBefore,
    displayName: '已重命名项目'
  });

  const bodyRejected = await jsonRequest(`${baseUrl}/api/projects/${alpha.projectId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(bodyRejected.response.status, 400);
  assert.equal((await lstat(alphaRoot)).isDirectory(), true);

  const deleted = await jsonRequest(`${baseUrl}/api/projects/${alpha.projectId}`, { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
  assert.deepEqual(deleted.body, { ok: true, data: { projectId: alpha.projectId, deleted: true } });
  assert.equal(await lstat(alphaRoot).catch(() => null), null);
  const missing = await jsonRequest(`${baseUrl}/api/projects/${alpha.projectId}`, { method: 'DELETE' });
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.error.code, 'PROJECT_NOT_FOUND');
  assert.equal(await readFile(path.join(betaRoot, '输出', 'keep.txt'), 'utf8'), 'keep project\n');
  assert.equal(await readFile(sharedMarker, 'utf8'), 'keep shared\n');
  const listed = await jsonRequest(`${baseUrl}/api/projects`);
  assert.deepEqual(listed.body.data.projects.map(({ projectId }) => projectId), [beta.projectId]);
});

test('project task history can be restored and deletion is accepted only after pause or completion', async (context) => {
  const softwareRoot = await makeRoot();
  context.after(() => rm(softwareRoot, { recursive: true, force: true }));
  const baseUrl = await startSoftwareServer(softwareRoot, context);
  const project = await createProject(baseUrl, '运行中项目');
  await uploadText(baseUrl, project.projectId, '运行中.txt', '第一集 开始\n任务内容\n');
  const started = await jsonRequest(`${baseUrl}/api/projects/${project.projectId}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'split' })
  });
  assert.equal(started.response.status, 202);

  const rejected = await jsonRequest(`${baseUrl}/api/projects/${project.projectId}`, { method: 'DELETE' });
  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.body.error.code, 'PROJECT_TASK_BUSY');
  const taskId = started.body.data.taskId;
  const history = await jsonRequest(`${baseUrl}/api/projects/${project.projectId}/tasks`);
  assert.equal(history.response.status, 200);
  assert.equal(history.body.data.tasks.some((task) => task.taskId === taskId), true);
  const paused = await jsonRequest(`${baseUrl}/api/projects/${project.projectId}/tasks/${taskId}`, { method: 'DELETE' });
  assert.equal(paused.response.status, 200);
  assert.equal(['paused', 'succeeded'].includes(paused.body.data.status), true);
  const deleted = await jsonRequest(`${baseUrl}/api/projects/${project.projectId}`, { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
});

test('project mutation routes are unavailable for legacy-root mode', async (context) => {
  const server = createPrototypeServer({ softwareMode: false, installationRoot: engineRoot });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const result = await jsonRequest(`${baseUrl}/api/projects/current-package`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: '不允许修改' })
  });
  assert.equal(result.response.status, 404);
  assert.equal(result.body.error.code, 'NOT_FOUND');
});

test('software control API rejects arbitrary actions, path-like ids, unsupported files, and writes in legacy mode', async (context) => {
  const softwareRoot = await makeRoot();
  context.after(() => rm(softwareRoot, { recursive: true, force: true }));
  const baseUrl = await startSoftwareServer(softwareRoot, context);
  const project = await createProject(baseUrl, '安全项目');

  const arbitrary = await jsonRequest(`${baseUrl}/api/projects/${project.projectId}/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'run-any-command' })
  });
  assert.equal(arbitrary.response.status, 400);
  assert.equal(arbitrary.body.error.code, 'ACTION_NOT_ALLOWED');
  const unsafeFile = await jsonRequest(`${baseUrl}/api/projects/${project.projectId}/screenplay`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', 'content-length': '1', 'x-ka-filename': encodeURIComponent('../escape.exe') },
    body: Buffer.from('x')
  });
  assert.equal(unsafeFile.response.status, 400);
  assert.equal(unsafeFile.body.ok, false);
  const traversal = await jsonRequest(`${baseUrl}/api/projects/%2e%2e/tasks/task-nope`);
  assert.notEqual(traversal.response.status, 200);
  assert.equal(traversal.body.ok, false);
});
