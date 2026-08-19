import { describe, expect, it, vi } from "vitest";
import { Game } from "../Game";
import { GameplayController } from "../controller/GameplayController";
import { executeAgentTool, getAgentToolDefinitions } from "../agent/AgentTools";
import { BUILDING_TYPES, DEFAULT_MAP_LAYOUT, TILE_TYPES, UNIT_TYPES, getBuildingConstructionTicks, getBuildingFootprint, getDistanceToBuildingFootprint, getUnitProductionTicks } from "@llmcraft/shared";

describe("GameplayController", () => {
  const player1BuildSite = { x: DEFAULT_MAP_LAYOUT.player1Hq.x + 16, y: DEFAULT_MAP_LAYOUT.player1Hq.y };

  function moveWorkerAdjacentToBuildSite(
    game: Game,
    workerId: string,
    buildingType: typeof BUILDING_TYPES[keyof typeof BUILDING_TYPES],
    site: { x: number; y: number } = player1BuildSite,
  ): void {
    const worker = game.getUnitManager().getUnit(workerId)!;
    const footprint = getBuildingFootprint(buildingType);
    worker.x = site.x - Math.floor(footprint.width / 2) - 1;
    worker.y = site.y;
  }

  function advanceTicks(game: Game, count: number): void {
    for (let tick = 0; tick < count; tick++) {
      game.tickUpdate();
    }
  }

  it("uses box-selection style unit arrays without a separate formation tool", () => {
    const tools = getAgentToolDefinitions();
    expect(tools.some((tool) => tool.name === "attack_move_group")).toBe(false);
    expect(tools.some((tool) => tool.name === "orchestrate_plan")).toBe(true);
    expect(tools.some((tool) => tool.name === "set_rally_point")).toBe(true);
    expect(tools.some((tool) => tool.name === "get_production_queue")).toBe(true);
    expect(tools.some((tool) => tool.name === "cancel_production")).toBe(true);
    expect(tools.some((tool) => tool.name === "cancel_plan")).toBe(true);
    const orchestrate = tools.find((tool) => tool.name === "orchestrate_plan")!;
    const planCalls = (((orchestrate.parameters.properties as any).steps.items.properties.call.enum) as string[]);
    expect(planCalls).not.toContain("spawn_unit");
    for (const name of ["move_unit", "attack_move_unit", "attack", "start_harvest_loop", "hold_unit"]) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      const unitIds = (tool.parameters.properties as Record<string, Record<string, unknown>>).unitIds;
      expect(unitIds.minItems).toBe(1);
      expect(unitIds).not.toHaveProperty("maxItems");
    }
  });

  it("queues action commands into the game immediately", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const worker = game.getState().players[0].units.find((unit) => unit.type === "worker")!;

    const result = gameplayController.moveUnit(worker.id, DEFAULT_MAP_LAYOUT.resources[0]);

    expect(result.result).toMatchObject({ ok: true });
    expect(result.result).toMatchObject({
      tick: expect.any(Number),
      warning: expect.objectContaining({ type: "no_recent_read" }),
    });
    expect(gameplayController.takeIssuedCommands()).toHaveLength(1);

    game.tickUpdate();

    const updatedWorker = game.getState().players[0].units.find((unit) => unit.id === worker.id)!;
    expect(updatedWorker.x).toBe(DEFAULT_MAP_LAYOUT.player1Workers[0].x + 1);
    expect(updatedWorker.y).toBe(DEFAULT_MAP_LAYOUT.player1Workers[0].y);
  });

  it("returns immediate validation errors for stale unit ids before queueing actions", () => {
    const game = new Game();
    const gameplayController = new GameplayController(game, "player_1");

    const result = gameplayController.moveUnit("missing_unit", DEFAULT_MAP_LAYOUT.resources[0]);

    expect(result.result).toMatchObject({
      tick: 0,
      ok: false,
      error: "invalid_unit",
      availableFriendlyUnits: expect.arrayContaining([
        expect.objectContaining({ type: UNIT_TYPES.WORKER }),
      ]),
    });
    expect(gameplayController.takeIssuedCommands()).toHaveLength(0);
  });

  it("does not warn merely because inference took many ticks after a read", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const worker = game.getState().players[0].units.find((unit) => unit.type === "worker")!;

    gameplayController.getMyUnits();
    for (let i = 0; i < 11; i++) {
      game.tickUpdate();
    }

    const result = gameplayController.moveUnit(worker.id, DEFAULT_MAP_LAYOUT.resources[0]);
    game.stop();

    expect(result.result).toMatchObject({ tick: 11, ok: true });
    expect(result.result).not.toHaveProperty("warning");
  });

  it("cancels active plans directly and fails global plans whose assigned unit dies", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const [firstWorker, secondWorker] = game.getState().players[0].units
      .filter((unit) => unit.type === UNIT_TYPES.WORKER);

    const firstPlan = gameplayController.orchestratePlan({
      unitIds: [firstWorker.id],
      steps: [{
        call: "build_structure",
        args: { unitId: firstWorker.id, buildingType: BUILDING_TYPES.BARRACKS },
        scope: "global",
        retry: true,
      }],
    }).result as { planId: string };
    expect(executeAgentTool(gameplayController, "cancel_plan", {
      planIds: [firstPlan.planId],
    }).result).toMatchObject({
      ok: true,
      cancelledPlanIds: [firstPlan.planId],
    });
    expect(gameplayController.getActivePlans()).toHaveLength(0);

    const secondPlan = gameplayController.orchestratePlan({
      unitIds: [secondWorker.id],
      steps: [{
        call: "build_structure",
        args: { unitId: secondWorker.id, buildingType: BUILDING_TYPES.BARRACKS },
        scope: "global",
        retry: true,
      }],
    }).result as { planId: string };
    game.getUnitManager().removeUnit(secondWorker.id);
    expect(gameplayController.handleCommittedTick()).toEqual([]);
    expect(gameplayController.getActivePlans()).toHaveLength(0);
    expect(gameplayController.getAllPlans()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        planId: secondPlan.planId,
        status: "failed",
        lastAttempt: expect.objectContaining({
          status: "failed",
          detail: expect.stringContaining(secondWorker.id),
        }),
      }),
    ]));
    game.stop();
  });

  it("queues, inspects, and cancels finite production batches through dedicated tools", () => {
    const game = new Game();
    const gameplayController = new GameplayController(game, "player_1");
    const barracks = game.getBuildingManager().createBuilding(
      BUILDING_TYPES.BARRACKS,
      player1BuildSite.x,
      player1BuildSite.y,
      "player_1",
    );

    expect(executeAgentTool(gameplayController, "spawn_unit", {
      buildingId: barracks.id,
      units: [{ unitType: UNIT_TYPES.SOLDIER, count: 1 }],
    }).result).toMatchObject({
      ok: false,
      error: "invalid_spawn_request",
      validUnitTypes: [UNIT_TYPES.RIFLEMAN, UNIT_TYPES.ROCKET_SOLDIER],
    });
    expect(gameplayController.getMyState().result).toMatchObject({
      canQueueSoldier: false,
      retiredProductionUnitTypes: [UNIT_TYPES.SOLDIER],
    });

    expect(executeAgentTool(gameplayController, "spawn_unit", {
      buildingId: barracks.id,
      units: [
        { unitType: UNIT_TYPES.RIFLEMAN, count: 5 },
        { unitType: UNIT_TYPES.ROCKET_SOLDIER, count: 5 },
      ],
    }).result).toMatchObject({ ok: true, requested: [{ count: 5 }, { count: 5 }] });
    game.processCommands();

    const inspected = executeAgentTool(gameplayController, "get_production_queue", {
      buildingIds: [barracks.id],
    }).result as any;
    expect(inspected.queues[0]).toMatchObject({
      buildingId: barracks.id,
      pendingByUnitType: { rifleman: 5, rocket_soldier: 5 },
      maxPendingPerUnitType: 100,
    });
    expect(inspected.queues[0].queue.map((order: any) => order.unitType)).toEqual([
      UNIT_TYPES.RIFLEMAN,
      UNIT_TYPES.ROCKET_SOLDIER,
    ]);

    const firstOrderId = inspected.queues[0].queue[0].orderId;
    expect(executeAgentTool(gameplayController, "cancel_production", {
      orderIds: [firstOrderId],
    }).result).toMatchObject({ ok: true, orderIds: [firstOrderId] });
    game.processCommands();
    const afterCancel = gameplayController.getProductionQueue([barracks.id]).result as any;
    expect(afterCancel.queues[0].queue).toHaveLength(1);
    expect(afterCancel.queues[0].queue[0].unitType).toBe(UNIT_TYPES.ROCKET_SOLDIER);
  });

  it("exposes the derived tech tier and blocks T3 production until a tech center is complete", () => {
    const game = new Game();
    const gameplayController = new GameplayController(game, "player_1");
    game.getBuildingManager().createBuilding(BUILDING_TYPES.BARRACKS, 24, 48, "player_1");
    const factory = game.getBuildingManager().createBuilding(BUILDING_TYPES.WAR_FACTORY, 32, 48, "player_1");

    expect(gameplayController.getMyState().result).toMatchObject({
      queueAvailability: expect.objectContaining({
        [UNIT_TYPES.LIGHT_TANK]: true,
        [UNIT_TYPES.FLAME_TANK]: true,
        [UNIT_TYPES.HEAVY_TANK]: false,
      }),
      techStatus: { own: expect.objectContaining({ tier: 2 }) },
    });
    expect(gameplayController.spawnUnit(factory.id, [{ unitType: UNIT_TYPES.HEAVY_TANK, count: 1 }]).result).toMatchObject({
      ok: false,
      error: "missing_prerequisite",
      missingPrerequisites: [BUILDING_TYPES.TECH_CENTER],
    });

    game.getBuildingManager().createBuilding(BUILDING_TYPES.TECH_CENTER, 40, 48, "player_1");
    const upgradedController = new GameplayController(game, "player_1");
    expect(upgradedController.getMyState().result).toMatchObject({
      queueAvailability: expect.objectContaining({
        [UNIT_TYPES.HEAVY_TANK]: true,
      }),
      techStatus: { own: expect.objectContaining({ tier: 3 }) },
    });
    expect(upgradedController.spawnUnit(factory.id, [{ unitType: UNIT_TYPES.HEAVY_TANK, count: 1 }]).result).toMatchObject({
      ok: true,
    });
  });

  it("exposes instantaneous phase separately from durable intent", () => {
    const game = new Game();
    const gameplayController = new GameplayController(game, "player_1");

    const result = gameplayController.getMyUnits().result as {
      units: Array<Record<string, unknown>>;
    };

    expect(result.units[0]).toHaveProperty("phase");
    expect(result.units[0]).not.toHaveProperty("state");
  });

  it("assigns harvest loops to unit arrays and treats an active loop as idempotent", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const workers = game.getState().players[0].units.filter((unit) => unit.type === UNIT_TYPES.WORKER).slice(0, 2);
    for (const worker of workers) gameplayController.holdUnit(worker.id);
    game.processCommands();
    gameplayController.takeIssuedCommands();

    const assigned = executeAgentTool(gameplayController, "start_harvest_loop", {
      unitIds: workers.map((worker) => worker.id),
    }).result as { ok: boolean; results: Array<Record<string, unknown>> };
    expect(assigned.ok).toBe(true);
    expect(assigned.results).toHaveLength(2);
    const commands = gameplayController.takeIssuedCommands();
    expect(commands).toHaveLength(2);
    game.tickUpdate();

    const repeated = executeAgentTool(gameplayController, "start_harvest_loop", {
      unitIds: [workers[0].id],
    }).result;
    expect(repeated).toMatchObject({
      ok: true,
      results: [expect.objectContaining({ status: "already_active", phase: expect.any(String) })],
    });
    expect(gameplayController.takeIssuedCommands()).toEqual([]);
    game.stop();
  });

  it("returns an immediate validation error for barracks positions adjacent to HQ", () => {
    const game = new Game();
    const gameplayController = new GameplayController(game, "player_2");
    const worker = game.getState().players[1].units.find((unit) => unit.type === UNIT_TYPES.WORKER)!;

    const result = gameplayController.buildStructure(worker.id, "barracks", {
      x: DEFAULT_MAP_LAYOUT.player2Hq.x,
      y: DEFAULT_MAP_LAYOUT.player2Hq.y - 1,
    });

    expect(result.result).toMatchObject({
      ok: false,
      error: "invalid_build_position",
      suggestedPlacements: expect.any(Array),
    });
    expect((result.result as { hint: string }).hint).toContain("building footprint");
    expect(gameplayController.takeIssuedCommands()).toHaveLength(0);
  });

  it("does not search suggested placements for a valid explicit build position", () => {
    const game = new Game();
    const gameplayController = new GameplayController(game, "player_1");
    const worker = game.getState().players[0].units.find((unit) => unit.type === UNIT_TYPES.WORKER)!;
    const placementSpy = vi.spyOn(
      gameplayController as unknown as { getSuggestedBuildSites: (...args: unknown[]) => unknown },
      "getSuggestedBuildSites",
    );

    const result = gameplayController.buildStructure(
      worker.id,
      BUILDING_TYPES.BARRACKS,
      player1BuildSite,
    );

    expect((result.result as { ok: boolean }).ok).toBe(true);
    expect(placementSpy).not.toHaveBeenCalled();
  });

  it("rejects old non-call orchestrate_plan steps instead of registering a stuck plan", () => {
    const game = new Game();
    const gameplayController = new GameplayController(game, "player_2");
    const worker = game.getState().players[1].units.find((unit) => unit.type === UNIT_TYPES.WORKER)!;

    const result = gameplayController.orchestratePlan({
      unitIds: [worker.id],
      steps: [{ type: "move_to_resource" }] as any,
    });

    expect(result.result).toMatchObject({
      ok: false,
      error: "invalid_plan",
    });
    expect((result.result as { hint: string }).hint).toContain("{ call: existing_tool");
    expect(gameplayController.getActivePlans()).toHaveLength(0);
  });

  it("registers call-step plans that attack-move near a target and then attack it", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const soldier = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 5, 10, "player_1");
    const enemyHQ = game.getState().players[1].buildings.find((building) => building.type === "hq")!;

    const result = gameplayController.orchestratePlan({
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
    expect(gameplayController.handleCommittedTick()).toEqual([
      expect.objectContaining({
        type: "attack_move",
        unitId: soldier.id,
        position: { x: enemyHQ.x, y: enemyHQ.y },
      }),
    ]);

    soldier.x = enemyHQ.x - 1;
    soldier.y = enemyHQ.y;
    expect(gameplayController.handleCommittedTick()).toEqual([
      expect.objectContaining({
        type: "attack",
        unitId: soldier.id,
        targetId: enemyHQ.id,
      }),
    ]);
    game.stop();
  });

  it.skip("runs mixed-scope opening plans for harvesting, building, and production", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const [worker1, worker2] = game.getState().players[0].units.filter((unit) => unit.type === UNIT_TYPES.WORKER);

    const result = gameplayController.orchestratePlan({
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
          call: "spawn_unit" as any,
          args: { buildingId: "$barracks", unitType: "rifleman" },
          scope: "global",
          when: { condition: "production_queue_empty", buildingType: "barracks" },
          until: { condition: "unit_count_at_least", unitType: "rifleman", count: 1 },
          retry: true,
        },
      ],
    });

    expect(result.result).toMatchObject({ ok: true });
    expect(gameplayController.handleCommittedTick()).toEqual([
      expect.objectContaining({ type: "harvest_loop", unitId: worker1.id }),
      expect.objectContaining({ type: "harvest_loop", unitId: worker2.id }),
    ]);

    moveWorkerAdjacentToBuildSite(game, worker1.id, BUILDING_TYPES.BARRACKS);
    const buildCommands = gameplayController.handleCommittedTick();
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
    advanceTicks(game, getBuildingConstructionTicks(BUILDING_TYPES.BARRACKS) - 1);

    expect(gameplayController.handleCommittedTick()).toEqual([
      expect.objectContaining({
        type: "spawn",
        unitType: "rifleman",
      }),
    ]);
    game.stop();
  });

  it("immediately reselects a build site when a unit occupies the planned footprint", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const [worker, passerby] = game.getState().players[0].units.filter((unit) => unit.type === UNIT_TYPES.WORKER);
    const result = gameplayController.buildStructure(worker.id, BUILDING_TYPES.BARRACKS).result as {
      ok: boolean;
      position: { x: number; y: number };
    };
    expect(result.ok).toBe(true);

    const runtimePasserby = game.getUnitManager().getUnit(passerby.id)!;
    runtimePasserby.x = result.position.x;
    runtimePasserby.y = result.position.y;

    const [replannedCommand] = gameplayController.handleCommittedTick();
    expect(replannedCommand).toMatchObject({ unitId: worker.id });
    expect(replannedCommand.position).not.toEqual(result.position);
    expect(gameplayController.getActivePlans()[0]?.currentStep?.args).not.toMatchObject(result.position);
    game.stop();
  });

  it("reserves auto-selected build plans and keeps production buildings in an HQ-side lane", () => {
    const game = new Game();
    const gameplayController = new GameplayController(game, "player_1");
    const [worker1, worker2] = game.getState().players[0].units.filter((unit) => unit.type === UNIT_TYPES.WORKER);

    const first = gameplayController.buildStructure(worker1.id, BUILDING_TYPES.BARRACKS).result as {
      ok: boolean;
      position: { x: number; y: number };
    };
    const second = gameplayController.buildStructure(worker2.id, BUILDING_TYPES.BARRACKS).result as {
      ok: boolean;
      position: { x: number; y: number };
    };

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.position).not.toEqual(second.position);
    expect(first.position.y).toBe(DEFAULT_MAP_LAYOUT.player1Hq.y);
    expect(second.position.y).toBe(DEFAULT_MAP_LAYOUT.player1Hq.y);
    expect(Math.abs(first.position.x - second.position.x)).toBeGreaterThanOrEqual(6);
  });

  it("sets and clears rally points for production-building arrays", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const hq = game.getState().players[0].buildings.find((building) => building.type === BUILDING_TYPES.HQ)!;
    const rallyPoint = { x: hq.x + 12, y: hq.y };

    expect(executeAgentTool(gameplayController, "set_rally_point", {
      buildingIds: [hq.id],
      ...rallyPoint,
    }).result).toMatchObject({ ok: true });
    game.tickUpdate();
    expect(game.getBuildingManager().getBuilding(hq.id)?.rallyPoint).toEqual({ ...rallyPoint, mode: "move" });

    expect(executeAgentTool(gameplayController, "set_rally_point", {
      buildingIds: [hq.id],
      ...rallyPoint,
      mode: "attack_move",
    }).result).toMatchObject({ ok: false, error: "unsupported_rally_mode" });

    expect(executeAgentTool(gameplayController, "set_rally_point", {
      buildingIds: [hq.id],
    }).result).toMatchObject({ ok: true });
    game.tickUpdate();
    expect(game.getBuildingManager().getBuilding(hq.id)?.rallyPoint).toBeUndefined();
    game.stop();
  });

  it("preserves attack-move rally mode through the game command queue", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const barracks = game.getBuildingManager().createBuilding(
      BUILDING_TYPES.BARRACKS,
      player1BuildSite.x,
      player1BuildSite.y,
      "player_1",
    );
    const rallyPoint = { x: player1BuildSite.x + 12, y: player1BuildSite.y };

    expect(executeAgentTool(gameplayController, "set_rally_point", {
      buildingIds: [barracks.id],
      ...rallyPoint,
      mode: "attack_move",
    }).result).toMatchObject({ ok: true });

    game.tickUpdate();

    expect(game.getBuildingManager().getBuilding(barracks.id)?.rallyPoint).toEqual({
      ...rallyPoint,
      mode: "attack_move",
    });
    game.stop();
  });

  it("does not resubmit build at the construction-complete boundary", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const worker = game.getState().players[0].units.find((unit) => unit.type === UNIT_TYPES.WORKER)!;
    moveWorkerAdjacentToBuildSite(game, worker.id, BUILDING_TYPES.BARRACKS);

    expect(gameplayController.buildStructure(
      worker.id,
      BUILDING_TYPES.BARRACKS,
      player1BuildSite,
    ).result).toMatchObject({ ok: true, planId: expect.any(String) });

    let buildCommandCount = 0;
    for (let tick = 0; tick <= getBuildingConstructionTicks(BUILDING_TYPES.BARRACKS) + 2; tick++) {
      const commands = gameplayController.handleCommittedTick();
      buildCommandCount += commands.filter((command) => command.type === "build").length;
      commands.forEach((command) => game.queueCommand(command));
      game.tickUpdate();
    }

    expect(buildCommandCount).toBe(1);
    expect(gameplayController.getActivePlans()).toEqual([]);
    game.stop();
  });

  it.skip("keeps an inferred production plan filling an empty queue every committed tick", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const barracks = game.getBuildingManager().createBuilding(
      BUILDING_TYPES.BARRACKS,
      player1BuildSite.x,
      player1BuildSite.y,
      "player_1",
    );

    expect(gameplayController.orchestratePlan({
      unitIds: [barracks.id],
      loop: -1,
      steps: [{
        call: "spawn_unit" as any,
        args: { buildingId: barracks.id, unitType: UNIT_TYPES.RIFLEMAN },
        scope: "global",
        until: { condition: "production_queue_empty" },
        retry: true,
      }],
    }).result).toMatchObject({ ok: true, unitIds: [barracks.id] });

    const firstCommands = gameplayController.handleCommittedTick();
    expect(firstCommands).toEqual([
      expect.objectContaining({ type: "spawn", buildingId: barracks.id, unitType: UNIT_TYPES.RIFLEMAN }),
    ]);
    firstCommands.forEach((command) => game.queueCommand(command));
    game.tickUpdate();

    let secondSpawnSeen = false;
    for (let tick = 0; tick <= getUnitProductionTicks(UNIT_TYPES.RIFLEMAN) + 1; tick++) {
      const commands = gameplayController.handleCommittedTick();
      if (commands.some((command) => command.type === "spawn" && command.buildingId === barracks.id)) {
        secondSpawnSeen = true;
        break;
      }
      game.tickUpdate();
    }
    expect(secondSpawnSeen).toBe(true);
    game.stop();
  });

  it.skip("load-balances an unanchored production placeholder across ready buildings", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const firstBarracks = game.getBuildingManager().createBuilding(
      BUILDING_TYPES.BARRACKS,
      player1BuildSite.x,
      player1BuildSite.y - 5,
      "player_1",
    );
    const secondBarracks = game.getBuildingManager().createBuilding(
      BUILDING_TYPES.BARRACKS,
      player1BuildSite.x,
      player1BuildSite.y + 5,
      "player_1",
    );

    expect(gameplayController.orchestratePlan({
      loop: -1,
      steps: [{
        call: "spawn_unit" as any,
        args: { buildingId: "$barracks", unitType: UNIT_TYPES.RIFLEMAN },
        scope: "global",
        until: { condition: "production_queue_empty" },
        retry: true,
      }],
    }).result).toMatchObject({ ok: true });

    const firstCommands = gameplayController.handleCommittedTick();
    expect(firstCommands).toEqual([
      expect.objectContaining({ type: "spawn", buildingId: firstBarracks.id }),
    ]);
    firstCommands.forEach((command) => game.queueCommand(command));
    game.tickUpdate();

    expect(gameplayController.handleCommittedTick()).toEqual([
      expect.objectContaining({ type: "spawn", buildingId: secondBarracks.id }),
    ]);
    game.stop();
  });

  it("advances a global unit step when its named worker reaches the requested position", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const worker = game.getState().players[0].units.find((unit) => unit.type === UNIT_TYPES.WORKER)!;
    const footprint = getBuildingFootprint(BUILDING_TYPES.BARRACKS);
    const workerSite = {
      x: player1BuildSite.x - Math.floor(footprint.width / 2) - 1,
      y: player1BuildSite.y,
    };

    expect(gameplayController.orchestratePlan({
      unitIds: [worker.id],
      steps: [
        {
          call: "move_unit",
          args: { unitId: worker.id, ...workerSite },
          scope: "global",
          until: { condition: "near_position", ...workerSite, distance: 1 },
          retry: true,
        },
        {
          call: "build_structure",
          args: { unitId: worker.id, buildingType: BUILDING_TYPES.BARRACKS, ...player1BuildSite },
          scope: "global",
          until: { condition: "building_exists", buildingType: BUILDING_TYPES.BARRACKS },
          retry: true,
        },
      ],
    }).result).toMatchObject({ ok: true });

    expect(gameplayController.handleCommittedTick()).toEqual([
      expect.objectContaining({ type: "move", unitId: worker.id, position: workerSite }),
    ]);
    const runtimeWorker = game.getUnitManager().getUnit(worker.id)!;
    runtimeWorker.x = workerSite.x;
    runtimeWorker.y = workerSite.y;

    expect(gameplayController.handleCommittedTick()).toEqual([
      expect.objectContaining({
        type: "build",
        unitId: worker.id,
        buildingType: BUILDING_TYPES.BARRACKS,
        position: player1BuildSite,
      }),
    ]);
    game.stop();
  });

  it("releases every ready per-unit plan command on the committed tick", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const workers = [
      ...game.getState().players[0].units.filter((unit) => unit.type === UNIT_TYPES.WORKER),
      game.getUnitManager().createUnit(UNIT_TYPES.WORKER, 8, 8, "player_1"),
      game.getUnitManager().createUnit(UNIT_TYPES.WORKER, 9, 8, "player_1"),
    ].slice(0, 4);

    expect(gameplayController.orchestratePlan({
      unitIds: workers.map((worker) => worker.id),
      steps: [
        { call: "start_harvest_loop", args: { unitId: "$unitId" }, scope: "per_unit" },
      ],
    }).result).toMatchObject({ ok: true });

    const firstTick = gameplayController.handleCommittedTick();
    expect(firstTick).toHaveLength(4);
    expect(firstTick.every((command) => command.type === "harvest_loop")).toBe(true);
    expect(new Set(firstTick.map((command) => command.unitId))).toEqual(
      new Set(workers.map((worker) => worker.id)),
    );
    game.stop();
  });

  it.skip("supports war factory and light tank production in orchestration plans", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const [worker1, worker2] = game.getState().players[0].units.filter((unit) => unit.type === UNIT_TYPES.WORKER);
    game.getBuildingManager().createBuilding(BUILDING_TYPES.BARRACKS, player1BuildSite.x, player1BuildSite.y, "player_1");
    const factorySite = { x: player1BuildSite.x + 8, y: player1BuildSite.y };
    moveWorkerAdjacentToBuildSite(game, worker1.id, BUILDING_TYPES.WAR_FACTORY, factorySite);

    const result = gameplayController.orchestratePlan({
      unitIds: [worker1.id, worker2.id],
      steps: [
        {
          call: "build_structure",
          args: { unitId: worker1.id, buildingType: "war_factory", x: factorySite.x, y: factorySite.y },
          scope: "global",
          when: { condition: "credits_at_least", amount: 220 },
          until: { condition: "building_exists", buildingType: "war_factory" },
          retry: true,
        },
        {
          call: "spawn_unit" as any,
          args: { buildingId: "$war_factory", unitType: "light_tank" },
          scope: "global",
          when: { condition: "production_queue_empty", buildingType: "war_factory" },
          until: { condition: "unit_count_at_least", unitType: "light_tank", count: 1 },
          retry: true,
        },
      ],
    });

    expect(result.result).toMatchObject({ ok: true });
    const buildCommands = gameplayController.handleCommittedTick();
    expect(buildCommands).toEqual([
      expect.objectContaining({
        type: "build",
        unitId: worker1.id,
        buildingType: "war_factory",
        position: factorySite,
      }),
    ]);
    for (const command of buildCommands) {
      game.queueCommand(command);
    }
    game.tickUpdate();
    advanceTicks(game, getBuildingConstructionTicks(BUILDING_TYPES.WAR_FACTORY) - 1);

    const runtimeWorker2 = game.getUnitManager().getUnit(worker2.id)!;
    runtimeWorker2.x = DEFAULT_MAP_LAYOUT.player1Hq.x + 1;
    runtimeWorker2.y = DEFAULT_MAP_LAYOUT.player1Hq.y;
    runtimeWorker2.carryingCredits = 100;
    game.tickUpdate();
    runtimeWorker2.carryingCredits = 20;
    game.tickUpdate();

    expect(gameplayController.handleCommittedTick()).toEqual([
      expect.objectContaining({
        type: "spawn",
        unitType: "light_tank",
      }),
    ]);
    game.stop();
  });

  it.skip("waits instead of queueing unaffordable production from orchestration plans", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
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

    const result = gameplayController.orchestratePlan({
      unitIds: [worker.id],
      steps: [
        {
          call: "spawn_unit" as any,
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
    expect(gameplayController.handleCommittedTick()).toEqual([]);
    expect(gameplayController.getActivePlans()).toEqual([
      expect.objectContaining({
        currentStep: expect.objectContaining({
          call: "spawn_unit",
          args: { buildingId: "$war_factory", unitType: "light_tank" },
        }),
        waiting: {
          code: "insufficient_credits",
          message: "Need 240 credits; 200 available.",
          details: { requiredCredits: 240, availableCredits: 200 },
        },
        lastAttempt: expect.objectContaining({
          call: "spawn_unit",
          status: "waiting",
          waiting: expect.objectContaining({ code: "insufficient_credits" }),
        }),
      }),
    ]);
    game.stop();
  });

  it.skip("does not flood a production queue while a retrying spawn plan waits for completed units", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const barracks = game.getBuildingManager().createBuilding(
      BUILDING_TYPES.BARRACKS,
      player1BuildSite.x,
      player1BuildSite.y,
      "player_1",
    );
    const worker = game.getState().players[0].units.find((unit) => unit.type === UNIT_TYPES.WORKER)!;

    expect(gameplayController.orchestratePlan({
      unitIds: [worker.id],
      steps: [{
        call: "spawn_unit" as any,
        args: { buildingId: barracks.id, unitType: UNIT_TYPES.RIFLEMAN },
        scope: "global",
        until: { condition: "unit_count_at_least", unitType: UNIT_TYPES.RIFLEMAN, count: 6 },
        retry: true,
      }],
    }).result).toMatchObject({ ok: true });

    const first = gameplayController.handleCommittedTick();
    expect(first).toHaveLength(1);
    game.queueCommand(first[0]);
    game.tickUpdate();
    expect(game.getBuildingManager().getBuilding(barracks.id)?.productionQueue).toHaveLength(1);
    expect(gameplayController.handleCommittedTick()).toEqual([]);
    game.stop();
  });

  it.skip("reserves same-tick credits across active orchestration plans", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
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

    gameplayController.orchestratePlan({
      unitIds: [worker1.id],
      steps: [
        {
          call: "spawn_unit" as any,
          args: { buildingId: "$war_factory", unitType: "light_tank" },
          scope: "global",
          when: { condition: "production_queue_empty", buildingType: "war_factory" },
          until: { condition: "unit_count_at_least", unitType: "light_tank", count: 1 },
          retry: true,
        },
      ],
    });
    gameplayController.orchestratePlan({
      unitIds: [worker2.id],
      steps: [
        {
          call: "spawn_unit" as any,
          args: { buildingId: "$barracks", unitType: "rocket_soldier" },
          scope: "global",
          when: { condition: "production_queue_empty", buildingType: "barracks" },
          until: { condition: "unit_count_at_least", unitType: "rocket_soldier", count: 1 },
          retry: true,
        },
      ],
    });

    expect(game.getState().players[0].resources.credits).toBe(300);
    expect(gameplayController.handleCommittedTick()).toEqual([
      expect.objectContaining({
        type: "spawn",
        unitType: "light_tank",
      }),
    ]);
    expect(gameplayController.getActivePlans()).toEqual([
      expect.objectContaining({
        lastAttempt: expect.objectContaining({
          call: "spawn_unit",
          status: "command_created",
          commandCount: 1,
        }),
      }),
      expect.objectContaining({
        waiting: {
          code: "insufficient_credits",
          message: "Need 110 credits; 60 available.",
          details: { requiredCredits: 110, availableCredits: 60 },
        },
        lastAttempt: expect.objectContaining({
          call: "spawn_unit",
          status: "waiting",
          waiting: expect.objectContaining({ code: "insufficient_credits" }),
        }),
      }),
    ]);
    game.stop();
  });

  it("summarizes objective tech status without prescribing counters", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");

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

    const result = gameplayController.getMyState().result as {
      techStatus: {
        own: Record<string, number>;
        enemy: Record<string, unknown>;
      };
      buildOptions: Array<{ buildingType: string; prerequisiteMet: boolean }>;
    };

    expect(result.techStatus.own.barracks).toBe(1);
    expect(result.techStatus.enemy).toMatchObject({ hasWarFactory: true, lightTanks: 1 });
    expect(result.techStatus).not.toHaveProperty("recommendedStructures");
    expect(result.techStatus).not.toHaveProperty("recommendedProduction");
    expect(result.buildOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ buildingType: "war_factory", prerequisiteMet: true }),
    ]));
    game.stop();
  });

  it("auto-selects a legal building center and turns a distant build into a durable plan", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const worker = game.getState().players[0].units.find((unit) => unit.type === UNIT_TYPES.WORKER)!;
    expect(
      getBuildingFootprint(BUILDING_TYPES.BARRACKS).width,
    ).toBeGreaterThan(1);

    const result = gameplayController.buildStructure(worker.id, BUILDING_TYPES.BARRACKS).result as {
      ok: boolean;
      planId: string;
      position: { x: number; y: number };
      workerPosition: { x: number; y: number };
    };
    expect(result).toMatchObject({
      ok: true,
      planId: expect.any(String),
      position: { x: expect.any(Number), y: expect.any(Number) },
      workerPosition: { x: expect.any(Number), y: expect.any(Number) },
    });
    expect(gameplayController.getActivePlans()).toEqual([
      expect.objectContaining({
        steps: expect.arrayContaining([
          expect.objectContaining({
            call: "build_structure",
            until: {
              condition: "building_exists",
              buildingType: BUILDING_TYPES.BARRACKS,
            },
          }),
        ]),
      }),
    ]);
    game.stop();
  });

  it("auto-places refineries for route savings and explains the nearby deposits", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const worker = game.getState().players[0].units.find((unit) => unit.type === UNIT_TYPES.WORKER)!;

    const result = gameplayController.buildStructure(worker.id, BUILDING_TYPES.REFINERY).result as {
      ok: boolean;
      position: { x: number; y: number };
      estimatedRouteSaving: number;
      nearbyResources: Array<{ x: number; y: number; newDeliveryDistance: number }>;
    };

    expect(result).toMatchObject({
      ok: true,
      estimatedRouteSaving: expect.any(Number),
      nearbyResources: expect.arrayContaining([
        expect.objectContaining({ x: expect.any(Number), y: expect.any(Number), newDeliveryDistance: expect.any(Number) }),
      ]),
    });
    expect(result.estimatedRouteSaving).toBeGreaterThan(0);
    expect(Math.max(
      Math.abs(result.position.x - DEFAULT_MAP_LAYOUT.player1Hq.x),
      Math.abs(result.position.y - DEFAULT_MAP_LAYOUT.player1Hq.y),
    )).toBeGreaterThan(10);
    game.stop();
  });

  it("explains the exact prerequisite that is keeping a plan step waiting", () => {
    const game = new Game();
    const gameplayController = new GameplayController(game, "player_1");
    const worker = game.getState().players[0].units.find((unit) => unit.type === UNIT_TYPES.WORKER)!;

    gameplayController.orchestratePlan({
      unitIds: [worker.id],
      steps: [{
        call: "build_structure",
        args: {
          unitId: worker.id,
          buildingType: BUILDING_TYPES.WAR_FACTORY,
          x: player1BuildSite.x,
          y: player1BuildSite.y,
        },
        scope: "global",
        retry: true,
      }],
    });

    expect(gameplayController.handleCommittedTick()).toEqual([]);
    expect(gameplayController.getActivePlans()).toEqual([
      expect.objectContaining({
        waiting: expect.objectContaining({
          code: "missing_prerequisite",
          details: expect.objectContaining({
            buildingType: BUILDING_TYPES.WAR_FACTORY,
            missingPrerequisites: [BUILDING_TYPES.BARRACKS],
          }),
        }),
        waitingReason: expect.stringContaining("barracks"),
      }),
    ]);
  });

  it("reports enemy composition without embedding a production policy", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    game.getBuildingManager().createBuilding(
      BUILDING_TYPES.BARRACKS,
      player1BuildSite.x,
      player1BuildSite.y,
      "player_1",
    );
    game.getBuildingManager().createBuilding(
      BUILDING_TYPES.WAR_FACTORY,
      player1BuildSite.x + 8,
      player1BuildSite.y,
      "player_1",
    );
    for (let index = 0; index < 3; index++) {
      game.getUnitManager().createUnit(
        UNIT_TYPES.ROCKET_SOLDIER,
        DEFAULT_MAP_LAYOUT.player2Hq.x - 8 - index,
        DEFAULT_MAP_LAYOUT.player2Hq.y,
        "player_2",
      );
    }

    const state = gameplayController.getMyState().result as {
      techStatus: {
        enemy: { rocketSoldiers: number };
      };
    };
    expect(state.techStatus.enemy.rocketSoldiers).toBe(3);
    expect(state.techStatus).not.toHaveProperty("productionWarnings");
    expect(state.techStatus).not.toHaveProperty("recommendedProduction");
    game.stop();
  });

  it("summarizes economy status and resource assignments from get_my_state", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const workers = game.getState().players[0].units.filter((unit) => unit.type === UNIT_TYPES.WORKER);

    gameplayController.startHarvestLoop(workers[0].id);
    gameplayController.startHarvestLoop(workers[1].id);
    game.processCommands();

    const result = gameplayController.getMyState().result as {
      economyStatus: {
        workers: number;
        activeHarvesters: number;
        idleWorkers: number;
        carryingCredits: number;
        resourceAssignments: Array<Record<string, unknown>>;
      };
    };

    expect(result.economyStatus).toMatchObject({
      workers: 4,
      activeHarvesters: 4,
      idleWorkers: 0,
      carryingCredits: 0,
    });
    const assignedResources = result.economyStatus.resourceAssignments.filter(
      (assignment) => Number(assignment.assignedHarvesters) > 0,
    );
    expect(assignedResources.length).toBeGreaterThanOrEqual(2);
    expect(assignedResources.reduce((sum, assignment) => sum + Number(assignment.assignedHarvesters), 0)).toBe(4);
    expect(assignedResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ x: expect.any(Number), y: expect.any(Number), assignedHarvesters: expect.any(Number) }),
      ])
    );
    for (const assignment of assignedResources) {
      expect(DEFAULT_MAP_LAYOUT.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ x: assignment.x, y: assignment.y }),
        ]),
      );
    }
    expect(result.economyStatus).not.toHaveProperty("recommendations");
    game.stop();
  });

  it.skip("uses enemy tech conditions to trigger counter-production plans", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const worker = game.getState().players[0].units.find((unit) => unit.type === UNIT_TYPES.WORKER)!;

    game.getBuildingManager().createBuilding(BUILDING_TYPES.BARRACKS, player1BuildSite.x, player1BuildSite.y, "player_1");
    game.getUnitManager().createUnit(
      UNIT_TYPES.LIGHT_TANK,
      DEFAULT_MAP_LAYOUT.player1Hq.x + 6,
      DEFAULT_MAP_LAYOUT.player1Hq.y,
      "player_2"
    );

    const result = gameplayController.orchestratePlan({
      unitIds: [worker.id],
      steps: [
        {
          call: "spawn_unit" as any,
          args: { buildingId: "$barracks", unitType: "rocket_soldier" },
          scope: "global",
          when: { condition: "enemy_unit_count_at_least", unitType: "light_tank", count: 1 },
          until: { condition: "unit_count_at_least", unitType: "rocket_soldier", count: 1 },
          retry: true,
        },
      ],
    });

    expect(result.result).toMatchObject({ ok: true });
    expect(gameplayController.handleCommittedTick()).toEqual([
      expect.objectContaining({
        type: "spawn",
        unitType: "rocket_soldier",
      }),
    ]);
    game.stop();
  });

  it("reports a harvest loop that makes no movement or credit progress", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const worker = game.getState().players[0].units.find((unit) => unit.type === UNIT_TYPES.WORKER)!;
    const origin = { x: worker.x, y: worker.y };

    gameplayController.startHarvestLoop(worker.id);
    game.processCommands();
    for (let tick = 0; tick < 14; tick++) {
      game.tickUpdate();
      const runtimeWorker = game.getUnitManager().getUnit(worker.id)!;
      runtimeWorker.x = origin.x;
      runtimeWorker.y = origin.y;
      runtimeWorker.carryingCredits = 0;
      gameplayController.handleCommittedTick();
    }

    const result = gameplayController.getMyState().result as {
      economyStatus: {
        activeHarvesters: number;
        stalledHarvesters: Array<{ unitId: string; reason: string }>;
      };
    };
    expect(result.economyStatus.activeHarvesters).toBe(3);
    expect(result.economyStatus.stalledHarvesters).toContainEqual({
      unitId: worker.id,
      reason: "path_blocked",
      carryingCredits: 0,
    });
    game.stop();
  });

  it.skip("pins a placeholder production plan to its friendly building anchor", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const firstBarracks = game.getBuildingManager().createBuilding(
      BUILDING_TYPES.BARRACKS,
      player1BuildSite.x,
      player1BuildSite.y - 5,
      "player_1",
    );
    const secondBarracks = game.getBuildingManager().createBuilding(
      BUILDING_TYPES.BARRACKS,
      player1BuildSite.x,
      player1BuildSite.y + 5,
      "player_1",
    );
    const productionStep = {
      call: "spawn_unit" as any,
      args: { buildingId: "$barracks", unitType: UNIT_TYPES.RIFLEMAN },
      scope: "global" as const,
      until: { condition: "production_queue_empty" as const },
      retry: true,
    };

    gameplayController.orchestratePlan({
      unitIds: [firstBarracks.id],
      loop: -1,
      steps: [productionStep],
    });
    gameplayController.orchestratePlan({
      unitIds: [secondBarracks.id],
      loop: -1,
      steps: [productionStep],
    });

    expect(gameplayController.getActivePlans()).toEqual([
      expect.objectContaining({
        unitIds: [firstBarracks.id],
        currentStep: expect.objectContaining({
          args: expect.objectContaining({ buildingId: firstBarracks.id }),
        }),
      }),
      expect.objectContaining({
        unitIds: [secondBarracks.id],
        currentStep: expect.objectContaining({
          args: expect.objectContaining({ buildingId: secondBarracks.id }),
        }),
      }),
    ]);
    expect(gameplayController.handleCommittedTick()).toEqual([
      expect.objectContaining({ type: "spawn", buildingId: firstBarracks.id }),
      expect.objectContaining({ type: "spawn", buildingId: secondBarracks.id }),
    ]);
    game.stop();
  });

  it("rejects unsupported call-step plan tools", () => {
    const gameplayController = new GameplayController(new Game(), "player_2");

    const result = gameplayController.orchestratePlan({
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
    expect(gameplayController.getActivePlans()).toHaveLength(0);
  });

  it("rejects plans that target buildings instead of units", () => {
    const gameplayController = new GameplayController(new Game(), "player_2");

    const result = gameplayController.orchestratePlan({
      unitIds: ["building_2"],
      steps: [{ call: "hold_unit", args: { unitId: "$unitId" } }],
    });

    expect(result.result).toMatchObject({
      ok: false,
      error: "invalid_plan",
    });
    expect((result.result as { hint: string }).hint).toContain("friendly unit ID");
    expect(gameplayController.getActivePlans()).toHaveLength(0);
  });

  it("returns a slim battlefield view from get_map_state by default", () => {
    const gameplayController = new GameplayController(new Game(), "player_2");

    const result = gameplayController.getMapState();
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
          phase: "idle",
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
    const gameplayController = new GameplayController(game, "player_1");
    const tank = game.getUnitManager().createUnit(UNIT_TYPES.LIGHT_TANK, 30, 48, "player_1");
    const rocket = game.getUnitManager().createUnit(UNIT_TYPES.ROCKET_SOLDIER, 31, 49, "player_1");

    gameplayController.holdUnit(tank.id);
    gameplayController.holdUnit(rocket.id);
    game.processCommands();

    const result = gameplayController.getMyUnits().result as {
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
          intent: "harvest_loop",
          count: 4,
        }),
      ])
    );
    expect(result.units.find((unit) => unit.id === tank.id)).toMatchObject({ intent: { type: "hold" } });
    game.stop();
  });

  it("reveals enemy units and buildings across the full battlefield", () => {
    const game = new Game();
    const gameplayController = new GameplayController(game, "player_1");
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

    const mapState = gameplayController.getMapState().result as {
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
    const gameplayController = new GameplayController(game, "player_1");
    const soldier = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const lightTank = game.getUnitManager().createUnit(UNIT_TYPES.LIGHT_TANK, 5, 6, "player_1");

    const soldierResult = gameplayController.attackMoveUnit(soldier.id, DEFAULT_MAP_LAYOUT.player2Hq);
    const tankResult = gameplayController.attackMoveUnit(lightTank.id, DEFAULT_MAP_LAYOUT.player2Hq);

    expect(soldierResult.result).toMatchObject({ ok: true });
    expect(tankResult.result).toMatchObject({ ok: true });
    expect(gameplayController.takeIssuedCommands()).toEqual([
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
        targetPriority: ["heavy_tank", "light_tank", "flame_tank", "rocket_soldier", "rifleman", "soldier", "anti_tank_turret", "war_factory", "barracks", "hq", "refinery"],
      }),
    ]);
    game.stop();
  });

  it("queues the same attack-move for a 100-unit box selection", () => {
    const game = new Game();
    const gameplayController = new GameplayController(game, "player_1");
    const unitIds = Array.from({ length: 100 }, (_, index) =>
      game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 20 + (index % 10), 12 + Math.floor(index / 10), "player_1").id
    );

    const result = executeAgentTool(gameplayController, "attack_move_unit", { unitIds, x: 108, y: 48 });
    const payload = result.result as {
      ok: boolean;
      results: Array<{ unitId: string; ok: boolean }>;
    };

    expect(payload.ok).toBe(true);
    expect(payload.results).toHaveLength(100);
    const commands = gameplayController.takeIssuedCommands();
    expect(commands).toHaveLength(100);
    expect(new Set(commands.map((command) => command.unitId))).toEqual(new Set(unitIds));
  });

  it("summarizes army composition without recommending a formation", () => {
    const game = new Game();
    const gameplayController = new GameplayController(game, "player_1");
    game.getUnitManager().createUnit(UNIT_TYPES.LIGHT_TANK, 10, 10, "player_1");
    game.getUnitManager().createUnit(UNIT_TYPES.LIGHT_TANK, 11, 10, "player_1");
    game.getUnitManager().createUnit(UNIT_TYPES.LIGHT_TANK, 12, 10, "player_1");
    game.getUnitManager().createUnit(UNIT_TYPES.LIGHT_TANK, 13, 10, "player_1");
    game.getUnitManager().createUnit(UNIT_TYPES.ROCKET_SOLDIER, 20, 10, "player_2");

    const summary = gameplayController.getArmySummary().result as {
      myCounts: Record<string, number>;
      enemyCounts: Record<string, number>;
      largestGroupUnitIds: string[];
    };

    expect(summary.myCounts.light_tank).toBe(4);
    expect(summary.enemyCounts.rocket_soldier).toBe(1);
    expect(summary.largestGroupUnitIds).toHaveLength(4);
    expect(summary).not.toHaveProperty("recommendedFormation");
    expect(summary).not.toHaveProperty("recommendations");
  });

  it("reports a nearby six-unit group without prescribing its target", () => {
    const game = new Game();
    const gameplayController = new GameplayController(game, "player_1");
    for (let index = 0; index < 6; index++) {
      game.getUnitManager().createUnit(UNIT_TYPES.RIFLEMAN, 10 + index, 10, "player_1");
    }
    const summary = gameplayController.getArmySummary().result as {
      groupedCombatUnits: number;
      largestGroupUnitIds: string[];
    };
    expect(summary.groupedCombatUnits).toBe(6);
    expect(summary.largestGroupUnitIds).toHaveLength(6);
    expect(summary).not.toHaveProperty("recommendations");
  });

  it("reports that six units spread across the map are not one nearby group", () => {
    const game = new Game();
    const gameplayController = new GameplayController(game, "player_1");
    for (let index = 0; index < 6; index++) {
      game.getUnitManager().createUnit(UNIT_TYPES.RIFLEMAN, 10 + index * 20, 10, "player_1");
    }

    const summary = gameplayController.getArmySummary().result as {
      groupedCombatUnits: number;
      largestGroupUnitIds: string[];
    };
    expect(summary.groupedCombatUnits).toBe(1);
    expect(summary.largestGroupUnitIds).toHaveLength(1);
    expect(summary).not.toHaveProperty("assemblyPoint");
    expect(summary).not.toHaveProperty("recommendations");
  });

  it("queues high-level attack as movement until the target is in range", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const attacker = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const target = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 8, 5, "player_2");

    gameplayController.getMapState();
    const result = gameplayController.attackTarget(attacker.id, target.id);

    expect(result.result).toMatchObject({ ok: true, mode: "move_to_target" });
    expect(gameplayController.takeIssuedCommands()).toEqual([
      expect.objectContaining({
        type: "move",
        unitId: attacker.id,
        position: { x: 8, y: 5 },
      }),
    ]);

    attacker.x = 7;
    attacker.y = 5;
    expect(gameplayController.handleCommittedTick()).toEqual([
      expect.objectContaining({
        type: "attack",
        unitId: attacker.id,
        targetId: target.id,
      }),
    ]);
    game.stop();
  });

  it("retargets a nearby enemy when a focused target dies during pursuit", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const attacker = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const focused = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 10, 5, "player_2");
    const fallback = game.getUnitManager().createUnit(UNIT_TYPES.ROCKET_SOLDIER, 7, 5, "player_2");

    gameplayController.attackTarget(attacker.id, focused.id);
    gameplayController.takeIssuedCommands();
    game.tickUpdate();
    game.getUnitManager().removeUnit(focused.id);

    expect(gameplayController.handleCommittedTick()).toEqual([
      expect.objectContaining({ unitId: attacker.id, type: "attack", targetId: fallback.id }),
    ]);
    game.stop();
  });

  it("retargets a nearby enemy when the requested target dies before the first attack call executes", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const attacker = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const focused = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 8, 5, "player_2");
    const fallback = game.getUnitManager().createUnit(UNIT_TYPES.ROCKET_SOLDIER, 6, 5, "player_2");
    gameplayController.getMapState();
    game.getUnitManager().removeUnit(focused.id);

    const result = gameplayController.attackTarget(attacker.id, focused.id);

    expect(result.result).toMatchObject({
      ok: true,
      targetId: fallback.id,
      retargetedFrom: focused.id,
    });
    expect(gameplayController.takeIssuedCommands()).toEqual([
      expect.objectContaining({ type: "attack", unitId: attacker.id, targetId: fallback.id }),
    ]);
    game.stop();
  });

  it("cancels stale pursuit movement when a focused target dies with no nearby replacement", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const attacker = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const focused = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 20, 5, "player_2");

    gameplayController.attackTarget(attacker.id, focused.id);
    gameplayController.takeIssuedCommands();
    game.tickUpdate();
    game.getUnitManager().removeUnit(focused.id);

    expect(gameplayController.handleCommittedTick()).toEqual([
      expect.objectContaining({ unitId: attacker.id, type: "hold" }),
    ]);
    game.stop();
  });

  it("measures building attack range from the footprint instead of its center", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const enemyHq = game.getBuildingManager().getBuildingsByPlayer("player_2")
      .find((building) => building.type === BUILDING_TYPES.HQ)!;
    const footprint = getBuildingFootprint(BUILDING_TYPES.HQ);
    const attacker = game.getUnitManager().createUnit(
      UNIT_TYPES.SOLDIER,
      enemyHq.x - Math.floor(footprint.width / 2) - 1,
      enemyHq.y,
      "player_1",
    );

    expect(gameplayController.attackTarget(attacker.id, enemyHq.id).result).toMatchObject({
      ok: true,
      mode: "attack",
    });
    expect(gameplayController.takeIssuedCommands()).toEqual([
      expect.objectContaining({
        type: "attack",
        unitId: attacker.id,
        targetId: enemyHq.id,
      }),
    ]);
    game.stop();
  });

  it("moves a short-ranged flame tank toward an out-of-range building", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const enemyHq = game.getBuildingManager().getBuildingsByPlayer("player_2")
      .find((building) => building.type === BUILDING_TYPES.HQ)!;
    const footprint = getBuildingFootprint(BUILDING_TYPES.HQ);
    const flameTank = game.getUnitManager().createUnit(
      UNIT_TYPES.FLAME_TANK,
      enemyHq.x - Math.floor(footprint.width / 2) - 5,
      enemyHq.y,
      "player_1",
    );

    expect(gameplayController.attackTarget(flameTank.id, enemyHq.id).result).toMatchObject({
      ok: true,
      mode: "move_to_target",
    });
    const [move] = gameplayController.takeIssuedCommands();
    expect(move).toMatchObject({ type: "move", unitId: flameTank.id });
    game.stop();
  });

  it("does not replace an in-flight path every tick for a persistent attack order", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const attacker = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const target = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 20, 5, "player_2");
    target.x = 20.4;
    target.y = 5.6;

    gameplayController.getMapState();
    gameplayController.attackTarget(attacker.id, target.id);
    const [move] = gameplayController.takeIssuedCommands();
    expect(move.position).toEqual({ x: 20, y: 6 });
    game.queueCommand(move);
    game.tickUpdate();

    expect(game.getState().players[0].units.find((unit) => unit.id === attacker.id)).toMatchObject({
      state: "moving",
      intent: { type: "move" },
    });
    expect(gameplayController.handleCommittedTick()).toEqual([]);
    game.stop();
  });

  it("keeps a persistent attack order without reissuing it during weapon reload", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const attacker = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const target = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 6, 5, "player_2");

    expect(gameplayController.attackTarget(attacker.id, target.id).result).toMatchObject({
      ok: true,
      mode: "attack",
    });
    const [attack] = gameplayController.takeIssuedCommands();
    game.queueCommand(attack);
    game.tickUpdate();

    expect(attacker.nextAttackTick).toBeGreaterThan(game.getTick());
    expect(gameplayController.handleCommittedTick()).toEqual([]);

    while (attacker.nextAttackTick !== undefined && game.getTick() < attacker.nextAttackTick) {
      game.tickUpdate();
    }
    expect(gameplayController.handleCommittedTick()).toEqual([]);
    game.stop();
  });

  it("reports a dead target instead of using fog-of-war memory", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const attacker = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const target = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 8, 5, "player_2");

    gameplayController.getMapState();
    game.getUnitManager().removeUnit(target.id);

    const result = gameplayController.attackTarget(attacker.id, target.id);

    expect(result.result).toMatchObject({
      ok: false,
      error: "target_missing",
      targetId: target.id,
      targetStatus: "destroyed",
      availableEnemyTargetCount: expect.any(Number),
      availableEnemyTargets: expect.arrayContaining([
        expect.objectContaining({ type: BUILDING_TYPES.HQ }),
      ]),
    });
    expect(gameplayController.takeIssuedCommands()).toEqual([]);
    expect(gameplayController.handleCommittedTick()).toEqual([]);
    game.stop();
  });

  it("hoists shared recovery candidates out of batch unit results", () => {
    const game = new Game();
    const gameplayController = new GameplayController(game, "player_1");
    game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 20, 20, "player_1");

    const execution = executeAgentTool(gameplayController, "attack", {
      unitIds: ["missing_1", "missing_2"],
      targetId: "missing_target",
    });
    const result = execution.result as {
      availableAttackers: unknown[];
      results: Array<Record<string, unknown>>;
    };

    expect(result.availableAttackers.length).toBeGreaterThan(0);
    expect(result.results).toHaveLength(2);
    expect(result.results.every((item) => item.availableAttackers === undefined)).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      error: "invalid_unit",
      failedUnitIds: ["missing_1", "missing_2"],
      message: expect.stringContaining("2 of 2"),
    });
  });

  it("returns detailed map cells only when requested", () => {
    const gameplayController = new GameplayController(new Game(), "player_2");

    const result = gameplayController.getMapState({ includeCells: true });
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
    const gameplayController = new GameplayController(game, "player_1");
    const worker = game.getState().players[0].units.find((unit) => unit.type === "worker")!;

    const explicitResource = DEFAULT_MAP_LAYOUT.resources.at(-1)!;
    const result = gameplayController.startHarvestLoop(worker.id, explicitResource);

    expect(result.result).toMatchObject({ ok: true });
    expect(gameplayController.takeIssuedCommands()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "harvest_loop",
          unitId: worker.id,
          position: explicitResource,
        }),
      ])
    );

    game.tickUpdate();
    game.stop();

    const updatedWorker = game.getState().players[0].units.find((unit) => unit.id === worker.id)!;
    expect(updatedWorker.intent).toMatchObject({
      type: "harvest_loop",
      targetX: explicitResource.x,
      targetY: explicitResource.y,
    });
  });

  it("returns controllable units with the read tick", () => {
    const gameplayController = new GameplayController(new Game(), "player_1");

    const result = gameplayController.getMyUnits();
    const myUnits = result.result as { tick: number; units: Array<Record<string, unknown>> };

    expect(myUnits.tick).toBe(0);
    expect(myUnits.units).toHaveLength(4);
    expect(myUnits.units[0]).toHaveProperty("hasActivePlan", false);
  });

  it("shares one lightweight read state across same-tick read tools", () => {
    const game = new Game();
    const gameplayController = new GameplayController(game, "player_1");
    const readStateSpy = vi.spyOn(game, "getAgentReadState");
    const fullStateSpy = vi.spyOn(game, "getState");

    gameplayController.getMapState();
    gameplayController.getMyState();
    gameplayController.getMyUnits();
    gameplayController.getActivePlansTool();
    gameplayController.getRecentEvents();

    expect(readStateSpy).toHaveBeenCalledTimes(1);
    expect(fullStateSpy).not.toHaveBeenCalled();
  });

  it("does not search building placements while reading my state", () => {
    const game = new Game();
    const gameplayController = new GameplayController(game, "player_1");
    for (let index = 0; index < 8; index++) {
      game.getUnitManager().createUnit(
        UNIT_TYPES.WORKER,
        DEFAULT_MAP_LAYOUT.player1Hq.x + index,
        DEFAULT_MAP_LAYOUT.player1Hq.y - 6,
        "player_1",
      );
    }
    const placementSpy = vi.spyOn(
      gameplayController as unknown as { getSuggestedBuildSites: (...args: unknown[]) => unknown },
      "getSuggestedBuildSites",
    );

    const state = gameplayController.getMyState().result as { buildOptions: Array<Record<string, unknown>> };

    expect(placementSpy).not.toHaveBeenCalled();
    expect(state.buildOptions.every((option) => !("placementsByWorker" in option))).toBe(true);
  });

  it("invalidates the lightweight read cache on the next tick", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const readStateSpy = vi.spyOn(game, "getAgentReadState");

    gameplayController.getMyUnits();
    gameplayController.getMyState();
    expect(readStateSpy).toHaveBeenCalledTimes(1);

    game.tickUpdate();
    gameplayController.getMyUnits();
    game.stop();

    expect(readStateSpy).toHaveBeenCalledTimes(2);
  });
});
