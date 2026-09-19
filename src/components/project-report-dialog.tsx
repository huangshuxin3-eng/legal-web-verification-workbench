"use client";

import { useRef, useState } from "react";
import { captureRequest, CaptureClientError } from "@/lib/capture-client";
import { errorMessage } from "@/lib/tasks";
import { REPORT_SOURCE_NAME, REPORT_TOPIC } from "@/lib/report-names";
import {
  ANALYSIS_DRAFT_LABEL,
  ANALYSIS_RESPONSE_INVALID_MESSAGE,
  ANALYSIS_SECTION_KEYS,
  ANALYSIS_SECTION_TITLES,
  ANALYSIS_SESSION_ONLY_NOTE,
  type AnalysisDraft,
} from "@/lib/analysis-names";
import { useAuth } from "./auth-provider";
import { Dialog } from "./dialog";

/** 与导出弹窗同源的文件名解析：服务端下发 UTF-8 的 Content-Disposition。 */
function responseFilename(response: Response) {
  const header = response.headers.get("content-disposition") ?? "";
  const encoded = header.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (!encoded) return "尽调报告.docx";
  try {
    return decodeURIComponent(encoded);
  } catch {
    return "尽调报告.docx";
  }
}

export function ProjectReportDialog({
  projectId,
  projectName,
  taskCount,
  captureCount,
  onClose,
  onGenerated,
}: {
  projectId: string;
  projectName: string;
  taskCount: number;
  captureCount: number;
  onClose: () => void;
  onGenerated: () => void;
}) {
  const { db } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  // AI 分析草稿（Slice 1）：只在本次弹窗会话内存在，不落库、不进 DOCX。
  const [analysis, setAnalysis] = useState<AnalysisDraft | null>(null);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [analysisError, setAnalysisError] = useState("");
  const analysisLock = useRef(false);

  async function generate() {
    if (lock.current || !captureCount) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await captureRequest(
        db,
        `/api/projects/${projectId}/report`,
      );
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = responseFilename(response);
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      onGenerated();
    } catch (error) {
      setError(
        error instanceof CaptureClientError
          ? error.message
          : errorMessage(error),
      );
      lock.current = false;
      setBusy(false);
    }
  }

  /** 服务端草稿必须恰好是四段非空字符串；否则按请求失败处理，不显示半成品。 */
  function readDraft(body: unknown): AnalysisDraft {
    const draft = (body as { draft?: unknown } | null)?.draft;
    if (!draft || typeof draft !== "object" || Array.isArray(draft))
      throw new CaptureClientError(ANALYSIS_RESPONSE_INVALID_MESSAGE);
    const source = draft as Record<string, unknown>;
    const next = {} as AnalysisDraft;
    for (const key of ANALYSIS_SECTION_KEYS) {
      const value = source[key];
      if (typeof value !== "string" || !value.trim())
        throw new CaptureClientError(ANALYSIS_RESPONSE_INVALID_MESSAGE);
      next[key] = value;
    }
    return next;
  }

  /** 生成分析草稿：事实由服务端解析，客户端不提交任何事实或提示词文本。 */
  async function generateAnalysis() {
    if (analysisLock.current || !captureCount) return;
    analysisLock.current = true;
    setAnalysisBusy(true);
    setAnalysisError("");
    try {
      const response = await captureRequest(
        db,
        `/api/projects/${projectId}/analysis`,
        { method: "POST" },
      );
      setAnalysis(readDraft(await response.json().catch(() => null)));
    } catch (error) {
      // 失败即清空草稿：宁可没有草稿，也不留下看起来可用的半成品。
      setAnalysis(null);
      setAnalysisError(
        error instanceof CaptureClientError
          ? error.message
          : errorMessage(error),
      );
    } finally {
      analysisLock.current = false;
      setAnalysisBusy(false);
    }
  }

  return (
    <Dialog title="生成尽调报告" onClose={onClose} busy={busy || analysisBusy}>
      <p className="text-sm text-slate-600">
        报告范围为本项目中「{REPORT_SOURCE_NAME}」的{REPORT_TOPIC}
        任务，每个任务只取当前检索词对应的详情留痕；列表页自动排除。
      </p>
      <dl className="my-5 rounded-lg bg-slate-50 p-4 text-sm">
        {[
          ["项目名称（报告标题）", projectName],
          [`${REPORT_TOPIC}任务数量`, taskCount],
          ["留痕文件数量", captureCount],
          ["核查日", "取自实际纳入报告的详情留痕日期"],
        ].map(([label, value]) => (
          <div key={label} className="mt-2 flex gap-6 first:mt-0">
            <dt className="shrink-0 text-slate-500">{label}</dt>
            <dd className="ml-auto break-words text-right font-semibold">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mb-4 text-xs text-slate-500">
        报告为开发验证草稿，需人工核对后使用；生成过程需要读取并解析全部详情留痕，请耐心等待。
      </p>
      {!captureCount && (
        <p className="error mb-4" role="alert">
          当前项目暂无可用于生成报告的执行详情留痕。
        </p>
      )}
      {error && (
        <p className="error mb-4" role="alert">
          {error}
        </p>
      )}
      {analysisError && (
        <p className="error mb-4" role="alert">
          {analysisError}
        </p>
      )}
      {analysis && (
        <section className="mt-5 border-t border-slate-200 pt-4">
          <h3 className="text-sm font-semibold">{ANALYSIS_DRAFT_LABEL}</h3>
          <p className="mt-1 text-xs text-slate-500">
            {ANALYSIS_SESSION_ONLY_NOTE}
          </p>
          <div className="mt-3 space-y-3">
            {ANALYSIS_SECTION_KEYS.map((key) => (
              <label key={key} className="block">
                <span className="text-sm text-slate-600">
                  {ANALYSIS_SECTION_TITLES[key]}
                </span>
                <textarea
                  className="mt-1 w-full rounded-lg border border-slate-200 p-2 text-sm"
                  rows={4}
                  value={analysis[key]}
                  disabled={analysisBusy}
                  onChange={(event) => {
                    const value = event.target.value;
                    setAnalysis((previous) =>
                      previous ? { ...previous, [key]: value } : previous,
                    );
                  }}
                />
              </label>
            ))}
          </div>
        </section>
      )}
      <div className="flex justify-end gap-3">
        <button className="btn" disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          className="btn"
          disabled={analysisBusy || busy || !captureCount}
          onClick={() => void generateAnalysis()}
        >
          {analysisBusy ? "正在分析…" : "生成 AI 分析"}
        </button>
        <button
          className="btn primary"
          disabled={busy || !captureCount}
          onClick={() => void generate()}
        >
          {busy ? "正在生成…" : "生成报告"}
        </button>
      </div>
    </Dialog>
  );
}
