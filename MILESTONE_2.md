# Milestone 2：Task → Query

## 范围与实现

- 沿用 queries 表及四层外键关系，没有新增业务表。
- Task Drawer 内增加查询记录区域，显示 Q01、查询内容、创建时间；支持轻量表单新增/编辑、两步确认删除。
- 工作台新增 Query 数量列，读取 Supabase `queries(count)` 的真实计数，不使用编号上限当数量。
- 写入成功后立即更新 Drawer，再读取父 Task 的状态和计数回填工作台。刷新失败会明确提示“已保存”，不会把刷新失败误报为保存失败。
- 不增加独立 Query 页面、结果状态、风险判断、Capture UI、Storage、插件、导入导出或 AI。

## 升级与运行

1. 在现有 Supabase 项目的 SQL Editor 执行 `supabase/migrations/202609140002_milestone_2.sql`。这是一份事务性增量迁移，不重建已有表，不删除已有业务数据；不要重跑 M1。
2. 沿用 `.env.local` 中的两个变量，无新增密钥、环境变量或运行时依赖。
3. `npm ci` 后执行 `npm run dev`。生产方式：`npm run build`，再 `npm start`。重启已有服务以加载新代码。
4. 新数据库先执行 M1 再执行 M2。

## 编号与事务设计

在 Task 增加 `last_query_no integer not null default 0` 作为持久化编号上限。迁移时用该 Task 已有 Query 的最大编号初始化。它只用于分配号码，不是 Query 数量。

插入 Query 的 BEFORE INSERT 触发器在同一条 UPDATE 中更新父 Task 的编号上限，自动获得该 Task 的行锁，将返回的编号写入新 Query。同 Task 的并发创建会等待前一个事务完成，因此不会竞争同一个编号；不同 Task 分别计数。原有 `(task_id, query_no)` 唯一约束保留作第二层保护。事务失败时 Query、计数及状态一起回滚；失败事务中从未提交的号码不算“已使用”。

删除 Query 不修改上限，因此删 Q02、删最高号、删除全部记录都不会复用已提交编号。Query 的 id、task_id、query_no、created_at 不允许修改；编辑只改查询内容。显示编号至少两位，Q100 等不会截断。

首次创建（历史计数为 0）时，若 Task 是 not_started，则改为 in_progress；其他三种状态保持不变。删除所有 Query 不回退状态。若用户在已有查询后手动改回 not_started，后续新增仍保留该手动状态；这里按需求中的“第一次创建”解释为该 Task 历史上的首次创建。

历史限制：M1 没有持久化被删除 Query 的编号。如果有人在升级前绕过 UI 手工创建并删除了历史最高号，现存数据无法恢复那个号码；迁移前应由管理员根据已知历史上限校正初始化值。M1 正常流程不创建 Query，此情况通常不涉及现有项目。从 M2 迁移后起，已提交的编号不会因 Query 删除而复用。

数据库依据：[PostgreSQL 行锁](https://www.postgresql.org/docs/17/explicit-locking.html)、[Supabase RLS 与函数安全](https://supabase.com/docs/guides/database/postgres/row-level-security)。

## 权限

原有 Query RLS 没有放宽，继续通过 Task → Project Owner 判断读写权限。收窄以下列级授权：

- authenticated 对 queries 只能 INSERT(task_id, query_text)、UPDATE(query_text)；SELECT、DELETE 仍受原有 RLS 限制。
- authenticated 对 tasks 只能写已列举的 M1 业务字段，不能插入/修改 last_query_no。
- 自动编号触发器必须以 SECURITY DEFINER 更新受保护计数器，因此在 UPDATE 中显式校验 Project Owner = auth.uid()；使用空 search_path 和完整表名，并撤销 PUBLIC/anon/authenticated 对触发器函数的直接执行权限。
- 原有 Task/Project 级联删除保留。Query 删除继续通过已有外键级联处理 Capture 数据，不涉及 Storage 或 Capture 功能。

## 修改文件

```text
supabase/migrations/202609140002_milestone_2.sql  增量迁移
src/components/query-section.tsx                Query 列表、表单、删除确认
src/components/task-drawer.tsx                  集成查询区域与保存锁定
src/components/project-workspace.tsx            Query 计数和 Task 状态回填
src/lib/database.types.ts                       数据类型
src/lib/queries.ts                              编号显示和聚合类型
tests/queries.test.ts                           M2 数据库测试与 M1 升级回归
package.json                                   同时执行两阶段数据库测试
README.md / MILESTONE_2.md                      运行与验收说明
```

## 验证记录

- `npm run build` 通过，包括 Next.js 编译与 TypeScript 检查。
- `npm run test:db`：21 项通过（19 个子场景与 2 个父测试）。包含 M1 原有测试，以及增量迁移、首次状态联动、删除中间/最高/全部记录、20 个排队创建请求、内容编辑与计数、其他状态及完成时间保持、失败回滚、列权限防篡改、双账号 RLS、匿名权限和升级后级联回归。
- PGlite 测试使用真实 PostgreSQL 语义和隔离数据，Auth 身份函数为测试替身。PGlite 会串行处理请求，因此“20 个排队请求”不等同于真实 PostgreSQL 多连接并发测试；真实连接验收见下文。
- 当前环境有 URL/publishable key，但没有 SQL 管理连接或测试账号；浏览器控制工具未能连接。未执行本次云端增量迁移及浏览器端到端验收，不能将本报告视作云端验收通过。

## 手工验收

1. 用 A 登录，新建一个未开始 Task，打开 Drawer；没有查询时显示空态。
2. 点击新增查询，留空/输入空白不能保存；输入“申请人 = XX科技有限公司”，保存得到 Q01。Drawer 状态及工作台变为进行中，Query 数量为 1。
3. 继续新增“商标名称 = ABC”和第三条内容，得到 Q02、Q03，计数为 3。刷新后仍存在。
4. 编辑 Q01 的内容，编号与创建时间不变，数量不变；取消编辑不保存。
5. 删除 Q02 时先点取消，记录仍在；重新删除并确认，Q01/Q03 保持原编号，数量为 2；新增得到 Q04。
6. 删除当前最高 Q04 后新增，应得 Q05；删除全部 Query 后新增，应得 Q06。Task 不因删除回退未开始。
7. 用新的 Task 分别在进行中、已完成、无法完成状态新增第一条 Query，状态不变；已完成的 completed_at 也不变。
8. 已有查询的 Task 手动改为未开始，再新增 Query，按本实现的“历史首次”规则保持未开始。
9. A/B 分别登录：B 不能看到 A 的项目或 Query。使用 B 的 JWT 调用 Supabase API，向 A 的 Task 新增 Query应失败；修改/删除 A 的 Query 返回 0 行；不能改编号或计数器。
10. 同一 Task 在两个浏览器会话同时新增不同内容，刷新后确认两条都存在且编号不同。也可用同一已登录用户的 Supabase 客户端并发提交 20 次 insert，仅传 task_id/query_text；确认成功结果有 20 个互异号码，且数量增加 20。
11. 断网保存时提示失败并保留输入；恢复后刷新确认是否已保存，再决定是否重试。保存已成功但后续刷新失败时，应看到“操作已保存”的提示。
12. 回归 M1：创建项目、创建/编辑 Task、切换四种状态、搜索和筛选、Drawer 编辑入口仍可用。工作台仅新增 Query 数量，没有 Capture 列。

## 已知边界

仍使用按 500 条分批读取、客户端筛选；跨标签或其他用户会话的修改需要刷新，无实时订阅。数据库并发分号已由行锁保障，但页面全量读取不是多请求一致性快照。没有新增网络重试幂等机制；提交响应丢失时先刷新再重试。

开发到此停止，不进入 Capture 阶段。
