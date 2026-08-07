import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  createPipelineTaskRunner as createBasePipelineTaskRunner,
  PIPELINE_TASK_ACTIONS,
  PipelineTaskRunnerError
} from '../src/server/pipeline-task-runner.mjs';

const TEST_RUNTIME_CONFIG = Object.freeze({
  model: 'gpt-5.6-terra', reasoningEffort: 'medium', modelLabel: 'gpt-5.6-terra',
  reasoningEffortLabel: 'medium', source: 'software-settings'
});
const createPipelineTaskRunner = (options) => createBasePipelineTaskRunner({
  readRuntimeConfig: async () => TEST_RUNTIME_CONFIG,
  ...options
});

const makeProjectRoot = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ka-pipeline-task-'));
  await Promise.all([
    mkdir(path.join(root, 'scripts', 'commands'), { recursive: true }),
    mkdir(path.join(root, 'scripts', 'pipeline'), { recursive: true }),
    mkdir(path.join(root, 'scripts', 'lib'), { recursive: true }),
    mkdir(path.join(root, 'assets', '图片生成', 'prompts', 'modifiers'), { recursive: true }),
    mkdir(path.join(root, '输出'), { recursive: true })
  ]);
  await Promise.all([
    writeFile(path.join(root, 'scripts', 'commands', 'python.ps1'), '# test wrapper', 'utf8'),
    writeFile(path.join(root, 'scripts', 'commands', 'node.ps1'), '# test wrapper', 'utf8'),
    writeFile(path.join(root, 'scripts', 'commands', 'check_environment.ps1'), '# test check', 'utf8'),
    writeFile(path.join(root, 'scripts', 'pipeline', 'extract_screenplay.py'), '# test extractor', 'utf8'),
    writeFile(path.join(root, 'scripts', 'pipeline', 'validate_asset_records.py'), '# test validator', 'utf8'),
    writeFile(path.join(root, 'scripts', 'pipeline', 'build_workbook.mjs'), '// test workbook builder', 'utf8'),
    writeFile(path.join(root, 'scripts', 'pipeline', 'build_image_queue.mjs'), '// test queue builder', 'utf8'),
    writeFile(path.join(root, 'scripts', 'pipeline', 'get_next_image_job.mjs'), '// test queue claimer', 'utf8'),
    writeFile(path.join(root, 'scripts', 'pipeline', 'update_image_progress.mjs'), '// test image updater', 'utf8'),
    writeFile(path.join(root, 'scripts', 'pipeline', 'update_analysis_progress.mjs'), '// test analysis progress', 'utf8'),
    writeFile(path.join(root, 'scripts', 'pipeline', 'write_episode_analysis.py'), '# test analysis writer', 'utf8'),
    writeFile(path.join(root, 'scripts', 'pipeline', 'query_asset_records.py'), '# test record query', 'utf8'),
    writeFile(path.join(root, 'scripts', 'pipeline', 'sync_episode_analysis.py'), '# test analysis sync', 'utf8'),
    writeFile(path.join(root, 'scripts', 'pipeline', 'page_world_records.py'), '# test world pager', 'utf8'),
    writeFile(path.join(root, 'scripts', 'pipeline', 'finalize_world_overview.py'), '# test world finalizer', 'utf8'),
    writeFile(path.join(root, 'scripts', 'pipeline', 'asset_visual_specs.py'), '# test visual specs', 'utf8'),
    writeFile(path.join(root, 'scripts', 'lib', 'prompt_catalog.mjs'), '// test prompt catalog', 'utf8'),
    writeFile(path.join(root, 'assets', '图片生成', 'prompts', 'catalog.json'), '{}\n', 'utf8'),
    writeFile(path.join(root, 'assets', '图片生成', 'prompts', 'modifiers', 'condition-modules-v1.json'), '{}\n', 'utf8'),
    writeFile(path.join(root, '输出', '剧本资产制表.xlsx'), 'test workbook', 'utf8')
  ]);
  return root;
};

const makePipelineSkill = async () => {
  const softwareRoot = await mkdtemp(path.join(os.tmpdir(), 'ka-pipeline-skill-'));
  const skillRoot = path.join(softwareRoot, 'runtime', 'skills', 'ka-script-pipeline');
  await mkdir(skillRoot, { recursive: true });
  const skillPath = path.join(skillRoot, 'SKILL.md');
  await writeFile(skillPath, '# fixed software pipeline skill\n', 'utf8');
  return { softwareRoot, skillPath };
};

const makeChild = () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
};

const waitFor = async (read, predicate, timeout = 2000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error('Timed out waiting for task state');
};

const sequenceClock = () => {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 4, 0, 0, tick++));
};

test('only fixed script and Agent actions with fixed request fields are accepted', async (context) => {
  const root = await makeProjectRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const runner = createPipelineTaskRunner({
    resolveProjectRoot: async () => root,
    materializeProjectRuntime: async () => {},
    spawnImpl: () => makeChild()
  });

  assert.deepEqual(PIPELINE_TASK_ACTIONS, [
    'environment-check',
    'split',
    'validate-and-build-workbook',
    'build-builtin-queue',
    'analyze-screenplay',
    'build-world-overview',
    'complete-asset-visual-specs',
    'classify-prompt-branches',
    'build-scoped-workbook',
    'finalize-after-confirmation',
    'run-full-pipeline'
  ]);
  for (const action of [
    'generate',
    'image-generation',
    'shell',
    '',
    'claim-next-builtin-image',
    'generate-next-builtin-image'
  ]) {
    assert.throws(
      () => runner.startTask({ projectId: 'alpha', action }),
      (error) => error instanceof PipelineTaskRunnerError && error.code === 'ACTION_NOT_ALLOWED'
    );
  }
  assert.throws(
    () => runner.startTask({ projectId: 'alpha', action: 'split', command: 'whoami' }),
    (error) => error instanceof PipelineTaskRunnerError && error.code === 'TASK_INPUT_NOT_ALLOWED'
  );
  assert.throws(
    () => runner.startTask({ projectId: 'alpha', action: 'split', analysisEpisodeLimit: 3 }),
    (error) => error instanceof PipelineTaskRunnerError && error.code === 'TASK_INPUT_NOT_ALLOWED'
  );
  assert.throws(
    () => runner.startTask({
      projectId: 'alpha', action: 'build-scoped-workbook', workbookEpisodeStart: 0,
      workbookEpisodeEnd: 3, workbookAssetTypes: ['characters']
    }),
    (error) => error instanceof PipelineTaskRunnerError && error.code === 'INVALID_WORKBOOK_SCOPE'
  );
  for (const forbiddenField of ['prompt', 'model', 'path', 'args', 'pipelineSkillPath']) {
    assert.throws(
      () => runner.startTask({
        projectId: 'alpha',
        action: 'analyze-screenplay',
        [forbiddenField]: 'user-controlled-value'
      }),
      (error) => error instanceof PipelineTaskRunnerError && error.code === 'TASK_INPUT_NOT_ALLOWED'
    );
  }
  assert.throws(
    () => runner.startTask({ projectId: '../alpha', action: 'split' }),
    (error) => error instanceof PipelineTaskRunnerError && error.code === 'INVALID_PROJECT_ID'
  );
  assert.throws(
    () => createPipelineTaskRunner({
      resolveProjectRoot: async () => root,
      materializeProjectRuntime: async () => {},
      pipelineSkillPath: 'relative/SKILL.md'
    }),
    /pipelineSkillPath must be an absolute path/u
  );
});

test('an unavailable configured software Skill fails an Agent task before worker spawn', async (context) => {
  const root = await makeProjectRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const missingSkill = path.join(
    os.tmpdir(),
    `missing-ka-skill-${Date.now()}`,
    'ka-script-pipeline',
    'SKILL.md'
  );
  let spawnCount = 0;
  const runner = createPipelineTaskRunner({
    resolveProjectRoot: async () => root,
    materializeProjectRuntime: async () => {},
    pipelineSkillPath: missingSkill,
    spawnImpl: () => {
      spawnCount += 1;
      return makeChild();
    },
    createTaskId: () => 'task-missing-software-skill'
  });
  const task = runner.startTask({ projectId: 'alpha', action: 'analyze-screenplay' });
  const failed = await waitFor(() => runner.getTask(task.taskId), (value) => value.status === 'failed');
  assert.equal(spawnCount, 0);
  assert.match(failed.log.text, /ka-script-pipeline/u);
  assert.equal(failed.log.text.includes(missingSkill), false);
});

test('standalone analysis safely splits the screenplay before starting the fixed Agent worker', async (context) => {
  const root = await makeProjectRoot();
  const software = await makePipelineSkill();
  context.after(() => rm(root, { recursive: true, force: true }));
  context.after(() => rm(software.softwareRoot, { recursive: true, force: true }));
  const calls = [];
  const children = [];
  const runner = createPipelineTaskRunner({
    resolveProjectRoot: async () => root,
    materializeProjectRuntime: async () => {},
    pipelineSkillPath: software.skillPath,
    spawnImpl: (...args) => {
      calls.push(args);
      const child = makeChild();
      children.push(child);
      return child;
    },
    createTaskId: () => 'task-analysis-with-split'
  });
  const canonicalRoot = await realpath(root);
  const canonicalSkill = await realpath(software.skillPath);
  const task = runner.startTask({ projectId: 'alpha', action: 'analyze-screenplay' });
  await waitFor(() => calls.length, (length) => length === 1);
  assert.equal(calls[0][0], 'powershell.exe');
  assert.equal(path.basename(calls[0][1].at(-2)), 'extract_screenplay.py');
  children[0].emit('close', 0);
  await waitFor(() => calls.length, (length) => length === 2);
  assert.equal(calls[1][0], process.execPath);
  assert.equal(path.basename(calls[1][1][0]), 'codex-agent-worker.mjs');
  assert.deepEqual(calls[1][1].slice(1), [
    'analyze-screenplay', canonicalRoot, canonicalSkill, 'gpt-5.6-terra', 'medium'
  ]);
  children[1].emit('close', 0);
  const complete = await waitFor(() => runner.getTask(task.taskId), (value) => value.status === 'succeeded');
  assert.equal(complete.action, 'analyze-screenplay');
});

test('full pipeline resumes an interrupted episode without rerunning screenplay split', async (context) => {
  const root = await makeProjectRoot();
  const software = await makePipelineSkill();
  context.after(() => rm(root, { recursive: true, force: true }));
  context.after(() => rm(software.softwareRoot, { recursive: true, force: true }));
  const cacheRoot = path.join(root, 'cache');
  const resumeToken = 'resume-episode-3-token';
  await mkdir(cacheRoot, { recursive: true });
  await Promise.all([
    writeFile(path.join(cacheRoot, '阅读进度.json'), `${JSON.stringify({
      status: 'in_progress',
      discoveredEpisodes: [1, 2, 3, 4],
      completedEpisodes: [1, 2],
      currentEpisode: 3,
      currentSessionToken: resumeToken
    }, null, 2)}\n`, 'utf8'),
    writeFile(path.join(cacheRoot, '.pipeline.lock'), `${JSON.stringify({
      kind: 'analysis_episode',
      key: 'episode:3',
      protocolVersion: 2,
      leaseMode: 'durable',
      token: resumeToken
    }, null, 2)}\n`, 'utf8')
  ]);
  const calls = [];
  const children = [];
  const runner = createPipelineTaskRunner({
    resolveProjectRoot: async () => root,
    materializeProjectRuntime: async () => {},
    pipelineSkillPath: software.skillPath,
    spawnImpl: (...args) => {
      calls.push(args);
      const child = makeChild();
      children.push(child);
      return child;
    },
    createTaskId: () => 'task-full-pipeline-resume'
  });
  const canonicalRoot = await realpath(root);
  const canonicalSkill = await realpath(software.skillPath);
  const task = runner.startTask({ projectId: 'alpha', action: 'run-full-pipeline' });

  await waitFor(() => calls.length, (length) => length === 1);
  assert.equal(path.basename(calls[0][1].at(-2)), 'check_environment.ps1');
  children[0].emit('close', 0);

  await waitFor(() => calls.length, (length) => length === 2);
  assert.equal(calls[1][0], process.execPath);
  assert.equal(path.basename(calls[1][1][0]), 'codex-agent-worker.mjs');
  assert.deepEqual(calls[1][1].slice(1), [
    'analyze-screenplay', canonicalRoot, canonicalSkill, 'gpt-5.6-terra', 'medium'
  ]);
  assert.equal(calls.some(([, args]) => args.some((value) => /extract_screenplay\.py$/u.test(value))), false);
  const running = runner.getTask(task.taskId);
  assert.match(running.log.text, /检测到第 3 集分析恢复状态/u);

  children[1].emit('close', 1);
  const failed = await waitFor(() => runner.getTask(task.taskId), (value) => value.status === 'failed');
  assert.equal(failed.exitCode, 1);
});

test('Agent actions spawn only the fixed local worker in the selected project', async (context) => {
  const root = await makeProjectRoot();
  const software = await makePipelineSkill();
  context.after(() => rm(root, { recursive: true, force: true }));
  context.after(() => rm(software.softwareRoot, { recursive: true, force: true }));
  const calls = [];
  const children = [];
  let taskNumber = 0;
  const runner = createPipelineTaskRunner({
    resolveProjectRoot: async () => root,
    materializeProjectRuntime: async () => {},
    pipelineSkillPath: software.skillPath,
    spawnImpl: (...args) => {
      calls.push(args);
      const child = makeChild();
      children.push(child);
      return child;
    },
    createTaskId: () => `task-agent-${++taskNumber}`
  });
  const canonicalRoot = await realpath(root);
  const canonicalSkill = await realpath(software.skillPath);

  for (const action of ['build-world-overview', 'classify-prompt-branches']) {
    const task = runner.startTask({ projectId: 'alpha', action });
    await waitFor(() => calls.length, (length) => length === taskNumber);
    const [executable, argumentsList, options] = calls.at(-1);
    assert.equal(executable, process.execPath);
    assert.equal(path.basename(argumentsList[0]), 'codex-agent-worker.mjs');
    assert.equal(path.isAbsolute(argumentsList[0]), true);
    assert.deepEqual(argumentsList.slice(1), [
      action, canonicalRoot, canonicalSkill, 'gpt-5.6-terra', 'medium'
    ]);
    assert.equal(options.cwd, canonicalRoot);
    assert.equal(argumentsList.some((value) => /--model|--prompt|--add-dir/iu.test(value)), false);
    children.at(-1).stdout.write('Codex Agent 已开始执行固定动作\n');
    children.at(-1).emit('close', 0);
    const complete = await waitFor(() => runner.getTask(task.taskId), (value) => value.status === 'succeeded');
    assert.equal(complete.action, action);
  }
});

test('run-full-pipeline executes the fixed non-image pipeline in order', async (context) => {
  const root = await makeProjectRoot();
  const software = await makePipelineSkill();
  context.after(() => rm(root, { recursive: true, force: true }));
  context.after(() => rm(software.softwareRoot, { recursive: true, force: true }));
  const calls = [];
  const children = [];
  const runner = createPipelineTaskRunner({
    resolveProjectRoot: async () => root,
    materializeProjectRuntime: async () => {},
    pipelineSkillPath: software.skillPath,
    spawnImpl: (...args) => {
      calls.push(args);
      const child = makeChild();
      children.push(child);
      return child;
    },
    createTaskId: () => 'task-full-pipeline'
  });
  const canonicalRoot = await realpath(root);
  const canonicalSkill = await realpath(software.skillPath);
  const expected = [
    ['powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(canonicalRoot, 'scripts', 'commands', 'check_environment.ps1'), '-NoInstall'
    ]],
    ['powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(canonicalRoot, 'scripts', 'commands', 'python.ps1'),
      path.join(canonicalRoot, 'scripts', 'pipeline', 'extract_screenplay.py'),
      canonicalRoot
    ]],
    [process.execPath, ['analyze-screenplay', canonicalRoot, canonicalSkill, 'gpt-5.6-terra', 'medium']],
    [process.execPath, ['build-world-overview', canonicalRoot, canonicalSkill, 'gpt-5.6-terra', 'medium']],
    [process.execPath, ['complete-asset-visual-specs', canonicalRoot, canonicalSkill, 'gpt-5.6-terra', 'medium']],
    ['powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(canonicalRoot, 'scripts', 'commands', 'python.ps1'),
      path.join(canonicalRoot, 'scripts', 'pipeline', 'validate_asset_records.py'),
      canonicalRoot
    ]],
    ['powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(canonicalRoot, 'scripts', 'commands', 'node.ps1'),
      path.join(canonicalRoot, 'scripts', 'pipeline', 'build_workbook.mjs'),
      canonicalRoot
    ]]
  ];

  const task = runner.startTask({ projectId: 'alpha', action: 'run-full-pipeline' });
  for (let index = 0; index < expected.length; index += 1) {
    await waitFor(() => calls.length, (length) => length === index + 1);
    const [executable, argumentsList, options] = calls[index];
    assert.equal(executable, expected[index][0]);
    assert.equal(options.cwd, canonicalRoot);
    if (executable === process.execPath) {
      assert.equal(path.basename(argumentsList[0]), 'codex-agent-worker.mjs');
      assert.deepEqual(argumentsList.slice(1), expected[index][1]);
    } else {
      assert.deepEqual(argumentsList, expected[index][1]);
    }
    assert.equal(argumentsList.some((value) => /build_image_queue|classify-prompt-branches/iu.test(value)), false);
    children[index].stdout.write(`step ${index + 1} complete\n`);
    children[index].emit('close', 0);
  }

  const complete = await waitFor(() => runner.getTask(task.taskId), (value) => value.status === 'succeeded');
  assert.equal(complete.action, 'run-full-pipeline');
  assert.equal(complete.exitCode, 0);
  assert.match(complete.log.text, /step 7 complete/u);
});

test('full pipeline pauses at the human confirmation checkpoint and continuation starts after it', async (context) => {
  const root = await makeProjectRoot();
  const software = await makePipelineSkill();
  context.after(() => rm(root, { recursive: true, force: true }));
  context.after(() => rm(software.softwareRoot, { recursive: true, force: true }));
  await mkdir(path.join(root, 'cache'), { recursive: true });
  await writeFile(path.join(root, 'cache', '待确认记录.json'), JSON.stringify([{
    pendingId: 'PENDING-CHAR-0123456789abcdef',
    status: 'pending',
    draftAsset: { assetName: '赵总' }
  }]), 'utf8');
  const calls = [];
  const children = [];
  let taskNumber = 0;
  const runner = createPipelineTaskRunner({
    resolveProjectRoot: async () => root,
    materializeProjectRuntime: async () => {},
    pipelineSkillPath: software.skillPath,
    spawnImpl: (...args) => {
      calls.push(args);
      const child = makeChild();
      children.push(child);
      return child;
    },
    createTaskId: () => `task-confirmation-${++taskNumber}`
  });

  const full = runner.startTask({ projectId: 'alpha', action: 'run-full-pipeline' });
  for (let index = 0; index < 4; index += 1) {
    await waitFor(() => calls.length, (length) => length === index + 1);
    children[index].emit('close', 0);
  }
  const paused = await waitFor(() => runner.getTask(full.taskId), (task) => task.status === 'paused');
  assert.equal(calls.length, 4);
  assert.match(paused.log.text, /1 项待确认资产/u);
  assert.match(paused.log.text, /安全等待人工确认/u);

  await writeFile(path.join(root, 'cache', '待确认记录.json'), JSON.stringify([{
    pendingId: 'PENDING-CHAR-0123456789abcdef',
    status: 'resolved',
    decision: 'exclude',
    appliedAt: '2026-08-06T00:00:00.000Z',
    draftAsset: { assetName: '赵总' }
  }]), 'utf8');
  const continuationOffset = calls.length;
  const continuation = runner.startTask({ projectId: 'alpha', action: 'finalize-after-confirmation' });
  for (let index = 0; index < 3; index += 1) {
    await waitFor(() => calls.length, (length) => length === continuationOffset + index + 1);
    children[continuationOffset + index].emit('close', 0);
  }
  const completed = await waitFor(
    () => runner.getTask(continuation.taskId),
    (task) => task.status === 'succeeded'
  );
  assert.equal(completed.action, 'finalize-after-confirmation');
  assert.equal(path.basename(calls[continuationOffset][1][0]), 'codex-agent-worker.mjs');
  assert.equal(calls[continuationOffset][1][1], 'complete-asset-visual-specs');
  assert.match(calls[continuationOffset + 1][1].join(' '), /validate_asset_records\.py/u);
  assert.match(calls[continuationOffset + 2][1].join(' '), /build_workbook\.mjs/u);
});

test('scoped workbook still runs the full analysis chain and only scopes the final workbook rows', async (context) => {
  const root = await makeProjectRoot();
  const software = await makePipelineSkill();
  context.after(() => rm(root, { recursive: true, force: true }));
  context.after(() => rm(software.softwareRoot, { recursive: true, force: true }));
  const calls = [];
  const children = [];
  const runner = createPipelineTaskRunner({
    resolveProjectRoot: async () => root,
    materializeProjectRuntime: async () => {},
    pipelineSkillPath: software.skillPath,
    spawnImpl: (...args) => {
      calls.push(args);
      const child = makeChild();
      children.push(child);
      return child;
    },
    createTaskId: () => 'task-scoped-workbook'
  });
  const canonicalRoot = await realpath(root);
  const canonicalSkill = await realpath(software.skillPath);
  const task = runner.startTask({
    projectId: 'alpha', action: 'build-scoped-workbook', workbookEpisodeStart: 2,
    workbookEpisodeEnd: 5, workbookAssetTypes: ['characters', 'scenes']
  });
  for (let index = 0; index < 7; index += 1) {
    await waitFor(() => calls.length, (length) => length === index + 1);
    children[index].emit('close', 0);
  }
  assert.deepEqual(calls[2][1].slice(1), [
    'analyze-screenplay', canonicalRoot, canonicalSkill, 'gpt-5.6-terra', 'medium'
  ]);
  assert.deepEqual(calls[3][1].slice(1), [
    'build-world-overview', canonicalRoot, canonicalSkill, 'gpt-5.6-terra', 'medium'
  ]);
  assert.deepEqual(calls[4][1].slice(1), [
    'complete-asset-visual-specs', canonicalRoot, canonicalSkill, 'gpt-5.6-terra', 'medium'
  ]);
  assert.deepEqual(calls[6][1].slice(-4), [
    canonicalRoot, '--episode-start=2', '--episode-end=5', '--asset-types=characters,scenes'
  ]);
  const complete = await waitFor(() => runner.getTask(task.taskId), (value) => value.status === 'succeeded');
  assert.equal(complete.action, 'build-scoped-workbook');
});

test('validate-and-build-workbook waits for validation before starting workbook build', async (context) => {
  const root = await makeProjectRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const children = [];
  const calls = [];
  const runner = createPipelineTaskRunner({
    resolveProjectRoot: async () => root,
    materializeProjectRuntime: async () => {},
    spawnImpl: (...args) => {
      const child = makeChild();
      children.push(child);
      calls.push(args);
      return child;
    },
    createTaskId: () => 'task-validate-workbook'
  });

  const task = runner.startTask({ projectId: 'alpha', action: 'validate-and-build-workbook' });
  await waitFor(() => runner.getTask(task.taskId), (value) => children.length === 1 && value.status === 'running');
  const canonicalRoot = await realpath(root);
  assert.deepEqual(calls[0][1].slice(-3), [
    path.join(canonicalRoot, 'scripts', 'commands', 'python.ps1'),
    path.join(canonicalRoot, 'scripts', 'pipeline', 'validate_asset_records.py'),
    canonicalRoot
  ]);

  children[0].stdout.write('validation complete\n');
  children[0].emit('close', 0);
  await waitFor(() => calls.length, (length) => length === 2);
  assert.equal(runner.getTask(task.taskId).status, 'running');
  assert.deepEqual(calls[1][1].slice(-3), [
    path.join(canonicalRoot, 'scripts', 'commands', 'node.ps1'),
    path.join(canonicalRoot, 'scripts', 'pipeline', 'build_workbook.mjs'),
    canonicalRoot
  ]);

  children[1].stdout.write('workbook complete\n');
  children[1].emit('close', 0);
  const complete = await waitFor(() => runner.getTask(task.taskId), (value) => value.status === 'succeeded');
  assert.equal(complete.exitCode, 0);
  assert.match(complete.log.text, /validation complete/u);
  assert.match(complete.log.text, /workbook complete/u);
});

test('a failed sequence step prevents later commands and releases the project', async (context) => {
  const root = await makeProjectRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const children = [];
  let taskNumber = 0;
  const runner = createPipelineTaskRunner({
    resolveProjectRoot: async () => root,
    materializeProjectRuntime: async () => {},
    spawnImpl: () => {
      const child = makeChild();
      children.push(child);
      return child;
    },
    createTaskId: () => `task-sequence-failure-${++taskNumber}`
  });

  const failedTask = runner.startTask({ projectId: 'alpha', action: 'validate-and-build-workbook' });
  await waitFor(() => children.length, (length) => length === 1);
  children[0].emit('close', 7);
  const failed = await waitFor(() => runner.getTask(failedTask.taskId), (value) => value.status === 'failed');
  assert.equal(failed.exitCode, 7);
  assert.equal(children.length, 1);

  const nextTask = runner.startTask({ projectId: 'alpha', action: 'build-builtin-queue' });
  await waitFor(() => children.length, (length) => length === 2);
  children[1].emit('close', 0);
  await waitFor(() => runner.getTask(nextTask.taskId), (value) => value.status === 'succeeded');
});

test('builtin queue build uses only the fixed node wrapper and queue claims are not exposed', async (context) => {
  const root = await makeProjectRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const children = [];
  let taskNumber = 0;
  const runner = createPipelineTaskRunner({
    resolveProjectRoot: async () => root,
    materializeProjectRuntime: async () => {},
    spawnImpl: (...args) => {
      calls.push(args);
      const child = makeChild();
      children.push(child);
      return child;
    },
    createTaskId: () => `task-builtin-${++taskNumber}`
  });
  const canonicalRoot = await realpath(root);

  const build = runner.startTask({ projectId: 'alpha', action: 'build-builtin-queue' });
  await waitFor(() => calls.length, (length) => length === 1);
  assert.deepEqual(calls[0][1].slice(-3), [
    path.join(canonicalRoot, 'scripts', 'commands', 'node.ps1'),
    path.join(canonicalRoot, 'scripts', 'pipeline', 'build_image_queue.mjs'),
    canonicalRoot
  ]);
  children[0].emit('close', 0);
  await waitFor(() => runner.getTask(build.taskId), (value) => value.status === 'succeeded');

  assert.throws(
    () => runner.startTask({ projectId: 'alpha', action: 'claim-next-builtin-image' }),
    (error) => error instanceof PipelineTaskRunnerError && error.code === 'ACTION_NOT_ALLOWED'
  );
  assert.equal(calls.length, 1);
});

test('a synchronous spawn error in a later sequence step cannot leave the task running', async (context) => {
  const root = await makeProjectRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const first = makeChild();
  let spawnCount = 0;
  const runner = createPipelineTaskRunner({
    resolveProjectRoot: async () => root,
    materializeProjectRuntime: async () => {},
    spawnImpl: () => {
      spawnCount += 1;
      if (spawnCount === 1) return first;
      throw new Error('second command could not start');
    },
    createTaskId: () => 'task-sequence-spawn-error'
  });

  const task = runner.startTask({ projectId: 'alpha', action: 'validate-and-build-workbook' });
  await waitFor(() => runner.getTask(task.taskId), (value) => value.status === 'running');
  first.emit('close', 0);
  const failed = await waitFor(() => runner.getTask(task.taskId), (value) => value.status === 'failed');
  assert.equal(failed.exitCode, null);
  assert.match(failed.log.text, /second command could not start/u);
});

test('split uses the project snapshot wrappers with an argument array and returns a redacted DTO', async (context) => {
  const root = await makeProjectRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const child = makeChild();
  const calls = [];
  const materialized = [];
  const runner = createPipelineTaskRunner({
    resolveProjectRoot: async (projectId) => ({ rootPath: root, projectId }),
    materializeProjectRuntime: async (input) => materialized.push(input),
    spawnImpl: (...args) => {
      calls.push(args);
      return child;
    },
    environment: {
      PATH: 'C:\\Windows\\System32',
      USERPROFILE: 'C:\\Users\\tester',
      API_KEY: 'must-not-reach-child',
      ACCESS_TOKEN: 'must-not-reach-child'
    },
    now: sequenceClock(),
    createTaskId: () => 'task-split-1'
  });

  const accepted = runner.startTask({ projectId: 'alpha', action: 'split' });
  assert.equal(accepted.status, 'queued');
  assert.equal(accepted.startedAt, null);
  await waitFor(() => runner.getTask(accepted.taskId), (task) => calls.length === 1 && task.status === 'running');

  const canonicalRoot = await realpath(root);
  assert.deepEqual(materialized, [{ projectId: 'alpha', projectRoot: canonicalRoot }]);
  const [executable, args, options] = calls[0];
  assert.equal(executable, 'powershell.exe');
  assert.deepEqual(args, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(canonicalRoot, 'scripts', 'commands', 'python.ps1'),
    path.join(canonicalRoot, 'scripts', 'pipeline', 'extract_screenplay.py'),
    canonicalRoot
  ]);
  assert.equal(options.cwd, canonicalRoot);
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(options.env.API_KEY, undefined);
  assert.equal(options.env.ACCESS_TOKEN, undefined);
  assert.equal(options.env.PATH, 'C:\\Windows\\System32');

  child.stdout.write(`processed ${canonicalRoot} PID: 4321\n`);
  child.stderr.write('API_KEY=very-secret sk-abcdefghijk\n');
  child.emit('close', 0);
  const complete = await waitFor(
    () => runner.getTask(accepted.taskId),
    (task) => task.status === 'succeeded'
  );
  assert.equal(complete.exitCode, 0);
  assert.ok(complete.startedAt);
  assert.ok(complete.finishedAt);
  const serialized = JSON.stringify(complete);
  assert.equal(serialized.toLowerCase().includes(canonicalRoot.toLowerCase()), false);
  assert.equal(serialized.includes('very-secret'), false);
  assert.equal(serialized.includes('abcdefghijk'), false);
  assert.equal(serialized.includes('4321'), false);
  assert.equal(Object.hasOwn(complete, 'pid'), false);
  assert.equal(serialized.includes('processId'), false);
});

test('one project can have only one queued or running task while other projects remain independent', async (context) => {
  const root = await makeProjectRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const children = [];
  const calls = [];
  let taskNumber = 0;
  const runner = createPipelineTaskRunner({
    resolveProjectRoot: async () => root,
    materializeProjectRuntime: async () => {},
    spawnImpl: (...args) => {
      const child = makeChild();
      children.push(child);
      calls.push(args);
      return child;
    },
    createTaskId: () => `task-busy-${++taskNumber}`
  });

  const alpha = runner.startTask({ projectId: 'alpha', action: 'split' });
  assert.equal(runner.hasActiveTask('alpha'), true);
  assert.throws(
    () => runner.startTask({ projectId: 'alpha', action: 'environment-check' }),
    (error) => error instanceof PipelineTaskRunnerError
      && error.status === 409
      && error.code === 'PROJECT_TASK_BUSY'
  );
  const beta = runner.startTask({ projectId: 'beta', action: 'split' });
  await waitFor(() => children.length, (length) => length === 2);
  children[0].emit('close', 0);
  children[1].emit('close', 0);
  await waitFor(() => runner.getTask(alpha.taskId), (task) => task.status === 'succeeded');
  const completeBeta = await waitFor(() => runner.getTask(beta.taskId), (task) => task.status === 'succeeded');
  assert.equal(completeBeta.exitCode, 0);
  assert.equal(runner.hasActiveTask('alpha'), false);

  const nextAlpha = runner.startTask({ projectId: 'alpha', action: 'environment-check' });
  await waitFor(() => children.length, (length) => length === 3);
  assert.equal(nextAlpha.action, 'environment-check');
  assert.deepEqual(calls[2][1].slice(-3), [
    '-File',
    path.join(await realpath(root), 'scripts', 'commands', 'check_environment.ps1'),
    '-NoInstall'
  ]);
  children[2].emit('close', 0);
  await waitFor(() => runner.getTask(nextAlpha.taskId), (task) => task.status === 'succeeded');
  assert.equal(runner.listTasks({ projectId: 'alpha' }).length, 2);
});

test('running tasks can be paused and shutdown interrupts every child before rejecting new work', async (context) => {
  const root = await makeProjectRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const children = [];
  const signals = [];
  let taskNumber = 0;
  const runner = createPipelineTaskRunner({
    resolveProjectRoot: async () => root,
    materializeProjectRuntime: async () => {},
    spawnImpl: () => {
      const child = makeChild();
      child.kill = (signal) => {
        signals.push(signal);
        if (children.length > 1) queueMicrotask(() => child.emit('close', null));
        return true;
      };
      children.push(child);
      return child;
    },
    createTaskId: () => `task-pause-${++taskNumber}`
  });

  const first = runner.startTask({ projectId: 'alpha', action: 'split' });
  await waitFor(() => runner.getTask(first.taskId), (task) => task.status === 'running');
  const pausing = await runner.pauseTask(first.taskId);
  assert.equal(pausing.status, 'pausing');
  assert.equal(runner.hasActiveTask('alpha'), true);
  assert.match(pausing.log.text, /用户暂停/u);
  assert.deepEqual(signals, ['SIGTERM']);
  assert.throws(
    () => runner.startTask({ projectId: 'alpha', action: 'environment-check' }),
    (error) => error instanceof PipelineTaskRunnerError && error.code === 'PROJECT_TASK_BUSY'
  );
  children[0].emit('close', null);
  const paused = await waitFor(() => runner.getTask(first.taskId), (task) => task.status === 'paused');
  assert.equal(runner.hasActiveTask('alpha'), false);
  assert.ok(paused.finishedAt);

  const second = runner.startTask({ projectId: 'beta', action: 'split' });
  await waitFor(() => runner.getTask(second.taskId), (task) => task.status === 'running');
  await runner.shutdown();
  assert.equal(runner.getTask(second.taskId).status, 'paused');
  assert.match(runner.getTask(second.taskId).log.text, /软件正在退出/u);
  assert.throws(
    () => runner.startTask({ projectId: 'gamma', action: 'split' }),
    (error) => error instanceof PipelineTaskRunnerError && error.code === 'TASK_RUNNER_STOPPING'
  );
  assert.equal(children.length, 2);
  assert.deepEqual(signals, ['SIGTERM', 'SIGTERM']);
});

test('project-idle operations reject active tasks and block new tasks until the operation finishes', async (context) => {
  const root = await makeProjectRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const children = [];
  let taskNumber = 0;
  const runner = createPipelineTaskRunner({
    resolveProjectRoot: async () => root,
    materializeProjectRuntime: async () => {},
    spawnImpl: () => {
      const child = makeChild();
      children.push(child);
      return child;
    },
    createTaskId: () => `task-project-idle-${++taskNumber}`
  });

  const active = runner.startTask({ projectId: 'alpha', action: 'split' });
  await assert.rejects(
    runner.withProjectIdle('alpha', async () => 'must not run'),
    (error) => error instanceof PipelineTaskRunnerError
      && error.status === 409
      && error.code === 'PROJECT_TASK_BUSY'
  );
  await waitFor(() => children.length, (length) => length === 1);
  children[0].emit('close', 0);
  await waitFor(() => runner.getTask(active.taskId), (task) => task.status === 'succeeded');

  let releaseOperation;
  const operationGate = new Promise((resolvePromise) => { releaseOperation = resolvePromise; });
  const operation = runner.withProjectIdle('alpha', async () => {
    await operationGate;
    return 'removed';
  });
  assert.throws(
    () => runner.startTask({ projectId: 'alpha', action: 'split' }),
    (error) => error instanceof PipelineTaskRunnerError
      && error.status === 409
      && error.code === 'PROJECT_TASK_BUSY'
  );
  releaseOperation();
  assert.equal(await operation, 'removed');
  assert.equal(runner.hasActiveTask('alpha'), false);
  await assert.rejects(
    runner.withProjectIdle('alpha', async () => { throw new Error('operation failed'); }),
    /operation failed/u
  );
  const afterFailure = runner.startTask({ projectId: 'alpha', action: 'split' });
  await waitFor(() => children.length, (length) => length === 2);
  children[1].emit('close', 0);
  await waitFor(() => runner.getTask(afterFailure.taskId), (task) => task.status === 'succeeded');
  assert.throws(() => runner.hasActiveTask('../alpha'), { code: 'INVALID_PROJECT_ID' });
});

test('spawn errors and setup errors finish as failed tasks without leaking paths', async (context) => {
  const root = await makeProjectRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const child = makeChild();
  let taskNumber = 0;
  const runner = createPipelineTaskRunner({
    resolveProjectRoot: async (projectId) => {
      if (projectId === 'missing') throw new Error(`missing at ${root}`);
      return root;
    },
    materializeProjectRuntime: async () => {},
    spawnImpl: () => child,
    createTaskId: () => `task-error-${++taskNumber}`
  });

  const processFailure = runner.startTask({ projectId: 'alpha', action: 'split' });
  await waitFor(() => runner.getTask(processFailure.taskId), (task) => task.status === 'running');
  child.emit('error', new Error(`cannot start C:\\private\\tool.exe password=hunter2 PID 7654`));
  const failed = await waitFor(() => runner.getTask(processFailure.taskId), (task) => task.status === 'failed');
  assert.equal(failed.exitCode, null);
  const serialized = JSON.stringify(failed);
  for (const forbidden of ['C:\\private', 'hunter2', '7654']) assert.equal(serialized.includes(forbidden), false);

  const setupFailure = runner.startTask({ projectId: 'missing', action: 'split' });
  const setupResult = await waitFor(() => runner.getTask(setupFailure.taskId), (task) => task.status === 'failed');
  assert.equal(JSON.stringify(setupResult).includes(root), false);
});

test('task logs are bounded and report truncation', async (context) => {
  const root = await makeProjectRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const child = makeChild();
  const runner = createPipelineTaskRunner({
    resolveProjectRoot: async () => root,
    materializeProjectRuntime: async () => {},
    spawnImpl: () => child,
    maxLogCharacters: 256,
    createTaskId: () => 'task-long-log'
  });
  const task = runner.startTask({ projectId: 'alpha', action: 'split' });
  await waitFor(() => runner.getTask(task.taskId), (value) => value.status === 'running');
  child.stdout.write('x'.repeat(10_000));
  child.emit('close', 0);
  const complete = await waitFor(() => runner.getTask(task.taskId), (value) => value.status === 'succeeded');
  assert.equal(complete.log.truncated, true);
  assert.ok(complete.log.text.startsWith('[早期日志已截断]\n'));
  assert.ok(complete.log.text.length <= 256 + '[早期日志已截断]\n'.length);
});
