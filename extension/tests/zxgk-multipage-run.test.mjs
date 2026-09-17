import test from "node:test";
import assert from "node:assert/strict";
import { cleanupSourceRoot } from "./helpers/source-modules.mjs";
import {
  continueRun,
  detailArchives,
  executionTask,
  jumps,
  listArchives,
  makeRow,
  named,
  rowsOfPage,
  startRun,
} from "./helpers/zxgk-multipage-harness.mjs";

test.after(cleanupSourceRoot);

/**
 * M8.2b Slice 5 —— 通用多页正常执行。
 *
 * 语义：run current page completely → 已到最后一页则 DONE，否则恰好一次
 * business advance → 处理下一页。业务 advance 数 = totalPages - 1。
 */

test("totalPages = 1：第 1 页处理完直接 DONE，不发出任何跳页动作", async () => {
  const run = await startRun({ totalPages: 1 });
  const job = await continueRun(run);

  assert.equal(job.state, run.state.AUTOMATION_STATES.DONE);
  assert.equal(job.currentPage, 1);
  assert.equal(job.totalPages, 1);
  assert.deepEqual(
    job.completedPages.map((item) => item.pageNo),
    [1],
  );
  assert.equal(jumps(run).length, 0);
  assert.equal(listArchives(run).length, 1);
  assert.equal(detailArchives(run).length, 10);
  // 成功终态统一是 DONE：不再产生 legacy 完成标记。
  assert.equal(job.firstPageComplete, null);
  assert.equal(job.currentOperation, null);
  assert.deepEqual(run.workflow.validateZxgkAutomationJobInvariant(job), {
    ok: true,
  });
});

test("totalPages = 2：20 条详情 + 2 份列表 = DONE，业务 advance 恰好 1 次", async () => {
  const run = await startRun({ totalPages: 2 });
  const job = await continueRun(run);

  assert.equal(job.state, run.state.AUTOMATION_STATES.DONE);
  assert.equal(job.currentPage, 2);
  assert.equal(job.totalPages, 2);
  assert.deepEqual(
    job.completedPages.map((item) => item.pageNo),
    [1, 2],
  );
  assert.equal(job.completedPages.length, 2);
  assert.equal(jumps(run).length, 1);
  assert.deepEqual(jumps(run), [["jump", 21, 2]]);
  assert.equal(listArchives(run).length, 2);
  assert.equal(detailArchives(run).length, 20);
  assert.deepEqual(run.workflow.validateZxgkAutomationJobInvariant(job), {
    ok: true,
  });
});

test("totalPages = 3：3 份列表 + 30 条详情 + 2 次业务 advance = DONE", async () => {
  const run = await startRun({ totalPages: 3 });
  const job = await continueRun(run);

  assert.equal(job.state, run.state.AUTOMATION_STATES.DONE);
  assert.equal(job.currentPage, 3);
  assert.equal(job.totalPages, 3);
  assert.deepEqual(
    job.completedPages.map((item) => item.pageNo),
    [1, 2, 3],
  );
  assert.deepEqual(
    jumps(run).map((call) => call[2]),
    [2, 3],
  );
  assert.equal(listArchives(run).length, 3);
  assert.equal(detailArchives(run).length, 30);
  assert.deepEqual(run.workflow.validateZxgkAutomationJobInvariant(job), {
    ok: true,
  });
});

// ---------------------------------------------------------------------------
// 21 页：Design Lock 锁定的计数（21 列表 / 210 详情 / 231 Capture / 20 advance）
// ---------------------------------------------------------------------------

test("totalPages = 21：21 份列表 + 210 条详情 = 231 Capture，业务 advance 恰好 20 次", async () => {
  const run = await startRun({ totalPages: 21 });
  const job = await continueRun(run);

  assert.equal(job.state, run.state.AUTOMATION_STATES.DONE);
  assert.equal(job.currentPage, 21);
  assert.equal(job.totalPages, 21);
  // 业务 advance 数 = totalPages - 1（不是 totalPages）。
  assert.equal(jumps(run).length, 20);
  assert.deepEqual(
    jumps(run).map((call) => call[2]),
    Array.from({ length: 20 }, (_, index) => index + 2),
  );
  assert.equal(listArchives(run).length, 21);
  assert.equal(detailArchives(run).length, 210);
  assert.equal(named(run, "archive").length, 231);
  // 全部 Capture 都属于同一个 canonical Query，编号连续（3..233）且不重复。
  assert.equal(named(run, "create-query").length, 1);
  assert.equal(job.queryId, "query-7");
  assert.deepEqual(
    new Set(named(run, "archive").map((call) => call[1])),
    new Set(["query-7"]),
  );
  const captureNos = named(run, "archive").map((call) => call[5]);
  assert.equal(new Set(captureNos).size, 231);
  assert.deepEqual(
    captureNos,
    Array.from({ length: 231 }, (_, index) => index + 3),
  );
  // completedPages 严格连续覆盖 1..21，每页 10 条详情。
  assert.deepEqual(
    job.completedPages.map((item) => item.pageNo),
    Array.from({ length: 21 }, (_, index) => index + 1),
  );
  assert.deepEqual(
    new Set(job.completedPages.map((item) => item.detailCount)),
    new Set([10]),
  );
  assert.equal(job.currentOperation, null);
  assert.equal(job.firstPageComplete, null);
  assert.deepEqual(run.workflow.validateZxgkAutomationJobInvariant(job), {
    ok: true,
  });
});

test("21 页：每一页都是「先列表留痕、再按冻结顺序逐条详情」，没有跨页乱序", async () => {
  const run = await startRun({ totalPages: 21 });
  await continueRun(run);

  // 归档序列按页分组：list, 10 × detail, list, 10 × detail, ...
  const kinds = named(run, "archive").map((call) => call[3]);
  assert.equal(kinds.length, 231);
  for (let pageNo = 1; pageNo <= 21; pageNo += 1) {
    const offset = (pageNo - 1) * 11;
    assert.deepEqual(kinds.slice(offset, offset + 11), [
      "list",
      ...Array.from({ length: 10 }, () => "detail"),
    ]);
  }
  // 归档的页号顺序严格递增，且每一页的 10 条详情都发生在跳页之前。
  const archivePages = named(run, "archive").map((call) => call[4]);
  assert.deepEqual(
    archivePages,
    archivePages.slice().sort((a, b) => a - b),
  );
  // 详情打开顺序 = 每页冻结顺序拼接。
  assert.deepEqual(
    named(run, "open-detail").map((call) => call[3]),
    Array.from({ length: 21 }, (_, index) => index + 1).flatMap((pageNo) =>
      Array.from({ length: 10 }, () => pageNo),
    ),
  );
  // 每个详情标签页都被关闭。
  assert.equal(named(run, "close-detail").length, 210);
});

test("21 页：业务 advance 意图已落盘、目标页尚未冻结时中断，状态仍然自洽", async () => {
  const run = await startRun({
    totalPages: 21,
    // 精确窗口：第 7 页已经完成、PAGE_ADVANCE(7 → 8) 已落盘，
    // 但"目标页已冻结"的那一次写入之前进程被杀。
    killBefore: ({ next }) => next.currentPage === 8,
  });
  await assert.rejects(continueRun(run), /worker killed/);
  const crashed = run.job;
  // 页坐标仍停在源页，completedPages 已经前移到源页，intent 是唯一未结算操作。
  assert.equal(crashed.currentPage, 7);
  assert.equal(crashed.currentOperation.type, "PAGE_ADVANCE");
  assert.equal(crashed.currentOperation.pageNo, 7);
  assert.equal(crashed.currentOperation.targetPage, 8);
  assert.deepEqual(
    crashed.completedPages.map((item) => item.pageNo),
    [1, 2, 3, 4, 5, 6, 7],
  );
  assert.deepEqual(run.workflow.validateZxgkAutomationJobInvariant(crashed), {
    ok: true,
  });
  // 7 次业务 advance、7 份列表、70 条详情：没有任何重复。
  assert.equal(jumps(run).length, 7);
  assert.equal(listArchives(run).length, 7);
  assert.equal(detailArchives(run).length, 70);
});

// ---------------------------------------------------------------------------
// fail closed：页级重复身份、baseline 变化
// ---------------------------------------------------------------------------

test("页内出现两条完全相同的结果：该页 fail closed，绝不打开该页任何详情", async () => {
  const duplicated = rowsOfPage(4);
  duplicated[1] = { ...duplicated[0], serial: "9" };
  const run = await startRun({
    totalPages: 21,
    rowsForPage: (pageNo) => (pageNo === 4 ? duplicated : rowsOfPage(pageNo)),
  });

  await assert.rejects(continueRun(run), /存在两条身份完全相同的结果/);
  const job = run.job;
  assert.equal(job.state, run.state.AUTOMATION_STATES.FAILED);
  assert.equal(job.errorCode, "ADVANCE_ROWS_INVALID");
  // 只完成了第 1–3 页；第 4 页连列表都没有留痕，详情一条都没打开。
  assert.equal(jumps(run).length, 3);
  assert.equal(listArchives(run).length, 3);
  assert.equal(detailArchives(run).length, 30);
  assert.deepEqual(
    job.completedPages.map((item) => item.pageNo),
    [1, 2, 3],
  );
  assert.equal(job.currentPage, 3);
});

test("跳页后页面自报总页数与 baseline 不一致：fail closed，不留痕该页", async () => {
  const run = await startRun({
    totalPages: 21,
    reportedTotalPages: (pageNo) => (pageNo >= 12 ? 5 : 21),
  });

  await assert.rejects(continueRun(run), /结果总页数已从 21 变为 5/);
  const job = run.job;
  assert.equal(job.state, run.state.AUTOMATION_STATES.FAILED);
  assert.equal(job.errorCode, "TOTAL_PAGES_CHANGED");
  assert.equal(jumps(run).length, 11);
  assert.equal(listArchives(run).length, 11);
  assert.equal(detailArchives(run).length, 110);
  assert.deepEqual(
    job.completedPages.map((item) => item.pageNo),
    Array.from({ length: 11 }, (_, index) => index + 1),
  );
});

// ---------------------------------------------------------------------------
// 跨页身份：同一 rowKey 出现在两页时必须都被留痕（禁止全局去重）
// ---------------------------------------------------------------------------

test("跨页出现同一 rowKey：两个 occurrence 都必须留痕，不做全局去重", async () => {
  // 第 5 页与第 6 页共用完全一样的一行（真实网站可能这样返回）。
  const shared = makeRow({
    caseNo: "（2023）粤0305执9999号",
    filingDate: "2023年9月10日",
    serial: "1",
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
  const sharedDetailArchives = detailArchives(run).filter((call) => {
    const row = run.details.get(call[2]);
    return row?.rowKey === sharedKey;
  });
  // 同一个 rowKey 在两个页面各留痕一次：全局去重会让它只出现一次。
  assert.equal(sharedDetailArchives.length, 2);
  assert.deepEqual(
    sharedDetailArchives.map((call) => call[4]).sort((a, b) => a - b),
    [5, 6],
  );
  assert.equal(listArchives(run).length, 6);
  assert.equal(detailArchives(run).length, 60);
  assert.deepEqual(
    job.completedPages.map((item) => item.pageNo),
    [1, 2, 3, 4, 5, 6],
  );
  assert.deepEqual(run.workflow.validateZxgkAutomationJobInvariant(job), {
    ok: true,
  });
});

test("页内进度是页局部量：进入下一页时已完成详情与留痕记录都被重置", async () => {
  const run = await startRun({
    totalPages: 3,
    // 第 2 页完整跑完之后停在第 3 页的列表留痕之前，观察页内状态。
    killBefore: ({ next }) =>
      next.currentPage === 3 && next.currentOperation?.type === "LIST",
  });
  await assert.rejects(continueRun(run), /worker killed/);
  const crashed = run.job;
  // 第 3 页刚冻结、还没开始留痕：页内状态是空的，历史页只留 summary。
  assert.equal(crashed.currentPage, 3);
  assert.deepEqual(crashed.completedDetailKeys, []);
  assert.deepEqual(crashed.detailCaptures, []);
  assert.equal(crashed.listCapture, null);
  assert.deepEqual(
    crashed.completedPages.map((item) => item.pageNo),
    [1, 2],
  );
  // 历史页 summary 里没有 rows / rowKeys / detailCaptures。
  for (const item of crashed.completedPages)
    assert.deepEqual(Object.keys(item).sort(), [
      "completedAt",
      "detailCount",
      "listCaptureId",
      "pageNo",
    ]);
  assert.deepEqual(run.workflow.validateZxgkAutomationJobInvariant(crashed), {
    ok: true,
  });
  // 第 1 页的边界指纹在整个过程中保持原样（D1）。
  assert.deepEqual(
    crashed.pageOneRowKeys,
    rowsOfPage(1).map(run.adapter.buildRowKey),
  );
});

test("返回列表后的复核只认当前页冻结集合，不读上一页的行键", async () => {
  const run = await startRun({ totalPages: 8 });
  await continueRun(run);
  // 每一次详情之后的复核（read-list）都发生在当期页；页号严格递增且不回头。
  const pages = named(run, "read-list").map((call) => call[2]);
  assert.deepEqual(
    pages,
    pages.slice().sort((a, b) => a - b),
  );
  assert.deepEqual(
    [...new Set(pages)],
    Array.from({ length: 8 }, (_, index) => index + 1),
  );
  assert.deepEqual(run.workflow.validateZxgkAutomationJobInvariant(run.job), {
    ok: true,
  });
});

test("未知页数（totalPages = null）：fail closed，绝不猜末页", async () => {
  const run = await startRun({ totalPages: 21 });
  // 页面自报不出总页数：既不能证明还有后续页，也不能证明已到最后一页。
  run.dependencies.readResultPage = async (tabId) => {
    run.calls.push(["read-list", tabId, run.list.pageNo]);
    return {
      ok: true,
      rows: rowsOfPage(run.list.pageNo),
      page: {
        input: run.list.pageNo,
        shown: run.list.pageNo,
        totalPages: null,
        totalSize: null,
        pagerVisible: true,
      },
      resultVisible: true,
      verification: { failed: false, evidence: null },
    };
  };
  await assert.rejects(continueRun(run), /总页数尚未建立 baseline/);
  assert.equal(run.job.state, run.state.AUTOMATION_STATES.FAILED);
  assert.equal(jumps(run).length, 0);
  assert.equal(listArchives(run).length, 1);
});

test("同一进程内重复调用不会重复留痕：任务终止后再次 continue 只 fail closed", async () => {
  const run = await startRun({ totalPages: 2 });
  const done = await continueRun(run);
  assert.equal(done.state, run.state.AUTOMATION_STATES.DONE);
  const archives = named(run, "archive").length;
  const jumpCount = jumps(run).length;

  await assert.rejects(continueRun(run), /不能继续检查结果/);
  assert.equal(named(run, "archive").length, archives);
  assert.equal(jumps(run).length, jumpCount);
  assert.equal(run.job.state, run.state.AUTOMATION_STATES.FAILED);
});

test("worker 重启扫描：DONE 是多页成功终态，不是中断态", async () => {
  const run = await startRun({ totalPages: 3 });
  const job = await continueRun(run);
  assert.equal(job.state, run.state.AUTOMATION_STATES.DONE);
  assert.equal(run.state.isAutomationRunning(job), false);
  assert.equal(run.state.canStartNewAutomation(job), true);
  assert.equal(run.state.canResumeAutomation(job), false);
  // 多页 DONE 仍然停在最后一页、连续覆盖全部页、没有未结算操作。
  assert.equal(job.currentPage, job.totalPages);
  assert.equal(job.completedPages.length, job.totalPages);
  assert.equal(job.currentOperation, null);
  assert.equal(executionTask.id, job.taskId);
});
