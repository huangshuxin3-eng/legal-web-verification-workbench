# 非诉网核工作台

依据《非诉网核工作台 PRD v1.0》实现 Project → Task → Query → Capture（用户界面称“留痕”）。Milestone 4 增加正式 Chrome Side Panel：对当前网页一键生成完整 PDF，并通过用户 JWT、现有 RLS 和 M3 协调协议归档到 Private Storage。Milestone 5 增加应用层批量任务生成器，按“核查对象 × 核查范围”预览、去重并批量创建 Task。详细说明见 [MILESTONE_4.md](MILESTONE_4.md) 和 [MILESTONE_5.md](MILESTONE_5.md)。

已通过 M1/M2 的数据库只执行 `supabase/migrations/202609140003_milestone_3.sql`，不要重跑旧迁移。完整升级、权限、失败恢复和验收说明见 [Milestone 3 交付说明](./MILESTONE_3.md)。仅使用原有 Publishable Key 和登录用户 JWT，没有新增环境变量或 service role 依赖。

## 1. 已完成的功能

- Supabase Auth 邮箱密码登录、会话恢复与退出；未登录时只显示登录入口。
- 项目列表：名称、编号、真实 Task 数量、北京时间创建时间、进入项目。
- 新建项目 Modal：名称必填、编号可选；保存成功后进入工作台。
- 工作台：项目名称、编号、Task 总数、已完成、未完成（包含无法完成）。顶部数量始终基于整个项目，不受筛选影响。
- 新增、编辑 Task；必填校验、只含空格校验、HTTP(S) 网址校验。
- 四种状态切换；数据库维护 completed_at，接口返回落库结果后才更新页面。
- 对象、事项、网站名称搜索；状态、对象、事项组合筛选与清空筛选。
- 点击 Task 行或“查看”打开右侧 Drawer，展示全部要求的详情字段及编辑入口。
- 原生 dialog 处理模态焦点、Escape 关闭、关闭后焦点恢复；保存期间防重复提交。
- 加载、空列表、无搜索结果、失败重试、无权访问状态。
- Drawer 查询记录：自动编号、新增、编辑、确认删除，展示创建时间；工作台显示真实 Query 数量。
- 每个 Task 保存已分配编号上限，删除不复用；首次 Query 创建与 not_started → in_progress 在同一事务完成。
- Project 工作台可进入三步批量任务生成器；预设范围保存在应用配置中，URL 必须由应用明确配置或由用户本次填写后才能创建。
- Task Drawer 支持永久删除 Task；Project 工作台的项目操作菜单支持输入完整名称后永久删除 Project。父级删除逐条复用留痕删除协调协议，先清理 Private Storage 文件再删除数据库记录。
- Task 表支持勾选当前筛选结果中的多个 Task 批量删除；服务端顺序复用同一层级删除服务，并分别返回成功项和失败项以支持安全重试。

只使用四张业务表。Web 手动留痕支持 PDF/PNG/JPG、私有预览、中文名下载、确认删除和 Query/Task 留痕计数；Extension 只选择已有 Query 并归档当前网页，不创建或编辑业务数据。

项目编辑仍未增加 UI；Project 和 Task 删除入口已经补齐。

## 2. 数据库 Schema / Migration

新数据库依次执行 M1、M2、M3、M4 四份迁移；已有 M3 数据库只执行 M4。M4 允许 Capture URL 为空、增加 PDF MIME 与 20 MiB 限制，但 Capture 仍只有原有六个字段。

| 表       | 字段与约束                                                                                                                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| projects | id UUID 主键；owner_id UUID 非空，引用 auth.users；name TEXT 非空非空白；code TEXT 可空；status 默认 active，限 active/completed；created_at TIMESTAMPTZ 非空默认 now()                   |
| tasks    | id UUID 主键；project_id UUID 非空；entity_name/topic/source_name/source_url TEXT 必填；note TEXT 可空；status 默认 not_started，限四种状态；created_at 非空默认 now()；completed_at 可空 |
| queries  | id UUID 主键；task_id UUID 非空；query_no 正整数；query_text TEXT 非空；created_at 非空默认 now()；UNIQUE(task_id, query_no)                                                              |
| captures | id UUID 主键；query_id UUID 非空；capture_no 正整数；storage_path TEXT 非空；source_url TEXT 可空；created_at 非空默认 now()；UNIQUE(query_id, capture_no)                                |

所有 id 默认 gen_random_uuid()。Project → Task → Query → Capture 外键均为 ON DELETE CASCADE。删除 Auth 用户也会删除其项目树。projects.owner_id、tasks.project_id 有索引；两组序号唯一约束的索引同时覆盖各自父级外键查询。

`set_task_completed_at` 为非 SECURITY DEFINER 触发器函数：首次进入 completed 时写数据库当前时间；completed 状态下编辑保留原时间（阻止直接篡改）；退出 completed 清空；再次完成写新的时间。CHECK 约束保证状态和完成时间一致。未绑定留痕完成条件，符合本阶段范围。

## 3. RLS 策略

四表均启用 RLS，每表一个 `FOR ALL TO authenticated` 策略，包含 USING 和 WITH CHECK：

- projects：owner_id 必须等于 auth.uid()。
- tasks：父 Project 必须属于当前用户。
- queries：父 Task 必须能通过其 RLS 被当前用户读取。
- captures：父 Query 必须能通过其 RLS 被当前用户读取。

USING 限制读取、更新和删除已有行；WITH CHECK 限制插入以及更新后的归属。不能把自己的行迁移到他人的项目树。匿名角色没有四表权限，authenticated 不获得 TRUNCATE。M2 进一步收窄列级写权限：Query 只能新增 task_id/query_text、编辑 query_text；Task 计数器只能由自动编号触发器维护。该触发器使用 SECURITY DEFINER 并显式验证 auth.uid() 对应的 Project Owner，固定空 search_path，禁止客户端直接调用。

浏览器只使用 publishable key（也兼容旧 anon key）和 Supabase Auth JWT，不使用 service_role。登录视图只是界面入口控制，真正的数据安全边界是数据库 RLS。Next.js 不在服务器渲染任何用户私有数据。

参考：[Supabase RLS 官方文档](https://supabase.com/docs/guides/database/postgres/row-level-security)、[Next.js 安装文档](https://nextjs.org/docs/app/getting-started/installation)。

## 4. 主要目录

```text
nonlit-workbench/
├── src/app/
│   ├── layout.tsx                     # 全局布局与 AuthProvider
│   ├── page.tsx                       # 项目列表
│   ├── globals.css                    # Tailwind 与基础样式
│   └── projects/[projectId]/page.tsx   # 工作台路由，没有 Task 详情页
├── src/components/
│   ├── auth-provider.tsx              # 登录、会话、退出
│   ├── dialog.tsx                     # Modal/Drawer 共用模态容器
│   ├── project-form.tsx               # 创建项目
│   ├── project-workspace.tsx          # Task 查询、筛选及写入
│   ├── task-form.tsx                  # 新增/编辑 Task
│   └── task-drawer.tsx                # Task 详情
├── src/lib/
│   ├── database.types.ts             # 四层数据与 Supabase 类型
│   ├── supabase.ts                    # 浏览器客户端单例
│   └── tasks.ts                       # 状态、网址与错误处理
├── supabase/migrations/202609140001_milestone_1.sql
├── tests/database.test.ts             # 真实 PostgreSQL 语义的隔离测试
├── .env.example
├── package.json
└── package-lock.json
```

## 5. 本地运行

使用 Node.js 22.18+（推荐当前维护的 LTS）和 npm，PowerShell 中运行：

```powershell
cd 'C:\Users\黄舒心\Documents\产品经理计划\nonlit-workbench'
npm ci
Copy-Item .env.example .env.local
```

1. 准备 Supabase 测试项目，按顺序执行三份 Migration；已有 M1/M2 项目只执行 M3。
2. 在 Supabase Authentication 中启用 Email/Password，创建并确认一个测试用户。应用本阶段只提供登录，不提供注册、找回密码页面。
3. 在 `.env.local` 中填入该项目 URL 和 publishable key。
4. 执行 `npm run dev`，打开 http://localhost:3000，使用该账号登录。

```powershell
npm run dev
```

验证命令：

```powershell
npm run typecheck
npm run test:db
npm run format:check
npm run build
npm start
```

`npm start` 启动生产构建，与 `npm run dev` 二选一。环境变量修改后重启；生产使用时需重新 build。

## 6. 必要环境变量

| 变量                                 | 说明                                                   |
| ------------------------------------ | ------------------------------------------------------ |
| NEXT_PUBLIC_SUPABASE_URL             | Supabase 项目 URL，如 https://项目标识.supabase.co     |
| NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY | 同一项目的 publishable key；旧 anon key 也可填写在这里 |

不需要数据库密码或 service_role key。不要将 service_role/secret key 放到 NEXT_PUBLIC 变量。未配置时显示配置提示，不会填充假数据。

## 7. 手工验收步骤

1. 执行迁移，确认 public 中仅新增四张业务表，四表 RLS 均启用。
2. 创建用户 A、B。用 A 登录；刷新仍保持登录；退出后只显示登录表单。
3. 新建名称为空/只含空格的项目，确认不能保存；填写名称、不填编号，创建成功并自动进入工作台；返回列表确认编号显示“—”。
4. 创建带编号项目，确认名称、编号、创建时间正确，Task 数量为 0。
5. 新增 Task，不填必填项、只填空格或填非 HTTP(S) 网址时不能保存；正确填写后默认未开始，计数为总数 1、完成 0、未完成 1。刷新确认落库。
6. 新增至少另外两项 Task，使用不同对象、事项和网站；分别及组合搜索/筛选，检查结果；无匹配时显示空结果；顶部计数不随筛选变化。
7. 编辑全部字段与备注，保存后检查表格、Drawer 和刷新后的内容一致。取消编辑不写入数据库。
8. 依次切换四种状态；在 Supabase Table Editor 检查 completed 时 completed_at 有值，其余状态为空；已完成时只改备注不改变完成时间；再次完成生成新时间。
9. 点击整行和查看按钮均打开右侧 Drawer；网址可新窗口访问；编辑可保存；关闭/Escape 返回工作台，无独立 Task 页面。
10. 断网后保存，确认提示失败、不伪造成功、保留表单内容；恢复网络后重试。快速双击保存不重复提交。
11. 用 B 在独立浏览器登录：看不到 A 的项目；访问 A 项目的 UUID 路由不能读到数据。
12. 用 B 的 authenticated JWT 调用 Supabase API：尝试查询/修改/删除 A 的四层记录以及将 B 的 Task 关联到 A 项目；确认读取为空、修改删除为 0 行或报无权访问，插入/跨属更新失败。不要用 SQL Editor 的管理员角色代替此测试，它可以绕过 RLS。
13. Query/Capture 的约束与级联用 `npm run test:db` 验收；它会在独立内存 PostgreSQL 中建立 A/B 完整树，检查跨属写入、两组唯一约束、删除 Task/Project 后的后代数据，无需 UI 或生产样本。

## 8. Milestone 1 验证记录与通用限制

- 已通过 TypeScript 检查、代码格式检查与 Next.js 生产构建。生产服务首页与项目路由 HTTP 检查均返回 200，缺少环境变量时正确显示配置提示。
- 隔离数据库测试通过 8 个子场景（Node 报告计入父测试共 9 项）。PGlite 执行实际迁移及 PostgreSQL RLS，Auth 用户表和 auth.uid() 仅在测试中模拟；这不替代云端 Auth/JWT 集成测试。
- M1 初次交付时未执行云端验收；用户现已确认 M1/M2 通过真实验收。M3 的本地验证和待执行的真实验收见 MILESTONE_3.md。
- 当前列表按 500 条分批取全量后客户端筛选，避免默认 1000 行返回上限截断；请保持 Supabase API Max Rows 至少 500（默认 1000）。适合本阶段基础规模，大项目的服务器分页暂未实现。
- 没有多标签实时订阅或乐观并发锁；其他会话的修改需刷新可见，同一记录并发编辑采用最后成功写入覆盖。
- 超时发生在服务端提交后但响应未返回时，用户重试新增仍可能重复；没有引入幂等业务表。先刷新确认是否已经创建，再重试。
- 已安装依赖随 package-lock.json 锁定；应用使用 Next.js 16、React 19、Tailwind 4 和 Supabase JS 2。

## 9. 当前阶段边界

Milestone 4 代码已实现。由用户执行 M4 migration、加载 `extension/dist` 并按 MILESTONE_4.md 完成真实 Chrome + Supabase 双账号验收；本阶段未实现 Excel、ZIP、AI、OCR 或自动网页操作。
