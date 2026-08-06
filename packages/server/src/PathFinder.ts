import { TileType, MAP_WIDTH, MAP_HEIGHT } from "@llmcraft/shared";
import { isDiscBlockedByGrid } from "./navigation/NavigationGrid";

const CARDINAL_DIRECTIONS = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
] as const;

export interface NavigationField {
  readonly width: number;
  readonly height: number;
  readonly passable: Uint8Array;
  readonly domains: Int32Array;
  readonly domainCount: number;
}

export interface IntegrationField {
  readonly navigation: NavigationField;
  readonly requestedGoal: { x: number; y: number };
  readonly projectedGoalCount: number;
  readonly distances: Int32Array;
  readonly visitedNodes: number;
}

interface Node {
  x: number;
  y: number;
  g: number;
  h: number;
  f: number;
}

class MinHeap {
  private items: Node[] = [];

  private comesBefore(left: Node, right: Node): boolean {
    return left.f < right.f || (left.f === right.f && left.h < right.h);
  }

  get size(): number {
    return this.items.length;
  }

  push(node: Node): void {
    this.items.push(node);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.comesBefore(this.items[index], this.items[parent])) break;
      [this.items[parent], this.items[index]] = [this.items[index], this.items[parent]];
      index = parent;
    }
  }

  pop(): Node | undefined {
    const first = this.items[0];
    const last = this.items.pop();
    if (!first || !last || this.items.length === 0) return first;
    this.items[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.items.length && this.comesBefore(this.items[left], this.items[smallest])) smallest = left;
      if (right < this.items.length && this.comesBefore(this.items[right], this.items[smallest])) smallest = right;
      if (smallest === index) break;
      [this.items[index], this.items[smallest]] = [this.items[smallest], this.items[index]];
      index = smallest;
    }
    return first;
  }
}

export class PathFinder {
  /**
   * Builds the static cost/island layer for one movement footprint. Buildings
   * and terrain belong here; moving units remain a local-avoidance concern.
   */
  static buildNavigationField(
    tiles: TileType[][],
    occupiedPositions: ReadonlySet<string> | undefined,
    clearanceRadius: number,
  ): NavigationField {
    const width = tiles[0]?.length ?? 0;
    const height = tiles.length;
    const nodeCount = width * height;
    const passable = new Uint8Array(nodeCount);
    const domains = new Int32Array(nodeCount);
    domains.fill(-1);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        passable[index] = isDiscBlockedByGrid(
          x,
          y,
          clearanceRadius,
          tiles,
          occupiedPositions,
        ) ? 0 : 1;
      }
    }

    const queue = new Int32Array(nodeCount);
    let domainCount = 0;
    for (let startIndex = 0; startIndex < nodeCount; startIndex++) {
      if (passable[startIndex] === 0 || domains[startIndex] !== -1) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = startIndex;
      domains[startIndex] = domainCount;
      while (head < tail) {
        const currentIndex = queue[head++]!;
        const x = currentIndex % width;
        const y = Math.floor(currentIndex / width);
        for (const direction of CARDINAL_DIRECTIONS) {
          const nextX = x + direction.x;
          const nextY = y + direction.y;
          if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
          const nextIndex = nextY * width + nextX;
          if (passable[nextIndex] === 0 || domains[nextIndex] !== -1) continue;
          domains[nextIndex] = domainCount;
          queue[tail++] = nextIndex;
        }
      }
      domainCount++;
    }

    return { width, height, passable, domains, domainCount };
  }

  /**
   * Builds a shared reverse integration field for a bounded goal region. All
   * passable candidates are seeded so callers on another navigation island do
   * not fail merely because the first equally-near projection was disconnected.
   */
  static buildIntegrationField(
    navigation: NavigationField,
    requestedX: number,
    requestedY: number,
    maxProjectionRadius: number,
  ): IntegrationField | null {
    const { width, height, passable } = navigation;
    const distances = new Int32Array(width * height);
    distances.fill(-1);
    const queue = new Int32Array(width * height);
    let head = 0;
    let tail = 0;
    for (let y = Math.max(0, requestedY - maxProjectionRadius); y <= Math.min(height - 1, requestedY + maxProjectionRadius); y++) {
      for (let x = Math.max(0, requestedX - maxProjectionRadius); x <= Math.min(width - 1, requestedX + maxProjectionRadius); x++) {
        if (Math.abs(x - requestedX) + Math.abs(y - requestedY) > maxProjectionRadius) continue;
        const index = y * width + x;
        if (passable[index] === 0) continue;
        distances[index] = 0;
        queue[tail++] = index;
      }
    }
    const projectedGoalCount = tail;
    if (projectedGoalCount === 0) return null;

    while (head < tail) {
      const currentIndex = queue[head++]!;
      const x = currentIndex % width;
      const y = Math.floor(currentIndex / width);
      const nextDistance = distances[currentIndex]! + 1;
      for (const direction of CARDINAL_DIRECTIONS) {
        const nextX = x + direction.x;
        const nextY = y + direction.y;
        if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
        const nextIndex = nextY * width + nextX;
        if (passable[nextIndex] === 0 || distances[nextIndex] !== -1) continue;
        distances[nextIndex] = nextDistance;
        queue[tail++] = nextIndex;
      }
    }

    return {
      navigation,
      requestedGoal: { x: requestedX, y: requestedY },
      projectedGoalCount,
      distances,
      visitedNodes: tail,
    };
  }

  static getIntegrationDistance(field: IntegrationField, x: number, y: number): number {
    if (x < 0 || x >= field.navigation.width || y < 0 || y >= field.navigation.height) return -1;
    return field.distances[y * field.navigation.width + x] ?? -1;
  }

  /** Allows a unit embedded by a new static footprint to escape through an adjacent navigable cell. */
  static getStartIntegrationDistance(field: IntegrationField, x: number, y: number): number {
    const direct = this.getIntegrationDistance(field, x, y);
    if (direct >= 0) return direct;
    let nearest = -1;
    for (const direction of CARDINAL_DIRECTIONS) {
      const distance = this.getIntegrationDistance(field, x + direction.x, y + direction.y);
      if (distance >= 0 && (nearest < 0 || distance < nearest)) nearest = distance;
    }
    return nearest;
  }

  /**
   * A* 寻路算法
   * @param startX 起点 X
   * @param startY 起点 Y
   * @param targetX 目标 X
   * @param targetY 目标 Y
   * @param tiles 地图地块
   * @param occupiedPositions 被其他单位占据的位置集合（可选）
   * @returns 路径数组（不包含起点），如果不可达返回空数组
   */
  static findPath(
    startX: number,
    startY: number,
    targetX: number,
    targetY: number,
    tiles: TileType[][],
    occupiedPositions?: ReadonlySet<string>,
    clearanceRadius = 0,
  ): Array<{ x: number; y: number }> {
    const width = MAP_WIDTH;
    const nodeCount = MAP_WIDTH * MAP_HEIGHT;
    const traversal = new Uint8Array(nodeCount);
    const isBlocked = (x: number, y: number): boolean => {
      const index = y * width + x;
      const cached = traversal[index];
      if (cached !== 0) return cached === 2;
      const blocked = isDiscBlockedByGrid(x, y, clearanceRadius, tiles, occupiedPositions);
      traversal[index] = blocked ? 2 : 1;
      return blocked;
    };

    // 目标点合法性检查
    if (
      targetX < 0 ||
      targetX >= MAP_WIDTH ||
      targetY < 0 ||
      targetY >= MAP_HEIGHT
    ) {
      return [];
    }

    // 目标点是障碍物
    if (isBlocked(targetX, targetY)) {
      return [];
    }

    // 起点就是目标
    if (startX === targetX && startY === targetY) {
      return [];
    }

    const startIndex = startY * width + startX;
    const targetIndex = targetY * width + targetX;
    const open = new MinHeap();
    const closed = new Uint8Array(nodeCount);
    const gScores = new Int32Array(nodeCount);
    const cameFrom = new Int32Array(nodeCount);
    gScores.fill(-1);
    cameFrom.fill(-1);
    gScores[startIndex] = 0;
    const startH = this.heuristic(startX, startY, targetX, targetY);
    open.push({ x: startX, y: startY, g: 0, h: startH, f: startH });

    while (open.size > 0) {
      const currentNode = open.pop()!;
      const currentIndex = currentNode.y * width + currentNode.x;
      if (closed[currentIndex] || currentNode.g !== gScores[currentIndex]) continue;

      if (currentIndex === targetIndex) {
        return this.reconstructPath(cameFrom, startIndex, targetIndex, width);
      }

      closed[currentIndex] = 1;

      // 检查邻居（4方向或8方向）
      const neighbors = this.getNeighbors(currentNode.x, currentNode.y);

      for (const neighbor of neighbors) {
        const { x, y } = neighbor;

        // 越界检查
        if (x < 0 || x >= MAP_WIDTH || y < 0 || y >= MAP_HEIGHT) {
          continue;
        }

        // 已经在关闭列表
        const neighborIndex = y * width + x;
        if (closed[neighborIndex]) {
          continue;
        }

        // 障碍物检查
        if (isBlocked(x, y)) {
          continue;
        }

        const nextG = currentNode.g + 1;
        if (gScores[neighborIndex] !== -1 && nextG >= gScores[neighborIndex]) continue;
        gScores[neighborIndex] = nextG;
        cameFrom[neighborIndex] = currentIndex;
        const h = this.heuristic(x, y, targetX, targetY);
        open.push({ x, y, g: nextG, h, f: nextG + h });
      }
    }

    // 无可达路径
    return [];
  }

  /**
   * 获取邻居节点（4方向：上下左右）
   */
  private static getNeighbors(
    x: number,
    y: number
  ): Array<{ x: number; y: number }> {
    return CARDINAL_DIRECTIONS.map((direction) => ({
      x: x + direction.x,
      y: y + direction.y,
    }));
  }

  /**
   * 启发函数：曼哈顿距离
   */
  private static heuristic(
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ): number {
    return Math.abs(x1 - x2) + Math.abs(y1 - y2);
  }

  /**
   * 重建路径
   */
  private static reconstructPath(
    cameFrom: Int32Array,
    startIndex: number,
    endIndex: number,
    width: number,
  ): Array<{ x: number; y: number }> {
    const path: Array<{ x: number; y: number }> = [];
    let currentIndex = endIndex;
    while (currentIndex !== startIndex) {
      path.push({ x: currentIndex % width, y: Math.floor(currentIndex / width) });
      const parent = cameFrom[currentIndex];
      if (parent < 0) return [];
      currentIndex = parent;
    }
    return path.reverse();
  }

  /**
   * 获取下一步（用于每 tick 移动）
   */
  static getNextStep(
    startX: number,
    startY: number,
    targetX: number,
    targetY: number,
    tiles: TileType[][],
    occupiedPositions?: ReadonlySet<string>
  ): { x: number; y: number } | null {
    const path = this.findPath(
      startX,
      startY,
      targetX,
      targetY,
      tiles,
      occupiedPositions
    );
    return path.length > 0 ? path[0] : null;
  }
}
