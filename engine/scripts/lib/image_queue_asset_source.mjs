import path from "node:path";

import { cleanText, readJsonFile } from "./pipeline_runtime.mjs";

const ASSET_RECORD_FILES = Object.freeze({
  角色: "角色记录.json",
  生物: "生物记录.json",
  群演: "群演记录.json",
  场景: "场景记录.json",
  道具: "道具记录.json",
});

export const sortAssetRecords = (records) => [...records].sort(
  (left, right) =>
    Number(left?.firstRequiredEpisode) - Number(right?.firstRequiredEpisode) ||
    Number(left?.firstRequiredOrder) - Number(right?.firstRequiredOrder) ||
    cleanText(left?.assetId).localeCompare(cleanText(right?.assetId), "zh-CN", { numeric: true }),
);

export const readOrderedAssetRecords = async (cacheDir, sheetOrder) => new Map(
  await Promise.all(sheetOrder.map(async (sheetName) => {
    const filename = ASSET_RECORD_FILES[sheetName];
    if (!filename) throw new Error(`未知资产类别：${sheetName}`);
    const records = await readJsonFile(path.join(cacheDir, "累计记录", filename), {
      label: `${sheetName}累计记录`,
    });
    if (!Array.isArray(records)) throw new Error(`${sheetName}累计记录必须是数组`);
    return [sheetName, sortAssetRecords(records)];
  })),
);
