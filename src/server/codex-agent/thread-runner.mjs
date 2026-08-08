import { codexThreadRuntimeOptions } from '../codex-runtime-config.mjs';
import { analysisSdkSchema } from './contracts.mjs';
import { sanitizeAgentText, workerError } from './worker-errors.mjs';
import { classifyRuntimeError, safeEventMessage } from './worker-runtime.mjs';

export function createCodexThreadRunner({
  projectRoot,
  runtimeConfig,
  signal,
  retryLimit,
  abort,
  getAbortError,
  resetIdleTimer,
  emitProgress
}) {
  return async function runThread({
    codex, prompt, outputSchema, sandboxMode, strictClassification = false, strictAnalysis = false,
    strictVisualSpec = false
  }) {
    if (getAbortError()) throw getAbortError();
    let thread;
    try {
      thread = codex.startThread({
        workingDirectory: projectRoot,
        skipGitRepoCheck: true,
        sandboxMode,
        networkAccessEnabled: false,
        webSearchMode: 'disabled',
        approvalPolicy: 'never',
        ...codexThreadRuntimeOptions(runtimeConfig ?? { model: null, reasoningEffort: null })
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
        signal
      });
    } catch (error) {
      throw classifyRuntimeError(error);
    }
    if (getAbortError()) throw getAbortError();
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
        if (getAbortError()) throw getAbortError();
        if (event?.type === 'error') {
          lastStreamError = String(event.message || 'Codex stream failed');
          networkRetryCount += 1;
          if (networkRetryCount >= retryLimit) {
            abort(
              'CODEX_NETWORK_RETRY_EXHAUSTED',
              `Codex 网络重试已达到 ${retryLimit} 次上限，任务已停止，可从当前进度继续`
            );
            throw getAbortError();
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
      if (getAbortError()) throw getAbortError();
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
}
