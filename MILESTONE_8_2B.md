# Milestone 8.2b：中国执行信息公开网「执行」多页全量留痕

## 范围

M8.2a 在 `FIRST_PAGE_COMPLETE` 处停止。M8.2b 从该状态继续，把第 1 页之后的页逐页补齐：

```text
FIRST_PAGE_COMPLETE（或中断后的稳定 checkpoint）
→ 校验 totalPages baseline
→ advance 到下一页
→ 校验真实落页信号
→ reconcile 当前页冻结集合
→ 留痕本页列表 → 逐条留痕本页全部详情
→ 页内完成后退回列表、确认仍在同一页
→ 直到最后一页
→ DONE
```

每页的 Capture 顺序与 M8.2a 一致：先本页列表，再按网站当前展示顺序逐条详情。Capture 编号继续由数据库 `reserve_capture_upload` 分配，Adapter 不自行计算。

M8.2b 的终点是 **`DONE`**：所有页 `PAGE_COMPLETE`、`completedPages` 连续覆盖 `1..totalPages`、totalPages 与 baseline 一致、无 pending operation、末页完整性已验证。`totalPages = 1` 时也走同一条成功路径写 `DONE`。

## 事实基线（Slice 0）

M8.2b 的网站事实在实现之前先行锁定，记录于 `NONLIT_WORKBENCH_CONTEXT.md` §26，分 A（源码级 CONFIRMED）/ B（真人 Chrome CONFIRMED）两类、不混写。要点：

- 分页控件位于 `#page-div`；「下一页」= `#next-btn` + `onclick="nextPage()"`。
- `firstPage / prePage / nextPage / lastPage / goPage` 本质都是「改 `#currentPage` → 调 `search()`」，而 `search()` 是**纯 AJAX POST**，列表页从不被导航。
- `nextPage()` 读的是 `#currentPage`（上次服务端回传值）**加 1**，不是 `#currentPage-show`。
- `goPage()` 存在夹取逻辑（输入 ≥ 总页数会被静默改成末页）→ 实现**不依赖** `goPage()`，越界校验必须由 adapter / automation 自己承担。
- 真实结果行判据为 `#tbody-result a.View`；不足 10 条的 filler row 没有 `a.View`；页内序号跨页必然重复，**不能作为身份**。
- `#totalPage-show = ceil(server totalSize / 10)`，页大小恒为 10、无 `pageSize` 参数；每次 search / 分页后按本次响应重算。
- 末页 `#next-btn` 仍存在、仍可见，但 `disabled = true` → **`next disabled ≠ DONE`**。
- 每次 `search()` 都检查 verification token；禁止 hardcode token TTL，禁止把验证码失败当作空结果页。

Slice 0 出口条件（`NONLIT_WORKBENCH_CONTEXT.md` §26.8）：源码探测完成、真人 F-1（1 → 2 页）✅、真人 F-4（末页 21 / 21）✅、不存在阻塞 M8.2b 的网站事实。

## 实施序列

本节按提交链列出，不重排历史。仓库既有文档只对**部分**阶段使用了明文编号（Slice 0、Slice 1、Slice 3B、Slice 5），其余阶段本文件不另行编号。

| 提交      | 内容                                         | 编号出处                                            |
| --------- | -------------------------------------------- | --------------------------------------------------- |
| `bc933fc` | 事实记录，仅改 `NONLIT_WORKBENCH_CONTEXT.md` | §26「M8.2b Slice 0」                                |
| `bc26084` | 泛化 zxgk automation 页面状态                | §26.8「Slice 1 — Runtime Page Model + Invariant」   |
| `4f3ce3b` | 暴露 zxgk 页面导航 adapter primitives        | `extension/src/adapters/zxgk-execution.mjs`         |
| `e65c3c8` | 确定性 zxgk 页面推进协议                     | `extension/tests/zxgk-page-advance.test.mjs`        |
| `cc6f438` | zxgk 两页执行流                              | `extension/tests/zxgk-two-page-run.test.mjs`        |
| `901c48a` | durable zxgk resume recovery                 | `extension/tests/zxgk-multipage-resume.test.mjs`    |
| `de05324` | 通用 zxgk 多页自动化                         | `automation-state.mjs` 状态注释「Slice 5 重新定义」 |

`bc26084` ~ `de05324` 同时修改 `extension/src` 与 `extension/dist`（本仓库把 dist 产物一并入库）。这是 M8.2b 的必要范围：多页能力落在 Extension 的自动化层，Workbench 侧与数据库侧零改动。

## 页面状态模型与不变量

状态机在 M8.2a 基础上新增 `ADVANCING_PAGE`、`PARTIAL_COMPLETE`，并以 `DONE` 作为多页成功终态；M8.2a 的 `FIRST_PAGE_COMPLETE` 保留为 legacy 终止态（读取兼容，新产品路径不再产生）。

页模型最小页号为 `FIRST_PAGE_NO = 1`：M8.2a 持久化的 job 没有页坐标（只有一个当前页），读取时按第 1 页处理。

`PARTIAL_COMPLETE` 的语义由 `automation-state.mjs` 的源码注释锁定：它是「已有连续完整前缀 `1..K`、但网站仍有剩余页」的**稳定 checkpoint**——属于正常结束，不是错误、不是运行中，也是一个已结算态，后台重启时不会像中断状态那样被改写成 `FAILED`，同时可以作为「继续剩余分页核查」的检查点。Slice 5 的通用分页引擎会把一次核查一直推进到最后一页并写 `DONE`，因此**新的核查不再产生 `PARTIAL_COMPLETE`**，它只用于旧版本遗留 checkpoint 的读取兼容。

状态集合仍由状态模块统一导出：`AUTOMATION_STATES`、`AUTOMATION_RUNNING_STATES`、`AUTOMATION_INTERRUPTED_STATES`、`AUTOMATION_CHECKPOINT_INVALID_CODES`，由 Service Worker 与 Side Panel 共用；checkpoint 合法性收敛在 `validateZxgkAutomationJobInvariant(job)` 与 `normalizeAutomationJob(job)`。

不变量（`NONLIT_WORKBENCH_CONTEXT.md` §26.7 人工锁定，不得弱化）：

- **`currentPage` / `completedPages` 必须 state-sensitive**：页内处理中 `currentPage` 不在 `completedPages`；`ADVANCING_PAGE` 时已在；`DONE` 时 `currentPage === totalPages` 且 `completedPages` 连续覆盖 `1..totalPages`。
- **历史页只存 summary**：历史页只保存 `completedPages` summary；只有当前页保存 `currentPageRows` + `pageFrozenKeys`。
- `firstPageComplete` 可保留，但新逻辑不依赖它，也不主动删除。
- **totalPages 任何变化都 PAUSED**：baseline 建立后 `observed === baseline → continue`，`observed !== baseline → PAUSED`；增加 / 减少 / null **全部暂停**，不采用 B+。

## 导航 primitives 与跳页协议

跳页动作统一走 `jumpToPageExpression(targetPage)`，协议为：

```text
1. 先校验：1 <= targetPage <= baselineTotalPages
2. 设置 #currentPage = targetPage
3. 调 search()
4. 读取真实页面信号验证目标页
```

因为不依赖 `goPage()`，网站自带的越界保护被绕开，越界校验由 adapter / automation 自己承担。

落页判定与冻结由一组纯函数完成，便于 Node 侧直接单测：`validatePage(snapshot, expectedPageNo)`、`validateFirstPage(snapshot)`、`freezePageRows(snapshot, expectedPageNo)`、`freezePageOneRows(snapshot)`、`locateRowKey(snapshot, expectedRowKey, expectedPageNo)`、`reconcileRowKeys(...)`、`reconcileFrozenSet(...)`。

结果身份仍为 M8.2a 锁定的 rowKey：

```text
normalize(name) | normalize(caseNo) | normalize(filingDate)
```

`ROW_KEY_SOURCE` 继续把同一份 rowKey 函数注入页面侧，Node 侧与页面侧共用，避免身份判定分叉。页面侧读取结果的表达式为 `resultSnapshotExpression()` / `resultRowsExpression()`。

推进的验证规则（`NONLIT_WORKBENCH_CONTEXT.md` §26.6 锁定）：

```text
success:
  target page observed
  + input / shown 一致
  + rows 可读
  + totalPages 与 baseline 一致

wrong page           → fail closed
captcha failure      → human / fail closed path
source page 一直不变 → 等到 deadline → timeout
```

禁止「固定 sleep 后假设成功」，也禁止「minWait 后提前猜失败」。

## 两页执行流与恢复

`cc6f438` 把流程从「第一页结束后停止」推进到「进入第 2 页并完整留痕」，即一次运行覆盖前两页。`901c48a` 补齐持久恢复，把「后台重启后怎么办」变成可判定问题：

- **same-environment pending `PAGE_ADVANCE` settle 与 fresh resume 必须分开。** 原环境仍在 → 可读真实 shown / input 来 settle；真正 resume → 不得据旧 click 猜测，必须重建查询环境后重新验证。
- **fresh resume 到 Page N（§26.5 锁定）**：

```text
重建查询
→ CAPTCHA
→ Page 1
→ baseline totalPages verification
→ direct jump Page N
→ page signal verification
→ current frozen-set reconciliation
→ continue
```

**不要逐页 next。**

- **legacy Page 1 继续分页前先 reconcile**：重查 Page 1 → 校验 totalPages → reconcile Page 1 frozen set → 才进入 Page 2；**不重新 Capture Page 1**。
- 页面侧由 `settlePendingPageAdvance(job, snapshot)` 与 `classifyPageArrival(...)` 判定「落地页到底是哪一页」，不猜页；页面完整性由 `pageCompleteness(job, pageNo)` 汇总。
- Side Panel 进度模型由 `deriveZxgkAutomationProgressViewModel(job)`（`extension/src/lib/automation-progress-view.mjs`）统一产出，Worker 与 UI 共用同一份口径。

## 通用多页

`de05324` 把「两页」硬编码泛化为 N 页：一次核查从第 1 页连续推进到最后一页，每页重复「列表留痕 → 逐条详情留痕 → 页内一致性校验」，全程以冻结集合与 totalPages baseline 为判据；`totalPages = 1` 的情形也走同一条成功路径。跨页结果身份依赖 rowKey，页内序号不参与身份判定。

## 失败原则

- resume 时冻结集合已变化 → `PAUSED(RESUME_BOUNDARY_CHANGED)`，不猜、不重发动作。
- 网站自报总页数与 baseline 不一致 → `PAUSED(TOTAL_PAGES_CHANGED)`。
- 目标丢失 / 落错页 → fail closed，保留已生成 Capture 与进度。
- 页内处理期间 `#currentPage` 意外被改写 → 不重发跳页动作，先证明真实落页再决定。
- 已有 `ADVANCING_PAGE` 意图但页面仍停在源页 → 重新证明后重新跳页一次；页面已到目标页 → 以真实事实就地冻结，**绝不重发动作**。

## 技术边界

- Extension permissions 保持 `activeTab / debugger / sidePanel / storage / tabs`，没有新增权限，没有 `<all_urls>`。
- 页面读写继续使用现有 `debugger` 权限下的 CDP `Runtime.evaluate`；PDF 继续使用 `Page.printToPDF` 与 Legal Web Check PDF Profile v1；归档继续走 M4 的 `POST /api/captures` → Private Storage → Capture 六字段。
- 本阶段 0 migration、0 schema、0 RLS、0 新业务实体，Capture 仍为六字段；`automationJob` 仍只存在于 `chrome.storage.local`。
- 不做 token 过期时长实验、不做 `goPage()` 非法输入实验、不做翻页 WAF 频率实验（§26.4）。
- 不做 AI 页面判断，不做第二网站 adapter。

## 自动化测试

`npm run extension:test`：**219 / 219 通过**（M8.2a 为 79 / 79，M8.2b 净增 140 条）。

本阶段新增 / 扩展的测试文件：

```text
extension/tests/automation-pagination.test.mjs
extension/tests/automation-progress-view.test.mjs
extension/tests/zxgk-pagination-adapter.test.mjs
extension/tests/zxgk-page-advance.test.mjs
extension/tests/zxgk-two-page-run.test.mjs
extension/tests/zxgk-multipage-run.test.mjs
extension/tests/zxgk-multipage-resume.test.mjs
extension/tests/zxgk-result-identity.test.mjs
```

夹具：

```text
extension/tests/helpers/zxgk-multipage-harness.mjs
extension/tests/helpers/source-modules.mjs
```

覆盖要点（由测试名钉住，节选）：

- same environment：页面自己证明仍是 persisted 第 2 页 → 就地继续，不重发跳页。
- same environment：页面与 checkpoint 不一致时不猜页，交回重建流程。
- Case B：跳页意图已落盘但页面已到第 2 页 → 以真实事实就地冻结，绝不重发动作。
- Case B：意图已落盘但页面仍停在源页 → 重新证明后重新跳页一次。
- fresh resume：重建环境后回到第 2 页，只补记已有留痕、绝不重复。
- fresh resume：第 1 页结果集合已经变化 → `PAUSED(RESUME_BOUNDARY_CHANGED)`。
- fresh resume：网站自报总页数已经变化 → `PAUSED(TOTAL_PAGES_CHANGED)`。

## 验收状态

自动化测试全绿（`extension:test` **219 / 219**，M8.2a 为 79 / 79）。本线**最终 checkpoint：`de05324`**。

真人多页端到端验收：**待补入档**。

> 已知情况：后续对话与交接材料中存在真人多页运行记录，但本轮仓库文档校准**未找到足够强的持久原始验收证据**，因此**暂不固化为正式 milestone acceptance**。在证据补入档前，本文件不声称多页真人 E2E 已通过。

## 已知限制

- 页内序号跨页必然重复，**不得作为结果身份**，身份只能用 rowKey。
- 不足 10 条的 filler row 没有 `a.View`；末页可能有 1..10 条真实 rows，**不得假设末页不足 10 条**。
- 分页是 AJAX，列表页从不被导航 → 「退回列表」不等于「重新导航到列表」。
- 若验证 token 在翻页循环期间失效，网站会重新要求人工验证；此时不得把验证失败当作空结果页。
- 末页 `#next-btn` 仍可见但 `disabled` → **`next disabled ≠ DONE`**，DONE 只能由不变量组合判定。
- 详情页 URL 固定为 `detail.html`、不含查询参数，因此同一轮所有详情 Capture 的 `source_url` 相同；详情之间仍只能靠 `capture_no` 与创建时间区分（M8.2a 遗留取舍）。
- `resume` 的 Query 校验是运行时判定，未落到 job 上：Query 已失效时 Side Panel 仍会显示「继续本次核查」，再点一次才得到明确的 fail-closed 提示。
