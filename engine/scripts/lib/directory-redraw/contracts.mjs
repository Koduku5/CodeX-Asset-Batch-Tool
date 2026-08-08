import fs from 'node:fs/promises';
import path from 'node:path';

import {
  cleanText,
  hasExactKeys,
  normalizePromptText,
  parseJsonText
} from '../pipeline_runtime.mjs';

export const normalizeCase = (value) =>
  process.platform === 'win32' ? value.toLowerCase() : value;

// Keep exact filesystem code points for I/O; NFC is only a comparison key.
export const toPortableRelativePath = (value) => String(value ?? '').split(path.sep).join('/');
export const comparisonPathKey = (value) =>
  toPortableRelativePath(value).normalize('NFC').toLowerCase();
export const comparePortablePaths = (left, right) => {
  const leftRaw = toPortableRelativePath(left);
  const rightRaw = toPortableRelativePath(right);
  const folded = comparisonPathKey(leftRaw).localeCompare(comparisonPathKey(rightRaw), 'en');
  if (folded) return folded;
  return leftRaw < rightRaw ? -1 : leftRaw > rightRaw ? 1 : 0;
};

export const isRootPath = (value) =>
  normalizeCase(path.resolve(value)) === normalizeCase(path.parse(path.resolve(value)).root);

export const isWithinOrSame = (target, root) => {
  const relative = path.relative(root, target);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

export const resolveInside = (root, relativePath, label) => {
  if (!cleanText(relativePath) || path.isAbsolute(relativePath)) {
    throw new Error(`${label}不是有效相对路径：${relativePath}`);
  }
  const segments = String(relativePath).split('/');
  if (segments.some((segment) =>
    !segment || segment === '.' || segment === '..' || segment.includes(':') || segment.includes('\\'))) {
    throw new Error(`${label}含有非法路径片段：${relativePath}`);
  }
  const target = path.resolve(root, ...segments);
  if (!isWithinOrSame(target, root) || normalizeCase(target) === normalizeCase(root)) {
    throw new Error(`${label}越出所选目录：${relativePath}`);
  }
  return target;
};

export const decodeConfiguration = () => {
  const encoded = cleanText(process.env.KA_REDRAW_CONFIG_B64);
  if (!encoded) throw new Error('缺少 KA_REDRAW_CONFIG_B64 批量重绘配置');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error('KA_REDRAW_CONFIG_B64 不是有效 Base64');
  }
  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded, 'base64'));
  } catch (error) {
    throw new Error(`批量重绘配置不是有效 UTF-8：${error.message}`);
  }
  const config = parseJsonText(decoded, '批量重绘配置');
  if (
    !hasExactKeys(config, ['outputRoot', 'prompt', 'sourceRoot'])
    || typeof config.sourceRoot !== 'string'
    || typeof config.outputRoot !== 'string'
    || typeof config.prompt !== 'string'
  ) {
    throw new Error('批量重绘配置必须且只能包含 sourceRoot、outputRoot、prompt 三个字符串');
  }
  const prompt = normalizePromptText(config.prompt);
  if (!prompt) throw new Error('本批次统一重绘要求不能为空');
  return {
    sourceRoot: cleanText(config.sourceRoot),
    outputRoot: cleanText(config.outputRoot),
    prompt
  };
};

export const requireRealDirectory = async (input, label) => {
  if (!input || !path.isAbsolute(input)) throw new Error(`${label}必须是绝对路径`);
  const resolved = path.resolve(input);
  if (isRootPath(resolved)) throw new Error(`${label}不能是盘符根目录或 UNC 共享根目录`);
  let linkStat;
  try {
    linkStat = await fs.lstat(resolved);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${label}不存在：${resolved}`);
    throw new Error(`${label}无法读取：${resolved}（${error?.code ?? error.message}）`);
  }
  if (linkStat.isSymbolicLink()) throw new Error(`${label}不能是符号链接或目录联接：${resolved}`);
  if (!linkStat.isDirectory()) throw new Error(`${label}不是文件夹：${resolved}`);
  const real = await fs.realpath(resolved);
  if (isRootPath(real)) throw new Error(`${label}不能解析到盘符根目录或 UNC 共享根目录`);
  return real;
};
