import OpenAI from "openai";
import { AIPromptPayload } from "@llmcraft/shared";
import { SYSTEM_PROMPT } from "./SystemPrompt";

export interface OpenAIClientConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
}

export class OpenAIClient {
  private client: OpenAI;
  private model: string;
  private baseURL?: string;
  private history: Array<{ role: "user" | "assistant"; content: string }> = [];
  private maxTurns = 20;

  constructor(config: OpenAIClientConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.model = config.model || "gpt-4o-mini";
    this.baseURL = config.baseURL;
  }

  shouldResetConversation(): boolean {
    return this.history.length / 2 >= this.maxTurns;
  }

  async generateCode(
    payload: AIPromptPayload,
    resetConversation = false
  ): Promise<{
    code: string;
    requestMessages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  }> {
    if (resetConversation) {
      this.history = [];
    }

    const userPrompt = JSON.stringify(payload, null, 2);
    const requestMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: SYSTEM_PROMPT },
      ...this.history,
      { role: "user", content: userPrompt },
    ];

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: requestMessages,
        temperature: 0.7,
        max_tokens: 1024,
      });

      const code = response.choices[0]?.message?.content || "";
      const cleanedCode = this.cleanCode(code);
      this.history.push({ role: "user", content: userPrompt });
      this.history.push({ role: "assistant", content: cleanedCode });
      if (this.history.length > this.maxTurns * 2) {
        this.history = this.history.slice(-(this.maxTurns * 2));
      }
      return { code: cleanedCode, requestMessages };
    } catch (e) {
      console.error("OpenAI API 错误:", e);
      return { code: "// AI 生成失败", requestMessages };
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
