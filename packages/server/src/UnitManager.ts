import {
  PlayerId,
  UnitType,
  TileType,
  ECONOMY_RULES,
  UNIT_STATES,
  getAttackDamageAgainstUnit,
  getUnitStats,
  RESULT_CODES,
  ResultCode,
  MAP_WIDTH,
  MAP_HEIGHT,
} from "@llmcraft/shared";
import { PathFinder } from "./PathFinder";
import type { WorldUnit as Unit } from "./WorldUnit";
import { getCollisionBoundingRadius, getMovementProfile } from "./navigation/MovementProfile";
import { UnitSpatialIndex } from "./navigation/UnitSpatialIndex";
import { isShapeBlockedByGrid } from "./navigation/NavigationGrid";
import { getCollisionManifold, type CollisionShape } from "./navigation/CollisionShape";
import {
  createUnitCollisionShape,
  getDefaultUnitHeading,
  getHeadingToward,
  getUnitCollisionShape,
  getUnitHeading,
} from "./navigation/UnitCollision";

const ARRIVAL_EPSILON = 0.001;
const SEPARATION_SLOP = 1e-6;
const SEPARATION_ITERATIONS = 8;
const MAX_UNIT_COLLISION_BOUNDING_RADIUS = Math.hypot(1.48, 0.98);
const MAX_MOVEMENT_SUBSTEPS_PER_TICK = 8;
const LOCAL_AVOIDANCE_ANGLES = [0, -30, 30, -60, 60, -90, 90] as const;
const CONGESTION_ESCAPE_ANGLES = [-120, 120, -150, 150, 180] as const;
const LOCAL_AVOIDANCE_DISTANCE_FACTORS = [1, 0.75, 0.5, 0.25] as const;
const MOVEMENT_PROGRESS_EPSILON = 0.05;
const CONGESTION_ESCAPE_TICKS = 4;
// Eight fixed samples keep translation + rotation work bounded while limiting
// a 180-degree turn to 22.5-degree collision intervals.
const COLLISION_SWEEP_SAMPLES = [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1] as const;

interface MovementReservation {
  unit: Unit;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  startHeading: number;
  endHeading: number;
}

interface ReservedEndpoint {
  shape: CollisionShape;
}

interface LocalMovementCandidate {
  x: number;
  y: number;
  distance: number;
  heading: number;
  forwardProgress: number;
  score: number;
}

function getDistance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
}

function getChebyshevDistance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getPathCell(x: number, y: number): { x: number; y: number } {
  return {
    x: clamp(Math.round(x), 0, MAP_WIDTH - 1),
    y: clamp(Math.round(y), 0, MAP_HEIGHT - 1),
  };
}

export class UnitManager {
  private units: Map<string, Unit> = new Map();
  private idCounter = 0;
  private readonly blockedTicks = new Map<string, number>();
  private readonly lastMovementOrigins = new Map<string, { x: number; y: number }>();

  /** @internal Authoritative runtime creation goes through EntityRegistry/WorldState. */
  createUnit(type: UnitType, x: number, y: number, playerId: PlayerId): Unit {
    const stats = getUnitStats(type);
    const unit: Unit = {
      id: `unit_${++this.idCounter}`,
      type,
      x,
      y,
      hp: stats.hp,
      maxHp: stats.hp,
      state: UNIT_STATES.IDLE,
      playerId,
      exists: true,
      attackRange: stats.attackRange,
      carryingCredits: 0,
      carryCapacity: ECONOMY_RULES.WORKER_CARRY_CAPACITY,
      heading: getDefaultUnitHeading(playerId),
    };
    this.units.set(unit.id, unit);
    return unit;
  }

  getUnit(id: string): Unit | undefined {
    return this.units.get(id);
  }

  getUnitsByPlayer(playerId: PlayerId): Unit[] {
    return Array.from(this.units.values()).filter(
      (u) => u.playerId === playerId && u.exists
    );
  }

  getAllUnits(): Unit[] {
    return Array.from(this.units.values()).filter((u) => u.exists);
  }

  iterateStoredUnits(): IterableIterator<Unit> {
    return this.units.values();
  }

  /**
   * Check if there is a unit at the given position
   */
  hasUnitAt(x: number, y: number, excludeUnitId?: string): boolean {
    for (const unit of this.units.values()) {
      if (!unit.exists || (excludeUnitId && unit.id === excludeUnitId)) {
        continue;
      }

      const unitCell = getPathCell(unit.x, unit.y);
      if (unitCell.x === x && unitCell.y === y) {
        return true;
      }
    }
    return false;
  }

  canPlaceUnitAt(
    type: UnitType,
    x: number,
    y: number,
    tiles?: TileType[][],
    blockedPositions?: Set<string>,
    excludeUnitId?: string,
  ): boolean {
    const shape = createUnitCollisionShape(type, x, y, 0);
    if (tiles && isShapeBlockedByGrid(shape, tiles, blockedPositions)) return false;
    for (const unit of this.units.values()) {
      if (!unit.exists || unit.id === excludeUnitId) continue;
      if (getCollisionManifold(shape, getUnitCollisionShape(unit))) return false;
    }
    return true;
  }

  moveUnit(
    unit: Unit,
    targetX: number,
    targetY: number,
    tiles?: TileType[][],
    blockedPositions?: Set<string>
  ): ResultCode {
    if (!unit.exists) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    // Check integer coordinates - must be whole numbers
    if (!Number.isInteger(targetX) || !Number.isInteger(targetY)) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    // Check map bounds
    if (targetX < 0 || targetX >= MAP_WIDTH || targetY < 0 || targetY >= MAP_HEIGHT) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    // Check speed limit: cannot move farther than unit's speed per tick
    const distance = getDistance(unit.x, unit.y, targetX, targetY);
    const maxSpeed = getUnitStats(unit.type).speed;
    if (distance > maxSpeed) {
      return RESULT_CODES.ERR_EXCEEDS_SPEED;
    }

    // Check collision: units have physical radius, not only a grid-center occupancy point.
    const nextHeading = getHeadingToward(unit.x, unit.y, targetX, targetY, getUnitHeading(unit));
    if (this.hasUnitCollisionAt(unit, targetX, targetY, nextHeading)) {
      return RESULT_CODES.ERR_POSITION_OCCUPIED;
    }

    if (tiles && isShapeBlockedByGrid(
      getUnitCollisionShape(unit, targetX, targetY, nextHeading),
      tiles,
      blockedPositions,
    )) {
      return RESULT_CODES.ERR_POSITION_OCCUPIED;
    }

    unit.x = targetX;
    unit.y = targetY;
    unit.heading = nextHeading;
    unit.state = UNIT_STATES.MOVING;
    // Record move intent for visualization
    unit.order = { type: 'move', targetX, targetY };

    return RESULT_CODES.OK;
  }

  attackUnit(attacker: Unit, target: Unit): ResultCode {
    if (!attacker.exists || !target.exists) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    if (attacker.playerId === target.playerId) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    // Critical: Check attack range
    const distance = getChebyshevDistance(attacker.x, attacker.y, target.x, target.y);
    if (distance > attacker.attackRange) {
      return RESULT_CODES.ERR_NOT_IN_RANGE;
    }

    const damage = getAttackDamageAgainstUnit(attacker.type, target.type);
    target.hp -= damage;
    attacker.state = UNIT_STATES.ATTACKING;
    // Record attack intent for visualization
    attacker.order = { type: 'attack', targetId: target.id, targetX: target.x, targetY: target.y };

    if (target.hp <= 0) {
      target.hp = 0;
      target.exists = false;
    }

    return RESULT_CODES.OK;
  }

  holdPosition(unit: Unit): ResultCode {
    if (!unit.exists) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    unit.state = UNIT_STATES.IDLE;
    this.blockedTicks.delete(unit.id);
    this.lastMovementOrigins.delete(unit.id);
    // Record hold intent for visualization
    unit.order = { type: 'hold' };
    return RESULT_CODES.OK;
  }

  /** @internal Authoritative runtime destruction goes through EntityRegistry/WorldState. */
  removeUnit(id: string): boolean {
    const unit = this.units.get(id);
    if (unit) {
      unit.exists = false;
      this.blockedTicks.delete(id);
      this.lastMovementOrigins.delete(id);
      return true;
    }
    return false;
  }

  /**
   * 设置单位的移动目标，自动计算路径
   * AI 调用此方法指定目标，系统会自动每 tick 沿路径移动
   */
  setMoveTarget(
    unit: Unit,
    targetX: number,
    targetY: number,
    tiles: TileType[][],
    blockedPositions?: Set<string>,
    keepResolvedTargetWhenAlreadyThere = false
  ): ResultCode {
    if (!unit.exists) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    if (!Number.isInteger(targetX) || !Number.isInteger(targetY)) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    // 检查目标点是否合法
    if (
      targetX < 0 ||
      targetX >= MAP_WIDTH ||
      targetY < 0 ||
      targetY >= MAP_HEIGHT
    ) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    const startCell = getPathCell(unit.x, unit.y);
    const reservedTargets = this.getReservedEndpoints(unit.id);
    const staticBlockedPositions = blockedPositions ?? new Set<string>();
    const resolvedTarget = this.resolveMoveTarget(
      unit,
      targetX,
      targetY,
      tiles,
      staticBlockedPositions,
      reservedTargets,
    );
    if (!resolvedTarget) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    const path = PathFinder.findPath(
      startCell.x,
      startCell.y,
      resolvedTarget.x,
      resolvedTarget.y,
      tiles,
      staticBlockedPositions,
      getMovementProfile(unit.type).navigationRadius,
    );

    // 保存路径和目标
    if (path.length === 0) {
      unit.path = undefined;
      const alreadyAtResolvedTarget = getChebyshevDistance(unit.x, unit.y, resolvedTarget.x, resolvedTarget.y) <= 0.35;
      unit.pathTarget =
        keepResolvedTargetWhenAlreadyThere && alreadyAtResolvedTarget
          ? { x: resolvedTarget.x, y: resolvedTarget.y }
          : undefined;
      unit.state = UNIT_STATES.IDLE;
      if (unit.order?.type === "move") {
        unit.order = undefined;
      }
      return RESULT_CODES.OK;
    }

    unit.path = path;
    unit.pathTarget = { x: resolvedTarget.x, y: resolvedTarget.y };
    unit.order = { type: "move", targetX: resolvedTarget.x, targetY: resolvedTarget.y };

    return RESULT_CODES.OK;
  }

  /**
   * 处理单位沿路径移动（每 tick 调用）
   * 按照单位速度移动相应步数
   */
  processPathMovement(
    unit: Unit,
    tiles: TileType[][],
    blockedPositions?: Set<string>,
    spatialIndex?: UnitSpatialIndex,
    movementReservations: readonly MovementReservation[] = [],
  ): ResultCode {
    if (!unit.exists || unit.state === UNIT_STATES.BUILDING || !unit.path || unit.path.length === 0) {
      return RESULT_CODES.OK;
    }

    let remainingDistance = getUnitStats(unit.type).speed;
    const index = spatialIndex ?? new UnitSpatialIndex(this.getAllUnits().filter((candidate) => candidate.id !== unit.id));
    let moved = false;
    let madeForwardProgress = false;
    let substeps = 0;

    while (
      remainingDistance > ARRIVAL_EPSILON
      && unit.path.length > 0
      && substeps < MAX_MOVEMENT_SUBSTEPS_PER_TICK
    ) {
      substeps++;
      const nextStep = unit.path[0];
      const distanceToStep = getDistance(unit.x, unit.y, nextStep.x, nextStep.y);

      if (distanceToStep <= ARRIVAL_EPSILON) {
        unit.x = nextStep.x;
        unit.y = nextStep.y;
        unit.path.shift();
        continue;
      }

      const travelDistance = Math.min(remainingDistance, distanceToStep);
      const ratio = travelDistance / distanceToStep;
      const nextX = unit.x + (nextStep.x - unit.x) * ratio;
      const nextY = unit.y + (nextStep.y - unit.y) * ratio;
      const preferredHeading = getHeadingToward(
        unit.x,
        unit.y,
        nextX,
        nextY,
        getUnitHeading(unit),
      );

      // Static topology changes invalidate the global path. Replan once and
      // yield until the next tick; never retry inside this movement loop.
      if (isShapeBlockedByGrid(
        getUnitCollisionShape(unit, nextX, nextY, preferredHeading),
        tiles,
        blockedPositions,
      )) {
        const startCell = getPathCell(unit.x, unit.y);
        const newPath = PathFinder.findPath(
          startCell.x,
          startCell.y,
          unit.pathTarget!.x,
          unit.pathTarget!.y,
          tiles,
          blockedPositions,
          getMovementProfile(unit.type).navigationRadius,
        );

        if (newPath.length === 0) {
          // 无法到达，清除路径
          unit.path = undefined;
          unit.pathTarget = undefined;
          return RESULT_CODES.ERR_POSITION_OCCUPIED;
        }

        unit.path = newPath;
        this.markBlocked(unit.id);
        return RESULT_CODES.ERR_POSITION_OCCUPIED;
      }

      // Mobile units are handled by bounded local avoidance, not by A*.
      const localMove = this.findLocalMovement(
        unit,
        nextX,
        nextY,
        travelDistance,
        tiles,
        blockedPositions,
        index,
        movementReservations,
      );
      if (!localMove) {
        this.markBlocked(unit.id);
        return RESULT_CODES.ERR_POSITION_OCCUPIED;
      }

      // 执行移动
      const movementOrigin = { x: unit.x, y: unit.y };
      unit.x = Math.abs(localMove.x - nextStep.x) <= ARRIVAL_EPSILON ? nextStep.x : localMove.x;
      unit.y = Math.abs(localMove.y - nextStep.y) <= ARRIVAL_EPSILON ? nextStep.y : localMove.y;
      unit.heading = localMove.heading;
      unit.state = UNIT_STATES.MOVING;
      remainingDistance -= localMove.distance;
      moved = true;
      madeForwardProgress ||= localMove.forwardProgress >= MOVEMENT_PROGRESS_EPSILON;
      this.lastMovementOrigins.set(unit.id, movementOrigin);

      if (getDistance(unit.x, unit.y, nextStep.x, nextStep.y) <= ARRIVAL_EPSILON) {
        unit.x = nextStep.x;
        unit.y = nextStep.y;
        unit.path.shift();
      }
    }

    if (madeForwardProgress) {
      this.blockedTicks.delete(unit.id);
    } else if (moved) {
      // Sideways motion is useful for avoidance, but it must not disguise a
      // traffic jam. Retain pressure so the deterministic escape candidates
      // become available instead of oscillating forever.
      this.markBlocked(unit.id);
    }

    // 路径走完
    if (unit.path.length === 0) {
      unit.path = undefined;
      unit.pathTarget = undefined;
      unit.state = UNIT_STATES.IDLE;
      this.blockedTicks.delete(unit.id);
      this.lastMovementOrigins.delete(unit.id);
      if (unit.order?.type === "move") {
        unit.order = undefined;
      }
    }

    return RESULT_CODES.OK;
  }

  /**
   * Advances all path followers against one spatial snapshot. Work is bounded
   * by units × a fixed local-candidate count, and accepted moves update the
   * broad-phase index immediately.
   */
  processAllPathMovement(tiles: TileType[][], blockedPositions?: Set<string>): void {
    const units = this.getAllUnits();
    const index = new UnitSpatialIndex(units);
    const movementReservations: MovementReservation[] = [];
    const movers = units
      .filter((unit) => unit.path && unit.path.length > 0)
      .sort((left, right) =>
        (this.blockedTicks.get(right.id) ?? 0) - (this.blockedTicks.get(left.id) ?? 0)
        || getMovementProfile(right.type).avoidancePriority - getMovementProfile(left.type).avoidancePriority
        || this.compareUnitIds(left.id, right.id),
      );

    for (const unit of movers) {
      const startX = unit.x;
      const startY = unit.y;
      const startHeading = getUnitHeading(unit);
      index.remove(unit);
      this.processPathMovement(unit, tiles, blockedPositions, index, movementReservations);
      index.add(unit);
      if (getDistance(startX, startY, unit.x, unit.y) > ARRIVAL_EPSILON) {
        movementReservations.push({
          unit,
          startX,
          startY,
          endX: unit.x,
          endY: unit.y,
          startHeading,
          endHeading: getUnitHeading(unit),
        });
      }
    }
  }

  resolveUnitSeparation(tiles: TileType[][], blockedPositions?: Set<string>): void {
    for (let iteration = 0; iteration < SEPARATION_ITERATIONS; iteration++) {
      const units = this.getAllUnits();
      const index = new UnitSpatialIndex(units);
      let foundOverlap = false;
      for (const left of units) {
        for (const right of index.query(
          left.x,
          left.y,
          getCollisionBoundingRadius(left.type) + MAX_UNIT_COLLISION_BOUNDING_RADIUS,
        )) {
          if (left.id.localeCompare(right.id) >= 0) continue;
          const manifold = getCollisionManifold(
            getUnitCollisionShape(left),
            getUnitCollisionShape(right),
          );
          if (!manifold) continue;

          foundOverlap = true;
          const direction = { x: manifold.normalX, y: manifold.normalY };
          const leftPriority = getMovementProfile(left.type).avoidancePriority;
          const rightPriority = getMovementProfile(right.type).avoidancePriority;
          const priorityTotal = leftPriority + rightPriority;
          const correction = manifold.depth + SEPARATION_SLOP;
          const leftCorrection = correction * rightPriority / priorityTotal;
          const rightCorrection = correction * leftPriority / priorityTotal;
          const leftMoved = this.tryApplySeparation(
            left,
            left.x - direction.x * leftCorrection,
            left.y - direction.y * leftCorrection,
            tiles,
            blockedPositions,
          );
          const rightMoved = this.tryApplySeparation(
            right,
            right.x + direction.x * rightCorrection,
            right.y + direction.y * rightCorrection,
            tiles,
            blockedPositions,
          );

          // A wall or building may pin one participant. In that case the other
          // participant must absorb the missing correction rather than leaving
          // the pair permanently intersecting.
          if (!leftMoved && rightMoved) {
            this.tryApplySeparation(
              right,
              right.x + direction.x * leftCorrection,
              right.y + direction.y * leftCorrection,
              tiles,
              blockedPositions,
            );
          } else if (leftMoved && !rightMoved) {
            this.tryApplySeparation(
              left,
              left.x - direction.x * rightCorrection,
              left.y - direction.y * rightCorrection,
              tiles,
              blockedPositions,
            );
          }
        }
      }
      if (!foundOverlap) return;
    }
  }

  /**
   * 清除单位的路径
   */
  clearPath(unit: Unit): void {
    unit.path = undefined;
    unit.pathTarget = undefined;
    this.blockedTicks.delete(unit.id);
    this.lastMovementOrigins.delete(unit.id);
  }

  /**
   * 获取被占据的位置集合（用于寻路避障）
   */
  private getReservedEndpoints(excludeUnitId?: string): ReservedEndpoint[] {
    const positions: ReservedEndpoint[] = [];
    for (const unit of this.units.values()) {
      if (!unit.exists || unit.id === excludeUnitId) {
        continue;
      }

      positions.push({ shape: getUnitCollisionShape(unit) });
      if (unit.pathTarget) {
        const targetHeading = getHeadingToward(
          unit.x,
          unit.y,
          unit.pathTarget.x,
          unit.pathTarget.y,
          getUnitHeading(unit),
        );
        positions.push({
          shape: getUnitCollisionShape(
            unit,
            unit.pathTarget.x,
            unit.pathTarget.y,
            targetHeading,
          ),
        });
      }
    }
    return positions;
  }

  private resolveMoveTarget(
    unit: Unit,
    requestedX: number,
    requestedY: number,
    tiles: TileType[][],
    staticBlockedPositions: Set<string>,
    reservedTargets: readonly ReservedEndpoint[],
  ): { x: number; y: number } | null {
    const startCell = getPathCell(unit.x, unit.y);
    const candidates: Array<{ x: number; y: number; radius: number; pathLength: number; unitDistance: number }> = [];

    for (let radius = 0; radius <= MAP_WIDTH + MAP_HEIGHT; radius++) {
      for (let y = Math.max(0, requestedY - radius); y <= Math.min(MAP_HEIGHT - 1, requestedY + radius); y++) {
        for (let x = Math.max(0, requestedX - radius); x <= Math.min(MAP_WIDTH - 1, requestedX + radius); x++) {
          if (Math.abs(x - requestedX) + Math.abs(y - requestedY) !== radius) {
            continue;
          }

          const candidateHeading = getHeadingToward(
            unit.x,
            unit.y,
            x,
            y,
            getUnitHeading(unit),
          );
          const candidateShape = getUnitCollisionShape(unit, x, y, candidateHeading);
          if (
            isShapeBlockedByGrid(candidateShape, tiles, staticBlockedPositions)
            || reservedTargets.some((reserved) => getCollisionManifold(candidateShape, reserved.shape))
          ) {
            continue;
          }

          const path = PathFinder.findPath(
            startCell.x,
            startCell.y,
            x,
            y,
            tiles,
            staticBlockedPositions,
            getMovementProfile(unit.type).navigationRadius,
          );
          if (path.length === 0 && (startCell.x !== x || startCell.y !== y)) {
            continue;
          }

          candidates.push({
            x,
            y,
            radius,
            pathLength: path.length,
            unitDistance: Math.abs(unit.x - x) + Math.abs(unit.y - y),
          });
        }
      }

      if (candidates.length > 0) {
        candidates.sort((a, b) =>
          a.radius - b.radius ||
          a.pathLength - b.pathLength ||
          a.unitDistance - b.unitDistance ||
          a.y - b.y ||
          a.x - b.x
        );

        return { x: candidates[0].x, y: candidates[0].y };
      }
    }

    return null;
  }

  private hasUnitCollisionAt(
    unit: Unit,
    targetX: number,
    targetY: number,
    heading = getHeadingToward(unit.x, unit.y, targetX, targetY, getUnitHeading(unit)),
  ): boolean {
    const candidateShape = getUnitCollisionShape(unit, targetX, targetY, heading);
    for (const other of this.units.values()) {
      if (!other.exists || other.id === unit.id) {
        continue;
      }
      if (getCollisionManifold(candidateShape, getUnitCollisionShape(other))) return true;
    }

    return false;
  }

  private findLocalMovement(
    unit: Unit,
    preferredX: number,
    preferredY: number,
    preferredDistance: number,
    tiles: TileType[][],
    blockedPositions: Set<string> | undefined,
    index: UnitSpatialIndex,
    movementReservations: readonly MovementReservation[],
  ): LocalMovementCandidate | null {
    const direction = Math.atan2(preferredY - unit.y, preferredX - unit.x);
    const currentHeading = getUnitHeading(unit);
    const blockedTicks = this.blockedTicks.get(unit.id) ?? 0;
    const angles: readonly number[] = blockedTicks >= CONGESTION_ESCAPE_TICKS
      ? [...LOCAL_AVOIDANCE_ANGLES, ...CONGESTION_ESCAPE_ANGLES]
      : LOCAL_AVOIDANCE_ANGLES;
    const lastOrigin = this.lastMovementOrigins.get(unit.id);
    const preferredSide = this.getDeterministicAvoidanceSide(unit.id);
    let best: LocalMovementCandidate | null = null;

    for (const distanceFactor of LOCAL_AVOIDANCE_DISTANCE_FACTORS) {
      const distance = preferredDistance * distanceFactor;
      for (const angleDegrees of angles) {
        const movementAngle = direction + angleDegrees * (Math.PI / 180);
        const isEscapeMove = Math.abs(angleDegrees) > 90;
        // Congested OBBs must be able to reverse out without sweeping through
        // neighbours while rotating 120-180 degrees in place.
        const heading = isEscapeMove ? currentHeading : movementAngle;
        const x = unit.x + Math.cos(movementAngle) * distance;
        const y = unit.y + Math.sin(movementAngle) * distance;
        const forwardProgress = Math.cos(angleDegrees * (Math.PI / 180)) * distance;
        if (
          lastOrigin
          && forwardProgress < MOVEMENT_PROGRESS_EPSILON
          && getDistance(x, y, lastOrigin.x, lastOrigin.y) <= MOVEMENT_PROGRESS_EPSILON
        ) continue;
        if (
          this.isTerrainMovementBlocked(
            unit,
            x,
            y,
            heading,
            tiles,
            blockedPositions,
          )
        ) continue;
        if (this.hasIndexedUnitCollisionAlongMovement(unit, x, y, heading, index)) continue;
        if (this.hasReservedMovementCollision(unit, x, y, heading, movementReservations)) continue;

        const turnDelta = Math.abs(Math.atan2(
          Math.sin(heading - currentHeading),
          Math.cos(heading - currentHeading),
        ));
        const side = Math.sign(angleDegrees);
        const sidePreference = side === 0 || side === preferredSide ? 0.25 : 0;
        const score = forwardProgress * 100 + distance * 2 - turnDelta * 3 + sidePreference;
        const candidate = { x, y, distance, heading, forwardProgress, score };
        if (!best || candidate.score > best.score) best = candidate;
      }
    }
    return best;
  }

  private hasIndexedUnitCollisionAlongMovement(
    unit: Unit,
    targetX: number,
    targetY: number,
    targetHeading: number,
    index: UnitSpatialIndex,
  ): boolean {
    const segmentLength = getDistance(unit.x, unit.y, targetX, targetY);
    const midX = (unit.x + targetX) / 2;
    const midY = (unit.y + targetY) / 2;
    const unitBound = getCollisionBoundingRadius(unit.type);
    for (const other of index.query(
      midX,
      midY,
      segmentLength / 2 + unitBound + MAX_UNIT_COLLISION_BOUNDING_RADIUS,
    )) {
      const otherShape = getUnitCollisionShape(other);
      const startManifold = getCollisionManifold(getUnitCollisionShape(unit), otherShape);
      const endManifold = getCollisionManifold(
        getUnitCollisionShape(unit, targetX, targetY, targetHeading),
        otherShape,
      );
      if (startManifold && (!endManifold || endManifold.depth < startManifold.depth - ARRIVAL_EPSILON)) {
        continue;
      }
      for (const progress of COLLISION_SWEEP_SAMPLES) {
        const shape = getUnitCollisionShape(
          unit,
          unit.x + (targetX - unit.x) * progress,
          unit.y + (targetY - unit.y) * progress,
          this.interpolateHeading(getUnitHeading(unit), targetHeading, progress),
        );
        if (getCollisionManifold(shape, otherShape)) return true;
      }
    }
    return false;
  }

  private hasReservedMovementCollision(
    unit: Unit,
    endX: number,
    endY: number,
    endHeading: number,
    reservations: readonly MovementReservation[],
  ): boolean {
    for (const reservation of reservations) {
      for (const progress of COLLISION_SWEEP_SAMPLES) {
        const unitShape = getUnitCollisionShape(
          unit,
          unit.x + (endX - unit.x) * progress,
          unit.y + (endY - unit.y) * progress,
          this.interpolateHeading(getUnitHeading(unit), endHeading, progress),
        );
        const reservationShape = getUnitCollisionShape(
          reservation.unit,
          reservation.startX + (reservation.endX - reservation.startX) * progress,
          reservation.startY + (reservation.endY - reservation.startY) * progress,
          this.interpolateHeading(reservation.startHeading, reservation.endHeading, progress),
        );
        if (getCollisionManifold(unitShape, reservationShape)) return true;
      }
    }
    return false;
  }

  private interpolateHeading(start: number, end: number, progress: number): number {
    const delta = Math.atan2(Math.sin(end - start), Math.cos(end - start));
    return start + delta * progress;
  }

  private compareUnitIds(leftId: string, rightId: string): number {
    const leftSequence = Number(leftId.slice(leftId.lastIndexOf("_") + 1));
    const rightSequence = Number(rightId.slice(rightId.lastIndexOf("_") + 1));
    if (Number.isFinite(leftSequence) && Number.isFinite(rightSequence) && leftSequence !== rightSequence) {
      return leftSequence - rightSequence;
    }
    return leftId.localeCompare(rightId);
  }

  private getDeterministicAvoidanceSide(unitId: string): -1 | 1 {
    const sequence = Number(unitId.slice(unitId.lastIndexOf("_") + 1));
    if (Number.isFinite(sequence)) return sequence % 2 === 0 ? 1 : -1;
    let hash = 0;
    for (const character of unitId) hash = (hash * 31 + character.charCodeAt(0)) | 0;
    return hash % 2 === 0 ? 1 : -1;
  }

  private markBlocked(unitId: string): void {
    this.blockedTicks.set(unitId, (this.blockedTicks.get(unitId) ?? 0) + 1);
  }

  private isTerrainMovementBlocked(
    unit: Unit,
    targetX: number,
    targetY: number,
    targetHeading: number,
    tiles: TileType[][],
    blockedPositions?: Set<string>,
  ): boolean {
    for (const progress of COLLISION_SWEEP_SAMPLES) {
      const shape = getUnitCollisionShape(
        unit,
        unit.x + (targetX - unit.x) * progress,
        unit.y + (targetY - unit.y) * progress,
        this.interpolateHeading(getUnitHeading(unit), targetHeading, progress),
      );
      if (isShapeBlockedByGrid(shape, tiles, blockedPositions)) return true;
    }
    return false;
  }

  private isPositionBlockedForUnit(
    unit: Unit,
    x: number,
    y: number,
    tiles: TileType[][],
    blockedPositions?: Set<string>,
  ): boolean {
    const heading = getHeadingToward(unit.x, unit.y, x, y, getUnitHeading(unit));
    return isShapeBlockedByGrid(getUnitCollisionShape(unit, x, y, heading), tiles, blockedPositions)
      || this.hasUnitCollisionAt(unit, x, y, heading);
  }

  private tryApplySeparation(unit: Unit, x: number, y: number, tiles: TileType[][], blockedPositions?: Set<string>): boolean {
    if (unit.state === UNIT_STATES.BUILDING) {
      return false;
    }
    const nextX = clamp(x, 0, MAP_WIDTH - 1);
    const nextY = clamp(y, 0, MAP_HEIGHT - 1);
    if (isShapeBlockedByGrid(
      getUnitCollisionShape(unit, nextX, nextY),
      tiles,
      blockedPositions,
    )) {
      return false;
    }
    unit.x = nextX;
    unit.y = nextY;
    return true;
  }

}
