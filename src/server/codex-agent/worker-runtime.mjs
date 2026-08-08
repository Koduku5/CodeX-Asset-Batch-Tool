import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { PromptBranchClassificationError } from '../prompt-branch-classification.mjs';
import { normalizeCodexRuntimeSelection } from '../codex-runtime-config.mjs';
import { createCodexSdkOptions } from '../codex-sdk-options.mjs';
import { analysisPrompt } from './analyze-screenplay.mjs';
import { worldOverviewPrompt } from './build-world-overview.mjs';
import { classificationPrompt } from './classify-prompt-branches.mjs';
import { CodexAgentWorkerError, workerError } from './worker-errors.mjs';

export const CODEX_AGENT_ACTIONS = Object.freeze([
  'analyze-screenplay',
  'build-world-overview',
  'complete-asset-visual-specs',
  'classify-prompt-branches'
]);
const ACTIONS = new Set(CODEX_AGENT_ACTIONS);
export const MAX_PROGRESS_EVENTS = 512;
const DEFAULT_NETWORK_RETRY_LIMIT = 3;
export const DEFAULT_TIMEOUTS = Object.freeze({
  'analyze-screenplay': Object.freeze({ total: 2 * 60 * 60 * 1000, idle: 8 * 60 * 1000 }),
  'build-world-overview': Object.freeze({ total: 60 * 60 * 1000, idle: 8 * 60 * 1000 }),
  'complete-asset-visual-specs': Object.freeze({ total: 2 * 60 * 60 * 1000, idle: 8 * 60 * 1000 }),
  'classify-prompt-branches': Object.freeze({ total: 2 * 60 * 60 * 1000, idle: 8 * 60 * 1000 })
});

export const promptForAction = (action, pipelineSkill) => {
  if (action === 'build-world-overview') return worldOverviewPrompt(pipelineSkill.path);
  if (action === 'classify-prompt-branches') return classificationPrompt(pipelineSkill.path);
  throw workerError('SKILL_UNAVAILABLE', '软件级执行规范没有绑定到固定动作');
};

export const promptForAnalysisEpisode = (episode, pipelineSkill) => analysisPrompt({
  episode,
  episodeFile: `cache/单集原文/第${String(episode).padStart(3, '0')}集.json`,
  episodeSkillPath: pipelineSkill.episodeAssetSkillPath
});

export const exactWorkerInput = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw workerError('INVALID_WORKER_INPUT', 'Agent 任务输入无效');
  }
  const unknown = Object.keys(input).filter(
    (key) => !['action', 'projectRoot', 'runtimeConfig'].includes(key)
  );
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
  return {
    action: input.action,
    projectRoot: resolve(input.projectRoot),
    runtimeConfig
  };
};

export const canonicalProject = async (candidate) => {
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

export const boundedTimeout = (value, fallback, label) => {
  const timeout = value ?? fallback;
  if (!Number.isInteger(timeout) || timeout < 10 || timeout > 24 * 60 * 60 * 1000) {
    throw new TypeError(`${label} must be an integer from 10 through 86400000`);
  }
  return timeout;
};

export const boundedRetryLimit = (value) => {
  const limit = value ?? DEFAULT_NETWORK_RETRY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new TypeError('networkRetryLimit must be an integer from 1 through 10');
  }
  return limit;
};

export const loadDefaultCodex = async () => {
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

export const classifyRuntimeError = (error) => {
  if (error instanceof CodexAgentWorkerError) return error;
  if (error instanceof PromptBranchClassificationError) {
    return workerError(error.code, error.message, error);
  }
  const message = String(error?.message || 'Codex Agent 运行失败');
  if (/auth|log[ -]?in|sign[ -]?in|unauthori[sz]ed|forbidden|\b401\b|\b403\b/iu.test(message)) {
    return workerError('CODEX_AUTH_UNAVAILABLE', 'Codex 尚未登录或认证不可用', error);
  }
  if (/spawn|executable|binary|runtime|ENOENT/iu.test(message)) {
    return workerError('CODEX_RUNTIME_UNAVAILABLE', 'Codex 本地运行时不可用', error);
  }
  return workerError('CODEX_AGENT_FAILED', 'Codex Agent 执行失败', error);
};

export const safeEventMessage = (event) => {
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
