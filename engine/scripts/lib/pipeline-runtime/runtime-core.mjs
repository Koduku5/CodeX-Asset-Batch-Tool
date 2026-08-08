import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { isPathWithinOrSame } from "./image-validation.mjs";

export const IMAGE_BACKENDS = Object.freeze(["builtin", "api"]);
export const MAX_EXCEL_CELL_CHARACTERS = 32_767;

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
