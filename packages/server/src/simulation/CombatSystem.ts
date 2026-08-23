import {
  RESULT_CODES,
  UNIT_STATES,
  getBuildingVisionRange,
  getBuildingWeapon,
  getBuildingArmor,
  getDefaultAttackMovePriority,
  getAttackSourceWeaponAgainstArmor,
  getUnitArmor,
  getUnitVisionRange,
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
import type { UnitDamagedEvent } from "./ProjectileSystem";

type AttackOrder = Extract<UnitIntent, { type: "attack" }>;
type AttackMoveOrder = Extract<UnitIntent, { type: "attack_move" }>;

export class CombatSystem {
  step(world: WorldState, damageEvents: readonly UnitDamagedEvent[] = []): void {
    this.processDamageReactions(world, damageEvents);
    this.processIdleAutoAcquisition(world);
    this.processDefensiveBuildings(world);
    this.processAttackMoveOrders(world);
    this.processHoldOrders(world);
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

    if (result === RESULT_CODES.OK || result === RESULT_CODES.ERR_BUSY) {
      world.units.clearPath(attacker);
      const resolvedOrder = attacker.order;
      attacker.order = {
        type: "attack",
        targetId: order.targetId,
        targetPriority: order.targetPriority,
        targetX: resolvedOrder?.targetX,
        targetY: resolvedOrder?.targetY,
        autoEngagement: order.autoEngagement ? { ...order.autoEngagement } : undefined,
      };
      if (result === RESULT_CODES.OK) attacker.lastAttackTick = world.tick;
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
    return this.attackUnit(world, attacker, target as WorldUnit);
  }

  private attackBuilding(world: WorldState, attacker: WorldUnit, target: Building): ResultCode {
    if (!attacker.exists || !target.exists || attacker.playerId === target.playerId) {
      this.cancelAttackCycle(attacker);
      return RESULT_CODES.ERR_INVALID_TARGET;
    }
    const distance = world.buildings.getDistanceToBuilding(target, attacker.x, attacker.y);
    const weapon = getAttackSourceWeaponAgainstArmor(attacker.type, getBuildingArmor(target.type));
    const minRange = weapon.minRange ?? 0;
    if (distance > weapon.range || distance < minRange) {
      this.cancelAttackCycle(attacker, target.id);
      return RESULT_CODES.ERR_NOT_IN_RANGE;
    }
    return this.launchProjectile(world, attacker, target, "building", target.x, target.y);
  }

  private attackUnit(world: WorldState, attacker: WorldUnit, target: WorldUnit): ResultCode {
    if (!attacker.exists || !target.exists || attacker.playerId === target.playerId) {
      this.cancelAttackCycle(attacker);
      return RESULT_CODES.ERR_INVALID_TARGET;
    }
    const distance = this.chebyshevDistance(attacker, target);
    const weapon = getAttackSourceWeaponAgainstArmor(attacker.type, getUnitArmor(target.type));
    const minRange = weapon.minRange ?? 0;
    if (distance > weapon.range || distance < minRange) {
      this.cancelAttackCycle(attacker, target.id);
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

    const targetArmor = targetKind === "building"
      ? getBuildingArmor((target as Building).type)
      : getUnitArmor((target as WorldUnit).type);
    const weapon = getAttackSourceWeaponAgainstArmor(attacker.type, targetArmor);
    const continuousFire = weapon.continuousFire;
    const continuingStream = continuousFire && attacker.attackStream?.targetId === target.id;
    if (attacker.attackStream && !continuingStream) {
      delete attacker.attackStream;
      delete attacker.attackWindup;
      world.markChanged();
    }
    if (attacker.nextAttackTick !== undefined && world.tick < attacker.nextAttackTick) {
      return RESULT_CODES.ERR_BUSY;
    }

    const windupTicks = weapon.windupTicks ?? 0;
    if (!continuingStream && windupTicks > 0) {
      const windup = attacker.attackWindup;
      if (!windup || windup.targetId !== target.id) {
        attacker.attackWindup = {
          targetId: target.id,
          startedTick: world.tick,
          completesAtTick: world.tick + windupTicks,
        };
        attacker.state = UNIT_STATES.ATTACKING;
        attacker.order = { type: "attack", targetId: target.id, targetX, targetY };
        world.markChanged();
        return RESULT_CODES.ERR_BUSY;
      }
      if (world.tick < windup.completesAtTick) {
        attacker.state = UNIT_STATES.ATTACKING;
        return RESULT_CODES.ERR_BUSY;
      }
      delete attacker.attackWindup;
      if (continuousFire) {
        attacker.attackStream = {
          targetId: target.id,
          startedTick: world.tick,
        };
        world.markChanged();
      }
    }
    if (!continuingStream && continuousFire && !attacker.attackStream) {
      attacker.attackStream = {
        targetId: target.id,
        startedTick: world.tick,
      };
      world.markChanged();
    }
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
    attacker.nextAttackTick = world.tick + (continuousFire?.damageIntervalTicks ?? weapon.reloadTicks);
    return RESULT_CODES.OK;
  }

  private processDamageReactions(world: WorldState, damageEvents: readonly UnitDamagedEvent[]): void {
    for (const event of damageEvents) {
      const defender = world.units.getUnit(event.unitId);
      const attacker = world.entities.resolve(event.attackerId);
      if (
        !defender?.exists
        || !attacker
        || attacker.entity.playerId === defender.playerId
        || !unitCanAttack(defender.type)
        || !this.isTargetWithinVision(world, defender, attacker.entity, attacker.kind)
      ) {
        continue;
      }

      if (defender.order?.type === "hold") {
        if (this.isTargetWithinWeaponRange(world, defender, attacker.entity, attacker.kind)) {
          defender.order = {
            ...defender.order,
            targetId: attacker.entity.id,
          };
        }
        continue;
      }

      if (
        defender.order
        || defender.state !== UNIT_STATES.IDLE
        || defender.path?.length
        || defender.pathTarget
      ) {
        continue;
      }

      defender.order = {
        type: "attack",
        targetId: attacker.entity.id,
        autoEngagement: {
          originX: defender.x,
          originY: defender.y,
        },
      };
    }
  }

  private processIdleAutoAcquisition(world: WorldState): void {
    const idleCombatUnits = world.units.getAllUnits()
      .filter((unit) =>
        unit.exists
        && unit.state === UNIT_STATES.IDLE
        && !unit.order
        && !unit.path?.length
        && !unit.pathTarget
        && unitCanAttack(unit.type)
      )
      .sort((left, right) => left.id.localeCompare(right.id));

    for (const unit of idleCombatUnits) {
      const target = this.findPrioritizedTarget(world, unit, unit.playerId);
      if (!target) continue;
      unit.order = {
        type: "attack",
        targetId: target.target.id,
        autoEngagement: {
          originX: unit.x,
          originY: unit.y,
        },
      };
    }
  }

  private processHoldOrders(world: WorldState): void {
    const holdingUnits = world.units.getAllUnits()
      .filter((unit) => unit.exists && unit.order?.type === "hold" && unitCanAttack(unit.type))
      .sort((left, right) => left.id.localeCompare(right.id));

    for (const unit of holdingUnits) {
      const holdOrder = unit.order as Extract<UnitIntent, { type: "hold" }>;
      const resolvedTarget = holdOrder.targetId ? world.entities.resolve(holdOrder.targetId) : undefined;
      const retainedTarget = resolvedTarget
        && resolvedTarget.entity.playerId !== unit.playerId
        && this.isTargetWithinVision(world, unit, resolvedTarget.entity, resolvedTarget.kind)
        && this.isTargetWithinWeaponRange(world, unit, resolvedTarget.entity, resolvedTarget.kind)
        ? { kind: resolvedTarget.kind, target: resolvedTarget.entity }
        : null;
      const target = retainedTarget ?? this.findPrioritizedTarget(
        world,
        unit,
        unit.playerId,
        holdOrder.targetPriority,
        true,
      );

      if (!target) {
        this.cancelAttackCycle(unit);
        unit.order = {
          type: "hold",
          targetPriority: holdOrder.targetPriority,
        };
        unit.state = UNIT_STATES.IDLE;
        continue;
      }

      const result = this.executeAttackTarget(world, unit, target.target, target.kind);
      unit.order = {
        type: "hold",
        targetId: target.target.id,
        targetPriority: holdOrder.targetPriority,
      };
      if (result === RESULT_CODES.OK || result === RESULT_CODES.ERR_BUSY) {
        world.units.clearPath(unit);
      } else {
        delete unit.order.targetId;
        unit.state = UNIT_STATES.IDLE;
      }
    }
  }

  private processAttackMoveOrders(world: WorldState): void {
    for (const unit of world.units.getAllUnits()) {
      if (!unit.exists || unit.order?.type !== "attack_move") continue;
      const attackMoveOrder: AttackMoveOrder = unit.order;
      const moveTarget = attackMoveOrder.targetX !== undefined && attackMoveOrder.targetY !== undefined
        ? { x: attackMoveOrder.targetX, y: attackMoveOrder.targetY }
        : null;

      if (!moveTarget || this.isNearPosition(unit, moveTarget)) {
        world.units.stopUnit(unit);
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
            if (this.moveIntoWeaponRange(world, unit, target.target, target.kind)) {
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

  private processDefensiveBuildings(world: WorldState): void {
    const defensiveBuildings = world.buildings.getAllBuildings()
      .filter((building) => !building.constructionProgress && getBuildingWeapon(building.type))
      .sort((left, right) => left.id.localeCompare(right.id));

    for (const building of defensiveBuildings) {
      const weapon = getBuildingWeapon(building.type);
      if (!weapon) continue;
      const visionRange = getBuildingVisionRange(building.type);
      const minRange = weapon.minRange ?? 0;
      const priority = weapon.targetPriority ?? [];
      const priorityIndex = (unit: WorldUnit): number => {
        const index = priority.indexOf(unit.type);
        return index < 0 ? priority.length : index;
      };
      const targets = world.units.getAllUnits()
        .filter((unit) => unit.playerId !== building.playerId)
        .map((unit) => ({ unit, distance: world.buildings.getDistanceToBuilding(building, unit.x, unit.y) }))
        .filter(({ distance }) => distance >= minRange && distance <= weapon.range && distance <= visionRange)
        .sort((left, right) =>
          priorityIndex(left.unit) - priorityIndex(right.unit)
          || left.distance - right.distance
          || left.unit.hp - right.unit.hp
          || left.unit.id.localeCompare(right.unit.id)
      );
      const target = targets[0]?.unit;
      if (!target) continue;
      const heading = Math.atan2(target.y - building.y, target.x - building.x);
      if (building.heading !== heading) {
        building.heading = heading;
        world.markChanged();
      }
      if (building.nextAttackTick !== undefined && world.tick < building.nextAttackTick) continue;
      const distance = world.buildings.getDistanceToBuilding(building, target.x, target.y);
      const flightTicks = weapon.projectileType === "instant"
        ? 1
        : Math.max(1, Math.ceil(Math.max(1, distance) / Math.max(1, weapon.projectileSpeed)));
      world.projectiles.push({
        id: `projectile_${++world.projectileCounter}`,
        playerId: building.playerId,
        attackerId: building.id,
        attackerType: building.type,
        projectileType: weapon.projectileType,
        x: building.x,
        y: building.y,
        startX: building.x,
        startY: building.y,
        targetX: target.x,
        targetY: target.y,
        launchedTick: world.tick,
        impactTick: world.tick + flightTicks,
        targetId: target.id,
        targetKind: "unit",
        splashRadius: weapon.splashRadius,
      });
      building.lastAttackTick = world.tick;
      building.nextAttackTick = world.tick + weapon.reloadTicks;
      world.markChanged();
    }
  }

  private processAttackOrders(world: WorldState): void {
    for (const unit of world.units.getAllUnits()) {
      if (!unit.exists || unit.order?.type !== "attack" || unit.lastAttackTick === world.tick) continue;
      const attackOrder = unit.order;
      if (attackOrder.autoEngagement && !this.isAutonomousTargetValid(world, unit, attackOrder)) {
        this.cancelAttackCycle(unit);
        world.units.stopUnit(unit);
        continue;
      }
      const result = this.executeAttackOrder(world, unit, unit.playerId, attackOrder);
      if (result === RESULT_CODES.ERR_INVALID_TARGET && unit.order?.targetId) {
        if (attackOrder.autoEngagement) {
          world.units.stopUnit(unit);
          continue;
        }
        const target = this.findPrioritizedTarget(world, unit, unit.playerId, unit.order.targetPriority);
        if (target) {
          const fallbackResult = this.executeAttackTarget(world, unit, target.target, target.kind);
          if (fallbackResult === RESULT_CODES.OK || fallbackResult === RESULT_CODES.ERR_BUSY) {
            unit.order = {
              type: "attack",
              targetId: target.target.id,
              targetPriority: unit.order.targetPriority,
            };
            continue;
          }
        }
        world.units.stopUnit(unit);
      } else if (result === RESULT_CODES.ERR_NOT_IN_RANGE && attackOrder.targetId) {
        const target = world.entities.resolve(attackOrder.targetId);
        if (target && this.moveIntoWeaponRange(world, unit, target.entity, target.kind)) {
          unit.order = attackOrder;
          continue;
        }
        unit.state = UNIT_STATES.IDLE;
      } else if (result === RESULT_CODES.ERR_BUSY) {
        unit.state = UNIT_STATES.ATTACKING;
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
    requireWeaponRange = false,
  ): { kind: "unit"; target: WorldUnit } | { kind: "building"; target: Building } | null {
    const priority = [...new Set([
      ...(targetPriority ?? []),
      ...getDefaultAttackMovePriority(attacker.type),
    ])].map((value) => String(value).toLowerCase());
    const acquisitionRange = getUnitVisionRange(attacker.type);
    const friendlyIds = new Set([
      ...world.units.getUnitsByPlayer(playerId).filter((unit) => unit.exists).map((unit) => unit.id),
      ...world.buildings.getBuildingsByPlayer(playerId).filter((building) => building.exists).map((building) => building.id),
    ]);
    const units = world.units.getAllUnits()
      .filter((unit) => unit.exists && unit.playerId !== playerId)
      .filter((unit) => this.chebyshevDistance(attacker, unit) <= acquisitionRange)
      .filter((unit) => !requireWeaponRange || this.isTargetWithinWeaponRange(world, attacker, unit, "unit"))
      .sort((left, right) =>
        Number(Boolean(right.order?.targetId && friendlyIds.has(right.order.targetId)))
        - Number(Boolean(left.order?.targetId && friendlyIds.has(left.order.targetId)))
        || this.chebyshevDistance(attacker, left) - this.chebyshevDistance(attacker, right)
        || left.hp - right.hp
        || left.id.localeCompare(right.id)
      );
    const buildings = world.buildings.getAllBuildings()
      .filter((building) => building.exists && building.playerId !== playerId)
      .filter((building) => world.buildings.getDistanceToBuilding(building, attacker.x, attacker.y) <= acquisitionRange)
      .filter((building) => !requireWeaponRange || this.isTargetWithinWeaponRange(world, attacker, building, "building"))
      .sort((left, right) =>
        world.buildings.getDistanceToBuilding(left, attacker.x, attacker.y)
        - world.buildings.getDistanceToBuilding(right, attacker.x, attacker.y)
        || left.hp - right.hp
        || left.id.localeCompare(right.id)
      );

    for (const requestedType of priority) {
      const unit = units.find((candidate) => candidate.type === requestedType);
      if (unit) return { kind: "unit", target: unit };
      const building = buildings.find((candidate) => candidate.type === requestedType);
      if (building) return { kind: "building", target: building };
    }
    if (buildings[0]) return { kind: "building", target: buildings[0] };
    if (units[0]) return { kind: "unit", target: units[0] };
    return null;
  }

  private isAutonomousTargetValid(
    world: WorldState,
    attacker: WorldUnit,
    order: AttackOrder,
  ): boolean {
    if (!order.targetId || !order.autoEngagement) return false;
    const target = world.entities.resolve(order.targetId);
    if (!target || target.entity.playerId === attacker.playerId) return false;

    const visionRange = getUnitVisionRange(attacker.type);
    const origin = {
      x: order.autoEngagement.originX,
      y: order.autoEngagement.originY,
    };
    return this.isTargetWithinVision(world, attacker, target.entity, target.kind)
      && this.getTargetDistance(world, target.entity, target.kind, origin) <= visionRange;
  }

  private isTargetWithinVision(
    world: WorldState,
    observer: WorldUnit,
    target: WorldUnit | Building,
    kind: "unit" | "building",
  ): boolean {
    return target.exists
      && target.playerId !== observer.playerId
      && this.getTargetDistance(world, target, kind, observer) <= getUnitVisionRange(observer.type);
  }

  private isTargetWithinWeaponRange(
    world: WorldState,
    attacker: WorldUnit,
    target: WorldUnit | Building,
    kind: "unit" | "building",
  ): boolean {
    if (!target.exists || target.playerId === attacker.playerId) return false;
    const targetArmor = kind === "building"
      ? getBuildingArmor((target as Building).type)
      : getUnitArmor((target as WorldUnit).type);
    const weapon = getAttackSourceWeaponAgainstArmor(attacker.type, targetArmor);
    const distance = this.getTargetDistance(world, target, kind, attacker);
    return distance >= (weapon.minRange ?? 0) && distance <= weapon.range;
  }

  private getTargetDistance(
    world: WorldState,
    target: WorldUnit | Building,
    kind: "unit" | "building",
    origin: { x: number; y: number },
  ): number {
    return kind === "building"
      ? world.buildings.getDistanceToBuilding(target as Building, origin.x, origin.y)
      : this.chebyshevDistance(origin, target);
  }

  private moveIntoWeaponRange(
    world: WorldState,
    attacker: WorldUnit,
    target: WorldUnit | Building,
    kind: "unit" | "building",
  ): boolean {
    const targetArmor = kind === "building"
      ? getBuildingArmor((target as Building).type)
      : getUnitArmor((target as WorldUnit).type);
    const weapon = getAttackSourceWeaponAgainstArmor(attacker.type, targetArmor);
    const distance = kind === "building"
      ? world.buildings.getDistanceToBuilding(target as Building, attacker.x, attacker.y)
      : this.chebyshevDistance(attacker, target);
    const minRange = weapon.minRange ?? 0;
    const candidates = distance < minRange
      ? this.getMinimumRangeRetreatCandidates(world, attacker, target, kind, minRange, weapon.range)
      : [this.toGridPosition(world, target)];
    const blockedPositions = world.buildings.getOccupiedPositions();

    for (const candidate of candidates) {
      const result = world.units.setMoveTarget(
        attacker,
        candidate.x,
        candidate.y,
        world.tiles,
        blockedPositions,
        true,
      );
      if (result !== RESULT_CODES.OK) continue;

      const resolvedTarget = attacker.pathTarget ?? candidate;
      const resolvedDistance = kind === "building"
        ? world.buildings.getDistanceToBuilding(target as Building, resolvedTarget.x, resolvedTarget.y)
        : this.chebyshevDistance(resolvedTarget, target);
      if (resolvedDistance >= minRange && resolvedDistance <= weapon.range) return true;
      world.units.clearPath(attacker);
    }
    return false;
  }

  private getMinimumRangeRetreatCandidates(
    world: WorldState,
    attacker: WorldUnit,
    target: WorldUnit | Building,
    kind: "unit" | "building",
    minRange: number,
    maxRange: number,
  ): Array<{ x: number; y: number }> {
    const height = world.tiles.length;
    const width = world.tiles[0]?.length ?? 0;
    const blockedPositions = world.buildings.getOccupiedPositions();
    const candidates: Array<{ x: number; y: number; movementDistance: number; targetDistance: number }> = [];

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (blockedPositions.has(`${x},${y}`)) continue;
        const targetDistance = kind === "building"
          ? world.buildings.getDistanceToBuilding(target as Building, x, y)
          : this.chebyshevDistance({ x, y }, target);
        if (targetDistance < minRange || targetDistance > maxRange) continue;
        candidates.push({
          x,
          y,
          targetDistance,
          movementDistance: this.chebyshevDistance(attacker, { x, y }),
        });
      }
    }

    return candidates
      .sort((left, right) =>
        left.movementDistance - right.movementDistance
        || left.targetDistance - right.targetDistance
        || left.y - right.y
        || left.x - right.x
      )
      .map(({ x, y }) => ({ x, y }));
  }

  private chebyshevDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  }

  private toGridPosition(world: WorldState, position: { x: number; y: number }): { x: number; y: number } {
    const height = world.tiles.length;
    const width = world.tiles[0]?.length ?? 0;
    return {
      x: Math.max(0, Math.min(width - 1, Math.round(position.x))),
      y: Math.max(0, Math.min(height - 1, Math.round(position.y))),
    };
  }

  private isNearPosition(
    position: { x: number; y: number },
    target: { x: number; y: number },
    tolerance = 0.35,
  ): boolean {
    return Math.max(Math.abs(position.x - target.x), Math.abs(position.y - target.y)) <= tolerance;
  }

  private cancelAttackCycle(attacker: WorldUnit, targetId?: string): void {
    if (!targetId || attacker.attackWindup?.targetId === targetId) {
      delete attacker.attackWindup;
    }
    if (!targetId || attacker.attackStream?.targetId === targetId) {
      delete attacker.attackStream;
    }
  }
}
