import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  cleanupSourceRoot,
  loadSourceModule,
} from "./helpers/source-modules.mjs";

test.after(cleanupSourceRoot);

const CANDIDATE = "某某集团有限公司";
/** 每页 10 条。页内序号跨页必然重复，因此只能靠 rowKey 建立身份。 */
const PAGE_SIZE = 10;

const rowOf = (index, pageNo) => ({
  serial: String(index + 1),
  name: CANDIDATE,
  filingDate: `2023年${(index % 9) + 1}月10日`,
  caseNo: `（2023）粤0305执${pageNo}${String(index + 1).padStart(2, "0")}号`,
  label: "查看",
});

const rowsOfPage = (pageNo, count = PAGE_SIZE) =>
  Array.from({ length: count }, (_, index) => rowOf(index, pageNo));

/** 与 adapter 的 resultRowsExpression 同形的页面快照。 */
const snapshotOf = (pageNo, patch = {}) => ({
  ok: true,
  rows: rowsOfPage(pageNo),
  page: {
    input: pageNo,
    shown: pageNo,
    totalPages: 21,
    totalSize: 202,
    pagerVisible: true,
  },
  resultVisible: true,
  ...patch,
});

/**
 * 在极简的假 DOM/window 里执行 adapter 生成的页面表达式。
 * 只做字符串/函数级的契约验证，不引入任何浏览器自动化框架。
 */
function runPageExpression(expression, options = {}) {
  const input = options.input === undefined ? { value: "" } : options.input;
  const calls = { search: 0, searchThis: undefined };
  const document = {
    querySelector: (selector) => (selector === "#currentPage" ? input : null),
  };
  const window = options.omitSearch
    ? {}
    : {
        search: function search() {
          calls.search += 1;
          calls.searchThis = this;
        },
      };
  const result = new Function("document", "window", `return ${expression};`)(
    document,
    window,
  );
  return { result, input, calls, window };
}

// ---------------------------------------------------------------------------
// A. validatePage：必须同时证明“输入框页码”与“页面显示页码”
// ---------------------------------------------------------------------------

test("validatePage：expectedPageNo 是显式页坐标，两个页信号都必须吻合", async () => {
  const adapter = await loadSourceModule("adapters/zxgk-execution.mjs");

  assert.deepEqual(adapter.validatePage(snapshotOf(1), 1), { ok: true });
  assert.deepEqual(adapter.validatePage(snapshotOf(2), 2), { ok: true });
  assert.deepEqual(adapter.validatePage(snapshotOf(21), 21), { ok: true });

  // 只看一个页信号都不够：输入框与页面显示必须都等于 expectedPageNo。
  assert.equal(
    adapter.validatePage({ ...snapshotOf(2), page: { input: 1, shown: 2 } }, 2)
      .ok,
    false,
  );
  assert.equal(
    adapter.validatePage({ ...snapshotOf(2), page: { input: 2, shown: 1 } }, 2)
      .ok,
    false,
  );
  // 期望页与实际页整体不符同样拒绝，并在文案里带上目标页。
  const wrongPage = adapter.validatePage(snapshotOf(1), 2);
  assert.equal(wrongPage.ok, false);
  assert.match(wrongPage.error, /第 2 页/);

  // 目标页码本身必须合法：0 / 负数 / 小数 / 非数字都直接拒绝。
  for (const bad of [0, -1, 1.5, "2", null, undefined, NaN])
    assert.equal(
      adapter.validatePage(snapshotOf(1), bad).ok,
      false,
      `expectedPageNo=${String(bad)} 必须被拒绝`,
    );

  // 不合格的页面事实仍然拒绝：没有结果行、缺少稳定身份、链接文字异常。
  assert.equal(
    adapter.validatePage({ ...snapshotOf(2), rows: [] }, 2).ok,
    false,
  );
  assert.equal(
    adapter.validatePage(
      { ...snapshotOf(2), rows: [{ ...rowOf(0, 2), caseNo: "" }] },
      2,
    ).ok,
    false,
  );
  assert.equal(
    adapter.validatePage(
      { ...snapshotOf(2), rows: [{ ...rowOf(0, 2), label: "详情" }] },
      2,
    ).ok,
    false,
  );
  assert.equal(adapter.validatePage(null, 2).ok, false);
});

// ---------------------------------------------------------------------------
// B. freezePageRows：先把页坐标钉死，再冻结该页集合
// ---------------------------------------------------------------------------

test("freezePageRows：按指定页冻结，页不符或身份重复一律 fail closed", async () => {
  const adapter = await loadSourceModule("adapters/zxgk-execution.mjs");

  const page2 = rowsOfPage(2);
  const frozen = adapter.freezePageRows(snapshotOf(2), 2);
  assert.equal(frozen.ok, true);
  assert.deepEqual(frozen.keys, page2.map(adapter.buildRowKey));
  assert.deepEqual(frozen.rows, page2);

  // 页面实际停在第 1 页，却要求冻结第 2 页：必须拒绝，绝不拿第 1 页冒充。
  const mismatch = adapter.freezePageRows(snapshotOf(1), 2);
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /第 2 页/);

  // 页内 rowKey 重复：宁可停下，也不靠行号猜测该处理哪一条。
  const duplicated = adapter.freezePageRows(
    { ...snapshotOf(2), rows: [page2[0], { ...page2[0], serial: "2" }] },
    2,
  );
  assert.equal(duplicated.ok, false);
  assert.match(duplicated.error, /完全相同的结果/);

  // 缺少任一身份字段都不能冻结。
  for (const field of ["name", "caseNo", "filingDate"]) {
    const incomplete = adapter.freezePageRows(
      { ...snapshotOf(2), rows: [{ ...page2[0], [field]: "" }] },
      2,
    );
    assert.equal(incomplete.ok, false, `缺少 ${field} 必须被拒绝`);
    assert.match(incomplete.error, /无法建立稳定身份/);
  }
});

// ---------------------------------------------------------------------------
// C. jumpToPageExpression：只发出网站动作，不宣称已经到达
// ---------------------------------------------------------------------------

test("jumpToPageExpression：改写 #currentPage 后触发页面查询，不含夹取逻辑", async () => {
  const adapter = await loadSourceModule("adapters/zxgk-execution.mjs");
  const expression = adapter.jumpToPageExpression(2);

  // 只做两件事：写 #currentPage、调用页面自己的查询函数。
  assert.match(expression, /querySelector\("#currentPage"\)/);
  assert.match(expression, /window\.search/);
  // 绝不依赖网站自带的分页控件函数或分页控件：它们会夹取越界目标。
  assert.doesNotMatch(expression, /goPage|nextPage|prePage|lastPage/);
  assert.doesNotMatch(expression, /#next-btn|#last-btn|#pre-btn|#goto/);
  assert.doesNotMatch(expression, /下一页|尾页/);
  // 不依赖任何 runtime job 概念。
  assert.doesNotMatch(expression, /job|baseline|totalPages/);
  // 返回语义只表示“动作已发出”，不使用“已到达”这类过度表述。
  assert.doesNotMatch(
    expression,
    /successfullyNavigated|pageReached|navigationComplete|arrived/,
  );
});

test("jumpToPageExpression：假 DOM 下确实写入页码并调用查询函数", async () => {
  const adapter = await loadSourceModule("adapters/zxgk-execution.mjs");

  const ok = runPageExpression(adapter.jumpToPageExpression(2));
  assert.deepEqual(ok.result, { ok: true, targetPage: 2 });
  // 返回值只有“动作已发出”这一层语义，没有任何“已到达”的字段。
  assert.deepEqual(Object.keys(ok.result).sort(), ["ok", "targetPage"]);
  assert.equal(typeof ok.result.targetPage, "number");
  // 页码被写成字符串形式的数字，查询函数被精确调用一次；
  // 且以页面 window 为接收者调用，与网站自己分页时的调用方式一致。
  assert.equal(ok.input.value, "2");
  assert.equal(ok.calls.search, 1);
  assert.equal(ok.calls.searchThis, ok.window);

  // 页面缺少分页输入框：不发动作。
  const noInput = runPageExpression(adapter.jumpToPageExpression(3), {
    input: null,
  });
  assert.equal(noInput.result.ok, false);
  assert.equal(noInput.calls.search, 0);

  // 页面未提供查询函数：不发动作。
  const noSearch = runPageExpression(adapter.jumpToPageExpression(3), {
    omitSearch: true,
  });
  assert.equal(noSearch.result.ok, false);
  assert.equal(noSearch.calls.search, 0);

  // targetPage 非法的组合不会存在：生成阶段就拒绝，不产出半成品表达式。
  for (const bad of [0, -1, 1.5, "2", null, undefined, NaN, Infinity])
    assert.throws(
      () => adapter.jumpToPageExpression(bad),
      `targetPage=${String(bad)} 必须在生成阶段被拒绝`,
    );
});

// ---------------------------------------------------------------------------
// D. 架构守卫：网站事实只允许存在于 adapter
// ---------------------------------------------------------------------------

test("分页网站事实只存在于 adapter，orchestration 不持有任何网站 selector", async () => {
  const [adapter, worker, workflow, state, progress, panel] = await Promise.all(
    [
      readFile(
        new URL("../src/adapters/zxgk-execution.mjs", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../src/worker.mjs", import.meta.url), "utf8"),
      readFile(
        new URL("../src/lib/zxgk-automation.mjs", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../src/lib/automation-state.mjs", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../src/lib/automation-progress-view.mjs", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../src/sidepanel.mjs", import.meta.url), "utf8"),
    ],
  );

  // adapter 是网站事实层：读写分页 DOM、发出跳页动作都是它的职责。
  for (const owned of [
    "#currentPage",
    "#currentPage-show",
    "#totalPage-show",
    "window.search",
    // 验证失败提示同样是网站事实：只有 adapter 知道它长什么样。
    ".warning-result",
  ])
    assert.ok(adapter.includes(owned), `adapter 应当拥有 ${owned}`);
  // 但绝不复用网站自带的分页控件函数：它们会把越界目标夹到末页。
  assert.doesNotMatch(adapter, /goPage|nextPage|prePage|lastPage/);

  // orchestration / worker / UI 只消费 adapter 的事实，不持有网站 selector。
  const siteFacts = [
    /下一页|尾页/,
    /nextPage|lastPage|prePage|goPage/,
    /#next-btn|#last-btn|#pre-btn|#goto/,
    /#currentPage|#totalPage-show|#totalSize-show/,
    /window\.search/,
    /warning-result/,
    /验证码错误|验证码已过期/,
  ];
  for (const source of [worker, workflow, state, progress, panel])
    for (const pattern of siteFacts)
      assert.doesNotMatch(
        source,
        pattern,
        `${pattern} 不该出现在非 adapter 源码里`,
      );

  // Slice 3A 起 worker 只把 adapter 的 primitive 注入标签页（与其它 primitive 同一模式），
  // orchestration 只消费注入的 jumpToPage。二者都不自己构造页面表达式。
  assert.doesNotMatch(
    workflow,
    /jumpToPageExpression|navigateToPageExpression/,
  );
  assert.doesNotMatch(worker, /navigateToPageExpression/);
  // state 层完全不知道“跳页”这件事。
  assert.doesNotMatch(state, /jumpToPage/);
  // 分页动作只能注入标签页执行，不得由 orchestration 直接驱动标签页。
  assert.doesNotMatch(workflow, /evaluateInTab|chrome\.tabs\./);
});

// ---------------------------------------------------------------------------
// E. 兼容性：M8.2a 入口继续按第 1 页工作
// ---------------------------------------------------------------------------

test("兼容：validateFirstPage / freezePageOneRows 仍然是第 1 页入口", async () => {
  const adapter = await loadSourceModule("adapters/zxgk-execution.mjs");

  for (const name of [
    "validatePage",
    "validateFirstPage",
    "freezePageRows",
    "freezePageOneRows",
    "locateRowKey",
    "reconcileRowKeys",
    "reconcileFrozenSet",
    "jumpToPageExpression",
  ])
    assert.equal(typeof adapter[name], "function", `${name} 必须仍然导出`);

  assert.deepEqual(adapter.validateFirstPage(snapshotOf(1)), { ok: true });
  const secondPage = adapter.validateFirstPage(snapshotOf(2));
  assert.equal(secondPage.ok, false);
  assert.match(secondPage.error, /第 1 页/);

  const frozen = adapter.freezePageOneRows(snapshotOf(1));
  assert.equal(frozen.ok, true);
  assert.deepEqual(frozen.keys, rowsOfPage(1).map(adapter.buildRowKey));

  // rowKey 规则不变：页面内注入版本与 Node 侧版本一致。
  const rebuilt = new Function(
    `${adapter.ROW_KEY_SOURCE} return buildRowKey;`,
  )();
  for (const row of rowsOfPage(2))
    assert.equal(rebuilt(row), adapter.buildRowKey(row));

  // 页参数化后的身份处理：先证明页坐标，再处理 rowKey。
  const keys = rowsOfPage(2).map(adapter.buildRowKey);
  assert.deepEqual(
    adapter.locateRowKey(snapshotOf(2), keys[0], 2).row,
    rowsOfPage(2)[0],
  );
  assert.equal(adapter.locateRowKey(snapshotOf(2), keys[0], 3).ok, false);
  assert.deepEqual(adapter.reconcileRowKeys(keys, snapshotOf(2), 2), {
    ok: true,
  });
  assert.equal(adapter.reconcileRowKeys(keys, snapshotOf(2), 1).ok, false);
  const reconciled = adapter.reconcileFrozenSet(keys, snapshotOf(2), 2);
  assert.equal(reconciled.ok, true);
  assert.deepEqual(reconciled.rows, rowsOfPage(2));
  // 集合只要变化（这里换成另一页）就 fail closed。
  assert.equal(adapter.reconcileFrozenSet(keys, snapshotOf(3), 3).ok, false);
});

// ---------------------------------------------------------------------------
// F. 验证失败信号：只认页面自己写进结果区的证据
// ---------------------------------------------------------------------------

/**
 * 在极简假 DOM 里执行 resultRowsExpression。只需要它真正读到的几个面：
 * 分页元素、结果区块、以及结果区里的提示节点。
 */
function runResultRows(expression, options = {}) {
  const node = (overrides = {}) => ({
    innerText: "",
    textContent: "",
    value: "",
    classList: { contains: () => false },
    ...overrides,
  });
  const warnings = (options.warnings || []).map((value) =>
    node({ innerText: value, textContent: value }),
  );
  const elements = {
    "#page-div": node(),
    "#result-block": node(),
    "#currentPage": node({ value: String(options.pageNo ?? 2) }),
    "#currentPage-show": node({ textContent: String(options.pageNo ?? 2) }),
    "#totalPage-show": node({ textContent: String(options.totalPages ?? 21) }),
    "#totalSize-show": node({ textContent: String(options.totalSize ?? 210) }),
  };
  const document = {
    querySelector: (selector) => elements[selector] ?? null,
    querySelectorAll: (selector) =>
      selector === ".warning-result" ? warnings : [],
  };
  return new Function("document", "window", `return ${expression};`)(
    document,
    {},
  );
}

test("resultRowsExpression：验证失败只由页面自己的提示证明，其它提示不算证据", async () => {
  const adapter = await loadSourceModule("adapters/zxgk-execution.mjs");
  const expression = adapter.resultRowsExpression();

  // 正常结果页：没有验证失败的证据，页坐标照常读取。
  const normal = runResultRows(expression);
  assert.deepEqual(normal.verification, { failed: false, evidence: null });
  assert.equal(normal.ok, true);
  assert.equal(normal.page.input, 2);
  assert.equal(normal.page.shown, 2);
  assert.equal(normal.page.totalPages, 21);

  // 页面自己写下的验证失败提示 = 唯一可接受的证据，原文保留给诊断。
  const failed = runResultRows(expression, {
    warnings: ["验证码错误或验证码已过期。"],
  });
  assert.equal(failed.verification.failed, true);
  assert.equal(failed.verification.evidence, "验证码错误或验证码已过期。");

  // 结果区里的其它提示（含空节点）都不是证据：不得据此推断验证码问题。
  for (const other of ["系统繁忙，请稍后再试。", "暂无数据", ""]) {
    assert.deepEqual(
      runResultRows(expression, { warnings: [other] }).verification,
      { failed: false, evidence: null },
      other,
    );
  }

  // 判据只在 Node 侧定义一次，页面表达式注入的是同一份 pattern 源码。
  assert.ok(adapter.ZXGK_VERIFICATION_FAILURE_PATTERN instanceof RegExp);
  assert.ok(
    expression.includes(
      JSON.stringify(adapter.ZXGK_VERIFICATION_FAILURE_PATTERN.source),
    ),
  );
  // 页面表达式只读取事实，不决定任何 orchestration 语义。
  assert.doesNotMatch(expression, /PAUSED|REQUIRES_VERIFICATION|job\b/);
});
