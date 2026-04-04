import OpenAI from "openai";
import { AIStatePackage } from "@llmcraft/shared";
import { SYSTEM_PROMPT } from "./SystemPrompt";

export interface OpenAIClientConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
}

export class OpenAIClient {
  private client: OpenAI;
  private model: string;

  constructor(config: OpenAIClientConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.model = config.model || "gpt-4o-mini";
  }

  async generateCode(state: AIStatePackage): Promise<string> {
    const userPrompt = JSON.stringify(state, null, 2);

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 1024,
      });

      const code = response.choices[0]?.message?.content || "";
      return this.cleanCode(code);
    } catch (e) {
      console.error("OpenAI API 错误:", e);
      return "// AI 生成失败";
    }
  }

  private cleanCode(code: string): string {
    return code
      .replace(/^```javascript\n?/m, "")
      .replace(/^```js\n?/m, "")
      .replace(/```$/m, "")
      .trim();
  }
}
