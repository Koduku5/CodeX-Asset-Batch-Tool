import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  compileLegacyDefinition,
  loadPromptCatalog,
  makeCatalogFingerprint,
  resolvePromptTemplate,
  validatePromptCatalog
} from '../../engine/scripts/lib/prompt_catalog.mjs';
import { createBuiltinBatchService } from './builtin-batch-service.mjs';
import { createCodexAgentChatService } from './codex-agent-chat-service.mjs';
import { createCodexImagegenHandoffService } from './codex-imagegen-handoff.mjs';
import { createCodexRuntimeConfigStore } from './codex-runtime-config.mjs';
import { createCodexSdkStatusService } from './codex-sdk-status.mjs';
import { createPendingAssetService } from './pending-asset-service.mjs';
import { createPipelineTaskRunner } from './pipeline-task-runner.mjs';
import { createProjectRootIndex } from './project-root-index.mjs';
import { createPromptRegistryService } from './prompt-registry-service.mjs';
import { createReferenceImageStore } from './reference-image-store.mjs';
import { createSoftwareWorkspace } from './software-workspace.mjs';
import { createStageTimingService } from './stage-timing-service.mjs';
import { createWorkbenchSnapshotReader } from './workbench-snapshot.mjs';

const serverRoot = fileURLToPath(new URL('.', import.meta.url));
const applicationRoot = resolve(serverRoot, '../..');
const builtRendererRoot = resolve(applicationRoot, 'dist/renderer');
const defaultEngineRoot = resolve(applicationRoot, 'engine');
const defaultSkillsRoot = resolve(applicationRoot, 'skills');
const defaultSoftwareRoot = resolve(applicationRoot, '.local');

const requireChatContract = (service) => {
  if (!service
    || typeof service.startMessage !== 'function'
    || typeof service.getSession !== 'function'
    || typeof service.cancelSession !== 'function'
    || typeof service.getRuntimeConfig !== 'function'
    || typeof service.updateRuntimeConfig !== 'function'
    || typeof service.shutdown !== 'function') {
    throw new TypeError('codexAgentChatService must expose the complete chat contract');
  }
  return service;
};

const requireStatusContract = (service) => {
  if (!service
    || typeof service.getStatus !== 'function'
    || typeof service.startLogin !== 'function') {
    throw new TypeError('codexStatusService must expose getStatus and startLogin');
  }
  return service;
};

export const createServerServices = (options = {}) => {
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
    if (cached && cached.rootPath === project.rootPath && cached.identity === project.identity) {
      return cached.reader;
    }
    const reader = createWorkbenchSnapshotReader(project.rootPath);
    projectReaders.set(cacheKey, { rootPath: project.rootPath, identity: project.identity, reader });
    return reader;
  };
  const taskRunner = softwareWorkspace ? createPipelineTaskRunner({
    resolveProjectRoot: async (projectId) => (await projectIndex.resolveProject(projectId)).rootPath,
    materializeProjectRuntime: async ({ projectId }) => softwareWorkspace.materializeProjectRuntime(projectId),
    pipelineSkillPath: resolve(resolvedSkillsRoot, 'ka-script-pipeline', 'SKILL.md'),
    ...(codexRuntimeConfigStore ? { readRuntimeConfig: codexRuntimeConfigStore.get } : {})
  }) : null;
  const codexAgentChatService = requireChatContract(
    options.codexAgentChatService ?? createCodexAgentChatService({
      resolveProjectRoot: async (projectId) => (await projectIndex.resolveProject(projectId)).rootPath,
      ...(codexRuntimeConfigStore ? {
        readRuntimeConfig: codexRuntimeConfigStore.get,
        writeRuntimeConfig: codexRuntimeConfigStore.update
      } : {})
    })
  );
  const codexStatusService = requireStatusContract(
    options.codexStatusService ?? createCodexSdkStatusService()
  );
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
    builtinImagegenSkillPath: resolve(resolvedSkillsRoot, 'ka-builtin-imagegen', 'SKILL.md'),
    softwareRoot: resolvedSkillsRoot
  }) : null;
  const pendingAssetService = softwareWorkspace ? createPendingAssetService({
    resolveProjectRoot,
    materializeProjectRuntime,
    withProjectIdle: taskRunner.withProjectIdle
  }) : null;
  const stageTimingService = softwareWorkspace ? createStageTimingService({ resolveProjectRoot }) : null;

  return Object.freeze({
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
    stageTimingService,
    legacyWorkbenchReader,
    getProjectReader,
    ensureReady,
    getCatalog
  });
};
