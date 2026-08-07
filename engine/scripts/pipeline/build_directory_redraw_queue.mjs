import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  acquirePipelineLock,
  canonicalSha256,
  cleanText,
  hasExactKeys,
  isObject,
  normalizePromptText,
  parseJsonText,
  readJsonFile,
  releasePipelineLock,
  sha256,
  validatePngBytes,
  writeJsonAtomic,
} from "../lib/pipeline_runtime.mjs";

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
const maxImagePixels = 24 * 1024 * 1024;
const maxScannedEntries = 100_000;
const maxSourceImages = 10_000;
const maxTotalSourceBytes = 50n * 1024n * 1024n * 1024n;

const normalizeCase = (value) =>
  process.platform === "win32" ? value.toLowerCase() : value;

// Preserve the filesystem's exact Unicode code points for later I/O. NFC is
// only appropriate for comparison keys; persisting it can make an NFD-named
// file impossible to reopen on filesystems that distinguish the two forms.
const toPortableRelativePath = (value) => String(value ?? "").split(path.sep).join("/");
const comparisonPathKey = (value) => toPortableRelativePath(value).normalize("NFC").toLowerCase();
const comparePortablePaths = (left, right) => {
  const leftRaw = toPortableRelativePath(left);
  const rightRaw = toPortableRelativePath(right);
  const folded = comparisonPathKey(leftRaw).localeCompare(comparisonPathKey(rightRaw), "en");
  if (folded) return folded;
  return leftRaw < rightRaw ? -1 : leftRaw > rightRaw ? 1 : 0;
};

const isRootPath = (value) =>
  normalizeCase(path.resolve(value)) === normalizeCase(path.parse(path.resolve(value)).root);

const isWithinOrSame = (target, root) => {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
};

const dimensionsAreSafe = (width, height) =>
  Number.isInteger(width) &&
  Number.isInteger(height) &&
  width > 0 &&
  height > 0 &&
  width <= Math.floor(maxImagePixels / height);

const resolveInside = (root, relativePath, label) => {
  if (!cleanText(relativePath) || path.isAbsolute(relativePath)) {
    throw new Error(`${label}不是有效相对路径：${relativePath}`);
  }
  const segments = String(relativePath).split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes(":") ||
        segment.includes("\\"),
    )
  ) {
    throw new Error(`${label}含有非法路径片段：${relativePath}`);
  }
  const target = path.resolve(root, ...segments);
  if (!isWithinOrSame(target, root) || normalizeCase(target) === normalizeCase(root)) {
    throw new Error(`${label}越出所选目录：${relativePath}`);
  }
  return target;
};

const decodeConfiguration = () => {
  const encoded = cleanText(process.env.KA_REDRAW_CONFIG_B64);
  if (!encoded) throw new Error("缺少 KA_REDRAW_CONFIG_B64 批量重绘配置");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error("KA_REDRAW_CONFIG_B64 不是有效 Base64");
  }
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64"));
  } catch (error) {
    throw new Error(`批量重绘配置不是有效 UTF-8：${error.message}`);
  }
  const config = parseJsonText(decoded, "批量重绘配置");
  if (
    !hasExactKeys(config, ["outputRoot", "prompt", "sourceRoot"]) ||
    typeof config.sourceRoot !== "string" ||
    typeof config.outputRoot !== "string" ||
    typeof config.prompt !== "string"
  ) {
    throw new Error("批量重绘配置必须且只能包含 sourceRoot、outputRoot、prompt 三个字符串");
  }
  const prompt = normalizePromptText(config.prompt);
  if (!prompt) throw new Error("本批次统一重绘要求不能为空");
  return {
    sourceRoot: cleanText(config.sourceRoot),
    outputRoot: cleanText(config.outputRoot),
    prompt,
  };
};

const requireRealDirectory = async (input, label) => {
  if (!input || !path.isAbsolute(input)) throw new Error(`${label}必须是绝对路径`);
  const resolved = path.resolve(input);
  if (isRootPath(resolved)) throw new Error(`${label}不能是盘符根目录或 UNC 共享根目录`);
  let linkStat;
  try {
    linkStat = await fs.lstat(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label}不存在：${resolved}`);
    throw new Error(`${label}无法读取：${resolved}（${error?.code ?? error.message}）`);
  }
  if (linkStat.isSymbolicLink()) throw new Error(`${label}不能是符号链接或目录联接：${resolved}`);
  if (!linkStat.isDirectory()) throw new Error(`${label}不是文件夹：${resolved}`);
  const real = await fs.realpath(resolved);
  if (isRootPath(real)) throw new Error(`${label}不能解析到盘符根目录或 UNC 共享根目录`);
  return real;
};

const validJpegBytes = (bytes) => {
  if (
    bytes.length < 16 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes.at(-2) !== 0xff ||
    bytes.at(-1) !== 0xd9
  ) {
    return false;
  }
  const sofMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  let sawFrame = false;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) return false;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return false;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return false;
    const segmentLength = bytes.readUInt16BE(offset);
    const segmentEnd = offset + segmentLength;
    if (segmentLength < 2 || segmentEnd > bytes.length) return false;
    if (sofMarkers.has(marker)) {
      if (segmentLength < 8) return false;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (!dimensionsAreSafe(width, height)) return false;
      sawFrame = true;
    }
    if (marker === 0xda) return sawFrame && segmentEnd < bytes.length - 2;
    offset = segmentEnd;
  }
  return false;
};

const consumeGifSubBlocks = (bytes, start) => {
  let offset = start;
  let sawData = false;
  while (offset < bytes.length) {
    const length = bytes[offset];
    offset += 1;
    if (length === 0) return { offset, sawData, complete: true };
    if (offset + length > bytes.length) return { offset, sawData, complete: false };
    sawData = true;
    offset += length;
  }
  return { offset, sawData, complete: false };
};

const validGifBytes = (bytes) => {
  if (bytes.length < 14 || !["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) {
    return false;
  }
  if (!dimensionsAreSafe(bytes.readUInt16LE(6), bytes.readUInt16LE(8))) return false;
  const packed = bytes[10];
  let offset = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 0x07) + 1) : 0);
  if (offset > bytes.length) return false;
  let sawImage = false;
  while (offset < bytes.length) {
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x3b) return sawImage && offset === bytes.length;
    if (marker === 0x21) {
      if (offset >= bytes.length) return false;
      offset += 1;
      const blocks = consumeGifSubBlocks(bytes, offset);
      if (!blocks.complete) return false;
      offset = blocks.offset;
      continue;
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) return false;
    const width = bytes.readUInt16LE(offset + 4);
    const height = bytes.readUInt16LE(offset + 6);
    const imagePacked = bytes[offset + 8];
    offset += 9;
    if (!dimensionsAreSafe(width, height)) return false;
    if (imagePacked & 0x80) offset += 3 * 2 ** ((imagePacked & 0x07) + 1);
    if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 12) return false;
    const blocks = consumeGifSubBlocks(bytes, offset + 1);
    if (!blocks.complete || !blocks.sawData) return false;
    offset = blocks.offset;
    sawImage = true;
  }
  return false;
};

const validWebpBytes = (bytes) => {
  if (
    bytes.length < 20 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  ) {
    return false;
  }
  let offset = 12;
  let sawImage = false;
  let canvasDimensions = null;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > bytes.length) return false;
    if (type === "VP8X") {
      if (length < 10) return false;
      canvasDimensions = {
        width: 1 + bytes.readUIntLE(dataStart + 4, 3),
        height: 1 + bytes.readUIntLE(dataStart + 7, 3),
      };
      if (!dimensionsAreSafe(canvasDimensions.width, canvasDimensions.height)) return false;
    } else if (type === "VP8 ") {
      if (length <= 10 || bytes.toString("hex", dataStart + 3, dataStart + 6) !== "9d012a") {
        return false;
      }
      if (
        !dimensionsAreSafe(
          bytes.readUInt16LE(dataStart + 6) & 0x3fff,
          bytes.readUInt16LE(dataStart + 8) & 0x3fff,
        )
      ) {
        return false;
      }
      sawImage = true;
    } else if (type === "VP8L") {
      if (length <= 5 || bytes[dataStart] !== 0x2f) return false;
      const packed = bytes.readUInt32LE(dataStart + 1);
      if (!dimensionsAreSafe((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1)) {
        return false;
      }
      sawImage = true;
    }
    offset = dataEnd + (length % 2);
  }
  return (
    sawImage &&
    offset === bytes.length &&
    (!canvasDimensions || dimensionsAreSafe(canvasDimensions.width, canvasDimensions.height))
  );
};

const imageSignatureMatches = (extension, bytes) => {
  if (extension === ".png") {
    return validatePngBytes(bytes);
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return validJpegBytes(bytes);
  }
  if (extension === ".gif") {
    return validGifBytes(bytes);
  }
  if (extension === ".webp") {
    return validWebpBytes(bytes);
  }
  return false;
};

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

const validateItemUniqueness = (items) => {
  const keys = new Map();
  const outputs = new Map();
  const collisions = [];
  for (const item of items) {
    const oldKey = keys.get(item.key);
    if (oldKey) {
      collisions.push(`任务键冲突：${oldKey} / ${item.sourceRelativePath}`);
    } else {
      keys.set(item.key, item.sourceRelativePath);
    }
    const outputKey = comparisonPathKey(item.outputRelativePath);
    const previousSource = outputs.get(outputKey);
    if (previousSource) {
      collisions.push(
        `输出同名冲突：${previousSource} / ${item.sourceRelativePath} -> ${item.outputRelativePath}`,
      );
    } else {
      outputs.set(outputKey, item.sourceRelativePath);
    }
  }
  if (collisions.length) {
    throw new Error(`原图转换为 PNG 后发生同名冲突：${collisions.slice(0, 8).join("；")}`);
  }
};

const terminalState = (state) => {
  if (!isObject(state)) return false;
  if (state.status === "completed") return true;
  return (
    state.status === "failed" &&
    (state.terminal === true || (Number.isInteger(state.attempts) && state.attempts >= 2))
  );
};

const queueHasIncompleteItems = (queue, progress) => {
  if (!Array.isArray(queue?.items) || !queue.items.length) return false;
  return queue.items.some((item) => !terminalState(progress?.items?.[item?.key]));
};

const validatePreviousState = (queue, progress) => {
  if (!isObject(queue) || queue.version !== 1 || queue.operation !== "directory_redraw") {
    throw new Error("现有批量重绘队列结构无效，禁止覆盖可能可恢复的任务");
  }
  if (
    !Array.isArray(queue.items) ||
    !cleanText(queue.batchId) ||
    !cleanText(queue.builtAt) ||
    !cleanText(queue.queueFingerprint)
  ) {
    throw new Error("现有批量重绘队列缺少批次、任务或指纹，禁止覆盖");
  }
  if (!isObject(progress) || !isObject(progress.items)) {
    throw new Error("现有批量重绘进度结构无效，禁止覆盖可能可恢复的任务");
  }
  if (
    progress.operation !== "directory_redraw" ||
    cleanText(progress.batchId) !== cleanText(queue.batchId) ||
    cleanText(progress.queueFingerprint) !== cleanText(queue.queueFingerprint)
  ) {
    throw new Error("现有批量重绘队列与进度指纹不一致，禁止猜测恢复");
  }
};

const isBlankInitializedQueue = (value) =>
  isObject(value) &&
  value.operation === "directory_redraw" &&
  Array.isArray(value.items) &&
  value.items.length === 0 &&
  Object.keys(value).every((key) => ["version", "operation", "items"].includes(key));

const isBlankInitializedProgress = (value) =>
  isObject(value) &&
  value.operation === "directory_redraw" &&
  isObject(value.items) &&
  Object.keys(value.items).length === 0 &&
  Object.keys(value).every((key) => ["version", "operation", "items"].includes(key));

const expectedResumeOutput = (state, inputFingerprint) => {
  if (!isObject(state) || state.inputFingerprint !== inputFingerprint) return false;
  if (state.status === "completed") return true;
  const remoteStatus = cleanText(state.remoteStatus);
  return (
    state.backend === "api" &&
    ["completed", "download_installing", "download_interrupted", "download_retry"].includes(
      remoteStatus,
    )
  );
};

const assertOutputTargetsAvailable = async (
  outputRoot,
  items,
  { resume = false, progressItems = {} } = {},
) => {
  const checkedDirectories = new Set([normalizeCase(outputRoot)]);
  const conflicts = [];
  for (const item of items) {
    const target = resolveInside(outputRoot, item.outputRelativePath, "重绘输出路径");
    const parentRelative = path.posix.dirname(item.outputRelativePath);
    const parentSegments = parentRelative === "." ? [] : parentRelative.split("/");
    let current = outputRoot;
    for (const segment of parentSegments) {
      current = path.join(current, segment);
      const cacheKey = normalizeCase(current);
      if (checkedDirectories.has(cacheKey)) continue;
      try {
        const currentStat = await fs.lstat(current);
        if (currentStat.isSymbolicLink()) {
          throw new Error(`输出子目录不能是符号链接或目录联接：${current}`);
        }
        if (!currentStat.isDirectory()) {
          throw new Error(`输出路径的父级不是文件夹：${current}`);
        }
        const realCurrent = await fs.realpath(current);
        if (!isWithinOrSame(realCurrent, outputRoot)) {
          throw new Error(`输出子目录解析后越出结果目录：${current}`);
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      checkedDirectories.add(cacheKey);
    }

    try {
      const targetStat = await fs.lstat(target);
      const expected =
        resume &&
        targetStat.isFile() &&
        !targetStat.isSymbolicLink() &&
        expectedResumeOutput(progressItems[item.key], item.inputFingerprint);
      if (!expected) conflicts.push(item.outputRelativePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (conflicts.length) {
    throw new Error(
      `结果目录已存在本批次目标文件，禁止覆盖：${conflicts.slice(0, 8).join("、")}${
        conflicts.length > 8 ? "…" : ""
      }`,
    );
  }
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
