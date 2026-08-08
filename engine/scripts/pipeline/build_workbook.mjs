import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { loadArtifactTool } from "../lib/load_artifact_tool.mjs";
import {
  WORKBOOK_ASSET_TYPES,
  createWorkbookValidation,
  parseWorkbookScope,
} from "../lib/workbook/validation.mjs";
import {
  acquirePipelineLock,
  assertSafeOutputPath,
  assertExcelCellValue,
  hasExactKeys,
  readJsonFile,
  readStableFileSnapshot,
  releasePipelineLock,
  sha256,
  writeJsonAtomic,
} from "../lib/pipeline_runtime.mjs";

const args = process.argv.slice(2);
if (!args.length) {
  throw new Error("用法：node build_workbook.mjs <skill-root> [--episode-start=N --episode-end=N --asset-types=types]");
}
const workbookScope = parseWorkbookScope(args);

const skillRoot = path.resolve(args[0]);
const templatePath = path.join(skillRoot, "assets", "Excel模板", "剧本资产制表模板.xlsx");
const overviewPath = path.join(skillRoot, "cache", "世界观总览.json");
const readingProgressPath = path.join(skillRoot, "cache", "阅读进度.json");
const registryDir = path.join(skillRoot, "cache", "累计记录");
const screenplayDir = path.join(skillRoot, "剧本");
const outputPath = path.join(skillRoot, "输出", "剧本资产制表.xlsx");
const lockPath = path.join(skillRoot, "cache", ".pipeline.lock");
const transactionPath = path.join(skillRoot, "cache", ".pipeline.transaction.json");
const validationReceiptPath = path.join(skillRoot, "cache", ".validation_receipt.json");
const pendingPath = path.join(skillRoot, "cache", "待确认记录.json");
const workbookScopeReceiptPath = path.join(skillRoot, "cache", "资产表范围.json");

const {
  readWorkbookScopeReceipt,
  assertValidationReceipt,
  assertNoPendingConfirmations,
  assertCurrentSources,
  sortAssets,
  columnName,
  snapshotsMatch,
} = createWorkbookValidation({
  skillRoot,
  workbookScopeReceiptPath,
  readingProgressPath,
  registryDir,
  screenplayDir,
  overviewPath,
  validationReceiptPath,
  pendingPath,
});


const workbookLock = await acquirePipelineLock(lockPath, {
  kind: "workbook_build",
  key: "workbook",
  leaseMode: "transient",
});

try {
  if (await fs.stat(transactionPath).then((stat) => stat.isFile()).catch(() => false)) {
    throw new Error("检测到未恢复的 Cache 写入事务，禁止生成 Excel；请先重跑上一步写入脚本");
  }
  if (workbookScope) {
    const [existingWorkbook, scopeReceipt] = await Promise.all([
      fs.stat(outputPath).then((stat) => stat.isFile()).catch((error) => {
        if (error?.code === "ENOENT") return false;
        throw error;
      }),
      readWorkbookScopeReceipt(),
    ]);
    if (existingWorkbook || scopeReceipt) {
      if (!existingWorkbook || !scopeReceipt) {
        throw new Error("现有资产表状态不完整，禁止生成局部表；只允许继续生成全剧表");
      }
      if (scopeReceipt.mode === "full") {
        throw new Error("全剧资产表已经形成，不允许缩回局部表");
      }
      throw new Error("局部资产表已经形成，不支持再次改写局部范围；只允许继续补充为全剧表");
    }
  }
  await assertNoPendingConfirmations();
  const validationFingerprint = await assertValidationReceipt();
  const { FileBlob, SpreadsheetFile } = await loadArtifactTool();
  const sourceFingerprint = await assertCurrentSources();
  const [world, overview, characters, creatures, extras, scenes, props] = await Promise.all([
    readJsonFile(path.join(registryDir, "世界观记录.json")),
    readJsonFile(overviewPath),
    readJsonFile(path.join(registryDir, "角色记录.json")),
    readJsonFile(path.join(registryDir, "生物记录.json")),
    readJsonFile(path.join(registryDir, "群演记录.json")),
    readJsonFile(path.join(registryDir, "场景记录.json")),
    readJsonFile(path.join(registryDir, "道具记录.json")),
  ]);

  if (
    !Array.isArray(world?.records) ||
    ![characters, creatures, extras, scenes, props].every(Array.isArray)
  ) {
    throw new Error("累计记录结构无效，请先运行 validate_asset_records.py");
  }
  if (
    !hasExactKeys(overview, [
      "version",
      "content",
      "factsFingerprint",
      "coverageFingerprint",
      "finalizedAt",
    ]) ||
    overview.version !== 2 ||
    typeof overview.content !== "string" ||
    !overview.content.trim() ||
    !/^[a-f0-9]{64}$/i.test(overview.factsFingerprint ?? "") ||
    !/^[a-f0-9]{64}$/i.test(overview.coverageFingerprint ?? "") ||
    typeof overview.finalizedAt !== "string" ||
    !/(?:Z|[+-]\d{2}:\d{2})$/i.test(overview.finalizedAt) ||
    !Number.isFinite(Date.parse(overview.finalizedAt))
  ) {
    throw new Error("世界观总览无效或尚未完成，请先运行 finalize_world_overview.py");
  }

  const workbookItems = (assetType, items) => sortAssets(
    workbookScope && workbookScope.assetTypes.includes(assetType)
      ? items.filter((item) => Number.isInteger(item?.firstRequiredEpisode)
        && item.firstRequiredEpisode >= workbookScope.episodeStart
        && item.firstRequiredEpisode <= workbookScope.episodeEnd)
      : workbookScope
        ? []
        : items,
  );

  const specs = [
    {
      sheetName: "剧本解析",
      tableName: "ScriptAnalysis",
      headers: ["解析项", "内容"],
      workflowHeaders: [],
      columnWidths: [22, 90],
      items: [{ item: "世界观总览", content: overview.content.trim() }],
      toRow: (item) => [item.item, item.content],
    },
    {
      sheetName: "角色",
      tableName: "CharacterAssets",
      headers: ["资产ID", "资产名称", "制作说明", "阵营", "剧本设定", "推演依据"],
      workflowHeaders: ["自动化", "负责人", "精修", "状态", "最终确认", "返修意见"],
      columnWidths: [16, 24, 48, 22, 42, 42, 14, 16, 12, 12, 16, 36],
      items: workbookItems("characters", characters),
      toRow: (item) => [
        item.assetId,
        item.assetName,
        item.productionNotes,
        item.faction ?? "",
        item.scriptSetting,
        item.inferenceBasis,
      ],
    },
    {
      sheetName: "生物",
      tableName: "CreatureAssets",
      headers: ["资产ID", "资产名称", "制作说明", "阵营", "剧本设定", "推演依据"],
      workflowHeaders: ["自动化", "负责人", "精修", "状态", "最终确认", "返修意见"],
      columnWidths: [16, 24, 48, 22, 42, 42, 14, 16, 12, 12, 16, 36],
      items: workbookItems("creatures", creatures),
      toRow: (item) => [
        item.assetId,
        item.assetName,
        item.productionNotes,
        item.faction ?? "",
        item.scriptSetting,
        item.inferenceBasis,
      ],
    },
    {
      sheetName: "群演",
      tableName: "ExtraAssets",
      headers: ["资产ID", "资产名称", "制作说明", "阵营", "剧本设定", "推演依据"],
      workflowHeaders: ["自动化", "负责人", "精修", "审核", "返修建议"],
      columnWidths: [16, 24, 48, 22, 42, 42, 14, 16, 12, 12, 36],
      items: workbookItems("extras", extras),
      toRow: (item) => [
        item.assetId,
        item.assetName,
        item.productionNotes,
        item.faction ?? "",
        item.scriptSetting,
        item.inferenceBasis,
      ],
    },
    {
      sheetName: "场景",
      tableName: "SceneAssets",
      headers: ["资产ID", "资产名称", "制作说明", "剧本设定", "推演依据"],
      workflowHeaders: ["自动化", "负责人", "精修", "审核", "最终确认", "返修建议"],
      columnWidths: [16, 24, 48, 42, 42, 14, 16, 12, 12, 16, 36],
      items: workbookItems("scenes", scenes),
      toRow: (item) => [
        item.assetId,
        item.assetName,
        item.productionNotes,
        item.scriptSetting,
        item.inferenceBasis,
      ],
    },
    {
      sheetName: "道具",
      tableName: "PropAssets",
      headers: ["资产ID", "资产名称", "制作说明", "剧本设定", "推演依据"],
      workflowHeaders: ["自动化", "负责人", "精修", "状态", "最终确认", "返修建议"],
      columnWidths: [16, 24, 48, 42, 42, 14, 16, 12, 12, 16, 36],
      items: workbookItems("props", props),
      toRow: (item) => [
        item.assetId,
        item.assetName,
        item.productionNotes,
        item.scriptSetting,
        item.inferenceBasis,
      ],
    },
  ];

  await assertSafeOutputPath(skillRoot, outputPath);
  const existingOutputSnapshot = await readStableFileSnapshot(outputPath);
  const preservedWorkflowBySheet = new Map();
  if (existingOutputSnapshot.exists) {
    const existingWorkbook = await SpreadsheetFile.importXlsx(await FileBlob.load(outputPath));
    const existingSheetNames = existingWorkbook.worksheets.items.map((sheet) => sheet.name);
    const expectedSheetNames = specs.map((spec) => spec.sheetName);
    if (JSON.stringify(existingSheetNames) !== JSON.stringify(expectedSheetNames)) {
      throw new Error(
        `现有交付工作簿 Sheet 结构异常，已停止覆盖以保护人工数据：应依次为 ${expectedSheetNames.join("、")}`,
      );
    }
    for (const spec of specs) {
      if (!spec.workflowHeaders.length) continue;
      const outputHeaders = [...spec.headers, ...spec.workflowHeaders];
      const rows = existingWorkbook.worksheets.getItem(spec.sheetName).getUsedRange(true)?.values ?? [];
      const existingHeaders = (rows[0] ?? []).slice(0, outputHeaders.length).map((value) =>
        String(value ?? "").trim(),
      );
      if (JSON.stringify(existingHeaders) !== JSON.stringify(outputHeaders)) {
        throw new Error(
          `现有交付工作簿 Sheet ${spec.sheetName} 表头异常，已停止覆盖以保护人工数据`,
        );
      }
      const hasExtraUserColumns = rows.some((row) =>
        (row ?? []).slice(outputHeaders.length).some(
          (value) => value !== null && value !== undefined && String(value).trim() !== "",
        ),
      );
      if (hasExtraUserColumns) {
        throw new Error(
          `现有交付工作簿 Sheet ${spec.sheetName} 含固定表头之外的人工列，已停止覆盖；请先从旧表迁移或备份这些列`,
        );
      }
      const byAssetId = new Map();
      for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex] ?? [];
        const assetId = String(row[0] ?? "").trim();
        const workflowValues = Array.from(
          { length: spec.workflowHeaders.length },
          (_, workflowIndex) => row[spec.headers.length + workflowIndex] ?? null,
        );
        const hasAnyValue = row.some(
          (value) => value !== null && value !== undefined && String(value).trim() !== "",
        );
        if (!hasAnyValue) continue;
        if (!assetId) {
          throw new Error(
            `现有交付工作簿 ${spec.sheetName}!A${rowIndex + 1} 缺少资产ID，已停止覆盖以保护人工数据`,
          );
        }
        if (byAssetId.has(assetId)) {
          throw new Error(`现有交付工作簿 Sheet ${spec.sheetName} 存在重复资产ID：${assetId}`);
        }
        byAssetId.set(
          assetId,
          workflowValues.map((value, workflowIndex) =>
            assertExcelCellValue(
              value,
              `${spec.sheetName}!${columnName(spec.headers.length + workflowIndex)}${rowIndex + 1}`,
            ),
          ),
        );
      }
      preservedWorkflowBySheet.set(spec.sheetName, byAssetId);
    }
    const snapshotAfterImport = await readStableFileSnapshot(outputPath);
    if (!snapshotsMatch(existingOutputSnapshot, snapshotAfterImport)) {
      throw new Error("现有交付工作簿在读取期间发生变化，已停止覆盖");
    }
  }

  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(templatePath));
  const actualSheetNames = workbook.worksheets.items.map((sheet) => sheet.name);
  const expectedSheetNames = specs.map((spec) => spec.sheetName);
  if (JSON.stringify(actualSheetNames) !== JSON.stringify(expectedSheetNames)) {
    throw new Error(`模板 Sheet 必须且只能依次为：${expectedSheetNames.join("、")}`);
  }

  for (const spec of specs) {
    const sheet = workbook.worksheets.getItem(spec.sheetName);
    const outputHeaders = [...spec.headers, ...spec.workflowHeaders];
    const lastColumn = columnName(outputHeaders.length - 1);
    const headerRange = `A1:${lastColumn}1`;
    const templateHeaders = (sheet.getRange(headerRange).values?.[0] ?? []).map((value) =>
      String(value ?? "").trim(),
    );
    if (JSON.stringify(templateHeaders) !== JSON.stringify(outputHeaders)) {
      throw new Error(
        `模板 Sheet ${spec.sheetName} 表头不匹配：应为 ${outputHeaders.join("｜")}`,
      );
    }

    const templateStyle = sheet.tables.items[0]?.style ?? "TableStyleMedium2";
    for (const table of sheet.tables.items) table.delete();
    sheet.getUsedRange()?.clear({ applyTo: "contents" });

    const dataRows = spec.items.map((item, rowIndex) => {
      const assetId = String(item?.assetId ?? "").trim();
      const preservedWorkflow = preservedWorkflowBySheet.get(spec.sheetName)?.get(assetId);
      return [
        ...spec.toRow(item),
        ...(preservedWorkflow ??
          Array.from({ length: spec.workflowHeaders.length }, () => null)),
      ].map((value, columnIndex) =>
        assertExcelCellValue(
          value,
          `${spec.sheetName}!${columnName(columnIndex)}${rowIndex + 2}`,
        ),
      );
    });
    const existingWorkflow = preservedWorkflowBySheet.get(spec.sheetName);
    if (existingWorkflow) {
      const currentAssetIds = new Set(
        spec.items.map((item) => String(item?.assetId ?? "").trim()).filter(Boolean),
      );
      const orphanedAssetIds = [...existingWorkflow.keys()].filter(
        (assetId) => !currentAssetIds.has(assetId),
      );
      if (orphanedAssetIds.length) {
        console.warn(
          `warning ${spec.sheetName} 中 ${orphanedAssetIds.length} 个旧资产已不在正式库；其人工列仅保留在备份：${orphanedAssetIds.slice(0, 12).join("、")}${orphanedAssetIds.length > 12 ? "…" : ""}`,
        );
      }
    }
    const bodyRows = dataRows.length
      ? dataRows
      : [Array.from({ length: outputHeaders.length }, () => null)];
    const lastRow = bodyRows.length + 1;
    sheet.getRange(`A1:${lastColumn}${lastRow}`).values = [outputHeaders, ...bodyRows];
    sheet.freezePanes.freezeRows(1);

    if (dataRows.length) {
      const bodyRange = sheet.getRange(`A2:${lastColumn}${lastRow}`);
      bodyRange.format = {
        font: { name: "Microsoft YaHei", size: 11 },
        horizontalAlignment: "center",
        verticalAlignment: "center",
        wrapText: true,
      };
      if (spec.sheetName === "剧本解析") {
        sheet.getRange("B1:B2").format.columnWidthPx = 900;
        sheet.getRange("B2").format = {
          font: { name: "Microsoft YaHei", size: 11 },
          horizontalAlignment: "left",
          verticalAlignment: "top",
          wrapText: true,
        };
      }
      bodyRange.format.autofitRows();
      if (spec.sheetName === "剧本解析") {
        const overviewText = String(dataRows[0]?.[1] ?? "");
        const estimatedLines = overviewText.split("\n").reduce(
          (total, line) => total + Math.max(1, Math.ceil(line.length / 55)),
          0,
        );
        sheet.getRange("A2:B2").format.rowHeight = Math.min(
          409,
          Math.max(72, estimatedLines * 13 + 12),
        );
      }
    }

    const table = sheet.tables.add(`A1:${lastColumn}${lastRow}`, true, spec.tableName);
    table.style = templateStyle;
    table.showFilterButton = true;

    const fullHeaderRange = sheet.getRange(`A1:${lastColumn}1`);
    fullHeaderRange.format = {
      fill: "#1F4E79",
      font: { name: "Microsoft YaHei", size: 11, bold: true, color: "#FFFFFF" },
      horizontalAlignment: "center",
      verticalAlignment: "center",
      wrapText: false,
      borders: { preset: "all", style: "thin", color: "#4F81BD" },
    };
    fullHeaderRange.format.rowHeight = 30;
    spec.columnWidths.forEach((width, index) => {
      const column = columnName(index);
      sheet.getRange(`${column}1:${column}${lastRow}`).format.columnWidth = width;
    });
    sheet.showGridLines = false;
  }

  const outputRoot = path.dirname(outputPath);
  await assertSafeOutputPath(skillRoot, outputRoot);
  await fs.mkdir(outputRoot, { recursive: true });
  await assertSafeOutputPath(skillRoot, outputRoot, { targetMayBeMissing: false });
  await assertSafeOutputPath(outputRoot, outputPath);
  const output = await SpreadsheetFile.exportXlsx(workbook);
  const tempPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  let tempHandle;
  try {
    await assertSafeOutputPath(outputRoot, tempPath);
    tempHandle = await fs.open(tempPath, "wx", 0o600);
    await tempHandle.writeFile(output.data);
    await tempHandle.sync();
    await tempHandle.close();
    tempHandle = undefined;
    await assertSafeOutputPath(outputRoot, tempPath, { targetMayBeMissing: false });
    if ((await assertCurrentSources()) !== sourceFingerprint) {
      throw new Error("剧本来源在 Excel 生成期间发生变化，已停止交付写入");
    }
    if ((await assertValidationReceipt()) !== validationFingerprint) {
      throw new Error("资产校验快照在 Excel 生成期间发生变化，已停止交付写入");
    }
    if (existingOutputSnapshot.exists) {
      const currentOutputSnapshot = await readStableFileSnapshot(outputPath);
      if (!snapshotsMatch(existingOutputSnapshot, currentOutputSnapshot)) {
        throw new Error("现有交付工作簿在生成期间发生变化，已停止覆盖");
      }
      const backupRoot = path.join(skillRoot, "备份");
      await assertSafeOutputPath(skillRoot, backupRoot);
      await fs.mkdir(backupRoot, { recursive: true });
      await assertSafeOutputPath(skillRoot, backupRoot, { targetMayBeMissing: false });
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = path.join(
        backupRoot,
        `剧本资产制表_${timestamp}_${randomUUID()}.xlsx`,
      );
      await assertSafeOutputPath(backupRoot, backupPath);
      try {
        await fs.copyFile(outputPath, backupPath, fsConstants.COPYFILE_EXCL);
        const [sourceAfterBackup, backupSnapshot] = await Promise.all([
          readStableFileSnapshot(outputPath),
          readStableFileSnapshot(backupPath),
        ]);
        if (
          !snapshotsMatch(existingOutputSnapshot, sourceAfterBackup) ||
          !backupSnapshot.exists ||
          backupSnapshot.size !== existingOutputSnapshot.size ||
          backupSnapshot.sha256 !== existingOutputSnapshot.sha256
        ) {
          await fs.rm(backupPath, { force: true }).catch(() => {});
          throw new Error("现有工作簿备份校验失败，已停止覆盖");
        }
        console.log(`backup ${backupPath}`);
      } catch (error) {
        await fs.rm(backupPath, { force: true }).catch(() => {});
        throw error;
      }
    } else if ((await readStableFileSnapshot(outputPath)).exists) {
      throw new Error("生成期间出现了新的交付工作簿，已停止覆盖");
    }
    await assertSafeOutputPath(outputRoot, outputPath);
    await fs.rename(tempPath, outputPath);
    const finalWorkbookSnapshot = await readStableFileSnapshot(outputPath);
    if (!finalWorkbookSnapshot.exists || !/^[a-f0-9]{64}$/iu.test(finalWorkbookSnapshot.sha256 ?? "")) {
      throw new Error("资产表写入后校验失败");
    }
    await assertSafeOutputPath(skillRoot, workbookScopeReceiptPath);
    await writeJsonAtomic(workbookScopeReceiptPath, {
      version: WORKBOOK_SCOPE_RECEIPT_VERSION,
      mode: workbookScope ? "scoped" : "full",
      episodeStart: workbookScope?.episodeStart ?? null,
      episodeEnd: workbookScope?.episodeEnd ?? null,
      assetTypes: workbookScope ? [...workbookScope.assetTypes] : [...WORKBOOK_ASSET_TYPES],
      sourceFingerprint,
      validationFingerprint,
      workbookSha256: finalWorkbookSnapshot.sha256,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    await tempHandle?.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  console.log(`saved ${outputPath}`);
} finally {
  await releasePipelineLock(lockPath, {
    kind: "workbook_build",
    key: "workbook",
    token: workbookLock.token,
  });
}
