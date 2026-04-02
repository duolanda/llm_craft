import { useEffect, useRef } from "react";
import { GameState, MAP_WIDTH, MAP_HEIGHT } from "@llmcraft/shared";

interface GameCanvasProps {
  state: GameState | null;
}

const TILE_SIZE = 32;
const CANVAS_WIDTH = MAP_WIDTH * TILE_SIZE;
const CANVAS_HEIGHT = MAP_HEIGHT * TILE_SIZE;

const COLORS = {
  empty: "#0d1014",
  obstacle: "#2a3440",
  resource: "#ffb300",
  player1: "#ff2a4a",
  player2: "#00e5ff",
  hq: "#c45fff",
  generator: "#ff9800",
  barracks: "#2979ff",
};

export function GameCanvas({ state }: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !state) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // 清除背景
    ctx.fillStyle = "#080a0c";
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // 绘制 subtle 网格
    ctx.strokeStyle = "rgba(42, 52, 64, 0.35)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= MAP_WIDTH; x++) {
      ctx.beginPath();
      ctx.moveTo(x * TILE_SIZE, 0);
      ctx.lineTo(x * TILE_SIZE, CANVAS_HEIGHT);
      ctx.stroke();
    }
    for (let y = 0; y <= MAP_HEIGHT; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * TILE_SIZE);
      ctx.lineTo(CANVAS_WIDTH, y * TILE_SIZE);
      ctx.stroke();
    }

    // 绘制地块
    for (let y = 0; y < MAP_HEIGHT; y++) {
      for (let x = 0; x < MAP_WIDTH; x++) {
        const tile = state.tiles[y]?.[x];
        if (tile?.type === "resource") {
          ctx.fillStyle = COLORS.resource;
          ctx.beginPath();
          ctx.arc(
            x * TILE_SIZE + TILE_SIZE / 2,
            y * TILE_SIZE + TILE_SIZE / 2,
            TILE_SIZE / 4,
            0,
            Math.PI * 2
          );
          ctx.fill();
          // 微光晕
          ctx.shadowColor = COLORS.resource;
          ctx.shadowBlur = 8;
          ctx.stroke();
          ctx.shadowBlur = 0;
        } else if (tile?.type === "obstacle") {
          ctx.fillStyle = COLORS.obstacle;
          ctx.fillRect(
            x * TILE_SIZE + 1,
            y * TILE_SIZE + 1,
            TILE_SIZE - 2,
            TILE_SIZE - 2
          );
        }
      }
    }

    // 绘制建筑
    for (const player of state.players) {
      const color = player.id === "player_1" ? COLORS.player1 : COLORS.player2;
      for (const building of player.buildings) {
        if (!building.exists) continue;
        const bx = building.x * TILE_SIZE;
        const by = building.y * TILE_SIZE;
        const typeColor = COLORS[building.type as keyof typeof COLORS] || color;
        ctx.fillStyle = typeColor;
        ctx.fillRect(bx + 3, by + 3, TILE_SIZE - 7, TILE_SIZE - 7);

        // 建筑边框（玩家色）
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.strokeRect(bx + 3, by + 3, TILE_SIZE - 7, TILE_SIZE - 7);

        // 血条背景
        ctx.fillStyle = "#1a2028";
        ctx.fillRect(bx + 2, by - 7, TILE_SIZE - 4, 5);
        // 血条
        ctx.fillStyle = color;
        ctx.fillRect(bx + 2, by - 7, (TILE_SIZE - 4) * (building.hp / building.maxHp), 5);
      }
    }

    // 绘制单位
    for (const player of state.players) {
      const color = player.id === "player_1" ? COLORS.player1 : COLORS.player2;
      for (const unit of player.units) {
        if (!unit.exists) continue;
        const ux = unit.x * TILE_SIZE;
        const uy = unit.y * TILE_SIZE;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(ux + TILE_SIZE / 2, uy + TILE_SIZE / 2, TILE_SIZE / 3 - 1, 0, Math.PI * 2);
        ctx.fill();

        // 单位边框（白色微描边增加对比）
        ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // 血条背景
        ctx.fillStyle = "#1a2028";
        ctx.fillRect(ux + 4, uy - 5, TILE_SIZE - 8, 4);
        // 血条
        ctx.fillStyle = color;
        ctx.fillRect(ux + 4, uy - 5, (TILE_SIZE - 8) * (unit.hp / unit.maxHp), 4);
      }
    }
  }, [state]);

  return (
    <canvas
      ref={canvasRef}
      width={CANVAS_WIDTH}
      height={CANVAS_HEIGHT}
    />
  );
}
