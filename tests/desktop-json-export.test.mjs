import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (filename) => readFile(path.join(root, filename), 'utf8');

test('desktop JSON export stays on the native RPC path with bounded strict input', async () => {
  const bridge = await read('desktop/PromptStudio.Desktop/DesktopRpcBridge.cs');
  const bridgeContracts = await read('desktop/PromptStudio.Desktop/DesktopRpcBridge.Contracts.cs');
  const bridgeSource = `${bridge}\n${bridgeContracts}`;

  assert.match(bridgeSource, /"saveJsonFile"\s*=>\s*await SaveJsonFileAsync/u);
  assert.match(bridgeSource, /property\.Name is not \("suggestedName" or "jsonText"\)/u);
  assert.match(bridgeSource, /MaxJsonTextBytes = 4 \* 1024 \* 1024/u);
  assert.match(bridgeSource, /MaxControlMessageBytes = 16 \* 1024/u);
  assert.match(bridgeSource, /MaxJsonExportMessageBytes = \(MaxJsonTextBytes \* 2\) \+ \(64 \* 1024\)/u);
  assert.match(bridgeSource, /method is not \("saveJsonFile" or "startApiBatch"\) && messageBytes > MaxControlMessageBytes/u);
  assert.match(bridgeSource, /StrictUtf8\.GetByteCount\(jsonText\)/u);
  assert.match(bridgeSource, /JsonDocument\.Parse\(jsonText/u);
  assert.match(bridgeSource, /Path\.GetFileName\(suggestedName\)/u);
  assert.match(bridgeSource, /Path\.GetExtension\(suggestedName\), "\.json"/u);
  assert.match(bridgeSource, /ReservedFileNamePattern/u);
});

test('WPF JSON export always cancels WebView downloads and reveals only the selected basename', async () => {
  const window = await read('desktop/PromptStudio.Desktop/MainWindow.cs');
  const bridgeScript = await read('desktop/PromptStudio.Desktop/MainWindow.BridgeScript.cs');
  const windowSource = `${window}\n${bridgeScript}`;

  assert.match(windowSource, /core\.DownloadStarting \+= \(_, args\) => args\.Cancel = true/u);
  assert.match(windowSource, /new SaveFileDialog/u);
  assert.match(windowSource, /OverwritePrompt = true/u);
  assert.match(windowSource, /ValidateNames = true/u);
  assert.match(windowSource, /File\.WriteAllTextAsync\(selectedPath, jsonText, JsonFileEncoding/u);
  assert.match(windowSource, /return new \{ saved = false \}/u);
  assert.match(windowSource, /saved = true, fileName = Path\.GetFileName\(selectedPath\)/u);
  assert.match(windowSource, /saveJsonFile: input => call\('saveJsonFile', input, 300000\)/u);
  assert.doesNotMatch(windowSource, /DownloadStarting[\s\S]{0,120}args\.Cancel = false/u);
});
