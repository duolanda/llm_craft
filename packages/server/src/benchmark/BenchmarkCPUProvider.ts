import { AIPromptPayload, BuiltinCPURuntimeConfig } from "@llmcraft/shared";
import { GenerateCodeResult, LLMProvider } from "../LLMProvider";
import { buildCPUCode } from "./cpuStrategies";

export class BenchmarkCPUProvider implements LLMProvider {
  constructor(private readonly config: BuiltinCPURuntimeConfig) {}

  shouldForceFullState(): boolean {
    return true;
  }

  async generateCode(payload: AIPromptPayload): Promise<GenerateCodeResult> {
    const code = buildCPUCode(this.config.strategy, payload);
    return {
      code,
      rawResponse: `[benchmark-cpu:${this.config.strategy}]`,
      requestMessages: [],
    };
  }

  getModel(): string {
    return `cpu-${this.config.strategy}`;
  }

  getBaseURL(): string | undefined {
    return undefined;
  }
}
