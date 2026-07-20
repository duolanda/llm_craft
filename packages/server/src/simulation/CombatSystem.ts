import {
  RESULT_CODES,
  UNIT_STATES,
  getDefaultAttackMovePriority,
  getUnitVisionRange,
  getUnitWeapon,
  unitCanAttack,
  type ActiveProjectile,
  type AttackTargetType,
  type Building,
  type PlayerId,
  type ResultCode,
  type UnitIntent,
} from "@llmcraft/shared";
import { WorldState } from "../WorldState";
import type { WorldUnit } from "../WorldUnit";

type AttackOrder = Extract<UnitIntent, { type: "attack" }>;
type AttackMoveOrder = Extract<UnitIntent, { type: "attack_move" }>;

export class CombatSystem {
  step(world: WorldState): void {
    this.processAttackMoveOrders(world);
    this.processAttackOrders(world);
  }

  executeAttackOrder(
    world: WorldState,
    attacker: WorldUnit,
    playerId: PlayerId,
    order: AttackOrder,
  ): ResultCode {
    if (!attacker.exists || order.type !== "attack") return RESULT_CODES.ERR_INVALID_TARGET;

    let result: ResultCode;
    if (order.targetId) {
      const target = world.entities.resolve(order.targetId);
      result = target
        ? this.executeAttackTarget(world, attacker, target.entity, target.kind)
        : RESULT_CODES.ERR_INVALID_TARGET;
    } else {
      const target = this.findPrioritizedTarget(world, attacker, playerId, order.targetPriority);
      result = target
        ? this.executeAttackTarget(world, attacker, target.target, target.kind)
        : RESULT_CODES.ERR_NOT_IN_RANGE;
    }

    if (result === RESULT_CODES.OK) {
      world.units.clearPath(attacker);
      const resolvedOrder = attacker.order;
      attacker.order = {
        type: "attack",
        targetId: order.targetId,
        targetPriority: order.targetPriority,
        targetX: resolvedOrder?.targetX,
        targetY: resolvedOrder?.targetY,
      };
      attacker.lastAttackTick = world.tick;
    }
    return result;
  }

  private executeAttackTarget(
    world: WorldState,
    attacker: WorldUnit,
    target: WorldUnit | Building,
    kind: "unit" | "building",
  ): ResultCode {
    if (kind === "building") return this.attackBuilding(world, attacker, target as Building);
    const targetUnit = target as WorldUnit;
    const result = this.attackUnit(world, attacker, targetUnit);
    if (result === RESULT_CODES.OK) this.processRetaliation(world, targetUnit, attacker);
    return result;
  }

  private attackBuilding(world: WorldState, attacker: WorldUnit, target: Building): ResultCode {
    if (!attacker.exists || !target.exists || attacker.playerId === target.playerId) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }
    if (world.buildings.getDistanceToBuilding(target, attacker.x, attacker.y) > attacker.attackRange) {
      return RESULT_CODES.ERR_NOT_IN_RANGE;
    }
    return this.launchProjectile(world, attacker, target, "building", target.x, target.y);
  }

  private attackUnit(world: WorldState, attacker: WorldUnit, target: WorldUnit): ResultCode {
    if (!attacker.exists || !target.exists || attacker.playerId === target.playerId) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }
    if (this.chebyshevDistance(attacker, target) > attacker.attackRange) {
      return RESULT_CODES.ERR_NOT_IN_RANGE;
    }
    return this.launchProjectile(world, attacker, target, "unit", target.x, target.y);
  }

  private launchProjectile(
    world: WorldState,
    attacker: WorldUnit,
    target: WorldUnit | Building,
    targetKind: "unit" | "building",
    targetX: number,
    targetY: number,
  ): ResultCode {
    if (!unitCanAttack(attacker.type)) return RESULT_CODES.ERR_INVALID_TARGET;
    if (attacker.nextAttackTick !== undefined && world.tick < attacker.nextAttackTick) {
      return RESULT_CODES.ERR_BUSY;
    }

    const weapon = getUnitWeapon(attacker.type);
    const distance = targetKind === "building"
      ? world.buildings.getDistanceToBuilding(target as Building, attacker.x, attacker.y)
      : this.chebyshevDistance(attacker, target);
    const flightTicks = weapon.projectileType === "instant"
      ? 1
      : Math.max(1, Math.ceil(Math.max(1, distance) / Math.max(1, weapon.projectileSpeed)));
    const projectile: ActiveProjectile = {
      id: `projectile_${++world.projectileCounter}`,
      playerId: attacker.playerId,
      attackerId: attacker.id,
      attackerType: attacker.type,
      projectileType: weapon.projectileType,
      x: attacker.x,
      y: attacker.y,
      startX: attacker.x,
      startY: attacker.y,
      targetX,
      targetY,
      launchedTick: world.tick,
      impactTick: world.tick + flightTicks,
      targetId: target.id,
      targetKind,
      splashRadius: weapon.splashRadius,
    };
    world.projectiles.push(projectile);
    attacker.state = UNIT_STATES.ATTACKING;
    attacker.order = { type: "attack", targetId: target.id, targetX, targetY };
    attacker.lastAttackTick = world.tick;
    attacker.nextAttackTick = world.tick + weapon.reloadTicks;
    return RESULT_CODES.OK;
  }

  private processRetaliation(world: WorldState, defender: WorldUnit, attacker: WorldUnit): void {
    if (!this.canRetaliate(world, defender, attacker)) return;
    const result = this.attackUnit(world, defender, attacker);
    if (result === RESULT_CODES.OK) {
      world.units.clearPath(defender);
      defender.lastAttackTick = world.tick;
    }
  }

  private canRetaliate(world: WorldState, defender: WorldUnit, attacker: WorldUnit): boolean {
    if (
      !defender.exists
      || !attacker.exists
      || defender.playerId === attacker.playerId
      || defender.lastAttackTick === world.tick
      || (defender.nextAttackTick !== undefined && world.tick < defender.nextAttackTick)
      || !unitCanAttack(defender.type)
      || defender.attackRange <= 0
      || defender.path?.length
      || defender.pathTarget
      || (defender.order && defender.order.type !== "hold")
    ) {
      return false;
    }
    return this.chebyshevDistance(defender, attacker) <= defender.attackRange;
  }

  private processAttackMoveOrders(world: WorldState): void {
    for (const unit of world.units.getAllUnits()) {
      if (!unit.exists || unit.order?.type !== "attack_move") continue;
      const attackMoveOrder: AttackMoveOrder = unit.order;
      const moveTarget = attackMoveOrder.targetX !== undefined && attackMoveOrder.targetY !== undefined
        ? { x: attackMoveOrder.targetX, y: attackMoveOrder.targetY }
        : null;

      if (!moveTarget || this.isNearPosition(unit, moveTarget)) {
        world.units.clearPath(unit);
        unit.order = { type: "hold" };
        unit.state = UNIT_STATES.IDLE;
        continue;
      }

      if (unit.lastAttackTick !== world.tick) {
        const target = this.findPrioritizedTarget(world, unit, unit.playerId, attackMoveOrder.targetPriority);
        if (target) {
          const result = this.executeAttackTarget(world, unit, target.target, target.kind);
          if (result === RESULT_CODES.OK || result === RESULT_CODES.ERR_BUSY) {
            unit.order = { ...attackMoveOrder, targetId: target.target.id };
            world.units.clearPath(unit);
            continue;
          }
          if (result === RESULT_CODES.ERR_NOT_IN_RANGE) {
            if (attackMoveOrder.targetId === target.target.id && unit.pathTarget) continue;
            const moveResult = world.units.setMoveTarget(
              unit,
              target.target.x,
              target.target.y,
              world.tiles,
              world.buildings.getOccupiedPositions(),
              true,
            );
            if (moveResult === RESULT_CODES.OK) {
              unit.order = { ...attackMoveOrder, targetId: target.target.id };
              continue;
            }
          }
        }
      }

      delete attackMoveOrder.targetId;
      const alreadyPathing = unit.pathTarget?.x === moveTarget.x && unit.pathTarget?.y === moveTarget.y;
      if (!alreadyPathing) {
        const result = world.units.setMoveTarget(
          unit,
          moveTarget.x,
          moveTarget.y,
          world.tiles,
          world.buildings.getOccupiedPositions(),
          true,
        );
        if (result === RESULT_CODES.OK) {
          unit.order = {
            ...attackMoveOrder,
            targetX: unit.pathTarget?.x ?? moveTarget.x,
            targetY: unit.pathTarget?.y ?? moveTarget.y,
          };
        }
      }
      if (!unit.pathTarget && unit.lastAttackTick !== world.tick) unit.state = UNIT_STATES.IDLE;
    }
  }

  private processAttackOrders(world: WorldState): void {
    for (const unit of world.units.getAllUnits()) {
      if (!unit.exists || unit.order?.type !== "attack" || unit.lastAttackTick === world.tick) continue;
      const result = this.executeAttackOrder(world, unit, unit.playerId, unit.order);
      if (result === RESULT_CODES.ERR_INVALID_TARGET && unit.order?.targetId) {
        unit.order = { type: "hold" };
        unit.state = UNIT_STATES.IDLE;
      } else if (result !== RESULT_CODES.OK && unit.order?.targetId) {
        unit.state = UNIT_STATES.IDLE;
      }
    }
  }

  private findPrioritizedTarget(
    world: WorldState,
    attacker: WorldUnit,
    playerId: PlayerId,
    targetPriority?: AttackTargetType[],
  ): { kind: "unit"; target: WorldUnit } | { kind: "building"; target: Building } | null {
    const hasExplicitPriority = Boolean(targetPriority && targetPriority.length > 0);
    const priority = (
      hasExplicitPriority ? targetPriority! : getDefaultAttackMovePriority(attacker.type)
    ).map((value) => String(value).toLowerCase());
    const acquisitionRange = getUnitVisionRange(attacker.type);
    const units = world.units.getAllUnits()
      .filter((unit) => unit.exists && unit.playerId !== playerId)
      .filter((unit) => this.chebyshevDistance(attacker, unit) <= acquisitionRange)
      .sort((left, right) => left.id.localeCompare(right.id));
    const buildings = world.buildings.getAllBuildings()
      .filter((building) => building.exists && building.playerId !== playerId)
      .filter((building) => world.buildings.getDistanceToBuilding(building, attacker.x, attacker.y) <= acquisitionRange)
      .sort((left, right) => left.id.localeCompare(right.id));

    for (const requestedType of priority) {
      const unit = units.find((candidate) => candidate.type === requestedType);
      if (unit) return { kind: "unit", target: unit };
      const building = buildings.find((candidate) => candidate.type === requestedType);
      if (building) return { kind: "building", target: building };
    }
    if (hasExplicitPriority) return null;
    if (buildings[0]) return { kind: "building", target: buildings[0] };
    if (units[0]) return { kind: "unit", target: units[0] };
    return null;
  }

  private chebyshevDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  }

  private isNearPosition(
    position: { x: number; y: number },
    target: { x: number; y: number },
    tolerance = 0.35,
  ): boolean {
    return Math.max(Math.abs(position.x - target.x), Math.abs(position.y - target.y)) <= tolerance;
  }
}
