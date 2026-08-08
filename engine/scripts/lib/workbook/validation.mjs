import fs from 'node:fs/promises';
import path from 'node:path';

import {
  canonicalSha256,
  hasExactKeys,
  isObject,
  readJsonFile,
  readStableFileSnapshot,
  sha256
} from '../pipeline_runtime.mjs';

export const WORKBOOK_ASSET_TYPES = Object.freeze(['characters', 'creatures', 'extras', 'scenes', 'props']);
const WORKBOOK_ASSET_TYPE_SET = new Set(WORKBOOK_ASSET_TYPES);
const VALIDATION_RECEIPT_VERSION = 1;
const VALIDATOR_PROTOCOL_VERSION = 5;
const WORKBOOK_SCOPE_RECEIPT_VERSION = 1;

export const parseWorkbookScope = (values) => {
  if (values.length === 1) return null;
  if (values.length !== 4) {
    throw new Error('用法：node build_workbook.mjs <skill-root> [--episode-start=N --episode-end=N --asset-types=types]');
  }
  const options = new Map();
  for (const value of values.slice(1)) {
    const match = /^--(episode-start|episode-end|asset-types)=(.+)$/u.exec(value);
    if (!match || options.has(match[1])) throw new Error('局部资产表参数无效或重复');
    options.set(match[1], match[2]);
  }
  if (options.size !== 3) throw new Error('局部资产表必须同时指定起止集数和资产类型');
  const episodeStart = Number(options.get('episode-start'));
  const episodeEnd = Number(options.get('episode-end'));
  const assetTypes = options.get('asset-types').split(',');
  if (!Number.isInteger(episodeStart) || !Number.isInteger(episodeEnd)
    || episodeStart < 1 || episodeEnd > 10000 || episodeStart > episodeEnd
    || !assetTypes.length || assetTypes.some((value) => !WORKBOOK_ASSET_TYPE_SET.has(value))
    || new Set(assetTypes).size !== assetTypes.length) {
    throw new Error('局部资产表必须使用有效的闭区间集数和至少一种不重复的资产类型');
  }
  return Object.freeze({ episodeStart, episodeEnd, assetTypes: Object.freeze(assetTypes) });
};

export function createWorkbookValidation({
  skillRoot,
  workbookScopeReceiptPath,
  readingProgressPath,
  registryDir,
  screenplayDir,
  overviewPath,
  validationReceiptPath,
  pendingPath
}) {
  const readWorkbookScopeReceipt = async () => {
    try {
      const receipt = await readJsonFile(workbookScopeReceiptPath, { label: "资产表范围" });
      const expected = [
        "version", "mode", "episodeStart", "episodeEnd", "assetTypes", "sourceFingerprint",
        "validationFingerprint", "workbookSha256", "updatedAt",
      ];
      if (!hasExactKeys(receipt, expected)
        || receipt.version !== WORKBOOK_SCOPE_RECEIPT_VERSION
        || !["scoped", "full"].includes(receipt.mode)
        || !Array.isArray(receipt.assetTypes)
        || receipt.assetTypes.some((value) => !WORKBOOK_ASSET_TYPE_SET.has(value))
        || new Set(receipt.assetTypes).size !== receipt.assetTypes.length
        || !/^[a-f0-9]{64}$/iu.test(receipt.sourceFingerprint ?? "")
        || !/^[a-f0-9]{64}$/iu.test(receipt.validationFingerprint ?? "")
        || !/^[a-f0-9]{64}$/iu.test(receipt.workbookSha256 ?? "")
        || typeof receipt.updatedAt !== "string" || !Number.isFinite(Date.parse(receipt.updatedAt))
        || (receipt.mode === "full"
          ? receipt.episodeStart !== null || receipt.episodeEnd !== null
            || JSON.stringify(receipt.assetTypes) !== JSON.stringify(WORKBOOK_ASSET_TYPES)
          : !Number.isInteger(receipt.episodeStart) || !Number.isInteger(receipt.episodeEnd)
            || receipt.episodeStart < 1 || receipt.episodeEnd > 10000
            || receipt.episodeStart > receipt.episodeEnd || !receipt.assetTypes.length)) {
        throw new Error("资产表范围记录无效");
      }
      return receipt;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  };

  const snapshotPath = async (filePath) => {
    try {
      return await fs.realpath(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") return path.resolve(filePath);
      throw error;
    }
  };

  const validationInputPaths = async () => {
    const cacheDir = path.join(skillRoot, "cache");
    const progress = await readJsonFile(readingProgressPath, { label: "阅读进度" });
    const discovered = Array.isArray(progress?.discoveredEpisodes)
      ? progress.discoveredEpisodes.filter((value) => Number.isInteger(value) && value > 0)
      : [];
    const fixed = [
      readingProgressPath,
      path.join(cacheDir, "待确认记录.json"),
      path.join(cacheDir, "世界观分页进度.json"),
      overviewPath,
      path.join(registryDir, "世界观记录.json"),
      path.join(registryDir, "角色记录.json"),
      path.join(registryDir, "生物记录.json"),
      path.join(registryDir, "群演记录.json"),
      path.join(registryDir, "场景记录.json"),
      path.join(registryDir, "道具记录.json"),
    ];
    const episodePaths = discovered.flatMap((episode) =>
      ["单集原文", "单集分析"].map((directory) =>
        path.join(cacheDir, directory, `第${String(episode).padStart(3, "0")}集.json`),
      ),
    );
    const sourceEntries = await fs.readdir(screenplayDir, { withFileTypes: true });
    const sourcePaths = sourceEntries
      .filter(
        (entry) =>
          entry.isFile() &&
          !entry.name.startsWith("~$") &&
          [".docx", ".txt"].includes(path.extname(entry.name).toLowerCase()),
      )
      .map((entry) => path.join(screenplayDir, entry.name));

    const unique = new Map();
    for (const candidate of [...sourcePaths, ...fixed, ...episodePaths]) {
      const resolved = await snapshotPath(candidate);
      unique.set(resolved.toLowerCase(), resolved);
    }
    return [...unique.values()].sort((left, right) => {
      const leftKey = left.split(path.sep).join("/").toLowerCase();
      const rightKey = right.split(path.sep).join("/").toLowerCase();
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  };

  const currentValidationSnapshot = async () => {
    const resolvedRoot = await fs.realpath(skillRoot);
    const files = [];
    for (const filePath of await validationInputPaths()) {
      const relativeNative = path.relative(resolvedRoot, filePath);
      if (
        relativeNative === ".." ||
        relativeNative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeNative)
      ) {
        throw new Error(`校验输入越出 Skill 根目录：${filePath}`);
      }
      const relative = relativeNative.split(path.sep).join("/");
      const snapshot = await readStableFileSnapshot(filePath);
      files.push({ path: relative, sha256: snapshot.exists ? snapshot.sha256 : "missing" });
    }
    return files;
  };

  const assertValidationReceipt = async () => {
    let receipt;
    try {
      receipt = await readJsonFile(validationReceiptPath, { label: "资产校验收据" });
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error("缺少资产校验收据，请先运行 validate_asset_records.py");
      }
      throw error;
    }
    const expectedFields = [
      "version",
      "validatorProtocolVersion",
      "snapshotFingerprint",
      "files",
      "validatedAt",
    ].sort();
    if (
      !hasExactKeys(receipt, expectedFields) ||
      receipt.version !== VALIDATION_RECEIPT_VERSION ||
      receipt.validatorProtocolVersion !== VALIDATOR_PROTOCOL_VERSION ||
      !/^[a-f0-9]{64}$/i.test(receipt.snapshotFingerprint ?? "") ||
      typeof receipt.validatedAt !== "string" ||
      !/(?:Z|[+-]\d{2}:\d{2})$/i.test(receipt.validatedAt) ||
      !Number.isFinite(Date.parse(receipt.validatedAt)) ||
      !Array.isArray(receipt.files)
    ) {
      throw new Error("资产校验收据结构或协议版本无效，请重新运行 validate_asset_records.py");
    }
    const current = await currentValidationSnapshot();
    if (
      JSON.stringify(receipt.files) !== JSON.stringify(current) ||
      canonicalSha256({ files: current }) !== receipt.snapshotFingerprint
    ) {
      throw new Error("资产校验收据已过期，Cache 或剧本在校验后发生变化，请重新运行校验");
    }
    return receipt.snapshotFingerprint;
  };

  const assertNoPendingConfirmations = async () => {
    const records = await readJsonFile(pendingPath, { label: "待确认记录" });
    if (!Array.isArray(records)) throw new Error("待确认记录顶层必须是数组");
    const unresolved = records.filter((record) => record?.status === "pending"
      || (record?.draftAsset && typeof record.draftAsset === "object"
        && !String(record?.appliedAt ?? "").trim()));
    if (unresolved.length) {
      throw new Error(`仍有 ${unresolved.length} 项资产尚未完成人工确认与正式纳入，处理完成前禁止生成 Excel`);
    }
  };

  const sortAssets = (items) =>
    [...items].sort(
      (left, right) =>
        (left.firstRequiredEpisode ?? Number.MAX_SAFE_INTEGER) -
          (right.firstRequiredEpisode ?? Number.MAX_SAFE_INTEGER) ||
        (left.firstRequiredOrder ?? Number.MAX_SAFE_INTEGER) -
          (right.firstRequiredOrder ?? Number.MAX_SAFE_INTEGER) ||
        String(left.assetName ?? "").localeCompare(String(right.assetName ?? ""), "zh-CN"),
    );

  const columnName = (index) => String.fromCharCode(65 + index);

  const snapshotsMatch = (left, right) =>
    left?.exists === true &&
    right?.exists === true &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.sha256 === right.sha256;

  const assertCurrentSources = async () => {
    const progress = await readJsonFile(readingProgressPath, { label: "阅读进度" });
    if (
      !isObject(progress) ||
      progress.status !== "complete" ||
      !Array.isArray(progress.sourceManifest) ||
      !Array.isArray(progress.discoveredEpisodes) ||
      !Array.isArray(progress.completedEpisodes) ||
      progress.discoveredEpisodes.length === 0 ||
      JSON.stringify(progress.completedEpisodes) !== JSON.stringify(progress.discoveredEpisodes)
    ) {
      throw new Error("剧本尚未完成全部分集分析，禁止生成 Excel");
    }
    const entries = await fs.readdir(screenplayDir, { withFileTypes: true });
    const sourceNames = entries
      .filter(
        (entry) =>
          entry.isFile() &&
          !entry.name.startsWith("~$") &&
          [".docx", ".txt"].includes(path.extname(entry.name).toLowerCase()),
      )
      .map((entry) => entry.name);
    const recorded = new Map();
    for (const item of progress.sourceManifest) {
      if (
        !isObject(item) ||
        typeof item.name !== "string" ||
        !Number.isInteger(item.size) ||
        typeof item.sha256 !== "string" ||
        recorded.has(item.name)
      ) {
        throw new Error("阅读进度中的剧本来源指纹结构无效");
      }
      recorded.set(item.name, item);
    }
    if (recorded.size !== sourceNames.length) {
      throw new Error("剧本文件与 Cache 来源指纹不一致，请重新切分或清空 Cache");
    }
    const actual = [];
    for (const name of sourceNames) {
      const expected = recorded.get(name);
      if (!expected) {
        throw new Error("剧本文件与 Cache 来源指纹不一致，请重新切分或清空 Cache");
      }
      const filePath = path.join(screenplayDir, name);
      const snapshot = await readStableFileSnapshot(filePath);
      if (!snapshot.exists) {
        throw new Error(`剧本来源已缺失：${name}；请重新切分或清空 Cache`);
      }
      if (snapshot.size !== expected.size || snapshot.sha256 !== expected.sha256) {
        throw new Error(`剧本来源已变化：${name}；请重新切分或清空 Cache`);
      }
      actual.push({ name, size: snapshot.size, sha256: expected.sha256 });
    }
    actual.sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true }));
    return sha256(JSON.stringify(actual));
  };

  return Object.freeze({
    readWorkbookScopeReceipt,
    assertValidationReceipt,
    assertNoPendingConfirmations,
    assertCurrentSources,
    sortAssets,
    columnName,
    snapshotsMatch
  });
}

