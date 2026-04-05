import { VM } from "vm2";
import { Command, AIStatePackage } from "@llmcraft/shared";
import { APIBridge } from "./APIBridge";

export interface AISandboxResult {
  commands: Command[];
  errorMessage?: string;
}

export class AISandbox {
  private playerId: string;
  private bridge: APIBridge;

  constructor(playerId: string) {
    this.playerId = playerId;
    this.bridge = new APIBridge(playerId);
  }

  async executeCode(code: string, state: AIStatePackage): Promise<AISandboxResult> {
    this.bridge.clearCommands();
    const api = this.bridge.createAPI(state);

    try {
      // 使用 vm2 创建隔离环境
      const vm = new VM({
        timeout: 50, // 50ms 超时
        sandbox: {
          game: api.game,
          me: api.me,
          enemies: api.enemies,
          enemyBuildings: api.enemyBuildings,
          aiFeedbackSinceLastCall: api.aiFeedbackSinceLastCall,
          map: api.map,
          unitStats: api.unitStats,
          buildingStats: api.buildingStats,
          economy: api.economy,
          utils: api.utils,
          console: { log: () => {} } // 禁用 console.log
        }
      });

      vm.run(code);
    } catch (e) {
      console.error(`AI ${this.playerId} 代码执行错误:`, e);
      return {
        commands: this.bridge.getCommands(),
        errorMessage: e instanceof Error ? e.message : String(e),
      };
    }

    return { commands: this.bridge.getCommands() };
  }
}
