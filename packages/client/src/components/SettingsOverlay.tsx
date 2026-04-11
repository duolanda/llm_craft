import { ReactNode } from "react";

interface SettingsOverlayProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export function SettingsOverlay({ open, title, onClose, children }: SettingsOverlayProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="settings-overlay">
      <div className="settings-dialog hud-panel">
        <div className="hud-panel-top-corners" />
        <div className="hud-panel-bottom-corners" />
        <div className="settings-dialog-header">
          <div className="panel-header">
            <span className="panel-header-accent accent-red">{title}</span>
          </div>
          <button
            type="button"
            className="hud-btn hud-btn-ghost settings-dialog-close"
            onClick={onClose}
            aria-label="关闭模型预设设置"
          >
            关闭
          </button>
        </div>
        <div className="settings-dialog-body">{children}</div>
      </div>
    </div>
  );
}
