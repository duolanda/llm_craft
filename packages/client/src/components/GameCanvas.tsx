import { useEffect, useRef } from "react";
import { GameState, MAP_WIDTH, MAP_HEIGHT } from "@llmcraft/shared";

interface GameCanvasProps {
  state: GameState | null;
}

const TILE_SIZE = 32;
const CANVAS_WIDTH = MAP_WIDTH * TILE_SIZE;
const CANVAS_HEIGHT = MAP_HEIGHT * TILE_SIZE;

const COLORS = {
  empty: "#1a1a2e",
  obstacle: "#4a4a6a",
  resource: "#ffd700",
  player1: "#ff6b6b",
  player2: "#4ecdc4",
  hq: "#9b59b6",
  generator: "#f39c12",
  barracks: "#3498db",
};

export function GameCanvas({ state }: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !state) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // 清除背景
    ctx.fillStyle = "#0f0f1a";
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // 绘制地块
    for (let y = 0; y < MAP_HEIGHT; y++) {
      for (let x = 0; x < MAP_WIDTH; x++) {
        const tile = state.tiles[y]?.[x];
        ctx.fillStyle = COLORS[tile?.type as keyof typeof COLORS] || COLORS.empty;
        ctx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE - 1, TILE_SIZE - 1);
      }
    }

    // 绘制建筑
    for (const player of state.players) {
      const color = player.id === "player_1" ? COLORS.player1 : COLORS.player2;
      for (const building of player.buildings) {
        if (!building.exists) continue;
        ctx.fillStyle = COLORS[building.type as keyof typeof COLORS] || color;
        ctx.fillRect(
          building.x * TILE_SIZE + 2,
          building.y * TILE_SIZE + 2,
          TILE_SIZE - 5,
          TILE_SIZE - 5
        );
        // 血条背景
        ctx.fillStyle = "#333";
        ctx.fillRect(building.x * TILE_SIZE, building.y * TILE_SIZE - 6, TILE_SIZE, 4);
        // 血条
        ctx.fillStyle = color;
        ctx.fillRect(
          building.x * TILE_SIZE,
          building.y * TILE_SIZE - 6,
          TILE_SIZE * (building.hp / building.maxHp),
          4
        );
      }
    }

    // 绘制单位
    for (const player of state.players) {
      const color = player.id === "player_1" ? COLORS.player1 : COLORS.player2;
      for (const unit of player.units) {
        if (!unit.exists) continue;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(
          unit.x * TILE_SIZE + TILE_SIZE / 2,
          unit.y * TILE_SIZE + TILE_SIZE / 2,
          TILE_SIZE / 3,
          0,
          Math.PI * 2
        );
        ctx.fill();
        // 血条背景
        ctx.fillStyle = "#333";
        ctx.fillRect(unit.x * TILE_SIZE, unit.y * TILE_SIZE - 4, TILE_SIZE, 3);
        // 血条
        ctx.fillStyle = color;
        ctx.fillRect(
          unit.x * TILE_SIZE,
          unit.y * TILE_SIZE - 4,
          TILE_SIZE * (unit.hp / unit.maxHp),
          3
        );
      }
    }
  }, [state]);

  return (
    <canvas
      ref={canvasRef}
      width={CANVAS_WIDTH}
      height={CANVAS_HEIGHT}
      style={{ border: "2px solid #333", display: "block" }}
    />
  );
}
