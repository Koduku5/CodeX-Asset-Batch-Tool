import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadArtifactTool } from "../lib/load_artifact_tool.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(process.argv[2] ?? path.join(scriptDir, "..", ".."));
const templatePath = path.join(skillRoot, "assets", "Excel模板", "剧本资产制表模板.xlsx");
const { FileBlob, SpreadsheetFile } = await loadArtifactTool();
if (!FileBlob || !SpreadsheetFile) {
  throw new Error("@oai/artifact-tool is present but its spreadsheet API is incomplete.");
}

const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(templatePath));
const expectedSheets = ["剧本解析", "角色", "生物", "群演", "场景", "道具"];
const actualSheets = workbook.worksheets.items.map((sheet) => sheet.name);
if (JSON.stringify(actualSheets) !== JSON.stringify(expectedSheets)) {
  throw new Error(`Excel template sheets are invalid: ${actualSheets.join(", ")}`);
}
const expectedHeaders = {
  剧本解析: ["解析项", "内容"],
  角色: [
    "资产ID", "资产名称", "制作说明", "阵营", "剧本设定", "推演依据",
    "自动化", "负责人", "精修", "状态", "最终确认", "返修意见",
  ],
  生物: [
    "资产ID", "资产名称", "制作说明", "阵营", "剧本设定", "推演依据",
    "自动化", "负责人", "精修", "状态", "最终确认", "返修意见",
  ],
  群演: [
    "资产ID", "资产名称", "制作说明", "阵营", "剧本设定", "推演依据",
    "自动化", "负责人", "精修", "审核", "返修建议",
  ],
  场景: [
    "资产ID", "资产名称", "制作说明", "剧本设定", "推演依据",
    "自动化", "负责人", "精修", "审核", "最终确认", "返修建议",
  ],
  道具: [
    "资产ID", "资产名称", "制作说明", "剧本设定", "推演依据",
    "自动化", "负责人", "精修", "状态", "最终确认", "返修建议",
  ],
};
for (const [sheetName, headers] of Object.entries(expectedHeaders)) {
  const lastColumn = String.fromCharCode(64 + headers.length);
  const actual = workbook.worksheets
    .getItem(sheetName)
    .getRange(`A1:${lastColumn}1`).values[0]
    .map((value) => String(value ?? "").trim());
  if (JSON.stringify(actual) !== JSON.stringify(headers)) {
    throw new Error(`Excel template headers are invalid on ${sheetName}: ${actual.join(", ")}`);
  }
}
const smoke = await SpreadsheetFile.exportXlsx(workbook);
if (!smoke?.data?.byteLength) throw new Error("Excel template smoke export is empty.");

console.log("artifact-tool=ok template=ok");
