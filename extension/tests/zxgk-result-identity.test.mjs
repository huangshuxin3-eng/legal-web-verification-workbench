import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanupSourceRoot,
  loadSourceModule,
} from "./helpers/source-modules.mjs";
import {
  continueRun,
  detailArchives,
  executionTask,
  makeRow,
  named,
  resumeRun,
  rowsOfPage,
  startRun,
} from "./helpers/zxgk-multipage-harness.mjs";

test.after(cleanupSourceRoot);

/**
 * ZXGK 结果身份契约（2026-09-17 真人事实锁定）。
 *
 * rowKey = normalize(name) | normalize(caseNo) | normalize(detailIdentity)
 *
 * - required：name、caseNo、detailIdentity（detailIdentity 来自 a.View 的
 *   `openZhcxDetail(name, caseNo, thirdArgument)` 第三个实参，是不透明令牌）；
 * - optional：filingDate —— 真实结果行的立案时间可以为空，它只是 metadata；
 * - 禁止 fallback：DOM 位置、a.id（真人页面恒为字符串 "null"）、href（恒为
 *   javascript:void(0)）、filingDate-only、name+caseNo-only 都不是身份。
 *
 * 本文件覆盖 A–J（外加 filler 排除），既验证 Node 侧纯函数，也把**真实的**
 * resultRowsExpression / openDetailExpression 放进极简假 DOM 里执行，
 * 证明它们对真实 onclick 文本的解析与点击目标。
 */

// ---------------------------------------------------------------------------
// 极简假 DOM：只实现 adapter 页面表达式真正读到的形状。
// 任何多余的实现都会削弱证据价值，因此这里刻意保持最小。
// ---------------------------------------------------------------------------

const HEADERS = ["序号", "姓名", "立案时间", "案号", "查看"];

const onclickOf = (name, caseNo, detailIdentity) =>
  `openZhcxDetail('${name}','${caseNo}','${detailIdentity}');`;

const invisible = () => ({ width: 0, height: 0 });
const shown = () => ({ width: 12, height: 12 });

/**
 * 造一个结果行。
 * - `onclick === null` 表示该行没有「查看」链接（最后一页的补齐行，filler）；
 * - 其余四个显示单元格分别对应 序号 / 姓名 / 立案时间 / 案号。
 */
function rowNode({
  serial,
  name,
  filingDate,
  caseNo,
  label = "查看",
  onclick = null,
  visible = true,
}) {
  const anchor = {
    innerText: label,
    onclick,
    clicked: 0,
    click() {
      this.clicked += 1;
    },
    getAttribute(name) {
      return name === "onclick" ? anchor.onclick : null;
    },
    getBoundingClientRect: visible ? shown : invisible,
    classList: { contains: () => true },
  };
  const cells = [serial, name, filingDate, caseNo].map((value) => ({
    innerText: value ?? "",
  }));
  return {
    anchor,
    cells,
    querySelector: (selector) =>
      selector === "a.View" || selector === 'a[onclick*="openZhcxDetail"]'
        ? onclick === null
          ? null
          : anchor
        : null,
  };
}

/** 有「查看」链接的真实结果行。 */
const realRowNode = (row) =>
  rowNode({
    ...row,
    onclick: onclickOf(row.name, row.caseNo, row.detailIdentity),
  });

/** 最后一页的补齐行：四个空单元格 + 不可见的「查看」，没有 a.View。 */
const fillerRowNode = (serial) =>
  rowNode({
    serial: String(serial),
    name: "",
    filingDate: "",
    caseNo: "",
    onclick: null,
  });

function listPage(rowNodes) {
  const headerRow = {
    cells: HEADERS.map((value) => ({ innerText: value })),
    querySelector: () => null,
  };
  const table = {
    rows: [headerRow, ...rowNodes],
    getBoundingClientRect: shown,
    classList: { contains: () => true },
  };
  const pager = { classList: { contains: (name) => name !== "hide" } };
  const block = { classList: { contains: () => true } };
  return {
    tables: [table],
    warnings: [],
    bodyText: "",
    elements: {
      "#page-div": pager,
      "#result-block": block,
      "#currentPage": { value: "1" },
      "#currentPage-show": { textContent: "1" },
      "#totalPage-show": { textContent: "21" },
      "#totalSize-show": { textContent: "210" },
    },
  };
}

/** 在假 DOM 里执行 adapter 生成的页面表达式。 */
function evaluate(expression, page) {
  const document = {
    body: { innerText: page.bodyText },
    querySelector: (selector) => page.elements[selector] ?? null,
    querySelectorAll: (selector) =>
      selector === "table"
        ? page.tables
        : selector === ".warning-result"
          ? page.warnings
          : [],
  };
  const getComputedStyle = () => ({
    display: "block",
    visibility: "visible",
    opacity: "1",
  });
  return new Function("document", "getComputedStyle", `return ${expression};`)(
    document,
    getComputedStyle,
  );
}

const snapshotOf = (rows, pageNo = 1) => ({
  ok: true,
  page: { input: pageNo, shown: pageNo, totalPages: 21, totalSize: 210 },
  rows,
  resultVisible: true,
});

async function adapterModule() {
  return loadSourceModule("adapters/zxgk-execution.mjs");
}

// ---------------------------------------------------------------------------
// A. 真实行 + filingDate === "" → 冻结成功（filingDate 是可选字段）
// ---------------------------------------------------------------------------

test("A. 真实 a.View 行：filingDate 为空、姓名/案号/详情身份齐全 → 冻结成功", async () => {
  const adapter = await adapterModule();
  const real = makeRow({
    serial: "10",
    name: "恒大集团有限公司",
    caseNo: "（2025）粤01执1403号",
    filingDate: "",
    detailIdentity: "91440101MA5D1234XX",
  });
  const page = listPage([realRowNode(real)]);

  const snapshot = evaluate(adapter.resultRowsExpression(), page);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.rows.length, 1);
  const [row] = snapshot.rows;
  // 三个身份字段齐全，且 detailIdentity 确实来自 onclick 的第三个实参。
  assert.equal(row.name, "恒大集团有限公司");
  assert.equal(row.caseNo, "（2025）粤01执1403号");
  assert.equal(row.detailIdentity, "91440101MA5D1234XX");
  assert.equal(row.identityError, null);
  // 空立案时间原样保留为 ""：不填假日期、不从其它字段猜。
  assert.equal(row.filingDate, "");

  const frozen = adapter.freezePageRows(snapshot, 1);
  assert.equal(frozen.ok, true);
  assert.deepEqual(frozen.keys, [
    "恒大集团有限公司|(2025)粤01执1403号|91440101MA5D1234XX",
  ]);
});

test("A2. filler 排除：没有 a.View 的补齐行永远不是 real row", async () => {
  const adapter = await adapterModule();
  const real = makeRow({
    serial: "1",
    caseNo: "（2025）粤01执1403号",
    detailIdentity: "ID-A",
  });
  // 最后一页：1 条真实结果 + 9 条补齐行。
  const page = listPage([
    realRowNode(real),
    ...Array.from({ length: 9 }, (_, index) => fillerRowNode(index + 2)),
  ]);

  const snapshot = evaluate(adapter.resultRowsExpression(), page);
  assert.equal(snapshot.rows.length, 1, "补齐行必须被排除，不得被当成结果");
  assert.equal(snapshot.rows[0].detailIdentity, "ID-A");
  // filler 不会因为 filingDate 变成可选而被纳入 real rows。
  assert.equal(adapter.freezePageRows(snapshot, 1).ok, true);
});

// ---------------------------------------------------------------------------
// B. 显示字段相同、detailIdentity 不同 → 两个 distinct occurrence
// ---------------------------------------------------------------------------

test("B. 显示字段完全相同但 detailIdentity 不同 → 两个不同的 rowKey，都处理", async () => {
  const adapter = await adapterModule();
  const sharedFields = {
    name: "湘0602执6856号当事人",
    caseNo: "（2025）湘0602执6856号",
    filingDate: "2025年6月1日",
  };
  const left = makeRow({
    ...sharedFields,
    serial: "3",
    detailIdentity: "IDENTITY-A",
  });
  const right = makeRow({
    ...sharedFields,
    serial: "5",
    detailIdentity: "IDENTITY-B",
  });
  const page = listPage([realRowNode(left), realRowNode(right)]);

  const snapshot = evaluate(adapter.resultRowsExpression(), page);
  assert.equal(snapshot.rows.length, 2);
  const keys = snapshot.rows.map(adapter.buildRowKey);
  assert.notEqual(keys[0], keys[1], "detailIdentity 必须让两条行成为两个身份");
  assert.deepEqual(keys, [
    "湘0602执6856号当事人|(2025)湘0602执6856号|IDENTITY-A",
    "湘0602执6856号当事人|(2025)湘0602执6856号|IDENTITY-B",
  ]);

  // 页内没有重复身份 → 冻结成功，两条都被冻结（不静默去重）。
  const frozen = adapter.freezePageRows(snapshot, 1);
  assert.equal(frozen.ok, true);
  assert.equal(frozen.keys.length, 2);
  assert.deepEqual(frozen.keys, keys);
});

// ---------------------------------------------------------------------------
// C. 三段完全相同的两条行 → page-local 重复 → fail closed
// ---------------------------------------------------------------------------

test("C. name+caseNo+detailIdentity 完全相同 → 页内重复身份 fail closed", async () => {
  const adapter = await adapterModule();
  const base = {
    name: "恒大集团有限公司",
    caseNo: "（2025）粤01执1403号",
    filingDate: "",
    detailIdentity: "IDENTITY-SAME",
  };
  const page = listPage([
    realRowNode(makeRow({ ...base, serial: "1" })),
    realRowNode(makeRow({ ...base, serial: "2" })),
  ]);

  const snapshot = evaluate(adapter.resultRowsExpression(), page);
  assert.equal(
    snapshot.rows.map(adapter.buildRowKey)[0],
    snapshot.rows.map(adapter.buildRowKey)[1],
  );

  const frozen = adapter.freezePageRows(snapshot, 1);
  assert.equal(frozen.ok, false);
  assert.match(frozen.error, /完全相同的结果/);
  // 提示文案给操作者可核对的姓名 + 案号，不把不透明令牌原文写出去。
  // （rowKey 里的文本已按身份规则做了全角→半角归一，因此提示里的括号是半角。）
  assert.match(frozen.error, /恒大集团有限公司/);
  assert.match(frozen.error, /\(2025\)粤01执1403号/);
  assert.equal(frozen.error.includes("IDENTITY-SAME"), false);

  // 绝不 silent dedupe：不是"去掉一条继续"，而是整页停下。
  assert.equal("rows" in frozen, false);
  assert.equal("keys" in frozen, false);
});

// ---------------------------------------------------------------------------
// D. detailIdentity 缺失 / 无法解析 → fail closed
// ---------------------------------------------------------------------------

test("D. detailIdentity 缺失或无法解析 → fail closed，绝不回退到其它字段", async () => {
  const adapter = await adapterModule();
  const row = {
    name: "恒大集团有限公司",
    caseNo: "（2025）粤01执1403号",
    filingDate: "",
  };

  const missing = listPage([
    rowNode({
      ...row,
      serial: "1",
      onclick: onclickOf(row.name, row.caseNo, ""),
    }),
  ]);
  const missingSnapshot = evaluate(adapter.resultRowsExpression(), missing);
  assert.equal(missingSnapshot.rows[0].detailIdentity, "");
  assert.match(missingSnapshot.rows[0].identityError, /详情身份为空/);
  const missingFrozen = adapter.freezePageRows(missingSnapshot, 1);
  assert.equal(missingFrozen.ok, false);
  assert.match(missingFrozen.error, /无法建立稳定身份/);

  // 真人页面的 a.id 恒为字符串 "null"、href 恒为 javascript:void(0)：
  // 这些都不是身份，绝不能作为 fallback。
  for (const onclick of [
    "javascript:void(0)",
    "void(0)",
    "openZhcxDetail()",
    "openZhcxDetail('a','b')",
    "openZhcxDetail('a','b','c','d')",
    "openZhcxDetail('a',\"b\",'c')",
    "",
  ]) {
    const page = listPage([rowNode({ ...row, serial: "1", onclick })]);
    const snapshot = evaluate(adapter.resultRowsExpression(), page);
    assert.equal(
      snapshot.rows[0].detailIdentity,
      "",
      `onclick=${onclick} 不得被猜出身份`,
    );
    assert.ok(
      snapshot.rows[0].identityError,
      `onclick=${onclick} 必须记录身份错误`,
    );
    assert.equal(
      adapter.freezePageRows(snapshot, 1).ok,
      false,
      `onclick=${onclick} 必须 fail closed`,
    );
  }

  // 纯函数层同样 fail closed，且不因缺省字段抛异常。
  for (const bad of [undefined, null, "", "javascript:void(0)", 0]) {
    const parsed = adapter.parseDetailIdentity(bad);
    assert.equal(parsed.ok, false, `${String(bad)} 不得被解析成身份`);
    assert.equal("detailIdentity" in parsed, false);
  }
});

test("D2. 解析只匹配固定结构：不 eval、不执行 onclick", async () => {
  const adapter = await adapterModule();
  // 注入尝试（引号提前闭合 + 追加语句）无法匹配固定结构 → fail closed。
  const injected =
    "openZhcxDetail('a','b','c');window.__pwned=true;openZhcxDetail('a','b','d');";
  const parsed = adapter.parseDetailIdentity(injected);
  assert.equal(parsed.ok, false);
  assert.equal(globalThis.__pwned, undefined, "onclick 绝不被执行");

  const expression = adapter.openDetailExpression("x|y|z");
  assert.doesNotMatch(expression, /\beval\s*\(/);
  assert.doesNotMatch(expression, /new Function/);
  assert.doesNotMatch(expression, /setTimeout|setInterval/);
  // 只读 onclick 属性文本。
  assert.match(expression, /getAttribute\("onclick"\)/);
});

// ---------------------------------------------------------------------------
// E / F. onclick 里的字段与列表显示不一致 → fail closed
// ---------------------------------------------------------------------------

test("E. onclick 姓名与列表显示姓名不一致 → fail closed", async () => {
  const adapter = await adapterModule();
  const page = listPage([
    rowNode({
      serial: "1",
      name: "恒大集团有限公司",
      caseNo: "（2025）粤01执1403号",
      filingDate: "",
      onclick: onclickOf("另一个主体有限公司", "（2025）粤01执1403号", "ID-X"),
    }),
  ]);
  const snapshot = evaluate(adapter.resultRowsExpression(), page);
  assert.match(snapshot.rows[0].identityError, /姓名与列表显示不一致/);
  const frozen = adapter.freezePageRows(snapshot, 1);
  assert.equal(frozen.ok, false);
  assert.match(frozen.error, /无法建立稳定身份/);
});

test("F. onclick 案号与列表显示案号不一致 → fail closed", async () => {
  const adapter = await adapterModule();
  const page = listPage([
    rowNode({
      serial: "1",
      name: "恒大集团有限公司",
      caseNo: "（2025）粤01执1403号",
      filingDate: "",
      onclick: onclickOf("恒大集团有限公司", "（2025）粤01执9999号", "ID-X"),
    }),
  ]);
  const snapshot = evaluate(adapter.resultRowsExpression(), page);
  assert.match(snapshot.rows[0].identityError, /案号与列表显示不一致/);
  assert.equal(adapter.freezePageRows(snapshot, 1).ok, false);
});

// ---------------------------------------------------------------------------
// G / H. fresh snapshot 对账：filingDate 无关，detailIdentity 有关
// ---------------------------------------------------------------------------

test("G. fresh snapshot 同 name/caseNo/detailIdentity：立案时间变化（含为空）不影响对账", async () => {
  const adapter = await adapterModule();
  const original = [
    makeRow({
      serial: "1",
      caseNo: "（2025）粤01执1号",
      filingDate: "2025年1月1日",
      detailIdentity: "ID-1",
    }),
    makeRow({
      serial: "2",
      caseNo: "（2025）粤01执2号",
      filingDate: "2025年2月1日",
      detailIdentity: "ID-2",
    }),
  ];
  const keys = original.map(adapter.buildRowKey);
  assert.equal(adapter.freezePageRows(snapshotOf(original), 1).ok, true);

  // fresh query 后立案时间变空 / 变化：身份不变 → 对账success。
  const refreshed = [
    { ...original[0], filingDate: "" },
    { ...original[1], filingDate: "2025年2月2日" },
  ];
  assert.deepEqual(adapter.reconcileFrozenSet(keys, snapshotOf(refreshed), 1), {
    ok: true,
    rows: refreshed,
  });
  assert.deepEqual(adapter.reconcileRowKeys(keys, snapshotOf(refreshed), 1), {
    ok: true,
  });
  // 展示顺序变化但集合一致 → 仍按原冻结顺序返回。
  assert.deepEqual(
    adapter
      .reconcileFrozenSet(keys, snapshotOf([refreshed[1], refreshed[0]]), 1)
      .rows.map(adapter.buildRowKey),
    keys,
  );
});

test("H. detailIdentity 改变 → 对账 fail closed，绝不自动重写冻结集合", async () => {
  const adapter = await adapterModule();
  const original = [
    makeRow({
      serial: "1",
      caseNo: "（2025）粤01执1号",
      detailIdentity: "ID-1",
    }),
    makeRow({
      serial: "2",
      caseNo: "（2025）粤01执2号",
      detailIdentity: "ID-2",
    }),
  ];
  const keys = original.map(adapter.buildRowKey);

  const changed = [{ ...original[0], detailIdentity: "ID-1-新" }, original[1]];
  const reconciled = adapter.reconcileFrozenSet(keys, snapshotOf(changed), 1);
  assert.equal(reconciled.ok, false);
  assert.match(reconciled.error, /结果集合已变化/);
  // 返回值里没有新的 keys —— 调用方不可能拿它去重写冻结集合。
  assert.equal("keys" in reconciled, false);

  // 只变 detailIdentity、显示字段一字不差：同样必须 fail closed。
  const sameDisplay = [
    { ...original[0], detailIdentity: "ID-OTHER" },
    original[1],
  ];
  assert.equal(
    adapter.reconcileFrozenSet(keys, snapshotOf(sameDisplay), 1).ok,
    false,
  );
});

// ---------------------------------------------------------------------------
// I. 点击目标精确性：显示字段相同的两条行各开各的详情
// ---------------------------------------------------------------------------

test("I. 显示字段完全相同的两条行：locate/open 精确命中各自 detailIdentity，不得都点第一条", async () => {
  const adapter = await adapterModule();
  const shared = {
    name: "湘0602执6856号当事人",
    caseNo: "（2025）湘0602执6856号",
    filingDate: "2025年6月1日",
  };
  const left = makeRow({
    ...shared,
    serial: "3",
    detailIdentity: "IDENTITY-A",
  });
  const right = makeRow({
    ...shared,
    serial: "5",
    detailIdentity: "IDENTITY-B",
  });
  const page = listPage([realRowNode(left), realRowNode(right)]);
  const [leftAnchor, rightAnchor] = page.tables[0].rows
    .slice(1)
    .map((row) => row.anchor);

  const keyA = adapter.buildRowKey(left);
  const keyB = adapter.buildRowKey(right);

  // locateRowKey 在快照里各自唯一定位。
  const snapshot = evaluate(adapter.resultRowsExpression(), page);
  const locatedA = adapter.locateRowKey(snapshot, keyA, 1);
  const locatedB = adapter.locateRowKey(snapshot, keyB, 1);
  assert.equal(locatedA.ok, true);
  assert.equal(locatedB.ok, true);
  assert.equal(locatedA.row.detailIdentity, "IDENTITY-A");
  assert.equal(locatedB.row.detailIdentity, "IDENTITY-B");
  assert.notEqual(locatedA.row, locatedB.row);

  // 真实 openDetailExpression：只点自己那一个 anchor。
  const openedA = evaluate(adapter.openDetailExpression(keyA), page);
  assert.equal(openedA.ok, true);
  assert.equal(openedA.detailIdentity, "IDENTITY-A");
  assert.equal(leftAnchor.clicked, 1);
  assert.equal(
    rightAnchor.clicked,
    0,
    "不得因为姓名+案号相同就点到第一条之后又点到第二条",
  );

  const openedB = evaluate(adapter.openDetailExpression(keyB), page);
  assert.equal(openedB.ok, true);
  assert.equal(openedB.detailIdentity, "IDENTITY-B");
  assert.equal(leftAnchor.clicked, 1, "第二次不得重复点第一条");
  assert.equal(rightAnchor.clicked, 1);

  // 回传的字段足以让 worker 用同一份实现复核身份（含 detailIdentity）。
  assert.equal(
    adapter.buildRowKey(openedB),
    keyB,
    "openDetail 的返回值必须能重算出同一个 rowKey",
  );
});

test("I2. 页面把两条行渲染成同一身份时，openDetail 绝不猜：fail closed", async () => {
  const adapter = await adapterModule();
  const shared = {
    name: "恒大集团有限公司",
    caseNo: "（2025）粤01执1403号",
    filingDate: "",
    detailIdentity: "IDENTITY-SAME",
  };
  const page = listPage([
    realRowNode(makeRow({ ...shared, serial: "1" })),
    realRowNode(makeRow({ ...shared, serial: "2" })),
  ]);
  const result = evaluate(
    adapter.openDetailExpression(adapter.buildRowKey(shared)),
    page,
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /多个相同身份/);
  for (const row of page.tables[0].rows.slice(1))
    assert.equal(row.anchor.clicked, 0, "身份不可区分时一条都不许点");
});

test("I3. 行身份不可确定时 openDetail 直接拒绝，不点任何行", async () => {
  const adapter = await adapterModule();
  const good = makeRow({
    serial: "1",
    caseNo: "（2025）粤01执1号",
    detailIdentity: "ID-1",
  });
  const page = listPage([
    realRowNode(good),
    rowNode({
      serial: "2",
      name: "恒大集团有限公司",
      caseNo: "（2025）粤01执2号",
      filingDate: "",
      onclick: "javascript:void(0)",
    }),
  ]);
  const result = evaluate(
    adapter.openDetailExpression(adapter.buildRowKey(good)),
    page,
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /无法确定详情身份/);
  assert.equal(page.tables[0].rows[1].anchor.clicked, 0);
});

// ---------------------------------------------------------------------------
// 注入源码自包含（页面侧与 Node 侧不得分叉）
// ---------------------------------------------------------------------------

test("身份实现自包含：注入页面后不依赖任何外部变量", async () => {
  const adapter = await adapterModule();
  const rebuilt = new Function(
    `${adapter.ROW_KEY_SOURCE} return { parseDetailIdentity, buildRowKey };`,
  )();
  assert.equal(
    rebuilt.buildRowKey({
      name: "A",
      caseNo: "B",
      filingDate: "C",
      detailIdentity: "D",
    }),
    adapter.buildRowKey({
      name: "A",
      caseNo: "B",
      filingDate: "C",
      detailIdentity: "D",
    }),
  );
  assert.deepEqual(
    rebuilt.parseDetailIdentity(onclickOf("A", "B", "D")),
    adapter.parseDetailIdentity(onclickOf("A", "B", "D")),
  );
  // filingDate 不在注入实现里参与身份，也不会因缺省而抛异常。
  assert.equal(
    rebuilt.buildRowKey({ name: "A", caseNo: "B", detailIdentity: "D" }),
    "A|B|D",
  );
});

// ---------------------------------------------------------------------------
// 端到端（harness）：B / I / J 在真实控制流下的行为
// ---------------------------------------------------------------------------

test("harness-B/I. 页内两条同显示字段、不同 detailIdentity：两条详情都留痕，各开各的", async () => {
  const shared = {
    name: "湘0602执6856号当事人",
    caseNo: "（2025）湘0602执6856号",
    filingDate: "2025年6月1日",
  };
  const pageOne = [
    makeRow({ ...shared, serial: "3", detailIdentity: "IDENTITY-A" }),
    makeRow({ ...shared, serial: "5", detailIdentity: "IDENTITY-B" }),
  ];
  const run = await startRun({ totalPages: 1, rowsForPage: () => pageOne });
  const job = await continueRun(run);

  assert.equal(job.state, run.state.AUTOMATION_STATES.DONE);
  assert.equal(job.expectedDetailCount, 2);
  assert.equal(job.completedDetailKeys.length, 2);
  assert.equal(
    new Set(job.completedDetailKeys).size,
    2,
    "两条 identity 必须是两个不同的 rowKey",
  );
  assert.equal(detailArchives(run).length, 2);

  // 两条详情各自打开了**自己那一个** occurrence。
  const opened = [...run.details.values()]
    .map((entry) => entry.detailIdentity)
    .sort();
  assert.deepEqual(opened, ["IDENTITY-A", "IDENTITY-B"]);
  const completed = job.detailCaptures
    .map((item) => item.rowKey.split("|")[2])
    .sort();
  assert.deepEqual(completed, ["IDENTITY-A", "IDENTITY-B"]);
});

test("harness-J. 跨页出现同一新 rowKey：两个 occurrence 都必须留痕，不做全局去重", async () => {
  const shared = makeRow({
    serial: "1",
    caseNo: "（2025）粤0305执9999号",
    filingDate: "2025年9月10日",
    detailIdentity: "IDENTITY-SHARED",
  });
  const pageFive = [...rowsOfPage(5).slice(0, 9), shared];
  const pageSix = [shared, ...rowsOfPage(6).slice(1)];
  const run = await startRun({
    totalPages: 6,
    rowsForPage: (pageNo) =>
      pageNo === 5 ? pageFive : pageNo === 6 ? pageSix : rowsOfPage(pageNo),
  });
  const job = await continueRun(run);

  assert.equal(job.state, run.state.AUTOMATION_STATES.DONE);
  const sharedKey = run.adapter.buildRowKey(shared);
  const sharedArchives = detailArchives(run).filter(
    (call) => run.details.get(call[2])?.rowKey === sharedKey,
  );
  // completedDetailKeys 是 page-local 的，因此同一 rowKey 在两页各留痕一次。
  assert.equal(sharedArchives.length, 2);
  assert.deepEqual(
    sharedArchives.map((call) => call[4]).sort((a, b) => a - b),
    [5, 6],
  );
  assert.equal(detailArchives(run).length, 60);
  assert.deepEqual(run.workflow.validateZxgkAutomationJobInvariant(job), {
    ok: true,
  });
});

test("harness-A. 真实空立案时间不阻断整条链路：冻结 → 留痕 → DONE", async () => {
  const pageOne = [
    makeRow({
      serial: "1",
      name: "恒大集团有限公司",
      caseNo: "（2025）粤01执1403号",
      filingDate: "",
      detailIdentity: "91440101MA5D1234XX",
    }),
  ];
  const run = await startRun({ totalPages: 1, rowsForPage: () => pageOne });
  const job = await continueRun(run);

  assert.equal(job.state, run.state.AUTOMATION_STATES.DONE);
  assert.equal(detailArchives(run).length, 1);
  assert.equal(
    job.detailCaptures[0].rowKey,
    run.adapter.buildRowKey(pageOne[0]),
  );
  // 空立案时间没有被改写成任何东西。
  assert.equal(job.currentPageRows[0].filingDate, "");
});

test("harness-H. fresh resume 时 detailIdentity 变化 → fail closed，不重复留痕", async () => {
  const run = await startRun({
    totalPages: 3,
    // 第 2 页刚冻结、尚未开始留痕时进程被杀。
    killBefore: ({ next }) =>
      next.currentPage === 2 && next.currentOperation?.type === "LIST",
  });
  await assert.rejects(continueRun(run), /worker killed/);
  run.interrupt();
  const crashed = run.job;
  assert.equal(crashed.currentPage, 2);
  assert.deepEqual(crashed.completedDetailKeys, []);
  assert.equal(executionTask.id, "task-execution");

  // 第 2 页第 5 条换了 detailIdentity：显示字段一字未改。
  const mutated = rowsOfPage(2);
  mutated[4] = { ...mutated[4], detailIdentity: "ID-2-5-已变化" };
  run.setPage(2, mutated);

  const archivesBefore = named(run, "archive").length;
  await resumeRun(run);
  await assert.rejects(continueRun(run), /结果集合已变化/);
  assert.equal(run.job.errorCode, "RESUME_FROZEN_SET_CHANGED");
  assert.equal(
    named(run, "archive").length,
    archivesBefore,
    "对账失败时不得新增任何留痕",
  );
  // 绝不自动重写已冻结的集合。
  assert.deepEqual(
    run.job.pageFrozenKeys,
    rowsOfPage(2).map(run.adapter.buildRowKey),
  );
  assert.equal(run.state.canResumeAutomation(run.job), false);
});

// ---------------------------------------------------------------------------
// §10 旧契约的 active checkpoint：不得被静默迁移
// ---------------------------------------------------------------------------

test("旧 rowKey 契约下的 active checkpoint 被识别为不一致并 fail closed，绝不静默迁移", async () => {
  const adapter = await adapterModule();
  const state = await loadSourceModule("lib/automation-state.mjs");
  const workflow = await loadSourceModule("lib/zxgk-automation.mjs");

  // 旧契约现场：pageOne/pageFrozen keys 是 name|caseNo|filingDate，rows 里没有 detailIdentity。
  const rows = [1, 2].map((index) => ({
    serial: String(index),
    name: "某某集团有限公司",
    caseNo: `（2023）粤0305执000${index}号`,
    filingDate: `2023年3月1${index}日`,
    label: "查看",
  }));
  const oldKeys = rows.map((row) =>
    [row.name, row.caseNo, row.filingDate].join("|"),
  );
  const legacyJob = {
    adapter: adapter.ZXGK_EXECUTION_ADAPTER,
    state: state.AUTOMATION_STATES.READY,
    taskId: "task-execution",
    projectId: "project-1",
    entityName: "某某集团有限公司",
    queryText: "某某集团有限公司",
    queryId: "query-7",
    topic: "执行",
    sourceName: "中国执行信息公开网",
    sourceUrl: "https://zxgk.court.gov.cn/",
    tabId: 21,
    result: "HAS_RESULT",
    currentPage: 2,
    totalPages: 21,
    pageFrozenKeys: oldKeys,
    currentPageRows: rows,
    pageOneRowKeys: oldKeys,
    pageOneRows: rows,
    expectedDetailCount: 2,
    completedDetailKeys: [],
    detailCaptures: [],
    listCapture: null,
    currentOperation: null,
    firstPageComplete: null,
    completedPages: [1, 2].map((pageNo) => ({
      pageNo,
      detailCount: 10,
      listCaptureId: `capture-${pageNo}`,
      completedAt: "2026-09-15T07:00:00.000Z",
    })),
    resultPage: { pageNo: 2, totalPages: 21, totalSize: 210 },
    updatedAt: "2026-09-15T07:00:00.000Z",
  };

  const verdict = workflow.validateZxgkAutomationJobInvariant(legacyJob);
  assert.equal(verdict.ok, false);
  // 旧 keys 与新契约派生的 keys 不一致 → job 被判为不一致，resume 会 fail closed。
  assert.equal(verdict.code, "ROWS_KEYS_ORDER_MISMATCH");
  assert.equal(state.canResumeAutomation(legacyJob), false);
  // 不迁移：validate 是只读的，现场一秒都没被改写。
  assert.deepEqual(legacyJob.pageFrozenKeys, oldKeys);
  assert.equal(legacyJob.pageOneRows[0].detailIdentity, undefined);
});
