import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createPromptBranchClassificationSession,
  PromptBranchClassificationError
} from './prompt-branch-classification.mjs';
import {
  codexThreadRuntimeOptions,
  normalizeCodexRuntimeSelection,
  readCodexModelLabel
} from './codex-runtime-config.mjs';
import { createCodexSdkOptions } from './codex-sdk-options.mjs';
import {
  nextAnalysisEpisode,
  normalizeAnalysisProgress,
  readAnalysisProgressFile,
  verifyEpisodeCommit
} from './codex-agent/analysis-progress.mjs';
import { analysisPrompt } from './codex-agent/analyze-screenplay.mjs';
import { worldOverviewPrompt } from './codex-agent/build-world-overview.mjs';
import {
  classificationPagePrompt,
  classificationPrompt
} from './codex-agent/classify-prompt-branches.mjs';
import { visualSpecPrompt } from './codex-agent/complete-asset-visual-specs.mjs';
import {
  analysisSdkSchema,
  resultSchema,
  visualSpecResultSchema
} from './codex-agent/contracts.mjs';
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
import {
  CodexAgentWorkerError,
  sanitizeAgentText,
  workerError
} from './codex-agent/worker-errors.mjs';

export { readCodexModelLabel } from './codex-runtime-config.mjs';
export { CodexAgentWorkerError, sanitizeAgentText };
export { SOFTWARE_EPISODE_ASSET_SKILL_PATH, SOFTWARE_PIPELINE_SKILL_PATH };
export { reconcileAnalysisAssetIdentities };

export const CODEX_AGENT_ACTIONS = Object.freeze([
  'analyze-screenplay',
  'build-world-overview',
  'complete-asset-visual-specs',
  'classify-prompt-branches'
]);

const ACTIONS = new Set(CODEX_AGENT_ACTIONS);
const MAX_PROGRESS_EVENTS = 512;
const DEFAULT_NETWORK_RETRY_LIMIT = 3;
const DEFAULT_TIMEOUTS = Object.freeze({
  'analyze-screenplay': Object.freeze({ total: 2 * 60 * 60 * 1000, idle: 8 * 60 * 1000 }),
  'build-world-overview': Object.freeze({ total: 60 * 60 * 1000, idle: 8 * 60 * 1000 }),
  'complete-asset-visual-specs': Object.freeze({ total: 2 * 60 * 60 * 1000, idle: 8 * 60 * 1000 }),
  'classify-prompt-branches': Object.freeze({ total: 2 * 60 * 60 * 1000, idle: 8 * 60 * 1000 })
});

const promptForAction = (action, pipelineSkill) => {
  if (action === 'build-world-overview') return worldOverviewPrompt(pipelineSkill.path);
  if (action === 'classify-prompt-branches') return classificationPrompt(pipelineSkill.path);
  throw workerError('SKILL_UNAVAILABLE', '软件级执行规范没有绑定到固定动作');
};

const promptForAnalysisEpisode = (episode, pipelineSkill) => analysisPrompt({
  episode,
  episodeFile: `cache/单集原文/第${String(episode).padStart(3, '0')}集.json`,
  episodeSkillPath: pipelineSkill.episodeAssetSkillPath
});

const exactInput = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw workerError('INVALID_WORKER_INPUT', 'Agent 任务输入无效');
  }
  const unknown = Object.keys(input).filter((key) => !['action', 'projectRoot', 'runtimeConfig'].includes(key));
  if (unknown.length) throw workerError('INVALID_WORKER_INPUT', 'Agent 任务包含不允许的字段');
  if (!ACTIONS.has(input.action)) throw workerError('ACTION_NOT_ALLOWED', '不允许执行该 Agent 动作');
  if (typeof input.projectRoot !== 'string' || !isAbsolute(input.projectRoot)) {
    throw workerError('INVALID_PROJECT_ROOT', 'Agent 项目根无效');
  }
  let runtimeConfig = null;
  if (input.runtimeConfig !== undefined) {
    try {
      runtimeConfig = normalizeCodexRuntimeSelection(input.runtimeConfig, { nullable: true });
    } catch (error) {
      throw workerError('INVALID_WORKER_INPUT', 'Agent 模型配置无效', error);
    }
  }
  return { action: input.action, projectRoot: resolve(input.projectRoot), runtimeConfig };
};

const canonicalProject = async (candidate) => {
  let info;
  let canonical;
  try {
    info = await lstat(candidate);
    canonical = await realpath(candidate);
  } catch (error) {
    throw workerError('PROJECT_ROOT_UNAVAILABLE', 'Agent 项目根不可用', error);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw workerError('PROJECT_ROOT_UNSAFE', 'Agent 项目根不是安全的普通目录');
  }
  return canonical;
};

const boundedTimeout = (value, fallback, label) => {
  const timeout = value ?? fallback;
  if (!Number.isInteger(timeout) || timeout < 10 || timeout > 24 * 60 * 60 * 1000) {
    throw new TypeError(`${label} must be an integer from 10 through 86400000`);
  }
  return timeout;
};

const boundedRetryLimit = (value) => {
  const limit = value ?? DEFAULT_NETWORK_RETRY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new TypeError('networkRetryLimit must be an integer from 1 through 10');
  }
  return limit;
};

const loadDefaultCodex = async () => {
  let module;
  try {
    module = await import('@openai/codex-sdk');
  } catch (error) {
    throw workerError('CODEX_SDK_UNAVAILABLE', 'Codex SDK 未安装或无法载入', error);
  }
  if (typeof module.Codex !== 'function') {
    throw workerError('CODEX_SDK_UNAVAILABLE', 'Codex SDK 运行时不完整');
  }
  try {
    return new module.Codex(createCodexSdkOptions());
  } catch (error) {
    throw workerError('CODEX_RUNTIME_UNAVAILABLE', 'Codex 本地运行时不可用', error);
  }
};

const classifyRuntimeError = (error) => {
  if (error instanceof CodexAgentWorkerError) return error;
  if (error instanceof PromptBranchClassificationError) return workerError(error.code, error.message, error);
  const message = String(error?.message || 'Codex Agent 运行失败');
  if (/auth|log[ -]?in|sign[ -]?in|unauthori[sz]ed|forbidden|\b401\b|\b403\b/iu.test(message)) {
    return workerError('CODEX_AUTH_UNAVAILABLE', 'Codex 尚未登录或认证不可用', error);
  }
  if (/spawn|executable|binary|runtime|ENOENT/iu.test(message)) {
    return workerError('CODEX_RUNTIME_UNAVAILABLE', 'Codex 本地运行时不可用', error);
  }
  return workerError('CODEX_AGENT_FAILED', 'Codex Agent 执行失败', error);
};

const safeEventMessage = (event) => {
  if (event?.type === 'thread.started') return 'Codex Agent 新会话已建立';
  if (event?.type === 'turn.started') return 'Codex Agent 已开始执行固定动作';
  if (event?.type === 'turn.completed') return 'Codex Agent 已完成本轮执行';
  if (event?.type !== 'item.completed') return null;
  const item = event.item;
  if (item?.type === 'command_execution') {
    if (item.status === 'failed') return '正式流水线命令执行失败';
    const command = String(item.command || '');
    if (/update_analysis_progress\.mjs/iu.test(command)) return '当前集分析进度已更新';
    if (/query_asset_records\.py/iu.test(command)) return '当前集候选资产记录已读取';
    if (/sync_episode_analysis\.py/iu.test(command)) return '当前集分析结果已累计保存';
    if (/page_world_records\.py/iu.test(command)) return '世界观事实分页已读取';
    if (/finalize_world_overview\.py/iu.test(command)) return '世界观总览已完成正式校验';
    return null;
  }
  if (item?.type === 'file_change') {
    const count = Array.isArray(item.changes) ? item.changes.length : 0;
    return `项目状态文件已更新（${Math.min(count, 999)} 项）`;
  }
  if (item?.type === 'mcp_tool_call') {
    return item.status === 'failed' ? '必需工具调用失败' : '必需工具调用已完成';
  }
  if (item?.type === 'error') return 'Codex Agent 报告执行错误';
  return null;
};

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
  const request = exactInput(input);
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

  const runThread = async ({
    codex, prompt, outputSchema, sandboxMode, strictClassification = false, strictAnalysis = false,
    strictVisualSpec = false
  }) => {
    if (abortError) throw abortError;
    let thread;
    try {
      thread = codex.startThread({
        workingDirectory: projectRoot,
        skipGitRepoCheck: true,
        sandboxMode,
        networkAccessEnabled: false,
        webSearchMode: 'disabled',
        approvalPolicy: 'never',
        ...codexThreadRuntimeOptions(request.runtimeConfig ?? { model: null, reasoningEffort: null })
      });
    } catch (error) {
      throw classifyRuntimeError(error);
    }
    if (!thread || typeof thread.runStreamed !== 'function') {
      throw workerError('CODEX_SDK_UNAVAILABLE', 'Codex SDK thread 不可用');
    }
    let streamed;
    try {
      streamed = await thread.runStreamed(prompt, {
        outputSchema: strictAnalysis || strictVisualSpec ? analysisSdkSchema(outputSchema) : outputSchema,
        signal: controller.signal
      });
    } catch (error) {
      throw classifyRuntimeError(error);
    }
    if (abortError) throw abortError;
    if (!streamed?.events || typeof streamed.events[Symbol.asyncIterator] !== 'function') {
      throw workerError('CODEX_SDK_UNAVAILABLE', 'Codex SDK 未返回事件流');
    }
    let finalMessage = '';
    let turnCompleted = false;
    let lastStreamError = '';
    let lastItemError = '';
    let lastAnalysisCommandError = '';
    let networkRetryCount = 0;
    try {
      for await (const event of streamed.events) {
        if (abortError) throw abortError;
        if (event?.type === 'error') {
          lastStreamError = String(event.message || 'Codex stream failed');
          networkRetryCount += 1;
          if (networkRetryCount >= retryLimit) {
            abort(
              'CODEX_NETWORK_RETRY_EXHAUSTED',
              `Codex 网络重试已达到 ${retryLimit} 次上限，任务已停止，可从当前进度继续`
            );
            throw abortError;
          }
          emitProgress(`Codex Agent 连接短暂中断，正在自动重试（${networkRetryCount}/${retryLimit}）`);
          continue;
        }
        resetIdleTimer();
        if (event?.type === 'reasoning' || event?.item?.type === 'reasoning') continue;
        if (event?.type === 'item.completed' && event.item?.type === 'agent_message') {
          finalMessage = event.item.text;
          continue;
        }
        if ((strictClassification || strictAnalysis || strictVisualSpec) && event?.item?.type === 'file_change') {
          throw workerError(
            strictClassification ? 'CLASSIFICATION_WRITE_ATTEMPT'
              : strictVisualSpec ? 'VISUAL_SPECS_WRITE_ATTEMPT' : 'ANALYSIS_WRITE_ATTEMPT',
            strictClassification ? '提示词分支分类 Agent 不允许直接修改项目文件'
              : strictVisualSpec ? '资产视觉规格 Agent 不允许直接修改项目文件'
                : '单集分析 Agent 不允许直接修改项目文件'
          );
        }
        if ((strictClassification || strictAnalysis || strictVisualSpec)
          && (event?.item?.type === 'mcp_tool_call' || event?.item?.type === 'web_search')) {
          throw workerError(
            strictClassification ? 'CLASSIFICATION_TOOL_ATTEMPT'
              : strictVisualSpec ? 'VISUAL_SPECS_TOOL_ATTEMPT' : 'ANALYSIS_EXTERNAL_TOOL_ATTEMPT',
            strictClassification ? '提示词分支分类 Agent 不允许调用外部工具'
              : strictVisualSpec ? '资产视觉规格 Agent 不允许调用外部工具'
                : '单集分析 Agent 不允许调用外部工具'
          );
        }
        if (strictVisualSpec && event?.item?.type === 'command_execution') {
          throw workerError('VISUAL_SPECS_COMMAND_ATTEMPT', '资产视觉规格 Agent 不允许执行命令');
        }
        if (strictAnalysis && event?.item?.type === 'command_execution' && event.item.status === 'failed') {
          const exitCode = Number.isInteger(event.item.exit_code) ? `（退出码 ${event.item.exit_code}）` : '';
          const detail = sanitizeAgentText(event.item.aggregated_output, projectRoot)
            .replace(/\s+/gu, ' ')
            .slice(0, 240);
          const command = sanitizeAgentText(event.item.command, projectRoot)
            .replace(/\s+/gu, ' ')
            .slice(0, 160);
          lastAnalysisCommandError = `单集分析只读查询命令执行失败${exitCode}`
            + `${command ? `；命令：${command}` : ''}`
            + `${detail ? `；输出：${detail}` : ''}`;
          emitProgress(`Codex Agent 只读命令失败，正在尝试恢复：${lastAnalysisCommandError}`);
          continue;
        }
        if (strictAnalysis && event?.item?.type === 'error') {
          lastItemError = sanitizeAgentText(event.item.message, projectRoot).slice(0, 240)
            || 'SDK 报告了未提供详情的非致命提示';
          emitProgress(`Codex Agent 非致命提示：${lastItemError}`);
          continue;
        }
        if (
          strictClassification
          && event?.item?.type === 'command_execution'
          && /(?:get_next_image_job|update_image_progress|build_image_queue|image[_ -]?gen)/iu.test(event.item.command || '')
        ) {
          throw workerError('CLASSIFICATION_COMMAND_REJECTED', '提示词分支分类 Agent 尝试执行受保护的生产命令');
        }
        if (event?.type === 'turn.failed') {
          throw new Error(event.error?.message || 'Codex turn failed');
        }
        if (event?.type === 'turn.completed') turnCompleted = true;
        emitProgress(safeEventMessage(event));
      }
    } catch (error) {
      if (abortError) throw abortError;
      throw classifyRuntimeError(error);
    }
    if (!turnCompleted) {
      if (lastStreamError) throw classifyRuntimeError(new Error(lastStreamError));
      throw workerError('CODEX_AGENT_FAILED', 'Codex Agent 未正常结束');
    }
    if (!finalMessage && strictAnalysis && lastAnalysisCommandError) {
      throw workerError('ANALYSIS_READ_COMMAND_FAILED', lastAnalysisCommandError);
    }
    if (!finalMessage && strictAnalysis && lastItemError) {
      throw workerError('ANALYSIS_AGENT_ERROR', `单集分析未返回完成回执：${lastItemError}`);
    }
    return finalMessage;
  };

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
      let session = null;
      try {
        session = await createBranchClassificationSession(projectRoot, {
          signal: controller.signal,
          onProgress: (message) => {
            resetIdleTimer();
            emitProgress(message);
          }
        });
        const pageResults = [];
        if (session.pages.length) {
          const codex = await createSdk();
          for (const page of session.pages) {
            resetIdleTimer();
            emitProgress(`正在判断提示词分支（第 ${page.page}/${session.pages.length} 页）`);
            const finalMessage = await runThread({
              codex,
              prompt: classificationPagePrompt(page, pipelineSkill.path),
              outputSchema: page.outputSchema,
              sandboxMode: 'read-only',
              strictClassification: true
            });
            pageResults.push(session.validatePageResult(
              page,
              parseAgentJson(finalMessage, '提示词分支分类')
            ));
          }
        } else {
          emitProgress('当前没有适用的条件分支，正在生成逐项空选择');
        }
        await verifySoftwarePipelineSkill(pipelineSkill);
        const committed = await session.commit(pageResults);
        const result = Object.freeze({
          completed: true,
          action: request.action,
          summary: committed.semanticPageCount
            ? `已完成 ${committed.processedCount} 项提示词分支判断并重建最终队列`
            : `已为 ${committed.processedCount} 个队列项写入空分支选择并重建最终队列`,
          processedCount: committed.processedCount,
          softwareSkill: publicSkillReceipt(pipelineSkill)
        });
        emit(`KA_AGENT_RESULT ${JSON.stringify(result)}`);
        return result;
      } catch (error) {
        await session?.rollback?.().catch((rollbackError) => {
          throw new AggregateError([error, rollbackError], '提示词分支分类失败且回滚失败');
        });
        throw classifyRuntimeError(error);
      }
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
