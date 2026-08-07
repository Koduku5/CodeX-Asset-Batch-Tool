import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CodexRuntimeConfigError,
  codexThreadRuntimeOptions,
  createCodexRuntimeConfigStore
} from '../src/server/codex-runtime-config.mjs';

test('software Codex model settings persist atomically and override the local CLI defaults', async (context) => {
  const softwareRoot = await mkdtemp(path.join(os.tmpdir(), 'ka-codex-runtime-config-'));
  context.after(() => rm(softwareRoot, { recursive: true, force: true }));
  const fallback = Object.freeze({
    model: 'gpt-5.6-sol', reasoningEffort: 'high', modelLabel: 'gpt-5.6-sol',
    reasoningEffortLabel: 'high', source: 'local-codex-config'
  });
  const createStore = () => createCodexRuntimeConfigStore({
    softwareRoot,
    readFallback: async () => fallback
  });

  assert.deepEqual(await createStore().get(), fallback);
  const saved = await createStore().update({ model: 'gpt-5.6-terra', reasoningEffort: 'xhigh' });
  assert.deepEqual(saved, {
    model: 'gpt-5.6-terra', reasoningEffort: 'xhigh', modelLabel: 'gpt-5.6-terra',
    reasoningEffortLabel: 'xhigh', source: 'software-settings'
  });
  assert.deepEqual(await createStore().get(), saved);
  assert.deepEqual(codexThreadRuntimeOptions(saved), {
    model: 'gpt-5.6-terra', modelReasoningEffort: 'xhigh'
  });
});

test('software Codex model settings reject unsupported SDK reasoning levels and extra fields', async (context) => {
  const softwareRoot = await mkdtemp(path.join(os.tmpdir(), 'ka-codex-runtime-invalid-'));
  context.after(() => rm(softwareRoot, { recursive: true, force: true }));
  const store = createCodexRuntimeConfigStore({ softwareRoot });

  await assert.rejects(
    store.update({ model: 'gpt-5.6-sol', reasoningEffort: 'max' }),
    (error) => error instanceof CodexRuntimeConfigError && error.code === 'INVALID_CODEX_RUNTIME_CONFIG'
  );
  await assert.rejects(
    store.update({ model: 'gpt-5.6-sol', reasoningEffort: 'high', privateOption: true }),
    (error) => error instanceof CodexRuntimeConfigError && error.code === 'INVALID_CODEX_RUNTIME_CONFIG'
  );
});
