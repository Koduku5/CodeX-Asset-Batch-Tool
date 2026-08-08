import fs from 'node:fs/promises';
import path from 'node:path';

import {
  ASSET_ID_PATTERNS,
  assertConditionMatchingQueueCurrent,
  assertSafeOutputPath,
  builtinPromptBatchMatchesCatalog,
  builtinSheetIsEnabled,
  canonicalSha256,
  cleanText,
  isObject,
  isPathWithinOrSame,
  makeAssetFingerprint,
  makeBuiltinPromptFingerprint,
  makeBuiltinPromptSpec,
  parseJsonText,
  readJsonFile,
  readValidatedReferenceImageInfo,
  sha256,
  validateBuiltinPromptBatch,
  validateBuiltinPromptDefinition
} from '../pipeline_runtime.mjs';

export async function loadImageJobQueueContext({
  skillRoot,
  onlyKey,
  queuePath,
  pendingPath,
  builtinDefinitionPath,
  builtinReferenceRoot,
  imageOutputRoot,
  resolveImageOutput
}) {
  const builtinDefinitionRaw = await fs.readFile(builtinDefinitionPath, 'utf8');
  const builtinDefinition = parseJsonText(builtinDefinitionRaw, '内置 image_gen 固定字段');
  if (!validateBuiltinPromptDefinition(builtinDefinition)) {
    throw new Error('内置 image_gen 固定字段结构无效');
  }
  const pendingRaw = await fs.readFile(pendingPath, 'utf8');
  const pendingRecords = parseJsonText(pendingRaw, '待确认记录');
  if (!Array.isArray(pendingRecords)) throw new Error('待确认记录顶层必须是数组');
  const eligibilityFingerprint = sha256(pendingRaw);

  const queue = await readJsonFile(queuePath, { label: '出图队列', retries: 2 });
  if (
    !isObject(queue)
    || queue.version !== 4
    || !Array.isArray(queue.items)
    || !cleanText(queue.builtAt)
    || !cleanText(queue.routingFingerprint)
    || !cleanText(queue.eligibilityFingerprint)
  ) {
    throw new Error('出图队列尚未建立或结构无效，请先重新建立出图队列');
  }
  if (cleanText(queue.operation) && queue.operation !== 'generate') {
    throw new Error('当前队列属于 API 参考图批量重绘，不能交给内置 image_gen 执行');
  }
  if (onlyKey && !queue.items.some((item) => cleanText(item?.key) === onlyKey)) {
    throw new Error(`指定的内置出图任务不存在：${onlyKey}`);
  }
  if (queue.eligibilityFingerprint !== eligibilityFingerprint) {
    throw new Error('待确认记录已变化，资产出图资格需要重新计算，请重新建立出图队列');
  }
  assertConditionMatchingQueueCurrent(queue);
  const builtinPromptBatch = queue.builtinPromptBatch;
  if (!validateBuiltinPromptBatch(builtinPromptBatch)) {
    throw new Error('本批次尚未确认内置 image_gen 风格与生成类型，请先完成选择式配置');
  }
  if (!builtinPromptBatchMatchesCatalog(builtinPromptBatch)) {
    throw new Error('内置 image_gen 当前活动风格路由已变化，请重新打开风格路由窗口确认');
  }
  const builtinConfigFingerprint = canonicalSha256(builtinPromptBatch);
  if (!Number.isFinite(Date.parse(queue.builtAt))) {
    throw new Error('出图队列 builtAt 无效，请重新建立出图队列');
  }

  const queueKeys = new Set();
  const itemByKey = new Map();
  const builtinPromptSpecByKey = new Map();
  const builtinPromptFingerprintByKey = new Map();
  const referencePathsByKey = new Map();
  const validatedReferencePaths = new Map();
  for (const item of queue.items) {
    if (
      !isObject(item)
      || !cleanText(item.key)
      || !cleanText(item.assetName)
      || !cleanText(item.productionNotes)
      || !cleanText(item.outputPath)
      || !cleanText(item.inputFingerprint)
      || !cleanText(item.assetFingerprint)
      || queueKeys.has(item.key)
    ) {
      throw new Error('出图队列含无效或重复 key，请重新建立出图队列');
    }
    queueKeys.add(item.key);
    itemByKey.set(item.key, item);
    if (!ASSET_ID_PATTERNS[item.sheetName]?.test(cleanText(item.assetId))) {
      throw new Error(`任务资产ID无效：${item.key}；请重新建立出图队列`);
    }
    if (item.assetFingerprint !== makeAssetFingerprint(item)) {
      throw new Error(`内置任务输入已变化或队列损坏：${item.key}；请重新建立出图队列`);
    }
    const promptSpec = makeBuiltinPromptSpec(builtinDefinition, builtinPromptBatch, item);
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
      builtinSheetIsEnabled(builtinPromptBatch, item)
      && promptSpec.referencePolicy === 'required'
      && referencePaths.length === 0
    ) {
      throw new Error(`内置路由缺少必填参考图片：${promptSpec.styleId}/${item.sheetName}`);
    }
    if (builtinSheetIsEnabled(builtinPromptBatch, item) && promptSpec.status !== 'configured') {
      throw new Error(`内置任务提示词配置无效：${item.key}：${promptSpec.message || promptSpec.status}`);
    }
    builtinPromptSpecByKey.set(item.key, promptSpec);
    referencePathsByKey.set(item.key, referencePaths);
    builtinPromptFingerprintByKey.set(
      item.key,
      makeBuiltinPromptFingerprint(item.assetFingerprint, promptSpec)
    );
    const queueOutput = resolveImageOutput(item.outputPath);
    await assertSafeOutputPath(imageOutputRoot, queueOutput.absolute);
  }

  return Object.freeze({
    queue,
    queueKeys,
    itemByKey,
    builtinPromptBatch,
    builtinConfigFingerprint,
    builtinPromptSpecByKey,
    builtinPromptFingerprintByKey,
    referencePathsByKey
  });
}
