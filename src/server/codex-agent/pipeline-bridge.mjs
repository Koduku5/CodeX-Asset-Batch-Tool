import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { readAssetRegistries } from './analysis-progress.mjs';
import { parseAgentJson, reconcileAnalysisAssetIdentities } from './result-validation.mjs';
import { sanitizeAgentText, workerError } from './worker-errors.mjs';

const MAX_PIPELINE_COMMAND_OUTPUT_BYTES = 64 * 1024;

const runControlledProcess = ({ executable, argumentsList, cwd, input = null, signal, onActivity }) => new Promise((resolve, reject) => {
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let settled = false;
  const child = spawn(executable, argumentsList, {
    cwd,
    windowsHide: true,
    signal,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const append = (current, chunk) => {
    const combined = Buffer.concat([current, Buffer.from(chunk)]);
    return combined.length > MAX_PIPELINE_COMMAND_OUTPUT_BYTES
      ? combined.subarray(combined.length - MAX_PIPELINE_COMMAND_OUTPUT_BYTES)
      : combined;
  };
  child.stdout.on('data', (chunk) => {
    stdout = append(stdout, chunk);
    onActivity?.();
  });
  child.stderr.on('data', (chunk) => {
    stderr = append(stderr, chunk);
    onActivity?.();
  });
  child.once('error', (error) => {
    if (settled) return;
    settled = true;
    reject(error);
  });
  child.once('close', (code, closeSignal) => {
    if (settled) return;
    settled = true;
    if (code === 0 && !closeSignal) {
      resolve(stdout.toString('utf8'));
      return;
    }
    reject(new Error(`pipeline command exited with ${closeSignal ? `signal ${closeSignal}` : `code ${code ?? 1}`}: ${stderr.toString('utf8')}`));
  });
  child.stdin.on('error', () => {});
  if (input === null) child.stdin.end();
  else child.stdin.end(input, 'utf8');
});

const runProjectPipelineScript = async ({
  projectRoot, runtime, script, argumentsList, input, signal, onActivity, label,
  errorCode = 'ANALYSIS_PIPELINE_FAILED'
}) => {
  const runner = join(projectRoot, 'scripts', 'commands', `${runtime}.ps1`);
  const scriptPath = join(projectRoot, 'scripts', 'pipeline', script);
  try {
    return await runControlledProcess({
      executable: 'powershell.exe',
      argumentsList: [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        runner, scriptPath, projectRoot, ...argumentsList
      ],
      cwd: projectRoot,
      input,
      signal,
      onActivity
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    const detail = sanitizeAgentText(error?.message, projectRoot)
      .replace(/^pipeline command exited with (?:signal \S+|code \d+):\s*/iu, '')
      .replace(/\s+/gu, ' ')
      .slice(0, 240);
    throw workerError(errorCode, `${label}失败${detail ? `：${detail}` : ''}`, error);
  }
};

export const prepareAnalysisEpisodeDefault = async ({ projectRoot, episode, resume, signal, onActivity, onProgress }) => {
  await runProjectPipelineScript({
    projectRoot,
    runtime: 'node',
    script: 'update_analysis_progress.mjs',
    argumentsList: ['start', String(episode), ...(resume ? ['--resume'] : [])],
    signal,
    onActivity,
    label: `第 ${episode} 集开始标记`
  });
  onProgress?.('当前集分析进度已更新');
};

export const commitAnalysisEpisodeDefault = async ({ projectRoot, episode, analysis, signal, onActivity, onProgress }) => {
  const registries = await readAssetRegistries(projectRoot);
  const reconciledAnalysis = reconcileAnalysisAssetIdentities(analysis, registries);
  await runProjectPipelineScript({
    projectRoot,
    runtime: 'python',
    script: 'write_episode_analysis.py',
    argumentsList: [String(episode)],
    input: JSON.stringify(reconciledAnalysis),
    signal,
    onActivity,
    label: `第 ${episode} 集分析文件写入`
  });
  onProgress?.('当前集分析文件已安全保存');
  await runProjectPipelineScript({
    projectRoot,
    runtime: 'python',
    script: 'sync_episode_analysis.py',
    argumentsList: [String(episode)],
    signal,
    onActivity,
    label: `第 ${episode} 集累计同步`
  });
  onProgress?.('当前集分析结果已累计保存');
  await runProjectPipelineScript({
    projectRoot,
    runtime: 'node',
    script: 'update_analysis_progress.mjs',
    argumentsList: ['complete', String(episode)],
    signal,
    onActivity,
    label: `第 ${episode} 集完成标记`
  });
  onProgress?.('当前集分析进度已更新');
};

export const runVisualSpecScriptDefault = async ({ projectRoot, command, payload = null, signal, onActivity }) => {
  const text = await runProjectPipelineScript({
    projectRoot,
    runtime: 'python',
    script: 'asset_visual_specs.py',
    argumentsList: [command],
    input: payload === null ? null : JSON.stringify(payload),
    signal,
    onActivity,
    label: `资产视觉规格${command === 'commit' ? '回填' : command === 'next' ? '读取' : '初始化'}`,
    errorCode: 'VISUAL_SPECS_PIPELINE_FAILED'
  });
  const result = parseAgentJson(text, '资产视觉规格本地脚本');
  if (result?.ok !== true) throw workerError('VISUAL_SPECS_PIPELINE_FAILED', '资产视觉规格本地脚本未返回成功状态');
  return result;
};

export const commitWorldOverviewDefault = async ({ projectRoot, content, signal, onActivity, onProgress }) => {
  const text = await runProjectPipelineScript({
    projectRoot,
    runtime: 'python',
    script: 'finalize_world_overview.py',
    argumentsList: [],
    input: JSON.stringify({ content }),
    signal,
    onActivity,
    label: '世界观总览正式提交',
    errorCode: 'WORLD_OVERVIEW_PIPELINE_FAILED'
  });
  const receipt = parseAgentJson(text, '世界观总览正式脚本');
  if (receipt?.ok !== true) throw workerError('WORLD_OVERVIEW_PIPELINE_FAILED', '世界观总览正式脚本未返回成功状态');
  onProgress?.('世界观总览已完成正式校验');
  return receipt;
};
