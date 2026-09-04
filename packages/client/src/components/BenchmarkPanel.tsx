import { FormEvent, useEffect, useState } from "react";
import {
  CPUStrategyType,
  DEFAULT_CPU_DECISION_INTERVAL_TICKS,
  LLMPresetSummary,
  MAX_CPU_DECISION_INTERVAL_TICKS,
  MatchDebugOptions,
  MIN_CPU_DECISION_INTERVAL_TICKS,
} from "@llmcraft/shared";

interface BenchmarkPanelProps {
  presets: LLMPresetSummary[];
  initialPresetId?: string;
  running: boolean;
  onStart: (input: {
    presetId: string;
    cpuStrategy: CPUStrategyType;
    rounds: number;
    decisionIntervalTicks: number;
    recordReplay: boolean;
    concurrency: number;
    debug?: MatchDebugOptions;
  }) => void;
  onClose: () => void;
}

export function BenchmarkPanel({ presets, initialPresetId = "", running, onStart, onClose }: BenchmarkPanelProps) {
  const [presetId, setPresetId] = useState(initialPresetId);
  const [cpuStrategy, setCpuStrategy] = useState<CPUStrategyType>("random");
  const [rounds, setRounds] = useState("1");
  const [decisionIntervalTicks, setDecisionIntervalTicks] = useState(
    String(DEFAULT_CPU_DECISION_INTERVAL_TICKS),
  );
  const [concurrency, setConcurrency] = useState("1");
  const [recordReplay, setRecordReplay] = useState(true);
  const [recordLLMTranscript, setRecordLLMTranscript] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const presetIds = new Set(presets.map((preset) => preset.id));
    setPresetId((current) => {
      if (current && presetIds.has(current)) {
        return current;
      }
      if (initialPresetId && presetIds.has(initialPresetId)) {
        return initialPresetId;
      }
      return presets[0]?.id ?? "";
    });
  }, [initialPresetId, presets]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!presetId) {
      setError("请选择一个 LLM 预设。");
      return;
    }

    const parsedRounds = Number(rounds);
    if (!Number.isInteger(parsedRounds) || parsedRounds <= 0 || parsedRounds > 100) {
      setError("局数必须是 1 到 100 之间的整数。");
      return;
    }

    const parsedConcurrency = Number(concurrency);
    if (!Number.isInteger(parsedConcurrency) || parsedConcurrency <= 0 || parsedConcurrency > 10) {
      setError("并发数必须是 1 到 10 之间的整数。");
      return;
    }

    const parsedDecisionIntervalTicks = Number(decisionIntervalTicks);
    if (
      !Number.isInteger(parsedDecisionIntervalTicks)
      || parsedDecisionIntervalTicks < MIN_CPU_DECISION_INTERVAL_TICKS
      || parsedDecisionIntervalTicks > MAX_CPU_DECISION_INTERVAL_TICKS
    ) {
      setError(
        `CPU 决策间隔必须是 ${MIN_CPU_DECISION_INTERVAL_TICKS} 到 ${MAX_CPU_DECISION_INTERVAL_TICKS} 之间的整数。`,
      );
      return;
    }

    setError(null);
    onStart({
      presetId,
      cpuStrategy,
      rounds: parsedRounds,
      decisionIntervalTicks: parsedDecisionIntervalTicks,
      recordReplay,
      concurrency: parsedConcurrency,
      debug: recordLLMTranscript ? { includeTranscript: true } : undefined,
    });
  };

  return (
    <form className="settings-form" onSubmit={handleSubmit}>
      <div className="settings-grid">
        <label className="settings-field settings-field-wide">
          <span>LLM 预设</span>
          <select
            className="settings-select"
            value={presetId}
            onChange={(event) => setPresetId(event.target.value)}
            disabled={running || presets.length === 0}
          >
            <option value="">选择一个预设</option>
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </label>

        <label className="settings-field">
          <span>CPU 策略</span>
          <select
            className="settings-select"
            value={cpuStrategy}
            onChange={(event) => setCpuStrategy(event.target.value as CPUStrategyType)}
            disabled={running}
          >
            <option value="random">random</option>
            <option value="rush">rush</option>
          </select>
        </label>

        <label className="settings-field">
          <span>局数</span>
          <input
            className="settings-input benchmark-number-input"
            type="number"
            min={1}
            max={100}
            value={rounds}
            onChange={(event) => setRounds(event.target.value)}
            disabled={running}
          />
        </label>

        <label className="settings-field">
          <span>并发对局数</span>
          <input
            className="settings-input benchmark-number-input"
            type="number"
            min={1}
            max={10}
            value={concurrency}
            onChange={(event) => setConcurrency(event.target.value)}
            disabled={running}
          />
        </label>

        <label className="settings-field">
          <span>CPU 决策间隔（tick）</span>
          <input
            className="settings-input benchmark-number-input"
            type="number"
            min={MIN_CPU_DECISION_INTERVAL_TICKS}
            max={MAX_CPU_DECISION_INTERVAL_TICKS}
            value={decisionIntervalTicks}
            onChange={(event) => setDecisionIntervalTicks(event.target.value)}
            disabled={running}
          />
        </label>

      </div>

      <div className="benchmark-toggle-group">
        <label className="benchmark-inline-toggle-row">
          <input
            type="checkbox"
            checked={recordReplay}
            onChange={(event) => {
              const nextRecordReplay = event.target.checked;
              setRecordReplay(nextRecordReplay);
              if (!nextRecordReplay) {
                setRecordLLMTranscript(false);
              }
            }}
            disabled={running}
          />
          <span>保存回放</span>
        </label>

        <label className="benchmark-inline-toggle-row">
          <input
            type="checkbox"
            checked={recordLLMTranscript}
            onChange={(event) => setRecordLLMTranscript(event.target.checked)}
            disabled={running || !recordReplay}
          />
          <span>记录完整 transcript</span>
        </label>
      </div>

      <div className="settings-list-item" style={{ marginTop: "12px" }}>
        <span>本次将运行</span>
        <strong>{rounds || "0"} 局，最多同时运行 {concurrency || "0"} 局</strong>
      </div>

      {error && <div className="settings-inline-error">{error}</div>}

      <div className="settings-actions">
        <button type="button" className="hud-btn hud-btn-ghost" onClick={onClose} disabled={running}>
          取消
        </button>
        <button type="submit" className="hud-btn hud-btn-start" disabled={running || presets.length === 0}>
          {running ? "运行中" : "启动 Benchmark"}
        </button>
      </div>
    </form>
  );
}
