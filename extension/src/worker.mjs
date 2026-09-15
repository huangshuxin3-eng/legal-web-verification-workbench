import { CONFIG } from "./config.mjs";
import { authorizedFetch } from "./lib/auth.mjs";
import * as data from "./lib/data.mjs";
import { businessName } from "./lib/names.mjs";
import { createArchiveBridge } from "./lib/archive-bridge.mjs";
import { printTab } from "./lib/print.mjs";
import { evaluateInTab } from "./lib/debugger-evaluate.mjs";
import {
  AUTOMATION_QUERY_UNAVAILABLE_MESSAGE,
  createZxgkAutomation,
} from "./lib/zxgk-automation.mjs";
import {
  buildRowKey,
  classifyZxgkExecutionResult,
  closeDetailExpression,
  detailIdentityExpression,
  fillEntityExpression,
  isZxgkDetailPage,
  isZxgkExecutionPage,
  openDetailExpression,
  resultRowsExpression,
  resultSnapshotExpression,
  submitQueryExpression,
  ZXGK_EXECUTION_URL,
} from "./adapters/zxgk-execution.mjs";
import {
  AUTOMATION_INTERRUPTED_STATES,
  AUTOMATION_STATES,
  isAutomationRunning,
} from "./lib/automation-state.mjs";

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
const archiveBridge = createArchiveBridge({
  queryContext: data.queryContext,
  queryNotAccessibleCode: data.QUERY_NOT_ACCESSIBLE,
  uploadCapture: uploadPdf,
  captureName: businessName,
});
/**
 * Query 读不到时的文案按上下文区分。手工上下文由用户自己重新选择；
 * 自动核查上下文只能停下来交人工，绝不新建或静默切换 Query。
 */
const queryUnavailableMessage = {
  manual: "当前手工 Query 已删除或无法访问，请重新选择。",
  automation: AUTOMATION_QUERY_UNAVAILABLE_MESSAGE,
};
async function archive(queryId, requestedTabId, context = "manual") {
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
    const queryRow = await archiveBridge.loadContext(
      queryId,
      queryUnavailableMessage[context],
    );
    const tab = requestedTabId
      ? await chrome.tabs.get(requestedTabId).catch(() => null)
      : (
          await chrome.tabs.query({
            active: true,
            currentWindow: true,
          })
        )[0];
    if (!tab?.id || !tab.url || !supported(tab.url)) {
      if (requestedTabId) throw new Error("目标标签页已关闭，本次未归档。");
      throw new Error(unsupportedMessage);
    }
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
    const archived = await archiveBridge.upload({
      queryId,
      queryRow,
      sourceUrl: frozen.sourceUrl,
      requestId,
      blob: new Blob([bytes], { type: "application/pdf" }),
    });
    const { capture, filename } = archived;
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

/**
 * 原自动化标签页已关闭时新建一个，并等到它真正落在综合查询入口。
 * 刻意不等待“状态变成 complete 就返回”：新建标签页可能先短暂停在初始页，
 * 这里以“URL 已是查询入口且加载完成”为准，避免误判。
 */
async function createQueryTab() {
  const tab = await chrome.tabs.create({
    url: ZXGK_EXECUTION_URL,
    active: true,
  });
  if (!tab?.id) throw new Error("无法创建用于自动核查的标签页。");
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const current = await chrome.tabs.get(tab.id).catch(() => null);
    if (!current) throw new Error("新建的自动核查标签页已关闭。");
    if (current.status === "complete" && isZxgkExecutionPage(current.url))
      return { id: current.id, url: current.url };
    await sleep(250);
  }
  throw new Error("新建的自动核查标签页未进入综合查询入口。");
}

async function checkedTab(tabId, reportedUrl) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = tab?.url || reportedUrl;
  if (!tab || !isZxgkExecutionPage(url))
    throw new Error("当前页面不是受支持的综合查询页面，自动核查已暂停。");
  return tab;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pollIntervalMs = 250;
const detailTabTimeoutMs = 20000;

/** 读取综合查询结果页：必须先确认标签页本身仍是结果页。 */
async function readResultPage(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error("综合查询结果标签页已关闭，自动核查已停止。");
  if (!isZxgkExecutionPage(tab.url))
    throw new Error("综合查询结果标签页已跳转到其他页面，自动核查已停止。");
  return evaluateInTab(tabId, resultRowsExpression());
}

/**
 * 点击“查看”。真实页面会 window.open("detail.html", "_blank") 打开新标签页，
 * 因此这里在点击前后对比标签页集合，等到新的详情标签页出现才继续。
 */
async function openDetailTab(listTabId, rowKey) {
  const known = new Set((await chrome.tabs.query({})).map((tab) => tab.id));
  const clicked = await evaluateInTab(listTabId, openDetailExpression(rowKey));
  if (!clicked?.ok)
    throw new Error(clicked?.error || "未能在结果列表中定位该条结果。");
  if (buildRowKey(clicked) !== rowKey)
    throw new Error("点击“查看”前的身份校验失败，未打开详情。");
  const deadline = Date.now() + detailTabTimeoutMs;
  for (;;) {
    const tabs = await chrome.tabs.query({});
    const created = tabs.find(
      (tab) => !known.has(tab.id) && isZxgkDetailPage(tab.url),
    );
    if (created) return { detailTabId: created.id, url: created.url };
    if (Date.now() >= deadline)
      throw new Error(
        "点击“查看”后未能在限定时间内打开详情标签页。请确认页面是否需要重新完成安全验证。",
      );
    await sleep(pollIntervalMs);
  }
}

/** 等待详情页渲染完成，并返回其案号等信息用于身份校验。 */
async function readDetailIdentity(detailTabId) {
  const deadline = Date.now() + detailTabTimeoutMs;
  for (;;) {
    const tab = await chrome.tabs.get(detailTabId).catch(() => null);
    if (!tab) return { ok: false, closed: true };
    if (!isZxgkDetailPage(tab.url))
      return { ok: false, error: "详情标签页已跳转到其他页面。" };
    const identity = await evaluateInTab(
      detailTabId,
      detailIdentityExpression(),
    );
    if (identity?.errorText || identity?.rowCount) return identity;
    if (Date.now() >= deadline) return { ok: false, timeout: true };
    await sleep(pollIntervalMs);
  }
}

async function waitForTabGone(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await chrome.tabs.get(tabId).catch(() => null))) return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollIntervalMs);
  }
}

/**
 * 返回列表：点击详情页网站自带的「关闭」按钮（goBack() → window.close()），
 * 然后必须等到该标签页确实关闭。列表标签页从未被导航，因此不使用 history。
 */
async function closeDetailTab(detailTabId, listTabId) {
  let failure = null;
  try {
    const closed = await evaluateInTab(detailTabId, closeDetailExpression());
    if (!closed?.ok)
      failure = new Error(closed?.error || "详情页未提供「关闭」按钮。");
  } catch (error) {
    failure = error;
  }
  const gone = await waitForTabGone(detailTabId, failure ? 3000 : 15000);
  if (!gone)
    throw (
      failure ||
      new Error("详情页「关闭」后标签页仍未关闭，无法确认已返回结果列表。")
    );
  await chrome.tabs.update(listTabId, { active: true }).catch(() => {});
}

const automation = createZxgkAutomation({
  now: () => new Date(),
  getTask: data.task,
  getActiveTab: async () =>
    (await chrome.tabs.query({ active: true, currentWindow: true }))[0] || null,
  getTab: async (tabId) => chrome.tabs.get(tabId).catch(() => null),
  // 仅在原自动化标签页已关闭时使用：新建专用标签页，不导航用户当前活动标签页。
  createTab: createQueryTab,
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
  readResultPage,
  openDetail: openDetailTab,
  readDetailIdentity,
  closeDetail: closeDetailTab,
  listTaskQueries: data.taskQueries,
  getQuery: data.query,
  createQuery: data.createQuery,
  // 自动核查的归档走同一个 M4 链路，但 Query 失效的文案必须属于自动核查上下文。
  archiveQuery: (queryId, tabId) => archive(queryId, tabId, "automation"),
});

chrome.storage.local.get("automationJob").then(({ automationJob }) => {
  if (!AUTOMATION_INTERRUPTED_STATES.includes(automationJob?.state)) return;
  chrome.storage.local.set({
    automationJob: {
      ...automationJob,
      state: AUTOMATION_STATES.FAILED,
      error:
        "扩展后台在自动操作期间中断，无法确认上一步是否完成。已生成的 Query 与留痕全部保留，可在 Side Panel 中「继续本次核查」。",
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
      if (isAutomationRunning(automationJob)) {
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
  if (message?.type === "automation-resume") {
    void runAutomation(
      () => automation.resume({ taskId: message.taskId }),
      reply,
    );
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
