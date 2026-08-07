import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const queueBuilder = path.join(root, 'engine', 'scripts', 'pipeline', 'build_image_queue.mjs');
const imageAssets = path.join(root, 'engine', 'assets', '图片生成');
const sheets = ['角色', '生物', '群演', '场景', '道具'];

const writeJson = (target, value) => writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

test('image queue reads cumulative JSON directly and sorts by first requirement without Excel', async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'ka-json-queue-'));
  try {
    const cache = path.join(project, 'cache');
    const records = path.join(cache, '累计记录');
    const assets = path.join(project, 'assets', '图片生成');
    await Promise.all([
      mkdir(records, { recursive: true }),
      mkdir(assets, { recursive: true }),
      mkdir(path.join(project, '输出'), { recursive: true })
    ]);
    await Promise.all([
      copyFile(path.join(imageAssets, '出图路由.json'), path.join(assets, '出图路由.json')),
      copyFile(path.join(imageAssets, '内置imagegen字段.json'), path.join(assets, '内置imagegen字段.json')),
      writeJson(path.join(cache, '待确认记录.json'), []),
      writeJson(path.join(records, '角色记录.json'), [
        {
          assetId: 'CHAR-002-EP2', assetName: '后出现角色', productionNotes: '第二集角色制作说明',
          firstRequiredEpisode: 2, firstRequiredOrder: 1
        },
        {
          assetId: 'CHAR-001-EP1', assetName: '先出现角色', productionNotes: '第一集角色制作说明',
          firstRequiredEpisode: 1, firstRequiredOrder: 1
        }
      ]),
      writeJson(path.join(records, '生物记录.json'), [
        {
          assetId: 'CREATURE-001-EP1', assetName: '首只生物', productionNotes: '第一集生物制作说明',
          firstRequiredEpisode: 1, firstRequiredOrder: 1
        }
      ]),
      writeJson(path.join(records, '群演记录.json'), []),
      writeJson(path.join(records, '场景记录.json'), []),
      writeJson(path.join(records, '道具记录.json'), [])
    ]);

    const templates = Object.fromEntries(sheets.map((sheet) => [sheet, `${sheet}固定模板`]));
    await run(process.execPath, [queueBuilder, project, '--api-prompts-env'], {
      env: {
        ...process.env,
        KA_API_PROMPT_TEMPLATES_B64: Buffer.from(JSON.stringify(templates), 'utf8').toString('base64')
      },
      windowsHide: true
    });

    const queue = JSON.parse(await readFile(path.join(cache, '出图队列.json'), 'utf8'));
    assert.deepEqual(queue.items.map((item) => item.key), [
      '角色:CHAR-001-EP1',
      '角色:CHAR-002-EP2',
      '生物:CREATURE-001-EP1'
    ]);
    assert.equal(queue.items[0].productionNotes, '第一集角色制作说明');
    assert.equal(queue.items[0].prompt, '角色固定模板\n\n第一集角色制作说明');
    assert.equal(queue.version, 4);
    assert.equal(Object.hasOwn(queue, 'sourceWorkbook'), false);
    assert.equal(Object.hasOwn(queue, 'sourceWorkbookFingerprint'), false);
    assert.equal(queue.apiPromptBatch.version, 2);
    assert.equal(Object.hasOwn(queue.apiPromptBatch, 'sourceWorkbookFingerprint'), false);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
