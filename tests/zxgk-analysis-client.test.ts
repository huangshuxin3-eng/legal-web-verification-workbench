/**
 * DeepSeek provider 接入（Slice 1）的**离线**测试。
 *
 * 全部使用注入的 mock `fetch`：不真的调用 DeepSeek、不花 API 钱、不依赖公网。
 * 覆盖请求形状（模型名 / `response_format` / `thinking` 明确关闭 / 无额外字段）、
 * 错误映射（401/429/500、响应体异常、content 缺失、超时）与「不重试」「不泄漏内部数据」
 * 两条硬约束。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { CaptureOperationError } from "../src/lib/capture-workflow.ts";
import { parseAnalysisResponse } from "../src/lib/server/ai-analysis.ts";
import {
  ANALYSIS_REQUEST_TIMEOUT_MS,
  AI_NETWORK_FAILED_MESSAGE,
  AI_NOT_CONFIGURED_MESSAGE,
  AI_RESPONSE_MALFORMED_MESSAGE,
  AI_TIMEOUT_MESSAGE,
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  aiUpstreamFailedMessage,
  requestAnalysisCompletion,
  requireAnalysisConfig,
  resolveAnalysisConfig,
  type AnalysisClientConfig,
} from "../src/lib/server/ai-client.ts";

const CONFIG: AnalysisClientConfig = {
  baseUrl: DEFAULT_AI_BASE_URL,
  apiKey: "test-key-not-a-real-credential",
  model: DEFAULT_AI_MODEL,
};

const REQUEST = { system: "系统提示词", user: "结构化事实" };

type CapturedCall = { url: string; init: RequestInit };
type Responder = () => Response | Promise<Response>;

/** 记录每次调用，并按给定 responder 返回响应。 */
function spyFetch(responder: Responder) {
  const calls: CapturedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return responder();
  };
  return { calls, fetchImpl };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 合法的 DeepSeek 响应体（OpenAI 兼容形状）。 */
function completion(content: string) {
  return jsonResponse({
    choices: [{ message: { role: "assistant", content } }],
  });
}

function callBody(call: CapturedCall) {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

/** 临时移除环境变量，用于验证「未配置」路径；结束后恢复。 */
async function withoutApiKey<T>(run: () => Promise<T>) {
  const saved = process.env.AI_API_KEY;
  delete process.env.AI_API_KEY;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = saved;
  }
}

// ── 1. 配置解析：只有 key 是必需项 ────────────────────────────────────────

test("未配置 AI_API_KEY → 判定为未配置（调用方 fail closed 为 503）", () => {
  assert.equal(resolveAnalysisConfig({}), null);
  assert.equal(resolveAnalysisConfig({ AI_API_KEY: "" }), null);
  assert.equal(resolveAnalysisConfig({ AI_API_KEY: "   " }), null);
});

test("base URL / model 未配置时回落到 DeepSeek 缺省值", () => {
  assert.deepEqual(resolveAnalysisConfig({ AI_API_KEY: "k" }), {
    baseUrl: DEFAULT_AI_BASE_URL,
    apiKey: "k",
    model: DEFAULT_AI_MODEL,
  });
  assert.equal(DEFAULT_AI_BASE_URL, "https://api.deepseek.com");
  assert.equal(DEFAULT_AI_MODEL, "deepseek-flash");
});

test("base URL 去尾部斜杠、模型名去首尾空白，避免拼出 //chat/completions", () => {
  assert.deepEqual(
    resolveAnalysisConfig({
      AI_API_KEY: " k ",
      AI_BASE_URL: "https://example.test/v1/",
      AI_MODEL: " another-model ",
    }),
    {
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "another-model",
    },
  );
});

test("缺少 AI_API_KEY 时明确 503，且**不发起任何网络请求**", async () => {
  const { calls, fetchImpl } = spyFetch(() => completion("不应被调用"));
  await withoutApiKey(async () => {
    await assert.rejects(
      requestAnalysisCompletion(REQUEST, { fetchImpl }),
      (error: unknown) =>
        error instanceof CaptureOperationError &&
        error.status === 503 &&
        error.message === AI_NOT_CONFIGURED_MESSAGE,
    );
  });
  assert.equal(calls.length, 0, "未配置时不得访问网络");
});

test("配置守卫 requireAnalysisConfig：缺 key → 同一句 503；有 key → 返回配置", () => {
  // 与 requestAnalysisCompletion 共用同一条失败文案，route 早失败与调用期失败不可分叉。
  assert.throws(
    () => requireAnalysisConfig({}),
    (error: unknown) =>
      error instanceof CaptureOperationError &&
      error.status === 503 &&
      error.message === AI_NOT_CONFIGURED_MESSAGE,
  );
  assert.throws(() => requireAnalysisConfig({ AI_API_KEY: "   " }), {
    status: 503,
  });
  assert.deepEqual(requireAnalysisConfig({ AI_API_KEY: "k" }), {
    baseUrl: DEFAULT_AI_BASE_URL,
    apiKey: "k",
    model: DEFAULT_AI_MODEL,
  });
});

// ── 2. 请求形状：模型名、JSON 约束、无额外字段 ─────────────────────────────

test("请求打到 {baseUrl}/chat/completions，且请求体只有固定的 5 个键", async () => {
  const { calls, fetchImpl } = spyFetch(() =>
    completion(JSON.stringify({ overview: "a" })),
  );
  await requestAnalysisCompletion(REQUEST, { config: CONFIG, fetchImpl });

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, "https://api.deepseek.com/chat/completions");
  assert.equal(call.init.method, "POST");

  const body = callBody(call);
  // 体量最小的白名单：多一个字段都会让这条断言失败（避免误传内部数据）。
  assert.deepEqual(Object.keys(body).sort(), [
    "messages",
    "model",
    "response_format",
    "stream",
    "thinking",
  ]);
  assert.equal(body.model, "deepseek-flash");
  assert.deepEqual(body.messages, [
    { role: "system", content: REQUEST.system },
    { role: "user", content: REQUEST.user },
  ]);
  assert.equal(body.stream, false);
});

test("明确关闭 thinking：request body 固定带 thinking.type = disabled", async () => {
  const { calls, fetchImpl } = spyFetch(() => completion("{}"));
  await requestAnalysisCompletion(REQUEST, { config: CONFIG, fetchImpl });
  // 第一版优先低延迟与稳定 JSON：不使用推理模式，也不给高 effort 留口子。
  assert.deepEqual(callBody(calls[0]).thinking, { type: "disabled" });
});

test("使用 response_format = json_object 约束模型只输出 JSON", async () => {
  const { calls, fetchImpl } = spyFetch(() => completion("{}"));
  await requestAnalysisCompletion(REQUEST, { config: CONFIG, fetchImpl });
  assert.deepEqual(callBody(calls[0]).response_format, { type: "json_object" });
});

test("API key 只出现在 Authorization 头里，不进请求体", async () => {
  const { calls, fetchImpl } = spyFetch(() => completion("{}"));
  await requestAnalysisCompletion(REQUEST, { config: CONFIG, fetchImpl });
  const { init } = calls[0];
  const headers = init.headers as Record<string, string>;
  assert.deepEqual(Object.keys(headers).sort(), [
    "Authorization",
    "Content-Type",
  ]);
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers.Authorization, `Bearer ${CONFIG.apiKey}`);
  assert.ok(
    !String(init.body).includes(CONFIG.apiKey),
    "请求体不得携带 API key",
  );
});

test("请求体不含 Supabase token / Capture 存储路径 / PDF 等内部数据", async () => {
  const { calls, fetchImpl } = spyFetch(() => completion("{}"));
  await requestAnalysisCompletion(REQUEST, { config: CONFIG, fetchImpl });
  const serialized = String(calls[0].init.body);
  for (const forbidden of [
    "Bearer",
    "service_role",
    "sb_publishable",
    "eyJ", // JWT 前缀
    "supabase",
    "storage/v1",
    "/object/",
    "%PDF",
  ])
    assert.ok(
      !serialized.includes(forbidden),
      `请求体不得出现内部数据：${forbidden}`,
    );
  // 客户端本身没有任何读取 PDF / 存储 / 用户会话的入口
  assert.deepEqual(Object.keys(callBody(calls[0])), [
    "model",
    "messages",
    "response_format",
    "thinking",
    "stream",
  ]);
});

// ── 3. 正常返回 ────────────────────────────────────────────────────────────

test("200 + 合法响应 → 返回 choices[0].message.content 原文（不擅自规整）", async () => {
  const content = '  {"overview":"本次核查共纳入 2 条记录。"}  ';
  const { fetchImpl } = spyFetch(() => completion(content));
  assert.equal(
    await requestAnalysisCompletion(REQUEST, { config: CONFIG, fetchImpl }),
    content,
  );
});

// ── 4. 上游失败：fail closed，且不重试 ─────────────────────────────────────

test("HTTP 401 / 429 / 500 全部 fail closed 为 502，且**不重试**", async () => {
  for (const status of [401, 429, 500, 503]) {
    const { calls, fetchImpl } = spyFetch(() =>
      jsonResponse({ error: { message: "upstream" } }, status),
    );
    await assert.rejects(
      requestAnalysisCompletion(REQUEST, { config: CONFIG, fetchImpl }),
      (error: unknown) =>
        error instanceof CaptureOperationError &&
        error.status === 502 &&
        error.message === aiUpstreamFailedMessage(status),
      `HTTP ${status} 应映射为 502`,
    );
    assert.equal(calls.length, 1, `HTTP ${status} 不得重试`);
  }
});

test("网络层失败（连不上）→ 502，且不重试", async () => {
  let count = 0;
  const fetchImpl: typeof fetch = async () => {
    count += 1;
    throw new TypeError("fetch failed");
  };
  await assert.rejects(
    requestAnalysisCompletion(REQUEST, { config: CONFIG, fetchImpl }),
    (error: unknown) =>
      error instanceof CaptureOperationError &&
      error.status === 502 &&
      error.message === AI_NETWORK_FAILED_MESSAGE,
  );
  assert.equal(count, 1);
});

test("响应体不是 JSON / content 缺失或非字符串 → 502，不产出半成品", async () => {
  const cases: [string, Response][] = [
    ["响应体不是 JSON", new Response("<html>502 Bad Gateway</html>")],
    ["choices 缺失", jsonResponse({})],
    ["choices 为空数组", jsonResponse({ choices: [] })],
    ["message 缺失", jsonResponse({ choices: [{}] })],
    ["content 缺失", jsonResponse({ choices: [{ message: {} }] })],
    [
      "content 为 null",
      jsonResponse({ choices: [{ message: { content: null } }] }),
    ],
    [
      "content 非字符串",
      jsonResponse({ choices: [{ message: { content: 42 } }] }),
    ],
    [
      "content 为空白",
      jsonResponse({ choices: [{ message: { content: "  " } }] }),
    ],
  ];
  for (const [label, response] of cases) {
    const { fetchImpl } = spyFetch(() => response);
    await assert.rejects(
      requestAnalysisCompletion(REQUEST, { config: CONFIG, fetchImpl }),
      (error: unknown) =>
        error instanceof CaptureOperationError &&
        error.status === 502 &&
        error.message === AI_RESPONSE_MALFORMED_MESSAGE,
      `应拒绝：${label}`,
    );
  }
});

test("超时 → 504，主动结束而不是无限等待；不重试", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = (_input, init) => {
    calls += 1;
    // 真实 provider 在 AbortSignal 触发时会令 fetch 以 TimeoutError 拒绝，这里如实模拟。
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  };
  // ⚠️ 必须持有一个 ref'd 定时器兜住事件循环：`AbortSignal.timeout()` 内部的定时器是
  // **unref** 的，当事件循环没有其它 handle 时它永远不会触发，于是这个「等待被中止」的
  // promise 会永久挂起，node:test 会把整个文件判为 cancelledByParent。生产代码不受影响
  // （真实 fetch 自身持有 socket handle），只有这个纯 mock 测试需要自己把循环撑住。
  const keeper = setTimeout(() => {}, 5_000);
  try {
    const startedAt = Date.now();
    await assert.rejects(
      requestAnalysisCompletion(REQUEST, {
        config: CONFIG,
        fetchImpl,
        timeoutMs: 20,
      }),
      (error: unknown) =>
        error instanceof CaptureOperationError &&
        error.status === 504 &&
        error.message === AI_TIMEOUT_MESSAGE,
    );
    assert.equal(calls, 1, "超时后不得重试");
    assert.ok(
      Date.now() - startedAt < 5_000,
      "超时必须真的中断，而不是等 provider 自己结束",
    );
  } finally {
    clearTimeout(keeper);
  }
});

test("超时上限为 60 秒", () => {
  assert.equal(ANALYSIS_REQUEST_TIMEOUT_MS, 60_000);
});

// ── 5. 与既有校验层串联：client 不绕过 parseAnalysisResponse ───────────────

test("content 交给 parseAnalysisResponse，非法输出仍由校验层 fail closed", async () => {
  const good = spyFetch(() =>
    completion(
      JSON.stringify({
        overview: "a",
        keyRisks: "b",
        keyRecords: "c",
        followUps: "d",
      }),
    ),
  );
  const draft = parseAnalysisResponse(
    await requestAnalysisCompletion(REQUEST, {
      config: CONFIG,
      fetchImpl: good.fetchImpl,
    }),
  );
  assert.deepEqual(Object.keys(draft), [
    "overview",
    "keyRisks",
    "keyRecords",
    "followUps",
  ]);

  // provider 返回 HTTP 200 但内容是散文（未按 JSON 输出）→ 校验层仍然拒绝
  const bad = spyFetch(() => completion("本次核查未发现异常。"));
  await assert.rejects(
    async () =>
      parseAnalysisResponse(
        await requestAnalysisCompletion(REQUEST, {
          config: CONFIG,
          fetchImpl: bad.fetchImpl,
        }),
      ),
    (error: unknown) =>
      error instanceof CaptureOperationError && error.status === 502,
  );
});

// ── 6. 文件级边界 ──────────────────────────────────────────────────────────

test("ai-client 是 server-only：无 NEXT_PUBLIC_ 前缀、无 use client、无 UI 依赖", async () => {
  const client = await readFile(
    new URL("../src/lib/server/ai-client.ts", import.meta.url),
    "utf8",
  );
  // 只禁止「真正的公开变量读写」；文件头注释里对 NEXT_PUBLIC_ 的禁令不算违规。
  assert.doesNotMatch(client, /NEXT_PUBLIC_AI/);
  assert.doesNotMatch(client, /process\.env\.NEXT_PUBLIC_/);
  assert.match(client, /process\.env\b/);
  assert.match(client, /Authorization/);
  assert.doesNotMatch(client, /^"use client"/m);
  assert.doesNotMatch(client, /@\/components|\.\.\/\.\.\/components/);
  // 不引入任何 SDK：provider 调用只依赖 Node 原生 fetch
  assert.doesNotMatch(
    client,
    /from "openai"|from "@?anthropic|require\("openai"\)/,
  );
});
