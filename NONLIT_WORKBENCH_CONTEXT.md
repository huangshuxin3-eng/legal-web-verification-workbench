# NONLIT_WORKBENCH_CONTEXT.md

> 项目：非诉网核工作台（Nonlit Workbench）
>
> 用途：跨对话 / 跨 Agent 的长期项目上下文与决策记录
>
> 最近更新：2026-09-19
>
> 当前正式 checkpoint：`116e93d perf: parallelize zxgk report capture loading`

---

## 1. 产品定位

非诉网核工作台面向非诉律师、律师助理、实习生、初级律师，核心目标不是“替律师做法律判断”，而是把网核工作变成可管理、可留痕、可归档、可交付的标准化工作流。

MVP 核心价值：

- 管理网核项目、任务、检索词与留痕；
- 自动记录实际检索过程；
- 自动生成证据留痕文件；
- 对文件进行统一命名、归档和存储；
- 最终生成可交付 ZIP + Excel 清单；
- 尽量减少人工重复操作，但在 CAPTCHA、页面不确定性等场景严格人工接管。

原则：

- 完整性优先，不能漏结果。
- 宁可暂停，也不能猜。
- CAPTCHA 必须由人工完成，不做绕过。
- 在 deterministic automation 足够时，不引入 AI。
- 不为了未来可能的需求提前过度抽象。

---

## 2. 技术栈

- Next.js
- React
- TypeScript
- Supabase PostgreSQL
- Supabase Auth
- Supabase Private Storage
- RLS
- Chrome Extension Manifest V3
- Chrome Side Panel
- `chrome.debugger`
- Chrome DevTools Protocol `Page.printToPDF`

本地项目：

```text
C:\Users\黄舒心\Documents\产品经理计划\nonlit-workbench
```

Supabase 区域：Tokyo。

Extension 仅使用用户 JWT + Publishable Key，不使用 service role。

---

## 3. 核心数据模型

### Project

```text
id
owner_id
name
code optional
status
created_at
```

### Task

```text
id
project_id
entity_name
topic
source_name
source_url
note optional
status
created_at
completed_at optional
```

Task 语义：

> 核查对象 × 核查事项 × 核查网站

例如：

```text
恒大集团有限公司 × 执行 × 中国执行信息公开网
```

### Query

```text
id
task_id
query_no
query_text
created_at
```

**Query 语义已正式锁定：**

> Query = 某个 Task 下的一种实际检索词。

不是“一次运行”。

因此：

```text
Task = 查哪个主体的哪类事项/网站
Query = 这个 Task 下使用的一个检索词
Capture = 这个检索词从头到尾产生的全部留痕证据
```

自动化的执行批次、进度、恢复状态属于 runtime state，不等于 Query。

默认自动化检索词：

```text
trim(Task.entity_name)
```

同一 Task + 同一 query_text：

- 必须复用同一个 canonical Query；
- 失败、继续、重跑仍然复用；
- 只有检索词真的改变时，才新建 Query。

历史重复 Query：

- 不删除；
- 不合并；
- 不迁移 Capture；
- 不重排 query_no。

canonical Query 选择规则：

1. `query_no` 最小；
2. 相同 `query_no` 时 `created_at ASC`；
3. 再以 `id ASC` 打破平局。

如果未来真的需要区分一次次执行，应新增 Run 概念，但当前不要增加 Run 表。

### Capture

字段严格锁定为 6 个：

```text
id
query_id
capture_no
storage_path
source_url
created_at
```

不得未经明确确认增加 Capture DB 字段。

业务含义：

> 网核留痕文件

格式：

- PDF 为主；
- PNG / JPG 为 fallback。

`capture_no`：

- 每个 Query 内单调递增；
- 永不复用。

Storage path：

```text
{user_id}/{project_id}/{task_id}/{query_id}/{capture_id}.pdf
```

业务文件名：

```text
{核查对象}_{核查事项}_{核查网站}_Q{Query序号}_{留痕序号}_{日期}.pdf
```

UI 统一使用“留痕”。

---

## 4. 已完成里程碑

### M1 Project + Task ✅
### M2 Query ✅
### M3 Capture + Private Storage ✅
### M4 Chrome PDF Evidence ✅
### M5 Batch Task Generator + 生命周期删除 ✅
### M6 ZIP + Excel 最终导出 ✅
### M6.5 大项目 Task 可用性 ✅
### M8.1 半自动执行 ✅
### M8.2a 第一页结果 + 全详情自动留痕 ✅
### M8.2b 多页全量留痕 + 中断恢复 ✅
### M8.3 ZXGK 尽调报告线（解析 → 核对表 → 报告）+ 留痕加载有界并发 ✅

关键历史 checkpoint：

```text
b23e526 checkpoint: milestone 4 codex handoff
f29df9f fix: prepare milestone 4 for e2e validation
c92ab85 fix: add tabs permission for side panel url access
f519303 feat: complete milestone 5 task workflow
36731d8 feat: complete milestone 6 export and task usability
71c3eea feat: complete milestone 8.1 semi-automated execution check
6c74ed6 feat: complete milestone 8.2a first-page execution automation
0d91f72 docs: add nonlit workbench project context
55c6b20 refactor: validate zxgk automation recovery invariants
5592764 refactor: centralize automation progress view model
f595d95 test: cover archive bridge contract
bc933fc docs: record stabilization and zxgk pagination facts
bc26084 refactor: generalize zxgk automation page state
4f3ce3b feat: expose zxgk page navigation adapter primitives
e65c3c8 feat: add deterministic zxgk page advance protocol
cc6f438 feat: add zxgk two-page execution flow
901c48a feat: add durable zxgk resume recovery
de05324 feat: add generic zxgk multipage automation
9db6489 feat: add zxgk detail report extraction
44331cc feat: add zxgk docx report generation
1e39a6e feat: integrate zxgk docx report generation
116e93d perf: parallelize zxgk report capture loading
```

---

## 5. M4 留痕机制

Extension 使用：

- `chrome.debugger`
- CDP `Page.printToPDF`

Legal Web Check PDF Profile v1：

- A4
- 打印背景
- UTC+08 时间
- header 标题 / 时间
- footer URL / 页码

权限锁定：

```text
activeTab
debugger
sidePanel
storage
tabs
```

无 `<all_urls>`。

已有 M3/M4 Capture reservation / finalization / recovery 协议必须复用，不重新发明。

---

## 6. M5 / M6 关键约束

Task Generator：

```text
entity × topic × website
```

预设事项：

- 工商信息
- 执行
- 失信
- 诉讼
- 法院公告
- 商标
- 专利

曾讨论的 M5.5 completeness/anomaly 功能已明确拒绝，不要复活。

M6 ZIP：

```text
项目名_网核成果_YYYYMMDD.zip
```

包含：

```text
项目名_网核清单_YYYYMMDD.xlsx
底稿文件/
```

Excel 仅 5 列：

```text
序号
核查对象
核查事项
核查网站
底稿数量
```

仅包含至少有 1 个 Capture 的 Task。

文件夹层级：

```text
核查对象
  └─ 核查事项
      └─ Capture 文件
```

不要再加网站层或 Query 层目录。

---

## 7. M8.1 中国执行信息公开网适配器

第一适配器：

```text
zxgk_execution
```

仅支持：

```text
topic === "执行"
source_name === "中国执行信息公开网"
```

入口：

```text
https://zxgk.court.gov.cn/gkw/html/zhzxgk/index.html
```

“失信”与“限制消费”不属于该 adapter。

M8.1 流程：

```text
Task
→ 使用 entity_name 填检索词
→ 提交
→ WAITING_HUMAN_VERIFICATION
→ 用户人工完成滑块
→ 用户点击继续
→ 分类 NO_RESULT / HAS_RESULT / UNKNOWN
```

规则：

- CAPTCHA 只人工；
- NO_RESULT 可留痕并 DONE；
- M8.1 的 HAS_RESULT 暂不自动展开详情；
- UNKNOWN 必须暂停；
- Manual Query / Capture 仍可使用。

---

## 8. 中国执行信息公开网真实页面事实

结果页真实表头：

```text
序号
姓名
立案时间
案号
查看
```

真实分页示例：

```text
1/21页
首页 / 上一页 / 下一页 / 尾页
```

重要 DOM / 行为事实：

- 有效结果行含 `a.View`；
- filler 行不含 `a.View`；
- 当前页信号：`#currentPage` / `#currentPage-show`；
- 总页数信号：`#totalPage-show`；
- “查看”通过 `onclick="openZhcxDetail(...)"`；
- 详情页使用 `window.open("detail.html", "_blank")`；
- 详情在**新 Tab**打开；
- 列表 Tab 留在原位置；
- 详情数据经 `sessionStorage` 传递；
- URL 无案件参数；
- 详情“关闭”按钮执行 `window.close()`；
- 详情 PDF 可能跨多页。

---

## 9. M8.2a 正式范围

M8.2a 只处理第一页。

HAS_RESULT 后：

```text
Capture 第 1 页列表
→ 冻结第一页 result rows / rowKeys
→ 按显示顺序逐条打开详情
→ 校验详情案号
→ 全页 Page.printToPDF
→ 关闭详情 Tab
→ 返回并重新校验列表状态
→ 下一条
→ FIRST_PAGE_COMPLETE
→ 停止
```

即使页面显示：

```text
1/21页
```

也绝对不点击下一页。

M8.2a 不做分页。

预期：

```text
第一页 10 条结果
= 1 个列表 Capture
+ 10 个详情 Capture
= 11 个 Capture
```

`FIRST_PAGE_COMPLETE` 不等于 `DONE`。

UI 明确提示：

> 第 1 页已完整处理，后续分页暂未自动执行。

---

## 10. M8.2a 真人 E2E 已通过

2026-09-15 真人验证：

```text
第 1 页列表：1 / 1
详情：10 / 10
本页新增留痕：11
网站结果页：共 21 页
```

最终：

```text
FIRST_PAGE_COMPLETE
```

且未进入第 2 页。

同时已验证中断恢复：

- 仍复用同一个 canonical Query；
- 列表不会重复留痕；
- 已完成详情不会重复留痕；
- 从第一个未完成详情继续；
- 最终仍为 11 个 Capture。

因此 M8.2a 已正式完成。

正式 checkpoint：

```text
6c74ed6 feat: complete milestone 8.2a first-page execution automation
```

---

## 11. rowKey 与详情验证

M8.2a rowKey：

```text
normalize(name)|normalize(caseNo)|normalize(filingDate)
```

normalize：

- NFKC
- whitespace normalization

规则：

- 第一页进入详情前先冻结完整 rowKey 集合；
- duplicate rowKey 必须 fail closed；
- 不依赖 row index；
- 详情至少校验 caseNo；
- 有条件时再校验 name；
- 返回列表后再次验证 rowKey / 页面状态。

---

## 12. M8.2a 运行状态

新增状态：

```text
CAPTURING_LIST_PAGE
READING_RESULT_ROWS
OPENING_DETAIL
CAPTURING_DETAIL
RETURNING_TO_LIST
VERIFYING_LIST_STATE
FIRST_PAGE_COMPLETE
```

runtime job 主要字段：

```text
queryId / query
listCapture / listFilename
resultPage
expectedDetailCount
pageOneRowKeys
completedDetailKeys
detailCaptures[]
currentOperation
firstPageComplete
error
```

`currentOperation` 语义：

```text
type: LIST | DETAIL
pageNo
rowKey
caseNo
phase
detailTabId optional
captureId optional
```

phase：

```text
LOCATING
OPENING
CAPTURING
RETURNING
VERIFYING
```

---

## 13. Resume 语义

“继续本次核查”：

- 恢复同一个 unfinished job；
- 使用同一个 Query；
- 已完成 rowKey 不重复；
- 从第一个未完成项继续。

如果原 automation tab 仍存在：

- 复用。

如果原 tab 已关闭：

- 创建新的中国执行信息公开网 tab；
- 更新 `job.tabId`；
- 不劫持用户当前普通 tab。

当前继续沿用字段名：

```text
job.tabId
```

不要仅为了命名好看而改名。

---

## 14. LIST / DETAIL Capture 恢复

为减少恢复时重复 Capture：

### DETAIL

archive 成功后：

1. 立即把 `currentOperation.captureId` 持久化；
2. 再关闭详情页 / reconcile；
3. 恢复时如果 `captureId` 已存在，则不重复 capture；
4. 只补做 reconcile / mark completed。

### LIST

同样：

- archive 成功后立即持久化 captureId；
- `settlePendingListCapture` 可恢复 `listCapture/listFilename`；
- `hasListCapture(job)` 用于判断列表是否已经成功留痕。

---

## 15. 已知 residual idempotency 技术债

仍存在一个极窄 crash window：

```text
archiveQuery 数据库 finalize 成功
→ 进程在下一次 saveState(captureId) 前死亡
```

此时恢复仍可能产生重复 Capture。

彻底解决需要：

- stable request_id / p_capture_id；
- 将 M4 reservation / finalization 做跨进程 exactly-once / idempotency hardening。

当前不要为了 M8.2a 继续扩展。

建议记为：

```text
TD-001 Capture archive cross-process exactly-once / idempotency
```

---

## 16. Query 被删除事件与 fail-closed

一次真人 E2E 中出现：

```text
automationJob 仍引用 Q03
但 Query / Capture / Storage 均不存在
```

只读诊断确认：

- `data.query(Q03)` → HTTP 200 + []
- `listTaskQueries(Task)` → []
- `queryContext(Q03)` → QUERY_NOT_ACCESSIBLE
- Capture 001 record 已不存在
- Storage 对象也已不存在
- Project / Task 仍存在

后续确认：该 Query 是用户手工删除。

因此 resume validator 的 fail-closed 行为是正确的：

> Query 被删除后，不允许自动核查继续产生新的 Capture。

不得为了“继续跑”而绕过该校验。

---

## 17. 正在运行的 Query 删除边界

当前 Web Workbench 不知道 Extension local storage 中的 `automationJob`。

因此现在仍允许用户在自动核查未结束时：

- 删除 automationJob.queryId；
- 删除其 Task；
- 删除其 Project；
- 批量删除其 Task。

删除后 Extension 不会自动 clear / abort automationJob。

当前结果：

```text
DB Query/Capture/Storage 已删除
+
automationJob 仍保留旧 queryId
+
resume validator fail closed
```

这不会破坏数据完整性，但 UX 不理想。

后续候选方案：

A. 自动核查运行期间禁止删除 Query；
B. 用户确认删除时同步明确 abort automationJob。

当前倾向：

> A：运行中的 Query 暂时禁止删除。

但不要在 M8.2a 继续实现。

---

## 18. 层级删除非原子性

当前：

```text
removeQueryTree()
removeTaskTree()
removeProjectTree()
```

不是跨 Storage + PostgreSQL 的统一事务。

例如：

```text
removeTaskTree()
→ 先逐个删除 Query
→ 最后删除 Task
```

若最终 Task 删除失败，可能出现：

```text
Task 仍在
但 Query / Capture / Storage 已删
```

这是当前已知一致性窗口。

不属于 M8.2a 当前修复范围。

---

## 19. 当前源码职责期望

Architecture Stabilization 时以此作为检查标准：

### adapter

负责网站事实：

- DOM selector
- 页面结构
- 结果行识别
- 翻页事实
- 详情入口事实
- 站点特有动作

### zxgk-automation

负责业务编排：

- start
- resume
- 状态推进
- LIST → DETAILS
- rowKey 流程
- fail closed
- FIRST_PAGE_COMPLETE

### automation-state

只负责：

- 状态常量
- 状态合法性 / 序列化结构相关逻辑

### worker

负责 Chrome primitives：

- tab
- debugger
- evaluate
- PDF
- archive bridge

不要让 worker 持有案件级业务判断。

### sidepanel

只负责：

- 展示
- 用户命令
- 状态同步

不要成为第二套业务状态机。

### data / Supabase

只负责：

- Query / Capture / Task 数据读写
- session / auth
- persistence

### query-identity

只负责：

- query text normalize
- canonical Query 选择

---

## 20. Architecture Stabilization after M8.2a

M8.2a 完成后的 Architecture Stabilization Step 1～3 已完成。原则始终是：

> 只减复杂度，不加产品功能。

### Step 1：Runtime Job Invariant Validation ✅

Commit：

```text
55c6b20 refactor: validate zxgk automation recovery invariants
```

目标是集中校验 persisted `automationJob` 的 runtime invariant。主要结果：

- 在恢复已有 job 前执行 invariant validation；
- 明显矛盾的 snapshot fail closed；
- 不自动修复 snapshot，也不猜测缺失状态；
- 不改变 persisted job shape；
- 不改变 Query / Capture 语义；
- 合法的 crash/recovery window 继续允许。

必须允许的合法 recovery window：

```text
DETAIL：
archive 成功
→ currentOperation.captureId 已保存
→ completedDetailKeys 尚未更新

LIST：
archive 成功
→ LIST currentOperation.captureId 已保存
→ listCapture 尚未 settle
```

Invariant validator 不得错误拦截以上状态。

### Step 2：Side Panel Automation Progress View Model ✅

Commit：

```text
5592764 refactor: centralize automation progress view model
```

新增：

```text
extension/src/lib/automation-progress-view.mjs
```

核心纯函数：

```text
deriveZxgkAutomationProgressViewModel(job)
```

职责是从 `automationJob` 纯派生 Side Panel 展示所需进度，包括：

- `completedDetailCount`
- `expectedDetailCount`
- `listCaptureComplete`
- `generatedCaptureCount`
- `nextIncompleteCaseNo`
- `pendingOperationCaseNo`
- `waitingForHumanVerification`
- `canContinue`
- `canResume`
- `firstPageProcessing`
- `firstPageComplete`
- `totalPages`
- `errorShownInCard`

Side Panel 不再自行：

- 解析 rowKey；
- 查找下一未完成案件；
- 理解 LIST `captureId` recovery window；
- 计算自动化进度事实。

按钮事件、runtime message 和 state machine 均未改变。

真人 UI smoke test 已通过：

```text
第 1 页已完整处理
结果列表 1/1
详情 10/10
本页新增留痕 11
网站结果页共 21 页
后续分页暂未自动执行
```

### Step 3：Archive Bridge Contract Test ✅

Commit：

```text
f595d95 test: cover archive bridge contract
```

新增：

```text
extension/src/lib/archive-bridge.mjs
extension/tests/archive-bridge.test.mjs
```

目的：补上真实 archive bridge 的测试盲点。真实契约为：

```text
automation queryId
→ worker archive
→ Archive Bridge
→ data.queryContext(queryId)
→ Query / Task / Project context
→ Capture API
→ Capture record
→ capture.id 返回 automation
```

Archive Bridge 不复制 M4 reservation/finalization/recovery 协议。验证结果：

- `queryId` 真实进入 `data.queryContext`；
- 错误 `queryId` 不再被万能 mock 掩盖；
- `QUERY_NOT_ACCESSIBLE` 时 fail closed，不进入 Capture upload；
- reservation/finalization 错误不被吞掉；
- recovery 信息保持原样；
- 成功时返回真实 `capture.id`。

自动检查：

```text
Contract tests：6/6
Extension tests：97/97
typecheck：通过
format check：通过
git diff --check：通过
```

未运行会触发危险 build cleanup 的 Extension build；完整 Extension 测试直接使用：

```text
node --test extension/tests/*.test.mjs
```

真人归档 smoke test 已通过：

- NO_RESULT 自动核查成功；
- 生成 1 份 Capture；
- Query 归属正确；
- 文件名正确；
- `capture_no` 正常继续递增；
- 手工 Query 与自动 Query 语义仍然分离。

### Stabilization 总结

Architecture Stabilization Step 1～3 已完成。本轮没有实现或修改：

- M8.2b 分页；
- 第二网站；
- Run 表；
- worker driver 抽象；
- generic plugin framework；
- XState / Redux；
- M4 exactly-once 重构；
- Capture schema；
- Query 语义；
- canonical Query 规则。

---

## 21. 暂缓事项

当前不要处理：

- 第二网站 adapter；
- AI Query suggestion；
- AI 页面判断；
- Run 数据表；
- Capture 新字段；
- M4 exactly-once 全量重构；
- 运行中 Query 删除 guard；
- 层级删除全局事务化；
- `.dist-previous` build cleanup；
- 大规模框架式重构。

「M8.2b 分页 / 第 2 页及之后」已于 2026-09-16 ~ 09-17 完成（见 §27 与 `MILESTONE_8_2B.md`），**不再是暂缓事项**；M8.2a 的完整真人回归也已在 2026-09-15 通过（见 §10）。

已知技术债继续保留，本轮均未处理：

```text
TD-001 archive finalize → saveState(captureId) 极窄 exactly-once 窗口
TD-002 automation 使用中的 Query 仍可被 Workbench 删除
TD-003 层级删除跨 Storage / PostgreSQL 非事务性
TD-004 .dist-previous build cleanup safety blocker
```

---

## 22. `.dist-previous` / build 已知问题

此前 Extension build 在尝试删除：

```text
extension/.dist-previous
```

时遇到 safety blocker。

当前约定：

- 不删除 `.dist-previous`；
- 不改 build script；
- 不运行会触发不安全删除 prompt 的命令；
- 必要时按既有安全流程手动同步 src → dist 并验证字节一致。

后续单独作为 tooling cleanup 处理。

---

## 23. M8.2a 提交前的 Git 状态（历史）

M8.2a commit 前已完成：

- 排除 `next-env.d.ts` 自动 dev 路径改动；
- 排除 dist 纯 CRLF 噪声：
  - `extension/dist/config.mjs`
  - `extension/dist/lib/names.mjs`
  - `extension/dist/lib/print.mjs`
  - `extension/dist/print-config.mjs`
  - `extension/dist/viewer.html`
  - `extension/dist/viewer.mjs`
- 这 6 个 `dist` 文件的 CRLF 噪声**可复现**：执行 `npm run extension:test` 之后它们会重新变成 modified，而 `git diff --numstat` 对它们全部为**空**（零内容改动，仅行尾差异；`core.autocrlf = true`）。提交前逐个 `git checkout --` 还原即可，不要把它们带进提交。
- 删除终端误粘贴产生的未跟踪垃圾文件；
- 确认：
  - `extension/manifest.json` 未改；
  - `extension/package.json` 未改；
  - `supabase` 未改；
- staged 范围只包含 M8.2a 必要文件；
- `git diff --cached --check` 通过。

M8.2a 与 Architecture Stabilization 最新 checkpoint 序列：

```text
f595d95 test: cover archive bridge contract
5592764 refactor: centralize automation progress view model
55c6b20 refactor: validate zxgk automation recovery invariants
0d91f72 docs: add nonlit workbench project context
6c74ed6 feat: complete milestone 8.2a first-page execution automation
```

---

## 24. 下一步

```text
产品下一阶段待重新选择 / Prioritization pending
```

- M8.2b 分页（见 §27）与 M8.3 报告线（见 §28）均**已完成并交付**，不再是「下一步」。
- 本节**不指定**下一个里程碑，也不自行选择 Stage 6 方向；由产品侧重新裁决后再更新本文件。
- 历史演进仅作留痕（均已发生）：Architecture Stabilization → M8.2a 完整真人回归 → stabilization checkpoint → M8.2b 分页 → M8.3 报告线。

---

## 25. 产品开发风格

用户非技术背景，沟通方式：

- 中文；
- 具体；
- 尽量一步一步；
- 给可直接复制到 Codex / WorkBuddy 的指令；
- 避免一次加很多需求；
- 大 milestone 完成后要做 checkpoint；
- 明确哪些是现在必须做、哪些只是技术债；
- 不把“架构优雅”当成目标，优先保持可理解、可维护、可验证。

长期开发原则：

> 功能完成后先稳定，再继续扩展。

---

## 26. M8.2b Slice 0 — ZXGK Pagination Facts

记录日期：2026-09-16。

本节只记录**事实**，分两类，**不混写**：

- **A. 源码级 CONFIRMED** —— 只读抓取真实 HTML / JS 得出；
- **B. 真人 Chrome CONFIRMED** —— 真人操作确认。

本节**不实现任何代码**——本节记录时（2026-09-16）M8.2b 实现尚未开始；§21 暂缓事项中关于「M8.2b 分页 / 第 2 页及之后」的约束，当时对**实现**部分继续有效。

> 后续进展：M8.2b 实现已于 2026-09-16 ~ 09-17 完成，见 §27 与 `MILESTONE_8_2B.md`。本节锁定的网站事实与设计基线继续有效，未被弱化。

### 26.1 事实来源与限制

入口 `https://zxgk.court.gov.cn/zhzxgk/index.html`；`API_BASE = location.origin + '/gkw/zhcx'`；列表接口 `POST API_BASE + '/searchZhcx'`；详情接口 `POST API_BASE + '/detailZhcx'`。

只读探测产物在 `C:\Users\黄舒心\zxgk-probe\`（**不在项目目录、未入库**）。

> 无浏览器会话的直接 POST 探测受到 WAF 限制（cURL 直连返回 502）。真实运行验证应在 Chrome 会话中完成。

因此：**分页契约**已从客户端 JS 完整读出；**运行时行为**以真人 Chrome 为准。

### 26.2 A. 源码级 CONFIRMED

#### A1. 分页 DOM selector

分页控件位于 `#page-div`。稳定 selector：

```text
#first-btn
#pre-btn
#next-btn
#last-btn
#goto
#currentPage          （<input type="hidden" name="currentPage">）
#currentPage-show
#totalPage-show
#totalSize-show       （class="hide"，隐藏但 DOM 可读）
```

「下一页」= `#next-btn` + `onclick="nextPage()"`。

#### A2. 分页实现

`firstPage` / `prePage` / `nextPage` / `lastPage` / `goPage` 本质都是：**修改 `#currentPage` → 调用 `search()`**。

注意 `nextPage()` 的输入是 `#currentPage`（**上次服务端回传值**）**加 1**，而不是从 `#currentPage-show` 读当前页。若该值陈旧或被意外改写，会跳错页。

#### A3. AJAX fact

`search()` → `serialize #zhcx-search-form` → `POST /gkw/zhcx/searchZhcx` → JSON；**无 URL navigation / full page navigation**，列表 Tab 从不被导航。即分页是**纯 AJAX POST**，不是 form submit。

#### A4. direct jump fact

**可靠 direct jump 能力存在。** 推荐未来 adapter primitive：

```text
1. 先校验：1 <= targetPage <= baselineTotalPages
2. 设置 #currentPage = targetPage
3. 调 search()
4. 读取真实页面信号验证目标页
```

**尚未实现。**

`goPage()` 存在**夹取逻辑**（输入 ≥ 总页数会被改成末页，静默改变目标页），因此实现**不依赖 `goPage()`**。绕开后失去网站自带越界保护 → **越界校验必须由 adapter / automation 自己承担**。

#### A5. page update fact

服务器响应 `success` callback 中**同步**更新：`currentPage-show` / `totalSize-show` / `totalPage-show` / `tbody`。

真实结果行判据：**`#tbody-result a.View`**；**不足 10 条的 filler row 没有 `a.View`**。页内序号 `i + 1` 跨页必然重复，**不能作为身份**。

#### A6. totalPages

`#totalPage-show = Math.ceil(server totalSize / 10)`。页大小恒为 10，无 `pageSize` 参数；**每次 search / pagination 后都按服务端本次响应重新计算 totalPages**。

#### A7. last page fact

最后一页时 `#next-btn` **仍存在、仍可见，但 `disabled = true`**（`#last-btn` 同）。

> `next disabled ≠ DONE`。

DONE 仍必须依赖：所有页 `PAGE_COMPLETE` + `completedPages` 连续覆盖 + totalPages baseline 未变化 + no pending operation + last page completeness verified。

#### A8. CAPTCHA facts

每次 `search()` 都检查 verification token：**有效 → 正常 AJAX**；**失效 → 可能重新要求人工验证，且存在明确验证码失败 DOM**。

禁止：`hardcode token TTL`；把验证码失败当作空结果页。

#### A9. result-state facts

`#pName` 结果态仍存在、可读；`#page-div` 有结果时可见，无结果或验证失败时可能隐藏。补充判据（可选）：无结果 / 验证失败时 `tbody` 会出现对应提示文案。

#### A10. identity fact

服务端 `result[i].id` 存在（写在 `a.View` 的 `id` 上），但 **不因发现 server id 而修改已锁定的 rowKey**：

```text
normalize(name) | normalize(caseNo) | normalize(filingDate)
```

### 26.3 B. 真人 Chrome CONFIRMED

对象：中国执行信息公开网 · 恒大集团有限公司 · 真实结果页。

#### B1. F-1 — Page 1 → Page 2 ✅

```text
before:                1 | 1 / 21 | rows = 10
after one manual next: 2 | 2 / 21 | rows = 10
```

结论：**hidden currentPage / shown currentPage / rows 能够一致到达 Page 2。F-1 PASS。**

#### B2. F-4 — last page ✅

```text
Page 21 / 21
currentPage hidden = 21
currentPage-show   = 21
totalPages         = 21
real rows          = 10
next exists        = true
next visible       = true
next disabled      = true
```

**F-4 PASS。**

重要：**末页可能有 1..10 个真实 rows**（本次第 21 页就是 10 条）。`PAGE_COMPLETE` 必须以真实 frozen row set 为准，**不得假设末页不足 10 条**。

### 26.4 C. 本阶段不再做额外实验

不做 token 过期时长实验，不做 `goPage()` 非法输入实验，不做翻页 WAF 频率实验。理由：correctness 不依赖 token TTL；M8.2b 自己严格校验 page range；频率问题留待后续真人 multi-page E2E 自然观察。

### 26.5 D. fresh resume 到 Page N（锁定）

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

### 26.6 E. page advance verification（锁定）

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

禁止：固定 sleep 后假设成功；minWait 后提前猜失败。

### 26.7 设计基线（人工锁定，不得弱化）

1. **totalPages 任何变化都 PAUSED。** baseline 建立后：`observed === baseline → continue`；`observed !== baseline → PAUSED`。增加 / 减少 / null **全部暂停**。**不采用 B+。**
2. **`currentPage` / `completedPages` invariant 必须 state-sensitive。** 页内处理中 `currentPage` 不在 `completedPages`；`ADVANCING_PAGE` 时已在；`DONE` 时 `currentPage === totalPages` 且 `completedPages` 连续覆盖 `1..totalPages`。
3. **same-environment pending `PAGE_ADVANCE` settle 与 fresh resume 必须分开。** 原环境仍在 → 可读真实 shown / input settle；真正 resume → 不得据旧 click 猜，必须重建查询环境后重新验证。
4. **legacy Page 1 继续分页前先 reconcile。** 重查 Page 1 → 校验 totalPages → reconcile Page 1 frozen set → 才进入 Page 2。**不重新 Capture Page 1。**
5. **`firstPageComplete` 可保留但新逻辑不依赖。** 可作 legacy marker 保留，DONE correctness 不依赖它，不主动删除。
6. **historical pages 只存 summary。** 历史页只存 `completedPages` summary；当前页保存 `currentPageRows` + `pageFrozenKeys`。

### 26.8 Slice 0 Exit Condition

```text
M8.2b Slice 0 ✅ COMPLETE
源码探测完成。
真人 F-1 ✅
真人 F-4 ✅
不存在阻塞 M8.2b 的网站事实。
```

当时下一步：**Slice 1 — Runtime Page Model + Invariant**（本节记录时未开始）。

> 后续进展：Slice 1 及之后的实现已于 2026-09-16 ~ 09-17 完成，见 §27 与 `MILESTONE_8_2B.md`。本节锁定的网站事实与设计基线，对实现部分继续有效且未被弱化。

---

## 27. M8.2b 实现记录（Slice 1 起）

完成日期：2026-09-16 ~ 2026-09-17。交付说明见 `MILESTONE_8_2B.md`。

提交序列：`bc26084` → `4f3ce3b` → `e65c3c8` → `cc6f438` → `901c48a` → `de05324`（另有 Slice 0 事实记录提交 `bc933fc`，只改本文件，不属实现改动）。

Slice / commit 对应关系——只标注**有明文出处**的编号，其余阶段不另行编号：

| 提交      | 能力                                                 | 编号出处                                           |
| --------- | ---------------------------------------------------- | -------------------------------------------------- |
| `bc933fc` | 事实记录（仅改 `NONLIT_WORKBENCH_CONTEXT.md`）       | §26「M8.2b Slice 0」                               |
| `bc26084` | page-state generalization（页面状态模型泛化）        | §26.8「Slice 1 — Runtime Page Model + Invariant」   |
| `4f3ce3b` | navigation adapter primitives                        | `extension/src/adapters/zxgk-execution.mjs`         |
| `e65c3c8` | deterministic advance（确定性页推进协议）            | `extension/tests/zxgk-page-advance.test.mjs`        |
| `cc6f438` | two-page flow（两页执行流）                          | `extension/tests/zxgk-two-page-run.test.mjs`        |
| `901c48a` | durable resume（中断恢复）                           | `extension/tests/zxgk-multipage-resume.test.mjs`    |
| `de05324` | generic multipage automation（通用多页）             | `automation-state.mjs` 状态注释「Slice 5 重新定义」 |

**本线最终 checkpoint：`de05324`**（分页线最后一个提交；其后的 `9db6489` 起进入 M8.3 报告线）。

在 §26 的事实与设计基线之上实现的内容：

- **页面状态模型**：新增 `ADVANCING_PAGE`、`PARTIAL_COMPLETE`；多页成功终态统一为 `DONE`；`FIRST_PAGE_COMPLETE` 退为 M8.2a 的 legacy 终止态（读取兼容，新产品路径不再产生）。`PARTIAL_COMPLETE` 是「已有连续完整前缀 `1..K`、但网站仍有剩余页」的**稳定 checkpoint**——不是错误、不是运行中，后台重启时不会被改写成 `FAILED`；Slice 5 起新核查不再产生它。
- **导航 primitives**：`jumpToPageExpression(targetPage)` 负责跳页；`validatePage` / `validateFirstPage` / `freezePageRows` / `locateRowKey` / `reconcileRowKeys` / `reconcileFrozenSet` 负责落页判定与冻结集合比对。
- **页推进协议**：先校验页范围 → 设 `#currentPage` → `search()` → 以真实页面信号验证；wrong page 一律 fail closed；**不依赖 `goPage()`**，越界校验自担。
- **两页执行流**：`cc6f438` 起一次运行覆盖前两页。
- **durable resume**：`901c48a` 把 same-environment pending `PAGE_ADVANCE` settle 与 fresh resume 分开；fresh resume 走「重建查询 → CAPTCHA → Page 1 → baseline totalPages → direct jump Page N → 页面信号验证 → frozen-set reconciliation → continue」，**不逐页 next**；legacy Page 1 继续分页前先 reconcile 且不重新 Capture。
- **通用多页**：`de05324` 把「两页」泛化为 N 页，连续推进到末页直到 `DONE`（`totalPages = 1` 亦同）。

范围与边界：改动集中在 `extension/src`（及随仓库入库的 `extension/dist`）；Workbench 侧与数据库侧 **0 改动**，0 migration / 0 schema / 0 RLS，Capture 仍六字段，`automationJob` 仍只在 `chrome.storage.local`。

测试：`extension:test` 由 M8.2a 的 79 / 79 增至 **219 / 219**。

真人多页端到端验收的结论与证据：**待补入档**（用户保留，本文件暂不记录）。

---

## 28. M8.3 ZXGK 尽调报告线

完成日期：2026-09-18 ~ 2026-09-19。交付说明见 `MILESTONE_8_3.md`。

提交序列：

```text
9db6489 feat: add zxgk detail report extraction        解析器 + CLI + 15 测试
44331cc feat: add zxgk docx report generation          docx 报告生成
1e39a6e feat: integrate zxgk docx report generation     接入产品入口
116e93d perf: parallelize zxgk report capture loading   留痕加载有界并发
```

- **解析层**唯一事实来源 = `scripts/zxgk-execution-parse.ts`；主表列 `MAIN_TABLE_COLUMNS` 共 **20 列**（元信息 4 + 通用 6 + 执行标的 + 终本 2 + 失信 6 + 长文本 1）。
- **报告口径**（人工 LOCK，2026-09-17 二次修正）见 `MILESTONE_8_3.md`：一条网站原始记录 = 一行、除列表页外所有 detail 入同一主表、多板块不拆不合并、空值语义四分、只在核查完成后出报告。
- **产品入口** `GET /api/projects/[projectId]/report` 当前**只生成 docx**；Excel 执行记录核对表仍由开发 CLI（`scripts/build-execution-table.ts`）生成。
- **并发加固**：`REPORT_CAPTURE_CONCURRENCY = 3` + `mapWithConcurrency`，只作用于 capture load + readPages，DB metadata 仍串行；基线画像 198s 中约 96.3% 花在 Storage 下载，瓶颈是到 Supabase 东京区的跨境链路，不是解析。

**Stage 5 性能事实（生产构建 + 真实浏览器 E2E，2026-09-19）**：

| 指标                             | 串行基线                                 | bounded concurrency = 3 |
| -------------------------------- | ---------------------------------------- | ----------------------- |
| production E2E 端到端 wall       | ≈ 35.4s                                  | **≈ 10.17s**（省 ≈71.3%） |
| Storage 最大 in-flight          | 1                                        | 3                       |
| Supabase 请求成功率              | —                                        | **36 / 36 全部 200**，零 retry / 4xx / 5xx |
| `word/document.xml` md5          | `ea7bb19d66108dde3c6539f422315700`       | **保持同值**（与串行逐字等价） |
| 内容正确性                       | —                                        | 28 records / 3 excluded / problems = 0 |

- **归因纪律（必须保留）**：同轮 `Σ(total) / wall ≈ 2.61×` 才是**同一轮内可直接观察的并发压缩证据**；`35.4s → 10.17s ≈ 3.48×` 是**跨轮**比较，两轮网络窗口不同，**不能全部归因于代码改动**。
- **已废弃的旧推断**：「payload transfer ≈158s / ≈39KB/s」是**推断值而非实测**，已被上述生产 E2E 结果取代，**不得再作为当前结论引用**（`MILESTONE_8_3.md` 已同步标注 superseded）。
- **编号说明**：既有材料混用 `Step` 与 `Stage`（两份 2026-09-19 review 用的是 `Stage 4` / `Stage 5`，其中 Stage 4 是产品入口接入后的一次浏览器 E2E）。本文件与 `MILESTONE_8_3.md` 均以提交为锚，不另立编号。

测试：`test:db` 181 / 181。

2026-09-19 的两份 review 位于 `nonlit-workbench-output/20260919/`：`Stage5_Report_Runtime_Hardening_Design_Review.md`（性能画像、方案比较、风险）与 `Stage5_Report_Concurrency_Code_Review.md`（实现核验、门禁记录）。
