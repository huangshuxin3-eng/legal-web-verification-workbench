import { apiError, captureContext, validId } from "@/lib/server/capture-api";
import { CaptureOperationError } from "@/lib/capture-workflow";
import { REPORT_SOURCE_NAME } from "@/lib/report-names";
import {
  downloadReportCapture,
  loadProjectReportData,
  parseProjectReport,
  PROJECT_MISSING_MESSAGE,
} from "@/lib/server/zxgk-report";
import {
  assertAnalysisDraftInScope,
  buildAnalysisPrompt,
  parseAnalysisResponse,
} from "@/lib/server/ai-analysis";
import {
  requestAnalysisCompletion,
  requireAnalysisConfig,
} from "@/lib/server/ai-client";

export const runtime = "nodejs";
type Context = { params: Promise<{ projectId: string }> };

/**
 * 生成 AI 分析草稿（Slice 1）。
 *
 * 输入完全由服务端自己产生：请求体**不参与**业务输入（客户端无法提交 facts 或
 * prompt 文本），因此不存在提示词注入面。事实来源与 DOCX 报告**同一条**链路
 * （`loadProjectReportData` → `parseProjectReport`），范围 / 顺序 / 核查日口径必然一致。
 *
 * 输入最小化（Slice 1.1）：facts 只把核查日、核查网站与结构化行交给模型，
 * **不传项目名称**，也不传任何「项目名 vs 检索对象」的比较信息 —— 项目与检索对象
 * 的关系不是本次分析的对象（这一点在 `AnalysisFacts` 的类型层面已经固化）。
 *
 * 确定性聚合（Slice 1.2）：所有数量由 `buildAnalysisSummary` 在 `buildAnalysisPrompt`
 * 内部就地算定（与 `rows` 必然同源），模型只引用不重算。本 route 因此**不需要**新增
 * 任何输入 —— 也就无法传入与明细不一致的统计。
 *
 * 配置缺失时**在读任何事实之前就失败**（`requireAnalysisConfig()`，503）：不读 Capture、
 * 不下载 PDF、不调用 parser，也不发出 provider 请求。鉴权仍然优先（401 先于 503）。
 *
 * 输出两道闸门：`parseAnalysisResponse`（结构）→ `assertAnalysisDraftInScope`（内容护栏，
 * 覆盖 project/query 关系、日期逻辑、清单外记录假设、空字段成因建议四类禁令）。
 * 任一不通过都是整次 fail closed，不返回半成品；护栏命中不自动 retry（避免重复计费）。
 *
 * Slice 1 不持久化：草稿只在响应里返回，刷新后消失（本 Slice 明确不做落库与 DOCX）。
 */
export async function POST(request: Request, context: Context) {
  const projectId = (await context.params).projectId;
  if (!validId(projectId))
    return apiError(new CaptureOperationError(PROJECT_MISSING_MESSAGE, 404));
  try {
    const { userDb } = await captureContext(request);
    // 早失败：鉴权之后、读取任何事实之前先确认 provider 已配置。缺 AI_API_KEY 时
    // 在这里就抛 503 —— 不读 Capture、不下载 PDF、不调用 parser、不发 provider 请求。
    requireAnalysisConfig();
    const data = await loadProjectReportData(userDb, projectId);
    const facts = await parseProjectReport({
      projectName: data.projectName,
      tasks: data.tasks,
      loadCapture: (storagePath) => downloadReportCapture(userDb, storagePath),
    });

    // 只交必要的结构化事实与核查日：不传项目名称，模型无从做 project/query 关系判断。
    const prompt = buildAnalysisPrompt({
      checkDate: facts.checkDate,
      siteName: REPORT_SOURCE_NAME,
      rows: facts.result.rows,
    });
    // 两道闸门串联：非法 JSON / 缺字段 / 类型错误 → 502（parseAnalysisResponse）；
    // 内容命中四类禁令（project/query 关系、日期逻辑、清单外记录、空字段成因建议）
    // → 502（assertAnalysisDraftInScope）。两者都不返回半成品，且都不自动 retry。
    const draft = assertAnalysisDraftInScope(
      parseAnalysisResponse(await requestAnalysisCompletion(prompt)),
    );
    return Response.json(
      { draft },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
