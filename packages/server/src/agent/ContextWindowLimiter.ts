import type { ContextWindowLimitRecord } from "@llmcraft/shared";

export interface ContextWindowLimiterOptions {
  maxMessages?: number;
  maxBytes?: number;
  maxMessageBytes?: number;
}

export interface ContextWindowLimiterResult {
  history: unknown[];
  record: ContextWindowLimitRecord;
}

const DEFAULT_MAX_MESSAGES = 80;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_MESSAGE_BYTES = 32 * 1024;

function messageBytes(message: unknown): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}

function historyBytes(history: readonly unknown[]): number {
  return history.reduce<number>((total, message) => total + messageBytes(message), 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRole(message: unknown): string {
  return isRecord(message) && typeof message.role === "string" ? message.role : "unknown";
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) {
    end = Math.floor(end * 0.9);
  }
  while (end < value.length && Buffer.byteLength(value.slice(0, end + 1), "utf8") <= maxBytes) {
    end += 1;
  }
  return value.slice(0, end);
}

/**
 * Temporary hard size limiter for provider messages.
 *
 * This is not durable agent memory and not a real semantic compactor. Replace
 * it with a compactor that produces an explicit, model-readable context summary
 * once the required summary contract is designed.
 */
export class ContextWindowLimiter {
  private readonly maxMessages: number;
  private readonly maxBytes: number;
  private readonly maxMessageBytes: number;

  constructor(options: ContextWindowLimiterOptions = {}) {
    this.maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    if (!Number.isSafeInteger(this.maxMessages) || this.maxMessages < 2) {
      throw new Error("Context window maxMessages must be an integer of at least 2.");
    }
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1024) {
      throw new Error("Context window maxBytes must be an integer of at least 1024.");
    }
    if (!Number.isSafeInteger(this.maxMessageBytes) || this.maxMessageBytes < 256) {
      throw new Error("Context window maxMessageBytes must be an integer of at least 256.");
    }
  }

  limit(history: readonly unknown[]): ContextWindowLimiterResult {
    const bytesBefore = historyBytes(history);
    let truncatedMessages = 0;
    const normalized = history.map((message) => {
      const result = this.normalizeMessage(message);
      if (result.truncated) truncatedMessages += 1;
      return result.message;
    });
    const groups = this.groupByUserBoundary(normalized);
    const retained: unknown[][] = [];
    let retainedMessages = 0;
    let retainedBytes = 0;
    let replacementNotice = false;

    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const group = groups[index]!;
      const groupBytes = historyBytes(group);
      const fits = retainedMessages + group.length <= this.maxMessages
        && retainedBytes + groupBytes <= this.maxBytes;
      if (!fits && retained.length > 0) break;
      if (!fits) {
        retained.push([this.createOmissionNotice(history.length, bytesBefore, "latest_group_exceeded_limit")]);
        retainedMessages = 1;
        retainedBytes = historyBytes(retained[0]!);
        replacementNotice = true;
        break;
      }
      retained.unshift(group);
      retainedMessages += group.length;
      retainedBytes += groupBytes;
    }

    let limitedHistory = retained.flat();
    const droppedMessagesBeforeNotice = Math.max(0, history.length - limitedHistory.length);
    let hasOmissionNotice = replacementNotice;
    if (droppedMessagesBeforeNotice > 0 && !replacementNotice) {
      limitedHistory.unshift(this.createOmissionNotice(
        droppedMessagesBeforeNotice,
        Math.max(0, bytesBefore - historyBytes(limitedHistory)),
        "older_history_omitted",
      ));
      hasOmissionNotice = true;
    }

    while (
      limitedHistory.length > 1
      && (limitedHistory.length > this.maxMessages || historyBytes(limitedHistory) > this.maxBytes)
    ) {
      const nextUserIndex = limitedHistory.findIndex((message, index) => index > 1 && getRole(message) === "user");
      if (nextUserIndex <= 0) break;
      limitedHistory.splice(1, nextUserIndex - 1);
    }

    if (
      hasOmissionNotice
      && (limitedHistory.length > this.maxMessages || historyBytes(limitedHistory) > this.maxBytes)
    ) {
      limitedHistory.shift();
      hasOmissionNotice = false;
    }

    const bytesAfter = historyBytes(limitedHistory);
    return {
      history: limitedHistory,
      record: {
        maxMessages: this.maxMessages,
        maxBytes: this.maxBytes,
        messagesBefore: history.length,
        messagesAfter: limitedHistory.length,
        bytesBefore,
        bytesAfter,
        droppedMessages: Math.max(
          0,
          history.length - (limitedHistory.length - (hasOmissionNotice ? 1 : 0)),
        ),
        truncatedMessages,
      },
    };
  }

  private normalizeMessage(message: unknown): { message: unknown; truncated: boolean } {
    if (messageBytes(message) <= this.maxMessageBytes) {
      return { message: structuredClone(message), truncated: false };
    }
    if (!isRecord(message)) {
      return {
        message: { role: "user", content: "[context-window-limiter: oversized non-object message omitted]" },
        truncated: true,
      };
    }

    const role = getRole(message);
    const originalBytes = messageBytes(message);
    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      // Tool results must keep their matching assistant tool-call declaration.
      // The enclosing user segment will be omitted as a unit if it cannot fit.
      return { message: structuredClone(message), truncated: false };
    }
    if (role === "tool") {
      let observedTick: number | null = null;
      if (typeof message.content === "string") {
        try {
          const parsed = JSON.parse(message.content);
          observedTick = typeof parsed?.tick === "number" ? parsed.tick : null;
        } catch {
          observedTick = null;
        }
      }
      return {
        message: {
          ...message,
          content: JSON.stringify({
            expired: true,
            reason: "context_window_oversize",
            originalBytes,
            observedTick,
            message: "This old oversized tool result was omitted. Read current state again before acting.",
          }),
        },
        truncated: true,
      };
    }

    if (typeof message.content === "string") {
      const suffix = `\n[context-window-limiter: truncated oversized ${role} message; originalBytes=${originalBytes}]`;
      return {
        message: {
          ...message,
          content: truncateUtf8(message.content, Math.max(1, this.maxMessageBytes - Buffer.byteLength(suffix))) + suffix,
        },
        truncated: true,
      };
    }

    return {
      message: {
        role,
        content: `[context-window-limiter: oversized ${role} message omitted; originalBytes=${originalBytes}]`,
      },
      truncated: true,
    };
  }

  private groupByUserBoundary(history: readonly unknown[]): unknown[][] {
    const groups: unknown[][] = [];
    for (const message of history) {
      if (getRole(message) === "user" || groups.length === 0) {
        groups.push([message]);
      } else {
        groups[groups.length - 1]!.push(message);
      }
    }
    return groups;
  }

  private createOmissionNotice(droppedMessages: number, droppedBytes: number, reason: string): unknown {
    return {
      role: "user",
      content: JSON.stringify({
        reason,
        droppedMessages,
        droppedBytes,
        instruction: "Earlier messages were omitted to fit the context window. Re-read current game state before relying on old observations.",
      }),
    };
  }
}
