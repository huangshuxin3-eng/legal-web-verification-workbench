/**
 * 开发验证脚本（不是产品入口）：
 * 读一个「已解压的网核成果目录」→ 解析成统一结构化明细 → 生成一份可在 Microsoft Word 中
 * 继续编辑的尽调报告草稿（.docx）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/build-report-docx.ts <解压目录> \
 *     [--out=<docx路径>] [--target=<核查对象>] [--date=<核查日>]
 *
 * 只做三件事：读 PDF 文字层、调用纯解析器、生成 docx。不联数据库、不联工作台、不调 LLM。
 *
 * 当前批次（31 份 PDF）不是完整核查结果，因此报告默认为「开发验证草稿」，
 * 标题与首页均带验证提示；正式产品在核查完成后才生成正式报告。
 *
 * 说明：下面的 PDF 读取 I/O 与 build-execution-table.ts 同源（约 20 行）。
 * 按当前阶段口径「不重构已通过验证的第一阶段代码」，本轮有意保留少量重复；
 * 待 Word 输出稳定后再单独做公共 reader 抽取，不与功能开发混在同一步。
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Packer } from "docx";
import { getDocumentProxy } from "unpdf";
import {
  captureNoFromFileName,
  parseExecutionTable,
  OBLIGATION_LABEL,
  type CaptureInput,
  type TextRun,
} from "./zxgk-execution-parse.ts";
import {
  DRAFT_MARK_LINE,
  LANDSCAPE_TEXT_WIDTH_MM,
  PORTRAIT_TEXT_WIDTH_MM,
  REPORT_TABLE_COLUMNS,
  REPORT_TABLE_WIDTH_MM,
  TITLE_SIZE_HALF_PT,
  buildReportModel,
  buildTitleLines,
  groupByPublicTypes,
  renderReportDocx,
  type ReportModel,
  type ReportSupplement,
} from "./zxgk-report-docx.ts";

const TARGET_PLACEHOLDER = "〔核查对象〕";

// 产物落在仓库外的独立输出目录（与仓库并列，不进 git），按批次日期归档，
// 避免把 Excel / PDF / docx 乃至核查数据混进仓库，也不再堆在桌面。
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_ROOT = join(
  REPO_ROOT,
  "..",
  "nonlit-workbench-output",
  "20260917",
);

const defaultOutPath = join(
  OUTPUT_ROOT,
  "ZXGK执行及失信公开信息核查报告_20260917.docx",
);

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
  // unpdf 的 getDocumentProxy() 返回的是已解析的 proxy，运行时没有 destroy()（虽然类型里有）。
  return pages;
}

function listPdfFiles(root: string): string[] {
  return readdirSync(root, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => entry.toLowerCase().endsWith(".pdf"))
    .map((entry) => join(root, entry));
}

/** 从文件名里的 `_YYYYMMDD.pdf` 取核查日；全批一致才采用，否则留占位。 */
function deriveCheckDate(files: string[]): string {
  const dates = new Set<string>();
  for (const file of files) {
    const matched = /_(\d{4})(\d{2})(\d{2})\.pdf$/i.exec(file);
    if (matched) dates.add(`${matched[1]}-${matched[2]}-${matched[3]}`);
  }
  if (dates.size !== 1) return "〔核查日〕";
  const [date] = [...dates];
  const [year, month, day] = date.split("-");
  return `${Number(year)}年${Number(month)}月${Number(day)}日`;
}

/** 核查对象：全批「被执行人姓名/名称」一致时取该值，否则留占位。 */
function deriveTargetName(model: ReportModel): string {
  const table = model.landscape.find((block) => block.kind === "table");
  if (!table || table.kind !== "table") return TARGET_PLACEHOLDER;
  const column = REPORT_TABLE_COLUMNS.findIndex(
    (item) => item.header === "被执行人姓名/名称",
  );
  const names = new Set(
    table.rows
      .map((row) => row[column])
      .filter((value): value is string => !!value),
  );
  return names.size === 1 ? [...names][0] : TARGET_PLACEHOLDER;
}

function isSupplement(block: unknown): block is ReportSupplement {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as ReportSupplement).kind === "supplement"
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const inputs = args.filter((arg) => !arg.startsWith("--"));
  const flag = (name: string): string | undefined => {
    const hit = args.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  const outPath = flag("out") ? resolve(flag("out")!) : defaultOutPath;

  if (inputs.length === 0) {
    console.error(
      "用法：node --experimental-strip-types scripts/build-report-docx.ts <解压目录> [--out=<docx>] [--target=<核查对象>] [--date=<核查日>]",
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

  // 先建一次模型以便从表体推核查对象，再按需覆盖目标名重建。
  const provisional = buildReportModel(result, {
    targetName: TARGET_PLACEHOLDER,
    checkDate: flag("date") ?? deriveCheckDate(files),
  });
  const targetName = flag("target") ?? deriveTargetName(provisional);
  const model = buildReportModel(result, {
    targetName,
    checkDate: flag("date") ?? deriveCheckDate(files),
  });

  const buffer = await Packer.toBuffer(renderReportDocx(model));
  writeFileSync(outPath, buffer);

  const table = model.landscape.find((block) => block.kind === "table");
  const supplements = model.appendix.filter(isSupplement);
  const withShixin = supplements.filter((block) => block.fields.length > 0);
  const evidenceOnly = supplements.filter((block) => block.fields.length === 0);
  const obligations = supplements
    .map((block) => block.obligation)
    .filter((value): value is string => typeof value === "string");

  console.log(`输出：${outPath}`);
  console.log();
  console.log("=== 节结构 ===");
  console.log(
    "  第 1 节 纵向 A4｜左右页边距 31.7mm｜标题 + 开发验证提示 + 一、核查说明",
  );
  console.log(
    "  第 2 节 横向 A4｜左右页边距 18mm｜二、明细标题 +（一）表 1 表题 + 表格本体",
  );
  console.log(
    "  第 3 节 纵向 A4｜左右页边距 31.7mm｜三、律师提示 + 附：表 1 补充信息及证据索引",
  );
  console.log(`  标题：${model.title}`);
  const titleLines = buildTitleLines(
    targetName,
    TITLE_SIZE_HALF_PT,
    PORTRAIT_TEXT_WIDTH_MM,
  );
  console.log(
    `  标题呈现：${titleLines.length} 行（纵向可用 ${PORTRAIT_TEXT_WIDTH_MM.toFixed(1)}mm）｜${titleLines.join(" ／ ")}`,
  );
  console.log(`  草稿标识行：${DRAFT_MARK_LINE}`);
  console.log(`  首页提示：${model.notice}`);
  console.log();

  console.log("=== 表 1 主表 ===");
  if (!table || table.kind !== "table") {
    console.log("  （未生成表格）");
  } else {
    console.log(
      `  ${table.rows.length} 行 × ${table.headers.length} 列｜总宽 ${REPORT_TABLE_WIDTH_MM}mm｜横向可用 ${LANDSCAPE_TEXT_WIDTH_MM}mm｜余量 ${(LANDSCAPE_TEXT_WIDTH_MM - REPORT_TABLE_WIDTH_MM).toFixed(1)}mm`,
    );
    console.log(`  表头：${table.headers.join(" | ")}`);
    console.log(
      `  行属性：表头 1 行 tblHeader（跨页重复）｜数据行 ${table.rows.length} 行全部 cantSplit（不跨页拆分）`,
    );
    console.log(
      "  单元格：全部禁止西文在单词中间折行（wordWrap=0，金额/代码不会被断开）",
    );
    const emptyByColumn = table.headers.map((header, index) => ({
      header,
      empty: table.rows.filter((row) => row[index] === null).length,
    }));
    const emptyTotal = emptyByColumn.reduce((sum, item) => sum + item.empty, 0);
    const dashCells = table.rows.reduce(
      (sum, row) => sum + row.filter((cell) => cell === "—").length,
      0,
    );
    console.log(
      `  空单元格：合计 ${emptyTotal} 个｜按列 ${emptyByColumn.map((i) => `${i.header}=${i.empty}`).join("，")}`,
    );
    console.log(
      `  值为「—」的单元格：${dashCells} 个（当前样本预期 0；规则上「—」必须原样保留）`,
    );
  }

  console.log();
  console.log("=== 公示类型分布（按 ParseResult 动态分组）===");
  for (const group of groupByPublicTypes(result.rows)) {
    console.log(`  ${group.publicTypes} → ${group.count} 条`);
  }
  console.log();

  console.log("=== 表 1 补充信息及证据索引 ===");
  console.log(`  补充块合计：${supplements.length} 块（应等于主表行数）`);
  console.log(`  含失信特有字段的块：${withShixin.length}`);
  console.log(`  仅有证据文件名的块：${evidenceOnly.length}`);
  const numbered = supplements
    .map((block) => block.index)
    .sort((a, b) => a - b);
  const contiguous = numbered.every((value, index) => value === index + 1);
  console.log(
    `  编号「补充 1..N」连续对应表 1 序号：${contiguous ? "是" : "否"}`,
  );
  console.log(
    `  证据文件名非空：${supplements.filter((block) => block.evidenceFile.length > 0).length}/${supplements.length}`,
  );
  if (obligations.length > 0) {
    const lengths = obligations
      .map((value) => value.length)
      .sort((a, b) => a - b);
    const mean = Math.round(
      lengths.reduce((a, b) => a + b, 0) / lengths.length,
    );
    console.log(
      `  「${OBLIGATION_LABEL}」样本 ${lengths.length} 条｜长度 min=${lengths[0]} 中位=${lengths[Math.floor(lengths.length / 2)]} 均值=${mean} max=${lengths[lengths.length - 1]}`,
    );
    console.log(
      `  >40 字（说明折行续行已合并）：${lengths.filter((l) => l > 40).length} 条`,
    );
  }

  console.log();
  console.log("=== 备注 ===");
  const remarkCount = (text: string) =>
    result.rows.filter((row) => row.remarks.includes(text)).length;
  console.log(`  同案号另有记录：${remarkCount("同案号另有记录")} 行`);
  console.log(`  立案时间未公示：${remarkCount("立案时间未公示")} 行`);
  console.log(
    `  板块字段差异：${result.rows.filter((row) => row.remarks.includes("板块公示")).length} 行`,
  );

  console.log();
  console.log(
    `未纳入主表的留痕（列表页/无法判定）：${result.excluded.length} 份`,
  );
  for (const row of result.excluded) {
    console.log(
      `  Q01_${String(row.captureNo).padStart(3, "0")}｜${row.reason}`,
    );
  }

  console.log(`解析异常：${result.problems.length}`);
  for (const problem of result.problems) console.log(`  - ${problem}`);
}

await main();
