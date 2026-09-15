# Milestone 6 交付说明

## 实现范围

Project Workbench 新增“导出网核成果”。弹窗显示项目名称、可导出核查对象数、有底稿的 Task 数量和 Capture 总数。没有 Capture 时不会生成空 ZIP。

成果包结构固定为：

```text
项目名_网核成果_YYYYMMDD.zip
├─ 项目名_网核清单_YYYYMMDD.xlsx
└─ 底稿文件/
   ├─ 01_主体名称/
   │  └─ 01_核查事项/
   │     └─ 现有 M4 业务文件名.pdf/png/jpg
   └─ 02_主体名称/
```

仅 Capture 数量大于 0 的 Task 进入 Excel 和目录。主体及事项复用 Workbench 的 canonical Task 顺序：主体排序后，预设事项按 M5 配置顺序，自定义事项排在预设事项之后，同事项按 Task 创建顺序；每个 Task 的 Capture 按 `query_no ASC, capture_no ASC` 排列。

## Excel

工作簿只有 `网核清单` 一个 Sheet，固定五列：序号、核查对象、核查事项、核查网站、底稿数量。表头加粗并居中，冻结首行，启用首行自动筛选，设置基础列宽，序号和底稿数量居中。

## 权限与生成流程

浏览器使用当前 Supabase 会话 JWT 请求 Next.js Node API。服务端用 Publishable Key 和该 JWT 创建用户态 Supabase client，先通过 RLS 读取 Project、Task、Query、Capture，再通过 Private Storage `download` 读取文件。没有 service role、公开 bucket、公开 URL或永久分享地址。

服务端先在系统临时目录完整生成 ZIP。Excel 只在内存中生成一次；Capture 按稳定顺序逐个下载和写入 ZIP，每次只保留一个 Capture 的内容，单文件继续受现有 20 MiB 上限保护。全部文件写入成功后才返回下载响应。任一数据库、Storage 或 ZIP 写入失败都会销毁未完成输出并删除临时文件，不向用户返回成功 ZIP。响应完成或中断后也会清理临时文件。

## 数据与范围

M6 没有 migration、Schema、RLS 或业务实体变更。继续使用 Project → Task → Query → Capture，Capture 保持六字段。没有实现 Query 明细、多 Sheet、风险评价、报告、部分 Task 导出、模板或分享链接。

## 验证

```powershell
npm run typecheck
npm run test:db
npm run extension:test
npm run format:check
npm run build
git diff --check
```

`tests/project-export.test.ts` 验证有底稿 Task 过滤、多 Query/Capture 聚合、稳定排序、现有业务文件名、Windows 路径安全、Excel 结构与样式、ZIP 文件类型和数量、空项目、私有权限实现、失败终止及 UI 入口。
