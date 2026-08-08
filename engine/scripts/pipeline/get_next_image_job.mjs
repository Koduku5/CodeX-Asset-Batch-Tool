import fs from "node:fs/promises";
import path from "node:path";
import {
  acquirePipelineLock,
  assertSafeOutputPath,
  canonicalSha256,
  cleanText,
  getBuiltinGenerationQuotaState,
  isObject,
  normalizeAttemptLedger,
  readJsonFile,
  readStableFileSnapshot,
  readValidatedPngInfo,
  releasePipelineLock,
  resolveImageOutputPath,
  writeJsonAtomic,
} from "../lib/pipeline_runtime.mjs";
import { loadImageJobQueueContext } from "../lib/image-job/queue-context.mjs";
import { recoverImageJobState } from "../lib/image-job/claim-recovery.mjs";
import { selectNextImageJob } from "../lib/image-job/job-selection.mjs";
import { makeClaimSelectionBinding } from "../lib/image-job/claim-contracts.mjs";


const maybeInjectCrash = (point) => {
  if (
    process.env.NODE_ENV === "test" &&
    cleanText(process.env.KA_PIPELINE_TEST_FAULT) === point
  ) {
    process.exit(86);
  }
};

const maybeInjectReleaseFailure = (point) => {
  if (
    process.env.NODE_ENV === "test" &&
    cleanText(process.env.KA_PIPELINE_TEST_FAULT) === point
  ) {
    const error = new Error(`测试注入锁释放失败：${point}`);
    error.code = "TEST_RELEASE_FAILURE";
    throw error;
  }
};

const maybeWaitBeforeClaimLock = async () => {
  if (
    process.env.NODE_ENV !== "test" ||
    cleanText(process.env.KA_PIPELINE_TEST_FAULT) !== "wait_before_claim_lock"
  ) {
    return;
  }
  const signalPath = cleanText(process.env.KA_PIPELINE_TEST_RACE_SIGNAL);
  const continuePath = cleanText(process.env.KA_PIPELINE_TEST_RACE_CONTINUE);
  if (!signalPath || !continuePath) {
    throw new Error("并发 claim 测试缺少同步文件路径");
  }
  await fs.writeFile(signalPath, "ready\n", { encoding: "utf8", flag: "wx" });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ready = await fs.stat(continuePath).then(() => true).catch((error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("并发 claim 测试等待继续信号超时");
};

const args = process.argv.slice(2);
const validResumeArgs = args.length === 2 && args[1] === "--resume";
const validOnlyKeyArgs =
  args.length === 3 && args[1] === "--only-key" && cleanText(args[2]);
if (!(args.length === 1 || validResumeArgs || validOnlyKeyArgs)) {
  throw new Error(
    "用法：node get_next_image_job.mjs <skill-root> [--resume | --only-key <queue-key>]",
  );
}

const skillRoot = path.resolve(args[0]);
const resume = validResumeArgs;
const onlyKey = validOnlyKeyArgs ? cleanText(args[2]) : "";
const cacheDir = path.join(skillRoot, "cache");
const queuePath = path.join(cacheDir, "出图队列.json");
const progressPath = path.join(cacheDir, "出图进度.json");
const builtinReferenceRoot = path.join(cacheDir, "内置参考图");
const pendingPath = path.join(cacheDir, "待确认记录.json");
const lockPath = path.join(cacheDir, ".pipeline.lock");
const builtinDefinitionPath = path.join(
  skillRoot,
  "assets",
  "图片生成",
  "内置imagegen字段.json",
);
const imageOutputRoot = path.join(skillRoot, "输出", "资产图");

const resolveImageOutput = (relativePath) =>
  resolveImageOutputPath(skillRoot, imageOutputRoot, relativePath);

const validPngFile = async (filePath) => {
  return Boolean(await readValidatedPngInfo(filePath));
};

const readOutputBaseline = readStableFileSnapshot;

const printLockError = (lock) => {
  console.log(
    JSON.stringify(
      {
        done: false,
        error: {
          code: "PIPELINE_LOCKED",
          message: `已有流水线任务进行中：${lock?.kind ?? "unknown"}:${lock?.key ?? "unknown"}`,
        },
        lock: lock
          ? {
              kind: lock.kind,
              key: lock.key,
              inputFingerprint: lock.inputFingerprint ?? "",
              createdAt: lock.createdAt ?? "",
            }
          : null,
      },
      null,
      2,
    ),
  );
  process.exitCode = 2;
};

const main = async () => {
  const {
    queue,
    queueKeys,
    itemByKey,
    builtinPromptBatch,
    builtinConfigFingerprint,
    builtinPromptSpecByKey,
    builtinPromptFingerprintByKey,
    referencePathsByKey,
  } = await loadImageJobQueueContext({
    skillRoot,
    onlyKey,
    queuePath,
    pendingPath,
    builtinDefinitionPath,
    builtinReferenceRoot,
    imageOutputRoot,
    resolveImageOutput,
  });

  const progress = await readJsonFile(progressPath, {
    fallback: { version: 3, items: {} },
    label: "出图进度",
    retries: 2,
  });
  if (!isObject(progress)) throw new Error("出图进度顶层必须是对象");
  if (!isObject(progress.items)) throw new Error("出图进度 items 必须是对象");

  const generationQuota = getBuiltinGenerationQuotaState(
    builtinPromptBatch,
    progress.items,
    queueKeys,
  );
  const quotaDetails = (claimed = generationQuota.claimed) => ({
    generationLimit: generationQuota.generationLimit,
    generationClaimed: claimed,
    generationRemaining:
      generationQuota.generationLimit === 0
        ? null
        : Math.max(0, generationQuota.generationLimit - claimed),
  });

  const makeJob = (item, prior, details = {}) => {
    return {
      key: item.key,
      sheetName: item.sheetName,
      rowNumber: item.rowNumber,
      assetId: item.assetId,
      assetName: item.assetName,
      productionNotes: item.productionNotes,
      promptSpec: builtinPromptSpecByKey.get(item.key),
      referenceImages: referencePathsByKey.get(item.key) ?? [],
      builtinPromptFingerprint: builtinPromptFingerprintByKey.get(item.key),
      outputPath: item.outputPath,
      assetFingerprint: item.assetFingerprint,
      inputFingerprint: item.inputFingerprint,
      previousStatus: prior.status ?? "pending",
      attempts: Number.isInteger(prior.attempts) ? prior.attempts : 0,
      ...details,
    };
  };

  const recovery = await recoverImageJobState({
    resume,
    lockPath,
    progressPath,
    progress,
    queue,
    itemByKey,
    builtinPromptFingerprintByKey,
    builtinConfigFingerprint,
    resolveImageOutput,
    readOutputBaseline,
    maybeInjectCrash,
    maybeInjectReleaseFailure,
    printLockError,
    quotaDetails,
    makeJob,
  });
  if (recovery.terminal) return;

  const activeApiEntry = Object.entries(progress.items).find(
    ([, state]) =>
      isObject(state) && state.backend === "api" && state.status === "generating",
  );
  if (activeApiEntry) {
    throw new Error(
      `API 任务仍未进入终态：${activeApiEntry[0]}；请运行 batch_generate_images.py 继续查询，禁止切换到内置出图`,
    );
  }

  const {
    selected,
    completed,
    blocked,
    notSelected,
    unconfigured,
    limited,
  } = await selectNextImageJob({
    queue,
    onlyKey,
    builtinPromptBatch,
    builtinPromptSpecByKey,
    builtinPromptFingerprintByKey,
    progress,
    generationQuota,
    resolveImageOutput,
    validPngFile,
  });

  if (!selected) {
    console.log(
      JSON.stringify(
        {
          done: true,
          total: onlyKey ? 1 : queue.items.length,
          completed,
          failedAfterRetry: blocked,
          notSelected,
          unconfigured,
          limited,
          limitReached: generationQuota.limitReached && limited > 0,
          ...quotaDetails(),
          requestedKey: onlyKey || undefined,
        },
        null,
        2,
      ),
    );
    return;
  }

  const {
    item,
    prior,
    outputValid,
    attemptLedger,
    builtinAttempt,
    claimSelectionBinding,
  } = selected;
  const builtinPromptFingerprint = builtinPromptFingerprintByKey.get(item.key);
  await maybeWaitBeforeClaimLock();
  let claim;
  try {
    claim = await acquirePipelineLock(lockPath, {
      kind: "image_generation",
      key: item.key,
      inputFingerprint: item.inputFingerprint,
      assetFingerprint: item.assetFingerprint,
      builtinPromptFingerprint,
      transition: "claim_pending",
      configFingerprint: builtinConfigFingerprint,
      queueFingerprint: queue.routingFingerprint,
      leaseMode: "durable",
    });
  } catch (error) {
    if (error?.code === "PIPELINE_LOCKED") {
      printLockError(error.lock);
      return;
    }
    throw error;
  }

  let lockedProgress;
  try {
    lockedProgress = await readJsonFile(progressPath, {
      label: "出图进度",
      retries: 2,
    });
    const lockedBinding = makeClaimSelectionBinding(
      lockedProgress,
      item,
      builtinPromptFingerprint,
    );
    if (
      canonicalSha256(lockedBinding) !==
      canonicalSha256(claimSelectionBinding)
    ) {
      const error = new Error(
        `任务 ${item.key} 的出图进度在锁外选择后发生变化，已拒绝旧 claim；请重新运行`,
      );
      error.code = "CLAIM_PROGRESS_CHANGED";
      throw error;
    }
  } catch (error) {
    try {
      await releasePipelineLock(lockPath, { token: claim.token });
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        `任务 ${item.key} 的 claim 状态复核失败，且本次锁释放失败；禁止覆盖进度`,
      );
    }
    throw error;
  }
  progress.version = lockedProgress.version;
  progress.routingFingerprint = lockedProgress.routingFingerprint;
  progress.items = lockedProgress.items;

  const preClaimAttemptLedger = normalizeAttemptLedger({ attemptLedger });
  let markerCommitted = false;
  let generatingCommitted = false;
  let preserveClaimLock = false;
  try {
    maybeInjectCrash("after_claim_lock");
    const queueOutput = resolveImageOutput(item.outputPath);
    let outputBaseline;
    try {
      await assertSafeOutputPath(imageOutputRoot, queueOutput.absolute);
      outputBaseline = await readOutputBaseline(queueOutput.absolute);
    } catch (error) {
      preserveClaimLock = true;
      throw error;
    }
    if (outputBaseline.exists) {
      preserveClaimLock = true;
      throw new Error(
        `获取锁后目标文件已经出现，已保留锁且禁止覆盖：${queueOutput.relative}`,
      );
    }

    const previousAttempts = builtinAttempt.attempts;
    const claimedAt = new Date().toISOString();
    const alreadyClaimedThisSession = generationQuota.claimedKeys.has(item.key);
    const generationClaimed = generationQuota.claimed + (alreadyClaimedThisSession ? 0 : 1);
    // The lock already carries claim_pending for the pre-marker crash window. This
    // progress marker preserves the uncharged ledger; generating is the sole commit
    // point that increments attempts and consumes this session's quota.
    progress.version = 3;
    progress.routingFingerprint = queue.routingFingerprint;
    progress.items[item.key] = {
      transition: "claim_pending",
      transitionToken: claim.token,
      key: item.key,
      backend: "builtin",
      inputFingerprint: item.inputFingerprint,
      assetFingerprint: item.assetFingerprint,
      builtinPromptFingerprint,
      configFingerprint: builtinConfigFingerprint,
      queueFingerprint: queue.routingFingerprint,
      outputPath: queueOutput.relative,
      updatedAt: claimedAt,
      attemptLedger: preClaimAttemptLedger,
    };
    await writeJsonAtomic(progressPath, progress);
    markerCommitted = true;
    maybeInjectCrash("after_claim_marker");

    attemptLedger.builtin = {
      ...builtinAttempt,
      attempts: previousAttempts + 1,
      updatedAt: claimedAt,
    };
    progress.items[item.key] = {
      status: "generating",
      backend: "builtin",
      attempts: previousAttempts + 1,
      outputPath: queueOutput.relative,
      error: "",
      updatedAt: claimedAt,
      inputFingerprint: item.inputFingerprint,
      assetFingerprint: item.assetFingerprint,
      builtinPromptFingerprint,
      builtinGenerationSession: generationQuota.generationSession,
      outputBaseline,
      attemptLedger,
    };
    await writeJsonAtomic(progressPath, progress);
    generatingCommitted = true;
    maybeInjectCrash("after_generating_commit");

    console.log(
      JSON.stringify(
        {
          done: false,
          resumed: false,
          total: onlyKey ? 1 : queue.items.length,
          completed,
          failedAfterRetry: blocked,
          notSelected,
          unconfigured,
          ...quotaDetails(generationClaimed),
          requestedKey: onlyKey || undefined,
          job: makeJob(item, prior, {
            claimed: true,
            attempts: previousAttempts + 1,
            outputExists: outputValid,
            outputBaseline,
          }),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    if (preserveClaimLock || generatingCommitted) throw error;

    const cleanupErrors = [];
    if (markerCommitted) {
      progress.version = 3;
      progress.routingFingerprint = queue.routingFingerprint;
      progress.items[item.key] = { attemptLedger: preClaimAttemptLedger };
      try {
        await writeJsonAtomic(progressPath, progress);
      } catch (rollbackError) {
        cleanupErrors.push(rollbackError);
      }
    }
    if (cleanupErrors.length === 0) {
      try {
        await releasePipelineLock(lockPath, { token: claim.token });
      } catch (releaseError) {
        cleanupErrors.push(releaseError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `任务 ${item.key} claim 失败，回滚或锁释放未完成；已保留可恢复状态`,
      );
    }
    throw error;
  }
};

await main();
