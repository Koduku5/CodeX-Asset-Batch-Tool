import { createHash } from 'node:crypto';
import { extname } from 'node:path';

export const SOFTWARE_WORKSPACE_SCHEMA_VERSION = 1;
export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_SCREENPLAY_BYTES = 200 * 1024 * 1024;

const WINDOWS_RESERVED_BASENAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`)
]);

export class SoftwareWorkspaceError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = 'SoftwareWorkspaceError';
    this.code = code;
    this.cause = cause;
  }
}

export const fail = (code, message, cause = null) => {
  throw new SoftwareWorkspaceError(code, message, cause);
};

export const assertPositiveInteger = (value, label, maximum) => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    fail('INVALID_OPTION', `${label} 必须是 1 到 ${maximum} 的整数`);
  }
  return value;
};

export const validateDisplayName = (value, maximumLength) => {
  if (typeof value !== 'string') fail('INVALID_DISPLAY_NAME', '项目名称必须是字符串');
  const normalized = value.normalize('NFC');
  if (!normalized || normalized !== normalized.trim()) {
    fail('INVALID_DISPLAY_NAME', '项目名称不能为空，也不能带首尾空格');
  }
  if (normalized.length > maximumLength) fail('INVALID_DISPLAY_NAME', `项目名称不能超过 ${maximumLength} 个字符`);
  if (/[\u0000-\u001f\u007f<>:"/\\|?*]/u.test(normalized) || normalized === '.' || normalized === '..') {
    fail('INVALID_DISPLAY_NAME', '项目名称含有路径符号或控制字符');
  }
  if (/[. ]$/u.test(normalized)) fail('INVALID_DISPLAY_NAME', '项目名称不能以点或空格结尾');
  return normalized;
};

export function projectIdFromDisplayName(displayName) {
  if (typeof displayName !== 'string' || !displayName.length) {
    fail('INVALID_DISPLAY_NAME', '项目名称不能为空');
  }
  const normalized = displayName.normalize('NFC');
  const slug = normalized
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40)
    .replace(/-+$/gu, '');
  const fingerprint = createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 12);
  return `${slug || 'project'}-${fingerprint}`;
}

export const validateProjectId = (projectId) => {
  if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) {
    fail('INVALID_PROJECT_ID', 'projectId 含有无效字符');
  }
  return projectId;
};

export function sanitizeScreenplayFilename(filename) {
  if (typeof filename !== 'string' || !filename.length || filename.length > 255) {
    fail('INVALID_FILENAME', '剧本文件名必须是 1 到 255 个字符');
  }
  if (filename.includes('/') || filename.includes('\\') || filename === '.' || filename === '..') {
    fail('UNSAFE_FILENAME', '剧本文件名不能包含路径');
  }
  let safeName = filename
    .normalize('NFC')
    .trim()
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/gu, '_')
    .replace(/[. ]+$/gu, '');
  const extension = extname(safeName).toLocaleLowerCase('en-US');
  if (extension !== '.txt' && extension !== '.docx') {
    fail('UNSUPPORTED_SCREENPLAY_TYPE', '只允许导入 .txt 或 .docx 剧本');
  }
  let stem = safeName.slice(0, -extension.length).replace(/[. ]+$/gu, '');
  if (!stem) fail('INVALID_FILENAME', '剧本文件名缺少有效名称');
  if (WINDOWS_RESERVED_BASENAMES.has(stem.toLocaleLowerCase('en-US'))) stem = `_${stem}`;
  stem = stem.slice(0, 180 - extension.length).replace(/[. ]+$/gu, '');
  safeName = `${stem}${extension}`;
  return safeName;
}
