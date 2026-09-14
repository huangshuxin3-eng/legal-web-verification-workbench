# Milestone 4 交付说明

## 已实现范围

正式 Chrome Manifest V3 Extension 以 Side Panel 为入口。用户使用现有 Supabase 邮箱/密码单独登录，按 Project → Task → Query 选择已有 Query；扩展读取当前活动 HTTP(S) 标签页 URL，生成完整 PDF，立即解除 debugger，再通过现有 Web `/api/captures` 归档到 Private Storage 并创建 Capture。没有连接 probe 的数据，也没有增加业务表或 Capture 字段。

Web 工作台继续保留手动兜底入口，用户术语已改为“留痕”。手动上传支持 PDF/PNG/JPG（20 MB），URL 可选；Private 预览、下载、删除、Query/Task 数量和中文业务文件名继续有效。Task 不会因生成留痕自动完成。

未实现 Excel、ZIP、AI、OCR、自动查询、网站 Adapter、批量任务、PNG 拼接、团队流程或 Web/Extension SSO。

## 目录

```text
extension/
  manifest.template.json        正式 MV3 manifest 源文件
  scripts/build.mjs             读取公开配置并生成 dist
  src/
    worker.mjs                  后台 PDF + 归档任务与互斥锁
    sidepanel.html/.mjs/.css    登录、级联选择、URL、进度、结果
    viewer.html/.mjs            携带 JWT 的 Private 留痕预览
    lib/auth.mjs                Supabase Auth 登录、刷新、退出
    lib/data.mjs                RLS 下读取 Project/Task/Query/计数
    lib/print.mjs               attach / print / finally detach
    lib/names.mjs               中文业务文件名
  tests/extension.test.mjs
  dist/                         npm run extension:build 的 Load unpacked 产物
supabase/migrations/202609140004_milestone_4.sql
```

`extension/dist/print-config.mjs` 每次构建都从 `../chrome-pdf-probe/extension/print-config.mjs` 复制。Legal Web Check PDF Profile v1 的单一来源仍是 probe 文件；正式扩展不维护第二套参数。

## Manifest permissions

- `activeTab`：用户点击扩展打开 Side Panel 后，读取该窗口当前活动 Tab 的 ID 与 URL；不申请 `<all_urls>`。
- `debugger`：对冻结的 Tab 调用 CDP `Page.printToPDF` 并 detach。
- `sidePanel`：正式操作入口。
- `storage`：保存扩展自己的 Supabase Session、最近 Query 选择和一次归档任务状态。

构建后只添加两个精确 host permissions：Supabase Project Origin，以及 `NEXT_PUBLIC_WORKBENCH_URL` 的 Origin。Publishable Key 会写入构建产物；它是公开客户端凭据。扩展中没有 service role、secret key 或数据库密码。

## Auth 与数据流

扩展直接调用同一 Supabase 项目的 `/auth/v1/token`，使用邮箱/密码获得用户 JWT，并通过 refresh token 刷新。Project/Task/Query/Capture 计数均通过 Supabase REST 读取，每次带 Publishable Key + 用户 JWT，继续受数据库 RLS 控制。最近选择只保存在 `chrome.storage.local`；恢复时重新查询，记录不存在或无权访问便不会恢复。

归档流程：

```text
Side Panel 单击并上锁
  → worker 重新按 RLS 读取 Query 上下文
  → 冻结 active tabId + URL，校验 http/https 且非 Chrome Web Store
  → debugger.attach(1.3)
  → Page.printToPDF(Legal Web Check PDF Profile v1)
  → finally debugger.detach
  → 校验同一 Tab 未导航、PDF ≤ 20 MB
  → POST /api/captures（JWT、query_id、自动 URL、稳定 request_id、PDF）
  → M3 reserve_capture_upload → Private Storage → finish_capture_upload
  → 返回 Capture，刷新 Query 留痕数量，显示动态中文文件名
```

上传仍由 Next.js API 使用 Publishable Key 和调用者 JWT 创建 Supabase client。API 不使用 service role。稳定 `request_id` 是 Capture UUID；同一失败请求重试会返回已有记录或继续相同预留，不重复递增和创建。编号仍由数据库锁定 Query 后递增 `last_capture_no`，允许失败留下空洞，删除后不复用。

## M4 migration 与 Storage

按 M1 → M2 → M3 → M4 顺序执行。已有通过 M3 的项目只执行：

```text
supabase/migrations/202609140004_milestone_4.sql
```

迁移只做增量：

- `captures.source_url` 改为 nullable，并约束非空值必须是 HTTP(S)。Capture 仍是六字段。
- 更新现有 `captures` Bucket：Private，20 MiB，允许 `application/pdf`、`image/png`、`image/jpeg`；不重建 Bucket。
- 替换 M3 `reserve_capture_upload`，增加 PDF/可选 URL以及可选稳定 Capture UUID；继续使用同一个计数器与 `capture_operations`。
- 原有 Capture RLS、Storage restrictive policies、完成/删除 RPC 和孤立文件保护继续使用。

Storage 路径仍为纯 ASCII：

```text
{user_id}/{project_id}/{task_id}/{query_id}/{capture_id}.pdf
```

业务文件名不入库，按 Task + Query + Capture 实时生成：

```text
{核查对象}_{核查事项}_{核查网站}_Q01_001_YYYYMMDD.pdf
```

## 配置与构建

Web `.env.local`：

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
NEXT_PUBLIC_WORKBENCH_URL=http://localhost:3000
```

生产部署时必须把 `NEXT_PUBLIC_WORKBENCH_URL` 改成实际 HTTPS Origin 后重新构建。它不可包含路径。不要把 service role 写入任何 `NEXT_PUBLIC_*` 或 Extension 文件。

```powershell
cd 'C:\Users\黄舒心\Documents\产品经理计划\nonlit-workbench'
npm install
npm run extension:build
npm run dev
```

Chrome 打开 `chrome://extensions`，开启 Developer mode，选择 Load unpacked，加载：

```text
C:\Users\黄舒心\Documents\产品经理计划\nonlit-workbench\extension\dist
```

修改代码、环境变量或 probe PDF 配置后必须重新构建，并在扩展页点击 Reload。

## 手工真实验收

1. 先执行 M4 migration，检查 captures Bucket 仍为 Private、20 MiB、三种 MIME，captures 仍仅六字段。
2. 启动 Web，确认工作台显示“留痕数量”；Query 中“添加留痕”接受 PDF/PNG/JPG、URL 留空可上传，Private 预览/下载/删除正常，下载是中文名。
3. 加载 `extension/dist`，确认权限只有四项及两个精确 Origin；打开 Side Panel，用账号 A 登录。
4. 依次选择 A 的 Project、Task、Query；核对 Task 核查网站、当前 URL、留痕数量。关闭重开后应恢复仍有权访问的 Query。
5. 普通公开网页点击“留痕并归档”；按钮锁定，Chrome 短暂显示 debugger 提示，完成后消失。核对 PDF 时间、标题、URL、页码、背景、末尾，Storage ASCII 路径、Capture source_url 与冻结 URL、中文名及计数。
6. 对长页和动态查询页重复；核对条件、所有表格行、多页、末尾和耗时。打印期间切换窗口或操作其他页面，目标仍应是冻结 tabId；若目标 Tab 自身跳转，本次不归档。
7. 同 Query 连续归档得 001/002/003；在 Web 删除 002 后再归档得 004。Task 与 Query 留痕数量准确，Task 状态不自动 completed。
8. 在 `chrome://extensions`、Chrome Web Store 等页面尝试，Side Panel 应提示改用 Ctrl+P + 工作台手动上传，不崩溃。打印中取消、关闭目标页或制造失败，确认提示消失、可安全重试且没有重复 Capture。
9. 账号 B 登录 Side Panel，只能选择 B 的数据。用 B 直接请求 A 的 Query/Capture/API/Storage/Signed URL 均应失败；A 的 Private PDF 不可读取、下载或删除。
10. 用超过 20 MB 的 PDF 验证扩展在上传前拒绝；JWT 过期时应尝试刷新，刷新失败要求重新登录。

## 自动化验证与已知限制

- `npm run test:db`：48 项通过，包含真实 PostgreSQL RLS 角色模拟、PDF、nullable URL、20 MiB Bucket、稳定 request_id、编号不复用、A/B Storage 隔离和 M1/M2 回归。
- `npm run extension:test`：4 项通过，包含最小权限、中文名、probe 配置来源、成功/失败 detach。
- `npm run typecheck`：通过。
- `npm run build`：通过。

尚未在本轮对真实 Supabase 执行 M4 migration，也未声称真实 Chrome + Supabase 端到端通过。Chrome 内部页、Web Store、DevTools 冲突等受浏览器限制；扩展会给出兜底提示。动态页面只打印调用时已渲染的内容。PDF 超过 20 MB 不上传。若 service worker 或整个 Chrome 进程被强制终止，JavaScript `finally` 无法继续；Chrome 会结束调试会话，但仍需在真实环境观察提示状态。扩展与 Web 是独立登录会话。
