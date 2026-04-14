import { ServerBenchmarkCompleteMessage, ServerBenchmarkProgressMessage } from "@llmcraft/shared";

interface BenchmarkResultProps {
  progress: ServerBenchmarkProgressMessage | null;
  result: ServerBenchmarkCompleteMessage | null;
}

export function BenchmarkResult({ progress, result }: BenchmarkResultProps) {
  if (!progress && !result) {
    return null;
  }

  if (!result) {
    return (
      <div className="settings-panel">
        <div className="settings-section">
          <h3>Benchmark 运行中</h3>
          <p>
            CPU 策略: <strong>{progress?.cpuStrategy}</strong>
          </p>
          <p>
            进度: {progress?.completedRounds ?? 0} / {progress?.totalRounds ?? 0}
          </p>
          <p>
            LLM 胜 / CPU 胜 / 平: {progress?.llmWins ?? 0} / {progress?.cpuWins ?? 0} / {progress?.draws ?? 0}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-panel">
      <div className="settings-section">
        <h3>Benchmark 结果</h3>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: "12px",
            marginTop: "12px",
          }}
        >
          <div className="settings-list-item">
            <span>CPU 策略</span>
            <strong>{result.cpuStrategy}</strong>
          </div>
          <div className="settings-list-item">
            <span>完成局数</span>
            <strong>
              {result.completedRounds} / {result.totalRounds}
              {result.stopped ? "（已中止）" : ""}
            </strong>
          </div>
          <div className="settings-list-item">
            <span>LLM 胜率</span>
            <strong>{result.llmWinRate}%</strong>
          </div>
          <div className="settings-list-item">
            <span>平均时长</span>
            <strong>{result.averageDurationTicks} ticks</strong>
          </div>
          <div className="settings-list-item">
            <span>LLM 胜</span>
            <strong>{result.llmWins}</strong>
          </div>
          <div className="settings-list-item">
            <span>CPU 胜 / 平</span>
            <strong>
              {result.cpuWins} / {result.draws}
            </strong>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <h3>逐局结果</h3>
        <div
          className="settings-list"
          style={{ display: "grid", gap: "10px" }}
        >
          {result.rounds.map((round) => (
            <div
              key={round.round}
              className="settings-list-item"
              style={{ display: "grid", gap: "6px" }}
            >
              <strong>第 {round.round} 局</strong>
              <span>LLM 方位: {round.llmSide === "player_1" ? "红方" : "蓝方"}</span>
              <span>结果: {round.winner === "llm" ? "LLM 胜" : round.winner === "cpu" ? "CPU 胜" : "平局"}</span>
              <span>时长: {round.durationTicks} ticks</span>
              {round.recordPath && <span>回放文件: {round.recordPath.split(/[\\/]/).pop()}</span>}
              {round.transcriptPath && <span>LLM Debug: {round.transcriptPath.split(/[\\/]/).pop()}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
