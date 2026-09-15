"use client";

import { useRef, useState } from "react";
import type { Project } from "@/lib/database.types";
import { captureRequest, CaptureClientError } from "@/lib/capture-client";
import { errorMessage } from "@/lib/tasks";
import { useAuth } from "./auth-provider";
import { Dialog } from "./dialog";

export function ProjectDeleteDialog({
  project,
  counts,
  onClose,
  onDeleted,
}: {
  project: Project;
  counts: { tasks: number; queries: number; captures: number };
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { db } = useAuth();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const confirmed = name === project.name;

  async function remove() {
    if (lock.current || !confirmed) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await captureRequest(db, `/api/projects/${project.id}`, {
        method: "DELETE",
      });
      onDeleted();
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
    <Dialog title="永久删除项目" onClose={onClose} busy={busy}>
      <p className="text-sm leading-6">
        删除后，该项目及其全部
        Task、Query、留痕记录和对应私有文件将永久删除，无法恢复。
      </p>
      <dl className="my-5 rounded-lg bg-red-50 p-4 text-sm">
        {[
          ["Task 数量", counts.tasks],
          ["Query 数量", counts.queries],
          ["留痕数量", counts.captures],
        ].map(([label, count]) => (
          <div key={label} className="mt-2 flex first:mt-0 justify-between">
            <dt>{label}</dt>
            <dd className="font-semibold">{count}</dd>
          </div>
        ))}
      </dl>
      <label>
        输入完整项目名称“{project.name}”以确认
        <input
          autoFocus
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          autoComplete="off"
        />
      </label>
      {error && (
        <p className="error mt-4" role="alert">
          {error}
        </p>
      )}
      <div className="mt-6 flex justify-end gap-3">
        <button className="btn" disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          className="btn border-red-700 bg-red-700 text-white hover:bg-red-800"
          disabled={busy || !confirmed}
          onClick={() => void remove()}
        >
          {busy ? "删除中…" : "永久删除项目"}
        </button>
      </div>
    </Dialog>
  );
}
