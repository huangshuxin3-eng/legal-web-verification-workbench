import { session, signIn, signOut } from "./lib/auth.mjs";
import * as data from "./lib/data.mjs";

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
  fill($("task"), [], "加载中…");
  $("task").disabled = true;
  fill($("query"), [], "请选择 Query");
  $("query").disabled = true;
  taskRows = id ? await data.tasks(id) : [];
  fill(
    $("task"),
    taskRows.map((t) =>
      option(t.id, `${t.entity_name} · ${t.topic} · ${t.source_name}`),
    ),
    taskRows.length ? "请选择 Task" : "项目中没有 Task",
  );
  $("task").disabled = !id || !taskRows.length;
  if (restoreTask && taskRows.some((t) => t.id === restoreTask)) {
    $("task").value = restoreTask;
    await chooseTask(restoreTask);
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
$("task").onchange = () =>
  chooseTask($("task").value).catch((error) => setError(error.message));
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
