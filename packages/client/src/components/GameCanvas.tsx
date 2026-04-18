import { useEffect, useRef } from "react";
import { GameState, MAP_WIDTH, MAP_HEIGHT, PLAYER_COLORS, GAME_COLORS } from "@llmcraft/shared";

interface GameCanvasProps {
  state: GameState | null;
}

const TILE_SIZE = 32;
const AXIS_GUTTER = 24;
const BOARD_OFFSET_X = AXIS_GUTTER;
const BOARD_OFFSET_Y = AXIS_GUTTER;
const BOARD_WIDTH = MAP_WIDTH * TILE_SIZE;
const BOARD_HEIGHT = MAP_HEIGHT * TILE_SIZE;
const CANVAS_WIDTH = BOARD_OFFSET_X + BOARD_WIDTH;
const CANVAS_HEIGHT = BOARD_OFFSET_Y + BOARD_HEIGHT;

const COLORS = {
  empty: GAME_COLORS.empty,
  obstacle: GAME_COLORS.obstacle,
  resource: GAME_COLORS.resource,
  player1: PLAYER_COLORS.player_1,
  player2: PLAYER_COLORS.player_2,
  hq: GAME_COLORS.hq,
  barracks: GAME_COLORS.barracks,
};

function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + safeRadius, y);
  ctx.lineTo(x + width - safeRadius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  ctx.lineTo(x + width, y + height - safeRadius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  ctx.lineTo(x + safeRadius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  ctx.lineTo(x, y + safeRadius);
  ctx.quadraticCurveTo(x, y, x + safeRadius, y);
  ctx.closePath();
}

function drawIdBadge(
  ctx: CanvasRenderingContext2D,
  text: string,
  centerX: number,
  centerY: number,
  accentColor: string
) {
  ctx.save();
  ctx.font = "bold 10px 'JetBrains Mono', monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const textWidth = ctx.measureText(text).width;
  const badgeWidth = Math.max(16, Math.ceil(textWidth + 8));
  const badgeHeight = 16;
  const x = Math.round(centerX - badgeWidth / 2);
  const y = Math.round(centerY - badgeHeight / 2);

  ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
  ctx.shadowBlur = 8;
  ctx.fillStyle = "rgba(8, 10, 12, 0.95)";
  drawRoundedRect(ctx, x, y, badgeWidth, badgeHeight, 6);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 1.5;
  drawRoundedRect(ctx, x, y, badgeWidth, badgeHeight, 6);
  ctx.stroke();

  ctx.fillStyle = "#f8fbff";
  ctx.fillText(text, centerX, centerY + 0.5);
  ctx.restore();
}

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

    // 坐标轴底板
    ctx.fillStyle = "rgba(8, 10, 12, 0.98)";
    ctx.fillRect(0, 0, CANVAS_WIDTH, BOARD_OFFSET_Y);
    ctx.fillRect(0, 0, BOARD_OFFSET_X, CANVAS_HEIGHT);

    // 坐标数字
    ctx.fillStyle = "rgba(153, 182, 197, 0.85)";
    ctx.font = "11px 'JetBrains Mono', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let x = 0; x < MAP_WIDTH; x++) {
      ctx.fillText(String(x), BOARD_OFFSET_X + x * TILE_SIZE + TILE_SIZE / 2, BOARD_OFFSET_Y / 2);
    }
    ctx.textAlign = "right";
    for (let y = 0; y < MAP_HEIGHT; y++) {
      ctx.fillText(String(y), BOARD_OFFSET_X - 6, BOARD_OFFSET_Y + y * TILE_SIZE + TILE_SIZE / 2);
    }

    // 绘制 subtle 网格
    ctx.strokeStyle = "rgba(42, 52, 64, 0.35)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= MAP_WIDTH; x++) {
      ctx.beginPath();
      ctx.moveTo(BOARD_OFFSET_X + x * TILE_SIZE, BOARD_OFFSET_Y);
      ctx.lineTo(BOARD_OFFSET_X + x * TILE_SIZE, CANVAS_HEIGHT);
      ctx.stroke();
    }
    for (let y = 0; y <= MAP_HEIGHT; y++) {
      ctx.beginPath();
      ctx.moveTo(BOARD_OFFSET_X, BOARD_OFFSET_Y + y * TILE_SIZE);
      ctx.lineTo(CANVAS_WIDTH, BOARD_OFFSET_Y + y * TILE_SIZE);
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
            BOARD_OFFSET_X + x * TILE_SIZE + TILE_SIZE / 2,
            BOARD_OFFSET_Y + y * TILE_SIZE + TILE_SIZE / 2,
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
            BOARD_OFFSET_X + x * TILE_SIZE + 1,
            BOARD_OFFSET_Y + y * TILE_SIZE + 1,
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
        const bx = BOARD_OFFSET_X + building.x * TILE_SIZE;
        const by = BOARD_OFFSET_Y + building.y * TILE_SIZE;
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

        // 建筑编号徽标
        const buildingIdText = building.id.split('_')[1];
        drawIdBadge(ctx, buildingIdText, bx + TILE_SIZE - 1, by + 6, color);
      }
    }

    // 绘制单位
    for (const player of state.players) {
      const color = player.id === "player_1" ? COLORS.player1 : COLORS.player2;
      for (const unit of player.units) {
        if (!unit.exists) continue;
        const ux = BOARD_OFFSET_X + unit.x * TILE_SIZE;
        const uy = BOARD_OFFSET_Y + unit.y * TILE_SIZE;
        const cx = ux + TILE_SIZE / 2;
        const cy = uy + TILE_SIZE / 2;
        ctx.fillStyle = color;

        // 根据单位类型使用不同形状
        if (unit.type === "soldier") {
          // 士兵: 带刺八边形
          const outer = TILE_SIZE / 3 - 1;
          const inner = TILE_SIZE / 4 - 2;
          ctx.beginPath();
          for (let i = 0; i < 8; i++) {
            const angle = -Math.PI / 2 + (Math.PI / 4) * i;
            const radius = i % 2 === 0 ? outer : inner;
            const px = cx + Math.cos(angle) * radius;
            const py = cy + Math.sin(angle) * radius;
            if (i === 0) {
              ctx.moveTo(px, py);
            } else {
              ctx.lineTo(px, py);
            }
          }
          ctx.closePath();
          ctx.fill();
        } else if (unit.type === "worker") {
          // 工人: 纯圆形
          ctx.beginPath();
          ctx.arc(cx, cy, TILE_SIZE / 4 - 1, 0, Math.PI * 2);
          ctx.fill();
        }

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

        // 单位编号徽标
        const unitIdText = unit.id.split('_')[1];
        drawIdBadge(ctx, unitIdText, ux + TILE_SIZE - 1, uy + 6, color);

        // 工人载货标记
        if (unit.type === "worker" && unit.carryingCredits > 0) {
          const badgeWidth = 20;
          const badgeHeight = 12;
          const badgeX = cx - badgeWidth / 2;
          const badgeY = uy + TILE_SIZE - 2;
          const carryRatio = Math.max(0, Math.min(1, unit.carryingCredits / unit.carryCapacity));

          ctx.fillStyle = "rgba(8, 10, 12, 0.9)";
          ctx.fillRect(badgeX, badgeY, badgeWidth, badgeHeight);

          ctx.fillStyle = "rgba(255, 179, 0, 0.25)";
          ctx.fillRect(badgeX + 1, badgeY + 1, (badgeWidth - 2) * carryRatio, badgeHeight - 2);

          ctx.strokeStyle = "rgba(255, 179, 0, 0.8)";
          ctx.lineWidth = 1;
          ctx.strokeRect(badgeX, badgeY, badgeWidth, badgeHeight);

          ctx.fillStyle = "#ffd54f";
          ctx.font = "10px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(unit.carryingCredits), cx, badgeY + badgeHeight / 2 + 0.5);
        }

        // 绘制意图
        if (unit.intent) {
          ctx.globalAlpha = 0.6;
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.setLineDash([4, 4]);

          if (unit.intent.type === 'move' && unit.intent.targetX !== undefined && unit.intent.targetY !== undefined) {
            // 移动意图：虚线连接到目标位置
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(
              BOARD_OFFSET_X + unit.intent.targetX * TILE_SIZE + TILE_SIZE / 2,
              BOARD_OFFSET_Y + unit.intent.targetY * TILE_SIZE + TILE_SIZE / 2
            );
            ctx.stroke();

            // 目标位置标记
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(
              BOARD_OFFSET_X + unit.intent.targetX * TILE_SIZE + TILE_SIZE / 2,
              BOARD_OFFSET_Y + unit.intent.targetY * TILE_SIZE + TILE_SIZE / 2,
              4, 0, Math.PI * 2
            );
            ctx.fill();
          } else if (unit.intent.type === 'attack' && unit.intent.targetX !== undefined && unit.intent.targetY !== undefined) {
            // 攻击意图：虚线连接到攻击目标
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(
              BOARD_OFFSET_X + unit.intent.targetX * TILE_SIZE + TILE_SIZE / 2,
              BOARD_OFFSET_Y + unit.intent.targetY * TILE_SIZE + TILE_SIZE / 2
            );
            ctx.stroke();

            // 攻击目标标记（X形）
            const tx = BOARD_OFFSET_X + unit.intent.targetX * TILE_SIZE + TILE_SIZE / 2;
            const ty = BOARD_OFFSET_Y + unit.intent.targetY * TILE_SIZE + TILE_SIZE / 2;
            ctx.strokeStyle = '#ff0000';
            ctx.lineWidth = 3;
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.moveTo(tx - 6, ty - 6);
            ctx.lineTo(tx + 6, ty + 6);
            ctx.moveTo(tx + 6, ty - 6);
            ctx.lineTo(tx - 6, ty + 6);
            ctx.stroke();

          } else if (unit.intent.type === 'attack_move' && unit.intent.targetX !== undefined && unit.intent.targetY !== undefined) {
            const tx = BOARD_OFFSET_X + unit.intent.targetX * TILE_SIZE + TILE_SIZE / 2;
            const ty = BOARD_OFFSET_Y + unit.intent.targetY * TILE_SIZE + TILE_SIZE / 2;
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(tx, ty);
            ctx.stroke();

            ctx.fillStyle = "rgba(255, 136, 64, 0.18)";
            ctx.beginPath();
            ctx.arc(tx, ty, 8, 0, Math.PI * 2);
            ctx.fill();

            ctx.strokeStyle = "#ff8840";
            ctx.setLineDash([]);
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.arc(tx, ty, 8, 0, Math.PI * 2);
            ctx.stroke();

          } else if (unit.intent.type === 'harvest_loop' && unit.intent.targetX !== undefined && unit.intent.targetY !== undefined) {
            const tx = BOARD_OFFSET_X + unit.intent.targetX * TILE_SIZE + TILE_SIZE / 2;
            const ty = BOARD_OFFSET_Y + unit.intent.targetY * TILE_SIZE + TILE_SIZE / 2;
            ctx.strokeStyle = "#ffd54f";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(tx, ty);
            ctx.stroke();

            ctx.setLineDash([]);
            ctx.strokeStyle = "#ffd54f";
            ctx.strokeRect(tx - 6, ty - 6, 12, 12);

            ctx.beginPath();
            ctx.arc(cx, cy, 10, Math.PI * 0.2, Math.PI * 1.8);
            ctx.stroke();

          } else if (unit.intent.type === 'hold') {
            // 待命意图：显示盾牌标记
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.moveTo(cx, cy - 8);
            ctx.lineTo(cx - 6, cy - 4);
            ctx.lineTo(cx - 6, cy + 2);
            ctx.quadraticCurveTo(cx, cy + 8, cx + 6, cy + 2);
            ctx.lineTo(cx + 6, cy - 4);
            ctx.closePath();
            ctx.stroke();
          }

          ctx.globalAlpha = 1;
          ctx.setLineDash([]);
        }
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
