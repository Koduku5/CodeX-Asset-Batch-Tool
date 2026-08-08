import {
  PIPELINE_LOCK_PROTOCOL_VERSION,
  acquirePipelineLock,
  canonicalSha256,
  cleanText,
  isObject,
  normalizeAttemptLedger,
  readJsonFile,
  readPipelineLock,
  releasePipelineLock,
  writeJsonAtomic
} from '../pipeline_runtime.mjs';
import {
  isBareAttemptLedgerState,
  isBuiltinTransitionMarker,
  lockHasLegacyTransitionFingerprints
} from './claim-contracts.mjs';

export async function recoverImageJobState({
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
  makeJob
}) {
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
        return { terminal: true, activeLock };
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
        return { terminal: true, activeLock };
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
      return { terminal: true, activeLock };
    }
  }

  if (activeLock) {
    printLockError(activeLock);
    return { terminal: true, activeLock };
  }
  return { terminal: false, activeLock };
}

