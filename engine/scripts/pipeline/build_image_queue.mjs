import fs from "node:fs/promises";
import path from "node:path";
import {
  acquirePipelineLock,
  assertSafeOutputPath,
  attemptEntryFor,
  builtinPromptBatchMatchesCatalog,
  builtinPromptPresetMatchesCatalog,
  cleanText,
  getBuiltinCatalogFingerprint,
  getConditionModuleRegistryFingerprint,
  hasExactKeys,
  isObject,
  normalizeAttemptLedger,
  parseJsonText,
  readJsonFile,
  releasePipelineLock,
  sha256,
  validateApiPromptBatch,
  validateBuiltinPromptBatch,
  validateBuiltinPromptDefinition,
  validateBuiltinPromptPreset,
  validateImageRoutes,
  writeJsonAtomic,
} from "../lib/pipeline_runtime.mjs";
import { readOrderedAssetRecords } from "../lib/image_queue_asset_source.mjs";
import {
  makeApiRouteFingerprints,
  readRequestedApiPromptTemplates,
} from "../lib/image_queue_prompt_builder.mjs";
import { buildImageQueueItems } from "../lib/image_queue_item_builder.mjs";
import {
  buildPreservedProgressItems,
  countActiveCompatibleApiTasks,
} from "../lib/image_queue_progress.mjs";

const args = process.argv.slice(2);
const optionArgs = args.slice(1);
const allowedOptions = new Set(["--api-prompts-env", "--reference-redraw"]);
if (
  args.length < 1 ||
  optionArgs.some((value) => !allowedOptions.has(value)) ||
  new Set(optionArgs).size !== optionArgs.length
) {
  throw new Error(
    "用法：node build_image_queue.mjs <skill-root> [--api-prompts-env] [--reference-redraw]",
  );
}
const apiPromptMode = optionArgs.includes("--api-prompts-env");
const referenceRedrawMode = optionArgs.includes("--reference-redraw");
if (referenceRedrawMode && !apiPromptMode) {
  throw new Error("参考图批量重绘必须同时使用 --api-prompts-env");
}

const skillRoot = path.resolve(args[0]);
const cacheDir = path.join(skillRoot, "cache");
const queuePath = path.join(cacheDir, "出图队列.json");
const progressPath = path.join(cacheDir, "出图进度.json");
const lockPath = path.join(cacheDir, ".pipeline.lock");
const pendingPath = path.join(cacheDir, "待确认记录.json");
const routesPath = path.join(skillRoot, "assets", "图片生成", "出图路由.json");
const builtinDefinitionPath = path.join(
  skillRoot,
  "assets",
  "图片生成",
  "内置imagegen字段.json",
);
const builtinPresetPath = path.join(cacheDir, "内置提示词预设.json");
const conditionMatchingPath = path.join(cacheDir, "提示词分支匹配.json");
const imageOutputRoot = path.join(skillRoot, "输出", "资产图");
const redrawBaseRoot = path.join(imageOutputRoot, "API重绘");
let redrawOutputRoot = redrawBaseRoot;

const resolveOutputFolder = (folderName) => {
  if (!cleanText(folderName)) throw new Error("出图目录为空");
  const resolved = path.resolve(imageOutputRoot, folderName);
  const relative = path.relative(imageOutputRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`出图目录越出 输出/资产图：${folderName}`);
  }
  return resolved;
};

const resolveRedrawOutputFolder = (folderName) => {
  if (!cleanText(folderName)) throw new Error("API 重绘目录为空");
  const resolved = path.resolve(redrawOutputRoot, folderName);
  const relative = path.relative(redrawOutputRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`API 重绘目录越出 输出/资产图/API重绘：${folderName}`);
  }
  return resolved;
};

const safeFilePart = (value) => {
  const cleaned = cleanText(value)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 100);
  return cleaned || "未命名资产";
};

const lock = await acquirePipelineLock(lockPath, {
  kind: "queue_build",
  key: "image_queue",
  leaseMode: "transient",
});

try {
  const previousQueue = await readJsonFile(queuePath, {
    fallback: null,
    label: "旧出图队列",
  });
  const previousProgress = await readJsonFile(progressPath, {
    fallback: { version: 3, items: {} },
    label: "出图进度",
  });
  if (!isObject(previousProgress)) throw new Error("出图进度顶层必须是对象");
  if (!isObject(previousProgress.items)) throw new Error("出图进度 items 必须是对象");

  const builtinDefinitionRaw = await fs.readFile(builtinDefinitionPath, "utf8");
  const builtinDefinition = parseJsonText(builtinDefinitionRaw, "内置 image_gen 固定字段");
  if (!validateBuiltinPromptDefinition(builtinDefinition)) {
    throw new Error(`内置 image_gen 固定字段结构无效：${builtinDefinitionPath}`);
  }
  let builtinPreset = null;
  try {
    const builtinPresetRaw = await fs.readFile(builtinPresetPath, "utf8");
    const parsedPreset = parseJsonText(builtinPresetRaw, "内置提示词预设");
    if (
      validateBuiltinPromptPreset(parsedPreset) &&
      builtinPromptPresetMatchesCatalog(parsedPreset)
    ) {
      builtinPreset = parsedPreset;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const routesRaw = await fs.readFile(routesPath, "utf8");
  const config = parseJsonText(routesRaw, "出图路由");
  if (!validateImageRoutes(config)) {
    throw new Error(`无效的出图路由配置：${routesPath}；必须固定包含角色、生物、群演、场景、道具五个 Sheet`);
  }
  const requestedApiPromptTemplates = readRequestedApiPromptTemplates({
    enabled: apiPromptMode,
    encoded: process.env.KA_API_PROMPT_TEMPLATES_B64,
    sheetOrder: config.sheetOrder,
  });
  const routingResourceFingerprints = {
    [path.relative(skillRoot, routesPath).split(path.sep).join("/")]: sha256(routesRaw),
  };
  for (const sheetName of config.sheetOrder) {
    const route = config.routes[sheetName];
    if (!isObject(route) || !cleanText(route.outputFolder)) {
      throw new Error(`Sheet ${sheetName} 缺少完整路由配置`);
    }
    resolveOutputFolder(route.outputFolder);
  }
  const routingFingerprint = sha256(routesRaw);

  const pendingRaw = await fs.readFile(pendingPath, "utf8");
  const pendingRecords = parseJsonText(pendingRaw, "待确认记录");
  if (!Array.isArray(pendingRecords)) throw new Error(`无效的待确认记录：${pendingPath}`);
  for (const [index, record] of pendingRecords.entries()) {
    if (!isObject(record) || !["pending", "resolved"].includes(record.status)) {
      throw new Error(`待确认记录第 ${index + 1} 项 status 只能是 pending 或 resolved`);
    }
    if (record?.status === "resolved" && !cleanText(record.resolution)) {
      throw new Error(`待确认记录第 ${index + 1} 项 status=resolved 时 resolution 不能为空`);
    }
  }
  const eligibilityFingerprint = sha256(pendingRaw);
  const pendingBlockers = pendingRecords.filter((record) => record?.status === "pending"
    || (isObject(record?.draftAsset) && !cleanText(record?.appliedAt)));
  if (pendingBlockers.length) {
    throw new Error(`仍有 ${pendingBlockers.length} 项资产尚未完成人工确认与正式纳入，禁止建立出图队列`);
  }

  const previousBuiltinBatch = previousQueue?.builtinPromptBatch;
  const reusablePreviousBuiltinBatch =
    validateBuiltinPromptBatch(previousBuiltinBatch) &&
    builtinPromptBatchMatchesCatalog(previousBuiltinBatch)
      ? previousBuiltinBatch
      : null;
  const presetBuiltinBatch = builtinPreset;
  const selectedBuiltinBatch =
    presetBuiltinBatch &&
    (!reusablePreviousBuiltinBatch ||
      Date.parse(presetBuiltinBatch.confirmedAt) >=
        Date.parse(reusablePreviousBuiltinBatch.confirmedAt))
      ? presetBuiltinBatch
      : reusablePreviousBuiltinBatch;

  let conditionMatching = null;
  try {
    const conditionMatchingRaw = await fs.readFile(conditionMatchingPath, "utf8");
    const parsed = parseJsonText(conditionMatchingRaw, "提示词分支匹配");
    if (
      !hasExactKeys(parsed, [
        "version",
        "catalogFingerprint",
        "conditionRegistryFingerprint",
        "items",
      ]) ||
      parsed.version !== 1 ||
      !isObject(parsed.items)
    ) {
      throw new Error("提示词分支匹配必须使用严格 v1 协议");
    }
    if (
      parsed.catalogFingerprint !== getBuiltinCatalogFingerprint() ||
      parsed.conditionRegistryFingerprint !== getConditionModuleRegistryFingerprint()
    ) {
      throw new Error("提示词分支匹配使用了过期 Prompt Catalog 或分支注册表");
    }
    if (!selectedBuiltinBatch) {
      throw new Error("存在提示词分支匹配时，必须先确认内置 image_gen 风格、生成类型与参考图方式");
    }
    if (referenceRedrawMode) {
      throw new Error("API 参考图批量重绘不允许携带内置 Prompt Catalog 分支匹配");
    }
    conditionMatching = parsed;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const previousQueueItems = Array.isArray(previousQueue?.items) ? previousQueue.items : null;
  const reuseReferenceRedrawProgress =
    referenceRedrawMode &&
    previousQueue?.version === 4 &&
    previousQueue?.operation === "reference_redraw" &&
    cleanText(previousQueue?.referenceRedraw?.batchId) &&
    Array.isArray(previousQueueItems) &&
    previousQueueItems.length > 0 &&
    (previousQueueItems.some((item) => {
      const state = previousProgress.items?.[item?.key];
      if (!isObject(state) || state.backend !== "api") return true;
      if (state.status === "completed") return false;
      const ledger = normalizeAttemptLedger(state);
      const apiAttempt = attemptEntryFor(ledger, "api", cleanText(item?.inputFingerprint));
      const terminalFailure =
        state.status === "failed" &&
        (state.terminal === true || apiAttempt.attempts >= 2);
      return !terminalFailure;
    }) || previousProgress.apiBatch?.canvasStatus === "failed");
  const redrawBatchId = referenceRedrawMode
    ? reuseReferenceRedrawProgress
      ? cleanText(previousQueue.referenceRedraw.batchId)
      : `batch-${new Date().toISOString().replace(/\D/g, "")}`
    : "";
  if (referenceRedrawMode) {
    redrawOutputRoot = path.join(redrawBaseRoot, redrawBatchId);
  }
  const previousApiPromptBatch = previousQueue?.apiPromptBatch;
  const reusablePreviousApiPromptBatch =
    previousQueue?.version === 4 && validateApiPromptBatch(previousApiPromptBatch)
      ? previousApiPromptBatch
      : null;
  const apiPromptBatch = requestedApiPromptTemplates
    ? {
        version: 2,
        confirmedAt: new Date().toISOString(),
        bySheet: requestedApiPromptTemplates,
      }
    : reusablePreviousApiPromptBatch;
  const promptTemplates = apiPromptBatch?.bySheet ??
    Object.fromEntries(config.sheetOrder.map((sheetName) => [sheetName, ""]));
  const routeFingerprints = makeApiRouteFingerprints({
    sheetOrder: config.sheetOrder,
    routes: config.routes,
    promptTemplates,
  });
  const recordsBySheet = await readOrderedAssetRecords(cacheDir, config.sheetOrder);

  const {
    counts,
    items,
    skippedMissingSources,
    skippedPending,
  } = await buildImageQueueItems({
    apiPromptMode,
    builtinDefinition,
    conditionMatching,
    config,
    promptTemplates,
    recordsBySheet,
    referenceRedrawMode,
    resolveOutputFolder,
    resolveRedrawOutputFolder,
    routeFingerprints,
    safeFilePart,
    selectedBuiltinBatch,
    skillRoot,
  });
  const builtAt = new Date().toISOString();
  const queue = {
    version: 4,
    builtAt,
    routingConfig: path.relative(skillRoot, routesPath).split(path.sep).join("/"),
    routingFingerprint,
    routingResourceFingerprints,
    eligibilityFingerprint,
    items,
  };
  if (conditionMatching) {
    queue.conditionMatching = {
      version: 1,
      source: "cache/提示词分支匹配.json",
      catalogFingerprint: conditionMatching.catalogFingerprint,
      conditionRegistryFingerprint: conditionMatching.conditionRegistryFingerprint,
    };
  }
  if (referenceRedrawMode) {
    queue.operation = "reference_redraw";
    queue.referenceRedraw = {
      version: 1,
      batchId: redrawBatchId,
      sourceRoot: "输出/资产图",
      outputRoot: `输出/资产图/API重绘/${redrawBatchId}`,
      candidateCount: items.length + skippedMissingSources.length,
      sourceCount: items.length,
      skippedMissingSources,
    };
  }
  if (apiPromptBatch) queue.apiPromptBatch = apiPromptBatch;
  if (selectedBuiltinBatch) {
    queue.builtinPromptBatch = selectedBuiltinBatch;
  }

  if (
    referenceRedrawMode &&
    Object.entries(previousProgress.items).some(
      ([, state]) => isObject(state) && state.backend === "builtin" && state.status === "generating",
    )
  ) {
    throw new Error("内置 image_gen 任务仍在运行，禁止切换到 API 参考图批量重绘");
  }
  const activeApiTasks = countActiveCompatibleApiTasks({
    previousProgress,
    previousQueueItems,
    items,
  });
  if (activeApiTasks) {
    console.log(
      JSON.stringify(
        {
          queuePath,
          reused: true,
          reason: "api_tasks_active",
          activeApiTasks,
          total: previousQueueItems.length,
        },
        null,
        2,
      ),
    );
  } else {
    const preservedItems = buildPreservedProgressItems({
      items,
      previousProgress,
      referenceRedrawMode,
      reuseReferenceRedrawProgress,
      selectedBuiltinBatch,
      builtinDefinition,
    });
    const progress = {
      version: 3,
      routingFingerprint,
      items: preservedItems,
    };

    await assertSafeOutputPath(skillRoot, imageOutputRoot);
    await fs.mkdir(imageOutputRoot, { recursive: true });
    await assertSafeOutputPath(skillRoot, imageOutputRoot, { targetMayBeMissing: false });
    await Promise.all(
      config.sheetOrder.map(async (sheetName) => {
        const outputFolder = referenceRedrawMode
          ? resolveRedrawOutputFolder(config.routes[sheetName].outputFolder)
          : resolveOutputFolder(config.routes[sheetName].outputFolder);
        await assertSafeOutputPath(imageOutputRoot, outputFolder);
        await fs.mkdir(outputFolder, { recursive: true });
        await assertSafeOutputPath(imageOutputRoot, outputFolder, {
          targetMayBeMissing: false,
        });
      }),
    );
    await writeJsonAtomic(queuePath, queue);
    try {
      await writeJsonAtomic(progressPath, progress);
    } catch (error) {
      try {
        if (previousQueue === null) await fs.rm(queuePath, { force: true });
        else await writeJsonAtomic(queuePath, previousQueue);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "出图进度写入失败，且队列回滚失败；禁止继续执行",
        );
      }
      throw error;
    }

    console.log(
      JSON.stringify(
        {
          queuePath,
          total: items.length,
          counts,
          skippedPending,
          operation: referenceRedrawMode ? "reference_redraw" : "generate",
          skippedMissingSources,
          preservedProgress: Object.keys(preservedItems).length,
          builtAt,
          routingFingerprint,
          eligibilityFingerprint,
        },
        null,
        2,
      ),
    );
  }
} finally {
  await releasePipelineLock(lockPath, { token: lock.token });
}
