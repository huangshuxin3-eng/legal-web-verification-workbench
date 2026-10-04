# 非诉网核工作台

非诉网核工作台是一款面向律师和法律从业者的公开信息核查工具。它通过 Web 工作台和 Chrome 网页核查助手，将网页查询、证据留存、结构化整理、AI 辅助分析和报告生成放在同一套工作流程中。

- **产品形态：** Web 工作台 + Chrome 网页核查助手
- **V1 数据源：** 中国执行信息公开网
- **当前阶段：** External Beta

## 产品背景

公开信息查询本身并不复杂，但查询以后通常还要翻页、打开详情、保存证据、整理字段、制作工作底稿并撰写报告。资料分散在网页、截图、表格和文档中时，后续复核也很难快速找到原始来源。

本项目把这些操作放进一套连续的工作流程，并保留核查记录与 PDF 证据之间的对应关系，方便检查和导出成果。

## 核心流程

```text
创建项目
→ 创建核查任务
→ 浏览器助手执行核查
→ PDF 证据留痕
→ 结构化整理
→ AI 辅助分析
→ 人工确认
→ DOCX / Excel 输出
```

## 产品界面

### Web 工作台

项目、核查任务和核查状态集中在同一工作区。

![Web 工作台](docs/images/workbench.png)

### 网页核查助手

在目标网站执行查询、翻页、详情访问和 PDF 留痕。

![网页核查助手](docs/images/extension.png)

### AI 分析与报告

基于结构化核查结果生成分析草稿，并经人工确认后进入报告。

![AI 分析与报告](docs/images/analysis.png)

## 核心功能

- 项目与核查任务管理
- 批量创建核查任务
- Chrome 网页核查助手
- 中国执行信息公开网自动核查
- 查询结果分页与详情处理
- 核查中断后继续执行，避免重复生成已完成的证据
- PDF 私有证据留痕、预览与下载
- 执行及失信公开信息的结构化整理
- AI 辅助分析草稿
- AI 内容编辑、保存与人工确认
- AI 分析与当前核查结果的一致性校验
- DOCX 尽调报告生成
- Excel 核查清单及 PDF 证据 ZIP 成果包
- 邮箱注册、登录、会话恢复与退出
- 基于 Supabase Auth 和 RLS 的多用户数据隔离
- Production Extension 构建与 External Beta 安装包

## AI 在产品中的使用方式

案号、金额、日期、数量和分类等基础事实由固定规则处理，AI 不直接负责确定这些内容。

AI 基于系统已经整理好的结构化结果生成四部分分析草稿：

- 核查结果概览
- 重点关注事项
- 重点记录
- 建议进一步核实事项

用户可以编辑和保存草稿。只有经过人工确认的 AI 内容才会进入最终报告。系统会记录 AI 分析对应的核查结果版本；底层结果变化后，旧分析需要重新生成和确认。技术实现中使用 `sourceHash` 进行版本一致性校验。

## 当前状态

已经完成：

- V1 核心工作流
- 公网部署
- 邮箱注册与登录
- 多用户数据隔离
- 生产环境插件构建
- External Beta 安装包
- 公网环境完整流程验证

仍待完成：

- 邀请 3–5 名真实外部目标用户完成正式 Beta 验证
- 根据真实使用记录整理问题并决定后续迭代

当前版本已经具备外部测试条件，但还需要通过真实用户测试验证使用体验和实际价值。

## 在线环境

公网工作台：<https://legal-web-verification-workbench.vercel.app>

V1 以桌面端使用为主。完整核查流程需要桌面版 Google Chrome 和配套网页核查助手，手机端无法完成依赖 Chrome Extension 的自动核查流程。

## 本地运行

### 运行环境

- Node.js 22.18 或更高版本
- npm
- Supabase 项目
- 如需使用 AI 分析，需要可用的 DeepSeek API 配置

### 安装与启动

```bash
npm ci
```

复制 `.env.example` 为 `.env.local`，填写自己的环境变量。新建 Supabase 环境时，按文件名顺序执行 `supabase/migrations/` 中的迁移，并在 Supabase Authentication 中启用邮箱密码登录。

```bash
npm run dev
```

默认访问 <http://localhost:3000>。

### 环境变量

| 变量                                   | 用途                                                       |
| -------------------------------------- | ---------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`             | Supabase 项目地址                                          |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | 浏览器端使用的 Supabase Publishable Key                    |
| `AI_BASE_URL`                          | AI 服务 API 地址                                           |
| `AI_API_KEY`                           | 服务端调用 AI 服务使用的密钥，禁止使用 `NEXT_PUBLIC_` 前缀 |
| `AI_MODEL`                             | AI 分析使用的模型名称                                      |

不要在仓库、日志或客户端代码中写入数据库密码、Supabase service role secret、AI API key、访问令牌或账号密码。未配置 `AI_API_KEY` 时，AI 分析接口会明确返回服务不可用，其他不依赖 AI 的功能仍可使用。

### 主要验证命令

```bash
npm run typecheck
npm run test:db
npm run extension:test
npm run format:check
npm run build
```

Chrome Extension 开发构建使用 `npm run extension:build`；Production Extension 构建使用 `npm run extension:build:production`。

## 技术栈

- Next.js / React / TypeScript
- Supabase Auth / PostgreSQL / Storage / RLS
- Chrome Extension Manifest V3
- DeepSeek API
- DOCX / Excel / ZIP generation

## 文档导航

- [非诉网核工作台使用手册](docs/USER_GUIDE.md)：面向 External Beta 用户的完整使用流程与常见问题
- [External Beta 插件安装说明](docs/EXTERNAL_BETA_INSTALL.md)：Chrome 网页核查助手安装步骤
- [Milestone 3](MILESTONE_3.md)、[Milestone 4](MILESTONE_4.md)、[Milestone 5](MILESTONE_5.md)、[Milestone 6](MILESTONE_6.md)：数据权限、留痕、批量任务与成果导出的开发记录
- [Milestone 8.1](MILESTONE_8_1.md)、[Milestone 8.2A](MILESTONE_8_2A.md)、[Milestone 8.2B](MILESTONE_8_2B.md)、[Milestone 8.3](MILESTONE_8_3.md)：中国执行信息公开网自动核查、恢复与报告功能的开发记录

Milestone 文档保留了实现过程、测试口径和阶段边界，供需要深入了解开发历史的读者查阅。
