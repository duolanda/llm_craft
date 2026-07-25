import { describe, expect, it, vi } from "vitest";
import { Game } from "../Game";
import { GameplayController } from "../controller/GameplayController";
import { executeAgentTool, getAgentToolDefinitions } from "../agent/AgentTools";
import { BUILDING_TYPES, DEFAULT_MAP_LAYOUT, TILE_TYPES, UNIT_TYPES, getBuildingConstructionTicks, getBuildingFootprint } from "@llmcraft/shared";

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
    for (const name of ["move_unit", "attack_move_unit", "attack"]) {
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

  it("adds a stale-read warning to actions when the last read is old", () => {
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

  it("runs mixed-scope opening plans for harvesting, building, and production", () => {
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
        unitType: "soldier",
      }),
    ]);
    game.stop();
  });

  it("fails a mission after the engine rejects a deterministic command instead of retrying forever", () => {
    const game = new Game();
    game.start();
    const gameplayController = new GameplayController(game, "player_1");
    const worker = game.getState().players[0].units.find((unit) => unit.type === UNIT_TYPES.WORKER)!;
    const invalidSite = { ...DEFAULT_MAP_LAYOUT.resources[0] };
    moveWorkerAdjacentToBuildSite(game, worker.id, BUILDING_TYPES.BARRACKS, invalidSite);

    expect(gameplayController.orchestratePlan({
      unitIds: [worker.id],
      steps: [{
        call: "build_structure",
        args: {
          unitId: worker.id,
          buildingType: BUILDING_TYPES.BARRACKS,
          ...invalidSite,
        },
        scope: "global",
        until: { condition: "building_exists", buildingType: BUILDING_TYPES.BARRACKS },
        retry: true,
      }],
    }).result).toMatchObject({ ok: true });

    const [command] = gameplayController.handleCommittedTick();
    expect(command).toMatchObject({ type: "build", provenance: { missionId: "plan_1" } });
    game.queueCommand(command);
    game.tickUpdate();

    expect(gameplayController.handleCommittedTick()).toEqual([]);
    expect(gameplayController.getActivePlans()).toEqual([]);
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

  it("supports war factory and light tank production in orchestration plans", () => {
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

  it("waits instead of queueing unaffordable production from orchestration plans", () => {
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

  it("does not flood a production queue while a retrying spawn plan waits for completed units", () => {
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
        call: "spawn_unit",
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

  it("reserves same-tick credits across active orchestration plans", () => {
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
          call: "spawn_unit",
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
            call: "move_unit",
            until: {
              condition: "worker_adjacent_to_build_footprint",
              buildingType: BUILDING_TYPES.BARRACKS,
              x: result.position.x,
              y: result.position.y,
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
          buildingType: BUILDING_TYPES.BARRACKS,
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
          code: "worker_not_adjacent",
          details: expect.objectContaining({
            workerId: worker.id,
            buildingPosition: player1BuildSite,
          }),
        }),
        waitingReason: expect.stringContaining("does not need replacement"),
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
      activeHarvesters: 2,
      idleWorkers: 2,
      carryingCredits: 0,
    });
    const assignedResources = result.economyStatus.resourceAssignments.filter(
      (assignment) => assignment.assignedHarvesters === 1,
    );
    expect(assignedResources).toHaveLength(2);
    expect(assignedResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ x: expect.any(Number), y: expect.any(Number), assignedHarvesters: 1 }),
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

  it("uses enemy tech conditions to trigger counter-production plans", () => {
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
    expect(gameplayController.handleCommittedTick()).toEqual([
      expect.objectContaining({
        type: "spawn",
        unitType: "rocket_soldier",
      }),
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
    expect((result.result as { hint: string }).hint).toContain("friendly units");
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
        targetPriority: ["light_tank", "rocket_soldier", "rifleman", "soldier", "war_factory", "barracks", "hq", "refinery"],
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

    const result = gameplayController.startHarvestLoop(worker.id, DEFAULT_MAP_LAYOUT.resources[0]);

    expect(result.result).toMatchObject({ ok: true });
    expect(gameplayController.takeIssuedCommands()).toEqual(
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
