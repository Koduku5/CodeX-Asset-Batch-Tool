import { validatePngBytes } from '../pipeline_runtime.mjs';

const MAX_IMAGE_PIXELS = 24 * 1024 * 1024;
const dimensionsAreSafe = (width, height) =>
  Number.isInteger(width)
  && Number.isInteger(height)
  && width > 0
  && height > 0
  && width <= Math.floor(MAX_IMAGE_PIXELS / height);

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

export const imageSignatureMatches = (extension, bytes) => {
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
