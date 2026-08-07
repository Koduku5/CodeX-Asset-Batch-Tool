import {
  attemptEntryFor,
  cleanText,
  isObject,
  makeBuiltinPromptFingerprint,
  makeBuiltinPromptSpec,
  normalizeAttemptLedger,
} from "./pipeline_runtime.mjs";

export const countActiveCompatibleApiTasks = ({
  previousProgress,
  previousQueueItems,
  items,
}) => {
  const currentItemsByKey = new Map(items.map((item) => [item.key, item]));
  let activeApiTasks = 0;
  for (const [key, previous] of Object.entries(previousProgress.items)) {
    if (!isObject(previous) || previous.status !== "generating" || previous.backend !== "api") {
      continue;
    }
    if (!previousQueueItems) {
      throw new Error(`API 远端任务尚未进入终态但旧队列缺失或结构无效：${key}；禁止重建队列`);
    }
    const oldMatches = previousQueueItems.filter((item) => item?.key === key);
    if (oldMatches.length !== 1) {
      throw new Error(`API 远端任务尚未进入终态但旧队列无法唯一定位任务：${key}；禁止重建队列`);
    }
    const oldItem = oldMatches[0];
    const current = currentItemsByKey.get(key);
    const previousFingerprint = cleanText(previous.inputFingerprint);
    const oldFingerprint = cleanText(oldItem.inputFingerprint);
    const oldPromptIsValid = typeof oldItem.prompt === "string" && oldItem.prompt.length > 0;
    if (
      !current ||
      !previousFingerprint ||
      !oldFingerprint ||
      !oldPromptIsValid ||
      previousFingerprint !== oldFingerprint ||
      current.inputFingerprint !== oldFingerprint ||
      current.prompt !== oldItem.prompt
    ) {
      throw new Error(
        `API 远端任务尚未进入终态，且旧队列缺少可靠指纹/Prompt 或当前输入已变化：${key}；请先运行 batch_generate_images.py 恢复并确认结果`,
      );
    }
    activeApiTasks += 1;
  }
  return activeApiTasks;
};

export const buildPreservedProgressItems = ({
  items,
  previousProgress,
  referenceRedrawMode,
  reuseReferenceRedrawProgress,
  selectedBuiltinBatch,
  builtinDefinition,
}) => {
  const previousItems =
    previousProgress.version === 3 && isObject(previousProgress.items)
      ? previousProgress.items
      : {};
  const validStatuses = new Set(["generating", "completed", "failed"]);
  const preservedItems = {};
  for (const item of items) {
    if (referenceRedrawMode && !reuseReferenceRedrawProgress) {
      preservedItems[item.key] = {
        attemptLedger: { api: attemptEntryFor({}, "api", item.inputFingerprint) },
      };
      continue;
    }
    const previous = previousItems[item.key];
    const attemptLedger = normalizeAttemptLedger(previous);
    attemptLedger.api = attemptEntryFor(attemptLedger, "api", item.inputFingerprint);
    let currentBuiltinPromptFingerprint = "";
    if (!referenceRedrawMode && selectedBuiltinBatch) {
      currentBuiltinPromptFingerprint = makeBuiltinPromptFingerprint(
        item.assetFingerprint,
        makeBuiltinPromptSpec(builtinDefinition, selectedBuiltinBatch, item),
      );
      attemptLedger.builtin = attemptEntryFor(
        attemptLedger,
        "builtin",
        currentBuiltinPromptFingerprint,
      );
    }
    const builtinMatches =
      previous?.backend === "builtin" &&
      previous.assetFingerprint === item.assetFingerprint &&
      (!currentBuiltinPromptFingerprint ||
        previous.builtinPromptFingerprint === currentBuiltinPromptFingerprint);
    const legacyBuiltinMatches =
      previous?.backend === "builtin" &&
      !cleanText(previous.assetFingerprint) &&
      previous.status === "completed" &&
      previous.inputFingerprint === item.inputFingerprint &&
      (!currentBuiltinPromptFingerprint ||
        !cleanText(previous.builtinPromptFingerprint) ||
        previous.builtinPromptFingerprint === currentBuiltinPromptFingerprint);
    const apiOrLegacyMatches =
      previous?.backend !== "builtin" && previous?.inputFingerprint === item.inputFingerprint;
    if (
      !isObject(previous) ||
      (!builtinMatches && !legacyBuiltinMatches && !apiOrLegacyMatches) ||
      !validStatuses.has(previous.status)
    ) {
      preservedItems[item.key] = { attemptLedger };
      continue;
    }
    const currentAttempt =
      previous.backend === "builtin"
        ? attemptEntryFor(
            attemptLedger,
            "builtin",
            currentBuiltinPromptFingerprint || cleanText(previous.builtinPromptFingerprint),
          )
        : attemptLedger.api;
    if (previous.backend === "builtin" && cleanText(previous.builtinPromptFingerprint)) {
      attemptLedger.builtin = currentAttempt;
    }
    const preserved = {
      status: previous.status,
      attempts: currentAttempt.attempts,
      outputPath: cleanText(previous.outputPath),
      error: String(previous.error ?? ""),
      updatedAt: String(previous.updatedAt ?? ""),
      inputFingerprint: item.inputFingerprint,
      attemptLedger,
      ...(previous.backend === "builtin" && cleanText(previous.assetFingerprint)
        ? { assetFingerprint: item.assetFingerprint }
        : {}),
      ...(isObject(previous.outputBaseline) ? { outputBaseline: previous.outputBaseline } : {}),
    };
    for (const field of [
      "backend", "requestId", "taskId", "remoteStatus", "failureCode",
      "failureCategory", "projectId", "modelId", "baseUrl", "executionFingerprint",
      "builtinPromptFingerprint", "builtinGenerationSession", "startedAt", "aspectRatio",
      "imageSize", "downloadedImage", "downloadCandidate", "operationMode",
    ]) {
      if (cleanText(previous[field])) preserved[field] = cleanText(previous[field]);
    }
    if (Number.isInteger(previous.queuePosition)) preserved.queuePosition = previous.queuePosition;
    if (Number.isInteger(previous.downloadAttempts) && previous.downloadAttempts >= 0) {
      preserved.downloadAttempts = previous.downloadAttempts;
    }
    if (typeof previous.retryable === "boolean") preserved.retryable = previous.retryable;
    if (typeof previous.terminal === "boolean") preserved.terminal = previous.terminal;
    if (typeof previous.submissionAcknowledged === "boolean") {
      preserved.submissionAcknowledged = previous.submissionAcknowledged;
    }
    if (Array.isArray(previous.referenceUrls)) {
      preserved.referenceUrls = previous.referenceUrls.map(cleanText).filter(Boolean);
    }
    if (Array.isArray(previous.remoteImages)) {
      preserved.remoteImages = previous.remoteImages.map(cleanText).filter(Boolean);
    }
    if (
      isObject(previous.installCandidateSnapshot) &&
      Number.isSafeInteger(previous.installCandidateSnapshot.size) &&
      previous.installCandidateSnapshot.size >= 0 &&
      /^[0-9a-f]{64}$/u.test(previous.installCandidateSnapshot.sha256)
    ) {
      preserved.installCandidateSnapshot = {
        size: previous.installCandidateSnapshot.size,
        sha256: previous.installCandidateSnapshot.sha256,
      };
    }
    preservedItems[item.key] = preserved;
  }
  return preservedItems;
};
