import { AUTOMATION_RESULT } from "../lib/automation-state.mjs";

export const ZXGK_EXECUTION_ADAPTER = "zxgk_execution";
export const ZXGK_EXECUTION_URL =
  "https://zxgk.court.gov.cn/gkw/html/zhzxgk/index.html";
export const ZXGK_EXECUTION_DETAIL_URL =
  "https://zxgk.court.gov.cn/gkw/html/zhzxgk/detail.html";
/** 结果表格的表头，与 classifyZxgkExecutionResult 保持一致。 */
export const ZXGK_RESULT_HEADERS = Object.freeze([
  "序号",
  "姓名",
  "立案时间",
  "案号",
  "查看",
]);

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

export function isZxgkDetailPage(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "zxgk.court.gov.cn" &&
      parsed.pathname === "/gkw/html/zhzxgk/detail.html"
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
  const expectedHeaders = ZXGK_RESULT_HEADERS;
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

// ---------------------------------------------------------------------------
// M8.2a：第一页结果列表 + 第一页全部“查看”详情
//
// 真实页面事实（2026-09-15 抓取 zxgk index.html / detail.html 与 data.js 确认）：
// 1. 结果行由页面脚本生成，结构为
//    <tr><td>序号</td><td>姓名</td><td>立案时间</td><td>案号</td>
//        <td><a class="View" id="{记录ID}" onclick="openZhcxDetail(...)">查看</a></td></tr>
//    不足 10 条时页面会补齐不可见的占位行，占位行中没有 a.View。
// 2. “查看”不会在当前标签页导航，而是 openZhcxDetail() 预取详情接口后
//    window.open("detail.html", "_blank") 打开一个新标签页；详情数据经
//    sessionStorage 传递。因此返回列表 = 关闭该详情标签页，列表页从未被导航。
// 3. 详情页底部提供唯一的「关闭」按钮（onclick="goBack()"），goBack() 在存在
//    opener 时执行 window.close()。这就是本 adapter 采用的确定性返回方式，
//    不使用 history.back() 之类未经确认的猜测。
// 4. 详情页把各板块渲染为 <div id="detail-sections"> 内的表格，
//    每行为 <td><strong>标签：</strong></td><td>值</td>，其中“案号”一行可用于
//    校验该详情确实属于当前处理的结果。
// 5. 结果表格下方是分页控件；M8.2a 只读取当前页与总页数（#currentPage、
//    #currentPage-show、#totalPage-show），绝不触发任何分页动作。分页属于 M8.2b。
// ---------------------------------------------------------------------------

/** 轻度规范化：只统一全角/半角与空白，不改写法律意义上的内容。 */
export function normalizeRowText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, "");
}

/**
 * 结果行的稳定运行期身份。只用于本轮 Extension 运行状态，
 * 不写入数据库，也不改变网站展示顺序。
 */
export function buildRowKey(row) {
  return [
    normalizeRowText(row?.name),
    normalizeRowText(row?.caseNo),
    normalizeRowText(row?.filingDate),
  ].join("|");
}

/**
 * 从 rowKey 还原案号，仅用于进度展示（例如「下一项」）。
 * rowKey 形如 name|caseNo|filingDate，倒数第二段恒为案号。
 */
export function caseNoFromRowKey(rowKey) {
  const parts = String(rowKey ?? "").split("|");
  return parts.length >= 3 ? parts[parts.length - 2] : "";
}

/**
 * 打开详情时需要在页面内重新计算 rowKey。这里把同一份实现注入页面表达式，
 * 避免 Node 侧与页面侧各写一套导致身份判定分叉。
 */
export const ROW_KEY_SOURCE = String.raw`const normalizeRowText = ${normalizeRowText.toString()};
const buildRowKey = ${buildRowKey.toString()};`;

const rowParserSource = String.raw`
  const RESULT_HEADERS = ${JSON.stringify(ZXGK_RESULT_HEADERS)};
  const readResultRowEntries = () => {
    const tables = Array.from(document.querySelectorAll("table")).filter(visible);
    for (const table of tables) {
      const tableRows = Array.from(table.rows);
      const headerIndex = tableRows.findIndex((row) =>
        RESULT_HEADERS.every((header) =>
          Array.from(row.cells).some((cell) => text(cell.innerText).includes(header)),
        ),
      );
      if (headerIndex < 0) continue;
      const entries = [];
      for (const row of tableRows.slice(headerIndex + 1)) {
        const anchor =
          row.querySelector("a.View") ||
          row.querySelector('a[onclick*="openZhcxDetail"]');
        if (!anchor) continue;
        const cells = Array.from(row.cells).map((cell) => text(cell.innerText));
        entries.push({
          serial: cells[0] || "",
          name: cells[1] || "",
          filingDate: cells[2] || "",
          caseNo: cells[3] || "",
          label: text(anchor.innerText),
          anchor,
        });
      }
      if (entries.length) return entries;
    }
    return [];
  };
`;

export function resultRowsExpression() {
  return String.raw`(() => {
    ${sharedDomHelpers}
    ${rowParserSource}
    const digit = (value) => {
      const match = String(value == null ? "" : value).match(/\d+/);
      return match ? Number(match[0]) : null;
    };
    const pager = document.querySelector("#page-div");
    const block = document.querySelector("#result-block");
    const pageInput = document.querySelector("#currentPage");
    const pageShown = document.querySelector("#currentPage-show");
    const totalPages = document.querySelector("#totalPage-show");
    const totalSize = document.querySelector("#totalSize-show");
    return {
      ok: true,
      rows: readResultRowEntries().map((entry) => ({
        serial: entry.serial,
        name: entry.name,
        filingDate: entry.filingDate,
        caseNo: entry.caseNo,
        label: entry.label,
      })),
      page: {
        input: pageInput ? digit(pageInput.value) : null,
        shown: pageShown ? digit(pageShown.textContent) : null,
        totalPages: totalPages ? digit(totalPages.textContent) : null,
        totalSize: totalSize ? digit(totalSize.textContent) : null,
        pagerVisible: pager ? !pager.classList.contains("hide") : false,
      },
      resultVisible: block ? !block.classList.contains("hide") : false,
    };
  })()`;
}

/** 打开“查看”前先在页面内按 rowKey 精确定位，定位不到就绝不点击。 */
export function openDetailExpression(expectedRowKey) {
  const encoded = JSON.stringify(String(expectedRowKey));
  return String.raw`(() => {
    ${sharedDomHelpers}
    ${rowParserSource}
    ${ROW_KEY_SOURCE}
    const expected = ${encoded};
    const matches = readResultRowEntries().filter(
      (entry) => buildRowKey(entry) === expected,
    );
    if (matches.length === 0)
      return { ok: false, error: "结果列表中已找不到该条结果，未打开详情。" };
    if (matches.length > 1)
      return { ok: false, error: "结果列表中出现多个相同身份的结果，未打开详情。" };
    const entry = matches[0];
    if (entry.label !== "查看")
      return { ok: false, error: "该条结果的“查看”链接文字异常，未打开详情。" };
    if (!visible(entry.anchor))
      return { ok: false, error: "该条结果的“查看”链接当前不可见，未打开详情。" };
    entry.anchor.click();
    return {
      ok: true,
      serial: entry.serial,
      name: entry.name,
      filingDate: entry.filingDate,
      caseNo: entry.caseNo,
    };
  })()`;
}

/** 读取详情页正文，用于在留痕前确认该详情确实属于当前处理的结果。 */
export function detailIdentityExpression() {
  return String.raw`(() => {
    ${sharedDomHelpers}
    const error = document.querySelector("#detail-error");
    const errorText =
      error && !error.classList.contains("hide") ? text(error.innerText) : "";
    const container = document.querySelector("#detail-sections");
    const pairs = [];
    if (container) {
      container.querySelectorAll("table tr").forEach((row) => {
        const cells = Array.from(row.cells);
        if (cells.length < 2) return;
        const label = text(cells[0].innerText).replace(/[：:]$/, "");
        if (label) pairs.push([label, text(cells[1].innerText)]);
      });
    }
    return {
      ok: true,
      errorText,
      rowCount: pairs.length,
      caseNumbers: pairs.filter(([label]) => label === "案号").map(([, value]) => value),
      names: pairs
        .filter(([label]) => /被执行人姓名|被执行人名称|姓名\/名称/.test(label))
        .map(([, value]) => value),
      bodyText: text(container ? container.innerText : ""),
    };
  })()`;
}

/** 使用网站自己的「关闭」按钮返回列表；列表页从未被导航，无需 history。 */
export function closeDetailExpression() {
  return String.raw`(() => {
    ${sharedDomHelpers}
    const buttons = Array.from(document.querySelectorAll("button")).filter(
      (button) =>
        !button.disabled &&
        visible(button) &&
        text(button.innerText) === "关闭" &&
        /goBack/.test(String(button.getAttribute("onclick") || "")),
    );
    if (buttons.length !== 1)
      return { ok: false, error: "详情页未提供唯一的「关闭」按钮，无法自动返回结果列表。" };
    const target = buttons[0];
    // window.close() 会销毁标签页，因此延后点击，先让本次调用正常返回。
    setTimeout(() => {
      try {
        target.click();
      } catch (error) {
        console.error("关闭详情页失败", error);
      }
    }, 50);
    return { ok: true };
  })()`;
}

export function validateFirstPage(snapshot) {
  if (!snapshot || snapshot.ok !== true || !Array.isArray(snapshot.rows))
    return { ok: false, error: "无法读取当前页面的查询结果表格。" };
  const page = snapshot.page || {};
  if (page.input !== 1 || page.shown !== 1)
    return {
      ok: false,
      error: `当前页面不是结果第 1 页（页面显示第 ${page.shown ?? "未知"} 页）。`,
    };
  if (!snapshot.rows.length)
    return { ok: false, error: "第一页没有可解析的结果行。" };
  for (const [index, row] of snapshot.rows.entries()) {
    if (!row.name || !row.caseNo || !row.filingDate)
      return {
        ok: false,
        error: `第 ${index + 1} 条结果缺少姓名、立案时间或案号，无法建立稳定身份。`,
      };
    if (row.label !== "查看")
      return { ok: false, error: `第 ${index + 1} 条结果的“查看”链接异常。` };
  }
  return { ok: true };
}

/**
 * 冻结第一页目标集合。rowKey 重复时 fail closed：宁可停下，
 * 也不靠行号猜测该处理哪一条。
 */
export function freezePageOneRows(snapshot) {
  const validation = validateFirstPage(snapshot);
  if (!validation.ok) return validation;
  const keys = snapshot.rows.map(buildRowKey);
  const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
  if (duplicate)
    return {
      ok: false,
      error: `第一页存在两条完全相同的结果（${duplicate}），无法可靠区分，自动核查已停止。`,
    };
  return { ok: true, rows: snapshot.rows, keys };
}

export function locateRowKey(snapshot, expectedRowKey) {
  const validation = validateFirstPage(snapshot);
  if (!validation.ok) return validation;
  const matches = snapshot.rows.filter(
    (row) => buildRowKey(row) === expectedRowKey,
  );
  if (!matches.length)
    return {
      ok: false,
      error: `结果列表中已找不到待处理结果：${expectedRowKey}。`,
    };
  if (matches.length > 1)
    return {
      ok: false,
      error: `结果列表中出现多个相同结果：${expectedRowKey}。`,
    };
  return { ok: true, row: matches[0] };
}

/** 返回列表后必须复核：仍是第 1 页，且冻结的目标集合仍然全部可定位。 */
export function reconcileRowKeys(expectedRowKeys, snapshot) {
  const validation = validateFirstPage(snapshot);
  if (!validation.ok) return validation;
  const available = new Set(snapshot.rows.map(buildRowKey));
  const missing = expectedRowKeys.filter((key) => !available.has(key));
  if (missing.length)
    return {
      ok: false,
      error: `返回结果列表后已无法定位以下结果：${missing.join("；")}。`,
    };
  return { ok: true };
}

/**
 * 「继续本次核查」时的严格集合校验：当前第 1 页必须与原冻结集合完全一致，
 * 只允许页面展示顺序变化。
 *
 * 不新增、不减少、不重复；任何不一致都 fail closed，绝不尝试合并两次结果集。
 * 返回按原冻结顺序排列的结果行，因此继续时仍按 rowKey 身份处理，而不是按行号。
 */
export function reconcileFrozenSet(expectedRowKeys, snapshot) {
  const validation = validateFirstPage(snapshot);
  if (!validation.ok) return validation;
  const keys = snapshot.rows.map(buildRowKey);
  const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
  if (duplicate)
    return {
      ok: false,
      error: `当前第 1 页出现重复结果（${duplicate}），无法可靠继续，本次自动核查已停止。`,
    };
  const available = new Set(keys);
  const missing = expectedRowKeys.filter((key) => !available.has(key));
  if (missing.length)
    return {
      ok: false,
      error: `结果集合已变化：当前第 1 页已找不到以下结果：${missing.join("；")}。本次自动核查已停止，请人工核对后再决定是否重新核查。`,
    };
  const frozen = new Set(expectedRowKeys);
  const extra = keys.filter((key) => !frozen.has(key));
  if (extra.length)
    return {
      ok: false,
      error: `结果集合已变化：当前第 1 页出现新的结果：${extra.join("；")}。本次自动核查已停止，请人工核对后再决定是否重新核查。`,
    };
  const byKey = new Map(snapshot.rows.map((row) => [buildRowKey(row), row]));
  return { ok: true, rows: expectedRowKeys.map((key) => byKey.get(key)) };
}

export function evaluateDetailIdentity(expected, observed) {
  if (observed?.closed)
    return { ok: false, error: "详情标签页在生成留痕前被关闭，未生成留痕。" };
  if (!observed || observed.ok !== true)
    return { ok: false, error: observed?.error || "无法读取详情页内容。" };
  if (observed.timeout)
    return {
      ok: false,
      error: "详情页在限定时间内没有渲染出内容，未生成留痕。",
    };
  if (observed.errorText)
    return { ok: false, error: `详情页提示：${observed.errorText}` };
  if (!observed.caseNumbers?.length)
    return {
      ok: false,
      error: "详情页未提供案号，无法确认该详情属于当前处理的结果，未生成留痕。",
    };
  const wantedCase = normalizeRowText(expected.caseNo);
  if (
    !observed.caseNumbers.some(
      (value) => normalizeRowText(value) === wantedCase,
    )
  )
    return {
      ok: false,
      error: `详情页显示的案号与当前处理案号不一致（期望 ${expected.caseNo}，实际 ${observed.caseNumbers.join("、")}），未生成留痕。`,
    };
  const wantedName = normalizeRowText(expected.name);
  if (wantedName && !normalizeRowText(observed.bodyText).includes(wantedName))
    return {
      ok: false,
      error: `详情页未出现当前处理主体名称（${expected.name}），未生成留痕。`,
    };
  return { ok: true };
}
