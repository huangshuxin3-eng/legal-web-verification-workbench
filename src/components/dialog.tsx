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
  small = false,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  drawer?: boolean;
  busy?: boolean;
  wide?: boolean;
  formLayout?: boolean;
  small?: boolean;
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
          ? "lt-dialog lt-drawer"
          : `lt-dialog ${wide ? "lt-dialog-wide" : small ? "lt-dialog-small" : formLayout ? "lt-dialog-form" : ""}`
      }
    >
      <div className="lt-modal-layout">
        <div className="lt-modal-header">
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
        <div className="lt-modal-body">{children}</div>
        {footer && <div className="lt-modal-footer">{footer}</div>}
      </div>
    </dialog>
  );
}
