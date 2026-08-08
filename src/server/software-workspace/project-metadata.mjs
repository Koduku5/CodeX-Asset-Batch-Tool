import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SOFTWARE_WORKSPACE_SCHEMA_VERSION, fail, validateDisplayName } from './contracts.mjs';
import { assertPathInside, assertPlainExistingEntry, assertSafeTargetChain } from './path-safety.mjs';

export const readProjectMetadata = async (projectRoot, expectedProjectId, maximumDisplayNameLength) => {
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

export const writeProjectMetadataAtomically = async (softwareRoot, projectRoot, metadata) => {
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

export const toPublicProject = (metadata, projectRoot) => Object.freeze({
  ...metadata,
  projectRoot,
  screenplayRoot: join(projectRoot, '剧本'),
  cacheRoot: join(projectRoot, 'cache'),
  outputRoot: join(projectRoot, '输出')
});
