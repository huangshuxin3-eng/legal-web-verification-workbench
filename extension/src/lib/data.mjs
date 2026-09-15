import { CONFIG } from "../config.mjs";
import { authorizedFetch } from "./auth.mjs";
async function rest(path) {
  const response = await authorizedFetch(
    `${CONFIG.supabaseUrl}/rest/v1/${path}`,
    { headers: { Accept: "application/json" }, cache: "no-store" },
  );
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? "登录已失效，请重新登录。"
        : "数据加载失败，请检查网络后重试。",
    );
  return response.json();
}
export const projects = () =>
  rest("projects?select=id,name,code&order=created_at.desc,id.asc");
export const tasks = (projectId) =>
  rest(
    `tasks?select=id,project_id,entity_name,topic,source_name,source_url&project_id=eq.${encodeURIComponent(projectId)}&order=created_at.asc,id.asc`,
  );
export async function task(taskId) {
  const rows = await rest(
    `tasks?select=id,project_id,entity_name,topic,source_name,source_url&id=eq.${encodeURIComponent(taskId)}&limit=1`,
  );
  return rows[0] || null;
}
export const queries = (taskId) =>
  rest(
    `queries?select=id,task_id,query_no,query_text,captures(count)&task_id=eq.${encodeURIComponent(taskId)}&order=query_no.asc`,
  );
export async function queryContext(queryId) {
  const rows = await rest(
    `queries?select=id,query_no,query_text,tasks!inner(id,project_id,entity_name,topic,source_name,source_url)&id=eq.${encodeURIComponent(queryId)}&limit=1`,
  );
  if (!rows[0]) throw new Error("Query 已删除或无权访问，请重新选择。");
  return rows[0];
}
export async function createQuery(taskId, queryText) {
  const response = await authorizedFetch(
    `${CONFIG.supabaseUrl}/rest/v1/queries?select=id,task_id,query_no,query_text,created_at`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.pgrst.object+json",
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ task_id: taskId, query_text: queryText }),
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body?.id)
    throw new Error(
      response.status === 401
        ? "登录已失效，请重新登录。"
        : body.message || "Query 创建失败，请返回手工模式检查后重试。",
    );
  return body;
}
