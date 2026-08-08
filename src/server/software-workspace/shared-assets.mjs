import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { fail } from './contracts.mjs';
import {
  assertPathInside,
  assertPlainExistingEntry,
  assertSafeTargetChain,
  isPathInside,
  lstatOrNull
} from './path-safety.mjs';

const SHARED_ASSETS_MANIFEST_VERSION = 1;
export const SHARED_ASSETS_MANIFEST_FILENAME = '.shared-assets-source.json';
const SHARED_ASSETS_MANIFEST_ALGORITHM = 'sha256-tree-v1';
const PROMPT_CATALOG_RELATIVE_PATH = '图片生成/prompts/catalog.json';

const isGeneratedRuntimeNoise = (name) => (
  name === '__pycache__' || name.toLocaleLowerCase('en-US').endsWith('.pyc')
);

const readRuntimeSourceEntries = async (root) => {
  const entries = await readdir(root);
  return entries
    .filter((entry) => !isGeneratedRuntimeNoise(entry))
    .sort((left, right) => left.localeCompare(right));
};

export const validateSourceTree = async (sourceRoot, label, budget, depth = 0) => {
  if (depth > 64) fail('SOURCE_TREE_TOO_DEEP', `${label} 的目录层级超过限制`);
  const info = await assertPlainExistingEntry(sourceRoot, label);
  if (info.isFile()) {
    budget.files += 1;
    budget.bytes += info.size;
    if (budget.files > budget.maxFiles || budget.bytes > budget.maxBytes) {
      fail('SOURCE_TREE_TOO_LARGE', `${label} 超过允许复制的大小`);
    }
    return;
  }
  if (!info.isDirectory()) fail('UNSAFE_SOURCE_ENTRY', `${label} 只能包含普通文件和目录`);
  const entries = await readRuntimeSourceEntries(sourceRoot);
  for (const entry of entries) {
    await validateSourceTree(join(sourceRoot, entry), `${label}/${entry}`, budget, depth + 1);
  }
};

export const copySafeTree = async (sourceRoot, destinationRoot, label, budget, depth = 0) => {
  if (depth > 64) fail('SOURCE_TREE_TOO_DEEP', `${label} 的目录层级超过限制`);
  const info = await assertPlainExistingEntry(sourceRoot, label);
  if (info.isDirectory()) {
    await mkdir(destinationRoot, { recursive: false });
    const entries = await readRuntimeSourceEntries(sourceRoot);
    for (const entry of entries) {
      await copySafeTree(join(sourceRoot, entry), join(destinationRoot, entry), `${label}/${entry}`, budget, depth + 1);
    }
    return;
  }
  if (!info.isFile()) fail('UNSAFE_SOURCE_ENTRY', `${label} 只能包含普通文件和目录`);
  budget.files += 1;
  budget.bytes += info.size;
  if (budget.files > budget.maxFiles || budget.bytes > budget.maxBytes) {
    fail('SOURCE_TREE_TOO_LARGE', `${label} 超过允许复制的大小`);
  }
  await copyFile(sourceRoot, destinationRoot, fsConstants.COPYFILE_EXCL);
};

const toManifestPath = (value) => value.split(sep).join('/');

const manifestFingerprint = (entries) => createHash('sha256')
  .update(JSON.stringify(entries), 'utf8')
  .digest('hex');

const makeTreeManifest = (entries) => ({
  schemaVersion: SHARED_ASSETS_MANIFEST_VERSION,
  algorithm: SHARED_ASSETS_MANIFEST_ALGORITHM,
  fingerprint: manifestFingerprint(entries),
  entries
});

export const buildTreeManifest = async (sourceRoot, label, budget) => {
  await assertPlainExistingEntry(sourceRoot, label, 'directory');
  const entries = [];
  const visit = async (currentRoot, relativeRoot = '', depth = 0) => {
    if (depth > 64) fail('SOURCE_TREE_TOO_DEEP', `${label} 的目录层级超过限制`);
    const names = await readRuntimeSourceEntries(currentRoot);
    for (const name of names) {
      const entryPath = join(currentRoot, name);
      const entry = await assertPlainExistingEntry(entryPath, `${label}/${relativeRoot}${name}`);
      const relativePath = relativeRoot ? `${relativeRoot}${name}` : name;
      const manifestPath = toManifestPath(relativePath);
      if (entry.isDirectory()) {
        entries.push({ path: manifestPath, type: 'directory' });
        await visit(entryPath, `${relativePath}${sep}`, depth + 1);
        continue;
      }
      if (!entry.isFile()) fail('UNSAFE_SOURCE_ENTRY', `${label} 只能包含普通文件和目录`);
      const bytes = await readFile(entryPath);
      budget.files += 1;
      budget.bytes += bytes.byteLength;
      if (budget.files > budget.maxFiles || budget.bytes > budget.maxBytes) {
        fail('SOURCE_TREE_TOO_LARGE', `${label} 超过允许复制的大小`);
      }
      entries.push({
        path: manifestPath,
        type: 'file',
        size: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex')
      });
    }
  };
  await visit(sourceRoot);
  return makeTreeManifest(entries);
};

export const sameTreeManifest = (left, right) => Boolean(
  left &&
  right &&
  left.fingerprint === right.fingerprint &&
  JSON.stringify(left.entries) === JSON.stringify(right.entries)
);

const parseTreeManifest = (text) => {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.schemaVersion !== SHARED_ASSETS_MANIFEST_VERSION ||
    value.algorithm !== SHARED_ASSETS_MANIFEST_ALGORITHM ||
    !/^[a-f0-9]{64}$/u.test(value.fingerprint) ||
    !Array.isArray(value.entries)
  ) {
    return null;
  }
  const paths = new Set();
  for (const entry of value.entries) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      typeof entry.path !== 'string' ||
      !entry.path ||
      entry.path.includes('\\') ||
      entry.path.startsWith('/') ||
      entry.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      paths.has(entry.path) ||
      (entry.type !== 'directory' && entry.type !== 'file')
    ) {
      return null;
    }
    paths.add(entry.path);
    if (
      entry.type === 'file' &&
      (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/u.test(entry.sha256))
    ) {
      return null;
    }
  }
  return value.fingerprint === manifestFingerprint(value.entries) ? value : null;
};

export const makeLegacyPromptCatalogManifest = async (packageAssetsRoot, currentManifest) => {
  const catalogPath = join(packageAssetsRoot, ...PROMPT_CATALOG_RELATIVE_PATH.split('/'));
  let catalogText;
  let catalog;
  try {
    catalogText = await readFile(catalogPath, 'utf8');
    catalog = JSON.parse(catalogText);
  } catch {
    return null;
  }
  const matches = [...catalogText.matchAll(
    /^[\t ]*"conditionModules"[\t ]*:[\t ]*"([^"\r\n]+)"[\t ]*,[\t ]*(?:\r?\n|$)/gmu
  )];
  if (matches.length !== 1 || catalog?.paths?.conditionModules !== matches[0][1]) return null;

  const promptsRoot = dirname(catalogPath);
  const conditionModulePath = resolve(promptsRoot, catalog.paths.conditionModules);
  if (!isPathInside(promptsRoot, conditionModulePath)) return null;
  const conditionModuleRelativePath = toManifestPath(relative(packageAssetsRoot, conditionModulePath));
  const conditionEntry = currentManifest.entries.find(({ path }) => path === conditionModuleRelativePath);
  const catalogEntryIndex = currentManifest.entries.findIndex(({ path }) => path === PROMPT_CATALOG_RELATIVE_PATH);
  if (conditionEntry?.type !== 'file' || currentManifest.entries[catalogEntryIndex]?.type !== 'file') return null;

  const legacyCatalogText = catalogText.slice(0, matches[0].index) + catalogText.slice(matches[0].index + matches[0][0].length);
  const legacyCatalogBytes = Buffer.from(legacyCatalogText, 'utf8');
  const entries = currentManifest.entries
    .filter(({ path }) => path !== conditionModuleRelativePath)
    .map((entry) => ({ ...entry }));
  const legacyCatalogEntryIndex = entries.findIndex(({ path }) => path === PROMPT_CATALOG_RELATIVE_PATH);
  entries[legacyCatalogEntryIndex] = {
    path: PROMPT_CATALOG_RELATIVE_PATH,
    type: 'file',
    size: legacyCatalogBytes.byteLength,
    sha256: createHash('sha256').update(legacyCatalogBytes).digest('hex')
  };
  return makeTreeManifest(entries);
};

export const readTreeManifest = async (manifestPath) => {
  const info = await lstatOrNull(manifestPath);
  if (info === null) return null;
  if (info.isSymbolicLink()) fail('UNSAFE_REPARSE_POINT', 'shared-assets 来源清单不能是符号链接或目录联接');
  if (!info.isFile()) fail('INVALID_SHARED_ASSETS_MANIFEST', 'shared-assets 来源清单必须是普通文件');
  return parseTreeManifest(await readFile(manifestPath, 'utf8'));
};

export const writeTreeManifest = async (softwareRoot, manifestPath, manifest) => {
  assertPathInside(softwareRoot, manifestPath, 'shared-assets 来源清单');
  await assertSafeTargetChain(softwareRoot, dirname(manifestPath), 'shared-assets 来源清单父目录');
  const stagePath = `${manifestPath}.stage-${randomUUID()}`;
  const backupPath = `${manifestPath}.backup-${randomUUID()}`;
  let hasBackup = false;
  try {
    await writeFile(stagePath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const current = await lstatOrNull(manifestPath);
    if (current !== null) {
      if (current.isSymbolicLink()) fail('UNSAFE_REPARSE_POINT', 'shared-assets 来源清单不能是符号链接或目录联接');
      if (!current.isFile()) fail('INVALID_SHARED_ASSETS_MANIFEST', 'shared-assets 来源清单必须是普通文件');
      await rename(manifestPath, backupPath);
      hasBackup = true;
    }
    try {
      await rename(stagePath, manifestPath);
    } catch (error) {
      if (hasBackup) {
        await rename(backupPath, manifestPath);
        hasBackup = false;
      }
      throw error;
    }
    if (hasBackup) {
      await rm(backupPath, { force: true });
      hasBackup = false;
    }
  } finally {
    await rm(stagePath, { force: true }).catch(() => {});
    if (hasBackup && await lstatOrNull(backupPath) && !(await lstatOrNull(manifestPath))) {
      await rename(backupPath, manifestPath);
      hasBackup = false;
    }
    if (hasBackup) await rm(backupPath, { force: true }).catch(() => {});
  }
};
