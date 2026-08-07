import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createProjectRootIndex,
  LEGACY_PROJECT_ID,
  PROJECT_ID_PATTERN,
  ProjectRootIndexError,
  validateProjectId
} from '../src/server/project-root-index.mjs';

const makeRoot = () => mkdtemp(path.join(os.tmpdir(), 'ka-project-index-'));
const writeJson = (filename, value) => writeFile(filename, JSON.stringify(value, null, 2), 'utf8');

test('project ids use a bounded ASCII-only non-path grammar', () => {
  for (const value of ['a', 'Project_01', 'current-package', `a${'b'.repeat(63)}`]) {
    assert.match(value, PROJECT_ID_PATTERN);
    assert.equal(validateProjectId(value), value);
  }
  for (const value of ['', '.', '..', '../alpha', 'alpha/beta', 'alpha\\beta', 'C:\\alpha', '/alpha', '%2e%2e', '项目一', `a${'b'.repeat(64)}`]) {
    assert.throws(
      () => validateProjectId(value),
      (error) => error instanceof ProjectRootIndexError && error.code === 'INVALID_PROJECT_ID'
    );
  }
});

test('missing projects directory exposes one explicit legacy-root project', async (context) => {
  const root = await makeRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeJson(path.join(root, 'project.json'), {
    displayName: '当前安装包',
    absolutePath: root,
    prompt: 'do-not-expose',
    credential: 'do-not-expose'
  });

  const index = createProjectRootIndex(root);
  assert.deepEqual(await index.listProjects(), [{
    projectId: LEGACY_PROJECT_ID,
    displayName: '当前安装包',
    storageMode: 'legacy-root',
    availability: 'available'
  }]);
  const resolved = await index.resolveProject(LEGACY_PROJECT_ID);
  assert.equal(resolved.rootPath, await realpath(root));
  assert.equal(JSON.stringify(resolved.metadata).includes(root), false);
});

test('software workspace mode omits the legacy installation root', async (context) => {
  const root = await makeRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const index = createProjectRootIndex(root, { includeLegacy: false });

  assert.deepEqual(await index.listProjects(), []);
  await assert.rejects(
    () => index.resolveProject('current-package'),
    (error) => error instanceof ProjectRootIndexError
      && error.status === 404
      && error.code === 'PROJECT_NOT_FOUND'
  );
});

test('enumeration accepts only direct safe project roots and whitelists displayName', async (context) => {
  const root = await makeRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const projects = path.join(root, 'projects');
  await Promise.all([
    mkdir(path.join(projects, 'alpha'), { recursive: true }),
    mkdir(path.join(projects, 'beta-2'), { recursive: true }),
    mkdir(path.join(projects, '项目'), { recursive: true }),
    mkdir(path.join(projects, 'bad.name'), { recursive: true })
  ]);
  await Promise.all([
    writeJson(path.join(projects, 'alpha', 'project.json'), {
      displayName: '甲项目', path: 'C:\\private', prompt: 'private prompt', pid: 1234
    }),
    writeJson(path.join(projects, 'beta-2', 'project.json'), {
      displayName: 'C:\\must-not-leak', password: 'private password'
    }),
    writeFile(path.join(projects, 'ordinary-file'), 'not a project', 'utf8')
  ]);

  const index = createProjectRootIndex(root);
  const listed = await index.listProjects();
  assert.deepEqual(listed, [
    { projectId: 'current-package', displayName: '当前安装包项目', storageMode: 'legacy-root', availability: 'available' },
    { projectId: 'alpha', displayName: '甲项目', storageMode: 'isolated-project', availability: 'available' },
    { projectId: 'beta-2', displayName: 'beta-2', storageMode: 'isolated-project', availability: 'available' }
  ]);
  assert.deepEqual(Object.keys(listed[1]), ['projectId', 'displayName', 'storageMode', 'availability']);
  const text = JSON.stringify(listed);
  for (const forbidden of [root, 'private prompt', 'private password', '1234']) assert.equal(text.includes(forbidden), false);

  const alpha = await index.resolveProject('alpha');
  assert.equal(alpha.rootPath, await realpath(path.join(root, 'projects', 'alpha')));
  await assert.rejects(
    () => index.resolveProject('项目'),
    (error) => error instanceof ProjectRootIndexError && error.code === 'INVALID_PROJECT_ID'
  );
  await assert.rejects(
    () => index.resolveProject('missing'),
    (error) => error instanceof ProjectRootIndexError && error.code === 'PROJECT_NOT_FOUND'
  );
});

test('junction or symlink project roots are listed unavailable and never resolved', async (context) => {
  const root = await makeRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const projects = path.join(root, 'projects');
  const external = path.join(root, 'external-project');
  await Promise.all([mkdir(projects, { recursive: true }), mkdir(external, { recursive: true })]);
  try {
    await symlink(external, path.join(projects, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      context.skip('当前环境不允许创建目录链接');
      return;
    }
    throw error;
  }

  const index = createProjectRootIndex(root);
  assert.deepEqual(await index.listProjects(), [
    {
      projectId: 'current-package',
      displayName: '当前安装包项目',
      storageMode: 'legacy-root',
      availability: 'available'
    },
    {
      projectId: 'linked',
      displayName: 'linked',
      storageMode: 'isolated-project',
      availability: 'unavailable'
    }
  ]);
  await assert.rejects(
    () => index.resolveProject('linked'),
    (error) => error instanceof ProjectRootIndexError && error.code === 'PROJECT_ROOT_UNSAFE'
  );
});

test('a linked projects container is rejected instead of falling back to the legacy root', async (context) => {
  const root = await makeRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const external = path.join(root, 'external-projects');
  await mkdir(external, { recursive: true });
  try {
    await symlink(external, path.join(root, 'projects'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      context.skip('当前环境不允许创建目录链接');
      return;
    }
    throw error;
  }

  await assert.rejects(
    () => createProjectRootIndex(root).listProjects(),
    (error) => error instanceof ProjectRootIndexError && error.code === 'PROJECT_INDEX_UNSAFE'
  );
});

test('the legacy card counts toward the bounded project limit', async (context) => {
  const root = await makeRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const projects = path.join(root, 'projects');
  await mkdir(projects, { recursive: true });
  await Promise.all(Array.from({ length: 256 }, (_, index) => (
    mkdir(path.join(projects, `project-${String(index).padStart(3, '0')}`))
  )));

  await assert.rejects(
    () => createProjectRootIndex(root).listProjects(),
    (error) => error instanceof ProjectRootIndexError
      && error.status === 503
      && error.code === 'PROJECT_LIMIT_EXCEEDED'
  );
});
