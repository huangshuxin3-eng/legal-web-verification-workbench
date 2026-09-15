const deadline = (promise, ms, label) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}超时。`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

export async function evaluateInTab(tabId, expression) {
  const target = { tabId };
  let attached = false;
  try {
    await deadline(chrome.debugger.attach(target, "1.3"), 15000, "连接页面");
    attached = true;
    const response = await deadline(
      chrome.debugger.sendCommand(target, "Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      }),
      20000,
      "页面操作",
    );
    if (response?.exceptionDetails)
      throw new Error(
        response.exceptionDetails.exception?.description ||
          response.exceptionDetails.text ||
          "页面操作失败。",
      );
    return response?.result?.value;
  } finally {
    if (attached)
      await deadline(chrome.debugger.detach(target), 5000, "解除页面调试");
  }
}
