import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  createReferenceImageStore,
  MAX_REFERENCE_IMAGE_BYTES,
  ReferenceImageStoreError
} from '../src/server/reference-image-store.mjs';

const makeFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'ka-reference-store-'));
  const projects = new Map();
  for (const id of ['project-a', 'project-b']) {
    const projectRoot = join(root, id);
    await mkdir(join(projectRoot, 'cache'), { recursive: true });
    projects.set(id, projectRoot);
  }
  const materialized = [];
  const store = createReferenceImageStore({
    resolveProjectRoot: async (projectId) => ({ rootPath: projects.get(projectId) }),
    materializeProjectRuntime: async ({ projectId }) => { materialized.push(projectId); },
    normalizeImageImpl: async ({ source, destination }) => writeFile(destination, await readFile(source)),
    clock: () => new Date('2026-08-04T00:00:00.000Z')
  });
  return { root, projects, materialized, store };
};

test('reference images are normalized into each project cache and exposed only by safe metadata', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const bytes = Buffer.from('normalized-png-fixture');
  const first = await fixture.store.importImage({
    projectId: 'project-a',
    styleId: 'cg',
    sheetName: '场景',
    filename: '树林.webp',
    stream: Readable.from([bytes])
  });
  assert.match(first.referenceId, /^ref-[a-f0-9]{64}$/u);
  assert.equal(first.path.startsWith('cache/内置参考图/cg/场景/'), true);
  assert.equal(first.path.endsWith('.png'), true);
  assert.equal(first.sourceName, '树林.webp');
  assert.equal(Object.values(first).some((value) => typeof value === 'string' && value.includes(fixture.root)), false);
  assert.deepEqual(fixture.materialized, ['project-a']);

  const duplicate = await fixture.store.importImage({
    projectId: 'project-a', styleId: 'cg', sheetName: '场景', filename: '同图.jpg', stream: Readable.from([bytes])
  });
  assert.equal(duplicate.referenceId, first.referenceId);
  assert.equal((await fixture.store.listImages({ projectId: 'project-a' })).length, 1);

  const otherSheet = await fixture.store.importImage({
    projectId: 'project-a', styleId: 'cg', sheetName: '道具', filename: '同图.png', stream: Readable.from([bytes])
  });
  assert.notEqual(otherSheet.referenceId, first.referenceId);
  assert.equal((await fixture.store.listImages({ projectId: 'project-b' })).length, 0);

  const content = await fixture.store.readImage({ projectId: 'project-a', referenceId: first.referenceId });
  assert.deepEqual(content.bytes, bytes);
  assert.equal(content.entry.referenceId, first.referenceId);

  assert.deepEqual(
    await fixture.store.removeImage({ projectId: 'project-a', referenceId: first.referenceId }),
    { referenceId: first.referenceId, removed: true }
  );
  assert.equal((await fixture.store.listImages({ projectId: 'project-a', sheetName: '场景' })).length, 0);
  assert.equal((await fixture.store.listImages({ projectId: 'project-a', sheetName: '道具' })).length, 1);
});

test('reference store rejects untrusted selectors, names, ids and oversized bodies', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const expectCode = async (promise, code) => assert.rejects(promise, (error) => {
    assert.equal(error instanceof ReferenceImageStoreError, true);
    assert.equal(error.code, code);
    return true;
  });
  await expectCode(fixture.store.importImage({
    projectId: 'project-a', styleId: '../cg', sheetName: '场景', filename: 'a.png', stream: Readable.from(['x'])
  }), 'INVALID_REFERENCE_STYLE');
  await expectCode(fixture.store.importImage({
    projectId: 'project-a', styleId: 'cg', sheetName: '../场景', filename: 'a.png', stream: Readable.from(['x'])
  }), 'INVALID_REFERENCE_SHEET');
  await expectCode(fixture.store.importImage({
    projectId: 'project-a', styleId: 'cg', sheetName: '场景', filename: '../a.png', stream: Readable.from(['x'])
  }), 'INVALID_REFERENCE_FILENAME');
  await expectCode(fixture.store.importImage({
    projectId: 'project-a', styleId: 'cg', sheetName: '场景', filename: 'a.svg', stream: Readable.from(['x'])
  }), 'UNSUPPORTED_REFERENCE_IMAGE');
  await expectCode(fixture.store.importImage({
    projectId: 'project-a', styleId: 'cg', sheetName: '场景', filename: 'a.png',
    stream: Readable.from([Buffer.alloc(MAX_REFERENCE_IMAGE_BYTES), Buffer.from('x')])
  }), 'REFERENCE_IMAGE_TOO_LARGE');
  await expectCode(fixture.store.readImage({ projectId: 'project-a', referenceId: '../secret' }), 'INVALID_REFERENCE_ID');
});
