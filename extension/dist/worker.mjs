import { CONFIG } from "./config.mjs";
import { authorizedFetch } from "./lib/auth.mjs";
import * as data from "./lib/data.mjs";
import { businessName } from "./lib/names.mjs";
import { printTab } from "./lib/print.mjs";
import { evaluateInTab } from "./lib/debugger-evaluate.mjs";
import { createZxgkAutomation } from "./lib/zxgk-automation.mjs";
import {
  classifyZxgkExecutionResult,
  fillEntityExpression,
  isZxgkExecutionPage,
  resultSnapshotExpression,
  submitQueryExpression,
  ZXGK_EXECUTION_URL,
} from "./adapters/zxgk-execution.mjs";
import { AUTOMATION_STATES } from "./lib/automation-state.mjs";

let running = null;
let automationOperation = null;
chrome.runtime.onInstalled.addListener(() =>
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }),
);
chrome.runtime.onStartup.addListener(() =>
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }),
);
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});
const saveJob = async (patch) => {
  const previous =
    (await chrome.storage.local.get("captureJob")).captureJob || {};
  const next = { ...previous, ...patch, updatedAt: new Date().toISOString() };
  await chrome.storage.local.set({ captureJob: next });
  return next;
};
const supported = (url) => {
  const parsed = new URL(url);
  return (
    ["http:", "https:"].includes(parsed.protocol) &&
    parsed.hostname !== "chromewebstore.google.com" &&
    !(
      parsed.hostname === "chrome.google.com" &&
      parsed.pathname.startsWith("/webstore")
    )
  );
};
const unsupportedMessage =
  "当前页面无法自动生成 PDF 留痕。你可以使用 Ctrl+P 保存 PDF 后，在工作台通过“添加留痕”手动上传。";
async function uploadPdf(queryId, sourceUrl, requestId, blob) {
  const form = new FormData();
  form.set("query_id", queryId);
  form.set("source_url", sourceUrl);
  form.set("request_id", requestId);
  form.set(
    "file",
    new File([blob], "capture.pdf", { type: "application/pdf" }),
  );
  const response = await authorizedFetch(
    `${CONFIG.workbenchUrl}/api/captures`,
    { method: "POST", body: form },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      body.error || "归档失败，请检查网络和登录状态后重试。",
    );
    error.recovery = body.recovery;
    throw error;
  }
  return body;
}
async function archive(queryId, requestedTabId) {
  if (running) throw new Error("已有留痕任务正在执行，请等待完成。");
  const controller = new AbortController();
  running = controller;
  let stage = "prepare";
  let requestId = crypto.randomUUID();
  try {
    const previous = (await chrome.storage.local.get("captureJob")).captureJob;
    if (
      previous?.status === "failed" &&
      previous.stage === "upload" &&
      previous.queryId === queryId &&
      previous.requestId
    )
      requestId = previous.requestId;
    const context = await data.queryContext(queryId);
    const tab = requestedTabId
      ? await chrome.tabs.get(requestedTabId).catch(() => null)
      : (
          await chrome.tabs.query({
            active: true,
            currentWindow: true,
          })
        )[0];
    if (!tab?.id || !tab.url || !supported(tab.url))
      throw new Error(unsupportedMessage);
    const frozen = { tabId: tab.id, sourceUrl: tab.url };
    await saveJob({
      status: "running",
      stage,
      queryId,
      requestId,
      sourceUrl: frozen.sourceUrl,
      error: null,
    });
    const printed = await printTab(
      frozen.tabId,
      controller.signal,
      async (nextStage) => {
        stage = nextStage;
        await saveJob({ stage });
      },
    );
    stage = "validate";
    await saveJob({ stage });
    const current = await chrome.tabs.get(frozen.tabId).catch(() => null);
    if (!current || current.url !== frozen.sourceUrl)
      throw new Error(
        "页面在生成 PDF 期间发生跳转，本次未归档。请确认页面后重试。",
      );
    const bytes = Uint8Array.from(atob(printed.data), (character) =>
      character.charCodeAt(0),
    );
    if (bytes.length > 20 * 1024 * 1024)
      throw new Error(
        "PDF 超过 20 MB，未上传。请使用 Ctrl+P 保存后检查内容，或缩小页面后重试。",
      );
    stage = "upload";
    await saveJob({
      stage,
      printMs: printed.printMs,
      debuggerMs: printed.debuggerMs,
      printedAt: printed.printedAt,
      bytes: bytes.length,
    });
    const capture = await uploadPdf(
      queryId,
      frozen.sourceUrl,
      requestId,
      new Blob([bytes], { type: "application/pdf" }),
    );
    const filename = businessName(
      context.tasks,
      context.query_no,
      capture.capture_no,
      capture.created_at,
    );
    await saveJob({
      status: "success",
      stage: "done",
      capture,
      filename,
      error: null,
    });
    return { capture, filename };
  } catch (error) {
    const technicalError = String(error.message || error);
    let displayError = technicalError;
    if (
      ["attach", "print"].includes(stage) &&
      !/用户已取消/.test(technicalError)
    )
      displayError = unsupportedMessage;
    if (stage === "detach")
      displayError =
        "PDF 生成过程已结束，但无法确认 Chrome 已解除调试。请检查 Chrome 的调试提示条，关闭提示后再重试。";
    await saveJob({
      status: "failed",
      stage,
      queryId,
      requestId,
      error: displayError,
      technicalError,
      recovery: error.recovery || null,
    });
    throw new Error(displayError);
  } finally {
    running = null;
  }
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error("综合查询页面加载超时。")),
      timeoutMs,
    );
    const onUpdated = (updatedId, change, tab) => {
      if (updatedId === tabId && change.status === "complete")
        finish(null, tab);
    };
    const onRemoved = (removedId) => {
      if (removedId === tabId) finish(new Error("自动核查标签页已关闭。"));
    };
    const finish = (error, tab) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (error) reject(error);
      else resolve(tab);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.get(tabId).then(
      (tab) => {
        if (tab.status === "complete") finish(null, tab);
      },
      () => finish(new Error("自动核查标签页已关闭。")),
    );
  });
}

async function openQueryPage(tabId, currentUrl) {
  if (!isZxgkExecutionPage(currentUrl))
    await chrome.tabs.update(tabId, { url: ZXGK_EXECUTION_URL });
  const tab = await waitForTabComplete(tabId);
  if (!isZxgkExecutionPage(tab?.url))
    throw new Error("页面未进入中国执行信息公开网综合查询入口。");
}

async function checkedTab(tabId, reportedUrl) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = tab?.url || reportedUrl;
  if (!tab || !isZxgkExecutionPage(url))
    throw new Error("当前页面不是受支持的综合查询页面，自动核查已暂停。");
  return tab;
}

const automation = createZxgkAutomation({
  now: () => new Date(),
  getTask: data.task,
  getActiveTab: async () =>
    (await chrome.tabs.query({ active: true, currentWindow: true }))[0] || null,
  getTab: async (tabId) => chrome.tabs.get(tabId).catch(() => null),
  getJob: async () =>
    (await chrome.storage.local.get("automationJob")).automationJob || null,
  saveJob: async (job) => {
    await chrome.storage.local.set({ automationJob: job });
    return job;
  },
  openQueryPage,
  fillEntity: async (tabId, entityName) => {
    await checkedTab(tabId);
    return evaluateInTab(tabId, fillEntityExpression(entityName));
  },
  submitQuery: async (tabId) => {
    await checkedTab(tabId);
    return evaluateInTab(tabId, submitQueryExpression());
  },
  inspectResult: async (tabId, reportedUrl) => {
    await checkedTab(tabId, reportedUrl);
    const snapshot = await evaluateInTab(tabId, resultSnapshotExpression());
    return classifyZxgkExecutionResult(snapshot);
  },
  createQuery: data.createQuery,
  archiveQuery: archive,
});

const automationLockedStates = new Set([
  AUTOMATION_STATES.OPENING_QUERY_PAGE,
  AUTOMATION_STATES.FILLING_ENTITY,
  AUTOMATION_STATES.SUBMITTING_QUERY,
  AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION,
  AUTOMATION_STATES.CHECKING_RESULT,
  AUTOMATION_STATES.CREATING_QUERY,
  AUTOMATION_STATES.CAPTURING_NO_RESULT,
]);
const interruptedAutomationStates = new Set([
  AUTOMATION_STATES.OPENING_QUERY_PAGE,
  AUTOMATION_STATES.FILLING_ENTITY,
  AUTOMATION_STATES.SUBMITTING_QUERY,
  AUTOMATION_STATES.CHECKING_RESULT,
  AUTOMATION_STATES.CREATING_QUERY,
  AUTOMATION_STATES.CAPTURING_NO_RESULT,
]);
chrome.storage.local.get("automationJob").then(({ automationJob }) => {
  if (!interruptedAutomationStates.has(automationJob?.state)) return;
  chrome.storage.local.set({
    automationJob: {
      ...automationJob,
      state: AUTOMATION_STATES.FAILED,
      error:
        "扩展后台在自动操作期间中断，无法确认上一步结果。请检查网页和 Query 后返回手工模式。",
      updatedAt: new Date().toISOString(),
    },
  });
});

async function runAutomation(action, reply) {
  if (automationOperation || running) {
    reply({ ok: false, error: "已有留痕或自动核查操作正在执行。" });
    return;
  }
  automationOperation = action();
  try {
    const job = await automationOperation;
    reply({ ok: true, job });
  } catch (error) {
    reply({
      ok: false,
      error: String(error.message || error),
      job: error.job || null,
    });
  } finally {
    automationOperation = null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === "cancel") {
    running?.abort();
    reply({ ok: true });
    return;
  }
  if (message?.type === "archive") {
    archive(message.queryId).then(
      (result) => reply({ ok: true, ...result }),
      (error) => reply({ ok: false, error: String(error.message || error) }),
    );
    return true;
  }
  if (message?.type === "automation-start") {
    chrome.storage.local.get("automationJob").then(({ automationJob }) => {
      if (automationLockedStates.has(automationJob?.state)) {
        reply({
          ok: false,
          error: "已有自动核查正在等待处理，请先完成或返回手工模式。",
          job: automationJob,
        });
        return;
      }
      void runAutomation(
        () =>
          automation.start({
            taskId: message.taskId,
            projectId: message.projectId,
          }),
        reply,
      );
    });
    return true;
  }
  if (message?.type === "automation-continue") {
    void runAutomation(
      () => automation.continueAfterVerification({ taskId: message.taskId }),
      reply,
    );
    return true;
  }
  if (message?.type === "automation-dismiss") {
    if (automationOperation) {
      reply({ ok: false, error: "自动核查操作仍在进行，暂时无法关闭。" });
      return;
    }
    chrome.storage.local
      .remove("automationJob")
      .then(() => reply({ ok: true }));
    return true;
  }
});
