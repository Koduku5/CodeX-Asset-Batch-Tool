import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";

import {
  ASSET_BINDING_MARKERS,
  bindAssetPromptFields,
  compileLegacyDefinition,
  loadPromptCatalogSync,
  makeCatalogFingerprint,
  makeConditionModuleRegistryFingerprint,
  resolvePromptTemplate,
} from "./prompt_catalog.mjs";

const PROMPT_CATALOG = loadPromptCatalogSync();
const COMPILED_LEGACY_PROMPT_DEFINITION = compileLegacyDefinition(PROMPT_CATALOG);
const BUILTIN_CATALOG_FINGERPRINT = makeCatalogFingerprint(PROMPT_CATALOG);
const VALIDATED_LEGACY_PROMPT_DEFINITIONS = new WeakSet();
const RESOLVED_PROMPT_TEMPLATE_CACHE = new Map();

export const IMAGE_SHEET_ORDER = Object.freeze([
  ...COMPILED_LEGACY_PROMPT_DEFINITION.sheetOrder,
]);
export const IMAGE_BACKENDS = Object.freeze(["builtin", "api"]);
export const BUILTIN_PROMPT_FIELD_ORDER = Object.freeze([
  ...COMPILED_LEGACY_PROMPT_DEFINITION.fieldOrder,
]);
export const BUILTIN_REFERENCE_MODE_IDS = Object.freeze(
  PROMPT_CATALOG.catalog.enums.referenceModes
    .filter((referenceMode) => referenceMode !== "none")
    .map((referenceMode) => referenceMode.replaceAll("-", "_")),
);
export const BUILTIN_GENERATION_LIMITS = Object.freeze([5, 0, 10]);
const CUSTOM_REFERENCE_TEMPLATE = resolvePromptTemplate(PROMPT_CATALOG, {
  style: "anime",
  asset: "character",
  referenceMode: "custom",
  referenceCount: 1,
});
const STYLE_REFERENCE_TEMPLATE = resolvePromptTemplate(PROMPT_CATALOG, {
  style: "anime",
  asset: "character",
  referenceMode: "style",
  referenceCount: 1,
});
const styleReferenceAnalysisMarker =
  STYLE_REFERENCE_TEMPLATE.fields["Primary request"]
    .split("\n")
    .slice(1)
    .join("\n")
    .match(/【[^】]+】/u)?.[0];
if (!styleReferenceAnalysisMarker) {
  throw new Error("风格参考提示词缺少 Agent 共同风格分析占位");
}
export const CUSTOM_INPUT_IMAGES_MARKER =
  CUSTOM_REFERENCE_TEMPLATE.fields["Input images"].split("\n", 1)[0];
export const CUSTOM_PRIMARY_REQUEST_MARKER =
  CUSTOM_REFERENCE_TEMPLATE.fields["Primary request"];
export const CUSTOM_USE_CASE_INSTRUCTION = CUSTOM_REFERENCE_TEMPLATE.fields["Use case"];
export const STYLE_REFERENCE_ANALYSIS_MARKER = styleReferenceAnalysisMarker;
export const ASSET_ID_PATTERNS = Object.freeze({
  角色: /^CHAR-\d{3,}-EP[1-9]\d*$/,
  生物: /^CREATURE-\d{3,}-EP[1-9]\d*$/,
  群演: /^CROWD-\d{3,}-EP[1-9]\d*$/,
  场景: /^SCENE-\d{3,}-EP[1-9]\d*$/,
  道具: /^PROP-\d{3,}-EP[1-9]\d*$/,
});
export const MAX_IMAGE_ATTEMPTS = 2;
export const MAX_VALIDATED_PNG_BYTES = 64 * 1024 * 1024;
export const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_REFERENCE_IMAGE_PIXELS = 24 * 1024 * 1024;
export const MAX_EXCEL_CELL_CHARACTERS = 32_767;
export const PIPELINE_LOCK_PROTOCOL_VERSION = 2;

const execFileAsync = promisify(execFile);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[index] = value >>> 0;
}

const crc32 = (buffer, start, end) => {
  let value = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    value = CRC_TABLE[(value ^ buffer[index]) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
};

export const validatePngBytes = (bytes) => {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < PNG_SIGNATURE.length ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return false;
  }
  let offset = PNG_SIGNATURE.length;
  let sawHeader = false;
  let sawImageData = false;
  let sawEnd = false;
  let imageDataClosed = false;
  let sawPalette = false;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const imageData = [];
  const validDepths = new Map([
    [0, new Set([1, 2, 4, 8, 16])],
    [2, new Set([8, 16])],
    [3, new Set([1, 2, 4, 8])],
    [4, new Set([8, 16])],
    [6, new Set([8, 16])],
  ]);

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) return false;
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > bytes.length) return false;
    const typeBytes = bytes.subarray(typeStart, dataStart);
    if (
      typeBytes.length !== 4 ||
      [...typeBytes].some(
        (value) => !((value >= 65 && value <= 90) || (value >= 97 && value <= 122)),
      ) ||
      !(typeBytes[2] >= 65 && typeBytes[2] <= 90) ||
      bytes.readUInt32BE(dataEnd) !== crc32(bytes, typeStart, dataEnd)
    ) {
      return false;
    }
    const type = typeBytes.toString("ascii");
    const data = bytes.subarray(dataStart, dataEnd);
    if (!sawHeader && type !== "IHDR") return false;

    if (type === "IHDR") {
      if (sawHeader || length !== 13) return false;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
      if (
        width <= 0 ||
        height <= 0 ||
        !validDepths.get(colorType)?.has(bitDepth) ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        ![0, 1].includes(interlace)
      ) {
        return false;
      }
      sawHeader = true;
    } else if (type === "PLTE") {
      if (
        sawPalette ||
        sawImageData ||
        length === 0 ||
        length > 768 ||
        length % 3 !== 0 ||
        [0, 4].includes(colorType) ||
        (colorType === 3 && length / 3 > 2 ** bitDepth)
      ) {
        return false;
      }
      sawPalette = true;
    } else if (type === "IDAT") {
      if (imageDataClosed || (colorType === 3 && !sawPalette)) return false;
      sawImageData = true;
      imageData.push(data);
    } else if (type === "IEND") {
      if (length !== 0 || !sawImageData || chunkEnd !== bytes.length) return false;
      sawEnd = true;
      offset = chunkEnd;
      break;
    } else if ((typeBytes[0] & 0x20) === 0) {
      return false;
    }
    if (sawImageData && type !== "IDAT") imageDataClosed = true;
    offset = chunkEnd;
  }
  if (offset !== bytes.length || !sawHeader || !sawImageData || !sawEnd) return false;

  const channels = new Map([
    [0, 1],
    [2, 3],
    [3, 1],
    [4, 2],
    [6, 4],
  ]).get(colorType);
  const bitsPerPixel = channels * bitDepth;
  const passes =
    interlace === 0
      ? [[0, 0, 1, 1]]
      : [
          [0, 0, 8, 8],
          [4, 0, 8, 8],
          [0, 4, 4, 8],
          [2, 0, 4, 4],
          [0, 2, 2, 4],
          [1, 0, 2, 2],
          [0, 1, 1, 2],
        ];
  const scanlines = [];
  let expectedSize = 0;
  for (const [startX, startY, stepX, stepY] of passes) {
    const passWidth = width <= startX ? 0 : Math.ceil((width - startX) / stepX);
    const passHeight = height <= startY ? 0 : Math.ceil((height - startY) / stepY);
    if (!passWidth || !passHeight) continue;
    const rowSize = Math.ceil((passWidth * bitsPerPixel) / 8);
    scanlines.push([passHeight, rowSize]);
    expectedSize += passHeight * (rowSize + 1);
  }
  if (
    !Number.isSafeInteger(expectedSize) ||
    expectedSize <= 0 ||
    expectedSize > 128 * 1024 * 1024
  ) {
    return false;
  }
  let decoded;
  try {
    const compressed = Buffer.concat(imageData);
    const inflated = inflateSync(compressed, {
      maxOutputLength: expectedSize + 1,
      info: true,
    });
    if (inflated.engine.bytesWritten !== compressed.length) return false;
    decoded = inflated.buffer;
  } catch {
    return false;
  }
  if (decoded.length !== expectedSize) return false;
  let decodedOffset = 0;
  for (const [passHeight, rowSize] of scanlines) {
    for (let row = 0; row < passHeight; row += 1) {
      if (decoded[decodedOffset] > 4) return false;
      decodedOffset += rowSize + 1;
    }
  }
  return decodedOffset === decoded.length;
};

export const readValidatedPngInfo = async (filePath, maxBytes = MAX_VALIDATED_PNG_BYTES) => {
  let stat;
  let bytes;
  try {
    stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return null;
    bytes = await fs.readFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let finalStat;
  try {
    finalStat = await fs.stat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (
    !finalStat.isFile() ||
    finalStat.size !== stat.size ||
    finalStat.mtimeMs !== stat.mtimeMs ||
    !validatePngBytes(bytes)
  ) {
    return null;
  }
  return {
    exists: true,
    size: finalStat.size,
    mtimeMs: finalStat.mtimeMs,
    sha256: sha256(bytes),
  };
};

export const referenceImageDimensionsAreSafe = (width, height) =>
  Number.isInteger(width) &&
  Number.isInteger(height) &&
  width > 0 &&
  height > 0 &&
  width <= MAX_REFERENCE_IMAGE_PIXELS &&
  height <= MAX_REFERENCE_IMAGE_PIXELS &&
  width * height <= MAX_REFERENCE_IMAGE_PIXELS;

export const validateReferenceImageBytes = (bytes, extension) => {
  if (!Buffer.isBuffer(bytes) || bytes.length <= 0 || bytes.length > MAX_REFERENCE_IMAGE_BYTES) {
    return false;
  }
  const normalizedExtension = String(extension ?? "").toLowerCase();
  if (
    normalizedExtension !== ".png" ||
    bytes[24] !== 8 ||
    !validatePngBytes(bytes)
  ) {
    return false;
  }
  const dimensions = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  return Boolean(
    dimensions && referenceImageDimensionsAreSafe(dimensions.width, dimensions.height),
  );
};

export const readValidatedReferenceImageInfo = async (filePath) => {
  let stat;
  let bytes;
  try {
    stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_REFERENCE_IMAGE_BYTES) return null;
    bytes = await fs.readFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const finalStat = await fs.stat(filePath);
  if (
    !finalStat.isFile() ||
    finalStat.size !== stat.size ||
    finalStat.mtimeMs !== stat.mtimeMs ||
    !validateReferenceImageBytes(bytes, path.extname(filePath))
  ) {
    return null;
  }
  return { size: finalStat.size, mtimeMs: finalStat.mtimeMs, sha256: sha256(bytes) };
};

export const readStableFileSnapshot = async (filePath) => {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const before = await handle.stat();
    if (!before.isFile()) return { exists: false };
    const hash = crypto.createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) hash.update(chunk);
    const [afterHandle, afterPath] = await Promise.all([handle.stat(), fs.stat(filePath)]);
    if (
      !afterHandle.isFile() ||
      !afterPath.isFile() ||
      afterHandle.size !== before.size ||
      afterHandle.mtimeMs !== before.mtimeMs ||
      afterPath.size !== before.size ||
      afterPath.mtimeMs !== before.mtimeMs ||
      afterPath.dev !== before.dev ||
      afterPath.ino !== before.ino
    ) {
      throw new Error(`文件在计算基线期间发生变化：${filePath}`);
    }
    return {
      exists: true,
      size: before.size,
      mtimeMs: before.mtimeMs,
      sha256: hash.digest("hex"),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
};

const normalizePathCase = (value) =>
  process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);

export const isPathWithinOrSame = (target, root) => {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
};

export const assertSafeOutputPath = async (rootPath, targetPath, options = {}) => {
  const { targetMayBeMissing = true } = options;
  const lexicalRoot = path.resolve(rootPath);
  const lexicalTarget = path.resolve(targetPath);
  if (!isPathWithinOrSame(lexicalTarget, lexicalRoot) || lexicalTarget === lexicalRoot) {
    throw new Error(`输出路径越出指定根目录：${lexicalTarget}`);
  }
  let realRoot;
  try {
    const rootStat = await fs.lstat(lexicalRoot);
    if (rootStat.isSymbolicLink()) {
      throw new Error(`输出根目录不能是符号链接或目录联接：${lexicalRoot}`);
    }
    realRoot = await fs.realpath(lexicalRoot);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`输出根目录不存在：${lexicalRoot}`);
    throw error;
  }

  const relative = path.relative(lexicalRoot, lexicalTarget);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = lexicalRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const isTarget = index === segments.length - 1;
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT" && (targetMayBeMissing || !isTarget)) continue;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`输出路径不能经过符号链接或目录联接：${current}`);
    }
    if (!isTarget && !stat.isDirectory()) {
      throw new Error(`输出路径父级不是文件夹：${current}`);
    }
    if (isTarget && !stat.isFile() && !stat.isDirectory()) {
      throw new Error(`输出目标不是普通文件或文件夹：${current}`);
    }
    const realCurrent = await fs.realpath(current);
    if (!isPathWithinOrSame(normalizePathCase(realCurrent), normalizePathCase(realRoot))) {
      throw new Error(`输出路径解析后越出指定根目录：${current}`);
    }
  }
  return lexicalTarget;
};

export const cleanText = (value) => String(value ?? "").trim();
export const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const EXCEL_FORMULA_PREFIX = /^[\s\u0000-\u001f\u007f]*[=+\-@]/u;
const INVALID_XML_TEXT_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu;
export const neutralizeExcelFormula = (value) => {
  if (typeof value !== "string") return value;
  const xmlSafeValue = value.replace(INVALID_XML_TEXT_CONTROLS, "\uFFFD");
  return EXCEL_FORMULA_PREFIX.test(value) ? `'${xmlSafeValue}` : xmlSafeValue;
};
export const assertExcelCellValue = (value, label = "Excel 单元格") => {
  if (value === null || value === undefined) return value;
  const safeValue = neutralizeExcelFormula(value);
  if (String(safeValue).length > MAX_EXCEL_CELL_CHARACTERS) {
    throw new Error(`${label}超过 Excel 单元格 ${MAX_EXCEL_CELL_CHARACTERS} 字符上限`);
  }
  return safeValue;
};

export const hasExactKeys = (value, expectedKeys) =>
  isObject(value) &&
  Object.keys(value).length === expectedKeys.length &&
  expectedKeys.every((key) => Object.hasOwn(value, key));
export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
export const stripBom = (value) => String(value ?? "").replace(/^\uFEFF/, "");

export const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
};

export const canonicalJson = (value) => JSON.stringify(canonicalize(value));
export const canonicalSha256 = (value) => sha256(canonicalJson(value));

export const normalizeAttemptEntry = (value) => {
  if (!isObject(value) || !cleanText(value.inputFingerprint)) return null;
  return {
    inputFingerprint: cleanText(value.inputFingerprint),
    attempts: Number.isInteger(value.attempts) && value.attempts >= 0 ? value.attempts : 0,
    lastError: String(value.lastError ?? ""),
    updatedAt: String(value.updatedAt ?? ""),
  };
};

export const normalizeAttemptLedger = (state) => {
  const ledger = {};
  if (isObject(state?.attemptLedger)) {
    for (const backend of IMAGE_BACKENDS) {
      const entry = normalizeAttemptEntry(state.attemptLedger[backend]);
      if (entry) ledger[backend] = entry;
    }
  }
  const legacyBackend = state?.backend;
  if (IMAGE_BACKENDS.includes(legacyBackend)) {
    const inputFingerprint = cleanText(
      legacyBackend === "builtin" ? state.builtinPromptFingerprint : state.inputFingerprint,
    );
    if (inputFingerprint && ledger[legacyBackend]?.inputFingerprint !== inputFingerprint) {
      ledger[legacyBackend] = {
        inputFingerprint,
        attempts: Number.isInteger(state.attempts) && state.attempts >= 0 ? state.attempts : 0,
        lastError: String(state.error ?? ""),
        updatedAt: String(state.updatedAt ?? ""),
      };
    }
  }
  return ledger;
};

export const attemptEntryFor = (ledger, backend, inputFingerprint) => {
  const current = normalizeAttemptEntry(ledger?.[backend]);
  if (current?.inputFingerprint === inputFingerprint) return current;
  return { inputFingerprint, attempts: 0, lastError: "", updatedAt: "" };
};

export const requiredFileInfo = async (filePath, label) => {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label}不存在：${filePath}`);
    throw error;
  }
  if (!stat.isFile()) throw new Error(`${label}不是文件：${filePath}`);
  return stat;
};

export const latestJsonMtime = async (directory) => {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  const times = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map(async (entry) => (await fs.stat(path.join(directory, entry.name))).mtimeMs),
  );
  return times.length ? Math.max(...times) : 0;
};

export const resolveImageOutputPath = (skillRoot, imageOutputRoot, relativePath) => {
  if (!cleanText(relativePath)) throw new Error("任务输出路径为空");
  const absolute = path.resolve(skillRoot, relativePath);
  if (!isPathWithinOrSame(absolute, imageOutputRoot)) {
    throw new Error(`任务输出路径越出 输出/资产图：${relativePath}`);
  }
  return {
    absolute,
    relative: path.relative(skillRoot, absolute).split(path.sep).join("/"),
  };
};

export const parseJsonText = (raw, label = "JSON") => {
  try {
    return JSON.parse(stripBom(raw));
  } catch (error) {
    throw new Error(`${label}不是有效 JSON：${error.message}`);
  }
};

export const readJsonFile = async (filePath, options = {}) => {
  const {
    fallback,
    allowEmpty = false,
    label = path.basename(filePath),
    retries = 0,
  } = options;
  const hasFallback = Object.hasOwn(options, "fallback");
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      if (allowEmpty && !stripBom(raw).trim()) return fallback;
      return parseJsonText(raw, label);
    } catch (error) {
      if (error?.code === "ENOENT" && hasFallback) return fallback;
      if (attempt === retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
  return fallback;
};

export const writeJsonAtomic = async (filePath, value) => {
  const parentPath = path.dirname(filePath);
  await fs.mkdir(parentPath, { recursive: true });
  const parentStat = await fs.lstat(parentPath);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`JSON 写入目录不是安全的普通文件夹：${parentPath}`);
  }
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, filePath);
    let directoryHandle;
    try {
      directoryHandle = await fs.open(parentPath, "r");
      await directoryHandle.sync();
    } catch {
      // Directory fsync is unavailable on some Windows filesystems.
    } finally {
      await directoryHandle?.close().catch(() => {});
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
};

export const validateImageRoutes = (config) => {
  if (
    !hasExactKeys(config, ["version", "sheetOrder", "routes"]) ||
    config.version !== 1 ||
    !isObject(config.routes) ||
    !Array.isArray(config.sheetOrder)
  ) {
    return false;
  }
  if (JSON.stringify(config.sheetOrder) !== JSON.stringify(IMAGE_SHEET_ORDER)) return false;
  if (!hasExactKeys(config.routes, IMAGE_SHEET_ORDER)) {
    return false;
  }
  return IMAGE_SHEET_ORDER.every((sheetName) => {
    const route = config.routes[sheetName];
    return (
      hasExactKeys(route, ["outputFolder"]) &&
      Boolean(cleanText(route.outputFolder))
    );
  });
};

export const normalizePromptText = (value) =>
  String(value ?? "").replace(/\r\n?/g, "\n").trim();

export const AGENT_PLACEHOLDER_CONTRACT_VERSION = 1;
const AGENT_PLACEHOLDER_PREFIXES = ["【由agent 具体判断说明：", "【由 Agent "];
const AGENT_PLACEHOLDER_PATTERN =
  /【由agent 具体判断说明：([^\r\n【】]+)】|【由 Agent ([^\r\n【】]+)】/gu;

const textRanges = (text, needle) => {
  const ranges = [];
  if (!needle) return ranges;
  let offset = 0;
  while (offset <= text.length - needle.length) {
    const start = text.indexOf(needle, offset);
    if (start < 0) break;
    ranges.push({ start, end: start + needle.length });
    offset = start + Math.max(needle.length, 1);
  }
  return ranges;
};

const rangeContains = (ranges, start, end = start + 1) =>
  ranges.some((range) => start >= range.start && end <= range.end);

export const analyzeAgentPromptFields = (
  fields,
  { ignoredValues = [], ignoredSourceRanges = [] } = {},
) => {
  const items = [];
  const errors = [];
  if (!Array.isArray(fields)) {
    return {
      version: AGENT_PLACEHOLDER_CONTRACT_VERSION,
      valid: false,
      items,
      errors: ["提示词字段不是数组"],
    };
  }
  for (const [fieldIndex, field] of fields.entries()) {
    const label = normalizePromptText(field?.label);
    const value = normalizePromptText(field?.value);
    const ignoredRanges = [
      ...(Array.isArray(ignoredValues) ? ignoredValues : []).flatMap((ignoredValue) =>
        textRanges(value, normalizePromptText(ignoredValue)),
      ),
      ...(Array.isArray(ignoredSourceRanges) ? ignoredSourceRanges : []).filter(
        (range) =>
          range?.fieldIndex === fieldIndex &&
          Number.isInteger(range.start) &&
          Number.isInteger(range.end) &&
          range.start >= 0 &&
          range.end > range.start &&
          range.end <= value.length,
      ),
    ];
    const validRanges = [];
    let occurrence = 0;
    for (const match of value.matchAll(AGENT_PLACEHOLDER_PATTERN)) {
      const marker = match[0];
      const start = match.index;
      const end = start + marker.length;
      if (rangeContains(ignoredRanges, start, end)) continue;
      validRanges.push({ start, end });
      const instruction = normalizePromptText(match[1] ?? match[2]);
      if (!instruction) {
        errors.push(`${label || "未知字段"} 的 Agent 占位符缺少判断说明`);
        continue;
      }
      occurrence += 1;
      items.push({
        field: label,
        occurrence,
        mode: value === marker ? "field" : "inline",
        marker,
        instruction,
      });
    }
    for (const prefix of AGENT_PLACEHOLDER_PREFIXES) {
      let prefixOffset = 0;
      while (prefixOffset < value.length) {
        const start = value.indexOf(prefix, prefixOffset);
        if (start < 0) break;
        const covered = rangeContains(ignoredRanges, start) || rangeContains(validRanges, start);
        if (!covered) {
          errors.push(`${label || "未知字段"} 含未闭合或不符合格式的 Agent 占位符`);
        }
        prefixOffset = start + prefix.length;
      }
    }
  }
  return {
    version: AGENT_PLACEHOLDER_CONTRACT_VERSION,
    valid: errors.length === 0,
    items,
    errors,
  };
};

const normalizeCustomFieldLabels = (value) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 24) return null;
  const labels = value.map((label) => typeof label === "string" ? normalizePromptText(label) : "");
  const normalized = labels.map((label) => label.toLocaleLowerCase("zh-CN"));
  const reserved = new Set(BUILTIN_PROMPT_FIELD_ORDER.map((label) => label.toLocaleLowerCase("zh-CN")));
  if (
    labels.some((label, index) =>
      !label || label !== value[index] || label.length > 80 || /[:\r\n]/u.test(label) || reserved.has(normalized[index]),
    ) || new Set(normalized).size !== labels.length
  ) return null;
  return labels;
};

const parsePromptFields = (promptText, customFieldLabels = []) => {
  const fields = [];
  const allowedLabels = new Set([...BUILTIN_PROMPT_FIELD_ORDER, ...customFieldLabels]);
  for (const line of normalizePromptText(promptText).split("\n")) {
    const match = line.match(/^([^:\n]{1,80}):\s?(.*)$/);
    const label = match ? normalizePromptText(match[1]) : "";
    if (match && allowedLabels.has(label)) {
      fields.push({ label, value: match[2] });
    } else if (fields.length) {
      fields[fields.length - 1].value += `${fields[fields.length - 1].value ? "\n" : ""}${line}`;
    } else if (line.trim()) {
      fields.push({ label: "Prompt", value: line });
    }
  }
  return fields;
};

const promptFieldSchemaMatches = (route, fields, customFieldLabels = []) => {
  const expectedLabels = [
    ...route.promptFields.map((field) => normalizePromptText(field.label)),
    ...customFieldLabels,
  ];
  const actualLabels = fields.map((field) => field.label);
  const expectedLabelSet = new Set(expectedLabels);
  return (
    actualLabels.length === expectedLabels.length &&
    new Set(actualLabels).size === actualLabels.length &&
    actualLabels.every((label) => expectedLabelSet.has(label))
  );
};

const renderPromptFields = (fields) =>
  fields
    .map((field) => {
      const label = normalizePromptText(field.label);
      const value = normalizePromptText(field.value);
      return `${label}:${value ? ` ${value}` : ""}`;
    })
    .join("\n");

export const validateBuiltinPromptDefinition = (definition) => {
  try {
    const valid =
      canonicalJson(definition) === canonicalJson(COMPILED_LEGACY_PROMPT_DEFINITION);
    if (valid && isObject(definition)) VALIDATED_LEGACY_PROMPT_DEFINITIONS.add(definition);
    return valid;
  } catch {
    return false;
  }
};

const resolveCatalogPromptTemplate = ({
  style,
  asset,
  referenceMode,
  referenceCount,
  productionNotes,
  selectedConditionModuleIds,
}) => {
  const cacheKey = JSON.stringify({
    style,
    asset,
    referenceMode,
    referenceCount,
    productionNotes: String(productionNotes ?? ""),
    selectedConditionModuleIds: selectedConditionModuleIds ?? [],
  });
  if (!RESOLVED_PROMPT_TEMPLATE_CACHE.has(cacheKey)) {
    RESOLVED_PROMPT_TEMPLATE_CACHE.set(
      cacheKey,
      resolvePromptTemplate(PROMPT_CATALOG, {
        style,
        asset,
        referenceMode,
        referenceCount,
        productionNotes,
        selectedConditionModuleIds,
      }),
    );
  }
  return RESOLVED_PROMPT_TEMPLATE_CACHE.get(cacheKey);
};

const bindPromptValue = (value, productionNotes) =>
  bindAssetPromptFields(
    { value: normalizePromptText(value) },
    { productionNotes: cleanText(productionNotes) },
  ).value;

const bindProductionNotesWithRanges = (templateValue, productionNotes) => {
  const template = normalizePromptText(templateValue);
  const notes = String(productionNotes ?? "").replace(/\r\n?/g, "\n");
  const ranges = [];
  let value = "";
  let offset = 0;
  while (offset <= template.length) {
    const markerOffset = template.indexOf(ASSET_BINDING_MARKERS.productionNotes, offset);
    if (markerOffset < 0) {
      value += template.slice(offset);
      break;
    }
    value += template.slice(offset, markerOffset);
    const start = value.length;
    value += notes;
    ranges.push({ start, end: value.length });
    offset = markerOffset + ASSET_BINDING_MARKERS.productionNotes.length;
  }
  const leadingTrim = value.length - value.trimStart().length;
  const normalizedValue = value.trim();
  return {
    value: normalizedValue,
    ranges: ranges
      .map(({ start, end }) => ({
        start: Math.max(0, start - leadingTrim),
        end: Math.min(normalizedValue.length, end - leadingTrim),
      }))
      .filter(({ start, end }) => end > start),
  };
};

const productionNoteSourceRanges = (fields, unboundPromptFields, productionNotes) => {
  const templatesByLabel = new Map(
    unboundPromptFields.map(({ label, value }) => [normalizePromptText(label), value]),
  );
  return fields.flatMap((field, fieldIndex) => {
    const tracked = bindProductionNotesWithRanges(
      templatesByLabel.get(normalizePromptText(field?.label)),
      productionNotes,
    );
    return textRanges(normalizePromptText(field?.value), tracked.value).flatMap(
      ({ start: templateStart }) =>
        tracked.ranges.map(({ start, end }) => ({
          fieldIndex,
          start: templateStart + start,
          end: templateStart + end,
        })),
    );
  });
};

const productionNoteSourceAmbiguities = (
  fields,
  unboundPromptFields,
  productionNotes,
  preciseRanges,
) => {
  const notes = normalizePromptText(productionNotes);
  if (!notes) return [];
  const notesAnalysis = analyzeAgentPromptFields([
    { label: "productionNotes", value: notes },
  ]);
  if (notesAnalysis.items.length === 0 && notesAnalysis.errors.length === 0) return [];
  const templatesByLabel = new Map(
    unboundPromptFields.map(({ label, value }) => [normalizePromptText(label), value]),
  );
  return fields.flatMap((field, fieldIndex) => {
    const label = normalizePromptText(field?.label);
    const template = normalizePromptText(templatesByLabel.get(label));
    const bindingCount = textRanges(
      template,
      ASSET_BINDING_MARKERS.productionNotes,
    ).length;
    const noteCount = textRanges(normalizePromptText(field?.value), notes).length;
    if (!bindingCount || !noteCount) return [];
    const preciseCount = new Set(
      preciseRanges
        .filter((range) => range.fieldIndex === fieldIndex)
        .map((range) => `${range.start}:${range.end}`),
    ).size;
    if (preciseCount >= Math.min(bindingCount, noteCount)) return [];
    return [{
      fieldIndex,
      label,
      error: `${label || "未知字段"} 的 productionNotes 替换来源歧义：制作说明含 Agent 占位符，且编辑后无法精确定位其注入区间`,
    }];
  });
};

const validateReferenceSnapshot = (snapshot) =>
  hasExactKeys(snapshot, ["path", "sourceName", "size", "sha256"]) &&
  cleanText(snapshot.path) &&
  cleanText(snapshot.sourceName) &&
  Number.isInteger(snapshot.size) &&
  snapshot.size > 0 &&
  snapshot.size <= MAX_REFERENCE_IMAGE_BYTES &&
  /^[a-f0-9]{64}$/.test(cleanText(snapshot.sha256));

const validateBuiltinReferencesBySheet = (referencesBySheet) =>
  hasExactKeys(referencesBySheet, IMAGE_SHEET_ORDER) &&
  IMAGE_SHEET_ORDER.every(
    (sheetName) =>
      Array.isArray(referencesBySheet[sheetName]) &&
      referencesBySheet[sheetName].every(validateReferenceSnapshot),
  );

const validateBuiltinReferenceModeBySheet = (referenceModeBySheet, referencesBySheet) =>
  hasExactKeys(referenceModeBySheet, IMAGE_SHEET_ORDER) &&
  IMAGE_SHEET_ORDER.every((sheetName) => {
    const referenceMode = referenceModeBySheet[sheetName];
    const referenceCount = referencesBySheet[sheetName].length;
    return (
      BUILTIN_REFERENCE_MODE_IDS.includes(referenceMode) &&
      (referenceCount > 0 || referenceMode === "style") &&
      (referenceMode !== "visual_consistency" || referenceCount >= 2)
    );
  });

const validateBuiltinPromptOverridesBySheet = (promptOverridesBySheet) =>
  hasExactKeys(promptOverridesBySheet, IMAGE_SHEET_ORDER) &&
  IMAGE_SHEET_ORDER.every((sheetName) => {
    const override = promptOverridesBySheet[sheetName];
    const customFieldLabels = normalizeCustomFieldLabels(override?.customFieldLabels);
    return (
      (hasExactKeys(override, ["routeMode", "promptText"]) ||
        hasExactKeys(override, ["routeMode", "promptText", "customFieldLabels"])) &&
      ["default", "reference"].includes(override.routeMode) &&
      typeof override.promptText === "string" &&
      customFieldLabels !== null
    );
  });

const validateEnabledSheets = (enabledSheets) =>
  Array.isArray(enabledSheets) &&
  enabledSheets.length > 0 &&
  new Set(enabledSheets).size === enabledSheets.length &&
  enabledSheets.every((sheetName) => IMAGE_SHEET_ORDER.includes(sheetName)) &&
  JSON.stringify(enabledSheets) ===
    JSON.stringify(IMAGE_SHEET_ORDER.filter((sheetName) => enabledSheets.includes(sheetName)));

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const validateRouteFingerprintsBySheet = (routeFingerprintsBySheet, enabledSheets) =>
  hasExactKeys(routeFingerprintsBySheet, enabledSheets) &&
  enabledSheets.every((sheetName) =>
    SHA256_PATTERN.test(cleanText(routeFingerprintsBySheet[sheetName])),
  );

export const getBuiltinCatalogFingerprint = () => BUILTIN_CATALOG_FINGERPRINT;

export const getConditionModuleRegistryFingerprint = () =>
  makeConditionModuleRegistryFingerprint(PROMPT_CATALOG);

export const assertConditionMatchingQueueCurrent = (queue) => {
  const items = Array.isArray(queue?.items) ? queue.items : [];
  const carriesAssignments = items.some(
    (item) =>
      isObject(item) &&
      Object.hasOwn(item, "selectedConditionModuleIds"),
  );
  const matching = queue?.conditionMatching;
  if (!matching && !carriesAssignments) return false;
  if (
    !hasExactKeys(matching, [
      "version",
      "source",
      "catalogFingerprint",
      "conditionRegistryFingerprint",
    ]) ||
    matching.version !== 1 ||
    matching.source !== "cache/提示词分支匹配.json" ||
    matching.catalogFingerprint !== getBuiltinCatalogFingerprint() ||
    matching.conditionRegistryFingerprint !== getConditionModuleRegistryFingerprint()
  ) {
    throw new Error("提示词分支匹配与当前 Prompt Catalog 或分支注册表不一致，请重新执行智能匹配并建立队列");
  }
  for (const item of items) {
    if (
      !isObject(item) ||
      !Object.hasOwn(item, "selectedConditionModuleIds") ||
      !Array.isArray(item.selectedConditionModuleIds) ||
      new Set(item.selectedConditionModuleIds).size !== item.selectedConditionModuleIds.length ||
      item.selectedConditionModuleIds.some((id) => !cleanText(id))
    ) {
      throw new Error("出图队列的提示词分支选择不完整或已损坏，请重新建立队列");
    }
  }
  return true;
};

export const makeBuiltinCatalogRouteFingerprint = (
  styleId,
  sheetName,
  referenceMode,
  referenceCount,
  loadedCatalog = PROMPT_CATALOG,
) => {
  const count = Math.max(0, Number(referenceCount) || 0);
  const effectiveReferenceMode = count > 0 ? cleanText(referenceMode || "style") : "none";
  const resolved = resolvePromptTemplate(loadedCatalog, {
    style: styleId,
    asset: sheetName,
    referenceMode: effectiveReferenceMode,
    referenceCount: count,
  });
  const referenceModifierFingerprints = resolved.fingerprints.modifierFingerprints.map(
    ({ id, fingerprint }) => ({ id, fingerprint }),
  );
  if (referenceModifierFingerprints.length !== 1 || resolved.enhancer) {
    throw new Error("内置批次路由指纹只能包含一个参考模式条件修饰器");
  }
  return canonicalSha256({
    version: 1,
    compiler: loadedCatalog.catalog.compilation,
    activeFieldSchema: {
      id: resolved.activeFieldSchema,
      fields: loadedCatalog.catalog.fieldSchemas[resolved.activeFieldSchema],
    },
    baseRouteFingerprint: resolved.fingerprints.baseRouteFingerprint,
    referenceModifierFingerprints,
  });
};

export const makeBuiltinRouteFingerprintsBySheet = (
  batch,
  loadedCatalog = PROMPT_CATALOG,
) => {
  if (!validateEnabledSheets(batch?.enabledSheets)) {
    throw new Error("内置提示词配置缺少有效的 enabledSheets");
  }
  return Object.fromEntries(
    batch.enabledSheets.map((sheetName) => {
      const references = batch?.referencesBySheet?.[sheetName];
      if (!Array.isArray(references)) {
        throw new Error(`内置提示词配置缺少 ${sheetName} 参考图列表`);
      }
      return [
        sheetName,
        makeBuiltinCatalogRouteFingerprint(
          batch.styleId,
          sheetName,
          batch?.referenceModeBySheet?.[sheetName],
          references.length,
          loadedCatalog,
        ),
      ];
    }),
  );
};

export const validateBuiltinPromptPreset = (preset) => {
  return (
    hasExactKeys(preset, [
      "version",
      "catalogFingerprint",
      "routeFingerprintsBySheet",
      "confirmedAt",
      "styleId",
      "generationLimit",
      "enabledSheets",
      "referencesBySheet",
      "referenceModeBySheet",
      "promptOverridesBySheet",
    ]) &&
    preset.version === 6 &&
    SHA256_PATTERN.test(cleanText(preset.catalogFingerprint)) &&
    cleanText(preset.confirmedAt) &&
    cleanText(preset.styleId) &&
    BUILTIN_GENERATION_LIMITS.includes(preset.generationLimit) &&
    validateEnabledSheets(preset.enabledSheets) &&
    validateRouteFingerprintsBySheet(
      preset.routeFingerprintsBySheet,
      preset.enabledSheets,
    ) &&
    Number.isFinite(Date.parse(preset.confirmedAt)) &&
    validateBuiltinReferencesBySheet(preset.referencesBySheet) &&
    validateBuiltinReferenceModeBySheet(
      preset.referenceModeBySheet,
      preset.referencesBySheet,
    ) &&
    validateBuiltinPromptOverridesBySheet(preset.promptOverridesBySheet)
  );
};

export const validateBuiltinPromptBatch = (batch) => {
  return validateBuiltinPromptPreset(batch);
};

export const builtinPromptBatchMatchesCatalog = (
  batch,
  loadedCatalog = PROMPT_CATALOG,
) => {
  if (!validateBuiltinPromptBatch(batch)) return false;
  try {
    return (
      canonicalJson(batch.routeFingerprintsBySheet) ===
      canonicalJson(makeBuiltinRouteFingerprintsBySheet(batch, loadedCatalog))
    );
  } catch {
    return false;
  }
};

export const builtinPromptPresetMatchesCatalog = (
  preset,
  loadedCatalog = PROMPT_CATALOG,
) => {
  if (!validateBuiltinPromptPreset(preset)) return false;
  try {
    return (
      canonicalJson(preset.routeFingerprintsBySheet) ===
      canonicalJson(makeBuiltinRouteFingerprintsBySheet(preset, loadedCatalog))
    );
  } catch {
    return false;
  }
};

export const getBuiltinGenerationQuotaState = (batch, progressItems, queueKeys = null) => {
  const generationLimit = BUILTIN_GENERATION_LIMITS.includes(batch?.generationLimit)
    ? batch.generationLimit
    : 5;
  const generationSession = cleanText(batch?.confirmedAt);
  const allowedKeys = queueKeys instanceof Set ? queueKeys : null;
  const claimedKeys = new Set();
  if (generationSession && isObject(progressItems)) {
    for (const [key, state] of Object.entries(progressItems)) {
      if (
        (!allowedKeys || allowedKeys.has(key)) &&
        isObject(state) &&
        state.backend === "builtin" &&
        cleanText(state.builtinGenerationSession) === generationSession
      ) {
        claimedKeys.add(key);
      }
    }
  }
  const unlimited = generationLimit === 0;
  const claimed = claimedKeys.size;
  return {
    generationLimit,
    generationSession,
    claimedKeys,
    claimed,
    remaining: unlimited ? null : Math.max(0, generationLimit - claimed),
    limitReached: !unlimited && claimed >= generationLimit,
  };
};

export const builtinSheetIsEnabled = (batch, itemOrSheetName) => {
  const sheetName = cleanText(
    typeof itemOrSheetName === "string" ? itemOrSheetName : itemOrSheetName?.sheetName,
  );
  return Array.isArray(batch?.enabledSheets) && batch.enabledSheets.includes(sheetName);
};

export const validateApiPromptBatch = (batch) => {
  if (
    !hasExactKeys(batch, ["version", "confirmedAt", "bySheet"]) ||
    batch.version !== 2 ||
    !cleanText(batch.confirmedAt) ||
    !hasExactKeys(batch.bySheet, IMAGE_SHEET_ORDER)
  ) {
    return false;
  }
  return IMAGE_SHEET_ORDER.every(
    (sheetName) => typeof batch.bySheet[sheetName] === "string",
  );
};

export const makeBuiltinPromptSpec = (definition, batch, item) => {
  if (
    !VALIDATED_LEGACY_PROMPT_DEFINITIONS.has(definition) &&
    !validateBuiltinPromptDefinition(definition)
  ) {
    throw new Error("内置 image_gen 固定字段与 prompt catalog 编译产物不一致");
  }
  const sheetName = cleanText(item?.sheetName);
  const styleId = cleanText(batch?.styleId);
  const legacyStyleName = PROMPT_CATALOG.catalog.legacyNames.styles?.[styleId];
  const style = definition.styles?.[legacyStyleName];
  const defaultRoute = style?.bySheet?.[sheetName];
  if (!defaultRoute) {
    throw new Error(`内置 image_gen 路由不存在：${styleId || "未选择风格"}/${sheetName || "未知资产类型"}`);
  }
  const referenceImages = batch.referencesBySheet[sheetName].map((snapshot) => ({
    path: normalizePromptText(snapshot.path),
    sourceName: normalizePromptText(snapshot.sourceName),
    size: snapshot.size,
    sha256: normalizePromptText(snapshot.sha256),
  }));
  const routeMode = referenceImages.length > 0 ? "reference" : "default";
  const configuredReferenceMode = batch.referenceModeBySheet[sheetName];
  const referenceMode = routeMode === "reference" ? configuredReferenceMode : "none";
  const resolvedTemplate = resolveCatalogPromptTemplate({
    style: styleId,
    asset: sheetName,
    referenceMode,
    referenceCount: referenceImages.length,
    productionNotes: item?.productionNotes,
    selectedConditionModuleIds: item?.selectedConditionModuleIds ?? [],
  });
  const unboundResolvedTemplate = resolveCatalogPromptTemplate({
    style: styleId,
    asset: sheetName,
    referenceMode,
    referenceCount: referenceImages.length,
    productionNotes: ASSET_BINDING_MARKERS.productionNotes,
    selectedConditionModuleIds: item?.selectedConditionModuleIds ?? [],
  });
  const hasConditionResolution =
    Array.isArray(item?.selectedConditionModuleIds) && item.selectedConditionModuleIds.length > 0;
  const unmodifiedTemplate = hasConditionResolution
    ? resolveCatalogPromptTemplate({
        style: styleId,
        asset: sheetName,
        referenceMode,
        referenceCount: referenceImages.length,
        productionNotes: item?.productionNotes,
        selectedConditionModuleIds: [],
      })
    : resolvedTemplate;
  const route = {
    status: resolvedTemplate.status,
    referencePolicy: resolvedTemplate.referencePolicy,
    message: resolvedTemplate.message,
    promptFields: resolvedTemplate.promptFields,
  };
  const missingRequiredReference =
    defaultRoute.referencePolicy === "required" && referenceImages.length === 0;
  const override = batch.promptOverridesBySheet[sheetName];
  const defaultPromptText = renderPromptFields(route.promptFields);
  const unmodifiedPromptText = renderPromptFields(unmodifiedTemplate.promptFields);
  const editedPromptText = normalizePromptText(
    override?.routeMode === routeMode ? override.promptText : defaultPromptText,
  );
  const customFieldLabels = override?.routeMode === routeMode
    ? normalizeCustomFieldLabels(override.customFieldLabels) ?? []
    : [];
  const parsedFields = parsePromptFields(editedPromptText, customFieldLabels);
  const fieldSchemaValid = promptFieldSchemaMatches(route, parsedFields, customFieldLabels);
  const overrideApplied =
    override?.routeMode === routeMode && editedPromptText !== unmodifiedPromptText;
  const managedPrimaryRequestField = route.promptFields.find(
    (field) => field.label === "Primary request",
  );
  const managedUseCaseField = route.promptFields.find((field) => field.label === "Use case");
  const managedInputImagesField = route.promptFields.find(
    (field) => field.label === "Input images",
  );
  const productionNoteBindingSourceFields = referenceMode === "custom"
    ? []
    : [{
        label: "Primary request",
        value: routeMode === "reference"
          ? managedPrimaryRequestField?.value
          : parsedFields.find((field) => field.label === "Primary request")?.value,
      }];
  const insufficientUnificationImages =
    routeMode === "reference" &&
    referenceMode === "visual_consistency" &&
    referenceImages.length < 2;
  let fields = fieldSchemaValid
    ? parsedFields.map((field) => ({
        label: field.label,
        value:
          field.label === "Use case"
            ? managedUseCaseField?.value ?? field.value
            : field.label === "Input images"
              ? referenceMode === "custom"
                ? field.value
                : managedInputImagesField?.value ?? field.value
            : field.label === "Primary request"
              ? referenceMode === "custom"
                ? field.value
                : bindPromptValue(
                    routeMode === "reference"
                      ? managedPrimaryRequestField?.value
                      : field.value,
                    item?.productionNotes,
                  )
              : field.value,
      }))
    : parsedFields;
  if (fieldSchemaValid && hasConditionResolution) {
    const unmodifiedFields = new Map(
      unmodifiedTemplate.promptFields.map(({ label, value }) => [label, normalizePromptText(value)]),
    );
    const modifiedFields = new Map(
      resolvedTemplate.promptFields.map(({ label, value }) => [label, normalizePromptText(value)]),
    );
    fields = fields.map((field) => ({
      ...field,
      value:
        modifiedFields.get(field.label) !== unmodifiedFields.get(field.label)
          ? modifiedFields.get(field.label) ?? field.value
          : field.value,
    }));
  }
  const liveStylePlaceholder = fields.some(
    (field) =>
      field.label === "Style/medium" &&
      normalizePromptText(field.value).includes("【占位：等待填写真人电影风格提示词】"),
  );
  const inputImagesField = fields.find((field) => field.label === "Input images");
  const primaryRequestField = fields.find((field) => field.label === "Primary request");
  const customFieldsRequired =
    routeMode === "reference" &&
    referenceMode === "custom" &&
    (!normalizePromptText(inputImagesField?.value) ||
      normalizePromptText(inputImagesField?.value).includes(CUSTOM_INPUT_IMAGES_MARKER) ||
      !normalizePromptText(primaryRequestField?.value) ||
      normalizePromptText(primaryRequestField?.value).includes(
        CUSTOM_PRIMARY_REQUEST_MARKER,
      ));
  const promptText = fieldSchemaValid
    ? renderPromptFields(fields)
    : editedPromptText;
  const productionNoteRanges = fieldSchemaValid
    ? [
        ...productionNoteSourceRanges(
          fields,
          unboundResolvedTemplate.promptFields,
          cleanText(item?.productionNotes),
        ),
        ...productionNoteSourceRanges(
          fields,
          productionNoteBindingSourceFields,
          cleanText(item?.productionNotes),
        ),
      ]
    : [];
  const productionNoteAmbiguities = fieldSchemaValid
    ? productionNoteSourceAmbiguities(
        fields,
        unboundResolvedTemplate.promptFields,
        item?.productionNotes,
        productionNoteRanges,
      )
    : [];
  const ambiguousLabels = new Set(productionNoteAmbiguities.map(({ label }) => label));
  const analyzedPlaceholders = fieldSchemaValid
    ? analyzeAgentPromptFields(fields, { ignoredSourceRanges: productionNoteRanges })
    : null;
  const agentPlaceholderAnalysis = analyzedPlaceholders
    ? {
        ...analyzedPlaceholders,
        valid: analyzedPlaceholders.valid && productionNoteAmbiguities.length === 0,
        items: analyzedPlaceholders.items.filter(({ field }) => !ambiguousLabels.has(field)),
        errors: [
          ...productionNoteAmbiguities.map(({ error }) => error),
          ...analyzedPlaceholders.errors,
        ],
      }
    : {
        version: AGENT_PLACEHOLDER_CONTRACT_VERSION,
        valid: true,
        items: [],
        errors: [],
      };
  const customPlaceholderReady =
    defaultRoute.status === "placeholder" &&
    overrideApplied &&
    !liveStylePlaceholder;
  const status = missingRequiredReference
    ? "missing_reference"
    : insufficientUnificationImages
      ? "insufficient_reference_images"
      : !fieldSchemaValid
        ? "invalid_field_schema"
        : !agentPlaceholderAnalysis.valid
          ? "invalid_agent_placeholder"
          : customFieldsRequired
            ? "custom_fields_required"
            : !promptText
              ? "empty_prompt"
              : defaultRoute.status === "placeholder" && !customPlaceholderReady
                ? "placeholder"
                : "configured";
  return {
    styleId,
    sheetName,
    routeMode,
    referenceMode,
    status,
    message: missingRequiredReference
      ? "该路由必须添加至少一张参考图片。"
      : insufficientUnificationImages
        ? "视觉风格统一至少需要两张图片：图像 1 为主风格基准，图像 2～N 为待统一素材。"
        : !fieldSchemaValid
          ? `字段名称和数量必须完整，当前应包含：${route.promptFields
            .map((field) => normalizePromptText(field.label))
            .concat(customFieldLabels)
            .join("、")}`
          : !agentPlaceholderAnalysis.valid
            ? agentPlaceholderAnalysis.errors[0]
            : customFieldsRequired
              ? "已选择自定义参考图用途；请填写 Input images 和 Primary request，并删除模板中的中文提示。"
              : customPlaceholderReady
                ? "使用本批次编辑后的自定义提示词。"
                : normalizePromptText(defaultRoute.message),
    referencePolicy: defaultRoute.referencePolicy,
    promptText,
    fields,
    agentPlaceholderContract: {
      version: agentPlaceholderAnalysis.version,
      items: agentPlaceholderAnalysis.items,
    },
    referenceImages,
    ...(hasConditionResolution
      ? {
          conditionResolution: {
            selectedConditionModules: resolvedTemplate.selectedConditionModules ?? [],
            activeModifiers: resolvedTemplate.activeModifiers,
            enhancer: resolvedTemplate.enhancer,
            resolvedFingerprint: resolvedTemplate.fingerprints.resolvedFingerprint,
          },
        }
      : {}),
  };
};

export const makeAssetFingerprint = (item) =>
  sha256(
    JSON.stringify({
      version: 1,
      sheetName: cleanText(item?.sheetName),
      assetId: cleanText(item?.assetId),
      assetName: cleanText(item?.assetName),
      productionNotes: cleanText(item?.productionNotes),
      outputPath: cleanText(item?.outputPath),
    }),
  );

export const makeBuiltinPromptFingerprint = (assetFingerprint, promptSpec) =>
  sha256(JSON.stringify({ version: 1, assetFingerprint, promptSpec }));

const currentProcessStartTime = new Date(Date.now() - process.uptime() * 1000).toISOString();
const currentHost = os.hostname();

const makeLockError = (lock) => {
  const error = new Error(
    `已有流水线任务占用：${lock?.kind ?? "unknown"}:${lock?.key ?? "unknown"}`,
  );
  error.code = "PIPELINE_LOCKED";
  error.lock = lock;
  return error;
};

const processExists = (processId) => {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return null;
  }
};

const windowsProcessStartTime = async (processId) => {
  const command = [
    "$ErrorActionPreference='Stop'",
    `$p=[System.Diagnostics.Process]::GetProcessById(${processId})`,
    "$p.StartTime.ToUniversalTime().ToString('o')",
  ].join("; ");
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      { encoding: "utf8", timeout: 5000, windowsHide: true },
    );
    const value = cleanText(stdout);
    return Number.isFinite(Date.parse(value)) ? value : null;
  } catch {
    return null;
  }
};

const classifyTransientLockOwner = async (lock) => {
  if (
    lock?.protocolVersion !== PIPELINE_LOCK_PROTOCOL_VERSION ||
    lock?.leaseMode !== "transient" ||
    cleanText(lock?.host).toLocaleLowerCase() !== currentHost.toLocaleLowerCase() ||
    !Number.isInteger(lock?.processId) ||
    lock.processId < 1 ||
    !Number.isFinite(Date.parse(lock?.processStartTime))
  ) {
    return "unknown";
  }
  const exists = processExists(lock.processId);
  if (exists === false) return "dead";
  if (exists !== true) return "unknown";

  if (lock.processId === process.pid) {
    return Math.abs(Date.parse(lock.processStartTime) - Date.parse(currentProcessStartTime)) <= 5000
      ? "alive"
      : "identity_mismatch";
  }
  if (process.platform !== "win32") return "unknown";
  const actualStartTime = await windowsProcessStartTime(lock.processId);
  if (!actualStartTime) return "unknown";
  return Math.abs(Date.parse(lock.processStartTime) - Date.parse(actualStartTime)) <= 5000
    ? "alive"
    : "identity_mismatch";
};

export const readPipelineLock = async (lockPath) => {
  const lock = await readJsonFile(lockPath, {
    fallback: null,
    label: "流水线锁",
    retries: 2,
  });
  if (lock === null) return null;
  if (!isObject(lock) || !cleanText(lock.kind) || !cleanText(lock.key)) {
    throw new Error("流水线锁结构无效，禁止继续");
  }
  return lock;
};

const quarantineStaleLock = async (lockPath, expected) => {
  const current = await readPipelineLock(lockPath);
  if (!current || !cleanText(expected?.token) || current.token !== expected.token) {
    throw makeLockError(current);
  }
  const quarantinePath = `${lockPath}.stale.${expected.token}.${crypto.randomUUID()}`;
  try {
    await fs.rename(lockPath, quarantinePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw makeLockError(await readPipelineLock(lockPath));
  }
  await fs.rm(quarantinePath, { force: true }).catch(() => {});
};

export const acquirePipelineLock = async (lockPath, payload) => {
  const transactionPath = path.join(path.dirname(lockPath), ".pipeline.transaction.json");
  if (await fs.stat(transactionPath).then((stat) => stat.isFile()).catch(() => false)) {
    const error = new Error(
      "检测到未恢复的 Cache 写入事务；禁止接管或启动其他流水线任务，请先重跑切分/同步脚本完成恢复",
    );
    error.code = "PIPELINE_TRANSACTION_PENDING";
    throw error;
  }
  const now = new Date().toISOString();
  const lock = {
    ...payload,
    protocolVersion: PIPELINE_LOCK_PROTOCOL_VERSION,
    leaseMode: payload?.leaseMode === "transient" ? "transient" : "durable",
    processId: process.pid,
    processStartTime: currentProcessStartTime,
    host: currentHost,
    token: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  };
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    let created = false;
    try {
      handle = await fs.open(lockPath, "wx");
      created = true;
      await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      return lock;
    } catch (error) {
      await handle?.close().catch(() => {});
      if (created) await fs.rm(lockPath, { force: true }).catch(() => {});
      if (error?.code !== "EEXIST") throw error;
      const existing = await readPipelineLock(lockPath);
      if (attempt === 0) {
        const state = await classifyTransientLockOwner(existing);
        if (state === "dead" || state === "identity_mismatch") {
          await quarantineStaleLock(lockPath, existing);
          continue;
        }
      }
      throw makeLockError(existing);
    }
  }
  throw makeLockError(await readPipelineLock(lockPath));
};

export const rotatePipelineLock = async (lockPath, expected, payload = {}) => {
  const current = await requirePipelineLock(lockPath, expected);
  if (current.leaseMode !== "durable") {
    throw new Error("只有 durable 流水线锁允许轮换会话令牌");
  }
  const now = new Date().toISOString();
  const rotated = {
    ...current,
    ...payload,
    protocolVersion: PIPELINE_LOCK_PROTOCOL_VERSION,
    leaseMode: "durable",
    processId: process.pid,
    processStartTime: currentProcessStartTime,
    host: currentHost,
    token: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    resumedFromTokenHash: sha256(current.token),
  };
  await writeJsonAtomic(lockPath, rotated);
  return rotated;
};

export const requirePipelineLock = async (lockPath, expected) => {
  const lock = await readPipelineLock(lockPath);
  if (!lock) throw new Error("当前任务未持有流水线锁");
  for (const [field, value] of Object.entries(expected)) {
    if (value !== undefined && lock[field] !== value) {
      throw new Error(`流水线锁不属于当前任务：${lock.kind}:${lock.key}`);
    }
  }
  return lock;
};

export const releasePipelineLock = async (lockPath, expected) => {
  const lock = await requirePipelineLock(lockPath, expected);
  if (!cleanText(lock.token)) throw new Error("流水线锁缺少释放令牌，禁止自动删除");
  await fs.unlink(lockPath);
};
