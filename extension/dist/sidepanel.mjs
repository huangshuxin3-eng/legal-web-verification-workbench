import { session, signIn, signOut } from "./lib/auth.mjs";
import * as data from "./lib/data.mjs";
import {
  groupTasksForPicker,
  validSelectedTaskId,
} from "./lib/task-picker.mjs";

const $ = (id) => document.getElementById(id);
let projectRows = [],
  taskRows = [],
  queryRows = [],
  activeTab = null,
  busy = false,
  latestCapture = null;
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
  $("archive").disabled = busy || !$("query").value || !activeTab?.url;
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
async function initialize() {
  setError();
  await currentTab();
  const current = await session();
  $("login").hidden = !!current;
  $("app").hidden = !current;
  if (!current) return;
  $("user").textContent = current.user?.email || "已登录用户";
  await loadProjects();
  const recent = (await chrome.storage.local.get("recentSelection"))
    .recentSelection;
  if (recent && projectRows.some((p) => p.id === recent.projectId)) {
    $("project").value = recent.projectId;
    await chooseProject(recent.projectId, recent.taskId);
    if ($("task").value) await chooseTask(recent.taskId, recent.queryId);
  }
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
