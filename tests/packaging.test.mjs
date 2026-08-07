import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFile(path.join(root, relativePath), 'utf8');

test('release build is self-contained and installs only production dependencies', async () => {
  const release = await read('packaging/build-release.ps1');
  const sidecar = JSON.parse(await read('packaging/sidecar/package.json'));

  assert.match(release, /dotnet publish[\s\S]*--self-contained true/u);
  assert.match(release, /npm\.cmd ci --omit=dev/u);
  assert.match(release, /runtime\\node/u);
  assert.match(release, /release-manifest\.json/u);
  assert.match(release, /Release directory is missing required file/u);
  assert.match(release, /\$files\.Count -lt 100/u);
  assert.match(release, /Where-Object \{ \$_\.Extension -in/u);
  assert.doesNotMatch(release, /-Include \*\.pdb,\*\.xml/u);
  assert.deepEqual(Object.keys(sidecar.dependencies), ['@openai/codex-sdk']);
  assert.equal(sidecar.devDependencies, undefined);
});

test('installer uses a stable identity, supports upgrade, and preserves workspace by default', async () => {
  const installer = await read('packaging/installer.iss');

  assert.match(installer, /AppId=\{\{8A203E5B-7C41-4BA3-A3D9-E69B3109429E\}/u);
  assert.match(installer, /CloseApplications=yes/u);
  assert.match(installer, /MicrosoftEdgeWebview2Setup\.exe/u);
  assert.match(installer, /DirExists\(WorkspacePath\)[\s\S]*MB_YESNO/u);
  assert.match(installer, /MB_YESNO or MB_DEFBUTTON2/u);
  assert.match(installer, /not UninstallSilent/u);
  assert.doesNotMatch(installer, /\[UninstallDelete\][\s\S]*workspace/iu);
  assert.doesNotMatch(installer, /Source:.*workspace/iu);
});

test('installer build verifies prerequisites and emits a checksum', async () => {
  const build = await read('packaging/build-installer.ps1');

  assert.match(build, /Get-AuthenticodeSignature/u);
  assert.match(build, /SignerCertificate\.Subject -notmatch 'Microsoft'/u);
  assert.match(build, /SHA256SUMS\.txt/u);
});
