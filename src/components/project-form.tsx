"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "./auth-provider";
import { Dialog } from "./dialog";
import { errorMessage } from "@/lib/tasks";
export function ProjectForm({ onClose }: { onClose: () => void }) {
  const { db, userId } = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog title="新建项目" onClose={onClose} busy={busy}>
      <form
        className="space-y-5"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          const form = new FormData(e.currentTarget);
          const name = String(form.get("name")).trim();
          if (!name) {
            setError("请填写项目名称。");
            return;
          }
          setBusy(true);
          setError("");
          try {
            const { data, error } = await db
              .from("projects")
              .insert({
                name,
                code: String(form.get("code")).trim() || null,
                owner_id: userId,
              })
              .select("id")
              .single();
            if (error) throw error;
            router.push(`/projects/${data.id}`);
          } catch (error) {
            setError(errorMessage(error));
            setBusy(false);
          }
        }}
      >
        <label>
          项目名称 *<input name="name" autoFocus required />
        </label>
        <label>
          项目编号
          <input name="code" />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-3">
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </button>
          <button className="btn primary" disabled={busy}>
            {busy ? "创建中…" : "创建并进入项目"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
