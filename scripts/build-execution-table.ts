/**
 * 开发验证脚本（不是产品入口）：
 * 读一个「已解压的网核成果目录」→ 解析成统一结构化明细 → 生成一份可人工核对的 Excel。
 *
 * 用法：
 *   node --experimental-strip-types scripts/build-execution-table.ts <解压目录> [--out=<xlsx路径>]
 *
 * 只做三件事：读 PDF 文字层、调用纯解析器、写 Excel。不联数据库、不联工作台、不调 LLM。
 *
 * 空值语义（重要）：真正没有值的字段必须写成 **null**，让 ExcelJS 不生成 `<c>` 元素。
 * 若传 `""`，ExcelJS 会为它建一条空共享字符串，读取方会把共享字符串下标显示成 21、22…
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { getDocumentProxy } from "unpdf";
import {
  captureNoFromFileName,
  parseExecutionTable,
  MAIN_TABLE_COLUMNS,
  OBLIGATION_LABEL,
  type CaptureInput,
  type DetailRow,
  type MainColumn,
  type TextRun,
} from "./zxgk-execution-parse.ts";

const EXCLUDED_HEADERS = [
  "序号",
  "capture_no",
  "未纳入原因",
  "对应证据PDF文件名",
] as const;

const EXCLUDED_WIDTHS = [6, 10, 40, 52];

// 产物落在仓库外的独立输出目录（与仓库并列，不进 git），按批次日期归档，
// 避免把 Excel / PDF / docx 乃至核查数据混进仓库，也不再堆在桌面。
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_ROOT = join(
  REPO_ROOT,
  "..",
  "nonlit-workbench-output",
  "20260917",
);

const defaultOutPath = join(OUTPUT_ROOT, "ZXGK执行记录核对表_20260917.xlsx");

async function readPages(bytes: Uint8Array): Promise<TextRun[][]> {
  const doc = await getDocumentProxy(bytes);
  const pages: TextRun[][] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const runs: TextRun[] = [];
    for (const item of content.items) {
      if (!("str" in item)) continue;
      runs.push({
        str: item.str,
        x: item.transform[4],
        y: item.transform[5],
        h: item.height,
      });
    }
    pages.push(runs);
  }
  // unpdf 的 getDocumentProxy() 返回的是已解析的 proxy，运行时没有 destroy()（虽然类型里有），
  // 这里不做清理：单批 31 份 PDF，进程结束即释放。
  return pages;
}

function listPdfFiles(root: string): string[] {
  return readdirSync(root, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => entry.toLowerCase().endsWith(".pdf"))
    .map((entry) => join(root, entry));
}

/** 只设置列宽与冻结首行；不要在这里 getRow(1)，否则会先创建一个空行。 */
function setupSheet(sheet: ExcelJS.Worksheet, widths: number[]): void {
  sheet.columns = widths.map((width) => ({ width }));
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

function styleHeaderRow(sheet: ExcelJS.Worksheet): void {
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: "middle" };
}

/** 空串不是「没有值」：统一折成 null，保证写出真正的空单元格。 */
function orNull(value: string | null): string | null {
  return value === null || value === "" ? null : value;
}

function cellValue(row: DetailRow, column: MainColumn): string | number | null {
  if (column.key === "field") return orNull(row.fields[column.header] ?? null);
  if (column.key === "remarks") return orNull(row.remarks);
  return row[column.key];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const inputs = args.filter((arg) => !arg.startsWith("--"));
  const outArg = args.find((arg) => arg.startsWith("--out="));
  const outPath = outArg
    ? resolve(outArg.slice("--out=".length))
    : defaultOutPath;

  if (inputs.length === 0) {
    console.error(
      "用法：node --experimental-strip-types scripts/build-execution-table.ts <解压目录> [--out=<xlsx>]",
    );
    process.exitCode = 2;
    return;
  }

  const root = resolve(inputs[0]);
  const files = listPdfFiles(root).sort((a, b) => {
    const left = captureNoFromFileName(a) ?? Number.MAX_SAFE_INTEGER;
    const right = captureNoFromFileName(b) ?? Number.MAX_SAFE_INTEGER;
    return left - right || a.localeCompare(b);
  });

  console.log(`输入目录：${root}`);
  console.log(`发现 PDF：${files.length} 份`);

  const captures: CaptureInput[] = [];
  for (const file of files) {
    const bytes = new Uint8Array(readFileSync(file));
    const fileName = file.split(sep).pop() ?? file;
    captures.push({ fileName, pages: await readPages(bytes) });
  }

  const result = parseExecutionTable(captures);

  const workbook = new ExcelJS.Workbook();
  const main = workbook.addWorksheet("主表");
  setupSheet(
    main,
    MAIN_TABLE_COLUMNS.map((column) => column.width),
  );
  main.addRow(MAIN_TABLE_COLUMNS.map((column) => column.header));
  styleHeaderRow(main);

  const wrapIndexes = MAIN_TABLE_COLUMNS.map((column, index) =>
    column.wrap ? index + 1 : 0,
  ).filter((index) => index > 0);
  for (const row of result.rows) {
    const added = main.addRow(
      MAIN_TABLE_COLUMNS.map((column) => cellValue(row, column)),
    );
    for (const index of wrapIndexes) {
      const cell = added.getCell(index);
      // 空单元格不加样式：加了会写出一个只有样式、没有值的 <c/> 幽灵单元格。
      if (cell.value === null) continue;
      cell.alignment = { wrapText: true, vertical: "top" };
    }
  }

  const excluded = workbook.addWorksheet("未纳入清单");
  setupSheet(excluded, [...EXCLUDED_WIDTHS]);
  excluded.addRow([...EXCLUDED_HEADERS]);
  styleHeaderRow(excluded);
  for (const row of result.excluded) {
    excluded.addRow([row.index, row.captureNo, row.reason, row.evidenceFile]);
  }

  await workbook.xlsx.writeFile(outPath);

  console.log(`输出：${outPath}`);
  console.log(
    `主表：${result.rows.length} 行 × ${MAIN_TABLE_COLUMNS.length} 列`,
  );
  console.log(`表头：${MAIN_TABLE_COLUMNS.map((c) => c.header).join(" | ")}`);

  const typeCount = new Map<string, number>();
  for (const row of result.rows) {
    typeCount.set(row.publicTypes, (typeCount.get(row.publicTypes) ?? 0) + 1);
  }
  console.log("公示类型分布：");
  for (const [type, count] of typeCount) console.log(`  ${type} → ${count}`);

  console.log(`未纳入行数：${result.excluded.length}（应全部为列表页）`);

  const remarkCount = (text: string) =>
    result.rows.filter((row) => row.remarks.includes(text)).length;
  console.log(`备注·同案号另有记录：${remarkCount("同案号另有记录")}`);
  console.log(`备注·立案时间未公示：${remarkCount("立案时间未公示")}`);
  console.log(
    `备注·板块字段差异：${result.rows.filter((row) => row.remarks.includes("板块公示")).length}`,
  );
  for (const row of result.rows) {
    if (row.remarks.includes("板块公示")) {
      console.log(
        `  Q01_${String(row.captureNo).padStart(3, "0")}：${row.remarks}`,
      );
    }
  }

  const emptyByColumn = MAIN_TABLE_COLUMNS.map((column) => ({
    header: column.header,
    empty: result.rows.filter((row) => cellValue(row, column) === null).length,
  }));
  const emptyTotal = emptyByColumn.reduce((sum, item) => sum + item.empty, 0);
  console.log(
    `空单元格统计：合计 ${emptyTotal} 个 / ${emptyByColumn.length} 列`,
  );
  console.log(
    `  按列：${emptyByColumn.map((i) => `${i.header}=${i.empty}`).join("，")}`,
  );

  const obligations = result.rows
    .map((row) => row.fields[OBLIGATION_LABEL])
    .filter((value): value is string => typeof value === "string");
  if (obligations.length > 0) {
    const lengths = obligations
      .map((value) => value.length)
      .sort((a, b) => a - b);
    const sum = (list: number[]) => list.reduce((a, b) => a + b, 0);
    const mean = Math.round(sum(lengths) / lengths.length);
    console.log(
      `「${OBLIGATION_LABEL}」样本 ${lengths.length} 条｜长度 min=${lengths[0]} 中位=${lengths[Math.floor(lengths.length / 2)]} 均值=${mean} max=${lengths[lengths.length - 1]}`,
    );
    console.log(
      `  >40 字（说明折行续行已合并）：${lengths.filter((l) => l > 40).length} 条`,
    );
  }

  console.log(`解析异常：${result.problems.length}`);
  for (const problem of result.problems) console.log(`  - ${problem}`);
}

await main();
