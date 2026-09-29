import { ReactNode, useEffect, useId, useRef } from "react";

interface SettingsOverlayProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export function SettingsOverlay({ open, title, onClose, children }: SettingsOverlayProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const animationFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key === "Tab") {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusableElements = Array.from(dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], summary, input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )).filter((element) => element.getClientRects().length > 0);
        const first = focusableElements[0];
        const last = focusableElements.at(-1);
        if (!first || !last) return;
        if (!dialog.contains(document.activeElement)
          || (event.shiftKey && document.activeElement === first)
          || (!event.shiftKey && document.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="settings-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="settings-dialog hud-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="hud-panel-top-corners" />
        <div className="hud-panel-bottom-corners" />
        <div className="settings-dialog-header">
          <div className="panel-header">
            <span id={titleId} className="panel-header-accent accent-red">{title}</span>
          </div>
          <button
            type="button"
            className="hud-btn hud-btn-ghost settings-dialog-close"
            onClick={onClose}
            aria-label={`关闭${title}`}
            ref={closeButtonRef}
          >
            关闭
          </button>
        </div>
        <div className="settings-dialog-body">{children}</div>
      </div>
    </div>
  );
}
