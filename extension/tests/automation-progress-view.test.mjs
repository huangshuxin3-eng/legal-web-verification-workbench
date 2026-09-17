import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanupSourceRoot,
  loadSourceModule,
} from "./helpers/source-modules.mjs";

test.after(cleanupSourceRoot);

async function modules() {
  const state = await loadSourceModule("lib/automation-state.mjs");
  const view = await loadSourceModule("lib/automation-progress-view.mjs");
  return { state, derive: view.deriveZxgkAutomationProgressViewModel };
}

// rowKey 形态：name | caseNo | detailIdentity（filingDate 不参与身份）。
const keys = Array.from(
  { length: 10 },
  (_, index) => `某某公司|（2026）沪01执${index + 1}号|ID-${index + 1}`,
);

function firstPageJob(state, patch = {}) {
  return {
    state: state.AUTOMATION_STATES.READING_RESULT_ROWS,
    expectedDetailCount: 10,
    pageOneRowKeys: keys,
    completedDetailKeys: [],
    detailCaptures: [],
    listCapture: null,
    currentOperation: null,
    firstPageComplete: null,
    ...patch,
  };
}

test("新 job 与 CAPTCHA 等待态保持无第一页进度", async () => {
  const { state, derive } = await modules();
  const fresh = derive({ state: state.AUTOMATION_STATES.IDLE });
  assert.equal(fresh.completedDetailCount, 0);
  assert.equal(fresh.expectedDetailCount, 0);
  assert.equal(fresh.listCaptureComplete, false);
  assert.equal(fresh.generatedCaptureCount, 0);
  assert.equal(fresh.canResume, false);
  assert.equal(fresh.currentPageProcessing, false);

  const waiting = derive({
    state: state.AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION,
  });
  assert.equal(waiting.waitingForHumanVerification, true);
  assert.equal(waiting.canContinue, true);
  assert.equal(waiting.canResume, false);
});

test("冻结第一页后稳定派生 0/10 与 3/10 进度", async () => {
  const { state, derive } = await modules();
  const empty = derive(firstPageJob(state));
  assert.equal(empty.completedDetailCount, 0);
  assert.equal(empty.expectedDetailCount, 10);
  assert.equal(empty.nextIncompleteCaseNo, "（2026）沪01执1号");
  // 页泛化后这个标志不再叫 firstPageProcessing：它描述的是"当前页"。
  assert.equal("firstPageProcessing" in empty, false);
  assert.equal(empty.currentPageProcessing, true);

  const partial = derive(
    firstPageJob(state, {
      completedDetailKeys: keys.slice(0, 3),
      listCapture: { id: "capture-list" },
    }),
  );
  assert.equal(partial.completedDetailCount, 3);
  assert.equal(partial.nextIncompleteCaseNo, "（2026）沪01执4号");
  assert.equal(partial.listCaptureComplete, true);
  assert.equal(partial.generatedCaptureCount, 4);
});

test("DETAIL pending operation 只派生当前展示信息", async () => {
  const { state, derive } = await modules();
  const operation = {
    type: "DETAIL",
    pageNo: 1,
    rowKey: keys[3],
    caseNo: "（2026）沪01执4号",
    phase: state.AUTOMATION_PHASES.CAPTURING,
    detailTabId: 901,
  };
  const job = firstPageJob(state, {
    state: state.AUTOMATION_STATES.CAPTURING_DETAIL,
    completedDetailKeys: keys.slice(0, 3),
    currentOperation: operation,
  });
  const snapshot = structuredClone(job);
  const result = derive(job);
  assert.equal(result.pendingOperationCaseNo, "（2026）沪01执4号");
  assert.equal(result.completedDetailCount, 3);
  assert.deepEqual(job, snapshot);
});

test("LIST recovery captureId 与稳定 listCapture 均显示列表已留痕", async () => {
  const { state, derive } = await modules();
  const pending = derive(
    firstPageJob(state, {
      state: state.AUTOMATION_STATES.CAPTURING_LIST_PAGE,
      currentOperation: {
        type: "LIST",
        pageNo: 1,
        rowKey: null,
        caseNo: null,
        phase: state.AUTOMATION_PHASES.CAPTURING,
        captureId: "capture-list",
      },
    }),
  );
  assert.equal(pending.listCaptureComplete, true);
  assert.equal(pending.generatedCaptureCount, 1);

  const settled = derive(
    firstPageJob(state, { listCapture: { id: "capture-list" } }),
  );
  assert.equal(settled.listCaptureComplete, true);
  assert.equal(settled.generatedCaptureCount, 1);
});

test("FIRST_PAGE_COMPLETE 派生完整完成进度与页数", async () => {
  const { state, derive } = await modules();
  const result = derive(
    firstPageJob(state, {
      state: state.AUTOMATION_STATES.FIRST_PAGE_COMPLETE,
      completedDetailKeys: keys,
      listCapture: { id: "capture-list" },
      firstPageComplete: { pageNo: 1, detailCount: 10, newCaptures: 11 },
      resultPage: { pageNo: 1, totalPages: 21 },
    }),
  );
  assert.equal(result.firstPageComplete, true);
  assert.equal(result.completedDetailCount, 10);
  assert.equal(result.generatedCaptureCount, 11);
  assert.equal(result.nextIncompleteCaseNo, "");
  assert.equal(result.totalPages, 21);
});

test("旧 job 缺失可选字段时保持当前零值兼容", async () => {
  const { state, derive } = await modules();
  const result = derive({ state: state.AUTOMATION_STATES.FAILED });
  assert.equal(result.completedDetailCount, 0);
  assert.equal(result.expectedDetailCount, 0);
  assert.equal(result.listCaptureComplete, false);
  assert.equal(result.nextIncompleteCaseNo, "");
});

test("DETAIL capture recovery window 不会提前增加 UI 完成数", async () => {
  const { state, derive } = await modules();
  const result = derive(
    firstPageJob(state, {
      state: state.AUTOMATION_STATES.RETURNING_TO_LIST,
      completedDetailKeys: keys.slice(0, 3),
      detailCaptures: keys.slice(0, 4).map((rowKey, index) => ({
        rowKey,
        captureId: `capture-${index + 1}`,
      })),
      listCapture: { id: "capture-list" },
      currentOperation: {
        type: "DETAIL",
        pageNo: 1,
        rowKey: keys[3],
        caseNo: "（2026）沪01执4号",
        phase: state.AUTOMATION_PHASES.RETURNING,
        captureId: "capture-4",
      },
    }),
  );
  assert.equal(result.completedDetailCount, 3);
  assert.equal(result.generatedCaptureCount, 4);
  assert.equal(result.nextIncompleteCaseNo, "（2026）沪01执4号");
});

test("currentPage = 2 时使用第 2 页冻结集合与案号，不读 legacy pageOneRowKeys", async () => {
  const { state, derive } = await modules();
  const pageTwoKeys = Array.from(
    { length: 3 },
    (_, index) => `某某公司|（2026）沪01执9${index + 1}号|2026年9月15日`,
  );
  const result = derive({
    state: state.AUTOMATION_STATES.READING_RESULT_ROWS,
    currentPage: 2,
    totalPages: 21,
    pageFrozenKeys: pageTwoKeys,
    currentPageRows: [],
    // legacy 字段仍然是第 1 页的集合：第 2 页绝不能再读它。
    pageOneRowKeys: keys,
    expectedDetailCount: 3,
    completedDetailKeys: pageTwoKeys.slice(0, 1),
    detailCaptures: [],
    listCapture: null,
    currentOperation: null,
    firstPageComplete: null,
    completedPages: [
      {
        pageNo: 1,
        detailCount: 10,
        listCaptureId: "capture-list-1",
        completedAt: "2026-09-15T08:00:00.000Z",
      },
    ],
  });

  assert.equal(result.currentPage, 2);
  assert.equal(result.totalPages, 21);
  assert.equal(result.expectedDetailCount, 3);
  // 下一项是第 2 页的案号，而不是第 1 页的「（2026）沪01执2号」。
  assert.equal(result.nextIncompleteCaseNo, "（2026）沪01执92号");
  assert.equal(result.completedPageCount, 1);
  assert.equal(result.completedPageCaptureCount, 11);
  assert.equal(result.partialComplete, false);
});

test("PARTIAL_COMPLETE 与多页 DONE 都派生页码、已处理页数与留痕总数", async () => {
  const { state, derive } = await modules();
  const pageTwoKeys = ["某某公司|（2026）沪01执91号|2026年9月15日"];
  const base = {
    currentPage: 2,
    totalPages: 21,
    pageFrozenKeys: pageTwoKeys,
    expectedDetailCount: 1,
    completedDetailKeys: pageTwoKeys,
    detailCaptures: [],
    listCapture: { id: "capture-list-2" },
    currentOperation: null,
    firstPageComplete: null,
    completedPages: [
      {
        pageNo: 1,
        detailCount: 10,
        listCaptureId: "capture-list-1",
        completedAt: "2026-09-15T08:00:00.000Z",
      },
      {
        pageNo: 2,
        detailCount: 1,
        listCaptureId: "capture-list-2",
        completedAt: "2026-09-15T08:10:00.000Z",
      },
    ],
  };

  const partial = derive({
    ...base,
    state: state.AUTOMATION_STATES.PARTIAL_COMPLETE,
  });
  assert.equal(partial.partialComplete, true);
  assert.equal(partial.firstPageComplete, false);
  assert.equal(partial.currentPage, 2);
  assert.equal(partial.totalPages, 21);
  assert.equal(partial.completedPageCount, 2);
  assert.equal(partial.completedPageCaptureCount, 13);
  // 部分完成：不提供"再次自动核查"（那会从第 1 页重造一整套 Capture）；
  // 但这个 job 完全没有 result / queryId，因此也没有可继续的检查点。
  assert.equal(partial.canContinue, false);
  assert.equal(partial.canResume, false);
  assert.equal(
    state.canStartNewAutomation({
      state: state.AUTOMATION_STATES.PARTIAL_COMPLETE,
    }),
    false,
  );
  // 也不是"运行中"：不会锁住留痕按钮以外的任何"正在处理"文案。
  assert.equal(partial.currentPageProcessing, false);

  // legacy 的 PARTIAL_COMPLETE 只要带完整 checkpoint（result + queryId + 连续前缀
  // 1..currentPage + 当前页冻结集合），就是正确的「继续剩余分页核查」入口。
  const resumablePartial = derive({
    ...base,
    state: state.AUTOMATION_STATES.PARTIAL_COMPLETE,
    result: state.AUTOMATION_RESULT.HAS_RESULT,
    queryId: "query-7",
  });
  assert.equal(resumablePartial.partialComplete, true);
  assert.equal(resumablePartial.canResume, true);
  assert.equal(resumablePartial.resumeTargetPage, 2);
  assert.equal(
    state.deriveResumeTarget({
      ...base,
      state: state.AUTOMATION_STATES.PARTIAL_COMPLETE,
      result: state.AUTOMATION_RESULT.HAS_RESULT,
      queryId: "query-7",
    }).targetPage,
    2,
  );

  // 两页站点跑完：同样的页数据，但状态是 DONE，而不是 PARTIAL_COMPLETE。
  const done = derive({
    ...base,
    totalPages: 2,
    state: state.AUTOMATION_STATES.DONE,
  });
  assert.equal(done.partialComplete, false);
  assert.equal(done.completedPageCount, 2);
  assert.equal(done.completedPageCaptureCount, 13);
});
