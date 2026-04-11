import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  CreateLLMPresetRequest,
  LLMPresetSummary,
  UpdateLLMPresetRequest,
} from "@llmcraft/shared";

type ProviderType = CreateLLMPresetRequest["providerType"];

interface PresetFormState {
  name: string;
  providerType: ProviderType;
  baseURL: string;
  model: string;
  apiKey: string;
}

interface SettingsPanelProps {
  presets: LLMPresetSummary[];
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void> | void;
  onCreate: (input: CreateLLMPresetRequest) => Promise<void>;
  onUpdate: (presetId: string, input: UpdateLLMPresetRequest) => Promise<void>;
  onDelete: (presetId: string) => Promise<void>;
}

const DEFAULT_FORM: PresetFormState = {
  name: "",
  providerType: "openai-compatible",
  baseURL: "",
  model: "",
  apiKey: "",
};

export function SettingsPanel({
  presets,
  loading,
  error,
  onRefresh,
  onCreate,
  onUpdate,
  onDelete,
}: SettingsPanelProps) {
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [selectionInitialized, setSelectionInitialized] = useState(false);
  const [form, setForm] = useState<PresetFormState>(DEFAULT_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.id === selectedPresetId) ?? null,
    [presets, selectedPresetId]
  );

  useEffect(() => {
    if (presets.length === 0) {
      setSelectedPresetId("");
      setSelectionInitialized(false);
      setForm(DEFAULT_FORM);
      return;
    }

    const stillExists = presets.some((preset) => preset.id === selectedPresetId);
    if (selectedPresetId && !stillExists) {
      setSelectedPresetId(presets[0]?.id ?? "");
      setSelectionInitialized(true);
      return;
    }

    if (!selectionInitialized && !selectedPresetId) {
      setSelectedPresetId(presets[0]?.id ?? "");
      setSelectionInitialized(true);
    }
  }, [presets, selectedPresetId, selectionInitialized]);

  useEffect(() => {
    if (!selectedPreset) {
      if (!selectedPresetId) {
        setForm(DEFAULT_FORM);
      }
      return;
    }

    setForm({
      name: selectedPreset.name,
      providerType: selectedPreset.providerType,
      baseURL: selectedPreset.baseURL,
      model: selectedPreset.model,
      apiKey: "",
    });
  }, [selectedPreset]);

  const resetForm = (options?: { clearStatus?: boolean }) => {
    setSelectedPresetId("");
    setSelectionInitialized(true);
    setForm(DEFAULT_FORM);
    setLocalError(null);
    if (options?.clearStatus !== false) {
      setStatusMessage(null);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLocalError(null);
    setStatusMessage(null);

    if (!form.name.trim() || !form.baseURL.trim() || !form.model.trim()) {
      setLocalError("名称、Base URL 和模型名称不能为空。");
      return;
    }

    if (!selectedPresetId && !form.apiKey.trim()) {
      setLocalError("新建预设时必须填写 API Key。");
      return;
    }

    setSaving(true);
    try {
      if (selectedPresetId) {
        const payload: UpdateLLMPresetRequest = {
          name: form.name.trim(),
          providerType: form.providerType,
          baseURL: form.baseURL.trim(),
          model: form.model.trim(),
        };
        if (form.apiKey.trim()) {
          payload.apiKey = form.apiKey.trim();
        }
        await onUpdate(selectedPresetId, payload);
        setStatusMessage("预设已更新。");
      } else {
        await onCreate({
          name: form.name.trim(),
          providerType: form.providerType,
          baseURL: form.baseURL.trim(),
          model: form.model.trim(),
          apiKey: form.apiKey.trim(),
        });
        resetForm({ clearStatus: false });
        setStatusMessage("预设已创建。");
      }
    } catch (submitError) {
      setLocalError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedPresetId) {
      return;
    }

    setDeleting(true);
    setLocalError(null);
    setStatusMessage(null);
    try {
      await onDelete(selectedPresetId);
      resetForm({ clearStatus: false });
      setStatusMessage("预设已删除。");
    } catch (deleteError) {
      setLocalError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setDeleting(false);
    }
  };

  const effectiveError = localError ?? error;

  return (
    <div className="settings-panel">
      <div className="settings-toolbar">
        <label className="settings-field">
          <span>预设列表</span>
          <select
            className="settings-select"
            value={selectedPresetId}
            onChange={(event) => {
              setSelectedPresetId(event.target.value);
              setSelectionInitialized(true);
              setLocalError(null);
              setStatusMessage(null);
            }}
            disabled={loading || presets.length === 0}
          >
            <option value="">新建预设</option>
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </label>
        <button className="hud-btn hud-btn-ghost" onClick={() => void onRefresh()} disabled={loading || saving || deleting}>
          {loading ? "刷新中" : "刷新"}
        </button>
      </div>

      <form className="settings-form" onSubmit={(event) => void handleSubmit(event)}>
        <div className="settings-grid">
          <label className="settings-field">
            <span>名称</span>
            <input
              className="settings-input"
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              placeholder="例如 Red Alpha"
            />
          </label>

          <label className="settings-field">
            <span>Provider</span>
            <select
              className="settings-select"
              value={form.providerType}
              onChange={(event) => setForm((current) => ({
                ...current,
                providerType: event.target.value as ProviderType,
              }))}
            >
              <option value="openai-compatible">OpenAI-compatible</option>
            </select>
          </label>

          <label className="settings-field settings-field-wide">
            <span>Base URL</span>
            <input
              className="settings-input"
              value={form.baseURL}
              onChange={(event) => setForm((current) => ({ ...current, baseURL: event.target.value }))}
              placeholder="https://api.example.com/v1"
            />
          </label>

          <label className="settings-field">
            <span>模型</span>
            <input
              className="settings-input"
              value={form.model}
              onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))}
              placeholder="gpt-4.1-mini"
            />
          </label>

          <label className="settings-field">
            <span>API Key</span>
            <input
              className="settings-input"
              type="password"
              autoComplete="new-password"
              value={form.apiKey}
              onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))}
              placeholder={selectedPreset?.hasApiKey ? "已保存，留空则保持不变" : "sk-..."}
            />
          </label>
        </div>

        <div className="settings-meta">
          {selectedPreset && (
            <>
              <span className="replay-meta-chip">已保存 Key: {selectedPreset.hasApiKey ? "YES" : "NO"}</span>
              <span className="replay-meta-chip">更新于: {new Date(selectedPreset.updatedAt).toLocaleString()}</span>
            </>
          )}
          {!selectedPreset && <span className="replay-meta-chip">创建新预设时不会显示明文 API Key。</span>}
        </div>

        {(effectiveError || statusMessage) && (
          <div className="settings-feedback">
            {effectiveError && <span className="status-error">{effectiveError}</span>}
            {statusMessage && <span>{statusMessage}</span>}
          </div>
        )}

        <div className="settings-actions">
          <button className="hud-btn hud-btn-start" type="submit" disabled={saving || deleting}>
            {saving ? "提交中" : selectedPresetId ? "更新预设" : "创建预设"}
          </button>
          <button
            className="hud-btn hud-btn-ghost"
            type="button"
            onClick={() => resetForm()}
            disabled={saving || deleting}
          >
            清空
          </button>
          <button
            className="hud-btn hud-btn-stop"
            type="button"
            onClick={() => void handleDelete()}
            disabled={!selectedPresetId || saving || deleting}
          >
            {deleting ? "删除中" : "删除预设"}
          </button>
        </div>
      </form>
    </div>
  );
}
