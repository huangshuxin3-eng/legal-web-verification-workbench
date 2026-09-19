"use client";

import { useEffect, useRef, useState } from "react";
import { captureRequest, CaptureClientError } from "@/lib/capture-client";
import { errorMessage } from "@/lib/tasks";
import { REPORT_SOURCE_NAME, REPORT_TOPIC } from "@/lib/report-names";
import {
  ANALYSIS_DRAFT_INVALID_MESSAGE,
  ANALYSIS_DRAFT_LABEL,
  ANALYSIS_PERSISTED_NOTE,
  ANALYSIS_RESPONSE_INVALID_MESSAGE,
  ANALYSIS_SECTION_KEYS,
  ANALYSIS_SECTION_TITLES,
  ANALYSIS_STATUS_LABELS,
  analysisDraftStatus,
  readAnalysisDraftRecord,
  type AnalysisDraft,
  type AnalysisDraftRecord,
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

/** 草稿操作的进行态；`"load"` 只是恢复已保存草稿，不阻塞弹窗关闭。 */
type DraftBusy = null | "load" | "generate" | "save" | "confirm";

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
  // AI 分析草稿（Slice 2）：草稿在服务端，本地只持有「最近一次已保存版本」+「编辑中内容」。
  // 两者不一致即为 dirty —— 状态文案与按钮可用性都由它派生，不做自动保存。
  const [record, setRecord] = useState<AnalysisDraftRecord | null>(null);
  const [sections, setSections] = useState<AnalysisDraft | null>(null);
  const [draftBusy, setDraftBusy] = useState<DraftBusy>(null);
  const [draftError, setDraftError] = useState("");
  const draftLock = useRef(false);

  /** 打开弹窗即恢复已保存草稿：没有就保持空，不报错。 */
  useEffect(() => {
    let active = true;
    setDraftBusy("load");
    setDraftError("");
    captureRequest(db, `/api/projects/${projectId}/analysis`)
      .then(async (response) => {
        const loaded = readRecord(await response.json().catch(() => null));
        if (!active) return;
        setRecord(loaded);
        setSections(loaded ? { ...loaded.sections } : null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setDraftError(
          error instanceof CaptureClientError
            ? error.message
            : errorMessage(error),
        );
      })
      .finally(() => {
        if (active) setDraftBusy(null);
      });
    return () => {
      active = false;
    };
  }, [db, projectId]);

  /** 服务端记录必须过 `readAnalysisDraftRecord`；形状不合法一律按请求失败处理。 */
  function readRecord(body: unknown): AnalysisDraftRecord | null {
    const raw = (body as { record?: unknown } | null)?.record ?? null;
    if (raw === null) return null;
    const parsed = readAnalysisDraftRecord(raw);
    if (!parsed) throw new CaptureClientError(ANALYSIS_DRAFT_INVALID_MESSAGE);
    return parsed;
  }

  function failureText(error: unknown) {
    return error instanceof CaptureClientError
      ? error.message
      : errorMessage(error);
  }

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
      setError(failureText(error));
      lock.current = false;
      setBusy(false);
    }
  }

  /**
   * 生成分析草稿：事实由服务端解析，客户端不提交任何事实或提示词文本。
   * 生成成功后服务端已自动保存，响应的就是落库后的记录。
   */
  async function generateAnalysis() {
    if (draftLock.current || !captureCount) return;
    draftLock.current = true;
    setDraftBusy("generate");
    setDraftError("");
    try {
      const response = await captureRequest(
        db,
        `/api/projects/${projectId}/analysis`,
        { method: "POST" },
      );
      const next = readRecord(await response.json().catch(() => null));
      if (!next)
        throw new CaptureClientError(ANALYSIS_RESPONSE_INVALID_MESSAGE);
      setRecord(next);
      setSections({ ...next.sections });
    } catch (error) {
      // 失败**不清空**既有草稿：已保存的那一份仍然有效，重新生成失败不应把它一起毁掉。
      setDraftError(failureText(error));
    } finally {
      draftLock.current = false;
      setDraftBusy(null);
    }
  }

  /**
   * 人工保存 / 人工确认：请求体只有 `{ action, sections }`。
   * `save` 之后服务端必然把 `confirmedAt` 清空（任何修改都要重新确认）。
   */
  async function writeAnalysis(action: "save" | "confirm") {
    if (draftLock.current || !record || !sections) return;
    draftLock.current = true;
    setDraftBusy(action);
    setDraftError("");
    try {
      const response = await captureRequest(
        db,
        `/api/projects/${projectId}/analysis`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, sections }),
        },
      );
      const next = readRecord(await response.json().catch(() => null));
      if (!next)
        throw new CaptureClientError(ANALYSIS_RESPONSE_INVALID_MESSAGE);
      setRecord(next);
      setSections({ ...next.sections });
    } catch (error) {
      // 保存失败时保留本地编辑内容，用户不必重打一遍。
      setDraftError(failureText(error));
    } finally {
      draftLock.current = false;
      setDraftBusy(null);
    }
  }

  const dirty =
    !!record &&
    !!sections &&
    ANALYSIS_SECTION_KEYS.some((key) => sections[key] !== record.sections[key]);
  const status = analysisDraftStatus(record, dirty);
  const working = draftBusy !== null && draftBusy !== "load";

  return (
    <Dialog title="生成尽调报告" onClose={onClose} busy={busy || working}>
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
      {draftError && (
        <p className="error mb-4" role="alert">
          {draftError}
        </p>
      )}
      <section className="mt-5 border-t border-slate-200 pt-4">
        <h3 className="text-sm font-semibold">{ANALYSIS_DRAFT_LABEL}</h3>
        <p className="mt-1 text-xs text-slate-500">
          {record
            ? `${ANALYSIS_PERSISTED_NOTE}（对应核查日 ${record.checkDate}）`
            : ANALYSIS_PERSISTED_NOTE}
        </p>
        {record && (
          <p className="mt-1 text-xs font-semibold text-slate-600">
            状态：{ANALYSIS_STATUS_LABELS[status]}
          </p>
        )}
        {sections ? (
          <div className="mt-3 space-y-3">
            {ANALYSIS_SECTION_KEYS.map((key) => (
              <label key={key} className="block">
                <span className="text-sm text-slate-600">
                  {ANALYSIS_SECTION_TITLES[key]}
                </span>
                <textarea
                  className="mt-1 w-full rounded-lg border border-slate-200 p-2 text-sm"
                  rows={4}
                  value={sections[key]}
                  disabled={working}
                  onChange={(event) => {
                    const value = event.target.value;
                    setSections((previous) =>
                      previous ? { ...previous, [key]: value } : previous,
                    );
                  }}
                />
              </label>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-sm text-slate-500">
            {draftBusy === "load"
              ? "正在读取已保存的分析草稿…"
              : "尚未生成分析草稿。生成后可在此编辑、保存并确认。"}
          </p>
        )}
      </section>
      <div className="flex flex-wrap justify-end gap-3">
        <button className="btn" disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          className="btn"
          disabled={working || busy || !captureCount}
          onClick={() => void generateAnalysis()}
        >
          {draftBusy === "generate" ? "正在分析…" : "生成 AI 分析"}
        </button>
        <button
          className="btn"
          disabled={working || busy || !record || !dirty}
          onClick={() => void writeAnalysis("save")}
        >
          {draftBusy === "save" ? "正在保存…" : "保存修改"}
        </button>
        <button
          className="btn"
          disabled={
            working || busy || !record || dirty || status === "confirmed"
          }
          onClick={() => void writeAnalysis("confirm")}
        >
          {draftBusy === "confirm" ? "正在确认…" : "确认分析"}
        </button>
        <button
          className="btn primary"
          disabled={busy || !captureCount || dirty}
          onClick={() => void generate()}
        >
          {busy ? "正在生成…" : "生成报告"}
        </button>
      </div>
      {dirty && (
        <p className="mt-2 text-right text-xs text-amber-700">
          请先保存修改并确认分析；未保存的文本不会进入报告。
        </p>
      )}
    </Dialog>
  );
}
