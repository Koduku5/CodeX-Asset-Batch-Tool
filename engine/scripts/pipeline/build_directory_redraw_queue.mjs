import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  acquirePipelineLock,
  canonicalSha256,
  cleanText,
  isObject,
  readJsonFile,
  releasePipelineLock,
  sha256,
  writeJsonAtomic,
} from "../lib/pipeline_runtime.mjs";
import { imageSignatureMatches } from "../lib/directory-redraw/image-signatures.mjs";
import {
  comparePortablePaths,
  comparisonPathKey,
  decodeConfiguration,
  isWithinOrSame,
  normalizeCase,
  requireRealDirectory,
  resolveInside,
  toPortableRelativePath,
} from "../lib/directory-redraw/contracts.mjs";
import {
  assertOutputTargetsAvailable,
  isBlankInitializedProgress,
  isBlankInitializedQueue,
  queueHasIncompleteItems,
  validateItemUniqueness,
  validatePreviousState,
} from "../lib/directory-redraw/queue-state.mjs";

const args = process.argv.slice(2);
if (args.length !== 1) {
  throw new Error("用法：node build_directory_redraw_queue.mjs <skill-root>");
}

const skillRoot = path.resolve(args[0]);
const cacheDir = path.join(skillRoot, "cache");
const redrawCacheDir = path.join(cacheDir, "批量重绘");
const queuePath = path.join(redrawCacheDir, "队列.json");
const progressPath = path.join(redrawCacheDir, "进度.json");
const lockPath = path.join(cacheDir, ".pipeline.lock");
const supportedExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const maxReferenceBytes = 20 * 1024 * 1024;
const maxScannedEntries = 100_000;
const maxSourceImages = 10_000;
const maxTotalSourceBytes = 50n * 1024n * 1024n * 1024n;



const skippedRecord = (sourceRelativePath, code, reason) => ({
  sourceRelativePath: toPortableRelativePath(sourceRelativePath),
  code,
  reason,
});

const scanSourceDirectory = async (sourceRoot, prompt, promptFingerprint) => {
  const discovered = [];
  const skipped = [];
  let scannedEntries = 0;
  let acceptedSourceBytes = 0n;

  const walk = async (directory) => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (normalizeCase(directory) === normalizeCase(sourceRoot)) throw error;
      skipped.push(
        skippedRecord(
          path.relative(sourceRoot, directory),
          "directory_unreadable",
          `子文件夹无法读取（${error?.code ?? "unknown"}）`,
        ),
      );
      return;
    }
    entries.sort((left, right) => comparePortablePaths(left.name, right.name));

    for (const entry of entries) {
      scannedEntries += 1;
      if (scannedEntries > maxScannedEntries) {
        throw new Error(`原图目录超过 ${maxScannedEntries} 个条目安全上限，请缩小选择范围`);
      }
      const absolutePath = path.join(directory, entry.name);
      const relativePath = toPortableRelativePath(path.relative(sourceRoot, absolutePath));
      let stat;
      try {
        stat = await fs.lstat(absolutePath, { bigint: true });
      } catch (error) {
        if (entry.isDirectory() || supportedExtensions.has(path.extname(entry.name).toLowerCase())) {
          skipped.push(
            skippedRecord(
              relativePath,
              "file_unreadable",
              `文件无法读取（${error?.code ?? "unknown"}）`,
            ),
          );
        }
        continue;
      }

      if (stat.isSymbolicLink()) {
        skipped.push(
          skippedRecord(relativePath, "link_skipped", "符号链接或目录联接未跟随"),
        );
        continue;
      }
      if (stat.isDirectory()) {
        let realDirectory;
        try {
          realDirectory = await fs.realpath(absolutePath);
        } catch (error) {
          skipped.push(
            skippedRecord(
              relativePath,
              "directory_unreadable",
              `子文件夹无法解析（${error?.code ?? "unknown"}）`,
            ),
          );
          continue;
        }
        if (!isWithinOrSame(realDirectory, sourceRoot)) {
          skipped.push(
            skippedRecord(relativePath, "directory_escape", "子文件夹解析后越出原图目录"),
          );
          continue;
        }
        await walk(realDirectory);
        continue;
      }
      if (!stat.isFile()) continue;

      const extension = path.extname(entry.name).toLowerCase();
      if (!supportedExtensions.has(extension)) continue;
      if (stat.size <= 0n) {
        skipped.push(skippedRecord(relativePath, "file_empty", "图片文件为空"));
        continue;
      }
      if (stat.size > BigInt(maxReferenceBytes)) {
        skipped.push(
          skippedRecord(relativePath, "file_too_large", "图片超过 20MB，未加入重绘队列"),
        );
        continue;
      }
      if (discovered.length >= maxSourceImages) {
        throw new Error(`可重绘图片超过 ${maxSourceImages} 张安全上限，请拆分批次`);
      }
      if (acceptedSourceBytes + stat.size > maxTotalSourceBytes) {
        throw new Error("可重绘图片总大小超过 50 GiB 安全上限，请拆分批次");
      }

      let realFile;
      let bytes;
      let finalStat;
      try {
        realFile = await fs.realpath(absolutePath);
        if (!isWithinOrSame(realFile, sourceRoot)) {
          skipped.push(skippedRecord(relativePath, "file_escape", "图片解析后越出原图目录"));
          continue;
        }
        bytes = await fs.readFile(realFile);
        finalStat = await fs.stat(realFile, { bigint: true });
      } catch (error) {
        skipped.push(
          skippedRecord(
            relativePath,
            "file_unreadable",
            `图片无法读取（${error?.code ?? "unknown"}）`,
          ),
        );
        continue;
      }
      if (finalStat.size !== stat.size || finalStat.mtimeNs !== stat.mtimeNs) {
        skipped.push(
          skippedRecord(relativePath, "file_changed", "图片在建立队列期间发生变化"),
        );
        continue;
      }
      if (!imageSignatureMatches(extension, bytes)) {
        skipped.push(
          skippedRecord(relativePath, "invalid_signature", "图片内容与文件扩展名不匹配"),
        );
        continue;
      }

      const parsed = path.posix.parse(relativePath);
      const outputRelativePath = parsed.dir ? `${parsed.dir}/${parsed.name}.png` : `${parsed.name}.png`;
      const sourceSnapshot = {
        size: Number(stat.size),
        sha256: sha256(bytes),
      };
      const key = `file-${sha256(comparisonPathKey(relativePath)).slice(0, 24)}`;
      const inputFingerprint = canonicalSha256({
        operation: "directory_redraw",
        sourceRelativePath: relativePath,
        sourceSnapshot,
        outputRelativePath,
        promptFingerprint,
      });
      discovered.push({
        key,
        sourceRelativePath: relativePath,
        outputRelativePath,
        sourceSnapshot,
        prompt,
        inputFingerprint,
      });
      acceptedSourceBytes += stat.size;
    }
  };

  await walk(sourceRoot);
  discovered.sort((left, right) =>
    comparePortablePaths(left.sourceRelativePath, right.sourceRelativePath),
  );
  skipped.sort((left, right) =>
    comparePortablePaths(left.sourceRelativePath, right.sourceRelativePath),
  );
  return { items: discovered, skipped };
};


const newBatchId = () => {
  const timestamp = new Date().toISOString().replace(/\D/g, "");
  return `redraw-${timestamp}-${crypto.randomUUID().slice(0, 8)}`;
};

const requested = decodeConfiguration();
const lock = await acquirePipelineLock(lockPath, {
  kind: "queue_build",
  key: "directory_redraw_queue",
  leaseMode: "transient",
});

try {
  const sourceRoot = await requireRealDirectory(requested.sourceRoot, "原图文件夹");
  const outputRoot = await requireRealDirectory(requested.outputRoot, "结果保存文件夹");
  const realSkillRoot = await fs.realpath(skillRoot);
  if (
    isWithinOrSame(sourceRoot, realSkillRoot) ||
    isWithinOrSame(realSkillRoot, sourceRoot) ||
    isWithinOrSame(outputRoot, realSkillRoot) ||
    isWithinOrSame(realSkillRoot, outputRoot)
  ) {
    throw new Error("原图和结果目录必须与 Skill 项目目录完全分离，不能位于其中或包含它");
  }
  if (isWithinOrSame(sourceRoot, outputRoot) || isWithinOrSame(outputRoot, sourceRoot)) {
    throw new Error("原图文件夹与结果保存文件夹不能相同，也不能互为上级或下级目录");
  }

  const promptFingerprint = canonicalSha256({ prompt: requested.prompt });
  const { items, skipped } = await scanSourceDirectory(
    sourceRoot,
    requested.prompt,
    promptFingerprint,
  );
  validateItemUniqueness(items);
  if (!items.length) {
    throw new Error(
      `原图文件夹中没有可执行图片；已跳过 ${skipped.length} 项。支持 PNG、JPG、JPEG、GIF、WEBP，单图不超过 20MB。`,
    );
  }

  const queueFingerprint = canonicalSha256({
    version: 1,
    operation: "directory_redraw",
    sourceRoot,
    outputRoot,
    promptFingerprint,
    recursive: true,
    items: items.map((item) => ({
      key: item.key,
      sourceRelativePath: item.sourceRelativePath,
      outputRelativePath: item.outputRelativePath,
      sourceSnapshot: item.sourceSnapshot,
      inputFingerprint: item.inputFingerprint,
    })),
    skipped,
  });

  let [previousQueue, previousProgress] = await Promise.all([
    readJsonFile(queuePath, { fallback: null, label: "旧批量重绘队列" }),
    readJsonFile(progressPath, { fallback: null, label: "旧批量重绘进度" }),
  ]);
  if (isBlankInitializedQueue(previousQueue) && isBlankInitializedProgress(previousProgress)) {
    previousQueue = null;
    previousProgress = null;
  }
  if ((previousQueue === null) !== (previousProgress === null)) {
    throw new Error("批量重绘队列与进度文件不成对，禁止覆盖可能可恢复的任务");
  }

  let resume = false;
  let batchId = newBatchId();
  let builtAt = new Date().toISOString();
  let preservedItems = {};
  let preservedApiBatch = null;
  if (previousQueue !== null) {
    validatePreviousState(previousQueue, previousProgress);
    const previousIncomplete = queueHasIncompleteItems(previousQueue, previousProgress);
    if (previousIncomplete && previousQueue.queueFingerprint !== queueFingerprint) {
      throw new Error(
        "已有未完成的目录批量重绘，且原图、结果目录或统一重绘要求已经变化；请先按原批次恢复，禁止覆盖远端任务状态",
      );
    }
    if (previousIncomplete) {
      resume = true;
      batchId = previousQueue.batchId;
      builtAt = previousQueue.builtAt;
      const previousItemsByKey = new Map(
        previousQueue.items
          .filter((item) => cleanText(item?.key))
          .map((item) => [item.key, item]),
      );
      for (const item of items) {
        const oldItem = previousItemsByKey.get(item.key);
        const state = previousProgress.items[item.key];
        if (
          oldItem?.inputFingerprint === item.inputFingerprint &&
          isObject(state) &&
          state.inputFingerprint === item.inputFingerprint
        ) {
          preservedItems[item.key] = state;
        }
      }
      if (isObject(previousProgress.apiBatch)) preservedApiBatch = previousProgress.apiBatch;
    }
  }

  await assertOutputTargetsAvailable(outputRoot, items, {
    resume,
    progressItems: preservedItems,
  });

  const queue = {
    version: 1,
    operation: "directory_redraw",
    batchId,
    builtAt,
    sourceRoot,
    outputRoot,
    prompt: requested.prompt,
    promptFingerprint,
    recursive: true,
    candidateCount: items.length + skipped.length,
    sourceCount: items.length,
    skipped,
    items,
    queueFingerprint,
  };
  const progress = {
    version: 1,
    operation: "directory_redraw",
    batchId,
    queueFingerprint,
    items: preservedItems,
  };
  if (preservedApiBatch) progress.apiBatch = preservedApiBatch;

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
        "批量重绘进度写入失败，且队列回滚失败；禁止继续执行",
      );
    }
    throw error;
  }
  console.log(
    JSON.stringify(
      {
        queuePath,
        progressPath,
        operation: queue.operation,
        batchId,
        sourceRoot,
        outputRoot,
        total: items.length,
        skipped: skipped.length,
        resumed: resume,
        preservedProgress: Object.keys(preservedItems).length,
        queueFingerprint,
      },
      null,
      2,
    ),
  );
} finally {
  await releasePipelineLock(lockPath, { token: lock.token });
}
