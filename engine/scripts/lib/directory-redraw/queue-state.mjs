import fs from 'node:fs/promises';
import path from 'node:path';

import { cleanText, isObject } from '../pipeline_runtime.mjs';
import {
  comparisonPathKey,
  isWithinOrSame,
  normalizeCase,
  resolveInside
} from './contracts.mjs';

export const validateItemUniqueness = (items) => {
  const keys = new Map();
  const outputs = new Map();
  const collisions = [];
  for (const item of items) {
    const oldKey = keys.get(item.key);
    if (oldKey) {
      collisions.push(`任务键冲突：${oldKey} / ${item.sourceRelativePath}`);
    } else {
      keys.set(item.key, item.sourceRelativePath);
    }
    const outputKey = comparisonPathKey(item.outputRelativePath);
    const previousSource = outputs.get(outputKey);
    if (previousSource) {
      collisions.push(
        `输出同名冲突：${previousSource} / ${item.sourceRelativePath} -> ${item.outputRelativePath}`,
      );
    } else {
      outputs.set(outputKey, item.sourceRelativePath);
    }
  }
  if (collisions.length) {
    throw new Error(`原图转换为 PNG 后发生同名冲突：${collisions.slice(0, 8).join("；")}`);
  }
};

const terminalState = (state) => {
  if (!isObject(state)) return false;
  if (state.status === "completed") return true;
  return (
    state.status === "failed" &&
    (state.terminal === true || (Number.isInteger(state.attempts) && state.attempts >= 2))
  );
};

export const queueHasIncompleteItems = (queue, progress) => {
  if (!Array.isArray(queue?.items) || !queue.items.length) return false;
  return queue.items.some((item) => !terminalState(progress?.items?.[item?.key]));
};

export const validatePreviousState = (queue, progress) => {
  if (!isObject(queue) || queue.version !== 1 || queue.operation !== "directory_redraw") {
    throw new Error("现有批量重绘队列结构无效，禁止覆盖可能可恢复的任务");
  }
  if (
    !Array.isArray(queue.items) ||
    !cleanText(queue.batchId) ||
    !cleanText(queue.builtAt) ||
    !cleanText(queue.queueFingerprint)
  ) {
    throw new Error("现有批量重绘队列缺少批次、任务或指纹，禁止覆盖");
  }
  if (!isObject(progress) || !isObject(progress.items)) {
    throw new Error("现有批量重绘进度结构无效，禁止覆盖可能可恢复的任务");
  }
  if (
    progress.operation !== "directory_redraw" ||
    cleanText(progress.batchId) !== cleanText(queue.batchId) ||
    cleanText(progress.queueFingerprint) !== cleanText(queue.queueFingerprint)
  ) {
    throw new Error("现有批量重绘队列与进度指纹不一致，禁止猜测恢复");
  }
};

export const isBlankInitializedQueue = (value) =>
  isObject(value) &&
  value.operation === "directory_redraw" &&
  Array.isArray(value.items) &&
  value.items.length === 0 &&
  Object.keys(value).every((key) => ["version", "operation", "items"].includes(key));

export const isBlankInitializedProgress = (value) =>
  isObject(value) &&
  value.operation === "directory_redraw" &&
  isObject(value.items) &&
  Object.keys(value.items).length === 0 &&
  Object.keys(value).every((key) => ["version", "operation", "items"].includes(key));

const expectedResumeOutput = (state, inputFingerprint) => {
  if (!isObject(state) || state.inputFingerprint !== inputFingerprint) return false;
  if (state.status === "completed") return true;
  const remoteStatus = cleanText(state.remoteStatus);
  return (
    state.backend === "api" &&
    ["completed", "download_installing", "download_interrupted", "download_retry"].includes(
      remoteStatus,
    )
  );
};

export const assertOutputTargetsAvailable = async (
  outputRoot,
  items,
  { resume = false, progressItems = {} } = {},
) => {
  const checkedDirectories = new Set([normalizeCase(outputRoot)]);
  const conflicts = [];
  for (const item of items) {
    const target = resolveInside(outputRoot, item.outputRelativePath, "重绘输出路径");
    const parentRelative = path.posix.dirname(item.outputRelativePath);
    const parentSegments = parentRelative === "." ? [] : parentRelative.split("/");
    let current = outputRoot;
    for (const segment of parentSegments) {
      current = path.join(current, segment);
      const cacheKey = normalizeCase(current);
      if (checkedDirectories.has(cacheKey)) continue;
      try {
        const currentStat = await fs.lstat(current);
        if (currentStat.isSymbolicLink()) {
          throw new Error(`输出子目录不能是符号链接或目录联接：${current}`);
        }
        if (!currentStat.isDirectory()) {
          throw new Error(`输出路径的父级不是文件夹：${current}`);
        }
        const realCurrent = await fs.realpath(current);
        if (!isWithinOrSame(realCurrent, outputRoot)) {
          throw new Error(`输出子目录解析后越出结果目录：${current}`);
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      checkedDirectories.add(cacheKey);
    }

    try {
      const targetStat = await fs.lstat(target);
      const expected =
        resume &&
        targetStat.isFile() &&
        !targetStat.isSymbolicLink() &&
        expectedResumeOutput(progressItems[item.key], item.inputFingerprint);
      if (!expected) conflicts.push(item.outputRelativePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (conflicts.length) {
    throw new Error(
      `结果目录已存在本批次目标文件，禁止覆盖：${conflicts.slice(0, 8).join("、")}${
        conflicts.length > 8 ? "…" : ""
      }`,
    );
  }
};

