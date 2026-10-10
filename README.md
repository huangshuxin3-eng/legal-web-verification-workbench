# LegalTrace

**把律师的公开信息核查，从「查网页、存证据、创建整理表格、写报告」，变成一套可回溯、可复核的工作流。**

公开信息核查其实包含两类工作：

- **在工作台整理结果**：管理核查任务、复核、分析、生成报告；
- **在网页上执行核查**：查询、翻页、查看详情、保存证据留痕。

所以 LegalTrace 由两个部分组成：

**Web 工作台**
负责管理核查任务、整理结果、人工复核，以及生成报告和成果包。

**网页核查助手（Chrome Extension）**
负责在公开网站执行核查并保存 PDF 证据留痕。

当前 V1 聚焦 **中国执行信息公开网**。

**在线体验：**
<https://legal-web-verification-workbench.vercel.app>

**网页核查助手：** External Beta，通过 Chrome 开发者模式安装。

[使用手册](docs/USER_GUIDE.md) · [网页核查助手安装说明](docs/EXTERNAL_BETA_INSTALL.md)

![LegalTrace 首页](docs/images/landing.png)

---

## 为什么做 LegalTrace

对律师来说，「搜索一个企业」并不难。

真正耗时的是查询之后。查询结果要逐页看，案件详情要逐条开，页面要存成证据留痕；案号、法院、金额、日期还得重新整理进表格，最后再写进报告。

当这些材料散落在网页、截图、PDF、Excel 和 Word 之间时，另一个问题也会出现：

> **几天以后重新复核一条记录时，它当时对应的是哪一个页面、哪一份证据？**

LegalTrace 不只是减少重复点击，更重要的是让**核查结果和当时的原始证据保持对应关系**，让后续复核有据可查。

---

## LegalTrace 怎么解决

整个流程被收敛成五步：

```text
创建核查任务
      ↓
网页核查助手执行核查
      ↓
保存 PDF 证据留痕
      ↓
工作台整理与人工复核
      ↓
生成报告 / Excel 清单 / 成果包
```

### 1. 创建核查任务

在 Web 工作台中建立项目，填写需要核查的对象，并选择核查事项和数据来源。

一个核查任务回答三个问题：

> **对谁、查什么、从哪里查。**

![LegalTrace 工作台](docs/images/workbench.png)

### 2. 在公开网站执行核查

打开网页核查助手，选择对应项目和核查任务后，它执行查询、翻页和详情访问。

如果目标网站出现安全验证，由用户本人完成验证后继续。

![LegalTrace 网页核查助手](docs/images/extension.png)

### 3. 保存 PDF 证据留痕

核查过程中，系统把当前页面保存为 PDF 证据留痕，并记录它来自哪个项目、哪个核查任务、哪一次检索批次和第几页。

一条整理后的核查记录，都能顺着这条对应关系回到当时的证据。

### 4. 整理并人工复核

系统从符合条件的证据留痕中整理案号、法院、日期、金额、公示类型等字段。

> **空白不等于「0」，也不等于「无」。**

公开页面没有公示的字段保持为空，系统不替用户解释缺失信息。

### 5. 生成报告与成果包

LegalTrace 可以基于已经整理好的核查结果生成 AI 辅助分析草稿。

> **系统负责事实，AI 负责组织，律师负责判断。**

案号、法院、金额、日期等基础事实由程序按固定规则处理，不交给 AI 判断；AI 只基于整理后的结果生成分析草稿；只有人工确认后的内容才会进入最终报告。

![AI 辅助分析与报告](docs/images/analysis.png)

核查完成后，可以：

- 生成 DOCX 尽调报告；
- 导出成果包（Excel 核查清单 + 对应证据文件）。

---

## 怎么开始使用

完整核查流程目前需要 **桌面版 Google Chrome** 和**网页核查助手**。

**1. 打开 Web 工作台**
访问 <https://legal-web-verification-workbench.vercel.app>，注册账号并创建项目和核查任务。

**2. 下载并安装网页核查助手**
当前网页核查助手以 External Beta 形式提供，通过 Chrome 开发者模式安装。

[下载网页核查助手](https://github.com/huangshuxin3-eng/legal-web-verification-workbench/releases/download/v8.1.0-beta/nonlit-web-verification-helper-8.1.0-beta.zip)

**3. 在网页核查助手中登录**
使用与 Web 工作台相同的邮箱账号。网页核查助手与 Web 工作台的登录状态各自独立，因此第一次安装后需要单独登录一次。

**4. 开始核查**
选择项目和核查任务，按照网页核查助手提示完成核查；完成后回到工作台查看留痕文件、整理后的核查结果，以及生成的报告。

详细说明：

[网页核查助手安装说明](docs/EXTERNAL_BETA_INSTALL.md) · [LegalTrace 使用手册](docs/USER_GUIDE.md)

---

## 当前范围

LegalTrace V1 聚焦：

> **企业公开信息核查中的执行信息查询、证据留痕与结果整理。**

当前覆盖中国执行信息公开网的执行信息核查：从查询、留痕、整理，到人工复核与成果交付。

V1 当前只接入中国执行信息公开网，也不让 AI 直接输出风险评级、法律结论或胜诉可能性判断。

---

## 当前验证

当前版本已经：

- 部署到 Production 环境，并人工走通从「创建任务」到「成果导出」的完整流程；
- 自动核查、分页处理与中断后继续执行由自动化测试覆盖，并验证已完成证据留痕不会重复生成；
- 为类型检查、数据层逻辑、网页核查助手、代码格式和生产构建提供可重复执行的验证命令。

### 下一步验证计划

1. 邀请真实律师完成实际核查流程试用；
2. 测量人工核查与 LegalTrace 在相同任务下的耗时差异；
3. 根据真实使用反馈决定下一批数据源，而不是先扩展功能。

---

## 技术实现

- **Web：** Next.js / React / TypeScript
- **数据与权限：** Supabase Auth / PostgreSQL / Storage / RLS
- **浏览器端：** Chrome Extension Manifest V3（网页核查助手）
- **AI：** 服务端可配置模型调用，provider / model 通过环境变量配置
- **成果交付：** DOCX / Excel / ZIP

---

## 本地开发

安装依赖：

```bash
npm ci
```

复制 `.env.example` 为 `.env.local`，配置 Supabase 与可选的 AI 服务环境变量。

启动开发环境：

```bash
npm run dev
```

新建 Supabase 环境时，按文件名顺序执行 `supabase/migrations/` 中的迁移。

### 主要环境变量

| 变量                                   | 用途                              |
| -------------------------------------- | --------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`             | Supabase 项目地址                 |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | 浏览器端 Supabase Publishable Key |
| `AI_BASE_URL`                          | AI 服务 API 地址                  |
| `AI_API_KEY`                           | 服务端 AI API 密钥                |
| `AI_MODEL`                             | AI 模型名称                       |

不要将数据库密码、Supabase service role secret、AI API key、访问令牌或账号密码提交到仓库。

### 验证命令

```bash
npm run typecheck
npm run test:db
npm run extension:test
npm run format:check
npm run build
```

网页核查助手生产构建：

```bash
npm run extension:build:production
```

---

## 文档

- [LegalTrace 使用手册](docs/USER_GUIDE.md)
- [网页核查助手安装说明](docs/EXTERNAL_BETA_INSTALL.md)
