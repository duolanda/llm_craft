import { AIPromptPayload } from "@llmcraft/shared";
import { GenerateCodeResult, LLMProvider } from "./LLMProvider";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class RateLimitedLLMProvider implements LLMProvider {
  private nextAvailableAt = 0;
  private chain = Promise.resolve();

  constructor(
    private readonly inner: LLMProvider,
    private readonly rpm?: number | null
  ) {}

  shouldForceFullState(): boolean {
    return this.inner.shouldForceFullState();
  }

  async generateCode(payload: AIPromptPayload): Promise<GenerateCodeResult> {
    if (!this.rpm) {
      return this.inner.generateCode(payload);
    }

    const intervalMs = 60000 / this.rpm;
    const run = async () => {
      const now = Date.now();
      const waitMs = Math.max(0, this.nextAvailableAt - now);
      if (waitMs > 0) {
        await sleep(waitMs);
      }

      this.nextAvailableAt = Math.max(this.nextAvailableAt, Date.now()) + intervalMs;
      return this.inner.generateCode(payload);
    };

    const pending = this.chain.then(run, run);
    this.chain = pending.then(() => undefined, () => undefined);
    return pending;
  }

  getModel(): string {
    return this.inner.getModel();
  }

  getBaseURL(): string | undefined {
    return this.inner.getBaseURL();
  }
}
