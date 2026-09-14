import { createPrintParams } from "../print-config.mjs";
const deadline = (promise, ms, label) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};
export async function printTab(tabId, signal, progress = async () => {}) {
  const target = { tabId };
  let attached = false;
  let detachedByChrome = false;
  let abandonedAttach = false;
  let attachRejected = false;
  let rejectInterrupted;
  const interrupted = new Promise((_, reject) => {
    rejectInterrupted = reject;
  });
  interrupted.catch(() => {});
  const abort = () => rejectInterrupted(new Error("用户已取消留痕。"));
  const onDetach = (source, reason) => {
    if (source.tabId !== tabId) return;
    detachedByChrome = true;
    rejectInterrupted(new Error(`Chrome 已解除调试：${reason}`));
  };
  signal?.addEventListener("abort", abort, { once: true });
  chrome.debugger.onDetach.addListener(onDetach);
  const started = performance.now();
  try {
    await progress("attach");
    const attachment = chrome.debugger.attach(target, "1.3").then(
      async () => {
        attached = true;
        if (abandonedAttach && !detachedByChrome) {
          try {
            await deadline(
              chrome.debugger.detach(target),
              5000,
              "迟到的 debugger detach",
            );
          } catch {
            /* surfaced by Chrome's persistent banner */
          }
        }
      },
      (error) => {
        attachRejected = true;
        throw error;
      },
    );
    try {
      await deadline(
        Promise.race([attachment, interrupted]),
        15000,
        "debugger attach",
      );
    } catch (error) {
      abandonedAttach = !attached && !attachRejected;
      throw error;
    }
    const printedAt = new Date();
    await progress("print");
    const result = await deadline(
      Promise.race([
        chrome.debugger.sendCommand(
          target,
          "Page.printToPDF",
          createPrintParams(printedAt),
        ),
        interrupted,
      ]),
      60000,
      "PDF 生成",
    );
    if (!result?.data) throw new Error("Chrome 未返回 PDF 数据。");
    return {
      data: result.data,
      printedAt: printedAt.toISOString(),
      printMs: Math.round(performance.now() - started),
    };
  } finally {
    if (attached && !abandonedAttach && !detachedByChrome) {
      await progress("detach");
      await deadline(chrome.debugger.detach(target), 5000, "debugger detach");
    }
    chrome.debugger.onDetach.removeListener(onDetach);
    signal?.removeEventListener("abort", abort);
  }
}
