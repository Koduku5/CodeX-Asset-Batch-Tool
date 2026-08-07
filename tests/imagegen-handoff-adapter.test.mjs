import assert from 'node:assert/strict';
import test from 'node:test';

import { ImagegenHandoffAdapter } from '../src/ui/services/imagegen-handoff-adapter.mjs';

const summary = {
  version: 1,
  projectId: 'project-a',
  status: 'ready',
  reasonCode: 'READY',
  message: '可以交给 Codex',
  queueEstablished: true,
  presetConfigured: true,
  counts: { total: 3, selected: 2, unselected: 1, pending: 2, completed: 0, failed: 0, active: 0 },
  quota: { limit: 5, claimed: 0, remaining: 5 },
  activeBackend: null
};

test('handoff adapter exposes a safe status over HTTP and uses only the native bridge for preparation', async () => {
  const calls = [];
  const adapter = new ImagegenHandoffAdapter({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, async json() { return { ok: true, data: summary }; } };
    },
    bridge: {
      async prepareBuiltinImagegen(input) {
        assert.deepEqual(input, { projectId: 'project-a' });
        return { ok: true, data: { projectId: 'project-a', copied: true, codexOpened: true } };
      }
    }
  });
  assert.equal((await adapter.getStatus({ projectId: 'project-a' })).status, 'ready');
  assert.deepEqual(calls.map(({ url, init }) => [url, init.method]), [['/api/projects/project-a/imagegen-handoff', 'GET']]);
  assert.deepEqual(await adapter.prepare({ projectId: 'project-a' }), { projectId: 'project-a', copied: true, codexOpened: true });
});

test('handoff adapter refuses browser-only preparation and malformed or cross-project receipts', async () => {
  const browserOnly = new ImagegenHandoffAdapter({ bridge: null, fetchImpl: async () => ({ ok: true, async json() { return { ok: true, data: summary }; } }) });
  await assert.rejects(() => browserOnly.prepare({ projectId: 'project-a' }), { code: 'DESKTOP_REQUIRED' });
  const crossed = new ImagegenHandoffAdapter({
    fetchImpl: async () => ({ ok: true, async json() { return { ok: true, data: { ...summary, projectId: 'project-b' } }; } })
  });
  await assert.rejects(() => crossed.getStatus({ projectId: 'project-a' }), { code: 'PROJECT_MISMATCH' });
  await assert.rejects(() => browserOnly.getStatus({ projectId: '../escape' }), { code: 'INVALID_PROJECT_ID' });
});
