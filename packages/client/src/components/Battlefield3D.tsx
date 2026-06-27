import { memo, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Billboard, Line, OrbitControls, useGLTF, useTexture } from "@react-three/drei";
import * as THREE from "three";
import {
  Building,
  ActiveProjectile,
  GAME_COLORS,
  GameState,
  PLAYER_COLORS,
  TICK_INTERVAL_MS,
  Tile,
  Unit,
} from "@llmcraft/shared";

interface Battlefield3DProps {
  state: GameState | null;
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

interface ModelTransform {
  position: Vec3;
  rotation: Vec3;
  scale: number;
  motionAmplitude?: number;
  motionPhase?: number;
  recoilAmplitude?: number;
  swayAmplitude?: number;
}

interface InstancedModelPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  localMatrix: THREE.Matrix4;
}

interface CombatShot {
  source: Vec3;
  current?: Vec3;
  target: Vec3;
  color: string;
  scale: number;
  phase: number;
  progress?: number;
}

interface DestructionBurst {
  id: string;
  position: Vec3;
  bornAt: number;
  scale: number;
}

type Vec3 = [number, number, number];

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
const UNIT_VISUAL_SCALE = 1.32;
const UNIT_SCALE_BY_TYPE: Partial<Record<Unit["type"], number>> = {
  worker: 1.08,
  soldier: 1.08,
  rifleman: 1.06,
  rocket_soldier: 1.06,
  light_tank: 1.16,
};
const STRUCTURE_VISUAL_SCALE = 1.16;
const UNIT_INTERPOLATION_DURATION_MS = TICK_INTERVAL_MS * 0.92;
const UNIT_INTERPOLATION_SNAP_DISTANCE = 10;
const MODEL_ROOT = "/assets/models/battlefield";
const TEXTURE_ROOT = "/assets/textures/battlefield";
const MODEL_VERSION = "production-20260620-1";
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
  light_tank: modelUrl("light_tank"),
  light_tank_lod: modelUrl("light_tank_lod"),
  light_tank_body: modelUrl("light_tank_body"),
  light_tank_body_lod: modelUrl("light_tank_body_lod"),
  light_tank_turret: modelUrl("light_tank_turret"),
  light_tank_turret_lod: modelUrl("light_tank_turret_lod"),
  hq: modelUrl("hq"),
  barracks: modelUrl("barracks"),
  war_factory: modelUrl("war_factory"),
  refinery: modelUrl("refinery"),
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
  return getHeading(unit) + (unit.type === "light_tank" ? TANK_FORWARD_OFFSET : 0);
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

function InstancedPart({
  part,
  transforms,
  castShadow,
}: {
  part: InstancedModelPart;
  transforms: ModelTransform[];
  castShadow: boolean;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const lastMotionUpdate = useRef(0);
  const scratch = useMemo(() => ({
    rootMatrix: new THREE.Matrix4(),
    finalMatrix: new THREE.Matrix4(),
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    rotation: new THREE.Euler(),
    scale: new THREE.Vector3(),
  }), []);
  const hasMotion = useMemo(
    () => transforms.some((transform) =>
      (transform.motionAmplitude ?? 0) > 0
      || (transform.recoilAmplitude ?? 0) > 0
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
      const recoilPulse = Math.pow(Math.max(0, Math.sin(elapsed * 11 + phase)), 10)
        * (transform.recoilAmplitude ?? 0);
      const sway = Math.sin(elapsed * 7.5 + phase) * (transform.swayAmplitude ?? 0);
      const heading = transform.rotation[1];
      scratch.position.set(
        transform.position[0] - Math.sin(heading) * recoilPulse,
        transform.position[1] + Math.abs(Math.sin(elapsed * 7.5 + phase)) * motion,
        transform.position[2] - Math.cos(heading) * recoilPulse,
      );
      scratch.rotation.set(transform.rotation[0], heading, transform.rotation[2] + sway);
      scratch.quaternion.setFromEuler(scratch.rotation);
      scratch.scale.setScalar(transform.scale);
      scratch.rootMatrix.compose(scratch.position, scratch.quaternion, scratch.scale);
      scratch.finalMatrix.multiplyMatrices(scratch.rootMatrix, part.localMatrix);
      mesh.setMatrixAt(index, scratch.finalMatrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  };

  useLayoutEffect(() => {
    updateMatrices(0);
  }, [part.localMatrix, transforms]);

  useFrame(({ clock }) => {
    if (!hasMotion) {
      return;
    }
    const elapsed = clock.getElapsedTime();
    if (elapsed - lastMotionUpdate.current < 1 / 30) {
      return;
    }
    lastMotionUpdate.current = elapsed;
    updateMatrices(elapsed);
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[part.geometry, part.material, transforms.length]}
      castShadow={castShadow}
      receiveShadow
      frustumCulled
    />
  );
}

function InstancedModelBatch({
  url,
  palette,
  transforms,
  castShadow = false,
}: {
  url: string;
  palette: TeamPalette;
  transforms: ModelTransform[];
  castShadow?: boolean;
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

function getResourceTransform(tile: Tile, dimensions: MapDimensions): ModelTransform {
  const scale = 0.78 + deterministicNoise(tile.x, tile.y, 2) * 0.34;
  return {
    position: toWorldPosition(tile.x, tile.y, dimensions, 0.02),
    rotation: [0, ((tile.x * 13 + tile.y * 7) % 360) * (Math.PI / 180), 0],
    scale,
  };
}

function getRockTransform(tile: Tile, dimensions: MapDimensions): ModelTransform | null {
  const density = deterministicNoise(tile.x, tile.y, 3);
  if (density < 0.3) {
    return null;
  }

  const basePosition = toWorldPosition(tile.x, tile.y, dimensions, 0);
  const jitterX = (deterministicNoise(tile.x, tile.y, 4) - 0.5) * CELL_SIZE * 0.62;
  const jitterZ = (deterministicNoise(tile.x, tile.y, 5) - 0.5) * CELL_SIZE * 0.62;
  const scale = 0.58 + deterministicNoise(tile.x, tile.y, 6) * 0.82;

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
  const terrainMap = useRepeatedTexture(`${TEXTURE_ROOT}/terrain_ph_albedo.jpg`, terrainRepeatX, terrainRepeatY);
  const terrainNormal = useRepeatedTexture(`${TEXTURE_ROOT}/terrain_ph_normal.jpg`, terrainRepeatX, terrainRepeatY, true);
  const terrainRoughness = useRepeatedTexture(`${TEXTURE_ROOT}/terrain_ph_roughness.jpg`, terrainRepeatX, terrainRepeatY, true);
  const outerTerrainMap = useRepeatedTexture(`${TEXTURE_ROOT}/terrain_ph_albedo.jpg`, terrainRepeatX * 2.6, terrainRepeatY * 2.6);
  const outerTerrainNormal = useRepeatedTexture(`${TEXTURE_ROOT}/terrain_ph_normal.jpg`, terrainRepeatX * 2.6, terrainRepeatY * 2.6, true);
  const outerTerrainRoughness = useRepeatedTexture(`${TEXTURE_ROOT}/terrain_ph_roughness.jpg`, terrainRepeatX * 2.6, terrainRepeatY * 2.6, true);

  return (
    <>
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[width, height]} />
        <meshStandardMaterial
          map={outerTerrainMap}
          normalMap={outerTerrainNormal}
          normalScale={new THREE.Vector2(0.68, 0.68)}
          roughnessMap={terrainRoughness}
          roughness={0.94}
          metalness={0.01}
        />
      </mesh>
      <mesh receiveShadow position={[0, -0.055, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[width * 2.6, height * 2.6]} />
        <meshStandardMaterial
          map={terrainMap}
          normalMap={terrainNormal}
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
  return (
    <group position={toWorldPosition(building.x, building.y, dimensions, 0.018)}>
      <mesh receiveShadow>
        <cylinderGeometry args={[4.2, 4.2, 0.08, 12]} />
        <meshStandardMaterial color="#1a211e" roughness={0.86} metalness={0.05} />
      </mesh>
      <mesh position={[0, 0.055, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[3.2, 3.52, 12]} />
        <meshBasicMaterial color={color} transparent opacity={0.38} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

function getUnitModelUrl(unit: Unit, massBattleLod: boolean): string {
  if (unit.type === "light_tank") {
    return massBattleLod ? MODEL_URLS.light_tank_lod : MODEL_URLS.light_tank;
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

function getUnitVisualScale(unit: Unit): number {
  return UNIT_VISUAL_SCALE * (UNIT_SCALE_BY_TYPE[unit.type] ?? 1);
}

function UnitBatches({
  units,
  buildings,
  dimensions,
  tick,
}: {
  units: Unit[];
  buildings: Building[];
  dimensions: MapDimensions;
  tick: number;
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
      const baseTransform: ModelTransform = {
        position: toWorldPosition(unit.x, unit.y, dimensions, 0.08),
        rotation: [0, getBodyHeading(unit), 0],
        scale: getUnitVisualScale(unit),
        motionAmplitude: unit.type !== "light_tank" && moving ? 0.035 : 0,
        motionPhase: index * 1.73 + (unit.playerId === "player_1" ? 0 : 0.8),
        recoilAmplitude: firing ? (unit.type === "light_tank" ? 0 : 0.055) : 0,
        swayAmplitude: unit.type !== "light_tank" && moving ? 0.025 : 0,
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

      if (unit.type === "light_tank") {
        addToBatch(massBattleLod ? MODEL_URLS.light_tank_body_lod : MODEL_URLS.light_tank_body, baseTransform);
        addToBatch(massBattleLod ? MODEL_URLS.light_tank_turret_lod : MODEL_URLS.light_tank_turret, {
          ...baseTransform,
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
          castShadow={units.length <= 60}
        />
      ))}
      {units
        .filter((unit) => unit.hp < unit.maxHp)
        .map((unit) => {
          const palette = getTeamPalette(unit.playerId);
          return (
            <group
              key={`health-${unit.id}`}
              position={toWorldPosition(unit.x, unit.y, dimensions, 0.08)}
              rotation={[0, getBodyHeading(unit), 0]}
              scale={getUnitVisualScale(unit)}
            >
              <HealthBar
                hp={unit.hp}
                maxHp={unit.maxHp}
                color={palette.primary}
                width={unit.type === "light_tank" ? 1.25 : 0.82}
                y={unit.type === "light_tank" ? 1.28 : 1.34}
              />
            </group>
          );
        })}
    </>
  );
}

function GroundRingBatch({
  units,
  dimensions,
  color,
}: {
  units: Unit[];
  dimensions: MapDimensions;
  color: string;
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
  const transforms = useMemo<ModelTransform[]>(() => units.map((unit) => ({
    position: toWorldPosition(unit.x, unit.y, dimensions, 0.035),
    rotation: [-Math.PI / 2, 0, 0],
    scale: unit.type === "light_tank" ? 1.22 : 0.72,
  })), [dimensions, units]);

  return <InstancedPart part={part} transforms={transforms} castShadow={false} />;
}

function UnitReadabilityLayer({ units, dimensions }: { units: Unit[]; dimensions: MapDimensions }) {
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
        />
      ))}
    </>
  );
}

function CombatEffects({
  units,
  buildings,
  projectiles,
  dimensions,
  tick,
}: {
  units: Unit[];
  buildings: Building[];
  projectiles: ActiveProjectile[];
  dimensions: MapDimensions;
  tick: number;
}) {
  const { gl } = useThree();
  const projectileRef = useRef<THREE.InstancedMesh>(null);
  const muzzleRef = useRef<THREE.InstancedMesh>(null);
  const impactRef = useRef<THREE.InstancedMesh>(null);
  const scratch = useMemo(() => ({
    matrix: new THREE.Matrix4(),
    position: new THREE.Vector3(),
    scale: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    direction: new THREE.Vector3(),
    up: new THREE.Vector3(0, 1, 0),
  }), []);
  const shots = useMemo(() => {
    const objects = new Map([...units, ...buildings].map((object) => [object.id, object]));
    const activeProjectileShots = projectiles
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((projectile, index): CombatShot => {
        const totalTicks = Math.max(1, projectile.impactTick - projectile.launchedTick);
        const progress = Math.min(1, Math.max(0, (tick - projectile.launchedTick) / totalTicks));
        const height = projectile.projectileType === "shell" ? 1.16 : projectile.projectileType === "rocket" ? 1.05 : 0.94;
        const color = projectile.projectileType === "rocket"
          ? "#ff6a22"
          : projectile.projectileType === "shell"
            ? "#ffd36a"
            : "#fff4b0";
        const scale = projectile.projectileType === "rocket" ? 0.2 : projectile.projectileType === "shell" ? 0.16 : 0.085;
        return {
          source: toWorldPosition(projectile.startX, projectile.startY, dimensions, height),
          current: toWorldPosition(projectile.x, projectile.y, dimensions, height),
          target: toWorldPosition(projectile.targetX, projectile.targetY, dimensions, height),
          color,
          scale,
          phase: deterministicNoise(projectile.startX, projectile.startY, tick + index) * 0.9,
          progress,
        };
      })
      .slice(0, 96);
    if (activeProjectileShots.length > 0) {
      return activeProjectileShots;
    }

    return units
      .filter((unit) => unit.lastAttackTick !== undefined && tick - unit.lastAttackTick <= 1 && unit.intent?.targetId)
      .sort((left, right) => left.id.localeCompare(right.id))
      .flatMap((unit, index): CombatShot[] => {
        const target = unit.intent?.targetId ? objects.get(unit.intent.targetId) : undefined;
        if (!target) {
          return [];
        }
        const sourceHeight = unit.type === "light_tank" ? 1.02 : 0.96;
        const targetHeight = "productionQueue" in target ? 1.4 : target.type === "light_tank" ? 0.76 : 0.82;
        return [{
          source: toWorldPosition(unit.x, unit.y, dimensions, sourceHeight),
          target: toWorldPosition(target.x, target.y, dimensions, targetHeight),
          color: unit.type === "rocket_soldier" ? "#ff6a22" : unit.type === "light_tank" ? "#ffd36a" : "#fff4b0",
          scale: unit.type === "rocket_soldier" ? 0.2 : unit.type === "light_tank" ? 0.16 : 0.085,
          phase: deterministicNoise(unit.x, unit.y, tick + index) * 0.9,
        }];
      })
      .slice(0, 48);
  }, [buildings, dimensions, projectiles, tick, units]);

  useEffect(() => {
    gl.domElement.dataset.combatShots = String(shots.length);
  }, [gl, shots.length]);

  useLayoutEffect(() => {
    const projectile = projectileRef.current;
    if (!projectile) {
      return;
    }
    shots.forEach((shot, index) => projectile.setColorAt(index, new THREE.Color(shot.color)));
    if (projectile.instanceColor) {
      projectile.instanceColor.needsUpdate = true;
    }
  }, [shots]);

  useFrame(({ clock }) => {
    const projectile = projectileRef.current;
    const muzzle = muzzleRef.current;
    const impact = impactRef.current;
    if (!projectile || !muzzle || !impact) {
      return;
    }
    const elapsed = clock.getElapsedTime();
    shots.forEach((shot, index) => {
      const progress = shot.progress ?? ((elapsed * 1.7 + shot.phase) % 1);
      if (shot.current) {
        scratch.position.set(shot.current[0], shot.current[1] + Math.sin(progress * Math.PI) * 0.22, shot.current[2]);
      } else {
        scratch.position.set(
          THREE.MathUtils.lerp(shot.source[0], shot.target[0], progress),
          THREE.MathUtils.lerp(shot.source[1], shot.target[1], progress) + Math.sin(progress * Math.PI) * 0.22,
          THREE.MathUtils.lerp(shot.source[2], shot.target[2], progress),
        );
      }
      scratch.direction.set(
        shot.target[0] - shot.source[0],
        shot.target[1] - shot.source[1],
        shot.target[2] - shot.source[2],
      ).normalize();
      scratch.quaternion.setFromUnitVectors(scratch.up, scratch.direction);
      scratch.scale.set(shot.scale * 0.48, shot.scale * 5.5, shot.scale * 0.48);
      scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale);
      projectile.setMatrixAt(index, scratch.matrix);

      const muzzlePulse = Math.max(0.001, 1 - progress * 9) * shot.scale * 7;
      scratch.quaternion.identity();
      scratch.position.set(...shot.source);
      scratch.scale.setScalar(muzzlePulse);
      scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale);
      muzzle.setMatrixAt(index, scratch.matrix);

      const impactPulse = Math.max(0.001, (progress - 0.82) * (1 - progress) * 28) * shot.scale * 9;
      scratch.position.set(...shot.target);
      scratch.scale.setScalar(impactPulse);
      scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale);
      impact.setMatrixAt(index, scratch.matrix);
    });
    projectile.instanceMatrix.needsUpdate = true;
    muzzle.instanceMatrix.needsUpdate = true;
    impact.instanceMatrix.needsUpdate = true;
  });

  if (shots.length === 0) {
    return null;
  }

  return (
    <>
      <instancedMesh ref={projectileRef} args={[undefined, undefined, shots.length]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#ffd36a" toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={muzzleRef} args={[undefined, undefined, shots.length]} frustumCulled={false}>
        <sphereGeometry args={[1, 7, 5]} />
        <meshBasicMaterial color="#ffb238" transparent opacity={0.88} blending={THREE.AdditiveBlending} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={impactRef} args={[undefined, undefined, shots.length]} frustumCulled={false}>
        <icosahedronGeometry args={[1, 1]} />
        <meshBasicMaterial color="#ff6a22" transparent opacity={0.76} blending={THREE.AdditiveBlending} toneMapped={false} />
      </instancedMesh>
    </>
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
  const previousObjects = useRef(new Map<string, Unit | Building>());
  const [bursts, setBursts] = useState<DestructionBurst[]>([]);
  const fireRef = useRef<THREE.InstancedMesh>(null);
  const debrisRef = useRef<THREE.InstancedMesh>(null);
  const scratch = useMemo(() => ({
    matrix: new THREE.Matrix4(),
    position: new THREE.Vector3(),
    scale: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
  }), []);

  useEffect(() => {
    const current = new Map([...units, ...buildings].map((object) => [object.id, object]));
    const destroyed: DestructionBurst[] = [];
    if (previousObjects.current.size > 0) {
      for (const [id, object] of previousObjects.current) {
        if (!current.has(id)) {
          destroyed.push({
            id: `${id}-${Date.now()}`,
            position: toWorldPosition(object.x, object.y, dimensions, object.type === "light_tank" ? 0.58 : 0.42),
            bornAt: Date.now() / 1000,
            scale: "productionQueue" in object ? 2.2 : object.type === "light_tank" ? 1.35 : 0.72,
          });
        }
      }
    }
    previousObjects.current = current;
    if (destroyed.length === 0) {
      return;
    }
    setBursts((currentBursts) => [...currentBursts, ...destroyed].slice(-24));
    const ids = new Set(destroyed.map((burst) => burst.id));
    window.setTimeout(() => {
      setBursts((currentBursts) => currentBursts.filter((burst) => !ids.has(burst.id)));
    }, 1200);
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

  if (bursts.length === 0) {
    return null;
  }

  return (
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
  );
}

function BuildingModel({ building, dimensions }: { building: Building; dimensions: MapDimensions }) {
  const palette = useMemo(() => getTeamPalette(building.playerId), [building.playerId]);
  const modelUrl =
    building.type === "hq"
      ? MODEL_URLS.hq
      : building.type === "barracks"
        ? MODEL_URLS.barracks
        : building.type === "war_factory"
          ? MODEL_URLS.war_factory
          : MODEL_URLS.refinery;
  const presentation = building.type === "hq"
    ? { scale: 1, healthY: 6.9, healthWidth: 3.4 }
    : building.type === "barracks"
      ? { scale: 0.92, healthY: 4.35, healthWidth: 2.45 }
      : building.type === "war_factory"
        ? { scale: 0.92, healthY: 5.15, healthWidth: 3.1 }
        : { scale: 0.94, healthY: 6.15, healthWidth: 2.7 };

  return (
    <group
      position={toWorldPosition(building.x, building.y, dimensions, 0)}
      scale={STRUCTURE_VISUAL_SCALE * presentation.scale}
    >
      <ModelInstance url={modelUrl} palette={palette} position={[0, 0, 0]} />
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

function IntentLines({ units, dimensions }: { units: Unit[]; dimensions: MapDimensions }) {
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
      const averageX = group.units.reduce((sum, unit) => sum + unit.x, 0) / group.units.length;
      const averageY = group.units.reduce((sum, unit) => sum + unit.y, 0) / group.units.length;
      return {
        source: toWorldPosition(averageX, averageY, dimensions, 0.18),
        target: toWorldPosition(group.targetX, group.targetY, dimensions, 0.18),
        color: group.color,
        key: `${group.units[0]?.playerId}:${group.targetX}:${group.targetY}`,
      };
    });
  }, [dimensions, units]);

  return (
    <>
      {formationLines.map((line) => {
        return (
          <Line
            key={line.key}
            points={[line.source, line.target]}
            color={line.color}
            lineWidth={1.1}
            transparent
            opacity={0.38}
          />
        );
      })}
    </>
  );
}

function useInterpolatedUnits(units: Unit[]): Unit[] {
  const sourceUnits = useRef(units);
  const visualPositions = useRef(new Map<string, { x: number; y: number }>());
  const transitions = useRef(new Map<string, { fromX: number; fromY: number; toX: number; toY: number; startedAtMs: number }>());
  const [displayUnits, setDisplayUnits] = useState(units);

  useEffect(() => {
    const now = performance.now();
    sourceUnits.current = units;
    const liveIds = new Set(units.map((unit) => unit.id));
    for (const [unitId] of visualPositions.current) {
      if (!liveIds.has(unitId)) {
        visualPositions.current.delete(unitId);
        transitions.current.delete(unitId);
      }
    }

    for (const unit of units) {
      const existing = visualPositions.current.get(unit.id);
      if (!existing) {
        visualPositions.current.set(unit.id, { x: unit.x, y: unit.y });
        transitions.current.set(unit.id, {
          fromX: unit.x,
          fromY: unit.y,
          toX: unit.x,
          toY: unit.y,
          startedAtMs: now,
        });
        continue;
      }
      const jumpDistance = Math.max(Math.abs(existing.x - unit.x), Math.abs(existing.y - unit.y));
      if (jumpDistance > UNIT_INTERPOLATION_SNAP_DISTANCE) {
        existing.x = unit.x;
        existing.y = unit.y;
      }
      transitions.current.set(unit.id, {
        fromX: existing.x,
        fromY: existing.y,
        toX: unit.x,
        toY: unit.y,
        startedAtMs: now,
      });
    }

    setDisplayUnits(units.map((unit) => {
      const visual = visualPositions.current.get(unit.id);
      return visual ? { ...unit, x: visual.x, y: visual.y } : unit;
    }));
  }, [units]);

  useFrame(() => {
    const now = performance.now();
    let changed = false;
    for (const [unitId, transition] of transitions.current) {
      const visual = visualPositions.current.get(unitId);
      if (!visual) {
        transitions.current.delete(unitId);
        continue;
      }

      const progress = Math.min(1, Math.max(0, (now - transition.startedAtMs) / UNIT_INTERPOLATION_DURATION_MS));
      const nextX = THREE.MathUtils.lerp(transition.fromX, transition.toX, progress);
      const nextY = THREE.MathUtils.lerp(transition.fromY, transition.toY, progress);
      if (Math.abs(nextX - visual.x) > 0.001 || Math.abs(nextY - visual.y) > 0.001) {
        changed = true;
      }
      visual.x = progress >= 1 ? transition.toX : nextX;
      visual.y = progress >= 1 ? transition.toY : nextY;

      if (progress >= 1) {
        transitions.current.delete(unitId);
      }
    }

    if (!changed) {
      return;
    }

    setDisplayUnits(sourceUnits.current.map((unit) => {
      const visual = visualPositions.current.get(unit.id);
      return visual ? { ...unit, x: visual.x, y: visual.y } : unit;
    }));
  });

  return displayUnits;
}

const BattlefieldScene = memo(function BattlefieldScene({ state }: { state: GameState }) {
  const dimensions = useMemo(() => getMapDimensions(state), [state]);
  const terrainWidth = dimensions.width * CELL_SIZE;
  const terrainHeight = dimensions.height * CELL_SIZE;
  const initialFocus = useMemo(
    () => getInitialCameraFocus(state, dimensions),
    [],
  );

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
  const displayUnits = useInterpolatedUnits(units);
  const resourceTransforms = useMemo(
    () => resourceTiles.map((tile) => getResourceTransform(tile, dimensions)),
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
          <BuildingModel key={building.id} building={building} dimensions={dimensions} />
        ))}
        <UnitBatches units={displayUnits} buildings={buildings} dimensions={dimensions} tick={state.tick} />
        <UnitReadabilityLayer units={displayUnits} dimensions={dimensions} />
        <CombatEffects
          units={displayUnits}
          buildings={buildings}
          projectiles={state.projectiles ?? []}
          dimensions={dimensions}
          tick={state.tick}
        />
        <DestructionEffects units={displayUnits} buildings={buildings} dimensions={dimensions} />
      </Suspense>
      {SHOW_DEBUG_INTENTS ? <IntentLines units={displayUnits} dimensions={dimensions} /> : null}
      <OrbitControls
        makeDefault
        target={initialFocus.target}
        enableDamping
        enablePan
        dampingFactor={0.08}
        minDistance={10}
        maxDistance={88}
        minPolarAngle={Math.PI * 0.18}
        maxPolarAngle={Math.PI * 0.42}
      />
    </>
  );
});

export function Battlefield3D({ state }: Battlefield3DProps) {
  const dimensions = state ? getMapDimensions(state) : { width: 96, height: 64 };
  const cameraFocus = state
    ? getInitialCameraFocus(state, dimensions)
    : { target: [0, 0, 0] as Vec3, position: [0, 23, 29] as Vec3 };

  if (!state) {
    return <div className="battlefield-3d empty-state">等待战场状态</div>;
  }

  return (
    <div className="battlefield-3d" data-testid="battlefield-3d">
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
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.08;
        }}
      >
        <BattlefieldScene state={state} />
      </Canvas>
    </div>
  );
}
