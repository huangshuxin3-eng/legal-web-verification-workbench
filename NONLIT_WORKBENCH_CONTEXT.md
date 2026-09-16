# NONLIT_WORKBENCH_CONTEXT.md

> 项目：非诉网核工作台（Nonlit Workbench）  
> 用途：跨对话 / 跨 Agent 的长期项目上下文与决策记录  
> 最近更新：2026-09-15  
> 当前正式 checkpoint：`f595d95 test: cover archive bridge contract`

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

- M8.2b 分页；
- 第 2 页及之后；
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

先完成完整 M8.2a 真人回归并建立 stabilization checkpoint，再设计 M8.2b。

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

## 23. 最近 Git 状态

M8.2a commit 前已完成：

- 排除 `next-env.d.ts` 自动 dev 路径改动；
- 排除 dist 纯 CRLF 噪声：
  - `extension/dist/config.mjs`
  - `extension/dist/lib/names.mjs`
  - `extension/dist/lib/print.mjs`
  - `extension/dist/print-config.mjs`
  - `extension/dist/viewer.html`
  - `extension/dist/viewer.mjs`
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

执行顺序：

```text
Architecture Stabilization 完成
→ 完整 M8.2a 真人回归
→ 建立 stabilization checkpoint
→ 再设计 M8.2b 分页
```

不要直接开始分页。

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

本节**不实现任何代码**。M8.2b 实现仍未开始；§21 暂缓事项中关于「M8.2b 分页 / 第 2 页及之后」的约束，对**实现**部分继续有效。

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

下一步：**Slice 1 — Runtime Page Model + Invariant**（本轮未开始）。
