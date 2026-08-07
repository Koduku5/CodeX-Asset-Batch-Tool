import fs from "node:fs/promises";
import path from "node:path";
import {
  MAX_IMAGE_ATTEMPTS,
  assertConditionMatchingQueueCurrent,
  assertSafeOutputPath,
  attemptEntryFor,
  builtinPromptBatchMatchesCatalog,
  builtinSheetIsEnabled,
  cleanText,
  isObject,
  makeAssetFingerprint,
  makeBuiltinPromptFingerprint,
  makeBuiltinPromptSpec,
  normalizeAttemptLedger,
  parseJsonText,
  readJsonFile,
  readValidatedPngInfo,
  requirePipelineLock,
  releasePipelineLock,
  resolveImageOutputPath,
  validateBuiltinPromptBatch,
  validateBuiltinPromptDefinition,
  writeJsonAtomic,
} from "../lib/pipeline_runtime.mjs";

const [skillRootArg, key, status, outputPath = "", errorMessage = ""] = process.argv.slice(2);
if (!skillRootArg || !key || !status) {
  throw new Error(
    "用法：node update_image_progress.mjs <skill-root> <queue-key> <completed|failed> [output-path] [error]",
  );
}
if (!["completed", "failed"].includes(status)) {
  throw new Error(`不支持的状态：${status}`);
}

const skillRoot = path.resolve(skillRootArg);
const cacheDir = path.join(skillRoot, "cache");
const queuePath = path.join(cacheDir, "出图队列.json");
const progressPath = path.join(cacheDir, "出图进度.json");
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

const readPngInfo = async (filePath) => {
  const info = await readValidatedPngInfo(filePath);
  if (!info) throw new Error(`完成失败：输出不是完整有效的 PNG 文件：${filePath}`);
  return info;
};

const queue = await readJsonFile(queuePath, { label: "出图队列", retries: 2 });
if (
  !isObject(queue) ||
  queue.version !== 4 ||
  !Array.isArray(queue.items) ||
  !cleanText(queue.builtAt) ||
  !cleanText(queue.routingFingerprint) ||
  !cleanText(queue.eligibilityFingerprint)
) {
  throw new Error("出图队列尚未建立或结构无效，请先建立出图队列");
}
if (cleanText(queue.operation) && queue.operation !== "generate") {
  throw new Error("当前队列属于 API 参考图批量重绘，不能写入内置 image_gen 进度");
}
assertConditionMatchingQueueCurrent(queue);
const matches = queue.items.filter((item) => item?.key === key);
if (matches.length !== 1) {
  throw new Error(matches.length ? `出图队列存在重复 key：${key}` : `任务不在当前出图队列：${key}`);
}
const item = matches[0];
if (!cleanText(item.inputFingerprint)) throw new Error(`任务缺少输入指纹：${key}`);
if (!cleanText(item.assetFingerprint) || item.assetFingerprint !== makeAssetFingerprint(item)) {
  throw new Error(`任务缺少有效的内置资产指纹：${key}`);
}
const builtinDefinitionRaw = await fs.readFile(builtinDefinitionPath, "utf8");
const builtinDefinition = parseJsonText(builtinDefinitionRaw, "内置 image_gen 固定字段");
if (!validateBuiltinPromptDefinition(builtinDefinition)) {
  throw new Error("内置 image_gen 固定字段结构无效");
}
if (!validateBuiltinPromptBatch(queue.builtinPromptBatch)) {
  throw new Error("当前队列缺少已确认的内置 image_gen 提示词配置");
}
if (!builtinPromptBatchMatchesCatalog(queue.builtinPromptBatch)) {
  throw new Error("内置 image_gen 当前活动风格路由已变化，请重新确认本批次配置");
}
if (!builtinSheetIsEnabled(queue.builtinPromptBatch, item)) {
  throw new Error(`任务所属类型未在本批次勾选：${item.sheetName}`);
}
const promptSpec = makeBuiltinPromptSpec(
  builtinDefinition,
  queue.builtinPromptBatch,
  item,
);
if (promptSpec.status !== "configured") {
  throw new Error(`任务提示词路由尚未配置：${promptSpec.styleId}/${item.sheetName}`);
}
if (promptSpec.referencePolicy === "required" && promptSpec.referenceImages.length === 0) {
  throw new Error(`任务缺少必填参考图片：${promptSpec.styleId}/${item.sheetName}`);
}
const builtinPromptFingerprint = makeBuiltinPromptFingerprint(
  item.assetFingerprint,
  promptSpec,
);

const queueOutput = resolveImageOutput(item.outputPath);
await assertSafeOutputPath(imageOutputRoot, queueOutput.absolute);
if (cleanText(outputPath)) {
  const requestedOutput = resolveImageOutput(outputPath);
  await assertSafeOutputPath(imageOutputRoot, requestedOutput.absolute);
  if (requestedOutput.absolute.toLowerCase() !== queueOutput.absolute.toLowerCase()) {
    throw new Error(`输出路径与当前队列不一致：${outputPath}`);
  }
}

const progress = await readJsonFile(progressPath, {
  fallback: { version: 3, items: {} },
  label: "出图进度",
  retries: 2,
});
if (!isObject(progress)) throw new Error("出图进度顶层必须是对象");
if (!isObject(progress.items)) throw new Error("出图进度 items 必须是对象");

progress.version = 3;
progress.routingFingerprint = queue.routingFingerprint;
const savedPrevious = progress.items[key];
if (
  isObject(savedPrevious) &&
  savedPrevious.status === "generating" &&
  savedPrevious.backend === "api"
) {
  throw new Error(
    `任务 ${key} 是活动中的 API 远端任务；只能由 batch_generate_images.py 更新，禁止覆盖`,
  );
}
const previous =
  isObject(savedPrevious) &&
  savedPrevious.inputFingerprint === item.inputFingerprint &&
  savedPrevious.assetFingerprint === item.assetFingerprint
    ? savedPrevious
    : {};
const attemptLedger = normalizeAttemptLedger(savedPrevious);
const builtinAttempt = attemptEntryFor(
  attemptLedger,
  "builtin",
  builtinPromptFingerprint,
);
attemptLedger.builtin = builtinAttempt;
const previousAttempts = builtinAttempt.attempts;

if (
  previous.status !== "generating" ||
  previous.backend !== "builtin" ||
  previous.builtinPromptFingerprint !== builtinPromptFingerprint
) {
  throw new Error(`${status === "completed" ? "完成" : "失败"}写入失败：${key} 当前不是内置出图任务`);
}

const lock = await requirePipelineLock(lockPath, {
  kind: "image_generation",
  key: item.key,
  inputFingerprint: item.inputFingerprint,
  assetFingerprint: item.assetFingerprint,
  builtinPromptFingerprint,
});
if (!cleanText(lock.token)) {
  throw new Error("当前出图锁缺少释放令牌，禁止继续写入");
}

let nextState;
if (status === "completed") {
  const currentOutput = await readPngInfo(queueOutput.absolute);
  const baseline = previous.outputBaseline;
  if (!isObject(baseline) || typeof baseline.exists !== "boolean") {
    throw new Error(`完成失败：任务 ${key} 缺少生成前输出基线`);
  }
  if (
    baseline.exists &&
    baseline.size === currentOutput.size &&
    baseline.mtimeMs === currentOutput.mtimeMs &&
    baseline.sha256 === currentOutput.sha256
  ) {
    throw new Error(`完成失败：输出文件与生成前旧图完全相同：${item.outputPath}`);
  }
  const updatedAt = new Date().toISOString();
  attemptLedger.builtin = {
    ...builtinAttempt,
    attempts: previousAttempts,
    lastError: "",
    updatedAt,
  };
  nextState = {
    status: "completed",
    backend: "builtin",
    attempts: previousAttempts,
    outputPath: queueOutput.relative,
    error: "",
    updatedAt,
    inputFingerprint: item.inputFingerprint,
    assetFingerprint: item.assetFingerprint,
    builtinPromptFingerprint,
    ...(cleanText(previous.builtinGenerationSession)
      ? { builtinGenerationSession: cleanText(previous.builtinGenerationSession) }
      : {}),
    outputBaseline: baseline,
    finalizationToken: lock.token,
    attemptLedger,
  };
} else {
  const failure = cleanText(errorMessage).slice(0, 2000);
  if (!failure) throw new Error("failed 状态必须提供非空错误信息");
  const updatedAt = new Date().toISOString();
  attemptLedger.builtin = {
    ...builtinAttempt,
    attempts: previousAttempts,
    lastError: failure,
    updatedAt,
  };
  nextState = {
    status: "failed",
    backend: "builtin",
    attempts: previousAttempts,
    outputPath: queueOutput.relative,
    error: failure,
    updatedAt,
    inputFingerprint: item.inputFingerprint,
    assetFingerprint: item.assetFingerprint,
    builtinPromptFingerprint,
    ...(cleanText(previous.builtinGenerationSession)
      ? { builtinGenerationSession: cleanText(previous.builtinGenerationSession) }
      : {}),
    finalizationToken: lock.token,
    retryable: previousAttempts < MAX_IMAGE_ATTEMPTS,
    terminal: previousAttempts >= MAX_IMAGE_ATTEMPTS,
    attemptLedger,
    ...(isObject(previous.outputBaseline) ? { outputBaseline: previous.outputBaseline } : {}),
  };
}

progress.items[key] = nextState;
await writeJsonAtomic(progressPath, progress);
try {
  await releasePipelineLock(lockPath, { token: lock.token });
} catch (releaseError) {
  let lockStillPresent = true;
  try {
    await fs.stat(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") lockStillPresent = false;
    else throw error;
  }
  if (lockStillPresent) {
    progress.items[key] = savedPrevious;
    try {
      await writeJsonAtomic(progressPath, progress);
    } catch (rollbackError) {
      throw new AggregateError(
        [releaseError, rollbackError],
        `任务 ${key} 已写入终态，但锁释放和进度回滚均失败；请保留 Cache 进行恢复`,
      );
    }
    throw new Error(`任务 ${key} 的锁释放失败，进度已恢复为 generating，可在旧进程停止后恢复`, {
      cause: releaseError,
    });
  }
}

console.log(JSON.stringify({ key, ...nextState }, null, 2));
