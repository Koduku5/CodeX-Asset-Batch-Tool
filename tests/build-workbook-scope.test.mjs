import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const scriptPath = path.resolve('engine/scripts/pipeline/build_workbook.mjs');

const runBuilder = (root, extraArguments = []) => new Promise((resolvePromise) => {
  const child = spawn(process.execPath, [scriptPath, root, ...extraArguments], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('close', (exitCode) => resolvePromise({ exitCode, stdout, stderr }));
});

const makeRoot = async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ka-workbook-scope-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(path.join(root, 'cache'), { recursive: true }),
    mkdir(path.join(root, '输出'), { recursive: true })
  ]);
  return root;
};

const scopeReceipt = (mode) => ({
  version: 1,
  mode,
  episodeStart: mode === 'full' ? null : 1,
  episodeEnd: mode === 'full' ? null : 3,
  assetTypes: mode === 'full'
    ? ['characters', 'creatures', 'extras', 'scenes', 'props']
    : ['characters', 'scenes'],
  sourceFingerprint: 'a'.repeat(64),
  validationFingerprint: 'b'.repeat(64),
  workbookSha256: 'c'.repeat(64),
  updatedAt: '2026-08-05T00:00:00.000Z'
});

test('an existing full workbook can never be shrunk to a scoped workbook', async (context) => {
  const root = await makeRoot(context);
  await Promise.all([
    writeFile(path.join(root, '输出', '剧本资产制表.xlsx'), 'existing full workbook'),
    writeFile(path.join(root, 'cache', '资产表范围.json'), `${JSON.stringify(scopeReceipt('full'))}\n`)
  ]);
  const result = await runBuilder(root, [
    '--episode-start=1', '--episode-end=3', '--asset-types=characters,scenes'
  ]);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /全剧资产表已经形成，不允许缩回局部表/u);
});

test('a workbook without a trustworthy scope receipt fails closed for scoped rebuilds', async (context) => {
  const root = await makeRoot(context);
  await writeFile(path.join(root, '输出', '剧本资产制表.xlsx'), 'legacy workbook');
  const result = await runBuilder(root, [
    '--episode-start=4', '--episode-end=6', '--asset-types=props'
  ]);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /现有资产表状态不完整/u);
});

test('scoped workbook arguments require one valid inclusive range and fixed asset types', async (context) => {
  const root = await makeRoot(context);
  const result = await runBuilder(root, [
    '--episode-start=5', '--episode-end=2', '--asset-types=characters,unknown'
  ]);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /有效的闭区间集数/u);
});

test('an unresolved pending asset blocks workbook generation before validation', async (context) => {
  const root = await makeRoot(context);
  await writeFile(path.join(root, 'cache', '待确认记录.json'), `${JSON.stringify([{
    pendingId: 'PENDING-CHAR-test',
    status: 'pending',
    candidate: '待确认角色'
  }])}\n`);
  const result = await runBuilder(root);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /仍有 1 项资产尚未完成人工确认与正式纳入/u);
});
