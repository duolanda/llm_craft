import { FormEvent, useEffect, useMemo, useState } from "react";
import type {
  CreateStrategyPromptRequest,
  MatchPromptSelection,
  StrategyPrompt,
  StrategyPromptVersionProvenance,
  UpdateStrategyPromptRequest,
} from "@llmcraft/shared";
import { formatPromptVersionDate } from "../lib/promptPresentation";
import { PromptVersionOrigin } from "./PromptVersionOrigin";

interface PromptPanelProps {
  prompts: StrategyPrompt[];
  initialSelection?: MatchPromptSelection;
  deletionBlockedPromptIds?: readonly string[];
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void> | void;
  onCreate: (input: CreateStrategyPromptRequest) => Promise<StrategyPrompt>;
  onUpdate: (promptId: string, input: UpdateStrategyPromptRequest) => Promise<StrategyPrompt>;
  onActivateVersion: (promptId: string, versionId: string) => Promise<StrategyPrompt>;
  onDelete: (promptId: string) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  onLoadProvenance?: (promptId: string) => Promise<Record<string, StrategyPromptVersionProvenance>>;
}

interface PromptForm {
  name: string;
  content: string;
}

const EMPTY_FORM: PromptForm = { name: "", content: "" };

function formFromPrompt(prompt: StrategyPrompt): PromptForm {
  return {
    name: prompt.name,
    content: prompt.versions.find((version) => version.id === prompt.activeVersionId)?.content ?? "",
  };
}

export function PromptPanel({
  prompts,
  initialSelection,
  deletionBlockedPromptIds = [],
  loading,
  error,
  onRefresh,
  onCreate,
  onUpdate,
  onActivateVersion,
  onDelete,
  onDirtyChange,
  onLoadProvenance,
}: PromptPanelProps) {
  const initialPrompt = prompts.find((prompt) => prompt.id === initialSelection?.promptId) ?? prompts[0];
  const [selectedPromptId, setSelectedPromptId] = useState(() => initialPrompt?.id ?? "");
  const [selectionInitialized, setSelectionInitialized] = useState(() => Boolean(initialPrompt));
  const [form, setForm] = useState<PromptForm>(() => initialPrompt ? formFromPrompt(initialPrompt) : EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [activatingVersionId, setActivatingVersionId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [provenance, setProvenance] = useState<Record<string, StrategyPromptVersionProvenance>>({});
  const [provenanceLoading, setProvenanceLoading] = useState(false);
  const [provenanceError, setProvenanceError] = useState<string | null>(null);

  const selectedPrompt = useMemo(
    () => prompts.find((prompt) => prompt.id === selectedPromptId) ?? null,
    [prompts, selectedPromptId],
  );
  const baseline = useMemo(
    () => selectedPrompt ? formFromPrompt(selectedPrompt) : EMPTY_FORM,
    [selectedPrompt],
  );
  const dirty = form.name !== baseline.name || form.content !== baseline.content;

  useEffect(() => {
    let cancelled = false;
    setProvenance({});
    setProvenanceError(null);
    if (!selectedPrompt || !onLoadProvenance) {
      setProvenanceLoading(false);
      return;
    }
    setProvenanceLoading(true);
    void onLoadProvenance(selectedPrompt.id)
      .then((result) => { if (!cancelled) setProvenance(result); })
      .catch(() => { if (!cancelled) setProvenanceError("来源信息暂时无法加载，请刷新重试。"); })
      .finally(() => { if (!cancelled) setProvenanceLoading(false); });
    return () => { cancelled = true; };
  }, [selectedPrompt, onLoadProvenance]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (prompts.length === 0) {
      setSelectedPromptId("");
      setSelectionInitialized(false);
      setForm(EMPTY_FORM);
      return;
    }
    if (selectedPromptId && !prompts.some((prompt) => prompt.id === selectedPromptId)) {
      const next = prompts[0]!;
      setSelectedPromptId(next.id);
      setForm(formFromPrompt(next));
      setSelectionInitialized(true);
      return;
    }
    if (!selectionInitialized && !selectedPromptId) {
      const next = prompts[0]!;
      setSelectedPromptId(next.id);
      setForm(formFromPrompt(next));
      setSelectionInitialized(true);
    }
  }, [prompts, selectedPromptId, selectionInitialized]);

  useEffect(() => {
    if (selectedPrompt && !dirty) setForm(formFromPrompt(selectedPrompt));
  }, [selectedPrompt, dirty]);

  const confirmDiscard = () => !dirty || window.confirm("当前有未保存的修改，确定放弃吗？");

  const selectPrompt = (promptId: string) => {
    if (!confirmDiscard()) return;
    const prompt = prompts.find((item) => item.id === promptId);
    setSelectedPromptId(promptId);
    setForm(prompt ? formFromPrompt(prompt) : EMPTY_FORM);
    setSelectionInitialized(true);
    setLocalError(null);
    setStatusMessage(null);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const name = form.name.trim();
    const content = form.content.trim();
    if (!name || !content) {
      setLocalError("名称和 Prompt 内容都不能为空。");
      return;
    }
    const contentChanged = content !== baseline.content;
    if (selectedPromptId && name === baseline.name && !contentChanged) {
      setForm(baseline);
      setLocalError(null);
      setStatusMessage("没有需要保存的更改。");
      return;
    }
    setSaving(true);
    setLocalError(null);
    setStatusMessage(null);
    try {
      if (selectedPromptId) {
        const updated = await onUpdate(selectedPromptId, { name, content });
        setForm(formFromPrompt(updated));
        setStatusMessage(contentChanged ? `已保存为 v${updated.versions.at(-1)?.version ?? updated.versions.length} 并设为当前版本。` : "策略名称已更新。");
      } else {
        const created = await onCreate({ name, content });
        setSelectedPromptId(created.id);
        setForm(formFromPrompt(created));
        setSelectionInitialized(true);
        setStatusMessage("策略 Prompt 已创建。");
      }
    } catch (submitError) {
      setLocalError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSaving(false);
    }
  };

  const handleActivate = async (versionId: string) => {
    if (!selectedPrompt || !confirmDiscard()) return;
    setActivatingVersionId(versionId);
    setLocalError(null);
    setStatusMessage(null);
    try {
      const updated = await onActivateVersion(selectedPrompt.id, versionId);
      setForm(formFromPrompt(updated));
      const version = updated.versions.find((item) => item.id === versionId);
      setStatusMessage(`v${version?.version ?? "?"} 已设为当前版本。`);
    } catch (activationError) {
      setLocalError(activationError instanceof Error ? activationError.message : String(activationError));
    } finally {
      setActivatingVersionId(null);
    }
  };

  const handleDelete = async () => {
    if (!selectedPrompt) return;
    if (!window.confirm(`确定删除策略“${selectedPrompt.name}”及其 ${selectedPrompt.versions.length} 个版本吗？此操作无法撤销。`)) return;
    setDeleting(true);
    setLocalError(null);
    try {
      await onDelete(selectedPrompt.id);
      setSelectedPromptId("");
      setForm(EMPTY_FORM);
      setSelectionInitialized(false);
      setStatusMessage("策略 Prompt 已删除。");
    } catch (deleteError) {
      setLocalError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setDeleting(false);
    }
  };

  const handleRefresh = () => {
    if (!confirmDiscard()) return;
    setForm(selectedPrompt ? formFromPrompt(selectedPrompt) : EMPTY_FORM);
    setLocalError(null);
    setStatusMessage(null);
    void onRefresh();
  };

  const busy = loading || saving || deleting || activatingVersionId !== null;
  const activeVersionId = selectedPrompt?.activeVersionId;
  const activeVersion = selectedPrompt?.versions.find((version) => version.id === activeVersionId);
  const openedVersion = selectedPromptId === initialSelection?.promptId
    ? selectedPrompt?.versions.find((version) => version.id === initialSelection.versionId)
    : undefined;
  const deletionBlocked = Boolean(
    selectedPrompt && deletionBlockedPromptIds.includes(selectedPrompt.id),
  );
  const sortedVersions = [...(selectedPrompt?.versions ?? [])].sort((left, right) => right.version - left.version);

  return (
    <div className="prompt-panel">
      <div className="settings-toolbar prompt-toolbar">
        <label className="settings-field">
          <span>策略列表</span>
          <select
            className="settings-select"
            value={selectedPromptId}
            onChange={(event) => selectPrompt(event.target.value)}
            disabled={busy}
          >
            <option value="">新建策略 Prompt</option>
            {prompts.map((prompt) => {
              const version = prompt.versions.find((item) => item.id === prompt.activeVersionId);
              return <option key={prompt.id} value={prompt.id}>{prompt.name}{version ? ` · 当前使用 v${version.version}` : ""}</option>;
            })}
          </select>
        </label>
        <button
          type="button"
          className="hud-btn hud-btn-ghost"
          onClick={handleRefresh}
          disabled={busy}
        >
          {loading ? "刷新中" : "刷新"}
        </button>
      </div>

      <div className="prompt-intro">
        开局使用所选策略的当前版本，对局开始后固定不变。AI 复盘生成的新版本需手动采用；策略不绑定模型或阵营，双方都可使用。
      </div>

      {activeVersion && (
        <div className="prompt-current-version">
          <span>当前使用 <strong>v{activeVersion.version}</strong></span>
          <time dateTime={activeVersion.createdAt}>
            {activeVersion.source === "reflection" ? "生成于" : "保存于"} {formatPromptVersionDate(activeVersion.createdAt)}
          </time>
        </div>
      )}
      {activeVersion && <PromptVersionOrigin version={activeVersion} provenance={provenance[activeVersion.id]} loading={provenanceLoading} unavailable={Boolean(provenanceError)} />}
      {provenanceError && <div className="settings-feedback error">{provenanceError}</div>}
      {openedVersion && openedVersion.id !== activeVersionId && (
        <div className="settings-feedback">
          对局配置使用 v{openedVersion.version}；策略库当前使用 v{activeVersion?.version}。该对局的版本不会随编辑或采用操作改变。
        </div>
      )}

      <form className="settings-form" onSubmit={(event) => void handleSubmit(event)}>
        <label className="settings-field">
          <span>名称</span>
          <input
            className="settings-input"
            value={form.name}
            maxLength={80}
            onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
            placeholder="例如：快速装甲推进"
          />
        </label>
        <label className="settings-field">
          <span>{activeVersion ? `当前版本内容 · v${activeVersion.version}` : "策略内容"}</span>
          <textarea
            className="settings-input settings-textarea prompt-editor"
            value={form.content}
            maxLength={30_000}
            onChange={(event) => setForm((current) => ({ ...current, content: event.target.value }))}
            placeholder="描述经济、兵种、进攻节奏或其他战略偏好…"
          />
        </label>

        {(localError ?? error) && <div className="settings-feedback error">{localError ?? error}</div>}
        {statusMessage && <div className="settings-feedback success">{statusMessage}</div>}

        <div className="settings-actions">
          <button type="submit" className="hud-btn hud-btn-start" disabled={busy || !dirty}>
            {saving ? "保存中…" : selectedPromptId ? (form.name !== baseline.name && form.content === baseline.content ? "保存名称" : "保存新版本") : "创建策略"}
          </button>
          {selectedPrompt && (
            <button
              type="button"
              className="hud-btn hud-btn-stop"
              onClick={() => void handleDelete()}
              disabled={busy || deletionBlocked}
              title={deletionBlocked ? "当前对局正在使用这个策略，结束或重置后才能删除" : undefined}
            >
              {deleting ? "删除中…" : "删除策略"}
            </button>
          )}
        </div>
        {deletionBlocked && (
          <small className="settings-help">当前对局已冻结这个策略版本；可以继续编辑，但结束或重置前不能删除。</small>
        )}
      </form>

      {selectedPrompt && (
        <section className="prompt-history" aria-label="Prompt 版本历史">
          <div className="prompt-history-heading">
            <span>版本历史</span>
            <small>{selectedPrompt.versions.length} 个版本</small>
          </div>
          <div className="prompt-version-list">
            {sortedVersions.map((version) => {
              const active = version.id === activeVersionId;
              return (
                <details
                  className={`prompt-version ${active ? "active" : ""}`}
                  key={version.id}
                  open={openedVersion?.id === version.id && !active}
                >
                  <summary>
                    <span className="prompt-version-title">v{version.version}</span>
                    <span className={`prompt-version-source ${version.source}`}>
                      {version.source === "reflection" ? "AI 复盘" : "编辑保存"}
                    </span>
                    <span className="prompt-version-state">{active ? "当前使用" : "其他版本"}</span>
                    <time dateTime={version.createdAt}>
                      {version.source === "reflection" ? "生成于" : "保存于"} {formatPromptVersionDate(version.createdAt)}
                    </time>
                  </summary>
                  {version.title && <div className="prompt-version-heading">{version.title}</div>}
                  <pre>{version.content}</pre>
                  <PromptVersionOrigin version={version} provenance={provenance[version.id]} loading={provenanceLoading} unavailable={Boolean(provenanceError)} />
                  {!active && (
                    <button
                      type="button"
                      className="hud-btn hud-btn-ghost"
                      onClick={() => void handleActivate(version.id)}
                      disabled={busy}
                    >
                      {activatingVersionId === version.id ? "采用中…" : `使用 v${version.version}`}
                    </button>
                  )}
                </details>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
