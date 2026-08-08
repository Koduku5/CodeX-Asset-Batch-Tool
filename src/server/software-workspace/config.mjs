import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_SCREENPLAY_BYTES, assertPositiveInteger, fail } from './contracts.mjs';
import { samePath } from './path-safety.mjs';
import { SHARED_ASSETS_MANIFEST_FILENAME } from './shared-assets.mjs';

const MODULE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const APPLICATION_ROOT = resolve(MODULE_ROOT, '../..');
const DEFAULT_SOFTWARE_ROOT = resolve(APPLICATION_ROOT, '.local');
const DEFAULT_ENGINE_ROOT = resolve(APPLICATION_ROOT, 'engine');
const DEFAULT_MAX_PROJECTS = 128;
const DEFAULT_MAX_DISPLAY_NAME_LENGTH = 80;
const DEFAULT_MAX_RUNTIME_FILES = 50_000;
const DEFAULT_MAX_RUNTIME_BYTES = 2 * 1024 * 1024 * 1024;

export const resolveSoftwareWorkspaceConfig = ({
  softwareRoot = DEFAULT_SOFTWARE_ROOT,
  engineRoot,
  packageRoot,
  maxProjects = DEFAULT_MAX_PROJECTS,
  maxDisplayNameLength = DEFAULT_MAX_DISPLAY_NAME_LENGTH,
  maxScreenplayBytes = MAX_SCREENPLAY_BYTES,
  maxRuntimeFiles = DEFAULT_MAX_RUNTIME_FILES,
  maxRuntimeBytes = DEFAULT_MAX_RUNTIME_BYTES,
  clock = () => new Date()
} = {}) => {
  const configuredEngineRoot = engineRoot ?? packageRoot ?? DEFAULT_ENGINE_ROOT;
  if (!isAbsolute(softwareRoot) || !isAbsolute(configuredEngineRoot)) {
    fail('INVALID_ROOT', 'softwareRoot 和 engineRoot 必须是绝对路径');
  }
  const resolvedSoftwareRoot = resolve(softwareRoot);
  const resolvedEngineRoot = resolve(configuredEngineRoot);
  if (samePath(resolvedSoftwareRoot, resolvedEngineRoot)) {
    fail('INVALID_ROOT', '软件数据目录不能与只读执行引擎目录相同');
  }
  if (typeof clock !== 'function') fail('INVALID_OPTION', 'clock 必须是函数');
  const workspaceRoot = join(resolvedSoftwareRoot, 'workspace');
  const projectsRoot = join(workspaceRoot, 'projects');
  const sharedAssetsRoot = join(workspaceRoot, 'shared-assets');
  return Object.freeze({
    softwareRoot: resolvedSoftwareRoot,
    engineRoot: resolvedEngineRoot,
    maxProjects: assertPositiveInteger(maxProjects, 'maxProjects', 10_000),
    maxDisplayNameLength: assertPositiveInteger(maxDisplayNameLength, 'maxDisplayNameLength', 200),
    maxScreenplayBytes: assertPositiveInteger(
      maxScreenplayBytes,
      'maxScreenplayBytes',
      MAX_SCREENPLAY_BYTES
    ),
    maxRuntimeFiles: assertPositiveInteger(maxRuntimeFiles, 'maxRuntimeFiles', 1_000_000),
    maxRuntimeBytes: assertPositiveInteger(
      maxRuntimeBytes,
      'maxRuntimeBytes',
      16 * 1024 * 1024 * 1024
    ),
    clock,
    workspaceRoot,
    projectsRoot,
    sharedAssetsRoot,
    sharedAssetsManifestPath: join(workspaceRoot, SHARED_ASSETS_MANIFEST_FILENAME),
    paths: Object.freeze({
      softwareRoot: resolvedSoftwareRoot,
      engineRoot: resolvedEngineRoot,
      workspaceRoot,
      projectsRoot,
      sharedAssetsRoot
    })
  });
};
