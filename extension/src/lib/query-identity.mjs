/**
 * Query 的产品语义：当前 Task 下的一种实际检索词。
 *
 * 同一个检索词在一轮又一轮自动核查中是同一个 Query，不因“执行次数”不同而重复创建。
 * Query 的边界是“检索词发生变化”，而不是“自动化执行次数发生变化”。
 * 这里只做读取与选择，不删除、不合并、不迁移任何历史 Query。
 */

/**
 * 检索词身份只做 trim：不合并法律意义上不同的检索词
 * （例如“恒大集团有限公司”与“恒大 集团有限公司”不是同一个检索词）。
 */
export function normalizeQueryText(value) {
  return String(value ?? "").trim();
}

function queryNoOf(row) {
  const value = Number(row?.query_no);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

/** query_no 优先；异常时用 created_at、id 做稳定 tie-break。 */
function compareCanonical(a, b) {
  const noA = queryNoOf(a);
  const noB = queryNoOf(b);
  if (noA !== noB) return noA - noB;
  const timeA = String(a?.created_at ?? "");
  const timeB = String(b?.created_at ?? "");
  if (timeA !== timeB) return timeA < timeB ? -1 : 1;
  return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
}

/**
 * 选出 canonical Query：当前 Task 内 query_text 与检索词相同的 Query 中，
 * query_no 最小者。历史遗留的多个同文本 Query 原样保留，只是不再继续制造新的。
 */
export function selectCanonicalQuery(rows, queryText) {
  const wanted = normalizeQueryText(queryText);
  if (!wanted) return null;
  const matches = (rows || []).filter(
    (row) => normalizeQueryText(row?.query_text) === wanted,
  );
  if (!matches.length) return null;
  return [...matches].sort(compareCanonical)[0];
}
