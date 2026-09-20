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
    <Dialog title="导出成果" onClose={onClose} busy={busy}>
      <p className="text-xs font-medium text-slate-400">{projectName}</p>
      <p className="mt-2 text-sm text-slate-600">
        成果包包含结构化核查结果及对应证据留痕。
      </p>
      <div className="mt-6">
        <p className="text-sm font-semibold text-slate-800">本次导出</p>
      </div>
      <dl className="my-4 divide-y divide-slate-100 rounded-xl bg-slate-50/80 px-4 text-sm">
        {[
          ["核查对象", entityCount],
          ["核查任务", taskCount],
          ["证据留痕", captureCount],
        ].map(([label, value]) => (
          <div key={label} className="flex items-center gap-6 py-3">
            <dt className="shrink-0 text-slate-500">{label}</dt>
            <dd className="ml-auto break-words text-right text-base font-semibold text-slate-900">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {!captureCount && (
        <p className="error mb-4" role="alert">
          当前项目暂无可导出的证据留痕。
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
          {busy ? "正在生成…" : "下载成果包"}
        </button>
      </div>
    </Dialog>
  );
}
