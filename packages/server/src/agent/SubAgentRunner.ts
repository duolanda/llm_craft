import { AgentRunInput } from "@llmcraft/shared";
import {
  AgentToolExecutionResult,
  AgentToolDefinition,
  SubAgentParentContext,
} from "../LLMProvider";
import { SYSTEM_PROMPT } from "../SystemPrompt";
import type { ModelCompletionResult } from "../model/ModelTransport";

const SUB_AGENT_CONSTRAINTS = `
## 你是子 Agent（执行 worker）

- 你是父 Agent 派出的执行 worker，不是战略规划者。
- 父 Agent 已经完成了总体规划、侦察和局势评估。
- 你只需要执行 objective 中描述的任务。
- 优先只操作分配给 assignedUnits 和 assignedBuildings 的单位/建筑。
- 不要重新制定全局战略。
- 不要接管未分配给你的单位或建筑。
- 不要质疑或重新评估父 Agent 的规划。
- 如果任务客观上不可执行，报告原因并停止；不要扩大任务范围。
- 你不能调用 spawn_agent 工具。
`;

const SUB_AGENT_MAX_TOKENS = 2048;
const SUB_AGENT_TEMPERATURE = 0.7;

type CreateSubAgentCompletion = (
  request: {
    messages: unknown[];
    tools: AgentToolDefinition[];
    temperature: number;
    maxTokens: number;
  },
  signal: AbortSignal,
) => Promise<ModelCompletionResult>;

function parseToolArgs(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function findLeaseViolation(
  args: unknown,
  assignedUnits: ReadonlySet<string>,
  assignedBuildings: ReadonlySet<string>,
): { kind: "unit" | "building"; id: string } | null {
  if (!args || typeof args !== "object") return null;
  if (Array.isArray(args)) {
    for (const value of args) {
      const violation = findLeaseViolation(value, assignedUnits, assignedBuildings);
      if (violation) return violation;
    }
    return null;
  }
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (key === "selection") {
      return { kind: "unit", id: `selection:${String(value)}` };
    }
    if (key === "unitId" && typeof value === "string" && !assignedUnits.has(value)) {
      return { kind: "unit", id: value };
    }
    if (key === "unitIds" && Array.isArray(value)) {
      const unitId = value.map(String).find((id) => !assignedUnits.has(id));
      if (unitId) return { kind: "unit", id: unitId };
    }
    if (key === "buildingId" && typeof value === "string" && !assignedBuildings.has(value)) {
      return { kind: "building", id: value };
    }
    const violation = findLeaseViolation(value, assignedUnits, assignedBuildings);
    if (violation) return violation;
  }
  return null;
}

function requireExplicitUnitIds(tool: AgentToolDefinition): AgentToolDefinition {
  const parameters = tool.parameters;
  const properties = parameters.properties;
  if (!properties || typeof properties !== "object" || !("selection" in properties)) {
    return tool;
  }
  const { selection: _selection, ...explicitProperties } = properties as Record<string, unknown>;
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((value): value is string => typeof value === "string")
    : [];
  const description = tool.description
    .replace("explicitly listed combat units or a dynamic execution-time combat selection", "one or more explicitly assigned combat units")
    .replace("explicitly listed units or a dynamic execution-time selection", "one or more explicitly assigned units")
    .replace(" Pass exactly one of unitIds or selection.", " Pass assigned unitIds.");
  return {
    ...tool,
    description,
    parameters: {
      ...parameters,
      required: [...new Set([...required, "unitIds"])],
      properties: explicitProperties,
    },
  };
}

function formatSubAgentUserMessage(
  input: AgentRunInput,
  runtimeState: SubAgentParentContext["runtimeState"],
  description: string,
  objective: string,
  assignedUnits?: string[],
  assignedBuildings?: string[],
  constraints?: string,
  successCriteria?: string,
): string {
  return JSON.stringify(
    {
      parentPlayerId: input.playerId,
      parentTick: input.tick,
      taskDescription: description,
      objective,
      assignedUnits: assignedUnits ?? [],
      assignedBuildings: assignedBuildings ?? [],
      constraints: constraints ?? null,
      successCriteria: successCriteria ?? null,
      currentRuntimeState: runtimeState,
    },
    null,
    2,
  );
}

function formatNotificationXML(
  taskId: string,
  description: string,
  status: "completed" | "failed" | "aborted",
  objective: string,
  result: string,
): string {
  return [
    "<sub-agent-result>",
    `taskId: ${taskId}`,
    `description: ${description}`,
    `status: ${status}`,
    `objective: ${objective}`,
    "result:",
    result,
    "</sub-agent-result>",
  ].join("\n");
}

export interface SubAgentRunConfig {
  createCompletion: CreateSubAgentCompletion;
  systemPrompt?: string;
  taskId: string;
  description: string;
  objective: string;
  assignedUnits?: string[];
  assignedBuildings?: string[];
  constraints?: string;
  successCriteria?: string;
  parentContext: SubAgentParentContext;
  signal: AbortSignal;
}

export async function runSubAgentTask(config: SubAgentRunConfig): Promise<string> {
  const {
    createCompletion,
    systemPrompt,
    taskId,
    description,
    objective,
    assignedUnits,
    assignedBuildings,
    constraints,
    successCriteria,
    parentContext,
    signal,
  } = config;

  const subAgentSystemPrompt = (systemPrompt ?? SYSTEM_PROMPT) + SUB_AGENT_CONSTRAINTS;
  const filteredTools: AgentToolDefinition[] = parentContext.tools
    .filter((tool) => tool.name !== "spawn_agent")
    .map(requireExplicitUnitIds);

  const userMessage = formatSubAgentUserMessage(
    parentContext.input,
    parentContext.runtimeState,
    description,
    objective,
    assignedUnits,
    assignedBuildings,
    constraints,
    successCriteria,
  );

  const messages: any[] = [
    { role: "system", content: subAgentSystemPrompt },
    { role: "user", content: userMessage },
  ];

  const assistantTexts: string[] = [];
  const leasedUnits = new Set(assignedUnits ?? []);
  const leasedBuildings = new Set(assignedBuildings ?? []);
  let modelRequests = 0;

  while (true) {
    if (signal.aborted) {
      return formatNotificationXML(taskId, description, "aborted", objective, assistantTexts.join("\n") || "Aborted before completion.");
    }

    const response = await createCompletion(
      {
        messages,
        tools: filteredTools,
        temperature: SUB_AGENT_TEMPERATURE,
        maxTokens: SUB_AGENT_MAX_TOKENS,
      },
      signal,
    );

    modelRequests++;
    if (modelRequests > 20) {
      return formatNotificationXML(taskId, description, "failed", objective, "Sub-agent exceeded maximum model requests.");
    }

    const assistantMessage = response.message;
    if (!assistantMessage) {
      return formatNotificationXML(taskId, description, "failed", objective, "Sub-agent received empty response.");
    }

    messages.push(assistantMessage);

    const text = typeof assistantMessage.content === "string" ? assistantMessage.content : "";
    if (text) {
      assistantTexts.push(text);
    }

    const toolCalls = assistantMessage.tool_calls ?? [];
    if (toolCalls.length === 0) {
      const finishReason = response.finishReason;
      const status = finishReason === "stop" ? "completed" : "failed";
      return formatNotificationXML(taskId, description, status, objective, assistantTexts.join("\n") || "(no text output)");
    }

    for (const toolCall of toolCalls) {
      const args = parseToolArgs(toolCall.function.arguments);
      let execution: AgentToolExecutionResult;
      try {
        const violation = findLeaseViolation(args, leasedUnits, leasedBuildings);
        if (violation) {
          execution = {
            effect: "read",
            result: {
              ok: false,
              error: "resource_not_leased",
              resourceType: violation.kind,
              resourceId: violation.id,
            },
          };
        } else {
          execution = await parentContext.executeTool(toolCall.function.name, args, {
            toolCallId: toolCall.id,
            controllerId: `subagent:${taskId}`,
            parentControllerId: parentContext.controllerId,
            turnId: parentContext.turnId,
            source: "subagent",
          });
        }
      } catch (error) {
        execution = {
          effect: "read",
          result: { ok: false, error: error instanceof Error ? error.message : String(error) },
        };
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(execution.result),
        name: toolCall.function.name,
      });
    }
  }
}
