"use client";
import { useEffect, useId, useRef } from "react";
export function Dialog({
  title,
  onClose,
  children,
  drawer = false,
  busy = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  drawer?: boolean;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    el?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      el?.close();
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      className={
        drawer
          ? "fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-dvh w-full max-w-lg border-l border-slate-200 bg-white p-6 shadow-xl"
          : "fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-lg rounded-xl bg-white p-6 shadow-xl"
      }
    >
      <div className="mb-6 flex items-center justify-between">
        <h2 id={titleId} className="text-lg font-semibold">
          {title}
        </h2>
        <button
          type="button"
          className="btn"
          aria-label="关闭"
          disabled={busy}
          onClick={onClose}
        >
          关闭
        </button>
      </div>
      {children}
    </dialog>
  );
}
