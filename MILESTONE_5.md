# Milestone 5 交付说明

## 实现范围

Project 工作台新增“批量生成任务”入口和空状态入口，进入 `/projects/[projectId]/tasks/generate`。生成器只创建 Task，不创建 Query、Capture，也不执行网页访问或自动留痕。

流程固定为三步：

1. 核查对象：按行解析，去除首尾空格和空行，对完全相同名称去重，并保持首次出现顺序。
2. 核查范围：选择应用配置中的“核查事项 × 核查网站”组合，或添加仅本次使用的临时网站。页面实时显示对象数、范围数和候选 Task 数。系统不会读取历史 Task 来自动填充 URL。
3. 预览并创建：在内存中展开候选任务，与当前 Project 已有 Task 比较；已有项灰显且跳过，待创建项可删除及修正 URL。提交前重新读取已有 Task，再进行一次去重检查。

创建成功后返回 Project 工作台，并显示本次创建数和跳过数。所有新 Task 的状态均为 `not_started`。

## 去重规则

应用层使用以下五项的精确值作为标识：

```text
project_id + entity_name + topic + source_name + source_url
```

同批候选内部和 Project 已有 Task 都按该规则去重。不同 Project 的相同组合不会互相影响。M5 有意不增加数据库唯一约束，因此两个并发会话在同一瞬间提交完全相同的组合时，数据库本身不会阻止重复；正常重复运行会在预览和提交前检查中跳过已有 Task。

## 核查范围配置与 URL

预设位于 `src/config/task-generator.ts`，没有新增数据库模板表。应用层已经明确配置工商信息、执行、失信、限制消费、诉讼、法院公告、商标和专利入口；这些 URL 会直接显示且允许本次编辑。破产、行政处罚 / 信用、证券监管和新闻舆情暂时保持为空，选中后必须由用户填写有效的 HTTP(S) URL。历史 Task 的 URL 不参与自动填充。临时核查网站只保存在当前页面内存中。

## 数据库与权限

M5 没有 migration，没有修改 Project、Task、Query、Capture Schema，也没有修改 RLS。浏览器继续使用登录用户 JWT 和 Supabase Publishable Key；Project 与 Task 查询、批量插入均受现有 Owner RLS 限制。

## Project / Task 永久删除

Task Drawer 底部提供危险操作，确认框展示真实 Query 和留痕数量。Project 工作台提供项目操作菜单，确认框展示完整后代数量并要求输入完整项目名称。两者都通过携带当前用户 JWT 的服务端 API 执行，继续受现有 RLS 约束。

父级删除复用 M3 的留痕协调协议：先处理未完成的 Capture operation，再逐个备份并删除 Private Storage 对象，最后完成 Capture record 删除；所有 Capture 清理完成后才删除 Query、Task 和 Project。中途失败不会报告成功，也不会提前删除父级；已经完成的子项保持删除状态，重试会从剩余数据继续。

Task 表保留序号，并提供逐行 checkbox 和当前筛选结果全选。选中后可批量永久删除；服务端依次调用同一个 Task 层级删除服务，返回成功与失败 ID。前端只移除成功项，失败项保持选中供用户重试，未选择和筛选外 Task 不受影响。

## 验证

```powershell
npm run typecheck
npm run test:db
npm run format:check
npm run build
npm run extension:test
```

`tests/task-generator.test.ts` 覆盖主体解析、范围选择、候选计算、批内与已有数据去重、候选删除、共享 Task 数据访问层批量写入、固定初始状态、无 Query/Capture 副作用、重复运行、跨 Project 识别及真实 PostgreSQL RLS 隔离。

`tests/hierarchy-deletion.test.ts` 覆盖空 Task、含 Query/Capture 的 Task、同项目其他 Task 隔离、空 Project、完整 Project 文件清理、失败重试、重复请求和 Owner 隔离；原有 Capture workflow 测试继续验证文件删除失败与数据库失败时的恢复行为。
