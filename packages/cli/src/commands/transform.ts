import type { ControlClient } from "../client.js";
import { ExitCode, exit } from "../io/errors.js";
import { printJson } from "../io/json.js";
import { readStdin } from "../io/stdin.js";

interface HasCoord {
  x: number;
  y: number;
}

function chebyshev(a: HasCoord, b: HasCoord): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

interface UnitItem extends HasCoord {
  id: string;
  type: string;
}

interface EnemyItem extends HasCoord {
  id: string;
  type: string;
  hp: number;
}

interface ResourceItem extends HasCoord {
  tile: string;
}

async function fetchMapState(client: ControlClient, sessionId: string) {
  const resp = await client.callTool(sessionId, "get_map_state", {
    includeCells: true,
    includeEmptyTiles: false,
  });
  if (!resp.ok) {
    exit(ExitCode.BackendFailure, resp.error?.message ?? "Failed to get map state");
  }
  return resp;
}

// --- nearest resource ---

export async function handleNearest(
  client: ControlClient,
  sessionId: string,
  subcommand: string,
): Promise<void> {
  if (subcommand !== "resource" && subcommand !== "enemy") {
    exit(ExitCode.ArgError, `nearest requires 'resource' or 'enemy', got: ${subcommand || "(none)"}`);
  }

  const stdinInput = await readStdin();
  if (!stdinInput || stdinInput.kind !== "selection") {
    exit(ExitCode.ArgError, "nearest requires stdin selection (from units)");
  }
  const data = stdinInput.data as Record<string, unknown>;
  const units = (data.units as UnitItem[]) ?? [];
  if (units.length === 0) {
    exit(ExitCode.ArgError, "nearest: stdin selection has no units");
  }

  if (subcommand === "resource") {
    const mapResp = await fetchMapState(client, sessionId);
    const mapData = mapResp.data as Record<string, unknown>;
    const cells = (mapData.cells as Array<Record<string, unknown>>) ?? [];
    const resources: ResourceItem[] = cells
      .filter((c) => c.tile === "resource")
      .map((c) => ({ x: c.x as number, y: c.y as number, tile: "resource" }));

    if (resources.length === 0) {
      exit(ExitCode.BackendFailure, "No resource tiles visible on map");
    }

    const pairs = units.map((unit) => {
      let nearest: ResourceItem = resources[0];
      let minDist = chebyshev(unit, nearest);
      for (let i = 1; i < resources.length; i++) {
        const dist = chebyshev(unit, resources[i]);
        if (dist < minDist) {
          minDist = dist;
          nearest = resources[i];
        }
      }
      return { unitId: unit.id, resource: { x: nearest.x, y: nearest.y } };
    });

    printJson({
      ok: true,
      tick: mapResp.tick,
      kind: "pairing",
      data: { pairs },
    });
    return;
  }

  // nearest enemy
  const mapResp = await fetchMapState(client, sessionId);
  const mapData = mapResp.data as Record<string, unknown>;
  const mapUnits = (mapData.units as Array<Record<string, unknown>>) ?? [];
  const mapBuildings = (mapData.buildings as Array<Record<string, unknown>>) ?? [];

  const enemies: EnemyItem[] = [
    ...mapUnits.filter((u) => u.relation === "enemy"),
    ...mapBuildings.filter((b) => b.relation === "enemy"),
  ].map((e) => ({
    id: e.id as string,
    type: e.type as string,
    x: e.x as number,
    y: e.y as number,
    hp: e.hp as number,
  }));

  if (enemies.length === 0) {
    exit(ExitCode.BackendFailure, "No enemies visible on map");
  }

  const pairs = units.map((unit) => {
    let nearest: EnemyItem = enemies[0];
    let minDist = chebyshev(unit, nearest);
    for (let i = 1; i < enemies.length; i++) {
      const dist = chebyshev(unit, enemies[i]);
      if (dist < minDist) {
        minDist = dist;
        nearest = enemies[i];
      }
    }
    return { unitId: unit.id, enemy: { id: nearest.id, type: nearest.type, x: nearest.x, y: nearest.y, hp: nearest.hp } };
  });

  printJson({
    ok: true,
    tick: mapResp.tick,
    kind: "pairing",
    data: { pairs },
  });
}

// --- target ---

export async function handleTarget(
  client: ControlClient,
  sessionId: string,
  subcommand: string,
): Promise<void> {
  const stdinInput = await readStdin();
  if (!stdinInput || stdinInput.kind !== "selection") {
    exit(ExitCode.ArgError, "target requires stdin selection (from units)");
  }
  const data = stdinInput.data as Record<string, unknown>;
  const units = (data.units as UnitItem[]) ?? [];
  if (units.length === 0) {
    exit(ExitCode.ArgError, "target: stdin selection has no units");
  }

  const mapResp = await fetchMapState(client, sessionId);
  const mapData = mapResp.data as Record<string, unknown>;
  const mapUnits = (mapData.units as Array<Record<string, unknown>>) ?? [];
  const mapBuildings = (mapData.buildings as Array<Record<string, unknown>>) ?? [];

  const enemies: EnemyItem[] = [
    ...mapUnits.filter((u) => u.relation === "enemy"),
    ...mapBuildings.filter((b) => b.relation === "enemy"),
  ].map((e) => ({
    id: e.id as string,
    type: e.type as string,
    x: e.x as number,
    y: e.y as number,
    hp: e.hp as number,
  }));

  if (enemies.length === 0) {
    exit(ExitCode.BackendFailure, "No enemies visible on map");
  }

  if (subcommand === "enemy-hq") {
    const hq = enemies.find((e) => e.type === "hq");
    if (!hq) {
      exit(ExitCode.BackendFailure, "No enemy HQ visible on map");
    }
    const pairs = units.map((unit) => ({
      unitId: unit.id,
      enemy: { id: hq.id, type: hq.type, x: hq.x, y: hq.y, hp: hq.hp },
    }));
    printJson({
      ok: true,
      tick: mapResp.tick,
      kind: "pairing",
      data: { pairs },
    });
    return;
  }

  if (subcommand === "weakest") {
    const sorted = [...enemies].sort((a, b) => a.hp - b.hp);
    const target = sorted[0];
    const pairs = units.map((unit) => ({
      unitId: unit.id,
      enemy: { id: target.id, type: target.type, x: target.x, y: target.y, hp: target.hp },
    }));
    printJson({
      ok: true,
      tick: mapResp.tick,
      kind: "pairing",
      data: { pairs },
    });
    return;
  }

  exit(ExitCode.ArgError, `target requires 'enemy-hq' or 'weakest', got: ${subcommand || "(none)"}`);
}
