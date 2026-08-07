import fs from "node:fs/promises";
import path from "node:path";
import {
  ASSET_ID_PATTERNS,
  IMAGE_BACKENDS,
  MAX_IMAGE_ATTEMPTS,
  PIPELINE_LOCK_PROTOCOL_VERSION,
  acquirePipelineLock,
  assertConditionMatchingQueueCurrent,
  assertSafeOutputPath,
  attemptEntryFor,
  builtinPromptBatchMatchesCatalog,
  builtinSheetIsEnabled,
  canonicalSha256,
  cleanText,
  getBuiltinGenerationQuotaState,
  isObject,
  isPathWithinOrSame,
  makeAssetFingerprint,
  makeBuiltinPromptFingerprint,
  makeBuiltinPromptSpec,
  normalizeAttemptLedger,
  parseJsonText,
  readJsonFile,
  readPipelineLock,
  readStableFileSnapshot,
  readValidatedReferenceImageInfo,
  readValidatedPngInfo,
  releasePipelineLock,
  resolveImageOutputPath,
  sha256,
  validateBuiltinPromptBatch,
  validateBuiltinPromptDefinition,
  writeJsonAtomic,
} from "../lib/pipeline_runtime.mjs";

const BUILTIN_TRANSITIONS = new Set(["claim_pending", "pause_pending"]);
const TRANSITION_MARKER_KEYS = [
  "transition",
  "transitionToken",
  "key",
  "backend",
  "inputFingerprint",
  "assetFingerprint",
  "builtinPromptFingerprint",
  "configFingerprint",
  "queueFingerprint",
  "outputPath",
  "updatedAt",
  "attemptLedger",
];

const hasExactKeys = (value, expectedKeys) =>
  isObject(value) &&
  Object.keys(value).length === expectedKeys.length &&
  expectedKeys.every((key) => Object.hasOwn(value, key));

const isStrictAttemptLedger = (value) =>
  isObject(value) &&
  Object.keys(value).every((backend) => IMAGE_BACKENDS.includes(backend)) &&
  Object.values(value).every(
    (entry) =>
      hasExactKeys(entry, ["inputFingerprint", "attempts", "lastError", "updatedAt"]) &&
      cleanText(entry.inputFingerprint) &&
      Number.isSafeInteger(entry.attempts) &&
      entry.attempts >= 0 &&
      typeof entry.lastError === "string" &&
      typeof entry.updatedAt === "string",
  );

const isStrictBuiltinTransitionLedger = (value, builtinPromptFingerprint) =>
  isStrictAttemptLedger(value) &&
  Object.hasOwn(value, "builtin") &&
  value.builtin.inputFingerprint === builtinPromptFingerprint;

const isBuiltinTransitionMarker = (value) =>
  hasExactKeys(value, TRANSITION_MARKER_KEYS) &&
  BUILTIN_TRANSITIONS.has(value.transition) &&
  cleanText(value.transitionToken) &&
  cleanText(value.key) &&
  value.backend === "builtin" &&
  cleanText(value.inputFingerprint) &&
  cleanText(value.assetFingerprint) &&
  cleanText(value.builtinPromptFingerprint) &&
  cleanText(value.configFingerprint) &&
  cleanText(value.queueFingerprint) &&
  cleanText(value.outputPath) &&
  Number.isFinite(Date.parse(value.updatedAt)) &&
  isStrictBuiltinTransitionLedger(
    value.attemptLedger,
    value.builtinPromptFingerprint,
  );

const isBareAttemptLedgerState = (value) =>
  hasExactKeys(value, ["attemptLedger"]) && isStrictAttemptLedger(value.attemptLedger);

const makeClaimSelectionBinding = (
  savedProgress,
  item,
  builtinPromptFingerprint,
) => {
  if (!isObject(savedProgress) || !isObject(savedProgress.items)) {
    throw new Error("出图进度结构无效，无法建立 claim 状态绑定");
  }
  const statePresent = Object.hasOwn(savedProgress.items, item.key);
  const state = statePresent ? savedProgress.items[item.key] : null;
  const attemptLedger = normalizeAttemptLedger(state);
  const builtinAttempt = attemptEntryFor(
    attemptLedger,
    "builtin",
    builtinPromptFingerprint,
  );
  return {
    version: 1,
    progressDigest: canonicalSha256(savedProgress),
    progressVersion: savedProgress.version,
    routingFingerprint: cleanText(savedProgress.routingFingerprint),
    key: item.key,
    statePresent,
    stateDigest: canonicalSha256(state),
    inputFingerprint: item.inputFingerprint,
    assetFingerprint: item.assetFingerprint,
    builtinPromptFingerprint,
    attemptInputFingerprint: builtinAttempt.inputFingerprint,
    attempts: builtinAttempt.attempts,
  };
};

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
  const builtinDefinitionRaw = await fs.readFile(builtinDefinitionPath, "utf8");
  const builtinDefinition = parseJsonText(builtinDefinitionRaw, "内置 image_gen 固定字段");
  if (!validateBuiltinPromptDefinition(builtinDefinition)) {
    throw new Error("内置 image_gen 固定字段结构无效");
  }
  const pendingRaw = await fs.readFile(pendingPath, "utf8");
  const pendingRecords = parseJsonText(pendingRaw, "待确认记录");
  if (!Array.isArray(pendingRecords)) throw new Error("待确认记录顶层必须是数组");
  const eligibilityFingerprint = sha256(pendingRaw);

  const queue = await readJsonFile(queuePath, { label: "出图队列", retries: 2 });
  if (
    !isObject(queue) ||
    queue.version !== 4 ||
    !Array.isArray(queue.items) ||
    !cleanText(queue.builtAt) ||
    !cleanText(queue.routingFingerprint) ||
    !cleanText(queue.eligibilityFingerprint)
  ) {
    throw new Error("出图队列尚未建立或结构无效，请先重新建立出图队列");
  }
  if (cleanText(queue.operation) && queue.operation !== "generate") {
    throw new Error("当前队列属于 API 参考图批量重绘，不能交给内置 image_gen 执行");
  }
  if (onlyKey && !queue.items.some((item) => cleanText(item?.key) === onlyKey)) {
    throw new Error(`指定的内置出图任务不存在：${onlyKey}`);
  }
  if (queue.eligibilityFingerprint !== eligibilityFingerprint) {
    throw new Error("待确认记录已变化，资产出图资格需要重新计算，请重新建立出图队列");
  }
  assertConditionMatchingQueueCurrent(queue);
  const builtinPromptBatch = queue.builtinPromptBatch;
  if (!validateBuiltinPromptBatch(builtinPromptBatch)) {
    throw new Error("本批次尚未确认内置 image_gen 风格与生成类型，请先完成选择式配置");
  }
  if (!builtinPromptBatchMatchesCatalog(builtinPromptBatch)) {
    throw new Error("内置 image_gen 当前活动风格路由已变化，请重新打开风格路由窗口确认");
  }
  const builtinConfigFingerprint = canonicalSha256(builtinPromptBatch);

  if (!Number.isFinite(Date.parse(queue.builtAt))) {
    throw new Error("出图队列 builtAt 无效，请重新建立出图队列");
  }

  const queueKeys = new Set();
  const itemByKey = new Map();
  const builtinPromptSpecByKey = new Map();
  const builtinPromptFingerprintByKey = new Map();
  const referencePathsByKey = new Map();
  const validatedReferencePaths = new Map();
  for (const item of queue.items) {
    if (
      !isObject(item) ||
      !cleanText(item.key) ||
      !cleanText(item.assetName) ||
      !cleanText(item.productionNotes) ||
      !cleanText(item.outputPath) ||
      !cleanText(item.inputFingerprint) ||
      !cleanText(item.assetFingerprint) ||
      queueKeys.has(item.key)
    ) {
      throw new Error("出图队列含无效或重复 key，请重新建立出图队列");
    }
    queueKeys.add(item.key);
    itemByKey.set(item.key, item);
    if (!ASSET_ID_PATTERNS[item.sheetName]?.test(cleanText(item.assetId))) {
      throw new Error(`任务资产ID无效：${item.key}；请重新建立出图队列`);
    }
    if (item.assetFingerprint !== makeAssetFingerprint(item)) {
      throw new Error(`内置任务输入已变化或队列损坏：${item.key}；请重新建立出图队列`);
    }
    const promptSpec = makeBuiltinPromptSpec(
      builtinDefinition,
      builtinPromptBatch,
      item,
    );
    const referencePaths = [];
    for (const snapshot of promptSpec.referenceImages) {
      const absolute = path.resolve(skillRoot, snapshot.path);
      if (!isPathWithinOrSame(absolute, builtinReferenceRoot)) {
        throw new Error(`内置参考图片越出 Cache 目录：${snapshot.path}`);
      }
      await assertSafeOutputPath(builtinReferenceRoot, absolute, { targetMayBeMissing: false });
      const cacheKey = `${absolute.toLowerCase()}|${snapshot.size}|${snapshot.sha256}`;
      if (!validatedReferencePaths.has(cacheKey)) {
        const info = await readValidatedReferenceImageInfo(absolute);
        if (!info || info.size !== snapshot.size || info.sha256 !== snapshot.sha256) {
          throw new Error(`内置参考图片已变化、格式无效或损坏：${snapshot.path}`);
        }
        validatedReferencePaths.set(cacheKey, absolute);
      }
      referencePaths.push(validatedReferencePaths.get(cacheKey));
    }
    if (
      builtinSheetIsEnabled(builtinPromptBatch, item) &&
      promptSpec.referencePolicy === "required" &&
      referencePaths.length === 0
    ) {
      throw new Error(`内置路由缺少必填参考图片：${promptSpec.styleId}/${item.sheetName}`);
    }
    if (builtinSheetIsEnabled(builtinPromptBatch, item) && promptSpec.status !== "configured") {
      throw new Error(
        `内置任务提示词配置无效：${item.key}：${promptSpec.message || promptSpec.status}`,
      );
    }
    builtinPromptSpecByKey.set(item.key, promptSpec);
    referencePathsByKey.set(item.key, referencePaths);
    builtinPromptFingerprintByKey.set(
      item.key,
      makeBuiltinPromptFingerprint(item.assetFingerprint, promptSpec),
    );
    const queueOutput = resolveImageOutput(item.outputPath);
    await assertSafeOutputPath(imageOutputRoot, queueOutput.absolute);
  }

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

  const lockTransitionFingerprintsMatch = (lock) =>
    lock?.configFingerprint === builtinConfigFingerprint &&
    lock?.queueFingerprint === queue.routingFingerprint;

  let activeLock = await readPipelineLock(lockPath);
  let recoveredFinalization = false;
  let recoveredTransition = false;
  if (resume && activeLock?.kind === "image_generation") {
    const finalizedItem = itemByKey.get(activeLock.key);
    const finalizedState = progress.items[activeLock.key];
    const finalizedPromptFingerprint = builtinPromptFingerprintByKey.get(activeLock.key);
    const safelyFinalized =
      finalizedItem &&
      isObject(finalizedState) &&
      finalizedState.backend === "builtin" &&
      ["completed", "failed"].includes(finalizedState.status) &&
      cleanText(finalizedState.finalizationToken) === cleanText(activeLock.token) &&
      finalizedState.inputFingerprint === finalizedItem.inputFingerprint &&
      finalizedState.assetFingerprint === finalizedItem.assetFingerprint &&
      finalizedState.builtinPromptFingerprint === finalizedPromptFingerprint &&
      activeLock.protocolVersion === PIPELINE_LOCK_PROTOCOL_VERSION &&
      activeLock.leaseMode === "durable" &&
      activeLock.inputFingerprint === finalizedItem.inputFingerprint &&
      activeLock.assetFingerprint === finalizedItem.assetFingerprint &&
      activeLock.builtinPromptFingerprint === finalizedPromptFingerprint &&
      lockTransitionFingerprintsMatch(activeLock);
    if (safelyFinalized) {
      await releasePipelineLock(lockPath, { token: activeLock.token });
      activeLock = null;
      recoveredFinalization = true;
    }
  }

  const transitionLikeEntries = Object.entries(progress.items).filter(
    ([, state]) => isObject(state) && Object.hasOwn(state, "transition"),
  );
  const invalidTransition = transitionLikeEntries.find(
    ([, state]) => !isBuiltinTransitionMarker(state),
  );
  if (invalidTransition) {
    throw new Error(
      `检测到结构无效的内置出图过渡标记：${invalidTransition[0]}；禁止自动恢复或删除锁`,
    );
  }
  if (transitionLikeEntries.length > 1) {
    throw new Error("检测到多个内置出图过渡标记，禁止自动恢复或删除锁");
  }

  const transitionMatchesCurrentQueue = (key, marker) => {
    const item = itemByKey.get(key);
    const queueOutput = item ? resolveImageOutput(item.outputPath) : null;
    return Boolean(
      item &&
        marker.key === key &&
        marker.inputFingerprint === item.inputFingerprint &&
        marker.assetFingerprint === item.assetFingerprint &&
        marker.builtinPromptFingerprint === builtinPromptFingerprintByKey.get(key) &&
        marker.configFingerprint === builtinConfigFingerprint &&
        marker.queueFingerprint === queue.routingFingerprint &&
        marker.outputPath === queueOutput.relative,
    );
  };

  const lockMatchesCurrentQueue = (lock, item) => {
    const builtinPromptFingerprint = builtinPromptFingerprintByKey.get(item?.key);
    const coreMatches =
      isObject(lock) &&
      lock.protocolVersion === PIPELINE_LOCK_PROTOCOL_VERSION &&
      lock.kind === "image_generation" &&
      lock.leaseMode === "durable" &&
      cleanText(lock.token) &&
      lock.key === item?.key &&
      lock.inputFingerprint === item?.inputFingerprint &&
      lock.assetFingerprint === item?.assetFingerprint &&
      lock.builtinPromptFingerprint === builtinPromptFingerprint;
    if (!coreMatches) return false;
    return lockTransitionFingerprintsMatch(lock);
  };

  if (transitionLikeEntries.length === 1) {
    const [transitionKey, marker] = transitionLikeEntries[0];
    const item = itemByKey.get(transitionKey);
    if (!transitionMatchesCurrentQueue(transitionKey, marker)) {
      throw new Error(
        `内置出图过渡标记与当前来源、配置或队列不一致：${transitionKey}；禁止自动恢复或删除锁`,
      );
    }
    if (activeLock) {
      if (!resume) {
        printLockError(activeLock);
        return;
      }
      const isTransitionRecoveryLease =
        activeLock.recoveryTransitionToken === marker.transitionToken;
      const transitionTokenMatches =
        activeLock.token === marker.transitionToken ||
        isTransitionRecoveryLease;
      if (
        !item ||
        !lockMatchesCurrentQueue(activeLock, item) ||
        !transitionTokenMatches ||
        (marker.transition === "claim_pending" &&
          activeLock.transition !== "claim_pending")
      ) {
        throw new Error(
          `内置出图过渡标记与当前锁不一致：${transitionKey}；禁止自动恢复或删除锁`,
        );
      }
      const lockedOutput = resolveImageOutput(item.outputPath);
      const lockedRecoveryOutput = await readOutputBaseline(lockedOutput.absolute);
      if (lockedRecoveryOutput.exists) {
        throw new Error(
          `恢复 ${marker.transition} 时目标文件已经出现，已保留锁和过渡标记：${lockedOutput.relative}`,
        );
      }
      maybeInjectReleaseFailure("fail_transition_original_release");
      await releasePipelineLock(lockPath, { token: activeLock.token });
      activeLock = null;
    }

    // Keep the marker intact while relinquishing an original/legacy lock. A new
    // recovery lock serializes the marker cleanup, so no process writes progress
    // after giving up ownership and a legacy release failure remains recoverable.
    try {
      activeLock = await acquirePipelineLock(lockPath, {
        kind: "image_generation",
        key: item.key,
        inputFingerprint: item.inputFingerprint,
        assetFingerprint: item.assetFingerprint,
        builtinPromptFingerprint: builtinPromptFingerprintByKey.get(item.key),
        transition: "claim_pending",
        recoveryTransitionToken: marker.transitionToken,
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
    const latestProgress = await readJsonFile(progressPath, {
      label: "出图进度",
      retries: 2,
    });
    const latestMarker = latestProgress?.items?.[transitionKey];
    if (
      !isObject(latestProgress) ||
      !isObject(latestProgress.items) ||
      !isBuiltinTransitionMarker(latestMarker) ||
      canonicalSha256(latestMarker) !== canonicalSha256(marker)
    ) {
      try {
        await releasePipelineLock(lockPath, { token: activeLock.token });
        activeLock = null;
      } catch (releaseError) {
        throw new AggregateError(
          [releaseError],
          `过渡标记在获取恢复锁期间发生变化，且恢复锁释放失败：${transitionKey}`,
        );
      }
      throw new Error(`过渡标记在获取恢复锁期间发生变化，请重试：${transitionKey}`);
    }
    const queueOutput = resolveImageOutput(item.outputPath);
    const recoveryOutput = await readOutputBaseline(queueOutput.absolute);
    if (recoveryOutput.exists) {
      throw new Error(
        `恢复 ${marker.transition} 时目标文件已经出现，已保留恢复锁和过渡标记：${queueOutput.relative}`,
      );
    }

    progress.version = 3;
    progress.routingFingerprint = queue.routingFingerprint;
    progress.items = latestProgress.items;
    progress.items[transitionKey] = {
      attemptLedger: normalizeAttemptLedger(marker),
    };
    await writeJsonAtomic(progressPath, progress);
    maybeInjectCrash("after_transition_cleanup_commit");
    try {
      maybeInjectReleaseFailure("fail_transition_cleanup_release");
      await releasePipelineLock(lockPath, { token: activeLock.token });
      activeLock = null;
    } catch (releaseError) {
      throw new Error(
        `过渡标记已清理，但恢复锁释放失败；claim_pending 锁已保留供 --resume 接管：${transitionKey}`,
        { cause: releaseError },
      );
    }
    recoveredTransition = true;
  }

  if (
    resume &&
    activeLock &&
    transitionLikeEntries.length === 0
  ) {
    const item = itemByKey.get(activeLock.key);
    const state = progress.items[activeLock.key];
    const stateIsCurrentGenerating =
      item &&
      isObject(state) &&
      state.status === "generating" &&
      state.backend === "builtin" &&
      state.inputFingerprint === item.inputFingerprint &&
      state.assetFingerprint === item.assetFingerprint &&
      state.builtinPromptFingerprint === builtinPromptFingerprintByKey.get(item.key);
    const recoverableClaimLock = activeLock.transition === "claim_pending";
    const recoverableLegacyBareLock =
      lockHasLegacyTransitionFingerprints(activeLock) &&
      isBareAttemptLedgerState(state);
    if (
      !stateIsCurrentGenerating &&
      (recoverableClaimLock || recoverableLegacyBareLock)
    ) {
      if (
        !item ||
        !lockMatchesCurrentQueue(activeLock, item, {
          allowLegacyTransitionFields: recoverableLegacyBareLock,
        })
      ) {
        throw new Error(
          "claim_pending 锁与当前来源、配置或队列不一致，禁止自动恢复或删除锁",
        );
      }
      const queueOutput = resolveImageOutput(item.outputPath);
      const recoveryOutput = await readOutputBaseline(queueOutput.absolute);
      if (recoveryOutput.exists) {
        throw new Error(
          `恢复 claim_pending 时目标文件已经出现，已保留锁：${queueOutput.relative}`,
        );
      }
      await releasePipelineLock(lockPath, { token: activeLock.token });
      activeLock = null;
      recoveredTransition = true;
    }
  }

  if (resume) {
    if (!activeLock && !recoveredFinalization && !recoveredTransition) {
      throw new Error("没有可恢复的出图任务");
    }
    if (recoveredFinalization || recoveredTransition) {
      // The terminal state was committed before a crash left its matching lock behind.
      // A strictly matched transition also continues through normal selection so a
      // claim is made exactly once and a paused attempt is refunded exactly once.
    } else {
      if (activeLock.kind !== "image_generation") {
        throw new Error(`当前锁不是出图任务：${activeLock.kind}:${activeLock.key}`);
      }
      if (!cleanText(activeLock.token)) {
        throw new Error("当前出图锁缺少释放令牌，禁止恢复或自动删除锁");
      }
      const item = itemByKey.get(activeLock.key);
      const prior = progress.items[activeLock.key];
      const builtinPromptFingerprint = builtinPromptFingerprintByKey.get(activeLock.key);
      if (
        !item ||
        !lockMatchesCurrentQueue(activeLock, item, {
          allowLegacyTransitionFields: true,
        }) ||
        !isObject(prior) ||
        prior.status !== "generating" ||
        prior.inputFingerprint !== item.inputFingerprint ||
        prior.assetFingerprint !== item.assetFingerprint ||
        prior.builtinPromptFingerprint !== builtinPromptFingerprint
      ) {
        throw new Error("当前锁与有效队列或 generating 进度不一致，禁止自动恢复或删除锁");
      }
      console.log(
        JSON.stringify(
          {
            done: false,
            resumed: true,
            total: queue.items.length,
            ...quotaDetails(),
            job: makeJob(item, prior, {
              claimed: true,
              outputBaseline: prior.outputBaseline ?? null,
            }),
          },
          null,
          2,
        ),
      );
      return;
    }
  }

  if (activeLock) {
    printLockError(activeLock);
    return;
  }

  const activeApiEntry = Object.entries(progress.items).find(
    ([, state]) =>
      isObject(state) && state.backend === "api" && state.status === "generating",
  );
  if (activeApiEntry) {
    throw new Error(
      `API 任务仍未进入终态：${activeApiEntry[0]}；请运行 batch_generate_images.py 继续查询，禁止切换到内置出图`,
    );
  }

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
    if (builtinPromptSpecByKey.get(item.key)?.status !== "configured") {
      if (onlyKey) {
        throw new Error(`指定任务的提示词路由待配置：${item.sheetName}`);
      }
      unconfigured += 1;
      continue;
    }
    const rawPrior = progress.items[item.key];
    const builtinPromptFingerprint = builtinPromptFingerprintByKey.get(item.key);
    const attemptLedger = normalizeAttemptLedger(rawPrior);
    const builtinAttempt = attemptEntryFor(
      attemptLedger,
      "builtin",
      builtinPromptFingerprint,
    );
    attemptLedger.builtin = builtinAttempt;
    const priorMatches =
      isObject(rawPrior) &&
      (rawPrior.backend === "builtin"
        ? cleanText(rawPrior.assetFingerprint)
          ? rawPrior.assetFingerprint === item.assetFingerprint &&
            rawPrior.builtinPromptFingerprint === builtinPromptFingerprint
          : rawPrior.status === "completed" &&
            rawPrior.inputFingerprint === item.inputFingerprint
        : rawPrior.inputFingerprint === item.inputFingerprint);
    const prior =
      priorMatches && !(rawPrior.backend === "api" && rawPrior.status === "failed")
        ? rawPrior
        : {};
    const queueOutput = resolveImageOutput(item.outputPath);
    let recordedOutputMatches = false;
    if (cleanText(prior.outputPath)) {
      try {
        recordedOutputMatches =
          resolveImageOutput(prior.outputPath).absolute.toLowerCase() ===
          queueOutput.absolute.toLowerCase();
      } catch {
        recordedOutputMatches = false;
      }
    }
    const outputValid = recordedOutputMatches
      ? await validPngFile(queueOutput.absolute)
      : false;
    if (prior.status === "completed" && outputValid) {
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
        `目标位置已有未被当前完成状态绑定的文件，禁止覆盖：${queueOutput.relative}；请先移动或备份该文件`,
      );
    }
    const attempts = builtinAttempt.attempts;
    const matchingBuiltinTerminal =
      prior.backend === "builtin" && prior.terminal === true;
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
          builtinPromptFingerprint,
        ),
      };
    }
  }

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
