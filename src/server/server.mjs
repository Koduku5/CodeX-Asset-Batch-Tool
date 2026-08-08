// Local application server composition root.
import { createServer } from 'node:http';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getApiDefaultTemplates,
  makeCatalogFingerprint,
  resolvePromptTemplate
} from '../../engine/scripts/lib/prompt_catalog.mjs';
import { CodexAgentChatError } from './codex-agent-chat-service.mjs';
import { CodexRuntimeConfigError } from './codex-runtime-config.mjs';
import { CodexSdkStatusError } from './codex-sdk-status.mjs';
import { PendingAssetServiceError } from './pending-asset-service.mjs';
import { PipelineTaskRunnerError } from './pipeline-task-runner.mjs';
import {
  PROJECT_INDEX_SCHEMA_VERSION,
  ProjectRootIndexError
} from './project-root-index.mjs';
import { createApiRouteHandler } from './routes/api-routes.mjs';
import { createDesktopRouteHandler } from './routes/desktop-routes.mjs';
import { createStaticRouteHandler } from './routes/static-route.mjs';
import {
  API_ASPECT_RATIOS,
  API_IMAGE_SIZES,
  HttpError,
  MAX_BATCH_BODY_BYTES,
  canvasHttpError,
  cleanString,
  constantTimeTextEqual,
  createDesktopSecurity,
  decodeOverwrite,
  decodeUploadFilename,
  exactRequestKeys,
  mime,
  parseRequestPathname,
  readJsonBody,
  redactForResponse,
  requireEmptyBody,
  requireLoopbackRequest,
  requireMethod,
  sendJson,
  serviceHttpError,
  validateDesktopRequest,
  validateReferenceUploadLength,
  validateResolveInput,
  validateUploadLength,
  workspaceHttpError
} from './server-http.mjs';
import { createServerServices } from './server-services.mjs';

export { validateResolveInput } from './server-http.mjs';

const SUMMARY_PROGRESS_MODES = new Set(['none', 'indeterminate', 'determinate']);
const SUMMARY_PHASES = new Set([
  'split', 'analysis', 'world-overview', 'asset-visual-specs', 'excel', 'generation',
  'complete', 'waiting-generation'
]);
const SUMMARY_STATES = new Set(['active', 'complete', 'waiting', 'warning', 'idle']);
const SUMMARY_BATCH_MODES = new Set(['none', 'idle', 'active', 'complete', 'warning']);
const SUMMARY_BACKENDS = new Set(['none', 'builtin', 'api', 'multiple', 'unknown']);

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

const enumOrNull = (value, allowed) => (
  typeof value === 'string' && allowed.has(value) ? value : null
);
const nonNegativeInteger = (value) => Number.isInteger(value) && value >= 0 ? value : null;
const safeObservedAt = (value) => (
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
);
const safeSummaryLabel = (value) => typeof value === 'string' && value.trim()
  ? value.replace(/[\r\n\t]+/gu, ' ').trim().slice(0, 160)
  : null;

const deriveStatusSummary = (snapshot) => {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return emptyStatusSummary();
  }
  const phase = enumOrNull(snapshot.pipeline?.phase, SUMMARY_PHASES);
  const state = enumOrNull(snapshot.pipeline?.state, SUMMARY_STATES);
  const stageId = phase === 'complete' || phase === 'waiting-generation' ? 'generation' : phase;
  const stage = Array.isArray(snapshot.pipeline?.stages)
    ? snapshot.pipeline.stages.find((candidate) => candidate?.id === stageId)
    : null;
  const requestedMode = enumOrNull(stage?.progress?.mode, SUMMARY_PROGRESS_MODES) || 'none';
  const done = nonNegativeInteger(stage?.progress?.done);
  const total = nonNegativeInteger(stage?.progress?.total);
  const validDeterminate = requestedMode === 'determinate'
    && done !== null
    && total !== null
    && done <= total;
  const progress = validDeterminate
    ? { mode: 'determinate', done, total }
    : {
        mode: requestedMode === 'indeterminate' ? 'indeterminate' : 'none',
        done: null,
        total: null
      };
  const countsKnown = snapshot.batch?.counts?.known === true;
  const assetTotal = snapshot.assetCounts?.known === true
    ? nonNegativeInteger(snapshot.assetCounts.total)
    : null;
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

const projectIdentity = ({ projectId, displayName, storageMode }) => ({
  projectId,
  displayName,
  storageMode
});
const sameCanonicalPath = (left, right) => process.platform === 'win32'
  ? String(left).toLowerCase() === String(right).toLowerCase()
  : left === right;

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

const readProjectSnapshot = async (services, projectId) => {
  await services.ensureReady();
  const project = await services.projectIndex.resolveProject(projectId);
  try {
    const snapshot = redactForResponse(
      await services.getProjectReader(project).getSnapshot(),
      [services.installationRoot, project.rootPath]
    );
    const verified = await services.projectIndex.resolveProject(projectId);
    if (!sameCanonicalPath(verified.rootPath, project.rootPath)
      || verified.identity !== project.identity) {
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
    if (project.availability !== 'available') {
      return { ...project, statusSummary: emptyStatusSummary() };
    }
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

export function createApplicationServer(options = {}) {
  const desktopSecurity = createDesktopSecurity(options);
  const { desktopMode } = desktopSecurity;
  const services = createServerServices(options);
  let shutdownRequested = false;
  const server = createServer(async (request, response) => {
    try {
      requireLoopbackRequest(request);
      const pathname = parseRequestPathname(request.url);
      validateDesktopRequest(request, pathname, desktopSecurity);
      if (desktopMode && pathname === '/health') {
        requireMethod(request, 'GET');
        sendJson(response, 200, { ok: true, data: { status: 'ready', protocolVersion: 1 } });
      } else if (desktopMode && pathname === '/shutdown') {
        requireMethod(request, 'POST');
        if (shutdownRequested) {
          throw new HttpError(409, 'SHUTDOWN_ALREADY_REQUESTED', '桌面服务已收到退出请求');
        }
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
        sendJson(
          response,
          202,
          { ok: true, data: { shuttingDown: true } },
          { connection: 'close' }
        );
      } else if (desktopMode && pathname.startsWith('/desktop/')) {
        await handleDesktop(request, response, pathname, services, desktopSecurity);
      } else if (pathname.startsWith('/api/')) {
        await handleApi(request, response, pathname, services);
      } else {
        await handleStatic(request, response, pathname, services.staticDirectory);
      }
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

// Backward-compatible export for existing integrations.
export const createPrototypeServer = createApplicationServer;

const isMain = typeof process !== 'undefined'
  && Array.isArray(process.argv)
  && process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number.parseInt(process.env.KA_PROMPT_STUDIO_PORT ?? '4173', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('KA_PROMPT_STUDIO_PORT 必须是 1 到 65535 的整数');
  }
  createApplicationServer().listen(port, '127.0.0.1', () => {
    console.log(`KA Asset Batch: http://127.0.0.1:${port}`);
  });
}
