import { AIStatePackage } from "@llmcraft/shared";
import { Game } from "./Game";
import { AISandbox } from "./AISandbox";
import { OpenAIClient, OpenAIClientConfig } from "./OpenAIClient";
import { AIStatePackageBuilder } from "./AIStatePackageBuilder";

export class GameOrchestrator {
  private game: Game;
  private ai1: AISandbox;
  private ai2: AISandbox;
  private openai1: OpenAIClient;
  private openai2: OpenAIClient;
  private lastAITick = { player_1: -100, player_2: -100 };
  private aiInterval = 5; // AI 每 5 个 tick 思考一次
  private isRunningAI = { player_1: false, player_2: false }; // 防止并发调用
  private isPolling = false;
  private pollTimeout: NodeJS.Timeout | null = null;
  private runSession = 0;

  constructor(config: OpenAIClientConfig) {
    this.game = new Game();
    this.ai1 = new AISandbox("player_1");
    this.ai2 = new AISandbox("player_2");
    this.openai1 = new OpenAIClient(config);
    this.openai2 = new OpenAIClient(config);
  }

  getGame(): Game {
    return this.game;
  }

  async runAI(playerId: string, sessionId = this.runSession): Promise<void> {
    // 防止并发调用
    if (this.isRunningAI[playerId as keyof typeof this.isRunningAI]) return;
    this.isRunningAI[playerId as keyof typeof this.isRunningAI] = true;

    try {
      const state = this.game.getState();
      const packageBuilder = AIStatePackageBuilder;
      const aiPackage = packageBuilder.build(playerId, state, this.game);

      const sandbox = playerId === "player_1" ? this.ai1 : this.ai2;
      const openai = playerId === "player_1" ? this.openai1 : this.openai2;

      const code = await openai.generateCode(aiPackage);
      if (!this.isPolling || sessionId !== this.runSession) {
        return;
      }
      this.game.setAIOutput(playerId, code);

      const { commands, errorMessage } = await sandbox.executeCode(code, aiPackage);
      if (!this.isPolling || sessionId !== this.runSession) {
        return;
      }
      if (errorMessage) {
        this.game.addAIFeedback(playerId, "execution", "error", errorMessage, { code });
      }
      for (const cmd of commands) {
        this.game.queueCommand(cmd);
      }
    } catch (e) {
      console.error(`AI 错误 ${playerId}:`, e);
      this.game.addAIFeedback(
        playerId,
        "generation",
        "error",
        e instanceof Error ? e.message : String(e)
      );
    } finally {
      this.isRunningAI[playerId as keyof typeof this.isRunningAI] = false;
    }
  }

  async start(): Promise<void> {
    if (this.isPolling) return;

    this.runSession++;
    this.isPolling = true;
    this.game.start();

    // 轮询 AI 更新
    const poll = async () => {
      if (!this.isPolling) return;

      const state = this.game.getState();
      if (state.winner) {
        this.stop();
        return;
      }

      for (const playerId of ["player_1", "player_2"]) {
        if (state.tick - this.lastAITick[playerId as keyof typeof this.lastAITick] >= this.aiInterval) {
          this.lastAITick[playerId as keyof typeof this.lastAITick] = state.tick;
          void this.runAI(playerId, this.runSession);
        }
      }

      this.pollTimeout = setTimeout(poll, 100);
    };

    await poll();
  }

  stop(): void {
    this.isPolling = false;
    this.runSession++;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
    this.game.stop();
  }
}
