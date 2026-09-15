import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanupSourceRoot,
  loadSourceModule,
} from "./helpers/source-modules.mjs";

const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;
let fetchHandler;

test.before(() => {
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({
          supabaseSession: {
            accessToken: "test-user-jwt",
            refreshToken: "test-refresh-token",
            expiresAt: Date.now() + 60 * 60 * 1000,
            user: { id: "user-1" },
          },
        }),
        set: async () => {},
        remove: async () => {},
      },
    },
  };
  globalThis.fetch = (...args) => fetchHandler(...args);
});

test.after(async () => {
  await cleanupSourceRoot();
  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
});

async function modules() {
  const data = await loadSourceModule("lib/data.mjs");
  const archive = await loadSourceModule("lib/archive-bridge.mjs");
  const names = await loadSourceModule("lib/names.mjs");
  return { data, archive, names };
}

const context = (queryId) => ({
  id: queryId,
  query_no: queryId === "Q2" ? 2 : 1,
  query_text: "上海某某科技有限公司",
  tasks: {
    id: "task-1",
    project_id: "project-1",
    entity_name: "上海某某科技有限公司",
    topic: "执行",
    source_name: "中国执行信息公开网",
    source_url: "https://zxgk.court.gov.cn/",
  },
});

function restResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

async function contract(uploadCapture) {
  const { data, archive, names } = await modules();
  return archive.createArchiveBridge({
    queryContext: data.queryContext,
    queryNotAccessibleCode: data.QUERY_NOT_ACCESSIBLE,
    uploadCapture,
    captureName: names.businessName,
  });
}

test("正确 Query 使用真实 queryContext，并把同一 queryId 传入归档上传", async () => {
  const fetchCalls = [];
  const uploadCalls = [];
  fetchHandler = async (url, options) => {
    fetchCalls.push({ url: String(url), options });
    return restResponse([context("Q1")]);
  };
  const bridge = await contract(async (...args) => {
    uploadCalls.push(args);
    return {
      id: "capture-101",
      query_id: "Q1",
      capture_no: 1,
      created_at: "2026-09-15T08:00:00.000Z",
    };
  });

  const queryRow = await bridge.loadContext(
    "Q1",
    "automation query unavailable",
  );
  const blob = new Blob(["pdf"], { type: "application/pdf" });
  const result = await bridge.upload({
    queryId: "Q1",
    queryRow,
    sourceUrl: "https://zxgk.court.gov.cn/result",
    requestId: "request-1",
    blob,
  });

  assert.match(fetchCalls[0].url, /id=eq\.Q1/);
  assert.match(fetchCalls[0].url, /tasks!inner/);
  assert.equal(
    fetchCalls[0].options.headers.Authorization,
    "Bearer test-user-jwt",
  );
  assert.equal(queryRow.tasks.project_id, "project-1");
  assert.equal(queryRow.tasks.entity_name, "上海某某科技有限公司");
  assert.deepEqual(uploadCalls[0], [
    "Q1",
    "https://zxgk.court.gov.cn/result",
    "request-1",
    blob,
  ]);
  assert.equal(result.capture.id, "capture-101");
  assert.equal(result.capture.query_id, "Q1");
  assert.match(
    result.filename,
    /上海某某科技有限公司_执行_中国执行信息公开网_Q01_001_/,
  );
});

test("QUERY_NOT_ACCESSIBLE 时在 PDF/upload/finalization 边界前 fail closed", async () => {
  let uploadCount = 0;
  fetchHandler = async () => restResponse([]);
  const bridge = await contract(async () => {
    uploadCount += 1;
    return null;
  });

  await assert.rejects(
    bridge.loadContext("Q1", "自动核查 Query 已失效"),
    /自动核查 Query 已失效/,
  );
  assert.equal(uploadCount, 0);
});

test("错误 queryId 不会被 mock 吞掉：Q2 会真实进入 REST URL 与上传参数", async () => {
  const observed = { urls: [], uploadIds: [] };
  fetchHandler = async (url) => {
    observed.urls.push(String(url));
    return restResponse([context("Q2")]);
  };
  const bridge = await contract(async (queryId) => {
    observed.uploadIds.push(queryId);
    return {
      id: "capture-202",
      query_id: queryId,
      capture_no: 2,
      created_at: "2026-09-15T08:00:00.000Z",
    };
  });

  const queryRow = await bridge.loadContext("Q2", "unavailable");
  const result = await bridge.upload({
    queryId: "Q2",
    queryRow,
    sourceUrl: "https://example.com/Q2",
    requestId: "request-Q2",
    blob: new Blob(["pdf"]),
  });

  assert.match(observed.urls[0], /id=eq\.Q2/);
  assert.deepEqual(observed.uploadIds, ["Q2"]);
  assert.equal(result.capture.query_id, "Q2");
  assert.match(result.filename, /_Q02_002_/);
});

test("Capture reservation 请求失败时错误原样向上冒泡", async () => {
  fetchHandler = async () => restResponse([context("Q1")]);
  const bridge = await contract(async () => {
    throw new Error("reserve_capture_upload failed");
  });
  const queryRow = await bridge.loadContext("Q1", "unavailable");

  await assert.rejects(
    bridge.upload({
      queryId: "Q1",
      queryRow,
      sourceUrl: "https://example.com",
      requestId: "request-reserve-fail",
      blob: new Blob(["pdf"]),
    }),
    /reserve_capture_upload failed/,
  );
});

test("reservation 后 upload/finalization 失败时保留 recovery 错误", async () => {
  fetchHandler = async () => restResponse([context("Q1")]);
  const bridge = await contract(async () => {
    const error = new Error("finish_capture_upload failed");
    error.recovery = { capture_id: "capture-reserved", retryable: true };
    throw error;
  });
  const queryRow = await bridge.loadContext("Q1", "unavailable");

  await assert.rejects(
    bridge
      .upload({
        queryId: "Q1",
        queryRow,
        sourceUrl: "https://example.com",
        requestId: "request-finalize-fail",
        blob: new Blob(["pdf"]),
      })
      .catch((error) => {
        assert.deepEqual(error.recovery, {
          capture_id: "capture-reserved",
          retryable: true,
        });
        throw error;
      }),
    /finish_capture_upload failed/,
  );
});

test("queryContext 的 auth/data 错误不会被改写或触发上传", async () => {
  let uploadCount = 0;
  fetchHandler = async () => restResponse({}, { ok: false, status: 500 });
  const bridge = await contract(async () => {
    uploadCount += 1;
  });

  await assert.rejects(
    bridge.loadContext("Q1", "automation query unavailable"),
    /数据加载失败/,
  );
  assert.equal(uploadCount, 0);
});
