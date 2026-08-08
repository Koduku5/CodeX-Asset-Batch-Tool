import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { fail } from './contracts.mjs';

const isMissing = (error) => error?.code === 'ENOENT';

const normalizeComparablePath = (value) => {
  const normalized = resolve(value).replace(/^\\\\\?\\/u, '').replaceAll('/', sep);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
};

export const samePath = (left, right) => normalizeComparablePath(left) === normalizeComparablePath(right);

export const assertTreeHasNoReparsePoints = async (root, label, depth = 0) => {
  if (depth > 64) fail('PROJECT_TREE_TOO_DEEP', `${label} 的目录层级超过限制`);
  const info = await assertPlainExistingEntry(root, label);
  if (info.isFile()) return;
  if (!info.isDirectory()) {
    fail('UNSAFE_PROJECT_ENTRY', `${label} 只能包含普通文件和目录`);
  }
  const entries = await readdir(root);
  entries.sort((left, right) => left.localeCompare(right));
  for (const entry of entries) {
    await assertTreeHasNoReparsePoints(join(root, entry), `${label}/${entry}`, depth + 1);
  }
};

export const isPathInside = (root, candidate, { allowRoot = false } = {}) => {
  const offset = relative(resolve(root), resolve(candidate));
  if (!offset) return allowRoot;
  return offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
};

export const assertPathInside = (root, candidate, label, { allowRoot = false } = {}) => {
  if (!isPathInside(root, candidate, { allowRoot })) {
    fail('PATH_OUTSIDE_SOFTWARE_ROOT', `${label} 必须位于软件目录内`);
  }
};

export const lstatOrNull = async (path) => {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
};

export const assertPlainExistingEntry = async (path, label, expectedKind = null) => {
  const info = await lstatOrNull(path);
  if (info === null) fail('MISSING_SOURCE', `${label} 不存在`);
  if (info.isSymbolicLink()) fail('UNSAFE_REPARSE_POINT', `${label} 不允许使用符号链接或目录联接`);
  if (expectedKind === 'directory' && !info.isDirectory()) fail('INVALID_DIRECTORY', `${label} 必须是目录`);
  if (expectedKind === 'file' && !info.isFile()) fail('INVALID_FILE', `${label} 必须是普通文件`);
  return info;
};

export const assertSafeTargetChain = async (softwareRoot, target, label) => {
  assertPathInside(softwareRoot, target, label, { allowRoot: true });
  await assertPlainExistingEntry(softwareRoot, 'softwareRoot', 'directory');
  const offset = relative(resolve(softwareRoot), resolve(target));
  if (!offset) return;
  let cursor = resolve(softwareRoot);
  for (const part of offset.split(sep)) {
    cursor = join(cursor, part);
    const info = await lstatOrNull(cursor);
    if (info === null) return;
    if (info.isSymbolicLink()) fail('UNSAFE_REPARSE_POINT', `${label} 的路径中含有符号链接或目录联接`);
  }
};
