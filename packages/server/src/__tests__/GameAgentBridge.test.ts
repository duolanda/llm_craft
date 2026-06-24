import { describe, expect, it, vi } from "vitest";
import { Game } from "../Game";
import { GameAgentBridge } from "../agent/GameAgentBridge";
import { BUILDING_TYPES, DEFAULT_MAP_LAYOUT, TILE_TYPES, UNIT_TYPES } from "@llmcraft/shared";

describe("GameAgentBridge", () => {
  const player1BuildSite = { x: DEFAULT_MAP_LAYOUT.player1Hq.x + 16, y: DEFAULT_MAP_LAYOUT.player1Hq.y };

  it("queues action commands into the game immediately", () => {
    const game = new Game();
    game.start();
    const bridge = new GameAgentBridge(game, "player_1");
    const worker = game.getState().players[0].units.find((unit) => unit.type === "worker")!;

    const result = bridge.moveUnit(worker.id, DEFAULT_MAP_LAYOUT.resources[0]);

    expect(result.result).toMatchObject({ ok: true });
    expect(result.result).toMatchObject({
      tick: expect.any(Number),
      warning: expect.objectContaining({ type: "no_recent_read" }),
    });
    expect(bridge.takeIssuedCommands()).toHaveLength(1);

    game.tickUpdate();

    const updatedWorker = game.getState().players[0].units.find((unit) => unit.id === worker.id)!;
    expect(updatedWorker.x).toBe(DEFAULT_MAP_LAYOUT.player1Workers[0].x + 1);
    expect(updatedWorker.y).toBe(DEFAULT_MAP_LAYOUT.player1Workers[0].y);
  });

  it("returns immediate validation errors for stale unit ids before queueing actions", () => {
    const game = new Game();
    const bridge = new GameAgentBridge(game, "player_1");

    const result = bridge.moveUnit("missing_unit", DEFAULT_MAP_LAYOUT.resources[0]);

    expect(result.result).toMatchObject({
      tick: 0,
      ok: false,
      error: "invalid_unit",
    });
    expect(bridge.takeIssuedCommands()).toHaveLength(0);
  });

  it("adds a stale-read warning to actions when the last read is old", () => {
    const game = new Game();
    game.start();
    const bridge = new GameAgentBridge(game, "player_1");
    const worker = game.getState().players[0].units.find((unit) => unit.type === "worker")!;

    bridge.getMyUnits();
    for (let i = 0; i < 11; i++) {
      game.tickUpdate();
    }

    const result = bridge.moveUnit(worker.id, DEFAULT_MAP_LAYOUT.resources[0]);
    game.stop();

    expect(result.result).toMatchObject({
      tick: 11,
      ok: true,
      warning: expect.objectContaining({
        type: "state_stale",
        lastReadTick: 0,
        currentTick: 11,
        ageTicks: 11,
        staleAfterTicks: 10,
      }),
    });
  });

  it("returns an immediate validation error for barracks positions adjacent to HQ", () => {
    const game = new Game();
    const bridge = new GameAgentBridge(game, "player_2");
    const worker = game.getState().players[1].units.find((unit) => unit.type === UNIT_TYPES.WORKER)!;

    const result = bridge.buildStructure(worker.id, "barracks", {
      x: DEFAULT_MAP_LAYOUT.player2Hq.x,
      y: DEFAULT_MAP_LAYOUT.player2Hq.y - 1,
    });

    expect(result.result).toMatchObject({
      ok: false,
      error: "invalid_build_position",
    });
    expect((result.result as { hint: string }).hint).toContain("building footprint");
    expect(bridge.takeIssuedCommands()).toHaveLength(0);
  });

  it("rejects old non-call orchestrate_plan steps instead of registering a stuck plan", () => {
    const game = new Game();
    const bridge = new GameAgentBridge(game, "player_2");
    const worker = game.getState().players[1].units.find((unit) => unit.type === UNIT_TYPES.WORKER)!;

    const result = bridge.orchestratePlan({
      unitIds: [worker.id],
      steps: [{ type: "move_to_resource" }] as any,
    });

    expect(result.result).toMatchObject({
      ok: false,
      error: "invalid_plan",
    });
    expect((result.result as { hint: string }).hint).toContain("{ call: existing_tool");
    expect(bridge.getActivePlans()).toHaveLength(0);
  });

  it("registers call-step plans that attack-move near a target and then attack it", () => {
    const game = new Game();
    game.start();
    const bridge = new GameAgentBridge(game, "player_1");
    const soldier = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 5, 10, "player_1");
    const enemyHQ = game.getState().players[1].buildings.find((building) => building.type === "hq")!;

    const result = bridge.orchestratePlan({
      unitIds: [soldier.id],
      steps: [
        {
          call: "attack_move_unit",
          args: { unitId: "$unitId", x: enemyHQ.x, y: enemyHQ.y },
          until: { condition: "near_position", x: enemyHQ.x, y: enemyHQ.y, distance: 1 },
          maxTicks: 40,
        },
        {
          call: "attack",
          args: { unitId: "$unitId", targetId: enemyHQ.id },
          until: { condition: "target_destroyed", targetId: enemyHQ.id },
          retry: true,
        },
      ],
    });

    expect(result.result).toMatchObject({ ok: true });
    expect(bridge.advancePlans()).toEqual([
      expect.objectContaining({
        type: "attack_move",
        unitId: soldier.id,
        position: { x: enemyHQ.x, y: enemyHQ.y },
      }),
    ]);

    soldier.x = enemyHQ.x - 1;
    soldier.y = enemyHQ.y;
    expect(bridge.advancePlans()).toEqual([
      expect.objectContaining({
        type: "attack",
        unitId: soldier.id,
        targetId: enemyHQ.id,
      }),
    ]);
    game.stop();
  });

  it("runs mixed-scope opening plans for harvesting, building, and production", () => {
    const game = new Game();
    game.start();
    const bridge = new GameAgentBridge(game, "player_1");
    const [worker1, worker2] = game.getState().players[0].units.filter((unit) => unit.type === UNIT_TYPES.WORKER);

    const result = bridge.orchestratePlan({
      unitIds: [worker1.id, worker2.id],
      steps: [
        { call: "start_harvest_loop", args: { unitId: "$unitId" }, scope: "per_unit" },
        {
          call: "build_structure",
          args: { unitId: worker1.id, buildingType: "barracks", x: player1BuildSite.x, y: player1BuildSite.y },
          scope: "global",
          when: { condition: "credits_at_least", amount: 120 },
          until: { condition: "building_exists", buildingType: "barracks" },
          retry: true,
        },
        {
          call: "spawn_unit",
          args: { buildingId: "$barracks", unitType: "soldier" },
          scope: "global",
          when: { condition: "production_queue_empty", buildingType: "barracks" },
          until: { condition: "unit_count_at_least", unitType: "soldier", count: 1 },
          retry: true,
        },
      ],
    });

    expect(result.result).toMatchObject({ ok: true });
    expect(bridge.advancePlans()).toEqual([
      expect.objectContaining({ type: "harvest_loop", unitId: worker1.id }),
      expect.objectContaining({ type: "harvest_loop", unitId: worker2.id }),
    ]);

    const buildCommands = bridge.advancePlans();
    expect(buildCommands).toEqual([
      expect.objectContaining({
        type: "build",
        unitId: worker1.id,
        buildingType: "barracks",
        position: player1BuildSite,
      }),
    ]);
    for (const command of buildCommands) {
      game.queueCommand(command);
    }
    game.tickUpdate();

    expect(bridge.advancePlans()).toEqual([
      expect.objectContaining({
        type: "spawn",
        unitType: "soldier",
      }),
    ]);
    game.stop();
  });

  it("supports war factory and light tank production in orchestration plans", () => {
    const game = new Game();
    game.start();
    const bridge = new GameAgentBridge(game, "player_1");
    const [worker1, worker2] = game.getState().players[0].units.filter((unit) => unit.type === UNIT_TYPES.WORKER);

    const result = bridge.orchestratePlan({
      unitIds: [worker1.id, worker2.id],
      steps: [
        {
          call: "build_structure",
          args: { unitId: worker1.id, buildingType: "war_factory", x: player1BuildSite.x, y: player1BuildSite.y },
          scope: "global",
          when: { condition: "credits_at_least", amount: 220 },
          until: { condition: "building_exists", buildingType: "war_factory" },
          retry: true,
        },
        {
          call: "spawn_unit",
          args: { buildingId: "$war_factory", unitType: "light_tank" },
          scope: "global",
          when: { condition: "production_queue_empty", buildingType: "war_factory" },
          until: { condition: "unit_count_at_least", unitType: "light_tank", count: 1 },
          retry: true,
        },
      ],
    });

    expect(result.result).toMatchObject({ ok: true });
    const buildCommands = bridge.advancePlans();
    expect(buildCommands).toEqual([
      expect.objectContaining({
        type: "build",
        unitId: worker1.id,
        buildingType: "war_factory",
        position: player1BuildSite,
      }),
    ]);
    for (const command of buildCommands) {
      game.queueCommand(command);
    }
    game.tickUpdate();

    const runtimeWorker2 = game.getUnitManager().getUnit(worker2.id)!;
    runtimeWorker2.x = DEFAULT_MAP_LAYOUT.player1Hq.x + 1;
    runtimeWorker2.y = DEFAULT_MAP_LAYOUT.player1Hq.y;
    runtimeWorker2.carryingCredits = 100;
    game.tickUpdate();
    runtimeWorker2.carryingCredits = 20;
    game.tickUpdate();

    expect(bridge.advancePlans()).toEqual([
      expect.objectContaining({
        type: "spawn",
        unitType: "light_tank",
      }),
    ]);
    game.stop();
  });

  it("waits instead of queueing unaffordable production from orchestration plans", () => {
    const game = new Game();
    game.start();
    const bridge = new GameAgentBridge(game, "player_1");
    const [worker] = game.getState().players[0].units.filter((unit) => unit.type === UNIT_TYPES.WORKER);
    const hq = game.getState().players[0].buildings.find((building) => building.type === BUILDING_TYPES.HQ)!;

    for (let i = 0; i < 12; i++) {
      game.queueCommand({
        id: `spend_worker_${i}`,
        type: "spawn",
        buildingId: hq.id,
        unitType: UNIT_TYPES.WORKER,
        playerId: "player_1",
      });
    }
    game.processCommands();
    game.getBuildingManager().createBuilding(BUILDING_TYPES.WAR_FACTORY, player1BuildSite.x, player1BuildSite.y, "player_1");

    const result = bridge.orchestratePlan({
      unitIds: [worker.id],
      steps: [
        {
          call: "spawn_unit",
          args: { buildingId: "$war_factory", unitType: "light_tank" },
          scope: "global",
          when: { condition: "production_queue_empty", buildingType: "war_factory" },
          until: { condition: "unit_count_at_least", unitType: "light_tank", count: 1 },
          retry: true,
        },
      ],
    });

    expect(result.result).toMatchObject({ ok: true });
    expect(game.getState().players[0].resources.credits).toBe(200);
    expect(bridge.advancePlans()).toEqual([]);
    expect(bridge.getActivePlans()).toEqual([
      expect.objectContaining({
        currentStep: expect.objectContaining({
          call: "spawn_unit",
          args: { buildingId: "$war_factory", unitType: "light_tank" },
        }),
        waitingReason: "waiting for budget: need 240 credits, available 200",
        lastAttempt: expect.objectContaining({
          call: "spawn_unit",
          status: "waiting",
          detail: "waiting for budget: need 240 credits, available 200",
        }),
      }),
    ]);
    game.stop();
  });

  it("reserves same-tick budget across active orchestration plans", () => {
    const game = new Game();
    game.start();
    const bridge = new GameAgentBridge(game, "player_1");
    const [worker1, worker2] = game.getState().players[0].units.filter((unit) => unit.type === UNIT_TYPES.WORKER);
    const hq = game.getState().players[0].buildings.find((building) => building.type === BUILDING_TYPES.HQ)!;

    for (let i = 0; i < 10; i++) {
      game.queueCommand({
        id: `spend_worker_${i}`,
        type: "spawn",
        buildingId: hq.id,
        unitType: UNIT_TYPES.WORKER,
        playerId: "player_1",
      });
    }
    game.processCommands();
    game.getBuildingManager().createBuilding(BUILDING_TYPES.BARRACKS, player1BuildSite.x, player1BuildSite.y - 1, "player_1");
    game.getBuildingManager().createBuilding(BUILDING_TYPES.WAR_FACTORY, player1BuildSite.x, player1BuildSite.y + 1, "player_1");

    bridge.orchestratePlan({
      unitIds: [worker1.id],
      steps: [
        {
          call: "spawn_unit",
          args: { buildingId: "$war_factory", unitType: "light_tank" },
          scope: "global",
          when: { condition: "production_queue_empty", buildingType: "war_factory" },
          until: { condition: "unit_count_at_least", unitType: "light_tank", count: 1 },
          retry: true,
        },
      ],
    });
    bridge.orchestratePlan({
      unitIds: [worker2.id],
      steps: [
        {
          call: "spawn_unit",
          args: { buildingId: "$barracks", unitType: "rocket_soldier" },
          scope: "global",
          when: { condition: "production_queue_empty", buildingType: "barracks" },
          until: { condition: "unit_count_at_least", unitType: "rocket_soldier", count: 1 },
          retry: true,
        },
      ],
    });

    expect(game.getState().players[0].resources.credits).toBe(300);
    expect(bridge.advancePlans()).toEqual([
      expect.objectContaining({
        type: "spawn",
        unitType: "light_tank",
      }),
    ]);
    expect(bridge.getActivePlans()).toEqual([
      expect.objectContaining({
        lastAttempt: expect.objectContaining({
          call: "spawn_unit",
          status: "command_created",
          commandCount: 1,
        }),
      }),
      expect.objectContaining({
        waitingReason: "waiting for budget: need 110 credits, available 60",
        lastAttempt: expect.objectContaining({
          call: "spawn_unit",
          status: "waiting",
          detail: "waiting for budget: need 110 credits, available 60",
        }),
      }),
    ]);
    game.stop();
  });

  it("summarizes tech status and recommends counters from get_my_state", () => {
    const game = new Game();
    game.start();
    const bridge = new GameAgentBridge(game, "player_1");

    game.getBuildingManager().createBuilding(BUILDING_TYPES.BARRACKS, player1BuildSite.x, player1BuildSite.y, "player_1");
    game.getBuildingManager().createBuilding(
      BUILDING_TYPES.WAR_FACTORY,
      DEFAULT_MAP_LAYOUT.player1Hq.x + 7,
      DEFAULT_MAP_LAYOUT.player1Hq.y,
      "player_2"
    );
    game.getUnitManager().createUnit(
      UNIT_TYPES.LIGHT_TANK,
      DEFAULT_MAP_LAYOUT.player1Hq.x + 6,
      DEFAULT_MAP_LAYOUT.player1Hq.y,
      "player_2"
    );

    const result = bridge.getMyState().result as {
      techStatus: {
        own: Record<string, number>;
        enemy: Record<string, unknown>;
        recommendedStructures: Array<Record<string, unknown>>;
        recommendedProduction: Array<Record<string, unknown>>;
      };
    };

    expect(result.techStatus.own.barracks).toBe(1);
    expect(result.techStatus.enemy).toMatchObject({ hasWarFactory: true, lightTanks: 1 });
    expect(result.techStatus.recommendedStructures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workerId: expect.any(String), buildingType: "refinery" }),
      ])
    );
    expect(result.techStatus.recommendedProduction).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ buildingId: expect.any(String), buildingType: "barracks", unitType: "rocket_soldier" }),
      ])
    );
    game.stop();
  });

  it("summarizes economy status and resource assignments from get_my_state", () => {
    const game = new Game();
    game.start();
    const bridge = new GameAgentBridge(game, "player_1");
    const workers = game.getState().players[0].units.filter((unit) => unit.type === UNIT_TYPES.WORKER);

    bridge.startHarvestLoop(workers[0].id);
    bridge.startHarvestLoop(workers[1].id);
    game.processCommands();

    const result = bridge.getMyState().result as {
      economyStatus: {
        workers: number;
        activeHarvesters: number;
        idleWorkers: number;
        carryingCredits: number;
        resourceAssignments: Array<Record<string, unknown>>;
        recommendations: Array<Record<string, unknown>>;
      };
    };

    expect(result.economyStatus).toMatchObject({
      workers: 4,
      activeHarvesters: 2,
      idleWorkers: 2,
      carryingCredits: 0,
    });
    expect(result.economyStatus.resourceAssignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          x: DEFAULT_MAP_LAYOUT.resources[0].x,
          y: DEFAULT_MAP_LAYOUT.resources[0].y,
          assignedHarvesters: 1,
        }),
        expect.objectContaining({
          x: DEFAULT_MAP_LAYOUT.resources[1].x,
          y: DEFAULT_MAP_LAYOUT.resources[1].y,
          assignedHarvesters: 1,
        }),
      ])
    );
    expect(result.economyStatus.recommendations).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "start_harvest_loop" })])
    );
    game.stop();
  });

  it("uses enemy tech conditions to trigger counter-production plans", () => {
    const game = new Game();
    game.start();
    const bridge = new GameAgentBridge(game, "player_1");
    const worker = game.getState().players[0].units.find((unit) => unit.type === UNIT_TYPES.WORKER)!;

    game.getBuildingManager().createBuilding(BUILDING_TYPES.BARRACKS, player1BuildSite.x, player1BuildSite.y, "player_1");
    game.getUnitManager().createUnit(
      UNIT_TYPES.LIGHT_TANK,
      DEFAULT_MAP_LAYOUT.player1Hq.x + 6,
      DEFAULT_MAP_LAYOUT.player1Hq.y,
      "player_2"
    );

    const result = bridge.orchestratePlan({
      unitIds: [worker.id],
      steps: [
        {
          call: "spawn_unit",
          args: { buildingId: "$barracks", unitType: "rocket_soldier" },
          scope: "global",
          when: { condition: "enemy_unit_count_at_least", unitType: "light_tank", count: 1 },
          until: { condition: "unit_count_at_least", unitType: "rocket_soldier", count: 1 },
          retry: true,
        },
      ],
    });

    expect(result.result).toMatchObject({ ok: true });
    expect(bridge.advancePlans()).toEqual([
      expect.objectContaining({
        type: "spawn",
        unitType: "rocket_soldier",
      }),
    ]);
    game.stop();
  });

  it("rejects unsupported call-step plan tools", () => {
    const bridge = new GameAgentBridge(new Game(), "player_2");

    const result = bridge.orchestratePlan({
      unitIds: ["unit_3"],
      steps: [
        {
          call: "spawn_unit",
          args: { unitId: "$unitId" },
        } as any,
      ],
    });

    expect(result.result).toMatchObject({
      ok: false,
      error: "invalid_plan",
    });
    expect(bridge.getActivePlans()).toHaveLength(0);
  });

  it("rejects plans that target buildings instead of units", () => {
    const bridge = new GameAgentBridge(new Game(), "player_2");

    const result = bridge.orchestratePlan({
      unitIds: ["building_2"],
      steps: [{ call: "hold_unit", args: { unitId: "$unitId" } }],
    });

    expect(result.result).toMatchObject({
      ok: false,
      error: "invalid_plan",
    });
    expect((result.result as { hint: string }).hint).toContain("friendly units");
    expect(bridge.getActivePlans()).toHaveLength(0);
  });

  it("returns a slim battlefield view from get_map_state by default", () => {
    const bridge = new GameAgentBridge(new Game(), "player_2");

    const result = bridge.getMapState();
    const mapState = result.result as {
      tick: number;
      units: Array<Record<string, unknown>>;
      buildings: Array<Record<string, unknown>>;
      resources: Array<Record<string, unknown>>;
      cells?: Array<Record<string, unknown>>;
    };

    expect(mapState.tick).toBe(0);
    expect(mapState).not.toHaveProperty("fogOfWar");
    expect(mapState).not.toHaveProperty("visibleTileCount");
    expect(mapState).not.toHaveProperty("asciiMap");
    expect(mapState).not.toHaveProperty("legend");
    expect(mapState.cells).toBeUndefined();
    expect(mapState.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          x: DEFAULT_MAP_LAYOUT.resources[0].x,
          y: DEFAULT_MAP_LAYOUT.resources[0].y,
          remaining: 5000,
        }),
      ])
    );
    expect(mapState.units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          x: DEFAULT_MAP_LAYOUT.player2Workers[0].x,
          y: DEFAULT_MAP_LAYOUT.player2Workers[0].y,
          type: "worker",
          hp: 50,
          maxHp: 50,
          state: "idle",
          relation: "self",
        }),
      ])
    );
    expect(mapState.units.some((unit) => unit.relation === "enemy")).toBe(true);
    expect(mapState.buildings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ x: DEFAULT_MAP_LAYOUT.player2Hq.x, y: DEFAULT_MAP_LAYOUT.player2Hq.y, type: "hq", relation: "self" }),
      ])
    );
    expect(mapState.buildings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ x: DEFAULT_MAP_LAYOUT.player1Hq.x, y: DEFAULT_MAP_LAYOUT.player1Hq.y, type: "hq", relation: "enemy" }),
      ])
    );
    expect(mapState.units[0]).not.toHaveProperty("my");
    expect(mapState.units[0]).not.toHaveProperty("playerId");
    expect(mapState.units[0]).not.toHaveProperty("carryingCredits");
    expect(mapState.units[0]).not.toHaveProperty("attackRange");
  });

  it("groups controllable units by role and intent in get_my_units", () => {
    const game = new Game();
    game.start();
    const bridge = new GameAgentBridge(game, "player_1");
    const tank = game.getUnitManager().createUnit(UNIT_TYPES.LIGHT_TANK, 30, 48, "player_1");
    const rocket = game.getUnitManager().createUnit(UNIT_TYPES.ROCKET_SOLDIER, 31, 49, "player_1");

    bridge.holdUnit(tank.id);
    bridge.holdUnit(rocket.id);
    game.processCommands();

    const result = bridge.getMyUnits().result as {
      groups: Array<Record<string, unknown>>;
      units: Array<Record<string, unknown>>;
    };

    expect(result.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "combat",
          intent: "hold",
          count: 2,
          unitIds: expect.arrayContaining([tank.id, rocket.id]),
          types: expect.objectContaining({
            [UNIT_TYPES.LIGHT_TANK]: 1,
            [UNIT_TYPES.ROCKET_SOLDIER]: 1,
          }),
          center: { x: 31, y: 49 },
        }),
        expect.objectContaining({
          role: "worker",
          intent: "none",
          count: 4,
        }),
      ])
    );
    expect(result.units.find((unit) => unit.id === tank.id)).toMatchObject({ intent: { type: "hold" } });
    game.stop();
  });

  it("reveals enemy units and buildings across the full battlefield", () => {
    const game = new Game();
    const bridge = new GameAgentBridge(game, "player_1");
    const enemyScout = game.getUnitManager().createUnit(
      UNIT_TYPES.RIFLEMAN,
      DEFAULT_MAP_LAYOUT.player1Hq.x + 7,
      DEFAULT_MAP_LAYOUT.player1Hq.y,
      "player_2"
    );
    const hiddenEnemy = game.getUnitManager().createUnit(
      UNIT_TYPES.LIGHT_TANK,
      DEFAULT_MAP_LAYOUT.player2Hq.x - 2,
      DEFAULT_MAP_LAYOUT.player2Hq.y,
      "player_2"
    );

    const mapState = bridge.getMapState().result as {
      units: Array<Record<string, unknown>>;
      buildings: Array<Record<string, unknown>>;
    };

    expect(mapState.units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: enemyScout.id, relation: "enemy", type: UNIT_TYPES.RIFLEMAN }),
      ])
    );
    expect(mapState.units.some((unit) => unit.id === hiddenEnemy.id)).toBe(true);
    expect(mapState.buildings.some((building) => building.relation === "enemy")).toBe(true);
  });

  it("queues attack-move commands with role-aware target priority by default", () => {
    const game = new Game();
    game.start();
    const bridge = new GameAgentBridge(game, "player_1");
    const soldier = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const lightTank = game.getUnitManager().createUnit(UNIT_TYPES.LIGHT_TANK, 5, 6, "player_1");

    const soldierResult = bridge.attackMoveUnit(soldier.id, DEFAULT_MAP_LAYOUT.player2Hq);
    const tankResult = bridge.attackMoveUnit(lightTank.id, DEFAULT_MAP_LAYOUT.player2Hq);

    expect(soldierResult.result).toMatchObject({ ok: true });
    expect(tankResult.result).toMatchObject({ ok: true });
    expect(bridge.takeIssuedCommands()).toEqual([
      expect.objectContaining({
        type: "attack_move",
        unitId: soldier.id,
        position: DEFAULT_MAP_LAYOUT.player2Hq,
        targetPriority: ["rocket_soldier", "rifleman", "soldier", "worker", "light_tank", "barracks", "refinery", "hq"],
      }),
      expect.objectContaining({
        type: "attack_move",
        unitId: lightTank.id,
        position: DEFAULT_MAP_LAYOUT.player2Hq,
        targetPriority: ["light_tank", "rocket_soldier", "rifleman", "soldier", "war_factory", "barracks", "hq", "refinery"],
      }),
    ]);
    game.stop();
  });

  it("assigns distinct formation destinations to a 100-unit army in one command", () => {
    const game = new Game();
    const bridge = new GameAgentBridge(game, "player_1");
    const unitIds = Array.from({ length: 100 }, (_, index) =>
      game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 20 + (index % 10), 12 + Math.floor(index / 10), "player_1").id
    );

    const result = bridge.attackMoveGroup(unitIds, { x: 108, y: 48 }, "line");
    const payload = result.result as { ok: boolean; assignments: Array<{ position: { x: number; y: number } }> };

    expect(payload.ok).toBe(true);
    expect(payload.assignments).toHaveLength(100);
    expect(new Set(payload.assignments.map((assignment) => `${assignment.position.x},${assignment.position.y}`)).size).toBe(100);
    expect(bridge.takeIssuedCommands()).toHaveLength(100);
  });

  it("summarizes army readiness and recommends battle_line for tank groups", () => {
    const game = new Game();
    const bridge = new GameAgentBridge(game, "player_1");
    game.getUnitManager().createUnit(UNIT_TYPES.LIGHT_TANK, 10, 10, "player_1");
    game.getUnitManager().createUnit(UNIT_TYPES.LIGHT_TANK, 11, 10, "player_1");
    game.getUnitManager().createUnit(UNIT_TYPES.LIGHT_TANK, 12, 10, "player_1");
    game.getUnitManager().createUnit(UNIT_TYPES.LIGHT_TANK, 13, 10, "player_1");
    game.getUnitManager().createUnit(UNIT_TYPES.ROCKET_SOLDIER, 20, 10, "player_2");

    const summary = bridge.getArmySummary().result as {
      myCounts: Record<string, number>;
      enemyCounts: Record<string, number>;
      recommendedFormation: string;
      recommendations: Array<{ action: string; formation?: string }>;
    };

    expect(summary.myCounts.light_tank).toBe(4);
    expect(summary.enemyCounts.rocket_soldier).toBe(1);
    expect(summary.recommendedFormation).toBe("battle_line");
    expect(summary.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "attack_move_group", formation: "battle_line" }),
    ]));
  });

  it("assigns battle_line formation with tanks ahead of rockets", () => {
    const game = new Game();
    const bridge = new GameAgentBridge(game, "player_1");
    const tank = game.getUnitManager().createUnit(UNIT_TYPES.LIGHT_TANK, 10, 10, "player_1");
    const rifleman = game.getUnitManager().createUnit(UNIT_TYPES.RIFLEMAN, 10, 11, "player_1");
    const rocket = game.getUnitManager().createUnit(UNIT_TYPES.ROCKET_SOLDIER, 10, 12, "player_1");

    const result = bridge.attackMoveGroup([rocket.id, tank.id, rifleman.id], { x: 60, y: 48 }, "battle_line").result as {
      assignments: Array<{ unitId: string; position: { x: number; y: number } }>;
    };
    const byUnit = new Map(result.assignments.map((assignment) => [assignment.unitId, assignment.position]));

    expect(byUnit.get(tank.id)?.x).toBe(60);
    expect(byUnit.get(rifleman.id)?.x).toBe(56);
    expect(byUnit.get(rocket.id)?.x).toBe(52);
  });

  it("queues high-level attack as movement until the target is in range", () => {
    const game = new Game();
    game.start();
    const bridge = new GameAgentBridge(game, "player_1");
    const attacker = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const target = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 8, 5, "player_2");

    bridge.getMapState();
    const result = bridge.attackTarget(attacker.id, target.id);

    expect(result.result).toMatchObject({ ok: true, mode: "move_to_target" });
    expect(bridge.takeIssuedCommands()).toEqual([
      expect.objectContaining({
        type: "move",
        unitId: attacker.id,
        position: { x: 8, y: 5 },
      }),
    ]);

    attacker.x = 7;
    attacker.y = 5;
    expect(bridge.advancePlans()).toEqual([
      expect.objectContaining({
        type: "attack",
        unitId: attacker.id,
        targetId: target.id,
      }),
    ]);
    game.stop();
  });

  it("moves to a remembered target position when the attack target has died", () => {
    const game = new Game();
    game.start();
    const bridge = new GameAgentBridge(game, "player_1");
    const attacker = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const target = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 8, 5, "player_2");

    bridge.getMapState();
    game.getUnitManager().removeUnit(target.id);

    const result = bridge.attackTarget(attacker.id, target.id);

    expect(result.result).toMatchObject({ ok: true, mode: "move_to_last_seen" });
    expect(bridge.takeIssuedCommands()).toEqual([
      expect.objectContaining({
        type: "move",
        unitId: attacker.id,
        position: { x: 8, y: 5 },
      }),
    ]);
    expect(bridge.advancePlans()).toEqual([]);
    game.stop();
  });

  it("returns detailed map cells only when requested", () => {
    const bridge = new GameAgentBridge(new Game(), "player_2");

    const result = bridge.getMapState({ includeCells: true });
    const mapState = result.result as {
      cells: Array<Record<string, unknown>>;
    };

    expect(mapState.cells.length).toBeGreaterThan(0);
    expect(mapState.cells.some((cell) => cell.tile === TILE_TYPES.RESOURCE)).toBe(true);
    expect(mapState.cells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          x: DEFAULT_MAP_LAYOUT.player2Workers[0].x,
          y: DEFAULT_MAP_LAYOUT.player2Workers[0].y,
          tile: "empty",
          unit: expect.objectContaining({
            type: "worker",
            x: DEFAULT_MAP_LAYOUT.player2Workers[0].x,
            y: DEFAULT_MAP_LAYOUT.player2Workers[0].y,
            relation: "self",
          }),
        }),
      ])
    );
  });

  it("queues built-in harvest loops for workers", () => {
    const game = new Game();
    game.start();
    const bridge = new GameAgentBridge(game, "player_1");
    const worker = game.getState().players[0].units.find((unit) => unit.type === "worker")!;

    const result = bridge.startHarvestLoop(worker.id, DEFAULT_MAP_LAYOUT.resources[0]);

    expect(result.result).toMatchObject({ ok: true });
    expect(bridge.takeIssuedCommands()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "harvest_loop",
          unitId: worker.id,
          position: DEFAULT_MAP_LAYOUT.resources[0],
        }),
      ])
    );

    game.tickUpdate();
    game.stop();

    const updatedWorker = game.getState().players[0].units.find((unit) => unit.id === worker.id)!;
    expect(updatedWorker.intent).toMatchObject({
      type: "harvest_loop",
      targetX: DEFAULT_MAP_LAYOUT.resources[0].x,
      targetY: DEFAULT_MAP_LAYOUT.resources[0].y,
    });
  });

  it("returns controllable units with the read tick", () => {
    const bridge = new GameAgentBridge(new Game(), "player_1");

    const result = bridge.getMyUnits();
    const myUnits = result.result as { tick: number; units: Array<Record<string, unknown>> };

    expect(myUnits.tick).toBe(0);
    expect(myUnits.units).toHaveLength(4);
    expect(myUnits.units[0]).toHaveProperty("hasActivePlan", false);
  });

  it("shares one lightweight read state across same-tick read tools", () => {
    const game = new Game();
    const bridge = new GameAgentBridge(game, "player_1");
    const readStateSpy = vi.spyOn(game, "getAgentReadState");
    const fullStateSpy = vi.spyOn(game, "getState");

    bridge.getMapState();
    bridge.getMyState();
    bridge.getMyUnits();
    bridge.getActivePlansTool();
    bridge.getRecentEvents();

    expect(readStateSpy).toHaveBeenCalledTimes(1);
    expect(fullStateSpy).not.toHaveBeenCalled();
  });

  it("invalidates the lightweight read cache on the next tick", () => {
    const game = new Game();
    game.start();
    const bridge = new GameAgentBridge(game, "player_1");
    const readStateSpy = vi.spyOn(game, "getAgentReadState");

    bridge.getMyUnits();
    bridge.getMyState();
    expect(readStateSpy).toHaveBeenCalledTimes(1);

    game.tickUpdate();
    bridge.getMyUnits();
    game.stop();

    expect(readStateSpy).toHaveBeenCalledTimes(2);
  });
});
