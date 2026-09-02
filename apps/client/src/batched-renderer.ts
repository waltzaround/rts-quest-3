import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  FIGHTER_SQUAD_OFFSETS,
  SHIPS,
  SHIP_TURRET_SCALES,
  getFighterSquadMemberPose,
} from "@space-rts/game-core";
import { getBatchedTurretGeometry, getShipHullGeometries, type HullGeometrySet } from "./combat-visuals";
import {
  MAX_RENDER_SHIPS,
  MAX_RENDER_TURRETS,
  SHIP_CLASSES,
  VisualLod,
  WEAPON_TYPES,
  type InterpolatedRenderState,
  type RenderQuality,
} from "./render-state";

type HullLayer = keyof HullGeometrySet;

interface InstanceBatch {
  mesh: THREE.InstancedMesh;
  count: number;
  capacity: number;
  colored: boolean;
}

interface FighterFormationVisual {
  yaw: number;
  lastSeen: number;
}

function wrappedAngleDelta(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

export interface BatchedRendererMetrics {
  shipInstances: number;
  turretInstances: number;
  thrusterInstances: number;
  activeBatches: number;
  transparentBatches: number;
  selectedShields: number;
}

const CLOSE_LAYERS: readonly HullLayer[] = ["hull", "armor", "dark", "accent", "light", "engine"];
const MEDIUM_LAYERS: readonly HullLayer[] = ["hull", "armor", "accent", "engine"];
const LARGE_BATTLE_MEDIUM_LAYERS: readonly HullLayer[] = ["hull", "accent"];

const BADGE_STROKE = 0.12;

function createBadgeBar(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  thickness = BADGE_STROKE,
): THREE.BufferGeometry {
  const deltaX = toX - fromX;
  const deltaY = toY - fromY;
  const geometry = new THREE.PlaneGeometry(Math.hypot(deltaX, deltaY), thickness);
  geometry.rotateZ(Math.atan2(deltaY, deltaX));
  geometry.translate((fromX + toX) / 2, (fromY + toY) / 2, 0);
  return geometry;
}

function createTacticalGeometry(classId: number): THREE.BufferGeometry {
  const pieces: THREE.BufferGeometry[] = [];
  const shipClass = SHIP_CLASSES[classId]!;
  const addBar = (
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    thickness = BADGE_STROKE,
  ): void => {
    pieces.push(createBadgeBar(fromX, fromY, toX, toY, thickness));
  };
  const addPolyline = (points: ReadonlyArray<readonly [number, number]>, thickness = BADGE_STROKE): void => {
    for (let index = 1; index < points.length; index += 1) {
      const from = points[index - 1]!;
      const to = points[index]!;
      addBar(from[0], from[1], to[0], to[1], thickness);
    }
  };
  const addClosedShape = (points: ReadonlyArray<readonly [number, number]>, thickness = BADGE_STROKE): void => {
    addPolyline([...points, points[0]!], thickness);
  };
  const addChevron = (x: number, y: number, width: number, height: number, thickness = 0.1): void => {
    addBar(x - width / 2, y - height / 2, x, y + height / 2, thickness);
    addBar(x, y + height / 2, x + width / 2, y - height / 2, thickness);
  };
  const addDiamond = (x: number, y: number, width: number, height: number, thickness = 0.1): void => {
    addClosedShape([
      [x, y + height / 2], [x + width / 2, y],
      [x, y - height / 2], [x - width / 2, y],
    ], thickness);
  };
  const addFrigateHull = (thickness = 0.13): void => {
    addClosedShape([
      [0, 0.9], [0.62, 0.22], [0.47, -0.72],
      [0, -0.5], [-0.47, -0.72], [-0.62, 0.22],
    ], thickness);
  };

  switch (shipClass) {
    case "fighter": // One unit is a five-craft squadron.
      addChevron(0, 0.58, 0.4, 0.3);
      addChevron(-0.47, 0.12, 0.4, 0.3);
      addChevron(0.47, 0.12, 0.4, 0.3);
      addChevron(-0.27, -0.42, 0.4, 0.3);
      addChevron(0.27, -0.42, 0.4, 0.3);
      break;
    case "bomber": // One broad strike craft, not a squadron marker.
      addClosedShape([
        [0, 0.88], [0.82, -0.28], [0.44, -0.62],
        [0, -0.38], [-0.44, -0.62], [-0.82, -0.28],
      ], 0.15);
      addBar(-0.56, -0.2, 0.56, -0.2, 0.13);
      addBar(0, -0.28, 0, 0.52, 0.13);
      break;
    case "fabricator": // Engineering diamond with a construction cross.
      addDiamond(0, 0, 1.34, 1.48, 0.14);
      addBar(-0.39, 0, 0.39, 0, 0.16);
      addBar(0, -0.39, 0, 0.39, 0.16);
      break;
    case "frigate": // Small pointed escort hull.
      addFrigateHull();
      addBar(0, -0.34, 0, 0.55, 0.13);
      break;
    case "flakFrigate": // Escort hull with an unmistakable flak burst.
      addFrigateHull();
      addBar(-0.36, -0.36, 0.36, 0.36, 0.12);
      addBar(-0.36, 0.36, 0.36, -0.36, 0.12);
      addBar(-0.48, 0, 0.48, 0, 0.12);
      addBar(0, -0.48, 0, 0.48, 0.12);
      break;
    case "torpedoFrigate": // Escort hull with paired launch rails.
      addFrigateHull();
      addBar(-0.25, -0.38, -0.25, 0.5, 0.15);
      addBar(0.25, -0.38, 0.25, 0.5, 0.15);
      addChevron(-0.25, 0.55, 0.28, 0.22, 0.1);
      addChevron(0.25, 0.55, 0.28, 0.22, 0.1);
      break;
    case "artilleryFrigate": // Narrow hull and one long-range gun.
      addFrigateHull();
      addBar(0, -0.42, 0, 0.76, 0.17);
      addBar(-0.38, -0.18, 0.38, -0.18, 0.12);
      addChevron(0, 0.8, 0.4, 0.24, 0.1);
      break;
    case "destroyer": // Broad line-warship diamond.
      addClosedShape([[0, 1], [0.88, 0.08], [0.62, -0.86], [0, -0.6], [-0.62, -0.86], [-0.88, 0.08]], 0.16);
      addBar(-0.58, 0.14, 0.58, 0.14, 0.17);
      addBar(-0.46, -0.22, 0.46, -0.22, 0.17);
      break;
    case "artilleryDestroyer": // Broad hull with twin siege barrels.
      addClosedShape([[0, 1], [0.85, 0.12], [0.62, -0.86], [0, -0.62], [-0.62, -0.86], [-0.85, 0.12]], 0.16);
      addBar(-0.26, -0.5, -0.26, 0.72, 0.17);
      addBar(0.26, -0.5, 0.26, 0.72, 0.17);
      addBar(-0.58, -0.28, 0.58, -0.28, 0.13);
      break;
    case "cruiser": // Wide heavy hull with a central armored spine.
      addClosedShape([[0, 1.02], [1.05, 0.4], [0.92, -0.68], [0, -0.9], [-0.92, -0.68], [-1.05, 0.4]], 0.17);
      addClosedShape([[0, 0.58], [0.52, 0.2], [0.42, -0.42], [0, -0.58], [-0.42, -0.42], [-0.52, 0.2]], 0.14);
      break;
    case "artilleryCruiser": // Heavy hull with paired strategic guns.
      addClosedShape([[0, 1.02], [1.05, 0.4], [0.92, -0.68], [0, -0.9], [-0.92, -0.68], [-1.05, 0.4]], 0.17);
      addBar(-0.3, -0.5, -0.3, 0.78, 0.18);
      addBar(0.3, -0.5, 0.3, 0.78, 0.18);
      addChevron(0, 0.84, 0.74, 0.3, 0.12);
      break;
    case "carrier": // Flight deck, runway, and embarked wing.
      addClosedShape([[-1.18, 0.72], [1.18, 0.72], [1.18, -0.72], [-1.18, -0.72]], 0.17);
      addBar(-0.72, 0, 0.72, 0, 0.13);
      addBar(0, -0.48, 0, 0.48, 0.13);
      addChevron(-0.68, 0.32, 0.34, 0.25, 0.09);
      addChevron(0.68, -0.32, 0.34, 0.25, 0.09);
      break;
    case "battleship": // Largest hull with three armored batteries.
      addClosedShape([
        [0, 1.08], [0.92, 0.72], [1.25, 0.18], [1.02, -0.74],
        [0, -0.96], [-1.02, -0.74], [-1.25, 0.18], [-0.92, 0.72],
      ], 0.19);
      addBar(-0.72, 0.38, 0.72, 0.38, 0.19);
      addBar(-0.76, 0, 0.76, 0, 0.19);
      addBar(-0.68, -0.38, 0.68, -0.38, 0.19);
      break;
  }

  const geometry = mergeGeometries(pieces, false);
  if (!geometry) throw new Error("Unable to build tactical badge geometry");
  return geometry;
}

function createSelectionGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.RingGeometry(0.92, 1, 32);
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

function createThrusterTrailGeometry(): THREE.BufferGeometry {
  // Two cheap shells share one instance and draw call. The inner shell gives
  // the plume a white-hot core instead of requiring a second instanced batch.
  const outer = new THREE.ConeGeometry(1, 1, 9, 2, true);
  outer.rotateX(-Math.PI / 2);
  outer.setAttribute("thrusterLayer", new THREE.BufferAttribute(
    new Float32Array(outer.getAttribute("position").count), 1,
  ));
  const core = new THREE.ConeGeometry(1, 1, 7, 1, true);
  core.rotateX(-Math.PI / 2);
  core.scale(0.46, 0.46, 0.72);
  core.translate(0, 0, 0.14);
  core.setAttribute("thrusterLayer", new THREE.BufferAttribute(
    new Float32Array(core.getAttribute("position").count).fill(1), 1,
  ));
  const merged = mergeGeometries([outer, core], false);
  if (!merged) throw new Error("Unable to build thruster geometry");
  return merged;
}

function createThrusterMaterial(time: { value: number }): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.52,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.thrusterTime = time;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
        attribute float thrusterLayer;
        varying float vThrusterAxial;
        varying float vThrusterLayer;
        varying float vThrusterPhase;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        vThrusterAxial = clamp(position.z + 0.5, 0.0, 1.0);
        vThrusterLayer = thrusterLayer;
        vThrusterPhase = dot(instanceMatrix[3].xz, vec2(0.071, 0.113));`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        uniform float thrusterTime;
        varying float vThrusterAxial;
        varying float vThrusterLayer;
        varying float vThrusterPhase;`)
      .replace("#include <opaque_fragment>", `
        float plumeNoise = sin(vThrusterAxial * 31.0 - thrusterTime * 10.5 + vThrusterPhase);
        plumeNoise += sin(vThrusterAxial * 13.0 + thrusterTime * 6.7 + vThrusterPhase * 1.9) * 0.5;
        float tipFade = smoothstep(0.015, vThrusterLayer > 0.5 ? 0.22 : 0.34, vThrusterAxial);
        float nozzleHeat = smoothstep(0.18, 1.0, vThrusterAxial);
        float shimmer = 0.86 + plumeNoise * (0.065 + (1.0 - vThrusterAxial) * 0.055);
        diffuseColor.a *= tipFade * shimmer * (vThrusterLayer > 0.5 ? 0.82 : 0.58);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.985, 1.0),
          nozzleHeat * (vThrusterLayer > 0.5 ? 0.92 : 0.34));
        #include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => "layered-thruster-v1";
  return material;
}

function createBatch(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  capacity: number,
  colored: boolean,
): InstanceBatch {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.count = 0;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  return { mesh, count: 0, capacity, colored };
}

const QUALITY_ENGINE_SCALE: Readonly<Record<RenderQuality, number>> = { low: 0.78, medium: 1, high: 1.16 };
const TACTICAL_SCALE = [12.5, 11, 12.5, 12.5, 13.5, 13.5, 14, 15, 15.5, 16.5, 17.5, 18.5, 20] as const;
const TACTICAL_SELECTION_RADIUS = [18, 16, 18, 18, 19, 19, 20, 22, 23, 24, 26, 27, 29] as const;
const CLOSE_SELECTION_RADIUS = [22, 13, 17, 7.5, 18, 19, 29, 42, 56, 64] as const;
const THRUSTER_REAR = [-3.65, -11.5, -15.1, -5.1, -15.4, -15.4, -29.2, -34.8, -45.5, -56] as const;
const THRUSTER_WIDTH = [0.3, 1.05, 1.35, 0.65, 1.42, 1.48, 1.72, 2.35, 2.4, 2.7] as const;
const THRUSTER_LENGTH = [3.2, 9, 12, 5, 12, 12, 21, 28, 34, 44] as const;
const THRUSTER_OFFSETS: ReadonlyArray<readonly number[]> = [
  [-0.46, 0.46], [-7.8, 7.8], [-10.5, 10.5], [-3.1, 3.1], [-11.3, 11.3], [-11.8, 11.8],
  [-9, -3, 3, 9], [-22, 22], [-30, -21, -5, 5, 21, 30], [-18, -11, -4, 4, 11, 18],
];
const THRUSTER_COLOR = [0x8ff7ff, 0x79f0c8, 0x78e8ff, 0x72dfff, 0x82f3ff, 0x77dcff, 0x68cfff, 0x77c5ff, 0x9abaff, 0xffbd78] as const;
const HEALTH_BAR_GREEN = new THREE.Color(0x63df8c);
const HEALTH_BAR_AMBER = new THREE.Color(0xf1bd5a);
const HEALTH_BAR_RED = new THREE.Color(0xff5674);
const DAMAGE_SCORCH = new THREE.Color(0x24130d);
const ARTILLERY_REVEAL = new THREE.Color(0xffb35c);
const DAMAGE_EMBER = new THREE.Color(0xff6a24);
const DAMAGE_EMBER_HOT = new THREE.Color(0xffc04f);
const MAX_DAMAGE_INSTANCES = 256;
const DAMAGE_VISIBLE_CLASS_IDS = new Set([2, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

export class BatchedShipRenderer {
  readonly group = new THREE.Group();
  readonly metrics: BatchedRendererMetrics = {
    shipInstances: 0,
    turretInstances: 0,
    thrusterInstances: 0,
    activeBatches: 0,
    transparentBatches: 0,
    selectedShields: 0,
  };

  private readonly hullBatches: Array<Array<Partial<Record<HullLayer, InstanceBatch>>>> = Array.from(
    { length: 4 },
    () => Array.from({ length: SHIP_CLASSES.length }, () => ({})),
  );
  private readonly turretBatches: InstanceBatch[] = [];
  private readonly allBatches: InstanceBatch[] = [];
  private readonly selectionBatch: InstanceBatch;
  private readonly shieldBatch: InstanceBatch;
  private readonly thrusterBatch: InstanceBatch;
  private readonly healthBarBackgroundBatch: InstanceBatch;
  private readonly healthBarFillBatch: InstanceBatch;
  private readonly damageBatch: InstanceBatch;
  private readonly thrusterTime = { value: 0 };
  private readonly shipMatrices = new Float32Array(MAX_RENDER_SHIPS * 16);
  private readonly matrix = new THREE.Matrix4();
  private readonly localMatrix = new THREE.Matrix4();
  private readonly memberMatrix = new THREE.Matrix4();
  private readonly scaleMatrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly yawQuaternion = new THREE.Quaternion();
  private readonly bankQuaternion = new THREE.Quaternion();
  private readonly memberQuaternion = new THREE.Quaternion();
  private readonly memberYawQuaternion = new THREE.Quaternion();
  private readonly memberBankQuaternion = new THREE.Quaternion();
  private readonly fighterFormations = new Map<number, FighterFormationVisual>();
  private readonly position = new THREE.Vector3();
  private readonly memberPosition = new THREE.Vector3();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly color = new THREE.Color();
  private readonly tint = new THREE.Color();
  private readonly white = new THREE.Color(0xffffff);
  private readonly forwardAxis = new THREE.Vector3(0, 0, 1);
  private readonly identityQuaternion = new THREE.Quaternion();
  private readonly billboardQuaternion = new THREE.Quaternion();
  private readonly screenRight = new THREE.Vector3();
  private readonly screenUp = new THREE.Vector3();
  private quality: RenderQuality = "medium";
  private lastUpdateAt = 0;

  constructor(scene: THREE.Scene) {
    const hullMaterial = new THREE.MeshStandardMaterial({
      color: 0xc1ced6, emissive: 0x102b3b, emissiveIntensity: 0.68,
      metalness: 0.7, roughness: 0.36, flatShading: true,
    });
    const armorMaterial = new THREE.MeshStandardMaterial({
      color: 0x8e9da7, emissive: 0x0b1d29, emissiveIntensity: 0.58,
      metalness: 0.78, roughness: 0.32, flatShading: true,
    });
    const darkMaterial = new THREE.MeshStandardMaterial({
      color: 0x1b2b36, emissive: 0x07141d, emissiveIntensity: 0.72,
      metalness: 0.62, roughness: 0.46, flatShading: true,
    });
    const accentMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const lightMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const engineMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.82,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    });
    const layerMaterials: Readonly<Record<HullLayer, THREE.Material>> = {
      hull: hullMaterial,
      armor: armorMaterial,
      dark: darkMaterial,
      accent: accentMaterial,
      light: lightMaterial,
      engine: engineMaterial,
    };

    for (let classId = 0; classId < SHIP_CLASSES.length; classId += 1) {
      const shipClass = SHIP_CLASSES[classId]!;
      const geometry = getShipHullGeometries(shipClass);
      // Adaptive squad LOD never expands more than two members once the fleet
      // is large enough to approach MAX_RENDER_SHIPS. Keeping this bounded at
      // 2x avoids uploading worst-case five-member buffers for every layer.
      const detailedCapacity = shipClass === "fighter" ? MAX_RENDER_SHIPS * 2 : MAX_RENDER_SHIPS;
      for (const lod of [VisualLod.Close, VisualLod.Medium] as const) {
        const layers = lod === VisualLod.Close ? CLOSE_LAYERS : MEDIUM_LAYERS;
        for (const layer of layers) {
          const colored = layer === "hull" || layer === "armor" || layer === "accent" || layer === "light" || layer === "engine";
          const batch = createBatch(geometry[layer], layerMaterials[layer], detailedCapacity, colored);
          this.hullBatches[lod]![classId]![layer] = batch;
          this.allBatches.push(batch);
          this.group.add(batch.mesh);
        }
      }
      const farBatch = createBatch(geometry.hull, new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), MAX_RENDER_SHIPS, true);
      this.hullBatches[VisualLod.Far]![classId]!.hull = farBatch;
      this.allBatches.push(farBatch);
      this.group.add(farBatch.mesh);
      const tacticalBatch = createBatch(
        createTacticalGeometry(classId),
        new THREE.MeshBasicMaterial({
          color: 0xffffff, transparent: true, opacity: 0.96, side: THREE.DoubleSide,
          depthWrite: false, depthTest: false, fog: false, toneMapped: false,
        }),
        MAX_RENDER_SHIPS,
        true,
      );
      tacticalBatch.mesh.renderOrder = 40;
      this.hullBatches[VisualLod.Tactical]![classId]!.hull = tacticalBatch;
      this.allBatches.push(tacticalBatch);
      this.group.add(tacticalBatch.mesh);
    }

    const turretMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0x061017, emissiveIntensity: 0.5, metalness: 0.72, roughness: 0.34,
      flatShading: true, vertexColors: true,
    });
    for (const weaponType of WEAPON_TYPES) {
      const batch = createBatch(getBatchedTurretGeometry(weaponType), turretMaterial, MAX_RENDER_TURRETS, true);
      this.turretBatches.push(batch);
      this.allBatches.push(batch);
      this.group.add(batch.mesh);
    }

    this.selectionBatch = createBatch(
      createSelectionGeometry(),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
        depthWrite: false, depthTest: false, fog: false, toneMapped: false,
      }),
      MAX_RENDER_SHIPS,
      true,
    );
    this.selectionBatch.mesh.renderOrder = 42;
    this.shieldBatch = createBatch(
      new THREE.SphereGeometry(1, 10, 6),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.075, wireframe: true, depthWrite: false, toneMapped: false }),
      MAX_RENDER_SHIPS,
      true,
    );
    this.thrusterBatch = createBatch(
      createThrusterTrailGeometry(),
      createThrusterMaterial(this.thrusterTime),
      MAX_RENDER_SHIPS * 2,
      true,
    );
    const healthBarGeometry = new THREE.PlaneGeometry(1, 1);
    this.healthBarBackgroundBatch = createBatch(
      healthBarGeometry,
      new THREE.MeshBasicMaterial({
        color: 0x020609, transparent: true, opacity: 0.86, side: THREE.DoubleSide,
        depthWrite: false, depthTest: false, fog: false, toneMapped: false,
      }),
      MAX_RENDER_SHIPS,
      false,
    );
    this.healthBarFillBatch = createBatch(
      healthBarGeometry,
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.96, side: THREE.DoubleSide,
        depthWrite: false, depthTest: false, fog: false, toneMapped: false,
      }),
      MAX_RENDER_SHIPS,
      true,
    );
    const damageGeometry = mergeGeometries([
      new THREE.IcosahedronGeometry(0.72, 0),
      new THREE.ConeGeometry(0.72, 2.8, 5).toNonIndexed().translate(0, 1.6, 0),
      new THREE.ConeGeometry(0.46, 2.1, 5).toNonIndexed().translate(0.55, 1.25, 0.18),
    ], false)!;
    this.damageBatch = createBatch(
      damageGeometry,
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.72,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      }),
      MAX_DAMAGE_INSTANCES,
      true,
    );
    this.damageBatch.mesh.renderOrder = 2;
    this.healthBarBackgroundBatch.mesh.renderOrder = 44;
    this.healthBarFillBatch.mesh.renderOrder = 45;
    this.thrusterBatch.mesh.renderOrder = 1;
    this.allBatches.push(
      this.selectionBatch, this.shieldBatch, this.thrusterBatch,
      this.healthBarBackgroundBatch, this.healthBarFillBatch, this.damageBatch,
    );
    this.group.add(
      this.selectionBatch.mesh, this.shieldBatch.mesh, this.thrusterBatch.mesh,
      this.healthBarBackgroundBatch.mesh, this.healthBarFillBatch.mesh, this.damageBatch.mesh,
    );
    scene.add(this.group);
  }

  setQuality(quality: RenderQuality): void {
    this.quality = quality;
    (this.shieldBatch.mesh.material as THREE.MeshBasicMaterial).opacity = quality === "low" ? 0.045 : quality === "medium" ? 0.075 : 0.095;
  }

  clearHistory(): void {
    this.fighterFormations.clear();
    this.lastUpdateAt = 0;
  }

  update(
    state: InterpolatedRenderState,
    now: number,
    camera: THREE.PerspectiveCamera,
    viewportHeight: number,
    tacticalScaleMultiplier = 1,
    visualTick = now * 0.02,
    showHealthBars = true,
  ): void {
    this.thrusterTime.value = now * 0.001;
    for (const batch of this.allBatches) batch.count = 0;
    this.metrics.shipInstances = state.shipCount;
    this.metrics.turretInstances = state.turretCount;
    this.metrics.thrusterInstances = 0;
    this.metrics.selectedShields = 0;
    const enginePulse = 0.94 + Math.sin(now * 0.018) * 0.09;
    const deltaSeconds = this.lastUpdateAt === 0 ? 1 / 60 : Math.min(0.05, Math.max(0, (now - this.lastUpdateAt) / 1_000));
    this.lastUpdateAt = now;
    this.billboardQuaternion.copy(camera.quaternion);
    this.screenRight.set(1, 0, 0).applyQuaternion(this.billboardQuaternion);
    this.screenUp.set(0, 1, 0).applyQuaternion(this.billboardQuaternion);
    const focalPixels = Math.max(1, viewportHeight) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));

    for (let index = 0; index < state.shipCount; index += 1) {
      const positionIndex = index * 3;
      this.position.set(
        state.shipPosition[positionIndex]!,
        state.shipPosition[positionIndex + 1]!,
        state.shipPosition[positionIndex + 2]!,
      );
      this.yawQuaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, state.shipYaw[index]!);
      this.bankQuaternion.setFromAxisAngle(this.forwardAxis, state.shipBank[index]!);
      this.quaternion.multiplyQuaternions(this.yawQuaternion, this.bankQuaternion);
      this.scale.set(1, 1, 1);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.matrix.toArray(this.shipMatrices, index * 16);
      this.color.setHex(state.shipColor[index]!);
      const health = state.shipHealth[index]!;
      this.tint.copy(this.color).lerp(this.white, 0.58).multiplyScalar(0.62 + health * 0.38);
      if (state.shipRevealed[index]) this.tint.lerp(ARTILLERY_REVEAL, 0.22 + Math.sin(now * 0.014) * 0.08);
      if (health < 0.7) this.tint.lerp(DAMAGE_SCORCH, Math.min(0.58, (0.7 - health) * 0.92));
      if (health < 0.3) this.color.multiplyScalar(0.62 + Math.abs(Math.sin(now * 0.012 + state.shipIds[index]!)) * 0.38);
      const lod = state.shipLod[index]! as VisualLod;
      const classId = state.shipClass[index]!;

      if (lod === VisualLod.Close || lod === VisualLod.Medium) {
        const layers = lod === VisualLod.Close
          ? CLOSE_LAYERS
          : state.shipCount > 768
            ? LARGE_BATTLE_MEDIUM_LAYERS
            : MEDIUM_LAYERS;
        const fighterCraftCount = Math.max(1, Math.ceil(health * FIGHTER_SQUAD_OFFSETS.length));
        const memberCount = classId !== 0
          ? 1
          : state.shipCount > 1_024
            ? lod === VisualLod.Close ? Math.min(2, fighterCraftCount) : 1
            : state.shipCount > 384
              ? lod === VisualLod.Close ? Math.min(3, fighterCraftCount) : 1
              : lod === VisualLod.Close
                ? fighterCraftCount
                : Math.min(3, fighterCraftCount);
        const centerX = this.position.x;
        const centerY = this.position.y;
        const centerZ = this.position.z;
        const shipId = state.shipIds[index]!;
        const desiredYaw = state.shipYaw[index]!;
        let formationYaw = desiredYaw;
        if (classId === 0) {
          let formation = this.fighterFormations.get(shipId);
          if (!formation || state.shipNewlyVisible[index]) {
            formation = { yaw: desiredYaw, lastSeen: now };
            this.fighterFormations.set(shipId, formation);
          }
          formation.yaw += wrappedAngleDelta(desiredYaw - formation.yaw) * Math.min(1, deltaSeconds * 2.6);
          formation.lastSeen = now;
          formationYaw = formation.yaw;
        }
        for (let member = 0; member < memberCount; member += 1) {
          if (classId === 0) {
            const pose = getFighterSquadMemberPose(shipId, member, visualTick);
            const formationCosine = Math.cos(formationYaw);
            const formationSine = Math.sin(formationYaw);
            this.memberPosition.set(
              centerX + formationCosine * pose.x + formationSine * pose.z,
              centerY + pose.y,
              centerZ - formationSine * pose.x + formationCosine * pose.z,
            );
            this.memberYawQuaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, desiredYaw + pose.yaw);
            const independentBank = pose.bank + state.shipBank[index]! * (member === 0 ? 1 : 0.28);
            this.memberBankQuaternion.setFromAxisAngle(this.forwardAxis, independentBank);
            this.memberQuaternion.multiplyQuaternions(this.memberYawQuaternion, this.memberBankQuaternion);
            this.memberMatrix.compose(this.memberPosition, this.memberQuaternion, this.scale.set(1, 1, 1));
          } else {
            this.memberMatrix.copy(this.matrix);
          }
          for (const layer of layers) {
            const batch = this.hullBatches[lod]![classId]![layer]!;
            if (layer === "engine") {
              this.scaleMatrix.makeScale(1, 1, enginePulse * state.shipEngine[index]! * QUALITY_ENGINE_SCALE[this.quality]);
              this.localMatrix.copy(this.memberMatrix).multiply(this.scaleMatrix);
              this.writeInstance(batch, this.localMatrix, this.color);
            } else {
              const layerColor = layer === "hull" || layer === "armor" ? this.tint : this.color;
              this.writeInstance(batch, this.memberMatrix, layerColor);
            }
          }
          this.writeThrusters(state, index, lod, now, this.memberMatrix);
        }
        this.position.set(centerX, centerY, centerZ);
      } else {
        const batch = this.hullBatches[lod]![classId]!.hull!;
        if (lod === VisualLod.Tactical) {
          const tacticalScale = (TACTICAL_SCALE[classId] ?? 28) * tacticalScaleMultiplier;
          this.scale.setScalar(tacticalScale);
          this.position.y = 1.5;
          this.localMatrix.compose(this.position, this.billboardQuaternion, this.scale);
          this.writeInstance(batch, this.localMatrix, this.color);
        } else {
          this.writeInstance(batch, this.matrix, this.color);
        }
      }

      if (state.shipSelected[index]) {
        const radius = lod === VisualLod.Tactical
          ? (TACTICAL_SELECTION_RADIUS[classId] ?? 34) * tacticalScaleMultiplier
          : CLOSE_SELECTION_RADIUS[classId] ?? 29;
        this.position.y -= 4;
        this.scale.setScalar(radius);
        this.localMatrix.compose(this.position, this.identityQuaternion, this.scale);
        this.writeInstance(this.selectionBatch, this.localMatrix, this.color);
        if (lod <= VisualLod.Medium && this.quality !== "low") {
          this.position.y += 6;
          this.scale.set(radius * 0.86, radius * 0.34, radius * 0.86);
          this.localMatrix.compose(this.position, this.identityQuaternion, this.scale);
          this.writeInstance(this.shieldBatch, this.localMatrix, this.color);
          this.metrics.selectedShields += 1;
        }
      }

      if (showHealthBars && health < 0.995 && health > 0) {
        this.writeHealthBar(state, index, classId, lod, health, camera, focalPixels);
      }
      if (health > 0 && health < 0.7 && (lod === VisualLod.Close || lod === VisualLod.Medium)) {
        this.writeShipDamage(state, index, classId, health, now);
      }
    }

    for (const [shipId, formation] of this.fighterFormations) {
      if (now - formation.lastSeen > 2_000) this.fighterFormations.delete(shipId);
    }

    for (let index = 0; index < state.turretCount; index += 1) {
      const ownerIndex = state.turretOwner[index]!;
      const classId = state.shipClass[ownerIndex]!;
      const shipClass = SHIP_CLASSES[classId]!;
      const turretScale = SHIP_TURRET_SCALES[shipClass] ?? 1.24;
      const verticalScale = shipClass === "cruiser" || shipClass === "carrier" || shipClass === "battleship"
        ? 0.62
        : shipClass === "destroyer" || shipClass === "artilleryDestroyer"
          ? 0.74
          : 0.86;
      this.localMatrix.makeRotationY(state.turretYaw[index]!);
      this.localMatrix.setPosition(
        state.turretLocalX[index]!,
        state.turretLocalY[index]!,
        state.turretLocalZ[index]!,
      );
      this.localMatrix.scale(this.scale.set(turretScale, turretScale * verticalScale, turretScale));
      this.matrix.fromArray(this.shipMatrices, ownerIndex * 16).multiply(this.localMatrix);
      this.color.setHex(state.turretColor[index]!);
      this.writeInstance(this.turretBatches[state.turretType[index]!]!, this.matrix, this.color);
    }

    this.metrics.activeBatches = 0;
    this.metrics.transparentBatches = 0;
    for (const batch of this.allBatches) {
      batch.mesh.count = batch.count;
      if (batch.count > 0) {
        batch.mesh.instanceMatrix.clearUpdateRanges();
        batch.mesh.instanceMatrix.addUpdateRange(0, batch.count * 16);
        batch.mesh.instanceMatrix.needsUpdate = true;
        if (batch.colored && batch.mesh.instanceColor) {
          batch.mesh.instanceColor.clearUpdateRanges();
          batch.mesh.instanceColor.addUpdateRange(0, batch.count * 3);
          batch.mesh.instanceColor.needsUpdate = true;
        }
        this.metrics.activeBatches += 1;
        const material = Array.isArray(batch.mesh.material) ? batch.mesh.material[0] : batch.mesh.material;
        if (material?.transparent) this.metrics.transparentBatches += 1;
      }
    }
  }

  private writeInstance(batch: InstanceBatch, matrix: THREE.Matrix4, color: THREE.Color): void {
    if (batch.count >= batch.capacity) return;
    const index = batch.count++;
    batch.mesh.setMatrixAt(index, matrix);
    if (batch.colored) batch.mesh.setColorAt(index, color);
  }

  private writeHealthBar(
    state: InterpolatedRenderState,
    shipIndex: number,
    classId: number,
    lod: VisualLod,
    health: number,
    camera: THREE.PerspectiveCamera,
    focalPixels: number,
  ): void {
    const shipClass = SHIP_CLASSES[classId]!;
    const positionIndex = shipIndex * 3;
    this.position.set(
      state.shipPosition[positionIndex]!,
      state.shipPosition[positionIndex + 1]!,
      state.shipPosition[positionIndex + 2]!,
    );
    const distance = Math.max(1, camera.position.distanceTo(this.position));
    const worldPerPixel = distance / focalPixels;
    const radiusPixels = SHIPS[shipClass].radius * focalPixels / distance;
    const widthPixels = lod === VisualLod.Tactical
      ? 24
      : THREE.MathUtils.clamp(24 + radiusPixels * 0.32, 24, 42);
    const offsetPixels = lod === VisualLod.Tactical
      ? 15
      : THREE.MathUtils.clamp(13 + radiusPixels * 0.72, 16, 48);
    const width = widthPixels * worldPerPixel;
    const backgroundHeight = 5 * worldPerPixel;
    const fillHeight = 3 * worldPerPixel;
    this.position.addScaledVector(this.screenUp, offsetPixels * worldPerPixel);

    this.scale.set(width + 2 * worldPerPixel, backgroundHeight, 1);
    this.matrix.compose(this.position, this.billboardQuaternion, this.scale);
    this.writeInstance(this.healthBarBackgroundBatch, this.matrix, this.white);

    const fillWidth = Math.max(worldPerPixel, width * health);
    this.position.addScaledVector(this.screenRight, (fillWidth - width) * 0.5);
    this.position.addScaledVector(this.screenUp, 0.1 * worldPerPixel);
    this.scale.set(fillWidth, fillHeight, 1);
    this.matrix.compose(this.position, this.billboardQuaternion, this.scale);
    const fillColor = health < 0.3
      ? HEALTH_BAR_RED
      : health < 0.6
        ? HEALTH_BAR_AMBER
        : HEALTH_BAR_GREEN;
    this.writeInstance(this.healthBarFillBatch, this.matrix, fillColor);
  }

  private writeShipDamage(
    state: InterpolatedRenderState,
    shipIndex: number,
    classId: number,
    health: number,
    now: number,
  ): void {
    if (!DAMAGE_VISIBLE_CLASS_IDS.has(classId) || this.damageBatch.count >= MAX_DAMAGE_INSTANCES) return;
    if (this.quality === "low" && health >= 0.35) return;
    if (state.shipCount > 1_024 && classId < 6) return;
    const shipClass = SHIP_CLASSES[classId]!;
    const radius = SHIPS[shipClass].radius;
    const shipId = state.shipIds[shipIndex]!;
    const breachCount = health < 0.22 && this.quality === "high" ? 2 : 1;
    this.matrix.fromArray(this.shipMatrices, shipIndex * 16);
    for (let breach = 0; breach < breachCount && this.damageBatch.count < MAX_DAMAGE_INSTANCES; breach += 1) {
      const phase = shipId * 1.618 + breach * 2.71;
      const pulse = 0.82 + Math.abs(Math.sin(now * 0.009 + phase)) * 0.38;
      const severity = Math.min(1, (0.7 - health) / 0.7);
      this.position.set(
        Math.sin(phase * 1.7) * radius * 0.38,
        radius * (0.1 + Math.abs(Math.sin(phase * 0.73)) * 0.12),
        Math.cos(phase * 1.31) * radius * 0.42,
      );
      const size = Math.max(0.75, radius * (0.055 + severity * 0.045)) * pulse;
      this.scale.set(size, size * (0.9 + severity * 0.45), size);
      this.localMatrix.compose(this.position, this.identityQuaternion, this.scale).premultiply(this.matrix);
      this.writeInstance(
        this.damageBatch,
        this.localMatrix,
        health < 0.28 ? DAMAGE_EMBER_HOT : DAMAGE_EMBER,
      );
    }
  }

  private writeThrusters(
    state: InterpolatedRenderState,
    shipIndex: number,
    lod: VisualLod.Close | VisualLod.Medium,
    now: number,
    shipMatrix: THREE.Matrix4,
  ): void {
    const classId = state.shipClass[shipIndex]!;
    const offsets = THRUSTER_OFFSETS[classId] ?? [0];
    const nozzleCount = lod === VisualLod.Close && this.quality !== "low" ? offsets.length : 1;
    const engine = state.shipEngine[shipIndex]!;
    const pulse = 0.88 + Math.sin(now * 0.026 + state.shipIds[shipIndex]! * 0.73) * 0.12;
    const cruiseScale = state.shipCruising[shipIndex] ? 1.18 : 1;
    const length = (THRUSTER_LENGTH[classId] ?? 20) * (0.46 + engine * 0.62) * pulse
      * QUALITY_ENGINE_SCALE[this.quality] * cruiseScale;
    const width = (THRUSTER_WIDTH[classId] ?? 2) * (0.72 + engine * 0.32);
    const rear = THRUSTER_REAR[classId] ?? -24;
    this.color.setHex(state.shipCruising[shipIndex] ? 0xa8efff : THRUSTER_COLOR[classId] ?? 0x77ddff);
    for (let nozzle = 0; nozzle < nozzleCount && this.thrusterBatch.count < this.thrusterBatch.capacity; nozzle += 1) {
      const offset = nozzleCount === 1 ? 0 : (offsets[nozzle] ?? 0);
      this.position.set(offset, 0.4, rear - length * 0.5);
      this.scale.set(width, width * 0.72, length);
      this.localMatrix.compose(this.position, this.identityQuaternion, this.scale).premultiply(shipMatrix);
      this.writeInstance(this.thrusterBatch, this.localMatrix, this.color);
    }
    this.metrics.thrusterInstances = this.thrusterBatch.count;
  }

}

const enum EffectMode { Flash, Ripple, Ring, Debris }

class EffectPool {
  readonly mesh: THREE.InstancedMesh;
  readonly capacity: number;
  activeCount = 0;
  usedCount = 0;
  private cursor = 0;
  private readonly born: Float64Array;
  private readonly duration: Float32Array;
  private readonly position: Float32Array;
  private readonly velocity: Float32Array;
  private readonly scale: Float32Array;
  private readonly color: Uint32Array;
  private readonly mode: EffectMode;
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly positionScratch = new THREE.Vector3();
  private readonly scaleScratch = new THREE.Vector3();
  private readonly colorScratch = new THREE.Color();
  private readonly xAxis = new THREE.Vector3(1, 0, 0);

  constructor(
    scene: THREE.Scene,
    geometry: THREE.BufferGeometry,
    capacity: number,
    mode: EffectMode,
    opacity: number,
    blending: THREE.Blending = THREE.AdditiveBlending,
  ) {
    this.capacity = capacity;
    this.mode = mode;
    this.born = new Float64Array(capacity);
    this.duration = new Float32Array(capacity);
    this.position = new Float32Array(capacity * 3);
    this.velocity = new Float32Array(capacity * 3);
    this.scale = new Float32Array(capacity);
    this.color = new Uint32Array(capacity);
    this.mesh = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity, blending,
      depthWrite: blending === THREE.NormalBlending, side: THREE.DoubleSide,
      toneMapped: blending === THREE.NormalBlending,
    }), capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
  }

  spawn(
    x: number, y: number, z: number, size: number, color: number, now: number, duration: number,
    velocityX = 0, velocityY = 0, velocityZ = 0,
  ): void {
    const index = this.cursor++ % this.capacity;
    const positionIndex = index * 3;
    this.born[index] = now;
    this.duration[index] = duration;
    this.position[positionIndex] = x;
    this.position[positionIndex + 1] = y;
    this.position[positionIndex + 2] = z;
    this.velocity[positionIndex] = velocityX;
    this.velocity[positionIndex + 1] = velocityY;
    this.velocity[positionIndex + 2] = velocityZ;
    this.scale[index] = size;
    this.color[index] = color;
    this.usedCount = Math.min(this.capacity, this.usedCount + 1);
  }

  update(now: number): void {
    let visible = 0;
    for (let index = 0; index < this.usedCount; index += 1) {
      const age = now - this.born[index]!;
      const duration = this.duration[index]!;
      if (age < 0 || age >= duration) continue;
      const progress = age / duration;
      const positionIndex = index * 3;
      this.positionScratch.set(
        this.position[positionIndex]! + this.velocity[positionIndex]! * age / 1_000,
        this.position[positionIndex + 1]! + this.velocity[positionIndex + 1]! * age / 1_000,
        this.position[positionIndex + 2]! + this.velocity[positionIndex + 2]! * age / 1_000,
      );
      const baseScale = this.scale[index]!;
      const animatedScale = this.mode === EffectMode.Ripple
        ? baseScale * (0.72 + progress * 0.5)
        : this.mode === EffectMode.Ring
        ? baseScale * (0.25 + progress * 1.9)
        : this.mode === EffectMode.Debris
          ? baseScale * (1 - progress * 0.55)
          : baseScale * Math.sin(Math.PI * Math.min(1, progress * 1.1));
      this.scaleScratch.setScalar(Math.max(0.001, animatedScale));
      if (this.mode === EffectMode.Ripple || this.mode === EffectMode.Ring) this.quaternion.setFromAxisAngle(this.xAxis, Math.PI / 2);
      else this.quaternion.setFromEuler(new THREE.Euler(progress * 4 + index, progress * 6, progress * 3));
      this.matrix.compose(this.positionScratch, this.quaternion, this.scaleScratch);
      this.mesh.setMatrixAt(visible, this.matrix);
      this.mesh.setColorAt(visible, this.colorScratch.setHex(this.color[index]!));
      visible += 1;
    }
    this.activeCount = visible;
    this.mesh.count = visible;
    if (visible > 0) {
      this.mesh.instanceMatrix.clearUpdateRanges();
      this.mesh.instanceMatrix.addUpdateRange(0, visible * 16);
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) {
        this.mesh.instanceColor.clearUpdateRanges();
        this.mesh.instanceColor.addUpdateRange(0, visible * 3);
        this.mesh.instanceColor.needsUpdate = true;
      }
    }
  }
}

const MAX_BEAMS = 384;
const BEAM_VERTICES = 6;

function createBeamMesh(opacity: number): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  const positions = new THREE.BufferAttribute(new Float32Array(MAX_BEAMS * BEAM_VERTICES * 3), 3);
  const colors = new THREE.BufferAttribute(new Float32Array(MAX_BEAMS * BEAM_VERTICES * 3), 3);
  positions.setUsage(THREE.DynamicDrawUsage);
  colors.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", positions);
  geometry.setAttribute("color", colors);
  geometry.setDrawRange(0, 0);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  }));
  mesh.frustumCulled = false;
  return mesh;
}

class BeamPool {
  readonly capacity = MAX_BEAMS;
  activeCount = 0;
  private cursor = 0;
  private usedCount = 0;
  private readonly born = new Float64Array(MAX_BEAMS);
  private readonly duration = new Float32Array(MAX_BEAMS);
  private readonly start = new Float32Array(MAX_BEAMS * 3);
  private readonly end = new Float32Array(MAX_BEAMS * 3);
  private readonly width = new Float32Array(MAX_BEAMS);
  private readonly color = new Uint32Array(MAX_BEAMS);
  private readonly glow = createBeamMesh(0.24);
  private readonly core = createBeamMesh(0.96);
  private readonly colorScratch = new THREE.Color();

  constructor(scene: THREE.Scene) {
    this.glow.renderOrder = 5;
    this.core.renderOrder = 6;
    scene.add(this.glow, this.core);
  }

  spawn(
    startX: number, startY: number, startZ: number,
    endX: number, endY: number, endZ: number,
    color: number, width: number, now: number, duration = 145,
  ): void {
    const index = this.cursor++ % MAX_BEAMS;
    const vectorIndex = index * 3;
    this.born[index] = now;
    this.duration[index] = duration;
    this.start[vectorIndex] = startX;
    this.start[vectorIndex + 1] = startY;
    this.start[vectorIndex + 2] = startZ;
    this.end[vectorIndex] = endX;
    this.end[vectorIndex + 1] = endY;
    this.end[vectorIndex + 2] = endZ;
    this.color[index] = color;
    this.width[index] = width;
    this.usedCount = Math.min(MAX_BEAMS, this.usedCount + 1);
  }

  update(now: number): void {
    this.activeCount = this.write(this.glow, now, 4.5, 0.52);
    this.write(this.core, now, 1, 1.45);
  }

  private write(mesh: THREE.Mesh, now: number, widthScale: number, brightness: number): number {
    const positions = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const colors = mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    let vertex = 0;
    let visible = 0;
    for (let index = 0; index < this.usedCount; index += 1) {
      const age = now - this.born[index]!;
      const duration = this.duration[index]!;
      if (age < 0 || age >= duration) continue;
      const progress = age / duration;
      const vectorIndex = index * 3;
      const startX = this.start[vectorIndex]!;
      const startY = this.start[vectorIndex + 1]!;
      const startZ = this.start[vectorIndex + 2]!;
      const endX = this.end[vectorIndex]!;
      const endY = this.end[vectorIndex + 1]!;
      const endZ = this.end[vectorIndex + 2]!;
      const dx = endX - startX;
      const dz = endZ - startZ;
      const length = Math.hypot(dx, dz) || 1;
      const flicker = 0.82 + Math.sin(age * 0.19 + index * 2.7) * 0.18;
      const halfWidth = this.width[index]! * widthScale * (1 - progress * 0.62) * flicker;
      const sideX = -dz / length * halfWidth;
      const sideZ = dx / length * halfWidth;
      const color = this.colorScratch.setHex(this.color[index]!);
      const fade = (1 - progress) * brightness;
      const writeVertex = (x: number, y: number, z: number): void => {
        positions.setXYZ(vertex, x, y, z);
        colors.setXYZ(vertex, color.r * fade, color.g * fade, color.b * fade);
        vertex += 1;
      };
      writeVertex(startX - sideX, startY, startZ - sideZ);
      writeVertex(startX + sideX, startY, startZ + sideZ);
      writeVertex(endX + sideX, endY, endZ + sideZ);
      writeVertex(startX - sideX, startY, startZ - sideZ);
      writeVertex(endX + sideX, endY, endZ + sideZ);
      writeVertex(endX - sideX, endY, endZ - sideZ);
      visible += 1;
    }
    if (vertex > 0) {
      positions.clearUpdateRanges();
      positions.addUpdateRange(0, vertex * 3);
      positions.needsUpdate = true;
      colors.clearUpdateRanges();
      colors.addUpdateRange(0, vertex * 3);
      colors.needsUpdate = true;
    }
    mesh.geometry.setDrawRange(0, vertex);
    return visible;
  }
}

export class CombatEffectRenderer {
  readonly muzzle: EffectPool;
  readonly shield: EffectPool;
  readonly flash: EffectPool;
  readonly shock: EffectPool;
  readonly debris: EffectPool;
  readonly wreck: EffectPool;
  readonly beams: BeamPool;
  private quality: RenderQuality = "medium";

  constructor(scene: THREE.Scene) {
    this.muzzle = new EffectPool(scene, new THREE.OctahedronGeometry(1, 0), 512, EffectMode.Flash, 0.95);
    this.shield = new EffectPool(scene, new THREE.RingGeometry(0.86, 1, 16), 512, EffectMode.Ripple, 0.18);
    this.flash = new EffectPool(scene, new THREE.IcosahedronGeometry(1, 1), 256, EffectMode.Flash, 0.78);
    this.shock = new EffectPool(scene, new THREE.RingGeometry(0.82, 1, 28), 256, EffectMode.Ring, 0.36);
    this.debris = new EffectPool(scene, new THREE.TetrahedronGeometry(1, 0), 768, EffectMode.Debris, 0.72);
    this.wreck = new EffectPool(
      scene, new THREE.BoxGeometry(1.8, 0.7, 3.2), 512, EffectMode.Debris, 0.86, THREE.NormalBlending,
    );
    this.beams = new BeamPool(scene);
  }

  setQuality(quality: RenderQuality): void { this.quality = quality; }

  spawnMuzzle(x: number, y: number, z: number, color: number, size: number, now: number): void {
    this.muzzle.spawn(x, y, z, size, color, now, 95);
  }

  spawnMissileLaunch(x: number, y: number, z: number, color: number, now: number): void {
    this.muzzle.spawn(x, y, z, 0.78, 0xffd69b, now, 175, 0, 16, 0);
    this.shock.spawn(x, y + 0.2, z, 1.15, color, now, 260);
  }

  spawnDamageImpact(
    x: number, y: number, z: number, radius: number,
    seed: number, damage: number, shielded: boolean, now: number,
  ): void {
    const angle = seed * 2.399963;
    const hitX = x + Math.sin(angle) * radius * 0.7;
    const hitY = y + radius * 0.12;
    const hitZ = z + Math.cos(angle) * radius * 0.7;
    if (shielded) {
      const rippleSize = Math.min(radius * 0.22, Math.max(0.65, radius * 0.14 + Math.sqrt(damage) * 0.06));
      this.shield.spawn(hitX, hitY, hitZ, rippleSize, 0xa8e9ff, now, 165);
      return;
    }
    const damageScale = Math.min(1, Math.sqrt(damage) / 12);
    const blastSize = Math.min(radius * 0.3, Math.max(0.75, radius * 0.07 + damageScale * 1.5));
    this.muzzle.spawn(hitX, hitY, hitZ, blastSize * 0.72, 0xffffff, now, 105);
    this.flash.spawn(hitX, hitY, hitZ, blastSize, 0xffb04f, now, 235);
    this.shock.spawn(hitX, hitY, hitZ, blastSize * 0.92, 0xff6a2a, now, 310);

    // Hull fragments reuse the fixed debris pool. Counts remain deliberately
    // small because sustained fleet fire can generate hundreds of hits/second.
    const debrisCount = this.quality === "low" ? 1 : this.quality === "medium" ? 2 : 3;
    for (let index = 0; index < debrisCount; index += 1) {
      const debrisAngle = angle + index * 2.0944;
      const speed = 5 + damageScale * 9 + index * 2;
      this.debris.spawn(
        hitX, hitY, hitZ, Math.max(0.22, blastSize * 0.18), index === 0 ? 0xffd18a : 0x9d4c28,
        now, 420 + index * 75,
        Math.sin(debrisAngle) * speed, 2 + damageScale * 5 + index, Math.cos(debrisAngle) * speed,
      );
    }
  }

  spawnBeam(
    startX: number, startY: number, startZ: number,
    endX: number, endY: number, endZ: number,
    color: number, width: number, now: number,
  ): void {
    this.beams.spawn(startX, startY, startZ, endX, endY, endZ, color, width, now);
    this.muzzle.spawn(startX, startY, startZ, width * 2.4, color, now, 125);
  }

  spawnExplosion(x: number, y: number, z: number, color: number, radius: number, now: number): void {
    this.flash.spawn(x, y, z, radius * 0.75, 0xffe5ad, now, 340);
    this.shock.spawn(x, y, z, radius * 0.8, color, now, 720);
    const debrisCount = this.quality === "low" ? 2 : this.quality === "medium" ? 4 : 7;
    for (let index = 0; index < debrisCount; index += 1) {
      const angle = index / debrisCount * Math.PI * 2 + radius;
      const speed = 8 + (index % 3) * 5;
      this.debris.spawn(
        x, y, z, Math.max(0.9, radius * 0.1), color, now, 900 + index * 70,
        Math.sin(angle) * speed, 2 + index % 2 * 4, Math.cos(angle) * speed,
      );
    }
  }

  spawnProjectileDetonation(x: number, y: number, z: number, color: number, size: number, now: number): void {
    this.muzzle.spawn(x, y, z, Math.max(0.35, size * 0.7), size >= 5 ? 0xfff1c7 : color, now, 130);
    if (size < 1) return;
    this.flash.spawn(x, y, z, size, size >= 5 ? 0xffa24a : color, now, size >= 5 ? 320 : 210);
    this.shock.spawn(x, y, z, size * 0.82, color, now, size >= 5 ? 520 : 340);
    if (size < 5) return;
    const debrisCount = this.quality === "low" ? 2 : this.quality === "medium" ? 4 : 6;
    for (let index = 0; index < debrisCount; index += 1) {
      const angle = index / debrisCount * Math.PI * 2 + x * 0.17 + z * 0.11;
      const speed = 8 + index % 3 * 4;
      this.debris.spawn(
        x, y, z, Math.max(0.55, size * 0.09), index % 2 === 0 ? 0xffd28a : color,
        now, 520 + index * 55,
        Math.sin(angle) * speed, 4 + index % 2 * 4, Math.cos(angle) * speed,
      );
    }
  }

  spawnShipDeath(
    x: number, y: number, z: number, color: number, radius: number,
    velocityX: number, velocityZ: number, seed: number, now: number,
  ): void {
    this.spawnExplosion(x, y, z, color, radius, now);
    const secondaryCount = this.quality === "low" ? 1 : this.quality === "medium" ? 2 : 3;
    for (let index = 0; index < secondaryCount; index += 1) {
      const angle = (seed * 2.399963 + index * 2.17) % (Math.PI * 2);
      const offset = radius * (0.18 + index * 0.12);
      const delay = 150 + index * 135;
      this.flash.spawn(
        x + Math.sin(angle) * offset, y + (index % 2) * radius * 0.12, z + Math.cos(angle) * offset,
        radius * (0.35 - index * 0.04), index % 2 === 0 ? 0xffc36b : 0x8feaff, now + delay, 280,
      );
      this.shock.spawn(x, y, z, radius * (0.45 + index * 0.12), color, now + delay, 520);
    }
    const chunkCount = this.quality === "low" ? 3 : this.quality === "medium" ? 5 : 8;
    const wreckColor = new THREE.Color(color).multiplyScalar(0.3).getHex();
    for (let index = 0; index < chunkCount; index += 1) {
      const angle = seed * 0.71 + index / chunkCount * Math.PI * 2;
      const speed = 4 + (index * 7 % 13);
      this.wreck.spawn(
        x + Math.sin(angle) * radius * 0.12,
        y + (index % 3 - 1) * radius * 0.08,
        z + Math.cos(angle) * radius * 0.12,
        Math.max(0.8, radius * (0.1 + index % 3 * 0.025)), wreckColor, now, 1_900 + index * 110,
        velocityX * 0.28 + Math.sin(angle) * speed,
        (index % 2 === 0 ? 1 : -1) * (2 + index % 4),
        velocityZ * 0.28 + Math.cos(angle) * speed,
      );
    }
  }

  update(now: number): void {
    this.muzzle.update(now);
    this.shield.update(now);
    this.flash.update(now);
    this.shock.update(now);
    this.debris.update(now);
    this.wreck.update(now);
    this.beams.update(now);
  }

  get activeCount(): number {
    return this.muzzle.activeCount + this.shield.activeCount + this.flash.activeCount
      + this.shock.activeCount + this.debris.activeCount + this.wreck.activeCount + this.beams.activeCount;
  }

  get poolUsage(): string {
    const active = this.activeCount;
    const capacity = this.muzzle.capacity + this.shield.capacity + this.flash.capacity
      + this.shock.capacity + this.debris.capacity + this.wreck.capacity + this.beams.capacity;
    return `${active} / ${capacity}`;
  }
}
