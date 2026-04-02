# LLMCraft MVP 实施计划

> **给 Claude：** 需要使用 superpowers:executing-plans 来逐个任务执行此计划。

**目标：** 构建一个最小可玩的 LLMCraft MVP，包含 20×20 地图、3 种单位、3 种建筑、单一资源、基础 API 和 OpenAI 集成。

**架构：** 带共享类型的 Monorepo、带 500ms  Tick 循环的 Node.js 后端、带 Canvas 渲染的 React/Vite 前端、用于 AI 代码执行的 isolated-vm 沙箱。

**技术栈：** TypeScript、Node.js、React、Vite、isolated-vm、OpenAI SDK、WebSocket

---

## 前置条件

- 安装 Node.js 18+
- npm 或 yarn 包管理器
- OpenAI API Key

---

### 任务 1: 初始化项目结构

**文件：**
- 创建: `package.json`
- 创建: `packages/shared/package.json`
- 创建: `packages/server/package.json`
- 创建: `packages/client/package.json`
- 创建: `tsconfig.json`
- 创建: `.gitignore`

**步骤 1: 创建根目录 package.json**

```json
{
  "name": "llmcraft",
  "private": true,
  "version": "0.1.0",
  "workspaces": ["packages/*"],
  "scripts": {
    "dev": "concurrently \"npm run dev:server\" \"npm run dev:client\"",
    "dev:server": "npm run dev -w @llmcraft/server",
    "dev:client": "npm run dev -w @llmcraft/client",
    "build": "npm run build -w @llmcraft/shared && npm run build -w @llmcraft/server && npm run build -w @llmcraft/client"
  },
  "devDependencies": {
    "concurrently": "^8.2.2",
    "typescript": "^5.3.3"
  }
}
```

**步骤 2: 创建 shared package.json**

```json
{
  "name": "@llmcraft/shared",
  "version": "0.1.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "devDependencies": {
    "typescript": "^5.3.3"
  }
}
```

**步骤 3: 创建 server package.json**

```json
{
  "name": "@llmcraft/server",
  "version": "0.1.0",
  "private": true,
  "main": "dist/index.js",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@llmcraft/shared": "*",
    "isolated-vm": "^4.6.0",
    "openai": "^4.24.7",
    "ws": "^8.16.0"
  },
  "devDependencies": {
    "@types/node": "^20.10.5",
    "@types/ws": "^8.5.10",
    "tsx": "^4.7.0",
    "typescript": "^5.3.3"
  }
}
```

**步骤 4: 创建 client package.json**

```json
{
  "name": "@llmcraft/client",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@llmcraft/shared": "*",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "@types/react": "^18.2.45",
    "@types/react-dom": "^18.2.18",
    "@vitejs/plugin-react": "^4.2.1",
    "typescript": "^5.3.3",
    "vite": "^5.0.8"
  }
}
```

**步骤 5: 创建根目录 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

**步骤 6: 创建 .gitignore**

```
node_modules
dist
.DS_Store
*.log
.env
logs/*.json
```

**步骤 7: 创建目录并安装依赖**

```bash
mkdir -p packages/shared/src packages/server/src packages/client/src logs
npm install
```

---

### 任务 2: 共享类型定义

**文件：**
- 创建: `packages/shared/src/index.ts`
- 创建: `packages/shared/src/types.ts`
- 创建: `packages/shared/src/constants.ts`
- 创建: `packages/shared/tsconfig.json`

**步骤 1: 创建 shared/tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true
  },
  "include": ["src/**/*"]
}
```

**步骤 2: 创建 shared/src/constants.ts**

```typescript
export const TICK_INTERVAL_MS = 500;
export const MAP_WIDTH = 20;
export const MAP_HEIGHT = 20;

export const RESULT_CODES = {
  OK: 0,
  ERR_NOT_OWNER: -1,
  ERR_NOT_IN_RANGE: -2,
  ERR_INVALID_TARGET: -3,
  ERR_NOT_ENOUGH_ENERGY: -4,
  ERR_BUSY: -5,
} as const;

export type ResultCode = typeof RESULT_CODES[keyof typeof RESULT_CODES];

export const UNIT_TYPES = {
  WORKER: "worker",
  SOLDIER: "soldier",
  SCOUT: "scout",
} as const;

export type UnitType = typeof UNIT_TYPES[keyof typeof UNIT_TYPES];

export const BUILDING_TYPES = {
  HQ: "hq",
  GENERATOR: "generator",
  BARRACKS: "barracks",
} as const;

export type BuildingType = typeof BUILDING_TYPES[keyof typeof BUILDING_TYPES];

export const UNIT_STATES = {
  IDLE: "idle",
  MOVING: "moving",
  ATTACKING: "attacking",
  GATHERING: "gathering",
} as const;

export type UnitState = typeof UNIT_STATES[keyof typeof UNIT_STATES];

export const TILE_TYPES = {
  EMPTY: "empty",
  OBSTACLE: "obstacle",
  RESOURCE: "resource",
} as const;

export type TileType = typeof TILE_TYPES[keyof typeof TILE_TYPES];

export const UNIT_STATS: Record<UnitType, { hp: number; speed: number; attack: number; cost: number }> = {
  [UNIT_TYPES.WORKER]: { hp: 50, speed: 1, attack: 5, cost: 50 },
  [UNIT_TYPES.SOLDIER]: { hp: 100, speed: 1, attack: 15, cost: 80 },
  [UNIT_TYPES.SCOUT]: { hp: 30, speed: 2, attack: 5, cost: 30 },
};

export const BUILDING_STATS: Record<BuildingType, { hp: number; cost: number; energyPerTick?: number }> = {
  [BUILDING_TYPES.HQ]: { hp: 1000, cost: 0 },
  [BUILDING_TYPES.GENERATOR]: { hp: 200, cost: 100, energyPerTick: 5 },
  [BUILDING_TYPES.BARRACKS]: { hp: 300, cost: 150 },
};
```

**步骤 3: 创建 shared/src/types.ts**

```typescript
import { UnitType, BuildingType, UnitState, TileType, ResultCode } from "./constants";

export interface Position {
  x: number;
  y: number;
}

export interface GameObject {
  id: string;
  x: number;
  y: number;
  exists: boolean;
}

export interface Unit extends GameObject {
  type: UnitType;
  hp: number;
  maxHp: number;
  state: UnitState;
  my: boolean;
  playerId: string;
}

export interface Building extends GameObject {
  type: BuildingType;
  hp: number;
  maxHp: number;
  my: boolean;
  playerId: string;
  productionQueue: UnitType[];
}

export interface Resources {
  energy: number;
  energyPerTick: number;
}

export interface Player {
  id: string;
  units: Unit[];
  buildings: Building[];
  resources: Resources;
}

export interface Tile {
  x: number;
  y: number;
  type: TileType;
}

export interface GameState {
  tick: number;
  players: Player[];
  tiles: Tile[][];
  winner: string | null;
  logs: GameLog[];
}

export interface GameLog {
  tick: number;
  type: string;
  message: string;
  data?: any;
}

export interface AIStatePackage {
  tick: number;
  my: {
    resources: Resources;
    units: Array<Omit<Unit, "playerId">>;
    buildings: Array<Omit<Building, "playerId">>;
  };
  visibleEnemies: Array<{ id: string; type: UnitType | BuildingType; x: number; y: number; hp: number }>;
  map: {
    width: number;
    height: number;
    visibleTiles: Position[];
  };
  eventsSinceLastCall: GameLog[];
  gameTimeRemaining: number;
}

export interface Command {
  id: string;
  type: string;
  unitId?: string;
  buildingId?: string;
  targetId?: string;
  position?: Position;
  unitType?: UnitType;
  playerId: string;
}

export interface GameSnapshot {
  tick: number;
  state: GameState;
  aiOutputs: Record<string, string>;
}
```

**步骤 4: 创建 shared/src/index.ts**

```typescript
export * from "./constants";
export * from "./types";
```

**步骤 5: 测试构建**

```bash
cd packages/shared && npm run build
```

预期结果：编译成功，无错误。

---

### 任务 3: 游戏状态和逻辑 - 核心类

**文件：**
- 创建: `packages/server/src/index.ts`
- 创建: `packages/server/src/Game.ts`
- 创建: `packages/server/src/UnitManager.ts`
- 创建: `packages/server/src/BuildingManager.ts`
- 创建: `packages/server/src/MapGenerator.ts`
- 创建: `packages/server/tsconfig.json`

**步骤 1: 创建 server/tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../shared" }]
}
```

**步骤 2: 创建 server/src/MapGenerator.ts**

```typescript
import { MAP_WIDTH, MAP_HEIGHT, TILE_TYPES, TileType } from "@llmcraft/shared";

export class MapGenerator {
  static generate(): TileType[][] {
    const tiles: TileType[][] = [];

    for (let y = 0; y < MAP_HEIGHT; y++) {
      tiles[y] = [];
      for (let x = 0; x < MAP_WIDTH; x++) {
        tiles[y][x] = TILE_TYPES.EMPTY;
      }
    }

    // 添加障碍物
    const obstaclePositions = [
      [5, 5], [6, 5], [5, 6],
      [14, 5], [13, 5], [14, 6],
      [5, 14], [6, 14], [5, 13],
      [14, 14], [13, 14], [14, 13],
      [10, 8], [10, 9], [10, 10], [10, 11],
      [9, 9], [11, 9], [9, 10], [11, 10],
    ];

    for (const [x, y] of obstaclePositions) {
      if (x >= 0 && x < MAP_WIDTH && y >= 0 && y < MAP_HEIGHT) {
        tiles[y][x] = TILE_TYPES.OBSTACLE;
      }
    }

    // 添加资源点
    const resourcePositions = [
      [2, 8], [2, 11],
      [17, 8], [17, 11],
      [8, 2], [11, 2],
      [8, 17], [11, 17],
    ];

    for (const [x, y] of resourcePositions) {
      if (x >= 0 && x < MAP_WIDTH && y >= 0 && y < MAP_HEIGHT) {
        tiles[y][x] = TILE_TYPES.RESOURCE;
      }
    }

    return tiles;
  }

  static isWalkable(tiles: TileType[][], x: number, y: number): boolean {
    if (x < 0 || x >= MAP_WIDTH || y < 0 || y >= MAP_HEIGHT) {
      return false;
    }
    return tiles[y][x] !== TILE_TYPES.OBSTACLE;
  }
}
```

**步骤 3: 创建 server/src/UnitManager.ts**

```typescript
import { Unit, UnitType, UnitState, Position, UNIT_TYPES, UNIT_STATS, UNIT_STATES, RESULT_CODES, ResultCode } from "@llmcraft/shared";

export class UnitManager {
  private units: Map<string, Unit> = new Map();
  private nextId = 0;

  createUnit(type: UnitType, x: number, y: number, playerId: string): Unit {
    const id = `unit_${++this.nextId}`;
    const stats = UNIT_STATS[type];
    const unit: Unit = {
      id,
      type,
      x,
      y,
      hp: stats.hp,
      maxHp: stats.hp,
      state: UNIT_STATES.IDLE,
      exists: true,
      my: false,
      playerId,
    };
    this.units.set(id, unit);
    return unit;
  }

  getUnit(id: string): Unit | undefined {
    return this.units.get(id);
  }

  getUnitsByPlayer(playerId: string): Unit[] {
    return Array.from(this.units.values()).filter(u => u.playerId === playerId && u.exists);
  }

  getAllUnits(): Unit[] {
    return Array.from(this.units.values()).filter(u => u.exists);
  }

  moveUnit(unit: Unit, targetX: number, targetY: number): ResultCode {
    if (!unit.exists) return RESULT_CODES.ERR_INVALID_TARGET;
    unit.x = targetX;
    unit.y = targetY;
    unit.state = UNIT_STATES.MOVING;
    return RESULT_CODES.OK;
  }

  attackUnit(attacker: Unit, target: Unit): ResultCode {
    if (!attacker.exists || !target.exists) return RESULT_CODES.ERR_INVALID_TARGET;
    if (attacker.playerId === target.playerId) return RESULT_CODES.ERR_INVALID_TARGET;

    const stats = UNIT_STATS[attacker.type];
    target.hp -= stats.attack;
    attacker.state = UNIT_STATES.ATTACKING;

    if (target.hp <= 0) {
      target.hp = 0;
      target.exists = false;
    }

    return RESULT_CODES.OK;
  }

  holdPosition(unit: Unit): ResultCode {
    if (!unit.exists) return RESULT_CODES.ERR_INVALID_TARGET;
    unit.state = UNIT_STATES.IDLE;
    return RESULT_CODES.OK;
  }

  removeUnit(id: string): void {
    const unit = this.units.get(id);
    if (unit) {
      unit.exists = false;
    }
  }
}
```

**步骤 4: 创建 server/src/BuildingManager.ts**

```typescript
import { Building, BuildingType, UnitType, Position, BUILDING_TYPES, BUILDING_STATS, RESULT_CODES, ResultCode } from "@llmcraft/shared";

export class BuildingManager {
  private buildings: Map<string, Building> = new Map();
  private nextId = 0;

  createBuilding(type: BuildingType, x: number, y: number, playerId: string): Building {
    const id = `building_${++this.nextId}`;
    const stats = BUILDING_STATS[type];
    const building: Building = {
      id,
      type,
      x,
      y,
      hp: stats.hp,
      maxHp: stats.hp,
      exists: true,
      my: false,
      playerId,
      productionQueue: [],
    };
    this.buildings.set(id, building);
    return building;
  }

  getBuilding(id: string): Building | undefined {
    return this.buildings.get(id);
  }

  getBuildingsByPlayer(playerId: string): Building[] {
    return Array.from(this.buildings.values()).filter(b => b.playerId === playerId && b.exists);
  }

  getAllBuildings(): Building[] {
    return Array.from(this.buildings.values()).filter(b => b.exists);
  }

  spawnUnit(building: Building, unitType: UnitType): ResultCode {
    if (!building.exists) return RESULT_CODES.ERR_INVALID_TARGET;
    if (building.type !== BUILDING_TYPES.HQ && building.type !== BUILDING_TYPES.BARRACKS) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }
    building.productionQueue.push(unitType);
    return RESULT_CODES.OK;
  }

  takeDamage(building: Building, damage: number): ResultCode {
    if (!building.exists) return RESULT_CODES.ERR_INVALID_TARGET;
    building.hp -= damage;
    if (building.hp <= 0) {
      building.hp = 0;
      building.exists = false;
    }
    return RESULT_CODES.OK;
  }

  getEnergyProduction(playerId: string): number {
    let total = 0;
    for (const building of this.getBuildingsByPlayer(playerId)) {
      if (building.type === BUILDING_TYPES.GENERATOR) {
        total += BUILDING_STATS[BUILDING_TYPES.GENERATOR].energyPerTick || 0;
      }
    }
    return total;
  }
}
```

**步骤 5: 创建 server/src/Game.ts**

```typescript
import {
  GameState,
  Player,
  GameLog,
  Command,
  Position,
  TICK_INTERVAL_MS,
  MAP_WIDTH,
  MAP_HEIGHT,
  UNIT_TYPES,
  BUILDING_TYPES,
  TILE_TYPES,
  UNIT_STATS,
  GameSnapshot,
} from "@llmcraft/shared";
import { UnitManager } from "./UnitManager";
import { BuildingManager } from "./BuildingManager";
import { MapGenerator } from "./MapGenerator";

export class Game {
  private tick = 0;
  private unitManager = new UnitManager();
  private buildingManager = new BuildingManager();
  private tiles: typeof TILE_TYPES[keyof typeof TILE_TYPES][][] = [];
  private players: Player[] = [];
  private logs: GameLog[] = [];
  private commandQueue: Command[] = [];
  private snapshots: GameSnapshot[] = [];
  private aiOutputs: Record<string, string> = {};
  private winner: string | null = null;
  private isRunning = false;
  private tickInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.initializeGame();
  }

  private initializeGame(): void {
    this.tiles = MapGenerator.generate();

    // 创建两个玩家
    this.players = [
      {
        id: "player_1",
        units: [],
        buildings: [],
        resources: { energy: 200, energyPerTick: 0 },
      },
      {
        id: "player_2",
        units: [],
        buildings: [],
        resources: { energy: 200, energyPerTick: 0 },
      },
    ];

    // 放置 HQ
    const hq1 = this.buildingManager.createBuilding(BUILDING_TYPES.HQ, 2, 10, "player_1");
    const hq2 = this.buildingManager.createBuilding(BUILDING_TYPES.HQ, 17, 10, "player_2");

    // 放置初始单位
    this.unitManager.createUnit(UNIT_TYPES.WORKER, 3, 9, "player_1");
    this.unitManager.createUnit(UNIT_TYPES.WORKER, 3, 11, "player_1");
    this.unitManager.createUnit(UNIT_TYPES.SOLDIER, 4, 10, "player_1");

    this.unitManager.createUnit(UNIT_TYPES.WORKER, 16, 9, "player_2");
    this.unitManager.createUnit(UNIT_TYPES.WORKER, 16, 11, "player_2");
    this.unitManager.createUnit(UNIT_TYPES.SOLDIER, 15, 10, "player_2");

    this.addLog("game_start", "游戏初始化完成");
    this.saveSnapshot();
  }

  private addLog(type: string, message: string, data?: any): void {
    this.logs.push({
      tick: this.tick,
      type,
      message,
      data,
    });
  }

  private saveSnapshot(): void {
    this.snapshots.push({
      tick: this.tick,
      state: this.getState(),
      aiOutputs: { ...this.aiOutputs },
    });
  }

  getState(): GameState {
    // 更新玩家引用
    for (const player of this.players) {
      player.units = this.unitManager.getUnitsByPlayer(player.id);
      player.buildings = this.buildingManager.getBuildingsByPlayer(player.id);
      player.resources.energyPerTick = this.buildingManager.getEnergyProduction(player.id);
    }

    return {
      tick: this.tick,
      players: this.players,
      tiles: this.tiles.map((row, y) =>
        row.map((type, x) => ({ x, y, type }))
      ),
      winner: this.winner,
      logs: this.logs.slice(-50),
    };
  }

  getSnapshots(): GameSnapshot[] {
    return this.snapshots;
  }

  enqueueCommand(command: Command): void {
    this.commandQueue.push(command);
  }

  setAIOutput(playerId: string, output: string): void {
    this.aiOutputs[playerId] = output;
  }

  private processCommands(): void {
    const commands = [...this.commandQueue];
    this.commandQueue = [];

    for (const command of commands) {
      switch (command.type) {
        case "move":
          if (command.unitId && command.position) {
            const unit = this.unitManager.getUnit(command.unitId);
            if (unit && unit.playerId === command.playerId) {
              this.unitManager.moveUnit(unit, command.position.x, command.position.y);
            }
          }
          break;
        case "attack":
          if (command.unitId && command.targetId) {
            const attacker = this.unitManager.getUnit(command.unitId);
            const target = this.unitManager.getUnit(command.targetId) ||
              this.buildingManager.getBuilding(command.targetId);
            if (attacker && target && attacker.playerId === command.playerId) {
              if ("hp" in target) {
                this.unitManager.attackUnit(attacker, target as any);
              }
            }
          }
          break;
        case "hold":
          if (command.unitId) {
            const unit = this.unitManager.getUnit(command.unitId);
            if (unit && unit.playerId === command.playerId) {
              this.unitManager.holdPosition(unit);
            }
          }
          break;
        case "spawn":
          if (command.buildingId && command.unitType) {
            const building = this.buildingManager.getBuilding(command.buildingId);
            if (building && building.playerId === command.playerId) {
              const cost = UNIT_STATS[command.unitType].cost;
              const player = this.players.find(p => p.id === command.playerId);
              if (player && player.resources.energy >= cost) {
                player.resources.energy -= cost;
                this.buildingManager.spawnUnit(building, command.unitType);
                // MVP 中立即生成
                const spawnX = building.x + (building.playerId === "player_1" ? 1 : -1);
                this.unitManager.createUnit(command.unitType, spawnX, building.y, command.playerId);
                this.addLog("spawn", `生成了 ${command.unitType}`, { playerId: command.playerId });
              }
            }
          }
          break;
      }
    }
  }

  private updateResources(): void {
    for (const player of this.players) {
      player.resources.energy += player.resources.energyPerTick;
    }
  }

  private checkWinCondition(): void {
    for (const player of this.players) {
      const hq = player.buildings.find(b => b.type === BUILDING_TYPES.HQ);
      if (!hq || !hq.exists) {
        const winner = this.players.find(p => p.id !== player.id);
        this.winner = winner?.id || null;
        this.isRunning = false;
        this.addLog("game_over", `胜利者: ${this.winner}`);
        this.saveSnapshot();
      }
    }
  }

  private tickUpdate(): void {
    if (!this.isRunning) return;

    this.tick++;
    this.processCommands();
    this.updateResources();
    this.checkWinCondition();
    this.saveSnapshot();
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.tickInterval = setInterval(() => this.tickUpdate(), TICK_INTERVAL_MS);
  }

  stop(): void {
    this.isRunning = false;
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }
}
```

**步骤 6: 创建 server/src/index.ts (初始测试)**

```typescript
import { Game } from "./Game";

console.log("启动 LLMCraft 服务器...");
const game = new Game();

// 测试游戏初始化
const state = game.getState();
console.log(`游戏初始化完成，共有 ${state.players.length} 个玩家`);
console.log(`玩家 1 有 ${state.players[0].units.length} 个单位`);

game.start();

// 5 秒后停止
setTimeout(() => {
  game.stop();
  console.log("游戏已停止");
  console.log(`最终 Tick: ${game.getState().tick}`);
}, 5000);
```

**步骤 7: 测试服务器**

```bash
cd packages/server && npm run dev
```

预期结果：服务器启动，游戏初始化，运行 5 秒，停止无错误。

---

### 任务 4: AI 沙箱和 API 注入

**文件：**
- 创建: `packages/server/src/AISandbox.ts`
- 创建: `packages/server/src/APIBridge.ts`
- 创建: `packages/server/src/SystemPrompt.ts`

**步骤 1: 创建 server/src/SystemPrompt.ts**

```typescript
export const SYSTEM_PROMPT = `你是一个玩即时战略游戏的 AI 指挥官。

你的目标是摧毁敌方 HQ。你控制单位和建筑。

## 类型定义

interface Position { x: number; y: number; }
interface Unit {
  id: string;
  type: "worker" | "soldier" | "scout";
  x: number; y: number;
  hp: number; maxHp: number;
  state: "idle" | "moving" | "attacking" | "gathering";
}
interface Building {
  id: string;
  type: "hq" | "generator" | "barracks";
  x: number; y: number;
  hp: number; maxHp: number;
}
interface Resources {
  energy: number;
  energyPerTick: number;
}

## 全局对象

- game: { tick: number; timeRemaining: number; }
- me: {
    units: Unit[];
    buildings: Building[];
    resources: Resources;
    hq: Building | null;
    workers: Unit[];
    soldiers: Unit[];
    scouts: Unit[];
  }
- enemies: Array<{ id: string; type: string; x: number; y: number; hp: number; }>
- map: { width: 20; height: 20; }
- utils: {
    getRange(a: {x:number,y:number}, b: {x:number,y:number}): number;
    inRange(a: {x:number,y:number}, b: {x:number,y:number}, range: number): boolean;
    findClosestByRange(from: {x:number,y:number}, targets: any[]): any;
  }

## 单位方法

unit.moveTo({x, y}): void
unit.attack(targetId): void
unit.holdPosition(): void

## 建筑方法

building.spawnUnit("worker" | "soldier" | "scout"): void

## 造价

- worker: 50 energy
- soldier: 80 energy
- scout: 30 energy

## 代码示例

// 移动所有士兵到中间
me.soldiers.forEach(s => s.moveTo({x: 10, y: 10}));

// 有能量就生产士兵
if (me.resources.energy > 150) {
  const barracks = me.buildings.find(b => b.type === "barracks");
  if (barracks) barracks.spawnUnit("soldier");
}

// 空闲士兵攻击最近敌人
const idleSoldiers = me.soldiers.filter(s => s.state === "idle");
idleSoldiers.forEach(s => {
  const nearestEnemy = utils.findClosestByRange(s, enemies);
  if (nearestEnemy && utils.inRange(s, nearestEnemy, 3)) {
    s.attack(nearestEnemy.id);
  } else if (nearestEnemy) {
    s.moveTo({x: nearestEnemy.x, y: nearestEnemy.y});
  }
});

只回复可执行的 JavaScript 代码。不要解释。
不要 markdown 格式。只写代码。
`;
```

**步骤 2: 创建 server/src/APIBridge.ts**

```typescript
import { Unit, Building, Command, Position, Player, AIStatePackage } from "@llmcraft/shared";

export class APIBridge {
  private commands: Command[] = [];
  private playerId: string;

  constructor(playerId: string) {
    this.playerId = playerId;
  }

  createAPI(state: AIStatePackage) {
    const self = this;

    // 创建单位包装器
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

    // 创建建筑包装器
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
        hq: myBuildings.find(b => b.type === "hq") || null,
        workers: myUnits.filter(u => u.type === "worker"),
        soldiers: myUnits.filter(u => u.type === "soldier"),
        scouts: myUnits.filter(u => u.type === "scout"),
      },
      enemies: state.visibleEnemies,
      map: {
        width: 20,
        height: 20,
      },
      utils: {
        getRange: (a: Position, b: Position) => {
          return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));
        },
        inRange: (a: Position, b: Position, range: number) => {
          return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2)) <= range;
        },
        findClosestByRange: (from: Position, targets: any[]) => {
          if (targets.length === 0) return null;
          let closest = targets[0];
          let minDist = Infinity;
          for (const t of targets) {
            const dist = Math.sqrt(Math.pow(from.x - t.x, 2) + Math.pow(from.y - t.y, 2));
            if (dist < minDist) {
              minDist = dist;
              closest = t;
            }
          }
          return closest;
        },
      },
    };
  }

  getCommands(): Command[] {
    return this.commands;
  }

  clearCommands(): void {
    this.commands = [];
  }
}
```

**步骤 3: 创建 server/src/AISandbox.ts**

```typescript
import ivm from "isolated-vm";
import { AIStatePackage, Command } from "@llmcraft/shared";
import { APIBridge } from "./APIBridge";

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

    // MVP 中我们直接使用 bridge，不用 isolated-vm
    this.executeInBridge(code, api);

    return this.bridge.getCommands();
  }

  private executeInBridge(code: string, api: any): void {
    try {
      // 创建一个安全的函数
      const fn = new Function(
        'game', 'me', 'enemies', 'map', 'utils',
        '"use strict";\n' + code
      );
      fn(api.game, api.me, api.enemies, api.map, api.utils);
    } catch (e) {
      console.error("AI 代码执行错误:", e);
    }
  }
}
```

---

### 任务 5: OpenAI 集成

**文件：**
- 创建: `packages/server/src/OpenAIClient.ts`
- 创建: `packages/server/src/GameOrchestrator.ts`
- 创建: `packages/server/.env.example`

**步骤 1: 创建 server/.env.example**

```
OPENAI_API_KEY=your_api_key_here
OPENAI_MODEL=gpt-4o-mini
PORT=3001
```

**步骤 2: 创建 server/src/OpenAIClient.ts**

```typescript
import OpenAI from "openai";
import { AIStatePackage } from "@llmcraft/shared";
import { SYSTEM_PROMPT } from "./SystemPrompt";

export class OpenAIClient {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string = "gpt-4o-mini") {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async generateCode(state: AIStatePackage): Promise<string> {
    const userPrompt = this.formatState(state);

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 1024,
    });

    const code = response.choices[0]?.message?.content || "";
    return this.cleanCode(code);
  }

  private formatState(state: AIStatePackage): string {
    return JSON.stringify(state, null, 2);
  }

  private cleanCode(code: string): string {
    // 移除 markdown 代码块（如果存在）
    code = code.replace(/^```javascript\n?/, "").replace(/^```js\n?/, "").replace(/```$/, "");
    return code.trim();
  }
}
```

**步骤 3: 创建 server/src/GameOrchestrator.ts**

```typescript
import { Game } from "./Game";
import { AISandbox } from "./AISandbox";
import { OpenAIClient } from "./OpenAIClient";
import { AIStatePackage } from "@llmcraft/shared";

export class GameOrchestrator {
  private game: Game;
  private ai1: AISandbox;
  private ai2: AISandbox;
  private openai1: OpenAIClient;
  private openai2: OpenAIClient;
  private lastAITick = { player_1: -100, player_2: -100 };
  private aiInterval = 5; // AI 每 5 个 tick 思考一次

  constructor(openaiKey: string) {
    this.game = new Game();
    this.ai1 = new AISandbox("player_1");
    this.ai2 = new AISandbox("player_2");
    this.openai1 = new OpenAIClient(openaiKey);
    this.openai2 = new OpenAIClient(openaiKey);
  }

  getGame(): Game {
    return this.game;
  }

  private buildStatePackage(playerId: string): AIStatePackage {
    const state = this.game.getState();
    const player = state.players.find(p => p.id === playerId)!;
    const enemy = state.players.find(p => p.id !== playerId)!;

    return {
      tick: state.tick,
      my: {
        resources: player.resources,
        units: player.units.map(u => ({ ...u, my: true })),
        buildings: player.buildings.map(b => ({ ...b, my: true })),
      },
      visibleEnemies: [
        ...enemy.units.map(u => ({ id: u.id, type: u.type, x: u.x, y: u.y, hp: u.hp })),
        ...enemy.buildings.map(b => ({ id: b.id, type: b.type, x: b.x, y: b.y, hp: b.hp })),
      ],
      map: {
        width: 20,
        height: 20,
        visibleTiles: [],
      },
      eventsSinceLastCall: [],
      gameTimeRemaining: 600 - state.tick / 2,
    };
  }

  async runAI(playerId: string): Promise<void> {
    const state = this.buildStatePackage(playerId);
    const sandbox = playerId === "player_1" ? this.ai1 : this.ai2;
    const openai = playerId === "player_1" ? this.openai1 : this.openai2;

    try {
      const code = await openai.generateCode(state);
      this.game.setAIOutput(playerId, code);

      const commands = await sandbox.executeCode(code, state);
      for (const cmd of commands) {
        this.game.enqueueCommand(cmd);
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
```

**步骤 4: 更新 server/src/index.ts**

```typescript
import * as dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";
import { GameOrchestrator } from "./GameOrchestrator";

dotenv.config();

const PORT = parseInt(process.env.PORT || "3001");
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";

if (!OPENAI_KEY) {
  console.error("需要 OPENAI_API_KEY");
  process.exit(1);
}

console.log("启动 LLMCraft 服务器...");

const orchestrator = new GameOrchestrator(OPENAI_KEY);
const wss = new WebSocketServer({ port: PORT });

console.log(`WebSocket 服务器运行在端口 ${PORT}`);

wss.on("connection", (ws) => {
  console.log("客户端已连接");

  // 发送初始状态
  const sendState = () => {
    const state = orchestrator.getGame().getState();
    const snapshots = orchestrator.getGame().getSnapshots();
    ws.send(JSON.stringify({
      type: "state",
      state,
      snapshots: snapshots.slice(-100),
    }));
  };

  sendState();

  // 轮询更新
  const interval = setInterval(sendState, 100);

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "start") {
        orchestrator.start();
      } else if (msg.type === "stop") {
        orchestrator.stop();
      }
    } catch (e) {
      console.error("消息错误:", e);
    }
  });

  ws.on("close", () => {
    console.log("客户端已断开");
    clearInterval(interval);
  });
});
```

**步骤 5: 安装 dotenv**

```bash
cd packages/server && npm install dotenv
```

---

### 任务 6: React 前端设置

**文件：**
- 创建: `packages/client/index.html`
- 创建: `packages/client/src/main.tsx`
- 创建: `packages/client/src/App.tsx`
- 创建: `packages/client/src/components/GameCanvas.tsx`
- 创建: `packages/client/src/components/AIOutputPanel.tsx`
- 创建: `packages/client/src/components/GameLog.tsx`
- 创建: `packages/client/src/hooks/useWebSocket.ts`
- 创建: `packages/client/vite.config.ts`
- 创建: `packages/client/tsconfig.json`

**步骤 1: 创建 client/vite.config.ts**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
  },
});
```

**步骤 2: 创建 client/tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"],
  "references": [{ "path": "../shared" }]
}
```

**步骤 3: 创建 client/index.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>LLMCraft MVP</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

**步骤 4: 创建 client/src/hooks/useWebSocket.ts**

```typescript
import { useEffect, useRef, useState } from "react";
import { GameState, GameSnapshot } from "@llmcraft/shared";

interface WSMessage {
  type: string;
  state: GameState;
  snapshots: GameSnapshot[];
}

export function useWebSocket(url: string) {
  const [state, setState] = useState<GameState | null>(null);
  const [snapshots, setSnapshots] = useState<GameSnapshot[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const send = (data: any) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  };

  useEffect(() => {
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("WebSocket 已连接");
      setConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const data: WSMessage = JSON.parse(event.data);
        if (data.type === "state") {
          setState(data.state);
          setSnapshots(data.snapshots);
        }
      } catch (e) {
        console.error("解析错误:", e);
      }
    };

    ws.onclose = () => {
      console.log("WebSocket 已断开");
      setConnected(false);
    };

    return () => {
      ws.close();
    };
  }, [url]);

  return { state, snapshots, connected, send };
}
```

**步骤 5: 创建 client/src/components/GameCanvas.tsx**

```typescript
import React, { useEffect, useRef } from "react";
import { GameState, MAP_WIDTH, MAP_HEIGHT, UNIT_TYPES, BUILDING_TYPES, TILE_TYPES } from "@llmcraft/shared";

interface GameCanvasProps {
  state: GameState | null;
}

const TILE_SIZE = 32;
const CANVAS_WIDTH = MAP_WIDTH * TILE_SIZE;
const CANVAS_HEIGHT = MAP_HEIGHT * TILE_SIZE;

const COLORS = {
  empty: "#1a1a2e",
  obstacle: "#4a4a6a",
  resource: "#ffd700",
  player1: "#ff6b6b",
  player2: "#4ecdc4",
  hq: "#9b59b6",
  generator: "#f39c12",
  barracks: "#3498db",
};

export function GameCanvas({ state }: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !state) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // 清除
    ctx.fillStyle = "#0f0f1a";
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // 绘制地块
    for (let y = 0; y < MAP_HEIGHT; y++) {
      for (let x = 0; x < MAP_WIDTH; x++) {
        const tile = state.tiles[y]?.[x];
        ctx.fillStyle = COLORS[tile?.type || "empty"];
        ctx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE - 1, TILE_SIZE - 1);
      }
    }

    // 绘制建筑
    for (const player of state.players) {
      const color = player.id === "player_1" ? COLORS.player1 : COLORS.player2;
      for (const building of player.buildings) {
        if (!building.exists) continue;
        ctx.fillStyle = COLORS[building.type as keyof typeof COLORS] || color;
        ctx.fillRect(
          building.x * TILE_SIZE + 2,
          building.y * TILE_SIZE + 2,
          TILE_SIZE - 5,
          TILE_SIZE - 5
        );
        // 血条
        ctx.fillStyle = "#333";
        ctx.fillRect(building.x * TILE_SIZE, building.y * TILE_SIZE - 6, TILE_SIZE, 4);
        ctx.fillStyle = color;
        ctx.fillRect(
          building.x * TILE_SIZE,
          building.y * TILE_SIZE - 6,
          TILE_SIZE * (building.hp / building.maxHp),
          4
        );
      }
    }

    // 绘制单位
    for (const player of state.players) {
      const color = player.id === "player_1" ? COLORS.player1 : COLORS.player2;
      for (const unit of player.units) {
        if (!unit.exists) continue;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(
          unit.x * TILE_SIZE + TILE_SIZE / 2,
          unit.y * TILE_SIZE + TILE_SIZE / 2,
          TILE_SIZE / 3,
          0,
          Math.PI * 2
        );
        ctx.fill();
        // 血条
        ctx.fillStyle = "#333";
        ctx.fillRect(unit.x * TILE_SIZE, unit.y * TILE_SIZE - 4, TILE_SIZE, 3);
        ctx.fillStyle = color;
        ctx.fillRect(
          unit.x * TILE_SIZE,
          unit.y * TILE_SIZE - 4,
          TILE_SIZE * (unit.hp / unit.maxHp),
          3
        );
      }
    }
  }, [state]);

  return (
    <canvas
      ref={canvasRef}
      width={CANVAS_WIDTH}
      height={CANVAS_HEIGHT}
      style={{ border: "2px solid #333" }}
    />
  );
}
```

**步骤 6: 创建 client/src/components/AIOutputPanel.tsx**

```typescript
import React from "react";
import { GameSnapshot } from "@llmcraft/shared";

interface AIOutputPanelProps {
  snapshots: GameSnapshot[];
}

export function AIOutputPanel({ snapshots }: AIOutputPanelProps) {
  const latest = snapshots[snapshots.length - 1];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px", height: "100%" }}>
      <div style={{ flex: 1, overflow: "auto" }}>
        <h3 style={{ margin: "0 0 8px 0", color: "#ff6b6b" }}>AI 1 (红方)</h3>
        <pre
          style={{
            background: "#1a1a2e",
            padding: "8px",
            borderRadius: "4px",
            fontSize: "11px",
            whiteSpace: "pre-wrap",
            maxHeight: "200px",
            overflow: "auto",
            color: "#e0e0e0",
          }}
        >
          {latest?.aiOutputs?.player_1 || "等待 AI..."}
        </pre>
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        <h3 style={{ margin: "0 0 8px 0", color: "#4ecdc4" }}>AI 2 (蓝方)</h3>
        <pre
          style={{
            background: "#1a1a2e",
            padding: "8px",
            borderRadius: "4px",
            fontSize: "11px",
            whiteSpace: "pre-wrap",
            maxHeight: "200px",
            overflow: "auto",
            color: "#e0e0e0",
          }}
        >
          {latest?.aiOutputs?.player_2 || "等待 AI..."}
        </pre>
      </div>
    </div>
  );
}
```

**步骤 7: 创建 client/src/components/GameLog.tsx**

```typescript
import React from "react";
import { GameState } from "@llmcraft/shared";

interface GameLogProps {
  state: GameState | null;
}

export function GameLog({ state }: GameLogProps) {
  return (
    <div
      style={{
        background: "#1a1a2e",
        padding: "8px",
        borderRadius: "4px",
        height: "100px",
        overflow: "auto",
        fontSize: "12px",
      }}
    >
      {state?.logs.slice(-20).map((log, i) => (
        <div key={i} style={{ color: "#aaa" }}>
          [{log.tick}] {log.message}
        </div>
      ))}
    </div>
  );
}
```

**步骤 8: 创建 client/src/App.tsx**

```typescript
import React, { useState } from "react";
import { GameCanvas } from "./components/GameCanvas";
import { AIOutputPanel } from "./components/AIOutputPanel";
import { GameLog } from "./components/GameLog";
import { useWebSocket } from "./hooks/useWebSocket";

function App() {
  const { state, snapshots, connected, send } = useWebSocket("ws://localhost:3001");
  const [isPlaying, setIsPlaying] = useState(false);

  const handleStart = () => {
    send({ type: "start" });
    setIsPlaying(true);
  };

  const handleStop = () => {
    send({ type: "stop" });
    setIsPlaying(false);
  };

  return (
    <div style={{
      background: "#0f0f1a",
      minHeight: "100vh",
      color: "#e0e0e0",
      padding: "16px",
    }}>
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: "16px",
      }}>
        <h1 style={{ margin: 0 }}>LLMCraft MVP</h1>
        <div style={{ display: "flex", gap: "8px" }}>
          <span style={{
            padding: "4px 8px",
            borderRadius: "4px",
            background: connected ? "#27ae60" : "#c0392b",
          }}>
            {connected ? "已连接" : "未连接"}
          </span>
          <button
            onClick={isPlaying ? handleStop : handleStart}
            disabled={!connected}
            style={{
              padding: "8px 16px",
              background: isPlaying ? "#c0392b" : "#27ae60",
              border: "none",
              borderRadius: "4px",
              color: "white",
              cursor: "pointer",
            }}
          >
            {isPlaying ? "停止" : "开始"}
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: "16px" }}>
        <div>
          <GameCanvas state={state} />
          <div style={{ marginTop: "8px" }}>
            <GameLog state={state} />
          </div>
        </div>
        <div>
          <AIOutputPanel snapshots={snapshots} />
        </div>
      </div>

      {state?.winner && (
        <div style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          background: "#1a1a2e",
          padding: "32px",
          borderRadius: "8px",
          border: "2px solid #ffd700",
          fontSize: "24px",
        }}>
          胜利者: {state.winner}
        </div>
      )}
    </div>
  );
}

export default App;
```

**步骤 9: 创建 client/src/main.tsx**

```typescript
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

---

### 任务 7: 集成和测试

**文件：**
- 创建: `.env` (从 .env.example 复制并添加 API key)
- 修改: `packages/server/src/index.ts` (如需要)

**步骤 1: 在根目录创建 .env (不提交)**

```
OPENAI_API_KEY=你的实际密钥
```

**步骤 2: 构建 shared 包**

```bash
npm run build -w @llmcraft/shared
```

**步骤 3: 启动服务器（在一个终端）**

```bash
cd packages/server && npm run dev
```

**步骤 4: 启动客户端（在另一个终端）**

```bash
cd packages/client && npm run dev
```

**步骤 5: 测试完整流程**

1. 打开 http://localhost:3000
2. 确认 WebSocket 已连接
3. 点击"开始"
4. 观看 AI 玩游戏

---

## 最终检查

- [ ] 已创建带 workspace 的项目结构
- [ ] 共享类型已构建且可用
- [ ] 带 Tick 系统的游戏逻辑
- [ ] 带 API 注入的 AI 沙箱
- [ ] OpenAI 集成
- [ ] WebSocket 服务器
- [ ] 带 Canvas 的 React 前端
- [ ] 完整游戏流程已测试

---

## 执行选项

计划已保存到 `docs/plans/2026-04-01-mvp-implementation.md`。

**两个执行选项：**

**1. Subagent-Driven（本会话）** - 我为每个任务启动子代理，任务之间做代码审查，快速迭代

**2. Parallel Session（独立会话）** - 打开新会话用 executing-plans，批量执行带检查点

选哪个？
