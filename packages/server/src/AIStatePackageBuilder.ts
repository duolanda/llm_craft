import { GameState, Player, AIStatePackage } from "@llmcraft/shared";

export class AIStatePackageBuilder {
  static build(playerId: string, state: GameState): AIStatePackage {
    const player = state.players.find(p => p.id === playerId)!;
    const enemy = state.players.find(p => p.id !== playerId)!;

    return {
      tick: state.tick,
      my: {
        resources: player.resources,
        units: player.units.filter(u => u.exists).map(u => ({ ...u, my: true })),
        buildings: player.buildings.filter(b => b.exists).map(b => ({ ...b, my: true })),
      },
      visibleEnemies: [
        ...enemy.units.filter(u => u.exists).map(u => ({ id: u.id, type: u.type, x: u.x, y: u.y, hp: u.hp })),
        ...enemy.buildings.filter(b => b.exists).map(b => ({ id: b.id, type: b.type, x: b.x, y: b.y, hp: b.hp })),
      ],
      map: {
        width: 20,
        height: 20,
        visibleTiles: [], // MVP: 全图可见
      },
      eventsSinceLastCall: state.logs.slice(-10), // 最近10条日志
      gameTimeRemaining: 600 - state.tick / 2, // 假设600秒游戏时间
    };
  }
}
