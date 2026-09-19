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
  buildAnalysisSourceHash,
  parseAnalysisResponse,
} from "@/lib/server/ai-analysis";
import {
  requestAnalysisCompletion,
  requireAnalysisConfig,
} from "@/lib/server/ai-client";
import {
  createAnalysisDraft,
  loadAnalysisDraft,
  readAnalysisWrite,
  writeAnalysisDraft,
} from "@/lib/server/analysis-draft";

export const runtime = "nodejs";
type Context = { params: Promise<{ projectId: string }> };

/**
 * AI 分析草稿：生成（POST）/ 读取（GET）/ 人工保存与确认（PUT）。
 *
 * 这一步闭合 V1 的完整回路：
 *   AI 生成 → 保存 → 人工编辑 → 人工确认 → 最终 DOCX 使用
 *
 * 共同边界（全部三个方法一致）：
 *   - 鉴权永远是第一道（`captureContext`，401），其后才做各自的事；
 *   - 一律走**用户 JWT + RLS**（`projects_owner`），不用 service role、不生成公开 URL；
 *   - 只读写 `analysis_draft` 一个 jsonb 列，不新增表 / policy / trigger；
 *   - 响应一律 `Cache-Control: no-store`（草稿不进任何缓存）。
 *
 * 输入最小化（Slice 1.1）：事实包只把核查日、核查网站与结构化行交给模型，
 * **不传项目名称**，也不传任何「项目名 vs 检索对象」的比较信息 —— 项目与检索对象
 * 的关系不是本次分析的对象（这一点在 `AnalysisFacts` 的类型层面已经固化）。
 *
 * 确定性聚合（Slice 1.2）：所有数量由 `buildAnalysisSummary` 在 `buildAnalysisPrompt`
 * 内部就地算定（与 `rows` 必然同源），模型只引用不重算。
 *
 * 输出两道闸门：`parseAnalysisResponse`（结构）→ `assertAnalysisDraftInScope`（内容护栏，
 * 覆盖 project/query 关系、日期逻辑、清单外记录假设、空字段成因建议、keyRecords 可追溯性
 * 五类禁令）。任一不通过都是整次 fail closed，不返回半成品；护栏命中不自动 retry
 * （避免重复计费）。
 *
 * 字段归属（Slice 2，硬边界）：`checkDate` / `sourceHash` / `generatedAt` 只能由
 * **本文件**在生成这一步写入；PUT 的请求体只接受 `{ action, sections }`，同名键会被
 * `readAnalysisWrite` 直接拒绝 —— 客户端在结构上就没有改写它们的路径。
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
    // 内容命中禁令（项目名关系 / 日期逻辑 / 清单外记录 / 空字段成因 / keyRecords 不可追溯）
    // → 502（assertAnalysisDraftInScope）。两者都不返回半成品，且都不自动 retry。
    const draft = assertAnalysisDraftInScope(
      parseAnalysisResponse(await requestAnalysisCompletion(prompt)),
      facts.result.rows,
    );
    // 通过两道闸门后立即落库：草稿从此不再依赖浏览器内存，刷新 / 换设备都还在。
    // 指纹在**同一批 facts**上算定，因此它与 `sections` 必然同源。
    const record = await createAnalysisDraft({
      db: userDb,
      projectId,
      sections: draft,
      checkDate: facts.checkDate,
      sourceHash: buildAnalysisSourceHash({
        checkDate: facts.checkDate,
        siteName: REPORT_SOURCE_NAME,
        rows: facts.result.rows,
      }),
    });
    return Response.json(
      { record },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}

/**
 * 读取当前已保存的分析草稿（打开报告弹窗时恢复）。
 *
 * 刻意**不**检查 provider 配置：读一份已经存在的草稿与 AI 是否可用无关，
 * 缺 `AI_API_KEY` 也必须能看到、能编辑、能确认既有草稿。
 *
 * 未生成时返回 `{ record: null }`（正常状态，不是错误）；项目不存在 → 404；
 * 已存内容不是合法形状 → 502（fail closed，绝不把异常 jsonb 当草稿用）。
 */
export async function GET(request: Request, context: Context) {
  const projectId = (await context.params).projectId;
  if (!validId(projectId))
    return apiError(new CaptureOperationError(PROJECT_MISSING_MESSAGE, 404));
  try {
    const { userDb } = await captureContext(request);
    const record = await loadAnalysisDraft(userDb, projectId);
    return Response.json(
      { record },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}

/**
 * 人工保存（`action: "save"`）与人工确认（`action: "confirm"`）。
 *
 * 请求体**只**接受 `{ action, sections }` 这一个形状（未知顶层键直接 400）：
 * 客户端能改的只有四段正文。`save` 一律把 `confirmedAt` 清空（任何人工修改后
 * 都必须重新确认），`confirm` 写入服务端时间戳；`checkDate` / `sourceHash` /
 * `generatedAt` 原样保留 —— 它们只属于生成那一刻的事实。
 */
export async function PUT(request: Request, context: Context) {
  const projectId = (await context.params).projectId;
  if (!validId(projectId))
    return apiError(new CaptureOperationError(PROJECT_MISSING_MESSAGE, 404));
  try {
    const { userDb } = await captureContext(request);
    // 请求体是**唯一**接受客户端输入的入口，因此解析失败必须立刻 400：
    // 非法 JSON 与非法形状走同一条拒绝路径，不给「部分写入」留空间。
    const body: unknown = await request.json().catch(() => null);
    const write = readAnalysisWrite(body);
    let currentSourceHash: string | undefined;
    if (write.action === "confirm") {
      // 确认不是单纯写一个时间戳：必须重新读取并解析**此刻**的报告事实，使用与
      // POST / DOCX 相同的 helper 重算指纹。事实变化时仓储层返回 409，旧草稿不落库。
      const data = await loadProjectReportData(userDb, projectId);
      const facts = await parseProjectReport({
        projectName: data.projectName,
        tasks: data.tasks,
        loadCapture: (storagePath) =>
          downloadReportCapture(userDb, storagePath),
      });
      currentSourceHash = buildAnalysisSourceHash({
        checkDate: facts.checkDate,
        siteName: REPORT_SOURCE_NAME,
        rows: facts.result.rows,
      });
    }
    const record = await writeAnalysisDraft({
      db: userDb,
      projectId,
      write,
      currentSourceHash,
    });
    return Response.json(
      { record },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
