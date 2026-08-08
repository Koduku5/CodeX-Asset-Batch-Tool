import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (filename) => readFile(path.join(root, filename), 'utf8');

test('WPF keeps Prompt Studio in one bounded two-dimensional stage', async () => {
  const source = await read('desktop/PromptStudio.Desktop/MainWindow.Stage.cs');

  assert.match(source, /CalculateStageBounds\(/u);
  assert.match(source, /MonitorFromWindow/u);
  assert.match(source, /monitorInfo\.WorkArea/u);
  assert.match(source, /targetHeight = safeHeight/u);
  assert.match(source, /Math\.Clamp\(targetLeft/u);
  assert.match(source, /Math\.Clamp\(targetTop/u);
  assert.match(source, /SetWindowPos\(/u);
  assert.match(source, /original\.State == WindowState\.Maximized/u);
  assert.doesNotMatch(source, /new\s+Window\s*\(/u);
});

test('WPF stage RPC returns DIP geometry and restores native placement idempotently', async () => {
  const source = await read('desktop/PromptStudio.Desktop/MainWindow.Stage.cs');

  for (const field of [
    'originalWidth',
    'originalHeight',
    'windowWidth',
    'windowHeight',
    'expandedBy',
    'expandedHeight',
    'restored'
  ]) assert.match(source, new RegExp(`\\b${field}\\b`, 'u'));

  assert.match(source, /GetClientRect\(/u);
  assert.match(source, /GetDpiForWindow\(/u);
  assert.match(source, /GetWindowPlacement\(/u);
  assert.match(source, /SetWindowPlacement\(/u);
  assert.match(source, /if \(_stageWindowState is not null\)/u);
  assert.match(source, /if \(original is null\)/u);
});
