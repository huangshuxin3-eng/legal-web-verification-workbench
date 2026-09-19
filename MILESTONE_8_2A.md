# Milestone 8.2a：中国执行信息公开网「执行」第一页全量留痕

## 范围

M8.1 在 `HAS_RESULT` 处停止。M8.2a 从该分支继续，自动完成**第一页结果列表**与**第一页全部“查看”详情**的 PDF 留痕，然后进入 `FIRST_PAGE_COMPLETE` 并停止。

固定流程：

```text
HAS_RESULT
→ 复用当前 Task 下同一检索词的 canonical Query（无则新建一次）
→ 留痕第 1 页结果列表
→ 读取并冻结第 1 页全部结果
→ 第 1 条 → 查看 → 校验身份 → 完整 PDF 留痕 → 关闭详情返回列表 → 校验仍是第 1 页
→ 第 2 条 → …… → 第 N 条
→ FIRST_PAGE_COMPLETE
```

第一页有 10 条结果时，Capture 顺序固定为：`001` 结果列表，`002`–`011` 依次对应网站当前展示顺序的 10 条详情。Capture 编号继续由数据库 `reserve_capture_upload` 分配，Adapter 不自行计算。

## 真实页面事实

以下行为于 2026-09-15 直接读取网站 `index.html`、`detail.html` 与 `static/javascript/data.js` 确认，未做任何猜测：

- 结果行由页面脚本生成：`<tr><td>序号</td><td>姓名</td><td>立案时间</td><td>案号</td><td><a class="View" id="{记录ID}" onclick="openZhcxDetail(...)">查看</a></td></tr>`。不足 10 条时页面补齐不可见占位行，占位行中没有 `a.View`，因此“存在 `a.View`”就是数据行的判据。
- 「查看」**不会在当前标签页导航**：`openZhcxDetail()` 先预取详情接口，把参数写入 `sessionStorage`，再执行 `window.open("detail.html", "_blank")` 打开新标签页。因此返回列表等于**关闭详情标签页**，列表页自始至终没有被导航过。
- 详情页底部提供唯一的「关闭」按钮（`onclick="goBack()"`），`goBack()` 在存在 `opener` 时执行 `window.close()`。M8.2a 采用这一**网站自带的返回方式**，不使用 `history.back()` 这类在该页面明确无效的做法（详情页注释本身也说明“有 referrer 也不能用 history.back”）。
- 详情页把内容渲染为 `#detail-sections` 内的表格，每行为 `<td><strong>标签：</strong></td><td>值</td>`，其中「案号」一行可用于确认该详情属于当前处理的结果。
- 分页控件位于结果表格下方；M8.2a 只读取 `#currentPage`、`#currentPage-show`、`#totalPage-show`，不触发任何分页动作。

## 状态机

在 M8.1 状态机上新增：`CAPTURING_LIST_PAGE`、`READING_RESULT_ROWS`、`OPENING_DETAIL`、`CAPTURING_DETAIL`、`RETURNING_TO_LIST`、`VERIFYING_LIST_STATE`、`FIRST_PAGE_COMPLETE`。

`currentOperation` 记录当前正在处理什么，只用于进度显示与诊断：

```text
列表：{ type: "LIST",   pageNo: 1, rowKey: null, caseNo: null, phase }
详情：{ type: "DETAIL", pageNo: 1, rowKey, caseNo, phase, detailTabId }
```

留痕 finalize 成功后会追加成功标记：详情添加 `captureId`，列表添加 `captureId / capture / filename`（补记载荷）。`phase` 取值 `LOCATING / OPENING / CAPTURING / RETURNING / VERIFYING`。这些信息只存在于 `chrome.storage.local.automationJob`，没有新增数据库字段。

`AUTOMATION_RUNNING_STATES` 与 `AUTOMATION_INTERRUPTED_STATES` 由状态模块统一导出，Service Worker 与 Side Panel 共用，避免新增状态时漏改其中一处。

## rowKey 与冻结集合

每条结果的运行期身份为：

```text
normalize(name) | normalize(caseNo) | normalize(filingDate)
```

`normalize` 只做 NFKC 与空白规整，不改写内容。rowKey 实现通过 `ROW_KEY_SOURCE` 注入页面表达式，Node 侧与页面侧共用同一份函数，避免身份判定分叉。

处理第一条详情之前，先读取并冻结 `pageOneRows / pageOneRowKeys / expectedDetailCount`。此后不按“第几行”决定下一条，只能通过 rowKey 重新定位。第一页出现两个完全相同的 rowKey 时 fail closed，不靠行号猜测。

`completedDetailKeys` 只在「PDF 生成成功 + Private Storage 上传成功 + Capture finalize 成功 + 已关闭详情并确认返回第 1 页」之后才追加：打开过网页不算完成，只生成到内存不算完成。

## 失败原则

任何一环异常都进入 `PAUSED / FAILED`，不跳过、不猜测，已生成的 Query 与 Capture 全部保留，不做自动回滚：

```text
无法解析第一页结果 / rowKey 不唯一 / 列表留痕失败 / 找不到目标 rowKey
找不到或不可见的“查看” / 详情标签页未打开 / 详情页报错或超时
详情案号与当前处理案号不一致 / 详情未出现主体名称 / 详情留痕失败
关闭详情后标签页仍在 / 返回后不是第 1 页 / 冻结目标无法再定位
标签页被关闭 / 页面被跳转 / 后台中断
```

身份校验使用 `evaluateDetailIdentity`：案号必须与当前处理的案号一致，正文必须出现当前主体名称，否则不生成留痕。

## M8.2a 收尾：canonical Query 与「继续本次核查」

真人 E2E 暴露了两个 blocker：失败后重新开始会从第 1 页第 1 条重来并重复留痕；每轮自动核查都会新建 Query。收尾阶段按锁定的产品语义做了最小修正。

### Query 语义（正式锁定）

```text
Task    = 核查对象（entity_name）× 核查事项（topic）× 核查网站（source_name / source_url）
Query   = 当前 Task 下的一种检索词（query_text）
Capture = 该 Query 从头到尾产生的全部证据
```

同一 Task 下 `trim(entity_name)` 相同的自动核查**始终复用同一个 canonical Query**，不因执行次数不同而新建。canonical 的选择规则：当前 Task 内 `query_text` 相同者中取 `query_no` 最小（异常时以 `created_at`、`id` 稳定 tie-break）。

- 复用发生在**开始自动核查时**，不等结果确认；`NO_RESULT` 也复用同一个 Query。
- 手工建立的 Query（不参与自动化）原样保留，不删除、不合并、不迁移任何历史 Query。
- 历史遗留的多个同文本 Query 全部保留，只是不再继续制造新的。

### 失败后继续

- 中断不再只能「放弃」：进度满足条件时 Side Panel 提供「继续本次核查」，`automation-resume` 消息复用**同一个 `automationJob` 与同一个 Query**，重新打开页面、填主体、提交，停在同一处 `WAITING_HUMAN_VERIFICATION`，仍不代替人工过安全验证。
- 进度仅存于 `chrome.storage.local.automationJob`：`queryId / listCapture / pageOneRows / pageOneRowKeys / expectedDetailCount / completedDetailKeys / currentOperation / firstPageComplete`。
- 列表已留痕则跳过；详情按 `completedDetailKeys` 跳过已完成项，从第一个未完成的 rowKey 继续。
- `currentOperation.captureId`（详情 Capture 成功即写入 `chrome.storage.local`）用于关闭「Capture 已成功但 `completedDetailKeys` 尚未更新」的窗口：重启后先补记，不重复留痕。
- 继续前对当前第 1 页重新读取 rowKey 集合，与原冻结集合做**严格集合校验**（顺序可变，但不增、不减、不重复）；任一不一致即 fail closed。Task 上下文（id / project / entity / topic / source）不符同样 fail closed。
- `resume` 同样只处理第一页，绝不点击任何分页控件。

### LIST 与 DETAIL 的统一成功事务语义

列表留痕与详情留痕使用同一套「先落盘成功标记、再收尾」的语义：

```text
archiveQuery 返回（Capture 已 finalize，DB 已有记录）
→ 立刻 saveState：currentOperation 写入 captureId（列表同时带上 capture / filename 补记载荷）
→ save automationJob
→ 再做 verify / 状态收尾（列表补记 listCapture 并清空 currentOperation）
```

因此「Capture 已成功但进度尚未补记」这一窗口对列表和详情都是**只补记、不重复留痕**：继续时按 `currentOperation.captureId` 判定，列表交给 `settlePendingListCapture` 补记 `listCapture`，详情交给 `settlePendingCapture` 补记 `completedDetailKeys`。`resumeFirstPage` 刻意**不再**在补记之前清空 `currentOperation`，否则会在补记之前新开一个中断窗口。`runFirstPageLoop` 另有一层兜底：只要 `currentOperation` 带着成功的列表 `captureId`，就绝不重新 Capture 列表。Side Panel 用 `hasListCapture` 判断进度，避免在这道窗口里谎报“待留痕”。

**仍未关闭的窗口**：`archiveQuery` 已经 finalize 成功、但**连成功标记都还没落盘**时进程被杀，本地没有任何成功证据，继续时会再归档一次列表（详情同理，属 M8.2a 既有行为）。彻底关闭它需要把稳定的 `request_id` 透传给 M4 归档链路——`reserve_capture_upload` 已按 `p_capture_id` 幂等（同 id 返回同一 Capture 或同一预留，不消耗新编号），`POST /api/captures` 也有「已存在则直接返回」的分支，因此这条路可行，但会改动 M4 调用链，本轮未做。`automation.test.mjs` 中有一条专门记录该残余行为的测试：「列表留痕在 finalize 返回前中断时，继续本次核查会重新归档列表（已知残余窗口）」。

### 继续时重建网页查询环境

`resume` 不假设原页面还能用，也不做「就地续跑」：

```text
resume
→ 复用原 automationJob / 原 Query / 原第一页进度
→ 重新读取 automationJob.queryId（fail closed 校验，见下）
→ getTab(job.tabId)：原自动化标签页仍在就直接复用
  原标签页已关闭 → createTab() 新建一个专用标签页（chrome.tabs.create + 等它真正落在查询入口）
                  → 新 tab.id 写回 job.tabId
  绝不退化为导航用户当前正在浏览的活动标签页
→ openQueryPage(tabId, 当前 URL)
     worker：当前 URL 不是查询入口才 chrome.tabs.update 重新导航，
             随后必须等加载完成并复核落地 URL
→ 重新填 Task.entity_name → 重新提交
→ 停在 WAITING_HUMAN_VERIFICATION（不代替人工过安全验证）
→ 人工验证后「重新检查结果」→ 重新读取第 1 页 → 与冻结集合 reconcile
→ 集合一致才从第一个未完成项继续
```

因此**可以恢复**：自动化标签页被关闭（会新建一个专用标签页，不占用用户当前标签页）、已被导航到别处、当前页面停在详情页/其他站点、当前不是第一页结果页、网站 session 或安全验证已失效（重新查询会再次要求人工验证）。**不能恢复**：当前第 1 页结果集合与原冻结集合不一致（一律 fail closed 交人工）；没有任何第一页进度（不提供「继续本次核查」）。另外，`openQueryPage` 在 URL 已是查询入口时**不会刷新页面**，这一分支依赖“结果态下 `#pName` 仍可见、且页面只有一个文本为「查询」的可见按钮”，该页面事实尚未在真实 Chrome 上逐条确认；即使不成立也只是 fail closed，不会误操作。

### 继续前的 Query fail-closed 校验

`resume` 在碰任何标签页之前，先按 id 重新读取 `automationJob.queryId`（`GET queries?id=eq.<id>&limit=1`，只读、无副作用），三个条件同时成立才允许继续：

1. Query 存在（未删除、当前账号仍可访问）；
2. `query.task_id === automationJob.taskId`；
3. `normalizeQueryText(query.query_text) === normalizeQueryText(automationJob.queryText)`（只 trim，与 `query-identity.mjs` 同一实现）。

任一不满足即 fail closed：任务进入 `FAILED`，文案为「本次核查关联的 Query 已不存在或无法访问，无法安全继续本次核查。已生成 Capture 不删除。」**不新建 Query、不静默切换其他 Query、不创建标签页、不重新查询、不产生任何 Capture**；已生成的进度与 Capture 全部原样保留。校验通过时不写回、不改动 Query（只读）。

### 手工 Query 与自动核查 Query 的彻底分离

Side Panel 上出现过的「Query 已删除或无权访问，请重新选择。」来自 `data.queryContext()`（`data.mjs`），它的唯一调用者是 M4 归档入口 `archive(queryId, tabId)`，而该入口被两条链路共用：

- **手工留痕**：`{type:"archive"}` 消息，`queryId = $("query").value`（即 `selectedQueryId`，手工下拉框）；
- **自动核查**：依赖注入 `archiveQuery`，`queryId = automationJob.queryId`。

原本文案完全相同，导致手工 Query 的失效看起来像自动核查的 Query 也坏了。现在按上下文分开：

| 上下文   | 取值来源                                | 文案                                                                                   |
| -------- | --------------------------------------- | -------------------------------------------------------------------------------------- |
| 手工     | `$("query").value`（`selectedQueryId`） | 当前手工 Query 已删除或无法访问，请重新选择。                                          |
| 自动核查 | `automationJob.queryId`                 | 本次核查关联的 Query 已不存在或无法访问，无法安全继续本次核查。已生成 Capture 不删除。 |

实现：`data.queryContext` 抛出带 `code: "QUERY_NOT_ACCESSIBLE"` 的**上下文无关**错误，`archive(queryId, tabId, context = "manual")` 按 `context` 映射文案（只重写这一类，网络 / 登录错误原样透传）；自动核查的文案由 `zxgk-automation.mjs` 导出 `AUTOMATION_QUERY_UNAVAILABLE_MESSAGE` 并被 worker 复用，避免两处漂移。

另外，自动核查**不依赖**手工选择：`automationRequest` 发出的消息体只有 `{ type, taskId, projectId }`，`resume/start/continueAfterVerification` 只读 `getTask`、`job.queryId`；反向耦合只有一处且是纯展示（自动核查请求后用 `chooseTask(job.taskId, job.queryId)` 把自动核查的 Query 显示到手工下拉框）。自动核查自身的失败已显示在自动核查卡片内，因此不再重复写进页面底部的错误行（`automationErrorShownInCard`），避免两个上下文在 UI 上糊在一起。

## 本轮不做

没有实现第二页及以后分页、下一页/尾页自动点击、多页完整性判断、Chrome 重启后的断点恢复、跨 session reconcile、专用 automation tab、后台并发执行、多 Task 队列、AI 与结果摘要。`FIRST_PAGE_COMPLETE` 有意不叫 `DONE`：网站可能还有第 2～21 页，Side Panel 明确显示「后续分页暂未自动执行。请人工继续核查。」，不出现“全部完成”类措辞。

## 技术边界

- Extension permissions 保持 `activeTab / debugger / sidePanel / storage / tabs`，没有新增权限，没有 `<all_urls>`。
- 详情标签页由页面 `window.open` 创建，Extension 通过对比标签页集合发现它，不依赖新增权限。
- 等待使用标签页状态与 DOM 条件加有界轮询，超时不等于成功。
- PDF 继续使用 `Page.printToPDF` 与 Legal Web Check PDF Profile v1；归档继续走 M4 的 `archive`（`POST /api/captures` → Private Storage → Capture 六字段），Extension 没有第二套上传或编号实现。
- 本阶段 0 migration、0 schema、0 RLS、0 新业务实体，Capture 仍为六字段。

## 自动化测试

- `npm run test:db`：100 / 100 通过（M8.2a 未改动 `src/` 与根 `tests/`，数量与 M8.1 一致）。
- `npm run extension:test`：79 / 79 通过（M8.2a 原始 45 项 + blocker 收尾 19 项 + LIST 成功事务语义与 continue 页面环境重建 6 项 + 恢复行为修正 2 项 + 本轮 Query 上下文分离 7 项）。其中 M8.2a 覆盖 Query 复用、列表优先顺序、详情展示顺序、rowKey 唯一性与注入一致性、详情案号校验、失败即停且保留已生成 Capture、返回后仍须第 1 页、顺序变化仍按冻结集合处理、目标丢失 fail closed、`FIRST_PAGE_COMPLETE` 不等于 `DONE`、绝不出现分页动作，以及 M8.1 `NO_RESULT` 与 M1–M6.5 回归；blocker 收尾覆盖 canonical Query 复用与最小 `query_no` 选择、手工 Query 不参与、继续时跳过已完成列表与详情、`currentOperation.captureId` 补记不重复、集合增/减/重复一律 fail closed、Task 变化 fail closed、无进度时不提供「继续」、继续时同样不点分页。
- 本轮新增 6 项：列表「finalize 成功但尚未补记」的精确中断窗口下继续核查**不重复留痕列表**且编号不多消耗；同一窗口在 finalize 返回前中断时**重新归档列表**（已知残余窗口的看门人）；`hasListCapture` 把「已 finalize 但尚未收尾」也判为已留痕；Side Panel 进度使用 `hasListCapture`；`resume` 重建查询环境、重新填主体/提交、仍停在人工验证；worker 与自动化层共用同一套查询页重建流程（条件导航 + 等加载完成 + 复核落地 URL）。
- 恢复行为修正新增 2 项：原自动化标签页仍在时**复用该标签页、一个都不新建**；原标签页已关闭时**新建专用标签页、把新 `tab.id` 写回 `job.tabId`、全程不查询也不导航用户当前活动标签页**，并在新标签页上照常走完「人工验证 → reconcile → 继续未完成项 → `FIRST_PAGE_COMPLETE`」且列表编号不多消耗。另有一条源码级断言把这套取标签页的分支钉住（`getActiveTab` 只有 `start` 用、`resume` 内不出现 `tabs.update`、worker 只有两处带显式 `tabId` 的 `tabs.update`）。
- 本轮新增 7 项：`automationJob.queryId` 已不存在 / 属于其他 Task / `query_text` 与 `job.queryText` 不一致时**继续本次核查一律 fail closed**，且断言「fail closed 之前不新建 Query、不创建标签页、不重新查询、不产生 Capture，进度与 Capture 原样保留」；检索词只差首尾空白**仍算一致**、继续不被拦（锁定 `normalizeQueryText` 只 trim 的语义）；手工 Query 已失效时自动核查**照常继续**（证明 `resume` 只认 `automationJob.queryId`）；手工与自动两套 Query 失效文案、`QUERY_NOT_ACCESSIBLE` 标记与 `archiveQuery` 的 automation 上下文绑定、`automationRequest` 消息体不含 `queryId`、`automationErrorShownInCard` 的源码级断言。
- `npm run typecheck`、`npm run build`、`npm run format:check`、`git diff --check`：通过。

尚未在真实 Chrome + 真实 Supabase 上完成端到端验收，本文档不声称 E2E 已通过。

## 已知限制

- 详情页 URL 固定为 `detail.html`，不含查询参数，因此同一轮中所有详情 Capture 的 `source_url` 相同；业务文件名本轮也不区分案号，详情之间只能靠 `capture_no` 与创建时间区分。这是 M8.2a 的已知取舍，留待后续阶段处理。
- 若列表页的安全验证在循环期间过期，网站的 `detailZhcx` 会弹出 `alert` 或跳回验证流程；此时详情标签页不会出现，自动核查按超时 fail closed。
- 列表与详情仍各有一道「Capture 已 finalize，但成功标记尚未落盘」的极窄中断窗口，此时继续会重复归档一次（见「LIST 与 DETAIL 的统一成功事务语义」）。关闭它需要把稳定的 `request_id` 透传进 M4 归档链路，本轮未做。
- 继续本次核查会重建查询环境并**再次要求人工过安全验证**：即使原标签页仍停在合法结果页，`resume` 也走「重填 + 重提交」而不是直接复用当前页面。因此页面上遗留的验证态不会被自动跳过，但也无法省掉这次人工验证。
- 标签页只在「继续」时按需处理：原自动化标签页仍在就复用它，已被关闭才新建一个并接管（新标签页会被激活以获得焦点），**不会**导航用户当前正在浏览的标签页。这里不做长期后台专用 tab 管理，也不跨 Task 复用标签页；若原自动化标签页仍存在但用户已把它用于别的用途，继续时会把它导航回查询入口。
- 本轮不做 Chrome 进程级断点恢复：Service Worker 被浏览器回收后，继续能力仍受限于 `chrome.storage.local.automationJob` 与「同一页第 1 页集合不变」；集合已变化则 fail closed，交由人工核对，不会自动从第 N 条继续。
- `resume` 的 Query 校验是**运行时**判定，没有把结果落到 job 上：若 `automationJob.queryId` 已失效，`canResumeFirstPage` 仍为真，Side Panel 仍会显示「继续本次核查」，再点一次会得到同一条明确的 fail-closed 提示（可用「放弃本次核查」退出）。这样避免新增 job 字段，代价是需要人工点一次才知道 Query 已失效。

---

## Post-completion status（后补，非本文件原文）

> 本节由文档校准轮次（2026-09-19）追加，用于消除与后续记录的表面矛盾。**本文件正文保持形成时的原状，未作改写**——上文「自动化测试」一节的结尾句反映的是本文档成文时的真实状态。

2026-09-15 已完成真人 Chrome + 真实 Supabase 端到端验收，结论记录在 `NONLIT_WORKBENCH_CONTEXT.md` §10：第 1 页列表 Capture 1 / 1、详情 Capture 10 / 10、本页新增留痕 11，终态 `FIRST_PAGE_COMPLETE`，且未进入第 2 页。

此后 M8.2b 已把该闭环泛化为多页全量留痕，`FIRST_PAGE_COMPLETE` 不再是新产品路径的终态；交付说明见 `MILESTONE_8_2B.md`。
