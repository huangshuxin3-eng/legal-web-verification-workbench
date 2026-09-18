/**
 * Word 尽调报告 V1 的模型层测试。
 *
 * 全部使用**合成的 ParseResult**：不读 PDF、不读磁盘、不生成 docx。
 * 断言的是「事实 → 报告内容」这一层的规则，与真实留痕的版式无关。
 *
 * 覆盖重点（对齐本阶段人工确认的口径）：
 *   1. 11 列主表、列序、表头为站点标签原文
 *   2. 空值语义：`null` → 真空白；`—` → 原样透传；不得写成 ""/0/无
 *   3. 核查结果统计动态分组（不硬编码组合名与数字）
 *   4. 28 个「补充」块与表 1 序号一一对应；证据 PDF 文件名必须进 Word
 *   5. 义务全文不截断
 *   6. 三节归属：纵向 → 横向 → 纵向，表题与表格同节
 *   7. 模板文字：只陈述数据已确定的事实，不含 AI/风险/评分
 *   8. 纯排版规则：长标题折行不产生残行、主表金额不被断行、证据行不被孤立到下一页
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  DetailRow,
  ParseResult,
} from "../scripts/zxgk-execution-parse.ts";
import {
  A4_TWIP,
  DRAFT_MARK_LINE,
  DRAFT_NOTICE,
  LANDSCAPE_TEXT_WIDTH_MM,
  PORTRAIT_TEXT_WIDTH_MM,
  REPORT_TABLE_COLUMNS,
  REPORT_TABLE_WIDTH_MM,
  TITLE_SIZE_HALF_PT,
  TITLE_TAIL,
  buildReportModel,
  buildSectionProperties,
  buildTitleLines,
  countDuplicateCaseNo,
  countMaskedRows,
  groupByPublicTypes,
  renderReportSupplement,
  renderReportTable,
  textWidthMm,
  type ReportModel,
  type ReportSupplement,
  type ReportTable,
} from "../scripts/zxgk-report-docx.ts";

const IDENTITY_LABEL = "身份证号码/组织机构代码";

function evidenceFile(index: number): string {
  return `某某集团有限公司_执行_中国执行信息公开网_Q01_${String(index).padStart(3, "0")}_20260917.pdf`;
}

function row(index: number, overrides: Partial<DetailRow> = {}): DetailRow {
  return {
    index,
    captureNo: index,
    publicTypes: "失信被执行人",
    remarks: "",
    evidenceFile: evidenceFile(index),
    fields: {},
    ...overrides,
  };
}

function result(rows: DetailRow[]): ParseResult {
  return { rows, excluded: [], problems: [] };
}

const META = {
  targetName: "某某集团有限公司",
  checkDate: "2026年9月17日",
};

function blocksOf(model: ReportModel) {
  return [...model.preamble, ...model.landscape, ...model.appendix];
}

/** 模型里的全部可见文字，用于模板文字断言。 */
function allText(model: ReportModel): string {
  const parts: string[] = [model.title, model.notice];
  for (const block of blocksOf(model)) {
    if (block.kind === "paragraph") {
      parts.push(block.spans.map((span) => span.text).join(""));
    } else if (block.kind === "table") {
      parts.push(...block.headers);
      parts.push(
        ...block.rows.flat().filter((cell): cell is string => cell !== null),
      );
    } else {
      parts.push(`补充 ${block.index}`);
      if (block.caseNo !== null) parts.push(block.caseNo);
      for (const field of block.fields) parts.push(field.label, field.value);
      if (block.obligation !== null) parts.push(block.obligation);
      parts.push(block.evidenceFile);
    }
  }
  return parts.join("\n");
}

function paragraphs(model: ReportModel): string[] {
  return blocksOf(model)
    .filter((block) => block.kind === "paragraph")
    .map((block) =>
      block.kind === "paragraph"
        ? block.spans.map((span) => span.text).join("")
        : "",
    );
}

function tableOf(model: ReportModel) {
  const table = model.landscape.find((block) => block.kind === "table");
  assert.ok(table && table.kind === "table", "第 2 节应含表格");
  return table;
}

function supplementsOf(model: ReportModel): ReportSupplement[] {
  return model.appendix.filter(
    (block): block is ReportSupplement => block.kind === "supplement",
  );
}

// ── 1. 主表列 ─────────────────────────────────────────────────────────────

test("主表 11 列，表头与顺序固定，且均为站点标签原文", () => {
  const model = buildReportModel(result([row(1)]), META);
  const table = tableOf(model);
  assert.deepEqual(table.headers, [
    "序号",
    "案号",
    "被执行人姓名/名称",
    "身份证号码/组织机构代码",
    "执行法院",
    "立案时间",
    "执行标的",
    "终本日期",
    "未履行金额",
    "公示类型",
    "备注",
  ]);
  assert.equal(table.headers.length, 11);
  // 表头不得被加上单位等改写
  assert.ok(!table.headers.some((header) => header.includes("（元）")));
});

test("主表行数 = ParseResult 行数，每行列数与表头一致，序号列连续", () => {
  const rows = [row(1), row(2), row(3)];
  const model = buildReportModel(result(rows), META);
  const table = tableOf(model);
  assert.equal(table.rows.length, 3);
  for (const cells of table.rows) assert.equal(cells.length, 11);
  assert.deepEqual(
    table.rows.map((cells) => cells[0]),
    ["1", "2", "3"],
  );
});

test("主表宽度不超横向 A4 可用宽度，列宽与列数一致", () => {
  assert.equal(
    REPORT_TABLE_COLUMNS.reduce((sum, column) => sum + column.widthMm, 0),
    REPORT_TABLE_WIDTH_MM,
  );
  assert.ok(
    REPORT_TABLE_WIDTH_MM <= LANDSCAPE_TEXT_WIDTH_MM,
    `表宽 ${REPORT_TABLE_WIDTH_MM}mm 必须 ≤ 可用宽 ${LANDSCAPE_TEXT_WIDTH_MM}mm`,
  );
});

test("证据 PDF 文件名不进主表，只在补充块里", () => {
  const model = buildReportModel(result([row(1)]), META);
  const table = tableOf(model);
  assert.ok(!table.headers.some((header) => header.includes("证据")));
  const flat = table.rows
    .flat()
    .filter((cell): cell is string => cell !== null);
  assert.ok(!flat.some((cell) => cell.endsWith(".pdf")));
  assert.equal(supplementsOf(model)[0].evidenceFile, evidenceFile(1));
});

// ── 2. 空值语义 ───────────────────────────────────────────────────────────

test("当前公示类型不存在的字段 → 真空白（null），不是空串、不是 —、不是 0 或 无", () => {
  const model = buildReportModel(
    result([
      row(1, {
        publicTypes: "被执行人",
        fields: {
          案号: "（2026）湘0602执6856号",
          执行标的: "37985642",
          // 终本日期 / 未履行金额：该公示类型根本不存在这两个字段 → 必须为 null
          终本日期: null,
          未履行金额: null,
        },
      }),
    ]),
    META,
  );
  const table = tableOf(model);
  const cells = table.rows[0];
  const at = (header: string) => cells[table.headers.indexOf(header)];
  assert.equal(at("终本日期"), null);
  assert.equal(at("未履行金额"), null);
  assert.notEqual(at("终本日期"), "");
  assert.notEqual(at("终本日期"), "—");
  assert.notEqual(at("终本日期"), "0");
  assert.notEqual(at("终本日期"), "无");
  assert.notEqual(at("终本日期"), "/");
  // 有值的字段照常输出
  assert.equal(at("执行标的"), "37985642");
});

test("网站明确公示 — → 原样透传，不得被清空或改写", () => {
  const model = buildReportModel(
    result([
      row(1, {
        publicTypes: "被执行人",
        fields: {
          案号: "（2026）湘0602执6856号",
          立案时间: "—",
          终本日期: "—",
          未履行金额: "—",
        },
      }),
    ]),
    META,
  );
  const table = tableOf(model);
  const cells = table.rows[0];
  const at = (header: string) => cells[table.headers.indexOf(header)];
  assert.equal(at("立案时间"), "—");
  assert.equal(at("终本日期"), "—");
  assert.equal(at("未履行金额"), "—");
  // 补充块里的失信字段同样透传 —
  const supplement = supplementsOf(model)[0];
  const model2 = buildReportModel(
    result([
      row(1, {
        fields: { 省份: "—", 发布时间: "—", 生效法律文书确定的义务: "—" },
      }),
    ]),
    META,
  );
  const supplement2 = supplementsOf(model2)[0];
  assert.deepEqual(
    supplement2.fields.map((field) => field.value),
    ["—", "—"],
  );
  assert.equal(supplement2.obligation, "—");
  assert.equal(supplement.fields.length, 0);
});

test("公共字段为空串时折成 null，不写成共享字符串式的空值", () => {
  const model = buildReportModel(
    result([row(1, { publicTypes: "", remarks: "", fields: { 案号: "" } })]),
    META,
  );
  const cells = tableOf(model).rows[0];
  const at = (header: string) => cells[tableOf(model).headers.indexOf(header)];
  assert.equal(at("案号"), null);
  assert.equal(at("公示类型"), null);
  assert.equal(at("备注"), null);
});

// ── 3. 核查结果统计动态生成 ───────────────────────────────────────────────

test("核查结果按实际 publicTypes 组合分组，样本口径得 13/9/6 且合计 28", () => {
  const rows: DetailRow[] = [];
  for (let i = 1; i <= 13; i++) {
    rows.push(row(i, { publicTypes: "失信被执行人、终本案件" }));
  }
  for (let i = 14; i <= 22; i++) {
    rows.push(row(i, { publicTypes: "失信被执行人" }));
  }
  for (let i = 23; i <= 28; i++) {
    rows.push(row(i, { publicTypes: "被执行人" }));
  }
  const model = buildReportModel(result(rows), META);
  const lines = paragraphs(model);
  assert.ok(
    lines.includes("1. 公示类型为“失信被执行人、终本案件”的记录　13 条；"),
    `缺少第 1 行，实际：\n${lines.join("\n")}`,
  );
  assert.ok(lines.includes("2. 公示类型为“失信被执行人”的记录　9 条；"));
  assert.ok(lines.includes("3. 公示类型为“被执行人”的记录　6 条；"));
  assert.ok(lines.includes("合计　28 条。"));
});

test("统计不硬编码：换个批次，组合与数字随之变化且顺序按条数降序", () => {
  const rows: DetailRow[] = [];
  for (let i = 1; i <= 5; i++) {
    rows.push(row(i, { publicTypes: "失信被执行人、终本案件" }));
  }
  for (let i = 6; i <= 8; i++) rows.push(row(i, { publicTypes: "被执行人" }));
  for (let i = 9; i <= 10; i++) {
    rows.push(row(i, { publicTypes: "限制消费人员" }));
  }
  const model = buildReportModel(result(rows), META);
  const lines = paragraphs(model);
  assert.deepEqual(groupByPublicTypes(rows), [
    { publicTypes: "失信被执行人、终本案件", count: 5 },
    { publicTypes: "被执行人", count: 3 },
    { publicTypes: "限制消费人员", count: 2 },
  ]);
  assert.ok(
    lines.includes("1. 公示类型为“失信被执行人、终本案件”的记录　5 条；"),
  );
  assert.ok(lines.includes("2. 公示类型为“被执行人”的记录　3 条；"));
  assert.ok(lines.includes("3. 公示类型为“限制消费人员”的记录　2 条；"));
  assert.ok(lines.includes("合计　10 条。"));
  // 上一批次的字样不得残留
  assert.ok(!lines.some((line) => line.includes("　13 条")));
});

// ── 4. 补充信息及证据索引 ─────────────────────────────────────────────────

test("补充块数量 = 表 1 行数，编号与表 1 序号一一对应，每块都有证据文件名", () => {
  const rows = [row(1), row(2), row(3)];
  const model = buildReportModel(result(rows), META);
  const supplements = supplementsOf(model);
  assert.equal(supplements.length, tableOf(model).rows.length);
  assert.deepEqual(
    supplements.map((block) => block.index),
    [1, 2, 3],
  );
  assert.deepEqual(
    supplements.map((block) => block.evidenceFile),
    [evidenceFile(1), evidenceFile(2), evidenceFile(3)],
  );
});

test("含失信信息的记录列示失信特有字段；纯被执行人记录只列证据文件名", () => {
  const shixinFields = {
    省份: "广东",
    执行依据文号: "（2022）粤0305民初2266号",
    做出执行依据单位: "深圳市南山区人民法院",
    发布时间: "2023年4月24日",
    被执行人的履行情况: "全部未履行",
    失信被执行人行为具体情形: "有履行能力而拒不履行生效法律文书确定义务",
    生效法律文书确定的义务: "支付工程款",
    // 终本特有字段为 null：不该出现在补充块里
    终本日期: null,
    未履行金额: null,
  };
  const model = buildReportModel(
    result([
      row(1, { fields: shixinFields }),
      row(2, {
        publicTypes: "被执行人",
        fields: { 案号: "（2026）湘0602执6856号" },
      }),
    ]),
    META,
  );
  const [first, second] = supplementsOf(model);
  assert.deepEqual(
    first.fields.map((field) => field.label),
    [
      "省份",
      "执行依据文号",
      "做出执行依据单位",
      "发布时间",
      "被执行人的履行情况",
      "失信被执行人行为具体情形",
    ],
  );
  assert.equal(first.obligation, "支付工程款");
  assert.deepEqual(second.fields, []);
  assert.equal(second.obligation, null);
  // 纯被执行人块仍必须保留证据文件名（否则无法追溯）
  assert.equal(second.evidenceFile, evidenceFile(2));
});

test("生效法律文书确定的义务全文保留，不截断", () => {
  const long = "被" + "执".repeat(567) + "行"; // 569 字
  assert.equal(long.length, 569);
  const model = buildReportModel(
    result([row(1, { fields: { 生效法律文书确定的义务: long } })]),
    META,
  );
  const supplement = supplementsOf(model)[0];
  assert.equal(supplement.obligation, long);
  assert.equal(supplement.obligation?.length, 569);
  assert.ok(!supplement.obligation?.includes("…"));
  assert.ok(!supplement.obligation?.includes("..."));
});

// ── 5. 三节归属与页面方向 ─────────────────────────────────────────────────

test("三节归属：「二、」明细标题与表 1 表题、表格同在第 2 横向节", () => {
  const model = buildReportModel(result([row(1)]), META);
  assert.ok(!model.preamble.some((block) => block.kind === "table"));
  assert.ok(!model.appendix.some((block) => block.kind === "table"));
  // 第 1 节止于核查说明：不得把「二、」留在纵向页底部
  const preambleText = model.preamble
    .filter((block) => block.kind === "paragraph")
    .map((block) =>
      block.kind === "paragraph"
        ? block.spans.map((span) => span.text).join("")
        : "",
    );
  assert.ok(!preambleText.includes("二、执行及失信公开信息明细"));
  assert.ok(
    preambleText.at(-1)?.endsWith("表 1“备注”栏留空者，系不存在需说明的事项。"),
    `第 1 节最后一段应为列示说明末项，实际：${preambleText.at(-1)}`,
  );
  // 第 2 节：二、 →（一）表题 → 表格
  assert.deepEqual(
    model.landscape.map((block) => block.kind),
    ["paragraph", "paragraph", "table"],
  );
  const textOf = (block: ReportModel["landscape"][number]) =>
    block.kind === "paragraph"
      ? block.spans.map((span) => span.text).join("")
      : "";
  assert.equal(textOf(model.landscape[0]), "二、执行及失信公开信息明细");
  assert.equal(
    textOf(model.landscape[1]),
    "（一）表 1　执行及失信公开信息汇总表",
  );
});

test("第 3 节以「三、律师提示」开头，附件标题在其后并另起一页", () => {
  const model = buildReportModel(result([row(1)]), META);
  const labelsOf = (blocks: ReportModel["appendix"]) =>
    blocks
      .filter((block) => block.kind === "paragraph")
      .map((block) =>
        block.kind === "paragraph"
          ? block.spans.map((span) => span.text).join("")
          : "",
      );

  // 节首即律师提示（不再被 28 个补充块推到文末）
  assert.equal(model.appendix[0].kind, "paragraph");
  assert.equal(labelsOf(model.appendix)[0], "三、律师提示");

  const appendixIndex = model.appendix.findIndex(
    (block) =>
      block.kind === "paragraph" &&
      block.spans.map((span) => span.text).join("") ===
        "附：表 1 补充信息及证据索引",
  );
  assert.ok(appendixIndex > 0, "应含「附：表 1 补充信息及证据索引」");
  const appendixHeading = model.appendix[appendixIndex];
  assert.equal(
    appendixHeading.kind === "paragraph"
      ? appendixHeading.pageBreakBefore
      : undefined,
    true,
  );
  // 律师提示全部条目排在附件之前
  const before = model.appendix.slice(0, appendixIndex);
  assert.ok(before.every((block) => block.kind === "paragraph"));
  assert.ok(
    labelsOf(before).some((line) => line.startsWith("1. 本报告所载信息")),
  );
  // 补充块全部排在附件标题之后
  const after = model.appendix.slice(appendixIndex + 1);
  assert.ok(after.every((block) => block.kind === "supplement"));
  assert.equal(after.length, tableOf(model).rows.length);
});

test("横向节传竖版逻辑尺寸 + LANDSCAPE（docx 会交换，交换后正好是 297×210）", () => {
  const landscape = buildSectionProperties("landscape");
  assert.equal(landscape.page.size.width, A4_TWIP.shortEdge);
  assert.equal(landscape.page.size.height, A4_TWIP.longEdge);
  assert.equal(landscape.page.size.orientation, "landscape");
  // 交换后的成品尺寸
  assert.equal(A4_TWIP.longEdge, 16837); // 297mm
  assert.equal(A4_TWIP.shortEdge, 11905); // 210mm
  assert.equal(landscape.page.margin.left, 1020); // 18mm
  assert.equal(landscape.page.margin.top, 1440); // 25.4mm

  const portrait = buildSectionProperties("portrait");
  assert.equal(portrait.page.size.orientation, "portrait");
  assert.equal(portrait.page.margin.left, 1797); // 31.7mm
  assert.equal(portrait.page.margin.top, 1440);
});

// ── 6. 模板文字 ───────────────────────────────────────────────────────────

test("开发验证稿：标题三层化，草稿标记独立成行，正式模式整段删除", () => {
  const draftModel = buildReportModel(result([row(1)]), META);
  // 标题字符串本身不含草稿字样
  assert.equal(
    draftModel.title,
    "《某某集团有限公司执行及失信公开信息核查报告》",
  );
  assert.ok(!draftModel.title.includes("开发验证"));
  assert.ok(!draftModel.title.includes(DRAFT_MARK_LINE));

  // 标题下方依次是「（开发验证草稿）」与「不作为正式核查报告」说明
  const lines = paragraphs(draftModel);
  assert.equal(lines.indexOf(draftModel.title), 0);
  assert.equal(lines[1], DRAFT_MARK_LINE);
  assert.equal(lines[2], DRAFT_NOTICE);

  const titleBlock = draftModel.preamble[0];
  const markBlock = draftModel.preamble[1];
  assert.equal(titleBlock.kind, "paragraph");
  assert.equal(markBlock.kind, "paragraph");
  if (titleBlock.kind === "paragraph" && markBlock.kind === "paragraph") {
    assert.ok(
      (markBlock.sizeHalfPt ?? 0) < (titleBlock.sizeHalfPt ?? 0),
      "草稿标识行字号必须小于主标题",
    );
    assert.equal(markBlock.align, "center");
  }

  // 正式模式：后两行一起删除
  const formal = buildReportModel(result([row(1)]), { ...META, draft: false });
  assert.equal(formal.title, "《某某集团有限公司执行及失信公开信息核查报告》");
  assert.equal(formal.notice, "");
  const formalLines = paragraphs(formal);
  assert.ok(!formalLines.includes(DRAFT_MARK_LINE));
  assert.ok(!formalLines.includes(DRAFT_NOTICE));
  assert.equal(formalLines[0], formal.title);
  assert.equal(formalLines[1], "一、核查说明");
});

test("模板文字只陈述已确定的事实，不出现 AI/风险/评分类表述", () => {
  const model = buildReportModel(result([row(1)]), META);
  const text = allText(model);
  for (const banned of [
    "AI",
    "人工智能",
    "系统认为",
    "智能分析",
    "模型",
    "风险",
    "评分",
    "本所律师认为",
    "应当认定",
    "构成违约",
  ]) {
    assert.ok(!text.includes(banned), `报告不应出现「${banned}」`);
  }
  // 必需的确定事实
  assert.ok(text.includes("中国执行信息公开网"));
  assert.ok(text.includes("http://zxgk.court.gov.cn/"));
  assert.ok(text.includes(META.checkDate));
  assert.ok(
    text.includes(
      "本报告根据中国执行信息公开网公示页面所载内容整理列示，未对公示事实内容作实质性改写。",
    ),
  );
  assert.ok(!text.includes("原文摘录"));
  assert.ok(!text.includes("未作增删或改动"));
  assert.ok(!text.includes("性别"));
});

test("同案号备注与掩码说明按数据出现，未触发时不出现", () => {
  // 无重复案号、无掩码 → 两条说明都不出现
  const plain = buildReportModel(
    result([row(1, { fields: { 案号: "（2026）湘0602执6856号" } })]),
    META,
  );
  const plainText = allText(plain);
  assert.ok(!plainText.includes("同案号另有记录"));
  assert.ok(!plainText.includes("掩码"));

  // 重复案号 + 掩码 → 两条都出现，且数字来自数据
  const dupeRows = [
    row(1, { fields: { 案号: "A", [IDENTITY_LABEL]: "9144030008****371X" } }),
    row(2, { fields: { 案号: "A", [IDENTITY_LABEL]: "9144030008****371X" } }),
    row(3, { fields: { 案号: "B", [IDENTITY_LABEL]: "08790937-1" } }),
  ];
  assert.deepEqual(countDuplicateCaseNo(dupeRows), { groups: 1, records: 2 });
  assert.equal(countMaskedRows(dupeRows), 2);
  const explicit = buildReportModel(result(dupeRows), META);
  const explicitText = allText(explicit);
  assert.ok(explicitText.includes("1 组案号（合计 2 条记录）"));
  assert.ok(explicitText.includes("同案号另有记录"));
  assert.ok(
    explicitText.includes(
      "部分身份信息以掩码形式公示，本报告按公示页面所载内容列示；如需进一步核实主体身份，建议结合其他资料进行核对。",
    ),
  );
  // 模板段落不应逐个列出掩码值（掩码值只应出现在主表与底稿里）
  const explicitParagraphs = paragraphs(explicit).join("\n");
  assert.ok(!explicitParagraphs.includes("9144030008****371X"));
  assert.ok(!explicitParagraphs.includes("08790937-1"));
  // 但主表必须保留原始掩码值
  const identityColumn = tableOf(explicit).headers.indexOf(IDENTITY_LABEL);
  assert.deepEqual(
    tableOf(explicit).rows.map((cells) => cells[identityColumn]),
    ["9144030008****371X", "9144030008****371X", "08790937-1"],
  );
});

test("列示说明含空值语义与 — 规则", () => {
  const model = buildReportModel(result([row(1)]), META);
  const text = allText(model);
  assert.ok(
    text.includes(
      "“终本日期”“未履行金额”栏留空；公示类型不含“被执行人”“终本案件”的记录，“执行标的”栏留空。",
    ),
  );
  assert.ok(text.includes("不得解释为“0”“无”或其他含义。"));
  assert.ok(
    text.includes("公示页面明确载明为“—”的项目，本报告按公示页面原值列示。"),
  );
});

// ── 7. 正文阅读顺序（律师提示不得被 28 个补充块推到文末）─────────────────

test("正文顺序：一、核查说明 → 二、明细 →（一）表 1 → 三、律师提示 → 附：索引", () => {
  const model = buildReportModel(result([row(1), row(2)]), META);
  const expected = [
    "一、核查说明",
    "二、执行及失信公开信息明细",
    "（一）表 1　执行及失信公开信息汇总表",
    "三、律师提示",
    "附：表 1 补充信息及证据索引",
  ];
  const seen: string[] = [];
  for (const block of blocksOf(model)) {
    if (block.kind !== "paragraph") continue;
    const text = block.spans.map((span) => span.text).join("");
    if (expected.includes(text)) seen.push(text);
  }
  assert.deepEqual(seen, expected);
});

// ── 8. 主表行不可跨页拆分（渲染层，非仅模型层）────────────────────────────

type XmlNode = Record<string, unknown>;

/** 渲染后表格的 `<w:tr>` 节点列表（docx 的 prepForXml 需要 context.stack）。 */
function tableRowNodes(table: ReportTable): XmlNode[] {
  const xml = renderReportTable(table).prepForXml({
    stack: [],
  } as never) as unknown as XmlNode;
  return ((xml["w:tbl"] ?? []) as XmlNode[]).filter((node) => "w:tr" in node);
}

/** 某行的 `<w:trPr>` 子节点（cantSplit / tblHeader 都写在这里）。 */
function rowProperties(rowNode: XmlNode): XmlNode[] {
  const tr = rowNode["w:tr"] as XmlNode[];
  return (tr[0]?.["w:trPr"] ?? []) as XmlNode[];
}

function hasProperty(rowNode: XmlNode, name: string): boolean {
  return rowProperties(rowNode).some((prop) => name in prop);
}

test("28 条记录：表头行与全部数据行都带 cantSplit，一条记录不被跨页拆开", () => {
  const rows = Array.from({ length: 28 }, (_, i) => row(i + 1));
  const model = buildReportModel(result(rows), META);
  const nodes = tableRowNodes(tableOf(model));

  assert.equal(nodes.length, 29, "应为 1 个表头行 + 28 个数据行");
  for (const [index, node] of nodes.entries()) {
    assert.ok(
      hasProperty(node, "w:cantSplit"),
      `第 ${index + 1} 行缺少 w:cantSplit（记录可能被跨页拆开）`,
    );
  }
  // 表头行必须保留跨页重复
  assert.ok(hasProperty(nodes[0], "w:tblHeader"), "表头行应保留 w:tblHeader");
  // 数据行不得被当作表头
  assert.ok(
    nodes.slice(1).every((node) => !hasProperty(node, "w:tblHeader")),
    "数据行不应带 w:tblHeader",
  );
});

test("加行属性不改变主表内容：仍为 1 表头 + N 数据行、每行 11 格", () => {
  const rows = Array.from({ length: 28 }, (_, i) => row(i + 1));
  const model = buildReportModel(result(rows), META);
  const table = tableOf(model);
  const nodes = tableRowNodes(table);

  assert.equal(nodes.length, table.rows.length + 1);
  for (const node of nodes) {
    const tr = node["w:tr"] as XmlNode[];
    assert.equal(
      tr.filter((child) => "w:tc" in child).length,
      11,
      "每行应为 11 个单元格",
    );
  }
});

// ── 9. 身份证列宽（末位 X 折行的排版修正）─────────────────────────────────

test("身份证列可用宽大于 18 字符代码的文本宽，末位 X 不会折行", () => {
  const column = REPORT_TABLE_COLUMNS.find(
    (item) => item.header === IDENTITY_LABEL,
  );
  assert.ok(column, "应存在「身份证号码/组织机构代码」列");
  // 单元格左右边距各 1mm
  const usableMm = (column?.widthMm ?? 0) - 2;
  const sample = "9144030008****371X";
  assert.equal(sample.length, 18);
  // 9pt Times New Roman：数字与 * 约 0.5em，大写 X 约 0.722em
  const textMm = (17 * 0.5 + 0.722) * 9 * (25.4 / 72);
  assert.ok(
    textMm < usableMm,
    `可用宽 ${usableMm}mm 必须大于文本宽 ${textMm.toFixed(1)}mm`,
  );
  // 放宽该列后 11 列总宽仍不得超过横向可用宽度
  assert.ok(
    REPORT_TABLE_WIDTH_MM <= LANDSCAPE_TEXT_WIDTH_MM,
    `表宽 ${REPORT_TABLE_WIDTH_MM}mm 必须 ≤ 可用宽 ${LANDSCAPE_TEXT_WIDTH_MM}mm`,
  );
});

// ── 10. 长标题折行（末尾 1~2 字不得单独成行）───────────────────────────────

test("长标题断在「《核查对象」与「核查事项》」之间，不出现末 1~2 字单独成行", () => {
  const longName = "北京术锐机器人有限公司";
  const oneLine = `《${longName}${TITLE_TAIL}》`;
  // 前提：这条标题在纵向可用宽内一行确实放不下（否则本用例无意义）
  assert.ok(
    textWidthMm(oneLine, TITLE_SIZE_HALF_PT) > PORTRAIT_TEXT_WIDTH_MM,
    "用例前提：单行放不下",
  );

  const lines = buildTitleLines(
    longName,
    TITLE_SIZE_HALF_PT,
    PORTRAIT_TEXT_WIDTH_MM,
  );
  assert.deepEqual(lines, [`《${longName}`, `${TITLE_TAIL}》`]);
  // 只选换行位置，不增删字符
  assert.equal(lines.join(""), oneLine);
  for (const line of lines) {
    assert.ok(
      textWidthMm(line, TITLE_SIZE_HALF_PT) <= PORTRAIT_TEXT_WIDTH_MM,
      `标题行「${line}」超出纵向可用宽`,
    );
  }
});

test("短标题保持一行，不因折行逻辑被切开", () => {
  const lines = buildTitleLines(
    "甲公司",
    TITLE_SIZE_HALF_PT,
    PORTRAIT_TEXT_WIDTH_MM,
  );
  assert.deepEqual(lines, [`《甲公司${TITLE_TAIL}》`]);
});

test("核查对象名过长时按宽度均分，末行不留残行", () => {
  const hugeName = "某某".repeat(13); // 26 字：连「《核查对象」一行都放不下
  const oneLine = `《${hugeName}${TITLE_TAIL}》`;
  const lines = buildTitleLines(
    hugeName,
    TITLE_SIZE_HALF_PT,
    PORTRAIT_TEXT_WIDTH_MM,
  );
  assert.ok(lines.length >= 2);
  assert.equal(lines.join(""), oneLine);
  for (const line of lines) {
    assert.ok(
      textWidthMm(line, TITLE_SIZE_HALF_PT) <= PORTRAIT_TEXT_WIDTH_MM,
      `标题行超出纵向可用宽：${line}`,
    );
  }
  // 末行不得只剩一两个字的残行
  const lastWidth = textWidthMm(lines.at(-1)!, TITLE_SIZE_HALF_PT);
  assert.ok(
    lastWidth > PORTRAIT_TEXT_WIDTH_MM * 0.3,
    `末行仅宽 ${lastWidth.toFixed(1)}mm，属残行`,
  );
});

test("标题折行后仍与草稿标识行构成同一个居中标题块", () => {
  const model = buildReportModel(result([row(1)]), {
    ...META,
    targetName: "北京术锐机器人有限公司",
  });
  const lines = model.preamble
    .filter((block) => block.kind === "paragraph")
    .map((block) =>
      block.kind === "paragraph"
        ? block.spans.map((span) => span.text).join("")
        : "",
    );
  assert.equal(lines[0], "《北京术锐机器人有限公司");
  assert.equal(lines[1], `${TITLE_TAIL}》`);
  assert.equal(lines[2], DRAFT_MARK_LINE);
  // 标题行仍居中、同字号；第 1 行与下一行同页
  for (const block of model.preamble.slice(0, 2)) {
    assert.equal(block.kind, "paragraph");
    if (block.kind !== "paragraph") continue;
    assert.equal(block.align, "center");
    assert.equal(block.sizeHalfPt, TITLE_SIZE_HALF_PT);
  }
  assert.equal(
    model.preamble[0].kind === "paragraph"
      ? model.preamble[0].keepNext
      : undefined,
    true,
  );
  // 模型层单行标题字符串保持不变（供 docx 元数据使用）
  assert.equal(
    model.title,
    "《北京术锐机器人有限公司执行及失信公开信息核查报告》",
  );
});

// ── 11. 主表金额不被断行 + 证据行不被孤立到下一页 ──────────────────────────

test("「执行标的」列宽容得下本批最长金额，数字不会被挤成两行", () => {
  const column = REPORT_TABLE_COLUMNS.find(
    (item) => item.header === "执行标的",
  );
  assert.ok(column, "应存在「执行标的」列");
  const usableMm = (column?.widthMm ?? 0) - 2; // 单元格左右边距各 1mm
  const longest = "513602222.00";
  // 9pt Times New Roman：数字约 0.5em，小数点约 0.25em
  const textMm = (11 * 0.5 + 0.25) * 9 * (25.4 / 72);
  assert.ok(
    textMm < usableMm,
    `可用宽 ${usableMm}mm 必须大于金额文本宽 ${textMm.toFixed(1)}mm`,
  );
  // 说明加宽 1mm 的必要性：原 20mm 列（可用 18mm）刚好放不下
  assert.ok(textMm > 18, `若 18mm 已能容纳 ${longest}，则该列无需加宽`);
  // 加宽后总宽仍不得超过横向可用宽度
  assert.ok(
    REPORT_TABLE_WIDTH_MM <= LANDSCAPE_TEXT_WIDTH_MM,
    `表宽 ${REPORT_TABLE_WIDTH_MM}mm 必须 ≤ 可用宽 ${LANDSCAPE_TEXT_WIDTH_MM}mm`,
  );
});

test("主表每个单元格都禁止西文在单词中间折行（金额、代码不被断开）", () => {
  const rows = Array.from({ length: 3 }, (_, i) => row(i + 1));
  const model = buildReportModel(result(rows), META);
  const xml = JSON.stringify(
    renderReportTable(tableOf(model)).prepForXml({ stack: [] } as never),
  );
  const cellCount = (rows.length + 1) * 11; // 1 表头行 + 3 数据行
  assert.equal(
    (xml.match(/"w:wordWrap"/g) ?? []).length,
    cellCount,
    "每个单元格的段落都应带 w:wordWrap",
  );
  // docx 的 wordWrap:true 写出的正是 val=0，即「不允许西文在单词中间换行」
  assert.ok(
    xml.includes('"w:wordWrap":{"_attr":{"w:val":0}}'),
    "wordWrap 必须写成 val=0（禁止西文中间折行）",
  );
});

test("补充块的「对应证据」与上一段同页，不被单独挤到下一页", () => {
  const rows = Array.from({ length: 28 }, (_, i) => row(i + 1));
  // 三种块结构都覆盖：有失信字段 + 义务全文 / 有失信字段无义务 / 只有证据文件名
  rows[0] = row(1, {
    fields: { 省份: "广东", 生效法律文书确定的义务: "支付工程款" },
  });
  rows[1] = row(2, { fields: { 省份: "广东" } });
  rows[2] = row(3, {
    publicTypes: "被执行人",
    fields: { 案号: "（2026）湘0602执6856号" },
  });
  const model = buildReportModel(result(rows), META);
  const supplements = supplementsOf(model);
  assert.equal(supplements.length, 28);

  for (const supplement of supplements) {
    const xml = renderReportSupplement(supplement).map((paragraph) =>
      JSON.stringify(paragraph.prepForXml({ stack: [] } as never)),
    );
    const evidenceAt = xml.findIndex((node) => node.includes("对应证据"));
    assert.ok(
      evidenceAt > 0,
      `补充 ${supplement.index} 的「对应证据」段应存在且不是首段`,
    );
    assert.ok(
      xml[evidenceAt - 1].includes("w:keepNext"),
      `补充 ${supplement.index} 的「对应证据」上一段缺少 keepNext`,
    );
  }
  // 三种结构各自的上一段分别是：义务全文段 / 失信字段段 / 块标题段
  const withObligation = renderReportSupplement(supplements[0]).length;
  assert.equal(withObligation, 4); // 标题 + 字段 + 义务 + 证据
  const fieldsOnly = renderReportSupplement(supplements[1]).length;
  assert.equal(fieldsOnly, 3); // 标题 + 字段 + 证据
  const evidenceOnly = renderReportSupplement(supplements[2]).length;
  assert.equal(evidenceOnly, 2); // 标题 + 证据
});
