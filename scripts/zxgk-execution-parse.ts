/**
 * ZXGK（中国执行信息公开网）留痕 PDF → 统一结构化明细 的确定性解析。
 *
 * 本文件是**纯函数**：不做任何 I/O，输入是「每页的文字段数组（含坐标）」，
 * 输出是结构化记录。读取 PDF / 写 Excel 的职责在 build-execution-table.ts。
 *
 * 口径（人工 LOCK）：一份 detail PDF = 一行；不按公示板块拆行、不合并同案号、
 * 不修改网站原始字段值。列表页不是案件明细，不进入主表。
 *
 * 解析依据（全部由真实留痕实测得出，不是猜测）：
 * 1. 版面来自 DOM 的 `<td align="right"><strong>标签：</strong></td><td align="left">值</td>`，
 *    打印后 label 列右边界恒为 185.6pt、value 列左边界恒为 194.6pt
 *    → 用 x 坐标切列，不用冒号/正则切分。
 * 2. 文字段数组顺序 ≠ 阅读顺序（板块标题常排在其正文行之后）
 *    → 必须先按 y 降序排，再分段。
 * 3. 板块可跨页（终本案件表头在 p1、终本日期/执行标的/未履行金额落到 p2）
 *    → 分段状态跨页延续。
 * 4. 站点用 `—` 渲染空值（`refRow()`），所以 `—` = 未公示，不是字段缺失；
 *    真正「本站块没有该字段」必须是 null（Excel 真空单元格），不能写成 `""`/`—`/`无`。
 * 5. 同一份 detail 可同时含多个板块且标签同名（案号/执行法院…）
 *    → 逐字段按 SECTION_PRIORITY 跨板块取值，不先挑「主板块」。
 * 6. 长文本值会折行：折行续行**无标签**、起始 x 恒为 194.6、与上一行间距恒为 15.00pt
 *    （字段行间距 24pt、页面顶部家具到 banner 45pt）→ 用「同页 + 间距 ≤ 20pt」归并。
 *    实测本批 116 条续行全部满足，且**没有任何续行跨页**。
 */

export const SECTION_TITLES = [
  "被执行人",
  "失信被执行人",
  "终本案件",
  "限制消费人员",
] as const;

export type SectionTitle = (typeof SECTION_TITLES)[number];

/**
 * 逐字段跨板块取值的优先级：执行类板块优先（本表的主题是执行案件），
 * 失信板块作为补充。实测只有 010/016 的「执行法院」两个板块写法不同。
 */
const SECTION_PRIORITY: readonly SectionTitle[] = [
  "终本案件",
  "被执行人",
  "失信被执行人",
  "限制消费人员",
];

// ── 字段清单（全部取自站点标签原文，不做改写）──────────────────────────
/** 三个板块都有的通用字段。 */
export const COMMON_FIELD_LABELS = [
  "案号",
  "被执行人姓名/名称",
  "性别",
  "身份证号码/组织机构代码",
  "执行法院",
  "立案时间",
] as const;

/** 失信板块没有这个字段。 */
export const EXECUTION_AMOUNT_LABEL = "执行标的";

/** 仅终本案件板块有。 */
export const TERMINATION_FIELD_LABELS = ["终本日期", "未履行金额"] as const;

/** 仅失信被执行人板块有（长文本单列，见 OBLIGATION_LABEL）。 */
export const SHIXIN_FIELD_LABELS = [
  "省份",
  "执行依据文号",
  "做出执行依据单位",
  "发布时间",
  "被执行人的履行情况",
  "失信被执行人行为具体情形",
] as const;

/** 失信板块的长文本字段，独占主表最后一列，不截断、不拆表。 */
export const OBLIGATION_LABEL = "生效法律文书确定的义务";

/** 一个文字段。x/y 为 PDF 用户空间坐标，h 为字高（≈字号）。 */
export type TextRun = {
  str: string;
  x: number;
  y: number;
  h: number;
};

/** 一份留痕 PDF：文件名（用于回填证据列与取编号）+ 每页的文字段。 */
export type CaptureInput = {
  fileName: string;
  pages: TextRun[][];
};

export type SectionRow = { label: string; value: string };
export type Section = { title: SectionTitle; rows: SectionRow[] };
export type CaptureKind = "list" | "detail" | "unknown";

/**
 * 一条主表记录。`fields` 的键是**站点标签原文**，值是站点公示的原文；
 * 没有该字段时为 **null**（不是 `""`，`""` 会被 ExcelJS 写成共享字符串下标）。
 */
export type DetailRow = {
  index: number;
  captureNo: number;
  /** 该 detail 实际公示的板块，按 DOM 渲染顺序用「、」连接。 */
  publicTypes: string;
  remarks: string;
  evidenceFile: string;
  fields: Record<string, string | null>;
};

export type ExcludedRow = {
  index: number;
  captureNo: number;
  reason: string;
  evidenceFile: string;
};

export type ParseResult = {
  rows: DetailRow[];
  excluded: ExcludedRow[];
  /** 解析过程中发现的异常/降级情形；正常批次应为空。 */
  problems: string[];
};

export type MainColumnKey =
  "index" | "publicTypes" | "remarks" | "evidenceFile" | "field";

/** 主表列定义（唯一事实来源）：表头、取值方式、列宽、是否换行。 */
export type MainColumn = {
  header: string;
  key: MainColumnKey;
  width: number;
  wrap?: boolean;
};

const fieldColumn = (
  header: string,
  width: number,
  wrap = false,
): MainColumn => ({ header, key: "field", width, wrap });

/**
 * 主表列（按输出顺序）。元信息在前，长文本独占最后一列。
 * 字段列的表头 = 站点标签原文，`key: "field"` 表示从 `row.fields[header]` 取值。
 */
export const MAIN_TABLE_COLUMNS: readonly MainColumn[] = [
  { header: "序号", key: "index", width: 6 },
  { header: "公示类型", key: "publicTypes", width: 22 },
  { header: "备注", key: "remarks", width: 34 },
  { header: "对应证据PDF文件名", key: "evidenceFile", width: 52 },
  ...COMMON_FIELD_LABELS.map((label) =>
    fieldColumn(label, label === "案号" ? 26 : 20),
  ),
  fieldColumn(EXECUTION_AMOUNT_LABEL, 16),
  ...TERMINATION_FIELD_LABELS.map((label) =>
    fieldColumn(label, label === "终本日期" ? 14 : 16),
  ),
  ...SHIXIN_FIELD_LABELS.map((label) => {
    if (label === "省份") return fieldColumn(label, 10);
    if (label === "发布时间") return fieldColumn(label, 14);
    if (label === "被执行人的履行情况") return fieldColumn(label, 16);
    if (label === "失信被执行人行为具体情形") return fieldColumn(label, 30);
    return fieldColumn(label, 26);
  }),
  fieldColumn(OBLIGATION_LABEL, 60, true),
];

/** 已知字段集合，用于发现「站点新增了未建模字段」这种静默丢失。 */
const KNOWN_FIELD_LABELS = new Set<string>([
  ...COMMON_FIELD_LABELS,
  EXECUTION_AMOUNT_LABEL,
  ...TERMINATION_FIELD_LABELS,
  ...SHIXIN_FIELD_LABELS,
  OBLIGATION_LABEL,
]);

/** 每个板块「本应公示」的字段：缺了才算异常。 */
const SECTION_OWNED_LABELS: Partial<Record<SectionTitle, readonly string[]>> = {
  被执行人: [...COMMON_FIELD_LABELS, EXECUTION_AMOUNT_LABEL],
  终本案件: [
    ...COMMON_FIELD_LABELS,
    EXECUTION_AMOUNT_LABEL,
    ...TERMINATION_FIELD_LABELS,
  ],
  失信被执行人: [
    ...COMMON_FIELD_LABELS,
    ...SHIXIN_FIELD_LABELS,
    OBLIGATION_LABEL,
  ],
};

// ── 版面常量（实测不变量）────────────────────────────────────────────
/** 标签列右边界 185.6 / 值列左边界 194.6 → 取中间值切列。 */
const VALUE_COLUMN_X = 190;
/** 正文行字号 10.5。 */
const BODY_FONT_MIN = 10.4;
const BODY_FONT_MAX = 11;
/** 板块 banner 字号 13.5。 */
const TITLE_FONT_MIN = 13;
const TITLE_FONT_MAX = 14;
/** 行距 24pt → 2pt 容差足以聚成同一行。 */
const ROW_Y_TOLERANCE = 2;
/**
 * 折行续行与上一行的最大间距：实测续行恒为 15.00pt，
 * 而字段行间距为 24pt、页面顶部家具到 banner 为 45pt → 20pt 是安全分界。
 */
const CONTINUATION_MAX_GAP = 20;
/** 站点渲染空值的符号。 */
export const NOT_PUBLISHED = "—";

/**
 * 页面家具白名单：这些字符串与正文同字号、且可能落在值列里，
 * 但它们是按钮/链接文案，不是字段值（`关闭` 有时与最后一行同 y）。
 * 注意 `—` 不在白名单里——它是站点对空值的真实渲染结果。
 */
const FURNITURE_TEXTS = new Set(["关闭", "返回", "首页", "打印", "查看"]);

const REMARK_DUPLICATE_CASE_NO = "同案号另有记录";
const REMARK_FILING_DATE_MISSING = "立案时间未公示";

type Line =
  | { kind: "banner"; title: SectionTitle; y: number; page: number }
  | { kind: "field"; label: string; value: string; y: number; page: number }
  /** 无标签、内容全落在值列 → 折行续行（也可能是页面顶部家具，由间距区分）。 */
  | { kind: "orphan"; value: string; y: number; page: number };

function isBodyFont(h: number): boolean {
  return h >= BODY_FONT_MIN && h <= BODY_FONT_MAX;
}

function isTitleFont(h: number): boolean {
  return h >= TITLE_FONT_MIN && h <= TITLE_FONT_MAX;
}

/** 去掉 PDF 逐字定位插入的排版空格，还原站点原始值。 */
export function normalizeValue(raw: string): string {
  return raw.replace(/\s+/g, "");
}

function isSectionTitle(text: string): text is SectionTitle {
  return (SECTION_TITLES as readonly string[]).includes(text);
}

/** 从 `…_Q01_002_20260917.pdf` 取 capture_no。 */
export function captureNoFromFileName(fileName: string): number | null {
  const base = fileName.replace(/\\/g, "/").split("/").pop() ?? "";
  const matched = /_Q\d+_(\d{3,})_\d{8}\.pdf$/i.exec(base);
  return matched ? Number(matched[1]) : null;
}

/**
 * list 还是 detail。最干净的判据是页脚 URL 的 pathname；
 * 页脚缺失时退化用 detail 独有的 `关闭` 按钮。
 */
export function classifyCapture(pages: TextRun[][]): CaptureKind {
  const all = pages.flat();
  if (all.some((run) => run.str.includes("zhzxgk/detail.html")))
    return "detail";
  if (all.some((run) => run.str.includes("zhzxgk/index.html"))) return "list";
  if (all.some((run) => run.str.trim() === "关闭")) return "detail";
  return "unknown";
}

/**
 * 把「每页文字段」摊平成按阅读顺序排列的行。
 * 只有落在标签列/值列的正文行、板块 banner、以及值列里的无标签行会被产出，
 * 页眉页脚家具被忽略。行上带 y/page，供后续归并折行续行使用。
 */
export function readLines(pages: TextRun[][]): Line[] {
  const lines: Line[] = [];

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pageIndex + 1;
    const runs = pages[pageIndex].filter(
      (run) =>
        run.str.trim().length > 0 && (isBodyFont(run.h) || isTitleFont(run.h)),
    );
    const sorted = [...runs].sort((a, b) => b.y - a.y);

    const clusters: TextRun[][] = [];
    for (const run of sorted) {
      const last = clusters[clusters.length - 1];
      if (last && Math.abs(last[0].y - run.y) <= ROW_Y_TOLERANCE)
        last.push(run);
      else clusters.push([run]);
    }

    for (const cluster of clusters) {
      const banner = cluster.find(
        (run) => isTitleFont(run.h) && isSectionTitle(run.str.trim()),
      );
      if (banner) {
        lines.push({
          kind: "banner",
          title: banner.str.trim() as SectionTitle,
          y: cluster[0].y,
          page,
        });
        continue;
      }

      const valueRuns = cluster
        .filter(
          (run) =>
            isBodyFont(run.h) &&
            run.x >= VALUE_COLUMN_X &&
            !FURNITURE_TEXTS.has(run.str.trim()),
        )
        .sort((a, b) => a.x - b.x);
      const value = normalizeValue(valueRuns.map((run) => run.str).join(""));

      const label = cluster.find(
        (run) =>
          isBodyFont(run.h) &&
          run.x < VALUE_COLUMN_X &&
          /[：:]$/.test(run.str.trim()),
      );
      if (label) {
        lines.push({
          kind: "field",
          label: label.str.trim().replace(/[：:]$/, ""),
          value,
          y: cluster[0].y,
          page,
        });
        continue;
      }

      // 无标签但内容全在值列：要么是长文本的折行续行，要么是页面顶部家具。
      if (valueRuns.length > 0) {
        lines.push({ kind: "orphan", value, y: cluster[0].y, page });
      }
    }
  }

  return lines;
}

/** 折叠成板块；板块状态跨页延续；无标签的值列行按间距归并到上一条字段。 */
export function readSections(pages: TextRun[][]): {
  sections: Section[];
  problems: string[];
} {
  const sections: Section[] = [];
  const problems: string[] = [];
  let current: Section | null = null;
  let previous: Line | null = null;

  for (const line of readLines(pages)) {
    if (line.kind === "banner") {
      current = { title: line.title, rows: [] };
      sections.push(current);
      previous = line;
      continue;
    }

    if (line.kind === "orphan") {
      const previousRow = current?.rows[current.rows.length - 1];
      const samePage = previous !== null && previous.page === line.page;
      const gap = previous === null ? Infinity : previous.y - line.y;
      if (previousRow && samePage && gap <= CONTINUATION_MAX_GAP) {
        // 折行续行：直接拼接，不加分隔符（站点原文本身就是被 CSS 折行截断的连续文本）。
        previousRow.value += line.value;
        previous = line;
        continue;
      }
      if (previousRow) {
        // 板块内出现了跟不上的无标签值列行：宁可报错，不要静默丢掉内容。
        problems.push(
          `字段值续行无法归属（已丢弃）：${line.value.slice(0, 30)}`,
        );
      }
      continue;
    }

    if (!current) {
      problems.push(`字段行不在任何板块内：${line.label}`);
      previous = line;
      continue;
    }
    if (current.rows.some((row) => row.label === line.label)) {
      problems.push(`板块「${current.title}」内标签重复：${line.label}`);
      previous = line;
      continue;
    }
    current.rows.push({ label: line.label, value: line.value });
    previous = line;
  }

  return { sections, problems };
}

/** 按 SECTION_PRIORITY 逐字段跨板块取值；没有该字段 → null（不是空串）。 */
function pickField(sections: Section[], label: string): string | null {
  for (const title of SECTION_PRIORITY) {
    const section = sections.find((item) => item.title === title);
    if (!section) continue;
    const value = section.rows.find((row) => row.label === label)?.value ?? "";
    if (value !== "") return value;
  }
  return null;
}

/** 混合 detail 里同一字段被不同板块写出不同文字 → 客观记录，不做对错判断。 */
function sectionDifferences(sections: Section[], label: string): string[] {
  const occurrences = sections
    .map((section) => ({
      title: section.title,
      value: section.rows.find((row) => row.label === label)?.value ?? "",
    }))
    .filter((item) => item.value !== "" && item.value !== NOT_PUBLISHED);
  if (occurrences.length < 2) return [];
  const distinct = new Set(occurrences.map((item) => item.value));
  if (distinct.size < 2) return [];
  const primary = pickField(sections, label);
  return occurrences
    .filter((item) => item.value !== primary)
    .map((item) => `${item.title}板块公示${label}为：${item.value}`);
}

/**
 * 主入口：一批留痕 → 主表行 + 未纳入清单。
 * 传入顺序即 Capture 顺序；行只按传入顺序编号，不重排。
 */
export function parseExecutionTable(captures: CaptureInput[]): ParseResult {
  const rows: DetailRow[] = [];
  const excluded: ExcludedRow[] = [];
  const problems: string[] = [];

  const picked: {
    captureNo: number;
    fileName: string;
    sections: Section[];
  }[] = [];

  for (const capture of captures) {
    const captureNo = captureNoFromFileName(capture.fileName);
    if (captureNo === null) {
      problems.push(`文件名无法解析 capture_no：${capture.fileName}`);
    }

    const kind = classifyCapture(capture.pages);
    if (kind === "list") {
      excluded.push({
        index: 0,
        captureNo: captureNo ?? 0,
        reason: "列表页（非单条执行记录）",
        evidenceFile: capture.fileName,
      });
      continue;
    }
    if (kind === "unknown") {
      excluded.push({
        index: 0,
        captureNo: captureNo ?? 0,
        reason: "无法判定页面类型（缺 detail 页脚标识）",
        evidenceFile: capture.fileName,
      });
      problems.push(`无法判定页面类型：${capture.fileName}`);
      continue;
    }

    const read = readSections(capture.pages);
    for (const problem of read.problems) {
      problems.push(`${capture.fileName}：${problem}`);
    }

    if (read.sections.length === 0) {
      excluded.push({
        index: 0,
        captureNo: captureNo ?? 0,
        reason: "详情页未发现任何公示板块",
        evidenceFile: capture.fileName,
      });
      problems.push(`详情页未发现任何公示板块：${capture.fileName}`);
      continue;
    }

    // 站点新增了未建模字段 → 报告出来，避免静默丢内容。
    for (const section of read.sections) {
      for (const row of section.rows) {
        if (!KNOWN_FIELD_LABELS.has(row.label)) {
          problems.push(
            `${capture.fileName}：板块「${section.title}」出现未建模字段「${row.label}」`,
          );
        }
      }
    }

    picked.push({
      captureNo: captureNo ?? 0,
      fileName: capture.fileName,
      sections: read.sections,
    });
  }

  // 同案号分组只用于加备注，不合并行。
  const caseNoCount = new Map<string, number>();
  const caseNos = picked.map((item) => pickField(item.sections, "案号") ?? "");
  for (const caseNo of caseNos) {
    if (!caseNo) continue;
    caseNoCount.set(caseNo, (caseNoCount.get(caseNo) ?? 0) + 1);
  }

  picked.forEach((item, position) => {
    const fields: Record<string, string | null> = {};
    for (const label of KNOWN_FIELD_LABELS) {
      fields[label] = pickField(item.sections, label);
    }

    // 「本板块本应有这个字段却空着」才算异常；板块没有的字段留空是预期结果。
    for (const section of item.sections) {
      for (const label of SECTION_OWNED_LABELS[section.title] ?? []) {
        if (fields[label] === null) {
          problems.push(
            `${item.fileName}：板块「${section.title}」字段「${label}」为空`,
          );
        }
      }
    }

    const caseNo = fields["案号"] ?? "";
    const filingDate = fields["立案时间"];

    const remarks: string[] = [];
    if ((caseNoCount.get(caseNo) ?? 0) > 1) {
      remarks.push(REMARK_DUPLICATE_CASE_NO);
    }
    if (filingDate === null || filingDate === NOT_PUBLISHED) {
      remarks.push(REMARK_FILING_DATE_MISSING);
    }
    const sharedLabels = [
      ...new Set(item.sections.flatMap((s) => s.rows.map((row) => row.label))),
    ];
    for (const label of sharedLabels) {
      remarks.push(...sectionDifferences(item.sections, label));
    }

    rows.push({
      index: position + 1,
      captureNo: item.captureNo,
      publicTypes: item.sections.map((section) => section.title).join("、"),
      remarks: remarks.join("；"),
      evidenceFile: item.fileName,
      fields,
    });
  });

  excluded.forEach((item, position) => {
    item.index = position + 1;
  });

  const seen = new Set<number>();
  for (const item of [...rows, ...excluded]) {
    if (item.captureNo && seen.has(item.captureNo)) {
      problems.push(`capture_no 重复：${item.captureNo}`);
    }
    seen.add(item.captureNo);
  }

  return { rows, excluded, problems };
}
