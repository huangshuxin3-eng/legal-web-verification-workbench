/**
 * AI provider 边界：DeepSeek（OpenAI 兼容 HTTP，Node 原生 `fetch`，**不引入任何 SDK**）。
 *
 * 这是**唯一**允许出现 provider 相关代码的位置；调用方只依赖本文件的契约，
 * 因此换 provider 只改环境变量（`AI_BASE_URL` / `AI_MODEL`），不改 route / UI / 校验层。
 *
 * 契约：
 *   入参：`system` / `user` 两段文本，全部来自 `buildAnalysisPrompt` 对结构化事实的
 *         确定性序列化 —— **不含任何原始 PDF 文本**。
 *   返回：`choices[0].message.content` 的**原始字符串**，不做任何解析，交给
 *         `parseAnalysisResponse` 做严格校验（非法 JSON / 缺字段 / 类型错误由校验层
 *         fail closed）。本文件**不绕过**该校验。
 *   失败：一律抛 `CaptureOperationError`，由既有 `apiError` 统一映射状态码：
 *         - 未配置 `AI_API_KEY` → 503（明确「未配置」，不是静默失败）
 *         - 超时 → 504；上游非 2xx / 响应体异常 / content 缺失 → 502
 *         **任何失败都不重试**：AI 生成是计费调用，第一版不因网络波动造成重复计费。
 *   早失败：`requireAnalysisConfig()` 供调用方在**读取任何事实之前**先做配置检查，
 *         缺配置时不会下载 PDF、不会调用 parser、也不会发出任何 provider 请求。
 *
 * 安全：
 *   - API key 只来自服务端环境变量，**禁止** `NEXT_PUBLIC_` 前缀（否则密钥会被打进
 *     浏览器 bundle）。本文件不得被任何 "use client" 模块 import。
 *   - 发给模型的请求体只有 system / user 两段文本 + 固定参数：**不含** Supabase token、
 *     用户 Authorization header、Capture storage path、PDF 二进制或原始版面文本。
 */

import { CaptureOperationError } from "../capture-workflow.ts";

/** 单次分析请求的超时上限：模型 60 秒未回答即主动结束本次请求并告知失败，不无限等待。 */
export const ANALYSIS_REQUEST_TIMEOUT_MS = 60_000;

/** base URL 缺省值；`AI_BASE_URL` 未配置或为空时使用。 */
export const DEFAULT_AI_BASE_URL = "https://api.deepseek.com";

/** 模型缺省值；`AI_MODEL` 未配置或为空时使用。 */
export const DEFAULT_AI_MODEL = "deepseek-flash";

export const AI_NOT_CONFIGURED_MESSAGE =
  "AI 分析服务尚未配置（服务端缺少 AI_API_KEY），无法生成分析草稿。";
export const AI_TIMEOUT_MESSAGE =
  "AI 分析请求超时（60 秒内未返回结果），本次未生成分析草稿。";
export const AI_RESPONSE_MALFORMED_MESSAGE =
  "AI 分析服务返回的数据不完整，未生成分析草稿，请稍后重试。";
export const AI_NETWORK_FAILED_MESSAGE =
  "无法连接 AI 分析服务，未生成分析草稿，请检查网络后重试。";

/** 上游返回非 2xx 时的用户可见文案（带状态码，便于区分 401 / 429 / 5xx）。 */
export function aiUpstreamFailedMessage(status: number) {
  return `AI 分析服务返回异常（HTTP ${status}），未生成分析草稿，请稍后重试。`;
}

export type AnalysisCompletionRequest = {
  system: string;
  user: string;
};

export type AnalysisClientConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

/** 去掉尾部斜杠，避免拼出 `//chat/completions`；空值一律回落到缺省值。 */
function normalizeBaseUrl(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_AI_BASE_URL;
  return trimmed.replace(/\/+$/, "");
}

/**
 * 从环境变量解析 provider 配置。
 *
 * `AI_API_KEY` 缺失或为空白 → 返回 null（调用方 fail closed 为 503）；
 * `AI_BASE_URL` / `AI_MODEL` 缺失 → 使用官方缺省值，不算配置错误。
 */
export function resolveAnalysisConfig(
  env: Record<string, string | undefined> = process.env,
): AnalysisClientConfig | null {
  const apiKey = env.AI_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    baseUrl: normalizeBaseUrl(env.AI_BASE_URL),
    apiKey,
    model: env.AI_MODEL?.trim() || DEFAULT_AI_MODEL,
  };
}

/**
 * 配置守卫：缺 `AI_API_KEY` 时立即抛 503，文案与 `requestAnalysisCompletion` 完全一致。
 *
 * 存在的意义是**让调用方在选择事实之前就失败**（route 早失败）：配置缺失是环境问题，
 * 不应该先下载并解析全部 PDF 再报错。
 */
export function requireAnalysisConfig(
  env: Record<string, string | undefined> = process.env,
): AnalysisClientConfig {
  const config = resolveAnalysisConfig(env);
  if (!config) throw new CaptureOperationError(AI_NOT_CONFIGURED_MESSAGE, 503);
  return config;
}

export type AnalysisCompletionOptions = {
  /** 仅供测试注入（与 `loadCapture` / `readPages` 同一注入模式）；缺省即全局 `fetch`。 */
  fetchImpl?: typeof fetch;
  /** 仅供测试注入；缺省从 `process.env` 解析。 */
  config?: AnalysisClientConfig;
  /** 仅供测试注入；缺省 `ANALYSIS_REQUEST_TIMEOUT_MS`。 */
  timeoutMs?: number;
};

function isAbortError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return (
    name === "TimeoutError" || name === "AbortError" || code === "ABORT_ERR"
  );
}

/** 严格按 `choices[0].message.content` 取值；任何缺失或非字符串都算响应异常。 */
function readCompletionContent(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices.length) return null;
  const message = (choices[0] as { message?: unknown } | null)?.message;
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" && content.trim() ? content : null;
}

/**
 * 调用 LLM 并返回其**原始输出字符串**。
 *
 * 未配置 key 时明确 fail closed（503），而不是静默返回空草稿。
 */
export async function requestAnalysisCompletion(
  request: AnalysisCompletionRequest,
  options: AnalysisCompletionOptions = {},
): Promise<string> {
  const config = options.config ?? requireAnalysisConfig();
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? ANALYSIS_REQUEST_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      // 请求体只允许出现四类内容：模型名、两段提示词、固定输出约束、固定推理开关。
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        response_format: { type: "json_object" },
        // 第一版明确关闭 thinking：本任务是对**已验证结构化事实**做固定栏目归纳，
        // 优先低延迟与稳定的 JSON 输出；只有输出质量不足时才单独比较 thinking on/off。
        thinking: { type: "disabled" },
        stream: false,
      }),
      // 60 秒无响应即主动中止；不重试（见文件头「失败」）。
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (error) {
    if (isAbortError(error))
      throw new CaptureOperationError(AI_TIMEOUT_MESSAGE, 504);
    throw new CaptureOperationError(AI_NETWORK_FAILED_MESSAGE, 502);
  }

  if (!response.ok)
    throw new CaptureOperationError(
      aiUpstreamFailedMessage(response.status),
      502,
    );

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CaptureOperationError(AI_RESPONSE_MALFORMED_MESSAGE, 502);
  }

  const content = readCompletionContent(body);
  if (content === null)
    throw new CaptureOperationError(AI_RESPONSE_MALFORMED_MESSAGE, 502);
  return content;
}
