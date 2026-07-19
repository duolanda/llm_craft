import {
  PlayerId,
  UnitType,
  TileType,
  ECONOMY_RULES,
  TILE_TYPES,
  UNIT_STATES,
  getAttackDamageAgainstUnit,
  getUnitStats,
  RESULT_CODES,
  ResultCode,
  MAP_WIDTH,
  MAP_HEIGHT,
} from "@llmcraft/shared";
import { PathFinder } from "./PathFinder";
import type { WorldUnit as Unit } from "./WorldUnit";

const ARRIVAL_EPSILON = 0.001;
const SEPARATION_ITERATIONS = 2;

const UNIT_COLLISION_RADIUS: Record<UnitType, number> = {
  worker: 0.3,
  soldier: 0.32,
  rifleman: 0.32,
  rocket_soldier: 0.32,
  light_tank: 0.56,
};

function getDistance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
}

function getChebyshevDistance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getPathCell(x: number, y: number): { x: number; y: number } {
  return {
    x: clamp(Math.round(x), 0, MAP_WIDTH - 1),
    y: clamp(Math.round(y), 0, MAP_HEIGHT - 1),
  };
}

function getCollisionRadius(unit: Unit): number {
  return UNIT_COLLISION_RADIUS[unit.type] ?? 0.32;
}

export class UnitManager {
  private units: Map<string, Unit> = new Map();
  private idCounter = 0;

  createCheckpoint(): { units: Unit[]; idCounter: number } {
    return {
      units: structuredClone(Array.from(this.units.values())),
      idCounter: this.idCounter,
    };
  }

  restoreCheckpoint(checkpoint: { units: Unit[]; idCounter: number }): void {
    this.units = new Map(
      structuredClone(checkpoint.units).map((unit) => [unit.id, unit]),
    );
    this.idCounter = checkpoint.idCounter;
  }

  /** @internal Authoritative runtime creation goes through EntityRegistry/WorldState. */
  createUnit(type: UnitType, x: number, y: number, playerId: PlayerId): Unit {
    const stats = getUnitStats(type);
    const unit: Unit = {
      id: `unit_${++this.idCounter}`,
      type,
      x,
      y,
      hp: stats.hp,
      maxHp: stats.hp,
      state: UNIT_STATES.IDLE,
      playerId,
      exists: true,
      attackRange: stats.attackRange,
      carryingCredits: 0,
      carryCapacity: ECONOMY_RULES.WORKER_CARRY_CAPACITY,
    };
    this.units.set(unit.id, unit);
    return unit;
  }

  getUnit(id: string): Unit | undefined {
    return this.units.get(id);
  }

  getUnitsByPlayer(playerId: PlayerId): Unit[] {
    return Array.from(this.units.values()).filter(
      (u) => u.playerId === playerId && u.exists
    );
  }

  getAllUnits(): Unit[] {
    return Array.from(this.units.values()).filter((u) => u.exists);
  }

  iterateStoredUnits(): IterableIterator<Unit> {
    return this.units.values();
  }

  /**
   * Check if there is a unit at the given position
   */
  hasUnitAt(x: number, y: number, excludeUnitId?: string): boolean {
    for (const unit of this.units.values()) {
      if (!unit.exists || (excludeUnitId && unit.id === excludeUnitId)) {
        continue;
      }

      const unitCell = getPathCell(unit.x, unit.y);
      if (unitCell.x === x && unitCell.y === y) {
        return true;
      }
    }
    return false;
  }

  moveUnit(
    unit: Unit,
    targetX: number,
    targetY: number,
    tiles?: TileType[][],
    blockedPositions?: Set<string>
  ): ResultCode {
    if (!unit.exists) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    // Check integer coordinates - must be whole numbers
    if (!Number.isInteger(targetX) || !Number.isInteger(targetY)) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    // Check map bounds
    if (targetX < 0 || targetX >= MAP_WIDTH || targetY < 0 || targetY >= MAP_HEIGHT) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    // Check speed limit: cannot move farther than unit's speed per tick
    const distance = getDistance(unit.x, unit.y, targetX, targetY);
    const maxSpeed = getUnitStats(unit.type).speed;
    if (distance > maxSpeed) {
      return RESULT_CODES.ERR_EXCEEDS_SPEED;
    }

    // Check collision: units have physical radius, not only a grid-center occupancy point.
    if (this.hasUnitCollisionAt(unit, targetX, targetY)) {
      return RESULT_CODES.ERR_POSITION_OCCUPIED;
    }

    if (blockedPositions?.has(`${targetX},${targetY}`)) {
      return RESULT_CODES.ERR_POSITION_OCCUPIED;
    }

    // Check obstacle collision if tiles provided
    if (tiles && tiles[targetY][targetX] === TILE_TYPES.OBSTACLE) {
      return RESULT_CODES.ERR_POSITION_OCCUPIED;
    }

    unit.x = targetX;
    unit.y = targetY;
    unit.state = UNIT_STATES.MOVING;
    // Record move intent for visualization
    unit.order = { type: 'move', targetX, targetY };

    return RESULT_CODES.OK;
  }

  attackUnit(attacker: Unit, target: Unit): ResultCode {
    if (!attacker.exists || !target.exists) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    if (attacker.playerId === target.playerId) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    // Critical: Check attack range
    const distance = getChebyshevDistance(attacker.x, attacker.y, target.x, target.y);
    if (distance > attacker.attackRange) {
      return RESULT_CODES.ERR_NOT_IN_RANGE;
    }

    const damage = getAttackDamageAgainstUnit(attacker.type, target.type);
    target.hp -= damage;
    attacker.state = UNIT_STATES.ATTACKING;
    // Record attack intent for visualization
    attacker.order = { type: 'attack', targetId: target.id, targetX: target.x, targetY: target.y };

    if (target.hp <= 0) {
      target.hp = 0;
      target.exists = false;
    }

    return RESULT_CODES.OK;
  }

  holdPosition(unit: Unit): ResultCode {
    if (!unit.exists) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    unit.state = UNIT_STATES.IDLE;
    // Record hold intent for visualization
    unit.order = { type: 'hold' };
    return RESULT_CODES.OK;
  }

  /** @internal Authoritative runtime destruction goes through EntityRegistry/WorldState. */
  removeUnit(id: string): boolean {
    const unit = this.units.get(id);
    if (unit) {
      unit.exists = false;
      return true;
    }
    return false;
  }

  /**
   * 设置单位的移动目标，自动计算路径
   * AI 调用此方法指定目标，系统会自动每 tick 沿路径移动
   */
  setMoveTarget(
    unit: Unit,
    targetX: number,
    targetY: number,
    tiles: TileType[][],
    blockedPositions?: Set<string>,
    keepResolvedTargetWhenAlreadyThere = false
  ): ResultCode {
    if (!unit.exists) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    if (!Number.isInteger(targetX) || !Number.isInteger(targetY)) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    // 检查目标点是否合法
    if (
      targetX < 0 ||
      targetX >= MAP_WIDTH ||
      targetY < 0 ||
      targetY >= MAP_HEIGHT
    ) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    const startCell = getPathCell(unit.x, unit.y);
    const occupiedPositions = this.getOccupiedPositions(unit.id, blockedPositions);
    const resolvedTarget = this.resolveMoveTarget(unit, targetX, targetY, tiles, occupiedPositions);
    if (!resolvedTarget) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    const path = PathFinder.findPath(
      startCell.x,
      startCell.y,
      resolvedTarget.x,
      resolvedTarget.y,
      tiles,
      occupiedPositions
    );

    // 保存路径和目标
    if (path.length === 0) {
      unit.path = undefined;
      const alreadyAtResolvedTarget = getChebyshevDistance(unit.x, unit.y, resolvedTarget.x, resolvedTarget.y) <= 0.35;
      unit.pathTarget =
        keepResolvedTargetWhenAlreadyThere && alreadyAtResolvedTarget
          ? { x: resolvedTarget.x, y: resolvedTarget.y }
          : undefined;
      unit.state = UNIT_STATES.IDLE;
      if (unit.order?.type === "move") {
        unit.order = undefined;
      }
      return RESULT_CODES.OK;
    }

    unit.path = path;
    unit.pathTarget = { x: resolvedTarget.x, y: resolvedTarget.y };
    unit.order = { type: "move", targetX: resolvedTarget.x, targetY: resolvedTarget.y };

    return RESULT_CODES.OK;
  }

  /**
   * 处理单位沿路径移动（每 tick 调用）
   * 按照单位速度移动相应步数
   */
  processPathMovement(
    unit: Unit,
    tiles: TileType[][],
    blockedPositions?: Set<string>,
    repathBudget?: { remaining: number },
  ): ResultCode {
    if (!unit.exists || unit.state === UNIT_STATES.BUILDING || !unit.path || unit.path.length === 0) {
      return RESULT_CODES.OK;
    }

    let remainingDistance = getUnitStats(unit.type).speed;

    while (remainingDistance > ARRIVAL_EPSILON && unit.path.length > 0) {
      const nextStep = unit.path[0];
      const distanceToStep = getDistance(unit.x, unit.y, nextStep.x, nextStep.y);

      if (distanceToStep <= ARRIVAL_EPSILON) {
        unit.x = nextStep.x;
        unit.y = nextStep.y;
        unit.path.shift();
        continue;
      }

      const travelDistance = Math.min(remainingDistance, distanceToStep);
      const ratio = travelDistance / distanceToStep;
      const nextX = unit.x + (nextStep.x - unit.x) * ratio;
      const nextY = unit.y + (nextStep.y - unit.y) * ratio;

      // 检查这一步是否仍然可行（可能被其他单位占据了）
      if (
        this.isPositionBlockedForUnit(unit, nextX, nextY, tiles, blockedPositions) ||
        this.hasUnitCollisionAt(unit, nextX, nextY)
      ) {
        if (repathBudget && repathBudget.remaining <= 0) {
          return RESULT_CODES.ERR_BUSY;
        }
        if (repathBudget) repathBudget.remaining -= 1;
        // 路径被阻挡，需要重新寻路
        const startCell = getPathCell(unit.x, unit.y);
        const occupiedPositions = this.getOccupiedPositions(unit.id, blockedPositions);
        const newPath = PathFinder.findPath(
          startCell.x,
          startCell.y,
          unit.pathTarget!.x,
          unit.pathTarget!.y,
          tiles,
          occupiedPositions
        );

        if (newPath.length === 0) {
          // 无法到达，清除路径
          unit.path = undefined;
          unit.pathTarget = undefined;
          return RESULT_CODES.ERR_POSITION_OCCUPIED;
        }

        unit.path = newPath;
        continue;
      }

      // 执行移动
      unit.x = Math.abs(nextX - nextStep.x) <= ARRIVAL_EPSILON ? nextStep.x : nextX;
      unit.y = Math.abs(nextY - nextStep.y) <= ARRIVAL_EPSILON ? nextStep.y : nextY;
      unit.state = UNIT_STATES.MOVING;
      remainingDistance -= travelDistance;

      if (getDistance(unit.x, unit.y, nextStep.x, nextStep.y) <= ARRIVAL_EPSILON) {
        unit.x = nextStep.x;
        unit.y = nextStep.y;
        unit.path.shift();
      }
    }

    // 路径走完
    if (unit.path.length === 0) {
      unit.path = undefined;
      unit.pathTarget = undefined;
      unit.state = UNIT_STATES.IDLE;
      if (unit.order?.type === "move") {
        unit.order = undefined;
      }
    }

    return RESULT_CODES.OK;
  }

  resolveUnitSeparation(tiles: TileType[][], blockedPositions?: Set<string>): void {
    for (let iteration = 0; iteration < SEPARATION_ITERATIONS; iteration++) {
      const units = this.getAllUnits();
      for (let i = 0; i < units.length; i++) {
        for (let j = i + 1; j < units.length; j++) {
          const left = units[i];
          const right = units[j];
          const minDistance = getCollisionRadius(left) + getCollisionRadius(right);
          const dx = right.x - left.x;
          const dy = right.y - left.y;
          const distance = Math.sqrt(dx * dx + dy * dy);

          if (distance >= minDistance || minDistance <= 0) {
            continue;
          }

          const overlap = minDistance - distance;
          const direction =
            distance > ARRIVAL_EPSILON
              ? { x: dx / distance, y: dy / distance }
              : this.getDeterministicSeparationDirection(left.id, right.id);
          const correction = overlap / 2;
          const leftX = left.x - direction.x * correction;
          const leftY = left.y - direction.y * correction;
          const rightX = right.x + direction.x * correction;
          const rightY = right.y + direction.y * correction;

          this.tryApplySeparation(left, leftX, leftY, tiles, blockedPositions);
          this.tryApplySeparation(right, rightX, rightY, tiles, blockedPositions);
        }
      }
    }
  }

  /**
   * 清除单位的路径
   */
  clearPath(unit: Unit): void {
    unit.path = undefined;
    unit.pathTarget = undefined;
  }

  /**
   * 获取被占据的位置集合（用于寻路避障）
   */
  private getOccupiedPositions(excludeUnitId?: string, blockedPositions?: Set<string>): Set<string> {
    const positions = new Set<string>();
    for (const unit of this.units.values()) {
      if (!unit.exists || unit.id === excludeUnitId) {
        continue;
      }

      const unitCell = getPathCell(unit.x, unit.y);
      positions.add(`${unitCell.x},${unitCell.y}`);
      if (unit.pathTarget) {
        positions.add(`${unit.pathTarget.x},${unit.pathTarget.y}`);
      }
    }
    for (const position of blockedPositions || []) {
      positions.add(position);
    }
    return positions;
  }

  private resolveMoveTarget(
    unit: Unit,
    requestedX: number,
    requestedY: number,
    tiles: TileType[][],
    occupiedPositions: Set<string>
  ): { x: number; y: number } | null {
    const startCell = getPathCell(unit.x, unit.y);
    const candidates: Array<{ x: number; y: number; radius: number; pathLength: number; unitDistance: number }> = [];

    for (let radius = 0; radius <= MAP_WIDTH + MAP_HEIGHT; radius++) {
      for (let y = Math.max(0, requestedY - radius); y <= Math.min(MAP_HEIGHT - 1, requestedY + radius); y++) {
        for (let x = Math.max(0, requestedX - radius); x <= Math.min(MAP_WIDTH - 1, requestedX + radius); x++) {
          if (Math.abs(x - requestedX) + Math.abs(y - requestedY) !== radius) {
            continue;
          }

          if (tiles[y][x] === TILE_TYPES.OBSTACLE) {
            continue;
          }

          if (occupiedPositions.has(`${x},${y}`)) {
            continue;
          }

          const path = PathFinder.findPath(startCell.x, startCell.y, x, y, tiles, occupiedPositions);
          if (path.length === 0 && (startCell.x !== x || startCell.y !== y)) {
            continue;
          }

          candidates.push({
            x,
            y,
            radius,
            pathLength: path.length,
            unitDistance: Math.abs(unit.x - x) + Math.abs(unit.y - y),
          });
        }
      }

      if (candidates.length > 0) {
        candidates.sort((a, b) =>
          a.radius - b.radius ||
          a.pathLength - b.pathLength ||
          a.unitDistance - b.unitDistance ||
          a.y - b.y ||
          a.x - b.x
        );

        return { x: candidates[0].x, y: candidates[0].y };
      }
    }

    return null;
  }

  private hasUnitCollisionAt(unit: Unit, targetX: number, targetY: number): boolean {
    const unitRadius = getCollisionRadius(unit);
    for (const other of this.units.values()) {
      if (!other.exists || other.id === unit.id) {
        continue;
      }

      const minDistance = unitRadius + getCollisionRadius(other);
      if (getDistance(targetX, targetY, other.x, other.y) < minDistance) {
        return true;
      }
    }

    return false;
  }

  private isPositionBlockedForUnit(
    unit: Unit,
    x: number,
    y: number,
    tiles: TileType[][],
    blockedPositions?: Set<string>,
  ): boolean {
    if (x < 0 || x >= MAP_WIDTH || y < 0 || y >= MAP_HEIGHT) {
      return true;
    }

    const cell = getPathCell(x, y);
    if (tiles[cell.y][cell.x] === TILE_TYPES.OBSTACLE) {
      return true;
    }

    if (blockedPositions?.has(`${cell.x},${cell.y}`)) {
      return true;
    }

    return this.hasUnitCollisionAt(unit, x, y);
  }

  private tryApplySeparation(unit: Unit, x: number, y: number, tiles: TileType[][], blockedPositions?: Set<string>): void {
    if (unit.state === UNIT_STATES.BUILDING) {
      return;
    }
    const nextX = clamp(x, 0, MAP_WIDTH - 1);
    const nextY = clamp(y, 0, MAP_HEIGHT - 1);
    if (this.isTerrainBlocked(nextX, nextY, tiles, blockedPositions)) {
      return;
    }
    unit.x = nextX;
    unit.y = nextY;
  }

  private isTerrainBlocked(x: number, y: number, tiles: TileType[][], blockedPositions?: Set<string>): boolean {
    if (x < 0 || x >= MAP_WIDTH || y < 0 || y >= MAP_HEIGHT) {
      return true;
    }

    const cell = getPathCell(x, y);
    return tiles[cell.y][cell.x] === TILE_TYPES.OBSTACLE || Boolean(blockedPositions?.has(`${cell.x},${cell.y}`));
  }

  private getDeterministicSeparationDirection(leftId: string, rightId: string): { x: number; y: number } {
    const seed = `${leftId}:${rightId}`;
    let hash = 0;
    for (let index = 0; index < seed.length; index++) {
      hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
    }
    const angle = (hash % 360) * (Math.PI / 180);
    return { x: Math.cos(angle), y: Math.sin(angle) };
  }
}
