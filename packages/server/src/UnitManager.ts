import {
  Unit,
  UnitType,
  UnitState,
  TileType,
  TILE_TYPES,
  UNIT_TYPES,
  UNIT_STATES,
  UNIT_STATS,
  RESULT_CODES,
  ResultCode,
  MAP_WIDTH,
  MAP_HEIGHT,
} from "@llmcraft/shared";
import { PathFinder } from "./PathFinder";

function getDistance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
}

export class UnitManager {
  private units: Map<string, Unit> = new Map();
  private idCounter = 0;

  createUnit(type: UnitType, x: number, y: number, playerId: string): Unit {
    const stats = UNIT_STATS[type];
    const unit: Unit = {
      id: `unit_${++this.idCounter}`,
      type,
      x,
      y,
      hp: stats.hp,
      maxHp: stats.hp,
      state: UNIT_STATES.IDLE,
      my: true,
      playerId,
      exists: true,
      attackRange: stats.attackRange,
    };
    this.units.set(unit.id, unit);
    return unit;
  }

  getUnit(id: string): Unit | undefined {
    return this.units.get(id);
  }

  getUnitsByPlayer(playerId: string): Unit[] {
    return Array.from(this.units.values()).filter(
      (u) => u.playerId === playerId && u.exists
    );
  }

  getAllUnits(): Unit[] {
    return Array.from(this.units.values()).filter((u) => u.exists);
  }

  /**
   * Check if there is a unit at the given position
   */
  hasUnitAt(x: number, y: number, excludeUnitId?: string): boolean {
    for (const unit of this.units.values()) {
      if (unit.exists && unit.x === x && unit.y === y) {
        if (excludeUnitId && unit.id === excludeUnitId) {
          continue;
        }
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
    const maxSpeed = UNIT_STATS[unit.type].speed;
    if (distance > maxSpeed) {
      return RESULT_CODES.ERR_EXCEEDS_SPEED;
    }

    // Check collision: cannot move to a position occupied by another unit
    if (this.hasUnitAt(targetX, targetY, unit.id)) {
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
    unit.intent = { type: 'move', targetX, targetY };

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
    const distance = Math.sqrt(
      Math.pow(attacker.x - target.x, 2) + Math.pow(attacker.y - target.y, 2)
    );
    if (distance > attacker.attackRange) {
      return RESULT_CODES.ERR_NOT_IN_RANGE;
    }

    const damage = UNIT_STATS[attacker.type].attack;
    target.hp -= damage;
    attacker.state = UNIT_STATES.ATTACKING;
    // Record attack intent for visualization
    attacker.intent = { type: 'attack', targetId: target.id, targetX: target.x, targetY: target.y };

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
    unit.intent = { type: 'hold' };
    return RESULT_CODES.OK;
  }

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
    blockedPositions?: Set<string>
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

    if (tiles[targetY][targetX] === TILE_TYPES.OBSTACLE) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    if (blockedPositions?.has(`${targetX},${targetY}`)) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    // 计算路径
    const occupiedPositions = this.getOccupiedPositions(unit.id, blockedPositions);
    const path = PathFinder.findPath(
      unit.x,
      unit.y,
      targetX,
      targetY,
      tiles,
      occupiedPositions
    );

    if (path.length === 0 && (unit.x !== targetX || unit.y !== targetY)) {
      // 不可达但不是因为已经在目标点
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    // 保存路径和目标
    unit.path = path;
    unit.pathTarget = { x: targetX, y: targetY };
    unit.intent = { type: 'move', targetX, targetY };

    return RESULT_CODES.OK;
  }

  /**
   * 处理单位沿路径移动（每 tick 调用）
   * 按照单位速度移动相应步数
   */
  processPathMovement(unit: Unit, tiles: TileType[][], blockedPositions?: Set<string>): ResultCode {
    if (!unit.exists || !unit.path || unit.path.length === 0) {
      return RESULT_CODES.OK;
    }

    const maxSpeed = UNIT_STATS[unit.type].speed;
    let stepsTaken = 0;

    while (stepsTaken < maxSpeed && unit.path.length > 0) {
      const nextStep = unit.path[0];

      // 检查这一步是否仍然可行（可能被其他单位占据了）
      if (
        this.hasUnitAt(nextStep.x, nextStep.y, unit.id) ||
        blockedPositions?.has(`${nextStep.x},${nextStep.y}`)
      ) {
        // 路径被阻挡，需要重新寻路
        const occupiedPositions = this.getOccupiedPositions(unit.id, blockedPositions);
        const newPath = PathFinder.findPath(
          unit.x,
          unit.y,
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
      unit.x = nextStep.x;
      unit.y = nextStep.y;
      unit.state = UNIT_STATES.MOVING;
      unit.path.shift();
      stepsTaken++;
    }

    // 路径走完
    if (unit.path.length === 0) {
      unit.path = undefined;
      unit.pathTarget = undefined;
    }

    return RESULT_CODES.OK;
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
      if (unit.exists && unit.id !== excludeUnitId) {
        positions.add(`${unit.x},${unit.y}`);
      }
    }
    for (const position of blockedPositions || []) {
      positions.add(position);
    }
    return positions;
  }
}
