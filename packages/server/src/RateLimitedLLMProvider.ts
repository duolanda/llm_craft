import { AgentRunInput } from "@llmcraft/shared";
import {
  LLMConnectionTestResult,
  LLMProvider,
  RunAgentOptions,
  RunAgentResult,
  RunSubAgentTaskInput,
  WarmupAgentResult,
} from "./LLMProvider";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createAbortedResult(): RunAgentResult {
  return {
    assistantMessages: [],
    toolCalls: [],
    plans: [],
    stopReason: "aborted",
    metrics: {
      modelRequests: 0,
      toolCalls: 0,
      stallDetected: false,
    },
  };
}

function createAbortedWarmupResult(): WarmupAgentResult {
  return {
    assistantMessages: [],
    stopReason: "aborted",
    hasPendingToolCalls: false,
    metrics: {
      modelRequests: 0,
    },
  };
}

export class RateLimitedLLMProvider implements LLMProvider {
  private nextAvailableAt = 0;
  private chain = Promise.resolve();

  constructor(
    private readonly inner: LLMProvider,
    private readonly rpm?: number | null
  ) {}

  async runAgent(input: AgentRunInput, options: RunAgentOptions): Promise<RunAgentResult> {
    if (options.signal?.aborted) {
      return createAbortedResult();
    }

    if (!this.rpm) {
      return this.inner.runAgent(input, options);
    }

    const result = await this.runWithRateLimit(options.signal, () => this.inner.runAgent(input, options));
    return result ?? createAbortedResult();
  }

  async testConnection(signal?: AbortSignal): Promise<LLMConnectionTestResult> {
    if (!this.rpm) {
      return this.inner.testConnection(signal);
    }

    const result = await this.runWithRateLimit(signal, () => this.inner.testConnection(signal));
    if (!result) {
      throw new DOMException("Aborted", "AbortError");
    }
    return result;
  }

  async runSubAgentTask(input: RunSubAgentTaskInput): Promise<string> {
    if (input.signal.aborted) {
      return this.createAbortedSubAgentResult(input);
    }

    if (!this.rpm) {
      return this.inner.runSubAgentTask(input);
    }

    const result = await this.runWithRateLimit(input.signal, () => this.inner.runSubAgentTask(input));
    return result ?? this.createAbortedSubAgentResult(input);
  }

  async warmupAgent(input: AgentRunInput, options: RunAgentOptions): Promise<WarmupAgentResult> {
    if (options.signal?.aborted) {
      return createAbortedWarmupResult();
    }

    if (!this.rpm) {
      return this.inner.warmupAgent(input, options);
    }

    const result = await this.runWithRateLimit(options.signal, () => this.inner.warmupAgent(input, options));
    return result ?? createAbortedWarmupResult();
  }

  getModel(): string {
    return this.inner.getModel();
  }

  getBaseURL(): string | undefined {
    return this.inner.getBaseURL();
  }

  private async runWithRateLimit<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T | null> {
    const intervalMs = this.rpm ? 60000 / this.rpm : 0;
    const run = async () => {
      if (signal?.aborted) {
        return null;
      }

      const now = Date.now();
      const waitMs = Math.max(0, this.nextAvailableAt - now);
      if (waitMs > 0) {
        await Promise.race([
          sleep(waitMs),
          new Promise<never>((_, reject) => {
            signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          }),
        ]);
      }

      if (signal?.aborted) {
        return null;
      }

      this.nextAvailableAt = Math.max(this.nextAvailableAt, Date.now()) + intervalMs;
      return operation();
    };

    const pending = this.chain.then(run, run);
    this.chain = pending.then(() => undefined, () => undefined);
    try {
      return await pending;
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        return null;
      }
      throw error;
    }
  }

  private createAbortedSubAgentResult(input: RunSubAgentTaskInput): string {
    return [
      "<sub-agent-result>",
      `taskId: ${input.taskId}`,
      `description: ${input.description}`,
      "status: aborted",
      `objective: ${input.objective}`,
      "result:",
      "Aborted before completion.",
      "</sub-agent-result>",
    ].join("\n");
  }
}
