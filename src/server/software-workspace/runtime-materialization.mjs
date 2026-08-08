import { randomUUID } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { fail } from './contracts.mjs';
import { assertPathInside, assertSafeTargetChain, lstatOrNull } from './path-safety.mjs';
import {
  buildTreeManifest,
  copySafeTree,
  sameTreeManifest
} from './shared-assets.mjs';


const treeLimits = ({ maxRuntimeFiles, maxRuntimeBytes }) => ({
  files: 0,
  bytes: 0,
  maxFiles: maxRuntimeFiles,
  maxBytes: maxRuntimeBytes
});

export async function replaceDirectory(context, sourceRoot, targetRoot, label, {
  expectedTargetManifest = null,
  sourceManifest = null
} = {}) {
  const { softwareRoot } = context;
  assertPathInside(softwareRoot, targetRoot, label);
  await assertSafeTargetChain(softwareRoot, dirname(targetRoot), `${label} 的父目录`);
  const stageRoot = `${targetRoot}.stage-${randomUUID()}`;
  const backupRoot = `${targetRoot}.backup-${randomUUID()}`;
  let hasBackup = false;
  try {
    await copySafeTree(sourceRoot, stageRoot, label, treeLimits(context));
    if (sourceManifest) {
      const stagedSourceManifest = await buildTreeManifest(
        stageRoot,
        `${label} 临时目录`,
        treeLimits(context)
      );
      if (!sameTreeManifest(stagedSourceManifest, sourceManifest)) {
        fail('SOURCE_CHANGED_DURING_COPY', `${label} 的来源在复制期间发生变化`);
      }
    }
    const current = await lstatOrNull(targetRoot);
    if (current === null && expectedTargetManifest) return false;
    if (current !== null) {
      await assertSafeTargetChain(softwareRoot, targetRoot, label);
      if (!current.isDirectory()) fail('INVALID_RUNTIME_DIRECTORY', `${label} 不是普通目录`);
      await rename(targetRoot, backupRoot);
      hasBackup = true;
      if (expectedTargetManifest) {
        const actualTargetManifest = await buildTreeManifest(
          backupRoot,
          `${label} 待替换目录`,
          treeLimits(context)
        );
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

async function targetManifest(context, targetRoot, label) {
  const info = await lstatOrNull(targetRoot);
  if (info === null) return null;
  await assertSafeTargetChain(context.softwareRoot, targetRoot, label);
  if (!info.isDirectory()) fail('INVALID_RUNTIME_DIRECTORY', `${label} 不是普通目录`);
  return buildTreeManifest(targetRoot, label, treeLimits(context));
}

export async function materializeProjectRuntime(context, project) {
  const { projectId, projectRoot } = project;
  const engineScriptsRoot = join(context.engineRoot, 'scripts');
  const scriptsSourceManifest = await buildTreeManifest(
    engineScriptsRoot,
    'engineRoot/scripts',
    treeLimits(context)
  );
  const assetsSourceManifest = await buildTreeManifest(
    context.sharedAssetsRoot,
    'sharedAssetsRoot',
    treeLimits(context)
  );
  const scriptsRoot = join(projectRoot, 'scripts');
  const assetsRoot = join(projectRoot, 'assets');

  const scriptsTargetManifest = await targetManifest(context, scriptsRoot, `项目 ${projectId}/scripts`);
  if (!sameTreeManifest(scriptsSourceManifest, scriptsTargetManifest)) {
    await replaceDirectory(context, engineScriptsRoot, scriptsRoot, `项目 ${projectId}/scripts`, {
      expectedTargetManifest: scriptsTargetManifest,
      sourceManifest: scriptsSourceManifest
    });
  }
  const assetsTargetManifest = await targetManifest(context, assetsRoot, `项目 ${projectId}/assets`);
  if (!sameTreeManifest(assetsSourceManifest, assetsTargetManifest)) {
    await replaceDirectory(context, context.sharedAssetsRoot, assetsRoot, `项目 ${projectId}/assets`, {
      expectedTargetManifest: assetsTargetManifest,
      sourceManifest: assetsSourceManifest
    });
  }
  return Object.freeze({ projectId, projectRoot, scriptsRoot, assetsRoot });
}
