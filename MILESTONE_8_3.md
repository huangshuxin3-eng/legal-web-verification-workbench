# Milestone 8.3：ZXGK 尽调报告线（留痕 → 核对表 → 报告）

## 范围

M8.1 / M8.2a / M8.2b 负责「把证据抓下来」；本阶段负责「把证据变成交付物」：

```text
PDF 留痕（site 原始证据）
→ 解析详情页板块与字段
→ Excel 执行记录核对表（主表 + 未纳入清单）
→ docx 尽调报告
→ 接入产品入口（项目页一次点击即可生成）
```

全程 deterministic，**不引入 AI 抽取**。

## 实施序列

本节按提交链记录。既有材料对这几个阶段的编号不一致——`NONLIT_WORKBENCH_CONTEXT.md` 与 2026-09-19 的交接文档混用 `Step` 与 `Stage`，而两份 2026-09-19 review 使用的是 `Stage 4` / `Stage 5`（`Stage 4` 指产品入口接入后的一次浏览器 E2E，`Stage 5` 指本轮的并发优化）。因此本文件以**提交**为锚，不另立编号。

| 提交      | 内容                                                              |
| --------- | ----------------------------------------------------------------- |
| `9db6489` | detail 报告抽取：解析器 + CLI + 15 条测试                         |
| `44331cc` | docx 报告生成                                                     |
| `1e39a6e` | 报告生成接入产品入口（HTTP 路由 + 对话框）                        |
| `116e93d` | 报告留痕加载有界并发优化（两份 2026-09-19 review 称之为 Stage 5） |

## 解析层

`scripts/zxgk-execution-parse.ts`（560 行）是解析逻辑与列定义的**唯一事实来源**。

- **板块**：`被执行人 / 失信被执行人 / 终本案件 / 限制消费人员`，detail 页渲染顺序固定为 被执行人 → 失信被执行人 → 终本案件 → 限制消费人员。
- **主表列 `MAIN_TABLE_COLUMNS` 共 20 列**：元信息 4 列（序号 / 公示类型 / 备注 / 对应证据PDF文件名）+ 通用字段 6 列（案号 / 被执行人姓名·名称 / 性别 / 身份证号码·组织机构代码 / 执行法院 / 立案时间）+ `执行标的` + 终本案件 2 列（终本日期 / 未履行金额）+ 失信板块 6 列（省份 / 执行依据文号 / 做出执行依据单位 / 发布时间 / 被执行人的履行情况 / 失信被执行人行为具体情形）+ 长文本 1 列（`生效法律文书确定的义务`，独占末列、不截断、不拆表）。
- **版面不变量（实测）**：标签列右边界 185.6、值列左边界 194.6 → 取中间值 `VALUE_COLUMN_X = 190` 切列；正文行字号 10.5；板块 banner 字号 13.5；行距 24pt（容差 2pt）；折行续行间距恒为 15.00pt（安全分界 `CONTINUATION_MAX_GAP = 20`）。因此解析**不依赖冒号或正则切列**。
- **空值**：站点渲染空值的符号为 `—`（`NOT_PUBLISHED`）→ NOT_FOUND；标签永远存在，**「标签缺席」不是缺失信号**。
- **静默丢失防护**：`KNOWN_FIELD_LABELS` 与 `SECTION_OWNED_LABELS` 定义「每个板块本应公示哪些字段」，字段缺失是否算异常由所属板块决定。
- **跨板块取值优先级**：终本案件 > 被执行人 > 失信被执行人 > 限制消费人员（`SECTION_PRIORITY`）；实测只有 010 / 016 的「执行法院」两个板块写法不同，差异写入备注。

CLI：`scripts/build-execution-table.ts`（236 行）生成 Excel 主表与未纳入清单。

## 报告层

渲染器 `scripts/zxgk-report-docx.ts`（952 行），CLI 包装 `scripts/build-report-docx.ts`（303 行）。

服务端流水线 `src/lib/server/zxgk-report.ts`（482 行）在产品内复用同一套解析与渲染：

```text
鉴权 → 项目 → getProjectTasks → 逐 Task 取 canonical Query → 逐 Query 取 captures
→ selectReportCaptures（纯函数）
→ 逐份下载 PDF + 读文字层 → classifyCapture
→ resolveCheckDate → parseExecutionTable
→ buildReportModel → renderZxgkReportDocx → Packer.toBuffer
→ 单次 HTTP 响应（无流式、零持久化）
```

产品入口：`src/app/api/projects/[projectId]/report/route.ts`；UI 为 `src/components/project-report-dialog.tsx`，只打 HTTP 端点、从不 import 服务端模块；产物命名由 `src/lib/report-names.ts` 统一。

开发 CLI 与产品入口共用同一份解析器与渲染器，避免出现两套口径。

## 报告口径（人工 LOCK，2026-09-17 二次修正）

- 一条网站原始记录 = 表格一行；**除列表页外所有 detail 留痕都入同一张主表**，多板块**不拆行、不合并**。
- 共有字段只填一次；终本 / 失信特有字段各填各列；`公示类型` 可多值（如 `失信被执行人、终本案件`）。
- **列表页不作为案件明细**（未纳入清单只留列表页）。
- **空值语义四分**：网站公示 `—` → 写 `—`；当前公示类型无此字段 → **真空白**；网站字段存在但值空 → 按网站实际；系统备注未触发 → **真空白**。
- 正式报告只在核查完成后生成，**不做「未完成核查报告」**。
- 列定义唯一事实来源 = `MAIN_TABLE_COLUMNS`。

## Deterministic report selection invariants

产品入口与开发 CLI 共用同一条选择链，规则全部**确定性**（无 AI、无启发式、无二次排序）：

- **eligible Task 范围**：`topic === "执行"` 且 `source_name === "中国执行信息公开网"`（`isReportTask`）。与扩展侧 adapter 的 `supportsZxgkExecution` 同口径，服务端不新增范围规则。范围内无 Task → `409`（`NO_TASK_MESSAGE`）。
- **每 Task 只选一个 Query**：即**该 Task 的 canonical Query**；同一 Task 下的历史 Query / 非 canonical Query **全部不进报告**。
- **canonical Query 规则**：在当前 Task 内筛出 `query_text` 等于检索词（默认检索词 = `task.entity_name`；`normalizeQueryText` **只 trim**，不合并、不改写）的行，再按 `query_no` 升序、同 `query_no` 按 `created_at` 升序取第一条（`compareCanonical`）。该规则是仓库既有 invariant，扩展侧实现在 `extension/src/lib/query-identity.mjs`；服务端按同一规则、同一 tie-break 落地，一致性由 `tests/zxgk-report-flow.test.ts` 固化。
- **无 canonical Query** → `409`（`unresolvedQueryMessage`），**不静默跳过该 Task**。
- **Task 顺序**：沿用 `getProjectTasks` 的既有 Task 顺序，**不重排、不按 entity regroup**。
- **Capture 顺序**：筛 `query_id === canonical.id` 的留痕后，按 `capture_no` 升序、再按 `id` 字典序升序（`toSorted`）。不同 Task 之间**不做** `query_no` / `capture_no` 交叉排序。
- **报告行序** = Task 顺序 → 该 Task 的 canonical Query → `capture_no` → `id`（`selectReportCaptures` 返回值即顺序）。
- **非 PDF 留痕**：跳过并计入 `skippedNonPdf`，不算错误；全部留痕都不是 PDF → `409`（`NO_DETAIL_MESSAGE`）。
- **`project.name` 与 query target 不要求一致**：报告标题用项目名称，`task.entity_name` 可以是另一个主体，二者不同**是合法情形**，**不做** mismatch 校验。
- **`checkDate` 来源**：全部**实际纳入报告的有效详情留痕**的 Asia/Shanghai 自然日，**不是**报告生成日、也不是下载日。
- **cross-day fail closed**：唯一自然日 > 1 → `409`（`MIXED_CHECK_DATE_MESSAGE`），**不取 latest、不做仲裁**；一份详情都没有同样 fail closed。
- **`excluded` 正常允许**：列表页（`classifyCapture === "list"`）归入 `excluded`，不进主表、也不进 `problems`；`excluded` 与 `skippedNonPdf` 都**不阻止**出报告。
- **`problems.length > 0` 阻止报告**：`renderZxgkReportDocx` 在 `problems` 非空时直接抛错并列出原因（`unparsableMessage`），**不出「带问题的报告」**。
- **`draft: true`**：`REPORT_DRAFT = true` 为 V1 固定值——Task 完成只代表工作流状态，**不代表已过人工法律审核**。
- **report artifact 不持久化**：不新增 report / artifact 表，点击即生成、单次 HTTP 响应下载，**零持久化**。

## Runtime hardening（`116e93d`，两份 2026-09-19 review 称之为 Stage 5）

**基线画像**（2026-09-19 Design Review，样本 = 31 份 PDF、每份 2 页、5.80 MiB）：一次真实全量产品调用耗时 **198s**，其中 Storage 下载占约 **96.3%**（延迟 16.3% + 负载传输 80.0%），计算总量仅 **1.02s（0.51%）**。瓶颈是到 Supabase 东京区的跨境链路，不是解析、也不是渲染。

**改动**（+67 / −6，仅 `src/lib/server/zxgk-report.ts`）：

- 新增 `REPORT_CAPTURE_CONCURRENCY = 3` 与 `mapWithConcurrency(items, concurrency, worker)` worker pool。
- 主循环由「下载 → 解析 → 下一份」串行改为**有界并发 3**；worker 体内只有 `loadCapture` 与 `readPages` 两次 await。
- 结果**按下标回填** `results[index]`，输入顺序不变；失败语义为「全部 settle 后**按 selection 顺序抛第一个失败**」，抛原对象。
- DB metadata 加载（`loadProjectReportData`）仍为串行，未改动。
- `generateZxgkReportDocx` 增加**可选** `readPages` 注入（server-internal test seam：route 不传、缺省即真实实现）。
- 并发度是**固定常量**，不做自适应、不加配置项。

**性能 E2E（生产构建，真实浏览器）**——数据来自 2026-09-19 交接文档 §4.2，证据文件位于 `%TEMP%\zxgk-stage5h\`：

| 指标                    | 串行基线 | 并发 = 3                               |
| ----------------------- | -------- | -------------------------------------- |
| 端到端 wall             | 35.4s    | **10.17s**（省 71.3%）                 |
| in-flight 峰值          | 1        | 3                                      |
| 真实重叠（≥2 并发占比） | —        | 94.8%                                  |
| 请求成功率              | —        | 36 / 36 全 200，零 retry / 4xx / 5xx   |
| `word/document.xml` md5 | —        | `ea7bb19d…`，**与串行等价**            |
| 内容正确性              | —        | 28 records / 3 excluded / problems = 0 |

⚠️ **两个数字不可直接相减**：198s 是 dev 环境下的一次全量产品调用画像，35.4s / 10.17s 是生产构建下的浏览器 E2E，样本与运行口径不同。

**归因纪律**：同轮 `Σ(total) / wall = 2.61×` 才是纯并发收益；跨轮倍数（3.48×）含网络窗口变量，**引用时必须注明**。

**已知且被接受的代价**：并发版在首个失败后**排空整批**（旧串行循环首个失败即停）→ 失败时多花若干次 Storage GET；**对外可观察结果逐字一致**（同一错误对象 / 502 / 不出报告）。这是 deterministic failure semantics 的代价，不要「优化」掉。

## 自动化测试

`npm run test:db`：**181 / 181 通过**。

```text
tests/zxgk-execution-parse.test.ts   解析层
tests/zxgk-report-docx.test.ts       渲染层
tests/zxgk-report-flow.test.ts       流程 / 并发（1024 行）
```

并发测试必须钉住的性质：`maxActive ≤ 3`；完成序 3→1→2 而回填序 1→2→3；多 Task / 多 Capture 的全局顺序；失败确定性；**全成功路径与串行参考实现的 `document.xml` 逐字相同**。

夹具用**显式闸门**（`setImmediate`）制造完成顺序，**严禁用 `setTimeout`**——Windows 定时器粒度约 15.6ms，会漂移并导致测试不稳定。

⚠️ 判定产物等价性必须用 `word/document.xml`，**不能用整包 md5**：`docProps/core.xml` 含时间戳，整文件 md5 每次运行都不同。

## 技术边界

- 路由模型不变：同步 GET + 即时下载 + **零持久化**；本阶段不新增持久化、不新增依赖、不引入 AI。
- Excel 由 ExcelJS 生成、docx 由 `docx` 生成；两者共用同一份解析结果。
- **产品入口当前只生成 docx**：`GET /api/projects/[projectId]/report` 返回单个 docx（`Content-Type` = `REPORT_MIME_TYPE`，一次性返回、无流式）。**Excel 执行记录核对表目前只由开发 CLI 生成**，尚未进产品入口。
- `scripts/` 是开发工具，**不是产品入口**；产品入口是 `src/app/api/projects/[projectId]/report/route.ts`。

## 不在本阶段范围

- 报告线 Step 2 / Step 3（含「核查说明与律师提示模板」）。
- 异步 report job（Design Review Option C：需新增 job 持久化、状态机、幂等键、进度端点、产物清理策略，属产品能力变化，非性能加固）。
- 报告产物缓存 / 预处理（Option B：唯一可缓存项是 text extraction = 0.46%，且需新增持久化，判定不做）。
- 第二网站 adapter、TD-002 guard、M4 exactly-once、canonical Query 物理共享。

## Rejected / superseded design

以下方案**曾被提出，但判定为对本 MVP 超前，已删除**。它们是 **Rejected / superseded for this MVP**——**不是**当前实现，也**不是**未来必须实现的 backlog，不要当作待办重提：

- `extractions` / `facts` / `citations` / `reviews` **四表方案**；
- **character-level citation span**（字符级引用跨度）；
- **LLM-based fact extraction from raw PDF / raw evidence**（让 LLM 从原始 PDF / 原始证据里抽事实，即此前所称的「LLM 抽取层」）；
- **review UI**（人工审核界面）；
- **eval harness**。

当前实现是上述方案的**替代路线**：确定性解析器（`scripts/zxgk-execution-parse.ts`）+ 单表输出 + 固定报告模型，**无 AI 抽取层、无引用溯源表、无人工审核环节**。出处：2026-09-19 交接文档 §10「已明确删除的过度设计（不要重提）」。

### 边界澄清：事实层确定性，解释层可 AI 辅助

被否决的是**把事实层交给 LLM**，而不是**在解释层使用 LLM**。两者的边界如下：

**仍然被否决** —— LLM-based fact extraction from raw PDF / raw evidence：

- 不让 LLM 负责识别案件号；
- 不让 LLM 负责抽取执行法院、金额、日期等事实；
- 不让 LLM 替代现有 deterministic parser；
- 事实层继续由现有规则解析器（`scripts/zxgk-execution-parse.ts`）负责。

**不属于被否决范围** —— LLM analysis over already-verified structured facts：

- AI 可以消费 `ParseResult.rows`（已完成解析、已验证的结构化事实）；
- AI 用于摘要、归纳、重点事项识别、进一步核查建议；
- AI 输出必须标识为「分析草稿」；
- AI 不得新增不存在于结构化 facts 中的案件、金额、法院、日期等事实。

> **Facts are deterministic; interpretation may be AI-assisted.**
> 事实层是确定性的；解释层可以由 AI 辅助。

以上仅**收窄**原条目的适用范围，不改变「四表方案 / character-level citation span / review UI / eval harness」的否决结论，也不改写本文其他历史设计记录。

## 已知限制

- **部署平台未指定**：仓库根无任何部署配置（无 `vercel.json` / `netlify.toml` / `Dockerfile` / `.github/`）。若最终部署到默认 300s 上限的 serverless，基线 198s 只剩约 100s 余量，样本规模翻倍即触界；并发优化后余量显著增加，但仍需在确定平台后按其实测 max duration 复核。
- **已废弃（superseded）**：~~PDF 传输吞吐仍是推断值（≈158s，约 5.11s / 份；乐观与保守投影相差 2.5×）~~。「payload transfer ≈158s / ≈39KB/s」是**推断而非实测**，已被 `116e93d` 之后的生产 E2E 实测结果取代（见「Runtime hardening」），**不得再作为当前结论引用**。Design Review §11 B2 当时把这项实测列为落代码的前置条件，该实测即本轮 Stage 5。
- `inputs` 会累积全部留痕的解析结果，样本量级增长时需重估内存（当前 31 份无影响；实测进程 RSS 峰值 225–251 MB，绝大部分是 pdfjs 常驻）。
- `Packer.toBuffer` 78ms、`renderReportDocx` 15ms 已属渲染侧最大项，占总量 0.04%，无需优化。
