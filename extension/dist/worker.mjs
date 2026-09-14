import { CONFIG } from "./config.mjs";
import { authorizedFetch } from "./lib/auth.mjs";
import { queryContext } from "./lib/data.mjs";
import { businessName } from "./lib/names.mjs";
import { printTab } from "./lib/print.mjs";

let running = null;
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
    parsed.hostname !== "chromewebstore.google.com"
  );
};
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
async function archive(queryId) {
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
    const context = await queryContext(queryId);
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id || !tab.url || !supported(tab.url))
      throw new Error(
        "当前页面无法自动生成 PDF 留痕。你可以使用 Ctrl+P 保存 PDF 后，在工作台通过“添加留痕”手动上传。",
      );
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
    await saveJob({
      status: "failed",
      stage,
      queryId,
      requestId,
      error: String(error.message || error),
      recovery: error.recovery || null,
    });
    throw error;
  } finally {
    running = null;
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
});
