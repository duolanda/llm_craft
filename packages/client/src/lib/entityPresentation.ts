import type {
  Building,
  BuildingType,
  PlayerId,
  ProductionStatus,
  Unit,
  UnitState,
  UnitType,
} from "@llmcraft/shared";

export const UNIT_LABELS: Record<UnitType, string> = {
  worker: "工人",
  soldier: "士兵",
  rifleman: "步兵",
  rocket_soldier: "火箭兵",
  commando: "特种兵",
  light_tank: "轻型坦克",
  flame_tank: "火焰坦克",
  heavy_tank: "重型坦克",
};

export const UNIT_SHORT_LABELS: Record<UnitType, string> = {
  worker: "工人",
  soldier: "士兵",
  rifleman: "步兵",
  rocket_soldier: "火箭",
  commando: "特种",
  light_tank: "轻坦",
  flame_tank: "火坦",
  heavy_tank: "重坦",
};

export const UNIT_COLORS: Record<UnitType, string> = {
  worker: "#f0b44d",
  soldier: "#ff6b7a",
  rifleman: "#72df91",
  rocket_soldier: "#ff8a4c",
  commando: "#f5d45f",
  light_tank: "#69c8ef",
  flame_tank: "#ff733d",
  heavy_tank: "#a98aed",
};

export const BUILDING_LABELS: Record<BuildingType, string> = {
  hq: "总部",
  barracks: "兵营",
  war_factory: "战车工厂",
  refinery: "精炼厂",
  machine_gun_turret: "机枪塔",
  anti_tank_turret: "反坦克塔",
  tech_center: "科技中心",
};

export const PLAYER_LABELS: Record<PlayerId, string> = {
  player_1: "红方",
  player_2: "蓝方",
};

export const PRODUCTION_STATUS_LABELS: Record<ProductionStatus, string> = {
  producing: "生产中",
  waiting_for_credits: "等待资金",
  waiting_for_spawn: "出口受阻",
  waiting_for_prerequisite: "科技中断",
  waiting_for_unit_limit: "达到上限",
};

export const UNIT_STATE_LABELS: Record<UnitState, string> = {
  idle: "待命",
  moving: "移动中",
  attacking: "交战中",
  gathering: "采集中",
  building: "施工中",
};

function entitySerial(id: string, prefix: string): string {
  const numericSuffix = id.match(/(\d+)$/)?.[1];
  if (numericSuffix) {
    return `${prefix}-${numericSuffix.padStart(3, "0")}`;
  }

  const compact = id
    .split(/[_-]/)
    .filter(Boolean)
    .at(-1)
    ?.replace(/[^a-z0-9]/gi, "")
    .toUpperCase()
    .slice(0, 5);
  return `${prefix}-${compact || "???"}`;
}

export function getUnitDisplayName(unit: Pick<Unit, "id" | "type" | "playerId">): string {
  return `${PLAYER_LABELS[unit.playerId]}${UNIT_LABELS[unit.type]} · ${entitySerial(unit.id, "U")}`;
}

export function getBuildingDisplayName(
  building: Pick<Building, "id" | "type" | "playerId">,
): string {
  return `${PLAYER_LABELS[building.playerId]}${BUILDING_LABELS[building.type]} · ${entitySerial(building.id, "B")}`;
}

export function getUnitActivityLabel(unit: Pick<Unit, "state" | "intent">): string {
  switch (unit.intent?.type) {
    case "attack_move":
      return "推进交战";
    case "attack":
      return "锁定目标";
    case "harvest_loop":
      return "采集循环";
    case "gather":
      return "采集中";
    case "deposit":
      return "返仓卸货";
    case "build":
      return "执行建造";
    case "hold":
      return "原地驻守";
    case "move":
      return "前往目标";
    default:
      return UNIT_STATE_LABELS[unit.state];
  }
}

export function formatTickDuration(ticks: number, tickIntervalMs: number): string {
  const seconds = Math.max(0, ticks * tickIntervalMs) / 1_000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`;
}
