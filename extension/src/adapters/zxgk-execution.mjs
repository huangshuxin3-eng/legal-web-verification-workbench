import { AUTOMATION_RESULT, FIRST_PAGE_NO } from "../lib/automation-state.mjs";

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

/**
 * 网站「明确报告验证失败」的文本判据（唯一来源）。
 *
 * 2026-09-15 实测 `index.html` 的 AJAX error 回调：验证失效时页面把
 * `<p class="bg-warning warning-result"><span class="important">验证码错误或验证码已过期。</span></p>`
 * 写进结果区，同时给 `#page-div` / `#result-thead` 加 `hide`。
 *
 * M8.2b Slice 4B 补充（真人页面确认）：安全验证过期时状态胶囊还会显示
 * `验证已失效：安全验证已失效。请重新验证。`（`tianaiCaptchaRestPage.js`
 * 的 `textExpired` 默认文案），因此必须把「验证已失效」一并纳入判据。
 *
 * 只有这段文字真的出现在页面上，才允许把「读不到目标结果」归类为需要人工
 * 重新完成安全验证；任何其它读取异常都不得被推断成验证码问题。
 */
export const ZXGK_VERIFICATION_FAILURE_PATTERN =
  /验证码错误|验证码已过期|验证已过期|验证已失效/;

/**
 * 页面自己宣布「安全验证已通过」的文本判据。
 *
 * 真实文案由页面覆盖为 `验证已通过，正在查询…`（`index.html` 的 textVerified），
 * 组件默认值是 `验证已通过，可点击查询`，因此只匹配前缀，不绑死后半句。
 */
export const ZXGK_VERIFICATION_QUERYING_PATTERN = /验证已通过/;

/**
 * 安全验证组件的可观察事实（M8.2b Slice 4A 真人在真实页面上确认）。
 *
 * 全部位于**同源主文档 DOM**：没有 iframe、没有 canvas、没有任何跨域内容，
 * 因此这里只读选择器即可，不需要任何跨域或 token 相关能力。
 *
 * 有意不使用（真人不支持或语义不符）：
 * - `.tianai-captcha-ui-mount` 的 id 含随机 uid；
 * - 加载文案是 `::after` 伪元素，且弹窗内被 `content:none !important` 覆盖；
 * - `#tianai-captcha-slider-move-btn`：真人 READY 样本里并不存在；
 * - `tianai-slider-verify-*`：描述的是松开滑块之后的校验阶段，不是首次取图；
 * - `.tianai-captcha-ui-err`：modal 模式下不可达。
 */
export const ZXGK_VERIFICATION_SELECTORS = Object.freeze({
  /** 弹窗遮罩：只有弹窗打开时才存在。 */
  overlay: ".tianai-captcha-ui-overlay",
  /** SDK 根容器：唯一稳定的容器锚点（无随机 id）。 */
  parent: "#tianai-captcha-parent",
  /**
   * 加载指示器：开关型信号（`showLoading()` 置 block / `closeLoading()` 置 none），
   * 节点始终存在，判定必须基于 computed style 与几何，不能基于文案。
   * 必须用父子链限定：同名 id 在 `#tianai-captcha .content` 内还有一个。
   */
  loading:
    "#tianai-captcha-parent > #tianai-captcha-box > #tianai-captcha-loading",
  /** 验证 UI 本体：只有取图成功之后才会被创建，是 READY 的直接证据。 */
  root: "#tianai-captcha-parent #tianai-captcha-box > #tianai-captcha",
  /** 页面自带的验证状态胶囊（组件在缺少时会自动插入）。 */
  status: "#tianai-rest-captcha-status",
});

/** 安全验证组件的 availability（页面事实，不落库、不是 automation state）。 */
export const ZXGK_VERIFICATION_WIDGET_STATES = Object.freeze({
  NOT_PRESENT: "NOT_PRESENT",
  LOADING: "LOADING",
  READY: "READY",
  PRESENT_BUT_NOT_READY: "PRESENT_BUT_NOT_READY",
});

/** 安全验证的 outcome（与 availability 正交，只由明确文案证明）。 */
export const ZXGK_VERIFICATION_OUTCOMES = Object.freeze({
  UNKNOWN: "UNKNOWN",
  UNVERIFIED: "UNVERIFIED",
  REJECTED_OR_EXPIRED: "REJECTED_OR_EXPIRED",
  VERIFIED_OR_QUERYING: "VERIFIED_OR_QUERYING",
});

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

/**
 * 提交查询（点击页面自己的「查询」按钮）。
 *
 * M8.2b Slice 4B 复核的真实页面事实：该按钮绑定 `submitCaptcha()`，
 * 而 `submitCaptcha(){ initCurrentPage(); search(); }`，`initCurrentPage()` 会把
 * `#currentPage` 归位为 1。因此**每次提交查询都必然从第 1 页开始**，页面里遗留的
 * `#currentPage = 2` 不会被带到新的查询里（fresh resume 依赖这一条事实）。
 * 这也意味着 fresh resume 不需要额外重置分页输入框。
 *
 * 注意：分页控件的「上一页/下一页/尾页」按钮只改页码后调用 `search()`，
 * 它们**不**调用 `initCurrentPage()`——本 adapter 因此从不使用它们。
 */
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
//    #currentPage-show、#totalPage-show），绝不触发任何分页动作。
//
// M8.2b Slice 2：分页的“网站事实”仍然全部留在本 adapter：
//   - 读取页信号由 resultRowsExpression 负责；
//   - 跳页只是“改写 #currentPage 的 value → 调用页面自己的查询函数”，
//     由 jumpToPageExpression 负责，并且刻意不使用网站自带的分页控件函数：
//     那些函数会把越界目标夹取到末页，使“请求的目标页”与“实际目标页”不一致。
//   - 本 adapter 只发出动作并读取事实，不决定是否继续、不决定 PAUSED；
//     baseline totalPages 的比较属于 automation orchestration。
//   本切片只暴露 primitive，尚未接入 automation，真人行为仍是第 1 页后停止。
// ---------------------------------------------------------------------------

/** 合法页码：>= 1 的整数。adapter 只做事实层校验，不决定 runtime baseline。 */
function isPageNo(value) {
  return Number.isInteger(value) && value >= 1;
}

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

/**
 * 在页面内读取「网站明确报告验证失败」的证据。
 *
 * 只认页面自己写进结果区的提示原文，不做任何推断：读不到就是没有证据（null）。
 * 判据只在 Node 侧定义一次，这里注入的是同一份 pattern 源码。
 */
const verificationSignalSource = String.raw`
  const VERIFICATION_FAILURE_PATTERN = new RegExp(${JSON.stringify(
    ZXGK_VERIFICATION_FAILURE_PATTERN.source,
  )});
  const readVerificationFailure = () => {
    const nodes = Array.from(document.querySelectorAll(".warning-result"));
    for (const node of nodes) {
      const value = text(node.innerText || node.textContent || "");
      if (VERIFICATION_FAILURE_PATTERN.test(value)) return value;
    }
    return null;
  };
`;

export function resultRowsExpression() {
  return String.raw`(() => {
    ${sharedDomHelpers}
    ${rowParserSource}
    ${verificationSignalSource}
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
    const verification = readVerificationFailure();
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
      verification: {
        failed: verification !== null,
        evidence: verification,
      },
    };
  })()`;
}

/**
 * 读取安全验证组件的可观察事实（M8.2b Slice 4B）。
 *
 * 只读 DOM 与 computed style，不做任何分类、不写状态、不发动作、不触碰 token：
 * 分类一律交给 Node 侧的 classifyVerificationAvailability /
 * classifyVerificationOutcome 完成，避免页面侧与 Node 侧各写一套判定。
 *
 * 弹窗未打开时 overlay / parent / root 都不存在，这是**预期事实**，不是错误：
 * NOT_PRESENT 既可能表示「还没打开验证码」，也可能表示「验证已通过、弹窗已移除」。
 */
export function verificationAvailabilityExpression() {
  const selectors = ZXGK_VERIFICATION_SELECTORS;
  return String.raw`(() => {
    ${sharedDomHelpers}
    const VERIFICATION_FAILURE_PATTERN = new RegExp(${JSON.stringify(
      ZXGK_VERIFICATION_FAILURE_PATTERN.source,
    )});
    const selector = ${JSON.stringify(selectors)};
    const pick = (value) => {
      try {
        return document.querySelector(value);
      } catch {
        return null;
      }
    };
    // 可见性必须基于 computed style 与几何：加载文案是伪元素，innerText 读不到。
    const widgetVisible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) > 0.01 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    let failureEvidence = null;
    for (const node of Array.from(document.querySelectorAll(".warning-result"))) {
      const value = text(node.innerText || node.textContent || "");
      if (VERIFICATION_FAILURE_PATTERN.test(value)) {
        failureEvidence = value;
        break;
      }
    }
    const loading = pick(selector.loading);
    const status = pick(selector.status);
    return {
      ok: true,
      overlayPresent: Boolean(pick(selector.overlay)),
      parentPresent: Boolean(pick(selector.parent)),
      loadingPresent: Boolean(loading),
      loadingVisible: widgetVisible(loading),
      rootPresent: Boolean(pick(selector.root)),
      statusText: status ? text(status.innerText || status.textContent || "") : null,
      failureEvidence,
    };
  })()`;
}

/** 页面事实的轻量归一：只统一全角/半角与空白，不改写文案内容。 */
function normalizeVerificationText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, "");
}

/**
 * 纯判定：安全验证当前处于哪一种 outcome。
 *
 * 与 availability 正交，且**只由明确文案证明**：
 * - REJECTED_OR_EXPIRED：页面自己写下验证失败/失效文案（结果区提示或状态胶囊）；
 * - VERIFIED_OR_QUERYING：页面自己宣布验证已通过；
 * - UNVERIFIED：组件仍在页面上，但没有通过也没有失败；
 * - UNKNOWN：什么证据都没有（例如弹窗已移除且状态为空）。
 *
 * NOT_PRESENT 有多重业务含义，因此缺证据时一律 UNKNOWN，绝不推断成"未验证"。
 */
export function classifyVerificationOutcome(facts) {
  const evidence = normalizeVerificationText(facts?.failureEvidence);
  if (evidence && ZXGK_VERIFICATION_FAILURE_PATTERN.test(evidence))
    return ZXGK_VERIFICATION_OUTCOMES.REJECTED_OR_EXPIRED;
  const status = normalizeVerificationText(facts?.statusText);
  if (status && ZXGK_VERIFICATION_FAILURE_PATTERN.test(status))
    return ZXGK_VERIFICATION_OUTCOMES.REJECTED_OR_EXPIRED;
  if (status && ZXGK_VERIFICATION_QUERYING_PATTERN.test(status))
    return ZXGK_VERIFICATION_OUTCOMES.VERIFIED_OR_QUERYING;
  if (facts?.overlayPresent || facts?.parentPresent)
    return ZXGK_VERIFICATION_OUTCOMES.UNVERIFIED;
  return ZXGK_VERIFICATION_OUTCOMES.UNKNOWN;
}

/**
 * 纯判定：安全验证组件当前的 availability。
 *
 * 判定顺序（只看开关型信号，不看文案、不看随机 id、不看滑块按钮）：
 * 1. overlay 或 parent 缺失 → NOT_PRESENT；
 * 2. root 存在且 loading 不可见 → READY；
 * 3. loading 可见且 root 不存在 → LOADING；
 * 4. 其余（含「root 与 loading 同时可见」这种矛盾事实）→ PRESENT_BUT_NOT_READY。
 *
 * 读取失败不会被猜成任何一种状态：返回 ok:false，由调用方 fail closed。
 */
export function classifyVerificationAvailability(facts) {
  if (!facts || facts.ok !== true)
    return {
      ok: false,
      state: null,
      outcome: ZXGK_VERIFICATION_OUTCOMES.UNKNOWN,
      error: "无法读取安全验证组件的页面事实。",
    };
  const outcome = classifyVerificationOutcome(facts);
  if (!facts.overlayPresent || !facts.parentPresent)
    return {
      ok: true,
      state: ZXGK_VERIFICATION_WIDGET_STATES.NOT_PRESENT,
      outcome,
    };
  if (facts.rootPresent && !facts.loadingVisible)
    return { ok: true, state: ZXGK_VERIFICATION_WIDGET_STATES.READY, outcome };
  if (facts.loadingVisible && !facts.rootPresent)
    return {
      ok: true,
      state: ZXGK_VERIFICATION_WIDGET_STATES.LOADING,
      outcome,
    };
  return {
    ok: true,
    state: ZXGK_VERIFICATION_WIDGET_STATES.PRESENT_BUT_NOT_READY,
    outcome,
  };
}

/**
 * 跳到指定结果页的网站动作（direct jump）。
 *
 * 真实页面事实（§26 Slice 0 CONFIRMED）：分页是纯 AJAX，所有分页入口最终都只是
 * 改写 #currentPage 的 value，然后调用页面自己的查询函数重新提交表单。
 * 因此本 primitive 直接改写 #currentPage 再触发查询，刻意绕开网站自带的
 * 分页控件函数——它们对越界目标有夹取行为，会让“请求的目标页”被静默改掉，
 * 而 M8.2b 的每一步都必须 fail closed。
 *
 * 返回值只表示“页面动作已成功发出”，**不代表已经到达 targetPage**：
 * 是否真的到达、结果是否可读、observed totalPages 是否仍等于 baseline，
 * 都必须在后续切片里重新读取页面快照自行判定。
 *
 * targetPage 的上界由 orchestration 用 baseline totalPages 控制，
 * 这里只做最基本的防御性校验。
 */
export function jumpToPageExpression(targetPage) {
  if (!isPageNo(targetPage))
    throw new Error(
      `目标页码必须是 >= 1 的整数，已拒绝生成跳页动作（收到 ${String(targetPage)}）。`,
    );
  const encoded = JSON.stringify(targetPage);
  return String.raw`(() => {
    const targetPage = ${encoded};
    if (!Number.isInteger(targetPage) || targetPage < 1)
      return { ok: false, error: "目标页码非法，未发出跳页动作。" };
    const input = document.querySelector("#currentPage");
    if (!input) return { ok: false, error: "页面缺少分页输入框，未发出跳页动作。" };
    const search = window.search;
    if (typeof search !== "function")
      return { ok: false, error: "页面未提供结果查询函数，未发出跳页动作。" };
    input.value = String(targetPage);
    search.call(window);
    return { ok: true, targetPage };
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

/**
 * 校验 snapshot 确实就是 expectedPageNo 这一页。
 *
 * 必须同时满足「分页输入框里的页码」与「页面显示的页码」都等于 expectedPageNo：
 * 只看其中一个都不足以证明当前页，也不能只看 rows 长得像就放过。
 *
 * 这里刻意不判断 observed totalPages 与 runtime baseline 是否一致：任何变化
 * 都会让结果集可能变化，是否 PAUSED 由 orchestration 决定，adapter 只报事实。
 */
export function validatePage(snapshot, expectedPageNo) {
  if (!isPageNo(expectedPageNo))
    return {
      ok: false,
      error: `目标页码必须是 >= 1 的整数（收到 ${String(expectedPageNo)}）。`,
    };
  if (!snapshot || snapshot.ok !== true || !Array.isArray(snapshot.rows))
    return { ok: false, error: "无法读取当前页面的查询结果表格。" };
  const page = snapshot.page || {};
  if (page.input !== expectedPageNo || page.shown !== expectedPageNo)
    return {
      ok: false,
      error: `当前页面不是结果第 ${expectedPageNo} 页（页面显示第 ${page.shown ?? "未知"} 页）。`,
    };
  if (!snapshot.rows.length)
    return { ok: false, error: `第 ${expectedPageNo} 页没有可解析的结果行。` };
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

/** M8.2a 兼容入口：等价于校验第 1 页。 */
export function validateFirstPage(snapshot) {
  return validatePage(snapshot, FIRST_PAGE_NO);
}

/**
 * 冻结指定页的目标集合。rowKey 重复时 fail closed：宁可停下，
 * 也不靠行号猜测该处理哪一条。
 */
export function freezePageRows(snapshot, expectedPageNo) {
  const validation = validatePage(snapshot, expectedPageNo);
  if (!validation.ok) return validation;
  const keys = snapshot.rows.map(buildRowKey);
  const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
  if (duplicate)
    return {
      ok: false,
      error: `第 ${expectedPageNo} 页存在两条完全相同的结果（${duplicate}），无法可靠区分，自动核查已停止。`,
    };
  return { ok: true, rows: snapshot.rows, keys };
}

/** M8.2a 兼容入口：等价于冻结第 1 页。 */
export function freezePageOneRows(snapshot) {
  return freezePageRows(snapshot, FIRST_PAGE_NO);
}

/**
 * 在指定页内按 rowKey 精确定位。定位前必须先证明 snapshot 就是 expectedPageNo，
 * 否则会把别的页面上恰好同名的结果当成目标。
 */
export function locateRowKey(snapshot, expectedRowKey, expectedPageNo) {
  const validation = validatePage(snapshot, expectedPageNo);
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

/** 返回列表后必须复核：仍是 expectedPageNo，且冻结的目标集合仍然全部可定位。 */
export function reconcileRowKeys(expectedRowKeys, snapshot, expectedPageNo) {
  const validation = validatePage(snapshot, expectedPageNo);
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
 * 「继续本次核查」时的严格集合校验：expectedPageNo 必须与原冻结集合完全一致，
 * 只允许页面展示顺序变化。
 *
 * 不新增、不减少、不重复；任何不一致都 fail closed，绝不尝试合并两次结果集。
 * 返回按原冻结顺序排列的结果行，因此继续时仍按 rowKey 身份处理，而不是按行号。
 */
export function reconcileFrozenSet(expectedRowKeys, snapshot, expectedPageNo) {
  const validation = validatePage(snapshot, expectedPageNo);
  if (!validation.ok) return validation;
  const keys = snapshot.rows.map(buildRowKey);
  const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
  if (duplicate)
    return {
      ok: false,
      error: `当前第 ${expectedPageNo} 页出现重复结果（${duplicate}），无法可靠继续，本次自动核查已停止。`,
    };
  const available = new Set(keys);
  const missing = expectedRowKeys.filter((key) => !available.has(key));
  if (missing.length)
    return {
      ok: false,
      error: `结果集合已变化：当前第 ${expectedPageNo} 页已找不到以下结果：${missing.join("；")}。本次自动核查已停止，请人工核对后再决定是否重新核查。`,
    };
  const frozen = new Set(expectedRowKeys);
  const extra = keys.filter((key) => !frozen.has(key));
  if (extra.length)
    return {
      ok: false,
      error: `结果集合已变化：当前第 ${expectedPageNo} 页出现新的结果：${extra.join("；")}。本次自动核查已停止，请人工核对后再决定是否重新核查。`,
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
