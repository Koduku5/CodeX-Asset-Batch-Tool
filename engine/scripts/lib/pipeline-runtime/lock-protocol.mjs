import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  cleanText,
  isObject,
  readJsonFile,
  sha256,
  writeJsonAtomic,
} from "./runtime-core.mjs";

export const PIPELINE_LOCK_PROTOCOL_VERSION = 2;

const execFileAsync = promisify(execFile);
const currentProcessStartTime = new Date(Date.now() - process.uptime() * 1000).toISOString();
const currentHost = os.hostname();

const makeLockError = (lock) => {
  const error = new Error(
    `已有流水线任务占用：${lock?.kind ?? "unknown"}:${lock?.key ?? "unknown"}`,
  );
  error.code = "PIPELINE_LOCKED";
  error.lock = lock;
  return error;
};

const processExists = (processId) => {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return null;
  }
};

const windowsProcessStartTime = async (processId) => {
  const command = [
    "$ErrorActionPreference='Stop'",
    `$p=[System.Diagnostics.Process]::GetProcessById(${processId})`,
    "$p.StartTime.ToUniversalTime().ToString('o')",
  ].join("; ");
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      { encoding: "utf8", timeout: 5000, windowsHide: true },
    );
    const value = cleanText(stdout);
    return Number.isFinite(Date.parse(value)) ? value : null;
  } catch {
    return null;
  }
};

const classifyTransientLockOwner = async (lock) => {
  if (
    lock?.protocolVersion !== PIPELINE_LOCK_PROTOCOL_VERSION ||
    lock?.leaseMode !== "transient" ||
    cleanText(lock?.host).toLocaleLowerCase() !== currentHost.toLocaleLowerCase() ||
    !Number.isInteger(lock?.processId) ||
    lock.processId < 1 ||
    !Number.isFinite(Date.parse(lock?.processStartTime))
  ) {
    return "unknown";
  }
  const exists = processExists(lock.processId);
  if (exists === false) return "dead";
  if (exists !== true) return "unknown";

  if (lock.processId === process.pid) {
    return Math.abs(Date.parse(lock.processStartTime) - Date.parse(currentProcessStartTime)) <= 5000
      ? "alive"
      : "identity_mismatch";
  }
  if (process.platform !== "win32") return "unknown";
  const actualStartTime = await windowsProcessStartTime(lock.processId);
  if (!actualStartTime) return "unknown";
  return Math.abs(Date.parse(lock.processStartTime) - Date.parse(actualStartTime)) <= 5000
    ? "alive"
    : "identity_mismatch";
};

export const readPipelineLock = async (lockPath) => {
  const lock = await readJsonFile(lockPath, {
    fallback: null,
    label: "流水线锁",
    retries: 2,
  });
  if (lock === null) return null;
  if (!isObject(lock) || !cleanText(lock.kind) || !cleanText(lock.key)) {
    throw new Error("流水线锁结构无效，禁止继续");
  }
  return lock;
};

const quarantineStaleLock = async (lockPath, expected) => {
  const current = await readPipelineLock(lockPath);
  if (!current || !cleanText(expected?.token) || current.token !== expected.token) {
    throw makeLockError(current);
  }
  const quarantinePath = `${lockPath}.stale.${expected.token}.${crypto.randomUUID()}`;
  try {
    await fs.rename(lockPath, quarantinePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw makeLockError(await readPipelineLock(lockPath));
  }
  await fs.rm(quarantinePath, { force: true }).catch(() => {});
};

export const acquirePipelineLock = async (lockPath, payload) => {
  const transactionPath = path.join(path.dirname(lockPath), ".pipeline.transaction.json");
  if (await fs.stat(transactionPath).then((stat) => stat.isFile()).catch(() => false)) {
    const error = new Error(
      "检测到未恢复的 Cache 写入事务；禁止接管或启动其他流水线任务，请先重跑切分/同步脚本完成恢复",
    );
    error.code = "PIPELINE_TRANSACTION_PENDING";
    throw error;
  }
  const now = new Date().toISOString();
  const lock = {
    ...payload,
    protocolVersion: PIPELINE_LOCK_PROTOCOL_VERSION,
    leaseMode: payload?.leaseMode === "transient" ? "transient" : "durable",
    processId: process.pid,
    processStartTime: currentProcessStartTime,
    host: currentHost,
    token: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  };
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    let created = false;
    try {
      handle = await fs.open(lockPath, "wx");
      created = true;
      await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      return lock;
    } catch (error) {
      await handle?.close().catch(() => {});
      if (created) await fs.rm(lockPath, { force: true }).catch(() => {});
      if (error?.code !== "EEXIST") throw error;
      const existing = await readPipelineLock(lockPath);
      if (attempt === 0) {
        const state = await classifyTransientLockOwner(existing);
        if (state === "dead" || state === "identity_mismatch") {
          await quarantineStaleLock(lockPath, existing);
          continue;
        }
      }
      throw makeLockError(existing);
    }
  }
  throw makeLockError(await readPipelineLock(lockPath));
};

export const rotatePipelineLock = async (lockPath, expected, payload = {}) => {
  const current = await requirePipelineLock(lockPath, expected);
  if (current.leaseMode !== "durable") {
    throw new Error("只有 durable 流水线锁允许轮换会话令牌");
  }
  const now = new Date().toISOString();
  const rotated = {
    ...current,
    ...payload,
    protocolVersion: PIPELINE_LOCK_PROTOCOL_VERSION,
    leaseMode: "durable",
    processId: process.pid,
    processStartTime: currentProcessStartTime,
    host: currentHost,
    token: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    resumedFromTokenHash: sha256(current.token),
  };
  await writeJsonAtomic(lockPath, rotated);
  return rotated;
};

export const requirePipelineLock = async (lockPath, expected) => {
  const lock = await readPipelineLock(lockPath);
  if (!lock) throw new Error("当前任务未持有流水线锁");
  for (const [field, value] of Object.entries(expected)) {
    if (value !== undefined && lock[field] !== value) {
      throw new Error(`流水线锁不属于当前任务：${lock.kind}:${lock.key}`);
    }
  }
  return lock;
};

export const releasePipelineLock = async (lockPath, expected) => {
  const lock = await requirePipelineLock(lockPath, expected);
  if (!cleanText(lock.token)) throw new Error("流水线锁缺少释放令牌，禁止自动删除");
  await fs.unlink(lockPath);
};
