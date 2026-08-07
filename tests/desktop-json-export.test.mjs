import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (filename) => readFile(path.join(root, filename), 'utf8');

test('desktop JSON export stays on the native RPC path with bounded strict input', async () => {
  const bridge = await read('desktop/PromptStudio.Desktop/DesktopRpcBridge.cs');

  assert.match(bridge, /"saveJsonFile"\s*=>\s*await SaveJsonFileAsync/u);
  assert.match(bridge, /property\.Name is not \("suggestedName" or "jsonText"\)/u);
  assert.match(bridge, /MaxJsonTextBytes = 4 \* 1024 \* 1024/u);
  assert.match(bridge, /MaxControlMessageBytes = 16 \* 1024/u);
  assert.match(bridge, /MaxJsonExportMessageBytes = \(MaxJsonTextBytes \* 2\) \+ \(64 \* 1024\)/u);
  assert.match(bridge, /method is not \("saveJsonFile" or "startApiBatch"\) && messageBytes > MaxControlMessageBytes/u);
  assert.match(bridge, /StrictUtf8\.GetByteCount\(jsonText\)/u);
  assert.match(bridge, /JsonDocument\.Parse\(jsonText/u);
  assert.match(bridge, /Path\.GetFileName\(suggestedName\)/u);
  assert.match(bridge, /Path\.GetExtension\(suggestedName\), "\.json"/u);
  assert.match(bridge, /ReservedFileNamePattern/u);
});

test('WPF JSON export always cancels WebView downloads and reveals only the selected basename', async () => {
  const window = await read('desktop/PromptStudio.Desktop/MainWindow.cs');

  assert.match(window, /core\.DownloadStarting \+= \(_, args\) => args\.Cancel = true/u);
  assert.match(window, /new SaveFileDialog/u);
  assert.match(window, /OverwritePrompt = true/u);
  assert.match(window, /ValidateNames = true/u);
  assert.match(window, /File\.WriteAllTextAsync\(selectedPath, jsonText, JsonFileEncoding/u);
  assert.match(window, /return new \{ saved = false \}/u);
  assert.match(window, /saved = true, fileName = Path\.GetFileName\(selectedPath\)/u);
  assert.match(window, /saveJsonFile: input => call\('saveJsonFile', input, 300000\)/u);
  assert.doesNotMatch(window, /DownloadStarting[\s\S]{0,120}args\.Cancel = false/u);
});
