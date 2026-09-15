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

/**
 * 自动核查判断“同文本 Query 是否已存在”时的只读查询。
 * 只读取编号与文本，不带 captures 统计，也不做任何删除或合并。
 */
export const taskQueries = (taskId) =>
  rest(
    `queries?select=id,task_id,query_no,query_text,created_at&task_id=eq.${encodeURIComponent(taskId)}&order=query_no.asc,created_at.asc,id.asc`,
  );
/**
 * Query 读不到时的标记：Query 已删除、或当前账号已无权访问。
 * 文案故意不带上下文（手工 / 自动），由调用方按自己的上下文改写，
 * 避免手工 Query 的错误被误读成自动核查的 Query 也坏了。
 */
export const QUERY_NOT_ACCESSIBLE = "QUERY_NOT_ACCESSIBLE";
export async function queryContext(queryId) {
  const rows = await rest(
    `queries?select=id,query_no,query_text,tasks!inner(id,project_id,entity_name,topic,source_name,source_url)&id=eq.${encodeURIComponent(queryId)}&limit=1`,
  );
  if (!rows[0]) {
    const error = new Error("该 Query 不存在或当前账号无权访问。");
    error.code = QUERY_NOT_ACCESSIBLE;
    throw error;
  }
  return rows[0];
}
/**
 * 按 id 只读一条 Query（不含 tasks 关联），读不到返回 null。
 * 自动核查在「继续本次核查」前用它确认本轮 Query 仍然有效。
 */
export async function query(queryId) {
  const rows = await rest(
    `queries?select=id,task_id,query_no,query_text&id=eq.${encodeURIComponent(queryId)}&limit=1`,
  );
  return rows[0] || null;
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
