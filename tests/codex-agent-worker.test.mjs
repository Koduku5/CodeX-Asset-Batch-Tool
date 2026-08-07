import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CODEX_AGENT_ACTIONS,
  CodexAgentWorkerError,
  readCodexModelLabel,
  runCodexAgentAction,
  sanitizeAgentText,
  SOFTWARE_EPISODE_ASSET_SKILL_PATH,
  SOFTWARE_PIPELINE_SKILL_PATH
} from '../src/server/codex-agent-worker.mjs';
import { readCodexRuntimeConfig } from '../src/server/codex-runtime-config.mjs';

const WORKER_PATH = fileURLToPath(new URL('../src/server/codex-agent-worker.mjs', import.meta.url));
const EPISODE_WRITER_PATH = fileURLToPath(new URL('../engine/scripts/pipeline/write_episode_analysis.py', import.meta.url));
const PYTHON_TEST_ENV = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };

const createProject = async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ka-codex-agent-worker-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

const createSoftwareSkill = async (context) => {
  const softwareRoot = await mkdtemp(path.join(os.tmpdir(), 'ka-codex-software-skill-'));
  context.after(() => rm(softwareRoot, { recursive: true, force: true }));
  const skillRoot = path.join(softwareRoot, 'runtime', 'skills', 'ka-script-pipeline');
  const episodeAssetSkillRoot = path.join(softwareRoot, 'runtime', 'skills', 'ka-episode-asset-analysis');
  await Promise.all([
    mkdir(skillRoot, { recursive: true }),
    mkdir(episodeAssetSkillRoot, { recursive: true })
  ]);
  const skillPath = path.join(skillRoot, 'SKILL.md');
  await Promise.all([
    writeFile(skillPath, '# controlled ka-script-pipeline\n', 'utf8'),
    writeFile(
      path.join(episodeAssetSkillRoot, 'SKILL.md'),
      '# 单集资产分析 Skill\nTEST_EPISODE_SKILL_BODY_ONLY\n',
      'utf8'
    )
  ]);
  return skillPath;
};

const episodeAnalysis = (episode = 1) => ({
  source: 'screenplay.docx',
  episode,
  scriptAnalysis: [],
  assets: { characters: [], creatures: [], extras: [], scenes: [], props: [] },
  exclusions: [{ item: '本集检查', reason: '测试夹具没有需要登记的记录' }]
});

const sdkExtraAsset = (overrides = {}) => ({
  assetId: null,
  assetName: '测试群演',
  productionNotes: '完整制作说明',
  faction: '测试组织｜测试群体',
  scriptSetting: '剧本明确设定',
  inferenceBasis: '可复核推演依据',
  aliases: [],
  firstRequiredEpisode: 1,
  firstRequiredOrder: 1,
  ...overrides
});

const standardEvents = async function* (
  action,
  { completed = true, episode = 1, analysis = episodeAnalysis(episode) } = {}
) {
  yield { type: 'thread.started', thread_id: 'must-not-be-logged' };
  yield { type: 'turn.started' };
  yield {
    type: 'item.completed',
    item: { id: 'reason-1', type: 'reasoning', text: 'private chain of thought' }
  };
  yield {
    type: 'item.completed',
    item: {
      id: 'command-1',
      type: 'command_execution',
      command: 'powershell.exe D:\\private\\read-only-check.ps1',
      aggregated_output: 'OPENAI_API_KEY=secret-token',
      exit_code: 0,
      status: 'completed'
    }
  };
  yield {
    type: 'item.completed',
    item: {
      id: 'message-1',
      type: 'agent_message',
      text: JSON.stringify({
        completed,
        action,
        summary: completed ? '正式状态已落盘' : '正式校验未通过',
        processedCount: 1,
        ...(action === 'analyze-screenplay' ? { analysis } : {})
      })
    }
  };
  yield { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20, reasoning_output_tokens: 10 } };
};

const analysisProgress = ({ discovered = [1], completed = [], currentEpisode = null } = {}) => ({
  discoveredEpisodes: discovered,
  completedEpisodes: completed,
  currentEpisode,
  currentSessionToken: currentEpisode === null ? null : 'private-session-token'
});

const analysisProgressSequence = (...states) => {
  let index = 0;
  return async () => {
    if (index >= states.length) throw new Error('unexpected analysis progress read');
    const state = states[index];
    index += 1;
    return state;
  };
};

const analysisRuntime = (calls = []) => ({
  prepareAnalysisEpisode: async (input) => { calls.push(['prepare', input.episode, input.resume]); },
  commitAnalysisEpisode: async (input) => { calls.push(['commit', input.episode, input.analysis]); }
});

test('fixed episode writer binds source to the active episode snapshot before atomic write', async (context) => {
  const root = await createProject(context);
  const cache = path.join(root, 'cache');
  await mkdir(path.join(cache, '单集原文'), { recursive: true });
  await Promise.all([
    writeFile(path.join(cache, '阅读进度.json'), JSON.stringify({
      status: 'in_progress', currentEpisode: 1, currentSessionToken: 'fixed-token'
    }), 'utf8'),
    writeFile(path.join(cache, '.pipeline.lock'), JSON.stringify({
      kind: 'analysis_episode', key: 'episode:1', token: 'fixed-token'
    }), 'utf8'),
    writeFile(path.join(cache, '单集原文', '第001集.json'), JSON.stringify({
      source: 'screenplay.docx', episode: 1
    }), 'utf8')
  ]);
  const analysis = episodeAnalysis(1);
  const written = spawnSync('python', [EPISODE_WRITER_PATH, root, '1'], {
    input: JSON.stringify(analysis), encoding: 'utf8', timeout: 5000, env: PYTHON_TEST_ENV
  });
  assert.equal(written.status, 0, written.stderr);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(cache, '单集分析', '第001集.json'), 'utf8')),
    analysis
  );

  const rebound = spawnSync('python', [EPISODE_WRITER_PATH, root, '1'], {
    input: JSON.stringify({ ...analysis, source: './cache/单集原文/第001集.json' }),
    encoding: 'utf8',
    timeout: 5000,
    env: PYTHON_TEST_ENV
  });
  assert.equal(rebound.status, 0, rebound.stderr);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(cache, '单集分析', '第001集.json'), 'utf8')),
    analysis
  );

  await writeFile(
    path.join(cache, '单集原文', '第001集.json'),
    JSON.stringify({ source: null, episode: 1 }),
    'utf8'
  );
  const invalidRawMetadata = spawnSync('python', [EPISODE_WRITER_PATH, root, '1'], {
    input: JSON.stringify(analysis), encoding: 'utf8', timeout: 5000, env: PYTHON_TEST_ENV
  });
  assert.equal(invalidRawMetadata.status, 1);
  assert.notEqual(invalidRawMetadata.stderr.trim(), '');
  assert.deepEqual(
    JSON.parse(await readFile(path.join(cache, '单集分析', '第001集.json'), 'utf8')),
    analysis
  );
});

test('fixed backend owns start, atomic analysis write, sync and complete end to end', async (context) => {
  const root = await createProject(context);
  await Promise.all([
    cp(fileURLToPath(new URL('../engine/scripts', import.meta.url)), path.join(root, 'scripts'), { recursive: true }),
    cp(fileURLToPath(new URL('../engine/assets', import.meta.url)), path.join(root, 'assets'), { recursive: true }),
    mkdir(path.join(root, '剧本'), { recursive: true })
  ]);
  await writeFile(path.join(root, '剧本', 'mini.txt'), '第一集\n角色甲在固定地点保管一件旧物。\n', 'utf8');
  const extracted = spawnSync('python', [
    path.join(root, 'scripts', 'pipeline', 'extract_screenplay.py'), root
  ], { encoding: 'utf8', timeout: 10000 });
  assert.equal(extracted.status, 0, extracted.stderr);

  const analysis = {
    ...episodeAnalysis(1),
    source: 'mini.txt'
  };
  const createCodex = async () => ({
    startThread: (options) => ({
      runStreamed: async () => ({
        events: standardEvents('analyze-screenplay', { episode: 1, analysis })
      }),
      options
    })
  });
  const result = await runCodexAgentAction(
    { action: 'analyze-screenplay', projectRoot: root },
    {
      createCodex,
      resolveModelLabel: async () => 'gpt-test',
      emit: () => {},
      totalTimeoutMs: 10000,
      idleTimeoutMs: 5000
    }
  );
  assert.equal(result.processedCount, 1);
  const progress = JSON.parse(await readFile(path.join(root, 'cache', '阅读进度.json'), 'utf8'));
  assert.deepEqual(progress.completedEpisodes, [1]);
  assert.equal(progress.currentEpisode, null);
  assert.equal(progress.status, 'complete');
  assert.deepEqual(
    JSON.parse(await readFile(path.join(root, 'cache', '单集分析', '第001集.json'), 'utf8')).exclusions,
    analysis.exclusions
  );
});

test('pipeline failures expose the sanitized formal validation reason', async (context) => {
  const root = await createProject(context);
  await Promise.all([
    cp(fileURLToPath(new URL('../engine/scripts', import.meta.url)), path.join(root, 'scripts'), { recursive: true }),
    cp(fileURLToPath(new URL('../engine/assets', import.meta.url)), path.join(root, 'assets'), { recursive: true }),
    mkdir(path.join(root, '剧本'), { recursive: true })
  ]);
  await writeFile(path.join(root, '剧本', 'mini.txt'), '第一集\n一群守卫在门前列队。\n', 'utf8');
  const extracted = spawnSync('python', [
    path.join(root, 'scripts', 'pipeline', 'extract_screenplay.py'), root
  ], { encoding: 'utf8', timeout: 10000 });
  assert.equal(extracted.status, 0, extracted.stderr);

  const analysis = { ...episodeAnalysis(1), source: 'mini.txt' };
  analysis.assets.extras = [sdkExtraAsset({ faction: '缺少分隔符' })];
  await assert.rejects(
    runCodexAgentAction(
      { action: 'analyze-screenplay', projectRoot: root },
      {
        createCodex: async () => ({
          startThread: () => ({
            runStreamed: async () => ({ events: standardEvents('analyze-screenplay', { analysis }) })
          })
        }),
        resolveModelLabel: async () => 'gpt-test',
        emit: () => {},
        totalTimeoutMs: 10000,
        idleTimeoutMs: 5000
      }
    ),
    (error) => error instanceof CodexAgentWorkerError
      && error.code === 'ANALYSIS_PIPELINE_FAILED'
      && /assets\.extras\[1\]\.faction 必须且只能包含一个/u.test(error.message)
      && !error.message.includes(root)
  );
});

test('Codex model label reports only an explicit top-level CLI model', async () => {
  assert.equal(await readCodexModelLabel({
    readConfig: async () => 'model = "gpt-5.4-codex"\nmodel_reasoning_effort = "high"\n'
  }), 'gpt-5.4-codex');
  assert.equal(await readCodexModelLabel({
    readConfig: async () => '[profiles.demo]\nmodel = "profile-only"\n'
  }), 'Codex 默认模型');
  assert.equal(await readCodexModelLabel({
    readConfig: async () => 'model = "unsafe model name"\n'
  }), 'Codex 默认模型');
  assert.equal(await readCodexModelLabel({
    readConfig: async () => { throw new Error('missing'); }
  }), 'Codex 默认模型');
  assert.deepEqual(await readCodexRuntimeConfig({
    readConfig: async () => 'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "xhigh"\n'
  }), {
    model: 'gpt-5.6-sol',
    reasoningEffort: 'xhigh',
    modelLabel: 'gpt-5.6-sol',
    reasoningEffortLabel: 'xhigh',
    source: 'local-codex-config'
  });
});

const classificationEvents = async function* () {
  yield { type: 'thread.started', thread_id: 'classification-thread-private' };
  yield { type: 'turn.started' };
  yield {
    type: 'item.completed',
    item: {
      type: 'agent_message',
      text: JSON.stringify({
        completed: true,
        action: 'classify-prompt-branches',
        summary: '本页判断完成',
        assignments: [{ key: '场景:SCENE-001-EP1', selectedConditionModuleIds: ['forest-highway'] }]
      })
    }
  };
  yield { type: 'turn.completed', usage: {} };
};

const makeClassificationSession = (calls, { pages = true } = {}) => ({
  pages: pages ? [{
    page: 1,
    relativeRequestPath: 'cache/.fixed/request-00001.json',
    outputSchema: { type: 'object', properties: { action: { enum: ['classify-prompt-branches'] } } }
  }] : [],
  validatePageResult(page, value) {
    calls.push(['validate', page.page, value.assignments]);
    return value.assignments;
  },
  async commit(results) {
    calls.push(['commit', results]);
    return { processedCount: pages ? 1 : 2, semanticPageCount: pages ? 1 : 0 };
  },
  async rollback() { calls.push(['rollback']); }
});

test('worker exposes only fixed semantic pipeline actions', async (context) => {
  const root = await createProject(context);
  assert.deepEqual(CODEX_AGENT_ACTIONS, [
    'analyze-screenplay',
    'build-world-overview',
    'complete-asset-visual-specs',
    'classify-prompt-branches'
  ]);
  let created = false;
  const createCodex = async () => {
    created = true;
    throw new Error('must not be reached');
  };
  for (const action of [
    'shell',
    'generate',
    'claim-next-builtin-image',
    'generate-next-builtin-image',
    ''
  ]) {
    await assert.rejects(
      runCodexAgentAction({ action, projectRoot: root }, { createCodex }),
      (error) => error instanceof CodexAgentWorkerError && error.code === 'ACTION_NOT_ALLOWED'
    );
  }
  for (const key of ['prompt', 'model', 'path', 'args', 'pipelineSkillPath']) {
    await assert.rejects(
      runCodexAgentAction({ action: 'classify-prompt-branches', projectRoot: root, [key]: 'forbidden' }, { createCodex }),
      (error) => error instanceof CodexAgentWorkerError && error.code === 'INVALID_WORKER_INPUT'
    );
  }
  assert.equal(created, false);
});

test('visual specifications use one read-only SDK thread and one atomic commit per asset', async (context) => {
  const root = await createProject(context);
  const pipelineSkillPath = await createSoftwareSkill(context);
  const requests = [
    {
      requestToken: 'token-char',
      worldOverview: '统一的完整世界观总览',
      asset: {
        category: 'characters', assetId: 'CHAR-008-EP3', assetName: '测试角色',
        faction: '测试组织｜测试部门（成员）', scriptSetting: '剧本明确角色事实', aliases: [],
        firstRequiredEpisode: 3, firstRequiredOrder: 1
      }
    },
    {
      requestToken: 'token-prop',
      worldOverview: '统一的完整世界观总览',
      asset: {
        category: 'props', assetId: 'PROP-002-EP4', assetName: '测试道具',
        scriptSetting: '剧本明确道具事实', aliases: [], firstRequiredEpisode: 4, firstRequiredOrder: 1
      }
    }
  ];
  const scriptCalls = [];
  let nextIndex = 0;
  let commitCount = 0;
  let threadCount = 0;
  const runVisualSpecScript = async ({ command, payload }) => {
    scriptCalls.push([command, payload ?? null]);
    if (command === 'start') return { ok: true, done: false, completed: 0, total: 2 };
    if (command === 'next') return { ok: true, done: false, completed: nextIndex, total: 2, ...requests[nextIndex++] };
    commitCount += 1;
    return {
      ok: true,
      done: commitCount === 2,
      completed: commitCount,
      total: 2,
      assetId: payload.assetId
    };
  };
  const createCodex = async () => ({
    startThread(options) {
      const request = requests[threadCount++];
      assert.equal(options.sandboxMode, 'read-only');
      assert.equal(options.networkAccessEnabled, false);
      return {
        async runStreamed(prompt, { outputSchema }) {
          assert.match(prompt, new RegExp(request.asset.assetId, 'u'));
          assert.equal(prompt.includes(request === requests[0] ? requests[1].asset.assetId : requests[0].asset.assetId), false);
          assert.equal(outputSchema.properties.assetId.enum[0], request.asset.assetId);
          const events = async function* () {
            yield { type: 'thread.started' };
            yield { type: 'turn.started' };
            yield {
              type: 'item.completed',
              item: {
                type: 'agent_message',
                text: JSON.stringify({
                  completed: true,
                  action: 'complete-asset-visual-specs',
                  summary: '当前资产视觉规格已完成',
                  processedCount: 1,
                  assetId: request.asset.assetId,
                  requestToken: request.requestToken,
                  productionNotes: `完整视觉规格-${request.asset.assetId}`,
                  inferenceBasis: `推演依据-${request.asset.assetId}`
                })
              }
            };
            yield { type: 'turn.completed' };
          };
          return { events: events() };
        }
      };
    }
  });

  const result = await runCodexAgentAction(
    { action: 'complete-asset-visual-specs', projectRoot: root },
    {
      pipelineSkillPath,
      createCodex,
      runVisualSpecScript,
      resolveModelLabel: async () => 'test-model / medium',
      emit: () => {},
      totalTimeoutMs: 1000,
      idleTimeoutMs: 500
    }
  );

  assert.equal(result.completed, true);
  assert.equal(result.processedCount, 2);
  assert.equal(threadCount, 2);
  assert.deepEqual(scriptCalls.map(([command]) => command), ['start', 'next', 'commit', 'next', 'commit']);
  assert.deepEqual(scriptCalls.filter(([command]) => command === 'commit').map(([, payload]) => payload.assetId), [
    'CHAR-008-EP3', 'PROP-002-EP4'
  ]);
});

test('worker rejects a software Skill inside the writable project and never starts the SDK', async (context) => {
  const root = await createProject(context);
  const skillRoot = path.join(root, 'ka-script-pipeline');
  const episodeAssetSkillRoot = path.join(root, 'ka-episode-asset-analysis');
  await Promise.all([
    mkdir(skillRoot, { recursive: true }),
    mkdir(episodeAssetSkillRoot, { recursive: true })
  ]);
  const pipelineSkillPath = path.join(skillRoot, 'SKILL.md');
  await Promise.all([
    writeFile(pipelineSkillPath, '# must remain outside the project\n', 'utf8'),
    writeFile(path.join(episodeAssetSkillRoot, 'SKILL.md'), '# must remain outside the project\n', 'utf8')
  ]);
  let created = false;
  await assert.rejects(
    runCodexAgentAction(
      { action: 'analyze-screenplay', projectRoot: root },
      {
        pipelineSkillPath,
        createCodex: async () => {
          created = true;
          throw new Error('must not start');
        }
      }
    ),
    (error) => error instanceof CodexAgentWorkerError && error.code === 'PROJECT_ROOT_UNSAFE'
  );
  assert.equal(created, false);
});

test('episode asset Skill changes abort before any episode result is committed', async (context) => {
  const root = await createProject(context);
  const pipelineSkillPath = await createSoftwareSkill(context);
  const episodeAssetSkillPath = path.join(
    path.dirname(path.dirname(pipelineSkillPath)),
    'ka-episode-asset-analysis',
    'SKILL.md'
  );
  const operations = [];
  await assert.rejects(
    runCodexAgentAction(
      { action: 'analyze-screenplay', projectRoot: root },
      {
        pipelineSkillPath,
        createCodex: async () => ({
          startThread: () => ({
            runStreamed: async () => {
              await writeFile(episodeAssetSkillPath, '# changed Skill\n', 'utf8');
              return { events: standardEvents('analyze-screenplay') };
            }
          })
        }),
        ...analysisRuntime(operations),
        readAnalysisProgress: analysisProgressSequence(analysisProgress()),
        emit: () => {},
        totalTimeoutMs: 1000,
        idleTimeoutMs: 500
      }
    ),
    (error) => error instanceof CodexAgentWorkerError && error.code === 'SKILL_CHANGED'
  );
  assert.deepEqual(operations.map(([kind]) => kind), ['prepare']);
});

test('worker CLI requires exactly the fixed action, roots and validated model configuration', async (context) => {
  const root = await createProject(context);
  const pipelineSkillPath = await createSoftwareSkill(context);
  for (const argumentsList of [
    [WORKER_PATH, 'analyze-screenplay', root],
    [WORKER_PATH, 'analyze-screenplay', root, pipelineSkillPath, 'gpt-5.6-sol', 'high', '--unexpected'],
    [WORKER_PATH, 'analyze-screenplay', root, pipelineSkillPath, 'gpt-5.6-sol', 'max']
  ]) {
    const child = spawnSync(process.execPath, argumentsList, { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /INVALID_WORKER_INPUT/u);
    assert.equal(child.stderr.includes(root), false);
    assert.equal(child.stderr.includes(pipelineSkillPath), false);
  }
});

test('classification uses a read-only fresh SDK thread and commits only worker-validated assignments', async (context) => {
  const root = await createProject(context);
  const pipelineSkillPath = await createSoftwareSkill(context);
  const emitted = [];
  const sdkCalls = [];
  const sessionCalls = [];
  const createCodex = async () => ({
    startThread(options) {
      const call = { options, prompt: null, turnOptions: null };
      sdkCalls.push(call);
      return {
        async runStreamed(prompt, turnOptions) {
          call.prompt = prompt;
          call.turnOptions = turnOptions;
          return { events: classificationEvents() };
        }
      };
    }
  });

  const result = await runCodexAgentAction(
    { action: 'classify-prompt-branches', projectRoot: root },
    {
      createCodex,
      createBranchClassificationSession: async () => makeClassificationSession(sessionCalls),
      pipelineSkillPath,
      emit: (line) => emitted.push(line),
      totalTimeoutMs: 1000,
      idleTimeoutMs: 500
    }
  );

  assert.equal(result.completed, true);
  assert.equal(result.processedCount, 1);
  assert.deepEqual(result.softwareSkill.id, 'ka-script-pipeline');
  assert.match(result.softwareSkill.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(sdkCalls.length, 1);
  assert.deepEqual(sdkCalls[0].options, {
    workingDirectory: await realpath(root),
    skipGitRepoCheck: true,
    sandboxMode: 'read-only',
    networkAccessEnabled: false,
    webSearchMode: 'disabled',
    approvalPolicy: 'never'
  });
  assert.equal(sdkCalls[0].prompt.includes(await realpath(pipelineSkillPath)), true);
  assert.equal(sdkCalls[0].prompt.includes(SOFTWARE_PIPELINE_SKILL_PATH), false);
  assert.equal(sdkCalls[0].prompt.includes('读取当前工作目录中的 ./SKILL.md'), false);
  assert.match(sdkCalls[0].prompt, /\.\/cache\/\.fixed\/request-00001\.json/u);
  assert.equal(sdkCalls[0].prompt.includes(root), false);
  assert.deepEqual(sessionCalls.map(([kind]) => kind), ['validate', 'commit']);
  assert.deepEqual(sessionCalls[0][2], [{
    key: '场景:SCENE-001-EP1',
    selectedConditionModuleIds: ['forest-highway']
  }]);
  assert.equal(emitted.filter((line) => line.startsWith('KA_AGENT_RESULT ')).length, 1);
  const serialized = emitted.join('\n');
  for (const forbidden of ['SCENE-001-EP1', 'forest-highway', 'classification-thread-private']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('analysis and overview preserve their sandboxes while applying the selected model configuration', async (context) => {
  const root = await createProject(context);
  const calls = [];
  const createCodex = async () => ({
    startThread(options) {
      const action = CODEX_AGENT_ACTIONS[calls.length];
      const call = { options, action };
      calls.push(call);
      return { runStreamed: async (prompt) => {
        call.prompt = prompt;
        return { events: standardEvents(action) };
      } };
    }
  });
  const readAnalysisProgress = analysisProgressSequence(
    analysisProgress(),
    analysisProgress({ completed: [1] })
  );
  for (const action of ['analyze-screenplay', 'build-world-overview']) {
    const result = await runCodexAgentAction(
      {
        action,
        projectRoot: root,
        runtimeConfig: { model: 'gpt-5.6-terra', reasoningEffort: 'medium' }
      },
      { createCodex, ...analysisRuntime(), readAnalysisProgress, emit: () => {}, totalTimeoutMs: 1000, idleTimeoutMs: 500 }
    );
    assert.equal(result.action, action);
  }
  for (const call of calls) {
    assert.equal(call.options.approvalPolicy, 'never');
    assert.equal(call.options.networkAccessEnabled, false);
    assert.equal(call.options.model, 'gpt-5.6-terra');
    assert.equal(call.options.modelReasoningEffort, 'medium');
  }
  const analyzeCall = calls.find((call) => call.action === 'analyze-screenplay');
  const overviewCall = calls.find((call) => call.action === 'build-world-overview');
  assert.equal(analyzeCall.options.sandboxMode, 'read-only');
  assert.equal(overviewCall.options.sandboxMode, 'workspace-write');
  assert.equal(analyzeCall.prompt.includes(SOFTWARE_EPISODE_ASSET_SKILL_PATH), true);
  assert.equal(analyzeCall.prompt.includes(SOFTWARE_PIPELINE_SKILL_PATH), false);
  assert.doesNotMatch(analyzeCall.prompt, /<episode-analysis-contract>/u);
  assert.doesNotMatch(analyzeCall.prompt, /只将“需要独立交付/u);
  assert.equal(analyzeCall.prompt.includes('asset-type-rules.md'), false);
  assert.equal(analyzeCall.prompt.includes('prompt-writing.md'), false);
  assert.match(analyzeCall.prompt, /该文件是本动作唯一允许读取的 Skill/u);
  assert.match(analyzeCall.prompt, /固定 worker 已在启动本次 SDK turn 前完成 start 或显式 resume/u);
  assert.match(analyzeCall.prompt, /禁止调用 apply_patch/u);
  assert.match(analyzeCall.prompt, /只返回本次调用提供的 output schema/u);
  assert.doesNotMatch(
    analyzeCall.prompt,
    /群演字段只能写|assetId=null|aliases 写空数组|firstRequiredOrder|禁止虚构记录凑数/u
  );
});

test('analysis schedules one fresh SDK thread per episode and verifies each atomic commit before continuing', async (context) => {
  const root = await createProject(context);
  const calls = [];
  const analysisOperations = [];
  let sdkCreations = 0;
  const createCodex = async () => {
    sdkCreations += 1;
    return {
      startThread(options) {
        const call = { options, prompt: null };
        calls.push(call);
        return {
          async runStreamed(prompt) {
            call.prompt = prompt;
            return { events: standardEvents('analyze-screenplay', { episode: calls.length === 1 ? 4 : 5 }) };
          }
        };
      }
    };
  };
  const emitted = [];
  const result = await runCodexAgentAction(
    { action: 'analyze-screenplay', projectRoot: root },
    {
      createCodex,
      ...analysisRuntime(analysisOperations),
      readAnalysisProgress: analysisProgressSequence(
        analysisProgress({ discovered: [4, 5], currentEpisode: 4 }),
        analysisProgress({ discovered: [4, 5], completed: [4] }),
        analysisProgress({ discovered: [4, 5], completed: [4, 5] })
      ),
      emit: (line) => emitted.push(line),
      totalTimeoutMs: 1000,
      idleTimeoutMs: 500
    }
  );

  assert.equal(sdkCreations, 1);
  assert.equal(calls.length, 2);
  assert.match(calls[0].prompt, /只完成第 4 集/u);
  assert.match(calls[0].prompt, /第004集\.json/u);
  assert.equal(calls[0].options.sandboxMode, 'read-only');
  assert.equal(calls[0].prompt.includes('第005集.json'), false);
  assert.match(calls[1].prompt, /只完成第 5 集/u);
  assert.match(calls[1].prompt, /第005集\.json/u);
  assert.equal(calls[1].prompt.includes('第004集.json'), false);
  assert.equal(calls.some((call) => call.prompt.includes('__KA_ANALYSIS_EPISODE__')), false);
  assert.equal(result.processedCount, 2);
  assert.deepEqual(analysisOperations.map(([kind, episode, value]) => [kind, episode, kind === 'prepare' ? value : value.episode]), [
    ['prepare', 4, true],
    ['commit', 4, 4],
    ['prepare', 5, false],
    ['commit', 5, 5]
  ]);
  assert.equal(emitted.includes('第 4 集分析已完成并计入累计记录（1/2）'), true);
  assert.equal(emitted.includes('第 5 集分析已完成并计入累计记录（2/2）'), true);
});

test('analysis uses a strict nested schema and deterministically normalizes aliases', async (context) => {
  const root = await createProject(context);
  const nested = episodeAnalysis(1);
  nested.assets.extras = [sdkExtraAsset({ productionNotes: null, inferenceBasis: null })];
  nested.assets.extras = [sdkExtraAsset({ productionNotes: null, inferenceBasis: null,
    aliases: [' 旧称 ', '', '旧 称', '测试群演', '另称']
  })];
  let outputSchema;
  const operations = [];
  const result = await runCodexAgentAction(
    { action: 'analyze-screenplay', projectRoot: root },
    {
      createCodex: async () => ({
        startThread: () => ({
          runStreamed: async (_prompt, options) => {
            outputSchema = options.outputSchema;
            return { events: standardEvents('analyze-screenplay', { analysis: nested }) };
          }
        })
      }),
      ...analysisRuntime(operations),
      readAnalysisProgress: analysisProgressSequence(
        analysisProgress(),
        analysisProgress({ completed: [1] })
      ),
      emit: () => {},
      totalTimeoutMs: 1000,
      idleTimeoutMs: 500
    }
  );

  assert.equal(result.completed, true);
  assert.equal(outputSchema.properties.analysis.type, 'object');
  assert.deepEqual(outputSchema.properties.analysis.properties.episode.enum, [1]);
  assert.deepEqual(
    Object.keys(outputSchema.properties.analysis.properties.assets.properties),
    ['characters', 'creatures', 'extras', 'scenes', 'props']
  );
  assert.equal(outputSchema.properties.analysis.properties.assets.additionalProperties, false);
  assert.deepEqual(
    outputSchema.properties.analysis.properties.assets.properties.characters.items.properties.productionNotes.type,
    ['string', 'null']
  );
  assert.equal(Object.hasOwn(outputSchema.properties.summary, 'maxLength'), false);
  assert.equal(Object.hasOwn(outputSchema.properties.processedCount, 'maximum'), false);
  assert.equal(
    Object.hasOwn(
      outputSchema.properties.analysis.properties.assets.properties.characters.items.properties.assetName,
      'minLength'
    ),
    false
  );
  assert.equal(
    Object.hasOwn(outputSchema.properties.analysis.properties.assets.properties.characters, 'maxItems'),
    false
  );
  assert.equal(
    Object.hasOwn(
      outputSchema.properties.analysis.properties.assets.properties.characters.items.properties.aliases,
      'uniqueItems'
    ),
    false
  );
  assert.equal(
    outputSchema.properties.analysis.properties.exclusions.items.required.includes('reason'),
    true
  );
  const committed = operations.find(([kind]) => kind === 'commit')?.[2];
  assert.equal(Object.hasOwn(committed.assets.extras[0], 'assetId'), false);
  assert.equal(committed.assets.extras[0].productionNotes, null);
  assert.equal(committed.assets.extras[0].inferenceBasis, null);
  assert.deepEqual(committed.assets.extras[0].aliases, ['旧称', '另称']);
});

test('analysis rejects every nested template deviation instead of correcting it', async (context) => {
  const root = await createProject(context);
  const malformed = episodeAnalysis(1);
  malformed.assets = {
    characters: [], creatures: [], crowds: [], scenes: [], props: []
  };
  await assert.rejects(
    runCodexAgentAction(
      { action: 'analyze-screenplay', projectRoot: root },
      {
        createCodex: async () => ({
          startThread: () => ({
            runStreamed: async () => ({ events: standardEvents('analyze-screenplay', { analysis: malformed }) })
          })
        }),
        ...analysisRuntime(),
        readAnalysisProgress: analysisProgressSequence(analysisProgress()),
        emit: () => {},
        totalTimeoutMs: 1000,
        idleTimeoutMs: 500
      }
    ),
    (error) => error instanceof CodexAgentWorkerError
      && error.code === 'INVALID_AGENT_RESULT'
      && /assets\.extras 缺失/u.test(error.message)
  );
});

test('analysis rejects missing, extra and mistyped fields at every nested level', async (context) => {
  const root = await createProject(context);
  const cases = [
    ['string exclusion', (analysis) => { analysis.exclusions = ['错误排除项']; }, '$.analysis.exclusions[0]'],
    ['extra top-level field', (analysis) => { analysis.unexpected = true; }, '$.analysis.unexpected'],
    ['incomplete asset', (analysis) => { analysis.assets.extras = [{ assetId: null }]; }, '$.analysis.assets.extras[0].assetName'],
    ['empty asset name', (analysis) => { analysis.assets.extras = [sdkExtraAsset({ assetName: '' })]; }, '$.analysis.assets.extras[0].assetName'],
    ['invalid asset order', (analysis) => { analysis.assets.extras = [sdkExtraAsset({ firstRequiredOrder: 0 })]; }, '$.analysis.assets.extras[0].firstRequiredOrder'],
    ['extra asset field', (analysis) => { analysis.assets.extras = [sdkExtraAsset({ unexpected: true })]; }, '$.analysis.assets.extras[0].unexpected'],
    ['mistyped world fact', (analysis) => { analysis.scriptAnalysis = [{ item: '规则', content: 42 }]; }, '$.analysis.scriptAnalysis[0].content']
  ];

  for (const [label, mutate, expectedPath] of cases) {
    const analysis = structuredClone(episodeAnalysis(1));
    mutate(analysis);
    await assert.rejects(
      runCodexAgentAction(
        { action: 'analyze-screenplay', projectRoot: root },
        {
          createCodex: async () => ({
            startThread: () => ({
              runStreamed: async () => ({ events: standardEvents('analyze-screenplay', { analysis }) })
            })
          }),
          ...analysisRuntime(),
          readAnalysisProgress: analysisProgressSequence(analysisProgress()),
          emit: () => {},
          totalTimeoutMs: 1000,
          idleTimeoutMs: 500
        }
      ),
      (error) => error instanceof CodexAgentWorkerError
        && error.code === 'INVALID_AGENT_RESULT'
        && error.message.includes(expectedPath),
      label
    );
  }
});

test('analysis never starts the next episode until the current episode is atomically committed', async (context) => {
  const root = await createProject(context);
  let threads = 0;
  const createCodex = async () => ({
    startThread: () => {
      threads += 1;
      return { runStreamed: async () => ({ events: standardEvents('analyze-screenplay', { episode: 4 }) }) };
    }
  });

  await assert.rejects(
    runCodexAgentAction(
      { action: 'analyze-screenplay', projectRoot: root },
      {
        createCodex,
        ...analysisRuntime(),
        readAnalysisProgress: analysisProgressSequence(
          analysisProgress({ discovered: [4, 5] }),
          analysisProgress({ discovered: [4, 5] })
        ),
        emit: () => {},
        totalTimeoutMs: 1000,
        idleTimeoutMs: 500
      }
    ),
    (error) => error instanceof CodexAgentWorkerError && error.code === 'ANALYSIS_EPISODE_NOT_COMMITTED'
  );
  assert.equal(threads, 1);
});

test('analysis skips the SDK when every discovered episode is already complete', async (context) => {
  const root = await createProject(context);
  const result = await runCodexAgentAction(
    { action: 'analyze-screenplay', projectRoot: root },
    {
      createCodex: async () => { throw new Error('SDK must not start'); },
      ...analysisRuntime(),
      readAnalysisProgress: analysisProgressSequence(
        analysisProgress({ discovered: [1, 2], completed: [1, 2] })
      ),
      emit: () => {},
      totalTimeoutMs: 1000,
      idleTimeoutMs: 500
    }
  );
  assert.equal(result.completed, true);
  assert.equal(result.processedCount, 0);
});

test('successful internal commands do not flood the public task log', async (context) => {
  const root = await createProject(context);
  const emitted = [];
  const createCodex = async () => ({
    startThread: () => ({
      runStreamed: async () => ({ events: (async function* () {
        yield { type: 'thread.started' };
        yield { type: 'turn.started' };
        yield { type: 'item.completed', item: { type: 'command_execution', status: 'completed', command: 'node update_analysis_progress.mjs start' } };
        yield { type: 'item.completed', item: { type: 'command_execution', status: 'completed', command: 'python query_asset_records.py' } };
        yield { type: 'item.completed', item: { type: 'command_execution', status: 'completed', command: 'python sync_episode_analysis.py' } };
        for (let index = 0; index < 20; index += 1) {
          yield { type: 'item.completed', item: { type: 'command_execution', status: 'completed' } };
        }
        yield {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: JSON.stringify({
              completed: true,
              action: 'analyze-screenplay',
              summary: '正式分析已完成',
              processedCount: 1,
              analysis: episodeAnalysis(1)
            })
          }
        };
        yield { type: 'turn.completed' };
      })() })
    })
  });

  await runCodexAgentAction(
    { action: 'analyze-screenplay', projectRoot: root },
    {
      createCodex,
      ...analysisRuntime(),
      readAnalysisProgress: analysisProgressSequence(
        analysisProgress(),
        analysisProgress({ completed: [1] })
      ),
      resolveModelLabel: async () => 'gpt-test-codex',
      emit: (line) => emitted.push(line),
      totalTimeoutMs: 1000,
      idleTimeoutMs: 500
    }
  );

  assert.equal(emitted.some((line) => line.includes('正式流水线命令已完成')), false);
  assert.equal(emitted.includes('分析模型：gpt-test-codex；开始逐集分析'), true);
  assert.equal(emitted.includes('当前集分析进度已更新'), true);
  assert.equal(emitted.includes('当前集候选资产记录已读取'), true);
  assert.equal(emitted.includes('当前集分析结果已累计保存'), true);
  assert.equal(emitted.filter((line) => line === 'Codex Agent 已开始执行固定动作').length, 1);
});

test('failed analysis read commands expose sanitized diagnostics and allow Agent recovery', async (context) => {
  const root = await createProject(context);
  const createCodex = async () => ({
    startThread: () => ({
      runStreamed: async () => ({ events: (async function* () {
        yield { type: 'thread.started' };
        yield { type: 'turn.started' };
        yield {
          type: 'item.completed',
          item: {
            type: 'command_execution', status: 'failed', exit_code: 1,
            command: 'powershell read current episode',
            aggregated_output: `Access denied at ${root} access_token=secret-value`
          }
        };
        yield {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: JSON.stringify({
              completed: true,
              action: 'analyze-screenplay',
              summary: '已纠正只读命令并完成分析',
              processedCount: 1,
              analysis: episodeAnalysis(1)
            })
          }
        };
        yield { type: 'turn.completed' };
      })() })
    })
  });

  const emitted = [];
  const result = await runCodexAgentAction(
    { action: 'analyze-screenplay', projectRoot: root },
    {
      createCodex,
      ...analysisRuntime(),
      readAnalysisProgress: analysisProgressSequence(
        analysisProgress(),
        analysisProgress({ completed: [1] })
      ),
      emit: (line) => emitted.push(line),
      totalTimeoutMs: 1000,
      idleTimeoutMs: 500
    }
  );
  assert.equal(result.completed, true);
  const diagnostic = emitted.find((line) => /只读命令失败，正在尝试恢复/u.test(line)) ?? '';
  assert.match(diagnostic, /退出码 1.*命令：powershell read current episode.*Access denied/u);
  assert.equal(diagnostic.includes(root), false);
  assert.equal(diagnostic.includes('secret-value'), false);
});

test('an empty condition registry commits one empty selection per queue item without starting SDK', async (context) => {
  const root = await createProject(context);
  const sessionCalls = [];
  const result = await runCodexAgentAction(
    { action: 'classify-prompt-branches', projectRoot: root },
    {
      createCodex: async () => { throw new Error('SDK must not start when no semantic pages exist'); },
      createBranchClassificationSession: async () => makeClassificationSession(sessionCalls, { pages: false }),
      emit: () => {},
      totalTimeoutMs: 1000,
      idleTimeoutMs: 500
    }
  );
  assert.equal(result.processedCount, 2);
  assert.deepEqual(sessionCalls, [['commit', []]]);
});

test('classification rejects file/tool mutations and rolls back the prepared base queue', async (context) => {
  const root = await createProject(context);
  const sessionCalls = [];
  const createCodex = async () => ({
    startThread: () => ({
      runStreamed: async () => ({
        events: (async function* () {
          yield { type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'cache/evil.json', kind: 'add' }] } };
        })()
      })
    })
  });
  await assert.rejects(
    runCodexAgentAction(
      { action: 'classify-prompt-branches', projectRoot: root },
      {
        createCodex,
        createBranchClassificationSession: async () => makeClassificationSession(sessionCalls),
        emit: () => {},
        totalTimeoutMs: 1000,
        idleTimeoutMs: 500
      }
    ),
    (error) => error instanceof CodexAgentWorkerError && error.code === 'CLASSIFICATION_WRITE_ATTEMPT'
  );
  assert.deepEqual(sessionCalls, [['rollback']]);
});

test('hanging SDK and silent streams are stopped by bounded timeouts', async (context) => {
  const root = await createProject(context);
  await assert.rejects(
    runCodexAgentAction(
      { action: 'analyze-screenplay', projectRoot: root },
      {
        createCodex: () => new Promise(() => {}),
        ...analysisRuntime(),
        readAnalysisProgress: analysisProgressSequence(analysisProgress()),
        emit: () => {},
        totalTimeoutMs: 20,
        idleTimeoutMs: 1000
      }
    ),
    (error) => error instanceof CodexAgentWorkerError && error.code === 'CODEX_TOTAL_TIMEOUT'
  );

  const createCodex = async () => ({
    startThread: () => ({
      runStreamed: async () => ({ events: (async function* () { await new Promise(() => {}); })() })
    })
  });
  await assert.rejects(
    runCodexAgentAction(
      { action: 'build-world-overview', projectRoot: root },
      { createCodex, emit: () => {}, totalTimeoutMs: 1000, idleTimeoutMs: 20 }
    ),
    (error) => error instanceof CodexAgentWorkerError && error.code === 'CODEX_IDLE_TIMEOUT'
  );
});

test('transient SDK error events allow a later successful turn completion', async (context) => {
  const root = await createProject(context);
  const emitted = [];
  const createCodex = async () => ({
    startThread: () => ({
      runStreamed: async () => ({
        events: (async function* () {
          yield { type: 'thread.started' };
          yield { type: 'turn.started' };
          yield { type: 'error', message: 'Reconnecting... 2/5 (request timed out)' };
          yield {
            type: 'item.completed',
            item: {
              type: 'agent_message',
              text: JSON.stringify({
                completed: true,
                action: 'analyze-screenplay',
                summary: '重连后正式状态已落盘',
                processedCount: 1,
                analysis: episodeAnalysis(1)
              })
            }
          };
          yield { type: 'turn.completed' };
        })()
      })
    })
  });

  const result = await runCodexAgentAction(
    { action: 'analyze-screenplay', projectRoot: root },
    {
      createCodex,
      ...analysisRuntime(),
      readAnalysisProgress: analysisProgressSequence(
        analysisProgress(),
        analysisProgress({ completed: [1] })
      ),
      emit: (line) => emitted.push(line),
      totalTimeoutMs: 1000,
      idleTimeoutMs: 500
    }
  );

  assert.equal(result.completed, true);
  assert.equal(result.processedCount, 1);
  assert.equal(emitted.includes('Codex Agent 连接短暂中断，正在自动重试（1/3）'), true);
});

test('non-fatal SDK error items do not abort a later valid analysis receipt', async (context) => {
  const root = await createProject(context);
  const emitted = [];
  const createCodex = async () => ({
    startThread: () => ({
      runStreamed: async () => ({
        events: (async function* () {
          yield { type: 'thread.started' };
          yield { type: 'turn.started' };
          yield {
            type: 'item.completed',
            item: { id: 'warning-1', type: 'error', message: `temporary read warning in ${root}` }
          };
          yield {
            type: 'item.completed',
            item: {
              type: 'agent_message',
              text: JSON.stringify({
                completed: true,
                action: 'analyze-screenplay',
                summary: '已恢复并完成本集分析',
                processedCount: 1,
                analysis: episodeAnalysis(1)
              })
            }
          };
          yield { type: 'turn.completed' };
        })()
      })
    })
  });

  const result = await runCodexAgentAction(
    { action: 'analyze-screenplay', projectRoot: root },
    {
      createCodex,
      ...analysisRuntime(),
      readAnalysisProgress: analysisProgressSequence(
        analysisProgress(),
        analysisProgress({ completed: [1] })
      ),
      emit: (line) => emitted.push(line),
      totalTimeoutMs: 1000,
      idleTimeoutMs: 500
    }
  );

  assert.equal(result.completed, true);
  assert.equal(result.processedCount, 1);
  assert.equal(emitted.some((line) => /Codex Agent 非致命提示/u.test(line)), true);
  assert.equal(emitted.some((line) => line.includes(root)), false);
});

test('network retry exhaustion aborts the SDK turn instead of waiting forever', async (context) => {
  const root = await createProject(context);
  const emitted = [];
  let sdkSignal = null;
  const createCodex = async () => ({
    startThread: () => ({
      runStreamed: async (_prompt, options) => {
        sdkSignal = options.signal;
        return {
          events: (async function* () {
            yield { type: 'turn.started' };
            for (let attempt = 1; attempt <= 3; attempt += 1) {
              yield { type: 'error', message: `temporary network error ${attempt}` };
            }
          })()
        };
      }
    })
  });

  await assert.rejects(
    runCodexAgentAction(
      { action: 'analyze-screenplay', projectRoot: root },
      {
        createCodex,
        ...analysisRuntime(),
        readAnalysisProgress: analysisProgressSequence(analysisProgress()),
        emit: (line) => emitted.push(line),
        totalTimeoutMs: 1000,
        idleTimeoutMs: 500,
        networkRetryLimit: 3
      }
    ),
    (error) => error instanceof CodexAgentWorkerError && error.code === 'CODEX_NETWORK_RETRY_EXHAUSTED'
  );
  assert.equal(sdkSignal?.aborted, true);
  assert.equal(emitted.includes('Codex Agent 连接短暂中断，正在自动重试（1/3）'), true);
  assert.equal(emitted.includes('Codex Agent 连接短暂中断，正在自动重试（2/3）'), true);
  assert.equal(emitted.includes('Codex Agent 连接短暂中断，正在自动重试（3/3）'), false);
});

test('authentication errors and incomplete standard receipts fail closed', async (context) => {
  const root = await createProject(context);
  const authCodex = async () => ({
    startThread: () => ({
      runStreamed: async () => ({ events: (async function* () { throw new Error('401 authentication required for token sk-abcdefghijk'); })() })
    })
  });
  await assert.rejects(
    runCodexAgentAction(
      { action: 'analyze-screenplay', projectRoot: root },
      {
        createCodex: authCodex,
        ...analysisRuntime(),
        readAnalysisProgress: analysisProgressSequence(analysisProgress()),
        emit: () => {},
        totalTimeoutMs: 1000,
        idleTimeoutMs: 500
      }
    ),
    (error) => error instanceof CodexAgentWorkerError && error.code === 'CODEX_AUTH_UNAVAILABLE'
  );

  const incompleteCodex = async () => ({
    startThread: () => ({ runStreamed: async () => ({ events: standardEvents('analyze-screenplay', { completed: false }) }) })
  });
  await assert.rejects(
    runCodexAgentAction(
      { action: 'analyze-screenplay', projectRoot: root },
      {
        createCodex: incompleteCodex,
        ...analysisRuntime(),
        readAnalysisProgress: analysisProgressSequence(analysisProgress()),
        emit: () => {},
        totalTimeoutMs: 1000,
        idleTimeoutMs: 500
      }
    ),
    (error) => error instanceof CodexAgentWorkerError && error.code === 'AGENT_REPORTED_INCOMPLETE'
  );
});

test('sanitizer removes project paths, credentials, usage and control characters', () => {
  const root = process.platform === 'win32' ? 'D:\\private\\project' : '/private/project';
  const sanitized = sanitizeAgentText(
    `${root} OPENAI_API_KEY=very-secret sk-abcdefghijk input_tokens=999\u0000`,
    root
  );
  for (const forbidden of [root, 'very-secret', 'abcdefghijk', '999', '\u0000']) {
    assert.equal(sanitized.includes(forbidden), false);
  }
});
