"use client";

import { useRef, useState } from "react";
import type { TaskWithQueryCount } from "@/lib/queries";
import { captureRequest, CaptureClientError } from "@/lib/capture-client";
import { errorMessage } from "@/lib/tasks";
import { useAuth } from "./auth-provider";
import { Dialog } from "./dialog";

export type BatchTaskDeleteResult = {
  deletedIds: string[];
  failedIds: string[];
};

export function TaskBatchDeleteDialog({
  tasks,
  onClose,
  onCompleted,
}: {
  tasks: TaskWithQueryCount[];
  onClose: () => void;
  onCompleted: (result: BatchTaskDeleteResult) => void;
}) {
  const { db } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const queryCount = tasks.reduce(
    (sum, task) => sum + (task.queries[0]?.count ?? 0),
    0,
  );
  const captureCount = tasks.reduce((sum, task) => sum + task.capture_count, 0);

  async function remove() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await captureRequest(db, "/api/tasks/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskIds: tasks.map((task) => task.id) }),
      });
      onCompleted((await response.json()) as BatchTaskDeleteResult);
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
    <Dialog title="批量永久删除任务" onClose={onClose} busy={busy}>
      <p className="text-sm leading-6">
        相关核查任务、检索批次、证据留痕及对应私有文件将永久删除，无法恢复。
      </p>
      <dl className="my-5 rounded-lg bg-red-50 p-4 text-sm">
        {[
          ["核查任务", tasks.length],
          ["检索批次", queryCount],
          ["证据留痕", captureCount],
        ].map(([label, count]) => (
          <div key={label} className="mt-2 flex justify-between first:mt-0">
            <dt>{label}</dt>
            <dd className="font-semibold">{count}</dd>
          </div>
        ))}
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
          {busy ? "删除中…" : `永久删除 ${tasks.length} 个任务`}
        </button>
      </div>
    </Dialog>
  );
}
