import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createPromptBranchClassificationSession } from './prompt-branch-classification.mjs';
import { readCodexModelLabel } from './codex-runtime-config.mjs';
import {
  nextAnalysisEpisode,
  normalizeAnalysisProgress,
  readAnalysisProgressFile,
  verifyEpisodeCommit
} from './codex-agent/analysis-progress.mjs';
import { runBranchClassificationAction } from './codex-agent/branch-classification-action.mjs';
import { visualSpecPrompt } from './codex-agent/complete-asset-visual-specs.mjs';
import { resultSchema, visualSpecResultSchema } from './codex-agent/contracts.mjs';
import { isOutside } from './codex-agent/path-safety.mjs';
import {
  commitAnalysisEpisodeDefault,
  commitWorldOverviewDefault,
  prepareAnalysisEpisodeDefault,
  runVisualSpecScriptDefault
} from './codex-agent/pipeline-bridge.mjs';
import {
  parseAgentJson,
  parseFinalResult,
  reconcileAnalysisAssetIdentities,
  validateSchemaValue
} from './codex-agent/result-validation.mjs';
import {
  publicSkillReceipt,
  SOFTWARE_EPISODE_ASSET_SKILL_PATH,
  SOFTWARE_PIPELINE_SKILL_PATH,
  inspectSoftwarePipelineSkill,
  verifySoftwarePipelineSkill
} from './codex-agent/software-skill-integrity.mjs';
import { createCodexThreadRunner } from './codex-agent/thread-runner.mjs';
import {
  CodexAgentWorkerError,
  sanitizeAgentText,
  workerError
} from './codex-agent/worker-errors.mjs';
import {
  CODEX_AGENT_ACTIONS,
  DEFAULT_TIMEOUTS,
  MAX_PROGRESS_EVENTS,
  boundedRetryLimit,
  boundedTimeout,
  canonicalProject,
  classifyRuntimeError,
  exactWorkerInput,
  loadDefaultCodex,
  promptForAction,
  promptForAnalysisEpisode
} from './codex-agent/worker-runtime.mjs';

export { readCodexModelLabel } from './codex-runtime-config.mjs';
export { CodexAgentWorkerError, sanitizeAgentText };
export { SOFTWARE_EPISODE_ASSET_SKILL_PATH, SOFTWARE_PIPELINE_SKILL_PATH };
export { reconcileAnalysisAssetIdentities };
export { CODEX_AGENT_ACTIONS };

export async function runCodexAgentAction(input, {
  createCodex = loadDefaultCodex,
  createBranchClassificationSession = createPromptBranchClassificationSession,
  readAnalysisProgress = readAnalysisProgressFile,
  prepareAnalysisEpisode = prepareAnalysisEpisodeDefault,
  commitAnalysisEpisode = commitAnalysisEpisodeDefault,
  commitWorldOverview = commitWorldOverviewDefault,
  runVisualSpecScript = runVisualSpecScriptDefault,
  resolveModelLabel = readCodexModelLabel,
  emit = (line) => process.stdout.write(`${line}\n`),
  pipelineSkillPath = SOFTWARE_PIPELINE_SKILL_PATH,
  signal = null,
  totalTimeoutMs,
  idleTimeoutMs,
  networkRetryLimit
} = {}) {
  if (typeof createCodex !== 'function' || typeof createBranchClassificationSession !== 'function'
    || typeof readAnalysisProgress !== 'function' || typeof resolveModelLabel !== 'function'
    || typeof prepareAnalysisEpisode !== 'function' || typeof commitAnalysisEpisode !== 'function'
    || typeof commitWorldOverview !== 'function'
    || typeof runVisualSpecScript !== 'function'
    || typeof emit !== 'function') {
    throw new TypeError('worker dependencies must be functions');
  }
  const request = exactWorkerInput(input);
  const projectRoot = await canonicalProject(request.projectRoot);
  const pipelineSkill = await inspectSoftwarePipelineSkill(pipelineSkillPath);
  if (!isOutside(projectRoot, pipelineSkill.path)
    || !isOutside(pipelineSkill.root, projectRoot)
    || !isOutside(projectRoot, pipelineSkill.episodeAssetSkillPath)
    || !isOutside(pipelineSkill.episodeAssetSkillRoot, projectRoot)) {
    throw workerError('PROJECT_ROOT_UNSAFE', '项目根不能与软件级 Skill 目录重叠');
  }
  const defaults = DEFAULT_TIMEOUTS[request.action];
  const totalTimeout = boundedTimeout(totalTimeoutMs, defaults.total, 'totalTimeoutMs');
  const idleTimeout = boundedTimeout(idleTimeoutMs, defaults.idle, 'idleTimeoutMs');
  const retryLimit = boundedRetryLimit(networkRetryLimit);
  const controller = new AbortController();
  let abortError = null;
  let idleTimer = null;
  let totalTimer = null;
  let externalAbort = null;
  let rejectTimeout;
  const timeoutPromise = new Promise((_, reject) => { rejectTimeout = reject; });
  const abort = (code, message) => {
    if (abortError) return;
    abortError = workerError(code, message);
    controller.abort(abortError);
    rejectTimeout(abortError);
  };
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abort('CODEX_IDLE_TIMEOUT', 'Codex Agent 长时间没有响应，任务已停止'), idleTimeout);
  };
  totalTimer = setTimeout(() => abort('CODEX_TOTAL_TIMEOUT', 'Codex Agent 超过总时限，任务已停止'), totalTimeout);
  resetIdleTimer();
  if (signal) {
    externalAbort = () => abort('CODEX_INTERRUPTED', 'Codex Agent 任务已中断');
    if (signal.aborted) externalAbort();
    else signal.addEventListener('abort', externalAbort, { once: true });
  }

  let progressEvents = 0;
  let progressTruncated = false;
  let lastProgressMessage = '';
  const emitProgress = (message) => {
    if (!message || message === lastProgressMessage) return;
    lastProgressMessage = message;
    if (progressEvents < MAX_PROGRESS_EVENTS) {
      emit(message);
      progressEvents += 1;
    } else if (!progressTruncated) {
      emit('中间进度较多，后续仅保留最终回执');
      progressTruncated = true;
    }
  };

  const createSdk = async () => {
    try {
      const codex = await createCodex();
      if (!codex || typeof codex.startThread !== 'function') {
        throw workerError('CODEX_SDK_UNAVAILABLE', 'Codex SDK 运行时不完整');
      }
      return codex;
    } catch (error) {
      throw classifyRuntimeError(error);
    }
  };

  const loadAnalysisProgress = async () => {
    try {
      return normalizeAnalysisProgress(await readAnalysisProgress(projectRoot));
    } catch (error) {
      if (error instanceof CodexAgentWorkerError) throw error;
      throw workerError('ANALYSIS_PROGRESS_UNAVAILABLE', '逐集分析进度不可用', error);
    }
  };

  const runThread = createCodexThreadRunner({
    projectRoot,
    runtimeConfig: request.runtimeConfig,
    signal: controller.signal,
    retryLimit,
    abort,
    getAbortError: () => abortError,
    resetIdleTimer,
    emitProgress
  });

  const consume = async () => {
    const modelLabel = request.runtimeConfig?.model ?? await resolveModelLabel();
    const reasoningLabel = request.runtimeConfig?.reasoningEffort;
    const runtimeLabel = reasoningLabel ? `${modelLabel} / ${reasoningLabel}` : modelLabel;
    emitProgress(request.action === 'analyze-screenplay'
      ? `分析模型：${runtimeLabel}；开始逐集分析`
      : `Codex 配置：${runtimeLabel}；开始执行`);
    if (request.action === 'analyze-screenplay') {
      let progress = await loadAnalysisProgress();
      const totalEpisodes = progress.discoveredEpisodes.length;
      let episode = nextAnalysisEpisode(progress);
      let processedCount = 0;
      let codex = null;
      while (episode !== null) {
        resetIdleTimer();
        emitProgress(`正在分析第 ${episode} 集（${progress.completedEpisodes.length + 1}/${totalEpisodes}）`);
        await prepareAnalysisEpisode({
          projectRoot,
          episode,
          resume: progress.currentEpisode === episode,
          signal: controller.signal,
          onActivity: resetIdleTimer,
          onProgress: emitProgress
        });
        if (abortError) throw abortError;
        codex ??= await createSdk();
        const finalMessage = await runThread({
          codex,
          prompt: promptForAnalysisEpisode(episode, pipelineSkill),
          outputSchema: resultSchema(request.action, episode),
          sandboxMode: 'read-only',
          strictAnalysis: true
        });
        const parsed = parseFinalResult(finalMessage, request.action, projectRoot, episode);
        if (parsed.processedCount !== 1 || parsed.analysis?.episode !== episode) {
          throw workerError('INVALID_AGENT_RESULT', `第 ${episode} 集回执必须且只能计入一集`);
        }
        await verifySoftwarePipelineSkill(pipelineSkill);
        await commitAnalysisEpisode({
          projectRoot,
          episode,
          analysis: parsed.analysis,
          signal: controller.signal,
          onActivity: resetIdleTimer,
          onProgress: emitProgress
        });
        if (abortError) throw abortError;
        const committed = await loadAnalysisProgress();
        verifyEpisodeCommit(progress, committed, episode);
        processedCount += 1;
        emitProgress(`第 ${episode} 集分析已完成并计入累计记录（${committed.completedEpisodes.length}/${totalEpisodes}）`);
        progress = committed;
        episode = nextAnalysisEpisode(progress);
      }
      const result = Object.freeze({
        completed: true,
        action: request.action,
        summary: processedCount
          ? `已逐集完成并累计 ${processedCount} 集分析`
          : `全部 ${totalEpisodes} 集分析均已完成，无需重复处理`,
        processedCount,
        softwareSkill: publicSkillReceipt(pipelineSkill)
      });
      emit(`KA_AGENT_RESULT ${JSON.stringify(result)}`);
      return result;
    }
    if (request.action === 'complete-asset-visual-specs') {
      let state = await runVisualSpecScript({
        projectRoot, command: 'start', signal: controller.signal, onActivity: resetIdleTimer
      });
      let processedCount = 0;
      let codex = null;
      emitProgress(`资产设定生成准备完成（${state.completed}/${state.total}）`);
      while (!state.done) {
        const current = await runVisualSpecScript({
          projectRoot, command: 'next', signal: controller.signal, onActivity: resetIdleTimer
        });
        if (current.done) {
          state = current;
          break;
        }
        const categoryLabel = {
          characters: '角色', creatures: '生物', extras: '群演', scenes: '场景', props: '道具'
        }[current.asset?.category];
        if (!categoryLabel || !current.asset?.assetId || !current.requestToken || !current.worldOverview) {
          throw workerError('VISUAL_SPECS_PIPELINE_FAILED', '本地脚本返回的当前资产结构无效');
        }
        emitProgress(`正在生成${categoryLabel} ${current.asset.assetId} 的资产设定（${current.completed + 1}/${current.total}）`);
        codex ??= await createSdk();
        const finalMessage = await runThread({
          codex,
          prompt: visualSpecPrompt(current),
          outputSchema: visualSpecResultSchema(current),
          sandboxMode: 'read-only',
          strictVisualSpec: true
        });
        const visualResult = parseAgentJson(finalMessage, '资产视觉规格');
        validateSchemaValue(visualResult, visualSpecResultSchema(current));
        if (!visualResult.completed) {
          throw workerError('AGENT_REPORTED_INCOMPLETE', sanitizeAgentText(visualResult.summary, projectRoot));
        }
        await verifySoftwarePipelineSkill(pipelineSkill);
        state = await runVisualSpecScript({
          projectRoot,
          command: 'commit',
          payload: {
            requestToken: visualResult.requestToken,
            assetId: visualResult.assetId,
            productionNotes: visualResult.productionNotes,
            inferenceBasis: visualResult.inferenceBasis
          },
          signal: controller.signal,
          onActivity: resetIdleTimer
        });
        processedCount += 1;
        emitProgress(`${categoryLabel} ${visualResult.assetId} 的资产设定已保存（${state.completed}/${state.total}）`);
      }
      const result = Object.freeze({
        completed: true,
        action: request.action,
        summary: processedCount
          ? `已完成 ${processedCount} 项资产视觉规格并写回累计记录`
          : '全部资产视觉规格均已完成，无需重复处理',
        processedCount,
        softwareSkill: publicSkillReceipt(pipelineSkill)
      });
      emit(`KA_AGENT_RESULT ${JSON.stringify(result)}`);
      return result;
    }
    if (request.action === 'classify-prompt-branches') {
      return runBranchClassificationAction({
        projectRoot,
        pipelineSkill,
        signal: controller.signal,
        createSession: createBranchClassificationSession,
        createSdk,
        runThread,
        resetIdleTimer,
        emitProgress,
        emit
      });
    }

    const codex = await createSdk();
    const finalMessage = await runThread({
      codex,
      prompt: promptForAction(request.action, pipelineSkill),
      outputSchema: resultSchema(request.action),
      sandboxMode: 'workspace-write'
    });
    await verifySoftwarePipelineSkill(pipelineSkill);
    const parsed = parseFinalResult(finalMessage, request.action, projectRoot);
    if (request.action === 'build-world-overview') {
      await commitWorldOverview({
        projectRoot,
        content: parsed.worldOverview,
        signal: controller.signal,
        onActivity: resetIdleTimer,
        onProgress: emitProgress
      });
    }
    const { worldOverview: _privateOverview, ...publicParsed } = parsed;
    const result = Object.freeze({
      ...publicParsed,
      softwareSkill: publicSkillReceipt(pipelineSkill)
    });
    emit(`KA_AGENT_RESULT ${JSON.stringify(result)}`);
    return result;
  };

  try {
    return await Promise.race([consume(), timeoutPromise]);
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    if (signal && externalAbort) signal.removeEventListener('abort', externalAbort);
  }
}

const cliMain = async () => {
  if (process.argv.length !== 7) {
    throw workerError('INVALID_WORKER_INPUT', 'Agent worker 只接受固定动作、项目根、软件级 Skill 路径和模型配置');
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    await runCodexAgentAction(
      {
        action: process.argv[2],
        projectRoot: process.argv[3],
        runtimeConfig: {
          model: process.argv[5] || null,
          reasoningEffort: process.argv[6] || null
        }
      },
      { signal: controller.signal, pipelineSkillPath: process.argv[4] }
    );
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
};

const isDirectExecution = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectExecution) {
  cliMain().catch((rawError) => {
    const error = classifyRuntimeError(rawError);
    const safe = {
      ok: false,
      code: error.code,
      message: sanitizeAgentText(error.message) || 'Codex Agent 任务失败'
    };
    process.stderr.write(`KA_AGENT_ERROR ${JSON.stringify(safe)}\n`);
    process.exitCode = error.code === 'CODEX_INTERRUPTED'
      ? 130
      : error.code === 'CODEX_TOTAL_TIMEOUT' || error.code === 'CODEX_IDLE_TIMEOUT'
        ? 124
        : 1;
  });
}
