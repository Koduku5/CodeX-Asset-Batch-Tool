import path from "node:path";
import {
  IMAGE_BACKENDS,
  PIPELINE_LOCK_PROTOCOL_VERSION,
  assertSafeOutputPath,
  canonicalSha256,
  cleanText,
  isObject,
  normalizeAttemptEntry,
  readJsonFile,
  readPipelineLock,
  readStableFileSnapshot,
  releasePipelineLock,
  resolveImageOutputPath,
  writeJsonAtomic,
} from "../lib/pipeline_runtime.mjs";

const maybeInjectCrash = (point) => {
  if (
    process.env.NODE_ENV === "test" &&
    cleanText(process.env.KA_PIPELINE_TEST_FAULT) === point
  ) {
    process.exit(86);
  }
};

const args = process.argv.slice(2);
if (args.length !== 3) {
  throw new Error(
    "用法：node pause_current_image_job.mjs <skill-root> <expected-key> <expected-token>",
  );
}

const skillRoot = path.resolve(args[0]);
const expectedKey = cleanText(args[1]);
const expectedToken = cleanText(args[2]);
if (!expectedKey || !expectedToken) throw new Error("暂停任务缺少预期 key 或锁令牌");

const cacheDir = path.join(skillRoot, "cache");
const lockPath = path.join(cacheDir, ".pipeline.lock");
const progressPath = path.join(cacheDir, "出图进度.json");
const queuePath = path.join(cacheDir, "出图队列.json");
const imageOutputRoot = path.join(skillRoot, "输出", "资产图");

const resolveImageOutput = (relativePath) =>
  resolveImageOutputPath(skillRoot, imageOutputRoot, relativePath);

const lock = await readPipelineLock(lockPath);
if (
  !isObject(lock) ||
  lock.protocolVersion !== PIPELINE_LOCK_PROTOCOL_VERSION ||
  lock.kind !== "image_generation" ||
  lock.leaseMode !== "durable" ||
  cleanText(lock.key) !== expectedKey ||
  cleanText(lock.token) !== expectedToken
) {
  throw new Error("当前内置出图锁已经变化，禁止退回其他任务");
}

const queue = await readJsonFile(queuePath, {
  label: "出图队列",
  retries: 2,
});
if (
  !isObject(queue) ||
  queue.version !== 4 ||
  !Array.isArray(queue.items) ||
  !cleanText(queue.routingFingerprint) ||
  !isObject(queue.builtinPromptBatch)
) {
  throw new Error("出图队列结构无效，禁止暂停或释放当前任务锁");
}
const queueMatches = queue.items.filter((item) => cleanText(item?.key) === expectedKey);
if (queueMatches.length !== 1) {
  throw new Error("当前任务无法在出图队列中唯一定位，禁止暂停或释放当前任务锁");
}
const item = queueMatches[0];
const configFingerprint = canonicalSha256(queue.builtinPromptBatch);
if (
  lock.inputFingerprint !== item.inputFingerprint ||
  lock.assetFingerprint !== item.assetFingerprint ||
  lock.configFingerprint !== configFingerprint ||
  lock.queueFingerprint !== queue.routingFingerprint
) {
  throw new Error("当前出图锁与来源、配置或队列不一致，禁止暂停或释放任务锁");
}

const progress = await readJsonFile(progressPath, {
  fallback: { version: 3, items: {} },
  label: "出图进度",
  retries: 2,
});
if (!isObject(progress) || !isObject(progress.items)) {
  throw new Error("出图进度结构无效，禁止释放当前任务锁");
}
if (cleanText(progress.routingFingerprint) !== queue.routingFingerprint) {
  throw new Error("出图进度与当前队列指纹不一致，禁止暂停或释放当前任务锁");
}

const state = progress.items[expectedKey];
if (
  !isObject(state) ||
  state.status !== "generating" ||
  state.backend !== "builtin" ||
  state.inputFingerprint !== lock.inputFingerprint ||
  state.assetFingerprint !== lock.assetFingerprint ||
  state.builtinPromptFingerprint !== lock.builtinPromptFingerprint
) {
  throw new Error("当前进度与内置出图锁不一致，禁止退回任务");
}

const queueOutput = resolveImageOutput(item.outputPath);
await assertSafeOutputPath(imageOutputRoot, queueOutput.absolute);
if (
  cleanText(state.outputPath) &&
  resolveImageOutput(state.outputPath).absolute.toLowerCase() !==
    queueOutput.absolute.toLowerCase()
) {
  throw new Error("当前进度输出路径与队列不一致，禁止暂停或释放当前任务锁");
}
const outputSnapshot = await readStableFileSnapshot(queueOutput.absolute);
if (outputSnapshot.exists) {
  throw new Error(`暂停时目标文件已经出现，已保留任务锁且禁止覆盖：${queueOutput.relative}`);
}

const attemptLedger = {};
for (const backend of IMAGE_BACKENDS) {
  const entry = normalizeAttemptEntry(state.attemptLedger?.[backend]);
  if (entry) attemptLedger[backend] = entry;
}
const builtinFingerprint = cleanText(lock.builtinPromptFingerprint);
const priorBuiltin =
  attemptLedger.builtin?.inputFingerprint === builtinFingerprint
    ? attemptLedger.builtin
    : {
        inputFingerprint: builtinFingerprint,
        attempts: Number.isInteger(state.attempts) && state.attempts >= 0 ? state.attempts : 1,
        lastError: "",
        updatedAt: "",
      };
const pausedAt = new Date().toISOString();
attemptLedger.builtin = {
  ...priorBuiltin,
  attempts: Math.max(0, priorBuiltin.attempts - 1),
  lastError: "",
  updatedAt: pausedAt,
};

progress.version = 3;
progress.routingFingerprint = queue.routingFingerprint;
progress.items[expectedKey] = {
  transition: "pause_pending",
  transitionToken: expectedToken,
  key: expectedKey,
  backend: "builtin",
  inputFingerprint: item.inputFingerprint,
  assetFingerprint: item.assetFingerprint,
  builtinPromptFingerprint: lock.builtinPromptFingerprint,
  configFingerprint,
  queueFingerprint: queue.routingFingerprint,
  outputPath: queueOutput.relative,
  updatedAt: pausedAt,
  attemptLedger,
};
await writeJsonAtomic(progressPath, progress);
maybeInjectCrash("after_pause_marker");
try {
  // Leave pause_pending in progress after releasing the lock. The next startup
  // acquires its own recovery lock before collapsing it to the refunded ledger,
  // so this process never writes shared progress after relinquishing ownership.
  await releasePipelineLock(lockPath, { token: expectedToken });
} catch (releaseError) {
  throw new Error(
    `任务 ${expectedKey} 已写入可恢复暂停标记，但锁释放失败；请保留 Cache 后重试恢复`,
    { cause: releaseError },
  );
}
maybeInjectCrash("after_pause_release");

console.log(
  JSON.stringify(
    {
      ok: true,
      paused: expectedKey,
      attemptRefunded: true,
      outputPreserved: true,
      pausedAt,
    },
    null,
    2,
  ),
);
