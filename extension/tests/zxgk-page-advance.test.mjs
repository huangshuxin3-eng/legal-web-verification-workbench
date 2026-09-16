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
  return { state, adapter, workflow };
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

/** 页快照：input 是输入框值，shown 是页面自报的当前页。 */
const pageSnapshot = (pageNo, totalPages, rows = rowsOfPage(pageNo)) => ({
  ok: true,
  rows,
  page: {
    input: pageNo,
    shown: pageNo,
    totalPages,
    totalSize: totalPages * 10,
    pagerVisible: true,
  },
  resultVisible: true,
  // 正常结果页：没有任何“验证失败”证据。
  verification: { failed: false, evidence: null },
});

/** 页面自己写下验证失败提示时的快照：页坐标可能仍残留着源页的值。 */
const verificationSnapshot = (
  pageNo,
  totalPages,
  evidence = "验证码错误或验证码已过期。",
) => ({
  ...pageSnapshot(pageNo, totalPages),
  verification: { failed: true, evidence },
});

const summary = (pageNo, detailCount = 10) => ({
  pageNo,
  detailCount,
  listCaptureId: `capture-list-${pageNo}`,
  completedAt: "2026-09-15T07:00:00.000Z",
});

/**
 * 一个已经 PAGE_COMPLETE、可以推进到下一页的页模型 job。
 * 默认停在「第 1 页已完成、准备离开」这一形态（等价于 STEP 2 落盘后的形状）。
 */
function completePageJob(state, adapter, patch = {}) {
  const pageNo = Number.isInteger(patch.currentPage) ? patch.currentPage : 1;
  const rows = rowsOfPage(pageNo);
  const keys = keysOf(adapter, rows);
  return {
    adapter: adapter.ZXGK_EXECUTION_ADAPTER,
    state: state.AUTOMATION_STATES.ADVANCING_PAGE,
    taskId: "task-execution",
    projectId: "project-1",
    queryText: ENTITY,
    queryId: "query-7",
    result: state.AUTOMATION_RESULT.HAS_RESULT,
    currentPage: pageNo,
    totalPages: 21,
    resultPage: { pageNo, totalPages: 21, totalSize: 210 },
    currentPageRows: rows,
    pageFrozenKeys: keys,
    expectedDetailCount: keys.length,
    completedDetailKeys: [...keys],
    detailCaptures: keys.map((rowKey, index) => ({
      rowKey,
      captureId: `capture-${index + 4}`,
    })),
    listCapture: {
      id: `capture-list-${pageNo}`,
      query_id: "query-7",
      capture_no: 3,
    },
    listFilename: `${ENTITY}_执行_中国执行信息公开网_Q07_003_20260915.pdf`,
    currentOperation: null,
    firstPageComplete: null,
    completedPages: [summary(pageNo)],
    error: null,
    errorCode: null,
    ...patch,
  };
}

/**
 * advancePage 的桩：只描述页面事实（停在哪一页、总页数、结果集合），
 * 以及是否让跳页动作“生效”。它不复制 worker 的任何实现。
 */
function advanceHarness(workflow, state, adapter, baseJob, options = {}) {
  const clock = { ms: Date.parse("2026-09-15T08:00:00.000Z") };
  const calls = [];
  const savedJobs = [];
  // 页坐标从 normalize 视图取：legacy job 只有 firstPageComplete.totalPages。
  const normalized = state.normalizeAutomationJob(baseJob);
  const list = {
    pageNo: options.startPageNo ?? normalized.currentPage ?? 1,
    totalPages:
      options.totalPages === undefined
        ? normalized.totalPages
        : options.totalPages,
  };
  let job = null;
  const dependencies = {
    now: () => new Date(clock.ms),
    saveJob: async (next) => {
      job = next;
      savedJobs.push(next);
      calls.push(["save", next.state]);
      return next;
    },
    readResultPage: async () => {
      calls.push(["read", list.pageNo]);
      if (options.readPage)
        return options.readPage({ pageNo: list.pageNo, list, calls });
      return pageSnapshot(list.pageNo, list.totalPages);
    },
    jumpToPage: async (tabId, targetPage) => {
      calls.push(["jump", targetPage]);
      const custom = options.jump?.({ targetPage, list, calls });
      if (custom) return custom;
      // 默认：动作真实生效，页面落在目标页。
      list.pageNo = targetPage;
      return { ok: true };
    },
    sleep: async (ms) => {
      calls.push(["sleep", ms]);
      clock.ms += ms;
    },
    inspectResult: async () => {
      calls.push(["inspect"]);
      const custom = options.inspectResult?.();
      if (custom instanceof Error) throw custom;
      if (custom) return custom;
      return state.AUTOMATION_RESULT.HAS_RESULT;
    },
  };
  // 缺少跳页 primitive 是“不发出任何动作”的一条前置条件，单独构造。
  if (options.omitJump) delete dependencies.jumpToPage;

  const jumpCalls = () => calls.filter(([name]) => name === "jump");
  const savedStates = () => calls.filter(([name]) => name === "save");
  return {
    calls,
    savedJobs,
    list,
    jumpCalls,
    savedStates,
    get job() {
      return job;
    },
    automation: workflow.createZxgkAutomation(dependencies),
  };
}

/** 捕获 advancePage 抛出的错误（协议永远以抛错结束失败路径）。 */
async function failure(run) {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

// ---------------------------------------------------------------------------
// A. 前置条件：任何一项不成立都不发出网站动作，也不写任何状态
// ---------------------------------------------------------------------------

test("A. 前置条件：页未完成 / 已到末页 / 完成记录缺失 / 操作未结算 都不跳页", async () => {
  const { state, adapter, workflow } = await modules();

  const cases = [
    {
      title: "源页仍有未处理的结果",
      job: completePageJob(state, adapter, {
        completedDetailKeys: keysOf(adapter, rowsOfPage(1)).slice(0, 9),
      }),
    },
    {
      title: "当前已是最后一页",
      job: completePageJob(state, adapter, {
        currentPage: 1,
        totalPages: 1,
        resultPage: { pageNo: 1, totalPages: 1, totalSize: 10 },
      }),
    },
    {
      title: "结果总页数尚未建立 baseline",
      job: completePageJob(state, adapter, { totalPages: null }),
    },
    {
      title: "完成记录与页坐标不一致",
      job: completePageJob(state, adapter, {
        currentPage: 2,
        completedPages: [],
      }),
    },
    {
      title: "仍有未结算的操作",
      job: completePageJob(state, adapter, {
        currentOperation: {
          type: "LIST",
          pageNo: 1,
          rowKey: null,
          caseNo: null,
          phase: state.AUTOMATION_PHASES.CAPTURING,
        },
      }),
    },
  ];

  for (const item of cases) {
    const run = advanceHarness(workflow, state, adapter, item.job);
    const error = await failure(() => run.automation.advancePage(item.job));
    assert.ok(error, `${item.title}：必须抛错停下`);
    assert.equal(run.jumpCalls().length, 0, `${item.title}：不得发出跳页动作`);
    assert.equal(run.savedStates().length, 0, `${item.title}：不得写任何状态`);
    assert.equal(run.job, null, `${item.title}：不得落盘`);
  }
});

test("A. 前置条件：缺少跳页 primitive 时不发出任何动作", async () => {
  const { state, adapter, workflow } = await modules();
  const job = completePageJob(state, adapter);
  const run = advanceHarness(workflow, state, adapter, job, { omitJump: true });

  const error = await failure(() => run.automation.advancePage(job));
  assert.ok(error);
  assert.deepEqual(run.calls, []);
  assert.equal(run.job, null);
});

// ---------------------------------------------------------------------------
// B. 正常路径：第 N 页 → 第 N+1 页
// ---------------------------------------------------------------------------

test("B. 正常路径：第 1 页完成 → 到达第 2 页并冻结目标页", async () => {
  const { state, adapter, workflow } = await modules();
  const job = completePageJob(state, adapter);
  const run = advanceHarness(workflow, state, adapter, job);

  const result = await run.automation.advancePage(job);

  // 只发出一次动作，且动作发生在 intent 落盘之后。
  assert.equal(run.jumpCalls().length, 1);
  assert.deepEqual(run.jumpCalls()[0], ["jump", 2]);
  const intentIndex = run.calls.findIndex(
    ([name, value]) => name === "save" && value === "ADVANCING_PAGE",
  );
  const jumpIndex = run.calls.findIndex(([name]) => name === "jump");
  assert.ok(intentIndex >= 0 && intentIndex < jumpIndex);

  // STEP 2 的落盘必须同时带“源页已完成”与“跳页 intent”。
  const intentJob = run.savedJobs.find(
    (item) => item.state === state.AUTOMATION_STATES.ADVANCING_PAGE,
  );
  assert.ok(intentJob, "必须先落盘 ADVANCING_PAGE 的跳页 intent");
  assert.deepEqual(intentJob.completedPages, [summary(1)]);
  assert.equal(intentJob.currentOperation.type, "PAGE_ADVANCE");
  assert.equal(intentJob.currentOperation.pageNo, 1);
  assert.equal(intentJob.currentOperation.targetPage, 2);
  assert.equal(intentJob.currentOperation.attempt, 1);
  assert.equal(intentJob.firstPageComplete, null);

  // 成功只由页面事实决定：目标页已冻结，且不再持有任何列表留痕。
  assert.equal(result.state, state.AUTOMATION_STATES.READING_RESULT_ROWS);
  assert.equal(result.currentPage, 2);
  assert.equal(result.totalPages, 21);
  assert.equal(result.resultPage.pageNo, 2);
  assert.equal(result.resultPage.totalPages, 21);
  assert.deepEqual(result.pageFrozenKeys, keysOf(adapter, rowsOfPage(2)));
  assert.deepEqual(result.currentPageRows, rowsOfPage(2));
  assert.equal(result.expectedDetailCount, 10);
  assert.deepEqual(result.completedDetailKeys, []);
  assert.deepEqual(result.detailCaptures, []);
  assert.equal(result.listCapture, null);
  assert.equal(result.listFilename, null);
  assert.equal(result.currentOperation, null);
  assert.equal(result.firstPageComplete, null);

  // 历史页只留最小 summary，并且从第 1 页起严格连续。
  assert.equal(result.completedPages.length, 1);
  assert.deepEqual(Object.keys(result.completedPages[0]).sort(), [
    "completedAt",
    "detailCount",
    "listCaptureId",
    "pageNo",
  ]);
  assert.equal(result.completedPages[0].detailCount, 10);
  assert.equal(result.completedPages[0].listCaptureId, "capture-list-1");
  // 源页的 rows / rowKeys 不进入历史页摘要。
  assert.equal(result.completedPages[0].rows, undefined);
  assert.equal(result.completedPages[0].rowKeys, undefined);

  // 落盘后的 job 仍然满足全部 invariant。
  assert.deepEqual(workflow.validateZxgkAutomationJobInvariant(result), {
    ok: true,
  });
});

test("B. 正常路径：第 2 页完成 → 第 3 页，历史摘要累计且不重复 append", async () => {
  const { state, adapter, workflow } = await modules();
  const job = completePageJob(state, adapter, {
    currentPage: 2,
    resultPage: { pageNo: 2, totalPages: 21, totalSize: 210 },
    completedPages: [summary(1), summary(2)],
  });
  const run = advanceHarness(workflow, state, adapter, job, { startPageNo: 2 });

  const result = await run.automation.advancePage(job);

  assert.equal(run.jumpCalls().length, 1);
  assert.deepEqual(run.jumpCalls()[0], ["jump", 3]);
  assert.equal(result.currentPage, 3);
  assert.deepEqual(
    result.completedPages.map((item) => item.pageNo),
    [1, 2],
  );
  assert.deepEqual(result.pageFrozenKeys, keysOf(adapter, rowsOfPage(3)));
  assert.deepEqual(workflow.validateZxgkAutomationJobInvariant(result), {
    ok: true,
  });
});

// ---------------------------------------------------------------------------
// C. 结果总页数不再是 baseline：fail closed，绝不推进
// ---------------------------------------------------------------------------

test("C. totalPages 变化（22 / 20 / null）一律 PAUSED，进度保留且只发一次动作", async () => {
  const { state, adapter, workflow } = await modules();

  for (const observed of [22, 20, null]) {
    const job = completePageJob(state, adapter);
    const run = advanceHarness(workflow, state, adapter, job, {
      totalPages: observed,
    });

    const error = await failure(() => run.automation.advancePage(job));
    assert.ok(error, `observed=${observed}：必须停下`);

    const paused = run.savedJobs.at(-1);
    assert.equal(paused.state, state.AUTOMATION_STATES.PAUSED);
    assert.equal(paused.errorCode, "TOTAL_PAGES_CHANGED");
    // 停在源页，且目标页从未被冻结。
    assert.equal(paused.currentPage, 1);
    assert.deepEqual(paused.completedPages, [summary(1)]);
    assert.equal(paused.listCapture.id, "capture-list-1");
    // 只发出一次动作：绝不因为结果集变化而重试。
    assert.equal(run.jumpCalls().length, 1);
  }
});

// ---------------------------------------------------------------------------
// D. 跳页后落在错误的页：fail closed，不纠正、不重发
// ---------------------------------------------------------------------------

test("D. 跳页后停在错误的页 → PAUSED(PAGE_ADVANCE_WRONG_PAGE)，不重发", async () => {
  const { state, adapter, workflow } = await modules();
  const job = completePageJob(state, adapter);
  const run = advanceHarness(workflow, state, adapter, job, {
    jump: ({ list }) => {
      list.pageNo = 3;
      return { ok: true };
    },
  });

  await failure(() => run.automation.advancePage(job));

  const paused = run.savedJobs.at(-1);
  assert.equal(paused.state, state.AUTOMATION_STATES.PAUSED);
  assert.equal(paused.errorCode, "PAGE_ADVANCE_WRONG_PAGE");
  assert.equal(paused.currentPage, 1);
  assert.equal(run.jumpCalls().length, 1);
  assert.match(paused.error, /不会再次发出跳页动作/);
});

// ---------------------------------------------------------------------------
// E. 源页在 deadline 内始终不变：动作未生效（普通页快照 ≠ 验证失效）
// ---------------------------------------------------------------------------

test("E. 源页快照一直轮询到 deadline → PAUSED(PAGE_ADVANCE_TIMEOUT)，不误判 verification", async () => {
  const { state, adapter, workflow } = await modules();
  const job = completePageJob(state, adapter);
  const run = advanceHarness(workflow, state, adapter, job, {
    // 动作发出去了，但页面从未翻页：每次读取都是“正常的源页快照”。
    jump: () => ({ ok: true }),
  });

  await failure(() => run.automation.advancePage(job));

  const paused = run.savedJobs.at(-1);
  assert.equal(paused.state, state.AUTOMATION_STATES.PAUSED);
  assert.equal(paused.errorCode, "PAGE_ADVANCE_TIMEOUT");
  // AJAX 请求飞行期间的真实表现就是源页快照；绝不能把它升级成“需要人工验证”。
  assert.notEqual(paused.errorCode, "PAGE_ADVANCE_REQUIRES_VERIFICATION");
  assert.equal(run.jumpCalls().length, 1);
  assert.ok(
    run.calls.filter(([name]) => name === "read").length > 1,
    "必须经过观察循环而不是立即放弃",
  );
  const sleeps = run.calls.filter(([name]) => name === "sleep");
  assert.ok(sleeps.length >= 1);
  assert.equal(sleeps[0][1], 250);
});

// ---------------------------------------------------------------------------
// E2. 可读但页信号不完整：既不是失败也不是验证失效，只观察到 deadline
// ---------------------------------------------------------------------------

test("E2. 页信号不完整（可读但无法确认）→ 观察到 deadline 后 TIMEOUT，不猜成验证", async () => {
  const { state, adapter, workflow } = await modules();
  const job = completePageJob(state, adapter);
  const run = advanceHarness(workflow, state, adapter, job, {
    jump: () => ({ ok: true }),
    // 页面结构异常但依然可读：既没有验证失败的证据，也没有目标页的事实。
    readPage: ({ list }) => ({
      ok: true,
      rows: rowsOfPage(list.pageNo),
      page: {
        input: null,
        shown: null,
        totalPages: 21,
        totalSize: 210,
        pagerVisible: true,
      },
      resultVisible: true,
      verification: { failed: false, evidence: null },
    }),
  });

  await failure(() => run.automation.advancePage(job));

  const paused = run.savedJobs.at(-1);
  assert.equal(paused.state, state.AUTOMATION_STATES.PAUSED);
  // 可读的页面不会被当成“读取失败”，也不会被当成验证失效。
  assert.equal(paused.errorCode, "PAGE_ADVANCE_TIMEOUT");
  assert.notEqual(paused.errorCode, "PAGE_ADVANCE_READ_FAILED");
  assert.notEqual(paused.errorCode, "PAGE_ADVANCE_REQUIRES_VERIFICATION");
  assert.equal(run.jumpCalls().length, 1);
});

// ---------------------------------------------------------------------------
// F. 验证失效只能被页面证据证明；读取异常不得被猜成验证码问题
// ---------------------------------------------------------------------------

test("F. 页面明确报告验证失败 → PAUSED(PAGE_ADVANCE_REQUIRES_VERIFICATION)，不判 NO_RESULT", async () => {
  const { state, adapter, workflow } = await modules();
  const job = completePageJob(state, adapter);
  const run = advanceHarness(workflow, state, adapter, job, {
    jump: () => ({ ok: true }),
    // 验证失败时页坐标往往仍残留着源页的值，不得据此继续观察。
    readPage: () => verificationSnapshot(1, 21),
  });

  const error = await failure(() => run.automation.advancePage(job));
  assert.ok(error);

  const paused = run.savedJobs.at(-1);
  assert.equal(paused.state, state.AUTOMATION_STATES.PAUSED);
  assert.equal(paused.errorCode, "PAGE_ADVANCE_REQUIRES_VERIFICATION");
  // 绝不把“验证失效”写成“本次核查无结果”。
  assert.notEqual(paused.result, state.AUTOMATION_RESULT.NO_RESULT);
  assert.equal(paused.currentPage, 1);
  // 已经证明需要人工验证，不必等到 deadline。
  assert.equal(run.calls.filter(([name]) => name === "sleep").length, 0);
  assert.equal(run.jumpCalls().length, 1);
});

test("F. 读取异常无法归类 → PAUSED(PAGE_ADVANCE_READ_FAILED)，不是 REQUIRES_VERIFICATION", async () => {
  const { state, adapter, workflow } = await modules();

  const variants = [
    {
      title: "标签页已被关闭",
      readPage: () => {
        throw new Error("综合查询结果标签页已关闭，自动核查已停止。");
      },
      diagnostic: "综合查询结果标签页已关闭",
    },
    {
      title: "页面注入 / 依赖异常",
      readPage: () => {
        throw new Error("页面操作超时。");
      },
      diagnostic: "页面操作超时。",
    },
    {
      title: "没有拿到快照",
      readPage: () => undefined,
      diagnostic: "未读到结果页快照",
    },
  ];

  for (const variant of variants) {
    const job = completePageJob(state, adapter);
    const run = advanceHarness(workflow, state, adapter, job, {
      jump: () => ({ ok: true }),
      // 即使页面分类返回 UNKNOWN，也不能影响异常归类。
      inspectResult: () => state.AUTOMATION_RESULT.UNKNOWN,
      readPage: variant.readPage,
    });

    const error = await failure(() => run.automation.advancePage(job));
    assert.ok(error, variant.title);

    const paused = run.savedJobs.at(-1);
    assert.equal(paused.state, state.AUTOMATION_STATES.PAUSED, variant.title);
    assert.equal(paused.errorCode, "PAGE_ADVANCE_READ_FAILED", variant.title);
    assert.notEqual(
      paused.errorCode,
      "PAGE_ADVANCE_REQUIRES_VERIFICATION",
      variant.title,
    );
    // 文案只说“无法确认页面状态”，绝不告诉用户一定是验证码问题。
    assert.match(paused.error, /分页后无法确认结果页面状态/, variant.title);
    assert.doesNotMatch(paused.error, /验证码|验证失败/, variant.title);
    // 保留原始 error 的安全诊断信息。
    assert.ok(paused.error.includes(variant.diagnostic), variant.title);
    // 用户数据语义不变：不得写成“无结果”。
    assert.notEqual(paused.result, state.AUTOMATION_RESULT.NO_RESULT);
    assert.equal(paused.currentPage, 1, variant.title);
    // 读取失败也绝不重发动作：整个 transition 只发过一次跳页。
    assert.equal(run.jumpCalls().length, 1, variant.title);
  }
});

// ---------------------------------------------------------------------------
// G. 崩溃窗口：settlePendingPageAdvance 的纯判定
// ---------------------------------------------------------------------------

function pendingJob(state, adapter, patch = {}) {
  return {
    ...completePageJob(state, adapter),
    currentOperation: {
      type: "PAGE_ADVANCE",
      pageNo: 1,
      targetPage: 2,
      attempt: 1,
      phase: state.AUTOMATION_PHASES.LOCATING,
    },
    ...patch,
  };
}

test("G. settlePendingPageAdvance：到达目标页才算 SETTLED", async () => {
  const { state, adapter, workflow } = await modules();
  const job = pendingJob(state, adapter);
  const snapshot = JSON.parse(JSON.stringify(job));

  const settled = workflow.settlePendingPageAdvance(job, pageSnapshot(2, 21));
  assert.equal(settled.outcome, "SETTLED");
  assert.equal(settled.sourcePage, 1);
  assert.equal(settled.targetPage, 2);
  assert.deepEqual(settled.keys, keysOf(adapter, rowsOfPage(2)));
  assert.deepEqual(settled.rows, rowsOfPage(2));

  // 纯函数：不 mutate job。
  assert.deepEqual(job, snapshot);
});

test("G. settlePendingPageAdvance：仍停在源页或页信号不完整都是 PENDING", async () => {
  const { state, adapter, workflow } = await modules();
  const job = pendingJob(state, adapter);

  assert.equal(
    workflow.settlePendingPageAdvance(job, pageSnapshot(1, 21)).outcome,
    "PENDING",
  );
  // input 已变、shown 未变：飞行中，既不算到达也不算失败。
  const flying = pageSnapshot(2, 21);
  flying.page = { ...flying.page, shown: 1 };
  assert.equal(
    workflow.settlePendingPageAdvance(job, flying).outcome,
    "PENDING",
  );
  assert.equal(
    workflow.settlePendingPageAdvance(job, {
      ok: true,
      rows: [],
      page: { input: null, shown: null, totalPages: 21 },
      resultVisible: true,
    }).outcome,
    "PENDING",
  );
});

test("G. settlePendingPageAdvance：落在别的页 / 总页数变化 / 目标页不可冻结都 FAILED", async () => {
  const { state, adapter, workflow } = await modules();
  const job = pendingJob(state, adapter);

  const wrong = workflow.settlePendingPageAdvance(job, pageSnapshot(3, 21));
  assert.equal(wrong.outcome, "FAILED");
  assert.equal(wrong.code, "PAGE_ADVANCE_WRONG_PAGE");

  const changed = workflow.settlePendingPageAdvance(job, pageSnapshot(2, 22));
  assert.equal(changed.outcome, "FAILED");
  assert.equal(changed.code, "TOTAL_PAGES_CHANGED");

  // 目标页两条结果无法区分：宁可停下，也不靠行号猜。
  const duplicated = rowsOfPage(2);
  duplicated[1] = { ...duplicated[0] };
  const invalid = workflow.settlePendingPageAdvance(
    job,
    pageSnapshot(2, 21, duplicated),
  );
  assert.equal(invalid.outcome, "FAILED");
  assert.equal(invalid.code, "PAGE_ADVANCE_ROWS_INVALID");
});

test("G. settlePendingPageAdvance：没有 pending 时不得凭空判定", async () => {
  const { state, adapter, workflow } = await modules();
  const job = completePageJob(state, adapter);

  const none = workflow.settlePendingPageAdvance(job, pageSnapshot(2, 21));
  assert.equal(none.outcome, "FAILED");
  assert.equal(none.code, "NO_PAGE_ADVANCE_PENDING");
});

test("G. settlePendingPageAdvance：验证失败的页面证据优先于页坐标（宁可暂停也不猜）", async () => {
  const { state, adapter, workflow } = await modules();
  const job = pendingJob(state, adapter);
  const before = JSON.parse(JSON.stringify(job));

  // 页坐标看起来还停在源页，但页面自己报告了验证失败：绝不能继续等待。
  const onSource = workflow.settlePendingPageAdvance(
    job,
    verificationSnapshot(1, 21),
  );
  assert.equal(onSource.outcome, "FAILED");
  assert.equal(onSource.code, "PAGE_ADVANCE_REQUIRES_VERIFICATION");
  assert.match(onSource.error, /验证码错误或验证码已过期/);

  // 页坐标看起来已经到达目标页，但同一份快照同时报告验证失败：
  // 矛盾事实不得被当成成功。
  const contradictory = workflow.settlePendingPageAdvance(
    job,
    verificationSnapshot(2, 21),
  );
  assert.equal(contradictory.outcome, "FAILED");
  assert.equal(contradictory.code, "PAGE_ADVANCE_REQUIRES_VERIFICATION");

  // 没有证据就绝不猜：快照缺失仍然只是 PENDING。
  assert.equal(workflow.settlePendingPageAdvance(job, null).outcome, "PENDING");

  // 纯函数：任何分支都不 mutate job。
  assert.deepEqual(job, before);
});

// ---------------------------------------------------------------------------
// H. pageCompleteness：最小泛化，只认直接事实
// ---------------------------------------------------------------------------

test("H. pageCompleteness：只用页坐标 / 冻结集合 / 详情进度 / 列表留痕", async () => {
  const { state, adapter, workflow } = await modules();
  const base = completePageJob(state, adapter, {
    state: state.AUTOMATION_STATES.PAUSED,
  });
  const keys = keysOf(adapter, rowsOfPage(1));

  assert.deepEqual(workflow.pageCompleteness(base, 1), { ok: true });

  const rejects = [
    { patch: { currentPage: 2 }, pageNo: 2 },
    { patch: { pageFrozenKeys: [] }, pageNo: 1 },
    { patch: { pageFrozenKeys: [keys[0], keys[0]] }, pageNo: 1 },
    { patch: { expectedDetailCount: 9 }, pageNo: 1 },
    {
      patch: { completedDetailKeys: [...keys.slice(0, 9), keys[0]] },
      pageNo: 1,
    },
    { patch: { completedDetailKeys: keys.slice(0, 9) }, pageNo: 1 },
    { patch: { listCapture: null }, pageNo: 1 },
    {
      patch: {
        currentOperation: {
          type: "LIST",
          pageNo: 1,
          rowKey: null,
          caseNo: null,
          phase: state.AUTOMATION_PHASES.CAPTURING,
        },
      },
      pageNo: 1,
    },
    { patch: { resultPage: { pageNo: 2, totalPages: 21 } }, pageNo: 1 },
  ];
  for (const item of rejects) {
    const verdict = workflow.pageCompleteness(
      { ...base, ...item.patch },
      item.pageNo,
    );
    assert.equal(verdict.ok, false, JSON.stringify(item.patch));
    assert.ok(verdict.reason);
  }

  // “Capture 已 finalize、尚未补记”的窗口：列表留痕算已生成，但操作仍未结算，
  // 因此这一页在补记之前不算 PAGE_COMPLETE（必须先结算，才谈得上离开这一页）。
  const recovering = workflow.pageCompleteness(
    {
      ...base,
      listCapture: null,
      currentOperation: {
        type: "LIST",
        pageNo: 1,
        rowKey: null,
        caseNo: null,
        phase: state.AUTOMATION_PHASES.CAPTURING,
        captureId: "capture-list-1",
      },
    },
    1,
  );
  assert.equal(recovering.ok, false);
  assert.match(recovering.reason, /未结束的操作/);
  // hasListCapture 仍然把这一窗口算作“已留痕”：补记完成后再判就是 PAGE_COMPLETE。
  assert.equal(
    state.hasListCapture({
      listCapture: null,
      currentOperation: { type: "LIST", captureId: "capture-list-1" },
    }),
    true,
  );
});

test("H. pageCompleteness 不依赖“分组控件是否禁用”，也不用计数代替集合覆盖", async () => {
  const workflow = await readFile(
    new URL("../src/lib/zxgk-automation.mjs", import.meta.url),
    "utf8",
  );
  const start = workflow.indexOf("export function pageCompleteness");
  const end = workflow.indexOf("/** 跳页观察的失败结果");
  const body = workflow.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(body, /nextDisabled|disabled/);
  assert.doesNotMatch(body, /#next-btn|#currentPage|querySelector/);
  // 覆盖关系只能由集合差集表达，不用“Capture 数量 === 11”。
  assert.match(body, /keys\.filter\(\(key\) => !completed\.includes\(key\)\)/);
});

// ---------------------------------------------------------------------------
// I. 架构守卫：协议在 orchestration，网站事实在 adapter
// ---------------------------------------------------------------------------

test("I. 每个 transition 只发一次跳页动作，且没有任何生产路径自动翻页", async () => {
  const [workflow, worker, stateSource] = await Promise.all([
    readFile(
      new URL("../src/lib/zxgk-automation.mjs", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/worker.mjs", import.meta.url), "utf8"),
    readFile(
      new URL("../src/lib/automation-state.mjs", import.meta.url),
      "utf8",
    ),
  ]);

  // 网站事实依旧只允许存在于 adapter。
  for (const source of [workflow, stateSource]) {
    assert.doesNotMatch(source, /#currentPage|#totalPage-show|#totalSize-show/);
    assert.doesNotMatch(source, /#next-btn|#last-btn|#pre-btn|#goto/);
    assert.doesNotMatch(source, /goPage|nextPage|prePage|lastPage|下一页|尾页/);
    assert.doesNotMatch(source, /querySelector|window\.search/);
    // 页面表达式只能由 adapter 生成。
    assert.doesNotMatch(source, /jumpToPageExpression|resultRowsExpression/);
  }
  // state 层完全不知道“跳页”这件事。
  assert.doesNotMatch(stateSource, /jumpToPage|PAGE_ADVANCE/);

  // orchestration 只消费注入的 primitive：dispatch 调用点有且只有一个。
  assert.equal((workflow.match(/dependencies\.jumpToPage\(/g) || []).length, 1);
  // advancePage 只被定义与导出，没有任何生产路径调用它。
  assert.equal((workflow.match(/advancePage\(/g) || []).length, 1);
  const continueBody = workflow.slice(
    workflow.indexOf("async function continueAfterVerification"),
    workflow.indexOf(
      "return { start, resume, continueAfterVerification, advancePage };",
    ),
  );
  assert.ok(continueBody.length > 0);
  assert.doesNotMatch(continueBody, /advancePage|jumpToPage|ADVANCING_PAGE/);

  // worker 只把 adapter 的 primitive 注入标签页，自己不持有 selector。
  assert.match(worker, /jumpToPageExpression/);
  assert.match(worker, /async function jumpToPage\(tabId, targetPage\) \{/);
  assert.match(worker, /jumpToPageExpression\(targetPage\)/);
  assert.doesNotMatch(worker, /#currentPage|#totalPage-show/);
});

// ---------------------------------------------------------------------------
// J. 与 M8.2a 的衔接：legacy 完成标记可以作为跳页入口
// ---------------------------------------------------------------------------

test("J. legacy FIRST_PAGE_COMPLETE 可以作为跳页入口，跳页后由 completedPages 接管", async () => {
  const { state, adapter, workflow } = await modules();
  const rows = rowsOfPage(1);
  const keys = keysOf(adapter, rows);
  const legacy = {
    adapter: adapter.ZXGK_EXECUTION_ADAPTER,
    state: state.AUTOMATION_STATES.FIRST_PAGE_COMPLETE,
    taskId: "task-execution",
    projectId: "project-1",
    queryText: ENTITY,
    queryId: "query-7",
    result: state.AUTOMATION_RESULT.HAS_RESULT,
    expectedDetailCount: keys.length,
    pageOneRowKeys: keys,
    pageOneRows: rows,
    completedDetailKeys: [...keys],
    detailCaptures: keys.map((rowKey, index) => ({
      rowKey,
      captureId: `capture-${index + 4}`,
    })),
    listCapture: { id: "capture-list", query_id: "query-7", capture_no: 3 },
    listFilename: `${ENTITY}_执行_中国执行信息公开网_Q07_003_20260915.pdf`,
    currentOperation: null,
    firstPageComplete: {
      pageNo: 1,
      totalPages: 21,
      detailCount: 10,
      newCaptures: 11,
    },
    updatedAt: "2026-09-15T08:00:00.000Z",
  };
  assert.deepEqual(workflow.validateZxgkAutomationJobInvariant(legacy), {
    ok: true,
  });

  const run = advanceHarness(workflow, state, adapter, legacy);
  const result = await run.automation.advancePage(legacy);

  assert.equal(run.jumpCalls().length, 1);
  assert.deepEqual(run.jumpCalls()[0], ["jump", 2]);
  // legacy 完成标记被 completedPages 接管，不再互相矛盾。
  assert.equal(result.firstPageComplete, null);
  // 派生摘要沿用 legacy 已有事实：listCapture.id 与该 job 的 updatedAt 作为完成时间。
  assert.deepEqual(result.completedPages, [
    {
      pageNo: 1,
      detailCount: 10,
      listCaptureId: "capture-list",
      completedAt: "2026-09-15T08:00:00.000Z",
    },
  ]);
  assert.equal(result.currentPage, 2);
  assert.deepEqual(result.pageFrozenKeys, keysOf(adapter, rowsOfPage(2)));
  assert.deepEqual(workflow.validateZxgkAutomationJobInvariant(result), {
    ok: true,
  });
});

// ---------------------------------------------------------------------------
// K. 验证失败的判据只存在于 adapter，且绝不由读取异常 / 页面分类推断
// ---------------------------------------------------------------------------

test("K. 验证失败判据只在 adapter；advancePage 不由异常或页面分类推断验证", async () => {
  const [adapter, workflow, worker, stateSource, progress, panel] =
    await Promise.all([
      readFile(
        new URL("../src/adapters/zxgk-execution.mjs", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../src/lib/zxgk-automation.mjs", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../src/worker.mjs", import.meta.url), "utf8"),
      readFile(
        new URL("../src/lib/automation-state.mjs", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../src/lib/automation-progress-view.mjs", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../src/sidepanel.mjs", import.meta.url), "utf8"),
    ]);

  // 网站事实（结果区提示的 selector 与页面原文）只允许存在于 adapter。
  assert.match(adapter, /warning-result/);
  assert.match(adapter, /验证码错误/);
  for (const source of [workflow, worker, stateSource, progress, panel]) {
    assert.doesNotMatch(source, /warning-result/);
    assert.doesNotMatch(source, /验证码错误|验证码已过期/);
  }

  // advancePage 不得再把“页面分类结果”当作验证失效的判据。
  const start = workflow.indexOf("async function advancePage");
  const end = workflow.indexOf("async function runFirstPageLoop");
  assert.ok(start >= 0 && start < end);
  const body = workflow.slice(start, end);
  assert.doesNotMatch(body, /inspectResult/);
  assert.match(body, /PAGE_ADVANCE_READ_FAILED/);
  assert.doesNotMatch(body, /REQUIRES_VERIFICATION/);

  // 两个 code 各自只在一个地方产生：READ_FAILED 只来自观察循环，
  // REQUIRES_VERIFICATION 只来自基于页面证据的纯判定。
  const settleBody = workflow.slice(
    workflow.indexOf("export function settlePendingPageAdvance"),
    workflow.indexOf("function pageAdvancePreconditions"),
  );
  assert.ok(settleBody.length > 0);
  assert.match(settleBody, /PAGE_ADVANCE_REQUIRES_VERIFICATION/);
  assert.doesNotMatch(settleBody, /PAGE_ADVANCE_READ_FAILED/);
});
