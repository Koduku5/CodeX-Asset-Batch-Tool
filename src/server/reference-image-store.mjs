import { createHash, randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const REFERENCE_INDEX_VERSION = 1;
export const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_REFERENCE_IMAGE_PIXELS = 24 * 1024 * 1024;
export const REFERENCE_STYLES = Object.freeze(['anime', 'cg', 'live-action']);
export const REFERENCE_SHEETS = Object.freeze(['角色', '生物', '群演', '场景', '道具']);

const STYLE_SET = new Set(REFERENCE_STYLES);
const SHEET_SET = new Set(REFERENCE_SHEETS);
const EXTENSION_SET = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.webp']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REFERENCE_ID_PATTERN = /^ref-[a-f0-9]{64}$/u;
const SAFE_ENVIRONMENT_KEYS = Object.freeze([
  'ALLUSERSPROFILE', 'APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMDRIVE', 'SYSTEMROOT',
  'TEMP', 'TMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'
]);

export class ReferenceImageStoreError extends Error {
  constructor(code, message, { status = 400, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ReferenceImageStoreError';
    this.code = code;
    this.status = status;
  }
}

const fail = (code, message, options) => {
  throw new ReferenceImageStoreError(code, message, options);
};

const samePath = (left, right) => process.platform === 'win32'
  ? String(left).toLowerCase() === String(right).toLowerCase()
  : left === right;

const isInside = (root, target, { allowRoot = false } = {}) => {
  const offset = relative(root, target);
  if (!offset) return allowRoot;
  return offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
};

const rootFromResolution = (value) => {
  const candidate = typeof value === 'string' ? value : value?.rootPath;
  if (typeof candidate !== 'string' || !isAbsolute(candidate)) {
    fail('PROJECT_ROOT_UNAVAILABLE', '无法解析项目运行目录', { status: 503 });
  }
  return resolve(candidate);
};

const canonicalProjectRoot = async (candidate) => {
  try {
    const info = await lstat(candidate);
    const canonical = await realpath(candidate);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('PROJECT_ROOT_UNSAFE', '项目运行目录不安全', { status: 409 });
    return canonical;
  } catch (error) {
    if (error instanceof ReferenceImageStoreError) throw error;
    fail('PROJECT_ROOT_UNAVAILABLE', '项目运行目录不可用', { status: 503, cause: error });
  }
};

const assertSafePath = async (projectRoot, target, { mustExist = false, file = false } = {}) => {
  const resolved = resolve(target);
  if (!isInside(projectRoot, resolved, { allowRoot: true })) fail('REFERENCE_PATH_UNSAFE', '参考图路径越出当前项目', { status: 409 });
  const offset = relative(projectRoot, resolved);
  let cursor = projectRoot;
  for (const segment of offset.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if (error?.code === 'ENOENT' && !mustExist) return resolved;
      throw error;
    }
    if (info.isSymbolicLink()) fail('REFERENCE_PATH_UNSAFE', '参考图路径不能包含符号链接或目录联接', { status: 409 });
  }
  if (mustExist) {
    const info = await lstat(resolved);
    if ((file && !info.isFile()) || (!file && !info.isDirectory())) {
      fail('REFERENCE_PATH_UNSAFE', '参考图路径类型不正确', { status: 409 });
    }
  }
  return resolved;
};

const safeEnvironment = (source) => Object.fromEntries(
  SAFE_ENVIRONMENT_KEYS.flatMap((name) => {
    const key = Object.keys(source).find((candidate) => candidate.toUpperCase() === name);
    return key && typeof source[key] === 'string' ? [[key, source[key]]] : [];
  })
);

const runFixedCommand = ({ executable, arguments: args, cwd, spawnImpl, environment }) => new Promise((resolvePromise, rejectPromise) => {
  let child;
  try {
    child = spawnImpl(executable, args, {
      cwd,
      env: safeEnvironment(environment),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    rejectPromise(new ReferenceImageStoreError('REFERENCE_TOOL_START_FAILED', '参考图处理工具无法启动', { status: 503, cause: error }));
    return;
  }
  let stdout = '';
  let stderr = '';
  const append = (target, chunk) => `${target}${String(chunk ?? '')}`.slice(-8192);
  child.stdout?.setEncoding?.('utf8');
  child.stderr?.setEncoding?.('utf8');
  child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); });
  child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });
  let settled = false;
  const settle = (error, result) => {
    if (settled) return;
    settled = true;
    if (error) rejectPromise(error);
    else resolvePromise(result);
  };
  child.once('error', (error) => settle(new ReferenceImageStoreError('REFERENCE_TOOL_FAILED', '参考图处理工具运行失败', { status: 503, cause: error })));
  child.once('close', (code) => {
    if (code !== 0) {
      settle(new ReferenceImageStoreError('INVALID_REFERENCE_IMAGE', '参考图片无法通过格式、尺寸或像素校验', { status: 422 }));
      return;
    }
    settle(null, { stdout, stderr });
  });
});

const validateStyle = (value) => {
  if (typeof value !== 'string' || !STYLE_SET.has(value)) fail('INVALID_REFERENCE_STYLE', '参考图制作风格无效');
  return value;
};

const validateSheet = (value) => {
  if (typeof value !== 'string' || !SHEET_SET.has(value)) fail('INVALID_REFERENCE_SHEET', '参考图资产类别无效');
  return value;
};

const safeSourceName = (value) => {
  if (typeof value !== 'string' || !value || value.length > 255 || basename(value) !== value || /[\\/\u0000-\u001f\u007f]/u.test(value)) {
    fail('INVALID_REFERENCE_FILENAME', '参考图片文件名无效');
  }
  const normalized = value.normalize('NFC').trim();
  if (!normalized || !EXTENSION_SET.has(extname(normalized).toLowerCase())) {
    fail('UNSUPPORTED_REFERENCE_IMAGE', '只支持 PNG、JPG、JPEG、BMP 或 WebP 参考图');
  }
  return normalized;
};

const validateReferenceId = (value) => {
  if (typeof value !== 'string' || !REFERENCE_ID_PATTERN.test(value)) fail('INVALID_REFERENCE_ID', '参考图编号无效');
  return value;
};

const emptyIndex = () => ({ version: REFERENCE_INDEX_VERSION, entries: [] });

const exactKeys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');

const referenceIdFrom = (styleId, sheetName, sha256) => `ref-${createHash('sha256')
  .update(`${styleId}\0${sheetName}\0${sha256}`, 'utf8')
  .digest('hex')}`;

const validateEntry = (entry) => exactKeys(entry, [
  'referenceId', 'styleId', 'sheetName', 'path', 'sourceName', 'size', 'sha256', 'createdAt'
])
  && REFERENCE_ID_PATTERN.test(entry.referenceId)
  && STYLE_SET.has(entry.styleId)
  && SHEET_SET.has(entry.sheetName)
  && typeof entry.path === 'string'
  && entry.path.startsWith('cache/内置参考图/')
  && typeof entry.sourceName === 'string'
  && Number.isInteger(entry.size) && entry.size > 0 && entry.size <= MAX_REFERENCE_IMAGE_BYTES
  && SHA256_PATTERN.test(entry.sha256)
  && entry.referenceId === referenceIdFrom(entry.styleId, entry.sheetName, entry.sha256)
  && Number.isFinite(Date.parse(entry.createdAt));

const readIndex = async (indexPath) => {
  try {
    const parsed = JSON.parse(await readFile(indexPath, 'utf8'));
    if (!exactKeys(parsed, ['version', 'entries']) || parsed.version !== REFERENCE_INDEX_VERSION || !Array.isArray(parsed.entries) || !parsed.entries.every(validateEntry)) {
      fail('REFERENCE_INDEX_INVALID', '当前项目的参考图索引无效', { status: 409 });
    }
    const ids = new Set(parsed.entries.map(({ referenceId }) => referenceId));
    if (ids.size !== parsed.entries.length) fail('REFERENCE_INDEX_INVALID', '当前项目的参考图索引包含重复编号', { status: 409 });
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyIndex();
    if (error instanceof ReferenceImageStoreError) throw error;
    fail('REFERENCE_INDEX_INVALID', '当前项目的参考图索引无法读取', { status: 409, cause: error });
  }
};

const atomicWriteJson = async (target, value) => {
  const temporary = `${target}.tmp-${randomUUID()}`;
  const backup = `${target}.backup-${randomUUID()}`;
  let hasBackup = false;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    try {
      await rename(target, backup);
      hasBackup = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    try {
      await rename(temporary, target);
    } catch (error) {
      if (hasBackup) {
        await rename(backup, target);
        hasBackup = false;
      }
      throw error;
    }
    if (hasBackup) {
      await rm(backup, { force: true });
      hasBackup = false;
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
    if (hasBackup) {
      try {
        await rename(backup, target);
      } catch {}
    }
    await rm(backup, { force: true }).catch(() => {});
  }
};

const writeUpload = async (stream, target) => {
  const handle = await open(target, 'wx', 0o600);
  let size = 0;
  try {
    for await (const raw of stream) {
      const chunk = typeof raw === 'string' ? Buffer.from(raw) : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
      size += chunk.byteLength;
      if (size > MAX_REFERENCE_IMAGE_BYTES) fail('REFERENCE_IMAGE_TOO_LARGE', '单张参考图不能超过 20 MiB', { status: 413 });
      await handle.write(chunk);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (size === 0) fail('EMPTY_REFERENCE_IMAGE', '参考图片不能为空');
};

const publicEntry = (entry) => ({ ...entry });

export function createReferenceImageStore({
  resolveProjectRoot,
  materializeProjectRuntime,
  spawnImpl = nodeSpawn,
  environment = process.env,
  clock = () => new Date(),
  normalizeImageImpl = null
} = {}) {
  if (typeof resolveProjectRoot !== 'function' || typeof materializeProjectRuntime !== 'function') {
    throw new TypeError('resolveProjectRoot and materializeProjectRuntime must be functions');
  }
  const writes = new Map();
  const withProjectWrite = async (projectId, operation) => {
    const prior = writes.get(projectId) || Promise.resolve();
    const current = prior.catch(() => {}).then(operation);
    writes.set(projectId, current);
    try {
      return await current;
    } finally {
      if (writes.get(projectId) === current) writes.delete(projectId);
    }
  };

  const getContext = async (projectId, { materialize = false } = {}) => {
    if (materialize) await materializeProjectRuntime({ projectId });
    const projectRoot = await canonicalProjectRoot(rootFromResolution(await resolveProjectRoot(projectId)));
    const cacheRoot = join(projectRoot, 'cache');
    await assertSafePath(projectRoot, cacheRoot, { mustExist: true });
    const storeRoot = join(cacheRoot, '内置参考图');
    const indexPath = join(cacheRoot, '提示词参考图索引.json');
    await assertSafePath(projectRoot, storeRoot);
    await assertSafePath(projectRoot, indexPath);
    await mkdir(storeRoot, { recursive: true });
    await assertSafePath(projectRoot, storeRoot, { mustExist: true });
    return { projectRoot, cacheRoot, storeRoot, indexPath };
  };

  const importImage = ({ projectId, styleId, sheetName, filename, stream }) => withProjectWrite(projectId, async () => {
    const style = validateStyle(styleId);
    const sheet = validateSheet(sheetName);
    const sourceName = safeSourceName(filename);
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') fail('INVALID_REFERENCE_BODY', '参考图上传内容不可读取');
    const context = await getContext(projectId, { materialize: true });
    const targetRoot = join(context.storeRoot, style, sheet);
    await assertSafePath(context.projectRoot, targetRoot);
    await mkdir(targetRoot, { recursive: true });
    await assertSafePath(context.projectRoot, targetRoot, { mustExist: true });
    const uploadPath = join(targetRoot, `.upload-${randomUUID()}${extname(sourceName).toLowerCase()}`);
    const normalizedPath = join(targetRoot, `.normalized-${randomUUID()}.png`);
    try {
      await writeUpload(stream, uploadPath);
      if (typeof normalizeImageImpl === 'function') {
        await normalizeImageImpl({ source: uploadPath, destination: normalizedPath, projectRoot: context.projectRoot });
      } else {
        const pythonRunner = join(context.projectRoot, 'scripts', 'commands', 'python.ps1');
        const normalizer = join(context.projectRoot, 'scripts', 'pipeline', 'normalize_reference_image.py');
        await assertSafePath(context.projectRoot, pythonRunner, { mustExist: true, file: true });
        await assertSafePath(context.projectRoot, normalizer, { mustExist: true, file: true });
        await runFixedCommand({
          executable: 'powershell.exe',
          arguments: [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', pythonRunner,
            normalizer, uploadPath, normalizedPath, String(MAX_REFERENCE_IMAGE_BYTES), String(MAX_REFERENCE_IMAGE_PIXELS)
          ],
          cwd: context.projectRoot,
          spawnImpl,
          environment
        });
        const nodeRunner = join(context.projectRoot, 'scripts', 'commands', 'node.ps1');
        const validator = join(context.projectRoot, 'scripts', 'pipeline', 'validate_reference_image.mjs');
        await runFixedCommand({
          executable: 'powershell.exe',
          arguments: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', nodeRunner, validator, normalizedPath],
          cwd: context.projectRoot,
          spawnImpl,
          environment
        });
      }
      const bytes = await readFile(normalizedPath);
      const digest = createHash('sha256').update(bytes).digest('hex');
      const referenceId = referenceIdFrom(style, sheet, digest);
      const finalPath = join(targetRoot, `${digest}.png`);
      const relativePath = relative(context.projectRoot, finalPath).split(sep).join('/');
      if (!isInside(context.projectRoot, finalPath)) fail('REFERENCE_PATH_UNSAFE', '参考图目标路径不安全', { status: 409 });
      try {
        await rename(normalizedPath, finalPath);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      const finalBytes = await readFile(finalPath);
      const finalDigest = createHash('sha256').update(finalBytes).digest('hex');
      if (finalDigest !== digest) fail('REFERENCE_IMAGE_CHANGED', '参考图在保存期间发生变化', { status: 409 });
      const info = await stat(finalPath);
      const index = await readIndex(context.indexPath);
      const existing = index.entries.find((entry) => entry.referenceId === referenceId);
      const entry = existing || {
        referenceId,
        styleId: style,
        sheetName: sheet,
        path: relativePath,
        sourceName,
        size: info.size,
        sha256: digest,
        createdAt: clock().toISOString()
      };
      if (!existing) {
        const sheetCount = index.entries.filter((candidate) => candidate.styleId === style && candidate.sheetName === sheet).length;
        if (sheetCount >= 16) fail('REFERENCE_LIMIT_REACHED', '每个风格和资产类别最多保存 16 张参考图', { status: 409 });
        index.entries.push(entry);
        index.entries.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.referenceId.localeCompare(right.referenceId));
        await atomicWriteJson(context.indexPath, index);
      }
      return publicEntry(entry);
    } finally {
      await rm(uploadPath, { force: true }).catch(() => {});
      await rm(normalizedPath, { force: true }).catch(() => {});
    }
  });

  const listImages = async ({ projectId, styleId = null, sheetName = null } = {}) => {
    if (styleId !== null) validateStyle(styleId);
    if (sheetName !== null) validateSheet(sheetName);
    const context = await getContext(projectId);
    const index = await readIndex(context.indexPath);
    return index.entries
      .filter((entry) => (styleId === null || entry.styleId === styleId) && (sheetName === null || entry.sheetName === sheetName))
      .map(publicEntry);
  };

  const removeImage = ({ projectId, referenceId }) => withProjectWrite(projectId, async () => {
    const id = validateReferenceId(referenceId);
    const context = await getContext(projectId);
    const index = await readIndex(context.indexPath);
    const entry = index.entries.find((candidate) => candidate.referenceId === id);
    if (!entry) fail('REFERENCE_NOT_FOUND', '参考图不存在', { status: 404 });
    const target = resolve(context.projectRoot, entry.path);
    await assertSafePath(context.projectRoot, target, { mustExist: true, file: true });
    index.entries = index.entries.filter((candidate) => candidate.referenceId !== id);
    await atomicWriteJson(context.indexPath, index);
    const stillUsed = index.entries.some((candidate) => candidate.path === entry.path);
    if (!stillUsed) {
      await rm(target, { force: true });
    }
    return { referenceId: id, removed: true };
  });

  const readImage = async ({ projectId, referenceId }) => {
    const id = validateReferenceId(referenceId);
    const context = await getContext(projectId);
    const index = await readIndex(context.indexPath);
    const entry = index.entries.find((candidate) => candidate.referenceId === id);
    if (!entry) fail('REFERENCE_NOT_FOUND', '参考图不存在', { status: 404 });
    const target = resolve(context.projectRoot, entry.path);
    await assertSafePath(context.projectRoot, target, { mustExist: true, file: true });
    const canonical = await realpath(target);
    if (!isInside(context.projectRoot, canonical) || !samePath(canonical, target)) fail('REFERENCE_PATH_UNSAFE', '参考图路径不安全', { status: 409 });
    const bytes = await readFile(canonical);
    if (bytes.length !== entry.size || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      fail('REFERENCE_IMAGE_CHANGED', '参考图内容校验失败', { status: 409 });
    }
    return { entry: publicEntry(entry), bytes };
  };

  return Object.freeze({ importImage, listImages, removeImage, readImage });
}
