import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  MAX_SCREENPLAY_BYTES,
  PROJECT_ID_PATTERN,
  SOFTWARE_WORKSPACE_SCHEMA_VERSION,
  SoftwareWorkspaceError,
  assertPositiveInteger,
  fail,
  projectIdFromDisplayName,
  sanitizeScreenplayFilename,
  validateDisplayName,
  validateProjectId
} from './software-workspace/contracts.mjs';
import {
  assertPathInside,
  assertPlainExistingEntry,
  assertSafeTargetChain,
  lstatOrNull,
  samePath
} from './software-workspace/path-safety.mjs';
import {
  SHARED_ASSETS_MANIFEST_FILENAME,
  buildTreeManifest,
  copySafeTree,
  makeLegacyPromptCatalogManifest,
  readTreeManifest,
  sameTreeManifest,
  validateSourceTree,
  writeTreeManifest
} from './software-workspace/shared-assets.mjs';

export {
  MAX_SCREENPLAY_BYTES,
  PROJECT_ID_PATTERN,
  SOFTWARE_WORKSPACE_SCHEMA_VERSION,
  SoftwareWorkspaceError,
  projectIdFromDisplayName,
  sanitizeScreenplayFilename
};

const MODULE_ROOT = dirname(fileURLToPath(import.meta.url));
const APPLICATION_ROOT = resolve(MODULE_ROOT, '../..');
const DEFAULT_SOFTWARE_ROOT = resolve(APPLICATION_ROOT, '.local');
const DEFAULT_ENGINE_ROOT = resolve(APPLICATION_ROOT, 'engine');
const DEFAULT_MAX_PROJECTS = 128;
const DEFAULT_MAX_DISPLAY_NAME_LENGTH = 80;
const DEFAULT_MAX_RUNTIME_FILES = 50_000;
const DEFAULT_MAX_RUNTIME_BYTES = 2 * 1024 * 1024 * 1024;
const readProjectMetadata = async (projectRoot, expectedProjectId, maximumDisplayNameLength) => {
  const metadataPath = join(projectRoot, 'project.json');
  await assertPlainExistingEntry(metadataPath, `项目 ${expectedProjectId} 的 project.json`, 'file');
  let value;
  try {
    value = JSON.parse(await readFile(metadataPath, 'utf8'));
  } catch (error) {
    fail('INVALID_PROJECT_METADATA', `项目 ${expectedProjectId} 的 project.json 无法读取`, error);
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.schemaVersion !== SOFTWARE_WORKSPACE_SCHEMA_VERSION ||
    value.projectId !== expectedProjectId ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    fail('INVALID_PROJECT_METADATA', `项目 ${expectedProjectId} 的 project.json 字段无效`);
  }
  const displayName = validateDisplayName(value.displayName, maximumDisplayNameLength);
  return {
    metadata: {
      schemaVersion: SOFTWARE_WORKSPACE_SCHEMA_VERSION,
      projectId: expectedProjectId,
      displayName,
      createdAt: value.createdAt
    },
    document: value
  };
};

const writeProjectMetadataAtomically = async (softwareRoot, projectRoot, metadata) => {
  const metadataPath = join(projectRoot, 'project.json');
  const stagePath = join(projectRoot, `.project-${randomUUID()}.json`);
  assertPathInside(softwareRoot, metadataPath, `项目 ${metadata.projectId} 的 project.json`);
  assertPathInside(softwareRoot, stagePath, `项目 ${metadata.projectId} 的 project.json 临时文件`);
  await assertSafeTargetChain(softwareRoot, projectRoot, `项目 ${metadata.projectId}`);
  await assertPlainExistingEntry(metadataPath, `项目 ${metadata.projectId} 的 project.json`, 'file');
  try {
    await writeFile(stagePath, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
    await assertSafeTargetChain(softwareRoot, projectRoot, `项目 ${metadata.projectId}`);
    await assertPlainExistingEntry(metadataPath, `项目 ${metadata.projectId} 的 project.json`, 'file');
    await rename(stagePath, metadataPath);
  } finally {
    await rm(stagePath, { force: true }).catch(() => {});
  }
};

const assertTreeHasNoReparsePoints = async (root, label, depth = 0) => {
  if (depth > 64) fail('PROJECT_TREE_TOO_DEEP', `${label} 的目录层级超过限制`);
  const info = await assertPlainExistingEntry(root, label);
  if (info.isFile()) return;
  if (!info.isDirectory()) fail('UNSAFE_PROJECT_ENTRY', `${label} 只能包含普通文件和目录`);
  const entries = await readdir(root);
  entries.sort((left, right) => left.localeCompare(right));
  for (const entry of entries) {
    await assertTreeHasNoReparsePoints(join(root, entry), `${label}/${entry}`, depth + 1);
  }
};

const toPublicProject = (metadata, projectRoot) => Object.freeze({
  ...metadata,
  projectRoot,
  screenplayRoot: join(projectRoot, '剧本'),
  cacheRoot: join(projectRoot, 'cache'),
  outputRoot: join(projectRoot, '输出')
});

const writeAll = async (handle, bytes) => {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (!bytesWritten) fail('UPLOAD_WRITE_FAILED', '剧本临时文件写入中断');
    offset += bytesWritten;
  }
};

const toAsyncIterable = (stream) => {
  if (stream && typeof stream[Symbol.asyncIterator] === 'function') return stream;
  if (stream && typeof stream.getReader === 'function') return Readable.fromWeb(stream);
  fail('INVALID_UPLOAD_BODY', 'stream 必须是可读取的数据流');
};

export class SoftwareWorkspace {
  #initializePromise = null;
  #projectMutations = new Set();

  constructor({
    softwareRoot = DEFAULT_SOFTWARE_ROOT,
    engineRoot,
    packageRoot,
    maxProjects = DEFAULT_MAX_PROJECTS,
    maxDisplayNameLength = DEFAULT_MAX_DISPLAY_NAME_LENGTH,
    maxScreenplayBytes = MAX_SCREENPLAY_BYTES,
    maxRuntimeFiles = DEFAULT_MAX_RUNTIME_FILES,
    maxRuntimeBytes = DEFAULT_MAX_RUNTIME_BYTES,
    clock = () => new Date()
  } = {}) {
    const configuredEngineRoot = engineRoot ?? packageRoot ?? DEFAULT_ENGINE_ROOT;
    if (!isAbsolute(softwareRoot) || !isAbsolute(configuredEngineRoot)) {
      fail('INVALID_ROOT', 'softwareRoot 和 engineRoot 必须是绝对路径');
    }
    this.softwareRoot = resolve(softwareRoot);
    this.engineRoot = resolve(configuredEngineRoot);
    if (samePath(this.softwareRoot, this.engineRoot)) {
      fail('INVALID_ROOT', '软件数据目录不能与只读执行引擎目录相同');
    }
    this.maxProjects = assertPositiveInteger(maxProjects, 'maxProjects', 10_000);
    this.maxDisplayNameLength = assertPositiveInteger(maxDisplayNameLength, 'maxDisplayNameLength', 200);
    this.maxScreenplayBytes = assertPositiveInteger(maxScreenplayBytes, 'maxScreenplayBytes', MAX_SCREENPLAY_BYTES);
    this.maxRuntimeFiles = assertPositiveInteger(maxRuntimeFiles, 'maxRuntimeFiles', 1_000_000);
    this.maxRuntimeBytes = assertPositiveInteger(maxRuntimeBytes, 'maxRuntimeBytes', 16 * 1024 * 1024 * 1024);
    if (typeof clock !== 'function') fail('INVALID_OPTION', 'clock 必须是函数');
    this.clock = clock;

    this.workspaceRoot = join(this.softwareRoot, 'workspace');
    this.projectsRoot = join(this.workspaceRoot, 'projects');
    this.sharedAssetsRoot = join(this.workspaceRoot, 'shared-assets');
    this.sharedAssetsManifestPath = join(this.workspaceRoot, SHARED_ASSETS_MANIFEST_FILENAME);
    this.paths = Object.freeze({
      softwareRoot: this.softwareRoot,
      engineRoot: this.engineRoot,
      workspaceRoot: this.workspaceRoot,
      projectsRoot: this.projectsRoot,
      sharedAssetsRoot: this.sharedAssetsRoot
    });
  }

  async initialize() {
    if (this.#initializePromise === null) {
      this.#initializePromise = this.#initialize().catch((error) => {
        this.#initializePromise = null;
        throw error;
      });
    }
    return this.#initializePromise;
  }

  async #initialize() {
    await mkdir(this.softwareRoot, { recursive: true });
    await assertPlainExistingEntry(this.softwareRoot, 'softwareRoot', 'directory');
    await assertPlainExistingEntry(this.engineRoot, 'engineRoot', 'directory');
    const [realSoftwareRoot, realEngineRoot] = await Promise.all([
      realpath(this.softwareRoot),
      realpath(this.engineRoot)
    ]);
    if (samePath(realSoftwareRoot, realEngineRoot)) {
      fail('INVALID_ROOT', '软件数据目录不能与只读执行引擎目录指向同一位置');
    }
    await assertSafeTargetChain(this.softwareRoot, this.workspaceRoot, 'workspaceRoot');
    await mkdir(this.workspaceRoot, { recursive: true });
    await assertSafeTargetChain(this.softwareRoot, this.workspaceRoot, 'workspaceRoot');
    await assertSafeTargetChain(this.softwareRoot, this.projectsRoot, 'projectsRoot');
    await mkdir(this.projectsRoot, { recursive: true });
    await assertSafeTargetChain(this.softwareRoot, this.projectsRoot, 'projectsRoot');

    const engineAssetsRoot = join(this.engineRoot, 'assets');
    const engineAssetsManifest = await buildTreeManifest(engineAssetsRoot, 'engineRoot/assets', {
      files: 0,
      bytes: 0,
      maxFiles: this.maxRuntimeFiles,
      maxBytes: this.maxRuntimeBytes
    });
    const sharedAssetsInfo = await lstatOrNull(this.sharedAssetsRoot);
    if (sharedAssetsInfo === null) {
      const stagingRoot = join(this.workspaceRoot, `.shared-assets-${randomUUID()}`);
      assertPathInside(this.softwareRoot, stagingRoot, 'shared-assets 临时目录');
      try {
        await copySafeTree(engineAssetsRoot, stagingRoot, 'engineRoot/assets', {
          files: 0,
          bytes: 0,
          maxFiles: this.maxRuntimeFiles,
          maxBytes: this.maxRuntimeBytes
        });
        const stagingManifest = await buildTreeManifest(stagingRoot, 'shared-assets 临时目录', {
          files: 0,
          bytes: 0,
          maxFiles: this.maxRuntimeFiles,
          maxBytes: this.maxRuntimeBytes
        });
        if (!sameTreeManifest(stagingManifest, engineAssetsManifest)) {
          fail('SOURCE_CHANGED_DURING_COPY', 'engineRoot/assets 在复制期间发生变化');
        }
        try {
          await rename(stagingRoot, this.sharedAssetsRoot);
        } catch (error) {
          if ((error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') && await lstatOrNull(this.sharedAssetsRoot)) {
            // Another initializer completed the same first-run snapshot.
          } else {
            throw error;
          }
        }
      } finally {
        if (await lstatOrNull(stagingRoot)) await rm(stagingRoot, { recursive: true, force: true });
      }
    }
    await assertSafeTargetChain(this.softwareRoot, this.sharedAssetsRoot, 'sharedAssetsRoot');
    const sharedAssetsManifest = await buildTreeManifest(this.sharedAssetsRoot, 'sharedAssetsRoot', {
      files: 0,
      bytes: 0,
      maxFiles: this.maxRuntimeFiles,
      maxBytes: this.maxRuntimeBytes
    });
    const recordedManifest = await readTreeManifest(this.sharedAssetsManifestPath);
    if (sameTreeManifest(sharedAssetsManifest, engineAssetsManifest)) {
      if (!sameTreeManifest(recordedManifest, engineAssetsManifest)) {
        await writeTreeManifest(this.softwareRoot, this.sharedAssetsManifestPath, engineAssetsManifest);
      }
      return this.paths;
    }

    let safeSourceManifest = null;
    if (recordedManifest && sameTreeManifest(sharedAssetsManifest, recordedManifest)) {
      safeSourceManifest = recordedManifest;
    } else if (recordedManifest === null) {
      const legacyManifest = await makeLegacyPromptCatalogManifest(engineAssetsRoot, engineAssetsManifest);
      if (sameTreeManifest(sharedAssetsManifest, legacyManifest)) safeSourceManifest = legacyManifest;
    }
    if (safeSourceManifest) {
      const upgraded = await this.#replaceDirectory(engineAssetsRoot, this.sharedAssetsRoot, 'sharedAssetsRoot', {
        expectedTargetManifest: safeSourceManifest,
        sourceManifest: engineAssetsManifest
      });
      if (upgraded) {
        await writeTreeManifest(this.softwareRoot, this.sharedAssetsManifestPath, engineAssetsManifest);
      }
    }
    return this.paths;
  }

  #projectRoot(projectId) {
    validateProjectId(projectId);
    const projectRoot = join(this.projectsRoot, projectId);
    assertPathInside(this.softwareRoot, projectRoot, `项目 ${projectId}`);
    return projectRoot;
  }

  async #canonicalProjectRoot(projectId, projectRoot) {
    await assertSafeTargetChain(this.softwareRoot, this.projectsRoot, 'projectsRoot');
    await assertSafeTargetChain(this.softwareRoot, projectRoot, `项目 ${projectId}`);
    const [canonicalSoftwareRoot, canonicalProjectsRoot, canonicalProjectRoot] = await Promise.all([
      realpath(this.softwareRoot),
      realpath(this.projectsRoot),
      realpath(projectRoot)
    ]);
    if (
      !samePath(canonicalProjectsRoot, join(canonicalSoftwareRoot, 'workspace', 'projects'))
      || !samePath(canonicalProjectRoot, join(canonicalProjectsRoot, projectId))
    ) {
      fail('PATH_OUTSIDE_SOFTWARE_ROOT', `项目 ${projectId} 未指向隔离项目目录`);
    }
    return { canonicalProjectsRoot, canonicalProjectRoot };
  }

  async #withProjectMutation(projectId, operation) {
    if (this.#projectMutations.has(projectId)) {
      fail('PROJECT_MUTATION_BUSY', `项目 ${projectId} 正在执行其他项目操作`);
    }
    this.#projectMutations.add(projectId);
    try {
      return await operation();
    } finally {
      this.#projectMutations.delete(projectId);
    }
  }

  async #scanProjectIds() {
    await this.initialize();
    const entries = await readdir(this.projectsRoot, { withFileTypes: true });
    const projectIds = [];
    for (const entry of entries) {
      const entryPath = join(this.projectsRoot, entry.name);
      const info = await lstat(entryPath);
      if (info.isSymbolicLink()) fail('UNSAFE_REPARSE_POINT', 'projects 目录中含有符号链接或目录联接');
      if (!PROJECT_ID_PATTERN.test(entry.name)) {
        if (entry.name.startsWith('.')) continue;
        fail('INVALID_PROJECT_DIRECTORY', `projects 目录中含有未知条目：${entry.name}`);
      }
      if (!entry.isDirectory() || !info.isDirectory()) fail('INVALID_PROJECT_DIRECTORY', `${entry.name} 不是项目目录`);
      await assertSafeTargetChain(this.softwareRoot, entryPath, `项目 ${entry.name}`);
      projectIds.push(entry.name);
    }
    return projectIds.sort((left, right) => left.localeCompare(right));
  }

  async listProjects() {
    const projectIds = await this.#scanProjectIds();
    const projects = [];
    for (const projectId of projectIds) projects.push(await this.getProject(projectId));
    return projects;
  }

  async getProject(projectId) {
    const projectRoot = this.#projectRoot(projectId);
    await this.initialize();
    await assertSafeTargetChain(this.softwareRoot, projectRoot, `项目 ${projectId}`);
    await assertPlainExistingEntry(projectRoot, `项目 ${projectId}`, 'directory');
    const { metadata } = await readProjectMetadata(projectRoot, projectId, this.maxDisplayNameLength);
    for (const directoryName of ['剧本', 'cache', '输出']) {
      await assertPlainExistingEntry(join(projectRoot, directoryName), `项目 ${projectId}/${directoryName}`, 'directory');
    }
    return toPublicProject(metadata, projectRoot);
  }

  async createProject(displayName) {
    const normalizedName = validateDisplayName(displayName, this.maxDisplayNameLength);
    await this.initialize();
    const projectId = projectIdFromDisplayName(normalizedName);
    if (this.#projectMutations.has(projectId)) fail('PROJECT_MUTATION_BUSY', `项目 ${projectId} 正在执行其他项目操作`);
    const projectRoot = this.#projectRoot(projectId);
    const projectIds = await this.#scanProjectIds();
    if (projectIds.includes(projectId) || await lstatOrNull(projectRoot)) {
      fail('PROJECT_EXISTS', `项目“${normalizedName}”已经存在`);
    }
    if (projectIds.length >= this.maxProjects) fail('PROJECT_LIMIT_REACHED', `项目数量不能超过 ${this.maxProjects}`);

    const stagingRoot = join(this.projectsRoot, `.creating-${projectId}-${randomUUID()}`);
    assertPathInside(this.softwareRoot, stagingRoot, '项目临时目录');
    const createdAt = this.clock().toISOString();
    const metadata = {
      schemaVersion: SOFTWARE_WORKSPACE_SCHEMA_VERSION,
      projectId,
      displayName: normalizedName,
      createdAt
    };
    try {
      await mkdir(stagingRoot, { recursive: false });
      for (const directoryName of ['剧本', 'cache', '输出']) {
        await mkdir(join(stagingRoot, directoryName), { recursive: false });
      }
      await writeFile(join(stagingRoot, 'project.json'), `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await rename(stagingRoot, projectRoot);
    } catch (error) {
      if (await lstatOrNull(stagingRoot)) await rm(stagingRoot, { recursive: true, force: true });
      if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') {
        fail('PROJECT_EXISTS', `项目“${normalizedName}”已经存在`, error);
      }
      throw error;
    }
    return toPublicProject(metadata, projectRoot);
  }

  async renameProject(projectId, displayName) {
    validateProjectId(projectId);
    const normalizedName = validateDisplayName(displayName, this.maxDisplayNameLength);
    return this.#withProjectMutation(projectId, async () => {
      await this.initialize();
      if (await lstatOrNull(this.#projectRoot(projectId)) === null) {
        fail('PROJECT_NOT_FOUND', `项目 ${projectId} 不存在`);
      }
      const project = await this.getProject(projectId);
      await this.#canonicalProjectRoot(projectId, project.projectRoot);
      const current = await readProjectMetadata(project.projectRoot, projectId, this.maxDisplayNameLength);
      if (current.metadata.displayName === normalizedName) return project;
      const document = { ...current.document, displayName: normalizedName };
      const metadata = { ...current.metadata, displayName: normalizedName };
      try {
        await writeProjectMetadataAtomically(this.softwareRoot, project.projectRoot, document);
      } catch (error) {
        if (error instanceof SoftwareWorkspaceError) throw error;
        fail('PROJECT_RENAME_FAILED', `项目 ${projectId} 重命名失败`, error);
      }
      return toPublicProject(metadata, project.projectRoot);
    });
  }

  async deleteProject(projectId) {
    validateProjectId(projectId);
    return this.#withProjectMutation(projectId, async () => {
      await this.initialize();
      if (await lstatOrNull(this.#projectRoot(projectId)) === null) {
        fail('PROJECT_NOT_FOUND', `项目 ${projectId} 不存在`);
      }
      const project = await this.getProject(projectId);
      const { canonicalProjectsRoot } = await this.#canonicalProjectRoot(projectId, project.projectRoot);
      await assertTreeHasNoReparsePoints(project.projectRoot, `项目 ${projectId}`);

      const deletionName = `.deleting-${projectId}-${randomUUID()}`;
      const deletionRoot = join(this.projectsRoot, deletionName);
      assertPathInside(this.softwareRoot, deletionRoot, `项目 ${projectId} 的删除暂存目录`);
      await assertSafeTargetChain(this.softwareRoot, deletionRoot, `项目 ${projectId} 的删除暂存目录`);
      let staged = false;
      try {
        await rename(project.projectRoot, deletionRoot);
        staged = true;
        const deletionInfo = await assertPlainExistingEntry(deletionRoot, `项目 ${projectId} 的删除暂存目录`, 'directory');
        const canonicalDeletionRoot = await realpath(deletionRoot);
        if (!deletionInfo.isDirectory() || !samePath(canonicalDeletionRoot, join(canonicalProjectsRoot, deletionName))) {
          fail('PATH_OUTSIDE_SOFTWARE_ROOT', `项目 ${projectId} 的删除暂存目录越过隔离边界`);
        }
        await rm(deletionRoot, { recursive: true, force: false, maxRetries: 3, retryDelay: 25 });
        staged = false;
      } catch (error) {
        if (staged && await lstatOrNull(deletionRoot) && !(await lstatOrNull(project.projectRoot))) {
          await rename(deletionRoot, project.projectRoot).catch(() => {});
        }
        if (error instanceof SoftwareWorkspaceError) throw error;
        fail('PROJECT_DELETE_FAILED', `项目 ${projectId} 删除失败`, error);
      }
      return Object.freeze({ projectId, deleted: true });
    });
  }

  async #replaceDirectory(sourceRoot, targetRoot, label, {
    expectedTargetManifest = null,
    sourceManifest = null
  } = {}) {
    assertPathInside(this.softwareRoot, targetRoot, label);
    await assertSafeTargetChain(this.softwareRoot, dirname(targetRoot), `${label} 的父目录`);
    const stageRoot = `${targetRoot}.stage-${randomUUID()}`;
    const backupRoot = `${targetRoot}.backup-${randomUUID()}`;
    let hasBackup = false;
    try {
      await copySafeTree(sourceRoot, stageRoot, label, {
        files: 0,
        bytes: 0,
        maxFiles: this.maxRuntimeFiles,
        maxBytes: this.maxRuntimeBytes
      });
      if (sourceManifest) {
        const stagedSourceManifest = await buildTreeManifest(stageRoot, `${label} 临时目录`, {
          files: 0,
          bytes: 0,
          maxFiles: this.maxRuntimeFiles,
          maxBytes: this.maxRuntimeBytes
        });
        if (!sameTreeManifest(stagedSourceManifest, sourceManifest)) {
          fail('SOURCE_CHANGED_DURING_COPY', `${label} 的来源在复制期间发生变化`);
        }
      }
      const current = await lstatOrNull(targetRoot);
      if (current === null && expectedTargetManifest) return false;
      if (current !== null) {
        await assertSafeTargetChain(this.softwareRoot, targetRoot, label);
        if (!current.isDirectory()) fail('INVALID_RUNTIME_DIRECTORY', `${label} 不是普通目录`);
        await rename(targetRoot, backupRoot);
        hasBackup = true;
        if (expectedTargetManifest) {
          const actualTargetManifest = await buildTreeManifest(backupRoot, `${label} 待替换目录`, {
            files: 0,
            bytes: 0,
            maxFiles: this.maxRuntimeFiles,
            maxBytes: this.maxRuntimeBytes
          });
          if (!sameTreeManifest(actualTargetManifest, expectedTargetManifest)) {
            await rename(backupRoot, targetRoot);
            hasBackup = false;
            return false;
          }
        }
      }
      try {
        await rename(stageRoot, targetRoot);
      } catch (error) {
        if (hasBackup) {
          await rename(backupRoot, targetRoot);
          hasBackup = false;
        }
        throw error;
      }
      if (hasBackup) {
        await rm(backupRoot, { recursive: true, force: true });
        hasBackup = false;
      }
      return true;
    } finally {
      if (await lstatOrNull(stageRoot)) await rm(stageRoot, { recursive: true, force: true });
      if (hasBackup && await lstatOrNull(backupRoot) && !(await lstatOrNull(targetRoot))) {
        await rename(backupRoot, targetRoot);
        hasBackup = false;
      }
      if (await lstatOrNull(backupRoot)) await rm(backupRoot, { recursive: true, force: true });
    }
  }

  async #replaceFile(sourcePath, targetPath, label) {
    assertPathInside(this.softwareRoot, targetPath, label);
    await assertSafeTargetChain(this.softwareRoot, dirname(targetPath), `${label} 的父目录`);
    const stagePath = `${targetPath}.stage-${randomUUID()}`;
    const backupPath = `${targetPath}.backup-${randomUUID()}`;
    let hasBackup = false;
    try {
      await copySafeTree(sourcePath, stagePath, label, {
        files: 0,
        bytes: 0,
        maxFiles: this.maxRuntimeFiles,
        maxBytes: this.maxRuntimeBytes
      });
      const current = await lstatOrNull(targetPath);
      if (current !== null) {
        await assertSafeTargetChain(this.softwareRoot, targetPath, label);
        if (!current.isFile()) fail('INVALID_RUNTIME_FILE', `${label} 不是普通文件`);
        await rename(targetPath, backupPath);
        hasBackup = true;
      }
      try {
        await rename(stagePath, targetPath);
      } catch (error) {
        if (hasBackup) {
          await rename(backupPath, targetPath);
          hasBackup = false;
        }
        throw error;
      }
      if (hasBackup) {
        await rm(backupPath, { force: true });
        hasBackup = false;
      }
    } finally {
      if (await lstatOrNull(stagePath)) await rm(stagePath, { force: true });
      if (hasBackup && await lstatOrNull(backupPath) && !(await lstatOrNull(targetPath))) {
        await rename(backupPath, targetPath);
        hasBackup = false;
      }
      if (await lstatOrNull(backupPath)) await rm(backupPath, { force: true });
    }
  }

  async materializeProjectRuntime(projectId) {
    validateProjectId(projectId);
    await this.initialize();
    const project = await this.getProject(projectId);
    const engineScriptsRoot = join(this.engineRoot, 'scripts');
    const scriptsSourceManifest = await buildTreeManifest(engineScriptsRoot, 'engineRoot/scripts', {
      files: 0,
      bytes: 0,
      maxFiles: this.maxRuntimeFiles,
      maxBytes: this.maxRuntimeBytes
    });
    const assetsSourceManifest = await buildTreeManifest(this.sharedAssetsRoot, 'sharedAssetsRoot', {
      files: 0,
      bytes: 0,
      maxFiles: this.maxRuntimeFiles,
      maxBytes: this.maxRuntimeBytes
    });
    const scriptsRoot = join(project.projectRoot, 'scripts');
    const assetsRoot = join(project.projectRoot, 'assets');
    const targetManifest = async (targetRoot, label) => {
      const info = await lstatOrNull(targetRoot);
      if (info === null) return null;
      await assertSafeTargetChain(this.softwareRoot, targetRoot, label);
      if (!info.isDirectory()) fail('INVALID_RUNTIME_DIRECTORY', `${label} 不是普通目录`);
      return buildTreeManifest(targetRoot, label, {
        files: 0,
        bytes: 0,
        maxFiles: this.maxRuntimeFiles,
        maxBytes: this.maxRuntimeBytes
      });
    };
    const scriptsTargetManifest = await targetManifest(scriptsRoot, `项目 ${projectId}/scripts`);
    if (!sameTreeManifest(scriptsSourceManifest, scriptsTargetManifest)) {
      await this.#replaceDirectory(engineScriptsRoot, scriptsRoot, `项目 ${projectId}/scripts`, {
        expectedTargetManifest: scriptsTargetManifest,
        sourceManifest: scriptsSourceManifest
      });
    }
    const assetsTargetManifest = await targetManifest(assetsRoot, `项目 ${projectId}/assets`);
    if (!sameTreeManifest(assetsSourceManifest, assetsTargetManifest)) {
      await this.#replaceDirectory(this.sharedAssetsRoot, assetsRoot, `项目 ${projectId}/assets`, {
        expectedTargetManifest: assetsTargetManifest,
        sourceManifest: assetsSourceManifest
      });
    }
    return Object.freeze({
      projectId,
      projectRoot: project.projectRoot,
      scriptsRoot,
      assetsRoot
    });
  }

  async importScreenplay(projectId, { filename, buffer, stream, overwrite = false } = {}) {
    validateProjectId(projectId);
    if (typeof overwrite !== 'boolean') fail('INVALID_OVERWRITE_OPTION', 'overwrite 必须是布尔值');
    const hasBuffer = buffer !== undefined;
    const hasStream = stream !== undefined;
    if (hasBuffer === hasStream) fail('INVALID_UPLOAD_BODY', 'buffer 和 stream 必须且只能提供一个');
    if (hasBuffer && !(buffer instanceof Uint8Array)) {
      fail('INVALID_UPLOAD_BODY', 'buffer 必须是 Buffer 或 Uint8Array');
    }
    const safeFilename = sanitizeScreenplayFilename(filename);
    await this.initialize();
    const project = await this.getProject(projectId);
    const screenplayRoot = project.screenplayRoot;
    await assertSafeTargetChain(this.softwareRoot, screenplayRoot, `项目 ${projectId}/剧本`);
    const finalPath = join(screenplayRoot, safeFilename);
    assertPathInside(this.softwareRoot, finalPath, '剧本目标文件');
    const initialTarget = await lstatOrNull(finalPath);
    if (initialTarget?.isSymbolicLink()) fail('UNSAFE_REPARSE_POINT', '剧本目标不能是符号链接或目录联接');
    if (initialTarget && !initialTarget.isFile()) fail('INVALID_FILE', '同名剧本目标不是普通文件');
    if (initialTarget && !overwrite) fail('SCREENPLAY_EXISTS', `剧本 ${safeFilename} 已存在；覆盖需要显式指定 overwrite: true`);

    const temporaryPath = join(screenplayRoot, `.upload-${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, 'wx', 0o600);
    let size = 0;
    try {
      const chunks = hasBuffer ? [buffer] : toAsyncIterable(stream);
      for await (const rawChunk of chunks) {
        const chunk = typeof rawChunk === 'string'
          ? Buffer.from(rawChunk)
          : rawChunk instanceof Uint8Array
            ? Buffer.from(rawChunk.buffer, rawChunk.byteOffset, rawChunk.byteLength)
            : null;
        if (chunk === null) fail('INVALID_UPLOAD_BODY', '上传流只能包含字符串或字节数据');
        size += chunk.byteLength;
        if (size > this.maxScreenplayBytes) {
          fail('SCREENPLAY_TOO_LARGE', `单个剧本不能超过 ${this.maxScreenplayBytes} 字节`);
        }
        await writeAll(handle, chunk);
      }
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
    await handle.close();
    if (size <= 0) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      fail('EMPTY_SCREENPLAY', '剧本文件不能为空');
    }

    let backupPath = null;
    try {
      const currentTarget = await lstatOrNull(finalPath);
      if (currentTarget?.isSymbolicLink()) fail('UNSAFE_REPARSE_POINT', '剧本目标不能是符号链接或目录联接');
      if (currentTarget && !currentTarget.isFile()) fail('INVALID_FILE', '同名剧本目标不是普通文件');
      if (currentTarget && !overwrite) fail('SCREENPLAY_EXISTS', `剧本 ${safeFilename} 已存在；覆盖需要显式指定 overwrite: true`);
      if (currentTarget) {
        backupPath = join(screenplayRoot, `.upload-backup-${randomUUID()}.tmp`);
        await rename(finalPath, backupPath);
      }
      try {
        await rename(temporaryPath, finalPath);
      } catch (error) {
        if (backupPath) {
          await rename(backupPath, finalPath);
          backupPath = null;
        }
        throw error;
      }
      if (backupPath) {
        await rm(backupPath, { force: true });
        backupPath = null;
      }
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {});
      if (backupPath && await lstatOrNull(backupPath) && !(await lstatOrNull(finalPath))) {
        await rename(backupPath, finalPath).catch(() => {});
      }
      if (backupPath) await rm(backupPath, { force: true }).catch(() => {});
    }
    return Object.freeze({ projectId, filename: safeFilename, path: finalPath, size });
  }
}

export const createSoftwareWorkspace = (options) => new SoftwareWorkspace(options);
