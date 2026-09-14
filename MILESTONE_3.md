# Milestone 3：Query → Capture 交付说明

## 当前交付与边界

本阶段代码已完成，等待用户推送 M3 Migration 并进行真实 Supabase / 浏览器验收。M1/M2 以用户已通过真实验收的版本为基线。本次没有使用 service role 执行业务读写，也不要求提供此密钥。

已实现：PNG/JPG 手动上传、Private Storage、Capture 分号、Query 截图列表与计数、Task 截图总数、鉴权预览、中文业务文件名下载、确认删除、失败恢复、无截图提示。Capture 保留 id/query_id/capture_no/storage_path/source_url/created_at 六个字段，没有增加业务表。

未实现 Chrome Extension、任何浏览器截图 API、自动获取 URL、Excel/ZIP、AI/OCR、查询结果或风险判断。

## 升级与运行

1. 已有 M1/M2 数据库只执行 `supabase/migrations/202609140003_milestone_3.sql`。原有 M1/M2 迁移未修改。新数据库依次执行 001、002、003。
2. 迁移会创建/确保 `captures` Bucket 为 **Private**，限制 PNG/JPEG、单文件 5 MiB。若存在同名 Bucket，仍会强制设为 Private。
3. 保留 `.env.local` 的 `NEXT_PUBLIC_SUPABASE_URL` 和 `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`。无需新增环境变量，不配置 service role。
4. `npm ci`，然后 `npm run dev`；生产方式为 `npm run build` 后 `npm start`。需重启旧服务以加载新版本。

仅新增直接依赖 `sharp`，用于服务器检查图片真实格式、完整性和像素上限，不生成或改写图片。上传原始文件字节，JPEG 扩展名统一使用 `.jpg`。前后端限制 5 MiB；服务器上限为 2500 万像素，不支持多帧文件。

## 文件名：已按用户补充要求调整

内部对象路径：

```text
{user_id}/{project_id}/{task_id}/{query_id}/{capture_id}.png
```

界面和下载实时使用：

```text
{核查对象}_{核查事项}_{网站名称}_Q{Query序号}_{截图序号}_{北京时间日期}.png
北京木锐机器人有限公司_知识产权_国家知识产权局_Q01_001_20260914.png
```

网站名称使用现有 Task.source_name，没有另建网站简称字段。中文不会转成 uXXXX，也不会存进 Storage 对象键；Windows 禁用字符替换为下划线，去掉尾随点/空格，对保留名称和超长字段作安全处理。每个业务部分最多 50 个 UTF-16 单元，避免下载文件名过长。序号不截断，例如 Q100、1000。

文件名由 Task + Query + Capture.created_at 动态生成，不保存 file_name/display_filename。修改 Task 后业务文件名随之改变，内部对象路径保持不变。HTTP 下载使用 UTF-8 Content-Disposition；页面下载也设置相同中文 download 文件名。可供后续导出复用命名函数，但本阶段不开发导出。

## 编号与可恢复文件流程

Query 上新增两个受保护的内部字段：

- `last_capture_no`：历史已分配的最大编号。删除全部记录、删除最高号、取消上传都不减少它。
- `capture_operations`：以 capture_id 为键的临时文件操作信息，动作只有 upload/cancel/delete。操作成功后清除，异常时保留供重试。这里不是 Capture 结果状态，也不是用户填写的业务字段。

仅查询现存 MAX(capture_no) 无法满足“删除最高号后不复用”；仅在浏览器保存状态无法处理断网/刷新后的文件恢复，因此需要这两个内部字段。每个 Query 同时最多 20 个未完成操作，达到上限时先处理旧操作。

上传流程：

1. 用户登录 JWT 经 Auth.getUser 验证，使用同一个用户客户端读取 Query 并校验输入/文件。
2. `reserve_capture_upload` 锁定父 Query，递增编号，并持久化内部路径、来源地址、时间等预留信息；此时没有 Capture Record。
3. 使用 **Publishable Key + 用户 JWT** 上传文件，必须通过 Storage INSERT RLS。
4. `finish_capture_upload` 校验 Owner、预留信息、对象实际存在后创建 Capture Record，再清除预留信息；可幂等重试。
5. UI 刷新 Query 数量和 Task 的所有 Query 下 Capture 总数。

分号与预留在事务内完成，同 Query 的并发请求依赖 PostgreSQL 行锁串行分号。上传失败也不回收已分配编号，因此允许出现空号。

删除流程：

1. 用户确认后，`prepare_capture_delete` 校验 Owner 并保存删除恢复信息。
2. 使用用户 JWT 删除 Storage 文件；DELETE RLS 要求相同 Owner 且已有 delete/cancel 操作。
3. 文件删除成功后，`finish_capture_delete` 确认 Storage 中已不存在对象，再删除 Capture Record 和操作信息。
4. 文件删除失败则保留记录；若响应丢失会检查并尝试恢复文件。数据库删除失败时尝试恢复原字节，仍显示未完成并允许重试。

PostgreSQL 与 Storage 没有共同事务，无法承诺任意进程崩溃下的瞬时原子性。此实现用持久化操作信息实现可恢复性：刷新后能看到“上传/删除尚未完成”，可继续确认上传、取消并清理，或重试已确认的删除。取消和上传确认共享 Query 行锁；已完成的上传不会被清理操作误删。

Query 删除会先清理它的未完成上传、逐张删除已关联截图，再删除 Query。部分文件删除失败时保留 Query，允许重试；之前成功删除的图片不会恢复。直接从数据库级联删除仍有文件/未完成操作的 Query、Task、Project 会被触发器阻止，避免孤立文件。已有截图路径的 Task 不允许直接跨 Project 移动；M1 UI 本身没有此功能。

## 权限说明（无 service role）

- 全部 Storage 读写使用真实登录用户 JWT，受 Storage RLS 控制。预览通过鉴权下载返回字节，再生成当前页面临时 Blob URL，不使用 public URL 或开放 Bucket。
- 原有四层 Project Owner RLS 保留。Capture 禁止客户端直接 INSERT/UPDATE/DELETE，避免跳过文件流程。
- Query 的两个内部字段不授予客户端写权限，仍只能按 M2 编辑 query_text。
- 文件 SELECT 要求路径中 user/project/task/query 与真实关联匹配，且存在自己的 Capture 或预留信息。
- 文件 INSERT 仅允许自己已预留的 upload 路径，或 delete 阶段恢复同一图片；DELETE 仅允许自己已确认的 delete/cancel 路径。不能随意上传任意路径，也不能覆盖已完成截图。
- 同时使用 restrictive Storage 策略，避免项目已有的宽松策略意外开放 captures Bucket。
- RPC 使用有限的 SECURITY DEFINER 权限维护受保护字段，每个公开变更函数在取得 Query 行锁前都以 `auth.uid()` 检查 Project Owner。没有可由调用者传入的 owner_id，没有动态 SQL，固定空 search_path，匿名执行被撤销。这个有限数据库能力不等同于在应用使用可绕过全部 RLS 的 service key。

技术参考：[Supabase Private Bucket](https://supabase.com/docs/guides/storage/buckets/fundamentals)、[Storage RLS](https://supabase.com/docs/guides/storage/security/access-control)、[PostgreSQL 行锁](https://www.postgresql.org/docs/17/explicit-locking.html)。

## 主要新增文件

```text
supabase/migrations/202609140003_milestone_3.sql
src/components/capture-section.tsx         上传、预览、下载、确认删除、恢复
src/lib/capture-names.ts                   中文业务命名
src/lib/capture-client.ts                  携带用户 JWT 的请求
src/lib/capture-workflow.ts                上传/删除补偿逻辑
src/lib/server/capture-api.ts              用户鉴权、RPC、Storage 协调
src/app/api/captures/route.ts              图片验证及上传
src/app/api/captures/[captureId]/route.ts   鉴权下载/删除
src/app/api/captures/recover/route.ts       恢复未完成的文件操作
src/app/api/queries/[queryId]/route.ts      清理图片后删除 Query
tests/captures.test.ts                     Auth 角色下的 DB/Storage RLS
tests/capture-workflow.test.ts             文件命名与故障注入
```

## 本地验证结果及其边界

- TypeScript 与 Next.js 生产构建已通过。
- 数据库/补偿测试 47 项通过，包含 M1/M2 回归、分号、删除最高号/全部记录、取消后号码不复用、幂等确认、恢复、跨 Query 统计、跨账号文件/记录隔离。
- M3 测试只在初始化隔离数据库、安装迁移时使用数据库管理权限。**所有业务操作均 SET ROLE authenticated 后使用 A/B 身份完成**，没有创建或使用 service_role 测试客户端。
- PGlite 执行实际 PostgreSQL RLS/事务语义；测试中的 auth.uid()/auth.role() 和 storage.objects 是测试环境替身，文件补偿使用故障注入。它们不代表实际 Supabase Storage 对象服务、网络或真实 JWT 验收通过。
- 本地 HTTP 检查：首页 200；新增上传、下载、删除、恢复和 Query 删除 API 未登录均返回 401。
- 浏览器控制工具当前连接失败，未进行真实页面端到端验收。按用户指示，M3 迁移由用户自行推送并通过真实测试账号验收。
- 没有任何业务自动化测试必须使用 service role；真实 A/B 账号可以完成全部功能/权限验收。仅数据库初始化/迁移本身需要管理工具权限。

## 真实手工验收（A/B）

1. 推送 M3 迁移；确认 Bucket captures 为 Private，Capture 表仍只有六个字段。启动本地 Web。
2. A 登录已有项目，打开一个 Query，确认提示“尚无截图”；上传 PNG 并填写真实 HTTP(S) 来源网址。查看 001、中文业务文件名、时间、预览/下载/删除。
3. 在 Supabase Storage 确认内部路径为 UUID 层级，captures.storage_path 与之匹配。下载所得文件必须保留中文业务名，内容与所选图片一致。
4. 连续上传 JPG/JPEG，编号为 002、003。删除 002 先取消，再确认，编号不重排；新增应为 004。删除最高号后新增仍继续递增。
5. 删除该 Query 全部 Capture 后新增，不回到 001；数量更新，无截图提示在数量为 0 时出现。
6. 同 Task 的另一个 Query 上传图片，确认 Task 截图数量是所有 Query 的合计，Query 数量未受影响。刷新后文件和记录仍在。
7. 打开预览、下载；未登录窗口访问内部 Storage public URL 必须无法得到图片。Blob URL 仅用于当前已鉴权页面，不是公共 Storage 地址。
8. B 登录后看不到 A 的项目/Capture。使用 B 的 JWT 调用 A Capture 下载/删除 API，必须失败；直接调用 Storage download/remove 也不能读取/删除 A 文件。A 再读取确认文件仍在。
9. B 调用 reserve_capture_upload(A的query_id,...)、finish_capture_upload、prepare_capture_delete、cancel_capture_upload 或 finish_capture_delete，全部必须失败。A 的未完成操作也不能被 B 操作。
10. 上传空文件、非图片改后缀、损坏图片、超过 5 MiB 的文件、不合法 URL，确认不能成功创建 Capture Record。
11. 模拟上传中断，刷新后查看未完成操作；已有完整文件时点击继续完成上传，否则取消并清理。取消过的编号不复用。
12. 模拟 Storage 删除失败，确认记录不被直接删除；恢复网络后重试。数据库确认删除失败时，界面保留恢复入口，最后检查对象和记录均不存在。
13. 删除含截图的 Query，确认提示会一并删除文件；完成后检查 Query、Capture、Storage 对象均清理。失败时 Query 应保留，可重试。
14. 两个 A 会话同时给同 Query 上传，刷新后检查编号互异；这一步验证真实 PostgreSQL 多连接并发。
15. 回归 M1/M2 创建/编辑项目任务、状态切换、Query CRUD、搜索筛选；上传 Capture 不改变 Task 状态或 completed_at。

## 当前限制

每张图片 5 MiB/2500 万像素，每 Query 最多 20 个未完成操作；列表仍按 500 条分批读取。没有跨标签实时推送，大项目的服务端分页不在本阶段。存储请求异常与硬崩溃可能留下临时待恢复操作，需要用户在恢复网络后处理；没有引入后台清理调度或 Activity Log。

M3 之前若手动删除过历史最高 Capture 编号，旧数据没有高水位记录，无法自动恢复那个历史值；迁移以现存最大编号初始化。正常 M1/M2 没有 Capture UI，不涉及此情形。M3 之后分配过的编号不会因删除或取消而复用。

至此停止，不进入 Chrome Extension 阶段。
