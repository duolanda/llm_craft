import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  CreateLLMPresetRequest,
  LLMPresetSummary,
  OpenAICompatibleReasoningEffort,
  TestLLMPresetRequest,
  TestLLMPresetResponse,
  UpdateLLMPresetRequest,
} from "@llmcraft/shared";

type ProviderType = CreateLLMPresetRequest["providerType"];

interface PresetFormState {
  name: string;
  providerType: ProviderType;
  baseURL: string;
  model: string;
  apiKey: string;
  rpm: string;
  reasoningEffort: "" | OpenAICompatibleReasoningEffort;
  extraRequestParams: string;
}

interface SettingsPanelProps {
  presets: LLMPresetSummary[];
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void> | void;
  onCreate: (input: CreateLLMPresetRequest) => Promise<void>;
  onUpdate: (presetId: string, input: UpdateLLMPresetRequest) => Promise<void>;
  onDelete: (presetId: string) => Promise<void>;
  onTest: (input: TestLLMPresetRequest) => Promise<TestLLMPresetResponse>;
}

const DEFAULT_FORM: PresetFormState = {
  name: "",
  providerType: "openai-compatible",
  baseURL: "",
  model: "",
  apiKey: "",
  rpm: "",
  reasoningEffort: "",
  extraRequestParams: "",
};

const FORBIDDEN_EXTRA_REQUEST_PARAMS = new Set(["model", "messages", "tools", "tool_choice", "stream", "signal"]);

function formatExtraRequestParams(params: Record<string, unknown> | null | undefined): string {
  return params && Object.keys(params).length > 0 ? JSON.stringify(params, null, 2) : "";
}

function parseExtraRequestParams(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("高级请求参数必须是 JSON object。");
  }

  const params = parsed as Record<string, unknown>;
  for (const key of Object.keys(params)) {
    if (FORBIDDEN_EXTRA_REQUEST_PARAMS.has(key)) {
      throw new Error(`高级请求参数不能覆盖 ${key}。`);
    }
  }

  return Object.keys(params).length > 0 ? params : null;
}

export function SettingsPanel({
  presets,
  loading,
  error,
  onRefresh,
  onCreate,
  onUpdate,
  onDelete,
  onTest,
}: SettingsPanelProps) {
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [selectionInitialized, setSelectionInitialized] = useState(false);
  const [form, setForm] = useState<PresetFormState>(DEFAULT_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [testing, setTesting] = useState(false);
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
      rpm: selectedPreset.rpm ? String(selectedPreset.rpm) : "",
      reasoningEffort: selectedPreset.reasoningEffort ?? "",
      extraRequestParams: formatExtraRequestParams(selectedPreset.extraRequestParams),
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

  const readValidatedProviderFields = (options: { requireName: boolean; requireApiKey: boolean }) => {
    if (options.requireName && !form.name.trim()) {
      throw new Error("名称不能为空。");
    }
    if (!form.baseURL.trim() || !form.model.trim()) {
      throw new Error("Base URL 和模型名称不能为空。");
    }
    if (options.requireApiKey && !form.apiKey.trim()) {
      throw new Error("新建预设或测试未保存配置时必须填写 API Key。");
    }
    const trimmedRpm = form.rpm.trim();
    const parsedRpm = trimmedRpm ? Number(trimmedRpm) : null;
    if (trimmedRpm && (parsedRpm === null || !Number.isInteger(parsedRpm) || parsedRpm <= 0)) {
      throw new Error("RPM 必须是正整数，留空表示不限制。");
    }
    const rpm = parsedRpm;
    const extraRequestParams = parseExtraRequestParams(form.extraRequestParams);
    const reasoningEffort = form.reasoningEffort || null;

    return {
      providerType: form.providerType,
      baseURL: form.baseURL.trim(),
      model: form.model.trim(),
      apiKey: form.apiKey.trim(),
      rpm,
      reasoningEffort,
      extraRequestParams,
    };
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLocalError(null);
    setStatusMessage(null);

    let fields: ReturnType<typeof readValidatedProviderFields>;
    try {
      fields = readValidatedProviderFields({
        requireName: true,
        requireApiKey: !selectedPresetId,
      });
    } catch (validationError) {
      setLocalError(validationError instanceof Error ? validationError.message : String(validationError));
      return;
    }

    setSaving(true);
    try {
      if (selectedPresetId) {
        const payload: UpdateLLMPresetRequest = {
          name: form.name.trim(),
          providerType: fields.providerType,
          baseURL: fields.baseURL,
          model: fields.model,
          rpm: fields.rpm,
          reasoningEffort: fields.reasoningEffort,
          extraRequestParams: fields.extraRequestParams,
        };
        if (fields.apiKey) {
          payload.apiKey = fields.apiKey;
        }
        await onUpdate(selectedPresetId, payload);
        setStatusMessage("预设已更新。");
      } else {
        await onCreate({
          name: form.name.trim(),
          providerType: fields.providerType,
          baseURL: fields.baseURL,
          model: fields.model,
          apiKey: fields.apiKey,
          rpm: fields.rpm,
          reasoningEffort: fields.reasoningEffort,
          extraRequestParams: fields.extraRequestParams,
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

  const handleTest = async () => {
    setLocalError(null);
    setStatusMessage(null);

    let fields: ReturnType<typeof readValidatedProviderFields>;
    try {
      fields = readValidatedProviderFields({
        requireName: false,
        requireApiKey: !selectedPresetId,
      });
    } catch (validationError) {
      setLocalError(validationError instanceof Error ? validationError.message : String(validationError));
      return;
    }

    setTesting(true);
    try {
      const result = await onTest({
        presetId: selectedPresetId || undefined,
        providerType: fields.providerType,
        baseURL: fields.baseURL,
        model: fields.model,
        apiKey: fields.apiKey || undefined,
        rpm: fields.rpm,
        reasoningEffort: fields.reasoningEffort,
        extraRequestParams: fields.extraRequestParams,
      });
      const responsePreview = result.responseText ? ` · ${result.responseText.slice(0, 80)}` : "";
      setStatusMessage(`API 测试通过，耗时 ${result.latencyMs}ms${responsePreview}`);
    } catch (testError) {
      setLocalError(testError instanceof Error ? testError.message : String(testError));
    } finally {
      setTesting(false);
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
        <button className="hud-btn hud-btn-ghost" onClick={() => void onRefresh()} disabled={loading || saving || deleting || testing}>
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

          <label className="settings-field">
            <span>RPM</span>
            <input
              className="settings-input"
              type="number"
              min={1}
              step={1}
              value={form.rpm}
              onChange={(event) => setForm((current) => ({ ...current, rpm: event.target.value }))}
              placeholder="留空表示不限制"
            />
          </label>

          <label className="settings-field">
            <span>reasoning_effort</span>
            <select
              className="settings-select"
              value={form.reasoningEffort}
              onChange={(event) => setForm((current) => ({
                ...current,
                reasoningEffort: event.target.value as PresetFormState["reasoningEffort"],
              }))}
            >
              <option value="">不传 reasoning_effort</option>
              <option value="minimal">minimal</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="xhigh">xhigh</option>
            </select>
            <small className="settings-help">
              OpenAI-compatible 快捷字段；高级 JSON 中的 reasoning_effort 会覆盖这里。
            </small>
          </label>

          <label className="settings-field settings-field-wide">
            <span>高级请求参数 JSON（保存为 extraRequestParams）</span>
            <textarea
              className="settings-input settings-textarea"
              value={form.extraRequestParams}
              onChange={(event) => setForm((current) => ({ ...current, extraRequestParams: event.target.value }))}
              placeholder={'例如 {"thinking":{"type":"disabled"},"max_tokens":512}'}
              rows={5}
            />
            <small className="settings-help">
              发送时会展开进 chat completions 请求体，相当于 Python SDK 的 extra_body 内容。可覆盖 reasoning_effort、max_tokens、temperature、thinking 等；不能覆盖 model、messages、tools、tool_choice、stream、signal。
            </small>
          </label>
        </div>

        <div className="settings-meta">
          {selectedPreset && (
            <>
              <span className="replay-meta-chip">已保存 Key: {selectedPreset.hasApiKey ? "YES" : "NO"}</span>
              <span className="replay-meta-chip">RPM: {selectedPreset.rpm ?? "UNLIMITED"}</span>
              <span className="replay-meta-chip">reasoning: {selectedPreset.reasoningEffort ?? "DEFAULT"}</span>
              <span className="replay-meta-chip">extra: {selectedPreset.extraRequestParams ? "YES" : "NO"}</span>
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
          <button className="hud-btn hud-btn-start" type="submit" disabled={saving || deleting || testing}>
            {saving ? "提交中" : selectedPresetId ? "更新预设" : "创建预设"}
          </button>
          <button
            className="hud-btn hud-btn-ghost"
            type="button"
            onClick={() => void handleTest()}
            disabled={saving || deleting || testing}
          >
            {testing ? "测试中" : "测试 API"}
          </button>
          <button
            className="hud-btn hud-btn-ghost"
            type="button"
            onClick={() => resetForm()}
            disabled={saving || deleting || testing}
          >
            清空
          </button>
          <button
            className="hud-btn hud-btn-stop"
            type="button"
            onClick={() => void handleDelete()}
            disabled={!selectedPresetId || saving || deleting || testing}
          >
            {deleting ? "删除中" : "删除预设"}
          </button>
        </div>
      </form>
    </div>
  );
}
