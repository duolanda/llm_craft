import { AgentRunInput, AgentToolCallRecord, BuiltinCPURuntimeConfig } from "@llmcraft/shared";
import {
  LLMConnectionTestResult,
  LLMProvider,
  RunAgentOptions,
  RunAgentResult,
  RunSubAgentTaskInput,
  WarmupAgentResult,
} from "../LLMProvider";
import { runBuiltinCPUStrategy } from "./BuiltinCPUStrategy";

export class BenchmarkCPUProvider implements LLMProvider {
  constructor(private readonly config: BuiltinCPURuntimeConfig) {}

  async warmupAgent(_input: AgentRunInput, options: RunAgentOptions): Promise<WarmupAgentResult> {
    if (options.signal?.aborted) {
      return {
        assistantMessages: [],
        stopReason: "aborted",
        hasPendingToolCalls: false,
        metrics: { modelRequests: 0 },
      };
    }

    return {
      assistantMessages: [],
      stopReason: "cpu_warmup_complete",
      hasPendingToolCalls: false,
      metrics: { modelRequests: 0 },
    };
  }

  async testConnection(): Promise<LLMConnectionTestResult> {
    return {
      responseText: "OK",
    };
  }

  async runSubAgentTask(_input: RunSubAgentTaskInput): Promise<string> {
    return [
      "<sub-agent-result>",
      "taskId: cpu-unavailable",
      "description: CPU provider does not support sub-agents",
      "status: failed",
      "objective: unavailable",
      "result:",
      "spawn_agent is unavailable for builtin CPU providers.",
      "</sub-agent-result>",
    ].join("\n");
  }

  async runAgent(_input: AgentRunInput, options: RunAgentOptions): Promise<RunAgentResult> {
    if (options.signal?.aborted) {
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

    let toolCallId = 0;
    const toolCalls: AgentToolCallRecord[] = [];
    const callTool = async (toolName: string, args: Record<string, unknown>) => {
      const execution = await options.executeTool(toolName, args);
      const toolCallRecord = {
        toolCallId: `cpu_tool_${++toolCallId}`,
        toolName,
        args,
        result: execution.result,
        isError:
          execution.result instanceof Object && "ok" in (execution.result as Record<string, unknown>)
            ? (execution.result as Record<string, unknown>).ok === false
            : false,
      };
      toolCalls.push(toolCallRecord);
      options.onToolCall?.(toolCallRecord);
      return execution.result;
    };

    await runBuiltinCPUStrategy({
      strategy: this.config.strategy,
      runtime: options.getRuntimeState(),
      callTool,
    });

    return {
      assistantMessages: [],
      toolCalls,
      plans: [],
      stopReason: "cpu_turn_complete",
      metrics: {
        modelRequests: 1,
        toolCalls: toolCalls.length,
        stallDetected: false,
      },
    };
  }

  getModel(): string {
    return `cpu-${this.config.strategy}`;
  }

  getBaseURL(): string | undefined {
    return undefined;
  }
}
