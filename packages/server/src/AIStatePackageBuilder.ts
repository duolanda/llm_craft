import { GameState, Player, AIStatePackage, UNIT_STATS, TILE_TYPES } from "@llmcraft/shared";

export class AIStatePackageBuilder {
  static build(playerId: string, state: GameState): AIStatePackage {
    const player = state.players.find(p => p.id === playerId)!;
    const enemy = state.players.find(p => p.id !== playerId)!;

    // 扁平化地图数据：只传送非空地块（减少数据量）
    const tiles = [];
    for (let y = 0; y < state.tiles.length; y++) {
      for (let x = 0; x < state.tiles[y].length; x++) {
        const tile = state.tiles[y][x];
        if (tile.type !== TILE_TYPES.EMPTY) {
          tiles.push({ x, y, type: tile.type });
        }
      }
    }

    return {
      tick: state.tick,
      my: {
        resources: player.resources,
        units: player.units.filter(u => u.exists).map(u => ({ ...u, my: true })),
        buildings: player.buildings.filter(b => b.exists).map(b => ({ ...b, my: true })),
      },
      visibleEnemies: enemy.units
        .filter(u => u.exists)
        .map(u => ({ id: u.id, type: u.type, x: u.x, y: u.y, hp: u.hp, maxHp: u.maxHp })),
      enemyBuildings: enemy.buildings
        .filter(b => b.exists)
        .map(b => ({ id: b.id, type: b.type, x: b.x, y: b.y, hp: b.hp, maxHp: b.maxHp })),
      map: {
        width: 20,
        height: 20,
        tiles, // 所有非空地块（障碍物、资源）
      },
      unitStats: UNIT_STATS, // 单位属性表
      eventsSinceLastCall: state.logs.slice(-10),
      gameTimeRemaining: 600 - state.tick / 2,
    };
  }
}
