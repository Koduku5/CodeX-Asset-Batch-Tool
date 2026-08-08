import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFile(path.join(root, relativePath), 'utf8');
const sourceExtensions = new Set(['.cs', '.js', '.mjs', '.ps1', '.py', '.ts', '.tsx']);

const countLines = (source) => {
  const normalized = source.replace(/\r\n?/gu, '\n');
  return normalized.endsWith('\n')
    ? normalized.slice(0, -1).split('\n').length
    : normalized.split('\n').length;
};

async function sourceFiles(relativeDirectory) {
  const directory = path.join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = path.join(relativeDirectory, entry.name).replaceAll('\\', '/');
    if (entry.isDirectory()) result.push(...await sourceFiles(relativePath));
    else if (sourceExtensions.has(path.extname(entry.name))) result.push(relativePath);
  }
  return result;
}

test('source modules stay below the reviewable implementation ceiling', async () => {
  const paths = [
    ...await sourceFiles('src'),
    ...await sourceFiles('engine/scripts'),
    ...await sourceFiles('desktop')
  ];
  const oversized = [];
  for (const relativePath of paths) {
    const lines = countLines(await read(relativePath));
    if (lines > 550) oversized.push(`${relativePath} (${lines})`);
  }
  assert.deepEqual(
    oversized,
    [],
    `modules above 550 lines must be split by responsibility: ${oversized.join(', ')}`
  );
});

test('public entries and compatibility facades remain thin', async () => {
  const ceilings = new Map([
    ['src/ui/App.tsx', 10],
    ['src/ui/features/workbench/workbench-app.tsx', 500],
    ['src/server/server.mjs', 360],
    ['src/server/software-workspace.mjs', 400],
    ['engine/scripts/lib/prompt_catalog.mjs', 60],
    ['engine/scripts/lib/pipeline_runtime.mjs', 120],
    ['engine/scripts/lib/pipeline_protocol.py', 60],
    ['engine/scripts/lib/api_batch/queue_runtime.py', 300],
    ['engine/scripts/lib/pending_asset_resolution.py', 320],
    ['engine/scripts/pipeline/extract_screenplay.py', 300],
    ['engine/scripts/pipeline/resolve_pending_asset.py', 100],
    ['engine/scripts/pipeline/validate_asset_records.py', 400],
    ['engine/scripts/commands/start_api_batch.ps1', 180],
    ['engine/scripts/commands/lib/api-batch-dialog.ps1', 450],
    ['desktop/PromptStudio.Desktop/MainWindow.cs', 220],
    ['desktop/PromptStudio.Desktop/DesktopRpcBridge.cs', 220]
  ]);
  for (const [relativePath, ceiling] of ceilings) {
    const lines = countLines(await read(relativePath));
    assert.ok(lines <= ceiling, `${relativePath} grew to ${lines} lines (ceiling: ${ceiling})`);
  }
});

test('domain partitions do not depend back on their configured facades', async () => {
  const forbiddenImports = new Map([
    ['engine/scripts/lib/api_batch/queue_validation.py', /api_batch\.queue_runtime/u],
    ['engine/scripts/lib/api_batch/queue_freshness.py', /api_batch\.queue_runtime/u],
    ['engine/scripts/lib/api_batch/item_state.py', /api_batch\.item_runner/u],
    ['engine/scripts/lib/pending_asset_contracts.py', /pending_asset_resolution/u],
    ['engine/scripts/lib/pending_asset_identity.py', /pending_asset_resolution/u],
    ['engine/scripts/lib/pending_asset_episode.py', /pending_asset_resolution/u],
    ['src/server/software-workspace/runtime-materialization.mjs', /software-workspace\.mjs/u],
    ['src/ui/features/workbench/workbench-shell.tsx', /workbench-app/u],
    ['src/ui/features/workbench/workbench-view-model.ts', /workbench-app/u]
  ]);
  for (const [relativePath, forbidden] of forbiddenImports) {
    assert.doesNotMatch(await read(relativePath), forbidden, `${relativePath} reverses its dependency direction`);
  }
});

test('composed entrypoints load every required partition in dependency order', async () => {
  const startApiBatch = await read('engine/scripts/commands/start_api_batch.ps1');
  const layoutIndex = startApiBatch.indexOf("api-batch-dialog-layout.ps1");
  const dialogIndex = startApiBatch.indexOf("api-batch-dialog.ps1");
  assert.ok(layoutIndex >= 0 && layoutIndex < dialogIndex, 'dialog layout must load before dialog events');

  const queueFacade = await read('engine/scripts/lib/api_batch/queue_runtime.py');
  assert.match(queueFacade, /from api_batch\.queue_freshness import/u);
  assert.match(queueFacade, /from api_batch\.queue_validation import/u);

  const pendingFacade = await read('engine/scripts/lib/pending_asset_resolution.py');
  assert.match(pendingFacade, /from pending_asset_contracts import/u);
  assert.match(pendingFacade, /from pending_asset_episode import/u);
  assert.match(pendingFacade, /from pending_asset_identity import/u);

  const workbench = await read('src/ui/features/workbench/workbench-app.tsx');
  assert.match(workbench, /from "@\/features\/workbench\/workbench-shell"/u);
  assert.match(workbench, /from "@\/features\/workbench\/workbench-view-model"/u);
});
