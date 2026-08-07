import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, win32 } from 'node:path';

export const PROJECT_INDEX_SCHEMA_VERSION = 1;
export const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const LEGACY_PROJECT_ID = 'current-package';
export const MAX_PROJECT_COUNT = 256;

const PROJECTS_DIRECTORY = 'projects';
const PROJECT_METADATA_FILE = 'project.json';
const MAX_METADATA_BYTES = 32 * 1024;
const MAX_DISPLAY_NAME_LENGTH = 80;
const LEGACY_DISPLAY_NAME = '当前安装包项目';

const isDirectChild = (parent, candidate, expectedName) => {
  const child = relative(parent, candidate);
  if (!child || child.startsWith('..') || isAbsolute(child) || child.includes('/') || child.includes('\\')) return false;
  return process.platform === 'win32'
    ? child.toLowerCase() === expectedName.toLowerCase()
    : child === expectedName;
};

const isMissing = (error) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';

export class ProjectRootIndexError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ProjectRootIndexError';
    this.status = status;
    this.code = code;
  }
}

export function validateProjectId(value) {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) {
    throw new ProjectRootIndexError(
      400,
      'INVALID_PROJECT_ID',
      'projectId 必须是 1 到 64 位 ASCII 字母、数字、下划线或连字符，且首位必须是字母或数字'
    );
  }
  return value;
}

const cleanDisplayName = (value) => {
  if (typeof value !== 'string') return null;
  const displayName = value.replace(/[\r\n\t]+/gu, ' ').trim();
  if (!displayName || displayName.length > MAX_DISPLAY_NAME_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/u.test(displayName) || /[\\/]/u.test(displayName)) return null;
  if (displayName === '.' || displayName === '..' || isAbsolute(displayName) || win32.isAbsolute(displayName)) return null;
  return displayName;
};

const inspectDirectory = async (candidate, canonicalParent, expectedName) => {
  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isDirectory()) return { safe: false };
    const canonical = await realpath(candidate);
    if (!isDirectChild(canonicalParent, canonical, expectedName)) return { safe: false };
    return {
      safe: true,
      canonical,
      identity: `${info.dev}:${info.ino}:${info.birthtimeMs}`
    };
  } catch (error) {
    return { safe: false, missing: isMissing(error) };
  }
};

const readDisplayName = async (projectRoot, canonicalProjectRoot, fallback) => {
  const metadataPath = resolve(projectRoot, PROJECT_METADATA_FILE);
  try {
    const info = await lstat(metadataPath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_METADATA_BYTES) return fallback;
    const canonicalMetadata = await realpath(metadataPath);
    if (!isDirectChild(canonicalProjectRoot, canonicalMetadata, PROJECT_METADATA_FILE)) return fallback;
    const contents = await readFile(metadataPath, 'utf8');
    const verifiedInfo = await lstat(metadataPath);
    const verifiedCanonical = await realpath(metadataPath);
    if (
      verifiedInfo.isSymbolicLink()
      || !verifiedInfo.isFile()
      || verifiedInfo.dev !== info.dev
      || verifiedInfo.ino !== info.ino
      || verifiedInfo.birthtimeMs !== info.birthtimeMs
      || verifiedInfo.mtimeMs !== info.mtimeMs
      || verifiedInfo.size !== info.size
      || !isDirectChild(canonicalProjectRoot, verifiedCanonical, PROJECT_METADATA_FILE)
    ) return fallback;
    const metadata = JSON.parse(contents);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return fallback;
    return cleanDisplayName(Object.prototype.hasOwnProperty.call(metadata, 'displayName') ? metadata.displayName : null) || fallback;
  } catch {
    return fallback;
  }
};

const publicMetadata = ({ projectId, displayName, storageMode, availability }) => Object.freeze({
  projectId,
  displayName,
  storageMode,
  availability
});

/**
 * Enumerates only fixed installationRoot/projects/<projectId> roots.
 * Returned public metadata never contains a filesystem path; resolveProject is
 * the only method that exposes a validated root to the local server process.
 */
export function createProjectRootIndex(installationRoot, { includeLegacy = true } = {}) {
  const rootPath = resolve(installationRoot);
  const projectsPath = resolve(rootPath, PROJECTS_DIRECTORY);
  const projectContainment = relative(rootPath, projectsPath);
  if (projectContainment !== PROJECTS_DIRECTORY) {
    throw new ProjectRootIndexError(500, 'PROJECT_INDEX_INVALID', '项目索引配置无效');
  }

  const inspectInstallationRoot = async () => {
    try {
      const info = await lstat(rootPath);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('unsafe root');
      return {
        canonical: await realpath(rootPath),
        identity: `${info.dev}:${info.ino}:${info.birthtimeMs}`
      };
    } catch {
      throw new ProjectRootIndexError(503, 'PROJECT_INDEX_UNAVAILABLE', '安装根不可用于项目读取');
    }
  };

  const makeLegacyProject = async (installation) => {
    const displayName = await readDisplayName(rootPath, installation.canonical, LEGACY_DISPLAY_NAME);
    return {
      metadata: publicMetadata({
        projectId: LEGACY_PROJECT_ID,
        displayName,
        storageMode: 'legacy-root',
        availability: 'available'
      }),
      rootPath: installation.canonical,
      identity: installation.identity
    };
  };

  const scan = async () => {
    const installation = await inspectInstallationRoot();
    let projectsInfo;
    try {
      projectsInfo = await lstat(projectsPath);
    } catch (error) {
      if (isMissing(error)) return includeLegacy ? [await makeLegacyProject(installation)] : [];
      throw new ProjectRootIndexError(503, 'PROJECT_INDEX_UNAVAILABLE', '项目索引不可读取');
    }
    if (projectsInfo.isSymbolicLink() || !projectsInfo.isDirectory()) {
      throw new ProjectRootIndexError(503, 'PROJECT_INDEX_UNSAFE', '项目索引包含不安全的重解析路径');
    }

    let canonicalProjects;
    try {
      canonicalProjects = await realpath(projectsPath);
    } catch {
      throw new ProjectRootIndexError(503, 'PROJECT_INDEX_UNAVAILABLE', '项目索引不可读取');
    }
    if (!isDirectChild(installation.canonical, canonicalProjects, PROJECTS_DIRECTORY)) {
      throw new ProjectRootIndexError(503, 'PROJECT_INDEX_UNSAFE', '项目索引包含不安全的重解析路径');
    }

    let entries;
    try {
      entries = await readdir(projectsPath, { withFileTypes: true });
    } catch {
      throw new ProjectRootIndexError(503, 'PROJECT_INDEX_UNAVAILABLE', '项目索引不可读取');
    }

    const candidates = entries
      .filter((entry) => PROJECT_ID_PATTERN.test(entry.name) && (entry.isDirectory() || entry.isSymbolicLink()))
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    if (candidates.some(({ name }) => name === LEGACY_PROJECT_ID)) {
      throw new ProjectRootIndexError(503, 'PROJECT_ID_CONFLICT', '隔离项目不得使用保留的 current-package 标识');
    }
    if (candidates.length + (includeLegacy ? 1 : 0) > MAX_PROJECT_COUNT) {
      throw new ProjectRootIndexError(503, 'PROJECT_LIMIT_EXCEEDED', `项目数量不得超过 ${MAX_PROJECT_COUNT}`);
    }

    const projects = includeLegacy ? [await makeLegacyProject(installation)] : [];
    for (const entry of candidates) {
      const candidate = resolve(projectsPath, entry.name);
      const inspected = await inspectDirectory(candidate, canonicalProjects, entry.name);
      if (!inspected.safe) {
        projects.push({
          metadata: publicMetadata({
            projectId: entry.name,
            displayName: entry.name,
            storageMode: 'isolated-project',
            availability: 'unavailable'
          }),
          rootPath: null,
          identity: null
        });
        continue;
      }
      projects.push({
        metadata: publicMetadata({
          projectId: entry.name,
          displayName: await readDisplayName(candidate, inspected.canonical, entry.name),
          storageMode: 'isolated-project',
          availability: 'available'
        }),
        rootPath: inspected.canonical,
        identity: inspected.identity
      });
    }
    return projects;
  };

  const listProjects = async () => Object.freeze((await scan()).map(({ metadata }) => metadata));

  const resolveProject = async (projectId) => {
    validateProjectId(projectId);
    const project = (await scan()).find(({ metadata }) => metadata.projectId === projectId);
    if (!project) throw new ProjectRootIndexError(404, 'PROJECT_NOT_FOUND', '项目不存在');
    if (!project.rootPath || project.metadata.availability !== 'available') {
      throw new ProjectRootIndexError(403, 'PROJECT_ROOT_UNSAFE', '项目根包含不安全的符号链接、junction 或重解析路径');
    }
    if (project.metadata.storageMode === 'isolated-project') {
      const canonicalProjects = await realpath(projectsPath).catch(() => null);
      const verified = canonicalProjects
        ? await inspectDirectory(project.rootPath, canonicalProjects, project.metadata.projectId)
        : { safe: false };
      if (!verified.safe || verified.identity !== project.identity) {
        throw new ProjectRootIndexError(403, 'PROJECT_ROOT_UNSAFE', '项目根在读取前发生变化');
      }
      project.rootPath = verified.canonical;
      project.identity = verified.identity;
    }
    return Object.freeze({
      metadata: project.metadata,
      rootPath: project.rootPath,
      identity: project.identity
    });
  };

  return Object.freeze({ listProjects, resolveProject });
}
