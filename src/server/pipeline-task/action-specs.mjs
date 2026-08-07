import { fileURLToPath } from 'node:url';

const CODEX_AGENT_WORKER_PATH = fileURLToPath(
  new URL('../codex-agent-worker.mjs', import.meta.url)
);

export const DEFAULT_PIPELINE_SKILL_PATH = fileURLToPath(
  new URL('../../../skills/ka-script-pipeline/SKILL.md', import.meta.url)
);

const makeCodexAgentCommand = (action, projectRoot, pipelineSkillPath, runtimeConfig) => ({
  executable: process.execPath,
  arguments: [
    CODEX_AGENT_WORKER_PATH,
    action,
    projectRoot,
    pipelineSkillPath,
    runtimeConfig?.model ?? '',
    runtimeConfig?.reasoningEffort ?? ''
  ],
  cwd: projectRoot
});

const BASE_ACTION_SPECS = Object.freeze({
  'environment-check': Object.freeze({
    requiredFiles: Object.freeze([
      Object.freeze(['scripts', 'commands', 'check_environment.ps1'])
    ]),
    makeCommands(projectRoot, [environmentCheck]) {
      return [{
        executable: 'powershell.exe',
        arguments: [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          environmentCheck,
          '-NoInstall'
        ],
        cwd: projectRoot
      }];
    }
  }),
  split: Object.freeze({
    requiredFiles: Object.freeze([
      Object.freeze(['scripts', 'commands', 'python.ps1']),
      Object.freeze(['scripts', 'pipeline', 'extract_screenplay.py'])
    ]),
    makeCommands(projectRoot, [pythonRunner, extractScreenplay]) {
      return [{
        executable: 'powershell.exe',
        arguments: [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          pythonRunner,
          extractScreenplay,
          projectRoot
        ],
        cwd: projectRoot
      }];
    }
  }),
  'validate-and-build-workbook': Object.freeze({
    requiredFiles: Object.freeze([
      Object.freeze(['scripts', 'commands', 'python.ps1']),
      Object.freeze(['scripts', 'pipeline', 'validate_asset_records.py']),
      Object.freeze(['scripts', 'commands', 'node.ps1']),
      Object.freeze(['scripts', 'pipeline', 'build_workbook.mjs'])
    ]),
    makeCommands(projectRoot, [pythonRunner, validateRecords, nodeRunner, buildWorkbook]) {
      return [{
        executable: 'powershell.exe',
        arguments: [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          pythonRunner,
          validateRecords,
          projectRoot
        ],
        cwd: projectRoot
      }, {
        executable: 'powershell.exe',
        arguments: [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          nodeRunner,
          buildWorkbook,
          projectRoot
        ],
        cwd: projectRoot
      }];
    }
  }),
  'build-builtin-queue': Object.freeze({
    requiredFiles: Object.freeze([
      Object.freeze(['scripts', 'commands', 'node.ps1']),
      Object.freeze(['scripts', 'pipeline', 'build_image_queue.mjs'])
    ]),
    makeCommands(projectRoot, [nodeRunner, buildImageQueue]) {
      return [{
        executable: 'powershell.exe',
        arguments: [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          nodeRunner,
          buildImageQueue,
          projectRoot
        ],
        cwd: projectRoot
      }];
    }
  }),
  'analyze-screenplay': Object.freeze({
    requiresPipelineSkill: true,
    requiredFiles: Object.freeze([
      Object.freeze(['scripts', 'commands', 'node.ps1']),
      Object.freeze(['scripts', 'commands', 'python.ps1']),
      Object.freeze(['scripts', 'pipeline', 'update_analysis_progress.mjs']),
      Object.freeze(['scripts', 'pipeline', 'write_episode_analysis.py']),
      Object.freeze(['scripts', 'pipeline', 'query_asset_records.py']),
      Object.freeze(['scripts', 'pipeline', 'sync_episode_analysis.py'])
    ]),
    makeCommands(projectRoot, _runtimeFiles, pipelineSkillPath, taskOptions) {
      return [makeCodexAgentCommand('analyze-screenplay', projectRoot, pipelineSkillPath, taskOptions.runtimeConfig)];
    }
  }),
  'build-world-overview': Object.freeze({
    requiresPipelineSkill: true,
    requiredFiles: Object.freeze([
      Object.freeze(['scripts', 'commands', 'python.ps1']),
      Object.freeze(['scripts', 'pipeline', 'page_world_records.py']),
      Object.freeze(['scripts', 'pipeline', 'finalize_world_overview.py'])
    ]),
    makeCommands(projectRoot, _runtimeFiles, pipelineSkillPath, taskOptions) {
      return [makeCodexAgentCommand('build-world-overview', projectRoot, pipelineSkillPath, taskOptions.runtimeConfig)];
    }
  }),
  'complete-asset-visual-specs': Object.freeze({
    requiresPipelineSkill: true,
    requiredFiles: Object.freeze([
      Object.freeze(['scripts', 'commands', 'python.ps1']),
      Object.freeze(['scripts', 'pipeline', 'asset_visual_specs.py'])
    ]),
    makeCommands(projectRoot, _runtimeFiles, pipelineSkillPath, taskOptions) {
      return [makeCodexAgentCommand('complete-asset-visual-specs', projectRoot, pipelineSkillPath, taskOptions.runtimeConfig)];
    }
  }),
  'classify-prompt-branches': Object.freeze({
    requiresPipelineSkill: true,
    requiredFiles: Object.freeze([
      Object.freeze(['scripts', 'commands', 'node.ps1']),
      Object.freeze(['scripts', 'pipeline', 'build_image_queue.mjs']),
      Object.freeze(['scripts', 'lib', 'prompt_catalog.mjs']),
      Object.freeze(['assets', '图片生成', 'prompts', 'catalog.json']),
      Object.freeze(['assets', '图片生成', 'prompts', 'modifiers', 'condition-modules-v1.json']),
      Object.freeze(['输出', '剧本资产制表.xlsx'])
    ]),
    makeCommands(projectRoot, _runtimeFiles, pipelineSkillPath, taskOptions) {
      return [makeCodexAgentCommand('classify-prompt-branches', projectRoot, pipelineSkillPath, taskOptions.runtimeConfig)];
    }
  })
});

const FULL_PIPELINE_STEPS = Object.freeze([
  'environment-check',
  'split',
  'analyze-screenplay',
  'build-world-overview',
  Object.freeze({
    requiredFiles: Object.freeze([]),
    makeCommands(projectRoot) {
      return [{ checkpoint: 'pending-assets', cwd: projectRoot }];
    }
  }),
  'complete-asset-visual-specs',
  'validate-and-build-workbook'
]);
const FINALIZE_AFTER_CONFIRMATION_STEPS = Object.freeze([
  'complete-asset-visual-specs',
  'validate-and-build-workbook'
]);
const ANALYZE_SCREENPLAY_STEPS = Object.freeze(['split', 'analyze-screenplay']);
const SCOPED_WORKBOOK_FINALIZE_SPEC = Object.freeze({
  requiredFiles: BASE_ACTION_SPECS['validate-and-build-workbook'].requiredFiles,
  makeCommands(projectRoot, [pythonRunner, validateRecords, nodeRunner, buildWorkbook], _pipelineSkillPath, taskOptions) {
    return [{
      executable: 'powershell.exe',
      arguments: [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        pythonRunner, validateRecords, projectRoot
      ],
      cwd: projectRoot
    }, {
      executable: 'powershell.exe',
      arguments: [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        nodeRunner, buildWorkbook, projectRoot,
        `--episode-start=${taskOptions.workbookEpisodeStart}`,
        `--episode-end=${taskOptions.workbookEpisodeEnd}`,
        `--asset-types=${taskOptions.workbookAssetTypes.join(',')}`
      ],
      cwd: projectRoot
    }];
  }
});
const SCOPED_WORKBOOK_STEPS = Object.freeze([
  'environment-check', 'split', 'analyze-screenplay', 'build-world-overview',
  Object.freeze({
    requiredFiles: Object.freeze([]),
    makeCommands(projectRoot) {
      return [{ checkpoint: 'pending-assets', cwd: projectRoot }];
    }
  }),
  'complete-asset-visual-specs', SCOPED_WORKBOOK_FINALIZE_SPEC
]);

const makeSequencedActionSpec = (actions) => {
  const steps = Object.freeze(actions.map((action) => Object.freeze({
    id: typeof action === 'string' ? action : null,
    spec: typeof action === 'string' ? BASE_ACTION_SPECS[action] : action
  })));
  return Object.freeze({
    requiresPipelineSkill: steps.some(({ spec }) => spec.requiresPipelineSkill),
    requiredFiles: Object.freeze(steps.flatMap(({ spec }) => spec.requiredFiles)),
    makeCommands(projectRoot, runtimeFiles, pipelineSkillPath, taskOptions) {
      let offset = 0;
      return steps.flatMap(({ id, spec }) => {
        const stepFiles = runtimeFiles.slice(offset, offset + spec.requiredFiles.length);
        offset += spec.requiredFiles.length;
        if (id === 'split' && Number.isInteger(taskOptions?.resumeAnalysisEpisode)) return [];
        return spec.makeCommands(projectRoot, stepFiles, pipelineSkillPath, taskOptions);
      });
    }
  });
};

export const ACTION_SPECS = Object.freeze({
  ...BASE_ACTION_SPECS,
  'analyze-screenplay': makeSequencedActionSpec(ANALYZE_SCREENPLAY_STEPS),
  'build-scoped-workbook': makeSequencedActionSpec(SCOPED_WORKBOOK_STEPS),
  'finalize-after-confirmation': makeSequencedActionSpec(FINALIZE_AFTER_CONFIRMATION_STEPS),
  'run-full-pipeline': makeSequencedActionSpec(FULL_PIPELINE_STEPS)
});

export const PIPELINE_TASK_ACTIONS = Object.freeze(Object.keys(ACTION_SPECS));
