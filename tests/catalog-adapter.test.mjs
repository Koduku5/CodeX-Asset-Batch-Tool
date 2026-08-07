import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CatalogAdapterError,
  CatalogResolverAdapter,
  deriveResolutionReadiness,
  makeRouteTrace,
  validateCatalogResult
} from '../src/ui/services/catalog-adapter.mjs';
import { createPrototypeServer } from '../src/server/server.mjs';

const postJson = (url, value) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value)
});

test('software bridge exposes the real writable Prompt Catalog and resolver', async (context) => {
  const softwareRoot = await mkdtemp(join(tmpdir(), 'ka-catalog-adapter-'));
  const server = createPrototypeServer({ softwareRoot });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(softwareRoot, { recursive: true, force: true });
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const adapter = new CatalogResolverAdapter({
    statusEndpoint: `${baseUrl}/api/prompt/status`,
    resolveEndpoint: `${baseUrl}/api/prompt/resolve`
  });

  const status = await adapter.getStatus();
  assert.equal(status.valid, true);
  assert.equal(status.version, 1);
  assert.equal(status.baseRouteCount, 15);
  assert.equal(status.readOnly, false);
  assert.match(status.catalogFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(status.catalogSummary.baseRoutes.length, 15);
  assert.deepEqual(status.catalogSummary.modifierOperations, ['replaceWith', 'prepend', 'set', 'append']);
  assert.equal(status.catalogSummary.referenceModifiers.length, 4);
  assert.equal(Array.isArray(status.catalogSummary.conditionModules), true);
  assert.deepEqual(Object.keys(status.catalogSummary).sort(), [
    'assets', 'baseRoutes', 'conditionModules', 'modifierOperations', 'referenceModifiers', 'styles'
  ]);

  const plain = await adapter.resolve({
    style: '二次元',
    asset: '道具',
    referenceMode: 'none',
    referenceCount: 0,
    productionNotes: '黄铜怀表，磨损金属与雕花表盖'
  });
  assert.equal(plain.source, 'catalog');
  assert.equal(plain.routeId, 'builtin.anime.prop');
  assert.equal(plain.activeFieldSchema, 'withoutInputImages');
  assert.equal(plain.promptFields.length, 11);
  assert.equal(plain.promptFields.some((field) => field.label === 'Input images'), false);
  assert.match(plain.fields['Primary request'], /黄铜怀表/);
  assert.deepEqual(makeRouteTrace(plain).slice(0, 2), ['request/anime/prop', 'base/builtin.anime.prop']);

  const [animeScene, cgScene] = await Promise.all([
    adapter.resolve({ style: '二次元', asset: '场景', referenceMode: 'none', referenceCount: 0 }),
    adapter.resolve({ style: 'CG', asset: '场景', referenceMode: 'none', referenceCount: 0 })
  ]);
  assert.deepEqual(animeScene.activeModifiers, ['reference.none']);
  assert.deepEqual(cgScene.activeModifiers, ['reference.none']);
  assert.deepEqual(animeScene.promptFields.map(({ label }) => label), cgScene.promptFields.map(({ label }) => label));
  assert.equal(animeScene.routeId, 'builtin.anime.scene');
  assert.equal(cgScene.routeId, 'builtin.cg.scene');

  const referenced = await adapter.resolve({
    style: 'CG',
    asset: '场景',
    referenceMode: 'style',
    referenceCount: 2,
    productionNotes: '废弃地下站台，中央通道保持开阔'
  });
  assert.equal(referenced.activeFieldSchema, 'withInputImages');
  assert.equal(referenced.promptFields.length, 12);
  assert.equal(referenced.promptFields[1].label, 'Input images');
  assert.deepEqual(referenced.activeModifiers, ['reference.style']);
  assert.equal(deriveResolutionReadiness(referenced).ready, true);

  const insufficient = await adapter.resolve({
    style: '二次元',
    asset: '道具',
    referenceMode: 'visual-consistency',
    referenceCount: 1
  });
  assert.deepEqual(deriveResolutionReadiness(insufficient), {
    ready: false,
    code: 'INSUFFICIENT_REFERENCE_IMAGES',
    message: '视觉风格统一至少需要 2 张参考图'
  });

  const placeholder = await adapter.resolve({ style: '真人', asset: '角色', referenceMode: 'none', referenceCount: 0 });
  assert.equal(placeholder.status, 'placeholder');
  assert.equal(deriveResolutionReadiness(placeholder).ready, false);

  const writeAttempt = await postJson(`${baseUrl}/api/prompt/resolve`, {
    style: '二次元', asset: '道具', referenceMode: 'none', referenceCount: 0, command: 'compile-legacy --write'
  });
  assert.equal(writeAttempt.status, 400);
  assert.equal((await writeAttempt.json()).error.code, 'INVALID_REQUEST');

  const unknownFieldAttempt = await postJson(`${baseUrl}/api/prompt/resolve`, {
    style: 'CG', asset: '场景', referenceMode: 'none', referenceCount: 0, retiredExtension: {}
  });
  assert.equal(unknownFieldAttempt.status, 400);
  assert.equal((await unknownFieldAttempt.json()).error.code, 'INVALID_REQUEST');

  const wrongMethod = await fetch(`${baseUrl}/api/prompt/resolve`);
  assert.equal(wrongMethod.status, 405);
  assert.equal((await wrongMethod.json()).error.code, 'METHOD_NOT_ALLOWED');

  const snapshotResponse = await fetch(`${baseUrl}/api/workbench/snapshot`);
  assert.equal(snapshotResponse.status, 200);
  const snapshotEnvelope = await snapshotResponse.json();
  assert.equal(snapshotEnvelope.ok, true);
  assert.equal(snapshotEnvelope.data.schemaVersion, 1);
  assert.deepEqual(snapshotEnvelope.data.pipeline.stages.map((stage) => stage.id), ['split', 'analysis', 'world-overview', 'asset-visual-specs', 'excel', 'generation']);
  const snapshotText = JSON.stringify(snapshotEnvelope);
  for (const forbidden of ['currentSessionToken', 'password', 'baseUrl', 'productionNotes', 'promptOverridesBySheet']) {
    assert.equal(snapshotText.includes(forbidden), false);
  }
  const snapshotWrite = await postJson(`${baseUrl}/api/workbench/snapshot`, { retry: true });
  assert.equal(snapshotWrite.status, 405);
  assert.equal((await snapshotWrite.json()).error.code, 'METHOD_NOT_ALLOWED');
});

test('adapter rejects malformed results and never silently invents a mock success', async () => {
  assert.throws(
    () => validateCatalogResult({ promptFields: [] }),
    (error) => error instanceof CatalogAdapterError && error.code === 'INVALID_RESPONSE'
  );
  const adapter = new CatalogResolverAdapter({
    resolveEndpoint: 'http://127.0.0.1.invalid/api/prompt/resolve',
    fetchImpl: async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'CATALOG_UNAVAILABLE', message: '测试中的 bridge 不可用' }
    }), { status: 503, headers: { 'content-type': 'application/json' } })
  });
  await assert.rejects(
    () => adapter.resolve({ style: '二次元', asset: '道具', referenceMode: 'none', referenceCount: 0 }),
    (error) => error instanceof CatalogAdapterError && error.code === 'CATALOG_UNAVAILABLE'
  );
});
