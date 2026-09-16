import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  cleanupSourceRoot,
  loadSourceModule,
} from "./helpers/source-modules.mjs";

test.after(cleanupSourceRoot);

const ENTITY = "上海某某科技有限公司";

async function modules() {
  const state = await loadSourceModule("lib/automation-state.mjs");
  const adapter = await loadSourceModule("adapters/zxgk-execution.mjs");
  const workflow = await loadSourceModule("lib/zxgk-automation.mjs");
  return {
    state,
    adapter,
    workflow,
    validate: workflow.validateZxgkAutomationJobInvariant,
  };
}

const rowOf = (serial, caseNo, filingDate) => ({
  serial: String(serial),
  name: "某某集团有限公司",
  filingDate,
  caseNo,
  label: "查看",
});

/** 每页 10 条。页内序号跨页必然重复，因此只能靠 rowKey 建立身份。 */
const rowsOfPage = (pageNo, count = 10) =>
  Array.from({ length: count }, (_, index) =>
    rowOf(
      index + 1,
      `（2023）粤0305执${pageNo}${String(index + 1).padStart(2, "0")}号`,
      `2023年${(index % 9) + 1}月10日`,
    ),
  );

const keysOf = (adapter, rows) => rows.map(adapter.buildRowKey);

/** 历史页只保留最小 completion summary：不含历史页 rows / rowKeys / detailCaptures。 */
const pageSummary = (pageNo) => ({
  pageNo,
  detailCount: 10,
  listCaptureId: `capture-list-${pageNo}`,
  completedAt: "2026-09-15T08:00:00.000Z",
});

/** M8.2a 的第一页进度：没有页坐标，也不含任何页模型字段。 */
function legacyFirstPage(adapter, patch = {}) {
  const rows = rowsOfPage(1);
  const keys = keysOf(adapter, rows);
  return {
    adapter: adapter.ZXGK_EXECUTION_ADAPTER,
    state: "READING_RESULT_ROWS",
    taskId: "task-execution",
    projectId: "project-1",
    queryText: ENTITY,
    queryId: "query-7",
    result: "HAS_RESULT",
    expectedDetailCount: keys.length,
    pageOneRowKeys: keys,
    pageOneRows: rows,
    completedDetailKeys: [],
    detailCaptures: [],
    listCapture: null,
    currentOperation: null,
    firstPageComplete: null,
    ...patch,
  };
}

/** M8.2b 页模型：显式带 currentPage，且不使用任何 legacy 字段。 */
function pageJob(state, adapter, patch = {}) {
  const pageNo = Number.isInteger(patch.currentPage) ? patch.currentPage : 1;
  const rows = rowsOfPage(pageNo);
  const keys = keysOf(adapter, rows);
  return {
    adapter: adapter.ZXGK_EXECUTION_ADAPTER,
    state: state.AUTOMATION_STATES.READING_RESULT_ROWS,
    taskId: "task-execution",
    projectId: "project-1",
    queryText: ENTITY,
    queryId: "query-7",
    result: state.AUTOMATION_RESULT.HAS_RESULT,
    currentPage: pageNo,
    totalPages: 3,
    currentPageRows: rows,
    pageFrozenKeys: keys,
    expectedDetailCount: keys.length,
    completedDetailKeys: [],
    detailCaptures: [],
    listCapture: {
      id: `capture-list-${pageNo}`,
      query_id: "query-7",
      capture_no: 3,
    },
    currentOperation: null,
    firstPageComplete: null,
    completedPages: [],
    ...patch,
  };
}

// ---------------------------------------------------------------------------
// A. normalizeAutomationJob 的 legacy 映射
// ---------------------------------------------------------------------------

test("normalize：M8.2a 第一页处理中的 job 派生 currentPage=1", async () => {
  const { state, adapter, validate } = await modules();
  const legacy = legacyFirstPage(adapter);
  const snapshot = JSON.parse(JSON.stringify(legacy));

  const normalized = state.normalizeAutomationJob(legacy);
  assert.equal(normalized.currentPage, 1);
  assert.deepEqual(normalized.pageFrozenKeys, legacy.pageOneRowKeys);
  assert.deepEqual(normalized.currentPageRows, legacy.pageOneRows);
  // 只有冻结结果集、没有完成摘要：第一页不算已完成。
  assert.deepEqual(normalized.completedPages, []);

  // 只读：不 mutate 输入，不删除、不改写 legacy 字段。
  assert.deepEqual(legacy, snapshot);
  assert.equal("currentPage" in legacy, false);
  assert.equal("completedPages" in legacy, false);
  assert.deepEqual(validate(legacy), { ok: true });
});

test("normalize：M8.2a FIRST_PAGE_COMPLETE 派生第 1 页完成摘要", async () => {
  const { state, adapter, validate } = await modules();
  const rows = rowsOfPage(1);
  const keys = keysOf(adapter, rows);
  const legacy = legacyFirstPage(adapter, {
    state: "FIRST_PAGE_COMPLETE",
    completedDetailKeys: [...keys],
    detailCaptures: keys.map((rowKey, index) => ({
      rowKey,
      captureId: `capture-${index + 4}`,
    })),
    listCapture: { id: "capture-list", query_id: "query-7", capture_no: 3 },
    firstPageComplete: {
      pageNo: 1,
      totalPages: 21,
      detailCount: 10,
      newCaptures: 11,
    },
    updatedAt: "2026-09-15T08:00:00.000Z",
  });
  const snapshot = JSON.parse(JSON.stringify(legacy));

  const normalized = state.normalizeAutomationJob(legacy);
  assert.equal(normalized.currentPage, 1);
  assert.equal(normalized.totalPages, 21);
  assert.deepEqual(normalized.completedPages, [
    {
      pageNo: 1,
      detailCount: 10,
      listCaptureId: "capture-list",
      completedAt: "2026-09-15T08:00:00.000Z",
    },
  ]);
  // 历史页只留 summary：不带 rows / rowKeys / detailCaptures。
  assert.deepEqual(Object.keys(normalized.completedPages[0]).sort(), [
    "completedAt",
    "detailCount",
    "listCaptureId",
    "pageNo",
  ]);
  assert.deepEqual(legacy, snapshot);
  assert.deepEqual(validate(legacy), { ok: true });
});

test("normalize：legacy 缺少 totalPages 时保持 null，不猜第 1 页", async () => {
  const { state, adapter } = await modules();
  const legacy = legacyFirstPage(adapter);
  const normalized = state.normalizeAutomationJob(legacy);
  assert.equal(normalized.totalPages, null);
  assert.notEqual(normalized.totalPages, 1);

  // 已有事实优先：firstPageComplete → resultPage。矛盾时不信 resultPage。
  assert.equal(
    state.normalizeAutomationJob({
      ...legacy,
      resultPage: { pageNo: 1, totalPages: 21 },
    }).totalPages,
    21,
  );
  assert.equal(
    state.normalizeAutomationJob({
      ...legacy,
      resultPage: { pageNo: 1, totalPages: 9 },
      firstPageComplete: { pageNo: 1, totalPages: 21, detailCount: 10 },
    }).totalPages,
    21,
  );
  // 非对象与非页模型字段原样返回，不做任何修复。
  assert.equal(state.normalizeAutomationJob(null), null);
  assert.equal(state.normalizeAutomationJob(undefined), undefined);
});

// ---------------------------------------------------------------------------
// B. 页坐标
// ---------------------------------------------------------------------------

test("页坐标：currentPage / totalPages 必须 >= 1 且不越界", async () => {
  const { state, adapter, validate } = await modules();
  assert.equal(
    validate(pageJob(state, adapter, { currentPage: 0 })).code,
    "CURRENT_PAGE_INVALID",
  );
  assert.equal(validate(pageJob(state, adapter)).code, undefined);
  assert.deepEqual(validate(pageJob(state, adapter)), { ok: true });
  assert.equal(
    validate(pageJob(state, adapter, { totalPages: 0 })).code,
    "TOTAL_PAGES_INVALID",
  );
  assert.equal(
    validate(pageJob(state, adapter, { currentPage: 3, totalPages: 2 })).code,
    "PAGE_OUT_OF_RANGE",
  );
  // currentPage 可以没有（早期状态），但一旦存在就必须合法。
  assert.deepEqual(
    validate({
      adapter: adapter.ZXGK_EXECUTION_ADAPTER,
      state: state.AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION,
      taskId: "task-execution",
      projectId: "project-1",
      queryText: ENTITY,
      queryId: null,
    }),
    { ok: true },
  );
});

// ---------------------------------------------------------------------------
// C. completedPages
// ---------------------------------------------------------------------------

test("completedPages：必须从第 1 页起严格连续且 field 合法", async () => {
  const { state, adapter, validate } = await modules();
  const paused = (patch) =>
    validate(
      pageJob(state, adapter, {
        state: state.AUTOMATION_STATES.PAUSED,
        ...patch,
      }),
    );

  assert.deepEqual(paused({ currentPage: 2, completedPages: [] }), {
    ok: true,
  });
  assert.deepEqual(
    paused({ currentPage: 2, completedPages: [pageSummary(1)] }),
    {
      ok: true,
    },
  );
  assert.deepEqual(
    paused({ currentPage: 3, completedPages: [1, 2, 3].map(pageSummary) }),
    { ok: true },
  );

  // 不从第 1 页开始、跳页、重复，都是同一条严格连续性规则。
  assert.equal(
    paused({ completedPages: [pageSummary(2)] }).code,
    "COMPLETED_PAGES_NOT_CONTIGUOUS",
  );
  assert.equal(
    paused({ currentPage: 3, completedPages: [pageSummary(1), pageSummary(3)] })
      .code,
    "COMPLETED_PAGES_NOT_CONTIGUOUS",
  );
  assert.equal(
    paused({ completedPages: [pageSummary(1), pageSummary(1)] }).code,
    "COMPLETED_PAGES_NOT_CONTIGUOUS",
  );
  assert.equal(
    paused({ completedPages: "page-1" }).code,
    "COMPLETED_PAGES_INVALID",
  );
  // 本网站 HAS_RESULT 的页至少有一条真实结果，因此 detailCount >= 1。
  assert.equal(
    paused({ completedPages: [{ ...pageSummary(1), detailCount: 0 }] }).code,
    "COMPLETED_PAGE_COUNT_INVALID",
  );
  assert.equal(
    paused({ completedPages: [{ ...pageSummary(1), listCaptureId: " " }] })
      .code,
    "COMPLETED_PAGE_CAPTURE_INVALID",
  );
  assert.equal(
    paused({ completedPages: [{ ...pageSummary(1), completedAt: "" }] }).code,
    "COMPLETED_PAGE_TIME_INVALID",
  );
  // 仅在 totalPages 已知时检查越界，不猜 totalPages。
  assert.equal(
    paused({
      currentPage: 1,
      totalPages: 1,
      completedPages: [1, 2].map(pageSummary),
    }).code,
    "COMPLETED_PAGE_OUT_OF_RANGE",
  );
  // listCaptureId / completedAt 允许缺失：legacy 可能没有完整历史时间。
  assert.deepEqual(
    paused({
      completedPages: [
        { pageNo: 1, detailCount: 10, listCaptureId: null, completedAt: null },
      ],
    }),
    { ok: true },
  );
});

// ---------------------------------------------------------------------------
// D. 当前页冻结集合
// ---------------------------------------------------------------------------

test("当前页冻结集合：长度、去重、详情归属与冻结顺序", async () => {
  const { state, adapter, validate } = await modules();
  const base = pageJob(state, adapter, {
    state: state.AUTOMATION_STATES.PAUSED,
  });
  const [firstKey] = base.pageFrozenKeys;

  // 冻结集合校验的输入是当前页冻结集合，因此新 shape 也走同一套既有 invariant。
  const duplicated = [...base.pageFrozenKeys];
  duplicated[1] = duplicated[0];
  assert.equal(
    validate({ ...base, pageFrozenKeys: duplicated }).code,
    "ROW_KEYS_DUPLICATE",
  );
  assert.equal(
    validate({ ...base, expectedDetailCount: 9 }).code,
    "EXPECTED_COUNT_MISMATCH",
  );
  assert.equal(
    validate({ ...base, completedDetailKeys: ["unknown-row"] }).code,
    "COMPLETED_KEY_UNKNOWN",
  );
  assert.equal(
    validate({ ...base, completedDetailKeys: [firstKey, firstKey] }).code,
    "COMPLETED_KEYS_DUPLICATE",
  );
  // 冻结顺序仍然有意义：只打乱 currentPageRows 就必须拒绝。
  assert.equal(
    validate({ ...base, currentPageRows: [...base.currentPageRows].reverse() })
      .code,
    "ROWS_KEYS_ORDER_MISMATCH",
  );
  // 类型与非空是新增的两条：这一页有冻结集合却为空时不再放行。
  assert.equal(
    validate({ ...base, pageFrozenKeys: "page-1" }).code,
    "PAGE_FROZEN_KEYS_INVALID",
  );
  assert.equal(
    validate({ ...base, pageFrozenKeys: [], expectedDetailCount: 0 }).code,
    "PAGE_FROZEN_KEYS_EMPTY",
  );
  assert.equal(
    validate({ ...base, currentPageRows: "page-1-rows" }).code,
    "PAGE_ROWS_INVALID",
  );
  assert.deepEqual(validate({ ...base, completedDetailKeys: [firstKey] }), {
    ok: true,
  });
  // M8.2a legacy job 继续通过同一套冻结集合 invariant。
  const legacy = legacyFirstPage(adapter, {
    state: state.AUTOMATION_STATES.PAUSED,
  });
  assert.deepEqual(validate(legacy), { ok: true });
});

// ---------------------------------------------------------------------------
// E. state-sensitive 规则
// ---------------------------------------------------------------------------

test("state-sensitive：页内处理中当前页必须未完成，准备离开时源页必须已完成", async () => {
  const { state, adapter, validate } = await modules();
  const inPage = pageJob(state, adapter, {
    state: state.AUTOMATION_STATES.READING_RESULT_ROWS,
    currentPage: 2,
  });
  // 第 2 页正在处理：只有第 1 页算完成。
  assert.deepEqual(validate({ ...inPage, completedPages: [pageSummary(1)] }), {
    ok: true,
  });
  assert.equal(
    validate({ ...inPage, completedPages: [1, 2].map(pageSummary) }).code,
    "CURRENT_PAGE_ALREADY_COMPLETED",
  );

  const advancing = {
    ...pageJob(state, adapter, {
      state: state.AUTOMATION_STATES.ADVANCING_PAGE,
      currentPage: 2,
    }),
    completedPages: [1, 2].map(pageSummary),
  };
  assert.deepEqual(validate(advancing), { ok: true });
  assert.equal(
    validate({ ...advancing, completedPages: [pageSummary(1)] }).code,
    "ADVANCE_PAGE_NOT_COMPLETED",
  );

  // M8.2a FIRST_PAGE_COMPLETE：currentPage 可以（且必然）在 completedPages 里。
  const rows = rowsOfPage(1);
  const keys = keysOf(adapter, rows);
  assert.deepEqual(
    validate(
      legacyFirstPage(adapter, {
        state: state.AUTOMATION_STATES.FIRST_PAGE_COMPLETE,
        completedDetailKeys: [...keys],
        listCapture: { id: "capture-list", query_id: "query-7", capture_no: 3 },
        firstPageComplete: { pageNo: 1, totalPages: 21, detailCount: 10 },
      }),
    ),
    { ok: true },
  );
});

test("多页 DONE 只在真正带多页标记时受限，NO_RESULT DONE 不受影响", async () => {
  const { state, adapter, validate } = await modules();
  const noResultDone = {
    adapter: adapter.ZXGK_EXECUTION_ADAPTER,
    state: state.AUTOMATION_STATES.DONE,
    taskId: "task-execution",
    projectId: "project-1",
    queryText: ENTITY,
    queryId: "query-7",
    result: state.AUTOMATION_RESULT.NO_RESULT,
    capture: { id: "capture-3", query_id: "query-7", capture_no: 3 },
    filename: `${ENTITY}_执行_中国执行信息公开网_Q07_003_20260915.pdf`,
  };
  const normalized = state.normalizeAutomationJob(noResultDone);
  assert.equal(normalized.totalPages, null);
  assert.deepEqual(normalized.completedPages, []);
  assert.deepEqual(validate(noResultDone), { ok: true });

  // 一旦出现多页标记，DONE 就必须连续覆盖到最后一页。
  const multiPageDone = pageJob(state, adapter, {
    state: state.AUTOMATION_STATES.DONE,
    currentPage: 3,
    totalPages: 3,
    completedPages: [1, 2, 3].map(pageSummary),
    currentOperation: null,
  });
  assert.deepEqual(validate(multiPageDone), { ok: true });
  assert.equal(
    validate({ ...multiPageDone, completedPages: [1, 2].map(pageSummary) })
      .code,
    "DONE_PAGES_INCOMPLETE",
  );
  assert.equal(
    validate({
      ...multiPageDone,
      currentPage: 2,
      completedPages: [1, 2].map(pageSummary),
    }).code,
    "DONE_PAGE_MISMATCH",
  );
  assert.equal(
    validate({
      ...multiPageDone,
      currentOperation: {
        type: "PAGE_ADVANCE",
        pageNo: 3,
        targetPage: 4,
        attempt: 1,
        phase: state.AUTOMATION_PHASES.VERIFYING,
      },
    }).code,
    "DONE_OPERATION_ACTIVE",
  );
  // 没有页标记的 DONE 不会被多页规则误判。
  assert.deepEqual(validate(noResultDone), { ok: true });
});

// ---------------------------------------------------------------------------
// F. PAGE_ADVANCE shape（只校验形状，不执行任何翻页动作）
// ---------------------------------------------------------------------------

test("PAGE_ADVANCE：只校验形状，源页必须已完成", async () => {
  const { state, adapter, validate } = await modules();
  const base = {
    ...pageJob(state, adapter, {
      state: state.AUTOMATION_STATES.ADVANCING_PAGE,
      currentPage: 2,
    }),
    completedPages: [1, 2].map(pageSummary),
  };
  const advance = {
    type: "PAGE_ADVANCE",
    pageNo: 2,
    targetPage: 3,
    attempt: 1,
    phase: state.AUTOMATION_PHASES.VERIFYING,
  };

  assert.deepEqual(validate({ ...base, currentOperation: advance }), {
    ok: true,
  });
  assert.equal(
    validate({ ...base, currentOperation: { ...advance, targetPage: 4 } }).code,
    "PAGE_ADVANCE_TARGET_INVALID",
  );
  assert.equal(
    validate({ ...base, currentOperation: { ...advance, attempt: 0 } }).code,
    "PAGE_ADVANCE_ATTEMPT_INVALID",
  );
  assert.equal(
    validate({
      ...base,
      currentOperation: { ...advance, rowKey: base.pageFrozenKeys[0] },
    }).code,
    "PAGE_ADVANCE_HAS_DETAIL_FIELDS",
  );
  assert.equal(
    validate({
      ...base,
      completedPages: [pageSummary(1)],
      currentOperation: advance,
    }).code,
    "PAGE_ADVANCE_SOURCE_INCOMPLETE",
  );
  // 源页与当前页不一致、phase 非法同样 fail closed。
  assert.equal(
    validate({ ...base, currentOperation: { ...advance, pageNo: 1 } }).code,
    "OPERATION_PAGE_INVALID",
  );
  assert.equal(
    validate({ ...base, currentOperation: { ...advance, phase: "PAUSED" } })
      .code,
    "OPERATION_PHASE_INVALID",
  );
});

test("operation.pageNo 泛化为当前页：legacy 第 1 页仍然合法", async () => {
  const { state, adapter, validate } = await modules();
  const legacy = legacyFirstPage(adapter, { listCapture: null });
  const [rowKey] = legacy.pageOneRowKeys;

  // M8.2a job 没有页坐标，有效当前页仍是第 1 页。
  assert.equal(state.normalizeAutomationJob(legacy).currentPage, 1);
  assert.deepEqual(
    validate({
      ...legacy,
      state: state.AUTOMATION_STATES.CAPTURING_DETAIL,
      currentOperation: {
        type: "DETAIL",
        pageNo: 1,
        rowKey,
        caseNo: legacy.pageOneRows[0].caseNo,
        phase: state.AUTOMATION_PHASES.CAPTURING,
        detailTabId: 901,
      },
    }),
    { ok: true },
  );
  // 页坐标存在时，operation 必须落在当前页。
  assert.equal(
    validate(
      pageJob(state, adapter, {
        currentPage: 2,
        currentOperation: {
          type: "LIST",
          pageNo: 1,
          rowKey: null,
          caseNo: null,
          phase: state.AUTOMATION_PHASES.CAPTURING,
        },
      }),
    ).code,
    "OPERATION_PAGE_INVALID",
  );
});

// ---------------------------------------------------------------------------
// G. 兼容性：M8.2a 的合法恢复窗口与 DONE 都不受影响
// ---------------------------------------------------------------------------

test("兼容：DETAIL 与 LIST 的合法 Capture recovery window 保持合法", async () => {
  const { state, adapter, validate } = await modules();
  const legacy = legacyFirstPage(adapter, { listCapture: null });
  const [rowKey] = legacy.pageOneRowKeys;

  // Capture 已 finalize、captureId 已落盘，但详情完成进度尚未补记。
  assert.deepEqual(
    validate({
      ...legacy,
      state: state.AUTOMATION_STATES.RETURNING_TO_LIST,
      detailCaptures: [{ rowKey, captureId: "capture-4" }],
      currentOperation: {
        type: "DETAIL",
        pageNo: 1,
        rowKey,
        caseNo: legacy.pageOneRows[0].caseNo,
        phase: state.AUTOMATION_PHASES.RETURNING,
        detailTabId: 901,
        captureId: "capture-4",
      },
    }),
    { ok: true },
  );
  // 列表 Capture 已 finalize，但 listCapture 尚未收尾。
  assert.deepEqual(
    validate({
      ...legacy,
      state: state.AUTOMATION_STATES.CAPTURING_LIST_PAGE,
      currentOperation: {
        type: "LIST",
        pageNo: 1,
        rowKey: null,
        caseNo: null,
        phase: state.AUTOMATION_PHASES.CAPTURING,
        captureId: "capture-list",
        capture: { id: "capture-list", query_id: "query-7", capture_no: 3 },
      },
    }),
    { ok: true },
  );
});

// ---------------------------------------------------------------------------
// H. Slice 1 边界：只建立 runtime model，不产生任何真实分页动作
// ---------------------------------------------------------------------------

test("Slice 1 不含任何真实分页动作，也没有生产路径进入 ADVANCING_PAGE", async () => {
  const { state } = await modules();
  const [workflow, stateSource] = await Promise.all([
    readFile(
      new URL("../src/lib/zxgk-automation.mjs", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/lib/automation-state.mjs", import.meta.url),
      "utf8",
    ),
  ]);

  for (const source of [workflow, stateSource]) {
    assert.doesNotMatch(source, /下一页|尾页/);
    assert.doesNotMatch(source, /nextPage|lastPage|prePage|goPage/);
    assert.doesNotMatch(source, /#next-btn|#last-btn|#pre-btn|#goto/);
    assert.doesNotMatch(source, /querySelector|chrome\.(tabs|debugger)/);
  }
  // 生产路径只读页模型字段，绝不写回：normalize 是 read-time 兼容视图。
  assert.doesNotMatch(workflow, /currentPage:/);
  assert.doesNotMatch(workflow, /pageFrozenKeys:/);
  assert.doesNotMatch(workflow, /completedPages:/);
  assert.doesNotMatch(workflow, /saveState\([^)]*ADVANCING_PAGE/);

  // ADVANCING_PAGE 先有合法表达，同时被当作运行中与中断状态。
  assert.equal(
    state.AUTOMATION_RUNNING_STATES.includes(
      state.AUTOMATION_STATES.ADVANCING_PAGE,
    ),
    true,
  );
  assert.equal(
    state.AUTOMATION_INTERRUPTED_STATES.includes(
      state.AUTOMATION_STATES.ADVANCING_PAGE,
    ),
    true,
  );
  assert.equal(state.isAutomationRunning({ state: "ADVANCING_PAGE" }), true);
});
