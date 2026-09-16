import { session, signIn, signOut } from "./lib/auth.mjs";
import * as data from "./lib/data.mjs";
import {
  groupTasksForPicker,
  validSelectedTaskId,
} from "./lib/task-picker.mjs";
import { supportsZxgkExecution } from "./adapters/zxgk-execution.mjs";
import {
  AUTOMATION_STATES,
  canStartNewAutomation,
  isAutomationRunning,
} from "./lib/automation-state.mjs";
import { deriveZxgkAutomationProgressViewModel } from "./lib/automation-progress-view.mjs";

const $ = (id) => document.getElementById(id);
let projectRows = [],
  taskRows = [],
  queryRows = [],
  activeTab = null,
  busy = false,
  latestCapture = null,
  automationJob = null,
  automationBusy = false;
const setError = (message = "") => {
  $("error").textContent = message;
};
const option = (value, text) => {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = text;
  return node;
};
function fill(select, rows, label) {
  select.replaceChildren(option("", label), ...rows);
}
async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;
  $("current-url").textContent = tab?.url || "当前页面 URL 不可读取";
  renderTaskPicker();
  updateButton();
}
function updateButton() {
  $("archive").disabled =
    busy ||
    automationBusy ||
    isAutomationRunning(automationJob) ||
    !$("query").value ||
    !activeTab?.url;
}
async function loadProjects() {
  projectRows = await data.projects();
  fill(
    $("project"),
    projectRows.map((p) =>
      option(p.id, p.code ? `${p.name} · ${p.code}` : p.name),
    ),
    "请选择项目",
  );
}
async function chooseProject(id, restoreTask) {
  $("task").value = "";
  $("task-search").value = "";
  $("task-search").disabled = true;
  $("selected-task").textContent = "正在加载 Task…";
  $("task-site").textContent = "";
  $("no-query").hidden = true;
  $("count").textContent = "—";
  closeTaskPicker();
  fill($("query"), [], "请选择 Query");
  $("query").disabled = true;
  taskRows = id ? await data.tasks(id) : [];
  $("task-search").disabled = !id || !taskRows.length;
  $("task").value = validSelectedTaskId(taskRows, restoreTask);
  renderTaskPicker();
  if ($("task").value) {
    await chooseTask($("task").value);
  } else {
    renderAutomation();
    updateButton();
  }
}
function closeTaskPicker() {
  $("task-options").hidden = true;
  $("task-search").setAttribute("aria-expanded", "false");
}
function openTaskPicker() {
  if ($("task-search").disabled) return;
  $("task-options").hidden = false;
  $("task-search").setAttribute("aria-expanded", "true");
}
function taskOption(task) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "task-option";
  button.setAttribute("role", "option");
  button.setAttribute("aria-selected", String($("task").value === task.id));
  const entity = document.createElement("span");
  entity.className = "task-option-entity";
  entity.textContent = task.entity_name;
  const meta = document.createElement("span");
  meta.className = "task-option-meta";
  meta.textContent = `${task.topic} · ${task.source_name}`;
  button.replaceChildren(entity, meta);
  button.onclick = async () => {
    $("task").value = task.id;
    $("task-search").value = "";
    closeTaskPicker();
    renderTaskPicker();
    try {
      await chooseTask(task.id);
    } catch (error) {
      setError(error.message);
    }
  };
  return button;
}
function appendTaskGroup(container, title, tasks) {
  if (!tasks.length) return;
  const heading = document.createElement("p");
  heading.className = "task-group-title";
  heading.textContent = title;
  container.append(heading, ...tasks.map(taskOption));
}
function renderTaskPicker() {
  const selectedTask = taskRows.find((task) => task.id === $("task").value);
  $("selected-task").textContent = selectedTask
    ? `${selectedTask.entity_name} · ${selectedTask.topic} · ${selectedTask.source_name}`
    : taskRows.length
      ? "请选择 Task"
      : "项目中没有 Task";
  const groups = groupTasksForPicker(
    taskRows,
    activeTab?.url,
    $("task-search").value,
  );
  const container = $("task-options");
  container.replaceChildren();
  appendTaskGroup(container, "当前网站匹配", groups.matches);
  appendTaskGroup(container, "全部 Task", groups.others);
  if (!groups.matches.length && !groups.others.length) {
    const empty = document.createElement("p");
    empty.className = "task-empty";
    empty.textContent = "没有匹配的 Task";
    container.append(empty);
  }
}
async function chooseTask(id, restoreQuery) {
  const task = taskRows.find((row) => row.id === id);
  $("task-site").textContent = task
    ? `核查网站：${task.source_name}（${task.source_url}）`
    : "";
  fill($("query"), [], "加载中…");
  $("query").disabled = true;
  queryRows = id ? await data.queries(id) : [];
  fill(
    $("query"),
    queryRows.map((q) =>
      option(q.id, `Q${String(q.query_no).padStart(2, "0")} · ${q.query_text}`),
    ),
    queryRows.length ? "请选择 Query" : "没有 Query",
  );
  $("query").disabled = !id || !queryRows.length;
  $("no-query").hidden = !id || queryRows.length > 0;
  if (restoreQuery && queryRows.some((q) => q.id === restoreQuery))
    $("query").value = restoreQuery;
  await chooseQuery($("query").value);
  renderAutomation();
}
async function chooseQuery(id) {
  const query = queryRows.find((row) => row.id === id);
  $("count").textContent = query
    ? String(query.captures?.[0]?.count ?? 0)
    : "—";
  if (id)
    await chrome.storage.local.set({
      recentSelection: {
        projectId: $("project").value,
        taskId: $("task").value,
        queryId: id,
      },
    });
  updateButton();
}

const automationLabels = {
  [AUTOMATION_STATES.IDLE]: "待开始",
  [AUTOMATION_STATES.OPENING_QUERY_PAGE]: "正在打开综合查询页面",
  [AUTOMATION_STATES.FILLING_ENTITY]: "正在填写查询条件",
  [AUTOMATION_STATES.SUBMITTING_QUERY]: "正在提交查询",
  [AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION]: "需要人工验证",
  [AUTOMATION_STATES.CHECKING_RESULT]: "正在检查查询结果",
  [AUTOMATION_STATES.CREATING_QUERY]: "正在创建 Query",
  [AUTOMATION_STATES.CAPTURING_NO_RESULT]: "正在生成并归档无结果留痕",
  [AUTOMATION_STATES.HAS_RESULT_UNSUPPORTED]: "已发现查询结果，需要人工继续",
  // 页内状态的文案不再写死“第 1 页”：具体页码由 automation-result
  // 按 progress.currentPage 渲染，第 2 页时不能显示第 1 页。
  [AUTOMATION_STATES.CAPTURING_LIST_PAGE]: "正在留痕结果列表",
  [AUTOMATION_STATES.READING_RESULT_ROWS]: "正在读取结果",
  [AUTOMATION_STATES.OPENING_DETAIL]: "正在打开结果详情",
  [AUTOMATION_STATES.CAPTURING_DETAIL]: "正在留痕结果详情",
  [AUTOMATION_STATES.RETURNING_TO_LIST]: "正在返回结果列表",
  [AUTOMATION_STATES.VERIFYING_LIST_STATE]: "正在校验结果状态",
  [AUTOMATION_STATES.ADVANCING_PAGE]: "正在前往下一结果页",
  [AUTOMATION_STATES.FIRST_PAGE_COMPLETE]: "第 1 页已完整处理",
  [AUTOMATION_STATES.PARTIAL_COMPLETE]: "已完成部分分页核查",
  [AUTOMATION_STATES.PAUSED]: "自动核查已暂停",
  [AUTOMATION_STATES.FAILED]: "自动核查失败",
  [AUTOMATION_STATES.DONE]: "查询与留痕已完成",
};
/**
 * 未完成的核查（第 1 页或第 2 页的 checkpoint）：显示真实进度，并把它作为主要动作。
 * 继续沿用同一个 Query 与同一份已完成留痕，不会从第 1 条重新开始。
 *
 * 第 2 页的 checkpoint 会先重新建立查询页面并重新完成安全验证，然后跳回第 2 页，
 * 因此文案必须说清"会重新验证"，而不是让用户以为点一下就能接着跑。
 */
function unfinishedProgressLines(view) {
  const pageNo = view.currentPage ?? 1;
  const lines = ["本次核查未完成"];
  if (view.completedPageCount > 0)
    lines.push(
      `✓ 已完成第 1–${view.completedPageCount} 页（网站共 ${view.totalPages ?? "未知"} 页）`,
    );
  lines.push(
    view.listCaptureComplete
      ? `✓ 第 ${pageNo} 页列表：已留痕`
      : `◦ 第 ${pageNo} 页列表：待留痕`,
    `第 ${pageNo} 页详情：${view.completedDetailCount} / ${view.expectedDetailCount}`,
    `已生成留痕：${view.generatedCaptureCount}`,
  );
  if (view.nextIncompleteCaseNo)
    lines.push(`下一项：${view.nextIncompleteCaseNo}`);
  lines.push(
    pageNo > 1
      ? "继续本次核查会重新建立查询页面、重新完成安全验证，然后跳回该页从下一个未完成项开始，不会重复已完成的留痕。"
      : "继续本次核查将从下一个未完成项开始，不会重复已完成的留痕。",
  );
  return lines;
}
function renderAutomation() {
  const task = taskRows.find((row) => row.id === $("task").value);
  const canStart =
    supportsZxgkExecution(task) && canStartNewAutomation(automationJob);
  $("automation-ready").hidden = !canStart;
  $("automation-ready-entity").textContent = task?.entity_name || "";
  $("automation-ready-query").textContent = task?.entity_name || "";
  $("automation-start").textContent = automationJob
    ? "再次自动核查"
    : "开始自动核查";
  $("automation-start").disabled = automationBusy;
  $("automation-panel").hidden = !automationJob;
  if (!automationJob) {
    $("automation-start").hidden = false;
    $("automation-resume").hidden = true;
    $("automation-resume-block").hidden = true;
    updateButton();
    return;
  }
  const progress = deriveZxgkAutomationProgressViewModel(automationJob);
  const resumable = progress.canResume;
  $("automation-entity").textContent = automationJob.entityName || "";
  $("automation-query-text").textContent = automationJob.queryText || "";
  $("automation-scope").textContent =
    `${automationJob.topic || "执行"} · ${automationJob.sourceName || "中国执行信息公开网"}`;
  $("automation-status").textContent =
    automationLabels[automationJob.state] || automationJob.state;
  const waiting = progress.waitingForHumanVerification;
  $("automation-verification").hidden = !waiting;
  const canContinue = progress.canContinue;
  $("automation-continue").hidden = !canContinue;
  $("automation-continue").disabled =
    automationBusy || $("task").value !== automationJob.taskId;
  $("automation-continue").textContent = waiting
    ? "验证完成，继续"
    : "重新检查结果";
  // 有未完成进度时，主要动作是「继续本次核查」，而不是重新开始。
  $("automation-start").hidden = resumable;
  $("automation-resume").hidden = !resumable;
  $("automation-resume").disabled =
    automationBusy || $("task").value !== automationJob.taskId;
  $("automation-resume-block").hidden = !resumable;
  $("automation-resume-block").textContent = resumable
    ? unfinishedProgressLines(progress).join("\n")
    : "";
  $("automation-dismiss").hidden = false;
  $("automation-dismiss").disabled = automationBusy;
  $("automation-dismiss").textContent = resumable
    ? "放弃本次核查"
    : "返回手工模式";
  const lines = [];
  const currentPage = progress.currentPage ?? 1;
  const totalPages = progress.totalPages;
  if (automationJob.state === AUTOMATION_STATES.DONE) {
    if (progress.completedPageCount > 0) {
      // 真的处理过结果页：不能再说“未发现相关结果 / 已生成 1 份留痕”。
      lines.push(
        "✓ 查询完成",
        `✓ 已自动处理到第 ${currentPage} 页（网站共 ${totalPages} 页）`,
        `✓ 本次新增留痕：${progress.completedPageCaptureCount}`,
        `Query：Q${String(automationJob.query?.query_no || 0).padStart(2, "0")}`,
      );
    } else {
      lines.push(
        "✓ 查询完成",
        "✓ 未发现相关结果",
        "✓ 已生成 1 份留痕",
        `Query：Q${String(automationJob.query?.query_no || 0).padStart(2, "0")}`,
        `留痕：${automationJob.filename || "已归档"}`,
      );
    }
  } else if (progress.partialComplete) {
    // 正常的部分完成：不是错误、也不是运行中，只是本轮不再继续翻页。
    lines.push(
      `已自动处理第 1–${currentPage} 页`,
      `网站共 ${totalPages} 页`,
      `✓ 本次新增留痕：${progress.completedPageCaptureCount}`,
      "后续分页暂未自动执行。请人工继续核查。",
    );
  } else if (progress.firstPageComplete) {
    lines.push(
      `第 ${currentPage} 页已完整处理`,
      "✓ 结果列表：1 / 1",
      `✓ 详情：${progress.completedDetailCount} / ${progress.expectedDetailCount}`,
      `✓ 本页新增留痕：${progress.completedDetailCount + 1}`,
    );
    if (totalPages)
      lines.push(
        `当前已自动处理：第 ${currentPage} 页`,
        `网站结果页：共 ${totalPages} 页`,
      );
    lines.push("后续分页暂未自动执行。请人工继续核查。");
  } else if (progress.currentPageProcessing) {
    lines.push(`正在处理第 ${currentPage} 页`);
    lines.push(
      progress.listCaptureComplete ? "✓ 列表留痕已完成" : "◦ 列表留痕待完成",
    );
    if (progress.expectedDetailCount)
      lines.push(
        `详情：${progress.completedDetailCount} / ${progress.expectedDetailCount}`,
      );
    if (progress.pendingOperationCaseNo)
      lines.push(`当前处理：${progress.pendingOperationCaseNo}`);
    lines.push(`累计新增留痕：${progress.generatedCaptureCount}`);
  } else if (automationJob.state === AUTOMATION_STATES.HAS_RESULT_UNSUPPORTED) {
    lines.push(
      "已发现查询结果",
      "M8.1 暂不支持自动遍历结果详情。",
      "请人工继续核查并留痕。",
    );
  } else if (
    [AUTOMATION_STATES.PAUSED, AUTOMATION_STATES.FAILED].includes(
      automationJob.state,
    )
  ) {
    lines.push(automationJob.error || "自动核查未能继续。请返回手工模式。");
  }
  $("automation-result").hidden = !lines.length;
  $("automation-result").textContent = lines.join("\n");
  updateButton();
}

async function automationRequest(type) {
  if (automationBusy) return;
  const task = taskRows.find((row) => row.id === $("task").value);
  if (!task) return;
  automationBusy = true;
  setError();
  renderAutomation();
  try {
    const response = await chrome.runtime.sendMessage({
      type,
      taskId: task.id,
      projectId: task.project_id,
    });
    if (response?.job) automationJob = response.job;
    let refreshError = null;
    if (response?.job?.queryId && $("task").value === response.job.taskId) {
      try {
        await chooseTask(response.job.taskId, response.job.queryId);
      } catch (error) {
        refreshError = error;
      }
    }
    if (!response?.ok) {
      if (
        !deriveZxgkAutomationProgressViewModel(response?.job).errorShownInCard
      )
        throw new Error(response?.error || "自动核查失败，请返回手工模式。");
      if (refreshError) throw refreshError;
      return;
    }
    if (refreshError) throw refreshError;
  } catch (error) {
    setError(error.message);
  } finally {
    automationBusy = false;
    renderAutomation();
  }
}

async function initialize() {
  setError();
  await currentTab();
  const current = await session();
  $("login").hidden = !!current;
  $("app").hidden = !current;
  if (!current) return;
  $("user").textContent = current.user?.email || "已登录用户";
  await loadProjects();
  automationJob = (await chrome.storage.local.get("automationJob"))
    .automationJob;
  const recent = (await chrome.storage.local.get("recentSelection"))
    .recentSelection;
  if (recent && projectRows.some((p) => p.id === recent.projectId)) {
    $("project").value = recent.projectId;
    await chooseProject(recent.projectId, recent.taskId);
    if ($("task").value) await chooseTask(recent.taskId, recent.queryId);
  }
  renderAutomation();
}
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setError();
  const values = new FormData(event.currentTarget);
  try {
    await signIn(
      String(values.get("email")).trim(),
      String(values.get("password")),
    );
    await initialize();
  } catch (error) {
    setError(error.message);
  }
});
$("logout").onclick = async () => {
  await signOut();
  await initialize();
};
$("refresh-url").onclick = () =>
  currentTab().catch((error) => setError(error.message));
$("project").onchange = () =>
  chooseProject($("project").value).catch((error) => setError(error.message));
$("task-search").onfocus = openTaskPicker;
$("task-search").onclick = openTaskPicker;
$("task-search").oninput = () => {
  renderTaskPicker();
  openTaskPicker();
};
$("task-search").onkeydown = (event) => {
  if (event.key === "Escape") closeTaskPicker();
  if (event.key === "ArrowDown") {
    event.preventDefault();
    openTaskPicker();
    $("task-options").querySelector(".task-option")?.focus();
  }
};
document.addEventListener("click", (event) => {
  if (!event.target.closest(".task-field")) closeTaskPicker();
});
$("query").onchange = () =>
  chooseQuery($("query").value).catch((error) => setError(error.message));
$("cancel").onclick = () => chrome.runtime.sendMessage({ type: "cancel" });
$("automation-start").onclick = () => automationRequest("automation-start");
$("automation-resume").onclick = () => automationRequest("automation-resume");
$("automation-continue").onclick = () =>
  automationRequest("automation-continue");
$("automation-dismiss").onclick = async () => {
  if (automationBusy) return;
  const response = await chrome.runtime.sendMessage({
    type: "automation-dismiss",
  });
  if (!response?.ok) {
    setError(response?.error || "暂时无法返回手工模式。");
    return;
  }
  automationJob = null;
  renderAutomation();
};
$("archive").onclick = async () => {
  if (busy) return;
  busy = true;
  latestCapture = null;
  updateButton();
  setError();
  $("success").hidden = true;
  $("cancel").hidden = false;
  $("status").textContent = "正在生成完整 PDF 留痕…";
  try {
    const response = await chrome.runtime.sendMessage({
      type: "archive",
      queryId: $("query").value,
    });
    if (!response?.ok) throw new Error(response?.error || "留痕失败，请重试。");
    latestCapture = response.capture;
    $("filename").textContent = response.filename;
    $("success").hidden = false;
    $("status").textContent = "";
    await chooseTask($("task").value, $("query").value);
  } catch (error) {
    setError(error.message);
    $("status").textContent = "";
  } finally {
    busy = false;
    $("cancel").hidden = true;
    updateButton();
  }
};
$("view").onclick = async () => {
  if (!latestCapture) return;
  await chrome.tabs.create({
    url: chrome.runtime.getURL(
      `viewer.html?id=${encodeURIComponent(latestCapture.id)}&name=${encodeURIComponent($("filename").textContent)}`,
    ),
  });
};
chrome.tabs.onActivated.addListener(() => currentTab().catch(() => {}));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (activeTab?.id === tabId && change.url) currentTab().catch(() => {});
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.automationJob) {
    automationJob = changes.automationJob.newValue || null;
    renderAutomation();
  }
  const job = changes.captureJob?.newValue;
  if (!busy || !job) return;
  const labels = {
    prepare: "正在准备留痕…",
    attach: "正在连接当前页面…",
    print: "正在生成完整 PDF…",
    detach: "正在解除页面调试…",
    upload: "正在归档到 Private Storage…",
  };
  $("status").textContent = labels[job.stage] || $("status").textContent;
});
initialize().catch((error) => setError(error.message));
