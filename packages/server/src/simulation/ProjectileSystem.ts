import {
  UNIT_STATES,
  getAttackDamageAgainstBuilding,
  getAttackDamageAgainstUnit,
  getUnitWeapon,
  type ActiveProjectile,
  type Building,
} from "@llmcraft/shared";
import { WorldState } from "../WorldState";
import type { WorldUnit } from "../WorldUnit";

export class ProjectileSystem {
  step(world: WorldState): void {
    if (world.projectiles.length === 0) return;

    const remaining: ActiveProjectile[] = [];
    for (const projectile of world.projectiles) {
      const liveTarget = projectile.targetId ? this.resolveTarget(world, projectile) : null;
      if (liveTarget) {
        projectile.targetX = liveTarget.x;
        projectile.targetY = liveTarget.y;
      }

      if (world.tick >= projectile.impactTick) {
        this.applyImpact(world, projectile);
        continue;
      }

      const totalTicks = Math.max(1, projectile.impactTick - projectile.launchedTick);
      const elapsedTicks = Math.max(0, world.tick - projectile.launchedTick);
      const progress = Math.min(1, elapsedTicks / totalTicks);
      projectile.x = projectile.startX + (projectile.targetX - projectile.startX) * progress;
      projectile.y = projectile.startY + (projectile.targetY - projectile.startY) * progress;
      remaining.push(projectile);
    }
    world.projectiles = remaining;
  }

  private resolveTarget(world: WorldState, projectile: ActiveProjectile): { x: number; y: number } | null {
    if (!projectile.targetId) return null;
    const target = world.entities.resolve(projectile.targetId);
    if (!target || target.kind !== projectile.targetKind) return null;
    return { x: target.entity.x, y: target.entity.y };
  }

  private applyImpact(world: WorldState, projectile: ActiveProjectile): void {
    const impact = this.resolveTarget(world, projectile) ?? { x: projectile.targetX, y: projectile.targetY };
    const weapon = getUnitWeapon(projectile.attackerType);
    const radius = weapon.splashRadius ?? 0;
    const damagedUnits = new Set<string>();
    const damagedBuildings = new Set<string>();
    const directTarget = projectile.targetId
      ? world.entities.resolve(projectile.targetId)
      : undefined;

    if (
      directTarget?.kind === "unit"
      && projectile.targetKind === "unit"
      && directTarget.entity.playerId !== projectile.playerId
    ) {
      this.damageUnit(world, projectile, directTarget.entity, 1);
      damagedUnits.add(directTarget.entity.id);
    } else if (
      directTarget?.kind === "building"
      && projectile.targetKind === "building"
      && directTarget.entity.playerId !== projectile.playerId
    ) {
      this.damageBuilding(world, projectile, directTarget.entity, 1);
      damagedBuildings.add(directTarget.entity.id);
    }

    if (radius <= 0) return;

    for (const unit of world.units.getAllUnits()) {
      if (unit.playerId === projectile.playerId || damagedUnits.has(unit.id)) continue;
      const distance = this.chebyshevDistance(unit, impact);
      const multiplier = this.splashMultiplier(distance, weapon.splashFalloff, radius);
      if (multiplier > 0) this.damageUnit(world, projectile, unit, multiplier);
    }

    for (const building of world.buildings.getAllBuildings()) {
      if (building.playerId === projectile.playerId || damagedBuildings.has(building.id)) continue;
      const distance = world.buildings.getDistanceToBuilding(building, impact.x, impact.y);
      const multiplier = this.splashMultiplier(distance, weapon.splashFalloff, radius);
      if (multiplier > 0) this.damageBuilding(world, projectile, building, multiplier);
    }
  }

  private splashMultiplier(distance: number, falloff: number[] | undefined, radius: number): number {
    if (distance < 0 || distance > radius) return 0;
    if (!falloff || falloff.length === 0) return distance === 0 ? 1 : 0.5;
    const index = Math.min(falloff.length - 1, Math.max(0, Math.ceil(distance)));
    return falloff[index] ?? 0;
  }

  private damageUnit(
    world: WorldState,
    projectile: ActiveProjectile,
    target: WorldUnit,
    multiplier: number,
  ): void {
    const damage = Math.max(
      0,
      Math.round(getAttackDamageAgainstUnit(projectile.attackerType, target.type) * multiplier),
    );
    if (damage <= 0) return;
    target.hp -= damage;
    if (target.hp <= 0) world.destroyEntity(target.id);
  }

  private damageBuilding(
    world: WorldState,
    projectile: ActiveProjectile,
    target: Building,
    multiplier: number,
  ): void {
    const damage = Math.max(
      0,
      Math.round(getAttackDamageAgainstBuilding(projectile.attackerType, target.type) * multiplier),
    );
    if (damage <= 0) return;
    const destroyed = world.buildings.takeDamage(target, damage);
    if (!destroyed) return;
    this.releaseConstructionWorker(world, target);
    world.destroyEntity(target.id);
  }

  private releaseConstructionWorker(world: WorldState, building: Building): void {
    const workerId = building.constructionProgress?.workerId;
    building.constructionProgress = undefined;
    if (!workerId) return;
    const worker = world.units.getUnit(workerId);
    if (!worker || !worker.exists || worker.constructingBuildingId !== building.id) return;
    worker.constructingBuildingId = undefined;
    worker.state = UNIT_STATES.IDLE;
    worker.order = undefined;
  }

  private chebyshevDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  }
}
