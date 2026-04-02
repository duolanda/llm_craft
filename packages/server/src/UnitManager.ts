import {
  Unit,
  UnitType,
  UnitState,
  UNIT_TYPES,
  UNIT_STATES,
  UNIT_STATS,
  RESULT_CODES,
  ResultCode,
} from "@llmcraft/shared";

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

  moveUnit(unit: Unit, targetX: number, targetY: number): ResultCode {
    if (!unit.exists) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    // Check collision: cannot move to a position occupied by another unit
    if (this.hasUnitAt(targetX, targetY, unit.id)) {
      return RESULT_CODES.ERR_POSITION_OCCUPIED;
    }

    unit.x = targetX;
    unit.y = targetY;
    unit.state = UNIT_STATES.MOVING;

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
}
