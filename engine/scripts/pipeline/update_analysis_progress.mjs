import fs from "node:fs/promises";
import path from "node:path";
import {
  acquirePipelineLock,
  canonicalSha256,
  canonicalJson,
  isObject,
  readJsonFile,
  readPipelineLock,
  readStableFileSnapshot,
  releasePipelineLock,
  requirePipelineLock,
  rotatePipelineLock,
  sha256,
  writeJsonAtomic,
} from "../lib/pipeline_runtime.mjs";

const [skillRootArg, action, episodeArg, ...flags] = process.argv.slice(2);
const resumeRequested = flags.includes("--resume");
if (!skillRootArg || !["start", "complete"].includes(action) || !episodeArg) {
  throw new Error(
    "用法：node update_analysis_progress.mjs <skill-root> <start|complete> <episode> [--resume]",
  );
}
if (flags.some((flag) => flag !== "--resume") || (resumeRequested && action !== "start")) {
  throw new Error("--resume 只能用于 start，且不接受其他参数");
}

const episode = Number(episodeArg);
if (!Number.isInteger(episode) || episode < 1) throw new Error(`无效集数：${episodeArg}`);

const skillRoot = path.resolve(skillRootArg);
const cacheDir = path.join(skillRoot, "cache");
const progressPath = path.join(cacheDir, "阅读进度.json");
const analysisPath = path.join(cacheDir, "单集分析", `第${String(episode).padStart(3, "0")}集.json`);
const originalPath = path.join(cacheDir, "单集原文", `第${String(episode).padStart(3, "0")}集.json`);
const registryDir = path.join(cacheDir, "累计记录");
const screenplayDir = path.join(skillRoot, "剧本");

const readJson = async (filePath, label) => {
  try {
    return await readJsonFile(filePath, { label });
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label}不存在：${filePath}`);
    throw error;
  }
};

const isNonEmptyText = (value) => typeof value === "string" && value.trim().length > 0;
const sameRecord = (left, right) =>
  canonicalJson(left) === canonicalJson(right);

const currentSourceManifest = async () => {
  const entries = await fs.readdir(screenplayDir, { withFileTypes: true });
  const names = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        !entry.name.startsWith("~$") &&
        [".docx", ".txt"].includes(path.extname(entry.name).toLowerCase()),
    )
    .map((entry) => entry.name);
  const manifest = [];
  for (const name of names) {
    const filePath = path.join(screenplayDir, name);
    const snapshot = await readStableFileSnapshot(filePath);
    if (!snapshot.exists) throw new Error(`剧本来源不是文件：${name}`);
    manifest.push({ name, size: snapshot.size, sha256: snapshot.sha256 });
  }
  return manifest;
};

const sourceManifestMatches = (recorded, current) => {
  if (!Array.isArray(recorded) || recorded.length !== current.length) return false;
  const byName = new Map();
  for (const item of recorded) {
    if (
      !isObject(item) ||
      typeof item.name !== "string" ||
      !Number.isInteger(item.size) ||
      typeof item.sha256 !== "string" ||
      byName.has(item.name)
    ) {
      return false;
    }
    byName.set(item.name, item);
  }
  return current.every((item) => {
    const expected = byName.get(item.name);
    return expected?.size === item.size && expected.sha256 === item.sha256;
  });
};

const validateWorldItem = (record, label) => {
  if (!isObject(record)) throw new Error(`${label}必须是对象`);
  const allowedFields = ["item", "content"];
  for (const field of allowedFields) {
    if (!isNonEmptyText(record[field])) throw new Error(`${label}.${field}必须是非空字符串`);
  }
  const extraFields = Object.keys(record).filter((field) => !allowedFields.includes(field));
  if (extraFields.length) {
    throw new Error(`${label}只能包含 item、content，发现多余字段：${extraFields.join("、")}`);
  }
};

const validateAsset = (record, label, needsFaction) => {
  if (!isObject(record)) throw new Error(`${label}必须是完整记录对象`);
  for (const field of ["assetId", "assetName", "scriptSetting"]) {
    if (!isNonEmptyText(record[field])) throw new Error(`${label}.${field}必须是非空字符串`);
  }
  for (const field of ["productionNotes", "inferenceBasis"]) {
    if (record[field] !== null && !isNonEmptyText(record[field])) {
      throw new Error(`${label}.${field}必须是非空字符串或 null`);
    }
  }
  if (needsFaction && !isNonEmptyText(record.faction)) {
    throw new Error(`${label}.faction必须是非空字符串`);
  }
  if (!Array.isArray(record.aliases) || record.aliases.some((alias) => !isNonEmptyText(alias))) {
    throw new Error(`${label}.aliases必须是字符串数组`);
  }
  for (const field of ["firstRequiredEpisode", "firstRequiredOrder"]) {
    if (!Number.isInteger(record[field]) || record[field] < 1) {
      throw new Error(`${label}.${field}必须是正整数`);
    }
  }
};

const verifyEpisodeWasSynced = async () => {
  const [analysis, original, world, characters, creatures, extras, scenes, props] = await Promise.all([
    readJson(analysisPath, "单集分析"),
    readJson(originalPath, "单集原文"),
    readJson(path.join(registryDir, "世界观记录.json"), "世界观累计记录"),
    readJson(path.join(registryDir, "角色记录.json"), "角色累计记录"),
    readJson(path.join(registryDir, "生物记录.json"), "生物累计记录"),
    readJson(path.join(registryDir, "群演记录.json"), "群演累计记录"),
    readJson(path.join(registryDir, "场景记录.json"), "场景累计记录"),
    readJson(path.join(registryDir, "道具记录.json"), "道具累计记录"),
  ]);

  if (!isObject(analysis)) throw new Error("单集分析顶层必须是对象");
  if (analysis.episode !== episode) throw new Error(`单集分析 episode 必须为 ${episode}`);
  if (!isNonEmptyText(analysis.source) || analysis.source !== original?.source) {
    throw new Error("单集分析 source 必须与单集原文完全一致");
  }
  if (original?.episode !== episode) throw new Error(`单集原文 episode 必须为 ${episode}`);
  if (!Array.isArray(analysis.scriptAnalysis)) throw new Error("scriptAnalysis 必须是数组");
  if (!isObject(analysis.assets)) throw new Error("assets 必须是对象");
  if (!Array.isArray(analysis.exclusions)) throw new Error("exclusions 必须是数组");
  if (!Array.isArray(world?.records)) throw new Error("世界观累计记录 records 必须是数组");

  const assetSpecs = [
    ["characters", "角色", characters, true],
    ["creatures", "生物", creatures, true],
    ["extras", "群演", extras, true],
    ["scenes", "场景", scenes, false],
    ["props", "道具", props, false],
  ];
  for (const [field, label, registry, needsFaction] of assetSpecs) {
    const records = analysis.assets[field];
    if (!Array.isArray(records)) throw new Error(`assets.${field} 必须是数组`);
    if (!Array.isArray(registry)) throw new Error(`${label}累计记录顶层必须是数组`);
    const names = new Set();
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const recordLabel = `assets.${field}[${index}]`;
      validateAsset(record, recordLabel, needsFaction);
      const assetName = record.assetName.trim();
      if (names.has(assetName)) throw new Error(`${recordLabel}与本集同类资产名称重复：${assetName}`);
      names.add(assetName);
      const synced = registry.find(
        (candidate) => isObject(candidate) && candidate.assetId === record.assetId,
      );
      if (!synced) throw new Error(`${label}资产尚未同步到累计记录：${record.assetName}`);
      if (!sameRecord(record, synced)) {
        throw new Error(`${label}资产累计记录与本集分析不一致：${record.assetName}`);
      }
    }
  }

  const worldItems = new Set();
  for (let index = 0; index < analysis.scriptAnalysis.length; index += 1) {
    const record = analysis.scriptAnalysis[index];
    const recordLabel = `scriptAnalysis[${index}]`;
    validateWorldItem(record, recordLabel);
    const item = record.item.trim();
    if (worldItems.has(item)) throw new Error(`${recordLabel}与本集解析项重复：${item}`);
    worldItems.add(item);
    const synced = world.records.find(
      (candidate) => isObject(candidate) && candidate.item === record.item,
    );
    if (!synced) throw new Error(`世界观解析项尚未同步：${record.item}`);
    if (!sameRecord(record, synced)) throw new Error(`世界观解析项累计内容不一致：${record.item}`);
  }

  for (let index = 0; index < analysis.exclusions.length; index += 1) {
    const record = analysis.exclusions[index];
    if (!isObject(record)) throw new Error(`exclusions[${index}]必须是对象`);
    for (const field of ["item", "reason"]) {
      if (!isNonEmptyText(record[field])) {
        throw new Error(`exclusions[${index}].${field}必须是非空字符串`);
      }
    }
  }

  const assetCount = assetSpecs.reduce(
    (total, [field]) => total + analysis.assets[field].length,
    0,
  );
  if (!analysis.scriptAnalysis.length && !assetCount && !analysis.exclusions.length) {
    throw new Error("单集分析为空；至少记录一项解析、资产或排除判断后才能完成");
  }
};

const lockKey = `episode:${episode}`;
const lockPath = path.join(cacheDir, ".pipeline.lock");
const operationLockPath = path.join(cacheDir, ".pipeline.operation.lock");
const transactionPath = path.join(cacheDir, ".pipeline.transaction.json");
const operationLock = await acquirePipelineLock(operationLockPath, {
  kind: `analysis_${action}`,
  key: lockKey,
  leaseMode: "transient",
});
let analysisLock = null;
let createdLock = false;

try {
  if (await fs.stat(transactionPath).then((stat) => stat.isFile()).catch(() => false)) {
    const pendingTransaction = await readJsonFile(transactionPath, { label: "Cache 事务日志" });
    const recoveryStep =
      pendingTransaction?.kind === "screenplay_extract"
        ? "重新运行 extract_screenplay.py"
        : "重新运行本集 sync_episode_analysis.py";
    throw new Error(
      `检测到未完成的 Cache 写入事务；请先${recoveryStep}完成自动恢复，再继续更新进度`,
    );
  }
  const progress = await readJson(progressPath, "阅读进度");
  if (!isObject(progress)) throw new Error("阅读进度顶层必须是对象");
  if (!sourceManifestMatches(progress.sourceManifest, await currentSourceManifest())) {
    throw new Error("当前剧本与阅读进度来源指纹不一致，请重新切分或清空 Cache");
  }
  const discovered = [...new Set((progress.discoveredEpisodes ?? []).map(Number))]
    .filter(Number.isInteger)
    .sort((a, b) => a - b);
  if (!discovered.includes(episode)) throw new Error(`第${episode}集不在已切分集数中`);
  const episodeManifest = Array.isArray(progress.episodeManifest) ? progress.episodeManifest : [];
  const expectedRaw = episodeManifest.find((item) => item?.episode === episode);
  const currentRaw = await readJson(originalPath, "单集原文");
  if (
    !expectedRaw ||
    typeof expectedRaw.sha256 !== "string" ||
    canonicalSha256(currentRaw) !== expectedRaw.sha256
  ) {
    throw new Error("单集原文与切分指纹不一致；旧 Cache 请重新运行 extract_screenplay.py");
  }

  const completed = new Set(
    (Array.isArray(progress.completedEpisodes) ? progress.completedEpisodes : [])
      .map(Number)
      .filter((value) => Number.isInteger(value) && discovered.includes(value)),
  );
  const existingLock = await readPipelineLock(lockPath);
  const existingLockEpisodeMatch = /^episode:(\d+)$/.exec(String(existingLock?.key ?? ""));
  const existingLockEpisode = existingLockEpisodeMatch
    ? Number(existingLockEpisodeMatch[1])
    : null;
  const recoveredTerminalCompletion =
    action === "complete" &&
    completed.has(episode) &&
    (progress.currentEpisode === null || progress.currentEpisode === undefined) &&
    existingLock?.kind === "analysis_episode" &&
    existingLockEpisode === episode &&
    typeof existingLock.token === "string" &&
    existingLock.token.length > 0;
  const expectedEpisode = discovered.find((value) => !completed.has(value));
  const statusAfterCompletion = () =>
    discovered.every((value) => completed.has(value)) ? "complete" : "ready";
  if (expectedEpisode === undefined && !recoveredTerminalCompletion) {
    throw new Error("所有已切分剧集均已完成分析");
  }
  if (!recoveredTerminalCompletion && episode !== expectedEpisode) {
    throw new Error(`必须按顺序处理；当前应处理第${expectedEpisode}集，不能处理第${episode}集`);
  }

  const now = new Date().toISOString();
  let alreadyStarted = false;
  let resumed = false;
  let recoveredInterruptedResume = false;
  if (action === "start") {
    if (progress.currentEpisode !== null && progress.currentEpisode !== undefined) {
      if (Number(progress.currentEpisode) !== episode) {
        throw new Error(`第${progress.currentEpisode}集仍处于处理中，不能开始第${episode}集`);
      }
      if (!resumeRequested) {
        throw new Error(
          `第${episode}集已有分析会话；禁止静默接管。确认旧任务已停止后，请显式追加 --resume`,
        );
      }
      const existing = await requirePipelineLock(lockPath, {
        kind: "analysis_episode",
        key: lockKey,
      });
      const recordedToken = String(progress.currentSessionToken ?? "").trim();
      if (!recordedToken) {
        throw new Error("阅读进度缺少 currentSessionToken，无法安全恢复；请先重置当前项目 Cache");
      }
      if (existing.token === recordedToken) {
        analysisLock = await rotatePipelineLock(
          lockPath,
          { kind: "analysis_episode", key: lockKey, token: recordedToken },
          { resumedAt: now },
        );
        resumed = true;
      } else if (existing.resumedFromTokenHash === sha256(recordedToken)) {
        // 上次 --resume 可能在轮换锁后、写入进度前崩溃；锁中的单向凭证允许完成该事务。
        analysisLock = existing;
        recoveredInterruptedResume = true;
        resumed = true;
      } else {
        throw new Error("分析会话锁令牌与阅读进度不一致，禁止接管；请检查 Cache 完整性");
      }
      progress.currentSessionToken = analysisLock.token;
      progress.currentResumedAt = now;
      alreadyStarted = true;
    } else {
      if (resumeRequested) {
        throw new Error(`第${episode}集当前没有可恢复的分析会话，请直接执行 start`);
      }
      const orphan = await readPipelineLock(lockPath);
      if (
        orphan?.kind === "analysis_episode" &&
        Number(String(orphan.key ?? "").replace("episode:", "")) < episode &&
        completed.has(Number(String(orphan.key ?? "").replace("episode:", "")))
      ) {
        await releasePipelineLock(lockPath, {
          kind: orphan.kind,
          key: orphan.key,
          token: orphan.token,
        });
      }
      analysisLock = await acquirePipelineLock(lockPath, {
        kind: "analysis_episode",
        key: lockKey,
        leaseMode: "durable",
      });
      createdLock = true;
      progress.currentEpisode = episode;
      progress.currentStartedAt = now;
      progress.currentSessionToken = analysisLock.token;
      progress.currentResumedAt = null;
    }
    progress.status = "in_progress";
  } else {
    if (recoveredTerminalCompletion) {
      analysisLock = await requirePipelineLock(lockPath, {
        kind: "analysis_episode",
        key: lockKey,
        token: existingLock.token,
      });
      await verifyEpisodeWasSynced();
      progress.currentEpisode = null;
      progress.currentStartedAt = null;
      progress.currentSessionToken = null;
      progress.currentResumedAt = null;
      progress.status = statusAfterCompletion();
    } else if (
      Number(progress.currentEpisode) !== episode ||
      !Number.isFinite(Date.parse(progress.currentStartedAt))
    ) {
      throw new Error(`第${episode}集尚未执行 start，不能标记完成`);
    } else {
      const recordedToken = String(progress.currentSessionToken ?? "").trim();
      if (!recordedToken) {
        throw new Error("阅读进度缺少 currentSessionToken，禁止完成当前分析会话");
      }
      analysisLock = await requirePipelineLock(lockPath, {
        kind: "analysis_episode",
        key: lockKey,
        token: recordedToken,
      });
      await verifyEpisodeWasSynced();
      completed.add(episode);
      progress.completedEpisodes = [...completed].sort((a, b) => a - b);
      progress.lastCompletedEpisode = episode;
      progress.currentEpisode = null;
      progress.currentStartedAt = null;
      progress.currentSessionToken = null;
      progress.currentResumedAt = null;
      progress.status = statusAfterCompletion();
    }
  }
  progress.updatedAt = now;
  if (!sourceManifestMatches(progress.sourceManifest, await currentSourceManifest())) {
    throw new Error("剧本文件在进度更新期间发生变化，已停止写入");
  }
  await writeJsonAtomic(progressPath, progress);

  if (action === "complete") {
    await releasePipelineLock(lockPath, {
      kind: "analysis_episode",
      key: lockKey,
      token: analysisLock.token,
    });
  }

  console.log(
    JSON.stringify(
      {
        action,
        episode,
        alreadyStarted,
        resumed,
        recoveredInterruptedResume,
        recoveredTerminalCompletion,
        sessionToken: action === "start" ? analysisLock.token : null,
        status: progress.status,
        completed: progress.completedEpisodes?.length ?? 0,
        total: discovered.length,
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (createdLock) {
    await releasePipelineLock(lockPath, {
      kind: "analysis_episode",
      key: lockKey,
      token: analysisLock.token,
    }).catch(() => {});
  }
  throw error;
} finally {
  await releasePipelineLock(operationLockPath, {
    kind: operationLock.kind,
    key: operationLock.key,
    token: operationLock.token,
  });
}
