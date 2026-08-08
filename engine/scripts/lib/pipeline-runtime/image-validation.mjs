import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";

export const MAX_VALIDATED_PNG_BYTES = 64 * 1024 * 1024;
export const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_REFERENCE_IMAGE_PIXELS = 24 * 1024 * 1024;

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
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
