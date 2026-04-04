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

  async runAI(playerId: string): Promise<void> {
    const state = this.game.getState();
    const packageBuilder = AIStatePackageBuilder;
    const aiPackage = packageBuilder.build(playerId, state);

    const sandbox = playerId === "player_1" ? this.ai1 : this.ai2;
    const openai = playerId === "player_1" ? this.openai1 : this.openai2;

    try {
      const code = await openai.generateCode(aiPackage);
      this.game.setAIOutput(playerId, code);

      const commands = await sandbox.executeCode(code, aiPackage);
      for (const cmd of commands) {
        this.game.queueCommand(cmd);
      }
    } catch (e) {
      console.error(`AI 错误 ${playerId}:`, e);
    }
  }

  async start(): Promise<void> {
    this.game.start();

    // 轮询 AI 更新
    const poll = async () => {
      const state = this.game.getState();
      if (state.winner) return;

      for (const playerId of ["player_1", "player_2"]) {
        if (state.tick - this.lastAITick[playerId as keyof typeof this.lastAITick] >= this.aiInterval) {
          this.lastAITick[playerId as keyof typeof this.lastAITick] = state.tick;
          this.runAI(playerId); // 发射后不管
        }
      }

      setTimeout(poll, 100);
    };

    poll();
  }

  stop(): void {
    this.game.stop();
  }
}
