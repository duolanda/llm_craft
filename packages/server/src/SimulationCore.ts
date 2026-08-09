import { WorldState } from "./WorldState";
import { CombatSystem } from "./simulation/CombatSystem";
import { ConstructionSystem, type ConstructionEvent } from "./simulation/ConstructionSystem";
import { EconomySystem, type EconomyEvent } from "./simulation/EconomySystem";
import { HarvestOrderSystem } from "./simulation/HarvestOrderSystem";
import { MovementSystem, type MovementEvent } from "./simulation/MovementSystem";
import { ProductionSystem, type ProductionEvent } from "./simulation/ProductionSystem";
import { ProjectileSystem, type ProjectileEvent } from "./simulation/ProjectileSystem";
import { VictorySystem, type VictoryOutcome } from "./simulation/VictorySystem";

export type SimulationEvent = MovementEvent | EconomyEvent | ConstructionEvent | ProductionEvent | ProjectileEvent | VictoryOutcome;

export interface SimulationStepResult {
  advanced: true;
  tick: number;
  matchEnded: boolean;
  events: SimulationEvent[];
}

export interface SimulationSystems {
  movement: Pick<MovementSystem, "step">;
  projectiles: Pick<ProjectileSystem, "step">;
  economy: Pick<EconomySystem, "step">;
  harvestOrders: Pick<HarvestOrderSystem, "step">;
  combat: Pick<CombatSystem, "step">;
  construction: Pick<ConstructionSystem, "step">;
  production: Pick<ProductionSystem, "step">;
  victory: Pick<VictorySystem, "step">;
}

function createDefaultSystems(): SimulationSystems {
  return {
    movement: new MovementSystem(),
    projectiles: new ProjectileSystem(),
    economy: new EconomySystem(),
    harvestOrders: new HarvestOrderSystem(),
    combat: new CombatSystem(),
    construction: new ConstructionSystem(),
    production: new ProductionSystem(),
    victory: new VictorySystem(),
  };
}

/**
 * Applies one deterministic rules step directly to authoritative WorldState.
 *
 * MatchRuntime owns clocks and lifecycle. CommandGateway
 * applies the accepted command batch at the tick boundary before this method.
 * The core has no timer, model, network, renderer, log or filesystem dependency.
 */
export class SimulationCore {
  private readonly systems: SimulationSystems;

  constructor(systems: Partial<SimulationSystems> = {}) {
    this.systems = { ...createDefaultSystems(), ...systems };
  }

  step(world: WorldState): SimulationStepResult {
    const events: SimulationEvent[] = [];

    events.push(...this.systems.movement.step(world));
    events.push(...this.systems.projectiles.step(world));
    events.push(...this.systems.economy.step(world));
    this.systems.harvestOrders.step(world);
    this.systems.combat.step(world);
    events.push(...this.systems.construction.step(world));
    events.push(...this.systems.production.step(world));
    const victory = this.systems.victory.step(world);
    if (victory) events.push(victory);
    return {
      advanced: true,
      tick: world.tick,
      matchEnded: victory !== null,
      events,
    };
  }
}
