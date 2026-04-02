import { Unit, Building, Command, Position, Player, AIStatePackage } from "@llmcraft/shared";

export class APIBridge {
  private commands: Command[] = [];
  private playerId: string;

  constructor(playerId: string) {
    this.playerId = playerId;
  }

  createAPI(state: AIStatePackage) {
    const self = this;

    const wrapUnit = (unit: any) => ({
      ...unit,
      moveTo: (pos: Position) => {
        self.commands.push({
          id: `cmd_${Date.now()}_${Math.random()}`,
          type: "move",
          unitId: unit.id,
          position: pos,
          playerId: self.playerId,
        });
      },
      attack: (targetId: string) => {
        self.commands.push({
          id: `cmd_${Date.now()}_${Math.random()}`,
          type: "attack",
          unitId: unit.id,
          targetId,
          playerId: self.playerId,
        });
      },
      holdPosition: () => {
        self.commands.push({
          id: `cmd_${Date.now()}_${Math.random()}`,
          type: "hold",
          unitId: unit.id,
          playerId: self.playerId,
        });
      },
    });

    const wrapBuilding = (building: any) => ({
      ...building,
      spawnUnit: (unitType: string) => {
        self.commands.push({
          id: `cmd_${Date.now()}_${Math.random()}`,
          type: "spawn",
          buildingId: building.id,
          unitType: unitType as any,
          playerId: self.playerId,
        });
      },
    });

    const myUnits = state.my.units.map(wrapUnit);
    const myBuildings = state.my.buildings.map(wrapBuilding);

    return {
      game: {
        tick: state.tick,
        timeRemaining: state.gameTimeRemaining,
      },
      me: {
        units: myUnits,
        buildings: myBuildings,
        resources: state.my.resources,
        hq: myBuildings.find((b: any) => b.type === "hq") || null,
        workers: myUnits.filter((u: any) => u.type === "worker"),
        soldiers: myUnits.filter((u: any) => u.type === "soldier"),
        scouts: myUnits.filter((u: any) => u.type === "scout"),
      },
      enemies: state.visibleEnemies,
      map: { width: 20, height: 20 },
      utils: {
        getRange: (a: Position, b: Position) => Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2)),
        inRange: (a: Position, b: Position, range: number) => Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2)) <= range,
        findClosestByRange: (from: Position, targets: any[]) => {
          if (targets.length === 0) return null;
          let closest = targets[0];
          let minDist = Infinity;
          for (const t of targets) {
            const dist = Math.sqrt(Math.pow(from.x - t.x, 2) + Math.pow(from.y - t.y, 2));
            if (dist < minDist) { minDist = dist; closest = t; }
          }
          return closest;
        },
      },
    };
  }

  getCommands(): Command[] { return this.commands; }
  clearCommands(): void { this.commands = []; }
}
