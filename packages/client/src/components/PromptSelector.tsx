import type { MatchPromptSelection, MatchPromptSnapshot, StrategyPrompt } from "@llmcraft/shared";

interface PromptSelectorProps {
  side: "red" | "blue";
  value: string;
  prompts: readonly StrategyPrompt[];
  frozenPrompt?: MatchPromptSnapshot;
  disabled: boolean;
  viewDisabled?: boolean;
  onChange: (promptId: string) => void;
  onView: (selection: MatchPromptSelection) => void;
}

/** Selection and library navigation share prompt identity, never a display name or version number. */
export function PromptSelector({ side, value, prompts, frozenPrompt, disabled, viewDisabled, onChange, onView }: PromptSelectorProps) {
  const sideName = side === "red" ? "红方" : "蓝方";
  const selected = prompts.find((prompt) => prompt.id === value);
  const selectedVersionId = frozenPrompt?.promptId === value ? frozenPrompt.versionId : selected?.activeVersionId;
  const optionLabel = (prompt: StrategyPrompt): string => {
    const frozen = frozenPrompt?.promptId === prompt.id ? frozenPrompt : undefined;
    const version = frozen?.version ?? prompt.versions.find((item) => item.id === prompt.activeVersionId)?.version;
    return `${prompt.name}${version ? ` · ${frozen ? "本局固定" : "当前使用"} v${version}` : ""}`;
  };
  return (
    <div className="prompt-select-row">
      <select
        aria-label={`${sideName}策略 Prompt`}
        className={`settings-select live-prompt-select ${side}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        title={selected ? optionLabel(selected) : "不附加自定义策略，仍使用系统游戏规则"}
      >
        <option value="">不使用自定义策略</option>
        {value && !selected && (
          <option value={value}>
            {frozenPrompt?.promptId === value
              ? `${frozenPrompt.promptName} · 本局固定 v${frozenPrompt.version}`
              : "当前对局策略"}
          </option>
        )}
        {prompts.map((prompt) => <option key={prompt.id} value={prompt.id}>{optionLabel(prompt)}</option>)}
      </select>
      <button
        type="button"
        className="prompt-view-btn"
        aria-label={`查看${sideName}策略`}
        title={selected ? "在策略库中查看此策略" : "先选择一份策略"}
        disabled={viewDisabled || !selected || !selectedVersionId}
        onClick={() => selected && selectedVersionId && onView({ promptId: selected.id, versionId: selectedVersionId })}
      >
        查看
      </button>
    </div>
  );
}
