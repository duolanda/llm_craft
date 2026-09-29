import type { PlayerId } from "@llmcraft/shared";
import { classifyModelRequestError, type ModelRequestRetryOptions } from "./agent/ModelRequestRetry";
import type { ModelCompletionRequest } from "./model/ModelTransport";

export interface PromptReflectionOptions extends ModelRequestRetryOptions {
  /** Opt-in local evaluation capture. Receives a detached request without credentials or signal. */
  onRequest?: (request: Omit<ModelCompletionRequest, "signal">) => void | Promise<void>;
}

export interface PromptReflectionInput {
  playerId: PlayerId;
  winner: PlayerId;
  finalTick: number;
}

export interface PromptReflectionResult {
  title: string;
  content: string;
  model: string;
}

/** Only expose known error categories, never arbitrary provider bodies, headers or credentials. */
export function describePromptReflectionError(error: unknown): string {
  const descriptions: Record<string, string> = {
    PROMPT_REFLECTION_SESSION_UNAVAILABLE: "原对战会话已不可用，无法继续本局复盘",
    PROMPT_REFLECTION_MATCH_NOT_FINISHED: "对局尚未正常结束，暂时不能复盘",
    PROMPT_REFLECTION_EMPTY: "模型没有返回策略正文",
    MODEL_RESPONSE_EMPTY: "模型没有返回策略正文",
    PROMPT_REFLECTION_INCOMPLETE: "模型输出达到 token 上限，复盘尚未完成",
    PROMPT_REFLECTION_INVALID_FORMAT: "模型未返回简短标题和完整策略正文，请重试",
    MODEL_RESPONSE_TRUNCATED: "模型输出达到 token 上限，复盘尚未完成",
    MODEL_RESPONSE_FAILED: "模型未正常完成响应",
    PROMPT_REFLECTION_UNEXPECTED_TOOL_CALL: "模型仍要求调用工具，未按复盘要求返回策略正文",
    PROMPT_NOT_FOUND: "原策略已被删除，无法保存新版本",
  };
  if (error instanceof Error && Object.hasOwn(descriptions, error.message)) return descriptions[error.message]!;
  const kind = classifyModelRequestError(error);
  if (kind === "cancelled") return "复盘请求已取消";
  if (kind === "quota") return "模型服务额度已用尽或账单受限，请检查供应商账户";
  if (kind === "network") return "模型服务连接中断";
  if (kind === "timeout") return "模型服务响应超时";
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
    const status = error.status;
    if (status === 400) {
      const param = "param" in error && typeof error.param === "string" ? error.param : "";
      const emptyMessage = /^messages\[(\d+)\] assistant must provide content, reasoning_content or tool_calls$/.exec(param);
      const index = emptyMessage ? Number(emptyMessage[1]) : NaN;
      if (Number.isSafeInteger(index) && index >= 0) return `模型拒绝了第 ${index + 1} 条空会话消息（HTTP 400）`;
      return "模型拒绝了请求（HTTP 400），请检查模型参数与会话格式";
    }
    if (status === 401 || status === 403) return `模型服务鉴权失败（HTTP ${status}）`;
    if (status === 429) return "模型服务限流（HTTP 429），请稍后重试";
    if (status >= 500 && status <= 599) return `模型服务暂时异常（HTTP ${status}），请稍后重试`;
  }
  return "生成或保存时发生错误，具体原因请查看服务端日志";
}

/** Appended to the playing session; the existing conversation is the evidence. */
export function createPromptReflectionMessage(input: PromptReflectionInput): string {
  return [
    `本局已于 tick ${input.finalTick} 正常结束。你控制 ${input.playerId}，获胜方为 ${input.winner}，你的结果是${input.winner === input.playerId ? "获胜" : "失败"}。`,
    "请给下一局的自己留一份简短的经验交接。不要重写原有攻略，挑这局带来的新认识，讲清你下一局会怎么打、为什么。接手的自己已经懂规则和工具，只需要这些实战体会。以本局实际反馈为准，旧策略中的故事不是本局记录，未验证的想法就按想法说。",
    "只用中文表达，兵种和建筑名称也译成中文，不夹带英文代码名；credits 是钱，写作“资金”。不写工具名、调用参数或本局的编号、坐标和时间线。",
    "只输出交接内容：首行用一个简短的中文 Markdown 一级标题（# 标题，最多 24 字），空一行后写正文。",
  ].join("\n\n");
}

export function normalizeReflectedPrompt(value: unknown): Pick<PromptReflectionResult, "title" | "content"> {
  const text = typeof value === "string" ? stripMarkdownFence(value.trim()) : "";
  if (!text) throw new Error("PROMPT_REFLECTION_EMPTY");
  const match = /^#[ \t]+([^\r\n]+)\r?\n\s*\r?\n([\s\S]+)$/.exec(text);
  const title = match?.[1]?.trim() ?? "";
  const content = match?.[2]?.trim() ?? "";
  if (!title || [...title].length > 24 || !content) throw new Error("PROMPT_REFLECTION_INVALID_FORMAT");
  return { title, content };
}

function stripMarkdownFence(value: string): string {
  const match = value.match(/^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```$/i);
  return (match?.[1] ?? value).trim();
}
