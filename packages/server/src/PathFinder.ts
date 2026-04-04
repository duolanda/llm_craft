import { TileType, TILE_TYPES, MAP_WIDTH, MAP_HEIGHT } from "@llmcraft/shared";

interface Node {
  x: number;
  y: number;
  g: number; // 从起点到当前节点的代价
  h: number; // 启发函数：到终点的估计代价
  f: number; // g + h
  parent?: Node;
}

export class PathFinder {
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
    occupiedPositions?: Set<string>
  ): Array<{ x: number; y: number }> {
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
    if (tiles[targetY][targetX] === TILE_TYPES.OBSTACLE) {
      return [];
    }

    // 起点就是目标
    if (startX === targetX && startY === targetY) {
      return [];
    }

    const openList: Node[] = [];
    const closedList = new Set<string>();

    const startNode: Node = {
      x: startX,
      y: startY,
      g: 0,
      h: this.heuristic(startX, startY, targetX, targetY),
      f: 0,
    };
    startNode.f = startNode.g + startNode.h;
    openList.push(startNode);

    while (openList.length > 0) {
      // 找出 f 值最小的节点
      let currentIndex = 0;
      for (let i = 1; i < openList.length; i++) {
        if (openList[i].f < openList[currentIndex].f) {
          currentIndex = i;
        }
      }

      const currentNode = openList[currentIndex];

      // 到达目标
      if (currentNode.x === targetX && currentNode.y === targetY) {
        return this.reconstructPath(currentNode);
      }

      // 移到关闭列表
      openList.splice(currentIndex, 1);
      closedList.add(`${currentNode.x},${currentNode.y}`);

      // 检查邻居（4方向或8方向）
      const neighbors = this.getNeighbors(currentNode.x, currentNode.y);

      for (const neighbor of neighbors) {
        const { x, y } = neighbor;

        // 越界检查
        if (x < 0 || x >= MAP_WIDTH || y < 0 || y >= MAP_HEIGHT) {
          continue;
        }

        // 已经在关闭列表
        if (closedList.has(`${x},${y}`)) {
          continue;
        }

        // 障碍物检查
        if (tiles[y][x] === TILE_TYPES.OBSTACLE) {
          continue;
        }

        // 被其他单位占据
        if (occupiedPositions?.has(`${x},${y}`)) {
          continue;
        }

        const gScore = currentNode.g + 1;
        const hScore = this.heuristic(x, y, targetX, targetY);
        const fScore = gScore + hScore;

        // 检查是否已经在开放列表中
        const existingNode = openList.find((n) => n.x === x && n.y === y);
        if (existingNode) {
          if (gScore < existingNode.g) {
            existingNode.g = gScore;
            existingNode.f = fScore;
            existingNode.parent = currentNode;
          }
        } else {
          openList.push({
            x,
            y,
            g: gScore,
            h: hScore,
            f: fScore,
            parent: currentNode,
          });
        }
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
    return [
      { x: x + 1, y }, // 右
      { x: x - 1, y }, // 左
      { x, y: y + 1 }, // 下
      { x, y: y - 1 }, // 上
    ];
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
    endNode: Node
  ): Array<{ x: number; y: number }> {
    const path: Array<{ x: number; y: number }> = [];
    let current: Node | undefined = endNode;

    while (current?.parent) {
      path.unshift({ x: current.x, y: current.y });
      current = current.parent;
    }

    return path;
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
    occupiedPositions?: Set<string>
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
