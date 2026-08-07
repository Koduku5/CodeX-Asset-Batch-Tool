import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createStageTimingService,
  StageTimingServiceError,
  STAGE_TIMING_FILENAME
} from '../src/server/stage-timing-service.mjs';

const makeRoot = async () => mkdtemp(path.join(os.tmpdir(), 'ka-stage-timing-'));

test('stage timing service persists one readable project Cache file and restores it', async (context) => {
  const root = await makeRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const service = createStageTimingService({
    resolveProjectRoot: async () => root,
    clock: () => new Date('2026-08-07T12:00:00.000Z')
  });

  assert.deepEqual(await service.read({ projectId: 'project-alpha' }), {
    version: 1,
    projectId: 'project-alpha',
    stages: {}
  });
  const saved = await service.save({
    projectId: 'project-alpha',
    stages: { analysis: 5673, 'world-overview': 473 }
  });
  assert.deepEqual(saved.stages, { analysis: 5673, 'world-overview': 473 });
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'cache', STAGE_TIMING_FILENAME), 'utf8')), {
    version: 1,
    updatedAt: '2026-08-07T12:00:00.000Z',
    stages: { analysis: 5673, 'world-overview': 473 }
  });
  assert.deepEqual((await service.read({ projectId: 'project-alpha' })).stages, {
    analysis: 5673,
    'world-overview': 473
  });
});

test('stage timing service rejects unknown stages and unsafe Cache files', async (context) => {
  const root = await makeRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const service = createStageTimingService({ resolveProjectRoot: async () => root });

  assert.throws(
    () => service.save({ projectId: 'project-alpha', stages: { invented: 1 } }),
    (error) => error instanceof StageTimingServiceError && error.code === 'INVALID_STAGE_TIMINGS'
  );
  await mkdir(path.join(root, 'cache'), { recursive: true });
  await writeFile(path.join(root, 'cache', STAGE_TIMING_FILENAME), '{broken', 'utf8');
  await assert.rejects(
    service.read({ projectId: 'project-alpha' }),
    (error) => error instanceof StageTimingServiceError && error.code === 'STAGE_TIMING_INVALID'
  );
});
