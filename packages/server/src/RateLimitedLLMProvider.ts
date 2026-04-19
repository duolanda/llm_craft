import { AgentRunInput } from "@llmcraft/shared";
import { LLMProvider, RunAgentOptions, RunAgentResult } from "./LLMProvider";

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

    const intervalMs = 60000 / this.rpm;
    const run = async () => {
      if (options.signal?.aborted) {
        return createAbortedResult();
      }

      const now = Date.now();
      const waitMs = Math.max(0, this.nextAvailableAt - now);
      if (waitMs > 0) {
        await Promise.race([
          sleep(waitMs),
          new Promise<never>((_, reject) => {
            options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          }),
        ]);
      }

      if (options.signal?.aborted) {
        return createAbortedResult();
      }

      this.nextAvailableAt = Math.max(this.nextAvailableAt, Date.now()) + intervalMs;
      return this.inner.runAgent(input, options);
    };

    const pending = this.chain.then(run, run);
    this.chain = pending.then(() => undefined, () => undefined);
    try {
      return await pending;
    } catch (error) {
      if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        return createAbortedResult();
      }
      throw error;
    }
  }

  getModel(): string {
    return this.inner.getModel();
  }

  getBaseURL(): string | undefined {
    return this.inner.getBaseURL();
  }
}
