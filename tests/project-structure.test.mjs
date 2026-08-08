import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const read = (relativePath) => readFile(path.join(root, relativePath), 'utf8');

test('the product owns its engine, skills, UI, server and desktop boundaries', async () => {
  for (const relativePath of [
    'engine/assets',
    'engine/scripts',
    'docs/reference',
    'skills/ka-script-pipeline/references',
    'skills/ka-builtin-imagegen/references',
    'skills/ka-script-pipeline/SKILL.md',
    'skills/ka-episode-asset-analysis/SKILL.md',
    'skills/ka-episode-asset-analysis/agents/openai.yaml',
    'skills/ka-builtin-imagegen/SKILL.md',
    'src/ui/App.tsx',
    'src/ui/features/README.md',
    'src/ui/features/workbench/workbench-app.tsx',
    'src/ui/features/prompt-studio/prompt-studio-drawer.tsx',
    'src/ui/services',
    'src/server/server.mjs',
    'src/server/server-http.mjs',
    'src/server/server-services.mjs',
    'src/server/software-workspace/config.mjs',
    'src/server/routes/api-routes.mjs',
    'src/server/routes/api/system-api-routes.mjs',
    'src/server/routes/api/project-api-routes.mjs',
    'src/server/routes/api/prompt-api-routes.mjs',
    'src/server/routes/desktop-routes.mjs',
    'src/server/routes/static-route.mjs',
    'src/server/codex-agent/analyze-screenplay.mjs',
    'src/server/codex-agent/branch-classification-action.mjs',
    'src/server/codex-agent/thread-runner.mjs',
    'src/server/codex-agent/worker-runtime.mjs',
    'src/server/codex-agent-chat/contracts.mjs',
    'src/server/codex-imagegen-handoff/contracts.mjs',
    'src/server/prompt-branch-classification/contracts.mjs',
    'src/server/codex-agent/build-world-overview.mjs',
    'src/server/codex-agent/complete-asset-visual-specs.mjs',
    'src/server/codex-agent/contracts.mjs',
    'src/server/pipeline-task/action-specs.mjs',
    'src/server/pipeline-task/contracts.mjs',
    'engine/scripts/lib/prompt_catalog.mjs',
    'engine/scripts/lib/prompt-catalog/core.mjs',
    'engine/scripts/lib/prompt-catalog/loader.mjs',
    'engine/scripts/lib/prompt-catalog/resolver.mjs',
    'engine/scripts/lib/prompt-catalog/validation.mjs',
    'engine/scripts/lib/prompt-catalog/legacy.mjs',
    'engine/scripts/lib/pipeline_runtime.mjs',
    'engine/scripts/lib/pipeline-runtime/prompt-context.mjs',
    'engine/scripts/lib/pipeline-runtime/agent-placeholders.mjs',
    'engine/scripts/lib/pipeline-runtime/prompt-fields.mjs',
    'engine/scripts/lib/pipeline-runtime/builtin-batch.mjs',
    'engine/scripts/lib/pipeline-runtime/prompt-spec.mjs',
    'engine/scripts/lib/api_batch/__init__.py',
    'engine/scripts/lib/api_batch/image_validation.py',
    'engine/scripts/lib/api_batch/progress_store.py',
    'engine/scripts/lib/api_batch/canvas_layout.py',
    'engine/scripts/lib/asset_record_validation.py',
    'engine/scripts/lib/world_delivery_validation.py',
    'packaging/build-release.ps1',
    'packaging/installer.iss',
    'desktop/PromptStudio.Desktop/PromptStudio.Desktop.csproj'
  ]) await access(path.join(root, relativePath));

  for (const legacyStandaloneEntry of [
    'engine/scripts/commands/progress_viewer.cmd',
    'engine/scripts/commands/progress_viewer.ps1',
    'engine/scripts/commands/start_pipeline_session.ps1',
    'engine/scripts/commands/configure_builtin_prompts.ps1',
    'engine/scripts/commands/open_prompt_settings.ps1',
    'engine/scripts/commands/reset_cache.ps1',
    'engine/scripts/commands/show_pipeline_progress.mjs',
    'engine/references/builtin-prompt-ui.md',
    'engine/references',
    'docs/legacy/ka-script-asset-batch-skill.md'
  ]) {
    await assert.rejects(access(path.join(root, legacyStandaloneEntry)), { code: 'ENOENT' });
  }

  const server = await read('src/server/server.mjs');
  assert.match(server, /\.\.\/\.\.\/engine\/scripts\/lib\/prompt_catalog\.mjs/u);
  assert.doesNotMatch(server, /ka-script-asset-batch安装包/u);

  const workspace = await read('src/server/software-workspace.mjs');
  assert.match(workspace, /\.local/u);
  assert.match(workspace, /engineRoot/u);

  const project = await read('desktop/PromptStudio.Desktop/PromptStudio.Desktop.csproj');
  assert.match(project, /<TargetFramework>net10\.0-windows<\/TargetFramework>/u);
  assert.match(project, /<UseWPF>true<\/UseWPF>/u);
  assert.match(project, /Microsoft\.Web\.WebView2/u);
  assert.match(project, /sidecar\\engine/u);
  assert.match(project, /sidecar\\skills/u);
  assert.match(project, /src\\server\\\*\*\\\*\.mjs/u);
  assert.match(project, /sidecar\\src\\server\\%\(RecursiveDir\)/u);
  assert.match(project, /Exclude="[^"]*__pycache__[^"]*\*\.pyc"/u);

  const desktopEntry = await read('src/server/desktop-entry.mjs');
  assert.match(desktopEntry, /spawn\('explorer\.exe', \[projectRoot\]/u);
  assert.match(desktopEntry, /spawn\('powershell\.exe',[\s\S]*?start_api_batch|spawn\('powershell\.exe',[\s\S]*?scriptPath/u);
  assert.match(desktopEntry, /detached: true,[\s\S]*windowsHide: true,[\s\S]*stdio: 'ignore'/u);
});

test('software skills only link to files that exist inside this repository', async () => {
  for (const relativeSkill of [
    'skills/ka-script-pipeline/SKILL.md',
    'skills/ka-builtin-imagegen/SKILL.md'
  ]) {
    const skillPath = path.join(root, relativeSkill);
    const skill = await readFile(skillPath, 'utf8');
    const links = [...skill.matchAll(/\]\(([^)#]+)(?:#[^)]+)?\)/gu)]
      .map((match) => match[1])
      .filter((target) => !/^[a-z][a-z0-9+.-]*:/iu.test(target));
    assert.ok(links.length > 0, `${relativeSkill} should declare repository-local references`);
    for (const target of links) {
      const resolved = path.resolve(path.dirname(skillPath), decodeURIComponent(target));
      assert.equal(
        resolved.startsWith(`${root}${path.sep}`),
        true,
        `${relativeSkill} must not link outside the software repository: ${target}`
      );
      await access(resolved);
    }
  }
});

test('desktop bulk workspace stays under the software project root instead of defaulting to C drive', async () => {
  const desktopPaths = await read('desktop/PromptStudio.Desktop/DesktopPaths.cs');
  assert.match(desktopPaths, /FindApplicationRoot\(engineRoot\)/u);
  assert.match(desktopPaths, /AppContext\.BaseDirectory/u);
  assert.match(desktopPaths, /PromptStudio\.Desktop\.csproj/u);
  assert.match(desktopPaths, /Path\.Combine\(softwareRoot, "\.local", "desktop", "WebView2"\)/u);
  assert.doesNotMatch(desktopPaths, /LocalApplicationData|OpenFolderDialog|workspace-root\.txt/u);
});
