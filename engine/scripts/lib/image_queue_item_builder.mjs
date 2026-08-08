import fs from "node:fs/promises";
import path from "node:path";

import {
  ASSET_ID_PATTERNS,
  builtinSheetIsEnabled,
  cleanText,
  hasExactKeys,
  makeAssetFingerprint,
  makeBuiltinPromptSpec,
  sha256,
  validatePngBytes,
} from "./pipeline_runtime.mjs";
import { composeApiPrompt } from "./image_queue_prompt_builder.mjs";


export async function buildImageQueueItems({
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
}) {
    const items = [];
    const counts = {};
    const skippedPending = [];
    const skippedMissingSources = [];
    const allAssetIds = new Set();
    for (const sheetName of config.sheetOrder) {
      const route = config.routes[sheetName];
      const outputFolder = resolveOutputFolder(route.outputFolder);
      const records = recordsBySheet.get(sheetName) ?? [];
      if (!records.length) {
        counts[sheetName] = 0;
        continue;
      }
  
      let assetOrder = 0;
      const assetNames = new Set();
      for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
        const record = records[recordIndex];
        const assetId = cleanText(record?.assetId);
        const assetName = cleanText(record?.assetName);
        const productionNotes = cleanText(record?.productionNotes);
        if (!assetId || !assetName || !productionNotes) {
          throw new Error(`${sheetName}累计记录第 ${recordIndex + 1} 项资产ID、资产名称或制作说明为空`);
        }
        if (!ASSET_ID_PATTERNS[sheetName]?.test(assetId)) {
          throw new Error(`${sheetName}累计记录第 ${recordIndex + 1} 项资产ID格式错误：${assetId}`);
        }
        if (allAssetIds.has(assetId)) throw new Error(`累计记录存在重复资产ID：${assetId}`);
        allAssetIds.add(assetId);
        if (assetNames.has(assetName)) {
          throw new Error(`${sheetName}累计记录存在重复资产名称：${assetName}`);
        }
        assetNames.add(assetName);
  
        const outputFileName = `${assetId}_${safeFilePart(assetName)}.png`;
        const references = [];
        const referenceSnapshots = [];
        let targetOutputFolder = outputFolder;
        if (referenceRedrawMode) {
          const sourcePath = path.join(outputFolder, outputFileName);
          const relativeSourcePath = path.relative(skillRoot, sourcePath).split(path.sep).join("/");
          let sourceBytes;
          let sourceStat;
          try {
            sourceStat = await fs.stat(sourcePath);
            if (!sourceStat.isFile()) throw new Error("不是文件");
            if (sourceStat.size <= 0) throw new Error("文件为空");
            if (sourceStat.size > 20 * 1024 * 1024) throw new Error("超过 20MB");
            sourceBytes = await fs.readFile(sourcePath);
            if (!validatePngBytes(sourceBytes)) {
              throw new Error("不是有效 PNG 文件");
            }
          } catch (error) {
            skippedMissingSources.push({
              key: `${sheetName}:${assetId}`,
              assetId,
              assetName,
              expectedPath: relativeSourcePath,
              reason: error?.code === "ENOENT" ? "原图不存在" : error.message,
            });
            continue;
          }
          references.push(relativeSourcePath);
          referenceSnapshots.push({
            path: relativeSourcePath,
            size: sourceStat.size,
            sha256: sha256(sourceBytes),
          });
          targetOutputFolder = resolveRedrawOutputFolder(route.outputFolder);
        }
  
        assetOrder += 1;
        const relativeOutputPath = path
          .relative(
            skillRoot,
            path.join(targetOutputFolder, outputFileName),
          )
          .split(path.sep)
          .join("/");
        const prompt = composeApiPrompt(promptTemplates[sheetName], productionNotes);
        const queueKey = `${sheetName}:${assetId}`;
        let conditionAssignment = null;
        if (conditionMatching) {
          conditionAssignment = conditionMatching.items[queueKey];
          if (
            !hasExactKeys(conditionAssignment, ["selectedConditionModuleIds"]) ||
            !Array.isArray(conditionAssignment.selectedConditionModuleIds) ||
            conditionAssignment.selectedConditionModuleIds.some(
              (id) => typeof id !== "string" || !cleanText(id),
            ) ||
            new Set(conditionAssignment.selectedConditionModuleIds).size !==
              conditionAssignment.selectedConditionModuleIds.length
          ) {
            throw new Error(`提示词分支匹配缺少或破坏了队列项：${queueKey}`);
          }
        }
        const assetFingerprint = makeAssetFingerprint({
          sheetName,
          assetId,
          assetName,
          productionNotes,
          outputPath: relativeOutputPath,
        });
        const inputPayload = {
            sheetName,
            assetId,
            assetName,
            productionNotes,
            prompt,
            routeFingerprint: routeFingerprints.get(sheetName),
            ...(conditionAssignment ? { conditionAssignment } : {}),
        };
        if (referenceRedrawMode) {
          Object.assign(inputPayload, {
            operation: "reference_redraw",
            references,
            referenceSnapshots,
          });
        }
        const inputFingerprint = sha256(JSON.stringify(inputPayload));
        const item = {
          key: queueKey,
          sheetName,
          rowNumber: recordIndex + 2,
          assetId,
          assetName,
          productionNotes,
          prompt,
          outputPath: relativeOutputPath,
          assetFingerprint,
          inputFingerprint,
          ...(conditionAssignment
            ? {
                selectedConditionModuleIds: [...conditionAssignment.selectedConditionModuleIds],
              }
            : {}),
        };
        if (referenceRedrawMode) {
          item.operation = "reference_redraw";
          item.references = references;
          item.referenceSnapshots = referenceSnapshots;
        }
        const shouldValidateBuiltinPrompt =
          selectedBuiltinBatch &&
          builtinSheetIsEnabled(selectedBuiltinBatch, item) &&
          (!apiPromptMode || conditionAssignment);
        if (shouldValidateBuiltinPrompt) {
          const promptSpec = makeBuiltinPromptSpec(builtinDefinition, selectedBuiltinBatch, item);
          if (promptSpec.status !== "configured") {
            throw new Error(
              `任务提示词配置无效：${item.key}：${promptSpec.message || promptSpec.status}`,
            );
          }
        }
        items.push(item);
      }
      counts[sheetName] = assetOrder;
    }
  
    if (referenceRedrawMode && !items.length) {
      throw new Error(
        `没有找到可重绘的原图。请先确认“输出/资产图/分类/资产ID_资产名称.png”存在；本次缺少 ${skippedMissingSources.length} 项。`,
      );
    }
    if (conditionMatching) {
      const queueKeys = new Set(items.map((item) => item.key));
      const matchingKeys = Object.keys(conditionMatching.items);
      const extraKeys = matchingKeys.filter((key) => !queueKeys.has(key));
      if (matchingKeys.length !== queueKeys.size || extraKeys.length > 0) {
        throw new Error(
          `提示词分支匹配项必须与当前出图队列逐项一致；多余或过期 key：${extraKeys.join(", ") || "存在未定位的遗漏项"}`,
        );
      }
    }
  
  return { counts, items, skippedMissingSources, skippedPending };
}

