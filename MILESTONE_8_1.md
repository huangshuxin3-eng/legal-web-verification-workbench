# Milestone 8.1：中国执行信息公开网“执行”无结果闭环

## 范围

Chrome Side Panel 对 `执行 + 中国执行信息公开网` Task 提供 `zxgk_execution` 确定性 adapter。它导航到固定综合查询页，仅填写 `Task.entity_name` 并点击查询。组织机构代码保持空白，执行法院范围保持网站默认值。

自动核查完全由 Task 驱动。开始一轮运行时，`automationJob` 锁定 `taskId` 和 `queryText = Task.entity_name`，并保持 `queryId = null`，不读取或跟随 Side Panel 手工流程中当前选中的 Query。用户在运行期间切换手工 Query 不会改变本轮检索词或后续归档目标。

查询触发后状态机进入 `WAITING_HUMAN_VERIFICATION`。扩展不识别、不拖动、不绕过滑块；用户在网页中完成人工验证并主动点击“验证完成，继续”后，扩展才重新读取页面状态。

## 结果边界

- `NO_RESULT`：页面必须明确显示全国法院范围内“没有找到……相关的结果”。此后创建 `query_text = Task.entity_name` 的 Query，并复用 M4 PDF、Private Storage、Capture reserve/upload/finalize 和业务文件名链路，最终进入 `DONE`。
- `HAS_RESULT`：页面必须出现包含序号、姓名、立案时间、案号、查看的结果表格及至少一条实际数据行。创建 Query 后进入 `HAS_RESULT_UNSUPPORTED`，不自动留痕、不翻页、不进入详情。
- `UNKNOWN`：进入 `PAUSED`，不创建 Query 或 Capture。

每次明确得到 `NO_RESULT` 或 `HAS_RESULT` 都代表一次真实检索，因此都会新建 Query；即使文本与历史 Query 相同也不去重，`query_no` 继续由数据库单调递增。创建成功后，本轮 `automationJob.queryId` 锁定新 Query，`NO_RESULT` 的 Capture 只归档到该 ID。

`DONE`、`FAILED` 和 `HAS_RESULT_UNSUPPORTED` 都只是一轮运行的终态。受支持的 Task 会继续显示“再次自动核查”，下一轮重新从 `Task.entity_name` 开始并在结果确认后创建另一条 Query。

## 技术边界

页面填写、点击和结果读取使用现有 `debugger` 权限下的 CDP `Runtime.evaluate`。每次调用独立 attach，并在 `finally` 中 detach。PDF 继续使用既有 `Page.printToPDF`。Extension permissions 保持 `activeTab / debugger / sidePanel / storage / tabs`，没有 `<all_urls>`。

状态保存在 Extension local storage。Service Worker 若在非人工等待阶段中断，会把遗留运行状态标记为 `FAILED`，要求用户检查网页和 Query 后回到手工模式。Side Panel 将 Query 选择器明确标为手工流程；它仍服务于既有手工留痕，不控制自动核查。

本阶段没有 migration、Schema、RLS、新业务实体或 Capture 字段变更，也没有实现有结果列表遍历、详情点击、分页、AI 或 CAPTCHA 自动处理。
