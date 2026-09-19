/**
 * AI 分析草稿（Slice 1 / 1.1 / 1.2）：提示词构造、输出结构校验与输出护栏的纯函数测试。
 *
 * 只测**边界**：AI 能看到什么事实、看不到什么；模型输出不合规时是否 fail closed。
 * 不发起网络请求、不读 PDF、不连 DB、不读磁盘。
 * provider 调用本身（DeepSeek 请求形状 / 错误映射 / 超时）见 `zxgk-analysis-client.test.ts`。
 *
 * regression test（把已发生的真实 bug 固化成自动测试）按 Slice 归档：
 *   1.1「5. 输入最小化」「7. 输出护栏」；1.2「6. 确定性聚合」「7. 输出护栏」。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { DetailRow } from "../scripts/zxgk-execution-parse.ts";
import { CaptureOperationError } from "../src/lib/capture-workflow.ts";
import {
  ANALYSIS_DRAFT_LABEL,
  ANALYSIS_GUARDRAIL_MESSAGE,
  ANALYSIS_RESPONSE_INVALID_MESSAGE,
  ANALYSIS_SESSION_ONLY_NOTE,
  ANALYSIS_SECTION_KEYS,
  ANALYSIS_SECTION_TITLES,
  type AnalysisDraft,
} from "../src/lib/analysis-names.ts";
import {
  ANALYSIS_FACTS_MARKER,
  ANALYSIS_SUMMARY_MARKER,
  ANALYSIS_SYSTEM_PROMPT,
  assertAnalysisDraftInScope,
  buildAnalysisPrompt,
  buildAnalysisSummary,
  findAnalysisGuardrailViolation,
  parseAnalysisResponse,
  type AnalysisSummary,
} from "../src/lib/server/ai-analysis.ts";

const ROWS: DetailRow[] = [
  {
    index: 1,
    captureNo: 1,
    publicTypes: "被执行人",
    remarks: "",
    evidenceFile:
      "恒大集团有限公司_执行_中国执行信息公开网_Q01_001_20260917.pdf",
    fields: {
      案号: "（2026）粤03执1234号",
      "被执行人姓名/名称": "恒大集团有限公司",
      执行法院: "深圳市南山区人民法院",
      执行标的: "1000000",
      性别: "—",
      生效法律文书确定的义务: null,
    },
  },
  {
    index: 2,
    captureNo: 2,
    publicTypes: "失信被执行人",
    remarks: "同案号另有记录",
    evidenceFile:
      "恒大集团有限公司_执行_中国执行信息公开网_Q01_002_20260917.pdf",
    fields: { 案号: "（2026）粤03执1234号", 执行法院: "深圳市南山区人民法院" },
  },
];

/**
 * 事实包：**不含 projectName**（Slice 1.1 输入最小化，类型层面已删除该字段）。
 * `PROJECT_NAME` 只是这份 fixture 外部世界的「报告标题」，用来断言它**没有**被泄漏给模型。
 */
const PROJECT_NAME = "北京术锐机器人有限公司";

const FACTS = {
  checkDate: "2026-09-17",
  siteName: "中国执行信息公开网",
  rows: ROWS,
};

/** 取出 user 消息里「结构化事实 JSON」那一段并解析（消息里除事实外不应有业务输入）。 */
function factsPayload(user: string): Record<string, unknown>[] {
  const marker = user.indexOf(ANALYSIS_FACTS_MARKER);
  assert.ok(marker >= 0, "user 消息必须带事实清单标记");
  return JSON.parse(
    user.slice(marker + ANALYSIS_FACTS_MARKER.length).trim(),
  ) as Record<string, unknown>[];
}

/** 取出 user 消息里「系统已计算统计」那一段并解析。 */
function summaryPayload(user: string): Record<string, unknown> {
  const start = user.indexOf(ANALYSIS_SUMMARY_MARKER);
  const end = user.indexOf(ANALYSIS_FACTS_MARKER);
  assert.ok(start >= 0, "user 消息必须带系统统计标记");
  assert.ok(end > start, "系统统计必须排在事实清单之前（模型先读权威数字）");
  return JSON.parse(
    user.slice(start + ANALYSIS_SUMMARY_MARKER.length, end).trim(),
  ) as Record<string, unknown>;
}

// ── 6. 确定性聚合（Slice 1.2 regression）───────────────────────────────────
//
// 第二次真实 E2E 的 bug：报告事实为 失信+终本 13 / 仅失信 9 / 仅被执行人 6 / 合计 28，
// 模型却输出「涉及失信 22，其中终本 16，仅失信 6」——典型的 LLM aggregation error。
// 根因是让模型自己数；修法是代码先算好、模型只引用（提示词第 9 条）。

/**
 * 复刻真实样本的 publicTypes 分布：13 / 9 / 6，合计 28。
 * 另给第 1 条与第 14 条同一案号，以便同时覆盖「同案号重复组数」。
 */
function sampleRows(): DetailRow[] {
  const row = (
    index: number,
    publicTypes: string,
    caseNo: string,
  ): DetailRow => ({
    index,
    captureNo: index,
    publicTypes,
    remarks: "",
    evidenceFile: `某公司_执行_中国执行信息公开网_Q01_${String(index).padStart(3, "0")}_20260917.pdf`,
    fields: { 案号: caseNo },
  });
  const rows: DetailRow[] = [];
  for (let i = 1; i <= 28; i++) {
    const publicTypes =
      i <= 13
        ? "失信被执行人、终本案件"
        : i <= 22
          ? "失信被执行人"
          : "被执行人";
    // 第 1 条与第 14 条同案号 → 1 组重复；其余各自独立案号。
    const caseNo =
      i === 1 || i === 14
        ? "（2026）粤03执重复号"
        : `（2026）粤03执${String(1000 + i)}号`;
    rows.push(row(i, publicTypes, caseNo));
  }
  return rows;
}

const SAMPLE_ROWS = sampleRows();

test("regression 1.2：13 / 9 / 6 / 28 由代码精确计算，不经过 LLM", () => {
  const summary = buildAnalysisSummary(SAMPLE_ROWS);
  assert.equal(summary.recordCount, 28);
  assert.equal(summary.lostAndTerminatedCount, 13);
  assert.equal(summary.lostOnlyCount, 9);
  assert.equal(summary.executedOnlyCount, 6);
  // 三个类别相加必须等于总数（分类互斥且完备）
  assert.equal(
    summary.lostAndTerminatedCount +
      summary.lostOnlyCount +
      summary.executedOnlyCount,
    summary.recordCount,
  );
  // 与报告正文同一口径的逐组合计数（报告「按公示页面所载公示类型统计如下」）
  assert.deepEqual(summary.publicTypeGroups, [
    { publicTypes: "失信被执行人、终本案件", count: 13 },
    { publicTypes: "失信被执行人", count: 9 },
    { publicTypes: "被执行人", count: 6 },
  ]);
  // 同案号重复组数
  assert.equal(summary.duplicateCaseGroupCount, 1);
});

test("regression 1.2：分类按成员判定，不受板块书写顺序影响，且不漏不重", () => {
  // 板块顺序换一种写法仍是「失信 + 终本」；「终本案件、被执行人」不含失信 → 仅被执行人。
  const summary = buildAnalysisSummary([
    { ...SAMPLE_ROWS[0], publicTypes: "终本案件、失信被执行人" },
    { ...SAMPLE_ROWS[0], index: 2, publicTypes: "终本案件、被执行人" },
    { ...SAMPLE_ROWS[0], index: 3, publicTypes: "限制消费人员" },
  ]);
  assert.equal(summary.lostAndTerminatedCount, 1);
  assert.equal(summary.executedOnlyCount, 1);
  assert.equal(summary.recordCount, 3);
  // 不认识的组合既不进三个语义类别，也不会被算成别的类别（无兜底字段）
  assert.equal(
    summary.lostAndTerminatedCount +
      summary.lostOnlyCount +
      summary.executedOnlyCount,
    2,
  );
});

test("regression 1.2：summary 是 rows 的纯函数（同输入同输出，空集也安全）", () => {
  assert.deepEqual(
    buildAnalysisSummary(SAMPLE_ROWS),
    buildAnalysisSummary(SAMPLE_ROWS),
  );
  const empty: AnalysisSummary = buildAnalysisSummary([]);
  assert.deepEqual(empty, {
    recordCount: 0,
    lostAndTerminatedCount: 0,
    lostOnlyCount: 0,
    executedOnlyCount: 0,
    duplicateCaseGroupCount: 0,
    publicTypeGroups: [],
  });
});

test("regression 1.2：prompt 单独携带「系统已计算统计」，数字与 rows 同源", () => {
  const { user } = buildAnalysisPrompt({
    checkDate: "2026-09-17",
    siteName: "中国执行信息公开网",
    rows: SAMPLE_ROWS,
  });
  const summary = summaryPayload(user);
  assert.equal(summary.记录总数, 28);
  assert.equal(summary.失信与终本同时公示, 13);
  assert.equal(summary.仅失信被执行人, 9);
  assert.equal(summary.仅被执行人, 6);
  assert.equal(summary.同案号重复组数, 1);
  assert.deepEqual(summary.按公示类型组合计数, [
    { 公示类型: "失信被执行人、终本案件", 记录数: 13 },
    { 公示类型: "失信被执行人", 记录数: 9 },
    { 公示类型: "被执行人", 记录数: 6 },
  ]);
  // 统计必须排在事实清单之前，且事实清单仍是完整的 28 条
  assert.ok(
    user.indexOf(ANALYSIS_SUMMARY_MARKER) < user.indexOf(ANALYSIS_FACTS_MARKER),
  );
  assert.equal(factsPayload(user).length, 28);
});

test("regression 1.2：统计随明细变化，不写死任何数字", () => {
  const one = buildAnalysisPrompt({ ...FACTS, rows: [ROWS[0]] });
  assert.equal(summaryPayload(one.user).记录总数, 1);
  const none = buildAnalysisPrompt({ ...FACTS, rows: [] });
  assert.equal(summaryPayload(none.user).记录总数, 0);
});

test("regression 1.2：提示词要求照抄系统统计、并禁止清单外记录与空字段成因建议", () => {
  for (const phrase of [
    "系统已计算统计",
    "引用「系统已计算统计」中给出的数值，逐字照抄",
    "不得自行统计、重新清点",
    "一律以**系统统计**为准",
    "就是全部记录",
    "未展开记录",
    "未列示记录",
    "遗漏记录",
    "公示类型不含「终本案件」的记录",
    "「终本日期」「未履行金额」本就不公示、为空",
    "「执行标的」本就不公示、为空",
    "这类空白不构成任何疑点或待核事项",
  ])
    assert.ok(ANALYSIS_SYSTEM_PROMPT.includes(phrase), `缺少约束：${phrase}`);
});

const VALID = JSON.stringify({
  overview: "本次核查共纳入 2 条记录。",
  keyRisks: "未发现需特别提示的事项",
  keyRecords: "1、（2026）粤03执1234号",
  followUps: "现有核查信息不足以判断",
});

// ── 1. 四段口径 ──────────────────────────────────────────────────────────

test("固定四段：字段名顺序与中文标题即产品口径", () => {
  assert.deepEqual(
    [...ANALYSIS_SECTION_KEYS],
    ["overview", "keyRisks", "keyRecords", "followUps"],
  );
  // Slice 1.1：第二段标题是「重点关注事项」，不再是「重点风险事项」——
  // 本段只做事实性提示，不下风险判断。字段名 keyRisks 保持不变。
  assert.deepEqual(
    ANALYSIS_SECTION_KEYS.map((key) => ANALYSIS_SECTION_TITLES[key]),
    ["核查结果概览", "重点关注事项", "重点记录", "建议进一步核实事项"],
  );
  for (const title of Object.values(ANALYSIS_SECTION_TITLES))
    assert.ok(
      ANALYSIS_SYSTEM_PROMPT.includes(title),
      `提示词必须覆盖固定标题：${title}`,
    );
  assert.ok(
    !ANALYSIS_SYSTEM_PROMPT.includes("重点风险事项"),
    "提示词不得再出现旧标题「重点风险事项」",
  );
});

test("提示词里写死的 JSON 字段名与 ANALYSIS_SECTION_KEYS 一致", () => {
  for (const key of ANALYSIS_SECTION_KEYS)
    assert.ok(
      ANALYSIS_SYSTEM_PROMPT.includes(`"${key}"`),
      `提示词必须写出字段名：${key}`,
    );
});

test("草稿标识明示非正式法律意见，且声明 Slice 1 不落库", () => {
  assert.ok(ANALYSIS_DRAFT_LABEL.includes("草稿"));
  assert.ok(ANALYSIS_DRAFT_LABEL.includes("非正式法律意见"));
  assert.ok(ANALYSIS_SESSION_ONLY_NOTE.includes("关闭弹窗"));
});

// ── 2. 输入边界：只允许结构化事实 ─────────────────────────────────────────

test("提示词只携带结构化事实，字段白名单之外一个都没有", () => {
  const payload = factsPayload(buildAnalysisPrompt(FACTS).user);
  assert.equal(payload.length, 2);
  const allowed = new Set(["序号", "公示类型", "备注", "证据文件", "字段"]);
  for (const record of payload)
    for (const key of Object.keys(record))
      assert.ok(allowed.has(key), `事实包出现白名单外字段：${key}`);
  // 原始 PDF 版面文本（站点标签后带全角冒号）不得进入提示词
  assert.doesNotMatch(buildAnalysisPrompt(FACTS).user, /被执行人姓名\/名称：/);
  // unpdf 的 TextRun 形状（{h, w, str}）不得随事实泄漏进提示词
  assert.doesNotMatch(buildAnalysisPrompt(FACTS).user, /"(h|w|str)":/);
});

test("null 字段被省略；空值不写成 —、0 或 无", () => {
  const payload = factsPayload(buildAnalysisPrompt(FACTS).user);
  const fields = payload[0].字段 as Record<string, string>;
  assert.ok(!("生效法律文书确定的义务" in fields), "null 字段必须省略");
  assert.equal(fields.案号, "（2026）粤03执1234号");
  // 网站明确公示的 — 是真实事实值，必须原样带走、不得改写
  assert.equal(fields.性别, "—");
  for (const value of Object.values(fields)) assert.notEqual(value, "");
});

test("空备注被省略，非空备注原样进入", () => {
  const payload = factsPayload(buildAnalysisPrompt(FACTS).user);
  assert.ok(!("备注" in payload[0]));
  assert.equal(payload[1].备注, "同案号另有记录");
});

test("提示词只带核查日 / 核查网站 / 系统统计这类必要事实", () => {
  const { user } = buildAnalysisPrompt(FACTS);
  assert.ok(user.includes("2026-09-17"));
  assert.ok(user.includes("中国执行信息公开网"));
  assert.ok(user.includes(ANALYSIS_SUMMARY_MARKER));
  assert.equal(summaryPayload(user).记录总数, 2);
});

// ── A. 输入最小化（Slice 1.1 regression）──────────────────────────────────
//
// 首次真实 E2E 的 bug：模型输出了
// 「项目名称北京术锐机器人尽调与检索对象恒大集团有限公司需要确认关联性」。
// 根因是 user 消息里带了 `【项目名称（…与检索对象不要求一致）】` —— 模型被提示词
// 明确告知存在「项目名 vs 检索对象」这一对照，于是把它写成了待核事项。
// 修法：把项目名从输入里彻底拿掉（`AnalysisFacts` 已无该字段）。

test("regression A：提示词不含项目名称，模型无从做 project/query 关系判断", () => {
  const { user, system } = buildAnalysisPrompt(FACTS);
  // 项目名本身不得出现在任何一段提示词里
  assert.ok(!user.includes(PROJECT_NAME), "user 消息不得包含项目名称");
  assert.ok(!system.includes(PROJECT_NAME), "system 提示词不得包含项目名称");
  assert.ok(!user.includes("北京术锐"), "不得出现项目名片段");
  // 连「项目名称」这个字段标签也不再出现在 user 事实包里
  assert.ok(!user.includes("项目名称"), "user 消息不得出现「项目名称」字段行");
  // 旧版那句显式比较提示必须消失
  assert.ok(
    !user.includes("与检索对象不要求一致"),
    "不得再给模型任何「项目名 vs 检索对象」的比较信息",
  );
  assert.doesNotMatch(user, /项目名称/);
});

test("regression A：事实包的顶层字段只有核查日 / 核查网站 / 系统统计 + 事实清单", () => {
  const { user } = buildAnalysisPrompt(FACTS);
  // 头部只允许这两行「【…】值」；统计与事实各自跟在标记之后。
  const head = user.slice(0, user.indexOf(ANALYSIS_SUMMARY_MARKER));
  assert.deepEqual(
    head
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(0, line.indexOf("】") + 1)),
    ["【核查日】", "【核查网站】"],
  );
});

test("regression B：提示词显式禁止项目名关系判断与日期逻辑判断", () => {
  for (const phrase of [
    "不是**本次分析的对象",
    "不得评价、推断、比较或提示二者是否一致",
    "输入里**没有**项目名称",
    "日期只能作为原始事实**原样引用**",
    "不得自行计算日期差",
    "晚于核查日",
    "接近核查日",
    "时间异常",
    "必须由程序预先计算",
  ])
    assert.ok(ANALYSIS_SYSTEM_PROMPT.includes(phrase), `缺少约束：${phrase}`);
});

test("regression B：提示词不再把「不一致」写成合法情形，避免反向提示", () => {
  // 旧文案「不一致是合法情形」本身就在提示模型去比较二者；必须已删除。
  assert.ok(!ANALYSIS_SYSTEM_PROMPT.includes("合法情形"));
});

test("记录总数用实际行数，不写死任何条数", () => {
  // 条数只由数据决定：换一份事实包，统计里的记录总数与事实条数同步变化。
  const one = buildAnalysisPrompt({ ...FACTS, rows: [ROWS[0]] });
  assert.equal(summaryPayload(one.user).记录总数, 1);
  assert.equal(factsPayload(one.user).length, 1);
  const three = buildAnalysisPrompt({ ...FACTS, rows: [...ROWS, ROWS[0]] });
  assert.equal(summaryPayload(three.user).记录总数, 3);
  assert.equal(factsPayload(three.user).length, 3);
});

test("硬约束固定写在系统提示词里", () => {
  for (const phrase of [
    "禁止虚构",
    "不得新增或推断金额、法院、日期、案号",
    "不得推断主体的偿债能力、信用状况",
    "现有核查信息不足以判断",
    "不是正式法律意见",
    "不要使用 Markdown 代码块",
  ])
    assert.ok(ANALYSIS_SYSTEM_PROMPT.includes(phrase), `缺少约束：${phrase}`);
});

test("提示词构造是确定性的：同一事实两次构造完全一致", () => {
  assert.deepEqual(buildAnalysisPrompt(FACTS), buildAnalysisPrompt(FACTS));
});

// ── 3. 输出结构校验：一切不合规都 fail closed ────────────────────────────

test("合法输出被规整为四段草稿（去首尾空白）", () => {
  const draft = parseAnalysisResponse(`  ${VALID}  `);
  assert.deepEqual(Object.keys(draft), [
    "overview",
    "keyRisks",
    "keyRecords",
    "followUps",
  ]);
  assert.equal(draft.overview, "本次核查共纳入 2 条记录。");
});

test("额外字段不进入草稿", () => {
  const draft = parseAnalysisResponse(
    JSON.stringify({ ...JSON.parse(VALID), citations: [], tables: [] }),
  );
  assert.deepEqual(Object.keys(draft), [
    "overview",
    "keyRisks",
    "keyRecords",
    "followUps",
  ]);
});

test("非法 JSON / 缺字段 / 类型错误 / 空值一律 fail closed，不返回半成品", () => {
  const cases: [string, unknown][] = [
    ["非字符串", 42],
    ["空字符串", ""],
    ["纯空白", "   "],
    ["非 JSON 文本", "分析结果如下：本次核查共纳入 2 条记录。"],
    ["Markdown 代码块包裹", `\`\`\`json\n${VALID}\n\`\`\``],
    ["数组", "[]"],
    ["null", "null"],
    ["字符串常量", '"ok"'],
    [
      "缺一段",
      JSON.stringify({ overview: "a", keyRisks: "b", keyRecords: "c" }),
    ],
    [
      "字段类型错误",
      JSON.stringify({
        overview: 1,
        keyRisks: "b",
        keyRecords: "c",
        followUps: "d",
      }),
    ],
    [
      "字段为空串",
      JSON.stringify({
        overview: "",
        keyRisks: "b",
        keyRecords: "c",
        followUps: "d",
      }),
    ],
  ];
  for (const [label, raw] of cases)
    assert.throws(
      () => parseAnalysisResponse(raw),
      (error: unknown) =>
        error instanceof CaptureOperationError &&
        error.status === 502 &&
        error.message === ANALYSIS_RESPONSE_INVALID_MESSAGE,
      `应拒绝：${label}`,
    );
});

// ── 5. 输出护栏（Slice 1.1 regression）─────────────────────────────────────
//
// 护栏 = 模型输出后的程序化机械检查。第一版只覆盖两条禁令的**明显**形态，
// 命中即整次 fail closed（不展示半成品、不自动 retry）。

/** 用给定 section 文案构造一份结构合法的四段草稿（其余段落保持安全内容）。 */
function draftWith(
  key: (typeof ANALYSIS_SECTION_KEYS)[number],
  value: string,
): AnalysisDraft {
  const draft = parseAnalysisResponse(VALID);
  return { ...draft, [key]: value };
}

/** 断言护栏拒绝：状态 502，且文案是**护栏**文案而非结构校验文案。 */
function assertRejected(label: string, draft: AnalysisDraft) {
  assert.throws(
    () => assertAnalysisDraftInScope(draft),
    (error: unknown) =>
      error instanceof CaptureOperationError &&
      error.status === 502 &&
      error.message === ANALYSIS_GUARDRAIL_MESSAGE,
    `护栏应拒绝：${label}`,
  );
}

/** 断言护栏放行：返回的仍是一份完整四段草稿。 */
function assertAllowed(label: string, draft: AnalysisDraft) {
  const passed = assertAnalysisDraftInScope(draft);
  assert.deepEqual(
    Object.keys(passed),
    ["overview", "keyRisks", "keyRecords", "followUps"],
    `护栏应放行：${label}`,
  );
}

test("regression D：project / query 关系判断（原句）→ 拒绝", () => {
  // 首次真实 E2E 的原句，一字不改地钉进测试。
  assertRejected(
    "首次 E2E 原句",
    draftWith(
      "keyRisks",
      "项目名称北京术锐机器人尽调与检索对象恒大集团有限公司需要确认关联性。",
    ),
  );
  assertRejected(
    "项目名称与查询对象关联性需确认",
    draftWith("keyRisks", "项目名称与查询对象关联性需确认。"),
  );
  assertRejected(
    "待核事项里谈二者关系",
    draftWith("followUps", "建议人工核对项目名称与检索对象是否一致。"),
  );
  assertRejected(
    "主体名称差异写成异常",
    draftWith("followUps", "项目名与被执行人名称存在差异，需确认。"),
  );
  // 护栏只做机械检查，但四段都要过：任何一段越界都整次作废。
  assertRejected(
    "越界出现在概览段",
    draftWith("overview", "项目名称与检索对象不一致，属数据质量问题。"),
  );
});

test("regression D：日期逻辑判断 → 拒绝", () => {
  for (const text of [
    "该公司立案时间为 2025-12-02，晚于核查日。",
    "立案时间早于核查日。",
    "立案时间为 2026-01-16，接近核查日。",
    "该记录时间异常。",
    "本次核查日期为 2026-09-17，相关记录均在其之前。",
  ])
    assertRejected(text, draftWith("keyRisks", text));
});

test("regression：正常描述与原样引用日期 → 放行", () => {
  assertAllowed(
    "日期原样引用",
    draftWith("keyRecords", "1、（2026）粤03执1234号，立案时间为 2026-01-16。"),
  );
  assertAllowed(
    "核查日原样引用",
    draftWith("overview", "本次核查日为 2026-09-17，共纳入 2 条记录。"),
  );
});

test("regression：大额执行 / 失信 / 终本 / 同案号等正常总结 → 放行", () => {
  assertAllowed(
    "四类正常总结",
    draftWith(
      "keyRisks",
      "共 2 条记录：1 条被执行人、1 条失信被执行人，其中 1 条标注同案号另有记录，执行标的 1000000 元；另有终本案件记录 1 条。",
    ),
  );
  assertAllowed(
    "安全兜底文案",
    draftWith("keyRisks", "未发现需特别提示的事项"),
  );
  assertAllowed(
    "信息不足声明",
    draftWith("followUps", "现有核查信息不足以判断，建议人工补充材料。"),
  );
});

test("regression 1.2：正常引用「系统已计算统计」的数字 → 放行", () => {
  assertAllowed(
    "照抄系统统计",
    draftWith(
      "overview",
      "本次核查共 28 条记录：其中 13 条同时公示失信与终本、9 条仅公示失信、6 条仅公示被执行人。",
    ),
  );
  assertAllowed(
    "照抄公示类型组合计数",
    draftWith(
      "keyRisks",
      "按公示类型组合，13 条记录同时涉及失信与终本案件，另有 9 条仅涉失信。",
    ),
  );
  // 单纯陈述字段为空是合法的事实引用，不是无效建议
  assertAllowed(
    "陈述字段为空",
    draftWith(
      "overview",
      "公示类型不含终本案件的记录，其终本日期、未履行金额栏为空。",
    ),
  );
});

test("regression 1.2：把「字段为空」当疑点、建议核实成因 → 拒绝", () => {
  for (const text of [
    "建议确认终本日期、未履行金额为空是否因公示类型不同。",
    "建议核实执行标的为空的原因。",
    "建议人工核对执行标的为空是否为数据缺失。",
    "部分字段为空，原因不明，建议进一步查明。",
  ])
    assertRejected(text, draftWith("followUps", text));
});

test("regression 1.2：假设存在清单外记录 → 拒绝", () => {
  assertRejected(
    "还有未展开记录需要补充核查",
    draftWith("followUps", "还有未展开记录需要补充核查。"),
  );
  assertRejected(
    "存在其他记录未纳入",
    draftWith("followUps", "存在其他记录未纳入本次核查范围。"),
  );
  assertRejected(
    "遗漏记录",
    draftWith("keyRisks", "本次公示可能存在遗漏记录，建议补充核查。"),
  );
  // 越界出现在任何一段都整次作废
  assertRejected(
    "未列示记录出现在概览段",
    draftWith("overview", "除上述记录外，尚有未列示的记录。"),
  );
});

test("护栏：解析器写进备注的「同案号另有记录」是合法事实字样，不得误杀", () => {
  assertAllowed(
    "同案号另有记录（备注原文）",
    draftWith(
      "keyRisks",
      "其中 1 条标注同案号另有记录，2 条记录共用同一案号。",
    ),
  );
});

test("护栏是纯机械检查：合法 JSON 结构 + 越界内容照样拒绝", () => {
  const draft = draftWith("keyRisks", "项目名称与查询对象关联性需确认。");
  // 结构完全合法（四段非空字符串）——结构校验不会拦它
  assert.deepEqual(Object.keys(draft), [
    "overview",
    "keyRisks",
    "keyRecords",
    "followUps",
  ]);
  assertRejected("结构合法但内容越界", draft);
});

test("护栏诊断接口：规则名只供服务端使用，不进对外文案", () => {
  assert.equal(
    findAnalysisGuardrailViolation("项目名称与查询对象关联性需确认。"),
    "project-name-relation",
  );
  assert.equal(
    findAnalysisGuardrailViolation("立案时间晚于核查日。"),
    "date-logic",
  );
  assert.equal(
    findAnalysisGuardrailViolation("还有未展开记录需要补充核查。"),
    "phantom-records",
  );
  assert.equal(
    findAnalysisGuardrailViolation("建议确认执行标的为空的原因。"),
    "empty-field-recheck",
  );
  assert.equal(findAnalysisGuardrailViolation("立案时间为 2026-01-16。"), null);
  assert.equal(findAnalysisGuardrailViolation("执行标的为空。"), null);
  assert.equal(findAnalysisGuardrailViolation(""), null);
  for (const rule of [
    "project-name-relation",
    "date-logic",
    "phantom-records",
    "empty-field-recheck",
  ])
    assert.ok(
      !ANALYSIS_GUARDRAIL_MESSAGE.includes(rule),
      "对外文案不得暴露内部规则名",
    );
  assert.ok(!ANALYSIS_GUARDRAIL_MESSAGE.includes("项目名称"));
  assert.ok(!ANALYSIS_GUARDRAIL_MESSAGE.includes("核查日"));
});

test("护栏的边界：护栏不解析数字，数量正确性由 summary + 提示词保证", () => {
  // Slice 1.2 的明确取舍：从自由文本可靠抽取「N 条终本」并与 summary 比对，必须区分
  // 金额 / 日期 / 案号中的数字，机械规则误杀率高 —— 因此**不**在这里做数字解析，
  // 数量一致性改由两道可靠层面保证：① 确定性 summary（代码算定）；② 提示词第 9 条（照抄不重算）。
  // 本测试只固定「代偿机制确实存在」，不阻止将来加更可靠的数字校验。
  assert.ok(
    ANALYSIS_SYSTEM_PROMPT.includes("不得自行统计、重新清点"),
    "数字约束必须写在提示词里（护栏不做数字解析的代偿）",
  );
  assert.ok(ANALYSIS_SYSTEM_PROMPT.includes("一律以**系统统计**为准"));
});

test("护栏文案明确：告知整次放弃且未展示片段", () => {
  assert.ok(ANALYSIS_GUARDRAIL_MESSAGE.includes("整次放弃"));
  assert.ok(ANALYSIS_GUARDRAIL_MESSAGE.includes("未展示任何片段"));
  // 护栏命中与结构非法是两种不同的失败，文案必须区分，不能混用
  assert.notEqual(
    ANALYSIS_GUARDRAIL_MESSAGE,
    ANALYSIS_RESPONSE_INVALID_MESSAGE,
  );
});

// ── C. 标题口径：UI 与服务端同源显示「重点关注事项」──────────────────────

test("regression C：UI 中文标题显示「重点关注事项」，字段名仍是 keyRisks", () => {
  assert.equal(ANALYSIS_SECTION_TITLES.keyRisks, "重点关注事项");
  assert.ok(
    ANALYSIS_SECTION_KEYS.includes("keyRisks"),
    "字段名不得因中文标题变化而改名（避免无意义 API churn）",
  );
  // UI 的标签必须来自同一个口径常量，不得自己硬编码标题
  return readFile(
    new URL("../src/components/project-report-dialog.tsx", import.meta.url),
    "utf8",
  ).then((dialog) => {
    assert.match(dialog, /ANALYSIS_SECTION_TITLES\[key\]/);
    assert.doesNotMatch(dialog, /重点风险事项/);
    assert.doesNotMatch(dialog, /重点关注事项/);
  });
});

// ── 4. 调用面：鉴权、无客户端输入、无密钥泄漏 ──────────────────────────────

test("analysis API 走用户 JWT + RLS，且不接受客户端提交的事实或提示词", async () => {
  const [route, client] = await Promise.all([
    readFile(
      new URL(
        "../src/app/api/projects/[projectId]/analysis/route.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../src/lib/server/ai-client.ts", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(route, /export const runtime = "nodejs"/);
  assert.match(route, /captureContext\(request\)/);
  assert.match(route, /apiError\(error\)/);
  assert.match(route, /parseProjectReport\(/);
  assert.match(route, /parseAnalysisResponse\(/);
  // Slice 1.1：输出护栏必须真的接在 route 上（不是只写在库里）
  assert.match(route, /assertAnalysisDraftInScope\(/);
  // 输入最小化：route 不得把项目名传进 prompt
  assert.doesNotMatch(route, /projectName:\s*facts\.projectName/);
  assert.doesNotMatch(route, /buildAnalysisPrompt\(\{[\s\S]*?projectName/);
  assert.doesNotMatch(route, /request\.json\(\)|request\.text\(\)/);
  assert.doesNotMatch(`${route}\n${client}`, /service[_-]?role/i);
  assert.doesNotMatch(`${route}\n${client}`, /getPublicUrl|createSignedUrl/);
  // API key 只能来自服务端环境变量：公开前缀会把密钥打进浏览器 bundle
  assert.doesNotMatch(`${route}\n${client}`, /NEXT_PUBLIC_AI/);
  assert.doesNotMatch(`${route}\n${client}`, /process\.env\.NEXT_PUBLIC_/);
});

test("早失败：配置检查在鉴权之后、读取任何事实之前（缺 key 不会下载 PDF / 调用 parser）", async () => {
  const route = await readFile(
    new URL(
      "../src/app/api/projects/[projectId]/analysis/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const at = (needle: string) => {
    const index = route.indexOf(needle);
    assert.ok(index >= 0, `route 必须包含：${needle}`);
    return index;
  };
  const auth = at("captureContext(request)");
  // 只认「语句形态」的那一句：注释里提到 `requireAnalysisConfig()` 不算数。
  const guard = route.search(/^\s*requireAnalysisConfig\(\);\s*$/m);
  assert.ok(guard >= 0, "route 必须有一句直接的 requireAnalysisConfig(); 调用");
  // 顺序即语义：先鉴权（401 优先）→ 配置守卫（503）→ 读留痕 → 解析 → 调 provider。
  assert.ok(auth < guard, "配置检查必须在鉴权之后，保持既有错误语义不变");
  for (const [label, offset] of [
    ["读取项目数据", at("loadProjectReportData(")],
    ["解析事实", at("parseProjectReport(")],
    ["调用 provider", at("requestAnalysisCompletion(")],
  ] as const)
    assert.ok(
      guard < offset,
      `配置检查必须先于${label}，否则会先下载 PDF 再报 503`,
    );
  // 守卫必须是那一句直接调用：不包在条件里、不做惰性回退。
  assert.match(route, /^\s*requireAnalysisConfig\(\);\s*$/m);
});
