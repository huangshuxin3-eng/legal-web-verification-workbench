import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  cleanupSourceRoot,
  loadSourceModule,
} from "./helpers/source-modules.mjs";

test.after(cleanupSourceRoot);

const executionTask = {
  id: "task-execution",
  project_id: "project-1",
  entity_name: "上海某某科技有限公司",
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
  const identity = await loadSourceModule("lib/query-identity.mjs");
  return { state, adapter, workflow, identity };
}

const rowOf = (serial, name, caseNo, filingDate) => ({
  serial: String(serial),
  name,
  caseNo,
  filingDate,
  label: "查看",
});

const pageOneRows = [
  rowOf(1, "某某集团有限公司", "（2023）粤0305执4653号", "2023年3月10日"),
  rowOf(2, "某某集团有限公司", "（2023）粤0305执4654号", "2023年4月11日"),
  rowOf(3, "某某集团有限公司", "（2023）粤0305执4655号", "2023年5月12日"),
];

/**
 * 同时支持 M8.1（NO_RESULT）与 M8.2a（HAS_RESULT 第一页）的桩。
 * 新增依赖只描述标签页与页面状态，不复制任何 Upload / Capture 实现：
 * 归档依旧只走 archiveQuery。
 */
async function harness(result, options = {}) {
  const { state, adapter, workflow } = await modules();
  const calls = [];
  const states = [];
  // Query 在这个桩里是持久的：同一 Task 下同文本 Query 会被自动核查复用。
  const queryRows = (options.existingQueries || []).map((row, index) => ({
    id: `query-existing-${index + 1}`,
    task_id: executionTask.id,
    created_at: `2026-09-0${index + 1}T00:00:00.000Z`,
    ...row,
  }));
  const queryLookups = [];
  // openQueryPage 实际收到的“当前 URL”必须被记录：continue 时 worker 正是靠它
  // 判断要不要把标签页重新导航回查询入口。
  const openedUrls = [];
  let job = null;
  let nextQueryNo = options.startingQueryNo ?? 7;
  let nextCaptureNo = options.startingCaptureNo ?? 3;
  let nextTabId = 900;
  let openedDetails = 0;
  // 当前自动化列表标签页：resume 在原标签页消失时会新建一个并接管它。
  // listTabIds 决定 archiveQuery / readResultPage 把它当列表页还是详情页。
  const listTabIds = new Set([21]);
  const closedTabIds = new Set();
  // 模拟 worker 进程被杀：写入既不会生效，后续写入也全部丢失（进程已不在）。
  // killArmed 保证同一条件只触发一次，否则恢复流程会被同一个条件再杀一次。
  let killed = false;
  let killNextWrite = false;
  let killArmed = true;
  const list = {
    rows: (options.rows || []).map((row) => ({ ...row })),
    pageNo: options.pageNo ?? 1,
    totalPages: options.totalPages ?? 21,
    totalSize: options.totalSize ?? (options.rows || []).length,
    fail: false,
  };
  const details = new Map();
  const detailOverrides = options.detailOverrides || {};
  const dependencies = {
    now: () => new Date("2026-09-15T08:00:00.000Z"),
    getTask: async () => ({ ...executionTask }),
    getActiveTab: async () => ({ id: 21, url: "https://example.com/" }),
    getTab: async (tabId) => {
      if (closedTabIds.has(tabId)) return null;
      if (listTabIds.has(tabId)) return { id: tabId, url: listUrl };
      if (details.has(tabId)) return { id: tabId, url: detailUrl };
      return null;
    },
    // 只在原自动化标签页已关闭时被调用：新建标签页并接管为列表页。
    createTab: async () => {
      const id = nextTabId++;
      listTabIds.add(id);
      calls.push(["create-tab", id]);
      return { id, url: listUrl };
    },
    getJob: async () => job,
    saveJob: async (next) => {
      // 进程已被杀：这一次写入丢失，之后也不会再有任何写入。
      // 命中 killBefore（“写入之前进程被杀”）时，已落盘的仍是上一次的 job。
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
      return next;
    },
    openQueryPage: async (tabId, currentUrl) => {
      calls.push(["open", tabId]);
      openedUrls.push({ tabId, currentUrl });
    },
    fillEntity: async (tabId, value) => {
      calls.push(["fill-entity-only", tabId, value]);
      return { ok: true };
    },
    submitQuery: async (tabId) => {
      calls.push(["submit", tabId]);
      return { ok: true };
    },
    inspectResult: async () => {
      calls.push(["inspect-after-human"]);
      return result;
    },
    listTaskQueries: async (taskId) => {
      queryLookups.push(taskId);
      return queryRows.map((row) => ({ ...row }));
    },
    // 按 id 只读一条 Query：读不到返回 null（与 data.query 同语义）。
    getQuery: async (queryId) => {
      calls.push(["get-query", queryId]);
      const row = queryRows.find((item) => item.id === queryId);
      return row ? { ...row } : null;
    },
    createQuery: async (taskId, queryText) => {
      calls.push(["create-query", taskId, queryText]);
      const queryNo = nextQueryNo++;
      const query = {
        id: `query-${queryNo}`,
        task_id: taskId,
        query_no: queryNo,
        query_text: queryText,
        created_at: `2026-09-15T00:0${queryNo}:00.000Z`,
      };
      queryRows.push(query);
      return { ...query };
    },
    archiveQuery: async (queryId, tabId) => {
      const kind = listTabIds.has(tabId) ? "list" : "detail";
      const entry = details.get(tabId);
      calls.push(["archive-existing-m4", queryId, tabId]);
      if (options.archiveFailure?.({ kind, tabId, detailIndex: entry?.index }))
        throw new Error("storage failed");
      const capture = {
        id: `capture-${nextCaptureNo}`,
        query_id: queryId,
        capture_no: nextCaptureNo,
      };
      nextCaptureNo += 1;
      const filename = `${executionTask.entity_name}_执行_中国执行信息公开网_Q07_${String(capture.capture_no).padStart(3, "0")}_20260915.pdf`;
      if (kind === "list") options.onStep?.("list-archived", { tabId });
      // 模拟最窄的窗口：Capture 已经在数据库里 finalize 成功（编号已消耗），
      // 但紧接着的那次状态写入之前进程被杀。同样只触发一次。
      if (kind === "list" && options.killAfterListArchive && killArmed) {
        killArmed = false;
        killNextWrite = true;
      }
      return { capture, filename };
    },
    readResultPage: async (tabId) => {
      calls.push(["read-list", tabId, list.pageNo]);
      if (!listTabIds.has(tabId)) throw new Error("不是结果列表标签页");
      if (list.fail)
        throw new Error("综合查询结果标签页已跳转到其他页面，自动核查已停止。");
      return {
        ok: true,
        rows: list.rows.map((row) => ({ ...row })),
        page: {
          input: list.pageNo,
          shown: list.pageNo,
          totalPages: list.totalPages,
          totalSize: list.totalSize,
          pagerVisible: true,
        },
        resultVisible: true,
      };
    },
    openDetail: async (tabId, rowKey) => {
      const row = list.rows.find((item) => adapter.buildRowKey(item) === rowKey);
      calls.push(["open-detail", rowKey, row?.caseNo ?? null]);
      if (!row) throw new Error("结果列表中已找不到该条结果，未打开详情。");
      const detailTabId = nextTabId++;
      details.set(detailTabId, {
        rowKey,
        closed: false,
        caseNo: row.caseNo,
        name: row.name,
        index: openedDetails++,
      });
      options.onStep?.("detail-opened", { detailTabId, rowKey });
      return { detailTabId, url: detailUrl };
    },
    readDetailIdentity: async (detailTabId) => {
      const entry = details.get(detailTabId);
      calls.push(["read-detail", detailTabId]);
      if (!entry || entry.closed) return { ok: false, closed: true };
      const override = detailOverrides[entry.rowKey] || {};
      if (override.timeout) return { ok: false, timeout: true };
      return {
        ok: true,
        errorText: override.errorText || "",
        rowCount: 3,
        caseNumbers: override.caseNumbers || [entry.caseNo],
        names: [entry.name],
        bodyText: `${entry.name}案号${entry.caseNo}`,
      };
    },
    closeDetail: async (detailTabId, listTabId) => {
      calls.push(["close-detail", detailTabId, listTabId]);
      const entry = details.get(detailTabId);
      if (
        options.closeFailure?.({
          detailIndex: entry?.index,
          rowKey: entry?.rowKey,
        })
      )
        throw new Error(
          "详情页「关闭」后标签页仍未关闭，无法确认已返回结果列表。",
        );
      if (entry) entry.closed = true;
      options.onStep?.("detail-closed", { detailTabId, rowKey: entry?.rowKey });
    },
  };
  return {
    calls,
    states,
    state,
    adapter,
    list,
    details,
    queryRows,
    queryLookups,
    openedUrls,
    state_names: state.AUTOMATION_STATES,
    get job() {
      return job;
    },
    replaceJob(next) {
      job = next;
      return job;
    },
    /** 模拟原自动化标签页被用户/浏览器关闭。 */
    closeListTab() {
      for (const id of listTabIds) closedTabIds.add(id);
      return listTabIds;
    },
    listTabIds,
    /**
     * 模拟扩展重启：进程重新可用，并按 worker.mjs 的启动扫描把
     * “运行中但已中断”的状态标记为 FAILED（已生成的进度原样保留）。
     */
    interrupt() {
      killed = false;
      killNextWrite = false;
      // killArmed 有意不复位：中断条件只模拟一次。
      if (!state.AUTOMATION_INTERRUPTED_STATES.includes(job?.state))
        return job;
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

// ---------------------------------------------------------------------------
// M8.1 回归
// ---------------------------------------------------------------------------

test("zxgk_execution 只匹配执行与中国执行信息公开网", async () => {
  const { adapter } = await modules();
  assert.equal(adapter.supportsZxgkExecution(executionTask), true);
  assert.equal(
    adapter.supportsZxgkExecution({ ...executionTask, topic: "失信" }),
    false,
  );
  assert.equal(
    adapter.supportsZxgkExecution({
      ...executionTask,
      source_name: "其他网站",
    }),
    false,
  );
  assert.equal(adapter.ZXGK_INPUT_POLICY.entityName, true);
  assert.equal(adapter.ZXGK_INPUT_POLICY.organizationCode, false);
  assert.equal(adapter.ZXGK_INPUT_POLICY.courtScope, false);
});

test("自动核查状态机显式包含 M8.1 与 M8.2a 的全部状态", async () => {
  const { state } = await modules();
  assert.deepEqual(Object.values(state.AUTOMATION_STATES), [
    "IDLE",
    "OPENING_QUERY_PAGE",
    "FILLING_ENTITY",
    "SUBMITTING_QUERY",
    "WAITING_HUMAN_VERIFICATION",
    "CHECKING_RESULT",
    "CREATING_QUERY",
    "CAPTURING_NO_RESULT",
    "HAS_RESULT_UNSUPPORTED",
    "CAPTURING_LIST_PAGE",
    "READING_RESULT_ROWS",
    "OPENING_DETAIL",
    "CAPTURING_DETAIL",
    "RETURNING_TO_LIST",
    "VERIFYING_LIST_STATE",
    "ADVANCING_PAGE",
    "FIRST_PAGE_COMPLETE",
    "PAUSED",
    "FAILED",
    "DONE",
  ]);
  assert.deepEqual(Object.values(state.AUTOMATION_PHASES), [
    "LOCATING",
    "OPENING",
    "CAPTURING",
    "RETURNING",
    "VERIFYING",
  ]);
  // WAITING_HUMAN_VERIFICATION 是正常的人工等待态，不属于“中断”。
  assert.equal(
    state.AUTOMATION_RUNNING_STATES.includes(
      state.AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION,
    ),
    true,
  );
  assert.equal(
    state.AUTOMATION_INTERRUPTED_STATES.includes(
      state.AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION,
    ),
    false,
  );
  assert.equal(
    state.AUTOMATION_INTERRUPTED_STATES.includes(
      state.AUTOMATION_STATES.OPENING_DETAIL,
    ),
    true,
  );
});

test("不支持的 topic fail closed，绝不执行页面操作", async () => {
  const { state } = await modules();
  const run = await harness(state.AUTOMATION_RESULT.NO_RESULT);
  run.dependencies.getTask = async () => ({
    ...executionTask,
    topic: "失信",
  });
  await assert.rejects(
    run.automation.start({
      taskId: executionTask.id,
      projectId: executionTask.project_id,
    }),
    /不支持 zxgk_execution/,
  );
  assert.equal(run.job.state, state.AUTOMATION_STATES.FAILED);
  assert.deepEqual(run.calls, []);
});

test("查询页 URL 必须精确匹配固定 HTTPS hostname 与 pathname", async () => {
  const { adapter } = await modules();
  assert.equal(adapter.isZxgkExecutionPage(adapter.ZXGK_EXECUTION_URL), true);
  assert.equal(
    adapter.isZxgkExecutionPage(
      "https://zxgk.court.gov.cn.evil.com/gkw/html/zhzxgk/index.html",
    ),
    false,
  );
  assert.equal(adapter.isZxgkExecutionPage("not a url"), false);
});

test("开始流程只填写 entity_name 并提交，随后停在 CAPTCHA 人工接管", async () => {
  const { state } = await modules();
  const run = await harness(state.AUTOMATION_RESULT.NO_RESULT);
  const job = await run.automation.start({
    taskId: executionTask.id,
    projectId: executionTask.project_id,
  });
  assert.equal(job.state, state.AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION);
  assert.equal(job.taskId, executionTask.id);
  assert.equal(job.queryText, executionTask.entity_name);
  assert.equal(job.queryId, null);
  assert.deepEqual(run.calls, [
    ["open", 21],
    ["fill-entity-only", 21, executionTask.entity_name],
    ["submit", 21],
  ]);
  assert.equal(named(run, "inspect-after-human").length, 0);
  assert.equal(named(run, "create-query").length, 0);
  assert.deepEqual(run.states, [
    state.AUTOMATION_STATES.OPENING_QUERY_PAGE,
    state.AUTOMATION_STATES.FILLING_ENTITY,
    state.AUTOMATION_STATES.SUBMITTING_QUERY,
    state.AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION,
  ]);
});

test("NO_RESULT 明确识别，HAS_RESULT 要求真实数据行，其他状态 UNKNOWN", async () => {
  const { adapter, state } = await modules();
  assert.equal(
    adapter.classifyZxgkExecutionResult({
      bodyText:
        "在全国法院（包含地方各级法院）范围内没有找到 上海某某科技有限公司 相关的结果。",
      tables: [],
    }),
    state.AUTOMATION_RESULT.NO_RESULT,
  );
  assert.equal(
    adapter.classifyZxgkExecutionResult({
      bodyText: "查询结果",
      tables: [
        [
          ["序号", "姓名/名称", "立案时间", "案号", "查看"],
          ["1", "某公司", "2026-09-15", "（2026）沪01执1号", "查看"],
        ],
      ],
    }),
    state.AUTOMATION_RESULT.HAS_RESULT,
  );
  assert.equal(
    adapter.classifyZxgkExecutionResult({
      bodyText: "系统繁忙，请稍候",
      tables: [[["序号", "姓名", "立案时间", "案号", "查看"]]],
    }),
    state.AUTOMATION_RESULT.UNKNOWN,
  );
});

test("NO_RESULT 后才创建 Query，并复用既有 M4 archive 链路完成 DONE", async () => {
  const { state } = await modules();
  const run = await harness(state.AUTOMATION_RESULT.NO_RESULT);
  await run.automation.start({
    taskId: executionTask.id,
    projectId: executionTask.project_id,
  });
  const job = await run.automation.continueAfterVerification({
    taskId: executionTask.id,
  });
  assert.equal(job.state, state.AUTOMATION_STATES.DONE);
  assert.equal(job.result, state.AUTOMATION_RESULT.NO_RESULT);
  assert.equal(job.query.query_no, 7);
  assert.equal(job.queryId, "query-7");
  assert.deepEqual(run.calls.slice(-3), [
    ["inspect-after-human"],
    ["create-query", executionTask.id, executionTask.entity_name],
    ["archive-existing-m4", "query-7", 21],
  ]);
  // M8.1 行为不回归：NO_RESULT 不读取结果表格，也不打开任何详情。
  assert.equal(named(run, "read-list").length, 0);
  assert.equal(named(run, "open-detail").length, 0);
});

test("UNKNOWN 进入 PAUSED，允许人工重查且不创建 Query/Capture", async () => {
  const { state } = await modules();
  const run = await harness(state.AUTOMATION_RESULT.UNKNOWN);
  await run.automation.start({
    taskId: executionTask.id,
    projectId: executionTask.project_id,
  });
  const job = await run.automation.continueAfterVerification({
    taskId: executionTask.id,
  });
  assert.equal(job.state, state.AUTOMATION_STATES.PAUSED);
  assert.equal(state.canRecheckAutomation(job), true);
  assert.equal(named(run, "create-query").length, 0);
  assert.equal(named(run, "archive-existing-m4").length, 0);
});

test("Task 上下文变化或 tab 丢失时 FAILED，不产生虚假完成", async () => {
  const { state } = await modules();
  const changed = await harness(state.AUTOMATION_RESULT.NO_RESULT);
  await changed.automation.start({
    taskId: executionTask.id,
    projectId: executionTask.project_id,
  });
  changed.dependencies.getTask = async () => ({
    ...executionTask,
    entity_name: "被修改的主体",
  });
  await assert.rejects(
    changed.automation.continueAfterVerification({
      taskId: executionTask.id,
    }),
    /Task 内容或归属已经变化/,
  );
  assert.equal(changed.job.state, state.AUTOMATION_STATES.FAILED);
  assert.equal(named(changed, "create-query").length, 0);

  const closed = await harness(state.AUTOMATION_RESULT.NO_RESULT);
  await closed.automation.start({
    taskId: executionTask.id,
    projectId: executionTask.project_id,
  });
  closed.dependencies.getTab = async () => null;
  await assert.rejects(
    closed.automation.continueAfterVerification({
      taskId: executionTask.id,
    }),
    /标签页已关闭/,
  );
  assert.equal(closed.job.state, state.AUTOMATION_STATES.FAILED);
});

test("Query 或 M4 Capture 链路失败时保持 FAILED，不显示 DONE", async () => {
  const { state } = await modules();
  const queryFailure = await harness(state.AUTOMATION_RESULT.NO_RESULT);
  queryFailure.dependencies.createQuery = async () => {
    throw new Error("query failed");
  };
  await queryFailure.automation.start({
    taskId: executionTask.id,
    projectId: executionTask.project_id,
  });
  await assert.rejects(
    queryFailure.automation.continueAfterVerification({
      taskId: executionTask.id,
    }),
    /query failed/,
  );
  assert.equal(queryFailure.job.state, state.AUTOMATION_STATES.FAILED);

  const captureFailure = await harness(state.AUTOMATION_RESULT.NO_RESULT);
  captureFailure.dependencies.archiveQuery = async () => {
    throw new Error("storage failed");
  };
  await captureFailure.automation.start({
    taskId: executionTask.id,
    projectId: executionTask.project_id,
  });
  await assert.rejects(
    captureFailure.automation.continueAfterVerification({
      taskId: executionTask.id,
    }),
    /storage failed/,
  );
  assert.equal(captureFailure.job.state, state.AUTOMATION_STATES.FAILED);
  assert.equal(captureFailure.job.query.id, "query-7");
  assert.equal(captureFailure.job.queryId, "query-7");
});

test("当前手工 Query 不影响自动检索词或本轮 automationJob", async () => {
  const { state } = await modules();
  const run = await harness(state.AUTOMATION_RESULT.NO_RESULT);
  run.dependencies.selectedManualQuery = {
    id: "old-query",
    query_text: "恒大集团有限公司",
  };
  const waiting = await run.automation.start({
    taskId: executionTask.id,
    projectId: executionTask.project_id,
  });
  run.dependencies.selectedManualQuery = {
    id: "another-old-query",
    query_text: "切换后的手工查询",
  };
  assert.equal(waiting.queryText, executionTask.entity_name);
  assert.equal(run.job.queryText, executionTask.entity_name);
  assert.equal(run.job.queryId, null);
  assert.deepEqual(run.calls[1], [
    "fill-entity-only",
    21,
    executionTask.entity_name,
  ]);
  const done = await run.automation.continueAfterVerification({
    taskId: executionTask.id,
  });
  assert.equal(done.queryId, "query-7");
  assert.deepEqual(run.calls.at(-1), ["archive-existing-m4", "query-7", 21]);
  assert.equal(
    run.calls.some((call) => call.includes("old-query")),
    false,
  );
});

test("再次自动核查复用同文本 canonical Query，不再产生新的同文本 Query", async () => {
  const { state } = await modules();
  const run = await harness(state.AUTOMATION_RESULT.NO_RESULT, {
    startingQueryNo: 5,
  });
  await run.automation.start({
    taskId: executionTask.id,
    projectId: executionTask.project_id,
  });
  const first = await run.automation.continueAfterVerification({
    taskId: executionTask.id,
  });
  assert.equal(first.state, state.AUTOMATION_STATES.DONE);
  assert.equal(first.queryId, "query-5");

  const secondWaiting = await run.automation.start({
    taskId: executionTask.id,
    projectId: executionTask.project_id,
  });
  assert.equal(
    secondWaiting.state,
    state.AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION,
  );
  // 同一个检索词在开始时就复用已有 Query，而不是等确认结果后才决定。
  assert.equal(secondWaiting.queryId, "query-5");
  assert.equal(secondWaiting.query.query_no, 5);
  const second = await run.automation.continueAfterVerification({
    taskId: executionTask.id,
  });
  assert.equal(second.state, state.AUTOMATION_STATES.DONE);
  assert.equal(second.queryId, "query-5");
  // 整个 Task 生命周期只创建过一条 Query。
  assert.deepEqual(named(run, "create-query"), [
    ["create-query", executionTask.id, executionTask.entity_name],
  ]);
  assert.deepEqual(named(run, "archive-existing-m4"), [
    ["archive-existing-m4", "query-5", 21],
    ["archive-existing-m4", "query-5", 21],
  ]);
  assert.equal(run.queryRows.length, 1);
});

test("DONE/FAILED/HAS_RESULT/FIRST_PAGE_COMPLETE 允许新一轮，运行中状态仍锁定", async () => {
  const { state } = await modules();
  const allowed = [
    null,
    { state: state.AUTOMATION_STATES.DONE },
    { state: state.AUTOMATION_STATES.FAILED },
    { state: state.AUTOMATION_STATES.HAS_RESULT_UNSUPPORTED },
    { state: state.AUTOMATION_STATES.FIRST_PAGE_COMPLETE },
  ];
  for (const job of allowed)
    assert.equal(
      state.canStartNewAutomation(job),
      true,
      `${job?.state ?? "null"} 应允许新一轮`,
    );
  for (const value of state.AUTOMATION_RUNNING_STATES)
    assert.equal(
      state.canStartNewAutomation({ state: value }),
      false,
      `${value} 应保持锁定`,
    );
  assert.equal(
    state.canStartNewAutomation({
      state: state.AUTOMATION_STATES.PAUSED,
      result: state.AUTOMATION_RESULT.UNKNOWN,
    }),
    false,
  );
});

test("Side Panel 区分手工 Query，自动请求只发送 Task 上下文", async () => {
  const [panel, html] = await Promise.all([
    readFile(new URL("../src/sidepanel.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/sidepanel.html", import.meta.url), "utf8"),
  ]);
  assert.match(html, /Query（手工流程）/);
  assert.match(html, /当前 Query 仅用于手工留痕，不控制自动核查/);
  assert.match(html, /自动核查无需预先创建/);
  assert.match(html, /id="automation-ready-query"/);
  assert.match(html, /id="automation-query-text"/);
  assert.match(panel, /canStartNewAutomation\(automationJob\)/);
  assert.match(panel, /再次自动核查/);
  const automationMessage = panel.match(
    /const response = await chrome\.runtime\.sendMessage\(\{([\s\S]*?)\n    \}\);/,
  )?.[1];
  assert.ok(automationMessage);
  assert.match(automationMessage, /taskId: task\.id/);
  assert.doesNotMatch(automationMessage, /query(Id|Text)|\$\("query"\)/);
});

test("Runtime.evaluate 成功或失败都可靠 detach", async () => {
  const calls = [];
  globalThis.chrome = {
    debugger: {
      attach: async () => calls.push("attach"),
      sendCommand: async () => {
        calls.push("evaluate");
        return { result: { value: { ok: true } } };
      },
      detach: async () => calls.push("detach"),
    },
  };
  const { evaluateInTab } = await loadSourceModule("lib/debugger-evaluate.mjs");
  assert.deepEqual(await evaluateInTab(21, "1 + 1"), { ok: true });
  assert.deepEqual(calls, ["attach", "evaluate", "detach"]);
  calls.length = 0;
  chrome.debugger.sendCommand = async () => {
    calls.push("evaluate");
    throw new Error("DOM failed");
  };
  await assert.rejects(evaluateInTab(21, "bad"), /DOM failed/);
  assert.deepEqual(calls, ["attach", "evaluate", "detach"]);
});

test("Query 创建只提交 task_id/query_text，编号由现有数据库逻辑分配", async () => {
  const source = await readFile(
    new URL("../src/lib/data.mjs", import.meta.url),
    "utf8",
  );
  const createQuery = source.slice(
    source.indexOf("export async function createQuery"),
  );
  assert.match(createQuery, /task_id: taskId, query_text: queryText/);
  assert.doesNotMatch(createQuery, /query_no\s*:/);
});

test("Extension 使用用户 JWT 创建 Query 并采用数据库返回的 query_no", async () => {
  const requests = [];
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({
          supabaseSession: {
            accessToken: "user-jwt",
            refreshToken: "refresh",
            expiresAt: Date.now() + 3600000,
          },
        }),
      },
    },
  };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(
      JSON.stringify({
        id: "query-from-db",
        task_id: executionTask.id,
        query_no: 12,
        query_text: executionTask.entity_name,
      }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );
  };
  const data = await loadSourceModule("lib/data.mjs");
  const query = await data.createQuery(
    executionTask.id,
    executionTask.entity_name,
  );
  assert.equal(query.query_no, 12);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers.Authorization, "Bearer user-jwt");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    task_id: executionTask.id,
    query_text: executionTask.entity_name,
  });
});

// ---------------------------------------------------------------------------
// M8.2a：第一页列表 + 第一页全部详情
// ---------------------------------------------------------------------------

async function runFirstPage(options = {}) {
  const { state } = await modules();
  const run = await harness(state.AUTOMATION_RESULT.HAS_RESULT, options);
  await run.automation.start({
    taskId: executionTask.id,
    projectId: executionTask.project_id,
  });
  return run;
}

test("HAS_RESULT 复用本轮 Query，先列表留痕再按展示顺序逐条处理详情", async () => {
  const { state, adapter } = await modules();
  const run = await runFirstPage({ rows: pageOneRows });
  const job = await run.automation.continueAfterVerification({
    taskId: executionTask.id,
  });
  const keys = pageOneRows.map(adapter.buildRowKey);

  assert.equal(job.state, state.AUTOMATION_STATES.FIRST_PAGE_COMPLETE);
  assert.notEqual(job.state, state.AUTOMATION_STATES.DONE);
  // 只创建一条 Query，且所有 Capture 都属于它。
  assert.deepEqual(named(run, "create-query"), [
    ["create-query", executionTask.id, executionTask.entity_name],
  ]);
  assert.equal(job.queryId, "query-7");
  assert.equal(job.query.query_no, 7);
  assert.deepEqual(
    named(run, "archive-existing-m4").map(([, queryId]) => queryId),
    ["query-7", "query-7", "query-7", "query-7"],
  );
  // 第一份 Capture 必须是结果列表。
  const firstArchive = named(run, "archive-existing-m4")[0];
  assert.deepEqual(firstArchive, ["archive-existing-m4", "query-7", 21]);
  const firstDetailIndex = run.calls.findIndex(
    (call) => call[0] === "open-detail",
  );
  assert.ok(run.calls.indexOf(firstArchive) < firstDetailIndex);
  // 详情按网站第一页展示顺序处理。
  assert.deepEqual(
    named(run, "open-detail").map(([, rowKey]) => rowKey),
    keys,
  );
  assert.equal(job.listCapture.capture_no, 3);
  assert.deepEqual(
    job.detailCaptures.map((item) => item.captureNo),
    [4, 5, 6],
  );
  assert.deepEqual(
    job.detailCaptures.map((item) => item.caseNo),
    pageOneRows.map((row) => row.caseNo),
  );
  // 每个详情标签页都关闭了，且没有分页动作。
  assert.equal(named(run, "close-detail").length, 3);
  assert.deepEqual(
    named(run, "close-detail").map(([, , listTabId]) => listTabId),
    [21, 21, 21],
  );
  // 完成后没有残留操作。
  assert.equal(job.currentOperation, null);
  assert.equal(job.expectedDetailCount, 3);
  assert.deepEqual(job.completedDetailKeys, keys);
  assert.deepEqual(job.pageOneRowKeys, keys);
});

test("expectedDetailCount 必须对应 N 个唯一 rowKey，缺一不可", async () => {
  const { state, adapter } = await modules();
  const rows = pageOneRows.slice(0, 1);
  const run = await runFirstPage({ rows });
  const job = await run.automation.continueAfterVerification({
    taskId: executionTask.id,
  });
  assert.equal(job.expectedDetailCount, 1);
  assert.equal(job.completedDetailKeys.length, 1);
  assert.equal(job.state, state.AUTOMATION_STATES.FIRST_PAGE_COMPLETE);
  assert.equal(new Set(job.completedDetailKeys).size, 1);
  assert.equal(
    job.completedDetailKeys[0],
    adapter.buildRowKey(rows[0]),
  );
  assert.equal(job.firstPageComplete.newCaptures, 2);
  assert.equal(job.firstPageComplete.totalPages, 21);
});

test("第一页解析：rowKey 含稳定结果身份，重复身份 fail closed", async () => {
  const { adapter } = await modules();
  const row = pageOneRows[0];
  assert.equal(
    adapter.buildRowKey(row),
    "某某集团有限公司|(2023)粤0305执4653号|2023年3月10日",
  );
  // 空白与全角差异被轻度规范化，但内容不被改写。
  assert.equal(
    adapter.buildRowKey({ ...row, name: " 某某集团有限公司 ", caseNo: "（2023）粤0305执4653号" }),
    adapter.buildRowKey(row),
  );
  assert.notEqual(
    adapter.buildRowKey({ ...row, caseNo: "（2023）粤0305执4654号" }),
    adapter.buildRowKey(row),
  );

  const snapshot = {
    ok: true,
    page: { input: 1, shown: 1, totalPages: 21, totalSize: 11 },
    rows: pageOneRows.map((item) => ({ ...item })),
  };
  const frozen = adapter.freezePageOneRows(snapshot);
  assert.equal(frozen.ok, true);
  assert.deepEqual(frozen.keys, pageOneRows.map(adapter.buildRowKey));

  const duplicated = adapter.freezePageOneRows({
    ...snapshot,
    rows: [pageOneRows[0], { ...pageOneRows[0], serial: "2" }],
  });
  assert.equal(duplicated.ok, false);
  assert.match(duplicated.error, /完全相同的结果/);

  const secondPage = adapter.freezePageOneRows({
    ...snapshot,
    page: { input: 2, shown: 2, totalPages: 21 },
  });
  assert.equal(secondPage.ok, false);
  assert.match(secondPage.error, /第 1 页/);

  const incomplete = adapter.freezePageOneRows({
    ...snapshot,
    rows: [{ ...pageOneRows[0], caseNo: "" }],
  });
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.error, /无法建立稳定身份/);
});

test("rowKey 实现与页面内注入版本一致且自包含", async () => {
  const { adapter } = await modules();
  // 在纯净作用域里重建，证明注入页面后不依赖任何外部变量。
  const rebuilt = new Function(
    `${adapter.ROW_KEY_SOURCE} return buildRowKey;`,
  )();
  for (const row of pageOneRows)
    assert.equal(rebuilt(row), adapter.buildRowKey(row));
  const expression = adapter.openDetailExpression(adapter.buildRowKey(pageOneRows[0]));
  assert.match(expression, /normalizeRowText = function normalizeRowText/);
  assert.match(expression, /buildRowKey = function buildRowKey/);
  assert.match(expression, /anchor\.click\(\)/);
});

test("详情页身份识别：只认 detail.html，案号不符或页面报错都不留痕", async () => {
  const { adapter } = await modules();
  assert.equal(adapter.isZxgkDetailPage(detailUrl), true);
  assert.equal(
    adapter.isZxgkDetailPage(
      "https://zxgk.court.gov.cn.evil.com/gkw/html/zhzxgk/detail.html",
    ),
    false,
  );
  assert.equal(adapter.isZxgkDetailPage(adapter.ZXGK_EXECUTION_URL), false);

  const expected = pageOneRows[0];
  assert.equal(
    adapter.evaluateDetailIdentity(expected, {
      ok: true,
      errorText: "",
      rowCount: 4,
      caseNumbers: ["（2023）粤0305执4653号"],
      bodyText: "某某集团有限公司",
    }).ok,
    true,
  );
  for (const observed of [
    { ok: true, errorText: "", rowCount: 4, caseNumbers: ["（2023）粤0305执9999号"], bodyText: "某某集团有限公司" },
    { ok: true, errorText: "", rowCount: 1, caseNumbers: [], bodyText: "某某集团有限公司" },
    { ok: true, errorText: "安全验证已失效，暂时无法加载", rowCount: 0, caseNumbers: [], bodyText: "" },
    { ok: true, timeout: true },
    { ok: false, closed: true },
  ]) {
    const verdict = adapter.evaluateDetailIdentity(expected, observed);
    assert.equal(verdict.ok, false, JSON.stringify(observed));
    assert.ok(verdict.error.length > 0);
  }
  const wrongName = adapter.evaluateDetailIdentity(expected, {
    ok: true,
    errorText: "",
    rowCount: 4,
    caseNumbers: ["（2023）粤0305执4653号"],
    bodyText: "另外一个主体",
  });
  assert.equal(wrongName.ok, false);
  assert.match(wrongName.error, /主体名称/);
});

test("详情案号不匹配时立即停止，且不生成该详情的 Capture", async () => {
  const { state, adapter } = await modules();
  const keys = pageOneRows.map(adapter.buildRowKey);
  const run = await runFirstPage({
    rows: pageOneRows,
    detailOverrides: {
      [keys[1]]: { caseNumbers: ["（2023）粤0305执9999号"] },
    },
  });
  await assert.rejects(
    run.automation.continueAfterVerification({ taskId: executionTask.id }),
    /案号与当前处理案号不一致/,
  );
  assert.equal(run.job.state, state.AUTOMATION_STATES.FAILED);
  // 只留痕了列表与第 1 条详情。
  assert.deepEqual(named(run, "archive-existing-m4"), [
    ["archive-existing-m4", "query-7", 21],
    ["archive-existing-m4", "query-7", 900],
  ]);
  assert.deepEqual(run.job.completedDetailKeys, [keys[0]]);
  assert.equal(run.job.detailCaptures.length, 1);
  assert.notEqual(run.job.state, state.AUTOMATION_STATES.FIRST_PAGE_COMPLETE);
});

test("详情留痕失败时不标记完成，但保留已成功的 Query 与 Capture", async () => {
  const { state } = await modules();
  const run = await runFirstPage({
    rows: pageOneRows,
    // 第 3 条详情（detailIndex 2）归档失败。
    archiveFailure: ({ kind, detailIndex }) =>
      kind === "detail" && detailIndex === 2,
  });
  await assert.rejects(
    run.automation.continueAfterVerification({ taskId: executionTask.id }),
    /storage failed/,
  );
  const job = run.job;
  assert.equal(job.state, state.AUTOMATION_STATES.FAILED);
  assert.notEqual(job.state, state.AUTOMATION_STATES.FIRST_PAGE_COMPLETE);
  assert.equal(job.queryId, "query-7");
  assert.equal(job.query.query_no, 7);
  assert.equal(job.listCapture.capture_no, 3);
  assert.equal(job.detailCaptures.length, 2);
  assert.deepEqual(
    job.detailCaptures.map((item) => item.captureNo),
    [4, 5],
  );
  assert.equal(job.completedDetailKeys.length, 2);
});

test("列表页留痕失败时不进入详情循环", async () => {
  const { state } = await modules();
  const run = await runFirstPage({
    rows: pageOneRows,
    archiveFailure: ({ kind }) => kind === "list",
  });
  await assert.rejects(
    run.automation.continueAfterVerification({ taskId: executionTask.id }),
    /storage failed/,
  );
  assert.equal(run.job.state, state.AUTOMATION_STATES.FAILED);
  assert.equal(named(run, "open-detail").length, 0);
  assert.equal(named(run, "read-detail").length, 0);
  assert.equal(run.job.listCapture, null);
  assert.equal(run.job.expectedDetailCount, 3);
  assert.deepEqual(run.job.completedDetailKeys, []);
});

test("列表顺序变化但 rowKey 仍可匹配时继续，且不改变冻结的处理顺序", async () => {
  const { state, adapter } = await modules();
  const keys = pageOneRows.map(adapter.buildRowKey);
  const run = await runFirstPage({
    rows: pageOneRows,
    onStep: (event) => {
      if (event === "detail-closed" && run.details.size === 1)
        run.list.rows.reverse();
    },
  });
  const job = await run.automation.continueAfterVerification({
    taskId: executionTask.id,
  });
  assert.equal(job.state, state.AUTOMATION_STATES.FIRST_PAGE_COMPLETE);
  // 处理顺序仍以冻结的第一页为准，而不是页面当时的行号。
  assert.deepEqual(
    named(run, "open-detail").map(([, rowKey]) => rowKey),
    keys,
  );
  assert.deepEqual(job.completedDetailKeys, keys);
});

test("返回列表后不是第 1 页时停止，不继续下一条", async () => {
  const { state } = await modules();
  const run = await runFirstPage({
    rows: pageOneRows,
    onStep: (event) => {
      if (event === "detail-closed") run.list.pageNo = 2;
    },
  });
  await assert.rejects(
    run.automation.continueAfterVerification({ taskId: executionTask.id }),
    /第 1 页/,
  );
  assert.equal(run.job.state, state.AUTOMATION_STATES.FAILED);
  assert.equal(named(run, "open-detail").length, 1);
  assert.equal(run.job.completedDetailKeys.length, 0);
});

test("目标 rowKey 在返回后无法定位时 fail closed", async () => {
  const { state, adapter } = await modules();
  const keys = pageOneRows.map(adapter.buildRowKey);
  const run = await runFirstPage({
    rows: pageOneRows,
    onStep: (event) => {
      // 第 2 条详情关闭后，网站结果里少了一条冻结目标。
      if (event === "detail-closed" && run.details.size === 2)
        run.list.rows = run.list.rows.filter(
          (row) => adapter.buildRowKey(row) !== keys[2],
        );
    },
  });
  await assert.rejects(
    run.automation.continueAfterVerification({ taskId: executionTask.id }),
    /已无法定位/,
  );
  assert.equal(run.job.state, state.AUTOMATION_STATES.FAILED);
  // 第 2 条的 Capture 已经真实生成并保留（detailCaptures），
  // 但因为返回后无法确认第一页状态，它不算“已完成”。
  assert.equal(run.job.detailCaptures.length, 2);
  assert.deepEqual(run.job.completedDetailKeys, [keys[0]]);
  assert.equal(run.job.listCapture.capture_no, 3);
  assert.equal(named(run, "open-detail").length, 2);
});

test("M8.2a 绝不点击任何分页控件", async () => {
  const [adapter, worker, workflow] = await Promise.all([
    readFile(new URL("../src/adapters/zxgk-execution.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/worker.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/zxgk-automation.mjs", import.meta.url), "utf8"),
  ]);
  // adapter 是网站事实层，允许持有分页 selector 与跳页 primitive；
  // 这里守住的是 orchestration / worker：它们仍然不得接触任何分页动作。
  for (const source of [worker, workflow]) {
    assert.doesNotMatch(source, /下一页|尾页/);
    assert.doesNotMatch(source, /nextPage|lastPage|prePage|goPage/);
    assert.doesNotMatch(source, /#next-btn|#last-btn|#pre-btn|#goto/);
  }
  // 只读当前页与总页数。
  assert.match(adapter, /#currentPage-show/);
  assert.match(adapter, /#totalPage-show/);
});

test("Side Panel 显示第一页进度与完成态，且不使用“全部完成”措辞", async () => {
  const panel = await readFile(
    new URL("../src/sidepanel.mjs", import.meta.url),
    "utf8",
  );
  assert.match(panel, /AUTOMATION_STATES\.FIRST_PAGE_COMPLETE/);
  assert.match(panel, /第 1 页已完整处理/);
  assert.match(panel, /后续分页暂未自动执行。请人工继续核查。/);
  assert.match(panel, /正在处理第 1 页/);
  assert.match(panel, /当前处理：/);
  assert.match(panel, /累计新增留痕/);
  assert.match(panel, /isAutomationRunning\(automationJob\)/);
  assert.doesNotMatch(panel, /自动核查完成|全部核查完成|已全部留痕/);
  assert.doesNotMatch(panel, /AI 正在思考/);
});

test("自动流程复用 archive，手工 Query 与留痕入口继续保留", async () => {
  const [worker, panel] = await Promise.all([
    readFile(new URL("../src/worker.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/sidepanel.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /archiveQuery: \(queryId, tabId\) =>\s*\n?\s*archive\(queryId, tabId, "automation"\)/);
  assert.match(worker, /archive\(message\.queryId\)/);
  assert.match(panel, /type: "archive"/);
  assert.match(panel, /\$\("query"\)\.onchange/);
  // 自动核查不绕过共享归档链路，也不自己实现 Capture 编号或上传。
  assert.match(worker, /openDetail: openDetailTab/);
  assert.match(worker, /closeDetail: closeDetailTab/);
  assert.doesNotMatch(worker, /reserve_capture_upload|finish_capture_upload/);
  assert.doesNotMatch(worker, /max\(capture_no\)|capture_no \+ 1|captureNo \+ 1/);
  assert.doesNotMatch(
    worker,
    /Input\.dispatchMouseEvent|mousePressed|captchaId/,
  );
  assert.match(worker, /AUTOMATION_INTERRUPTED_STATES/);
});

// ---------------------------------------------------------------------------
// M8.2a blocker fix：Query 语义（一个检索词 = 一个 Query）
// ---------------------------------------------------------------------------

test("同文本 Query 已存在时直接复用，不创建新的同文本 Query", async () => {
  const { state } = await modules();
  const run = await harness(state.AUTOMATION_RESULT.HAS_RESULT, {
    rows: pageOneRows,
    existingQueries: [
      {
        id: "query-canonical",
        query_no: 1,
        query_text: executionTask.entity_name,
      },
      { id: "query-other", query_no: 2, query_text: "另一个检索词" },
    ],
  });
  const waiting = await run.automation.start({
    taskId: executionTask.id,
    projectId: executionTask.project_id,
  });
  assert.equal(waiting.queryId, "query-canonical");
  assert.equal(waiting.query.query_no, 1);
  assert.equal(named(run, "create-query").length, 0);
  assert.ok(run.queryLookups.length > 0);

  const job = await run.automation.continueAfterVerification({
    taskId: executionTask.id,
  });
  assert.equal(job.state, state.AUTOMATION_STATES.FIRST_PAGE_COMPLETE);
  assert.equal(job.queryId, "query-canonical");
  // 所有留痕（1 列表 + 3 详情）都挂在同一个已有 Query 下。
  assert.deepEqual(
    named(run, "archive-existing-m4").map(([, queryId]) => queryId),
    [
      "query-canonical",
      "query-canonical",
      "query-canonical",
      "query-canonical",
    ],
  );
  assert.equal(run.queryRows.length, 2);
});

test("没有同文本 Query 时，确认结果后才创建一次并复用", async () => {
  const { state } = await modules();
  const run = await harness(state.AUTOMATION_RESULT.HAS_RESULT, {
    rows: pageOneRows,
    existingQueries: [
      { id: "query-other", query_no: 4, query_text: "别的检索词" },
    ],
  });
  const waiting = await run.automation.start({
    taskId: executionTask.id,
    projectId: executionTask.project_id,
  });
  // 真实检索尚未确认前不创建 Query。
  assert.equal(waiting.queryId, null);
  assert.equal(named(run, "create-query").length, 0);

  const job = await run.automation.continueAfterVerification({
    taskId: executionTask.id,
  });
  assert.deepEqual(named(run, "create-query"), [
    ["create-query", executionTask.id, executionTask.entity_name],
  ]);
  assert.equal(job.queryId, "query-7");
  assert.equal(run.queryRows.length, 2);
});

test("多个同文本历史 Query 时取 query_no 最小的 canonical，不删除不迁移", async () => {
  const { state, identity } = await modules();
  const rows = [
    {
      id: "c",
      query_no: 9,
      query_text: "恒大集团有限公司",
      created_at: "2026-01-03",
    },
    {
      id: "a",
      query_no: 2,
      query_text: " 恒大集团有限公司 ",
      created_at: "2026-01-01",
    },
    {
      id: "b",
      query_no: 5,
      query_text: "恒大集团有限公司",
      created_at: "2026-01-02",
    },
    {
      id: "d",
      query_no: 1,
      query_text: "别的检索词",
      created_at: "2026-01-04",
    },
  ];
  const frozen = JSON.stringify(rows);
  assert.equal(identity.selectCanonicalQuery(rows, "恒大集团有限公司").id, "a");
  assert.equal(
    identity.selectCanonicalQuery(rows, " 恒大集团有限公司 ").id,
    "a",
  );
  assert.equal(identity.selectCanonicalQuery(rows, ""), null);
  assert.equal(identity.selectCanonicalQuery(rows, "不存在的检索词"), null);
  // 只读选择：历史数据完全未被改动。
  assert.equal(JSON.stringify(rows), frozen);
  // query_no 异常时用 created_at、id 稳定 tie-break。
  assert.equal(
    identity.selectCanonicalQuery(
      [
        { id: "z", query_no: null, query_text: "X", created_at: "2026-01-02" },
        { id: "y", query_no: null, query_text: "X", created_at: "2026-01-01" },
      ],
      "X",
    ).id,
    "y",
  );
  assert.equal(
    identity.selectCanonicalQuery(
      [
        { id: "b", query_no: null, query_text: "X", created_at: "2026-01-01" },
        { id: "a", query_no: null, query_text: "X", created_at: "2026-01-01" },
      ],
      "X",
    ).id,
    "a",
  );
  // 检索词身份只做 trim：不合并法律意义上不同的检索词。
  assert.equal(identity.normalizeQueryText("  A B  "), "A B");
  assert.equal(
    identity.selectCanonicalQuery(
      [{ id: "x", query_no: 1, query_text: "A B" }],
      "AB",
    ),
    null,
  );

  const run = await harness(state.AUTOMATION_RESULT.NO_RESULT, {
    existingQueries: [
      { id: "q-dup-3", query_no: 3, query_text: executionTask.entity_name },
      { id: "q-dup-1", query_no: 1, query_text: executionTask.entity_name },
      { id: "q-dup-2", query_no: 2, query_text: executionTask.entity_name },
    ],
  });
  await run.automation.start({
    taskId: executionTask.id,
    projectId: executionTask.project_id,
  });
  const job = await run.automation.continueAfterVerification({
    taskId: executionTask.id,
  });
  assert.equal(job.queryId, "q-dup-1");
  assert.equal(named(run, "create-query").length, 0);
  assert.deepEqual(named(run, "archive-existing-m4"), [
    ["archive-existing-m4", "q-dup-1", 21],
  ]);
  // 历史重复 Query 原样保留。
  assert.equal(run.queryRows.length, 3);
});

test("NO_RESULT 与 HAS_RESULT 重复核查都复用同一 Query", async () => {
  const { state } = await modules();
  for (const [result, rows] of [
    [state.AUTOMATION_RESULT.NO_RESULT, []],
    [state.AUTOMATION_RESULT.HAS_RESULT, pageOneRows.slice(0, 1)],
  ]) {
    const run = await harness(result, { rows });
    await run.automation.start({
      taskId: executionTask.id,
      projectId: executionTask.project_id,
    });
    const first = await run.automation.continueAfterVerification({
      taskId: executionTask.id,
    });
    await run.automation.start({
      taskId: executionTask.id,
      projectId: executionTask.project_id,
    });
    const second = await run.automation.continueAfterVerification({
      taskId: executionTask.id,
    });
    assert.equal(first.queryId, "query-7", result);
    assert.equal(second.queryId, "query-7", result);
    assert.equal(named(run, "create-query").length, 1, result);
    assert.ok(
      named(run, "archive-existing-m4").every(
        ([, queryId]) => queryId === "query-7",
      ),
      result,
    );
    assert.equal(run.queryRows.length, 1, result);
  }
});

test("手工选中的 Query 不参与 canonical 选择", async () => {
  const { state } = await modules();
  const run = await harness(state.AUTOMATION_RESULT.NO_RESULT, {
    existingQueries: [
      {
        id: "query-canonical",
        query_no: 1,
        query_text: executionTask.entity_name,
      },
    ],
  });
  run.dependencies.selectedManualQuery = {
    id: "manual-query",
    query_text: "恒大集团有限公司",
  };
  const waiting = await run.automation.start({
    taskId: executionTask.id,
    projectId: executionTask.project_id,
  });
  assert.equal(waiting.queryText, executionTask.entity_name);
  assert.equal(waiting.queryId, "query-canonical");
  assert.deepEqual(run.calls[1], [
    "fill-entity-only",
    21,
    executionTask.entity_name,
  ]);
  const job = await run.automation.continueAfterVerification({
    taskId: executionTask.id,
  });
  assert.equal(job.queryId, "query-canonical");
  assert.equal(
    run.calls.some((call) => call.includes("manual-query")),
    false,
  );
});

test("Query 复用只读，不产生任何删除、合并或迁移动作", async () => {
  const [worker, dataSource, workflow] = await Promise.all([
    readFile(new URL("../src/worker.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/data.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/zxgk-automation.mjs", import.meta.url), "utf8"),
  ]);
  const querySection = dataSource.slice(
    dataSource.indexOf("export const taskQueries"),
  );
  for (const source of [worker, dataSource, workflow, querySection]) {
    assert.doesNotMatch(source, /method:\s*"DELETE"/);
    assert.doesNotMatch(source, /method:\s*"PATCH"/);
  }
  // 只读取已有 Query，不写回历史 Query。
  assert.match(dataSource, /export const taskQueries/);
  assert.doesNotMatch(querySection, /insert|upsert/i);
});

// ---------------------------------------------------------------------------
// M8.2a blocker fix：失败后「继续本次核查」
// ---------------------------------------------------------------------------

const tenRowPage = Array.from({ length: 10 }, (_, index) =>
  rowOf(
    index + 1,
    "某某集团有限公司",
    `（2023）粤0305执46${50 + index}号`,
    `2023年3月${10 + index}日`,
  ),
);

function invariantJob(state, adapter, patch = {}) {
  const keys = tenRowPage.map(adapter.buildRowKey);
  return {
    adapter: adapter.ZXGK_EXECUTION_ADAPTER,
    state: state.AUTOMATION_STATES.READING_RESULT_ROWS,
    taskId: executionTask.id,
    projectId: executionTask.project_id,
    queryText: executionTask.entity_name,
    queryId: "query-7",
    result: state.AUTOMATION_RESULT.HAS_RESULT,
    expectedDetailCount: keys.length,
    pageOneRowKeys: keys,
    completedDetailKeys: [],
    detailCaptures: [],
    listCapture: {
      id: "capture-list",
      query_id: "query-7",
      capture_no: 3,
    },
    currentOperation: null,
    firstPageComplete: null,
    ...patch,
  };
}

test("runtime job invariant 接受合法早期状态与第一页进度", async () => {
  const { state, adapter, workflow } = await modules();
  const validate = workflow.validateZxgkAutomationJobInvariant;
  assert.deepEqual(
    validate({
      adapter: adapter.ZXGK_EXECUTION_ADAPTER,
      state: state.AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION,
      taskId: executionTask.id,
      projectId: executionTask.project_id,
      queryText: executionTask.entity_name,
      queryId: null,
    }),
    { ok: true },
  );

  const base = invariantJob(state, adapter);
  assert.deepEqual(validate(base), { ok: true });
  const keys = base.pageOneRowKeys;
  assert.deepEqual(
    validate({
      ...base,
      completedDetailKeys: keys.slice(0, 3),
      detailCaptures: keys.slice(0, 3).map((rowKey, index) => ({
        rowKey,
        captureId: `capture-${index + 4}`,
      })),
    }),
    { ok: true },
  );
});

test("runtime job invariant 保留 DETAIL 与 LIST 的合法 Capture recovery window", async () => {
  const { state, adapter, workflow } = await modules();
  const validate = workflow.validateZxgkAutomationJobInvariant;
  const base = invariantJob(state, adapter, { listCapture: null });
  const [rowKey] = base.pageOneRowKeys;
  const caseNo = tenRowPage[0].caseNo;

  assert.deepEqual(
    validate({
      ...base,
      state: state.AUTOMATION_STATES.CAPTURING_DETAIL,
      currentOperation: {
        type: "DETAIL",
        pageNo: 1,
        rowKey,
        caseNo,
        phase: state.AUTOMATION_PHASES.CAPTURING,
        detailTabId: 901,
      },
    }),
    { ok: true },
  );
  assert.deepEqual(
    validate({
      ...base,
      state: state.AUTOMATION_STATES.RETURNING_TO_LIST,
      detailCaptures: [{ rowKey, captureId: "capture-4" }],
      currentOperation: {
        type: "DETAIL",
        pageNo: 1,
        rowKey,
        caseNo,
        phase: state.AUTOMATION_PHASES.RETURNING,
        detailTabId: 901,
        captureId: "capture-4",
      },
    }),
    { ok: true },
  );
  assert.deepEqual(
    validate({
      ...base,
      state: state.AUTOMATION_STATES.CAPTURING_LIST_PAGE,
      currentOperation: {
        type: "LIST",
        pageNo: 1,
        rowKey: null,
        caseNo: null,
        phase: state.AUTOMATION_PHASES.CAPTURING,
        captureId: "capture-list",
        capture: {
          id: "capture-list",
          query_id: "query-7",
          capture_no: 3,
        },
      },
    }),
    { ok: true },
  );
});

test("runtime job invariant 拒绝冻结集合与详情进度矛盾", async () => {
  const { state, adapter, workflow } = await modules();
  const validate = workflow.validateZxgkAutomationJobInvariant;
  const base = invariantJob(state, adapter);
  const duplicateKeys = [...base.pageOneRowKeys];
  duplicateKeys[1] = duplicateKeys[0];

  assert.equal(
    validate({ ...base, pageOneRowKeys: duplicateKeys }).code,
    "ROW_KEYS_DUPLICATE",
  );
  assert.equal(
    validate({ ...base, completedDetailKeys: ["unknown-row"] }).code,
    "COMPLETED_KEY_UNKNOWN",
  );
  assert.equal(
    validate({ ...base, expectedDetailCount: 9 }).code,
    "EXPECTED_COUNT_MISMATCH",
  );
  assert.equal(
    validate({
      ...base,
      listCapture: { ...base.listCapture, query_id: "query-other" },
    }).code,
    "LIST_CAPTURE_QUERY_MISMATCH",
  );
  assert.equal(
    validate({
      ...base,
      currentOperation: {
        type: "DETAIL",
        pageNo: 1,
        rowKey: "unknown-row",
        caseNo: "（2026）错误案号",
        phase: state.AUTOMATION_PHASES.CAPTURING,
      },
    }).code,
    "DETAIL_OPERATION_KEY_UNKNOWN",
  );
});

test("runtime job invariant 严格校验 FIRST_PAGE_COMPLETE", async () => {
  const { state, adapter, workflow } = await modules();
  const validate = workflow.validateZxgkAutomationJobInvariant;
  const base = invariantJob(state, adapter);
  const summary = { pageNo: 1, detailCount: 10, newCaptures: 11 };

  assert.equal(
    validate({
      ...base,
      state: state.AUTOMATION_STATES.FIRST_PAGE_COMPLETE,
      firstPageComplete: summary,
      completedDetailKeys: base.pageOneRowKeys.slice(0, 9),
    }).code,
    "COMPLETE_DETAILS_MISSING",
  );
  assert.equal(
    validate({
      ...base,
      state: state.AUTOMATION_STATES.FIRST_PAGE_COMPLETE,
      firstPageComplete: summary,
      completedDetailKeys: base.pageOneRowKeys,
      currentOperation: {
        type: "LIST",
        pageNo: 1,
        rowKey: null,
        caseNo: null,
        phase: state.AUTOMATION_PHASES.VERIFYING,
      },
    }).code,
    "COMPLETE_OPERATION_ACTIVE",
  );
  assert.equal(
    validate({
      ...base,
      state: state.AUTOMATION_STATES.FIRST_PAGE_COMPLETE,
      firstPageComplete: null,
      completedDetailKeys: base.pageOneRowKeys,
    }).code,
    "COMPLETE_MARKER_MISSING",
  );
  assert.equal(
    validate({ ...base, firstPageComplete: summary }).code,
    "COMPLETE_STATE_MISMATCH",
  );
  assert.deepEqual(
    validate({
      ...base,
      state: state.AUTOMATION_STATES.FIRST_PAGE_COMPLETE,
      firstPageComplete: summary,
      completedDetailKeys: base.pageOneRowKeys,
    }),
    { ok: true },
  );
});

/** 跑到指定条失败，返回同一个 run（同一个 automationJob）。 */
async function failOnDetail(options) {
  const run = await runFirstPage({ rows: tenRowPage, ...options });
  await assert.rejects(
    run.automation.continueAfterVerification({ taskId: executionTask.id }),
  );
  return run;
}

test("resume 遇到非法持久化 job 时在任何外部动作前 fail closed", async () => {
  const { state } = await modules();
  const run = await failOnDetail({
    archiveFailure: ({ kind, detailIndex }) =>
      kind === "detail" && detailIndex === 2,
  });
  const duplicateKeys = [...run.job.pageOneRowKeys];
  duplicateKeys[1] = duplicateKeys[0];
  run.replaceJob({ ...run.job, pageOneRowKeys: duplicateKeys });
  const callsBefore = run.calls.length;
  const queryCreatesBefore = named(run, "create-query").length;
  const archivesBefore = named(run, "archive-existing-m4").length;
  const detailOpensBefore = named(run, "open-detail").length;

  await assert.rejects(
    run.automation.resume({ taskId: executionTask.id }),
    /恢复状态不完整或不一致.*ROW_KEYS_DUPLICATE/,
  );

  assert.equal(run.job.state, state.AUTOMATION_STATES.FAILED);
  assert.match(run.job.error, /已生成留痕不会删除/);
  assert.equal(run.calls.length, callsBefore);
  assert.equal(named(run, "create-query").length, queryCreatesBefore);
  assert.equal(named(run, "archive-existing-m4").length, archivesBefore);
  assert.equal(named(run, "open-detail").length, detailOpensBefore);
});

test("详情处理到第 6 条失败后，继续本次核查从第 6 条开始", async () => {
  const { state, adapter } = await modules();
  const keys = tenRowPage.map(adapter.buildRowKey);
  const run = await failOnDetail({
    archiveFailure: ({ kind, detailIndex }) =>
      kind === "detail" && detailIndex === 5,
  });
  const failed = run.job;
  assert.equal(failed.state, state.AUTOMATION_STATES.FAILED);
  assert.equal(state.canResumeFirstPage(failed), true);
  assert.equal(failed.queryId, "query-7");
  assert.equal(failed.listCapture.capture_no, 3);
  assert.deepEqual(failed.completedDetailKeys, keys.slice(0, 5));
  assert.equal(failed.detailCaptures.length, 5);
  assert.equal(failed.expectedDetailCount, 10);

  // 继续本次核查：重新查询 → 校验第一页集合 → 跳过已完成项
  await run.automation.resume({ taskId: executionTask.id });
  assert.equal(
    run.job.state,
    state.AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION,
  );
  assert.equal(run.job.queryId, "query-7");

  const job = await run.automation.continueAfterVerification({
    taskId: executionTask.id,
  });
  assert.equal(job.state, state.AUTOMATION_STATES.FIRST_PAGE_COMPLETE);
  assert.notEqual(job.state, state.AUTOMATION_STATES.DONE);
  // 不创建新 Query，也不切换 Query。
  assert.equal(named(run, "create-query").length, 1);
  assert.equal(job.queryId, "query-7");
  // 列表留痕没有重复：全程只有一次列表归档。
  assert.equal(
    named(run, "archive-existing-m4").filter(([, , tabId]) => tabId === 21)
      .length,
    1,
  );
  // 最终仍是 1 个列表 + 10 个唯一详情：失败的那次尝试没有产生 Capture。
  // 列表 + 10 条详情 = 11 份留痕，编号 3（列表）与 4–13（详情）连续且不重复。
  assert.equal(job.listCapture.capture_no, 3);
  assert.deepEqual(
    job.detailCaptures.map((item) => item.captureNo),
    [4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  );
  assert.equal(new Set(job.detailCaptures.map((item) => item.captureNo)).size, 10);
  assert.equal(job.detailCaptures.length, 10);
  assert.equal(new Set(job.detailCaptures.map((item) => item.caseNo)).size, 10);
  assert.deepEqual(job.completedDetailKeys, keys);
  // 已完成的 1–5 不再打开，继续时从第 6 条（含重试）开始。
  assert.deepEqual(
    named(run, "open-detail").slice(6).map(([, rowKey]) => rowKey),
    keys.slice(5),
  );
  assert.equal(job.currentOperation, null);
});

test("列表已经留痕时，继续本次核查不会重复生成列表留痕", async () => {
  const { state } = await modules();
  const run = await failOnDetail({
    archiveFailure: ({ kind, detailIndex }) =>
      kind === "detail" && detailIndex === 0,
  });
  assert.equal(run.job.listCapture.capture_no, 3);
  assert.equal(run.job.completedDetailKeys.length, 0);
  // 列表 1 次 + 第 1 条失败的那次尝试（未产生 Capture）。
  assert.equal(named(run, "archive-existing-m4").length, 2);

  await run.automation.resume({ taskId: executionTask.id });
  const job = await run.automation.continueAfterVerification({
    taskId: executionTask.id,
  });
  assert.equal(job.state, state.AUTOMATION_STATES.FIRST_PAGE_COMPLETE);
  assert.equal(job.listCapture.capture_no, 3);
  assert.equal(
    named(run, "archive-existing-m4").filter(([, , tabId]) => tabId === 21)
      .length,
    1,
  );
  assert.equal(job.detailCaptures.length, 10);
  assert.deepEqual(
    job.detailCaptures.map((item) => item.captureNo),
    [4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  );
});

test("继续本次核查仍停在 CAPTCHA 人工接管，不跳过人工验证", async () => {
  const { state } = await modules();
  const run = await failOnDetail({
    archiveFailure: ({ kind, detailIndex }) =>
      kind === "detail" && detailIndex === 1,
  });
  const resumed = await run.automation.resume({ taskId: executionTask.id });
  assert.equal(
    resumed.state,
    state.AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION,
  );
  assert.equal(state.canResumeFirstPage(resumed), false);
  assert.equal(named(run, "inspect-after-human").length, 1);
});

test("Capture 已成功但尚未补记进度时，继续本次核查不重复留痕该条", async () => {
  const { state, adapter } = await modules();
  const keys = tenRowPage.map(adapter.buildRowKey);
  const run = await failOnDetail({
    // 第 3 条详情归档成功，但返回列表阶段失败。
    closeFailure: ({ detailIndex }) => detailIndex === 2,
  });
  const failed = run.job;
  assert.equal(failed.state, state.AUTOMATION_STATES.FAILED);
  // Capture 已经真正生成，captureId 已落盘，但还未补记 completedDetailKeys。
  assert.deepEqual(failed.completedDetailKeys, keys.slice(0, 2));
  assert.equal(failed.currentOperation.captureId, "capture-6");
  assert.equal(failed.currentOperation.rowKey, keys[2]);
  assert.equal(failed.detailCaptures.length, 3);
  assert.equal(named(run, "archive-existing-m4").length, 4);

  await run.automation.resume({ taskId: executionTask.id });
  const job = await run.automation.continueAfterVerification({
    taskId: executionTask.id,
  });
  assert.equal(job.state, state.AUTOMATION_STATES.FIRST_PAGE_COMPLETE);
  // 第 3 条没有再次留痕：共 11 份 = 1 列表 + 10 详情，编号连续且不重复。
  assert.equal(named(run, "archive-existing-m4").length, 11);
  assert.equal(job.listCapture.capture_no, 3);
  assert.deepEqual(
    job.detailCaptures.map((item) => item.captureNo),
    [4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  );
  // 第 3 条已补记为完成，因此继续时不会再次打开它的详情。
  assert.deepEqual(
    named(run, "open-detail").map(([, rowKey]) => rowKey),
    [...keys.slice(0, 3), ...keys.slice(3)],
  );
  assert.deepEqual(job.completedDetailKeys, keys);
  assert.equal(job.detailCaptures.length, 10);
});

test("currentOperation 没有 captureId 时，继续本次核查会重试该条", async () => {
  const { state, adapter } = await modules();
  const keys = tenRowPage.map(adapter.buildRowKey);
  const run = await failOnDetail({
    archiveFailure: ({ kind, detailIndex }) =>
      kind === "detail" && detailIndex === 2,
  });
  assert.equal(run.job.currentOperation.captureId, undefined);
  assert.deepEqual(run.job.completedDetailKeys, keys.slice(0, 2));
  await run.automation.resume({ taskId: executionTask.id });
  const job = await run.automation.continueAfterVerification({
    taskId: executionTask.id,
  });
  assert.equal(job.state, state.AUTOMATION_STATES.FIRST_PAGE_COMPLETE);
  // 第 3 条被重试一次，且只重试一次。
  assert.deepEqual(
    named(run, "open-detail").map(([, rowKey]) => rowKey),
    [...keys.slice(0, 3), ...keys.slice(2)],
  );
  // 只有 10 条详情真正留痕，编号连续且不重复。
  assert.equal(job.detailCaptures.length, 10);
  assert.deepEqual(
    job.detailCaptures.map((item) => item.captureNo),
    [4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  );
});

test("列表留痕 finalize 成功但尚未补记时，继续本次核查绝不重复留痕列表", async () => {
  const { state, adapter } = await modules();
  const keys = tenRowPage.map(adapter.buildRowKey);
  const run = await runFirstPage({
    rows: tenRowPage,
    // 精确窗口：列表 Capture 已经在数据库 finalize 成功，但在“写 listCapture
    // 收尾”的那一次写入之前进程被杀。
    killBefore: ({ next }) => Boolean(next.listCapture),
  });
  await assert.rejects(
    run.automation.continueAfterVerification({ taskId: executionTask.id }),
    /worker killed/,
  );
  const crashed = run.job;
  // 崩溃现场：成功标记已经落盘，listCapture 还没有。
  assert.equal(crashed.listCapture, null);
  assert.equal(crashed.currentOperation.type, "LIST");
  assert.equal(crashed.currentOperation.captureId, "capture-3");
  assert.equal(crashed.currentOperation.capture.capture_no, 3);
  assert.equal(crashed.queryId, "query-7");
  assert.equal(
    named(run, "archive-existing-m4").filter(([, , tabId]) => tabId === 21)
      .length,
    1,
  );
  // 中断当场还不能“继续”：必须先经过 worker 启动扫描把它标记为 FAILED。
  assert.equal(
    state.AUTOMATION_INTERRUPTED_STATES.includes(crashed.state),
    true,
  );
  assert.equal(state.canResumeFirstPage(crashed), false);

  run.interrupt();
  assert.equal(run.job.state, state.AUTOMATION_STATES.FAILED);
  assert.equal(state.canResumeFirstPage(run.job), true);
  // 进度显示也不谎报“待留痕”。
  assert.equal(state.hasListCapture(run.job), true);

  await run.automation.resume({ taskId: executionTask.id });
  const job = await run.automation.continueAfterVerification({
    taskId: executionTask.id,
  });
  assert.equal(job.state, state.AUTOMATION_STATES.FIRST_PAGE_COMPLETE);
  assert.notEqual(job.state, state.AUTOMATION_STATES.DONE);
  // 列表全程只归档过一次：绝不重复 Capture 列表，也没有多消耗一个编号。
  assert.equal(
    named(run, "archive-existing-m4").filter(([, , tabId]) => tabId === 21)
      .length,
    1,
  );
  assert.equal(job.listCapture.id, "capture-3");
  assert.equal(job.listCapture.capture_no, 3);
  assert.equal(job.listFilename, crashed.currentOperation.filename);
  assert.deepEqual(
    job.detailCaptures.map((item) => item.captureNo),
    [4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  );
  assert.deepEqual(job.completedDetailKeys, keys);
  assert.equal(job.currentOperation, null);
  // 列表已留痕，继续时直接从第 1 条详情开始。
  assert.deepEqual(
    named(run, "open-detail").map(([, rowKey]) => rowKey),
    keys,
  );
  // 仍然是同一轮、同一个 Query。
  assert.equal(named(run, "create-query").length, 1);
  assert.equal(job.queryId, "query-7");
});

test("列表留痕在 finalize 返回前中断时，继续本次核查会重新归档列表（已知残余窗口）", async () => {
  const { state } = await modules();
  const run = await runFirstPage({
    rows: tenRowPage,
    // 最窄的窗口：数据库已生成列表 Capture，但连“成功标记”都还没来得及落盘。
    killAfterListArchive: true,
  });
  await assert.rejects(
    run.automation.continueAfterVerification({ taskId: executionTask.id }),
    /worker killed/,
  );
  const crashed = run.job;
  // 崩溃现场：currentOperation 仍是“正在留痕”，本地没有任何成功证据。
  assert.equal(crashed.listCapture, null);
  assert.equal(crashed.currentOperation.type, "LIST");
  assert.equal(crashed.currentOperation.captureId, undefined);
  assert.equal(state.hasListCapture(crashed), false);

  run.interrupt();
  await run.automation.resume({ taskId: executionTask.id });
  const job = await run.automation.continueAfterVerification({
    taskId: executionTask.id,
  });
  assert.equal(job.state, state.AUTOMATION_STATES.FIRST_PAGE_COMPLETE);
  // 记录当前已知行为：本地没有成功标记，因此继续时会再归档一次列表。
  // 关闭它需要把稳定的 request_id 透传给 M4 归档链路（reserve_capture_upload
  // 已按 p_capture_id 幂等，见 supabase/migrations/202609140004_milestone_4.sql），
  // 本轮未做；这条断言就是那道窗口的看门人。
  assert.equal(
    named(run, "archive-existing-m4").filter(([, , tabId]) => tabId === 21)
      .length,
    2,
  );
  assert.equal(job.listCapture.capture_no, 4);
  assert.deepEqual(
    job.detailCaptures.map((item) => item.captureNo),
    [5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  );
  assert.equal(job.detailCaptures.length, 10);
  assert.equal(job.currentOperation, null);
});

test("继续本次核查时页面顺序变化但集合一致，仍按原冻结 rowKey 继续", async () => {
  const { state, adapter } = await modules();
  const keys = tenRowPage.map(adapter.buildRowKey);
  const run = await failOnDetail({
    archiveFailure: ({ kind, detailIndex }) =>
      kind === "detail" && detailIndex === 2,
  });
  run.list.rows.reverse();
  await run.automation.resume({ taskId: executionTask.id });
  const job = await run.automation.continueAfterVerification({
    taskId: executionTask.id,
  });
  assert.equal(job.state, state.AUTOMATION_STATES.FIRST_PAGE_COMPLETE);
  assert.deepEqual(
    named(run, "open-detail").slice(3).map(([, rowKey]) => rowKey),
    keys.slice(2),
  );
  assert.deepEqual(job.completedDetailKeys, keys);
});

test("继续本次核查时结果集合变化（增加/减少/重复）都 fail closed", async () => {
  for (const mutate of [
    {
      name: "增加",
      apply: (rows) => [
        ...rows,
        rowOf(11, "某某集团有限公司", "（2023）粤0305执4799号", "2023年6月1日"),
      ],
    },
    { name: "减少", apply: (rows) => rows.slice(0, 9) },
    { name: "重复", apply: (rows) => [...rows.slice(0, 9), { ...rows[0] }] },
  ]) {
    const { state } = await modules();
    const run = await failOnDetail({
      archiveFailure: ({ kind, detailIndex }) =>
        kind === "detail" && detailIndex === 1,
    });
    const archivesBefore = named(run, "archive-existing-m4").length;
    run.list.rows = mutate.apply(run.list.rows);
    await run.automation.resume({ taskId: executionTask.id });
    await assert.rejects(
      run.automation.continueAfterVerification({ taskId: executionTask.id }),
      /结果集合已变化|重复结果/,
      mutate.name,
    );
    assert.equal(run.job.state, state.AUTOMATION_STATES.FAILED, mutate.name);
    assert.notEqual(
      run.job.state,
      state.AUTOMATION_STATES.FIRST_PAGE_COMPLETE,
      mutate.name,
    );
    // 没有继续产生新的 Capture，已生成的留痕全部保留。
    assert.equal(
      named(run, "archive-existing-m4").length,
      archivesBefore,
      mutate.name,
    );
    assert.equal(run.job.queryId, "query-7", mutate.name);
    assert.equal(run.job.listCapture.capture_no, 3, mutate.name);
    // 进度仍然保留，可人工核对后再次决定。
    assert.equal(state.canResumeFirstPage(run.job), true, mutate.name);
  }
});

test("继续本次核查时 Task 变化或选择不匹配都 fail closed", async () => {
  const { state } = await modules();
  const run = await failOnDetail({
    archiveFailure: ({ kind, detailIndex }) =>
      kind === "detail" && detailIndex === 1,
  });
  const archivesBefore = named(run, "archive-existing-m4").length;
  await assert.rejects(
    run.automation.resume({ taskId: "task-other" }),
    /Task 已变化/,
  );
  assert.equal(named(run, "archive-existing-m4").length, archivesBefore);

  run.dependencies.getTask = async () => ({
    ...executionTask,
    entity_name: "被修改的主体",
  });
  await assert.rejects(
    run.automation.resume({ taskId: executionTask.id }),
    /Task 内容或归属已经变化/,
  );
  assert.equal(run.job.state, state.AUTOMATION_STATES.FAILED);
  assert.equal(named(run, "archive-existing-m4").length, archivesBefore);
});

test("没有第一页进度时不提供「继续本次核查」", async () => {
  const { state } = await modules();
  const run = await harness(state.AUTOMATION_RESULT.NO_RESULT);
  await run.automation.start({
    taskId: executionTask.id,
    projectId: executionTask.project_id,
  });
  await run.automation.continueAfterVerification({
    taskId: executionTask.id,
  });
  assert.equal(state.canResumeFirstPage(run.job), false);
  await assert.rejects(
    run.automation.resume({ taskId: executionTask.id }),
    /没有可继续的第一页核查进度/,
  );
});

test("canResumeFirstPage 只在存在未完成第一页进度时为真", async () => {
  const { state } = await modules();
  const base = {
    state: state.AUTOMATION_STATES.FAILED,
    result: state.AUTOMATION_RESULT.HAS_RESULT,
    queryId: "query-7",
    pageOneRowKeys: ["k"],
  };
  assert.equal(state.canResumeFirstPage(base), true);
  assert.equal(
    state.canResumeFirstPage({
      ...base,
      result: state.AUTOMATION_RESULT.NO_RESULT,
    }),
    false,
  );
  assert.equal(state.canResumeFirstPage({ ...base, queryId: null }), false);
  assert.equal(state.canResumeFirstPage({ ...base, pageOneRowKeys: [] }), false);
  assert.equal(
    state.canResumeFirstPage({ ...base, pageOneRowKeys: null }),
    false,
  );
  assert.equal(
    state.canResumeFirstPage({
      ...base,
      state: state.AUTOMATION_STATES.FIRST_PAGE_COMPLETE,
    }),
    false,
  );
  assert.equal(
    state.canResumeFirstPage({
      ...base,
      state: state.AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION,
    }),
    false,
  );
});

test("Side Panel 提供「继续本次核查」，与重新开始区分", async () => {
  const [panel, html] = await Promise.all([
    readFile(new URL("../src/sidepanel.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/sidepanel.html", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="automation-resume"/);
  assert.match(html, /继续本次核查/);
  assert.match(html, /id="automation-resume-block"/);
  assert.match(panel, /deriveZxgkAutomationProgressViewModel\(automationJob\)/);
  assert.match(panel, /const resumable = progress\.canResume/);
  assert.match(panel, /automation-resume"\)\.onclick/);
  assert.match(panel, /本次核查未完成/);
  assert.match(panel, /下一项：/);
  assert.match(panel, /放弃本次核查/);
  // 有未完成进度时主要动作是继续，而不是再次自动核查。
  assert.match(panel, /\$\("automation-start"\)\.hidden = resumable/);
  assert.match(panel, /\$\("automation-resume"\)\.hidden = !resumable/);
  assert.doesNotMatch(panel, /自动核查完成|全部核查完成|已全部留痕/);
});

test("worker 暴露继续本次核查，且复用共享归档链路", async () => {
  const worker = await readFile(
    new URL("../src/worker.mjs", import.meta.url),
    "utf8",
  );
  assert.match(worker, /message\?\.type === "automation-resume"/);
  assert.match(worker, /automation\.resume\(\{ taskId: message\.taskId \}\)/);
  assert.match(worker, /listTaskQueries: data\.taskQueries/);
  assert.match(worker, /archiveQuery: \(queryId, tabId\) =>\s*\n?\s*archive\(queryId, tabId, "automation"\)/);
  assert.doesNotMatch(worker, /reserve_capture_upload|finish_capture_upload/);
  assert.doesNotMatch(worker, /max\(capture_no\)|capture_no \+ 1/);
});

test("继续本次核查也绝不点击任何分页控件", async () => {
  const [adapter, worker, workflow] = await Promise.all([
    readFile(
      new URL("../src/adapters/zxgk-execution.mjs", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/worker.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/zxgk-automation.mjs", import.meta.url), "utf8"),
  ]);
  // adapter 允许持有分页事实；继续核查路径本身仍然不得触碰分页动作。
  for (const source of [worker, workflow]) {
    assert.doesNotMatch(source, /下一页|尾页/);
    assert.doesNotMatch(source, /nextPage|lastPage|prePage|goPage/);
    assert.doesNotMatch(source, /#next-btn|#last-btn|#pre-btn|#goto/);
  }
  assert.match(workflow, /reconcileFrozenSet/);
  assert.match(adapter, /#currentPage-show/);
  assert.match(adapter, /#totalPage-show/);
});

test("hasListCapture 把“已 finalize 但尚未收尾”也算作列表已留痕", async () => {
  const { state } = await modules();
  assert.equal(state.hasListCapture({ listCapture: { id: "capture-3" } }), true);
  assert.equal(
    state.hasListCapture({
      listCapture: null,
      currentOperation: { type: "LIST", captureId: "capture-3" },
    }),
    true,
  );
  assert.equal(
    state.hasListCapture({
      listCapture: null,
      currentOperation: { type: "LIST", phase: "CAPTURING" },
    }),
    false,
  );
  // 详情操作的成功标记不能冒充列表留痕。
  assert.equal(
    state.hasListCapture({
      listCapture: null,
      currentOperation: { type: "DETAIL", captureId: "capture-6" },
    }),
    false,
  );
  assert.equal(state.hasListCapture(null), false);
});

test("Side Panel 的列表留痕进度使用 hasListCapture，不谎报待留痕", async () => {
  const [panel, progressView] = await Promise.all([
    readFile(new URL("../src/sidepanel.mjs", import.meta.url), "utf8"),
    readFile(
      new URL("../src/lib/automation-progress-view.mjs", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(panel, /progress\.listCaptureComplete/);
  assert.match(progressView, /hasListCapture\(job\)/);
  assert.doesNotMatch(panel, /listCapture \?/);
});

test("原自动化标签页仍在时，继续本次核查复用它，不新建标签页", async () => {
  const { state } = await modules();
  const run = await failOnDetail({
    archiveFailure: ({ kind, detailIndex }) =>
      kind === "detail" && detailIndex === 2,
  });
  // 首次开始核查时，openQueryPage 收到的就是活动标签页当时的 URL。
  assert.deepEqual(run.openedUrls, [
    { tabId: 21, currentUrl: "https://example.com/" },
  ]);
  const resumed = await run.automation.resume({ taskId: executionTask.id });
  // 仍然是同一轮：同一个 Query、同一份已完成进度。
  assert.equal(resumed.queryId, "query-7");
  assert.equal(resumed.completedDetailKeys.length, 2);
  assert.equal(
    resumed.state,
    state.AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION,
  );
  // 原自动化标签页仍存在 → 直接复用，一个都不新建。
  assert.equal(resumed.tabId, 21);
  assert.equal(named(run, "create-tab").length, 0);
  // 把该标签页的“当前 URL”交给 openQueryPage 判断：是否重新导航回查询入口
  // 由 worker 决定，而不是假设页面还能用。
  assert.deepEqual(run.openedUrls.at(-1), { tabId: 21, currentUrl: listUrl });
  // 重新填主体 → 重新提交 → 再次等人工验证。
  assert.deepEqual(run.calls.slice(-3), [
    ["open", 21],
    ["fill-entity-only", 21, executionTask.entity_name],
    ["submit", 21],
  ]);
  // 重建环境后停在人工验证：resume 自己不检查结果，必须由人过 CAPTCHA。
  assert.equal(named(run, "inspect-after-human").length, 1);
});

test("原自动化标签页已关闭时，新建标签页并写回 job，不导航用户当前活动标签页", async () => {
  const { state } = await modules();
  const run = await failOnDetail({
    archiveFailure: ({ kind, detailIndex }) =>
      kind === "detail" && detailIndex === 2,
  });
  // 原自动化标签页被关掉；用户此刻正在浏览的标签页是 88。
  run.closeListTab();
  const activeTabQueries = [];
  run.dependencies.getActiveTab = async () => {
    activeTabQueries.push(1);
    return { id: 88, url: "https://user.example.com/reading" };
  };

  const resumed = await run.automation.resume({ taskId: executionTask.id });

  // 新建了一个专用标签页，并把新 tab.id 写回 automationJob。
  const created = named(run, "create-tab");
  assert.equal(created.length, 1);
  const newTabId = created[0][1];
  assert.equal(resumed.tabId, newTabId);
  assert.equal(run.job.tabId, newTabId);
  assert.notEqual(newTabId, 88);
  // 用户当前活动标签页从头到尾没有参与，也没有被导航。
  assert.equal(activeTabQueries.length, 0);
  assert.equal(
    run.calls.some((call) => call[0] === "open" && call[1] === 88),
    false,
  );
  assert.deepEqual(run.openedUrls.at(-1), {
    tabId: newTabId,
    currentUrl: listUrl,
  });
  // 后续流程与复用原标签页完全一致：查询 → 重新填主体 → 重新提交 → 人工验证。
  assert.deepEqual(run.calls.slice(-3), [
    ["open", newTabId],
    ["fill-entity-only", newTabId, executionTask.entity_name],
    ["submit", newTabId],
  ]);
  assert.equal(
    resumed.state,
    state.AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION,
  );
  // 同一轮：复用同一个 Query，没有新建。
  assert.equal(resumed.queryId, "query-7");
  assert.equal(named(run, "create-query").length, 1);
  assert.equal(resumed.completedDetailKeys.length, 2);
});

test("新建标签页后，人工验证 → reconcile → 继续未完成项照常走完", async () => {
  const { state, adapter } = await modules();
  const keys = tenRowPage.map(adapter.buildRowKey);
  const run = await failOnDetail({
    archiveFailure: ({ kind, detailIndex }) =>
      kind === "detail" && detailIndex === 2,
  });
  run.closeListTab();
  // 只观察“继续”之后新产生的调用，避免混入第一轮核查的痕迹。
  const afterResume = run.calls.length;
  await run.automation.resume({ taskId: executionTask.id });
  const newTabId = run.job.tabId;
  assert.notEqual(newTabId, 21);

  // 人工过 CAPTCHA 后点“重新检查结果”：resumeFirstPage 在新标签页上重新读第 1 页，
  // 与原 pageOneRowKeys 严格 reconcile 后继续未完成项。
  const finished = await run.automation.continueAfterVerification({
    taskId: executionTask.id,
  });
  const reads = run.calls
    .slice(afterResume)
    .filter((call) => call[0] === "read-list");
  assert.ok(reads.length >= 1);
  assert.equal(
    reads.every((call) => call[1] === newTabId),
    true,
  );
  assert.equal(finished.state, state.AUTOMATION_STATES.FIRST_PAGE_COMPLETE);
  assert.deepEqual(finished.completedDetailKeys, keys);
  // 列表没有因为换标签页而重复留痕：继续后只归档了 8 条未完成详情，
  // 列表仍是第一轮那一份（capture_no 仍为 3），详情编号据此连续不重复。
  assert.equal(
    run.calls
      .slice(afterResume)
      .filter((call) => call[0] === "archive-existing-m4").length,
    8,
  );
  assert.equal(finished.listCapture.capture_no, 3);
  assert.equal(finished.detailCaptures.length, 10);
  assert.deepEqual(
    finished.detailCaptures.map((item) => item.captureNo),
    [4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  );
  assert.equal(finished.firstPageComplete.detailCount, 10);
  // 依旧没有任何分页动作。
  assert.equal(named(run, "click-page").length, 0);
});

test("automationJob.queryId 已不存在时，继续本次核查 fail closed", async () => {
  const { state } = await modules();
  const run = await failOnDetail({
    archiveFailure: ({ kind, detailIndex }) =>
      kind === "detail" && detailIndex === 2,
  });
  const before = run.calls.length;
  // Query 被删除，或当前账号已无权访问。
  run.dependencies.getQuery = async (queryId) => {
    run.calls.push(["get-query", queryId]);
    return null;
  };

  await assert.rejects(
    run.automation.resume({ taskId: executionTask.id }),
    /本次核查关联的 Query 已不存在或无法访问，无法安全继续本次核查/,
  );

  assert.equal(run.job.state, state.AUTOMATION_STATES.FAILED);
  assert.match(run.job.error, /已生成 Capture 不删除/);
  // fail closed 发生在任何页面 / 标签页 / 数据库写动作之前：
  // 不新建 Query、不创建标签页、不重新查询、不产生任何 Capture。
  assert.deepEqual(run.calls.slice(before), [["get-query", "query-7"]]);
  assert.equal(named(run, "create-query").length, 1);
  assert.equal(named(run, "create-tab").length, 0);
  assert.equal(named(run, "open").length, 1);
  assert.equal(named(run, "fill-entity-only").length, 1);
  assert.equal(named(run, "submit").length, 1);
  // 已生成的进度与 Capture 原样保留，但不会继续往下跑。
  assert.equal(run.job.queryId, "query-7");
  assert.equal(run.job.completedDetailKeys.length, 2);
  assert.equal(run.job.tabId, 21);
});

test("automationJob.queryId 属于其他 Task 时，继续本次核查 fail closed", async () => {
  const { state } = await modules();
  const run = await failOnDetail({
    archiveFailure: ({ kind, detailIndex }) =>
      kind === "detail" && detailIndex === 2,
  });
  const before = run.calls.length;
  run.dependencies.getQuery = async (queryId) => {
    run.calls.push(["get-query", queryId]);
    return {
      id: queryId,
      task_id: "task-other",
      query_no: 7,
      query_text: executionTask.entity_name,
    };
  };

  await assert.rejects(
    run.automation.resume({ taskId: executionTask.id }),
    /无法安全继续本次核查/,
  );
  assert.equal(run.job.state, state.AUTOMATION_STATES.FAILED);
  assert.deepEqual(run.calls.slice(before), [["get-query", "query-7"]]);
  assert.equal(named(run, "create-query").length, 1);
});

test("automationJob.queryId 的检索词与 job.queryText 不一致时 fail closed", async () => {
  const { state } = await modules();
  const run = await failOnDetail({
    archiveFailure: ({ kind, detailIndex }) =>
      kind === "detail" && detailIndex === 2,
  });
  const before = run.calls.length;
  run.dependencies.getQuery = async (queryId) => {
    run.calls.push(["get-query", queryId]);
    return {
      id: queryId,
      task_id: executionTask.id,
      query_no: 7,
      query_text: "另一个主体名称",
    };
  };

  await assert.rejects(
    run.automation.resume({ taskId: executionTask.id }),
    /无法安全继续本次核查/,
  );
  assert.equal(run.job.state, state.AUTOMATION_STATES.FAILED);
  assert.deepEqual(run.calls.slice(before), [["get-query", "query-7"]]);
  assert.equal(named(run, "create-query").length, 1);
});

test("检索词只差首尾空白仍算一致，继续本次核查不被拦", async () => {
  const { state } = await modules();
  const run = await failOnDetail({
    archiveFailure: ({ kind, detailIndex }) =>
      kind === "detail" && detailIndex === 2,
  });
  // normalizeQueryText 只做 trim：空白差异不改变 Query 身份。
  run.dependencies.getQuery = async (queryId) => ({
    id: queryId,
    task_id: executionTask.id,
    query_no: 7,
    query_text: `  ${executionTask.entity_name}  `,
  });

  const resumed = await run.automation.resume({ taskId: executionTask.id });
  assert.equal(
    resumed.state,
    state.AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION,
  );
  assert.equal(resumed.queryId, "query-7");
  assert.equal(resumed.completedDetailKeys.length, 2);
  assert.equal(named(run, "create-query").length, 1);
});

test("手工 Query 已失效不影响自动核查：resume 只认 automationJob.queryId", async () => {
  const { state } = await modules();
  const run = await failOnDetail({
    existingQueries: [
      { id: "query-manual", query_no: 1, query_text: "另一个手工检索词" },
    ],
    archiveFailure: ({ kind, detailIndex }) =>
      kind === "detail" && detailIndex === 2,
  });
  // 手工下拉框里选中的那条 Query 已被删除（getQuery 只对它返回 null）。
  run.dependencies.getQuery = async (queryId) => {
    run.calls.push(["get-query", queryId]);
    if (queryId === "query-manual") return null;
    const row = run.queryRows.find((item) => item.id === queryId);
    return row ? { ...row } : null;
  };
  const before = run.calls.length;

  const resumed = await run.automation.resume({ taskId: executionTask.id });

  // 自动核查仍然继续：用的是 automationJob.queryId，不是手工选中的那条。
  assert.equal(
    resumed.state,
    state.AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION,
  );
  assert.equal(resumed.queryId, "query-7");
  assert.notEqual(resumed.queryId, "query-manual");
  assert.equal(resumed.completedDetailKeys.length, 2);
  assert.equal(named(run, "create-query").length, 1);
  assert.deepEqual(
    run.calls
      .slice(before)
      .filter((call) => call[0] === "get-query")
      .map((call) => call[1]),
    ["query-7"],
  );
});

test("手工 Query 的错误文案与自动核查文案彻底分开", async () => {
  const [data, worker, workflow, archiveBridge] = await Promise.all([
    readFile(new URL("../src/lib/data.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/worker.mjs", import.meta.url), "utf8"),
    readFile(
      new URL("../src/lib/zxgk-automation.mjs", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/lib/archive-bridge.mjs", import.meta.url), "utf8"),
  ]);
  // 数据层只给上下文无关的标记，不再自带“手工”或“自动”的口径。
  assert.doesNotMatch(data, /Query 已删除或无权访问，请重新选择。/);
  assert.match(data, /QUERY_NOT_ACCESSIBLE/);
  assert.match(data, /该 Query 不存在或当前账号无权访问。/);
  // 手工上下文明确写出“当前手工 Query”。
  assert.match(
    worker,
    /manual: "当前手工 Query 已删除或无法访问，请重新选择。"/,
  );
  // 自动核查上下文用自动化层导出的同一句文案，且归档时显式传 automation 上下文。
  assert.match(worker, /automation: AUTOMATION_QUERY_UNAVAILABLE_MESSAGE/);
  assert.match(
    worker,
    /archiveQuery: \(queryId, tabId\) => archive\(queryId, tabId, "automation"\)/,
  );
  assert.match(workflow, /export const AUTOMATION_QUERY_UNAVAILABLE_MESSAGE =/);
  assert.match(workflow, /已生成 Capture 不删除/);
  // Query 失效不等于网络/登录错误：只重写“读不到 Query”这一类。
  assert.match(worker, /queryNotAccessibleCode: data\.QUERY_NOT_ACCESSIBLE/);
  assert.match(
    archiveBridge,
    /if \(error\?\.code !== queryNotAccessibleCode\) throw error;/,
  );
});

test("自动核查自身的失败不再写进手工错误行，手工错误也不碰自动核查卡片", async () => {
  const panel = await readFile(
    new URL("../src/sidepanel.mjs", import.meta.url),
    "utf8",
  );
  // 自动核查请求只带 taskId / projectId，绝不携带手工 selectedQueryId。
  assert.match(
    panel,
    /sendMessage\(\{\s*\n\s*type,\s*\n\s*taskId: task\.id,\s*\n\s*projectId: task\.project_id,\s*\n\s*\}\)/,
  );
  assert.doesNotMatch(
    panel.slice(
      panel.indexOf("async function automationRequest("),
      panel.indexOf("async function initialize()"),
    ),
    /queryId: \$\("query"\)\.value/,
  );
  // 卡片已展示的自动核查失败不再占用页面底部错误行。
  assert.match(panel, /deriveZxgkAutomationProgressViewModel\(response\?\.job\)/);
  assert.match(
    panel,
    /\.errorShownInCard\s*\n\s*\)\s*\n\s*throw new Error\(response\?\.error/,
  );
  // 手工留痕仍然只使用手工下拉框的 Query。
  assert.match(panel, /type: "archive",\s*\n\s*queryId: \$\("query"\)\.value,/);
});

test("worker 与自动化层共用同一套查询页重建流程，必要时重新导航", async () => {
  const [worker, workflow] = await Promise.all([
    readFile(new URL("../src/worker.mjs", import.meta.url), "utf8"),
    readFile(
      new URL("../src/lib/zxgk-automation.mjs", import.meta.url),
      "utf8",
    ),
  ]);
  // 条件导航：当前不是查询入口才重新导航，随后必须等加载完成并复核落地 URL。
  assert.match(
    worker,
    /if \(!isZxgkExecutionPage\(currentUrl\)\)\s*\n\s*await chrome\.tabs\.update\(tabId, \{ url: ZXGK_EXECUTION_URL \}\)/,
  );
  assert.match(worker, /const tab = await waitForTabComplete\(tabId\);\s*\n\s*if \(!isZxgkExecutionPage\(tab\?\.url\)\)/);
  assert.match(worker, /页面未进入中国执行信息公开网综合查询入口/);
  // start 与 continue 使用同一个 openQueryPage：continue 不是“就地续跑”。
  assert.equal(
    (workflow.match(/openQueryPage\(tab\.id, tab\.url\)/g) || []).length,
    2,
  );
  assert.doesNotMatch(workflow, /history\.back/);

  // resume 取标签页：原标签页还在就复用，不在就新建——没有“当前活动标签页”兜底。
  assert.match(
    workflow,
    /let tab = await dependencies\.getTab\(job\.tabId\);\s*\n\s*if \(!tab\?\.id\) \{\s*\n\s*tab = await dependencies\.createTab\(\);/,
  );
  // 全文件只有 start 允许使用当前活动标签页，且必须出现在 resume 之前。
  assert.equal(
    (workflow.match(/dependencies\.getActiveTab\(\)/g) || []).length,
    1,
  );
  const startAt = workflow.indexOf("async function start(");
  const resumeAt = workflow.indexOf("async function resume(");
  const activeAt = workflow.indexOf("dependencies.getActiveTab()");
  assert.ok(startAt >= 0 && activeAt > startAt && resumeAt > activeAt);
  const resumeBody = workflow.slice(
    resumeAt,
    workflow.indexOf("async function captureListPage("),
  );
  assert.doesNotMatch(resumeBody, /getActiveTab|tabs\.update/);

  // 新建标签页走 chrome.tabs.create，并等到真正落在查询入口才返回。
  assert.match(worker, /async function createQueryTab\(\)/);
  assert.match(
    worker,
    /chrome\.tabs\.create\(\{\s*\n\s*url: ZXGK_EXECUTION_URL,\s*\n\s*active: true,\s*\n\s*\}\)/,
  );
  assert.match(worker, /if \(current\.status === "complete" && isZxgkExecutionPage\(current\.url\)\)/);
  assert.match(worker, /createTab: createQueryTab/);
  // worker 里只有两处 tabs.update，都带显式 tabId（查询页导航 / 关闭详情后切回列表），
  // 不存在“导航用户当前活动标签页”的写法。
  assert.equal((worker.match(/chrome\.tabs\.update\(/g) || []).length, 2);
});
