import { GameState, PlayerId } from "@llmcraft/shared";

export const HQ_UNDER_ATTACK_ALERT = "Alert: our HQ is under attack.";

type AlertUnit = {
  type?: string;
  x: number;
  y: number;
  attackRange?: number;
  relation?: string;
};

type AlertHQ = {
  id?: string;
  type?: string;
  x: number;
  y: number;
};

export function getHQUnderAttackAlertFromGameState(state: GameState, playerId: PlayerId): string | null {
  const me = state.players.find((player) => player.id === playerId);
  const enemy = state.players.find((player) => player.id !== playerId);
  const hq = me?.buildings.find((building) => building.type === "hq" && building.exists);
  if (!hq || !enemy) {
    return null;
  }

  return isHQUnderAttack(
    hq,
    enemy.units.filter((unit) => unit.exists)
  )
    ? HQ_UNDER_ATTACK_ALERT
    : null;
}

export function getHQUnderAttackAlertFromRuntimeState(runtimeState: {
  mapState: unknown;
  myState: unknown;
}): string | null {
  const myState = runtimeState.myState as {
    hq?: AlertHQ | null;
    buildings?: AlertHQ[];
  } | null;
  const mapState = runtimeState.mapState as {
    units?: AlertUnit[];
    cells?: Array<{
      x: number;
      y: number;
      unit?: AlertUnit;
    }>;
  } | null;

  const buildings = Array.isArray(myState?.buildings)
    ? myState.buildings
    : myState?.hq
      ? [myState.hq]
      : [];
  if (buildings.length === 0) {
    return null;
  }

  const enemyUnits = Array.isArray(mapState?.cells)
    ? mapState.cells
        .filter((cell) => cell?.unit?.relation === "enemy")
        .map((cell) => ({
          x: cell.x,
          y: cell.y,
          type: cell.unit?.type,
          relation: cell.unit?.relation,
          attackRange: cell.unit?.attackRange,
        }))
    : (mapState?.units ?? []).filter((unit) => unit?.relation === "enemy");
  const threatened = buildings.find((building) => isHQUnderAttack(building, enemyUnits));
  if (!threatened) return null;
  if (threatened.type === "hq" || threatened === myState?.hq) return HQ_UNDER_ATTACK_ALERT;
  return `Alert: our ${threatened.type ?? "base building"} ${threatened.id ?? ""} is under attack at (${threatened.x},${threatened.y}).`
    .replace("  ", " ");
}

function isHQUnderAttack(hq: AlertHQ, enemyUnits: AlertUnit[]): boolean {
  return enemyUnits.some((unit) => {
    const attackRange = typeof unit.attackRange === "number"
      ? unit.attackRange
      : unit.type === "soldier"
        ? 1
        : 0;
    return attackRange > 0 && chebyshevDistance(unit.x, unit.y, hq.x, hq.y) <= attackRange;
  });
}

function chebyshevDistance(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}
