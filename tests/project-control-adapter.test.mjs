import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_SCREENPLAY_BYTES,
  PROJECT_CONTROL_ACTIONS,
  ProjectControlAdapter,
  ProjectControlError
} from '../src/ui/services/project-control-adapter.mjs';

const project = { projectId: 'alpha', displayName: '甲项目', storageMode: 'isolated-project', availability: 'available' };
const deletedProject = { projectId: 'alpha', deleted: true };
const task = {
  taskId: 'task-1', projectId: 'alpha', action: 'split', status: 'running',
  queuedAt: '2026-08-04T00:00:00.000Z', startedAt: '2026-08-04T00:00:01.000Z',
  finishedAt: null, exitCode: null, log: { text: '正在切分', truncated: false }
};
const envelope = (data) => ({ ok: true, data });

test('project control exposes every fixed script-backed and Agent pipeline action', () => {
  assert.deepEqual(PROJECT_CONTROL_ACTIONS, [
    'environment-check',
    'split',
    'validate-and-build-workbook',
    'build-builtin-queue',
    'analyze-screenplay',
    'build-scoped-workbook',
    'build-world-overview',
    'complete-asset-visual-specs',
    'classify-prompt-branches',
    'finalize-after-confirmation',
    'run-full-pipeline'
  ]);
});

test('run-full-pipeline is sent as one fixed project-bound action', async () => {
  const calls = [];
  const adapter = new ProjectControlAdapter({
    bridge: {
      startProjectTask: async (input) => {
        calls.push(input);
        return envelope({ ...task, action: input.action });
      }
    }
  });
  const result = await adapter.startTask({ projectId: 'alpha', action: 'run-full-pipeline' });
  assert.equal(result.action, 'run-full-pipeline');
  assert.deepEqual(calls, [{ projectId: 'alpha', action: 'run-full-pipeline' }]);
});

test('scoped workbook forwards only a validated episode and asset-type range', async () => {
  const calls = [];
  const adapter = new ProjectControlAdapter({
    bridge: {
      startProjectTask: async (input) => {
        calls.push(input);
        return envelope({ ...task, action: input.action });
      }
    }
  });
  await adapter.startTask({
    projectId: 'alpha', action: 'build-scoped-workbook', workbookEpisodeStart: 2,
    workbookEpisodeEnd: 5, workbookAssetTypes: ['characters', 'scenes']
  });
  assert.deepEqual(calls, [{
    projectId: 'alpha', action: 'build-scoped-workbook', workbookEpisodeStart: 2,
    workbookEpisodeEnd: 5, workbookAssetTypes: ['characters', 'scenes']
  }]);
  await assert.rejects(
    () => adapter.startTask({
      projectId: 'alpha', action: 'split', workbookEpisodeStart: 2,
      workbookEpisodeEnd: 5, workbookAssetTypes: ['characters']
    }),
    (error) => error instanceof ProjectControlError && error.code === 'INVALID_TASK_INPUT'
  );
});

test('bridge mutations are project-bound and validate every returned envelope', async () => {
  const calls = [];
  const adapter = new ProjectControlAdapter({
    bridge: {
      createProject: async (input) => (calls.push(['create', input]), envelope(project)),
      renameProject: async (input) => (calls.push(['rename', input]), envelope({ ...project, displayName: input.displayName })),
      deleteProject: async (input) => (calls.push(['delete', input]), envelope(deletedProject)),
      uploadScreenplay: async (input) => (calls.push(['upload', input.projectId, input.file.name]), envelope({ projectId: 'alpha', filename: '第1集.txt', size: 8 })),
      startProjectTask: async (input) => (calls.push(['start', input]), envelope(task)),
      getProjectTask: async (input) => (calls.push(['get', input]), envelope(task)),
      listProjectTasks: async (input) => (calls.push(['list', input]), envelope({ tasks: [task] })),
      pauseProjectTask: async (input) => (calls.push(['pause', input]), envelope({ ...task, status: 'pausing' }))
    },
    fetchImpl: () => { throw new Error('HTTP fallback must not run'); }
  });
  const file = { name: '第1集.txt', size: 8, type: 'text/plain' };

  assert.deepEqual(await adapter.createProject({ displayName: ' 甲项目 ' }), project);
  assert.equal((await adapter.renameProject({ projectId: 'alpha', displayName: ' 新项目 ' })).displayName, '新项目');
  assert.deepEqual(await adapter.deleteProject({ projectId: 'alpha' }), deletedProject);
  assert.equal((await adapter.uploadScreenplay({ projectId: 'alpha', file })).filename, '第1集.txt');
  assert.equal((await adapter.startTask({ projectId: 'alpha', action: 'split' })).status, 'running');
  assert.equal((await adapter.getTask({ projectId: 'alpha', taskId: 'task-1' })).taskId, 'task-1');
  assert.equal((await adapter.listTasks({ projectId: 'alpha' })).tasks.length, 1);
  assert.equal((await adapter.pauseTask({ projectId: 'alpha', taskId: 'task-1' })).status, 'pausing');
  assert.deepEqual(calls.map(([kind]) => kind), ['create', 'rename', 'delete', 'upload', 'start', 'get', 'list', 'pause']);
});

test('HTTP fallback uses only fixed project-control routes and raw file bodies', async () => {
  const requests = [];
  const responses = [
    project,
    { ...project, displayName: '新项目' },
    deletedProject,
    { projectId: 'alpha', filename: 'script.txt', size: 7 },
    task,
    task,
    { tasks: [task] },
    { ...task, status: 'pausing' }
  ];
  const adapter = new ProjectControlAdapter({
    bridge: null,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, json: async () => envelope(responses.shift()) };
    }
  });
  const file = { name: 'script.txt', size: 7, type: 'text/plain' };

  await adapter.createProject({ displayName: '项目 A' });
  await adapter.renameProject({ projectId: 'alpha', displayName: '新项目' });
  await adapter.deleteProject({ projectId: 'alpha' });
  await adapter.uploadScreenplay({ projectId: 'alpha', file });
  await adapter.startTask({ projectId: 'alpha', action: 'split' });
  await adapter.getTask({ projectId: 'alpha', taskId: 'task-1' });
  await adapter.listTasks({ projectId: 'alpha' });
  await adapter.pauseTask({ projectId: 'alpha', taskId: 'task-1' });

  assert.deepEqual(requests.map(({ url, init }) => [url, init.method]), [
    ['/api/projects', 'POST'],
    ['/api/projects/alpha', 'PATCH'],
    ['/api/projects/alpha', 'DELETE'],
    ['/api/projects/alpha/screenplay', 'PUT'],
    ['/api/projects/alpha/tasks', 'POST'],
    ['/api/projects/alpha/tasks/task-1', 'GET'],
    ['/api/projects/alpha/tasks', 'GET'],
    ['/api/projects/alpha/tasks/task-1', 'DELETE']
  ]);
  assert.equal(requests[2].init.body, undefined);
  assert.equal(requests[3].init.body, file);
  assert.equal(decodeURIComponent(requests[3].init.headers['x-ka-filename']), 'script.txt');
});

test('invalid names, files, ids, actions, oversized input, and mismatched receipts fail closed', async () => {
  const adapter = new ProjectControlAdapter({ bridge: null, fetchImpl: async () => ({ ok: true, json: async () => envelope(project) }) });
  const rejects = [
    () => adapter.createProject({ displayName: '../escape' }),
    () => adapter.createProject({ displayName: 'bad:name' }),
    () => adapter.renameProject({ projectId: '../escape', displayName: '安全名称' }),
    () => adapter.renameProject({ projectId: 'alpha', displayName: '../escape' }),
    () => adapter.renameProject({ projectId: 'alpha', displayName: 'bad:name' }),
    () => adapter.deleteProject({ projectId: '../escape' }),
    () => adapter.uploadScreenplay({ projectId: '../escape', file: { name: 'a.txt', size: 1 } }),
    () => adapter.uploadScreenplay({ projectId: 'alpha', file: { name: 'a.exe', size: 1 } }),
    () => adapter.uploadScreenplay({ projectId: 'alpha', file: { name: 'a.txt', size: MAX_SCREENPLAY_BYTES + 1 } }),
    () => adapter.startTask({ projectId: 'alpha', action: 'powershell-anything' }),
    () => adapter.startTask({ projectId: 'alpha', action: 'claim-next-builtin-image' }),
    () => adapter.startTask({ projectId: 'alpha', action: 'generate-next-builtin-image' }),
    () => adapter.getTask({ projectId: 'alpha', taskId: '../task' }),
    () => adapter.listTasks({ projectId: '../alpha' }),
    () => adapter.pauseTask({ projectId: 'alpha', taskId: '../task' })
  ];
  for (const reject of rejects) await assert.rejects(reject, ProjectControlError);

  const mismatch = new ProjectControlAdapter({
    bridge: { startProjectTask: async () => envelope({ ...task, projectId: 'beta' }) }
  });
  await assert.rejects(
    () => mismatch.startTask({ projectId: 'alpha', action: 'split' }),
    (error) => error instanceof ProjectControlError && error.code === 'TASK_MISMATCH'
  );

  const mismatchedProjectMutations = new ProjectControlAdapter({
    bridge: {
      renameProject: async () => envelope({ ...project, projectId: 'beta', displayName: '新项目' }),
      deleteProject: async () => envelope({ projectId: 'beta', deleted: true })
    }
  });
  await assert.rejects(
    () => mismatchedProjectMutations.renameProject({ projectId: 'alpha', displayName: '新项目' }),
    (error) => error instanceof ProjectControlError && error.code === 'PROJECT_MISMATCH'
  );
  await assert.rejects(
    () => mismatchedProjectMutations.deleteProject({ projectId: 'alpha' }),
    (error) => error instanceof ProjectControlError && error.code === 'PROJECT_MISMATCH'
  );
});

test('task DTO rejects extra fields that could leak paths or process identity', async () => {
  const adapter = new ProjectControlAdapter({
    bridge: { getProjectTask: async () => envelope({ ...task, projectRoot: 'D:\\secret', pid: 1234 }) }
  });
  await assert.rejects(
    () => adapter.getTask({ projectId: 'alpha', taskId: 'task-1' }),
    (error) => error instanceof ProjectControlError && error.code === 'INVALID_RESPONSE'
  );
});

test('project mutation DTOs reject extra fields and non-isolated project receipts', async () => {
  const adapter = new ProjectControlAdapter({
    bridge: {
      renameProject: async () => envelope({ ...project, displayName: '新项目', projectRoot: 'D:\\secret' }),
      deleteProject: async () => envelope({ ...deletedProject, path: 'D:\\secret' })
    }
  });
  await assert.rejects(
    () => adapter.renameProject({ projectId: 'alpha', displayName: '新项目' }),
    (error) => error instanceof ProjectControlError && error.code === 'INVALID_RESPONSE'
  );
  await assert.rejects(
    () => adapter.deleteProject({ projectId: 'alpha' }),
    (error) => error instanceof ProjectControlError && error.code === 'INVALID_RESPONSE'
  );

  const legacy = new ProjectControlAdapter({
    bridge: { renameProject: async () => envelope({ ...project, displayName: '新项目', storageMode: 'legacy-root' }) }
  });
  await assert.rejects(
    () => legacy.renameProject({ projectId: 'alpha', displayName: '新项目' }),
    (error) => error instanceof ProjectControlError && error.code === 'INVALID_RESPONSE'
  );
});
