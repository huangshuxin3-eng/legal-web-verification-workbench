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

const keys = Array.from(
  { length: 10 },
  (_, index) => `某某公司|（2026）沪01执${index + 1}号|2026年9月15日`,
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
  assert.equal(fresh.firstPageProcessing, false);

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
  assert.equal(empty.firstPageProcessing, true);

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
