const vm = require("node:vm");
const { AI_SANDBOX_TIMEOUT_MS } = require("./AISandbox.constants.cjs");

let commandCounter = 0;
const DEFAULT_ATTACK_PRIORITY = ["hq", "soldier", "worker", "barracks"];

function generateId() {
  commandCounter += 1;
  return `cmd_${Date.now()}_${commandCounter}`;
}

function buildAPI(playerId, state) {
  const commands = [];

  const wrapUnit = (unit) => ({
    ...unit,
    moveTo: (pos) => {
      commands.push({
        id: generateId(),
        type: "move",
        unitId: unit.id,
        position: pos,
        playerId,
      });
    },
    attack: (targetId) => {
      commands.push({
        id: generateId(),
        type: "attack",
        unitId: unit.id,
        targetId,
        playerId,
      });
    },
    attackInRange: (targetPriority) => {
      commands.push({
        id: generateId(),
        type: "attack_in_range",
        unitId: unit.id,
        targetPriority:
          targetPriority && targetPriority.length > 0
            ? targetPriority.map((value) => String(value))
            : [...DEFAULT_ATTACK_PRIORITY],
        playerId,
      });
    },
    holdPosition: () => {
      commands.push({
        id: generateId(),
        type: "hold",
        unitId: unit.id,
        playerId,
      });
    },
    build: (buildingType, pos) => {
      commands.push({
        id: generateId(),
        type: "build",
        unitId: unit.id,
        buildingType,
        position: pos,
        playerId,
      });
    },
  });

  const wrapBuilding = (building) => ({
    ...building,
    spawnUnit: (unitType) => {
      commands.push({
        id: generateId(),
        type: "spawn",
        buildingId: building.id,
        unitType,
        playerId,
      });
    },
  });

  const myUnits = state.my.units.map(wrapUnit);
  const myBuildings = state.my.buildings.map(wrapBuilding);

  return {
    api: {
      game: {
        tick: state.tick,
        timeRemaining: state.gameTimeRemaining,
      },
      me: {
        units: myUnits,
        buildings: myBuildings,
        resources: state.my.resources,
        hq: myBuildings.find((building) => building.type === "hq") || null,
        workers: myUnits.filter((unit) => unit.type === "worker"),
        soldiers: myUnits.filter((unit) => unit.type === "soldier"),
      },
      enemies: state.enemies,
      enemyBuildings: state.enemyBuildings,
      eventsSinceLastCall: state.eventsSinceLastCall,
      map: {
        width: state.map.width,
        height: state.map.height,
        tiles: state.map.tiles,
        getTile: (x, y) =>
          state.map.tiles.find((tile) => tile.x === x && tile.y === y) || { x, y, type: "empty" },
      },
      unitStats: state.unitStats,
      buildingStats: state.buildingStats,
      economy: state.economy,
      utils: {
        getRange: (a, b) => Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2)),
        inRange: (a, b, range) => Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2)) <= range,
        findClosestByRange: (from, targets) => {
          if (targets.length === 0) {
            return null;
          }
          let closest = targets[0];
          let minDist = Infinity;
          for (const target of targets) {
            const distance = Math.sqrt(Math.pow(from.x - target.x, 2) + Math.pow(from.y - target.y, 2));
            if (distance < minDist) {
              minDist = distance;
              closest = target;
            }
          }
          return closest;
        },
      },
      console: { log: () => {} },
    },
    commands,
  };
}

process.on("message", (payload) => {
  if (!payload || typeof payload !== "object") {
    process.send?.({ commands: [], errorType: "invalid_payload", errorMessage: "Invalid sandbox payload" });
    process.exit(0);
    return;
  }

  const { code, state, playerId } = payload;
  const { api, commands } = buildAPI(playerId, state);

  try {
    const context = vm.createContext(api);
    const script = new vm.Script(String(code));
    script.runInContext(context, { timeout: AI_SANDBOX_TIMEOUT_MS });
    process.send?.({ commands });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorType = /Script execution timed out/i.test(message) ? "vm_timeout" : "runtime_error";
    process.send?.({
      commands,
      errorType,
      errorMessage:
        errorType === "vm_timeout"
          ? `Sandbox vm timeout after ${AI_SANDBOX_TIMEOUT_MS}ms`
          : message,
    });
  } finally {
    process.exit(0);
  }
});
