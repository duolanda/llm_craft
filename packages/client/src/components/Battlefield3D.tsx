import { memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentRef, ReactNode } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import type { ThreeEvent } from "@react-three/fiber";
import { Billboard, OrbitControls, useGLTF, useTexture } from "@react-three/drei";
import * as THREE from "three";
import {
  Building,
  ActiveProjectile,
  ENTITY_GEOMETRY,
  GAME_COLORS,
  GameState,
  PLAYER_COLORS,
  TICK_INTERVAL_MS,
  Tile,
  Unit,
  UNIT_TYPES,
  getProductionOptions,
} from "@llmcraft/shared";
import { type SimulationVisualTimeline, VisualWorld } from "@llmcraft/record";
import {
  BUILDING_LABELS,
  formatTickDuration,
  getBuildingDisplayName,
  getUnitActivityLabel,
  getUnitDisplayName,
  PLAYER_LABELS,
  PRODUCTION_STATUS_LABELS,
  UNIT_LABELS,
} from "../lib/entityPresentation";

interface Battlefield3DProps {
  state: GameState | null;
  projectileFxMode?: ProjectileFxMode;
  timeline?: SimulationVisualTimeline;
  effectsResetKey?: string;
}

interface MapDimensions {
  width: number;
  height: number;
}

interface TeamPalette {
  primary: string;
  accent: string;
}

interface CameraFocus {
  target: Vec3;
  position: Vec3;
}

interface HoveredEntityPointer {
  entityId: string;
  x: number;
  y: number;
}

type EntityHoverHandler = (
  entityId: string,
  clientX: number,
  clientY: number,
) => void;

interface ModelTransform {
  entityId?: string;
  visualRotation?: "body" | "aim" | "fixed";
  position: Vec3;
  rotation: Vec3;
  scale: number;
  motionAmplitude?: number;
  motionFrequency?: number;
  motionPhase?: number;
  recoilAmplitude?: number;
  timedRecoilAmplitude?: number;
  timedRecoilAtMs?: number;
  timedRecoilCycleMs?: number;
  timedRecoilPhaseMs?: number;
  timedRecoilWidthMs?: number;
  swayAmplitude?: number;
  swayFrequency?: number;
}

interface InstancedModelPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  localMatrix: THREE.Matrix4;
}

interface CombatShot {
  sourceEntityId?: string;
  targetEntityId?: string;
  sourceElevation?: number;
  targetElevation?: number;
  projectileType: ActiveProjectile["projectileType"];
  source: Vec3;
  current?: Vec3;
  target: Vec3;
  color: string;
  trailColor: string;
  scale: number;
  phase: number;
  progress?: number;
  totalTicks?: number;
}

interface VisualProjectile {
  id: string;
  projectileType: ActiveProjectile["projectileType"];
  source: Vec3;
  target: Vec3;
  color: string;
  trailColor: string;
  scale: number;
  phase: number;
  bornAtMs: number;
  durationMs: number;
}

interface PreviewFxShotSpec {
  id: string;
  projectileType: ActiveProjectile["projectileType"];
  sourceId: string;
  targetId: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourceElevation: number;
  targetElevation: number;
  color: string;
  trailColor: string;
  scale: number;
  phase: number;
  durationMs: number;
}

interface DestructionBurst {
  id: string;
  position: Vec3;
  bornAt: number;
  scale: number;
}

interface FallenInfantry {
  id: string;
  modelUrl: string;
  playerId: Unit["playerId"];
  position: Vec3;
  heading: number;
  fallDirection: -1 | 1;
  sideTilt: number;
  bornAt: number;
}

type Vec3 = [number, number, number];

type ProjectileFxMode = "game" | "preview";

declare global {
  interface Window {
    __LLMCRAFT_RENDER_DIAGNOSTICS__?: {
      fps: number;
      calls: number;
      triangles: number;
      lines: number;
      points: number;
    };
  }
}

const CELL_SIZE = 1.15;
const PLAYER_1_COLOR = PLAYER_COLORS.player_1;
const PLAYER_2_COLOR = PLAYER_COLORS.player_2;
const NEUTRAL_PALETTE: TeamPalette = { primary: "#ffffff", accent: "#ffffff" };
const VEHICLE_UNIT_TYPES = new Set<Unit["type"]>([
  UNIT_TYPES.LIGHT_TANK,
  UNIT_TYPES.FLAME_TANK,
  UNIT_TYPES.HEAVY_TANK,
]);
const isVehicleUnit = (unit: Unit): boolean => VEHICLE_UNIT_TYPES.has(unit.type);
const PREVIEW_FX_SOURCE_X = 63;
const PREVIEW_FX_TARGET_X = 81;
const PREVIEW_FX_SHOT_SPECS: PreviewFxShotSpec[] = [
  {
    id: "preview-bullet",
    projectileType: "bullet",
    sourceId: "player_1_lab_fx_source_rifle",
    targetId: "player_2_lab_fx_target_rifle",
    sourceX: PREVIEW_FX_SOURCE_X + 0.62,
    sourceY: 39,
    targetX: PREVIEW_FX_TARGET_X - 0.35,
    targetY: 39,
    sourceElevation: 1.02,
    targetElevation: 0.88,
    color: "#fff1a8",
    trailColor: "#ffe27a",
    scale: 0.075,
    phase: 0,
    durationMs: 680,
  },
  {
    id: "preview-rocket",
    projectileType: "rocket",
    sourceId: "player_1_lab_fx_source_rocket",
    targetId: "player_2_lab_fx_target_rocket_tank",
    sourceX: PREVIEW_FX_SOURCE_X + 0.68,
    sourceY: 47,
    targetX: PREVIEW_FX_TARGET_X - 0.52,
    targetY: 47,
    sourceElevation: 1.08,
    targetElevation: 0.92,
    color: "#ff8a2a",
    trailColor: "#b7b5a7",
    scale: 0.19,
    phase: 1.7,
    durationMs: 1450,
  },
  {
    id: "preview-shell",
    projectileType: "shell",
    sourceId: "player_1_lab_fx_source_tank",
    targetId: "player_2_lab_fx_target_tank",
    sourceX: PREVIEW_FX_SOURCE_X + 0.92,
    sourceY: 53,
    targetX: PREVIEW_FX_TARGET_X - 0.72,
    targetY: 53,
    sourceElevation: 1.18,
    targetElevation: 0.94,
    color: "#ffd36a",
    trailColor: "#f5d48a",
    scale: 0.15,
    phase: 3.2,
    durationMs: 1250,
  },
];
const PREVIEW_FX_CYCLE_GAP_MS = 620;
const INFANTRY_FALL_DURATION_SECONDS = 0.52;
const INFANTRY_BODY_LINGER_SECONDS = 1.25;
const INFANTRY_FADE_DURATION_SECONDS = 0.7;
const INFANTRY_DEATH_EFFECT_MS = (
  INFANTRY_FALL_DURATION_SECONDS
  + INFANTRY_BODY_LINGER_SECONDS
  + INFANTRY_FADE_DURATION_SECONDS
) * 1000;
const MODEL_ROOT = "/assets/models/battlefield";
const TEXTURE_ROOT = "/assets/textures/battlefield";
const MODEL_VERSION = "production-20260823-1";
const SHOW_DEBUG_INTENTS = new URLSearchParams(window.location.search).has("debug-intents");
const MASS_BATTLE_LOD_ENABLED = new URLSearchParams(window.location.search).get("lod") === "mass";
const FAR_READABILITY_VIEW = new URLSearchParams(window.location.search).get("view") === "far";
const REFINERY_INSPECTION_VIEW = new URLSearchParams(window.location.search).get("view") === "refinery";
const TANK_FORWARD_OFFSET = Math.PI / 2;

function modelUrl(fileName: string): string {
  return `${MODEL_ROOT}/${fileName}.glb?v=${MODEL_VERSION}`;
}

const MODEL_URLS = {
  worker: modelUrl("worker"),
  worker_lod: modelUrl("worker_lod"),
  soldier: modelUrl("soldier"),
  soldier_lod: modelUrl("soldier_lod"),
  rifleman: modelUrl("rifleman"),
  rifleman_lod: modelUrl("rifleman_lod"),
  rocket_soldier: modelUrl("rocket_soldier"),
  rocket_soldier_lod: modelUrl("rocket_soldier_lod"),
  commando: modelUrl("commando"),
  commando_lod: modelUrl("commando_lod"),
  light_tank_body: modelUrl("light_tank_body"),
  light_tank_body_lod: modelUrl("light_tank_body_lod"),
  light_tank_turret: modelUrl("light_tank_turret"),
  light_tank_turret_lod: modelUrl("light_tank_turret_lod"),
  flame_tank_body: modelUrl("flame_tank_body"),
  flame_tank_body_lod: modelUrl("flame_tank_body_lod"),
  flame_tank_turret: modelUrl("flame_tank_turret"),
  flame_tank_turret_lod: modelUrl("flame_tank_turret_lod"),
  heavy_tank_body: modelUrl("heavy_tank_body"),
  heavy_tank_body_lod: modelUrl("heavy_tank_body_lod"),
  heavy_tank_turret: modelUrl("heavy_tank_turret"),
  heavy_tank_turret_lod: modelUrl("heavy_tank_turret_lod"),
  hq: modelUrl("hq"),
  barracks: modelUrl("barracks"),
  war_factory: modelUrl("war_factory"),
  refinery: modelUrl("refinery"),
  machine_gun_turret_body: modelUrl("machine_gun_turret_body"),
  machine_gun_turret_turret: modelUrl("machine_gun_turret_turret"),
  anti_tank_turret_body: modelUrl("anti_tank_turret_body"),
  anti_tank_turret_turret: modelUrl("anti_tank_turret_turret"),
  tech_center: modelUrl("tech_center"),
  resource: modelUrl("resource"),
  rock: modelUrl("rock"),
} as const;

Object.values(MODEL_URLS).forEach((url) => useGLTF.preload(url));

function getMapDimensions(state: GameState): MapDimensions {
  return {
    width: state.tiles[0]?.length ?? 1,
    height: state.tiles.length || 1,
  };
}

function toWorldPosition(x: number, y: number, dimensions: MapDimensions, elevation = 0): Vec3 {
  return [
    (x - (dimensions.width - 1) / 2) * CELL_SIZE,
    elevation,
    (y - (dimensions.height - 1) / 2) * CELL_SIZE,
  ];
}

function getPlayerColor(playerId: string): string {
  return playerId === "player_1" ? PLAYER_1_COLOR : PLAYER_2_COLOR;
}

function getTeamPalette(playerId: string): TeamPalette {
  return {
    primary: getPlayerColor(playerId),
    accent: playerId === "player_1" ? "#f2a1a8" : "#8ed7df",
  };
}

function getCameraFrame(aspect = 1) {
  const narrow = aspect < 0.9;
  if (REFINERY_INSPECTION_VIEW) {
    return { height: narrow ? 24 : 15, distance: narrow ? 31 : 23 };
  }
  if (FAR_READABILITY_VIEW) {
    return {
      height: narrow ? 74 : 62,
      distance: narrow ? 108 : 94,
    };
  }
  return {
    height: narrow ? 24 : 15,
    distance: narrow ? 29 : 22,
  };
}

function getTacticalFocus(state: GameState, dimensions: MapDimensions): Vec3 {
  if (REFINERY_INSPECTION_VIEW) {
    const refinery = state.players
      .find((player) => player.id === "player_1")
      ?.buildings.find((building) => building.exists && building.type === "refinery");
    if (refinery) return toWorldPosition(refinery.x, refinery.y, dimensions, 0);
  }
  const units = state.players.flatMap((player) => player.units).filter((unit) => unit.exists);
  const fightingUnits = units.filter(
    (unit) => unit.state === "attacking" || unit.intent?.type === "attack" || unit.intent?.type === "attack_move",
  );
  const combatUnits = units.filter((unit) => unit.type !== "worker");
  const focusUnits = fightingUnits.length > 0 ? fightingUnits : combatUnits;

  if (focusUnits.length > 0) {
    const averageX = focusUnits.reduce((sum, unit) => sum + unit.x, 0) / focusUnits.length;
    const averageY = focusUnits.reduce((sum, unit) => sum + unit.y, 0) / focusUnits.length;
    return toWorldPosition(averageX, averageY, dimensions, 0);
  }

  const playerOneHq = state.players
    .find((player) => player.id === "player_1")
    ?.buildings.find((building) => building.exists && building.type === "hq");
  return playerOneHq
    ? toWorldPosition(playerOneHq.x, playerOneHq.y, dimensions, 0)
    : [0, 0, 0];
}

function getInitialCameraFocus(state: GameState, dimensions: MapDimensions, aspect = 1): CameraFocus {
  const target = getTacticalFocus(state, dimensions);
  const frame = getCameraFrame(aspect);
  return {
    target,
    position: [target[0], target[1] + frame.height, target[2] + frame.distance],
  };
}

function ResponsiveCamera({
  initialFocus,
}: {
  initialFocus: CameraFocus;
}) {
  const { camera, size } = useThree();
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) {
      return;
    }
    const aspect = size.width / Math.max(1, size.height);
    const frame = getCameraFrame(aspect);
    camera.position.set(
      initialFocus.target[0],
      initialFocus.target[1] + frame.height,
      initialFocus.target[2] + frame.distance,
    );
    camera.lookAt(...initialFocus.target);
    camera.updateProjectionMatrix();
    initialized.current = true;
  }, [camera, initialFocus, size.height, size.width]);

  return null;
}

function BoundedCameraControls({
  resetFocus,
  dimensions,
}: {
  resetFocus: CameraFocus;
  dimensions: MapDimensions;
}) {
  const controlsRef = useRef<ComponentRef<typeof OrbitControls>>(null);
  const middlePointer = useRef<{ x: number; y: number } | null>(null);
  const initialized = useRef(false);
  const { camera, gl } = useThree();
  const halfWidth = Math.max(0, (dimensions.width - 1) * CELL_SIZE * 0.5);
  const halfHeight = Math.max(0, (dimensions.height - 1) * CELL_SIZE * 0.5);

  const resetCamera = () => {
    const controls = controlsRef.current;
    if (!controls) return;
    controls.target.set(...resetFocus.target);
    camera.position.set(...resetFocus.position);
    camera.lookAt(controls.target);
    camera.updateProjectionMatrix();
    controls.update();
  };

  useEffect(() => {
    if (initialized.current || !controlsRef.current) return;
    controlsRef.current.target.set(...resetFocus.target);
    controlsRef.current.update();
    initialized.current = true;
  }, [resetFocus]);

  useEffect(() => {
    const canvas = gl.domElement;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 1) return;
      middlePointer.current = { x: event.clientX, y: event.clientY };
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (event.button !== 1 || !middlePointer.current) return;
      const movement = Math.hypot(
        event.clientX - middlePointer.current.x,
        event.clientY - middlePointer.current.y,
      );
      middlePointer.current = null;
      if (movement <= 4) resetCamera();
    };
    const clearMiddlePointer = () => {
      middlePointer.current = null;
    };
    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointerup", handlePointerUp);
    canvas.addEventListener("pointercancel", clearMiddlePointer);
    return () => {
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointerup", handlePointerUp);
      canvas.removeEventListener("pointercancel", clearMiddlePointer);
    };
  }, [camera, gl, resetFocus]);

  useFrame(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const clampedX = THREE.MathUtils.clamp(controls.target.x, -halfWidth, halfWidth);
    const clampedZ = THREE.MathUtils.clamp(controls.target.z, -halfHeight, halfHeight);
    const deltaX = clampedX - controls.target.x;
    const deltaY = -controls.target.y;
    const deltaZ = clampedZ - controls.target.z;
    if (deltaX === 0 && deltaY === 0 && deltaZ === 0) return;
    controls.target.set(clampedX, 0, clampedZ);
    camera.position.add(new THREE.Vector3(deltaX, deltaY, deltaZ));
    controls.update();
  });

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enableDamping
      enablePan
      dampingFactor={0.08}
      minDistance={10}
      maxDistance={88}
      minPolarAngle={Math.PI * 0.18}
      maxPolarAngle={Math.PI * 0.42}
    />
  );
}

function RenderDiagnostics() {
  const { gl } = useThree();
  const frameCounter = useRef(0);
  const sampleStartedAt = useRef(Date.now());

  useFrame(() => {
    if (!import.meta.env.DEV) {
      return;
    }

    frameCounter.current += 1;
    const now = Date.now();
    const elapsed = now - sampleStartedAt.current;
    if (elapsed < 1000) {
      return;
    }

    const diagnostics = {
      fps: Math.round((frameCounter.current * 1000 / elapsed) * 10) / 10,
      calls: gl.info.render.calls,
      triangles: gl.info.render.triangles,
      lines: gl.info.render.lines,
      points: gl.info.render.points,
    };
    window.__LLMCRAFT_RENDER_DIAGNOSTICS__ = diagnostics;
    gl.domElement.dataset.renderFps = String(diagnostics.fps);
    gl.domElement.dataset.renderCalls = String(diagnostics.calls);
    gl.domElement.dataset.renderTriangles = String(diagnostics.triangles);
    frameCounter.current = 0;
    sampleStartedAt.current = now;
  });

  return null;
}

function VisualFrameSystem({
  visualWorld,
  units,
  timeline,
}: {
  visualWorld: VisualWorld;
  units: Unit[];
  timeline?: SimulationVisualTimeline;
}) {
  const unitsRef = useRef(units);
  unitsRef.current = units;

  useLayoutEffect(() => {
    visualWorld.step(units, timeline, performance.now());
  }, [timeline, units, visualWorld]);

  useFrame(() => {
    visualWorld.step(unitsRef.current, timeline, performance.now());
  }, -100);

  return null;
}

function VisualUnitAnchor({
  entityId,
  visualWorld,
  dimensions,
  elevation,
  scale,
  children,
}: {
  entityId: string;
  visualWorld: VisualWorld;
  dimensions: MapDimensions;
  elevation: number;
  scale: number;
  children: ReactNode;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const update = () => {
    const group = groupRef.current;
    const transform = visualWorld.getTransform(entityId);
    if (!group || !transform) return;
    group.position.set(
      (transform.x - (dimensions.width - 1) / 2) * CELL_SIZE,
      elevation,
      (transform.y - (dimensions.height - 1) / 2) * CELL_SIZE,
    );
    group.rotation.set(0, transform.bodyHeading, 0);
  };

  useLayoutEffect(update, [dimensions, entityId, visualWorld]);
  useFrame(update, -30);

  return <group ref={groupRef} scale={scale}>{children}</group>;
}

function ProjectileFxModeMarker({ mode }: { mode: ProjectileFxMode }) {
  const { gl } = useThree();

  useEffect(() => {
    if (mode === "preview") {
      gl.domElement.dataset.projectileFxMode = "preview";
      return;
    }

    delete gl.domElement.dataset.projectileFxMode;
  }, [gl, mode]);

  return null;
}

function FlameWindupMarker({
  unit,
  visualWorld,
  dimensions,
}: {
  unit: Unit;
  visualWorld: VisualWorld;
  dimensions: MapDimensions;
}) {
  const coreRef = useRef<THREE.Mesh>(null);
  const ringRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    const pulse = 0.82 + Math.sin(clock.elapsedTime * 15 + unit.x * 0.7 + unit.y) * 0.18;
    coreRef.current?.scale.setScalar(pulse);
    if (ringRef.current) {
      ringRef.current.rotation.z = clock.elapsedTime * 4.5;
      ringRef.current.scale.setScalar(0.88 + pulse * 0.16);
    }
  });

  return (
    <VisualUnitAnchor entityId={unit.id} visualWorld={visualWorld} dimensions={dimensions} elevation={0.08} scale={1}>
      <group position={[-0.92, 1.24, 0]}>
        <mesh ref={coreRef}>
          <sphereGeometry args={[0.18, 12, 8]} />
          <meshBasicMaterial color="#fff06a" transparent opacity={0.92} blending={THREE.AdditiveBlending} toneMapped={false} depthWrite={false} />
        </mesh>
        <mesh ref={ringRef} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.27, 0.045, 8, 18]} />
          <meshBasicMaterial color="#ff5a16" transparent opacity={0.8} blending={THREE.AdditiveBlending} toneMapped={false} depthWrite={false} />
        </mesh>
      </group>
    </VisualUnitAnchor>
  );
}

function AttackWindupEffects({
  units,
  dimensions,
  visualWorld,
}: {
  units: Unit[];
  dimensions: MapDimensions;
  visualWorld: VisualWorld;
}) {
  const windingUp = units.filter((unit) => unit.type === UNIT_TYPES.FLAME_TANK && unit.attackWindup);
  return windingUp.map((unit) => (
    <FlameWindupMarker key={unit.id} unit={unit} dimensions={dimensions} visualWorld={visualWorld} />
  ));
}

const FLAME_STREAM_SEGMENTS = 14;
const FLAME_STREAM_NOZZLES = 2;

function FlameStreamEffects({
  units,
  buildings,
  dimensions,
  visualWorld,
}: {
  units: Unit[];
  buildings: Building[];
  dimensions: MapDimensions;
  visualWorld: VisualWorld;
}) {
  const { gl } = useThree();
  const outerRef = useRef<THREE.InstancedMesh>(null);
  const coreRef = useRef<THREE.InstancedMesh>(null);
  const streams = useMemo(() => {
    const targets = new Map([...units, ...buildings].map((target) => [target.id, target]));
    return units
      .filter((unit) => unit.type === UNIT_TYPES.FLAME_TANK && unit.attackStream)
      .sort((left, right) => left.id.localeCompare(right.id))
      .flatMap((unit) => {
        const targetId = unit.attackStream?.targetId;
        const target = targetId ? targets.get(targetId) : undefined;
        if (!target) return [];
        const targetIsBuilding = "productionQueue" in target;
        return [{
          sourceId: unit.id,
          source: toWorldPosition(unit.x, unit.y, dimensions, 1.12),
          targetId: targetIsBuilding ? undefined : target.id,
          target: toWorldPosition(
            target.x,
            target.y,
            dimensions,
            targetIsBuilding ? 1.05 : isVehicleUnit(target) ? 0.72 : 0.78,
          ),
          phase: deterministicNoise(unit.x, unit.y, unit.attackStream?.startedTick ?? 0) * Math.PI * 2,
        }];
      });
  }, [buildings, dimensions, units]);
  const instanceCount = streams.length * FLAME_STREAM_NOZZLES * FLAME_STREAM_SEGMENTS;
  const scratch = useMemo(() => ({
    matrix: new THREE.Matrix4(),
    position: new THREE.Vector3(),
    scale: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    direction: new THREE.Vector3(),
    segmentDirection: new THREE.Vector3(),
    perpendicular: new THREE.Vector3(),
    source: new THREE.Vector3(),
    target: new THREE.Vector3(),
    nozzle: new THREE.Vector3(),
    up: new THREE.Vector3(0, 1, 0),
  }), []);

  useEffect(() => {
    gl.domElement.dataset.flameStreams = String(streams.length);
    return () => {
      delete gl.domElement.dataset.flameStreams;
    };
  }, [gl, streams.length]);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const core = coreRef.current;
    if (!outer || !core) return;
    for (let index = 0; index < instanceCount; index++) {
      const segment = index % FLAME_STREAM_SEGMENTS;
      const heat = segment / Math.max(1, FLAME_STREAM_SEGMENTS - 1);
      outer.setColorAt(index, new THREE.Color().setHSL(0.065 - heat * 0.035, 1, 0.55 - heat * 0.08));
      core.setColorAt(index, new THREE.Color().setHSL(0.13 - heat * 0.04, 1, 0.82 - heat * 0.14));
    }
    if (outer.instanceColor) outer.instanceColor.needsUpdate = true;
    if (core.instanceColor) core.instanceColor.needsUpdate = true;
  }, [instanceCount]);

  useFrame(({ clock }) => {
    const outer = outerRef.current;
    const core = coreRef.current;
    if (!outer || !core) return;
    const elapsed = clock.elapsedTime;
    let instanceIndex = 0;

    for (const stream of streams) {
      const sourceVisual = visualWorld.getTransform(stream.sourceId);
      const targetVisual = stream.targetId ? visualWorld.getTransform(stream.targetId) : undefined;
      scratch.source.set(
        sourceVisual ? (sourceVisual.x - (dimensions.width - 1) / 2) * CELL_SIZE : stream.source[0],
        stream.source[1],
        sourceVisual ? (sourceVisual.y - (dimensions.height - 1) / 2) * CELL_SIZE : stream.source[2],
      );
      scratch.target.set(
        targetVisual ? (targetVisual.x - (dimensions.width - 1) / 2) * CELL_SIZE : stream.target[0],
        stream.target[1],
        targetVisual ? (targetVisual.y - (dimensions.height - 1) / 2) * CELL_SIZE : stream.target[2],
      );
      scratch.direction.copy(scratch.target).sub(scratch.source).normalize();
      scratch.perpendicular.set(-scratch.direction.z, 0, scratch.direction.x).normalize();

      for (let nozzleIndex = 0; nozzleIndex < FLAME_STREAM_NOZZLES; nozzleIndex++) {
        const nozzleSide = nozzleIndex === 0 ? -1 : 1;
        scratch.nozzle.copy(scratch.source)
          .addScaledVector(scratch.direction, 0.72)
          .addScaledVector(scratch.perpendicular, nozzleSide * 0.12);
        const streamLength = scratch.nozzle.distanceTo(scratch.target);
        const segmentLength = Math.max(0.08, streamLength / FLAME_STREAM_SEGMENTS * 1.62);

        for (let segment = 0; segment < FLAME_STREAM_SEGMENTS; segment++) {
          const t = (segment + 0.5) / FLAME_STREAM_SEGMENTS;
          const pulse = elapsed * 11 - segment * 1.15 + stream.phase + nozzleIndex * 0.8;
          const jitter = (0.018 + t * 0.075) * Math.sin(pulse);
          scratch.position.copy(scratch.nozzle).lerp(scratch.target, t)
            .addScaledVector(scratch.perpendicular, jitter);
          scratch.position.y += Math.cos(pulse * 0.73) * (0.012 + t * 0.045);
          scratch.segmentDirection.copy(scratch.target).sub(scratch.nozzle).normalize();
          scratch.quaternion.setFromUnitVectors(scratch.up, scratch.segmentDirection);

          const tipEnvelope = t > 0.84 ? Math.max(0.22, (1 - t) / 0.16) : 1;
          const outerRadius = (0.09 + t * 0.3) * tipEnvelope * (0.9 + Math.sin(pulse * 0.61) * 0.1);
          scratch.scale.set(outerRadius, segmentLength, outerRadius);
          scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale);
          outer.setMatrixAt(instanceIndex, scratch.matrix);

          const coreRadius = (0.045 + t * 0.12) * tipEnvelope * (0.92 + Math.cos(pulse * 0.77) * 0.08);
          scratch.scale.set(coreRadius, segmentLength * 0.82, coreRadius);
          scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale);
          core.setMatrixAt(instanceIndex, scratch.matrix);
          instanceIndex++;
        }
      }
    }

    outer.instanceMatrix.needsUpdate = true;
    core.instanceMatrix.needsUpdate = true;
  }, -9);

  if (instanceCount === 0) return null;
  return (
    <>
      <instancedMesh ref={outerRef} args={[undefined, undefined, instanceCount]} frustumCulled={false} renderOrder={8}>
        <cylinderGeometry args={[1, 1, 1, 8, 1, true]} />
        <meshBasicMaterial transparent opacity={0.68} blending={THREE.AdditiveBlending} toneMapped={false} depthWrite={false} />
      </instancedMesh>
      <instancedMesh ref={coreRef} args={[undefined, undefined, instanceCount]} frustumCulled={false} renderOrder={9}>
        <cylinderGeometry args={[1, 1, 1, 7, 1, true]} />
        <meshBasicMaterial transparent opacity={0.9} blending={THREE.AdditiveBlending} toneMapped={false} depthWrite={false} />
      </instancedMesh>
    </>
  );
}

function DemolitionChargeEffects({
  projectiles,
  buildings,
  dimensions,
}: {
  projectiles: ActiveProjectile[];
  buildings: Building[];
  dimensions: MapDimensions;
}) {
  const chargeRef = useRef<THREE.InstancedMesh>(null);
  const ringRef = useRef<THREE.InstancedMesh>(null);
  const charges = useMemo(() => {
    const buildingIds = new Set(buildings.map((building) => building.id));
    return projectiles
      .filter((projectile) =>
        projectile.projectileType === "demolition"
        && projectile.targetId
        && buildingIds.has(projectile.targetId)
      )
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((projectile) => ({
        id: projectile.id,
        position: toWorldPosition(projectile.targetX, projectile.targetY, dimensions, 1.48),
        phase: deterministicNoise(projectile.targetX, projectile.targetY, projectile.launchedTick) * Math.PI * 2,
      }));
  }, [buildings, dimensions, projectiles]);
  const scratch = useMemo(() => ({
    matrix: new THREE.Matrix4(),
    position: new THREE.Vector3(),
    scale: new THREE.Vector3(),
    chargeQuaternion: new THREE.Quaternion(),
    ringQuaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)),
    up: new THREE.Vector3(0, 1, 0),
  }), []);

  useFrame(({ clock }) => {
    const charge = chargeRef.current;
    const ring = ringRef.current;
    if (!charge || !ring) return;
    charges.forEach((entry, index) => {
      const pulse = 0.88 + Math.sin(clock.elapsedTime * 18 + entry.phase) * 0.16;
      scratch.position.set(...entry.position);
      scratch.chargeQuaternion.setFromAxisAngle(scratch.up, clock.elapsedTime * 2.4 + entry.phase);
      scratch.scale.set(0.32 * pulse, 0.16 * pulse, 0.46 * pulse);
      scratch.matrix.compose(scratch.position, scratch.chargeQuaternion, scratch.scale);
      charge.setMatrixAt(index, scratch.matrix);

      scratch.position.y += 0.03;
      scratch.scale.setScalar(0.48 + pulse * 0.12);
      scratch.matrix.compose(scratch.position, scratch.ringQuaternion, scratch.scale);
      ring.setMatrixAt(index, scratch.matrix);
    });
    charge.instanceMatrix.needsUpdate = true;
    ring.instanceMatrix.needsUpdate = true;
  }, -8);

  if (charges.length === 0) return null;
  return (
    <>
      <instancedMesh ref={chargeRef} args={[undefined, undefined, charges.length]} frustumCulled={false} renderOrder={10}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#252b28" emissive="#ff4b16" emissiveIntensity={1.1} roughness={0.46} metalness={0.35} />
      </instancedMesh>
      <instancedMesh ref={ringRef} args={[undefined, undefined, charges.length]} frustumCulled={false} renderOrder={11}>
        <torusGeometry args={[0.46, 0.07, 8, 18]} />
        <meshBasicMaterial color="#ffb21c" transparent opacity={0.9} blending={THREE.AdditiveBlending} toneMapped={false} depthWrite={false} />
      </instancedMesh>
    </>
  );
}

function deterministicNoise(x: number, y: number, salt: number): number {
  const value = Math.sin(x * 12.9898 + y * 78.233 + salt * 37.719) * 43758.5453;
  return value - Math.floor(value);
}

function getHeading(object: Unit): number {
  const targetX = object.intent?.targetX;
  const targetY = object.intent?.targetY;
  if (targetX === undefined || targetY === undefined) {
    return object.playerId === "player_1" ? Math.PI / 2 : -Math.PI / 2;
  }
  return Math.atan2(targetX - object.x, targetY - object.y);
}

function getBodyHeading(unit: Unit): number {
  if (isVehicleUnit(unit) && unit.heading !== undefined) {
    return Math.PI - unit.heading;
  }
  return getHeading(unit) + (isVehicleUnit(unit) ? TANK_FORWARD_OFFSET : 0);
}

function getAimHeading(unit: Unit, objectPositions: Map<string, { x: number; y: number }>): number {
  const target = unit.intent?.targetId ? objectPositions.get(unit.intent.targetId) : undefined;
  if (target) {
    return Math.atan2(target.x - unit.x, target.y - unit.y) + TANK_FORWARD_OFFSET;
  }
  return getHeading(unit) + TANK_FORWARD_OFFSET;
}

function cloneMaterial(material: THREE.Material, palette?: TeamPalette): THREE.Material {
  const cloned = material.clone();
  const materialName = material.name.replace(/\.\d+$/, "");

  if (cloned instanceof THREE.MeshStandardMaterial) {
    if (materialName === "team_primary" && palette) {
      cloned.color.set(palette.primary).lerp(new THREE.Color("#bfc1b8"), 0.44);
      cloned.emissive.set(palette.primary);
      cloned.emissiveIntensity = 0.025;
    } else if (materialName === "team_accent" && palette) {
      cloned.color.set(palette.accent).lerp(new THREE.Color("#c3c8c3"), 0.34);
      cloned.emissive.set(palette.accent);
      cloned.emissiveIntensity = 0.12;
    } else if (materialName === "glass_emissive") {
      cloned.emissiveIntensity = 0.65;
    } else if (materialName === "resource_gold") {
      cloned.color.set("#c48a2d");
      cloned.emissive.set("#8a4a0f");
      cloned.emissiveIntensity = 0.14;
    }
  }

  return cloned;
}

function cloneModel(scene: THREE.Object3D, palette?: TeamPalette): THREE.Object3D {
  const clone = scene.clone(true);

  clone.traverse((child) => {
    const mesh = child as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
    if (!mesh.isMesh) {
      return;
    }

    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map((material) => cloneMaterial(material, palette))
      : cloneMaterial(mesh.material, palette);
  });

  return clone;
}

function ModelInstance({
  url,
  palette,
  position,
  rotation = [0, 0, 0],
  scale = 1,
}: {
  url: string;
  palette?: TeamPalette;
  position: Vec3;
  rotation?: Vec3;
  scale?: number;
}) {
  const { scene } = useGLTF(url) as { scene: THREE.Object3D };
  const model = useMemo(
    () => cloneModel(scene, palette),
    [palette?.accent, palette?.primary, scene],
  );

  return <primitive object={model} position={position} rotation={rotation} scale={scale} />;
}

function TraversingModelInstance({
  url,
  palette,
  heading,
}: {
  url: string;
  palette: TeamPalette;
  heading: number;
}) {
  const { scene } = useGLTF(url) as { scene: THREE.Object3D };
  const model = useMemo(
    () => cloneModel(scene, palette),
    [palette.accent, palette.primary, scene],
  );
  const groupRef = useRef<THREE.Group>(null);
  const initialHeading = useRef(heading);
  const targetHeading = useRef(heading);
  targetHeading.current = heading;

  useFrame((_, delta) => {
    const group = groupRef.current;
    if (!group) return;
    const difference = Math.atan2(
      Math.sin(targetHeading.current - group.rotation.y),
      Math.cos(targetHeading.current - group.rotation.y),
    );
    const step = Math.min(Math.abs(difference), delta * 4.2);
    group.rotation.y += Math.sign(difference) * step;
  }, -35);

  return (
    <group ref={groupRef} rotation={[0, initialHeading.current, 0]}>
      <primitive object={model} />
    </group>
  );
}

function InstancedPart({
  part,
  transforms,
  castShadow,
  visualWorld,
  dimensions,
  onEntityHover,
  onEntityLeave,
}: {
  part: InstancedModelPart;
  transforms: ModelTransform[];
  castShadow: boolean;
  visualWorld?: VisualWorld;
  dimensions?: MapDimensions;
  onEntityHover?: EntityHoverHandler;
  onEntityLeave?: () => void;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const scratch = useMemo(() => ({
    rootMatrix: new THREE.Matrix4(),
    finalMatrix: new THREE.Matrix4(),
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    rotation: new THREE.Euler(),
    scale: new THREE.Vector3(),
  }), []);
  const isDynamic = useMemo(
    () => transforms.some((transform) =>
      transform.entityId !== undefined ||
      (transform.motionAmplitude ?? 0) > 0
      || (transform.recoilAmplitude ?? 0) > 0
      || (transform.timedRecoilAmplitude ?? 0) > 0
      || (transform.swayAmplitude ?? 0) > 0),
    [transforms],
  );

  const updateMatrices = (elapsed: number) => {
    const mesh = meshRef.current;
    if (!mesh) {
      return;
    }

    transforms.forEach((transform, index) => {
      const motion = transform.motionAmplitude ?? 0;
      const phase = transform.motionPhase ?? 0;
      const motionFrequency = transform.motionFrequency ?? 5.2;
      const swayFrequency = transform.swayFrequency ?? 4.6;
      const recoilPulse = Math.pow(Math.max(0, Math.sin(elapsed * 11 + phase)), 10)
        * (transform.recoilAmplitude ?? 0);
      const cycleMs = transform.timedRecoilCycleMs ?? 0;
      const timedRecoilAtMs = transform.timedRecoilAtMs ?? 0;
      const timedRecoilWidthMs = transform.timedRecoilWidthMs ?? 160;
      const timedLocalMs = cycleMs > 0
        ? ((elapsed * 1000 + (transform.timedRecoilPhaseMs ?? 0)) % cycleMs + cycleMs) % cycleMs
        : -1;
      const timedRecoilProgress = timedLocalMs >= timedRecoilAtMs && timedLocalMs <= timedRecoilAtMs + timedRecoilWidthMs
        ? (timedLocalMs - timedRecoilAtMs) / Math.max(1, timedRecoilWidthMs)
        : -1;
      const timedRecoilPulse = timedRecoilProgress >= 0
        ? Math.sin(timedRecoilProgress * Math.PI) * (transform.timedRecoilAmplitude ?? 0)
        : 0;
      const totalRecoilPulse = recoilPulse + timedRecoilPulse;
      const sway = Math.sin(elapsed * swayFrequency + phase) * (transform.swayAmplitude ?? 0);
      const visual = transform.entityId ? visualWorld?.getTransform(transform.entityId) : undefined;
      const heading = visual && transform.visualRotation !== "fixed"
        ? transform.visualRotation === "aim" ? visual.aimHeading : visual.bodyHeading
        : transform.rotation[1];
      const positionX = visual && dimensions
        ? (visual.x - (dimensions.width - 1) / 2) * CELL_SIZE
        : transform.position[0];
      const positionZ = visual && dimensions
        ? (visual.y - (dimensions.height - 1) / 2) * CELL_SIZE
        : transform.position[2];
      scratch.position.set(
        positionX - Math.sin(heading) * totalRecoilPulse,
        transform.position[1] + Math.abs(Math.sin(elapsed * motionFrequency + phase)) * motion,
        positionZ - Math.cos(heading) * totalRecoilPulse,
      );
      scratch.rotation.set(transform.rotation[0], heading, transform.rotation[2] + sway);
      scratch.quaternion.setFromEuler(scratch.rotation);
      scratch.scale.setScalar(transform.scale);
      scratch.rootMatrix.compose(scratch.position, scratch.quaternion, scratch.scale);
      scratch.finalMatrix.multiplyMatrices(scratch.rootMatrix, part.localMatrix);
      mesh.setMatrixAt(index, scratch.finalMatrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  };

  useLayoutEffect(() => {
    updateMatrices(performance.now() / 1000);
  }, [part.localMatrix, transforms]);

  useFrame(({ clock }) => {
    if (isDynamic) updateMatrices(clock.getElapsedTime());
  }, -40);

  return (
    <instancedMesh
      ref={meshRef}
      args={[part.geometry, part.material, transforms.length]}
      castShadow={castShadow}
      receiveShadow
      frustumCulled={!isDynamic}
      onPointerMove={onEntityHover ? (event: ThreeEvent<PointerEvent>) => {
        const entityId = event.instanceId === undefined
          ? undefined
          : transforms[event.instanceId]?.entityId;
        if (!entityId) return;
        event.stopPropagation();
        onEntityHover(entityId, event.nativeEvent.clientX, event.nativeEvent.clientY);
      } : undefined}
      onPointerOut={onEntityLeave ? (event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        onEntityLeave();
      } : undefined}
    />
  );
}

function InstancedModelBatch({
  url,
  palette,
  transforms,
  castShadow = false,
  visualWorld,
  dimensions,
  onEntityHover,
  onEntityLeave,
}: {
  url: string;
  palette: TeamPalette;
  transforms: ModelTransform[];
  castShadow?: boolean;
  visualWorld?: VisualWorld;
  dimensions?: MapDimensions;
  onEntityHover?: EntityHoverHandler;
  onEntityLeave?: () => void;
}) {
  const { scene } = useGLTF(url) as { scene: THREE.Object3D };
  const parts = useMemo(() => {
    scene.updateMatrixWorld(true);
    const nextParts: InstancedModelPart[] = [];

    scene.traverse((child) => {
      const mesh = child as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
      if (!mesh.isMesh) {
        return;
      }

      nextParts.push({
        geometry: mesh.geometry,
        material: Array.isArray(mesh.material)
          ? mesh.material.map((sourceMaterial) => cloneMaterial(sourceMaterial, palette))
          : cloneMaterial(mesh.material, palette),
        localMatrix: mesh.matrixWorld.clone(),
      });
    });

    return nextParts;
  }, [palette.accent, palette.primary, scene]);

  return (
    <>
      {parts.map((part, index) => (
        <InstancedPart
          key={`${part.geometry.uuid}-${index}`}
          part={part}
          transforms={transforms}
          castShadow={castShadow}
          visualWorld={visualWorld}
          dimensions={dimensions}
          onEntityHover={onEntityHover}
          onEntityLeave={onEntityLeave}
        />
      ))}
    </>
  );
}

function HealthBar({
  hp,
  maxHp,
  color,
  width,
  y,
}: {
  hp: number;
  maxHp: number;
  color: string;
  width: number;
  y: number;
}) {
  const ratio = Math.max(0, Math.min(1, hp / Math.max(1, maxHp)));

  return (
    <Billboard position={[0, y, 0]}>
      <mesh>
        <boxGeometry args={[width, 0.08, 0.03]} />
        <meshBasicMaterial color="#11161b" />
      </mesh>
      <mesh position={[-(width * (1 - ratio)) / 2, 0.006, 0.02]}>
        <boxGeometry args={[width * ratio, 0.07, 0.035]} />
        <meshBasicMaterial color={color} />
      </mesh>
    </Billboard>
  );
}

function getUnitHealthBarY(unit: Unit): number {
  switch (unit.type) {
    case UNIT_TYPES.LIGHT_TANK:
      return 2.22;
    case UNIT_TYPES.FLAME_TANK:
      return 2.28;
    case UNIT_TYPES.HEAVY_TANK:
      return 2.76;
    default:
      return 1.7;
  }
}

function getResourceClusterTransforms(tile: Tile, dimensions: MapDimensions): ModelTransform[] {
  const basePosition = toWorldPosition(tile.x, tile.y, dimensions, 0.02);
  const count = 10;
  return Array.from({ length: count }, (_, index) => {
    const angle = deterministicNoise(tile.x, tile.y, 20 + index) * Math.PI * 2;
    const radius = index === 0 ? 0 : CELL_SIZE * (0.22 + deterministicNoise(tile.x, tile.y, 30 + index) * 0.74);
    const scale = (index === 0 ? 1.65 : 0.86) + deterministicNoise(tile.x, tile.y, 40 + index) * 0.54;
    return {
      position: [
        basePosition[0] + Math.cos(angle) * radius,
        basePosition[1],
        basePosition[2] + Math.sin(angle) * radius,
      ],
      rotation: [0, ((tile.x * 13 + tile.y * 7 + index * 43) % 360) * (Math.PI / 180), 0],
      scale,
    };
  });
}

function getRockTransform(tile: Tile, dimensions: MapDimensions): ModelTransform | null {
  const density = deterministicNoise(tile.x, tile.y, 3);
  if (density < 0.52) {
    return null;
  }

  const basePosition = toWorldPosition(tile.x, tile.y, dimensions, 0);
  const jitterX = (deterministicNoise(tile.x, tile.y, 4) - 0.5) * CELL_SIZE * 0.44;
  const jitterZ = (deterministicNoise(tile.x, tile.y, 5) - 0.5) * CELL_SIZE * 0.44;
  const scale = 0.34 + deterministicNoise(tile.x, tile.y, 6) * 0.46;

  return {
    position: [basePosition[0] + jitterX, 0, basePosition[2] + jitterZ],
    rotation: [0, ((tile.x * 17 + tile.y * 11) % 360) * (Math.PI / 180), 0],
    scale,
  };
}

function useRepeatedTexture(url: string, repeatX: number, repeatY: number, nonColor = false) {
  const source = useTexture(url);
  return useMemo(() => {
    const texture = source.clone();
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(repeatX, repeatY);
    texture.anisotropy = 8;
    texture.colorSpace = nonColor ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }, [nonColor, repeatX, repeatY, source]);
}

function BattlefieldGround({ width, height }: { width: number; height: number }) {
  const terrainRepeatX = Math.max(1, width / 52);
  const terrainRepeatY = Math.max(1, height / 52);
  const terrainMap = useRepeatedTexture(`${TEXTURE_ROOT}/terrain_industrial_albedo.jpg`, terrainRepeatX, terrainRepeatY);
  const terrainNormal = useRepeatedTexture(`${TEXTURE_ROOT}/terrain_industrial_normal.jpg`, terrainRepeatX, terrainRepeatY, true);
  const terrainRoughness = useRepeatedTexture(`${TEXTURE_ROOT}/terrain_industrial_roughness.jpg`, terrainRepeatX, terrainRepeatY, true);
  const outerTerrainMap = useRepeatedTexture(`${TEXTURE_ROOT}/terrain_industrial_albedo.jpg`, terrainRepeatX * 2.6, terrainRepeatY * 2.6);
  const outerTerrainNormal = useRepeatedTexture(`${TEXTURE_ROOT}/terrain_industrial_normal.jpg`, terrainRepeatX * 2.6, terrainRepeatY * 2.6, true);
  const outerTerrainRoughness = useRepeatedTexture(`${TEXTURE_ROOT}/terrain_industrial_roughness.jpg`, terrainRepeatX * 2.6, terrainRepeatY * 2.6, true);

  return (
    <>
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[width, height]} />
        <meshStandardMaterial
          map={terrainMap}
          normalMap={terrainNormal}
          normalScale={new THREE.Vector2(0.68, 0.68)}
          roughnessMap={terrainRoughness}
          roughness={0.94}
          metalness={0.01}
        />
      </mesh>
      <mesh receiveShadow position={[0, -0.055, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[width * 2.6, height * 2.6]} />
        <meshStandardMaterial
          map={outerTerrainMap}
          normalMap={outerTerrainNormal}
          normalScale={new THREE.Vector2(0.35, 0.35)}
          roughnessMap={outerTerrainRoughness}
          roughness={0.98}
          color="#ffffff"
        />
      </mesh>
    </>
  );
}

function BasePlatform({
  building,
  dimensions,
}: {
  building: Building;
  dimensions: MapDimensions;
}) {
  if (building.type !== "hq") {
    return null;
  }

  const color = getPlayerColor(building.playerId);
  const hqRadius = ENTITY_GEOMETRY.buildingBodies.hq.width * CELL_SIZE * 0.5;
  return (
    <group position={toWorldPosition(building.x, building.y, dimensions, 0.018)}>
      <mesh receiveShadow>
        <cylinderGeometry args={[hqRadius, hqRadius, 0.08, 12]} />
        <meshStandardMaterial color="#1a211e" roughness={0.86} metalness={0.05} />
      </mesh>
      <mesh position={[0, 0.055, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[hqRadius * 0.76, hqRadius * 0.84, 12]} />
        <meshBasicMaterial color={color} transparent opacity={0.38} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

function getUnitModelUrl(unit: Unit, massBattleLod: boolean): string {
  if (unit.type === "commando") {
    return massBattleLod ? MODEL_URLS.commando_lod : MODEL_URLS.commando;
  }
  if (unit.type === "rocket_soldier") {
    return massBattleLod ? MODEL_URLS.rocket_soldier_lod : MODEL_URLS.rocket_soldier;
  }
  if (unit.type === "rifleman") {
    return massBattleLod ? MODEL_URLS.rifleman_lod : MODEL_URLS.rifleman;
  }
  if (unit.type === "worker") {
    return massBattleLod ? MODEL_URLS.worker_lod : MODEL_URLS.worker;
  }
  return massBattleLod ? MODEL_URLS.soldier_lod : MODEL_URLS.soldier;
}

function getVehiclePartModelUrls(
  unit: Unit,
  massBattleLod: boolean,
): { body: string; turret: string } {
  switch (unit.type) {
    case UNIT_TYPES.FLAME_TANK:
      return {
        body: massBattleLod ? MODEL_URLS.flame_tank_body_lod : MODEL_URLS.flame_tank_body,
        turret: massBattleLod ? MODEL_URLS.flame_tank_turret_lod : MODEL_URLS.flame_tank_turret,
      };
    case UNIT_TYPES.HEAVY_TANK:
      return {
        body: massBattleLod ? MODEL_URLS.heavy_tank_body_lod : MODEL_URLS.heavy_tank_body,
        turret: massBattleLod ? MODEL_URLS.heavy_tank_turret_lod : MODEL_URLS.heavy_tank_turret,
      };
    default:
      return {
        body: massBattleLod ? MODEL_URLS.light_tank_body_lod : MODEL_URLS.light_tank_body,
        turret: massBattleLod ? MODEL_URLS.light_tank_turret_lod : MODEL_URLS.light_tank_turret,
      };
  }
}

function getUnitMotionProfile(unit: Unit, moving: boolean, firing: boolean): Pick<ModelTransform, "motionAmplitude" | "motionFrequency" | "swayAmplitude" | "swayFrequency" | "recoilAmplitude"> {
  if (isVehicleUnit(unit)) {
    return {
      motionAmplitude: 0,
      swayAmplitude: 0,
      recoilAmplitude: firing ? 0 : 0,
    };
  }

  if (unit.type === "worker") {
    const working = unit.intent?.type === "harvest_loop" || unit.intent?.type === "gather" || unit.intent?.type === "deposit" || unit.state === "gathering";
    if (working && !moving) {
      return {
        motionAmplitude: 0,
        motionFrequency: 1.2,
        swayAmplitude: 0.003,
        swayFrequency: 1.15,
        recoilAmplitude: 0,
      };
    }

    return {
      motionAmplitude: moving ? 0.006 : 0,
      motionFrequency: 2.2,
      swayAmplitude: moving ? 0.003 : 0,
      swayFrequency: 1.9,
      recoilAmplitude: 0,
    };
  }

  return {
    motionAmplitude: moving ? 0.01 : 0,
    motionFrequency: 3.2,
    swayAmplitude: moving ? 0.004 : 0,
    swayFrequency: 2.8,
    recoilAmplitude: firing ? 0.04 : 0,
  };
}

function getPreviewFxTimedRecoil(unitId: string): Pick<
  ModelTransform,
  "timedRecoilAmplitude" | "timedRecoilAtMs" | "timedRecoilCycleMs" | "timedRecoilPhaseMs" | "timedRecoilWidthMs"
> {
  const sourceShot = PREVIEW_FX_SHOT_SPECS.find((shot) => shot.sourceId === unitId);
  if (sourceShot) {
    return {
      timedRecoilAmplitude: sourceShot.projectileType === "shell" ? 0.11 : 0.052,
      timedRecoilAtMs: 0,
      timedRecoilCycleMs: sourceShot.durationMs + PREVIEW_FX_CYCLE_GAP_MS,
      timedRecoilPhaseMs: sourceShot.phase * 1000,
      timedRecoilWidthMs: sourceShot.projectileType === "shell" ? 190 : 120,
    };
  }

  const targetShot = PREVIEW_FX_SHOT_SPECS.find((shot) => shot.targetId === unitId);
  if (targetShot) {
    return {
      timedRecoilAmplitude: targetShot.projectileType === "bullet" ? 0.035 : 0.075,
      timedRecoilAtMs: targetShot.durationMs,
      timedRecoilCycleMs: targetShot.durationMs + PREVIEW_FX_CYCLE_GAP_MS,
      timedRecoilPhaseMs: targetShot.phase * 1000,
      timedRecoilWidthMs: targetShot.projectileType === "bullet" ? 105 : 150,
    };
  }

  return {};
}

function UnitBatches({
  units,
  buildings,
  dimensions,
  tick,
  visualWorld,
  onEntityHover,
  onEntityLeave,
}: {
  units: Unit[];
  buildings: Building[];
  dimensions: MapDimensions;
  tick: number;
  visualWorld: VisualWorld;
  onEntityHover: EntityHoverHandler;
  onEntityLeave: () => void;
}) {
  const objectPositions = useMemo(() => new Map(
    [...units, ...buildings].map((object) => [object.id, { x: object.x, y: object.y }]),
  ), [buildings, units]);
  const batches = useMemo(() => {
    const grouped = new Map<string, { url: string; palette: TeamPalette; transforms: ModelTransform[] }>();
    const massBattleLod = MASS_BATTLE_LOD_ENABLED;

    for (const [index, unit] of units.entries()) {
      const moving = unit.state === "moving" || unit.intent?.type === "move" || unit.intent?.type === "attack_move";
      const firing = unit.lastAttackTick !== undefined && tick - unit.lastAttackTick <= 1;
      const motionProfile = getUnitMotionProfile(unit, moving, firing);
      const previewFxTimedRecoil = getPreviewFxTimedRecoil(unit.id);
      const baseTransform: ModelTransform = {
        entityId: unit.id,
        visualRotation: "body",
        position: toWorldPosition(unit.x, unit.y, dimensions, 0.08),
        rotation: [0, getBodyHeading(unit), 0],
        scale: CELL_SIZE,
        motionAmplitude: motionProfile.motionAmplitude,
        motionFrequency: motionProfile.motionFrequency,
        motionPhase: index * 1.73 + (unit.playerId === "player_1" ? 0 : 0.8),
        recoilAmplitude: motionProfile.recoilAmplitude,
        ...previewFxTimedRecoil,
        swayAmplitude: motionProfile.swayAmplitude,
        swayFrequency: motionProfile.swayFrequency,
      };

      const addToBatch = (url: string, transform: ModelTransform) => {
        const key = `${unit.playerId}:${url}`;
        const batch = grouped.get(key) ?? {
          url,
          palette: getTeamPalette(unit.playerId),
          transforms: [],
        };
        batch.transforms.push(transform);
        grouped.set(key, batch);
      };

      if (isVehicleUnit(unit)) {
        const vehicleModels = getVehiclePartModelUrls(unit, massBattleLod);
        addToBatch(vehicleModels.body, baseTransform);
        addToBatch(vehicleModels.turret, {
          ...baseTransform,
          visualRotation: "aim",
          rotation: [0, getAimHeading(unit, objectPositions), 0],
          recoilAmplitude: firing ? 0.09 : 0,
        });
      } else {
        addToBatch(getUnitModelUrl(unit, massBattleLod), baseTransform);
      }
    }

    return [...grouped.entries()];
  }, [dimensions, objectPositions, tick, units]);

  return (
    <>
      {batches.map(([key, batch]) => (
        <InstancedModelBatch
          key={key}
          url={batch.url}
          palette={batch.palette}
          transforms={batch.transforms}
          castShadow
          visualWorld={visualWorld}
          dimensions={dimensions}
          onEntityHover={onEntityHover}
          onEntityLeave={onEntityLeave}
        />
      ))}
      {units
        .filter((unit) => unit.hp < unit.maxHp)
        .map((unit) => {
          const palette = getTeamPalette(unit.playerId);
          return (
            <VisualUnitAnchor
              key={`health-${unit.id}`}
              entityId={unit.id}
              visualWorld={visualWorld}
              dimensions={dimensions}
              elevation={0.08}
              scale={CELL_SIZE}
            >
              <HealthBar
                hp={unit.hp}
                maxHp={unit.maxHp}
                color={palette.primary}
                width={isVehicleUnit(unit) ? 1.25 : 0.82}
                y={getUnitHealthBarY(unit)}
              />
            </VisualUnitAnchor>
          );
        })}
    </>
  );
}

function GroundRingBatch({
  units,
  dimensions,
  color,
  visualWorld,
  onEntityHover,
  onEntityLeave,
}: {
  units: Unit[];
  dimensions: MapDimensions;
  color: string;
  visualWorld: VisualWorld;
  onEntityHover: EntityHoverHandler;
  onEntityLeave: () => void;
}) {
  const geometry = useMemo(() => new THREE.RingGeometry(0.48, 0.64, 24), []);
  const material = useMemo(() => new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    side: THREE.DoubleSide,
  }), [color]);
  const part = useMemo<InstancedModelPart>(() => ({
    geometry,
    material,
    localMatrix: new THREE.Matrix4(),
  }), [geometry, material]);
  const hitPart = useMemo<InstancedModelPart>(() => ({
    geometry: new THREE.CircleGeometry(0.76, 24),
    material: new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      colorWrite: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
    localMatrix: new THREE.Matrix4(),
  }), []);
  const transforms = useMemo<ModelTransform[]>(() => units.map((unit) => ({
    entityId: unit.id,
    visualRotation: "fixed",
    position: toWorldPosition(unit.x, unit.y, dimensions, 0.035),
    rotation: [-Math.PI / 2, 0, 0],
    scale: isVehicleUnit(unit) ? 1.22 : 0.72,
  })), [dimensions, units]);

  return (
    <>
      <InstancedPart
        part={part}
        transforms={transforms}
        castShadow={false}
        visualWorld={visualWorld}
        dimensions={dimensions}
      />
      <InstancedPart
        part={hitPart}
        transforms={transforms}
        castShadow={false}
        visualWorld={visualWorld}
        dimensions={dimensions}
        onEntityHover={onEntityHover}
        onEntityLeave={onEntityLeave}
      />
    </>
  );
}

function UnitReadabilityLayer({
  units,
  dimensions,
  visualWorld,
  onEntityHover,
  onEntityLeave,
}: {
  units: Unit[];
  dimensions: MapDimensions;
  visualWorld: VisualWorld;
  onEntityHover: EntityHoverHandler;
  onEntityLeave: () => void;
}) {
  const teamGroups = useMemo(() => {
    const groups = new Map<string, Unit[]>();
    for (const unit of units) {
      const group = groups.get(unit.playerId) ?? [];
      group.push(unit);
      groups.set(unit.playerId, group);
    }
    return [...groups.entries()];
  }, [units]);

  return (
    <>
      {teamGroups.map(([playerId, teamUnits]) => (
        <GroundRingBatch
          key={`rings-${playerId}`}
          units={teamUnits}
          dimensions={dimensions}
          color={getPlayerColor(playerId)}
          visualWorld={visualWorld}
          onEntityHover={onEntityHover}
          onEntityLeave={onEntityLeave}
        />
      ))}
    </>
  );
}

function getProjectileVisualType(unitType: Unit["type"]): ActiveProjectile["projectileType"] {
  if (unitType === "rocket_soldier") {
    return "rocket";
  }
  if (VEHICLE_UNIT_TYPES.has(unitType)) {
    return "shell";
  }
  return "bullet";
}

function getProjectileVisualColor(projectileType: ActiveProjectile["projectileType"]): string {
  if (projectileType === "flame") {
    return "#fff06a";
  }
  if (projectileType === "rocket") {
    return "#ff8a2a";
  }
  if (projectileType === "shell") {
    return "#ffd36a";
  }
  return "#fff1a8";
}

function getProjectileTrailColor(projectileType: ActiveProjectile["projectileType"]): string {
  if (projectileType === "flame") {
    return "#ff5a16";
  }
  if (projectileType === "rocket") {
    return "#b7b5a7";
  }
  if (projectileType === "shell") {
    return "#f5d48a";
  }
  return "#ffe27a";
}

function getProjectileVisualScale(projectileType: ActiveProjectile["projectileType"]): number {
  if (projectileType === "flame") {
    return 0.24;
  }
  if (projectileType === "rocket") {
    return 0.19;
  }
  if (projectileType === "shell") {
    return 0.15;
  }
  return 0.075;
}

function CombatEffects({
  units,
  buildings,
  projectiles,
  dimensions,
  tick,
  visualWorld,
}: {
  units: Unit[];
  buildings: Building[];
  projectiles: ActiveProjectile[];
  dimensions: MapDimensions;
  tick: number;
  visualWorld: VisualWorld;
}) {
  const { gl } = useThree();
  const projectileRef = useRef<THREE.InstancedMesh>(null);
  const trailRef = useRef<THREE.InstancedMesh>(null);
  const muzzleRef = useRef<THREE.InstancedMesh>(null);
  const tickFrameRef = useRef({ tick, observedAtMs: performance.now() });
  const scratch = useMemo(() => ({
    matrix: new THREE.Matrix4(),
    position: new THREE.Vector3(),
    trailPosition: new THREE.Vector3(),
    scale: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    direction: new THREE.Vector3(),
    up: new THREE.Vector3(0, 1, 0),
    hiddenScale: new THREE.Vector3(0.001, 0.001, 0.001),
  }), []);
  const shots = useMemo(() => {
    const objects = new Map([...units, ...buildings].map((object) => [object.id, object]));
    const activeProjectileShots = projectiles
      .filter((projectile) => projectile.projectileType !== "flame" && projectile.projectileType !== "demolition")
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((projectile, index): CombatShot => {
        const totalTicks = Math.max(1, projectile.impactTick - projectile.launchedTick);
        const progress = Math.min(1, Math.max(0, (tick - projectile.launchedTick) / totalTicks));
        const height = projectile.projectileType === "shell" ? 1.16 : projectile.projectileType === "rocket" ? 1.05 : 0.94;
        return {
          projectileType: projectile.projectileType,
          source: toWorldPosition(projectile.startX, projectile.startY, dimensions, height),
          current: toWorldPosition(projectile.x, projectile.y, dimensions, height),
          target: toWorldPosition(projectile.targetX, projectile.targetY, dimensions, height),
          color: getProjectileVisualColor(projectile.projectileType),
          trailColor: getProjectileTrailColor(projectile.projectileType),
          scale: getProjectileVisualScale(projectile.projectileType),
          phase: deterministicNoise(projectile.startX, projectile.startY, tick + index) * 0.9,
          progress,
          totalTicks,
        };
      });
    if (activeProjectileShots.length > 0) {
      return activeProjectileShots;
    }

    return units
      .filter((unit) => unit.type !== UNIT_TYPES.FLAME_TANK && unit.lastAttackTick !== undefined && tick - unit.lastAttackTick <= 1 && unit.intent?.targetId)
      .sort((left, right) => left.id.localeCompare(right.id))
      .flatMap((unit, index): CombatShot[] => {
        const target = unit.intent?.targetId ? objects.get(unit.intent.targetId) : undefined;
        if (!target) {
          return [];
        }
        const sourceHeight = isVehicleUnit(unit) ? 1.02 : 0.96;
        const targetHeight = "productionQueue" in target ? 1.4 : VEHICLE_UNIT_TYPES.has(target.type) ? 0.76 : 0.82;
        const projectileType = getProjectileVisualType(unit.type);
        return [{
          sourceEntityId: unit.id,
          targetEntityId: "productionQueue" in target ? undefined : target.id,
          sourceElevation: sourceHeight,
          targetElevation: targetHeight,
          projectileType,
          source: toWorldPosition(unit.x, unit.y, dimensions, sourceHeight),
          target: toWorldPosition(target.x, target.y, dimensions, targetHeight),
          color: getProjectileVisualColor(projectileType),
          trailColor: getProjectileTrailColor(projectileType),
          scale: getProjectileVisualScale(projectileType),
          phase: deterministicNoise(unit.x, unit.y, tick + index) * 0.9,
        }];
      });
  }, [buildings, dimensions, projectiles, tick, units]);

  useEffect(() => {
    gl.domElement.dataset.combatShots = String(shots.length);
  }, [gl, shots.length]);

  useEffect(() => {
    tickFrameRef.current = { tick, observedAtMs: performance.now() };
  }, [tick]);

  useLayoutEffect(() => {
    const projectile = projectileRef.current;
    const trail = trailRef.current;
    if (!projectile || !trail) {
      return;
    }
    shots.forEach((shot, index) => {
      projectile.setColorAt(index, new THREE.Color(shot.color));
      trail.setColorAt(index, new THREE.Color(shot.trailColor));
    });
    if (projectile.instanceColor) {
      projectile.instanceColor.needsUpdate = true;
    }
    if (trail.instanceColor) {
      trail.instanceColor.needsUpdate = true;
    }
  }, [shots]);

  useFrame(({ clock }) => {
    const projectile = projectileRef.current;
    const trail = trailRef.current;
    const muzzle = muzzleRef.current;
    if (!projectile || !trail || !muzzle) {
      return;
    }
    const elapsed = clock.getElapsedTime();
    const tickFrame = tickFrameRef.current;
    const tickFraction = tickFrame.tick === tick
      ? Math.min(0.98, Math.max(0, (performance.now() - tickFrame.observedAtMs) / TICK_INTERVAL_MS))
      : 0;
    shots.forEach((shot, index) => {
      const progress = shot.progress !== undefined
        ? Math.min(1, shot.progress + tickFraction / Math.max(1, shot.totalTicks ?? 1))
        : ((elapsed * 1.7 + shot.phase) % 1);
      const sourceVisual = shot.sourceEntityId ? visualWorld.getTransform(shot.sourceEntityId) : undefined;
      const targetVisual = shot.targetEntityId ? visualWorld.getTransform(shot.targetEntityId) : undefined;
      const sourceX = sourceVisual
        ? (sourceVisual.x - (dimensions.width - 1) / 2) * CELL_SIZE
        : shot.source[0];
      const sourceY = sourceVisual ? shot.sourceElevation ?? shot.source[1] : shot.source[1];
      const sourceZ = sourceVisual
        ? (sourceVisual.y - (dimensions.height - 1) / 2) * CELL_SIZE
        : shot.source[2];
      const targetX = targetVisual
        ? (targetVisual.x - (dimensions.width - 1) / 2) * CELL_SIZE
        : shot.target[0];
      const targetY = targetVisual ? shot.targetElevation ?? shot.target[1] : shot.target[1];
      const targetZ = targetVisual
        ? (targetVisual.y - (dimensions.height - 1) / 2) * CELL_SIZE
        : shot.target[2];
      scratch.direction.set(targetX - sourceX, targetY - sourceY, targetZ - sourceZ).normalize();
      scratch.quaternion.setFromUnitVectors(scratch.up, scratch.direction);

      const arc = shot.projectileType === "shell"
        ? Math.sin(progress * Math.PI) * 0.58
        : shot.projectileType === "rocket"
          ? Math.sin(progress * Math.PI) * 0.18
          : 0.02;
      scratch.position.set(
        THREE.MathUtils.lerp(sourceX, targetX, progress),
        THREE.MathUtils.lerp(sourceY, targetY, progress) + arc,
        THREE.MathUtils.lerp(sourceZ, targetZ, progress),
      );

      const projectileLength = shot.projectileType === "flame" ? 5.4 : shot.projectileType === "bullet" ? 6.2 : shot.projectileType === "rocket" ? 3.2 : 2.8;
      scratch.scale.set(shot.scale * 0.5, shot.scale * projectileLength, shot.scale * 0.5);
      scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale);
      projectile.setMatrixAt(index, scratch.matrix);

      const trailLength = shot.projectileType === "flame" ? shot.scale * 10.5 : shot.projectileType === "rocket" ? shot.scale * 8.5 : shot.scale * 5.4;
      scratch.trailPosition.copy(scratch.position).addScaledVector(scratch.direction, -trailLength * 0.55);
      scratch.scale.set(
        shot.scale * (shot.projectileType === "flame" ? 1.25 : shot.projectileType === "rocket" ? 0.9 : 0.38),
        trailLength,
        shot.scale * (shot.projectileType === "flame" ? 1.25 : shot.projectileType === "rocket" ? 0.9 : 0.38),
      );
      scratch.matrix.compose(scratch.trailPosition, scratch.quaternion, scratch.scale);
      trail.setMatrixAt(index, scratch.matrix);

      const muzzleScale = Math.max(0.001, 1 - progress * 18) * shot.scale * (shot.projectileType === "flame" ? 6.5 : shot.projectileType === "rocket" ? 5.2 : 4.6);
      scratch.quaternion.identity();
      scratch.position.set(sourceX, sourceY, sourceZ);
      if (progress < 0.09) {
        scratch.scale.setScalar(muzzleScale);
      } else {
        scratch.scale.copy(scratch.hiddenScale);
      }
      scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale);
      muzzle.setMatrixAt(index, scratch.matrix);
    });
    projectile.instanceMatrix.needsUpdate = true;
    trail.instanceMatrix.needsUpdate = true;
    muzzle.instanceMatrix.needsUpdate = true;
  }, -10);

  if (shots.length === 0) {
    return null;
  }

  return (
    <>
      <instancedMesh ref={projectileRef} args={[undefined, undefined, shots.length]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#ffd36a" toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={trailRef} args={[undefined, undefined, shots.length]} frustumCulled={false}>
        <cylinderGeometry args={[1, 0.28, 1, 8, 1, true]} />
        <meshBasicMaterial color="#f4c66b" transparent opacity={0.28} blending={THREE.AdditiveBlending} toneMapped={false} depthWrite={false} />
      </instancedMesh>
      <instancedMesh ref={muzzleRef} args={[undefined, undefined, shots.length]} frustumCulled={false}>
        <sphereGeometry args={[1, 7, 5]} />
        <meshBasicMaterial color="#ffc04f" transparent opacity={0.82} blending={THREE.AdditiveBlending} toneMapped={false} depthWrite={false} />
      </instancedMesh>
    </>
  );
}

function ProjectilePreviewEffects({ dimensions }: { dimensions: MapDimensions }) {
  const projectileRef = useRef<THREE.InstancedMesh>(null);
  const trailRef = useRef<THREE.InstancedMesh>(null);
  const muzzleRef = useRef<THREE.InstancedMesh>(null);
  const scratch = useMemo(() => ({
    matrix: new THREE.Matrix4(),
    position: new THREE.Vector3(),
    trailPosition: new THREE.Vector3(),
    scale: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    direction: new THREE.Vector3(),
    up: new THREE.Vector3(0, 1, 0),
  }), []);
  const previews = useMemo<VisualProjectile[]>(() =>
    PREVIEW_FX_SHOT_SPECS.map((shot) => ({
      id: shot.id,
      projectileType: shot.projectileType,
      source: toWorldPosition(shot.sourceX, shot.sourceY, dimensions, shot.sourceElevation),
      target: toWorldPosition(shot.targetX, shot.targetY, dimensions, shot.targetElevation),
      color: shot.color,
      trailColor: shot.trailColor,
      scale: shot.scale,
      phase: shot.phase,
      bornAtMs: 0,
      durationMs: shot.durationMs,
    })),
  [dimensions]);

  useLayoutEffect(() => {
    const projectile = projectileRef.current;
    const trail = trailRef.current;
    if (!projectile || !trail) {
      return;
    }
    previews.forEach((preview, index) => {
      projectile.setColorAt(index, new THREE.Color(preview.color));
      trail.setColorAt(index, new THREE.Color(preview.trailColor));
    });
    projectile.instanceColor!.needsUpdate = true;
    trail.instanceColor!.needsUpdate = true;
  }, [previews]);

  useFrame(({ clock }) => {
    const projectile = projectileRef.current;
    const trail = trailRef.current;
    const muzzle = muzzleRef.current;
    if (!projectile || !trail || !muzzle) {
      return;
    }

    const nowMs = clock.elapsedTime * 1000;
    const hiddenScale = new THREE.Vector3(0.001, 0.001, 0.001);
    previews.forEach((preview, index) => {
      const cycleMs = preview.durationMs + PREVIEW_FX_CYCLE_GAP_MS;
      const localMs = (nowMs + preview.phase * 1000) % cycleMs;
      const flying = localMs <= preview.durationMs;
      const progress = Math.min(1, Math.max(0, localMs / preview.durationMs));

      scratch.direction.set(
        preview.target[0] - preview.source[0],
        preview.target[1] - preview.source[1],
        preview.target[2] - preview.source[2],
      ).normalize();
      scratch.quaternion.setFromUnitVectors(scratch.up, scratch.direction);

      if (flying) {
        const arc = preview.projectileType === "shell"
          ? Math.sin(progress * Math.PI) * 0.58
          : preview.projectileType === "rocket"
            ? Math.sin(progress * Math.PI) * 0.18
            : 0.02;
        scratch.position.set(
          THREE.MathUtils.lerp(preview.source[0], preview.target[0], progress),
          THREE.MathUtils.lerp(preview.source[1], preview.target[1], progress) + arc,
          THREE.MathUtils.lerp(preview.source[2], preview.target[2], progress),
        );
        const projectileLength = preview.projectileType === "flame" ? 5.4 : preview.projectileType === "bullet" ? 6.2 : preview.projectileType === "rocket" ? 3.2 : 2.8;
        scratch.scale.set(preview.scale * 0.5, preview.scale * projectileLength, preview.scale * 0.5);
        scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale);
        projectile.setMatrixAt(index, scratch.matrix);

        const trailLength = preview.projectileType === "flame" ? preview.scale * 10.5 : preview.projectileType === "rocket" ? preview.scale * 8.5 : preview.scale * 5.4;
        scratch.trailPosition.copy(scratch.position).addScaledVector(scratch.direction, -trailLength * 0.55);
        scratch.scale.set(
          preview.scale * (preview.projectileType === "flame" ? 1.25 : preview.projectileType === "rocket" ? 0.9 : 0.38),
          trailLength,
          preview.scale * (preview.projectileType === "flame" ? 1.25 : preview.projectileType === "rocket" ? 0.9 : 0.38),
        );
        scratch.matrix.compose(scratch.trailPosition, scratch.quaternion, scratch.scale);
        trail.setMatrixAt(index, scratch.matrix);

        const muzzleScale = Math.max(0.001, 1 - progress * 18) * preview.scale * (preview.projectileType === "flame" ? 6.5 : preview.projectileType === "rocket" ? 5.2 : 4.6);
        scratch.quaternion.identity();
        scratch.scale.setScalar(muzzleScale);
        scratch.position.set(...preview.source);
        scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale);
        muzzle.setMatrixAt(index, scratch.matrix);
      } else {
        scratch.matrix.compose(scratch.position, scratch.quaternion, hiddenScale);
        projectile.setMatrixAt(index, scratch.matrix);
        trail.setMatrixAt(index, scratch.matrix);
        muzzle.setMatrixAt(index, scratch.matrix);
      }
    });

    projectile.instanceMatrix.needsUpdate = true;
    trail.instanceMatrix.needsUpdate = true;
    muzzle.instanceMatrix.needsUpdate = true;
  });

  return (
    <>
      <instancedMesh ref={projectileRef} args={[undefined, undefined, previews.length]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#ffd36a" toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={trailRef} args={[undefined, undefined, previews.length]} frustumCulled={false}>
        <cylinderGeometry args={[1, 0.28, 1, 8, 1, true]} />
        <meshBasicMaterial color="#f4c66b" transparent opacity={0.28} blending={THREE.AdditiveBlending} toneMapped={false} depthWrite={false} />
      </instancedMesh>
      <instancedMesh ref={muzzleRef} args={[undefined, undefined, previews.length]} frustumCulled={false}>
        <sphereGeometry args={[1, 8, 6]} />
        <meshBasicMaterial color="#ffc04f" transparent opacity={0.82} blending={THREE.AdditiveBlending} toneMapped={false} depthWrite={false} />
      </instancedMesh>
    </>
  );
}

function FallenInfantryModel({ casualty }: { casualty: FallenInfantry }) {
  const { scene } = useGLTF(casualty.modelUrl) as { scene: THREE.Object3D };
  const palette = useMemo(() => getTeamPalette(casualty.playerId), [casualty.playerId]);
  const model = useMemo(
    () => cloneModel(scene, palette),
    [palette.accent, palette.primary, scene],
  );
  const fadingMaterials = useMemo(() => {
    const materials = new Set<THREE.Material>();
    model.traverse((child) => {
      const mesh = child as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
      if (!mesh.isMesh) {
        return;
      }
      const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of meshMaterials) {
        material.transparent = true;
        material.needsUpdate = true;
        materials.add(material);
      }
    });
    return [...materials].map((material) => ({ material, opacity: material.opacity }));
  }, [model]);
  const fallPivotRef = useRef<THREE.Group>(null);

  useEffect(() => () => {
    for (const { material } of fadingMaterials) {
      material.dispose();
    }
  }, [fadingMaterials]);

  useFrame(() => {
    const fallPivot = fallPivotRef.current;
    if (!fallPivot) {
      return;
    }

    const age = Math.max(0, Date.now() / 1000 - casualty.bornAt);
    const fallProgress = THREE.MathUtils.clamp(
      age / INFANTRY_FALL_DURATION_SECONDS,
      0,
      1,
    );
    const easedFall = 1 - Math.pow(1 - fallProgress, 3);
    const fadeProgress = THREE.MathUtils.clamp(
      (age - INFANTRY_FALL_DURATION_SECONDS - INFANTRY_BODY_LINGER_SECONDS)
        / INFANTRY_FADE_DURATION_SECONDS,
      0,
      1,
    );

    fallPivot.rotation.set(
      casualty.fallDirection * easedFall * Math.PI * 0.49,
      0,
      casualty.sideTilt * easedFall,
    );
    fallPivot.position.y = -easedFall * 0.025 - fadeProgress * 0.08;
    for (const entry of fadingMaterials) {
      entry.material.opacity = entry.opacity * (1 - fadeProgress);
    }
  }, -5);

  return (
    <group position={casualty.position} rotation={[0, casualty.heading, 0]}>
      <group ref={fallPivotRef}>
        <primitive object={model} scale={CELL_SIZE} />
      </group>
    </group>
  );
}

function DestructionEffects({
  units,
  buildings,
  dimensions,
}: {
  units: Unit[];
  buildings: Building[];
  dimensions: MapDimensions;
}) {
  const { gl } = useThree();
  const previousObjects = useRef(new Map<string, Unit | Building>());
  const cleanupTimers = useRef(new Set<number>());
  const [bursts, setBursts] = useState<DestructionBurst[]>([]);
  const [fallenInfantry, setFallenInfantry] = useState<FallenInfantry[]>([]);
  const fireRef = useRef<THREE.InstancedMesh>(null);
  const debrisRef = useRef<THREE.InstancedMesh>(null);
  const scratch = useMemo(() => ({
    matrix: new THREE.Matrix4(),
    position: new THREE.Vector3(),
    scale: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
  }), []);

  useEffect(() => () => {
    for (const timer of cleanupTimers.current) window.clearTimeout(timer);
    cleanupTimers.current.clear();
  }, []);

  useEffect(() => {
    gl.domElement.dataset.destructionBursts = String(bursts.length);
    gl.domElement.dataset.fallenInfantry = String(fallenInfantry.length);
    return () => {
      delete gl.domElement.dataset.destructionBursts;
      delete gl.domElement.dataset.fallenInfantry;
    };
  }, [bursts.length, fallenInfantry.length, gl]);

  useEffect(() => {
    const current = new Map([...units, ...buildings].map((object) => [object.id, object]));
    const destroyed: DestructionBurst[] = [];
    const casualties: FallenInfantry[] = [];
    const bornAt = Date.now() / 1000;
    if (previousObjects.current.size > 0) {
      for (const [id, object] of previousObjects.current) {
        if (!current.has(id)) {
          const isBuilding = "productionQueue" in object;
          if (!isBuilding && !isVehicleUnit(object)) {
            casualties.push({
              id: `${id}-${bornAt}`,
              modelUrl: getUnitModelUrl(object, MASS_BATTLE_LOD_ENABLED),
              playerId: object.playerId,
              position: toWorldPosition(object.x, object.y, dimensions, 0.08),
              heading: getBodyHeading(object),
              fallDirection: deterministicNoise(object.x, object.y, 91) < 0.5 ? -1 : 1,
              sideTilt: (deterministicNoise(object.x, object.y, 92) - 0.5) * 0.22,
              bornAt,
            });
          } else {
            destroyed.push({
              id: `${id}-${bornAt}`,
              position: toWorldPosition(object.x, object.y, dimensions, isBuilding ? 0.86 : 0.58),
              bornAt,
              scale: isBuilding ? 2.2 : 1.35,
            });
          }
        }
      }
    }
    previousObjects.current = current;
    if (destroyed.length > 0) {
      setBursts((currentBursts) => [...currentBursts, ...destroyed]);
      const ids = new Set(destroyed.map((burst) => burst.id));
      const timer = window.setTimeout(() => {
        cleanupTimers.current.delete(timer);
        setBursts((currentBursts) => currentBursts.filter((burst) => !ids.has(burst.id)));
      }, 1200);
      cleanupTimers.current.add(timer);
    }
    if (casualties.length > 0) {
      setFallenInfantry((currentCasualties) => [...currentCasualties, ...casualties]);
      const ids = new Set(casualties.map((casualty) => casualty.id));
      const timer = window.setTimeout(() => {
        cleanupTimers.current.delete(timer);
        setFallenInfantry((currentCasualties) => currentCasualties.filter((casualty) => !ids.has(casualty.id)));
      }, INFANTRY_DEATH_EFFECT_MS + 100);
      cleanupTimers.current.add(timer);
    }
  }, [buildings, dimensions, units]);

  useFrame(() => {
    const fire = fireRef.current;
    const debris = debrisRef.current;
    if (!fire || !debris) {
      return;
    }
    const now = Date.now() / 1000;
    bursts.forEach((burst, burstIndex) => {
      const age = Math.min(1, Math.max(0, (now - burst.bornAt) / 1.05));
      const fireScale = Math.sin(age * Math.PI) * burst.scale;
      scratch.position.set(burst.position[0], burst.position[1] + age * burst.scale * 0.45, burst.position[2]);
      scratch.scale.setScalar(Math.max(0.001, fireScale));
      scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale);
      fire.setMatrixAt(burstIndex, scratch.matrix);

      for (let piece = 0; piece < 6; piece += 1) {
        const index = burstIndex * 6 + piece;
        const angle = (piece / 6) * Math.PI * 2 + deterministicNoise(burstIndex, piece, 13);
        const distance = age * burst.scale * (0.8 + piece * 0.08);
        scratch.position.set(
          burst.position[0] + Math.sin(angle) * distance,
          burst.position[1] + Math.sin(age * Math.PI) * burst.scale * (0.7 + piece * 0.05),
          burst.position[2] + Math.cos(angle) * distance,
        );
        scratch.quaternion.setFromEuler(new THREE.Euler(age * 8 + piece, angle, age * 6));
        scratch.scale.setScalar(Math.max(0.001, burst.scale * 0.1 * (1 - age * 0.5)));
        scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale);
        debris.setMatrixAt(index, scratch.matrix);
      }
    });
    fire.instanceMatrix.needsUpdate = true;
    debris.instanceMatrix.needsUpdate = true;
  });

  if (bursts.length === 0 && fallenInfantry.length === 0) {
    return null;
  }

  return (
    <>
      {bursts.length > 0 ? (
        <>
          <instancedMesh ref={fireRef} args={[undefined, undefined, bursts.length]} frustumCulled={false}>
            <icosahedronGeometry args={[1, 2]} />
            <meshBasicMaterial color="#ff6b1f" transparent opacity={0.78} blending={THREE.AdditiveBlending} toneMapped={false} />
          </instancedMesh>
          <instancedMesh ref={debrisRef} args={[undefined, undefined, bursts.length * 6]} castShadow frustumCulled={false}>
            <boxGeometry args={[1, 0.42, 0.65]} />
            <meshStandardMaterial color="#252826" metalness={0.72} roughness={0.46} />
          </instancedMesh>
        </>
      ) : null}
      {fallenInfantry.map((casualty) => (
        <FallenInfantryModel key={casualty.id} casualty={casualty} />
      ))}
    </>
  );
}

function BuildingModel({
  building,
  dimensions,
  onEntityHover,
  onEntityLeave,
}: {
  building: Building;
  dimensions: MapDimensions;
  onEntityHover: EntityHoverHandler;
  onEntityLeave: () => void;
}) {
  const palette = useMemo(() => getTeamPalette(building.playerId), [building.playerId]);
  const staticModelUrl =
    building.type === "hq"
      ? MODEL_URLS.hq
      : building.type === "barracks"
        ? MODEL_URLS.barracks
        : building.type === "war_factory"
          ? MODEL_URLS.war_factory
          : building.type === "refinery"
            ? MODEL_URLS.refinery
            : MODEL_URLS.tech_center;
  const defensiveModels = building.type === "machine_gun_turret"
    ? {
        body: MODEL_URLS.machine_gun_turret_body,
        turret: MODEL_URLS.machine_gun_turret_turret,
      }
    : building.type === "anti_tank_turret"
      ? {
          body: MODEL_URLS.anti_tank_turret_body,
          turret: MODEL_URLS.anti_tank_turret_turret,
        }
      : null;
  const presentation = building.type === "hq"
    ? { healthY: 6.65, healthWidth: 3.4 }
    : building.type === "barracks"
      ? { healthY: 3.85, healthWidth: 2.45 }
      : building.type === "war_factory"
        ? { healthY: 3.8, healthWidth: 3.1 }
        : building.type === "refinery"
          ? { healthY: 3.98, healthWidth: 2.7 }
          : building.type === "machine_gun_turret"
            ? { healthY: 2.55, healthWidth: 1.9 }
            : building.type === "anti_tank_turret"
              ? { healthY: 2.3, healthWidth: 2.3 }
              : { healthY: 4.77, healthWidth: 3.0 };
  const defaultHeading = building.playerId === "player_1" ? 0 : Math.PI;
  const turretHeading = Math.PI - (building.heading ?? defaultHeading);

  return (
    <group
      position={toWorldPosition(building.x, building.y, dimensions, 0)}
      scale={CELL_SIZE}
      onPointerMove={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        onEntityHover(building.id, event.nativeEvent.clientX, event.nativeEvent.clientY);
      }}
      onPointerOut={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        onEntityLeave();
      }}
    >
      {defensiveModels ? (
        <>
          <ModelInstance url={defensiveModels.body} palette={palette} position={[0, 0, 0]} />
          <TraversingModelInstance url={defensiveModels.turret} palette={palette} heading={turretHeading} />
        </>
      ) : (
        <ModelInstance url={staticModelUrl} palette={palette} position={[0, 0, 0]} />
      )}
      <HealthBar
        hp={building.hp}
        maxHp={building.maxHp}
        color={palette.primary}
        width={presentation.healthWidth}
        y={presentation.healthY}
      />
    </group>
  );
}

function VisualIntentSegment({
  entityIds,
  targetX,
  targetY,
  color,
  dimensions,
  visualWorld,
}: {
  entityIds: string[];
  targetX: number;
  targetY: number;
  color: string;
  dimensions: MapDimensions;
  visualWorld: VisualWorld;
}) {
  const geometry = useMemo(() => {
    const next = new THREE.BufferGeometry();
    next.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    return next;
  }, []);
  const update = () => {
    const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
    let totalX = 0;
    let totalY = 0;
    let count = 0;
    for (const entityId of entityIds) {
      const transform = visualWorld.getTransform(entityId);
      if (!transform) continue;
      totalX += transform.x;
      totalY += transform.y;
      count += 1;
    }
    if (count === 0) return;
    const source = toWorldPosition(totalX / count, totalY / count, dimensions, 0.18);
    const target = toWorldPosition(targetX, targetY, dimensions, 0.18);
    positions.setXYZ(0, source[0], source[1], source[2]);
    positions.setXYZ(1, target[0], target[1], target[2]);
    positions.needsUpdate = true;
  };

  useLayoutEffect(update, [dimensions, entityIds, geometry, targetX, targetY, visualWorld]);
  useFrame(update, -20);

  return (
    <lineSegments geometry={geometry} frustumCulled={false}>
      <lineBasicMaterial color={color} transparent opacity={0.38} />
    </lineSegments>
  );
}

function IntentLines({
  units,
  dimensions,
  visualWorld,
}: {
  units: Unit[];
  dimensions: MapDimensions;
  visualWorld: VisualWorld;
}) {
  const formationLines = useMemo(() => {
    const groups = new Map<string, { units: Unit[]; targetX: number; targetY: number; color: string }>();

    for (const unit of units) {
      const targetX = unit.intent?.targetX;
      const targetY = unit.intent?.targetY;
      if (targetX === undefined || targetY === undefined) {
        continue;
      }
      const intentType = unit.intent?.type ?? "move";
      const key = `${unit.playerId}:${intentType}:${targetX}:${targetY}`;
      const group = groups.get(key) ?? {
        units: [],
        targetX,
        targetY,
        color: intentType === "harvest_loop" ? GAME_COLORS.resource : getPlayerColor(unit.playerId),
      };
      group.units.push(unit);
      groups.set(key, group);
    }

    return [...groups.values()].map((group) => {
      return {
        entityIds: group.units.map((unit) => unit.id),
        targetX: group.targetX,
        targetY: group.targetY,
        color: group.color,
        key: `${group.units[0]?.playerId}:${group.targetX}:${group.targetY}`,
      };
    });
  }, [units]);

  return (
    <>
      {formationLines.map((line) => (
        <VisualIntentSegment
          key={line.key}
          entityIds={line.entityIds}
          targetX={line.targetX}
          targetY={line.targetY}
          color={line.color}
          dimensions={dimensions}
          visualWorld={visualWorld}
        />
      ))}
    </>
  );
}

function useVisualWorld(): VisualWorld {
  return useMemo(() => new VisualWorld(), []);
}
const BattlefieldScene = memo(function BattlefieldScene({
  state,
  projectileFxMode = "game",
  timeline,
  effectsResetKey,
  onEntityHover,
  onEntityLeave,
}: {
  state: GameState;
  projectileFxMode?: ProjectileFxMode;
  timeline?: SimulationVisualTimeline;
  effectsResetKey?: string;
  onEntityHover: EntityHoverHandler;
  onEntityLeave: () => void;
}) {
  const dimensions = useMemo(() => getMapDimensions(state), [state]);
  const terrainWidth = dimensions.width * CELL_SIZE;
  const terrainHeight = dimensions.height * CELL_SIZE;
  const initialFocus = useMemo(
    () => getInitialCameraFocus(state, dimensions),
    [dimensions, state],
  );
  const visualWorld = useVisualWorld();

  const { resourceTiles, obstacleTiles, units, buildings } = useMemo(() => {
    const resourceTiles: Tile[] = [];
    const obstacleTiles: Tile[] = [];

    for (const row of state.tiles) {
      for (const tile of row) {
        if (tile.type === "resource") {
          resourceTiles.push(tile);
        } else if (tile.type === "obstacle") {
          obstacleTiles.push(tile);
        }
      }
    }

    return {
      resourceTiles,
      obstacleTiles,
      units: state.players.flatMap((player) => player.units).filter((unit) => unit.exists),
      buildings: state.players.flatMap((player) => player.buildings).filter((building) => building.exists),
    };
  }, [state]);
  const resourceTransforms = useMemo(
    () => resourceTiles.flatMap((tile) => getResourceClusterTransforms(tile, dimensions)),
    [dimensions, resourceTiles],
  );
  const rockTransforms = useMemo(
    () => obstacleTiles
      .map((tile) => getRockTransform(tile, dimensions))
      .filter((transform): transform is ModelTransform => transform !== null),
    [dimensions, obstacleTiles],
  );

  return (
    <>
      <ResponsiveCamera initialFocus={initialFocus} />
      <RenderDiagnostics />
      <VisualFrameSystem visualWorld={visualWorld} units={units} timeline={timeline} />
      <ProjectileFxModeMarker mode={projectileFxMode} />
      <color attach="background" args={["#82989a"]} />
      <fog attach="fog" args={["#82989a", 86, 205]} />
      <hemisphereLight color="#dce6e3" groundColor="#253127" intensity={0.82} />
      <directionalLight
        castShadow
        position={[-32, 42, 26]}
        intensity={1.65}
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-80}
        shadow-camera-right={80}
        shadow-camera-top={80}
        shadow-camera-bottom={-80}
      />
      <Suspense fallback={null}>
        <BattlefieldGround width={terrainWidth} height={terrainHeight} />
        <InstancedModelBatch
          url={MODEL_URLS.resource}
          palette={NEUTRAL_PALETTE}
          transforms={resourceTransforms}
        />
        <InstancedModelBatch
          url={MODEL_URLS.rock}
          palette={NEUTRAL_PALETTE}
          transforms={rockTransforms}
        />
        {buildings.map((building) => (
          <BasePlatform key={`platform-${building.id}`} building={building} dimensions={dimensions} />
        ))}
        {buildings.map((building) => (
          <BuildingModel
            key={building.id}
            building={building}
            dimensions={dimensions}
            onEntityHover={onEntityHover}
            onEntityLeave={onEntityLeave}
          />
        ))}
        <UnitBatches
          units={units}
          buildings={buildings}
          dimensions={dimensions}
          tick={state.tick}
          visualWorld={visualWorld}
          onEntityHover={onEntityHover}
          onEntityLeave={onEntityLeave}
        />
        <UnitReadabilityLayer
          units={units}
          dimensions={dimensions}
          visualWorld={visualWorld}
          onEntityHover={onEntityHover}
          onEntityLeave={onEntityLeave}
        />
        <AttackWindupEffects units={units} dimensions={dimensions} visualWorld={visualWorld} />
        <FlameStreamEffects units={units} buildings={buildings} dimensions={dimensions} visualWorld={visualWorld} />
        <DemolitionChargeEffects projectiles={state.projectiles ?? []} buildings={buildings} dimensions={dimensions} />
        {projectileFxMode === "game" ? (
          <CombatEffects
            units={units}
            buildings={buildings}
            projectiles={state.projectiles ?? []}
            dimensions={dimensions}
            tick={state.tick}
            visualWorld={visualWorld}
          />
        ) : null}
        {projectileFxMode === "preview" ? <ProjectilePreviewEffects dimensions={dimensions} /> : null}
        <DestructionEffects key={effectsResetKey} units={units} buildings={buildings} dimensions={dimensions} />
      </Suspense>
      {SHOW_DEBUG_INTENTS ? (
        <IntentLines units={units} dimensions={dimensions} visualWorld={visualWorld} />
      ) : null}
      <BoundedCameraControls resetFocus={initialFocus} dimensions={dimensions} />
    </>
  );
});

function EntityHoverCard({
  entity,
  pointer,
}: {
  entity: Unit | Building;
  pointer: HoveredEntityPointer;
}) {
  const isBuilding = "productionQueue" in entity;
  const sideClass = entity.playerId === "player_1" ? "red" : "blue";
  const hpRatio = Math.max(0, Math.min(1, entity.hp / Math.max(1, entity.maxHp)));

  if (!isBuilding) {
    return (
      <aside
        className={`entity-hover-card ${sideClass}`}
        style={{ left: pointer.x, top: pointer.y }}
        role="tooltip"
      >
        <div className="entity-hover-kicker">
          <span>单位</span>
          <b>{PLAYER_LABELS[entity.playerId]}</b>
        </div>
        <strong className="entity-hover-name">{getUnitDisplayName(entity)}</strong>
        <span className="entity-hover-type">{UNIT_LABELS[entity.type]}</span>
        <div className="entity-hover-health-label">
          <span>生命值</span>
          <b>{Math.ceil(entity.hp)} / {entity.maxHp}</b>
        </div>
        <div className="entity-hover-health">
          <span style={{ width: `${hpRatio * 100}%` }} />
        </div>
        <div className="entity-hover-meta">
          <span>状态 <b>{getUnitActivityLabel(entity)}</b></span>
          <span>坐标 <b>{entity.x.toFixed(1)}, {entity.y.toFixed(1)}</b></span>
        </div>
        <code>{entity.id}</code>
      </aside>
    );
  }

  const construction = entity.constructionProgress;
  const production = entity.productionProgress;
  const productionRatio = production
    ? Math.max(0, Math.min(1, 1 - production.remainingTicks / Math.max(1, production.totalTicks)))
    : 0;
  const constructionRatio = construction
    ? Math.max(0, Math.min(1, 1 - construction.remainingTicks / Math.max(1, construction.totalTicks)))
    : 0;
  const queuedUnits = Math.max(
    0,
    entity.productionQueue.reduce((total, order) => total + order.remainingCount, 0) - (production ? 1 : 0),
  );
  const canProduce = getProductionOptions(entity.type).length > 0;

  return (
    <aside
      className={`entity-hover-card ${sideClass}`}
      style={{ left: pointer.x, top: pointer.y }}
      role="tooltip"
    >
      <div className="entity-hover-kicker">
        <span>建筑</span>
        <b>{PLAYER_LABELS[entity.playerId]}</b>
      </div>
      <strong className="entity-hover-name">{getBuildingDisplayName(entity)}</strong>
      <span className="entity-hover-type">{BUILDING_LABELS[entity.type]}</span>
      <div className="entity-hover-health-label">
        <span>结构完整度</span>
        <b>{Math.ceil(entity.hp)} / {entity.maxHp}</b>
      </div>
      <div className="entity-hover-health">
        <span style={{ width: `${hpRatio * 100}%` }} />
      </div>

      {construction ? (
        <div className="entity-hover-operation">
          <div><span>施工中</span><b>{Math.round(constructionRatio * 100)}%</b></div>
          <div className="entity-hover-operation-track">
            <span style={{ width: `${constructionRatio * 100}%` }} />
          </div>
          <small>剩余 {formatTickDuration(construction.remainingTicks, TICK_INTERVAL_MS)}</small>
        </div>
      ) : production ? (
        <div className={`entity-hover-operation${production.status === "producing" ? "" : " waiting"}`}>
          <div><span>生产 {UNIT_LABELS[production.unitType]}</span><b>{Math.round(productionRatio * 100)}%</b></div>
          <div className="entity-hover-operation-track">
            <span style={{ width: `${productionRatio * 100}%` }} />
          </div>
          <small>
            {PRODUCTION_STATUS_LABELS[production.status]} · 剩余 {formatTickDuration(production.remainingTicks, TICK_INTERVAL_MS)}
            {production.missingPrerequisites?.length
              ? ` · 缺少 ${production.missingPrerequisites.map((type) => BUILDING_LABELS[type]).join("、")}`
              : ""}
          </small>
        </div>
      ) : canProduce ? (
        <div className="entity-hover-idle">生产线空闲</div>
      ) : null}

      <div className="entity-hover-meta">
        {canProduce && <span>后续队列 <b>{queuedUnits}</b></span>}
        <span>坐标 <b>{entity.x.toFixed(1)}, {entity.y.toFixed(1)}</b></span>
      </div>
      <code>{entity.id}</code>
    </aside>
  );
}

export function Battlefield3D({ state, projectileFxMode = "game", timeline, effectsResetKey }: Battlefield3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredPointer, setHoveredPointer] = useState<HoveredEntityPointer | null>(null);
  const handleEntityHover = useCallback<EntityHoverHandler>((entityId, clientX, clientY) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cardWidth = 238;
    const cardHeight = 190;
    const preferredX = clientX - rect.left + 15;
    const preferredY = clientY - rect.top + 15;
    setHoveredPointer({
      entityId,
      x: Math.max(8, Math.min(preferredX, rect.width - cardWidth - 8)),
      y: Math.max(8, Math.min(preferredY, rect.height - cardHeight - 8)),
    });
  }, []);
  const clearHoveredEntity = useCallback(() => setHoveredPointer(null), []);
  useEffect(() => {
    window.addEventListener("resize", clearHoveredEntity);
    return () => window.removeEventListener("resize", clearHoveredEntity);
  }, [clearHoveredEntity]);
  const dimensions = state ? getMapDimensions(state) : { width: 96, height: 64 };
  const cameraFocus = state
    ? getInitialCameraFocus(state, dimensions)
    : { target: [0, 0, 0] as Vec3, position: [0, 23, 29] as Vec3 };

  if (!state) {
    return <div className="battlefield-3d empty-state">等待战场状态</div>;
  }

  const hoveredEntity = hoveredPointer
    ? state.players
        .flatMap((player) => [...player.units, ...player.buildings])
        .find((entity) => entity.exists && entity.id === hoveredPointer.entityId)
    : undefined;

  return (
    <div
      ref={containerRef}
      className="battlefield-3d"
      data-testid="battlefield-3d"
      onPointerLeave={clearHoveredEntity}
    >
      <Canvas
        shadows="percentage"
        dpr={1}
        camera={{
          position: cameraFocus.position,
          fov: 46,
          near: 0.5,
          far: 260,
        }}
        gl={{ antialias: true, powerPreference: "high-performance" }}
        onPointerMissed={clearHoveredEntity}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.08;
        }}
      >
        <BattlefieldScene
          state={state}
          projectileFxMode={projectileFxMode}
          timeline={timeline}
          effectsResetKey={effectsResetKey}
          onEntityHover={handleEntityHover}
          onEntityLeave={clearHoveredEntity}
        />
      </Canvas>
      {hoveredEntity && hoveredPointer ? (
        <EntityHoverCard entity={hoveredEntity} pointer={hoveredPointer} />
      ) : null}
    </div>
  );
}
