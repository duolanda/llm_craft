import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { OpenAICompatibleRuntimeConfig } from "@llmcraft/shared";
import { GameOrchestrator } from "../src/GameOrchestrator";
import { BUILTIN_PRESET_SECRET, PresetStore } from "../src/PresetStore";
import { PromptStore } from "../src/PromptStore";
import { createPromptReflectionMessage, describePromptReflectionError, normalizeReflectedPrompt, type PromptReflectionInput } from "../src/PromptReflection";
import { retryModelRequest } from "../src/agent/ModelRequestRetry";
import { readModelResponse } from "../src/model/ModelResponse";
import { OpenAICompatibleModelTransport } from "../src/model/OpenAICompatibleModelTransport";
import { RateLimitedModelTransport } from "../src/model/RateLimitedModelTransport";
import type { ModelCompletionRequest, ModelCompletionResult } from "../src/model/ModelTransport";

type FrozenRequest = Omit<ModelCompletionRequest, "signal">;
interface ReflectionFixture {
  format: "reflection-eval-v1";
  capturedAt: string;
  matchId: string;
  input: PromptReflectionInput;
  presetId: string;
  model: string;
  settingsHash: string;
  requestHash: string;
  request: FrozenRequest;
}

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(serverDir, "../..");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const settingsHash = (config: OpenAICompatibleRuntimeConfig) => hash({
  providerType: config.providerType, model: config.model, baseURL: config.baseURL,
  rpm: config.rpm ?? null, reasoningEffort: config.reasoningEffort ?? null,
  extraRequestParams: config.extraRequestParams ?? null,
});
const inputPath = (value: string) => resolve(repoDir, value);

async function writeNew(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, { flag: "wx", mode: 0o600 });
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      fixture: { type: "string" }, preset: { type: "string" },
      "opponent-preset": { type: "string" }, prompt: { type: "string" }, version: { type: "string" },
      instruction: { type: "string" }, label: { type: "string" }, runs: { type: "string", default: "1" },
      "instruction-role": { type: "string" },
      "max-minutes": { type: "string", default: "30" },
    },
  });
  const command = positionals[0];
  if (!values.fixture || !["capture", "run"].includes(command ?? "")) {
    throw new Error("Usage: reflection-eval capture --fixture <file> --preset <id> [--opponent-preset <id>] [--prompt <id> --version <id>] | run --fixture <file> --label <name> [--instruction <file|current>] [--runs <n>]. Paths are relative to the repository root.");
  }
  const fixturePath = inputPath(values.fixture);
  const presetStore = new PresetStore({ filePath: resolve(serverDir, "data/llm-presets.json"), encryptionSecret: BUILTIN_PRESET_SECRET });

  if (command === "capture") {
    if (!values.preset) throw new Error("capture requires --preset");
    if (Boolean(values.prompt) !== Boolean(values.version)) throw new Error("--prompt and --version must be supplied together");
    const config = await presetStore.getRuntimeConfig(values.preset);
    const opponent = values["opponent-preset"]
      ? await presetStore.getRuntimeConfig(values["opponent-preset"])
      : { providerType: "builtin-cpu" as const, strategy: "rush" as const };
    const prompt = values.prompt && values.version
      ? await new PromptStore({ filePath: resolve(serverDir, "data/strategy-prompts.json") }).resolve({ promptId: values.prompt, versionId: values.version })
      : undefined;
    const maxMinutes = Number(values["max-minutes"]);
    if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) throw new Error("--max-minutes must be positive");
    if (await access(fixturePath).then(() => true, () => false)) throw new Error("Fixture already exists; choose a new path");
    // Reserve the destination before starting any paid model requests.
    await writeNew(`${fixturePath}.capture.json`, JSON.stringify({ presetId: values.preset, startedAt: new Date().toISOString() }, null, 2));
    const orchestrator = new GameOrchestrator({
      player1: config, player2: opponent,
      ...(prompt ? { strategyPrompts: { player_1: prompt } } : {}),
      debug: { recordingProfile: "evaluation", includeTranscript: true },
      runtime: { recordDir: resolve(dirname(fixturePath), "records") },
    });
    const captureController = new AbortController();
    const stop = () => { captureController.abort(); orchestrator.stop(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const deadline = setTimeout(stop, maxMinutes * 60_000);
    const progress = setInterval(() => {
      const state = orchestrator.getGame().getAgentReadState();
      console.log(JSON.stringify({ phase: "playing", matchId: orchestrator.getMatchId(), tick: state.tick,
        players: state.players.map(p => ({ id: p.id, credits: p.resources.credits, units: p.units.length, buildings: p.buildings.length })) }));
    }, 30_000);
    try {
      console.log(JSON.stringify({ phase: "starting", model: config.model, opponent: opponent.providerType, matchId: orchestrator.getMatchId() }));
      await orchestrator.warmup({ player_1: true, ...(opponent.providerType === "openai-compatible" ? { player_2: true } : {}) });
      await orchestrator.start();
      const end = await orchestrator.waitForEnd();
      clearInterval(progress);
      clearTimeout(deadline);
      await orchestrator.quiesce();
      const recordPath = await orchestrator.saveRecord();
      if (end.status !== "finished" || !end.state.winner) throw new Error(`Capture requires a natural terminal result. Saved interrupted match: ${recordPath}`);
      const input: PromptReflectionInput = { playerId: "player_1", winner: end.state.winner, finalTick: end.state.tick };
      const result = await orchestrator.reflectPrompt("player_1", {
        signal: AbortSignal.any([captureController.signal, AbortSignal.timeout(180_000)]),
        onRequest: async (request) => {
          const fixture: ReflectionFixture = { format: "reflection-eval-v1", capturedAt: new Date().toISOString(),
            matchId: orchestrator.getMatchId(), input, presetId: values.preset!, model: config.model,
            settingsHash: settingsHash(config), requestHash: hash(request), request };
          await writeNew(fixturePath, JSON.stringify(fixture, null, 2));
          console.log(JSON.stringify({ phase: "captured", fixturePath, recordPath, hash: fixture.requestHash, messages: request.messages.length, tools: request.tools?.length ?? 0 }));
        },
      });
      await writeNew(`${fixturePath}.capture-output.md`, `# ${result.title}\n\n${result.content}\n`);
      console.log(JSON.stringify({ phase: "complete", title: result.title, characters: [...result.content].length }));
    } finally {
      clearInterval(progress);
      clearTimeout(deadline);
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      await orchestrator.quiesce();
    }
    return;
  }

  const fixture: ReflectionFixture = JSON.parse(await readFile(fixturePath, "utf8"));
  if (fixture.format !== "reflection-eval-v1" || hash(fixture.request) !== fixture.requestHash) throw new Error("Invalid or changed reflection fixture");
  const config = await presetStore.getRuntimeConfig(values.preset ?? fixture.presetId);
  if (settingsHash(config) !== fixture.settingsHash) throw new Error("Preset model/endpoint/parameters differ from the captured fixture");
  const runs = Number(values.runs);
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 10) throw new Error("--runs must be an integer from 1 to 10");
  if (!values.label || !/^[a-z0-9][a-z0-9_-]*$/i.test(values.label)) throw new Error("--label must use letters, digits, underscores or hyphens");
  const request = structuredClone(fixture.request);
  const finalMessage = request.messages.at(-1);
  if (!finalMessage || typeof finalMessage !== "object" || !("role" in finalMessage) || !["user", "system"].includes(String(finalMessage.role))
    || !("content" in finalMessage) || typeof finalMessage.content !== "string") throw new Error("Fixture must end with the reflection instruction");
  const instructionRole = values["instruction-role"] ?? String(finalMessage.role);
  if (!["user", "system"].includes(instructionRole)) throw new Error("--instruction-role must be user or system");
  const instruction = values.instruction === "current"
    ? createPromptReflectionMessage(fixture.input)
    : values.instruction ? await readFile(inputPath(values.instruction), "utf8") : undefined;
  if (instruction !== undefined || values["instruction-role"] !== undefined) {
    if (instruction !== undefined && !instruction.trim()) throw new Error("Empty reflection instruction");
    request.messages[request.messages.length - 1] = { role: instructionRole, content: instruction ?? finalMessage.content };
  }
  const prefixHash = hash({ ...request, messages: request.messages.slice(0, -1) });
  const baselinePrefixHash = hash({ ...fixture.request, messages: fixture.request.messages.slice(0, -1) });
  if (prefixHash !== baselinePrefixHash) throw new Error("Only the final reflection instruction may change");
  const outputDir = resolve(dirname(fixturePath), values.label);
  await mkdir(outputDir); // Labels are immutable: fail before charging if already used.
  await writeNew(resolve(outputDir, "instruction.txt"), instruction ?? finalMessage.content);
  const transport = new RateLimitedModelTransport(new OpenAICompatibleModelTransport(config), config.rpm);
  for (let run = 1; run <= runs; run++) {
    const startedAt = Date.now();
    const signal = AbortSignal.timeout(180_000);
    const identity = { fixtureHash: fixture.requestHash, requestHash: hash(request), prefixHash, settingsHash: fixture.settingsHash, instructionRole };
    let retries = 0;
    let response: ModelCompletionResult;
    try {
      response = await retryModelRequest(() => transport.complete({ ...structuredClone(request), signal }), {
        signal,
        onRetry: progress => {
          retries = progress.attempt;
          console.log(JSON.stringify({ label: values.label, run, phase: progress.phase, attempt: progress.attempt }));
        },
      });
    } catch (error) {
      await writeNew(resolve(outputDir, `${run}.error.json`), JSON.stringify({ ...identity, retries, elapsedMs: Date.now() - startedAt, error: describePromptReflectionError(error) }, null, 2));
      throw error;
    }
    // Preserve the raw response even if output validation fails; never write PromptStore.
    await writeNew(resolve(outputDir, `${run}.json`), JSON.stringify({ ...identity, retries, elapsedMs: Date.now() - startedAt, response }, null, 2));
    const message = readModelResponse(response);
    if (message.tool_calls?.length) throw new Error("Unexpected tool calls in reflection evaluation");
    const output = normalizeReflectedPrompt(message.content);
    await writeNew(resolve(outputDir, `${run}.md`), `# ${output.title}\n\n${output.content}\n`);
    console.log(JSON.stringify({ label: values.label, run, title: output.title, characters: [...output.content].length, paragraphs: output.content.split(/\n\s*\n/).length,
      latencyMs: Date.now() - startedAt, usage: response.usage, prefixHash, outputDir }));
  }
}

main().catch(error => {
  // Provider errors may contain headers or request bodies; report only known categories.
  console.error(error instanceof Error && !('status' in error) && !('headers' in error) ? error.message : describePromptReflectionError(error));
  process.exitCode = 1;
});
