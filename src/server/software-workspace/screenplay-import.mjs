import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { fail, sanitizeScreenplayFilename } from './contracts.mjs';
import { assertPathInside, assertSafeTargetChain, lstatOrNull } from './path-safety.mjs';

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

export const prepareScreenplayImport = ({ filename, buffer, stream, overwrite = false } = {}) => {
  if (typeof overwrite !== 'boolean') fail('INVALID_OVERWRITE_OPTION', 'overwrite 必须是布尔值');
  const hasBuffer = buffer !== undefined;
  const hasStream = stream !== undefined;
  if (hasBuffer === hasStream) fail('INVALID_UPLOAD_BODY', 'buffer 和 stream 必须且只能提供一个');
  if (hasBuffer && !(buffer instanceof Uint8Array)) {
    fail('INVALID_UPLOAD_BODY', 'buffer 必须是 Buffer 或 Uint8Array');
  }
  return Object.freeze({
    safeFilename: sanitizeScreenplayFilename(filename),
    buffer,
    stream,
    overwrite,
    hasBuffer
  });
};

export const storeScreenplay = async ({
  softwareRoot,
  projectId,
  screenplayRoot,
  maxScreenplayBytes,
  request
}) => {
  const { safeFilename, buffer, stream, overwrite, hasBuffer } = request;
  await assertSafeTargetChain(softwareRoot, screenplayRoot, `项目 ${projectId}/剧本`);
  const finalPath = join(screenplayRoot, safeFilename);
  assertPathInside(softwareRoot, finalPath, '剧本目标文件');
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
      if (size > maxScreenplayBytes) {
        fail('SCREENPLAY_TOO_LARGE', `单个剧本不能超过 ${maxScreenplayBytes} 字节`);
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
};
