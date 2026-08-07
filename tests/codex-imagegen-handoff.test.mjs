import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CodexImagegenHandoffError,
  createCodexImagegenHandoffService
} from '../src/server/codex-imagegen-handoff.mjs';

const SHEETS = ['角色', '生物', '群演', '场景', '道具'];
const hex = (character) => character.repeat(64);
const writeJson = (filename, value) => writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

const makePreset = () => ({
  version: 6,
  catalogFingerprint: hex('a'),
  routeFingerprintsBySheet: { 角色: hex('b') },
  confirmedAt: '2026-08-04T01:02:03.000Z',
  styleId: 'cg',
  generationLimit: 5,
  enabledSheets: ['角色'],
  referencesBySheet: Object.fromEntries(SHEETS.map((sheet) => [sheet, []])),
  referenceModeBySheet: Object.fromEntries(SHEETS.map((sheet) => [sheet, 'style'])),
  promptOverridesBySheet: Object.fromEntries(SHEETS.map((sheet) => [sheet, {
    routeMode: 'default',
    promptText: sheet === '角色' ? 'PRIVATE PROMPT sk-not-a-real-key' : ''
  }]))
});

const makeQueue = (preset) => ({
  version: 4,
  builtAt: '2026-08-04T01:03:00.000Z',
  routingConfig: 'assets/图片生成/出图路由.json',
  routingFingerprint: hex('d'),
  routingResourceFingerprints: {},
  eligibilityFingerprint: hex('e'),
  items: [{
    key: '角色:CHAR-0001',
    sheetName: '角色',
    rowNumber: 2,
    assetId: 'CHAR-0001',
    assetName: 'PRIVATE ASSET NAME',
    productionNotes: 'PRIVATE PRODUCTION NOTES OPENAI_API_KEY=must-not-leak',
    prompt: 'PRIVATE API PROMPT must-not-leak',
    outputPath: '输出/资产图/角色/CHAR-0001_PRIVATE.png',
    assetFingerprint: hex('f'),
    inputFingerprint: hex('1')
  }],
  builtinPromptBatch: structuredClone(preset)
});

const makeProgress = () => ({
  version: 3,
  routingFingerprint: hex('d'),
  items: {
    '角色:CHAR-0001': {
      attemptLedger: {
        builtin: {
          inputFingerprint: hex('2'),
          attempts: 0,
          lastError: '',
          updatedAt: ''
        }
      }
    }
  }
});

const makeFixture = async (context) => {
  const installationRoot = await mkdtemp(path.join(os.tmpdir(), 'ka-imagegen-handoff-'));
  context.after(() => rm(installationRoot, { recursive: true, force: true }));
  const builtinImagegenSkillPath = path.join(
    installationRoot,
    'runtime',
    'skills',
    'ka-builtin-imagegen',
    'SKILL.md'
  );
  await mkdir(path.dirname(builtinImagegenSkillPath), { recursive: true });
  await writeFile(
    builtinImagegenSkillPath,
    '# KA builtin ImageGen common skill\nRead the queue one item at a time.\n',
    'utf8'
  );
  const roots = new Map();
  for (const projectId of ['project-a', 'project-b']) {
    const projectRoot = path.join(installationRoot, 'projects', projectId);
    await mkdir(path.join(projectRoot, 'cache'), { recursive: true });
    roots.set(projectId, projectRoot);
  }
  const preset = makePreset();
  const queue = makeQueue(preset);
  const progress = makeProgress();
  await Promise.all([
    writeJson(path.join(roots.get('project-a'), 'cache', '内置提示词预设.json'), preset),
    writeJson(path.join(roots.get('project-a'), 'cache', '出图队列.json'), queue),
    writeJson(path.join(roots.get('project-a'), 'cache', '出图进度.json'), progress)
  ]);
  const service = createCodexImagegenHandoffService({
    softwareRoot: installationRoot,
    builtinImagegenSkillPath,
    resolveProjectRoot: async (projectId) => ({
      metadata: { projectId, storageMode: 'isolated-project' },
      rootPath: roots.get(projectId)
    })
  });
  return {
    installationRoot,
    builtinImagegenSkillPath,
    roots,
    preset,
    queue,
    progress,
    service
  };
};

test('the repository software-level ImageGen skill is accepted by the default software root', () => {
  const builtinImagegenSkillPath = path.resolve(
    'skills',
    'ka-builtin-imagegen',
    'SKILL.md'
  );
  const service = createCodexImagegenHandoffService({
    builtinImagegenSkillPath,
    resolveProjectRoot: async () => { throw new Error('not used by factory validation'); }
  });
  assert.equal(typeof service.getStatus, 'function');
  assert.equal(typeof service.createNativeBridgeHandoffText, 'function');
});

test('ready status is a bounded UI-safe summary and native handoff is read-only', async (context) => {
  const fixture = await makeFixture(context);
  const cacheRoot = path.join(fixture.roots.get('project-a'), 'cache');
  const beforeNames = await readdir(cacheRoot);
  const beforeFiles = Object.fromEntries(await Promise.all(beforeNames.map(async (name) => [
    name,
    await readFile(path.join(cacheRoot, name), 'utf8')
  ])));

  const summary = await fixture.service.getStatus({ projectId: 'project-a' });
  assert.deepEqual(summary, {
    version: 1,
    projectId: 'project-a',
    status: 'ready',
    reasonCode: 'READY',
    message: '项目已具备交给 Codex 执行单项内置出图的基本状态',
    queueEstablished: true,
    presetConfigured: true,
    counts: {
      total: 1,
      selected: 1,
      unselected: 0,
      pending: 1,
      completed: 0,
      failed: 0,
      active: 0
    },
    quota: { limit: 5, claimed: 0, remaining: 5 },
    activeBackend: null
  });
  const publicText = JSON.stringify(summary);
  for (const forbidden of [
    fixture.installationRoot,
    'PRIVATE PROMPT',
    'PRIVATE ASSET NAME',
    'PRIVATE PRODUCTION NOTES',
    'CHAR-0001',
    'must-not-leak',
    'OPENAI_API_KEY'
  ]) assert.equal(publicText.includes(forbidden), false);

  const handoff = await fixture.service.createNativeBridgeHandoffText({ projectId: 'project-a' });
  const canonicalRoot = await realpath(fixture.roots.get('project-a'));
  assert.equal(handoff.includes(JSON.stringify(canonicalRoot)), true);
  assert.equal(handoff.includes(JSON.stringify(path.resolve(fixture.builtinImagegenSkillPath))), true);
  assert.match(handoff, /^模式：dispatch/mu);
  assert.match(handoff, /只复用标题和独立任务目录名都精确匹配的 projectless 任务/u);
  assert.match(handoff, /独立任务目录名："ka-imagegen-project-a"/u);
  assert.match(handoff, /主出图任务标题："出图｜project-a"/u);
  assert.match(handoff, /<KA_IMAGEGEN_WORKER_PAYLOAD>[\s\S]*模式：worker/u);
  assert.match(handoff, /新建或复用一个用户可见出图任务/u);
  assert.match(handoff, /完整读取上述软件级 ka-builtin-imagegen\/SKILL\.md/u);
  assert.match(handoff, /项目目录不保存 Skill 副本/u);
  assert.equal(handoff.includes('项目快照 ./SKILL.md'), false);
  assert.match(handoff, /每次只通过 get_next_image_job\.mjs 原子领取一项/u);
  assert.match(handoff, /Codex 内置 image_gen/u);
  assert.match(handoff, /update_image_progress\.mjs/u);
  assert.match(handoff, /桌面宿主、\.NET bridge 和任何 SDK.*绝不能调用或模拟 image_gen/u);
  assert.equal(handoff.includes('ka-script-asset-batch安装包'), false);
  assert.equal(handoff.includes('自动化设定资产Agent'), false);
  for (const forbidden of [
    'PRIVATE PROMPT',
    'PRIVATE ASSET NAME',
    'PRIVATE PRODUCTION NOTES',
    'CHAR-0001',
    'must-not-leak',
    'OPENAI_API_KEY'
  ]) assert.equal(handoff.includes(forbidden), false);

  assert.deepEqual(await readdir(cacheRoot), beforeNames);
  for (const [name, contents] of Object.entries(beforeFiles)) {
    assert.equal(await readFile(path.join(cacheRoot, name), 'utf8'), contents);
  }
  assert.equal((await readdir(cacheRoot)).includes('.pipeline.lock'), false);
});

test('handoff is unavailable until a project queue and progress have been built', async (context) => {
  const fixture = await makeFixture(context);
  const projectRoot = fixture.roots.get('project-b');
  const summary = await fixture.service.getStatus({ projectId: 'project-b' });
  assert.equal(summary.status, 'blocked');
  assert.equal(summary.reasonCode, 'QUEUE_NOT_BUILT');
  assert.equal(summary.queueEstablished, false);
  assert.equal(JSON.stringify(summary).includes(projectRoot), false);

  await assert.rejects(
    fixture.service.createNativeBridgeHandoffText({ projectId: 'project-b' }),
    (error) => error instanceof CodexImagegenHandoffError
      && error.code === 'HANDOFF_NOT_READY'
      && !error.message.includes(projectRoot)
  );
});

test('an active builtin claim is summarized without exposing its key, token, pid or paths', async (context) => {
  const fixture = await makeFixture(context);
  const projectRoot = fixture.roots.get('project-a');
  const cacheRoot = path.join(projectRoot, 'cache');
  const progress = makeProgress();
  progress.items['角色:CHAR-0001'] = {
    status: 'generating',
    backend: 'builtin',
    attempts: 1,
    outputPath: '输出/资产图/角色/CHAR-0001_PRIVATE.png',
    error: '',
    updatedAt: '2026-08-04T01:04:00.000Z',
    inputFingerprint: hex('1'),
    assetFingerprint: hex('f'),
    builtinPromptFingerprint: hex('2'),
    builtinGenerationSession: fixture.preset.confirmedAt,
    attemptLedger: {}
  };
  await Promise.all([
    writeJson(path.join(cacheRoot, '出图进度.json'), progress),
    writeJson(path.join(cacheRoot, '.pipeline.lock'), {
      protocolVersion: 2,
      kind: 'image_generation',
      key: '角色:CHAR-0001',
      leaseMode: 'durable',
      processId: 54321,
      processStartTime: '2026-08-04T01:03:50.000Z',
      host: 'PRIVATE-HOST',
      token: 'PRIVATE-LOCK-TOKEN',
      createdAt: '2026-08-04T01:04:00.000Z',
      updatedAt: '2026-08-04T01:04:01.000Z'
    })
  ]);

  const summary = await fixture.service.getStatus({ projectId: 'project-a' });
  assert.equal(summary.status, 'active');
  assert.equal(summary.reasonCode, 'BUILTIN_ACTIVE');
  assert.equal(summary.activeBackend, 'builtin');
  assert.equal(summary.counts.active, 1);
  assert.deepEqual(summary.quota, { limit: 5, claimed: 1, remaining: 4 });
  const serialized = JSON.stringify(summary);
  for (const forbidden of [projectRoot, 'CHAR-0001', 'PRIVATE-LOCK-TOKEN', 'PRIVATE-HOST', '54321']) {
    assert.equal(serialized.includes(forbidden), false);
  }
  await assert.rejects(
    fixture.service.createNativeBridgeHandoffText({ projectId: 'project-a' }),
    (error) => error instanceof CodexImagegenHandoffError && error.code === 'HANDOFF_NOT_READY'
  );
});

test('preset drift, malformed JSON and path-like project ids all fail closed', async (context) => {
  const fixture = await makeFixture(context);
  const cacheRoot = path.join(fixture.roots.get('project-a'), 'cache');
  const changedPreset = makePreset();
  changedPreset.confirmedAt = '2026-08-04T02:00:00.000Z';
  await writeJson(path.join(cacheRoot, '内置提示词预设.json'), changedPreset);
  const drift = await fixture.service.getStatus({ projectId: 'project-a' });
  assert.equal(drift.status, 'blocked');
  assert.equal(drift.reasonCode, 'BATCH_OUT_OF_SYNC');

  await writeFile(path.join(cacheRoot, '出图队列.json'), '{"prompt":"PRIVATE",', 'utf8');
  await assert.rejects(
    fixture.service.getStatus({ projectId: 'project-a' }),
    (error) => error instanceof CodexImagegenHandoffError
      && error.code === 'STATE_INVALID'
      && !error.message.includes('PRIVATE')
      && !error.message.includes(cacheRoot)
  );

  let resolverCalled = false;
  const service = createCodexImagegenHandoffService({
    softwareRoot: fixture.installationRoot,
    builtinImagegenSkillPath: fixture.builtinImagegenSkillPath,
    resolveProjectRoot: async () => {
      resolverCalled = true;
      return fixture.roots.get('project-a');
    }
  });
  await assert.rejects(
    service.getStatus({ projectId: '../project-a' }),
    (error) => error instanceof CodexImagegenHandoffError && error.code === 'INVALID_PROJECT_ID'
  );
  assert.equal(resolverCalled, false);
});

test('the common builtin skill must remain an unchanged ordinary file inside the software root', async (context) => {
  const fixture = await makeFixture(context);
  await appendFile(fixture.builtinImagegenSkillPath, 'changed after service creation\n', 'utf8');
  await assert.rejects(
    fixture.service.getStatus({ projectId: 'project-a' }),
    (error) => error instanceof CodexImagegenHandoffError
      && error.code === 'BUILTIN_SKILL_CHANGED'
      && !error.message.includes(fixture.builtinImagegenSkillPath)
  );

  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'ka-imagegen-skill-outside-'));
  context.after(() => rm(outsideRoot, { recursive: true, force: true }));
  const outsideSkill = path.join(outsideRoot, 'SKILL.md');
  await writeFile(outsideSkill, '# outside skill\n', 'utf8');
  assert.throws(
    () => createCodexImagegenHandoffService({
      softwareRoot: fixture.installationRoot,
      builtinImagegenSkillPath: outsideSkill,
      resolveProjectRoot: async () => fixture.roots.get('project-a')
    }),
    (error) => error instanceof CodexImagegenHandoffError
      && error.code === 'BUILTIN_SKILL_UNTRUSTED'
      && !error.message.includes(outsideSkill)
  );
  assert.throws(
    () => createCodexImagegenHandoffService({
      softwareRoot: fixture.installationRoot,
      builtinImagegenSkillPath: 'skills/ka-builtin-imagegen/SKILL.md',
      resolveProjectRoot: async () => fixture.roots.get('project-a')
    }),
    (error) => error instanceof CodexImagegenHandoffError
      && error.code === 'BUILTIN_SKILL_PATH_INVALID'
  );
});

test('linked queue files cannot redirect inspection into another project', async (context) => {
  const fixture = await makeFixture(context);
  const alphaCache = path.join(fixture.roots.get('project-a'), 'cache');
  const betaQueue = path.join(fixture.roots.get('project-b'), 'cache', 'foreign-queue.json');
  await writeJson(betaQueue, fixture.queue);
  await rm(path.join(alphaCache, '出图队列.json'));
  try {
    await symlink(betaQueue, path.join(alphaCache, '出图队列.json'), 'file');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      context.skip('当前环境不允许创建文件符号链接');
      return;
    }
    throw error;
  }

  await assert.rejects(
    fixture.service.getStatus({ projectId: 'project-a' }),
    (error) => error instanceof CodexImagegenHandoffError
      && error.code === 'STATE_FILE_UNSAFE'
      && !error.message.includes(betaQueue)
  );
});
