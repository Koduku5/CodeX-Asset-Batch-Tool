import { timingSafeEqual } from 'node:crypto';
import { isAbsolute, win32 } from 'node:path';

import { BuiltinBatchServiceError } from './builtin-batch-service.mjs';
import { CodexImagegenHandoffError } from './codex-imagegen-handoff.mjs';
import { IntinifyCanvasServiceError } from './intinify-canvas-service.mjs';
import { PromptRegistryServiceError } from './prompt-registry-service.mjs';
import {
  MAX_REFERENCE_IMAGE_BYTES,
  ReferenceImageStoreError
} from './reference-image-store.mjs';
import {
  MAX_SCREENPLAY_BYTES,
  SoftwareWorkspaceError
} from './software-workspace.mjs';
import { StageTimingServiceError } from './stage-timing-service.mjs';

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_BATCH_BODY_BYTES = 1024 * 1024;
export const API_ASPECT_RATIOS = new Set([
  '21:9', '16:9', '5:4', '4:3', '3:2', '1:1', '2:3', '3:4', '4:5', '9:16'
]);
export const API_IMAGE_SIZES = new Set(['1K', '2K']);
export const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

const STYLE_INPUTS = new Set(['anime', 'cg', 'live-action', '二次元', 'CG', '真人']);
const ASSET_INPUTS = new Set([
  'character', 'creature', 'crowd', 'scene', 'prop', '角色', '生物', '群演', '场景', '道具'
]);
const REFERENCE_MODES = new Set(['none', 'style', 'visual-consistency', 'custom']);
const RESOLVE_KEYS = new Set(['style', 'asset', 'referenceMode', 'referenceCount', 'productionNotes']);
const SENSITIVE_RESPONSE_KEYS = new Set([
  'password', 'passwordhash', 'credential', 'credentials', 'token', 'accesstoken',
  'refreshtoken', 'jwt', 'secret', 'apikey', 'prompt', 'prompts', 'productionnotes',
  'pid', 'processid', 'queue', 'queueitems'
]);
const SENSITIVE_RESPONSE_KEY_FRAGMENTS = [
  'password', 'credential', 'token', 'secret', 'prompt', 'apikey'
];
const SENSITIVE_RESPONSE_VALUE = /(?:^|[^a-z0-9])(?:password|credential|access[-_ ]?token|refresh[-_ ]?token|secret|prompt|api[-_ ]?key|jwt|pid)(?:$|[^a-z0-9])/iu;
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const DESKTOP_PROTECTED_PATHS = ['/api/', '/desktop/', '/health', '/shutdown'];

export class HttpError extends Error {
  constructor(status, code, message, { allow = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.allow = allow;
  }
}

export const constantTimeTextEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left ?? ''), 'utf8');
  const rightBuffer = Buffer.from(String(right ?? ''), 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const normalizeAllowedOrigin = (value) => {
  if (value === undefined || value === null || value === '') return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('allowedOrigin 必须是有效的 http://127.0.0.1:<port> 来源');
  }
  if (parsed.protocol !== 'http:'
    || parsed.hostname !== '127.0.0.1'
    || !parsed.port
    || parsed.origin !== value) {
    throw new TypeError('allowedOrigin 必须是精确的 http://127.0.0.1:<port> 来源');
  }
  return parsed.origin;
};

export const createDesktopSecurity = (options = {}) => {
  const desktopMode = options.desktopMode === true;
  const capabilityToken = typeof options.capabilityToken === 'string' ? options.capabilityToken : '';
  const nativeCapabilityToken = typeof options.nativeCapabilityToken === 'string'
    ? options.nativeCapabilityToken
    : '';
  if (desktopMode && Buffer.byteLength(capabilityToken, 'utf8') < 32) {
    throw new TypeError('desktopMode 需要至少 32 字节的 capabilityToken');
  }
  if (nativeCapabilityToken && Buffer.byteLength(nativeCapabilityToken, 'utf8') < 32) {
    throw new TypeError('nativeCapabilityToken 至少需要 32 字节');
  }
  return Object.freeze({
    desktopMode,
    capabilityToken,
    nativeCapabilityToken,
    allowedOrigin: normalizeAllowedOrigin(options.allowedOrigin),
    openDirectory: typeof options.desktopOpenDirectory === 'function'
      ? options.desktopOpenDirectory
      : async () => { throw new HttpError(503, 'PROJECT_DIRECTORY_OPEN_UNAVAILABLE', '桌面壳没有注册打开文件夹能力'); },
    openApiSettings: typeof options.desktopOpenApiSettings === 'function'
      ? options.desktopOpenApiSettings
      : async () => { throw new HttpError(503, 'API_SETTINGS_UNAVAILABLE', '桌面壳没有注册无限画板 API 配置能力'); },
    loadApiCatalog: typeof options.desktopLoadApiCatalog === 'function'
      ? options.desktopLoadApiCatalog
      : async () => { throw new HttpError(503, 'API_CATALOG_UNAVAILABLE', '桌面壳没有注册无限画板登录能力'); },
    startApiBatch: typeof options.desktopStartApiBatch === 'function'
      ? options.desktopStartApiBatch
      : async () => { throw new HttpError(503, 'API_BATCH_UNAVAILABLE', '桌面壳没有注册无限画板执行能力'); }
  });
};

const originForRequest = (request, configuredOrigin) => {
  if (configuredOrigin) return configuredOrigin;
  const port = request.socket?.localPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `http://127.0.0.1:${port}`;
};

export const validateDesktopRequest = (request, pathname, security) => {
  if (!security.desktopMode) return;
  const expectedOrigin = originForRequest(request, security.allowedOrigin);
  if (!expectedOrigin) {
    throw new HttpError(503, 'DESKTOP_ORIGIN_UNAVAILABLE', '桌面服务尚未完成本地端口绑定');
  }
  const expectedHost = new URL(expectedOrigin).host;
  if (!constantTimeTextEqual(request.headers.host, expectedHost)) {
    throw new HttpError(403, 'INVALID_DESKTOP_HOST', '桌面服务拒绝了无效的本地主机标识');
  }
  const tokenRequired = DESKTOP_PROTECTED_PATHS.some((prefix) => (
    prefix.endsWith('/') ? pathname.startsWith(prefix) : pathname === prefix
  ));
  const suppliedOrigin = request.headers.origin;
  if (suppliedOrigin !== undefined && !constantTimeTextEqual(suppliedOrigin, expectedOrigin)) {
    throw new HttpError(403, 'INVALID_DESKTOP_ORIGIN', '桌面服务拒绝了跨来源请求');
  }
  const suppliedReferer = request.headers.referer;
  if (suppliedOrigin === undefined && suppliedReferer !== undefined) {
    let refererOrigin = null;
    try {
      refererOrigin = new URL(suppliedReferer).origin;
    } catch {
      // Invalid referrers are rejected below.
    }
    if (!constantTimeTextEqual(refererOrigin, expectedOrigin)) {
      throw new HttpError(403, 'INVALID_DESKTOP_ORIGIN', '桌面服务拒绝了跨来源请求');
    }
  }
  if (tokenRequired && suppliedOrigin === undefined && suppliedReferer === undefined) {
    throw new HttpError(403, 'DESKTOP_ORIGIN_REQUIRED', '桌面服务需要有效的本地请求来源');
  }
  if (tokenRequired
    && !constantTimeTextEqual(request.headers['x-ka-desktop-token'], security.capabilityToken)) {
    throw new HttpError(401, 'DESKTOP_TOKEN_REQUIRED', '桌面服务需要有效的本地会话令牌');
  }
};

export const requireLoopbackRequest = (request) => {
  const remoteAddress = request.socket?.remoteAddress || '';
  if (!LOOPBACK_ADDRESSES.has(remoteAddress)) {
    throw new HttpError(403, 'LOCAL_ONLY', '本地服务只接受当前电脑的请求');
  }
};

export const requireMethod = (request, ...allowed) => {
  if (!allowed.includes(request.method)) {
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', `此端点只允许 ${allowed.join(' 或 ')}`, {
      allow: allowed.join(', ')
    });
  }
};

export const sendJson = (response, status, value, extraHeaders = {}) => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders
  });
  response.end(`${JSON.stringify(value)}\n`);
};

const normalizeResponseKey = (value) => String(value).replace(/[-_]/gu, '').toLowerCase();
const isSensitiveResponseKey = (value) => {
  const key = normalizeResponseKey(value);
  return SENSITIVE_RESPONSE_KEYS.has(key)
    || SENSITIVE_RESPONSE_KEY_FRAGMENTS.some((fragment) => key.includes(fragment))
    || key === 'pid'
    || key.endsWith('pid');
};
const hasAbsolutePath = (value, forbiddenRoots = []) => {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  if (isAbsolute(text) || win32.isAbsolute(text) || /^file:\/\//iu.test(text)) return true;
  if (/(?:^|[^a-z0-9])[A-Za-z]:[\\/]/iu.test(text)
    || /(?:^|[^\\])\\\\[^\\/\s]+[\\/]/u.test(text)) return true;
  if (/(?:^|[\s("'=\[])\/(?:[^/\s]+\/)*[^/\s]+/u.test(text)) return true;
  return forbiddenRoots.some((root) => {
    const needle = String(root || '');
    if (!needle) return false;
    return process.platform === 'win32'
      ? text.toLowerCase().includes(needle.toLowerCase())
      : text.includes(needle);
  });
};

export const redactForResponse = (value, forbiddenRoots = []) => {
  if (Array.isArray(value)) return value.map((item) => redactForResponse(item, forbiddenRoots));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
      if (isSensitiveResponseKey(key)) return [];
      return [[key, redactForResponse(item, forbiddenRoots)]];
    }));
  }
  if (typeof value === 'string' && SENSITIVE_RESPONSE_VALUE.test(value)) return '[redacted]';
  if (hasAbsolutePath(value, forbiddenRoots)) return '[redacted]';
  return value;
};

export const parseRequestPathname = (requestUrl) => {
  const target = String(requestUrl || '');
  const rawPath = target.split(/[?#]/u, 1)[0];
  let decodedRaw;
  try {
    decodedRaw = decodeURIComponent(rawPath);
  } catch {
    throw new HttpError(400, 'INVALID_PATH', '请求路径编码无效');
  }
  if (decodedRaw.includes('\u0000')
    || decodedRaw.replace(/\\/gu, '/').split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new HttpError(400, 'INVALID_PATH', '请求路径不得包含点段或路径穿越');
  }
  try {
    return decodeURIComponent(new URL(target, 'http://localhost').pathname);
  } catch {
    throw new HttpError(400, 'INVALID_PATH', '请求路径编码无效');
  }
};

export const readJsonBody = async (request, maximumBytes = MAX_BODY_BYTES) => {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '请求必须使用 application/json');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) {
      throw new HttpError(413, 'BODY_TOO_LARGE', '请求体超过当前接口限制');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_JSON', '请求体不是有效 JSON');
  }
};

export const requireEmptyBody = async (request) => {
  for await (const chunk of request) {
    if (chunk.length > 0) {
      throw new HttpError(400, 'INVALID_REQUEST', '删除项目请求不接受请求体');
    }
  }
};

export const serviceHttpError = (error) => {
  if (error instanceof ReferenceImageStoreError
    || error instanceof BuiltinBatchServiceError
    || error instanceof PromptRegistryServiceError
    || error instanceof CodexImagegenHandoffError
    || error instanceof StageTimingServiceError) {
    return new HttpError(error.status, error.code, error.message);
  }
  return error;
};

export const canvasHttpError = (error) => {
  if (!(error instanceof IntinifyCanvasServiceError)) return error;
  const status = ['INVALID_BASE_URL', 'INSECURE_BASE_URL', 'INVALID_USERNAME', 'INVALID_PASSWORD']
    .includes(error.code) ? 400 : 502;
  return new HttpError(status, error.code, error.message);
};

export const validateReferenceUploadLength = (request) => {
  const value = request.headers['content-length'];
  if (value === undefined) return;
  if (!/^\d+$/u.test(value)) {
    throw new HttpError(400, 'INVALID_CONTENT_LENGTH', '参考图上传长度无效');
  }
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new HttpError(400, 'EMPTY_REFERENCE_IMAGE', '参考图不能为空');
  }
  if (size > MAX_REFERENCE_IMAGE_BYTES) {
    throw new HttpError(413, 'REFERENCE_IMAGE_TOO_LARGE', '单张参考图不能超过 20 MiB');
  }
};

export const exactRequestKeys = (value, allowed, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_REQUEST', `${label} 必须是对象`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new HttpError(400, 'INVALID_REQUEST', `${label} 包含不允许的字段`);
  }
  return value;
};

export const workspaceHttpError = (error) => {
  if (!(error instanceof SoftwareWorkspaceError)) return error;
  const status = error.code === 'SCREENPLAY_TOO_LARGE' ? 413
    : error.code === 'PROJECT_NOT_FOUND' ? 404
      : ['PROJECT_EXISTS', 'SCREENPLAY_EXISTS', 'PROJECT_MUTATION_BUSY'].includes(error.code) ? 409
      : ['UNSAFE_REPARSE_POINT', 'PATH_OUTSIDE_SOFTWARE_ROOT'].includes(error.code) ? 403
        : [
          'INVALID_DISPLAY_NAME', 'INVALID_PROJECT_ID', 'INVALID_FILENAME', 'UNSAFE_FILENAME',
          'UNSUPPORTED_SCREENPLAY_TYPE', 'INVALID_UPLOAD_BODY', 'INVALID_OVERWRITE_OPTION',
          'EMPTY_SCREENPLAY'
        ].includes(error.code) ? 400
          : 503;
  return new HttpError(status, error.code, error.message);
};

export const decodeUploadFilename = (request) => {
  const encoded = request.headers['x-ka-filename'];
  if (typeof encoded !== 'string' || !encoded || encoded.length > 1024) {
    throw new HttpError(400, 'INVALID_FILENAME', '缺少有效的剧本文件名');
  }
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new HttpError(400, 'INVALID_FILENAME', '剧本文件名编码无效');
  }
};

export const decodeOverwrite = (request) => {
  const value = request.headers['x-ka-overwrite'];
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new HttpError(400, 'INVALID_OVERWRITE_OPTION', '覆盖选项无效');
};

export const validateUploadLength = (request) => {
  const value = request.headers['content-length'];
  if (value === undefined) return;
  if (!/^\d+$/u.test(value)) {
    throw new HttpError(400, 'INVALID_CONTENT_LENGTH', '上传长度无效');
  }
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new HttpError(400, 'EMPTY_SCREENPLAY', '剧本文件不能为空');
  }
  if (size > MAX_SCREENPLAY_BYTES) {
    throw new HttpError(413, 'SCREENPLAY_TOO_LARGE', '单个剧本不能超过 200 MiB');
  }
};

export const cleanString = (value, label, maxLength, { optional = false } = {}) => {
  if (optional && (value === undefined || value === null || value === '')) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, 'INVALID_REQUEST', `${label} 必须是非空字符串`);
  }
  if (value.length > maxLength) {
    throw new HttpError(400, 'INVALID_REQUEST', `${label} 超过 ${maxLength} 字符`);
  }
  return value;
};

export const validateResolveInput = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_REQUEST', 'resolve 请求必须是对象');
  }
  const unknown = Object.keys(value).filter((key) => !RESOLVE_KEYS.has(key));
  if (unknown.length) {
    throw new HttpError(400, 'INVALID_REQUEST', `不允许的字段：${unknown.join(', ')}`);
  }
  const style = cleanString(value.style, 'style', 32);
  const asset = cleanString(value.asset, 'asset', 32);
  const referenceMode = value.referenceMode ?? 'none';
  const referenceCount = value.referenceCount ?? 0;
  if (!STYLE_INPUTS.has(style)) {
    throw new HttpError(400, 'INVALID_REQUEST', 'style 不在允许范围内');
  }
  if (!ASSET_INPUTS.has(asset)) {
    throw new HttpError(400, 'INVALID_REQUEST', 'asset 不在允许范围内');
  }
  if (!REFERENCE_MODES.has(referenceMode)) {
    throw new HttpError(400, 'INVALID_REQUEST', 'referenceMode 不在允许范围内');
  }
  if (!Number.isInteger(referenceCount) || referenceCount < 0 || referenceCount > 16) {
    throw new HttpError(400, 'INVALID_REQUEST', 'referenceCount 必须是 0 到 16 的整数');
  }
  if ((referenceMode === 'none' && referenceCount !== 0)
    || (referenceMode !== 'none' && referenceCount < 1)) {
    throw new HttpError(400, 'INVALID_REQUEST', 'referenceMode 与 referenceCount 不一致');
  }
  const productionNotes = value.productionNotes === undefined
    ? undefined
    : cleanString(value.productionNotes, 'productionNotes', 32767, { optional: true });
  return {
    style,
    asset,
    referenceMode,
    referenceCount,
    ...(productionNotes !== undefined ? { productionNotes } : {})
  };
};
