import { loadSourceModule } from "./source-modules.mjs";

/**
 * 通用多页 zxgk 执行桩（M8.2b Slice 5）。
 *
 * 只描述标签页与页面事实：停在哪一页、总页数是多少、每一页的结果集合是什么。
 * `jumpToPage` 是**唯一**能改变"页面停在第几页"的动作，因此"跑到第几页"完全由
 * zxgk-automation 的控制流决定，桩自己不复制任何分页逻辑：
 * - 不复制 worker 的实现；
 * - 不替 orchestration 决定该不该翻页；
 * - 不对页数施加任何上限。
 *
 * 页数默认 21（真人样本），每页默认 10 条；跨页 rowKey 默认不同（案号里带页号），
 * 想验证跨页重复身份时用 `rowsForPage` 显式返回同样的行即可。
 */

export const ENTITY = "上海某某科技有限公司";
export const LIST_TAB_BASE = 21;

export const executionTask = {
  id: "task-execution",
  project_id: "project-1",
  entity_name: ENTITY,
  topic: "执行",
  source_name: "中国执行信息公开网",
  source_url: "https://zxgk.court.gov.cn/",
};

export const listUrl = "https://zxgk.court.gov.cn/gkw/html/zhzxgk/index.html";
export const detailUrl =
  "https://zxgk.court.gov.cn/gkw/html/zhzxgk/detail.html";

export const DEFAULT_ROW_COUNT = 10;
export const DEFAULT_TOTAL_PAGES = 21;

/**
 * 结果行身份契约（2026-09-17）：name + caseNo + detailIdentity 三者构成 rowKey；
 * filingDate 只是 metadata（真实结果行可以为空），不参与身份。
 * 夹具默认给每条行一个稳定的 detailIdentity，需要构造「显示字段相同、身份不同」
 * 或「身份完全相同」时用 detailIdentity 显式覆盖。
 */
export function makeRow({
  name = "某某集团有限公司",
  caseNo,
  filingDate = "2023年3月10日",
  serial = "1",
  detailIdentity = `ID-${serial}`,
} = {}) {
  return {
    serial: String(serial),
    name,
    caseNo,
    filingDate,
    detailIdentity,
    identityError: null,
    label: "查看",
  };
}

/** 每页 count 条；页内序号重复（现实如此），身份由 rowKey 建立。 */
export function rowsOfPage(pageNo, count = DEFAULT_ROW_COUNT) {
  return Array.from({ length: count }, (_, index) =>
    makeRow({
      caseNo: `（2023）粤0305执${pageNo}${String(index + 1).padStart(2, "0")}号`,
      filingDate: `2023年${(index % 9) + 1}月10日`,
      serial: String(index + 1),
    }),
  );
}

/** 页面自报的"未找到 / 无结果"以外的最小可用快照。 */
const verificationOk = { failed: false, evidence: null };

export async function createMultipageHarness(options = {}) {
  const [state, adapter, workflow] = await Promise.all([
    loadSourceModule("lib/automation-state.mjs"),
    loadSourceModule("adapters/zxgk-execution.mjs"),
    loadSourceModule("lib/zxgk-automation.mjs"),
  ]);

  const calls = [];
  const states = [];
  const savedJobs = [];
  const openedUrls = [];

  const totalPages = options.totalPages ?? DEFAULT_TOTAL_PAGES;
  const rowCount = options.rowCount ?? DEFAULT_ROW_COUNT;
  const rowsForPage =
    options.rowsForPage ?? ((pageNo) => rowsOfPage(pageNo, rowCount));
  const overrides = new Map();
  const pageRows = (pageNo) =>
    (overrides.get(pageNo) ?? rowsForPage(pageNo)).map((row) => ({ ...row }));

  // 标签页真实地"停在"某一页：只有 jumpToPage 能改变它。
  const list = { pageNo: options.pageNo ?? 1, totalPages };
  // 页面自报的总页数以"标签页当前事实"为准，因此 list.totalPages 可以被测试直接改写
  // （模拟网站在两次访问之间改变了结果集规模）。
  const reportedTotalPages = (pageNo) =>
    options.reportedTotalPages
      ? options.reportedTotalPages(pageNo)
      : list.totalPages;
  const rowsOnList = () => pageRows(list.pageNo);

  const listTabIds = new Set([LIST_TAB_BASE]);
  const closedTabIds = new Set();
  const details = new Map();

  let job = null;
  let nextQueryNo = 7;
  // Capture 编号是"服务端按 Query 连续编号"的替身：需要接续 legacy 现场时由调用方指定起点。
  let nextCaptureNo = options.captureNoStart ?? 3;
  let nextTabId = 900;
  let clock = Date.parse("2026-09-15T08:00:00.000Z");
  // 模拟 worker 进程被杀：这一次写入丢失，之后的所有写入都消失。
  let killed = false;
  let killNextWrite = false;
  let killArmed = true;

  const listTabId = () => job?.tabId ?? LIST_TAB_BASE;
  // 允许预置已存在的 Query：legacy PARTIAL_COMPLETE 的 resume 必须能查回它。
  // task_id 默认补成当前 Task —— resume 会按「同 Task」核对 Query，漏掉它只会得到一个
  // 与真实原因无关的 QUERY_UNAVAILABLE。
  const queries = (options.queries ?? []).map((row) => ({
    task_id: executionTask.id,
    ...row,
  }));

  const dependencies = {
    now: () => new Date(clock),
    getTask: async () => ({ ...executionTask }),
    getActiveTab: async () => ({
      id: LIST_TAB_BASE,
      url: "https://example.com/",
    }),
    getTab: async (tabId) => {
      if (closedTabIds.has(tabId)) return null;
      if (listTabIds.has(tabId)) return { id: tabId, url: listUrl };
      if (details.has(tabId)) return { id: tabId, url: detailUrl };
      return null;
    },
    createTab: async () => {
      const id = nextTabId++;
      listTabIds.add(id);
      calls.push(["create-tab", id]);
      return { id, url: listUrl };
    },
    getJob: async () => job,
    saveJob: async (next) => {
      const killNow =
        killed ||
        killNextWrite ||
        (killArmed && options.killBefore?.({ next, current: job }));
      if (killNow) {
        killed = true;
        killNextWrite = false;
        killArmed = false;
        throw new Error("worker killed");
      }
      job = next;
      states.push(next.state);
      savedJobs.push(next);
      return next;
    },
    openQueryPage: async (tabId, currentUrl, openOptions = {}) => {
      calls.push(["open", tabId]);
      openedUrls.push({ tabId, currentUrl });
      // force=true 对应 worker 的真实行为：真正重新加载查询入口。
      // 页面事实：查询按钮绑定 submitCaptcha()，它会先 initCurrentPage() 再 search()，
      // 因此重建环境之后页面必然回到第 1 页——fresh resume 必须据此重新定位。
      if (openOptions?.force === true) list.pageNo = 1;
    },
    fillEntity: async (tabId, value) => {
      calls.push(["fill", tabId, value]);
      return { ok: true };
    },
    submitQuery: async (tabId) => {
      calls.push(["submit", tabId]);
      return { ok: true };
    },
    readVerificationAvailability: async (tabId) => {
      calls.push(["read-verification", tabId]);
      const override = options.verificationAvailability?.();
      if (override) return override;
      return {
        ok: true,
        overlayPresent: true,
        parentPresent: true,
        loadingPresent: false,
        loadingVisible: false,
        rootPresent: true,
        statusText: null,
        failureEvidence: null,
      };
    },
    inspectResult: async () => {
      calls.push(["inspect"]);
      return options.inspectResult?.() ?? state.AUTOMATION_RESULT.HAS_RESULT;
    },
    listTaskQueries: async () => [],
    getQuery: async (queryId) => {
      const row = queries.find((item) => item.id === queryId);
      return row ? { ...row } : null;
    },
    createQuery: async (taskId, queryText) => {
      const queryNo = nextQueryNo++;
      const query = {
        id: `query-${queryNo}`,
        task_id: taskId,
        query_no: queryNo,
        query_text: queryText,
        created_at: `2026-09-15T00:0${queryNo}:00.000Z`,
      };
      queries.push(query);
      calls.push(["create-query", query.id, queryText]);
      return { ...query };
    },
    archiveQuery: async (queryId, tabId) => {
      const kind = listTabIds.has(tabId) ? "list" : "detail";
      const pageNo = kind === "list" ? list.pageNo : detailPageOf(tabId);
      calls.push(["archive", queryId, tabId, kind, pageNo]);
      // 失败的上传不产生 Capture，因此也不消耗编号（与真实归档链路的语义一致）。
      const failure = options.archiveFailure?.({ kind, pageNo, tabId });
      if (failure)
        throw Object.assign(new Error(failure), { stage: "storage" });
      const capture = {
        id: `capture-${nextCaptureNo}`,
        query_id: queryId,
        capture_no: nextCaptureNo,
      };
      nextCaptureNo += 1;
      // capture_no 记录在调用日志里，便于断言"编号连续且不重复"。
      calls[calls.length - 1].push(capture.capture_no);
      if (kind === "list" && options.killAfterListArchive && killArmed) {
        killArmed = false;
        killNextWrite = true;
      }
      return {
        capture,
        filename: `${ENTITY}_执行_中国执行信息公开网_Q07_${String(
          capture.capture_no,
        ).padStart(3, "0")}_20260915.pdf`,
      };
    },
    readResultPage: async (tabId) => {
      calls.push(["read-list", tabId, list.pageNo]);
      if (!listTabIds.has(tabId)) throw new Error("不是结果列表标签页");
      const total = reportedTotalPages(list.pageNo);
      return {
        ok: true,
        rows: rowsOnList(),
        page: {
          input: list.pageNo,
          shown: list.pageNo,
          totalPages: total,
          totalSize: total * rowCount,
          pagerVisible: true,
        },
        resultVisible: true,
        verification: { ...verificationOk },
      };
    },
    jumpToPage: async (tabId, targetPage) => {
      calls.push(["jump", tabId, targetPage]);
      const custom = options.jump?.({ targetPage, list });
      if (custom) return custom;
      // 默认：动作真实生效，列表页落在目标页。
      list.pageNo = targetPage;
      return { ok: true };
    },
    sleep: async () => {
      // 页面事实不会自己变化；只推进虚拟时钟，让观察循环最终能到 deadline。
      clock += 250;
    },
    openDetail: async (tabId, rowKey) => {
      const pageNo = list.pageNo;
      const row = rowsOnList().find(
        (item) => adapter.buildRowKey(item) === rowKey,
      );
      calls.push(["open-detail", rowKey, row?.caseNo ?? null, pageNo]);
      if (!row) throw new Error("结果列表中已找不到该条结果，未打开详情。");
      const detailTabId = nextTabId++;
      details.set(detailTabId, {
        rowKey,
        caseNo: row.caseNo,
        name: row.name,
        // detailIdentity 让「显示字段相同、身份不同的两条行」可被逐条断言：
        // 测试必须能证明两条行各自打开了**自己那一个**详情请求。
        detailIdentity: row.detailIdentity,
        pageNo,
        closed: false,
      });
      return { detailTabId, url: detailUrl };
    },
    readDetailIdentity: async (detailTabId) => {
      const entry = details.get(detailTabId);
      calls.push(["read-detail", detailTabId]);
      if (!entry || entry.closed) return { ok: false, closed: true };
      return {
        ok: true,
        errorText: "",
        rowCount: 3,
        caseNumbers: [entry.caseNo],
        names: [entry.name],
        bodyText: `${entry.name}案号${entry.caseNo}`,
      };
    },
    closeDetail: async (detailTabId, listTabId) => {
      calls.push(["close-detail", detailTabId, listTabId]);
      const entry = details.get(detailTabId);
      if (entry) entry.closed = true;
    },
  };

  function detailPageOf(detailTabId) {
    const entry = details.get(detailTabId);
    return entry ? entry.pageNo : null;
  }

  /** 进程重新可用：写入不再被丢弃（不动 job）。 */
  const reviveProcess = () => {
    killed = false;
    killNextWrite = false;
  };

  return {
    calls,
    states,
    savedJobs,
    openedUrls,
    state,
    adapter,
    workflow,
    list,
    details,
    rowsForPage,
    /** 直接改写某一页的结果集合（模拟网站在两次访问之间变化）。 */
    setPage(pageNo, rows) {
      overrides.set(
        pageNo,
        rows.map((row) => ({ ...row })),
      );
    },
    detailPageOf,
    get job() {
      return job;
    },
    get tabId() {
      return listTabId();
    },
    closeListTab() {
      if (job?.tabId) closedTabIds.add(job.tabId);
    },
    /**
     * 直接写入持久化 job（绕过 saveJob 的杀进程模拟）：用于构造真实的
     * legacy / 中断现场快照，而不是靠复制生产逻辑去"生成"它们。
     */
    setJob(next) {
      job = next;
      savedJobs.push(next);
      states.push(next.state);
      return job;
    },
    /**
     * 真正发出的 business transition（Page N → N+1）。
     *
     * 唯一的定义是 **advancePage 的 intent 写入**：`state === ADVANCING_PAGE` 只由那一次
     * 落盘产生（"源页已完成、准备离开"）。刻意不按"job 里是否带着 PAGE_ADVANCE
     * operation"过滤——未结算的 intent 会随之后的状态写入一起被复制（重建查询环境、
     * CHECKING_RESULT、markResumePage 都带着它），那样会把同一次 transition 数成很多次。
     */
    savedIntents() {
      return savedJobs.filter(
        (item) => item.state === state.AUTOMATION_STATES.ADVANCING_PAGE,
      );
    },
    /**
     * 模拟扩展进程重新可用：写入不再被丢弃，但**不改动持久化 job**。
     *
     * 与 interrupt() 的区别是职责：这里只回答"进程活了没有"，job 该是什么状态由
     * 调用方自己决定（例如用 setJob 构造"用户就在原页面上重新检查结果"的现场）。
     */
    revive: reviveProcess,
    /**
     * 模拟扩展重启：进程重新可用，并按 worker 的启动扫描把"运行中但已中断"的
     * 状态标记为 FAILED（已生成的进度原样保留）。
     */
    interrupt() {
      reviveProcess();
      if (!state.AUTOMATION_INTERRUPTED_STATES.includes(job?.state)) return job;
      job = {
        ...job,
        state: state.AUTOMATION_STATES.FAILED,
        error:
          "扩展后台在自动操作期间中断，无法确认上一步是否完成。已生成的 Query 与留痕全部保留，可在 Side Panel 中「继续剩余分页核查」。",
        updatedAt: new Date("2026-09-15T08:05:00.000Z").toISOString(),
      };
      return job;
    },
    automation: workflow.createZxgkAutomation(dependencies),
    dependencies,
  };
}

export const named = (run, name) =>
  run.calls.filter((call) => call[0] === name);
export const listArchives = (run) =>
  named(run, "archive").filter((call) => call[3] === "list");
export const detailArchives = (run) =>
  named(run, "archive").filter((call) => call[3] === "detail");
export const jumps = (run) => named(run, "jump");

export const startRun = async (options = {}) => {
  const run = await createMultipageHarness(options);
  await run.automation.start({
    taskId: executionTask.id,
    projectId: executionTask.project_id,
  });
  return run;
};

export const continueRun = (run) =>
  run.automation.continueAfterVerification({ taskId: executionTask.id });

export const resumeRun = (run) =>
  run.automation.resume({ taskId: executionTask.id });
