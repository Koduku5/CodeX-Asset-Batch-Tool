import {
  MAX_IMAGE_ATTEMPTS,
  attemptEntryFor,
  builtinSheetIsEnabled,
  cleanText,
  isObject,
  normalizeAttemptLedger,
  readStableFileSnapshot
} from '../pipeline_runtime.mjs';
import { makeClaimSelectionBinding } from './claim-contracts.mjs';

export async function selectNextImageJob({
  queue,
  onlyKey,
  builtinPromptBatch,
  builtinPromptSpecByKey,
  builtinPromptFingerprintByKey,
  progress,
  generationQuota,
  resolveImageOutput,
  validPngFile
}) {
  let completed = 0;
  let blocked = 0;
  let notSelected = 0;
  let unconfigured = 0;
  let limited = 0;
  let selected = null;
  for (const item of queue.items) {
    if (onlyKey && item.key !== onlyKey) continue;
    if (!builtinSheetIsEnabled(builtinPromptBatch, item)) {
      if (onlyKey) {
        throw new Error(`指定任务所属类型未勾选：${item.sheetName}；请在风格路由窗口勾选后再试`);
      }
      notSelected += 1;
      continue;
    }
    if (builtinPromptSpecByKey.get(item.key)?.status !== 'configured') {
      if (onlyKey) throw new Error(`指定任务的提示词路由待配置：${item.sheetName}`);
      unconfigured += 1;
      continue;
    }
    const rawPrior = progress.items[item.key];
    const builtinPromptFingerprint = builtinPromptFingerprintByKey.get(item.key);
    const attemptLedger = normalizeAttemptLedger(rawPrior);
    const builtinAttempt = attemptEntryFor(attemptLedger, 'builtin', builtinPromptFingerprint);
    attemptLedger.builtin = builtinAttempt;
    const priorMatches =
      isObject(rawPrior)
      && (rawPrior.backend === 'builtin'
        ? cleanText(rawPrior.assetFingerprint)
          ? rawPrior.assetFingerprint === item.assetFingerprint
            && rawPrior.builtinPromptFingerprint === builtinPromptFingerprint
          : rawPrior.status === 'completed'
            && rawPrior.inputFingerprint === item.inputFingerprint
        : rawPrior.inputFingerprint === item.inputFingerprint);
    const prior =
      priorMatches && !(rawPrior.backend === 'api' && rawPrior.status === 'failed')
        ? rawPrior
        : {};
    const queueOutput = resolveImageOutput(item.outputPath);
    let recordedOutputMatches = false;
    if (cleanText(prior.outputPath)) {
      try {
        recordedOutputMatches =
          resolveImageOutput(prior.outputPath).absolute.toLowerCase()
          === queueOutput.absolute.toLowerCase();
      } catch {
        recordedOutputMatches = false;
      }
    }
    const outputValid = recordedOutputMatches ? await validPngFile(queueOutput.absolute) : false;
    if (prior.status === 'completed' && outputValid) {
      completed += 1;
      continue;
    }
    const alreadyClaimedThisSession = generationQuota.claimedKeys.has(item.key);
    if (generationQuota.limitReached && !alreadyClaimedThisSession) {
      limited += 1;
      continue;
    }
    const unboundOutput = await readStableFileSnapshot(queueOutput.absolute);
    if (unboundOutput.exists) {
      throw new Error(
        `目标位置已有未被当前完成状态绑定的文件，禁止覆盖：${queueOutput.relative}；请先移动或备份该文件`
      );
    }
    const attempts = builtinAttempt.attempts;
    const matchingBuiltinTerminal = prior.backend === 'builtin' && prior.terminal === true;
    if (matchingBuiltinTerminal || attempts >= MAX_IMAGE_ATTEMPTS) {
      blocked += 1;
      continue;
    }
    if (!selected) {
      selected = {
        item,
        prior,
        outputValid,
        attemptLedger,
        builtinAttempt,
        claimSelectionBinding: makeClaimSelectionBinding(
          progress,
          item,
          builtinPromptFingerprint
        )
      };
    }
  }
  return Object.freeze({ selected, completed, blocked, notSelected, unconfigured, limited });
}
