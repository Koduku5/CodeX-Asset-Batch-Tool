import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  PROJECT_ID_PATTERN,
  createSoftwareWorkspace,
  projectIdFromDisplayName,
  sanitizeScreenplayFilename
} from '../src/server/software-workspace.mjs';

const createFixture = async (t, options = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'prompt-studio-workspace-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'package');
  const softwareRoot = join(root, 'software');
  await mkdir(join(packageRoot, 'assets', 'prompts'), { recursive: true });
  await mkdir(join(packageRoot, 'scripts', 'pipeline'), { recursive: true });
  await mkdir(join(packageRoot, 'references'), { recursive: true });
  await writeFile(join(packageRoot, 'assets', 'prompts', 'catalog.json'), '{"schemaVersion":1}\n');
  await writeFile(join(packageRoot, 'scripts', 'pipeline', 'extract_screenplay.py'), 'print("split")\n');
  await writeFile(join(packageRoot, 'SKILL.md'), '# Isolated project instructions\n');
  await writeFile(join(packageRoot, 'references', 'asset-rules.md'), '# Asset rules\n');
  const workspace = createSoftwareWorkspace({ softwareRoot, packageRoot, ...options });
  return { root, packageRoot, softwareRoot, workspace };
};

const treeDigest = async (root) => {
  const values = [];
  const visit = async (current, relativePath = '') => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = join(current, entry.name);
      const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        values.push(`d:${childRelative}`);
        await visit(entryPath, childRelative);
      } else {
        const bytes = await readFile(entryPath);
        values.push(`f:${childRelative}:${createHash('sha256').update(bytes).digest('hex')}`);
      }
    }
  };
  await visit(root);
  return values;
};

const LEGACY_PROMPT_CATALOG = `{
  "version": 1,
  "paths": {
    "referenceModifiers": "modifiers/reference-mode.json",
    "apiDefaults": "fragments/api/default-templates.json"
  }
}
`;

const CURRENT_PROMPT_CATALOG = `{
  "version": 1,
  "paths": {
    "referenceModifiers": "modifiers/reference-mode.json",
    "conditionModules": "modifiers/condition-modules-v1.json",
    "apiDefaults": "fragments/api/default-templates.json"
  }
}
`;

const createLegacyPromptCatalogFixture = async (t) => {
  const fixture = await createFixture(t);
  const packagePromptRoot = join(fixture.packageRoot, 'assets', '图片生成', 'prompts');
  const sharedAssetsRoot = join(fixture.softwareRoot, 'workspace', 'shared-assets');
  const sharedPromptRoot = join(sharedAssetsRoot, '图片生成', 'prompts');
  await mkdir(join(packagePromptRoot, 'modifiers'), { recursive: true });
  await writeFile(join(packagePromptRoot, 'catalog.json'), CURRENT_PROMPT_CATALOG);
  await writeFile(join(packagePromptRoot, 'modifiers', 'condition-modules-v1.json'), '{"version":1,"modules":[]}\n');

  await mkdir(join(sharedAssetsRoot, 'prompts'), { recursive: true });
  await mkdir(join(sharedPromptRoot, 'modifiers'), { recursive: true });
  await writeFile(join(sharedAssetsRoot, 'prompts', 'catalog.json'), '{"schemaVersion":1}\n');
  await writeFile(join(sharedPromptRoot, 'catalog.json'), LEGACY_PROMPT_CATALOG);
  return { ...fixture, sharedAssetsRoot, sharedPromptRoot };
};

test('initialization and project creation write only below softwareRoot while package sources remain unchanged', async (t) => {
  const fixture = await createFixture(t, { clock: () => new Date('2026-08-04T00:00:00.000Z') });
  const packageBefore = await treeDigest(fixture.packageRoot);

  const paths = await fixture.workspace.initialize();
  assert.equal(paths.softwareRoot, fixture.softwareRoot);
  assert.equal(await readFile(join(paths.sharedAssetsRoot, 'prompts', 'catalog.json'), 'utf8'), '{"schemaVersion":1}\n');
  const sourceManifest = JSON.parse(await readFile(join(paths.workspaceRoot, '.shared-assets-source.json'), 'utf8'));
  assert.equal(sourceManifest.schemaVersion, 1);
  assert.equal(sourceManifest.algorithm, 'sha256-tree-v1');
  assert.match(sourceManifest.fingerprint, /^[a-f0-9]{64}$/u);

  const created = await fixture.workspace.createProject('高速公路测试');
  assert.match(created.projectId, PROJECT_ID_PATTERN);
  assert.equal(created.projectId, projectIdFromDisplayName('高速公路测试'));
  assert.equal(created.projectRoot.startsWith(fixture.softwareRoot), true);
  assert.deepEqual(JSON.parse(await readFile(join(created.projectRoot, 'project.json'), 'utf8')), {
    schemaVersion: 1,
    projectId: created.projectId,
    displayName: '高速公路测试',
    createdAt: '2026-08-04T00:00:00.000Z'
  });
  for (const directoryName of ['剧本', 'cache', '输出']) {
    assert.equal((await lstat(join(created.projectRoot, directoryName))).isDirectory(), true);
  }
  assert.deepEqual(await treeDigest(fixture.packageRoot), packageBefore);
  assert.deepEqual((await fixture.workspace.listProjects()).map(({ projectId }) => projectId), [created.projectId]);
});

test('project rename atomically changes only displayName while preserving project identity and contents', async (t) => {
  const fixture = await createFixture(t, { clock: () => new Date('2026-08-04T00:00:00.000Z') });
  const created = await fixture.workspace.createProject('原项目名');
  await writeFile(join(created.cacheRoot, 'keep.json'), '{"keep":true}\n');
  const metadataPath = join(created.projectRoot, 'project.json');
  const metadataBefore = {
    ...JSON.parse(await readFile(metadataPath, 'utf8')),
    extension: { keep: true }
  };
  await writeFile(metadataPath, `${JSON.stringify(metadataBefore, null, 2)}\n`);

  const renamed = await fixture.workspace.renameProject(created.projectId, '新项目名');

  assert.equal(renamed.projectId, created.projectId);
  assert.equal(renamed.projectRoot, created.projectRoot);
  assert.equal(renamed.displayName, '新项目名');
  assert.deepEqual(JSON.parse(await readFile(metadataPath, 'utf8')), {
    ...metadataBefore,
    displayName: '新项目名'
  });
  assert.equal(await readFile(join(created.cacheRoot, 'keep.json'), 'utf8'), '{"keep":true}\n');
  assert.deepEqual((await readdir(created.projectRoot)).filter((name) => name.startsWith('.project-')), []);
  assert.equal((await fixture.workspace.getProject(created.projectId)).displayName, '新项目名');
  await assert.rejects(fixture.workspace.renameProject(created.projectId, '../escape'), { code: 'INVALID_DISPLAY_NAME' });
});

test('project deletion removes exactly one isolated project and preserves siblings and shared assets', async (t) => {
  const fixture = await createFixture(t);
  const alpha = await fixture.workspace.createProject('删除目标');
  const beta = await fixture.workspace.createProject('保留目标');
  await writeFile(join(alpha.outputRoot, 'delete.txt'), 'delete me\n');
  await writeFile(join(beta.outputRoot, 'keep.txt'), 'keep project\n');
  await writeFile(join(fixture.workspace.paths.sharedAssetsRoot, 'keep-shared.txt'), 'keep shared\n');

  assert.deepEqual(await fixture.workspace.deleteProject(alpha.projectId), {
    projectId: alpha.projectId,
    deleted: true
  });

  assert.equal(await lstat(alpha.projectRoot).catch(() => null), null);
  assert.equal(await readFile(join(beta.outputRoot, 'keep.txt'), 'utf8'), 'keep project\n');
  assert.equal(
    await readFile(join(fixture.workspace.paths.sharedAssetsRoot, 'keep-shared.txt'), 'utf8'),
    'keep shared\n'
  );
  assert.deepEqual(
    (await readdir(fixture.workspace.paths.projectsRoot)).filter((name) => name.startsWith('.deleting-')),
    []
  );
  assert.deepEqual((await fixture.workspace.listProjects()).map(({ projectId }) => projectId), [beta.projectId]);
  await assert.rejects(fixture.workspace.deleteProject(alpha.projectId), { code: 'PROJECT_NOT_FOUND' });
  await assert.rejects(fixture.workspace.deleteProject('../escape'), { code: 'INVALID_PROJECT_ID' });
});

test('project deletion rejects nested symbolic links without touching their external target', async (t) => {
  const fixture = await createFixture(t);
  const project = await fixture.workspace.createProject('链接删除测试');
  const external = join(fixture.root, 'external-delete-target');
  await mkdir(external);
  await writeFile(join(external, 'outside.txt'), 'outside\n');
  try {
    await symlink(external, join(project.cacheRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip('当前系统不允许创建用于验证的符号链接或目录联接');
      return;
    }
    throw error;
  }

  await assert.rejects(fixture.workspace.deleteProject(project.projectId), { code: 'UNSAFE_REPARSE_POINT' });
  assert.equal((await lstat(project.projectRoot)).isDirectory(), true);
  assert.equal(await readFile(join(external, 'outside.txt'), 'utf8'), 'outside\n');
});

test('legacy unmodified shared assets receive the new conditionModules catalog source exactly once', async (t) => {
  const fixture = await createLegacyPromptCatalogFixture(t);
  const packageBefore = await treeDigest(fixture.packageRoot);

  await fixture.workspace.initialize();

  assert.equal(await readFile(join(fixture.sharedPromptRoot, 'catalog.json'), 'utf8'), CURRENT_PROMPT_CATALOG);
  assert.equal(
    await readFile(join(fixture.sharedPromptRoot, 'modifiers', 'condition-modules-v1.json'), 'utf8'),
    '{"version":1,"modules":[]}\n'
  );
  const manifest = JSON.parse(
    await readFile(join(fixture.softwareRoot, 'workspace', '.shared-assets-source.json'), 'utf8')
  );
  assert.equal(
    manifest.entries.some(({ path }) => path === '图片生成/prompts/modifiers/condition-modules-v1.json'),
    true
  );
  assert.deepEqual(await treeDigest(fixture.packageRoot), packageBefore);
});

test('legacy shared assets with any user change are preserved without recording false provenance', async (t) => {
  const fixture = await createLegacyPromptCatalogFixture(t);
  await writeFile(join(fixture.sharedAssetsRoot, 'user-custom.json'), '{"keep":true}\n');

  await fixture.workspace.initialize();

  assert.equal(await readFile(join(fixture.sharedPromptRoot, 'catalog.json'), 'utf8'), LEGACY_PROMPT_CATALOG);
  assert.equal(
    await lstat(join(fixture.sharedPromptRoot, 'modifiers', 'condition-modules-v1.json')).catch(() => null),
    null
  );
  assert.equal(await readFile(join(fixture.sharedAssetsRoot, 'user-custom.json'), 'utf8'), '{"keep":true}\n');
  assert.equal(
    await lstat(join(fixture.softwareRoot, 'workspace', '.shared-assets-source.json')).catch(() => null),
    null
  );
});

test('recorded source manifest permits a later untouched shared-assets snapshot to upgrade safely', async (t) => {
  const fixture = await createFixture(t);
  await fixture.workspace.initialize();
  const manifestPath = join(fixture.softwareRoot, 'workspace', '.shared-assets-source.json');
  const firstManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(join(fixture.packageRoot, 'assets', 'prompts', 'catalog.json'), '{"schemaVersion":2}\n');
  await writeFile(join(fixture.packageRoot, 'assets', 'prompts', 'new-module.json'), '{"version":1}\n');

  const upgradedWorkspace = createSoftwareWorkspace({
    softwareRoot: fixture.softwareRoot,
    packageRoot: fixture.packageRoot
  });
  await upgradedWorkspace.initialize();

  assert.equal(
    await readFile(join(fixture.softwareRoot, 'workspace', 'shared-assets', 'prompts', 'catalog.json'), 'utf8'),
    '{"schemaVersion":2}\n'
  );
  assert.equal(
    await readFile(join(fixture.softwareRoot, 'workspace', 'shared-assets', 'prompts', 'new-module.json'), 'utf8'),
    '{"version":1}\n'
  );
  const upgradedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.notEqual(upgradedManifest.fingerprint, firstManifest.fingerprint);
});

test('recorded source manifest never authorizes overwriting user-modified shared assets', async (t) => {
  const fixture = await createFixture(t);
  await fixture.workspace.initialize();
  const manifestPath = join(fixture.softwareRoot, 'workspace', '.shared-assets-source.json');
  const manifestBefore = await readFile(manifestPath, 'utf8');
  const sharedCatalogPath = join(fixture.softwareRoot, 'workspace', 'shared-assets', 'prompts', 'catalog.json');
  await writeFile(sharedCatalogPath, '{"user":"custom"}\n');
  await writeFile(join(fixture.packageRoot, 'assets', 'prompts', 'catalog.json'), '{"schemaVersion":2}\n');
  await writeFile(join(fixture.packageRoot, 'assets', 'prompts', 'new-module.json'), '{"version":1}\n');

  const upgradedWorkspace = createSoftwareWorkspace({
    softwareRoot: fixture.softwareRoot,
    packageRoot: fixture.packageRoot
  });
  await upgradedWorkspace.initialize();

  assert.equal(await readFile(sharedCatalogPath, 'utf8'), '{"user":"custom"}\n');
  assert.equal(
    await lstat(join(fixture.softwareRoot, 'workspace', 'shared-assets', 'prompts', 'new-module.json')).catch(() => null),
    null
  );
  assert.equal(await readFile(manifestPath, 'utf8'), manifestBefore);
});

test('runtime materialization snapshots read-only sources and keeps projects isolated', async (t) => {
  const fixture = await createFixture(t);
  await mkdir(join(fixture.packageRoot, 'scripts', 'pipeline', '__pycache__'));
  await writeFile(join(fixture.packageRoot, 'scripts', 'pipeline', '__pycache__', 'ignored.pyc'), 'generated cache');
  await writeFile(join(fixture.packageRoot, 'scripts', 'pipeline', 'ignored.pyc'), 'generated cache');
  const packageBefore = await treeDigest(fixture.packageRoot);
  const alpha = await fixture.workspace.createProject('项目 Alpha');
  const beta = await fixture.workspace.createProject('项目 Beta');
  await fixture.workspace.materializeProjectRuntime(alpha.projectId);
  await fixture.workspace.materializeProjectRuntime(beta.projectId);

  const stableScriptPath = join(alpha.projectRoot, 'scripts', 'pipeline', 'extract_screenplay.py');
  const stableScriptBefore = await lstat(stableScriptPath);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await fixture.workspace.materializeProjectRuntime(alpha.projectId);
  const stableScriptAfter = await lstat(stableScriptPath);
  assert.equal(stableScriptAfter.mtimeMs, stableScriptBefore.mtimeMs);

  assert.equal(await lstat(join(alpha.projectRoot, 'SKILL.md')).catch(() => null), null);
  assert.equal(await lstat(join(alpha.projectRoot, 'references')).catch(() => null), null);
  assert.equal(await lstat(join(alpha.projectRoot, 'scripts', 'pipeline', '__pycache__')).catch(() => null), null);
  assert.equal(await lstat(join(alpha.projectRoot, 'scripts', 'pipeline', 'ignored.pyc')).catch(() => null), null);

  const alphaCatalog = join(alpha.projectRoot, 'assets', 'prompts', 'catalog.json');
  const betaCatalog = join(beta.projectRoot, 'assets', 'prompts', 'catalog.json');
  await writeFile(alphaCatalog, '{"project":"alpha"}\n');
  assert.equal(await readFile(betaCatalog, 'utf8'), '{"schemaVersion":1}\n');
  assert.equal(await readFile(join(alpha.projectRoot, 'scripts', 'pipeline', 'extract_screenplay.py'), 'utf8'), 'print("split")\n');

  await writeFile(join(fixture.workspace.paths.sharedAssetsRoot, 'prompts', 'catalog.json'), '{"shared":2}\n');
  await writeFile(join(alpha.cacheRoot, 'user-state.json'), '{"keep":true}\n');
  await writeFile(join(alpha.outputRoot, 'result.txt'), 'keep output\n');
  await writeFile(join(alpha.screenplayRoot, 'episode.txt'), 'keep screenplay\n');
  await fixture.workspace.materializeProjectRuntime(beta.projectId);
  await fixture.workspace.materializeProjectRuntime(alpha.projectId);
  assert.equal(await readFile(betaCatalog, 'utf8'), '{"shared":2}\n');
  assert.equal(await readFile(alphaCatalog, 'utf8'), '{"shared":2}\n');
  assert.equal(await readFile(join(alpha.cacheRoot, 'user-state.json'), 'utf8'), '{"keep":true}\n');
  assert.equal(await readFile(join(alpha.outputRoot, 'result.txt'), 'utf8'), 'keep output\n');
  assert.equal(await readFile(join(alpha.screenplayRoot, 'episode.txt'), 'utf8'), 'keep screenplay\n');
  assert.deepEqual(await treeDigest(fixture.packageRoot), packageBefore);
});

test('project names, project limits, and project ids reject dangerous or ambiguous input', async (t) => {
  const fixture = await createFixture(t, { maxProjects: 1, maxDisplayNameLength: 12 });
  for (const displayName of ['', ' name', 'name ', '..', '../escape', 'bad/name', 'bad\\name', 'line\nbreak', '1234567890123']) {
    await assert.rejects(fixture.workspace.createProject(displayName), { code: 'INVALID_DISPLAY_NAME' });
  }
  await fixture.workspace.createProject('项目一');
  await assert.rejects(fixture.workspace.createProject('项目二'), { code: 'PROJECT_LIMIT_REACHED' });
  await assert.rejects(fixture.workspace.getProject('../escape'), { code: 'INVALID_PROJECT_ID' });
  await assert.rejects(fixture.workspace.materializeProjectRuntime('..'), { code: 'INVALID_PROJECT_ID' });
  assert.throws(
    () => createSoftwareWorkspace({ softwareRoot: fixture.packageRoot, packageRoot: fixture.packageRoot }),
    { code: 'INVALID_ROOT' }
  );
});

test('symbolic links and directory junctions are rejected in source and project target trees', async (t) => {
  const fixture = await createFixture(t);
  const external = join(fixture.root, 'external');
  await mkdir(external);
  await writeFile(join(external, 'outside.txt'), 'outside');
  const sourceLink = join(fixture.packageRoot, 'assets', 'linked');
  try {
    await symlink(external, sourceLink, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip('当前系统不允许创建用于验证的符号链接或目录联接');
      return;
    }
    throw error;
  }
  await assert.rejects(fixture.workspace.initialize(), { code: 'UNSAFE_REPARSE_POINT' });

  await rm(sourceLink, { force: true });
  const safeWorkspace = createSoftwareWorkspace({ softwareRoot: fixture.softwareRoot, packageRoot: fixture.packageRoot });
  const project = await safeWorkspace.createProject('安全项目');
  await rm(project.screenplayRoot, { recursive: true, force: true });
  await symlink(external, project.screenplayRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    safeWorkspace.importScreenplay(project.projectId, { filename: 'episode.txt', buffer: Buffer.from('data') }),
    { code: 'UNSAFE_REPARSE_POINT' }
  );
  assert.equal(await readFile(join(external, 'outside.txt'), 'utf8'), 'outside');
});

test('screenplays support buffer and stream imports, sanitize names, and require explicit overwrite', async (t) => {
  const fixture = await createFixture(t);
  const project = await fixture.workspace.createProject('导入测试');

  assert.equal(sanitizeScreenplayFilename(' 第 1 集:草稿.TXT '), '第 1 集_草稿.txt');
  const first = await fixture.workspace.importScreenplay(project.projectId, {
    filename: ' 第 1 集:草稿.TXT ',
    buffer: Buffer.from('first')
  });
  assert.equal(first.filename, '第 1 集_草稿.txt');
  assert.equal(first.size, 5);
  assert.equal(await readFile(first.path, 'utf8'), 'first');
  await assert.rejects(
    fixture.workspace.importScreenplay(project.projectId, { filename: first.filename, buffer: Buffer.from('second') }),
    { code: 'SCREENPLAY_EXISTS' }
  );
  await fixture.workspace.importScreenplay(project.projectId, {
    filename: first.filename,
    stream: Readable.from([Buffer.from('sec'), Buffer.from('ond')]),
    overwrite: true
  });
  assert.equal(await readFile(first.path, 'utf8'), 'second');
  assert.deepEqual((await readdir(project.screenplayRoot)).filter((name) => name.startsWith('.upload-')), []);
});

test('screenplay import rejects paths, unsupported types, invalid payloads, and oversized streams without residue', async (t) => {
  const fixture = await createFixture(t, { maxScreenplayBytes: 8 });
  const project = await fixture.workspace.createProject('限制测试');
  await assert.rejects(
    fixture.workspace.importScreenplay(project.projectId, { filename: '../escape.txt', buffer: Buffer.from('x') }),
    { code: 'UNSAFE_FILENAME' }
  );
  await assert.rejects(
    fixture.workspace.importScreenplay(project.projectId, { filename: 'image.png', buffer: Buffer.from('x') }),
    { code: 'UNSUPPORTED_SCREENPLAY_TYPE' }
  );
  await assert.rejects(
    fixture.workspace.importScreenplay(project.projectId, { filename: 'episode.txt', buffer: 'not bytes' }),
    { code: 'INVALID_UPLOAD_BODY' }
  );
  await assert.rejects(
    fixture.workspace.importScreenplay(project.projectId, { filename: 'empty.txt', buffer: Buffer.alloc(0) }),
    { code: 'EMPTY_SCREENPLAY' }
  );
  await assert.rejects(
    fixture.workspace.importScreenplay(project.projectId, {
      filename: 'episode.docx',
      stream: Readable.from([Buffer.alloc(4), Buffer.alloc(5)])
    }),
    { code: 'SCREENPLAY_TOO_LARGE' }
  );
  assert.deepEqual(await readdir(project.screenplayRoot), []);
  assert.equal(await lstat(join(fixture.root, 'escape.txt')).catch(() => null), null);
});
