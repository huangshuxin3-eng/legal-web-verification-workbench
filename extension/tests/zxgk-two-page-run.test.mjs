import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanupSourceRoot,
  loadSourceModule,
} from "./helpers/source-modules.mjs";

test.after(cleanupSourceRoot);

const ENTITY = "上海某某科技有限公司";

const executionTask = {
  id: "task-execution",
  project_id: "project-1",
  entity_name: ENTITY,
  topic: "执行",
  source_name: "中国执行信息公开网",
  source_url: "https://zxgk.court.gov.cn/",
};

const listUrl = "https://zxgk.court.gov.cn/gkw/html/zhzxgk/index.html";
const detailUrl = "https://zxgk.court.gov.cn/gkw/html/zhzxgk/detail.html";

async function modules() {
  const state = await loadSourceModule("lib/automation-state.mjs");
  const adapter = await loadSourceModule("adapters/zxgk-execution.mjs");
  const workflow = await loadSourceModule("lib/zxgk-automation.mjs");
  return { state, adapter, workflow };
}

const rowOf = (serial, caseNo, filingDate) => ({
  serial: String(serial),
  name: "某某集团有限公司",
  caseNo,
  filingDate,
  label: "查看",
});

/** 每页 3 条。页内序号跨页必然重复，因此只能靠 rowKey 建立身份。 */
const rowsOfPage = (pageNo, count = 3) =>
  Array.from({ length: count }, (_, index) =>
    rowOf(
      index + 1,
      `（2023）粤0305执${pageNo}${String(index + 1).padStart(2, "0")}号`,
      `2023年${(index % 9) + 1}月10日`,
    ),
  );

const keysOf = (adapter, rows) => rows.map(adapter.buildRowKey);

/**
 * 两页执行桩：列表标签页真实地"停在"某一页，jumpToPage 是**唯一**能改变它的动作。
 *
 * 它只描述标签页与页面事实（停在哪一页、总页数、该页结果集合），不复制 worker 的
 * 任何实现，也不替 orchestration 决定该不该翻页——是否进入第 2 页只能由
 * zxgk-automation 的控制流决定。
 */
async function harness(options = {}) {
  const { state, adapter, workflow } = await modules();
  const calls = [];
  const states = [];
  const savedJobs = [];
  const openedUrls = [];

  const pages = new Map([
    [1, (options.pageOneRows || rowsOfPage(1)).map((row) => ({ ...row }))],
    [2, (options.pageTwoRows || rowsOfPage(2)).map((row) => ({ ...row }))],
  ]);
  const list = { pageNo: 1, totalPages: options.totalPages ?? 21 };
  const rowsOnList = () =>
    (pages.get(list.pageNo) || []).map((row) => ({ ...row }));
  // 页面自报的总页数独立于 runtime baseline：用来验证 baseline 变化仍被 fail closed。
  const reportedTotalPages = (pageNo) =>
    options.reportedTotalPages
      ? options.reportedTotalPages(pageNo)
      : list.totalPages;

  const queries = [];
  const details = new Map();
  const listTabIds = new Set([21]);
  const closedTabIds = new Set();

  let job = null;
  let nextQueryNo = 7;
  let nextCaptureNo = 3;
  let nextTabId = 900;
  let clock = Date.parse("2026-09-15T08:00:00.000Z");
  // 模拟 worker 进程被杀：这一次写入丢失，且之后的所有写入都消失。
  let killed = false;
  let killNextWrite = false;
  let killArmed = true;

  const dependencies = {
    now: () => new Date(clock),
    getTask: async () => ({ ...executionTask }),
    getActiveTab: async () => ({ id: 21, url: "https://example.com/" }),
    getTab: async (tabId) => {
      if (closedTabIds.has(tabId)) return null;
      if (listTabIds.has(tabId)) return { id: tabId, url: listUrl };
      if (details.has(tabId)) return { id: tabId, url: detailUrl };
      return null;
    },
    createTab: async () => {
      const id = nextTabId++;
      listTabIds.add(id);
      calls.push(["create-tab", id]);
      return { id, url: listUrl };
    },
    getJob: async () => job,
    saveJob: async (next) => {
      const killNow =
        killed ||
        killNextWrite ||
        (killArmed && options.killBefore?.({ next, current: job }));
      if (killNow) {
        killed = true;
        killNextWrite = false;
        killArmed = false;
        throw new Error("worker killed");
      }
      job = next;
      states.push(next.state);
      savedJobs.push(next);
      return next;
    },
    openQueryPage: async (tabId, currentUrl, options = {}) => {
      calls.push(["open", tabId]);
      openedUrls.push({ tabId, currentUrl });
      // force=true 对应 worker 的真实行为：真正重新加载查询入口。
      // 页面事实：查询按钮绑定 submitCaptcha()，它会先 initCurrentPage() 再 search()，
      // 因此重建环境之后页面必然回到第 1 页——fresh resume 必须据此重新证明。
      if (options?.force === true) list.pageNo = 1;
    },
    fillEntity: async (tabId, value) => {
      calls.push(["fill", tabId, value]);
      return { ok: true };
    },
    submitQuery: async (tabId) => {
      calls.push(["submit", tabId]);
      return { ok: true };
    },
    // Slice 4B：提交后必须先观察到安全验证组件进入可操作状态（默认真人 READY 样本）。
    readVerificationAvailability: async (tabId) => {
      calls.push(["read-verification", tabId]);
      const override = options.verificationAvailability?.();
      if (override) return override;
      return {
        ok: true,
        overlayPresent: true,
        parentPresent: true,
        loadingPresent: false,
        loadingVisible: false,
        rootPresent: true,
        statusText: null,
        failureEvidence: null,
      };
    },
    inspectResult: async () => {
      calls.push(["inspect"]);
      return state.AUTOMATION_RESULT.HAS_RESULT;
    },
    listTaskQueries: async () => queries.map((row) => ({ ...row })),
    getQuery: async (queryId) => {
      const row = queries.find((item) => item.id === queryId);
      return row ? { ...row } : null;
    },
    createQuery: async (taskId, queryText) => {
      const queryNo = nextQueryNo++;
      const query = {
        id: `query-${queryNo}`,
        task_id: taskId,
        query_no: queryNo,
        query_text: queryText,
        created_at: `2026-09-15T00:0${queryNo}:00.000Z`,
      };
      queries.push(query);
      calls.push(["create-query", query.id, queryText]);
      return { ...query };
    },
    archiveQuery: async (queryId, tabId) => {
      const kind = listTabIds.has(tabId) ? "list" : "detail";
      const capture = {
        id: `capture-${nextCaptureNo}`,
        query_id: queryId,
        capture_no: nextCaptureNo,
      };
      nextCaptureNo += 1;
      calls.push(["archive", queryId, tabId, kind]);
      // 最窄的窗口：Capture 已在数据库里 finalize 成功（编号已消耗），
      // 但紧接着的那次状态写入之前进程被杀。同样只触发一次。
      if (kind === "list" && options.killAfterListArchive && killArmed) {
        killArmed = false;
        killNextWrite = true;
      }
      return {
        capture,
        filename: `${ENTITY}_执行_中国执行信息公开网_Q07_${String(
          capture.capture_no,
        ).padStart(3, "0")}_20260915.pdf`,
      };
    },
    readResultPage: async (tabId) => {
      calls.push(["read-list", tabId, list.pageNo]);
      if (!listTabIds.has(tabId)) throw new Error("不是结果列表标签页");
      const total = reportedTotalPages(list.pageNo);
      return {
        ok: true,
        rows: rowsOnList(),
        page: {
          input: list.pageNo,
          shown: list.pageNo,
          totalPages: total,
          totalSize: total * 3,
          pagerVisible: true,
        },
        resultVisible: true,
        // 正常结果页：没有任何“验证失败”证据。
        verification: { failed: false, evidence: null },
      };
    },
    jumpToPage: async (tabId, targetPage) => {
      calls.push(["jump", tabId, targetPage]);
      const custom = options.jump?.({ targetPage, list });
      if (custom) return custom;
      // 默认：动作真实生效，列表页落在目标页。
      list.pageNo = targetPage;
      return { ok: true };
    },
    sleep: async () => {
      // 页面事实不会自己变化；只推进虚拟时钟，让观察循环最终能到 deadline。
      clock += 250;
    },
    openDetail: async (tabId, rowKey) => {
      const row = (pages.get(list.pageNo) || []).find(
        (item) => adapter.buildRowKey(item) === rowKey,
      );
      calls.push(["open-detail", rowKey, row?.caseNo ?? null]);
      if (!row) throw new Error("结果列表中已找不到该条结果，未打开详情。");
      const detailTabId = nextTabId++;
      details.set(detailTabId, {
        rowKey,
        caseNo: row.caseNo,
        name: row.name,
        closed: false,
      });
      return { detailTabId, url: detailUrl };
    },
    readDetailIdentity: async (detailTabId) => {
      const entry = details.get(detailTabId);
      calls.push(["read-detail", detailTabId]);
      if (!entry || entry.closed) return { ok: false, closed: true };
      return {
        ok: true,
        errorText: "",
        rowCount: 3,
        caseNumbers: [entry.caseNo],
        names: [entry.name],
        bodyText: `${entry.name}案号${entry.caseNo}`,
      };
    },
    closeDetail: async (detailTabId, listTabId) => {
      calls.push(["close-detail", detailTabId, listTabId]);
      const entry = details.get(detailTabId);
      if (entry) entry.closed = true;
    },
  };

  return {
    calls,
    states,
    savedJobs,
    openedUrls,
    state,
    adapter,
    list,
    pages,
    details,
    get job() {
      return job;
    },
    /**
     * 模拟扩展重启：进程重新可用，并按 worker 的启动扫描把"运行中但已中断"
     * 的状态标记为 FAILED（已生成的进度原样保留）。
     */
    interrupt() {
      killed = false;
      killNextWrite = false;
      if (!state.AUTOMATION_INTERRUPTED_STATES.includes(job?.state)) return job;
      job = {
        ...job,
        state: state.AUTOMATION_STATES.FAILED,
        error:
          "扩展后台在自动操作期间中断，无法确认上一步是否完成。已生成的 Query 与留痕全部保留，可在 Side Panel 中「继续本次核查」。",
        updatedAt: new Date("2026-09-15T08:05:00.000Z").toISOString(),
      };
      return job;
    },
    automation: workflow.createZxgkAutomation(dependencies),
    dependencies,
  };
}

const named = (run, name) => run.calls.filter((call) => call[0] === name);
const listArchives = (run) =>
  named(run, "archive").filter((call) => call[3] === "list");
const detailArchives = (run) =>
  named(run, "archive").filter((call) => call[3] === "detail");
const jumps = (run) => named(run, "jump");

async function startRun(options = {}) {
  const run = await harness(options);
  await run.automation.start({
    taskId: executionTask.id,
    projectId: executionTask.project_id,
  });
  return run;
}

const continueRun = (run) =>
  run.automation.continueAfterVerification({ taskId: executionTask.id });

// ---------------------------------------------------------------------------
// 1. 两页执行主链路：第 1 页 → 一次跳页 → 第 2 页 → PARTIAL_COMPLETE
// ---------------------------------------------------------------------------

test("两页执行：第 1 页 → 唯一一次跳页 → 第 2 页 → PARTIAL_COMPLETE，绝不到第 3 页", async () => {
  const { state, adapter } = await modules();
  const run = await startRun({ totalPages: 21 });
  const job = await continueRun(run);

  const pageOneKeys = keysOf(adapter, rowsOfPage(1));
  const pageTwoKeys = keysOf(adapter, rowsOfPage(2));

  // 终态：连续页前缀 1..2 已完整处理，但网站还有后续页 —— 这是正常停止，不是错误。
  assert.equal(job.state, state.AUTOMATION_STATES.PARTIAL_COMPLETE);
  assert.equal(job.currentPage, 2);
  assert.equal(job.totalPages, 21);
  assert.deepEqual(
    job.completedPages.map((item) => item.pageNo),
    [1, 2],
  );
  assert.equal(job.currentOperation, null);
  assert.equal(job.firstPageComplete, null);
  assert.equal(state.isAutomationRunning(job), false);
  assert.equal(state.canStartNewAutomation(job), false);
  assert.equal(state.canRecheckAutomation(job), false);

  // 一次 transition 只发出一次跳页动作，目标就是第 2 页。
  assert.deepEqual(jumps(run), [["jump", 21, 2]]);
  assert.equal(run.list.pageNo, 2);
  // 页面从未被读取过第 3 页：控制流里没有第二个跳页点，结构上到不了下一页。
  assert.deepEqual(
    [...new Set(named(run, "read-list").map((call) => call[2]))].sort(),
    [1, 2],
  );
  assert.equal(run.states.includes("ADVANCING_PAGE"), true);

  // 两页共用同一个 canonical Query，全部 Capture 都属于它。
  assert.equal(named(run, "create-query").length, 1);
  assert.equal(job.queryId, "query-7");
  assert.deepEqual(
    named(run, "archive").map(([, queryId]) => queryId),
    [
      "query-7",
      "query-7",
      "query-7",
      "query-7",
      "query-7",
      "query-7",
      "query-7",
      "query-7",
    ],
  );
  // 顺序：第 1 页列表 → 第 1 页 3 条详情 → 第 2 页列表 → 第 2 页 3 条详情。
  assert.deepEqual(
    named(run, "archive").map((call) => `${call[3]}:${call[2]}`),
    [
      "list:21",
      "detail:900",
      "detail:901",
      "detail:902",
      "list:21",
      "detail:903",
      "detail:904",
      "detail:905",
    ],
  );
  assert.deepEqual(
    named(run, "open-detail").map(([, rowKey]) => rowKey),
    [...pageOneKeys, ...pageTwoKeys],
  );
  assert.equal(listArchives(run).length, 2);
  assert.equal(detailArchives(run).length, 6);
  assert.equal(named(run, "close-detail").length, 6);
  // 第 2 页的当前页状态：冻结集合与完成进度都换成第 2 页自己的。
  assert.deepEqual(job.completedDetailKeys, pageTwoKeys);
  assert.equal(job.expectedDetailCount, 3);
  assert.equal(job.pageFrozenKeys.length, 3);
  assert.equal(job.listCapture.capture_no, 7);
});

// ---------------------------------------------------------------------------
// 2. 第 2 页的顺序：列表先留痕，再逐条详情；两者都只发生一次
// ---------------------------------------------------------------------------

test("第 2 页：先留痕列表再逐条详情，列表只归档一次、详情不留痕在列表之前", async () => {
  const { adapter } = await modules();
  const run = await startRun({ totalPages: 21 });
  const job = await continueRun(run);

  const jumpIndex = run.calls.findIndex((call) => call[0] === "jump");
  const afterJump = run.calls
    .map((call, index) => ({ call, index }))
    .filter(({ call, index }) => call[0] === "archive" && index > jumpIndex);
  assert.deepEqual(
    afterJump.map(({ call }) => call[3]),
    ["list", "detail", "detail", "detail"],
  );
  // 第 1 页的列表在跳页之前，且两页各自只归档一次列表。
  assert.equal(listArchives(run).length, 2);
  assert.ok(run.calls.indexOf(listArchives(run)[0]) < jumpIndex);
  // 第 2 页列表留痕拿到的编号紧随第 1 页的 3 条详情之后。
  assert.equal(job.listCapture.capture_no, 7);
  assert.deepEqual(
    job.detailCaptures.map((item) => item.captureNo),
    [8, 9, 10],
  );
  assert.deepEqual(
    job.detailCaptures.map((item) => item.caseNo),
    rowsOfPage(2).map((row) => row.caseNo),
  );
  // 第 2 页冻结集合是它与第 1 页唯一的身份区别（页内序号重复）。
  assert.notDeepEqual(job.pageFrozenKeys, keysOf(adapter, rowsOfPage(1)));
  assert.deepEqual(job.pageFrozenKeys, keysOf(adapter, rowsOfPage(2)));
  // 每一页的完成摘要都记在自己那一页上。
  assert.deepEqual(
    job.completedPages.map((item) => item.detailCount),
    [3, 3],
  );
  assert.equal(job.completedPages[0].listCaptureId, "capture-3");
  assert.equal(job.completedPages[1].listCaptureId, "capture-7");
});

// ---------------------------------------------------------------------------
// 3. 第 2 页就是最后一页 → DONE（不是 PARTIAL_COMPLETE）
// ---------------------------------------------------------------------------

test("totalPages = 2：第 2 页处理完是 DONE，仍然只跳页一次", async () => {
  const { state } = await modules();
  const run = await startRun({ totalPages: 2 });
  const job = await continueRun(run);

  assert.equal(job.state, state.AUTOMATION_STATES.DONE);
  assert.notEqual(job.state, state.AUTOMATION_STATES.PARTIAL_COMPLETE);
  assert.equal(job.currentPage, 2);
  assert.equal(job.totalPages, 2);
  assert.deepEqual(
    job.completedPages.map((item) => item.pageNo),
    [1, 2],
  );
  assert.deepEqual(jumps(run), [["jump", 21, 2]]);
  assert.equal(listArchives(run).length, 2);
  assert.equal(detailArchives(run).length, 6);
});

// ---------------------------------------------------------------------------
// 4. 第 2 页出现重复身份 → fail closed，绝不猜测
// ---------------------------------------------------------------------------

test("第 2 页存在两条完全相同的结果：不进入第 2 页详情，也不留痕第 2 页列表", async () => {
  const { state } = await modules();
  const duplicated = rowsOfPage(2);
  duplicated[1] = { ...duplicated[0], serial: "9" };
  const run = await startRun({ totalPages: 21, pageTwoRows: duplicated });

  await assert.rejects(continueRun(run), /存在两条完全相同的结果/);
  const job = run.job;
  assert.equal(job.state, state.AUTOMATION_STATES.FAILED);
  assert.equal(job.errorCode, "ADVANCE_ROWS_INVALID");
  // 失败前只处理完了第 1 页；第 2 页一行都没有被打开，也没有第 2 页列表留痕。
  assert.equal(jumps(run).length, 1);
  assert.equal(named(run, "open-detail").length, 3);
  assert.equal(listArchives(run).length, 1);
  assert.equal(detailArchives(run).length, 3);
  assert.equal(job.currentPage, 1);
  assert.deepEqual(
    job.completedPages.map((item) => item.pageNo),
    [1],
  );
});

// ---------------------------------------------------------------------------
// 5. 结果总页数 baseline 变化 → fail closed
// ---------------------------------------------------------------------------

test("跳页后页面自报总页数与 baseline 不一致：fail closed，不留痕第 2 页", async () => {
  const { state } = await modules();
  const run = await startRun({
    totalPages: 21,
    reportedTotalPages: (pageNo) => (pageNo === 2 ? 5 : 21),
  });

  await assert.rejects(continueRun(run), /结果总页数已从 21 变为 5/);
  const job = run.job;
  assert.equal(job.state, state.AUTOMATION_STATES.FAILED);
  assert.equal(job.errorCode, "TOTAL_PAGES_CHANGED");
  assert.equal(jumps(run).length, 1);
  assert.equal(listArchives(run).length, 1);
  assert.equal(named(run, "open-detail").length, 3);
  assert.deepEqual(
    job.completedPages.map((item) => item.pageNo),
    [1],
  );
});

// ---------------------------------------------------------------------------
// 6. 崩溃 / 中断窗口：第 2 页的证据绝不重复生成
// ---------------------------------------------------------------------------

test("第 2 页列表留痕 finalize 成功但尚未补记时中断：列表不重复留痕，且检查点可恢复", async () => {
  const { state } = await modules();
  const run = await startRun({
    totalPages: 21,
    // 精确窗口：第 2 页列表 Capture 已经在数据库 finalize 成功（编号 7 已消耗），
    // 但在"写 listCapture 收尾"的那一次写入之前进程被杀。
    killBefore: ({ next }) =>
      next.currentPage === 2 && next.listCapture?.capture_no === 7,
  });

  await assert.rejects(continueRun(run), /worker killed/);
  const crashed = run.job;
  assert.equal(crashed.listCapture, null);
  assert.equal(crashed.currentOperation.type, "LIST");
  assert.equal(crashed.currentOperation.pageNo, 2);
  assert.equal(crashed.currentOperation.captureId, "capture-7");
  // 全程只归档过两次列表（第 1 页、第 2 页各一次），没有重复。
  assert.equal(listArchives(run).length, 2);
  assert.equal(detailArchives(run).length, 3);
  assert.equal(jumps(run).length, 1);

  // 中断当场还不是 PAUSED/FAILED，因此不提供「继续本次核查」。
  assert.equal(
    state.AUTOMATION_INTERRUPTED_STATES.includes(crashed.state),
    true,
  );
  assert.equal(state.canResumeAutomation(crashed), false);
  run.interrupt();
  assert.equal(run.job.state, state.AUTOMATION_STATES.FAILED);
  // Slice 4B：第 2 页的 checkpoint（第 1 页已完成、第 2 页列表 Capture 已成功）
  // 属于批准的 fresh resume 范围，因此必须给出「继续本次核查」。
  assert.equal(state.canResumeAutomation(run.job), true);
  assert.equal(
    state.deriveResumeTarget(run.job).targetPage,
    2,
    "恢复目标是第 2 页",
  );
  assert.equal(state.canRecheckAutomation(run.job), false);
  // 中断只改状态，不产生任何新的网站动作或留痕。
  assert.equal(listArchives(run).length, 2);
});

test("第 2 页详情 Capture 已成功但进度尚未落盘时中断：证据只生成一次", async () => {
  const { state, adapter } = await modules();
  const pageTwoKeys = keysOf(adapter, rowsOfPage(2));
  const run = await startRun({
    totalPages: 21,
    // 精确窗口：第 2 页第 1 条详情的 Capture 已成功，但"记为已完成"那一次写入之前被杀。
    killBefore: ({ next }) =>
      next.state === "VERIFYING_LIST_STATE" &&
      next.currentPage === 2 &&
      next.currentOperation?.type === "DETAIL" &&
      Boolean(next.currentOperation?.captureId),
  });

  await assert.rejects(continueRun(run), /worker killed/);
  const crashed = run.job;
  // 成功证据已经落盘：Capture 编号、留痕记录都在，且完成进度还没记。
  // 进入第 2 页时上一页的 detailCaptures 已被清空，因此这里只应剩第 2 页这一条。
  assert.equal(crashed.state, state.AUTOMATION_STATES.RETURNING_TO_LIST);
  assert.equal(crashed.currentOperation.captureId, "capture-8");
  assert.equal(crashed.detailCaptures.length, 1);
  assert.equal(crashed.detailCaptures[0].rowKey, pageTwoKeys[0]);
  assert.equal(crashed.completedDetailKeys.includes(pageTwoKeys[0]), false);
  // 第 2 页列表 1 次 + 第 2 页详情 1 次；没有任何重复留痕。
  assert.equal(listArchives(run).length, 2);
  assert.equal(detailArchives(run).length, 4);
  assert.equal(
    detailArchives(run).filter(([, , tabId]) => tabId === 903).length,
    1,
  );
  assert.equal(state.canResumeAutomation(crashed), false);
});

// ---------------------------------------------------------------------------
// 7. 新一轮核查：不继承上一轮的第 2 页坐标
// ---------------------------------------------------------------------------

test("上一轮停在第 2 页后重新开始：页运行态被清空，且绝不把第 2 页当成第 1 页", async () => {
  const { state } = await modules();
  const run = await startRun({ totalPages: 21 });
  await continueRun(run);
  assert.equal(run.list.pageNo, 2);

  // 重新开始：显式重置页运行态，不再依赖"下一轮从第 1 页开始"的隐含假设。
  await run.automation.start({
    taskId: executionTask.id,
    projectId: executionTask.project_id,
  });
  const started = run.job;
  assert.equal(started.currentPage, 1);
  assert.equal(started.totalPages, null);
  assert.deepEqual(started.completedPages, []);
  assert.equal(started.pageFrozenKeys, null);
  assert.equal(started.currentPageRows, null);
  assert.equal(started.pageOneRowKeys, null);
  assert.equal(started.expectedDetailCount, null);
  assert.equal(started.listCapture, null);
  assert.equal(started.resultPage, null);
  // 上一轮第 2 页的冻结集合没有以任何形式残留下来。
  const opened = run.savedJobs.find(
    (item) => item.state === state.AUTOMATION_STATES.OPENING_QUERY_PAGE,
  );
  assert.equal(opened.pageFrozenKeys, null);
  assert.deepEqual(opened.completedPages, []);
  assert.equal(opened.currentPage, 1);

  // 重建环境时查询入口被真正重新加载，页面事实是回到第 1 页：新核查从第 1 页开始，
  // 上一轮第 2 页的结果绝不会被当成第 1 页处理。
  const archivesBefore = named(run, "archive").length;
  const jumpsBefore = jumps(run).length;
  const finished = await continueRun(run);
  assert.equal(finished.state, state.AUTOMATION_STATES.PARTIAL_COMPLETE);
  // 新一轮重新跑完两页：8 条新留痕 + 1 次新跳页（而不是复用上一轮第 2 页的 checkpoint）。
  assert.equal(named(run, "archive").length, archivesBefore + 8);
  assert.equal(jumps(run).length, jumpsBefore + 1);
});

// ---------------------------------------------------------------------------
// 8. PARTIAL_COMPLETE 不是"假的运行中"：没有继续/重新自动核查入口
// ---------------------------------------------------------------------------

test("PARTIAL_COMPLETE 触达继续入口只会 fail closed，不产生任何新留痕与跳页", async () => {
  const { state } = await modules();
  const run = await startRun({ totalPages: 21 });
  const partial = await continueRun(run);
  assert.equal(partial.state, state.AUTOMATION_STATES.PARTIAL_COMPLETE);
  assert.equal(state.isAutomationRunning(partial), false);
  assert.equal(state.canStartNewAutomation(partial), false);
  assert.equal(state.canRecheckAutomation(partial), false);

  const archives = named(run, "archive").length;
  const details = named(run, "open-detail").length;
  await assert.rejects(continueRun(run), /不能继续检查结果/);
  assert.equal(run.job.state, state.AUTOMATION_STATES.FAILED);
  assert.equal(named(run, "archive").length, archives);
  assert.equal(named(run, "open-detail").length, details);
  assert.equal(jumps(run).length, 1);
});

// ---------------------------------------------------------------------------
// 9. Durable resume（M8.2b Slice 4B）：重建环境后回到检查点所在页
// ---------------------------------------------------------------------------

/** 中断在第 2 页列表 Capture 已成功、但尚未补记的那一次写入之前。 */
const pageTwoListCrash = {
  killBefore: ({ next }) =>
    next.currentPage === 2 && next.listCapture?.capture_no === 7,
};

test("fresh resume：重建环境后回到第 2 页，只补记已有留痕、绝不重复", async () => {
  const { state } = await modules();
  const run = await startRun({ totalPages: 21, ...pageTwoListCrash });
  await assert.rejects(continueRun(run), /worker killed/);
  run.interrupt();

  const crashed = run.job;
  assert.equal(state.canResumeAutomation(crashed), true);
  assert.equal(state.deriveResumeTarget(crashed).targetPage, 2);
  // 中断时：第 1 页 1 列表 + 3 详情，第 2 页只有那一次"未补记"的列表留痕。
  assert.equal(listArchives(run).length, 2);
  assert.equal(detailArchives(run).length, 3);

  // 重建环境：worker 真正重新加载查询入口，页面事实是回到第 1 页。
  const rebuilt = await run.automation.resume({ taskId: executionTask.id });
  assert.equal(run.list.pageNo, 1);
  assert.equal(
    rebuilt.state,
    state.AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION,
  );

  const finished = await continueRun(run);

  // 第 2 页的列表留痕只补记（同一个 capture_no），绝不重复归档。
  assert.equal(listArchives(run).length, 2);
  assert.equal(finished.listCapture.capture_no, 7);
  // 第 1 页也没有重跑：只有第 2 页那 3 条详情是新增留痕。
  assert.equal(detailArchives(run).length, 6);
  assert.equal(finished.state, state.AUTOMATION_STATES.PARTIAL_COMPLETE);
  assert.equal(finished.currentPage, 2);
  // 全程两次跳页动作都指向第 2 页，结构上不可能进入第 3 页。
  assert.deepEqual(jumps(run), [
    ["jump", 21, 2],
    ["jump", 21, 2],
  ]);
});

test("fresh resume：第 1 页结果集合已经变化 → PAUSED(RESUME_BOUNDARY_CHANGED)", async () => {
  const { state } = await modules();
  const run = await startRun({ totalPages: 21, ...pageTwoListCrash });
  await assert.rejects(continueRun(run), /worker killed/);
  run.interrupt();
  // 网站上第 1 页结果集多了一条：旧 checkpoint 的边界指纹随之失效。
  run.pages.set(1, [
    ...rowsOfPage(1),
    rowOf(4, "（2026）粤0305执9999号", "2026年1月1日"),
  ]);
  await run.automation.resume({ taskId: executionTask.id });

  const archives = named(run, "archive").length;
  const jumpsBefore = jumps(run).length;
  await assert.rejects(continueRun(run), /结果集合已变化/);

  assert.equal(run.job.errorCode, "RESUME_BOUNDARY_CHANGED");
  assert.equal(state.canResumeAutomation(run.job), false);
  assert.equal(named(run, "archive").length, archives);
  assert.equal(jumps(run).length, jumpsBefore);
});

test("fresh resume：网站自报总页数已经变化 → PAUSED(TOTAL_PAGES_CHANGED)", async () => {
  const { state } = await modules();
  const run = await startRun({ totalPages: 21, ...pageTwoListCrash });
  await assert.rejects(continueRun(run), /worker killed/);
  run.interrupt();
  run.list.totalPages = 22;
  await run.automation.resume({ taskId: executionTask.id });

  const archives = named(run, "archive").length;
  await assert.rejects(continueRun(run), /结果总页数已从 21 变为 22/);

  assert.equal(run.job.errorCode, "TOTAL_PAGES_CHANGED");
  assert.equal(state.canResumeAutomation(run.job), false);
  assert.equal(named(run, "archive").length, archives);
  assert.equal(jumps(run).length, 1);
});

test("same environment：页面自己证明仍是 persisted 第 2 页 → 就地继续，不重发跳页", async () => {
  const { state } = await modules();
  const run = await startRun({ totalPages: 21, ...pageTwoListCrash });
  await assert.rejects(continueRun(run), /worker killed/);
  run.interrupt();
  // 经「继续本次核查」回到人工交接点：环境已重建，Query 与 checkpoint 不变。
  await run.automation.resume({ taskId: executionTask.id });

  // 第一次「重新检查结果」：页面还没呈现可确认的结果 → PAUSED + result UNKNOWN。
  run.dependencies.inspectResult = async () => {
    run.calls.push(["inspect-after-human"]);
    return state.AUTOMATION_RESULT.UNKNOWN;
  };
  const unknown = await continueRun(run);
  assert.equal(unknown.state, state.AUTOMATION_STATES.PAUSED);
  assert.equal(state.canRecheckAutomation(unknown), true);

  // 人工在页面上重新完成验证，页面正好停在 persisted 的第 2 页。
  run.dependencies.inspectResult = async () => {
    run.calls.push(["inspect-after-human"]);
    return state.AUTOMATION_RESULT.HAS_RESULT;
  };
  run.list.pageNo = 2;

  const jumpsBefore = jumps(run).length;
  const finished = await continueRun(run);

  // 页面事实与 checkpoint 完全一致 → 就地继续，绝不重发跳页、绝不重复留痕。
  assert.equal(jumps(run).length, jumpsBefore);
  assert.equal(listArchives(run).length, 2);
  assert.equal(detailArchives(run).length, 6);
  assert.equal(finished.state, state.AUTOMATION_STATES.PARTIAL_COMPLETE);
  assert.equal(finished.listCapture.capture_no, 7);
});

test("same environment：页面与 checkpoint 不一致时不猜页，交回重建流程", async () => {
  const { state } = await modules();
  const run = await startRun({ totalPages: 21, ...pageTwoListCrash });
  await assert.rejects(continueRun(run), /worker killed/);
  run.interrupt();
  await run.automation.resume({ taskId: executionTask.id });
  // 页面在第 1 页，但记录里的当前页是第 2 页：same environment 判据不成立，
  // 因此必须走 fresh 分支重新证明第 1 页，而不是把第 1 页当成第 2 页。
  assert.equal(run.list.pageNo, 1);
  const jumpsBefore = jumps(run).length;
  const finished = await continueRun(run);
  // 重新证明第 1 页 → 重新跳一次 → 第 2 页。
  assert.equal(jumps(run).length, jumpsBefore + 1);
  assert.equal(finished.state, state.AUTOMATION_STATES.PARTIAL_COMPLETE);
  assert.equal(finished.currentPage, 2);
  assert.equal(listArchives(run).length, 2);
  assert.equal(detailArchives(run).length, 6);
});

test("Case B：跳页意图已落盘但页面已到第 2 页 → 以真实事实就地冻结，绝不重发动作", async () => {
  const { state } = await modules();
  // 只跳过"意图那次写入"，让中断落在意图已落盘、到达尚未落盘的窗口。
  let intentSeen = false;
  const run = await startRun({
    totalPages: 21,
    killBefore: ({ next }) => {
      if (next.currentOperation?.type === "PAGE_ADVANCE") {
        intentSeen = true;
        return false;
      }
      return intentSeen;
    },
  });
  await assert.rejects(continueRun(run), /worker killed/);
  run.interrupt();

  const crashed = run.job;
  assert.equal(crashed.currentOperation.type, "PAGE_ADVANCE");
  // 页坐标还停在源页，但旧环境里的跳页其实已经生效。
  assert.equal(crashed.currentPage, 1);
  assert.equal(state.canResumeAutomation(crashed), true);
  assert.equal(state.deriveResumeTarget(crashed).targetPage, 1);

  await run.automation.resume({ taskId: executionTask.id });
  // Case B 考查的是"页面已经到了目标页、记录还不知道"这一事实组合。
  // 页面是怎么到达这里的与本判定无关，因此这里直接把页面放回第 2 页。
  run.list.pageNo = 2;

  const jumpsBefore = jumps(run).length;
  const finished = await continueRun(run);

  // 不重发跳页：直接以页面事实冻结第 2 页并继续。
  assert.equal(jumps(run).length, jumpsBefore);
  assert.equal(finished.state, state.AUTOMATION_STATES.PARTIAL_COMPLETE);
  assert.equal(finished.currentPage, 2);
  assert.equal(listArchives(run).length, 2);
  assert.equal(detailArchives(run).length, 6);
});

test("Case B：意图已落盘但页面仍停在源页 → 重新证明后重新跳页一次", async () => {
  const { state } = await modules();
  let intentSeen = false;
  const run = await startRun({
    totalPages: 21,
    killBefore: ({ next }) => {
      if (next.currentOperation?.type === "PAGE_ADVANCE") {
        intentSeen = true;
        return false;
      }
      return intentSeen;
    },
  });
  await assert.rejects(continueRun(run), /worker killed/);
  run.interrupt();
  assert.equal(state.canResumeAutomation(run.job), true);

  // 重建环境之后页面回到第 1 页：这正是 Case B 的另一个分支。
  await run.automation.resume({ taskId: executionTask.id });
  assert.equal(run.list.pageNo, 1);

  const finished = await continueRun(run);

  // 先重新证明第 1 页，然后才重新发出恰好一次跳页动作。
  assert.equal(run.list.pageNo, 2);
  assert.equal(finished.state, state.AUTOMATION_STATES.PARTIAL_COMPLETE);
  assert.deepEqual(
    jumps(run).map((call) => call[2]),
    [2, 2],
  );
  assert.equal(listArchives(run).length, 2);
  assert.equal(detailArchives(run).length, 6);
});
