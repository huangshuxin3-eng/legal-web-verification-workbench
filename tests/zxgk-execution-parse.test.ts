/**
 * 解析器单元测试：全部使用**合成几何数据**，不依赖真实 PDF，
 * 因此可以在任何机器上稳定跑。合成数据严格按真实留痕的实测坐标构造：
 * 标签列右边界 185.6 / 值列左边界 194.6 / 字段行距 24pt / 折行续行间距 15pt /
 * 页面顶部家具到 banner 45pt / banner 字高 13.5 / 正文 10.5。
 *
 * 覆盖 6 个真实陷阱：跨页板块、同标签双板块、字距插空格、`—` 空值、
 * **长文本折行续行**、**页面顶部家具不是续行**，
 * 外加「文字段顺序 ≠ 阅读顺序」「页面家具不污染字段值」「只有列表页才排除」。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  captureNoFromFileName,
  classifyCapture,
  parseExecutionTable,
  readSections,
  normalizeValue,
  MAIN_TABLE_COLUMNS,
  OBLIGATION_LABEL,
  type CaptureInput,
  type TextRun,
} from "../scripts/zxgk-execution-parse.ts";

// ── 合成几何数据工具 ────────────────────────────────────────────────
const BODY = 10.5;
const TITLE = 13.5;
const ROW_GAP = 24;
/** 折行续行与上一行的实测间距。 */
const WRAP_GAP = 15;

const label = (text: string, y: number): TextRun => ({
  str: `${text}：`,
  x: 60,
  y,
  h: BODY,
});
/** refRow() 渲染在标签列右边缘的行内空格，字高为 0。 */
const padding = (y: number): TextRun => ({ str: " ", x: 185.6, y, h: 0 });
const value = (text: string, y: number): TextRun => ({
  str: text,
  x: 194.6,
  y,
  h: BODY,
});
const banner = (title: string, y: number): TextRun => ({
  str: title,
  x: 57.7,
  y,
  h: TITLE,
});
const footer = (url: string): TextRun => ({ str: url, x: 28.3, y: 16.9, h: 6 });
/** 每页顶部都有的「返回首页」链接：与正文同字号、且落在值列里。 */
const HOME_LINK = (y: number): TextRun => ({
  str: "../shouye/index.html",
  x: 419.2,
  y,
  h: BODY,
});

const DETAIL_FOOTER = footer(
  "https://zxgk.court.gov.cn/gkw/html/zhzxgk/detail.html",
);
const LIST_FOOTER = footer(
  "https://zxgk.court.gov.cn/gkw/html/zhzxgk/index.html",
);
/** detail 页独有的按钮，与正文同字号。 */
const CLOSE_BUTTON = (y: number): TextRun => ({
  str: "关闭",
  x: 287.6,
  y,
  h: BODY,
});

type Fields = [string, string][];

/** 把字段列表铺成「自上而下、行距 24pt」的一组文字段。 */
function stack(fields: Fields, top: number): TextRun[] {
  return fields.flatMap(([name, val], index) => {
    const y = top - index * ROW_GAP;
    return [label(name, y), padding(y), value(val, y)];
  });
}

/** 一条字段，但它的值被 CSS 折成了多行：续行与上一行间距 15pt、无标签。 */
function wrappedField(
  name: string,
  lines: string[],
  y: number,
): { runs: TextRun[]; lastY: number } {
  const runs: TextRun[] = [label(name, y), padding(y), value(lines[0], y)];
  let currentY = y;
  for (const line of lines.slice(1)) {
    currentY -= WRAP_GAP;
    runs.push(value(line, currentY));
  }
  return { runs, lastY: currentY };
}

const BZXR_FIELDS = (
  party: string,
  idCode: string,
  court: string,
  filingDate: string,
  caseNo: string,
  amount: string,
): Fields => [
  ["被执行人姓名/名称", party],
  ["性别", "—"],
  ["身份证号码/组织机构代码", idCode],
  ["执行法院", court],
  ["立案时间", filingDate],
  ["案号", caseNo],
  ["执行标的", amount],
];

const ZBAJ_FIELDS = (
  caseNo: string,
  party: string,
  idCode: string,
  court: string,
  filingDate: string,
  terminationDate: string,
  amount: string,
  unpaid: string,
): Fields => [
  ["案号", caseNo],
  ["被执行人姓名/名称", party],
  ["性别", "—"],
  ["身份证号码/组织机构代码", idCode],
  ["执行法院", court],
  ["立案时间", filingDate],
  ["终本日期", terminationDate],
  ["执行标的", amount],
  ["未履行金额", unpaid],
];

const SX_FIELDS = (
  caseNo: string,
  court = "深圳市南山区人民法院",
  filingDate = "2023年3月10日",
  obligation = "支付工程款",
): Fields => [
  ["被执行人姓名/名称", "恒大集团有限公司"],
  ["性别", "—"],
  ["身份证号码/组织机构代码", "9144030008****371X"],
  ["执行法院", court],
  ["省份", "广东"],
  ["执行依据文号", "（2022）粤0305民初2266号"],
  ["立案时间", filingDate],
  ["案号", caseNo],
  ["做出执行依据单位", "深圳市南山区人民法院"],
  [OBLIGATION_LABEL, obligation],
  ["被执行人的履行情况", "全部未履行"],
  ["失信被执行人行为具体情形", "有履行能力而拒不履行"],
  ["发布时间", "2023年4月24日"],
];

const capture = (fileName: string, pages: TextRun[][]): CaptureInput => ({
  fileName,
  pages,
});

const FILE = (n: number) =>
  `恒大集团有限公司_执行_中国执行信息公开网_Q01_${String(n).padStart(3, "0")}_20260917.pdf`;

/** 只含一个「被执行人」板块的最小 detail。 */
function bzxrCapture(
  n: number,
  idCode = "08790937-1",
  amount = "37985642",
): CaptureInput {
  const page = [
    HOME_LINK(697.2),
    banner("被执行人", 652.2),
    ...stack(
      BZXR_FIELDS(
        "恒大集团有限公司",
        idCode,
        "岳阳市岳阳楼区人民法院",
        "2026年9月9日",
        "（2026）湘0602执6856号",
        amount,
      ),
      625.9,
    ),
    CLOSE_BUTTON(481.9),
    DETAIL_FOOTER,
  ];
  return capture(FILE(n), [page]);
}

// ── 测试 ────────────────────────────────────────────────────────────

test("capture_no 从文件名解析", () => {
  assert.equal(captureNoFromFileName(FILE(7)), 7);
  assert.equal(
    captureNoFromFileName(
      "C:\\downloads\\底稿文件\\01_执行\\恒大集团有限公司_执行_中国执行信息公开网_Q01_031_20260917.pdf",
    ),
    31,
  );
  assert.equal(captureNoFromFileName("随便一个名字.pdf"), null);
});

test("list 与 detail 由页脚 pathname 区分", () => {
  assert.equal(classifyCapture([[footer("x"), LIST_FOOTER]]), "list");
  assert.equal(classifyCapture([[DETAIL_FOOTER]]), "detail");
  assert.equal(classifyCapture([[footer("没有可识别的页脚")]]), "unknown");
});

test("normalizeValue 去掉逐字定位插入的空格", () => {
  assert.equal(
    normalizeValue("深 圳 市 南 山 区 人 民 法 院"),
    "深圳市南山区人民法院",
  );
  assert.equal(
    normalizeValue("（2022）粤 0305 民初 2266 号"),
    "（2022）粤0305民初2266号",
  );
  assert.equal(normalizeValue("9144030008****371X"), "9144030008****371X");
  assert.equal(normalizeValue("—"), "—");
});

test("主表列定义：20 列，长文本独占最后一列", () => {
  assert.equal(MAIN_TABLE_COLUMNS.length, 20);
  assert.equal(
    MAIN_TABLE_COLUMNS[MAIN_TABLE_COLUMNS.length - 1].header,
    OBLIGATION_LABEL,
  );
  assert.equal(MAIN_TABLE_COLUMNS[MAIN_TABLE_COLUMNS.length - 1].wrap, true);
  assert.deepEqual(
    MAIN_TABLE_COLUMNS.map((column) => column.header),
    [
      "序号",
      "公示类型",
      "备注",
      "对应证据PDF文件名",
      "案号",
      "被执行人姓名/名称",
      "性别",
      "身份证号码/组织机构代码",
      "执行法院",
      "立案时间",
      "执行标的",
      "终本日期",
      "未履行金额",
      "省份",
      "执行依据文号",
      "做出执行依据单位",
      "发布时间",
      "被执行人的履行情况",
      "失信被执行人行为具体情形",
      "生效法律文书确定的义务",
    ],
  );
});

test("陷阱1：文字段数组顺序不是阅读顺序，必须先按 y 排序", () => {
  // banner 被刻意排在它自己的正文行**之后**（真实 Q01_002 就是这个顺序）
  const page = [
    ...stack(SX_FIELDS("（2023）粤0305执4653号"), 625.9),
    banner("失信被执行人", 652.2),
    DETAIL_FOOTER,
  ];
  const { sections } = readSections([page]);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].title, "失信被执行人");
  assert.equal(sections[0].rows.length, 13);
  assert.equal(sections[0].rows[7].label, "案号");
  assert.equal(sections[0].rows[7].value, "（2023）粤0305执4653号");
});

test("陷阱2：终本板块跨页延续（表头在 p1、三个字段落到 p2）", () => {
  const pageOne = [
    HOME_LINK(697.2),
    ...stack(SX_FIELDS("（2023）粤0305执4653号"), 625.9),
    banner("失信被执行人", 652.2),
    banner("终本案件", 212.7),
    // 前 6 个字段（案号…立案时间）留在 p1，后 3 个（终本日期/执行标的/未履行金额）落到 p2
    ...stack(
      ZBAJ_FIELDS(
        "（2023）粤0305执4653号",
        "恒大集团有限公司",
        "9144030008****371X",
        "深圳市南山区人民法院",
        "2023年3月10日",
        "",
        "",
        "",
      ).slice(0, 6),
      187.2,
    ),
    DETAIL_FOOTER,
  ];
  const pageTwo = [
    ...stack(
      [
        ["终本日期", "2023年4月26日"],
        ["执行标的", "107610.00"],
        ["未履行金额", "107609.50"],
      ],
      792.4,
    ),
    CLOSE_BUTTON(695.7),
    DETAIL_FOOTER,
  ];

  const { sections, problems } = readSections([pageOne, pageTwo]);
  assert.deepEqual(problems, []);
  assert.equal(sections.length, 2);
  assert.equal(sections[1].title, "终本案件");
  assert.equal(sections[1].rows.length, 9);
  const last = new Map(sections[1].rows.map((row) => [row.label, row.value]));
  assert.equal(last.get("终本日期"), "2023年4月26日");
  assert.equal(last.get("执行标的"), "107610.00");
  assert.equal(last.get("未履行金额"), "107609.50");
  assert.equal(last.get("执行法院"), "深圳市南山区人民法院");

  const result = parseExecutionTable([capture(FILE(2), [pageOne, pageTwo])]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].publicTypes, "失信被执行人、终本案件");
  assert.equal(result.rows[0].fields["终本日期"], "2023年4月26日");
  assert.equal(result.rows[0].fields["未履行金额"], "107609.50");
});

test("陷阱3：混合 detail 的公共字段按板块优先级取值，差异写进备注", () => {
  const pageOne = [
    HOME_LINK(697.2),
    ...stack(
      SX_FIELDS(
        "（2023）辽01执1682号",
        "辽宁省沈阳市中级人民法院",
        "2023年9月18日",
      ),
      625.9,
    ),
    banner("失信被执行人", 652.2),
    banner("终本案件", 272.7),
    ...stack(
      ZBAJ_FIELDS(
        "（2023）辽01执1682号",
        "恒大集团有限公司",
        "9144030008****371X",
        "沈阳市中级人民法院",
        "2023年9月18日",
        "2024年9月19日",
        "513602222.00",
        "367607322.22",
      ),
      248.7,
    ),
    DETAIL_FOOTER,
  ];

  const result = parseExecutionTable([capture(FILE(10), [pageOne])]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].publicTypes, "失信被执行人、终本案件");
  // 失信板块写「辽宁省沈阳市中级人民法院」，终本板块写「沈阳市中级人民法院」→ 执行类板块优先
  assert.equal(result.rows[0].fields["执行法院"], "沈阳市中级人民法院");
  assert.equal(result.rows[0].fields["执行标的"], "513602222.00");
  // 差异客观记录，不做对错判断
  assert.equal(
    result.rows[0].remarks,
    "失信被执行人板块公示执行法院为：辽宁省沈阳市中级人民法院",
  );
  assert.deepEqual(result.problems, []);
});

test("陷阱4：`—` 是站点对空值的渲染 → 立案时间未公示，且不影响其它字段", () => {
  const page = [
    HOME_LINK(697.2),
    banner("被执行人", 652.2),
    ...stack(
      BZXR_FIELDS(
        "恒大集团有限公司",
        "08790937-1",
        "岳阳市岳阳楼区人民法院",
        "—",
        "（2026）湘0602执6856号",
        "37985642",
      ),
      625.9,
    ),
    DETAIL_FOOTER,
  ];

  const result = parseExecutionTable([capture(FILE(26), [page])]);
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.equal(row.fields["立案时间"], "—");
  assert.equal(row.remarks, "立案时间未公示");
  assert.equal(row.fields["身份证号码/组织机构代码"], "08790937-1");
  // 「被执行人」板块没有终本字段与失信字段 → null（Excel 真空白），不是 `—`、不是空串
  assert.equal(row.fields["终本日期"], null);
  assert.equal(row.fields["未履行金额"], null);
  assert.equal(row.fields[OBLIGATION_LABEL], null);
  assert.deepEqual(result.problems, []);
});

test("陷阱5：长文本折行续行必须完整拼接，不能被静默截断", () => {
  const obligationLines = [
    "一、被告江西济民可信房地产开发有限公司于本判决生效之日起十日内向原告",
    "中国建筑第四工程局有限公司支付欠付款项4,372,000元及利息（以2,880,281.22",
    "元为基数，自2021年12月9日起按全国银行间同业拆借中心公布的同期贷款市场",
    "报价利率计算至实际付清之日止）；二、驳回原告中国建筑第四工程局有限公司",
    "的其他诉讼请求。",
  ];
  // 前 8 个字段：最后一个落在 625.9 - 7×24 = 457.9，长文本紧接其下（间距仍是 24）
  const before = stack(SX_FIELDS("（2023）粤0305执4653号").slice(0, 8), 625.9);
  const wrapped = wrappedField(OBLIGATION_LABEL, obligationLines, 433.9);
  const afterY = wrapped.lastY - ROW_GAP;
  const page = [
    HOME_LINK(697.2),
    banner("失信被执行人", 652.2),
    ...before,
    ...wrapped.runs,
    label("被执行人的履行情况", afterY),
    padding(afterY),
    value("全部未履行", afterY),
    DETAIL_FOOTER,
  ];

  const { sections, problems } = readSections([page]);
  assert.deepEqual(problems, []);
  const fields = new Map(sections[0].rows.map((row) => [row.label, row.value]));
  assert.equal(fields.get(OBLIGATION_LABEL), obligationLines.join(""));
  // 折行后面的字段没有被续行吃掉
  assert.equal(fields.get("被执行人的履行情况"), "全部未履行");
});

test("陷阱6：页面顶部家具落在值列里，但间距 45pt → 不是续行", () => {
  const page = [
    // 「返回首页」链接在整页最上方，此时还没有任何板块
    HOME_LINK(697.2),
    banner("失信被执行人", 652.2),
    ...stack(SX_FIELDS("（2023）粤0305执4653号"), 625.9),
    DETAIL_FOOTER,
  ];
  const { sections, problems } = readSections([page]);
  assert.deepEqual(problems, []);
  const fields = new Map(sections[0].rows.map((row) => [row.label, row.value]));
  assert.equal(fields.get("被执行人姓名/名称"), "恒大集团有限公司");
  // 家具文本没有混进任何字段值
  assert.equal(
    sections[0].rows.some((row) => row.value.includes("shouye")),
    false,
  );
});

test("续行不跨页：第二页开头的无标签行不能被并到上一页的字段里", () => {
  const pageOne = [
    HOME_LINK(697.2),
    banner("失信被执行人", 652.2),
    // 最后一个字段落在 625.9 - 9×24 = 409.9
    ...stack(SX_FIELDS("（2023）粤0305执4653号").slice(0, 10), 625.9),
    DETAIL_FOOTER,
  ];
  const pageTwo = [
    // 第二页顶部的翻页控件：无标签、落在值列里，但它是**另一页**的行
    value("跳转到2/21页", 754.9),
    ...stack(
      [
        ["被执行人的履行情况", "全部未履行"],
        ["失信被执行人行为具体情形", "有履行能力而拒不履行"],
        ["发布时间", "2023年4月24日"],
      ],
      728.9,
    ),
    DETAIL_FOOTER,
  ];

  const { sections, problems } = readSections([pageOne, pageTwo]);
  const fields = new Map(sections[0].rows.map((row) => [row.label, row.value]));
  assert.equal(fields.get(OBLIGATION_LABEL), "支付工程款");
  assert.equal(fields.get("发布时间"), "2023年4月24日");
  // 丢内容必须报错，不能静默
  assert.equal(problems.length, 1);
  assert.match(problems[0], /字段值续行无法归属/);
});

test("只有列表页进未纳入清单；纯失信 detail 进主表", () => {
  const listPage = [
    banner("查询结果", 344.7),
    { str: "被执行人姓名/名称:", x: 50.2, y: 614.7, h: BODY },
    { str: "恒大集团有限公司", x: 60, y: 590.7, h: BODY },
    LIST_FOOTER,
  ];
  const shixinOnly = [
    HOME_LINK(697.2),
    banner("失信被执行人", 652.2),
    ...stack(SX_FIELDS("（2023）粤0305执4653号"), 625.9),
    DETAIL_FOOTER,
  ];

  const result = parseExecutionTable([
    capture(FILE(1), [listPage]),
    capture(FILE(3), [shixinOnly]),
  ]);

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].publicTypes, "失信被执行人");
  assert.equal(result.rows[0].captureNo, 3);
  // 纯失信记录没有执行标的/终本字段 → 留空是预期结果，不算异常
  assert.equal(result.rows[0].fields["执行标的"], null);
  assert.equal(result.rows[0].fields["终本日期"], null);
  assert.equal(result.rows[0].fields[OBLIGATION_LABEL], "支付工程款");

  assert.equal(result.excluded.length, 1);
  assert.equal(result.excluded[0].captureNo, 1);
  assert.equal(result.excluded[0].reason, "列表页（非单条执行记录）");
  assert.deepEqual(result.problems, []);
});

test("同案号不合并：两行都在，行序 = Capture 顺序，两行都加备注", () => {
  const result = parseExecutionTable([
    bzxrCapture(28, "9144030008****371X"),
    bzxrCapture(26, "08790937-1"),
  ]);

  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].captureNo, 28);
  assert.equal(result.rows[1].captureNo, 26);
  assert.equal(result.rows[0].index, 1);
  assert.equal(result.rows[1].index, 2);
  for (const row of result.rows) {
    assert.equal(row.remarks, "同案号另有记录");
    assert.equal(row.publicTypes, "被执行人");
  }
  // 掩码原样保留，不被「修正」
  assert.equal(
    result.rows[0].fields["身份证号码/组织机构代码"],
    "9144030008****371X",
  );
  assert.equal(result.rows[1].fields["身份证号码/组织机构代码"], "08790937-1");
});

test("板块本应有却空着的字段进 problems，而不是静默产出空单元格", () => {
  const page = [
    HOME_LINK(697.2),
    banner("被执行人", 652.2),
    ...stack(
      [
        ["被执行人姓名/名称", "恒大集团有限公司"],
        ["性别", "—"],
        ["身份证号码/组织机构代码", "08790937-1"],
        ["执行法院", "岳阳市岳阳楼区人民法院"],
        ["立案时间", "2026年9月9日"],
        ["执行标的", "37985642"],
      ],
      625.9,
    ),
    DETAIL_FOOTER,
  ];

  const result = parseExecutionTable([capture(FILE(26), [page])]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].fields["案号"], null);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /板块「被执行人」字段「案号」为空/);
});

test("站点出现未建模字段时报错，不静默丢内容", () => {
  const page = [
    HOME_LINK(697.2),
    banner("被执行人", 652.2),
    ...stack(
      [
        ...BZXR_FIELDS(
          "恒大集团有限公司",
          "08790937-1",
          "岳阳市岳阳楼区人民法院",
          "2026年9月9日",
          "（2026）湘0602执6856号",
          "37985642",
        ),
        ["新增的神秘字段", "某值"],
      ],
      625.9,
    ),
    DETAIL_FOOTER,
  ];

  const result = parseExecutionTable([capture(FILE(26), [page])]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /未建模字段「新增的神秘字段」/);
});
