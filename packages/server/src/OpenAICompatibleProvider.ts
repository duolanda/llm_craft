import OpenAI from "openai";
import { AIPromptPayload } from "@llmcraft/shared";
import { LLMProvider, OpenAIProviderConfig } from "./LLMProvider";
import { SYSTEM_PROMPT } from "./SystemPrompt";

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 2048;

export class OpenAICompatibleProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;
  private baseURL?: string;
  private history: Array<{
    mode: AIPromptPayload["mode"];
    user: string;
    assistant: string;
  }> = [];
  private maxTurns = 20;

  constructor(config: OpenAIProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.model = config.model || "gpt-4o-mini";
    this.baseURL = config.baseURL;
  }

  shouldForceFullState(): boolean {
    const retainedHistory = this.history.length >= this.maxTurns ? this.history.slice(1) : this.history;
    return retainedHistory.every((turn) => turn.mode !== "full");
  }

  async generateCode(payload: AIPromptPayload): Promise<{
    code: string;
    rawResponse: string;
    requestMessages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    errorMessage?: string;
  }> {
    const userPrompt = JSON.stringify(payload, null, 2);
    const requestMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: SYSTEM_PROMPT },
      ...this.history.flatMap((turn) => [
        { role: "user" as const, content: turn.user },
        { role: "assistant" as const, content: turn.assistant },
      ]),
      { role: "user", content: userPrompt },
    ];

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: requestMessages,
        temperature: DEFAULT_TEMPERATURE,
        max_tokens: DEFAULT_MAX_TOKENS,
      });

      const choice = response.choices[0];
      const rawResponse = choice?.message?.content || "";
      const cleanedCode = this.cleanCode(rawResponse);
      const errorMessage =
        choice?.finish_reason === "length"
          ? `LLM response was truncated by max_tokens (${DEFAULT_MAX_TOKENS}); generated code may be incomplete.`
          : undefined;
      this.history.push({
        mode: payload.mode,
        user: userPrompt,
        assistant: cleanedCode,
      });
      if (this.history.length > this.maxTurns) {
        this.history = this.history.slice(-this.maxTurns);
      }
      return { code: cleanedCode, rawResponse, requestMessages, errorMessage };
    } catch (e) {
      console.error("OpenAI API 错误:", e);
      return {
        code: "// AI 生成失败",
        rawResponse: "",
        requestMessages,
        errorMessage: e instanceof Error ? e.message : String(e),
      };
    }
  }

  getModel(): string {
    return this.model;
  }

  getBaseURL(): string | undefined {
    return this.baseURL;
  }

  private cleanCode(code: string): string {
    return code
      .replace(/^```javascript\n?/m, "")
      .replace(/^```js\n?/m, "")
      .replace(/```$/m, "")
      .trim();
  }
}
