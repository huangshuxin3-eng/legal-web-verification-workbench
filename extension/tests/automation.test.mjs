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

async function modules() {
  const state = await loadSourceModule("lib/automation-state.mjs");
  const adapter = await loadSourceModule("adapters/zxgk-execution.mjs");
  const workflow = await loadSourceModule("lib/zxgk-automation.mjs");
  return { state, adapter, workflow };
}

async function harness(result, { startingQueryNo = 7 } = {}) {
  const { state, workflow } = await modules();
  const calls = [];
  const states = [];
  let job = null;
  let nextQueryNo = startingQueryNo;
  const dependencies = {
    now: () => new Date("2026-09-15T08:00:00.000Z"),
    getTask: async () => ({ ...executionTask }),
    getActiveTab: async () => ({ id: 21, url: "https://example.com/" }),
    getTab: async () => ({
      id: 21,
      url: "https://zxgk.court.gov.cn/gkw/html/zhzxgk/index.html",
    }),
    getJob: async () => job,
    saveJob: async (next) => {
      job = next;
      states.push(next.state);
      return next;
    },
    openQueryPage: async (tabId) => calls.push(["open", tabId]),
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
    createQuery: async (taskId, queryText) => {
      calls.push(["create-query", taskId, queryText]);
      const queryNo = nextQueryNo++;
      return {
        id: `query-${queryNo}`,
        task_id: taskId,
        query_no: queryNo,
        query_text: queryText,
      };
    },
    archiveQuery: async (queryId, tabId) => {
      calls.push(["archive-existing-m4", queryId, tabId]);
      return {
        capture: { id: "capture-1", capture_no: 3 },
        filename:
          "上海某某科技有限公司_执行_中国执行信息公开网_Q07_003_20260915.pdf",
      };
    },
  };
  return {
    calls,
    states,
    state,
    get job() {
      return job;
    },
    automation: workflow.createZxgkAutomation(dependencies),
    dependencies,
  };
}

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

test("自动核查状态机显式包含 M8.1 的全部状态", async () => {
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
    "PAUSED",
    "FAILED",
    "DONE",
  ]);
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
  assert.equal(
    run.calls.some(([name]) => name === "inspect-after-human"),
    false,
  );
  assert.equal(
    run.calls.some(([name]) => name === "create-query"),
    false,
  );
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
});

test("HAS_RESULT 创建 Query 后停止，不归档、不翻页、不标记 DONE", async () => {
  const { state } = await modules();
  const run = await harness(state.AUTOMATION_RESULT.HAS_RESULT);
  await run.automation.start({
    taskId: executionTask.id,
    projectId: executionTask.project_id,
  });
  const job = await run.automation.continueAfterVerification({
    taskId: executionTask.id,
  });
  assert.equal(job.state, state.AUTOMATION_STATES.HAS_RESULT_UNSUPPORTED);
  assert.equal(job.queryId, "query-7");
  assert.equal(
    run.calls.some(([name]) => name === "create-query"),
    true,
  );
  assert.equal(
    run.calls.some(([name]) => name === "archive-existing-m4"),
    false,
  );
  assert.notEqual(job.state, state.AUTOMATION_STATES.DONE);
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
  assert.equal(
    run.calls.some(([name]) => name === "create-query"),
    false,
  );
  assert.equal(
    run.calls.some(([name]) => name === "archive-existing-m4"),
    false,
  );
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
  assert.equal(
    changed.calls.some(([name]) => name === "create-query"),
    false,
  );

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
  assert.deepEqual(run.calls.at(-1), [
    "archive-existing-m4",
    "query-7",
    21,
  ]);
  assert.equal(
    run.calls.some((call) => call.includes("old-query")),
    false,
  );
});

test("DONE 后同一 Task 可再次核查，相同文本仍产生单调递增的新 Query", async () => {
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
  assert.equal(secondWaiting.queryId, null);
  const second = await run.automation.continueAfterVerification({
    taskId: executionTask.id,
  });
  assert.equal(second.state, state.AUTOMATION_STATES.DONE);
  assert.equal(second.queryId, "query-6");
  assert.equal(second.query.query_no, 6);
  assert.deepEqual(
    run.calls.filter(([name]) => name === "create-query"),
    [
      ["create-query", executionTask.id, executionTask.entity_name],
      ["create-query", executionTask.id, executionTask.entity_name],
    ],
  );
  assert.deepEqual(
    run.calls.filter(([name]) => name === "archive-existing-m4"),
    [
      ["archive-existing-m4", "query-5", 21],
      ["archive-existing-m4", "query-6", 21],
    ],
  );
});

test("DONE/FAILED/HAS_RESULT 允许新一轮，运行中状态仍锁定", async () => {
  const { state } = await modules();
  assert.equal(state.canStartNewAutomation(null), true);
  assert.equal(
    state.canStartNewAutomation({ state: state.AUTOMATION_STATES.DONE }),
    true,
  );
  assert.equal(
    state.canStartNewAutomation({ state: state.AUTOMATION_STATES.FAILED }),
    true,
  );
  assert.equal(
    state.canStartNewAutomation({
      state: state.AUTOMATION_STATES.HAS_RESULT_UNSUPPORTED,
    }),
    true,
  );
  assert.equal(
    state.canStartNewAutomation({
      state: state.AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION,
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

test("自动流程复用 archive，手工 Query 与留痕入口继续保留", async () => {
  const [worker, panel] = await Promise.all([
    readFile(new URL("../src/worker.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/sidepanel.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /archiveQuery: archive/);
  assert.match(worker, /archive\(message\.queryId\)/);
  assert.match(panel, /type: "archive"/);
  assert.match(panel, /\$\("query"\)\.onchange/);
  assert.doesNotMatch(worker, /下一页|详情/);
  assert.doesNotMatch(
    worker,
    /Input\.dispatchMouseEvent|mousePressed|captchaId/,
  );
  assert.match(worker, /interruptedAutomationStates/);
});
