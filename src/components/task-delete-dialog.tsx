"use client";

import { useRef, useState } from "react";
import type { TaskWithQueryCount } from "@/lib/queries";
import { captureRequest, CaptureClientError } from "@/lib/capture-client";
import { errorMessage } from "@/lib/tasks";
import { useAuth } from "./auth-provider";
import { Dialog } from "./dialog";

export function TaskDeleteDialog({
  task,
  onClose,
  onDeleted,
  onBusyChange,
}: {
  task: TaskWithQueryCount;
  onClose: () => void;
  onDeleted: (taskId: string) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const { db } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const queryCount = task.queries[0]?.count ?? 0;

  async function remove() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      await captureRequest(db, `/api/tasks/${task.id}`, { method: "DELETE" });
      onDeleted(task.id);
    } catch (error) {
      setError(
        error instanceof CaptureClientError
          ? error.message
          : errorMessage(error),
      );
      lock.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  }

  return (
    <Dialog title="永久删除任务" onClose={onClose} busy={busy}>
      <p className="text-sm leading-6">
        删除后，该核查任务及其检索批次、证据留痕和对应私有文件将永久删除，无法恢复。
      </p>
      <p className="mt-4 break-words text-sm font-semibold">
        {task.entity_name} · {task.topic} · {task.source_name}
      </p>
      <dl className="my-5 rounded-lg bg-red-50 p-4 text-sm">
        <div className="flex justify-between">
          <dt>检索批次</dt>
          <dd className="font-semibold">{queryCount}</dd>
        </div>
        <div className="mt-2 flex justify-between">
          <dt>证据留痕</dt>
          <dd className="font-semibold">{task.capture_count}</dd>
        </div>
      </dl>
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
          className="btn border-red-700 bg-red-700 text-white hover:bg-red-800"
          disabled={busy}
          onClick={() => void remove()}
        >
          {busy ? "删除中…" : "永久删除任务"}
        </button>
      </div>
    </Dialog>
  );
}
