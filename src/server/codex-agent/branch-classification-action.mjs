import { classificationPagePrompt } from './classify-prompt-branches.mjs';
import { parseAgentJson } from './result-validation.mjs';
import {
  publicSkillReceipt,
  verifySoftwarePipelineSkill
} from './software-skill-integrity.mjs';
import { classifyRuntimeError } from './worker-runtime.mjs';

export async function runBranchClassificationAction({
  projectRoot,
  pipelineSkill,
  signal,
  createSession,
  createSdk,
  runThread,
  resetIdleTimer,
  emitProgress,
  emit
}) {
  let session = null;
  try {
    session = await createSession(projectRoot, {
      signal,
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
      action: 'classify-prompt-branches',
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
