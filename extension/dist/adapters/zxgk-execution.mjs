import { AUTOMATION_RESULT } from "../lib/automation-state.mjs";

export const ZXGK_EXECUTION_ADAPTER = "zxgk_execution";
export const ZXGK_EXECUTION_URL =
  "https://zxgk.court.gov.cn/gkw/html/zhzxgk/index.html";

export const ZXGK_INPUT_POLICY = Object.freeze({
  entityName: true,
  organizationCode: false,
  courtScope: false,
});

export function supportsZxgkExecution(task) {
  return task?.topic === "执行" && task?.source_name === "中国执行信息公开网";
}

export function isZxgkExecutionPage(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "zxgk.court.gov.cn" &&
      parsed.pathname === "/gkw/html/zhzxgk/index.html"
    );
  } catch {
    return false;
  }
}

const sharedDomHelpers = String.raw`
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const text = (value) => String(value || "").replace(/\s+/g, "").trim();
  const description = (input) => {
    const label = input.id
      ? document.querySelector('label[for="' + CSS.escape(input.id) + '"]')?.innerText
      : "";
    const container = input.closest("tr, li, .form-group, .layui-form-item, .search-item");
    return text([
      input.placeholder,
      input.getAttribute("aria-label"),
      input.title,
      input.name,
      input.id,
      label,
      container?.innerText,
    ].join(" "));
  };
  const entityInput = () => {
    const direct = document.querySelector("#pName");
    if (direct instanceof HTMLInputElement && !direct.disabled && visible(direct))
      return direct;
    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"])'))
      .filter((input) => !input.disabled && visible(input))
      .map((input) => ({ input, label: description(input) }))
      .filter(({ label }) =>
        /(被执行人姓名\/名称|被执行人姓名或名称|姓名\/名称)/.test(label) &&
        !/(身份证|组织机构代码|验证码|执行法院)/.test(label)
      );
    return inputs.length === 1 ? inputs[0].input : null;
  };
`;

export function fillEntityExpression(entityName) {
  const encoded = JSON.stringify(String(entityName));
  return String.raw`(async () => {
    ${sharedDomHelpers}
    const deadline = Date.now() + 15000;
    let input = entityInput();
    while (!input && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      input = entityInput();
    }
    if (!input) return { ok: false, error: "未找到唯一的“被执行人姓名/名称”输入框。" };
    const value = ${encoded};
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) return { ok: false, error: "当前页面输入框不支持自动填写。" };
    setter.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dataset.nonlitZxgkEntity = "true";
    input.blur();
    return input.value === value
      ? { ok: true, value }
      : { ok: false, error: "主体名称写入后未能通过页面校验。" };
  })()`;
}

export function submitQueryExpression() {
  return String.raw`(() => {
    ${sharedDomHelpers}
    const input = document.querySelector('[data-nonlit-zxgk-entity="true"]') || entityInput();
    if (!input) return { ok: false, error: "提交前无法重新定位主体输入框。" };
    const candidatesIn = (root) => Array.from(root.querySelectorAll('button, input[type="button"], input[type="submit"], a'))
      .filter((element) => !element.disabled && visible(element))
      .filter((element) => text(element.innerText || element.value) === "查询");
    const local = input.form ? candidatesIn(input.form) : [];
    const candidates = local.length ? local : candidatesIn(document);
    if (candidates.length !== 1)
      return { ok: false, error: "未找到唯一的查询按钮。" };
    candidates[0].click();
    return { ok: true };
  })()`;
}

export function resultSnapshotExpression() {
  return String.raw`(() => {
    ${sharedDomHelpers}
    return {
      bodyText: document.body?.innerText || "",
      tables: Array.from(document.querySelectorAll("table"))
        .filter(visible)
        .map((table) => Array.from(table.rows).map((row) =>
          Array.from(row.cells).map((cell) => text(cell.innerText))
        )),
    };
  })()`;
}

export function classifyZxgkExecutionResult(snapshot) {
  const bodyText = String(snapshot?.bodyText || "").replace(/\s+/g, "");
  const noResult =
    /在全国法院[（(]包含地方各级法院[）)]范围内没有找到.{0,300}相关的结果[。.．]?/.test(
      bodyText,
    );
  const expectedHeaders = ["序号", "姓名", "立案时间", "案号", "查看"];
  const hasResult = (snapshot?.tables || []).some((rows) => {
    const headerIndex = rows.findIndex((cells) =>
      expectedHeaders.every((header) =>
        cells.some((cell) => cell.includes(header)),
      ),
    );
    if (headerIndex < 0) return false;
    return rows
      .slice(headerIndex + 1)
      .some(
        (cells) =>
          cells.length >= expectedHeaders.length &&
          cells.some((cell) => cell && !/暂无|没有找到|无数据/.test(cell)),
      );
  });
  if (noResult === hasResult) return AUTOMATION_RESULT.UNKNOWN;
  return noResult ? AUTOMATION_RESULT.NO_RESULT : AUTOMATION_RESULT.HAS_RESULT;
}
