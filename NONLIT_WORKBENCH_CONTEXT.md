# NONLIT_WORKBENCH_CONTEXT.md

> 项目：非诉网核工作台（Nonlit Workbench）  
> 用途：跨对话 / 跨 Agent 的长期项目上下文与决策记录  
> 最近更新：2026-09-15  
> 当前正式 checkpoint：`6c74ed6 feat: complete milestone 8.2a first-page execution automation`

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

## 20. Architecture Stabilization 目标

M8.2a 之后，先不开发新功能。

做一次只读架构体检，再决定是否做小范围重构。

重点检查：

- 职责是否开始混在一起；
- resume 逻辑是否散落；
- sidepanel 是否拥有过多业务逻辑；
- worker 是否开始知道太多 zxgk 业务；
- adapter 是否仍只负责站点事实；
- 状态是否由大量 scattered booleans 驱动；
- Query / runtime run 是否混淆；
- 第二个网站接入时是否需要修改太多公共文件；
- 测试是否在 mock 中掩盖真实 worker/data 边界；
- 哪些结构债现在值得收口，哪些只是“看起来不优雅”但不值得动。

原则：

> 只减复杂度，不加产品功能。

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

先完成 Architecture Stabilization，再决定进入 M8.2b。

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

最终 commit：

```text
6c74ed6 feat: complete milestone 8.2a first-page execution automation
```

---

## 24. 下一步

下一阶段：

```text
M8.2a Architecture Stabilization
```

执行顺序：

1. Codex 只读架构审计；
2. 输出职责边界、重复逻辑、耦合、扩展爆炸点；
3. 给出“必须现在修 / 可延后 / 不要动”的分级；
4. 用户确认后，才做最小范围重构；
5. 重构完成并真人回归；
6. 新 checkpoint；
7. 再进入 M8.2b。

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
