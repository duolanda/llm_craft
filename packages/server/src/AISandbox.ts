import { VM } from "vm2";
import { Command } from "@llmcraft/shared";
import { APIBridge } from "./APIBridge";

export interface AIStatePackage {
  tick: number;
  my: {
    resources: { energy: number; energyPerTick: number; };
    units: any[];
    buildings: any[];
  };
  visibleEnemies: any[];
  map: { width: number; height: number; visibleTiles: any[]; };
  eventsSinceLastCall: any[];
  gameTimeRemaining: number;
}

export class AISandbox {
  private playerId: string;
  private bridge: APIBridge;

  constructor(playerId: string) {
    this.playerId = playerId;
    this.bridge = new APIBridge(playerId);
  }

  async executeCode(code: string, state: AIStatePackage): Promise<Command[]> {
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
          map: api.map,
          utils: api.utils,
          console: { log: () => {} } // 禁用 console.log
        }
      });

      vm.run(code);
    } catch (e) {
      console.error(`AI ${this.playerId} 代码执行错误:`, e);
    }

    return this.bridge.getCommands();
  }
}
