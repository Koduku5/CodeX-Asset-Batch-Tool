// Zero-dependency local preview server with a read-only Prompt Catalog bridge.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createApiRouteHandler } from './routes/api-routes.mjs';
import { createDesktopRouteHandler } from './routes/desktop-routes.mjs';
import { createStaticRouteHandler } from './routes/static-route.mjs';
import {
  compileLegacyDefinition,
  getApiDefaultTemplates,
  loadPromptCatalog,
  makeCatalogFingerprint,
  resolvePromptTemplate,
  validatePromptCatalog
} from '../../engine/scripts/lib/prompt_catalog.mjs';
import {
  createProjectRootIndex,
  PROJECT_INDEX_SCHEMA_VERSION,
  ProjectRootIndexError
} from './project-root-index.mjs';
import {
  createSoftwareWorkspace,
  MAX_SCREENPLAY_BYTES,
  SoftwareWorkspaceError
} from './software-workspace.mjs';
import {
  createPipelineTaskRunner,
  PipelineTaskRunnerError
} from './pipeline-task-runner.mjs';
import { createWorkbenchSnapshotReader } from './workbench-snapshot.mjs';
import {
  createReferenceImageStore,
  MAX_REFERENCE_IMAGE_BYTES,
  ReferenceImageStoreError
} from './reference-image-store.mjs';
import {
  BuiltinBatchServiceError,
  createBuiltinBatchService
} from './builtin-batch-service.mjs';
import {
  createPromptRegistryService,
  PromptRegistryServiceError
} from './prompt-registry-service.mjs';
import {
  createCodexImagegenHandoffService,
  CodexImagegenHandoffError
} from './codex-imagegen-handoff.mjs';
import { IntinifyCanvasServiceError } from './intinify-canvas-service.mjs';
import {
  CodexSdkStatusError,
  createCodexSdkStatusService
} from './codex-sdk-status.mjs';
import {
  CodexAgentChatError,
  createCodexAgentChatService
} from './codex-agent-chat-service.mjs';
import {
  CodexRuntimeConfigError,
  createCodexRuntimeConfigStore
} from './codex-runtime-config.mjs';
import {
  createPendingAssetService,
  PendingAssetServiceError
} from './pending-asset-service.mjs';

const serverRoot = fileURLToPath(new URL('.', import.meta.url));
const applicationRoot = resolve(serverRoot, '../..');
const builtRendererRoot = resolve(applicationRoot, 'dist/renderer');
const defaultEngineRoot = resolve(applicationRoot, 'engine');
const defaultSkillsRoot = resolve(applicationRoot, 'skills');
const defaultSoftwareRoot = resolve(applicationRoot, '.local');
const MAX_BODY_BYTES = 64 * 1024;
const MAX_BATCH_BODY_BYTES = 1024 * 1024;
const STYLE_INPUTS = new Set(['anime', 'cg', 'live-action', '二次元', 'CG', '真人']);
const ASSET_INPUTS = new Set(['character', 'creature', 'crowd', 'scene', 'prop', '角色', '生物', '群演', '场景', '道具']);
const REFERENCE_MODES = new Set(['none', 'style', 'visual-consistency', 'custom']);
const API_ASPECT_RATIOS = new Set(['21:9', '16:9', '5:4', '4:3', '3:2', '1:1', '2:3', '3:4', '4:5', '9:16']);
const API_IMAGE_SIZES = new Set(['1K', '2K']);
const RESOLVE_KEYS = new Set(['style', 'asset', 'referenceMode', 'referenceCount', 'productionNotes']);
const SUMMARY_PROGRESS_MODES = new Set(['none', 'indeterminate', 'determinate']);
const SUMMARY_PHASES = new Set(['split', 'analysis', 'world-overview', 'asset-visual-specs', 'excel', 'generation', 'complete', 'waiting-generation']);
const SUMMARY_STATES = new Set(['active', 'complete', 'waiting', 'warning', 'idle']);
const SUMMARY_BATCH_MODES = new Set(['none', 'idle', 'active', 'complete', 'warning']);
const SUMMARY_BACKENDS = new Set(['none', 'builtin', 'api', 'multiple', 'unknown']);
const SENSITIVE_RESPONSE_KEYS = new Set([
  'password', 'passwordhash', 'credential', 'credentials', 'token', 'accesstoken',
  'refreshtoken', 'jwt', 'secret', 'apikey', 'prompt', 'prompts', 'productionnotes',
  'pid', 'processid', 'queue', 'queueitems'
]);
const SENSITIVE_RESPONSE_KEY_FRAGMENTS = ['password', 'credential', 'token', 'secret', 'prompt', 'apikey'];
const SENSITIVE_RESPONSE_VALUE = /(?:^|[^a-z0-9])(?:password|credential|access[-_ ]?token|refresh[-_ ]?token|secret|prompt|api[-_ ]?key|jwt|pid)(?:$|[^a-z0-9])/iu;
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const DESKTOP_PROTECTED_PATHS = ['/api/', '/desktop/', '/health', '/shutdown'];

const constantTimeTextEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left ?? ''), 'utf8');
  const rightBuffer = Buffer.from(String(right ?? ''), 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const originForRequest = (request, configuredOrigin) => {
  if (configuredOrigin) return configuredOrigin;
  const port = request.socket?.localPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `http://127.0.0.1:${port}`;
};

const validateDesktopRequest = (request, pathname, security) => {
  if (!security.desktopMode) return;
  const expectedOrigin = originForRequest(request, security.allowedOrigin);
  if (!expectedOrigin) throw new HttpError(503, 'DESKTOP_ORIGIN_UNAVAILABLE', '桌面服务尚未完成本地端口绑定');
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
  if (tokenRequired && !constantTimeTextEqual(request.headers['x-ka-desktop-token'], security.capabilityToken)) {
    throw new HttpError(401, 'DESKTOP_TOKEN_REQUIRED', '桌面服务需要有效的本地会话令牌');
  }
};

const normalizeAllowedOrigin = (value) => {
  if (value === undefined || value === null || value === '') return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('allowedOrigin 必须是有效的 http://127.0.0.1:<port> 来源');
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port || parsed.origin !== value) {
    throw new TypeError('allowedOrigin 必须是精确的 http://127.0.0.1:<port> 来源');
  }
  return parsed.origin;
};

class HttpError extends Error {
  constructor(status, code, message, { allow = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.allow = allow;
  }
}

const requireMethod = (request, ...allowed) => {
  if (!allowed.includes(request.method)) {
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', `此端点只允许 ${allowed.join(' 或 ')}`, { allow: allowed.join(', ') });
  }
};

const sendJson = (response, status, value, extraHeaders = {}) => {
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
  if (/(?:^|[^a-z0-9])[A-Za-z]:[\\/]/iu.test(text) || /(?:^|[^\\])\\\\[^\\/\s]+[\\/]/u.test(text)) return true;
  if (/(?:^|[\s("'=\[])\/(?:[^/\s]+\/)*[^/\s]+/u.test(text)) return true;
  return forbiddenRoots.some((root) => {
    const needle = String(root || '');
    if (!needle) return false;
    return process.platform === 'win32'
      ? text.toLowerCase().includes(needle.toLowerCase())
      : text.includes(needle);
  });
};

const redactForResponse = (value, forbiddenRoots = []) => {
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

const emptyStatusSummary = () => ({
  observedAt: null,
  phase: null,
  state: null,
  currentTaskLabel: null,
  progress: { mode: 'none', done: null, total: null },
  assetTotal: null,
  batch: { mode: null, backend: null, completed: null, total: null, failed: null },
  warningCount: null
});

const enumOrNull = (value, allowed) => typeof value === 'string' && allowed.has(value) ? value : null;
const nonNegativeInteger = (value) => Number.isInteger(value) && value >= 0 ? value : null;
const safeObservedAt = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const safeSummaryLabel = (value) => typeof value === 'string' && value.trim()
  ? value.replace(/[\r\n\t]+/gu, ' ').trim().slice(0, 160)
  : null;

const deriveStatusSummary = (snapshot) => {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return emptyStatusSummary();
  const phase = enumOrNull(snapshot.pipeline?.phase, SUMMARY_PHASES);
  const state = enumOrNull(snapshot.pipeline?.state, SUMMARY_STATES);
  const stageId = phase === 'complete' || phase === 'waiting-generation' ? 'generation' : phase;
  const stage = Array.isArray(snapshot.pipeline?.stages)
    ? snapshot.pipeline.stages.find((candidate) => candidate?.id === stageId)
    : null;
  const requestedMode = enumOrNull(stage?.progress?.mode, SUMMARY_PROGRESS_MODES) || 'none';
  const done = nonNegativeInteger(stage?.progress?.done);
  const total = nonNegativeInteger(stage?.progress?.total);
  const validDeterminate = requestedMode === 'determinate' && done !== null && total !== null && done <= total;
  const progress = validDeterminate
    ? { mode: 'determinate', done, total }
    : { mode: requestedMode === 'indeterminate' ? 'indeterminate' : 'none', done: null, total: null };
  const countsKnown = snapshot.batch?.counts?.known === true;
  const assetTotal = snapshot.assetCounts?.known === true ? nonNegativeInteger(snapshot.assetCounts.total) : null;
  return {
    observedAt: safeObservedAt(snapshot.observedAt),
    phase,
    state,
    currentTaskLabel: safeSummaryLabel(snapshot.pipeline?.currentTask?.label),
    progress,
    assetTotal,
    batch: {
      mode: enumOrNull(snapshot.batch?.mode, SUMMARY_BATCH_MODES),
      backend: enumOrNull(snapshot.batch?.backend, SUMMARY_BACKENDS),
      completed: countsKnown ? nonNegativeInteger(snapshot.batch?.counts?.completed) : null,
      total: countsKnown ? nonNegativeInteger(snapshot.batch?.counts?.total) : null,
      failed: countsKnown ? nonNegativeInteger(snapshot.batch?.counts?.failed) : null
    },
    warningCount: Array.isArray(snapshot.warnings) ? snapshot.warnings.length : null
  };
};

const projectIdentity = ({ projectId, displayName, storageMode }) => ({ projectId, displayName, storageMode });
const sameCanonicalPath = (left, right) => process.platform === 'win32'
  ? String(left).toLowerCase() === String(right).toLowerCase()
  : left === right;

const parseRequestPathname = (requestUrl) => {
  const target = String(requestUrl || '');
  const rawPath = target.split(/[?#]/u, 1)[0];
  let decodedRaw;
  try {
    decodedRaw = decodeURIComponent(rawPath);
  } catch {
    throw new HttpError(400, 'INVALID_PATH', '请求路径编码无效');
  }
  if (decodedRaw.includes('\u0000') || decodedRaw.replace(/\\/gu, '/').split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new HttpError(400, 'INVALID_PATH', '请求路径不得包含点段或路径穿越');
  }
  try {
    return decodeURIComponent(new URL(target, 'http://localhost').pathname);
  } catch {
    throw new HttpError(400, 'INVALID_PATH', '请求路径编码无效');
  }
};

const makeCatalogSummary = (loaded) => ({
  styles: loaded.catalog.enums.styles.map((id) => ({
    id,
    label: loaded.catalog.legacyNames.styles[id]
  })),
  assets: loaded.catalog.enums.assets.map((id) => ({
    id,
    label: loaded.catalog.legacyNames.assets[id]
  })),
  modifierOperations: [...loaded.catalog.enums.modifierOperations],
  baseRoutes: loaded.builtinRoutes.routes.map((route) => ({
    id: route.id,
    when: { ...route.when },
    compose: [...route.compose]
  })),
  referenceModifiers: loaded.referenceModifiers.modifiers.map((modifier) => ({
    id: modifier.id,
    when: { ...modifier.when },
    fragment: modifier.fragment
  })),
  conditionModules: loaded.conditionModules.modules.map((module) => structuredClone(module))
});

const readJsonBody = async (request, maximumBytes = MAX_BODY_BYTES) => {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '请求必须使用 application/json');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new HttpError(413, 'BODY_TOO_LARGE', '请求体超过当前接口限制');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_JSON', '请求体不是有效 JSON');
  }
};

const requireEmptyBody = async (request) => {
  for await (const chunk of request) {
    if (chunk.length > 0) throw new HttpError(400, 'INVALID_REQUEST', '删除项目请求不接受请求体');
  }
};

const serviceHttpError = (error) => {
  if (error instanceof ReferenceImageStoreError
    || error instanceof BuiltinBatchServiceError
    || error instanceof PromptRegistryServiceError
    || error instanceof CodexImagegenHandoffError) {
    return new HttpError(error.status, error.code, error.message);
  }
  return error;
};

const canvasHttpError = (error) => {
  if (!(error instanceof IntinifyCanvasServiceError)) return error;
  const status = ['INVALID_BASE_URL', 'INSECURE_BASE_URL', 'INVALID_USERNAME', 'INVALID_PASSWORD']
    .includes(error.code) ? 400 : 502;
  return new HttpError(status, error.code, error.message);
};

const validateReferenceUploadLength = (request) => {
  const value = request.headers['content-length'];
  if (value === undefined) return;
  if (!/^\d+$/u.test(value)) throw new HttpError(400, 'INVALID_CONTENT_LENGTH', '参考图上传长度无效');
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size <= 0) throw new HttpError(400, 'EMPTY_REFERENCE_IMAGE', '参考图不能为空');
  if (size > MAX_REFERENCE_IMAGE_BYTES) throw new HttpError(413, 'REFERENCE_IMAGE_TOO_LARGE', '单张参考图不能超过 20 MiB');
};

const exactRequestKeys = (value, allowed, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_REQUEST', `${label} 必须是对象`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new HttpError(400, 'INVALID_REQUEST', `${label} 包含不允许的字段`);
  return value;
};

const workspaceHttpError = (error) => {
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

const decodeUploadFilename = (request) => {
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

const decodeOverwrite = (request) => {
  const value = request.headers['x-ka-overwrite'];
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new HttpError(400, 'INVALID_OVERWRITE_OPTION', '覆盖选项无效');
};

const validateUploadLength = (request) => {
  const value = request.headers['content-length'];
  if (value === undefined) return;
  if (!/^\d+$/u.test(value)) throw new HttpError(400, 'INVALID_CONTENT_LENGTH', '上传长度无效');
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size <= 0) throw new HttpError(400, 'EMPTY_SCREENPLAY', '剧本文件不能为空');
  if (size > MAX_SCREENPLAY_BYTES) throw new HttpError(413, 'SCREENPLAY_TOO_LARGE', '单个剧本不能超过 200 MiB');
};

const cleanString = (value, label, maxLength, { optional = false } = {}) => {
  if (optional && (value === undefined || value === null || value === '')) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'INVALID_REQUEST', `${label} 必须是非空字符串`);
  if (value.length > maxLength) throw new HttpError(400, 'INVALID_REQUEST', `${label} 超过 ${maxLength} 字符`);
  return value;
};

export function validateResolveInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_REQUEST', 'resolve 请求必须是对象');
  }
  const unknown = Object.keys(value).filter((key) => !RESOLVE_KEYS.has(key));
  if (unknown.length) throw new HttpError(400, 'INVALID_REQUEST', `不允许的字段：${unknown.join(', ')}`);
  const style = cleanString(value.style, 'style', 32);
  const asset = cleanString(value.asset, 'asset', 32);
  const referenceMode = value.referenceMode ?? 'none';
  const referenceCount = value.referenceCount ?? 0;
  if (!STYLE_INPUTS.has(style)) throw new HttpError(400, 'INVALID_REQUEST', 'style 不在允许范围内');
  if (!ASSET_INPUTS.has(asset)) throw new HttpError(400, 'INVALID_REQUEST', 'asset 不在允许范围内');
  if (!REFERENCE_MODES.has(referenceMode)) throw new HttpError(400, 'INVALID_REQUEST', 'referenceMode 不在允许范围内');
  if (!Number.isInteger(referenceCount) || referenceCount < 0 || referenceCount > 16) {
    throw new HttpError(400, 'INVALID_REQUEST', 'referenceCount 必须是 0 到 16 的整数');
  }
  if ((referenceMode === 'none' && referenceCount !== 0) || (referenceMode !== 'none' && referenceCount < 1)) {
    throw new HttpError(400, 'INVALID_REQUEST', 'referenceMode 与 referenceCount 不一致');
  }
  const productionNotes = value.productionNotes === undefined
    ? undefined : cleanString(value.productionNotes, 'productionNotes', 32767, { optional: true });
  return {
    style,
    asset,
    referenceMode,
    referenceCount,
    ...(productionNotes !== undefined ? { productionNotes } : {})
  };
}

const readProjectSnapshot = async (services, projectId) => {
  await services.ensureReady();
  const project = await services.projectIndex.resolveProject(projectId);
  try {
    const snapshot = redactForResponse(
      await services.getProjectReader(project).getSnapshot(),
      [services.installationRoot, project.rootPath]
    );
    const verified = await services.projectIndex.resolveProject(projectId);
    if (!sameCanonicalPath(verified.rootPath, project.rootPath) || verified.identity !== project.identity) {
      throw new HttpError(503, 'PROJECT_ROOT_CHANGED', '项目根在快照读取期间发生变化');
    }
    return { project: projectIdentity(project.metadata), snapshot };
  } catch (error) {
    if (error instanceof ProjectRootIndexError || error instanceof HttpError) throw error;
    throw new HttpError(503, 'PROJECT_SNAPSHOT_UNAVAILABLE', '项目快照暂时不可读取');
  }
};

const listProjectCards = async (services) => {
  await services.ensureReady();
  const metadata = await services.projectIndex.listProjects();
  const projects = await Promise.all(metadata.map(async (project) => {
    if (project.availability !== 'available') return { ...project, statusSummary: emptyStatusSummary() };
    try {
      const result = await readProjectSnapshot(services, project.projectId);
      return {
        ...project,
        availability: 'available',
        statusSummary: deriveStatusSummary(result.snapshot)
      };
    } catch {
      return { ...project, availability: 'unavailable', statusSummary: emptyStatusSummary() };
    }
  }));
  return { schemaVersion: PROJECT_INDEX_SCHEMA_VERSION, projects };
};

const routeContext = Object.freeze({
  API_ASPECT_RATIOS,
  API_IMAGE_SIZES,
  CodexSdkStatusError,
  HttpError,
  MAX_BATCH_BODY_BYTES,
  PendingAssetServiceError,
  PipelineTaskRunnerError,
  canvasHttpError,
  cleanString,
  constantTimeTextEqual,
  decodeOverwrite,
  decodeUploadFilename,
  exactRequestKeys,
  extname,
  getApiDefaultTemplates,
  isAbsolute,
  listProjectCards,
  lstat,
  makeCatalogFingerprint,
  makeCatalogSummary,
  mime,
  readFile,
  readJsonBody,
  readProjectSnapshot,
  realpath,
  redactForResponse,
  relative,
  requireEmptyBody,
  requireMethod,
  resolve,
  resolvePromptTemplate,
  sameCanonicalPath,
  sendJson,
  serviceHttpError,
  validateReferenceUploadLength,
  validateResolveInput,
  validateUploadLength,
  workspaceHttpError
});
const handleApi = createApiRouteHandler(routeContext);
const handleDesktop = createDesktopRouteHandler(routeContext);
const handleStatic = createStaticRouteHandler(routeContext);

export function createPrototypeServer(options = {}) {
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
  const desktopSecurity = Object.freeze({
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
  const resolvedStaticDirectory = resolve(
    options.staticDirectory
      ?? process.env.KA_PROMPT_STUDIO_STATIC_ROOT
      ?? builtRendererRoot
  );
  const softwareMode = options.softwareMode ?? !Object.hasOwn(options, 'installationRoot');
  const resolvedEngineRoot = resolve(options.engineRoot ?? options.packageRoot ?? defaultEngineRoot);
  const resolvedSkillsRoot = resolve(
    options.skillsRoot
      ?? (options.runtimeRoot ? resolve(options.runtimeRoot, 'skills') : defaultSkillsRoot)
  );
  const resolvedSoftwareRoot = resolve(options.softwareRoot ?? defaultSoftwareRoot);
  const softwareWorkspace = softwareMode
    ? createSoftwareWorkspace({ softwareRoot: resolvedSoftwareRoot, engineRoot: resolvedEngineRoot })
    : null;
  const resolvedInstallationRoot = softwareWorkspace
    ? softwareWorkspace.paths.workspaceRoot
    : resolve(options.installationRoot ?? resolvedEngineRoot);
  const ensureReady = softwareWorkspace
    ? () => softwareWorkspace.initialize()
    : async () => undefined;
  const projectIndex = createProjectRootIndex(resolvedInstallationRoot, { includeLegacy: !softwareWorkspace });
  const legacyWorkbenchReader = createWorkbenchSnapshotReader(resolvedInstallationRoot);
  const codexRuntimeConfigStore = options.codexRuntimeConfigStore ?? (softwareWorkspace
    ? createCodexRuntimeConfigStore({ softwareRoot: resolvedSoftwareRoot })
    : null);
  const projectReaders = new Map();
  const getProjectReader = (project) => {
    if (project.metadata.storageMode === 'legacy-root') return legacyWorkbenchReader;
    const cacheKey = `${project.metadata.storageMode}:${project.metadata.projectId}`;
    const cached = projectReaders.get(cacheKey);
    if (cached && cached.rootPath === project.rootPath && cached.identity === project.identity) return cached.reader;
    const reader = createWorkbenchSnapshotReader(project.rootPath);
    projectReaders.set(cacheKey, { rootPath: project.rootPath, identity: project.identity, reader });
    return reader;
  };
  const taskRunner = softwareWorkspace ? createPipelineTaskRunner({
    resolveProjectRoot: async (projectId) => (await projectIndex.resolveProject(projectId)).rootPath,
    materializeProjectRuntime: async ({ projectId }) => softwareWorkspace.materializeProjectRuntime(projectId),
    pipelineSkillPath: resolve(
      resolvedSkillsRoot,
      'ka-script-pipeline',
      'SKILL.md'
    ),
    ...(codexRuntimeConfigStore ? { readRuntimeConfig: codexRuntimeConfigStore.get } : {})
  }) : null;
  const codexAgentChatService = options.codexAgentChatService ?? createCodexAgentChatService({
    resolveProjectRoot: async (projectId) => (await projectIndex.resolveProject(projectId)).rootPath,
    ...(codexRuntimeConfigStore ? {
      readRuntimeConfig: codexRuntimeConfigStore.get,
      writeRuntimeConfig: codexRuntimeConfigStore.update
    } : {})
  });
  if (!codexAgentChatService
    || typeof codexAgentChatService.startMessage !== 'function'
    || typeof codexAgentChatService.getSession !== 'function'
    || typeof codexAgentChatService.cancelSession !== 'function'
    || typeof codexAgentChatService.getRuntimeConfig !== 'function'
    || typeof codexAgentChatService.updateRuntimeConfig !== 'function'
    || typeof codexAgentChatService.shutdown !== 'function') {
    throw new TypeError('codexAgentChatService must expose the complete chat contract');
  }
  const codexStatusService = options.codexStatusService ?? createCodexSdkStatusService();
  if (
    !codexStatusService
    || typeof codexStatusService.getStatus !== 'function'
    || typeof codexStatusService.startLogin !== 'function'
  ) {
    throw new TypeError('codexStatusService must expose getStatus and startLogin');
  }
  let catalogPromise = null;
  const getCatalog = async () => {
    await ensureReady();
    if (catalogPromise === null) {
      const catalogLocation = softwareWorkspace
        ? resolve(softwareWorkspace.paths.sharedAssetsRoot, '图片生成', 'prompts', 'catalog.json')
        : undefined;
      catalogPromise = (catalogLocation ? loadPromptCatalog(catalogLocation) : loadPromptCatalog())
        .catch((error) => {
          catalogPromise = null;
          throw error;
        });
    }
    return catalogPromise;
  };
  const invalidateCatalog = () => { catalogPromise = null; };
  let pipelineRuntimePromise = null;
  const getPipelineRuntime = async () => {
    if (pipelineRuntimePromise === null) {
      const runtimeLocation = resolve(resolvedEngineRoot, 'scripts', 'lib', 'pipeline_runtime.mjs');
      pipelineRuntimePromise = import(pathToFileURL(runtimeLocation).href);
    }
    return pipelineRuntimePromise;
  };
  const resolveProjectRoot = async (projectId) => (await projectIndex.resolveProject(projectId)).rootPath;
  const materializeProjectRuntime = async ({ projectId }) => softwareWorkspace.materializeProjectRuntime(projectId);
  const referenceStore = softwareWorkspace ? createReferenceImageStore({
    resolveProjectRoot,
    materializeProjectRuntime
  }) : null;
  const builtinBatchService = softwareWorkspace ? createBuiltinBatchService({
    resolveProjectRoot,
    materializeProjectRuntime,
    referenceStore,
    getCatalog,
    getPipelineRuntime,
    makeCatalogFingerprint,
    resolvePromptTemplate,
    compileLegacyDefinition
  }) : null;
  const promptRegistryService = softwareWorkspace ? createPromptRegistryService({
    sharedAssetsRoot: softwareWorkspace.paths.sharedAssetsRoot,
    getCatalog,
    invalidateCatalog,
    makeCatalogFingerprint,
    validatePromptCatalog
  }) : null;
  const imagegenHandoffService = softwareWorkspace ? createCodexImagegenHandoffService({
    resolveProjectRoot,
    builtinImagegenSkillPath: resolve(
      resolvedSkillsRoot,
      'ka-builtin-imagegen',
      'SKILL.md'
    ),
    softwareRoot: resolvedSkillsRoot
  }) : null;
  const pendingAssetService = softwareWorkspace ? createPendingAssetService({
    resolveProjectRoot,
    materializeProjectRuntime,
    withProjectIdle: taskRunner.withProjectIdle
  }) : null;
  const services = Object.freeze({
    installationRoot: resolvedInstallationRoot,
    engineRoot: resolvedEngineRoot,
    skillsRoot: resolvedSkillsRoot,
    staticDirectory: resolvedStaticDirectory,
    softwareWorkspace,
    projectIndex,
    taskRunner,
    codexAgentChatService,
    codexStatusService,
    referenceStore,
    builtinBatchService,
    promptRegistryService,
    imagegenHandoffService,
    pendingAssetService,
    legacyWorkbenchReader,
    getProjectReader,
    ensureReady,
    getCatalog
  });
  let shutdownRequested = false;
  const server = createServer(async (request, response) => {
    try {
      const remoteAddress = request.socket?.remoteAddress || '';
      if (!LOOPBACK_ADDRESSES.has(remoteAddress)) {
        throw new HttpError(403, 'LOCAL_ONLY', '本地服务只接受当前电脑的请求');
      }
      const pathname = parseRequestPathname(request.url);
      validateDesktopRequest(request, pathname, desktopSecurity);
      if (desktopMode && pathname === '/health') {
        requireMethod(request, 'GET');
        sendJson(response, 200, { ok: true, data: { status: 'ready', protocolVersion: 1 } });
      } else if (desktopMode && pathname === '/shutdown') {
        requireMethod(request, 'POST');
        if (shutdownRequested) throw new HttpError(409, 'SHUTDOWN_ALREADY_REQUESTED', '桌面服务已收到退出请求');
        shutdownRequested = true;
        response.once('finish', () => {
          void Promise.allSettled([
            Promise.resolve(services.taskRunner?.shutdown()),
            Promise.resolve(services.codexAgentChatService.shutdown())
          ]).finally(() => {
            server.close(() => {
              Promise.resolve(options.onShutdown?.()).catch(() => undefined);
            });
            server.closeIdleConnections?.();
          });
        });
        sendJson(response, 202, { ok: true, data: { shuttingDown: true } }, { connection: 'close' });
      } else if (desktopMode && pathname.startsWith('/desktop/')) {
        await handleDesktop(request, response, pathname, services, desktopSecurity);
      } else if (pathname.startsWith('/api/')) await handleApi(request, response, pathname, services);
      else await handleStatic(request, response, pathname, services.staticDirectory);
    } catch (error) {
      const expected = error instanceof HttpError
        || error instanceof ProjectRootIndexError
        || error instanceof PipelineTaskRunnerError
        || error instanceof CodexAgentChatError
        || error instanceof CodexRuntimeConfigError;
      const status = expected ? error.status : 500;
      const code = expected ? error.code : 'INTERNAL_SERVER_ERROR';
      const message = expected ? error.message : '服务暂时无法处理请求';
      sendJson(
        response,
        status,
        { ok: false, error: { code, message } },
        status === 405 && error.allow ? { allow: error.allow } : {}
      );
    }
  });
  Object.defineProperty(server, 'shutdownTasks', {
    value: () => Promise.allSettled([
      Promise.resolve(services.taskRunner?.shutdown()),
      Promise.resolve(services.codexAgentChatService.shutdown())
    ]),
    enumerable: false
  });
  return server;
}

const isMain = typeof process !== 'undefined' && Array.isArray(process.argv)
  && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number.parseInt(process.env.KA_PROMPT_STUDIO_PORT ?? '4173', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('KA_PROMPT_STUDIO_PORT 必须是 1 到 65535 的整数');
  }
  createPrototypeServer().listen(port, '127.0.0.1', () => {
    console.log(`KA Asset Batch prototype: http://127.0.0.1:${port}`);
  });
}
