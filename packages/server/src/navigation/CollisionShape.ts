export interface CircleShape {
  kind: "circle";
  x: number;
  y: number;
  radius: number;
}

export interface ObbShape {
  kind: "obb";
  x: number;
  y: number;
  halfLength: number;
  halfWidth: number;
  /** Radians in simulation XY space: zero points toward +X. */
  heading: number;
}

export type CollisionShape = CircleShape | ObbShape;

export interface CollisionManifold {
  /** Unit vector pointing from the left shape toward the right shape. */
  normalX: number;
  normalY: number;
  depth: number;
}

const EPSILON = 1e-9;

function dot(x1: number, y1: number, x2: number, y2: number): number {
  return x1 * x2 + y1 * y2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getObbAxes(shape: ObbShape) {
  const forwardX = Math.cos(shape.heading);
  const forwardY = Math.sin(shape.heading);
  return {
    forwardX,
    forwardY,
    sideX: -forwardY,
    sideY: forwardX,
  };
}

function circleCircle(left: CircleShape, right: CircleShape): CollisionManifold | null {
  const dx = right.x - left.x;
  const dy = right.y - left.y;
  const distance = Math.hypot(dx, dy);
  const depth = left.radius + right.radius - distance;
  if (depth <= EPSILON) return null;
  if (distance <= EPSILON) return { normalX: 1, normalY: 0, depth };
  return { normalX: dx / distance, normalY: dy / distance, depth };
}

/** Returns a manifold pointing from the OBB toward the circle. */
function obbCircle(obb: ObbShape, circle: CircleShape): CollisionManifold | null {
  const axes = getObbAxes(obb);
  const dx = circle.x - obb.x;
  const dy = circle.y - obb.y;
  const localForward = dot(dx, dy, axes.forwardX, axes.forwardY);
  const localSide = dot(dx, dy, axes.sideX, axes.sideY);
  const closestForward = clamp(localForward, -obb.halfLength, obb.halfLength);
  const closestSide = clamp(localSide, -obb.halfWidth, obb.halfWidth);
  const deltaForward = localForward - closestForward;
  const deltaSide = localSide - closestSide;
  const distance = Math.hypot(deltaForward, deltaSide);

  if (distance > EPSILON) {
    const depth = circle.radius - distance;
    if (depth <= EPSILON) return null;
    const normalForward = deltaForward / distance;
    const normalSide = deltaSide / distance;
    return {
      normalX: axes.forwardX * normalForward + axes.sideX * normalSide,
      normalY: axes.forwardY * normalForward + axes.sideY * normalSide,
      depth,
    };
  }

  // Circle center is inside the box. Exit through the nearest face.
  const forwardExit = obb.halfLength - Math.abs(localForward);
  const sideExit = obb.halfWidth - Math.abs(localSide);
  if (forwardExit <= sideExit) {
    const sign = localForward < 0 ? -1 : 1;
    return {
      normalX: axes.forwardX * sign,
      normalY: axes.forwardY * sign,
      depth: circle.radius + forwardExit,
    };
  }
  const sign = localSide < 0 ? -1 : 1;
  return {
    normalX: axes.sideX * sign,
    normalY: axes.sideY * sign,
    depth: circle.radius + sideExit,
  };
}

function obbProjectionRadius(shape: ObbShape, axisX: number, axisY: number): number {
  const axes = getObbAxes(shape);
  return shape.halfLength * Math.abs(dot(axes.forwardX, axes.forwardY, axisX, axisY))
    + shape.halfWidth * Math.abs(dot(axes.sideX, axes.sideY, axisX, axisY));
}

function obbObb(left: ObbShape, right: ObbShape): CollisionManifold | null {
  const leftAxes = getObbAxes(left);
  const rightAxes = getObbAxes(right);
  const axes = [
    { x: leftAxes.forwardX, y: leftAxes.forwardY },
    { x: leftAxes.sideX, y: leftAxes.sideY },
    { x: rightAxes.forwardX, y: rightAxes.forwardY },
    { x: rightAxes.sideX, y: rightAxes.sideY },
  ];
  const centerDx = right.x - left.x;
  const centerDy = right.y - left.y;
  let minimumDepth = Number.POSITIVE_INFINITY;
  let minimumNormalX = 1;
  let minimumNormalY = 0;

  for (const axis of axes) {
    const centerProjection = dot(centerDx, centerDy, axis.x, axis.y);
    const depth = obbProjectionRadius(left, axis.x, axis.y)
      + obbProjectionRadius(right, axis.x, axis.y)
      - Math.abs(centerProjection);
    if (depth <= EPSILON) return null;
    if (depth < minimumDepth) {
      const sign = centerProjection < 0 ? -1 : 1;
      minimumDepth = depth;
      minimumNormalX = axis.x * sign;
      minimumNormalY = axis.y * sign;
    }
  }

  return { normalX: minimumNormalX, normalY: minimumNormalY, depth: minimumDepth };
}

export function getCollisionManifold(
  left: CollisionShape,
  right: CollisionShape,
): CollisionManifold | null {
  if (left.kind === "circle" && right.kind === "circle") return circleCircle(left, right);
  if (left.kind === "obb" && right.kind === "circle") return obbCircle(left, right);
  if (left.kind === "circle" && right.kind === "obb") {
    const manifold = obbCircle(right, left);
    return manifold
      ? { normalX: -manifold.normalX, normalY: -manifold.normalY, depth: manifold.depth }
      : null;
  }
  return obbObb(left as ObbShape, right as ObbShape);
}

export function getShapeBoundingRadius(shape: CollisionShape): number {
  return shape.kind === "circle"
    ? shape.radius
    : Math.hypot(shape.halfLength, shape.halfWidth);
}

export function getShapeBounds(shape: CollisionShape) {
  if (shape.kind === "circle") {
    return {
      minX: shape.x - shape.radius,
      maxX: shape.x + shape.radius,
      minY: shape.y - shape.radius,
      maxY: shape.y + shape.radius,
    };
  }
  const axes = getObbAxes(shape);
  const extentX = Math.abs(axes.forwardX) * shape.halfLength + Math.abs(axes.sideX) * shape.halfWidth;
  const extentY = Math.abs(axes.forwardY) * shape.halfLength + Math.abs(axes.sideY) * shape.halfWidth;
  return {
    minX: shape.x - extentX,
    maxX: shape.x + extentX,
    minY: shape.y - extentY,
    maxY: shape.y + extentY,
  };
}

export function createCellShape(x: number, y: number): ObbShape {
  return { kind: "obb", x, y, halfLength: 0.5, halfWidth: 0.5, heading: 0 };
}
