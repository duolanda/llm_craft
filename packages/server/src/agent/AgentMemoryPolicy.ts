import type { AgentMemoryPolicyRecord } from "@llmcraft/shared";

export interface AgentMemoryPolicyOptions {
  maxMessages?: number;
  maxBytes?: number;
  maxMessageBytes?: number;
}

export interface AgentMemoryPolicyResult {
  history: unknown[];
  record: AgentMemoryPolicyRecord;
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

/** Deterministic, model-free history compaction at AgentSession turn boundaries. */
export class AgentMemoryPolicy {
  private readonly maxMessages: number;
  private readonly maxBytes: number;
  private readonly maxMessageBytes: number;

  constructor(options: AgentMemoryPolicyOptions = {}) {
    this.maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    if (!Number.isSafeInteger(this.maxMessages) || this.maxMessages < 2) {
      throw new Error("Agent memory maxMessages must be an integer of at least 2.");
    }
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1024) {
      throw new Error("Agent memory maxBytes must be an integer of at least 1024.");
    }
    if (!Number.isSafeInteger(this.maxMessageBytes) || this.maxMessageBytes < 256) {
      throw new Error("Agent memory maxMessageBytes must be an integer of at least 256.");
    }
  }

  compact(history: readonly unknown[]): AgentMemoryPolicyResult {
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
    let replacementSummary = false;

    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const group = groups[index]!;
      const groupBytes = historyBytes(group);
      const fits = retainedMessages + group.length <= this.maxMessages
        && retainedBytes + groupBytes <= this.maxBytes;
      if (!fits && retained.length > 0) break;
      if (!fits) {
        retained.push([this.createSummaryMessage(history.length, bytesBefore, "latest_group_exceeded_budget")]);
        retainedMessages = 1;
        retainedBytes = historyBytes(retained[0]!);
        replacementSummary = true;
        break;
      }
      retained.unshift(group);
      retainedMessages += group.length;
      retainedBytes += groupBytes;
    }

    let compacted = retained.flat();
    const droppedMessagesBeforeSummary = Math.max(0, history.length - compacted.length);
    let hasCompactionSummary = replacementSummary;
    if (droppedMessagesBeforeSummary > 0 && !replacementSummary) {
      compacted.unshift(this.createSummaryMessage(
        droppedMessagesBeforeSummary,
        Math.max(0, bytesBefore - historyBytes(compacted)),
        "older_history_compacted",
      ));
      hasCompactionSummary = true;
    }

    while (
      compacted.length > 1
      && (compacted.length > this.maxMessages || historyBytes(compacted) > this.maxBytes)
    ) {
      const nextUserIndex = compacted.findIndex((message, index) => index > 1 && getRole(message) === "user");
      if (nextUserIndex <= 0) break;
      compacted.splice(1, nextUserIndex - 1);
    }

    if (
      hasCompactionSummary
      && (compacted.length > this.maxMessages || historyBytes(compacted) > this.maxBytes)
    ) {
      compacted.shift();
      hasCompactionSummary = false;
    }

    const bytesAfter = historyBytes(compacted);
    return {
      history: compacted,
      record: {
        policyVersion: 1,
        maxMessages: this.maxMessages,
        maxBytes: this.maxBytes,
        messagesBefore: history.length,
        messagesAfter: compacted.length,
        bytesBefore,
        bytesAfter,
        droppedMessages: Math.max(
          0,
          history.length - (compacted.length - (hasCompactionSummary ? 1 : 0)),
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
        message: { role: "user", content: "[memory-policy: oversized non-object message omitted]" },
        truncated: true,
      };
    }

    const role = getRole(message);
    const originalBytes = messageBytes(message);
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
            reason: "memory_policy_oversize",
            originalBytes,
            observedTick,
            message: "This old oversized tool result was omitted. Read current state again before acting.",
          }),
        },
        truncated: true,
      };
    }

    if (typeof message.content === "string") {
      const suffix = `\n[memory-policy: truncated oversized ${role} message; originalBytes=${originalBytes}]`;
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
        content: `[memory-policy: oversized ${role} message omitted; originalBytes=${originalBytes}]`,
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

  private createSummaryMessage(droppedMessages: number, droppedBytes: number, reason: string): unknown {
    return {
      role: "user",
      content: JSON.stringify({
        memorySummaryVersion: 1,
        reason,
        droppedMessages,
        droppedBytes,
        instruction: "Earlier conversation details were compacted. Re-read current game state before relying on old observations.",
      }),
    };
  }
}
