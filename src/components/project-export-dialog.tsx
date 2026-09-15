"use client";

import { useRef, useState } from "react";
import { captureRequest, CaptureClientError } from "@/lib/capture-client";
import { errorMessage } from "@/lib/tasks";
import { useAuth } from "./auth-provider";
import { Dialog } from "./dialog";

function responseFilename(response: Response) {
  const header = response.headers.get("content-disposition") ?? "";
  const encoded = header.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (!encoded) return "网核成果.zip";
  try {
    return decodeURIComponent(encoded);
  } catch {
    return "网核成果.zip";
  }
}

export function ProjectExportDialog({
  projectId,
  projectName,
  entityCount,
  taskCount,
  captureCount,
  onClose,
  onGenerated,
}: {
  projectId: string;
  projectName: string;
  entityCount: number;
  taskCount: number;
  captureCount: number;
  onClose: () => void;
  onGenerated: () => void;
}) {
  const { db } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);

  async function generate() {
    if (lock.current || !captureCount) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await captureRequest(
        db,
        `/api/projects/${projectId}/export`,
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

  return (
    <Dialog title="导出网核成果" onClose={onClose} busy={busy}>
      <p className="text-sm text-slate-600">
        仅导出至少存在 1 份留痕的核查任务。
      </p>
      <dl className="my-5 rounded-lg bg-slate-50 p-4 text-sm">
        {[
          ["项目名称", projectName],
          ["核查对象数量", entityCount],
          ["有底稿的 Task 数量", taskCount],
          ["Capture / 底稿文件数量", captureCount],
        ].map(([label, value]) => (
          <div key={label} className="mt-2 flex gap-6 first:mt-0">
            <dt className="shrink-0 text-slate-500">{label}</dt>
            <dd className="ml-auto break-words text-right font-semibold">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {!captureCount && (
        <p className="error mb-4" role="alert">
          当前项目暂无可导出的底稿。
        </p>
      )}
      {error && (
        <p className="error mb-4" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-3">
        <button className="btn" disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          className="btn primary"
          disabled={busy || !captureCount}
          onClick={() => void generate()}
        >
          {busy ? "正在生成…" : "生成成果包"}
        </button>
      </div>
    </Dialog>
  );
}
