/**
 * `projects.analysis_draft` 的读写与确认门禁（Slice 2）。
 *
 * 落点只有一处：`projects.analysis_draft`（jsonb，一行一项目），沿用既有
 * `projects_owner` RLS（`for all to authenticated using (owner_id = auth.uid())`）——
 * **不**新增表、**不**新增 policy、**不**新增 trigger。用户 JWT + RLS 即完整隔离。
 *
 * 字段归属（硬边界，Slice 2 明确要求）：
 *   `checkDate` / `sourceHash` / `generatedAt` 由**服务端**在「生成」这一步写入，
 *   `save` / `confirm` 一律**原样保留**（`...existing`），请求体里同名键会被
 *   `readAnalysisWrite` 直接拒绝 —— 客户端在结构上就没有改写它们的路径。
 *   `updatedAt` / `confirmedAt` 是服务端时间戳，`confirmedAt` 只由 confirm 写入，
 *   `save` 强制清空（任何人工修改后都必须重新确认）。
 *
 * 本文件只做「形状 + 归属 + 门禁」，不碰 LLM、不碰 PDF、不碰 DOCX 渲染。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../database.types.ts";
import {
  ANALYSIS_DRAFT_INVALID_MESSAGE,
  ANALYSIS_DRAFT_MISSING_MESSAGE,
  ANALYSIS_DRAFT_VERSION,
  ANALYSIS_SAVE_INVALID_MESSAGE,
  ANALYSIS_SECTION_KEYS,
  ANALYSIS_STALE_MESSAGE,
  readAnalysisDraftRecord,
  type AnalysisDraft,
  type AnalysisDraftRecord,
} from "../analysis-names.ts";
import { CaptureOperationError } from "../capture-workflow.ts";

/** 项目不存在（或不属于当前用户）—— 与报告侧同语义，只是这里不涉及报告生成。 */
export const ANALYSIS_PROJECT_MISSING_MESSAGE = "项目不存在或无权访问。";

// ── 读 ────────────────────────────────────────────────────────────────────

/**
 * 读取当前项目的分析草稿。
 *
 * 三种结果，语义各不相同：
 *   - 没有项目行 → 404（与报告侧一致，避免把「无权访问」伪装成「没有草稿」）；
 *   - 有项目行但 `analysis_draft` 为 null → `null`（尚未生成，正常状态）；
 *   - 有值但不是 `AnalysisDraftRecord` 形状 → 抛错（fail closed）。
 *
 * 第三条是关键：**不可解析的草稿绝不降级成可用草稿**。宁可报错让用户重新生成，
 * 也不让一个来路不明的 jsonb 溜进报告。
 */
export async function loadAnalysisDraft(
  db: SupabaseClient<Database>,
  projectId: string,
): Promise<AnalysisDraftRecord | null> {
  const { data, error } = await db
    .from("projects")
    .select("analysis_draft")
    .eq("id", projectId)
    .maybeSingle();
  if (error) throw error;
  if (!data)
    throw new CaptureOperationError(ANALYSIS_PROJECT_MISSING_MESSAGE, 404);
  // 列类型是 `AnalysisDraftRecord | null`（schema 镜像），但运行时可能是任意 JSON ——
  // 先落回 unknown，再交给形状校验，绝不直接断言。
  const stored: unknown = data.analysis_draft;
  if (stored === null || stored === undefined) return null;
  const record = readAnalysisDraftRecord(stored);
  if (!record)
    throw new CaptureOperationError(ANALYSIS_DRAFT_INVALID_MESSAGE, 502);
  return record;
}

// ── 请求体（固定 schema）───────────────────────────────────────────────────

export type AnalysisWriteAction = "save" | "confirm";

export type AnalysisWrite = {
  action: AnalysisWriteAction;
  sections: AnalysisDraft;
};

function invalidWrite(): CaptureOperationError {
  return new CaptureOperationError(ANALYSIS_SAVE_INVALID_MESSAGE, 400);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * 解析 `PUT` 请求体：**只**接受 `{ action, sections }` 这一个形状。
 *
 * 刻意**拒绝**未知顶层键（而不是忽略）：`checkDate` / `sourceHash` / `generatedAt` /
 * `confirmedAt` / `updatedAt` 都由服务端拥有，客户端一旦试图提交就必须立刻失败，
 * 而不是静默被忽略 —— 静默忽略会让「客户端以为自己改成功了」这种误解长期潜伏。
 */
export function readAnalysisWrite(body: unknown): AnalysisWrite {
  if (!plainObject(body)) throw invalidWrite();
  const keys = Object.keys(body).sort();
  if (keys.length !== 2 || keys[0] !== "action" || keys[1] !== "sections")
    throw invalidWrite();
  const action = body.action;
  if (action !== "save" && action !== "confirm") throw invalidWrite();
  const raw = body.sections;
  if (!plainObject(raw)) throw invalidWrite();
  const sections = {} as AnalysisDraft;
  for (const key of ANALYSIS_SECTION_KEYS) {
    const value = raw[key];
    if (typeof value !== "string" || !value.trim()) throw invalidWrite();
    sections[key] = value.trim();
  }
  if (Object.keys(raw).length !== ANALYSIS_SECTION_KEYS.length)
    throw invalidWrite();
  return { action, sections };
}

// ── 写 ────────────────────────────────────────────────────────────────────

type Db = SupabaseClient<Database>;

/** 写回 `analysis_draft`；0 行受影响说明项目不存在或不属于当前用户。 */
async function persist(
  db: Db,
  projectId: string,
  record: AnalysisDraftRecord,
): Promise<AnalysisDraftRecord> {
  const { data, error } = await db
    .from("projects")
    .update({ analysis_draft: record })
    .eq("id", projectId)
    .select("analysis_draft")
    .maybeSingle();
  if (error) throw error;
  if (!data)
    throw new CaptureOperationError(ANALYSIS_PROJECT_MISSING_MESSAGE, 404);
  return record;
}

/**
 * 「生成」这一步的写入（POST 成功后自动保存）。
 *
 * 只有这里会写 `sourceHash` / `checkDate` / `generatedAt`，且三者都由服务端算定：
 * 指纹来自 `buildAnalysisSourceHash(facts)`，核查日来自 `parseProjectReport`。
 * `confirmedAt` 必然为 null —— 新生成的分析永远是「未确认」。
 */
export async function createAnalysisDraft(options: {
  db: Db;
  projectId: string;
  sections: AnalysisDraft;
  checkDate: string;
  sourceHash: string;
  now?: Date;
}): Promise<AnalysisDraftRecord> {
  const at = (options.now ?? new Date()).toISOString();
  return persist(options.db, options.projectId, {
    version: ANALYSIS_DRAFT_VERSION,
    checkDate: options.checkDate,
    sourceHash: options.sourceHash,
    generatedAt: at,
    updatedAt: at,
    confirmedAt: null,
    sections: options.sections,
  });
}

/**
 * 「人工保存 / 人工确认」的写入（PUT）。
 *
 * 两种 action 都**要求已有草稿**：没有草稿就没有可信的 `sourceHash` / `checkDate`，
 * 也就无法判断这份编辑对应哪一批事实 —— 因此宁可 409 也不凭空造一份。
 *
 * 关键差异只有 `confirmedAt`：
 *   - `save`   → `confirmedAt = null`（任何人工修改后都必须重新确认）；
 *   - `confirm`→ `confirmedAt = 服务端时间戳`。
 */
export async function writeAnalysisDraft(options: {
  db: Db;
  projectId: string;
  write: AnalysisWrite;
  /** confirm 时由当前刚解析的 report facts 计算；save 不需要也不得传。 */
  currentSourceHash?: string;
  now?: Date;
}): Promise<AnalysisDraftRecord> {
  const existing = await loadAnalysisDraft(options.db, options.projectId);
  if (!existing)
    throw new CaptureOperationError(ANALYSIS_DRAFT_MISSING_MESSAGE, 409);
  if (
    options.write.action === "confirm" &&
    existing.sourceHash !== options.currentSourceHash
  )
    throw new CaptureOperationError(ANALYSIS_STALE_MESSAGE, 409);
  const at = (options.now ?? new Date()).toISOString();
  return persist(options.db, options.projectId, {
    ...existing,
    updatedAt: at,
    confirmedAt: options.write.action === "confirm" ? at : null,
    sections: options.write.sections,
  });
}

// ── 确认门禁（纯函数：报告是否可以使用这份分析）───────────────────────────

/**
 * 决定「已保存的草稿是否进入最终报告」。三种结果：
 *   - 没有草稿，或草稿未确认 → `null`：报告照常生成，**不写** AI 章节，
 *     既有非 AI 报告语义完全不变；
 *   - 已确认且指纹等于当下事实 → 返回四段正文，写入 DOCX；
 *   - 已确认但指纹不同 → 抛 409：旧 AI 分析**不允许静默进入新报告**。
 *
 * 纯函数，不碰 DB：`currentHash` 由调用方用同一份刚解析出来的事实现算，
 * 因此「比较的两个指纹」必然来自同一条链路。
 */
export function resolveConfirmedAnalysis(options: {
  record: AnalysisDraftRecord | null;
  currentHash: string;
}): AnalysisDraft | null {
  const { record, currentHash } = options;
  if (!record || !record.confirmedAt) return null;
  if (record.sourceHash !== currentHash)
    throw new CaptureOperationError(ANALYSIS_STALE_MESSAGE, 409);
  return record.sections;
}
