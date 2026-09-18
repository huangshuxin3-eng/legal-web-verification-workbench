/**
 * ZXGK 留痕 → Word 尽调报告（V1）的**报告模型层 + 渲染层**。
 *
 * 分层：
 *   parseExecutionTable（已提交的纯解析器，本文件不改动）
 *     → buildReportModel(result, meta)  ← 纯函数：结构化事实 → 报告内容模型（可单测，不读写磁盘）
 *     → renderReportDocx(model)         ← 薄渲染层：内容模型 → docx Document（只管版式）
 *
 * 本文件不读 PDF、不写文件；读 PDF 与写 .docx 的职责在 build-report-docx.ts。
 *
 * 口径（人工 LOCK）：
 *   1. Word 是「律师报告表达层」，Excel 才是完整事实底稿。底稿 20 列不机械搬进 Word：
 *      11 列进主表、失信特有字段与长文本进「表 1 补充信息及证据索引」、证据文件名进索引、
 *      「性别」不进 Word（28/28 恒为 `—`，进表零信息量）。
 *   2. 一份 detail = 一行 = 一个「补充」块；不合并同案号、不修改网站原始字段值。
 *   3. 核查结果统计**动态生成**：按 ParseResult 中实际出现的 publicTypes 组合分组计数，
 *      不硬编码任何组合名称或数字。
 *   4. 空值语义与 Excel 底稿完全一致，不因排版改变：
 *        网站明确公示 `—` → 原值输出 `—`；
 *        当前公示类型根本不存在该字段（null）→ 真空白，不写成 `—`/`0`/`无`/`/`；
 *        系统备注未触发 → 真空白。
 *      渲染层对 `—` 是**透传**的：当前 28 条样本的 11 列主表恰好没有 `—`，
 *      但未来真实字段出现 `—` 时必须原样输出（见 tests 里的 `—` 透传用例）。
 *   5. 固定模板文字只陈述数据已确定的事实；不作风险评分、不作法律结论、不写「AI/系统认为」。
 *
 * 版式（显式写入代码，不依赖 Word 默认值）：
 *   第 1 节 纵向 A4：报告标题 + 开发验证提示 + 一、核查说明
 *   第 2 节 横向 A4：二、执行及失信公开信息明细 +（一）表 1 表题 + 11 列表格本体
 *   第 3 节 纵向 A4：三、律师提示 + 附：表 1 补充信息及证据索引
 *
 * 以下是**纯排版**规则（只决定换行/分页位置，不增删任何事实内容）：
 *   1. 主表数据行 `cantSplit`（一条记录不跨页拆分），表头行保留 `tableHeader` 跨页重复；
 *   2. 主标题一行放不下时，在「《实体名」与「核查事项》」之间断成两行，
 *      避免最后 1~2 个字被单独挤到第二行（见 buildTitleLines）；
 *   3. 表体单元格禁止西文在单词中间折行，金额、代码等一整串数字不会被断开
 *      （见 renderCell 的 `wordWrap`：docx 写出的是 `<w:wordWrap w:val="0"/>`）；
 *   4. 补充块的「对应证据：xxx.pdf」与其上一段保持同页，不被单独挤到下一页
 *      （见 renderReportSupplement 的 `keepNext`）。
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  PageOrientation,
  Paragraph,
  SectionType,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
  convertMillimetersToTwip,
} from "docx";
import {
  NOT_PUBLISHED,
  OBLIGATION_LABEL,
  SHIXIN_FIELD_LABELS,
  type DetailRow,
  type ParseResult,
} from "./zxgk-execution-parse.ts";

// ── 报告元信息 ────────────────────────────────────────────────────────────

export const DEFAULT_SITE_NAME = "中国执行信息公开网";
export const DEFAULT_SITE_URL = "http://zxgk.court.gov.cn/";
/**
 * 开发验证稿标识行：**独立成行**、居中、字号小于主标题，不拼进标题字符串。
 * 正式报告（`draft: false`）时，本行与 DRAFT_NOTICE 一起整行删除。
 */
export const DRAFT_MARK_LINE = "（开发验证草稿）";
export const DRAFT_NOTICE =
  "本文件仅用于报告模板及数据呈现验证，不作为正式核查报告。";

/** 主标题字号（半点）：16pt。折成两行时两行同字号。 */
export const TITLE_SIZE_HALF_PT = 32;
/** 标题固定后缀（核查事项）。标题 = 《核查对象 + 本后缀》。 */
export const TITLE_TAIL = "执行及失信公开信息核查报告";

export type ReportMeta = {
  /** 核查对象（被查询主体名称）。 */
  targetName: string;
  /** 核查日，例如「2026年9月17日」。 */
  checkDate: string;
  /** 核查网站名称；默认「中国执行信息公开网」。 */
  siteName?: string;
  /** 核查网站网址；默认站点首页。 */
  siteUrl?: string;
  /** 是否开发验证草稿；正式产品在核查完成后置 false。默认 true。 */
  draft?: boolean;
};

// ── 报告内容模型 ──────────────────────────────────────────────────────────

export type ReportTextSpan = {
  text: string;
  bold?: boolean;
};

export type ReportParagraph = {
  kind: "paragraph";
  spans: ReportTextSpan[];
  /** 字号（半点）：18 = 9pt、21 = 10.5pt、24 = 12pt、28 = 14pt、32 = 16pt。 */
  sizeHalfPt?: number;
  /** 中文（eastAsia）字体。 */
  fontEastAsia?: string;
  bold?: boolean;
  align?: "left" | "center";
  /** 左缩进字符数（按本段字号计）。 */
  indentChars?: number;
  spacingBeforePt?: number;
  spacingAfterPt?: number;
  /** 本段之前分页。 */
  pageBreakBefore?: boolean;
  /** 与下一段同页（避免标题落在页底）。 */
  keepNext?: boolean;
};

export type ReportTable = {
  kind: "table";
  headers: string[];
  columnWidthsMm: number[];
  /** null = 真空白单元格（不是 `""`、不是 `—`）。 */
  rows: (string | null)[][];
};

export type ReportSupplementField = {
  label: string;
  /** 已是渲染值：可能是 `—`（网站明确公示空值），不会是空串。 */
  value: string;
};

export type ReportSupplement = {
  kind: "supplement";
  /** 「补充 N」，与表 1 序号一一对应。 */
  index: number;
  caseNo: string | null;
  /** 该条实际公示的失信特有字段；该公示类型不含的字段不在此数组里。 */
  fields: ReportSupplementField[];
  /** `生效法律文书确定的义务` 全文，不截断；无此字段时为 null。 */
  obligation: string | null;
  evidenceFile: string;
};

export type ReportBlock = ReportParagraph | ReportTable | ReportSupplement;

export type ReportModel = {
  title: string;
  /** 首页的醒目提示；正式报告为空串。 */
  notice: string;
  /** 第 1 节（纵向）：标题 + 开发验证提示 + 一、核查说明。 */
  preamble: ReportBlock[];
  /** 第 2 节（横向）：二、明细标题 +（一）表 1 表题 + 表格本体。 */
  landscape: ReportBlock[];
  /** 第 3 节（纵向）：三、律师提示 + 附：表 1 补充信息及证据索引。 */
  appendix: ReportBlock[];
};

// ── 主表列定义（11 列，横向 A4）─────────────────────────────────────────

/**
 * 主表的列。`header` 除三个元信息列外都是**站点标签原文**，
 * 因此可直接用它取 `row.fields[header]`。
 */
export type ReportTableColumn = {
  header: string;
  widthMm: number;
  key: "index" | "publicTypes" | "remarks" | "field";
};

/**
 * 列宽（mm）合计 259mm ≤ 横向 A4 可用宽 261mm。
 * 「身份证号码/组织机构代码」列取 34mm（可用 32mm）：18 字符的统一社会信用代码或
 * 掩码值（`9144030008****371X`，9pt Times New Roman 下约 29.3mm）须完整显示，
 * 不把末位 X 折到下一行。
 * 「执行标的」列 20mm → 21mm（可用 19mm）：本批最长金额 `513602222.00`
 * 在 9pt Times New Roman 下约 18.3mm，20mm 列刚好放不下、会把末位数字挤到第二行；
 * 补的 1mm 从「备注」列（27mm → 26mm；该列文字本身很长、恒为多行）匀出，总宽不变。
 */
export const REPORT_TABLE_COLUMNS: readonly ReportTableColumn[] = [
  { header: "序号", widthMm: 9, key: "index" },
  { header: "案号", widthMm: 31, key: "field" },
  { header: "被执行人姓名/名称", widthMm: 27, key: "field" },
  { header: "身份证号码/组织机构代码", widthMm: 34, key: "field" },
  { header: "执行法院", widthMm: 27, key: "field" },
  { header: "立案时间", widthMm: 20, key: "field" },
  { header: "执行标的", widthMm: 21, key: "field" },
  { header: "终本日期", widthMm: 20, key: "field" },
  { header: "未履行金额", widthMm: 21, key: "field" },
  { header: "公示类型", widthMm: 23, key: "publicTypes" },
  { header: "备注", widthMm: 26, key: "remarks" },
];

/** 主表总宽（mm）——与横向 A4 可用宽度（261mm）核对用。 */
export const REPORT_TABLE_WIDTH_MM = REPORT_TABLE_COLUMNS.reduce(
  (sum, column) => sum + column.widthMm,
  0,
);

/** 横向 A4、左右页边距 18mm 时的可用宽度（mm）。 */
export const LANDSCAPE_TEXT_WIDTH_MM = 297 - 18 * 2;
/** 纵向 A4、左右页边距 31.7mm 时的可用宽度（mm）。 */
export const PORTRAIT_TEXT_WIDTH_MM = 210 - 31.7 * 2;

// ── 文字宽度估算与标题折行（仅决定换行位置，不参与任何事实计算）─────────────

/**
 * 单个字符占多少 em：CJK / 全角按 1 em，其余（ASCII、数字、半角标点）按 0.5 em。
 * 只用于预估一行能放多少字，不追求与字体度量表逐字一致。
 */
export function charEm(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  const wide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd);
  return wide ? 1 : 0.5;
}

/** 一段文字在给定字号下的估算宽度（mm）。 */
export function textWidthMm(text: string, sizeHalfPt: number): number {
  let em = 0;
  for (const char of text) em += charEm(char);
  return ((em * sizeHalfPt) / 2) * (25.4 / 72);
}

/**
 * 主标题折行位置。
 *
 * 规则（对应「长标题不要出现最后 1~2 个字单独换行」）：
 *   1. 一行放得下 → 一行；
 *   2. 放不下 → 在「《核查对象」与「核查事项》」之间断成两行（两行都放得下时才用）；
 *   3. 仍放不下（核查对象名本身过长）→ 按宽度均分为 N 行。
 * 只选换行位置，不增删任何字符（`lines.join("")` 恒等于原标题）。导出供测试断言。
 */
export function buildTitleLines(
  targetName: string,
  sizeHalfPt: number,
  usableWidthMm: number,
): string[] {
  const oneLine = `《${targetName}${TITLE_TAIL}》`;
  if (textWidthMm(oneLine, sizeHalfPt) <= usableWidthMm) return [oneLine];

  const semantic = [`《${targetName}`, `${TITLE_TAIL}》`];
  if (
    semantic.every((line) => textWidthMm(line, sizeHalfPt) <= usableWidthMm)
  ) {
    return semantic;
  }

  return balancedLines(oneLine, sizeHalfPt, usableWidthMm);
}

/** 按宽度尽量均分成若干行，避免末行只剩一两个字。 */
function balancedLines(
  text: string,
  sizeHalfPt: number,
  usableWidthMm: number,
): string[] {
  const total = textWidthMm(text, sizeHalfPt);
  const count = Math.max(2, Math.ceil(total / usableWidthMm));
  const target = total / count;
  const lines: string[] = [];
  let current = "";
  for (const char of text) {
    const grown = current + char;
    if (
      current !== "" &&
      lines.length < count - 1 &&
      textWidthMm(grown, sizeHalfPt) > target
    ) {
      lines.push(current);
      current = char;
    } else {
      current = grown;
    }
  }
  lines.push(current);
  return lines;
}

const IDENTITY_LABEL = "身份证号码/组织机构代码";
const CASE_NO_LABEL = "案号";
const REMARK_DUPLICATE_CASE_NO = "同案号另有记录";
/** 解析器对「不同板块同一字段文字不一致」写备注时使用的固定字样。 */
const SECTION_DIFFERENCE_MARK = "板块公示";
const UNKNOWN_PUBLIC_TYPES = "（未识别公示类型）";

/** 空串不是「没有值」。保留 `—`（网站明确公示的空值），只把空串折成 null。 */
function orNull(value: string | null | undefined): string | null {
  return value === null || value === undefined || value === "" ? null : value;
}

/** 主表单元格的渲染值。 */
export function tableCellText(
  row: DetailRow,
  column: ReportTableColumn,
): string | null {
  if (column.key === "index") return String(row.index);
  if (column.key === "publicTypes") return orNull(row.publicTypes);
  if (column.key === "remarks") return orNull(row.remarks);
  return orNull(row.fields[column.header] ?? null);
}

// ── 统计（全部动态，无硬编码组合/数字）──────────────────────────────────

export type PublicTypeGroup = { publicTypes: string; count: number };

/**
 * 按该批次实际出现的 publicTypes 组合分组计数。
 * 排序：条数降序 → 组合名升序（保证输出稳定、可幂等比较）。
 */
export function groupByPublicTypes(rows: DetailRow[]): PublicTypeGroup[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.publicTypes === "" ? UNKNOWN_PUBLIC_TYPES : row.publicTypes;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([publicTypes, count]) => ({ publicTypes, count }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        (a.publicTypes < b.publicTypes
          ? -1
          : a.publicTypes > b.publicTypes
            ? 1
            : 0),
    );
}

/** 同案号重复的组数与涉及记录数。 */
export function countDuplicateCaseNo(rows: DetailRow[]): {
  groups: number;
  records: number;
} {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const caseNo = row.fields[CASE_NO_LABEL];
    if (!caseNo) continue;
    counts.set(caseNo, (counts.get(caseNo) ?? 0) + 1);
  }
  let groups = 0;
  let records = 0;
  for (const count of counts.values()) {
    if (count > 1) {
      groups += 1;
      records += count;
    }
  }
  return { groups, records };
}

/** 行数按备注字样统计（备注文案是解析器已锁定的输出契约）。 */
export function countRowsWithRemark(rows: DetailRow[], mark: string): number {
  return rows.filter((row) => row.remarks.split("；").includes(mark)).length;
}

/** 不同公示板块文字不一致的记录数。 */
export function countSectionDifferenceRows(rows: DetailRow[]): number {
  return rows.filter((row) =>
    row.remarks
      .split("；")
      .some((part) => part.includes(SECTION_DIFFERENCE_MARK)),
  ).length;
}

/** 身份信息以掩码形式公示的记录数。 */
export function countMaskedRows(rows: DetailRow[]): number {
  return rows.filter((row) => (row.fields[IDENTITY_LABEL] ?? "").includes("*"))
    .length;
}

// ── 段落构造小工具 ────────────────────────────────────────────────────────

type ParagraphOptions = Omit<ReportParagraph, "kind" | "spans">;

function paragraph(
  spans: ReportTextSpan[],
  options: ParagraphOptions = {},
): ReportParagraph {
  return { kind: "paragraph", spans, ...options };
}

/** 正文段落（10.5pt 宋体）。 */
function body(text: string, options: ParagraphOptions = {}): ReportParagraph {
  return paragraph([{ text }], options);
}

/** 一级标题（14pt 黑体）。 */
function heading1(
  text: string,
  options: ParagraphOptions = {},
): ReportParagraph {
  return paragraph([{ text }], {
    sizeHalfPt: 28,
    fontEastAsia: "黑体",
    bold: true,
    spacingBeforePt: 12,
    spacingAfterPt: 6,
    keepNext: true,
    ...options,
  });
}

/** 二级标题（12pt 黑体）。 */
function heading2(
  text: string,
  options: ParagraphOptions = {},
): ReportParagraph {
  return paragraph([{ text }], {
    sizeHalfPt: 24,
    fontEastAsia: "黑体",
    bold: true,
    spacingBeforePt: 10,
    spacingAfterPt: 4,
    keepNext: true,
    ...options,
  });
}

// ── 报告模型 ──────────────────────────────────────────────────────────────

export function buildReportModel(
  result: ParseResult,
  meta: ReportMeta,
): ReportModel {
  const draft = meta.draft ?? true;
  const siteName = meta.siteName ?? DEFAULT_SITE_NAME;
  const siteUrl = meta.siteUrl ?? DEFAULT_SITE_URL;
  const rows = result.rows;
  const total = rows.length;

  const groups = groupByPublicTypes(rows);
  const duplicate = countDuplicateCaseNo(rows);
  const differenceRows = countSectionDifferenceRows(rows);
  const maskedRows = countMaskedRows(rows);
  const duplicateRemarkRows = countRowsWithRemark(
    rows,
    REMARK_DUPLICATE_CASE_NO,
  );

  // 标题字符串**不含**草稿后缀：草稿提示改为标题下方独立两行（正式模式整段删除）。
  const title = `《${meta.targetName}${TITLE_TAIL}》`;

  // 标题折行：一行放得下就一行；放不下则在「《核查对象」与「核查事项》」之间断成两行，
  // 避免最后 1~2 个字被单独挤到第二行。渲染后仍是同一个居中标题块。
  const titleLines = buildTitleLines(
    meta.targetName,
    TITLE_SIZE_HALF_PT,
    PORTRAIT_TEXT_WIDTH_MM,
  );

  // ── 第 1 节：标题 + 开发验证提示 + 核查说明 ───────────────────────────
  const preamble: ReportBlock[] = titleLines.map((line, position) =>
    paragraph([{ text: line }], {
      sizeHalfPt: TITLE_SIZE_HALF_PT,
      fontEastAsia: "黑体",
      bold: true,
      align: "center",
      // 标题折行时行间不留空隙；末行才留出与草稿标识行的间隔。
      spacingAfterPt: position === titleLines.length - 1 ? (draft ? 4 : 8) : 0,
      // 只在需要时写入：避免 docx 把 false 写成冗余的 w:val="false"
      keepNext: position < titleLines.length - 1 ? true : undefined,
    }),
  );
  if (draft) {
    preamble.push(
      paragraph([{ text: DRAFT_MARK_LINE }], {
        sizeHalfPt: 24,
        fontEastAsia: "黑体",
        bold: true,
        align: "center",
        spacingAfterPt: 4,
      }),
      paragraph([{ text: DRAFT_NOTICE }], {
        sizeHalfPt: 21,
        fontEastAsia: "黑体",
        bold: true,
        align: "center",
        spacingAfterPt: 14,
      }),
    );
  }

  preamble.push(heading1("一、核查说明"));

  preamble.push(heading2("（一）核查事项"));
  preamble.push(
    body(
      `本所律师于 ${meta.checkDate}登录${siteName}（网址：${siteUrl}），` +
        `就被查询主体的执行及失信公开信息进行查询。`,
    ),
  );

  preamble.push(heading2("（二）核查结果"));
  preamble.push(
    body(
      `本次查询共取得被查询主体执行及失信公开信息公示记录 ${total} 条，` +
        `按公示页面所载公示类型统计如下：`,
    ),
  );
  groups.forEach((group, position) => {
    preamble.push(
      body(
        `${position + 1}. 公示类型为“${group.publicTypes}”的记录　${group.count} 条；`,
        { indentChars: 2 },
      ),
    );
  });
  preamble.push(
    body(`合计　${total} 条。`, { indentChars: 3, spacingBeforePt: 2 }),
  );
  preamble.push(
    body(
      `上述 ${total} 条记录对应的查询页面均已留存电子文件。表 1 各条记录与其对应留痕文件的` +
        `对应关系，见“表 1 补充信息及证据索引”。`,
      { spacingBeforePt: 6 },
    ),
  );

  preamble.push(heading2("（三）列示说明"));
  const listingItems: string[] = [
    "本报告根据" +
      siteName +
      "公示页面所载内容整理列示，未对公示事实内容作实质性改写。",
    "公示信息不包含相应项目的，本报告相应栏目留空。例如：公示类型不含“终本案件”的记录，" +
      "“终本日期”“未履行金额”栏留空；公示类型不含“被执行人”“终本案件”的记录，" +
      "“执行标的”栏留空。上述空白仅表示公示信息未包含该项目，不得解释为“0”“无”或其他含义。",
    `公示页面明确载明为“${NOT_PUBLISHED}”的项目，本报告按公示页面原值列示。`,
  ];
  if (duplicate.groups > 0) {
    listingItems.push(
      `${total} 条记录中，${duplicate.groups} 组案号（合计 ${duplicate.records} 条记录）` +
        `在本次查询结果中各出现两次以上，已在表 1“备注”栏标注“${REMARK_DUPLICATE_CASE_NO}”。`,
    );
  }
  if (differenceRows > 0) {
    listingItems.push(
      `${differenceRows} 条记录的不同公示板块对同一字段公示文字不一致，` +
        `已在表 1“备注”栏予以客观记录。`,
    );
  }
  listingItems.push("表 1“备注”栏留空者，系不存在需说明的事项。");
  listingItems.forEach((text, position) => {
    preamble.push(body(`${position + 1}. ${text}`));
  });

  // ── 第 2 节：「二、」明细标题 + 表 1 表题 + 表格本体（同一横向节）──────
  const landscape: ReportBlock[] = [
    heading1("二、执行及失信公开信息明细"),
    heading2("（一）表 1　执行及失信公开信息汇总表"),
    {
      kind: "table",
      headers: REPORT_TABLE_COLUMNS.map((column) => column.header),
      columnWidthsMm: REPORT_TABLE_COLUMNS.map((column) => column.widthMm),
      rows: rows.map((row) =>
        REPORT_TABLE_COLUMNS.map((column) => tableCellText(row, column)),
      ),
    },
  ];

  // ── 第 3 节：律师提示 + 附：表 1 补充信息及证据索引 ───────────────────
  const appendix: ReportBlock[] = [heading1("三、律师提示")];
  const hints: string[] = [
    `本报告所载信息系基于${siteName}于 ${meta.checkDate}公示的内容整理而成。` +
      `该等公示信息系动态信息，可能因被执行人履行义务、执行程序推进、案件撤销或信息更正等` +
      `原因发生变化，本报告不构成对相关公示事项现状的确认。`,
    "本报告仅对公示信息进行整理列示，未对相关执行案件的实体争议，执行标的金额、未履行金额的" +
      "准确性及其计算依据，以及被查询主体的清偿能力发表意见，亦未就所涉案件的严重程度、责任" +
      "认定或法律后果作出判断。",
  ];
  if (duplicateRemarkRows > 0) {
    hints.push(
      `表 1“备注”栏中“${REMARK_DUPLICATE_CASE_NO}”的标注，仅系对该案号在本次查询结果中` +
        `出现两次以上这一客观情形的记载，不代表本所对相关记录是否重复、案件数量或案件同一性` +
        `作出判断。`,
    );
  }
  if (differenceRows > 0) {
    hints.push(
      "表 1“备注”栏中关于不同公示板块对同一字段公示文字不一致的记载，系对公示页面客观差异的" +
        "记录，本所未就何者更为准确作出判断。",
    );
  }
  if (maskedRows > 0) {
    hints.push(
      "部分身份信息以掩码形式公示，本报告按公示页面所载内容列示；如需进一步核实主体身份，" +
        "建议结合其他资料进行核对。",
    );
  }
  hints.forEach((text, position) => {
    appendix.push(body(`${position + 1}. ${text}`));
  });

  // 附件独立起页：28 个补充块篇幅长，置于律师提示之后另起一页，接近律所报告体例。
  appendix.push(
    heading1("附：表 1 补充信息及证据索引", { pageBreakBefore: true }),
  );
  for (const row of rows) {
    appendix.push(buildSupplement(row));
  }

  return {
    title,
    notice: draft ? DRAFT_NOTICE : "",
    preamble,
    landscape,
    appendix,
  };
}

/** 一条记录 → 一个「补充」块：失信特有字段 + 义务全文 + 证据文件名。 */
function buildSupplement(row: DetailRow): ReportSupplement {
  const fields: ReportSupplementField[] = [];
  for (const label of SHIXIN_FIELD_LABELS) {
    const value = row.fields[label];
    // null = 该公示类型根本不存在这个字段 → 不列示；`—` = 网站公示了空值 → 原样列出。
    if (value === null || value === undefined || value === "") continue;
    fields.push({ label, value });
  }
  const obligation = row.fields[OBLIGATION_LABEL];
  return {
    kind: "supplement",
    index: row.index,
    caseNo: orNull(row.fields[CASE_NO_LABEL] ?? null),
    fields,
    obligation:
      obligation === null || obligation === undefined || obligation === ""
        ? null
        : obligation,
    evidenceFile: row.evidenceFile,
  };
}

// ── 渲染层 ────────────────────────────────────────────────────────────────

const SIZE_BODY = 21;
const SIZE_TABLE = 18;

/** 正文/表格统一字体：中文宋体、西文 Times New Roman。 */
function font(eastAsia: string) {
  return { ascii: "Times New Roman", hAnsi: "Times New Roman", eastAsia };
}

/** 字符缩进 → twip。 */
function indentTwip(chars: number, sizeHalfPt: number): number {
  return Math.round(chars * (sizeHalfPt / 2) * 20);
}

function toRuns(
  spans: ReportTextSpan[],
  sizeHalfPt: number,
  eastAsia: string,
  forceBold = false,
): TextRun[] {
  return spans.map(
    (span) =>
      new TextRun({
        text: span.text,
        bold: forceBold || span.bold === true,
        size: sizeHalfPt,
        font: font(eastAsia),
      }),
  );
}

function renderParagraph(block: ReportParagraph): Paragraph {
  const sizeHalfPt = block.sizeHalfPt ?? SIZE_BODY;
  const eastAsia = block.fontEastAsia ?? "宋体";
  return new Paragraph({
    children: toRuns(block.spans, sizeHalfPt, eastAsia, block.bold === true),
    alignment:
      block.align === "center" ? AlignmentType.CENTER : AlignmentType.LEFT,
    indent:
      block.indentChars === undefined
        ? undefined
        : { left: indentTwip(block.indentChars, sizeHalfPt) },
    spacing: {
      before: Math.round((block.spacingBeforePt ?? 0) * 20),
      after: Math.round((block.spacingAfterPt ?? 0) * 20),
      line: Math.round(sizeHalfPt * 20 * 1.35),
    },
    pageBreakBefore: block.pageBreakBefore,
    keepNext: block.keepNext,
  });
}

function renderCell(
  text: string | null,
  widthMm: number,
  options: { bold?: boolean; center?: boolean; shaded?: boolean },
): TableCell {
  return new TableCell({
    width: {
      size: convertMillimetersToTwip(widthMm),
      type: WidthType.DXA,
    },
    verticalAlign: VerticalAlign.CENTER,
    shading: options.shaded
      ? { type: ShadingType.CLEAR, color: "auto", fill: "F2F2F2" }
      : undefined,
    margins: {
      top: convertMillimetersToTwip(0.8),
      bottom: convertMillimetersToTwip(0.8),
      left: convertMillimetersToTwip(1),
      right: convertMillimetersToTwip(1),
    },
    children: [
      new Paragraph({
        // null = 真空白单元格：只放一个空段落，不写 —/0/无// 任何占位字符。
        children:
          text === null
            ? []
            : toRuns([{ text }], SIZE_TABLE, "宋体", options.bold === true),
        alignment: options.center ? AlignmentType.CENTER : AlignmentType.LEFT,
        spacing: { before: 0, after: 0 },
        // ⚠️ docx 的 `wordWrap: true` 写出的是 `<w:wordWrap w:val="0"/>`，
        // 含义是「**不**允许西文在单词中间换行」：金额（如 513602222.00）、
        // 代码（如 9144030008****371X）等一整串数字/字母若在本行放不下，
        // 整串移到下一行，不会从数字中间断开。
        wordWrap: true,
      }),
    ],
  });
}

/**
 * 表格渲染。**每一行都设 `cantSplit`**：
 *   表头行——自身不被拆开，靠 `tableHeader` 在跨页时自动重复；
 *   数据行——「一条记录不跨页拆开」，本页放不下时整行移到下一页。
 * 导出以便渲染层测试直接断言行属性（不只测模型）。
 */
export function renderReportTable(block: ReportTable): Table {
  const widths = block.columnWidthsMm;
  const headerRow = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: block.headers.map((header, index) =>
      renderCell(header, widths[index], {
        bold: true,
        center: true,
        shaded: true,
      }),
    ),
  });
  const bodyRows = block.rows.map(
    (row) =>
      new TableRow({
        cantSplit: true,
        children: row.map((cell, index) =>
          renderCell(cell, widths[index], { center: index === 0 }),
        ),
      }),
  );
  return new Table({
    rows: [headerRow, ...bodyRows],
    columnWidths: widths.map((width) => convertMillimetersToTwip(width)),
    width: {
      size: widths.reduce(
        (sum, width) => sum + convertMillimetersToTwip(width),
        0,
      ),
      type: WidthType.DXA,
    },
    layout: TableLayoutType.FIXED,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
      left: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
      right: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
    },
  });
}

/**
 * 一个「补充」块 → 若干段落。导出以便渲染层测试直接断言段落的
 * `keepNext`（「对应证据」不得被单独挤到下一页），不依赖人工目视。
 */
export function renderReportSupplement(block: ReportSupplement): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const header =
    block.caseNo === null
      ? `补充 ${block.index}（表 1 序号 ${block.index}）`
      : `补充 ${block.index}（表 1 序号 ${block.index}，案号：${block.caseNo}）`;
  paragraphs.push(
    renderParagraph(
      paragraph([{ text: header }], {
        sizeHalfPt: SIZE_TABLE,
        bold: true,
        spacingBeforePt: 6,
        spacingAfterPt: 0,
        keepNext: true,
      }),
    ),
  );

  if (block.fields.length > 0) {
    const spans: ReportTextSpan[] = [];
    block.fields.forEach((field, position) => {
      spans.push({ text: `${field.label}：`, bold: true });
      spans.push({ text: field.value });
      spans.push({
        text: position === block.fields.length - 1 ? "。" : "；",
      });
    });
    paragraphs.push(
      renderParagraph(
        paragraph(spans, {
          sizeHalfPt: SIZE_TABLE,
          indentChars: 2,
          spacingAfterPt: 0,
          // 本块没有义务全文时，本段就是「对应证据」的上一段 → 与之同页
          // （只在需要时写入，避免 docx 把 false 写成冗余的 w:val="false"）
          keepNext: block.obligation === null ? true : undefined,
        }),
      ),
    );
  }

  if (block.obligation !== null) {
    paragraphs.push(
      renderParagraph(
        paragraph(
          [
            { text: `${OBLIGATION_LABEL}：`, bold: true },
            { text: block.obligation },
          ],
          {
            sizeHalfPt: SIZE_TABLE,
            indentChars: 2,
            spacingAfterPt: 0,
            // 与下一段「对应证据：xxx.pdf」同页：证据行不被单独挤到下一页
            keepNext: true,
          },
        ),
      ),
    );
  }

  paragraphs.push(
    renderParagraph(
      paragraph(
        [{ text: "对应证据：", bold: true }, { text: block.evidenceFile }],
        { sizeHalfPt: SIZE_TABLE, indentChars: 2, spacingAfterPt: 0 },
      ),
    ),
  );

  return paragraphs;
}

function renderBlocks(blocks: ReportBlock[]): (Paragraph | Table)[] {
  const children: (Paragraph | Table)[] = [];
  for (const block of blocks) {
    if (block.kind === "paragraph") children.push(renderParagraph(block));
    else if (block.kind === "table") children.push(renderReportTable(block));
    else children.push(...renderReportSupplement(block));
  }
  return children;
}

/**
 * 单节的页面属性。
 * 注意横向节传进去的是**竖版逻辑尺寸**，交换由 docx 完成 —— 见 SECTION_PAGE_MM 的注释。
 */
export function buildSectionProperties(orientation: SectionOrientation) {
  const page = SECTION_PAGE_MM[orientation];
  const toTwip = (value: number) => convertMillimetersToTwip(value);
  return {
    type: SectionType.NEXT_PAGE,
    page: {
      size: {
        width: toTwip(page.width),
        height: toTwip(page.height),
        orientation:
          orientation === "landscape"
            ? PageOrientation.LANDSCAPE
            : PageOrientation.PORTRAIT,
      },
      margin: {
        top: toTwip(page.margin.top),
        bottom: toTwip(page.margin.bottom),
        left: toTwip(page.margin.left),
        right: toTwip(page.margin.right),
      },
    },
  };
}

/**
 * 每节的页面尺寸与页边距（mm）。
 *
 * ⚠️ `width`/`height` 是 **docx 的竖版逻辑值**，不是成品的实际宽高：
 * docx 在 `orientation === LANDSCAPE` 时会**自行交换** width/height 再写 `w:pgSz`
 * （实测：传 (210, 297) + LANDSCAPE → 写出 `w=16837twip(297mm) h=11905twip(210mm) orient="landscape"`）。
 * 所以横向节必须传 (210, 297)：若照直觉传 (297, 210)，会得到一个
 * 「竖版纸张尺寸 + landscape 标记」的坏页面（w=210mm h=297mm orient=landscape）。
 */
export const SECTION_PAGE_MM = {
  portrait: {
    width: 210,
    height: 297,
    margin: { top: 25.4, bottom: 25.4, left: 31.7, right: 31.7 },
  },
  landscape: {
    width: 210,
    height: 297,
    margin: { top: 25.4, bottom: 25.4, left: 18, right: 18 },
  },
} as const;

/** 逐个对照 docx 写出值用（测试里断言，防止升级 docx 后行为变化）。 */
export const A4_TWIP = {
  shortEdge: convertMillimetersToTwip(210),
  longEdge: convertMillimetersToTwip(297),
} as const;

export type SectionOrientation = keyof typeof SECTION_PAGE_MM;

/** 内容模型 → docx Document。只管版式，不做任何事实加工。 */
export function renderReportDocx(model: ReportModel): Document {
  return new Document({
    creator: "nonlit-workbench",
    title: model.title,
    description: model.notice,
    sections: [
      {
        properties: buildSectionProperties("portrait"),
        children: renderBlocks(model.preamble),
      },
      {
        properties: buildSectionProperties("landscape"),
        children: renderBlocks(model.landscape),
      },
      {
        properties: buildSectionProperties("portrait"),
        children: renderBlocks(model.appendix),
      },
    ],
  });
}
