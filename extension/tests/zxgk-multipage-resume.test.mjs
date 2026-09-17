import test from "node:test";
import assert from "node:assert/strict";
import { cleanupSourceRoot } from "./helpers/source-modules.mjs";
import {
  ENTITY,
  continueRun,
  createMultipageHarness,
  detailArchives,
  executionTask,
  jumps,
  listArchives,
  named,
  resumeRun,
  rowsOfPage,
} from "./helpers/zxgk-multipage-harness.mjs";

test.after(cleanupSourceRoot);

/**
 * M8.2b Slice 5 —— 通用 fresh resume / 崩溃窗口。
 *
 * 覆盖的 checkpoint 形态（全部以第 7 / 第 8 页为样本，证明它不再只是"第 1 / 第 2 页"）：
 * 1. 当前页未完成（第 7 页 4/10）
 * 2. 源页已完成、目标页尚未冻结（第 7 页完整，第 8 页未冻结）
 * 3. pending PAGE_ADVANCE 7 → 8，页面已经在第 8 页（same environment 就地冻结）
 * 4. pending PAGE_ADVANCE 7 → 8，环境已重建（页面在第 1 页）
 * 5. 目标页已经冻结（第 8 页刚冻结、尚未处理）
 * 6. legacy PARTIAL_COMPLETE 2/21
 * 以及三类 fail closed：Page1 指纹变化 / 总页数变化 / 目标页冻结集合变化。
 */

const PAGE_SEVEN_PARTIAL = {
  // 第 7 页处理完第 5 条详情的写入被丢弃 → 持久化进度停在第 4 条。
  killBefore: ({ next }) =>
    next.currentPage === 7 && next.completedDetailKeys?.length === 5,
};

const PAGE_SEVEN_COMPLETE = {
  // 第 7 页全部完成、PAGE_ADVANCE(7 → 8) 的写入被丢弃 → 源页已完成但还没离开。
  killBefore: ({ next }) =>
    next.state === "ADVANCING_PAGE" && next.currentPage === 7,
};

const PAGE_EIGHT_FROZEN = {
  // 第 8 页已冻结、它的列表留痕写入被丢弃 → 目标页已冻结但完全没有处理。
  killBefore: ({ next }) =>
    next.currentPage === 8 && next.currentOperation?.type === "LIST",
};

/** 跑到第 7 页中途被杀 → worker 重启扫描 → FAILED（可继续）。 */
async function crashAtSeven(options) {
  const run = await createMultipageHarness({
    totalPages: 21,
    ...options,
    queries: [{ id: "query-7", query_no: 7, query_text: ENTITY }],
  });
  await run.automation.start({
    taskId: executionTask.id,
    projectId: executionTask.project_id,
  });
  await assert.rejects(continueRun(run), /worker killed/);
  run.interrupt();
  assert.equal(run.job.state, run.state.AUTOMATION_STATES.FAILED);
  return run;
}

const assertInvariant = (run, job) =>
  assert.deepEqual(run.workflow.validateZxgkAutomationJobInvariant(job), {
    ok: true,
  });

// ---------------------------------------------------------------------------
// 1. 当前页未完成：第 7 页 4 / 10
// ---------------------------------------------------------------------------

test("当前页未完成（第 7 页 4/10）：fresh resume 定位回第 7 页，只补做剩余 6 条", async () => {
  const run = await crashAtSeven(PAGE_SEVEN_PARTIAL);
  const crashed = run.job;
  assert.equal(crashed.currentPage, 7);
  assert.equal(crashed.completedDetailKeys.length, 4);
  assert.deepEqual(
    crashed.completedPages.map((item) => item.pageNo),
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal(crashed.listCapture.capture_no, 3 + 11 * 6);
  assertInvariant(run, crashed);
  assert.deepEqual(run.state.deriveResumeTarget(crashed), {
    ok: true,
    targetPage: 7,
  });

  // 这是本轮第 4 条的 Capture 已经成功、但进度尚未补记的窗口：
  // resume 必须先把它补记，而不是重新留痕。
  assert.equal(crashed.detailCaptures.length, 5);
  const archivesBefore = named(run, "archive").length;

  // fresh resume：重建查询环境 → 人工验证。
  await resumeRun(run);
  assert.equal(run.list.pageNo, 1);
  assert.equal(
    run.job.state,
    run.state.AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION,
  );

  const finished = await continueRun(run);
  assert.equal(finished.state, run.state.AUTOMATION_STATES.DONE);
  assert.equal(finished.currentPage, 21);
  assert.deepEqual(
    finished.completedPages.map((item) => item.pageNo),
    Array.from({ length: 21 }, (_, index) => index + 1),
  );
  // 第 7 页那一条未补记的证据只补记一次：第 5 条详情全程只归档一次。
  const pageSevenDetails = detailArchives(run).filter((call) => call[4] === 7);
  assert.equal(pageSevenDetails.length, 10);
  // 恢复之后新增的留痕 = 第 7 页剩余 5 条 + 第 8–21 页 × 11 = 159。
  assert.equal(named(run, "archive").length - archivesBefore, 5 + 14 * 11);
  // 全站 21 页：21 列表 + 210 详情 = 231 份，编号连续不重复。
  const captureNos = named(run, "archive").map((call) => call[5]);
  assert.equal(captureNos.length, 231);
  assert.equal(new Set(captureNos).size, 231);
  assertInvariant(run, finished);
});

test("locate jump 不写 PAGE_ADVANCE intent、不改页坐标：业务 advance 恰好 20 次", async () => {
  const run = await crashAtSeven(PAGE_SEVEN_PARTIAL);
  const intentsAtCrash = run.savedIntents().length;
  assert.equal(intentsAtCrash, 6);
  assert.equal(jumps(run).length, 6);

  await resumeRun(run);
  await continueRun(run);

  // 业务 advance 数恒为 totalPages - 1；定位用的那一次跳页不产生任何 intent。
  assert.equal(run.savedIntents().length, 20);
  // 页面动作 = 20 次 business advance + 恰好 1 次 locate jump。
  assert.equal(jumps(run).length, 21);
  // 每一次 business advance 的意图都先于对应的页面动作落盘。
  const intentIndexes = run.savedJobs
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.currentOperation?.type === "PAGE_ADVANCE")
    .map(({ index }) => index);
  assert.equal(intentIndexes.length, 20);
  // 21 页全部完成，且没有任何重复留痕。
  assert.equal(listArchives(run).length, 21);
  assert.equal(detailArchives(run).length, 210);
});

// ---------------------------------------------------------------------------
// 2. 源页已完成、目标页尚未冻结
// ---------------------------------------------------------------------------

test("源页已完成但目标页未冻结（第 7 页完整）：重新证明后只发一次 business advance 7 → 8", async () => {
  const run = await crashAtSeven(PAGE_SEVEN_COMPLETE);
  const crashed = run.job;
  // 崩溃现场：第 7 页已经完整处理，但记录里既没有 intent 也没有第 8 页的坐标。
  assert.equal(crashed.currentPage, 7);
  assert.equal(crashed.currentOperation, null);
  assert.equal(crashed.completedDetailKeys.length, 10);
  assert.deepEqual(
    crashed.completedPages.map((item) => item.pageNo),
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal(run.workflow.pageCompleteness(crashed, 7).ok, true);
  assertInvariant(run, crashed);
  assert.deepEqual(run.state.deriveResumeTarget(crashed), {
    ok: true,
    targetPage: 7,
  });

  await resumeRun(run);
  const finished = await continueRun(run);

  // 第 7 页不重复留痕：它的列表与 10 条详情都只归档过一次。
  assert.equal(
    run.calls.filter((call) => call[3] === "list" && call[4] === 7).length,
    1,
  );
  assert.equal(detailArchives(run).filter((call) => call[4] === 7).length, 10);
  assert.equal(finished.state, run.state.AUTOMATION_STATES.DONE);
  assert.deepEqual(
    finished.completedPages.map((item) => item.pageNo),
    Array.from({ length: 21 }, (_, index) => index + 1),
  );
  // 业务 advance = 20（其中 7 → 8 是恢复之后重新发出的那一次）。
  assert.equal(run.savedIntents().length, 20);
  const advances = run
    .savedIntents()
    .map(
      (item) =>
        `${item.currentOperation.pageNo}->${item.currentOperation.targetPage}`,
    );
  assert.equal(advances.filter((value) => value === "7->8").length, 1);
  assertInvariant(run, finished);
});

// ---------------------------------------------------------------------------
// 3. pending PAGE_ADVANCE 7 → 8：same environment，页面已经在第 8 页
// ---------------------------------------------------------------------------

test("pending 7 → 8 且页面已在第 8 页：以真实事实就地冻结，绝不重发动作", async () => {
  const run = await createMultipageHarness({
    totalPages: 21,
    // 意图已落盘、dispatch 已发出、但"到达第 8 页"的写入被丢弃。
    killBefore: ({ next }) => next.currentPage === 8,
    queries: [{ id: "query-7", query_no: 7, query_text: ENTITY }],
  });
  await run.automation.start({
    taskId: executionTask.id,
    projectId: executionTask.project_id,
  });
  await assert.rejects(continueRun(run), /worker killed/);
  const crashed = run.job;
  assert.equal(crashed.currentPage, 7);
  assert.equal(crashed.currentOperation.type, "PAGE_ADVANCE");
  assert.equal(crashed.currentOperation.targetPage, 8);
  assert.deepEqual(
    crashed.completedPages.map((item) => item.pageNo),
    [1, 2, 3, 4, 5, 6, 7],
  );
  assertInvariant(run, crashed);

  // 环境没有被重建：页面确实已经在第 8 页（旧 dispatch 其实生效了）。
  // 进程重新可用（写入不再被丢弃），但 job 状态由下面的 setJob 直接构造：
  // "用户就在这个页面上重新检查结果"，因此不经过 worker 的重启扫描。
  run.revive();
  run.setJob({
    ...crashed,
    state: run.state.AUTOMATION_STATES.PAUSED,
    result: run.state.AUTOMATION_RESULT.UNKNOWN,
    errorCode: null,
    error: "当前页面尚未呈现可确认的结果，请重试。",
  });
  assert.equal(run.state.canRecheckAutomation(run.job), true);
  assert.equal(run.list.pageNo, 8);

  const jumpsBefore = jumps(run).length;
  const finished = await continueRun(run);

  // 不重发跳页：直接以页面事实冻结第 8 页并继续，新增的页面动作全部是
  // 第 8 页之后的 business advance（9 … 21），没有一次回头跳。
  const newJumps = jumps(run).slice(jumpsBefore);
  assert.deepEqual(
    newJumps.map((call) => call[2]),
    Array.from({ length: 13 }, (_, index) => index + 9),
  );
  // business transition 仍然恰好 totalPages - 1 = 20 次，且 7 → 8 只发生过一次。
  assert.equal(run.savedIntents().length, 20);
  assert.equal(
    run.savedIntents().filter((item) => item.currentOperation.pageNo === 7)
      .length,
    1,
  );
  assert.equal(finished.state, run.state.AUTOMATION_STATES.DONE);
  assert.deepEqual(
    finished.completedPages.map((item) => item.pageNo),
    Array.from({ length: 21 }, (_, index) => index + 1),
  );
  // 第 8 页从头处理一次，第 7 页一行都不重复。
  assert.equal(detailArchives(run).filter((call) => call[4] === 7).length, 10);
  assert.equal(detailArchives(run).filter((call) => call[4] === 8).length, 10);
  assert.equal(listArchives(run).length, 21);
  assertInvariant(run, finished);
});

// ---------------------------------------------------------------------------
// 4. pending PAGE_ADVANCE 7 → 8：环境已重建
// ---------------------------------------------------------------------------

test("pending 7 → 8 且环境已重建：重新证明源页，只重新发出一个新的 business transition", async () => {
  const run = await createMultipageHarness({
    totalPages: 21,
    killBefore: ({ next }) => next.currentPage === 8,
    queries: [{ id: "query-7", query_no: 7, query_text: ENTITY }],
  });
  await run.automation.start({
    taskId: executionTask.id,
    projectId: executionTask.project_id,
  });
  await assert.rejects(continueRun(run), /worker killed/);
  run.interrupt();
  const crashed = run.job;
  assert.equal(crashed.currentOperation.type, "PAGE_ADVANCE");
  assert.deepEqual(run.state.deriveResumeTarget(crashed), {
    ok: true,
    targetPage: 7,
  });
  const advancesBefore = run.savedIntents().length;
  assert.equal(advancesBefore, 7);

  // fresh resume：页面必然回到第 1 页，旧 dispatch 的结果完全不可信。
  await resumeRun(run);
  assert.equal(run.list.pageNo, 1);
  const finished = await continueRun(run);

  // 旧 intent 被丢弃（页面事实不可信），只重新发出一个新的 7 → 8：
  // 落盘的 business transition 共 21 次 = 崩溃前 7 次（含被作废的那次 7 → 8）+ 重新发出的 1 次 + 13 次。
  assert.equal(run.savedIntents().length, 21);
  const advances = run
    .savedIntents()
    .map(
      (item) =>
        `${item.currentOperation.pageNo}->${item.currentOperation.targetPage}`,
    );
  assert.equal(advances.filter((value) => value === "7->8").length, 2);
  // 但**不同**的页转换仍然只有 totalPages - 1 = 20 个：重发不新增任何业务进度。
  assert.equal(new Set(advances).size, 20);
  // 第 7 页不重复留痕。
  assert.equal(detailArchives(run).filter((call) => call[4] === 7).length, 10);
  assert.equal(listArchives(run).filter((call) => call[4] === 7).length, 1);
  assert.equal(finished.state, run.state.AUTOMATION_STATES.DONE);
  assertInvariant(run, finished);
});

// ---------------------------------------------------------------------------
// 5. 目标页已经冻结
// ---------------------------------------------------------------------------

test("目标页已冻结（第 8 页刚开始）：直接定位到第 8 页，不重新证明第 7 页", async () => {
  const run = await crashAtSeven(PAGE_EIGHT_FROZEN);
  const crashed = run.job;
  assert.equal(crashed.currentPage, 8);
  assert.deepEqual(
    crashed.completedPages.map((item) => item.pageNo),
    [1, 2, 3, 4, 5, 6, 7],
  );
  assert.deepEqual(
    crashed.pageFrozenKeys,
    rowsOfPage(8).map(run.adapter.buildRowKey),
  );
  assert.deepEqual(crashed.completedDetailKeys, []);
  assert.equal(crashed.listCapture, null);
  assertInvariant(run, crashed);
  assert.deepEqual(run.state.deriveResumeTarget(crashed), {
    ok: true,
    targetPage: 8,
  });

  await resumeRun(run);
  const jumpsBefore = jumps(run).length;
  const finished = await continueRun(run);

  // 恢复之后的页面动作序列：第 1 个就是"直接跳到第 8 页"（locate jump），
  // 之后才是第 8 → … → 21 的 business advance。没有任何"先跳到第 7 页再往后"的动作。
  const newJumps = jumps(run).slice(jumpsBefore);
  assert.deepEqual(
    newJumps.map((call) => call[2]),
    Array.from({ length: 14 }, (_, index) => index + 8),
  );
  // business transition 仍然恰好 totalPages - 1 = 20 次：locate jump 不计入业务进度。
  assert.equal(run.savedIntents().length, 20);
  assert.equal(finished.state, run.state.AUTOMATION_STATES.DONE);
  assert.equal(detailArchives(run).filter((call) => call[4] === 7).length, 10);
  assert.equal(detailArchives(run).filter((call) => call[4] === 8).length, 10);
  assert.equal(listArchives(run).length, 21);
  assertInvariant(run, finished);
});

// ---------------------------------------------------------------------------
// 6. legacy PARTIAL_COMPLETE 2 / 21
// ---------------------------------------------------------------------------

/** 旧版本留下的 PARTIAL_COMPLETE 检查点：连续完整前缀 1..2，仍有剩余页。 */
function legacyPartialJob(run) {
  const pageOneKeys = rowsOfPage(1).map(run.adapter.buildRowKey);
  const pageTwoRows = rowsOfPage(2);
  const pageTwoKeys = pageTwoRows.map(run.adapter.buildRowKey);
  const completedAt = "2026-09-15T07:00:00.000Z";
  return {
    adapter: run.adapter.ZXGK_EXECUTION_ADAPTER,
    state: run.state.AUTOMATION_STATES.PARTIAL_COMPLETE,
    taskId: executionTask.id,
    projectId: executionTask.project_id,
    entityName: ENTITY,
    queryText: ENTITY,
    queryId: "query-7",
    query: { id: "query-7", query_no: 7, query_text: ENTITY },
    topic: executionTask.topic,
    sourceName: executionTask.source_name,
    sourceUrl: executionTask.source_url,
    tabId: 21,
    result: run.state.AUTOMATION_RESULT.HAS_RESULT,
    currentPage: 2,
    totalPages: 21,
    pageFrozenKeys: pageTwoKeys,
    currentPageRows: pageTwoRows,
    pageOneRowKeys: pageOneKeys,
    pageOneRows: rowsOfPage(1),
    expectedDetailCount: 10,
    completedDetailKeys: pageTwoKeys,
    detailCaptures: pageTwoKeys.map((rowKey, index) => ({
      rowKey,
      captureId: `capture-${index + 8}`,
      captureNo: index + 8,
    })),
    listCapture: { id: "capture-7", query_id: "query-7", capture_no: 7 },
    listFilename: `${ENTITY}_执行_中国执行信息公开网_Q07_007_20260915.pdf`,
    currentOperation: null,
    firstPageComplete: null,
    completedPages: [1, 2].map((pageNo) => ({
      pageNo,
      detailCount: 10,
      listCaptureId: pageNo === 1 ? "capture-3" : "capture-7",
      completedAt,
    })),
    resultPage: { pageNo: 2, totalPages: 21, totalSize: 210 },
    updatedAt: completedAt,
  };
}

test("legacy PARTIAL_COMPLETE 2/21：可继续剩余分页核查，第 1–2 页不重复留痕", async () => {
  const run = await createMultipageHarness({
    totalPages: 21,
    // 旧版本已经用掉了编号 3（第 1 页列表）与 7..17（第 2 页列表 + 详情）：
    // 恢复之后的新证据必须从 18 接着编号，既不占用也不重复旧编号。
    captureNoStart: 18,
    queries: [{ id: "query-7", query_no: 7, query_text: ENTITY }],
  });
  const legacy = legacyPartialJob(run);
  run.setJob(legacy);
  assertInvariant(run, legacy);
  assert.equal(run.state.canStartNewAutomation(legacy), false);
  assert.equal(run.state.canResumeAutomation(legacy), true);
  assert.deepEqual(run.state.deriveResumeTarget(legacy), {
    ok: true,
    targetPage: 2,
  });

  await resumeRun(run);
  assert.equal(run.list.pageNo, 1);
  const finished = await continueRun(run);

  assert.equal(finished.state, run.state.AUTOMATION_STATES.DONE);
  assert.equal(finished.currentPage, 21);
  assert.deepEqual(
    finished.completedPages.map((item) => item.pageNo),
    Array.from({ length: 21 }, (_, index) => index + 1),
  );
  // 第 1、2 页不重复留痕：列表归档只发生在第 3–21 页。
  assert.deepEqual(
    listArchives(run).map((call) => call[4]),
    Array.from({ length: 19 }, (_, index) => index + 3),
  );
  assert.deepEqual(
    [...new Set(detailArchives(run).map((call) => call[4]))],
    Array.from({ length: 19 }, (_, index) => index + 3),
  );
  // 定位到第 2 页 1 次 + 业务 advance 2 → 3 .. 20 → 21 共 19 次。
  assert.equal(jumps(run).length, 20);
  assert.deepEqual(
    jumps(run).map((call) => call[2]),
    [2, ...Array.from({ length: 19 }, (_, index) => index + 3)],
  );
  assert.equal(run.savedIntents().length, 19);
  // 预留的 legacy capture_no（3、7..17）一个新证据都没占用：新留痕从 18 起连续编号。
  const captureNos = named(run, "archive").map((call) => call[5]);
  assert.deepEqual(
    captureNos,
    Array.from({ length: 19 * 11 }, (_, index) => index + 18),
  );
  assertInvariant(run, finished);
});

// ---------------------------------------------------------------------------
// 7. fail closed
// ---------------------------------------------------------------------------

test("Page1 边界指纹变化：fresh resume fail closed(RESUME_BOUNDARY_CHANGED)", async () => {
  const run = await crashAtSeven(PAGE_SEVEN_PARTIAL);
  const archivesBefore = named(run, "archive").length;
  const jumpsBefore = jumps(run).length;
  // 网站上第 1 页多了一条：旧 checkpoint 的边界指纹随之失效。
  run.setPage(1, [
    ...rowsOfPage(1),
    { ...rowsOfPage(1)[0], caseNo: "（2026）粤0305执9999号" },
  ]);
  await resumeRun(run);

  await assert.rejects(continueRun(run), /结果集合已变化/);
  assert.equal(run.job.errorCode, "RESUME_BOUNDARY_CHANGED");
  assert.equal(run.state.canResumeAutomation(run.job), false);
  assert.equal(named(run, "archive").length, archivesBefore);
  // 边界证明失败发生在任何跳页动作之前。
  assert.equal(jumps(run).length, jumpsBefore);
});

test("总页数 baseline 变化：fresh resume fail closed(TOTAL_PAGES_CHANGED)", async () => {
  const run = await crashAtSeven(PAGE_SEVEN_PARTIAL);
  const archivesBefore = named(run, "archive").length;
  const jumpsBefore = jumps(run).length;
  run.list.totalPages = 22;
  await resumeRun(run);

  await assert.rejects(continueRun(run), /结果总页数已从 21 变为 22/);
  assert.equal(run.job.errorCode, "TOTAL_PAGES_CHANGED");
  assert.equal(run.state.canResumeAutomation(run.job), false);
  assert.equal(named(run, "archive").length, archivesBefore);
  assert.equal(jumps(run).length, jumpsBefore);
});

test("目标页冻结集合变化：fail closed(RESUME_FROZEN_SET_CHANGED)，不重复留痕", async () => {
  const run = await crashAtSeven(PAGE_SEVEN_PARTIAL);
  const archivesBefore = named(run, "archive").length;
  // 第 7 页的结果集合变了：已冻结的 rowKey 有一个不再存在。
  const mutated = rowsOfPage(7);
  mutated[9] = { ...mutated[9], caseNo: "（2026）粤0305执8888号" };
  run.setPage(7, mutated);
  await resumeRun(run);

  await assert.rejects(continueRun(run), /结果集合已变化/);
  assert.equal(run.job.errorCode, "RESUME_FROZEN_SET_CHANGED");
  assert.equal(run.state.canResumeAutomation(run.job), false);
  assert.equal(named(run, "archive").length, archivesBefore);
});

test("checkpoint 页出现重复身份：fresh resume 就地 fail closed，不重复留痕", async () => {
  const run = await crashAtSeven(PAGE_SEVEN_PARTIAL);
  const archivesBefore = named(run, "archive").length;
  const opensBefore = named(run, "open-detail").length;
  // 第 7 页出现了两条完全相同的结果（冻结集合里已有一条与它同身份）。
  const duplicated = rowsOfPage(7);
  duplicated[9] = { ...duplicated[0], serial: "9" };
  run.setPage(7, duplicated);
  await resumeRun(run);

  // 对账先撞上"重复结果"这一条：重复身份本身就让冻结集合无法可靠对账，因此
  // 走 RESUME_FROZEN_SET_CHANGED 而不是 ADVANCE_ROWS_INVALID（后者是"到达一个新页并
  // 冻结它"时的路径，见正常执行测试的第 4 页重复身份用例）。
  await assert.rejects(continueRun(run), /出现重复结果/);
  assert.equal(run.job.errorCode, "RESUME_FROZEN_SET_CHANGED");
  assert.equal(run.state.canResumeAutomation(run.job), false);
  assert.equal(named(run, "archive").length, archivesBefore);
  // 连一条详情都不许打开：绝不靠行号猜该处理哪一条。
  assert.equal(named(run, "open-detail").length, opensBefore);
});

test("恢复目标页数未知（totalPages 缺失）：fail closed(RESUME_BOUNDARY_MISSING)", async () => {
  const run = await crashAtSeven(PAGE_SEVEN_PARTIAL);
  const archivesBefore = named(run, "archive").length;
  run.setJob({ ...run.job, totalPages: null });
  await resumeRun(run);

  await assert.rejects(continueRun(run), /没有可用的结果总页数 baseline/);
  assert.equal(run.job.errorCode, "RESUME_BOUNDARY_MISSING");
  assert.equal(run.state.canResumeAutomation(run.job), false);
  assert.equal(named(run, "archive").length, archivesBefore);
});

// ---------------------------------------------------------------------------
// 8. 页面顺序变化 / 标签页重建
// ---------------------------------------------------------------------------

test("恢复时页面展示顺序变化但集合一致：仍按原冻结 rowKey 继续，不顺从页面顺序", async () => {
  const run = await crashAtSeven(PAGE_SEVEN_PARTIAL);
  const frozen = [...run.job.pageFrozenKeys];
  run.setPage(7, rowsOfPage(7).reverse());
  await resumeRun(run);
  const finished = await continueRun(run);

  assert.equal(finished.state, run.state.AUTOMATION_STATES.DONE);
  // 第 7 页后 5 条（第 5–10 条）按冻结顺序处理，而不是页面顺序。
  const pageSevenOpens = named(run, "open-detail")
    .filter((call) => call[3] === 7)
    .map((call) => call[1]);
  assert.deepEqual(pageSevenOpens, frozen);
  assertInvariant(run, finished);
});

test("原自动化标签页已关闭：新建标签页后仍能定位到 checkpoint 页并跑完", async () => {
  const run = await crashAtSeven(PAGE_SEVEN_PARTIAL);
  run.closeListTab();
  await resumeRun(run);
  const newTabId = run.job.tabId;
  assert.notEqual(newTabId, 21);
  const finished = await continueRun(run);

  assert.equal(finished.state, run.state.AUTOMATION_STATES.DONE);
  assert.equal(finished.tabId, newTabId);
  assert.equal(listArchives(run).length, 21);
  assert.equal(detailArchives(run).length, 210);
  assertInvariant(run, finished);
});
