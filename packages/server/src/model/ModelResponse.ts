import type { ModelAssistantMessage, ModelCompletionResult, ModelToolCall } from "./ModelTransport";

export function isTruncatedResponse(finishReason: string | null): boolean {
  return finishReason === "length" || finishReason === "max_tokens";
}

/** Thinking alone is not a completed answer or an actionable tool request. */
export function hasAssistantOutput(message: ModelAssistantMessage | null): boolean {
  if (!message) return false;
  if (message.tool_calls?.length) return true;
  if (typeof message.refusal === "string" && message.refusal.trim()) return true;
  const content = message.content;
  if (typeof content === "string") return content.trim().length > 0;
  return Array.isArray(content) && content.some((part: unknown) => {
    if (!part || typeof part !== "object") return false;
    if ("text" in part && typeof part.text === "string") return part.text.trim().length > 0;
    return "refusal" in part && typeof part.refusal === "string" && part.refusal.trim().length > 0;
  });
}

/** Validate before checkpointing a response. Truncated tool batches need paired failures, not execution. */
export function readModelResponse(response: ModelCompletionResult): ModelAssistantMessage {
  if (response.finishReason === "aborted") {
    throw Object.assign(new Error("Request was aborted."), { name: "AbortError" });
  }
  if (response.finishReason === "error" || response.finishReason === "content_filter") {
    throw new Error("MODEL_RESPONSE_FAILED");
  }
  if (isTruncatedResponse(response.finishReason) && !response.message?.tool_calls?.length) {
    throw new Error("MODEL_RESPONSE_TRUNCATED");
  }
  if (!response.message || !hasAssistantOutput(response.message)) throw new Error("MODEL_RESPONSE_EMPTY");
  return response.message;
}

interface ToolCallPreparation {
  args: unknown;
  failure?: { ok: false; error: "model_output_truncated" | "invalid_tool_arguments"; hint: string };
}

/** Do not salvage partial JSON into executable actions, even when it happens to parse. */
export function prepareToolCall(call: ModelToolCall, finishReason: string | null): ToolCallPreparation {
  let args: unknown = null;
  let valid = false;
  try {
    args = JSON.parse(call.function.arguments);
    valid = args !== null && typeof args === "object" && !Array.isArray(args);
  } catch {
    // Retain an explicit failure instead of turning malformed input into {}.
  }
  if (isTruncatedResponse(finishReason)) {
    return { args, failure: {
      ok: false,
      error: "model_output_truncated",
      hint: "Not executed: the model response hit its output limit. Re-issue the tool call with complete arguments.",
    } };
  }
  if (!valid) {
    return { args, failure: {
      ok: false,
      error: "invalid_tool_arguments",
      hint: "Not executed: tool arguments must be a complete JSON object. Re-issue the tool call with valid arguments.",
    } };
  }
  return { args };
}
