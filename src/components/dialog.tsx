"use client";
import { useEffect, useId, useRef } from "react";
export function Dialog({
  title,
  onClose,
  children,
  drawer = false,
  busy = false,
  wide = false,
  formLayout = false,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  drawer?: boolean;
  busy?: boolean;
  wide?: boolean;
  formLayout?: boolean;
  footer?: React.ReactNode;
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
          ? "fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-dvh w-full max-w-lg overflow-hidden border-l border-slate-200 bg-white p-0 shadow-xl"
          : `fixed inset-0 m-auto max-h-[88dvh] w-[calc(100%-2rem)] overflow-hidden rounded-2xl border border-slate-200/80 bg-white p-0 shadow-xl ${wide ? "max-w-[940px]" : formLayout ? "max-w-[800px]" : "max-w-xl"}`
      }
    >
      <div
        className={
          drawer
            ? "flex h-dvh min-h-0 flex-col"
            : "flex max-h-[88dvh] min-h-0 flex-col"
        }
      >
        <div
          className={`flex shrink-0 items-center justify-between border-b border-slate-100 px-6 ${formLayout ? "py-4" : "py-5"}`}
        >
          <h2 id={titleId} className="text-xl font-semibold tracking-tight">
            {title}
          </h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭"
            disabled={busy}
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <div
          className={`min-h-0 flex-1 overflow-y-auto px-6 ${formLayout ? "py-5 sm:px-7" : "py-5"}`}
        >
          {children}
        </div>
        {footer && (
          <div
            className={`shrink-0 border-t border-slate-100 bg-white/95 px-6 py-4 backdrop-blur ${formLayout ? "sm:px-7" : ""}`}
          >
            {footer}
          </div>
        )}
      </div>
    </dialog>
  );
}
