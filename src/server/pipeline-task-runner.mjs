import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import {
  ACTION_SPECS,
  DEFAULT_PIPELINE_SKILL_PATH,
  PIPELINE_TASK_ACTIONS
} from './pipeline-task/action-specs.mjs';
import {
  ACTIVE_STATUSES,
  DEFAULT_MAX_LOG_CHARACTERS,
  DEFAULT_MAX_RETAINED_TASKS,
  PipelineTaskRunnerError,
  assertProjectId,
  assertStartInput,
  attachOutput,
  boundedInteger,
  isoTimestamp,
  publicTask,
  safeChildEnvironment,
  samePath
} from './pipeline-task/contracts.mjs';
import {
  ANALYSIS_RESUME_ACTIONS,
  canonicalPipelineSkillPath,
  canonicalProjectRoot,
  normalizePipelineSkillPath,
  resumableAnalysisEpisode,
  resolveRuntimeFile,
  rootPathFromResolution,
  unresolvedPendingAssetCount
} from './pipeline-task/runtime-resolution.mjs';
import { readCodexRuntimeConfig } from './codex-runtime-config.mjs';

export { DEFAULT_PIPELINE_SKILL_PATH, PIPELINE_TASK_ACTIONS };
export { PipelineTaskRunnerError } from './pipeline-task/contracts.mjs';

export function createPipelineTaskRunner({
  resolveProjectRoot,
  materializeProjectRuntime,
  pipelineSkillPath = DEFAULT_PIPELINE_SKILL_PATH,
  spawnImpl = nodeSpawn,
  now = () => new Date(),
  createTaskId = () => `task-${randomUUID()}`,
  maxLogCharacters,
  maxRetainedTasks,
  readRuntimeConfig = readCodexRuntimeConfig,
  environment = process.env
} = {}) {
  if (typeof resolveProjectRoot !== 'function') throw new TypeError('resolveProjectRoot must be a function');
  if (typeof materializeProjectRuntime !== 'function') throw new TypeError('materializeProjectRuntime must be a function');
  if (typeof spawnImpl !== 'function') throw new TypeError('spawnImpl must be a function');
  if (typeof readRuntimeConfig !== 'function') throw new TypeError('readRuntimeConfig must be a function');
  if (typeof now !== 'function' || typeof createTaskId !== 'function') throw new TypeError('clock and task id factory must be functions');
  const configuredPipelineSkillPath = normalizePipelineSkillPath(pipelineSkillPath);
  const logLimit = boundedInteger(maxLogCharacters, DEFAULT_MAX_LOG_CHARACTERS, 256, 64 * 1024, 'maxLogCharacters');
  const taskLimit = boundedInteger(maxRetainedTasks, DEFAULT_MAX_RETAINED_TASKS, 8, 2048, 'maxRetainedTasks');
  const tasks = new Map();
  const activeByProject = new Map();
  const projectOperationLocks = new Set();
  let shuttingDown = false;

  const appendLog = (task, chunk) => {
    task.rawLog += String(chunk ?? '');
    const rawLimit = logLimit * 4;
    if (task.rawLog.length > rawLimit) {
      task.rawLog = task.rawLog.slice(-rawLimit);
      task.rawLogTruncated = true;
    }
  };

  const pruneFinishedTasks = () => {
    if (tasks.size < taskLimit) return;
    for (const [taskId, task] of tasks) {
      if (tasks.size < taskLimit) break;
      if (!ACTIVE_STATUSES.has(task.status)) tasks.delete(taskId);
    }
  };

  const finalize = (task, status, exitCode) => {
    if (!ACTIVE_STATUSES.has(task.status)) return;
    task.status = status;
    task.exitCode = Number.isInteger(exitCode) ? exitCode : null;
    task.finishedAt = isoTimestamp(now);
    if (activeByProject.get(task.projectId) === task.taskId) activeByProject.delete(task.projectId);
  };

  const terminateChild = (task, child) => {
    if (!child || typeof child.kill !== 'function') return;
    try {
      child.kill('SIGTERM');
    } catch (error) {
      appendLog(task, `\n任务进程未能正常停止：${error?.message || 'unknown error'}\n`);
    }
    const forceTimer = setTimeout(() => {
      if (task.child !== child) return;
      try {
        child.kill('SIGKILL');
      } catch {
        // The process may already have exited between the identity check and kill.
      }
    }, 500);
    forceTimer.unref?.();
  };

  const pauseInternal = (task, message) => {
    if (!ACTIVE_STATUSES.has(task.status)) return;
    task.pauseRequested = true;
    appendLog(task, `\n${message}\n`);
    const child = task.child;
    if (!child) finalize(task, 'paused', null);
    else task.status = 'pausing';
    terminateChild(task, child);
  };

  const executeCommand = (task, command) => {
    const commandPromise = new Promise((resolveCommand, rejectCommand) => {
      let child;
      try {
        child = spawnImpl(command.executable, command.arguments, {
          cwd: command.cwd,
          env: safeChildEnvironment(environment),
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        rejectCommand(new PipelineTaskRunnerError(
          'TASK_START_FAILED',
          `任务进程启动失败：${error?.message || 'unknown error'}`,
          { status: 503 }
        ));
        return;
      }
      if (!child || typeof child.once !== 'function') {
        rejectCommand(new PipelineTaskRunnerError('TASK_START_FAILED', '任务进程启动失败', { status: 503 }));
        return;
      }
      attachOutput(child.stdout, (chunk) => appendLog(task, chunk));
      attachOutput(child.stderr, (chunk) => appendLog(task, chunk));
      let settled = false;
      const settle = (succeeded, exitCode, error) => {
        if (settled) return;
        settled = true;
        if (error) appendLog(task, `\n${error.message || '任务进程异常'}\n`);
        resolveCommand({ succeeded, exitCode: Number.isInteger(exitCode) ? exitCode : null });
      };
      task.child = child;
      child.once('error', (error) => settle(false, null, error));
      child.once('close', (code) => settle(code === 0, code));
      if (task.status === 'queued') {
        task.status = 'running';
        task.startedAt = isoTimestamp(now);
      }
      if (task.pauseRequested) terminateChild(task, child);
    });
    task.commandPromise = commandPromise;
    return commandPromise.finally(() => {
      task.child = null;
      task.commandPromise = null;
      if (task.pauseRequested) finalize(task, 'paused', null);
    });
  };

  const run = async (task) => {
    try {
      const initialRoot = await canonicalProjectRoot(rootPathFromResolution(
        await resolveProjectRoot(task.projectId)
      ));
      await materializeProjectRuntime({ projectId: task.projectId, projectRoot: initialRoot });
      const verifiedRoot = await canonicalProjectRoot(rootPathFromResolution(
        await resolveProjectRoot(task.projectId)
      ));
      if (!samePath(initialRoot, verifiedRoot)) {
        throw new PipelineTaskRunnerError('PROJECT_ROOT_CHANGED', '项目运行目录在准备期间发生变化', { status: 409 });
      }
      task.projectRoot = verifiedRoot;
      const spec = ACTION_SPECS[task.action];
      task.runtimeConfig = spec.requiresPipelineSkill ? await readRuntimeConfig() : null;
      const runtimeFiles = [];
      for (const segments of spec.requiredFiles) {
        runtimeFiles.push(await resolveRuntimeFile(verifiedRoot, segments));
      }
      const pipelineSkill = spec.requiresPipelineSkill
        ? await canonicalPipelineSkillPath(configuredPipelineSkillPath, verifiedRoot)
        : null;
      const resumeAnalysisEpisode = ANALYSIS_RESUME_ACTIONS.has(task.action)
        ? await resumableAnalysisEpisode(verifiedRoot)
        : null;
      if (Number.isInteger(resumeAnalysisEpisode)) {
        appendLog(task, `检测到第 ${resumeAnalysisEpisode} 集分析恢复状态，跳过剧本拆分并继续逐集分析\n`);
      }
      const commands = spec.makeCommands(verifiedRoot, runtimeFiles, pipelineSkill, {
        workbookEpisodeStart: task.workbookEpisodeStart,
        workbookEpisodeEnd: task.workbookEpisodeEnd,
        workbookAssetTypes: task.workbookAssetTypes,
        runtimeConfig: task.runtimeConfig,
        resumeAnalysisEpisode
      });
      for (const command of commands) {
        if (task.pauseRequested) return;
        if (command.checkpoint === 'pending-assets') {
          const pendingCount = await unresolvedPendingAssetCount(verifiedRoot);
          if (pendingCount > 0) {
            appendLog(task, `检测到 ${pendingCount} 项待确认资产；已完成全部单集分析和世界观总览，流水线在资产设定与制表前安全等待人工确认。\n`);
            finalize(task, 'paused', null);
            return;
          }
          continue;
        }
        const result = await executeCommand(task, command);
        if (task.pauseRequested) return;
        if (!result.succeeded) {
          finalize(task, 'failed', result.exitCode);
          return;
        }
      }
      finalize(task, 'succeeded', 0);
    } catch (error) {
      if (task.pauseRequested) return;
      appendLog(task, `${error?.message || '任务准备失败'}\n`);
      finalize(task, 'failed', null);
    }
  };

  const startTask = (input) => {
    const {
      projectId, action, workbookEpisodeStart, workbookEpisodeEnd, workbookAssetTypes
    } = assertStartInput(input);
    if (shuttingDown) {
      throw new PipelineTaskRunnerError('TASK_RUNNER_STOPPING', '软件正在退出，不能启动新任务', { status: 503 });
    }
    if (activeByProject.has(projectId) || projectOperationLocks.has(projectId)) {
      throw new PipelineTaskRunnerError('PROJECT_TASK_BUSY', '该项目已有任务正在运行', { status: 409 });
    }
    pruneFinishedTasks();
    if (tasks.size >= taskLimit) {
      throw new PipelineTaskRunnerError('TASK_HISTORY_FULL', '任务记录已满，请稍后重试', { status: 503 });
    }
    const taskId = createTaskId();
    if (typeof taskId !== 'string' || !/^task-[A-Za-z0-9-]{1,80}$/u.test(taskId) || tasks.has(taskId)) {
      throw new TypeError('createTaskId() returned an invalid or duplicate task id');
    }
    const task = {
      taskId,
      projectId,
      action,
      workbookEpisodeStart,
      workbookEpisodeEnd,
      workbookAssetTypes,
      status: 'queued',
      queuedAt: isoTimestamp(now),
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      rawLog: '',
      rawLogTruncated: false,
      projectRoot: null,
      runtimeConfig: null,
      pauseRequested: false,
      child: null,
      commandPromise: null
    };
    tasks.set(taskId, task);
    activeByProject.set(projectId, taskId);
    queueMicrotask(() => void run(task));
    return publicTask(task, logLimit);
  };

  const getTask = (taskId) => {
    if (typeof taskId !== 'string' || !/^task-[A-Za-z0-9-]{1,80}$/u.test(taskId)) {
      throw new PipelineTaskRunnerError('INVALID_TASK_ID', '任务编号格式无效');
    }
    const task = tasks.get(taskId);
    if (!task) throw new PipelineTaskRunnerError('TASK_NOT_FOUND', '任务不存在', { status: 404 });
    return publicTask(task, logLimit);
  };

  const listTasks = ({ projectId } = {}) => {
    const selectedProjectId = projectId === undefined ? null : assertProjectId(projectId);
    return [...tasks.values()]
      .filter((task) => !selectedProjectId || task.projectId === selectedProjectId)
      .map((task) => publicTask(task, logLimit));
  };

  const pauseTask = async (taskId) => {
    if (typeof taskId !== 'string' || !/^task-[A-Za-z0-9-]{1,80}$/u.test(taskId)) {
      throw new PipelineTaskRunnerError('INVALID_TASK_ID', '任务编号格式无效');
    }
    const task = tasks.get(taskId);
    if (!task) throw new PipelineTaskRunnerError('TASK_NOT_FOUND', '任务不存在', { status: 404 });
    pauseInternal(task, '任务已由用户暂停');
    return publicTask(task, logLimit);
  };

  const shutdown = async ({ timeoutMs = 600 } = {}) => {
    shuttingDown = true;
    for (const task of tasks.values()) {
      pauseInternal(task, '软件正在退出，任务已安全中断');
    }
    const pending = [...tasks.values()].map((task) => task.commandPromise).filter(Boolean);
    if (pending.length) {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise((resolveTimeout) => setTimeout(resolveTimeout, timeoutMs))
      ]);
    }
    for (const task of tasks.values()) {
      if (task.child) terminateChild(task, task.child);
    }
  };

  const hasActiveTask = (projectId) => activeByProject.has(assertProjectId(projectId));

  const withProjectIdle = async (projectId, operation) => {
    const selectedProjectId = assertProjectId(projectId);
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    if (activeByProject.has(selectedProjectId) || projectOperationLocks.has(selectedProjectId)) {
      throw new PipelineTaskRunnerError('PROJECT_TASK_BUSY', '该项目已有任务正在运行', { status: 409 });
    }
    projectOperationLocks.add(selectedProjectId);
    try {
      return await operation();
    } finally {
      projectOperationLocks.delete(selectedProjectId);
    }
  };

  return Object.freeze({ startTask, getTask, listTasks, pauseTask, shutdown, hasActiveTask, withProjectIdle });
}
