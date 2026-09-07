import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  FIGHTER_SQUAD_OFFSETS,
  FACTION_IDS,
  SHIPS,
  SHIP_TURRET_SCALES,
  type ShipClass,
  type FactionId,
} from "@space-rts/game-core";
import { getBatchedTurretGeometry, getShipHullGeometries, type HullGeometrySet } from "./combat-visuals";
import { fighterMemberCount, fighterMemberMatrix, fighterMuzzlePosition } from "./fighter-visuals";
import { FighterWakes } from "./fighter-wakes";
import { createWeaponTrailMaterial, getWeaponStyle, weaponFactionIndex } from "./weapon-appearance";
import { SHIP_THRUSTERS } from "./ship-layout";
import { createShipSurfaceMaterial, FACTION_SURFACES } from "./ship-materials";
import { createShipLivery } from "./ship-livery";
import { getShipSilhouetteGeometry, getShipMediumGeometry } from "./ship-hulls";
import { createBreachGeometry, createBreachMaterial, getShipDamageSites } from "./ship-damage";
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

export function createThrusterTrailGeometry(): THREE.BufferGeometry {
  // Two crossed ribbons: four triangles per nozzle, with soft shader edges.
  const horizontal = new THREE.PlaneGeometry(2, 1).rotateX(Math.PI / 2);
  const vertical = horizontal.clone().rotateZ(Math.PI / 2);
  const geometry = mergeGeometries([horizontal, vertical], false)!;
  horizontal.dispose(); vertical.dispose();
  return geometry;
}

export function createThrusterMaterial(time: { value: number }): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({
    color: 0xb6e7ff, transparent: true, opacity: 0.64,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.thrusterTime = time;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
        varying vec2 vPlumeUv;
        varying float vPlumePhase;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        vPlumeUv = vec2(uv.x * 2.0 - 1.0, position.z + 0.5);
        vPlumePhase = dot(instanceMatrix[3].xz, vec2(0.071, 0.113));`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        uniform float thrusterTime;
        varying vec2 vPlumeUv;
        varying float vPlumePhase;`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        float axial = clamp(vPlumeUv.y, 0.0, 1.0);
        float width = mix(0.16, 0.76, pow(axial, 0.65));
        float radial = abs(vPlumeUv.x) / width;
        float feather = exp(-radial * radial * 4.5) * (1.0 - smoothstep(0.72, 1.0, radial));
        float core = exp(-radial * radial * 28.0) * pow(axial, 2.0);
        float tip = smoothstep(0.0, 0.55, axial);
        float shock = 0.9 + 0.1 * sin(axial * 27.0 - thrusterTime * 8.0 + vPlumePhase);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85, 0.96, 1.0), core * 0.85);
        diffuseColor.a *= feather * tip * shock;
      `);
  };
  material.customProgramCacheKey = () => "soft-nozzle-plume-v2";
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
const TACTICAL_SCALE = [12.5, 11, 12.5, 11.5, 13.5, 13.5, 14, 15, 15.5, 16.5, 17.5, 18.5, 20] as const;
const TACTICAL_SELECTION_RADIUS = [18, 16, 18, 17, 19, 19, 20, 22, 23, 24, 26, 27, 29] as const;
const CLOSE_SELECTION_RADIUS = [22, 13, 17, 7.5, 18, 19, 19, 29, 31, 42, 45, 56, 64] as const;
const HEALTH_BAR_GREEN = new THREE.Color(0x63df8c);
const HEALTH_BAR_AMBER = new THREE.Color(0xf1bd5a);
const HEALTH_BAR_RED = new THREE.Color(0xff5674);
const DAMAGE_SCORCH = new THREE.Color(0x24130d);
const ARTILLERY_REVEAL = new THREE.Color(0xffb35c);
const MAX_DAMAGE_INSTANCES = 256;
const DAMAGE_VISIBLE_CLASS_IDS = new Set([1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

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
    () => Array.from({ length: SHIP_CLASSES.length * FACTION_IDS.length }, () => ({})),
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
  private readonly fighterWakes = new FighterWakes();
  private readonly shipMatrices = new Float32Array(MAX_RENDER_SHIPS * 16);
  private readonly fighterMatrices = new Float32Array(MAX_RENDER_SHIPS * FIGHTER_SQUAD_OFFSETS.length * 16);
  private readonly matrix = new THREE.Matrix4();
  private readonly localMatrix = new THREE.Matrix4();
  private readonly memberMatrix = new THREE.Matrix4();
  private readonly scaleMatrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly yawQuaternion = new THREE.Quaternion();
  private readonly bankQuaternion = new THREE.Quaternion();
  private readonly pitchQuaternion = new THREE.Quaternion();
  private readonly pitchAxis = new THREE.Vector3(1, 0, 0);
  private readonly visibleShipIndices = new Map<number, number>();
  private renderState: InterpolatedRenderState | undefined;
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly color = new THREE.Color();
  private readonly tint = new THREE.Color();
  private readonly lightTint = new THREE.Color();
  private readonly exhaustColor = new THREE.Color();
  private readonly white = new THREE.Color(0xffffff);
  private readonly forwardAxis = new THREE.Vector3(0, 0, 1);
  private readonly identityQuaternion = new THREE.Quaternion();
  private readonly billboardQuaternion = new THREE.Quaternion();
  private readonly screenRight = new THREE.Vector3();
  private readonly screenUp = new THREE.Vector3();
  private quality: RenderQuality = "medium";

  // Allocate only combinations present in a match. Empty factions/classes
  // carry no instance buffers or draw calls, including their turret batches.
  private ensureModel(classId: number, factionId: number): number {
    const modelId = factionId * SHIP_CLASSES.length + classId;
    if (this.hullBatches[VisualLod.Close]![modelId]!.hull) return modelId;
    const faction = FACTION_IDS[factionId] ?? "industrial";
    const shipClass = SHIP_CLASSES[classId]!;
    const geometry = getShipHullGeometries(shipClass, faction);
    const livery = faction === "industrial" ? createShipLivery([geometry.hull, geometry.armor]) : undefined;
    const hullMaterial = createShipSurfaceMaterial("hull", faction, livery);
    const armorMaterial = createShipSurfaceMaterial("armor", faction, livery);
    const darkMaterial = new THREE.MeshStandardMaterial({
      color: FACTION_SURFACES[faction].dark, emissive: 0x07141d, emissiveIntensity: 0.72,
      metalness: 0.62, roughness: 0.46, flatShading: true,
    });
    const accentMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const lightMaterial = new THREE.MeshBasicMaterial({ color: FACTION_SURFACES[faction].glow, toneMapped: false });
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

    {
      getShipDamageSites(shipClass, faction);
      // Simplify geometry, never remove operational squad members. Capacity
      // covers five craft even when every visible entity is a fighter squad.
      const detailedCapacity = shipClass === "fighter" ? MAX_RENDER_SHIPS * FIGHTER_SQUAD_OFFSETS.length : MAX_RENDER_SHIPS;
      for (const lod of [VisualLod.Close, VisualLod.Medium] as const) {
        const layers = lod === VisualLod.Close ? CLOSE_LAYERS : MEDIUM_LAYERS;
        for (const layer of layers) {
          if (geometry[layer].getAttribute("position").count === 0) continue;
          const colored = layer === "hull" || layer === "armor" || layer === "accent" || layer === "light" || layer === "engine";
          const batch = createBatch(lod === VisualLod.Medium && (layer === "hull" || layer === "armor")
            ? getShipMediumGeometry(shipClass, layer, faction) : geometry[layer], layerMaterials[layer], detailedCapacity, colored);
          this.hullBatches[lod]![modelId]![layer] = batch;
          this.allBatches.push(batch);
          this.group.add(batch.mesh);
        }
      }
      const farBatch = createBatch(getShipSilhouetteGeometry(shipClass, faction), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, side: THREE.DoubleSide }), detailedCapacity, true);
      this.hullBatches[VisualLod.Far]![modelId]!.hull = farBatch;
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
      this.hullBatches[VisualLod.Tactical]![modelId]!.hull = tacticalBatch;
      this.allBatches.push(tacticalBatch);
      this.group.add(tacticalBatch.mesh);
    }

    if (!this.turretBatches[factionId * WEAPON_TYPES.length]) {
      const turretMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0x061017, emissiveIntensity: 0.5, metalness: 0.72, roughness: 0.34,
      flatShading: true, vertexColors: true,
    });
    for (let weaponId = 0; weaponId < WEAPON_TYPES.length; weaponId++) {
      const batch = createBatch(getBatchedTurretGeometry(WEAPON_TYPES[weaponId]!, faction), turretMaterial, MAX_RENDER_TURRETS, true);
      this.turretBatches[factionId * WEAPON_TYPES.length + weaponId] = batch;
      this.allBatches.push(batch);
      this.group.add(batch.mesh);
    }
    }
    return modelId;
  }

  constructor(scene: THREE.Scene) {
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
      MAX_RENDER_SHIPS * FIGHTER_SQUAD_OFFSETS.length * 2,
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
    this.damageBatch = createBatch(
      createBreachGeometry(), createBreachMaterial(this.thrusterTime), MAX_DAMAGE_INSTANCES, true,
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
      this.healthBarBackgroundBatch.mesh, this.healthBarFillBatch.mesh, this.damageBatch.mesh, this.fighterWakes.mesh,
    );
    scene.add(this.group);
  }

  setQuality(quality: RenderQuality): void {
    this.quality = quality;
    (this.shieldBatch.mesh.material as THREE.MeshBasicMaterial).opacity = quality === "low" ? 0.045 : quality === "medium" ? 0.075 : 0.095;
  }

  clearHistory(): void {
    this.fighterWakes.clear();
    this.visibleShipIndices.clear();
    this.renderState = undefined;
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
    this.fighterWakes.beginFrame(visualTick, this.quality);
    for (let index = 0; index < state.shipCount; index++) this.ensureModel(state.shipClass[index]!, state.shipFaction[index]!);
    for (let modelId = 0; modelId < SHIP_CLASSES.length * FACTION_IDS.length; modelId += 1) {
      const hull = this.hullBatches[VisualLod.Medium]![modelId]!.hull;
      if (!hull) continue;
      const shipClass = SHIP_CLASSES[modelId % SHIP_CLASSES.length]!;
      const faction = FACTION_IDS[Math.floor(modelId / SHIP_CLASSES.length)]!;
      hull.mesh.geometry = state.shipCount > 768
        ? getShipSilhouetteGeometry(shipClass, faction)
        : getShipMediumGeometry(shipClass, "hull", faction);
    }
    for (const batch of this.allBatches) batch.count = 0;
    this.metrics.shipInstances = state.shipCount;
    this.metrics.turretInstances = state.turretCount;
    this.metrics.thrusterInstances = 0;
    this.metrics.selectedShields = 0;
    const enginePulse = 0.94 + Math.sin(now * 0.018) * 0.09;
    this.renderState = state;
    this.visibleShipIndices.clear();
    this.billboardQuaternion.copy(camera.quaternion);
    this.screenRight.set(1, 0, 0).applyQuaternion(this.billboardQuaternion);
    this.screenUp.set(0, 1, 0).applyQuaternion(this.billboardQuaternion);
    const focalPixels = Math.max(1, viewportHeight) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));

    for (let index = 0; index < state.shipCount; index += 1) {
      this.visibleShipIndices.set(state.shipIds[index]!, index);
      const positionIndex = index * 3;
      this.position.set(
        state.shipPosition[positionIndex]!,
        state.shipPosition[positionIndex + 1]!,
        state.shipPosition[positionIndex + 2]!,
      );
      this.yawQuaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, state.shipYaw[index]!);
      this.bankQuaternion.setFromAxisAngle(this.forwardAxis, state.shipBank[index]!);
      this.pitchQuaternion.setFromAxisAngle(this.pitchAxis, state.shipPitch[index]!);
      this.quaternion.multiplyQuaternions(this.yawQuaternion, this.pitchQuaternion).multiply(this.bankQuaternion);
      this.scale.set(1, 1, 1);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.matrix.toArray(this.shipMatrices, index * 16);
      this.color.setHex(state.shipColor[index]!);
      const health = state.shipHealth[index]!;
      const classId = state.shipClass[index]!;
      const modelId = state.shipFaction[index]! * SHIP_CLASSES.length + classId;
      const faction = FACTION_IDS[state.shipFaction[index]!] ?? "industrial";
      const requestedLod = state.shipLod[index]! as VisualLod;
      const lod = classId === 0 && state.shipCount > 768 && requestedLod === VisualLod.Close
        ? VisualLod.Medium : requestedLod;
      // Industrial surfaces use the owner color only inside their paint mask.
      this.tint.copy(this.color).lerp(this.white, faction === "industrial" ? 0 : 0.9).multiplyScalar(0.87 + health * 0.13);
      this.lightTint.copy(this.color).lerp(this.white, 0.72);
      if (state.shipRevealed[index]) {
        const reveal = 0.22 + Math.sin(now * 0.014) * 0.08;
        this.tint.lerp(ARTILLERY_REVEAL, reveal);
      }
      if (health < 0.7) {
        const scorch = Math.min(0.16, (0.7 - health) * 0.25);
        this.tint.lerp(DAMAGE_SCORCH, scorch);
      }
      if (health < 0.3) this.color.multiplyScalar(0.62 + Math.abs(Math.sin(now * 0.012 + state.shipIds[index]!)) * 0.38);

      if (lod === VisualLod.Close || lod === VisualLod.Medium) {
        const layers = lod === VisualLod.Close
          ? CLOSE_LAYERS
          : state.shipCount > 768
            ? LARGE_BATTLE_MEDIUM_LAYERS
            : MEDIUM_LAYERS;
        const memberCount = classId === 0 ? fighterMemberCount(health) : 1;
        const centerX = this.position.x;
        const centerY = this.position.y;
        const centerZ = this.position.z;
        for (let member = 0; member < memberCount; member += 1) {
          if (classId === 0) {
            fighterMemberMatrix(this.memberMatrix, state.shipIds[index]!, member, visualTick,
              centerX, centerY, centerZ, state.shipYaw[index]!, state.shipBank[index]!,
              state.shipSpeed[index]!, state.shipEngagement[index]!, state.shipPitch[index]!, faction,
              state.shipTurnVelocity[index]!, state.shipFormationYaw[index]!);
            this.memberMatrix.toArray(this.fighterMatrices, (index * FIGHTER_SQUAD_OFFSETS.length + member) * 16);
            if (state.shipSpeed[index]! > 10) {
              this.fighterWakes.write(state.shipIds[index]!, member, this.memberMatrix, this.color,
                state.shipNewlyVisible[index] === 1);
            }
          } else {
            this.memberMatrix.copy(this.matrix);
          }
          for (const layer of layers) {
            const batch = this.hullBatches[lod]![modelId]![layer];
            if (!batch) continue;
            if (layer === "engine") {
              this.scaleMatrix.makeScale(1, 1, enginePulse * state.shipEngine[index]! * QUALITY_ENGINE_SCALE[this.quality]);
              this.localMatrix.copy(this.memberMatrix).multiply(this.scaleMatrix);
              this.writeInstance(batch, this.localMatrix, this.color);
            } else {
              const layerColor = layer === "hull" || layer === "armor"
                ? this.tint
                : layer === "light" ? this.lightTint : this.color;
              this.writeInstance(batch, this.memberMatrix, layerColor);
            }
          }
          this.writeThrusters(state, index, now, this.memberMatrix);
        }
        this.position.set(centerX, centerY, centerZ);
      } else {
        const batch = this.hullBatches[lod]![modelId]!.hull!;
        if (lod === VisualLod.Tactical) {
          const tacticalScale = (TACTICAL_SCALE[classId] ?? 28) * tacticalScaleMultiplier;
          this.scale.setScalar(tacticalScale);
          this.position.y = 1.5;
          this.localMatrix.compose(this.position, this.billboardQuaternion, this.scale);
          this.writeInstance(batch, this.localMatrix, this.color);
        } else if (classId === 0) {
          for (let member = 0; member < fighterMemberCount(health); member += 1) {
            fighterMemberMatrix(this.memberMatrix, state.shipIds[index]!, member, visualTick,
              this.position.x, this.position.y, this.position.z, state.shipYaw[index]!, state.shipBank[index]!,
              state.shipSpeed[index]!, state.shipEngagement[index]!, state.shipPitch[index]!, faction,
              state.shipTurnVelocity[index]!, state.shipFormationYaw[index]!);
            this.memberMatrix.toArray(this.fighterMatrices, (index * FIGHTER_SQUAD_OFFSETS.length + member) * 16);
            this.writeInstance(batch, this.memberMatrix, this.color);
          }
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

    this.fighterWakes.endFrame();
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
      this.color.setHex(state.turretColor[index]!).lerp(this.white, 0.76);
      this.writeInstance(this.turretBatches[state.shipFaction[ownerIndex]! * WEAPON_TYPES.length + state.turretType[index]!]!, this.matrix, this.color);
    }

    this.metrics.activeBatches = this.fighterWakes.mesh.visible ? 1 : 0;
    this.metrics.transparentBatches = this.fighterWakes.mesh.visible ? 1 : 0;
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
    if (state.shipCount > 768 && state.shipLod[shipIndex] !== VisualLod.Close) return;
    if (this.quality === "low" && health >= 0.35) return;
    if (state.shipCount > 1_024 && classId < 6) return;
    const shipClass = SHIP_CLASSES[classId]!;
    const radius = SHIPS[shipClass].radius;
    const shipId = state.shipIds[shipIndex]!;
    const sites = getShipDamageSites(shipClass, FACTION_IDS[state.shipFaction[shipIndex]!]!);
    const severity = Math.min(1, (0.7 - health) / 0.7);
    const breachCount = this.quality === "low" ? 1 : health < 0.3 ? 3 : health < 0.5 ? 2 : 1;
    this.matrix.fromArray(this.shipMatrices, shipIndex * 16);
    for (let breach = 0; breach < Math.min(breachCount, sites.length) && this.damageBatch.count < MAX_DAMAGE_INSTANCES; breach += 1) {
      const site = sites[(shipId + breach * 5) % sites.length]!;
      const size = Math.max(0.55, radius * (0.026 + severity * 0.025));
      this.scale.set(size, size, size * 1.25);
      this.localMatrix.compose(site.position, site.orientation, this.scale).premultiply(this.matrix);
      this.color.setRGB(severity, ((shipId * 7 + breach * 13) % 31) / 31, 0);
      this.writeInstance(this.damageBatch, this.localMatrix, this.color);
    }
  }

  getVisualPosition(shipId: number, target: THREE.Vector3): boolean {
    const index = this.visibleShipIndices.get(shipId);
    if (index === undefined || !this.renderState) return false;
    target.fromArray(this.renderState.shipPosition, index * 3);
    return true;
  }

  getFighterMuzzle(shipId: number, member: number, sequence: number, target: THREE.Vector3): boolean {
    const state = this.renderState;
    const index = this.visibleShipIndices.get(shipId);
    if (!state || index === undefined || state.shipClass[index] !== 0
      || state.shipLod[index]! >= VisualLod.Tactical
      || member < 0 || member >= fighterMemberCount(state.shipHealth[index]!)) return false;
    this.memberMatrix.fromArray(this.fighterMatrices, (index * FIGHTER_SQUAD_OFFSETS.length + member) * 16);
    fighterMuzzlePosition(target, this.memberMatrix, sequence);
    return true;
  }

  private writeThrusters(
    state: InterpolatedRenderState,
    shipIndex: number,
    now: number,
    shipMatrix: THREE.Matrix4,
  ): void {
    const classId = state.shipClass[shipIndex]!;
    const layout = SHIP_THRUSTERS[SHIP_CLASSES[classId]!];
    const offsets = layout.offsets;
    const nozzleCount = offsets.length;
    const engine = state.shipEngine[shipIndex]!;
    const pulse = 0.88 + Math.sin(now * 0.026 + state.shipIds[shipIndex]! * 0.73) * 0.12;
    const cruiseScale = state.shipCruising[shipIndex] ? 1.18 : 1;
    const length = layout.length * (0.15 + engine * 0.28) * pulse
      * QUALITY_ENGINE_SCALE[this.quality] * cruiseScale;
    const width = layout.width * (1.05 + engine * 0.22);
    const rear = layout.rear;
    this.exhaustColor.setHex(state.shipCruising[shipIndex] ? 0xc5edff : FACTION_SURFACES[FACTION_IDS[state.shipFaction[shipIndex]!]!].glow);
    for (let nozzle = 0; nozzle < nozzleCount && this.thrusterBatch.count < this.thrusterBatch.capacity; nozzle += 1) {
      const offset = offsets[nozzle] ?? 0;
      this.position.set(offset, layout.y, rear - length * 0.5);
      this.scale.set(width, width * 0.72, length);
      this.localMatrix.compose(this.position, this.identityQuaternion, this.scale).premultiply(shipMatrix);
      this.writeInstance(this.thrusterBatch, this.localMatrix, this.exhaustColor);
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
  private readonly rotation = new THREE.Euler();
  private readonly direction = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly opacity: THREE.InstancedBufferAttribute;

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
    this.opacity = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.opacity.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("effectOpacity", this.opacity);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity, blending,
      depthWrite: false, side: THREE.DoubleSide,
      toneMapped: blending === THREE.NormalBlending,
    });
    material.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>
          attribute float effectOpacity;
          varying float vEffectOpacity;
          varying vec2 vEffectPoint;`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>
          vEffectOpacity = effectOpacity;
          vEffectPoint = position.xy;`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
          varying float vEffectOpacity;
          varying vec2 vEffectPoint;`)
        .replace("#include <color_fragment>", `#include <color_fragment>
          diffuseColor.a *= vEffectOpacity;
          ${mode === EffectMode.Flash ? `
          float radius = length(vEffectPoint);
          float glow = max(0.0, 1.0 - radius);
          diffuseColor.a *= glow * glow;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.7, 1.5, 1.1), pow(glow, 8.0) * vEffectOpacity);
          ` : ""}`);
    };
    material.customProgramCacheKey = () => `combat-effect-${mode}`;
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
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

  update(now: number, camera?: THREE.Camera): void {
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
          ? baseScale
          : baseScale * (0.65 + Math.sqrt(progress) * 0.9);
      this.scaleScratch.setScalar(Math.max(0.001, animatedScale));
      if (this.mode === EffectMode.Ripple || this.mode === EffectMode.Ring) this.quaternion.setFromAxisAngle(this.xAxis, Math.PI / 2);
      else if (this.mode === EffectMode.Flash && camera) this.quaternion.copy(camera.quaternion);
      else if (this.mode === EffectMode.Debris && (this.mesh.material as THREE.MeshBasicMaterial).blending === THREE.AdditiveBlending) {
        this.direction.set(this.velocity[positionIndex]!, this.velocity[positionIndex + 1]!, this.velocity[positionIndex + 2]!);
        if (this.direction.lengthSq() > 0) this.quaternion.setFromUnitVectors(this.up, this.direction.normalize());
        this.scaleScratch.set(animatedScale * 0.3, animatedScale * (2.6 - progress * 1.7), animatedScale * 0.3);
      } else this.quaternion.setFromEuler(this.rotation.set(progress * 4 + index, progress * 6, progress * 3));
      this.matrix.compose(this.positionScratch, this.quaternion, this.scaleScratch);
      this.mesh.setMatrixAt(visible, this.matrix);
      this.mesh.setColorAt(visible, this.colorScratch.setHex(this.color[index]!));
      this.opacity.setX(visible, this.mode === EffectMode.Debris
        ? 1 - THREE.MathUtils.smoothstep(progress, 0.55, 1)
        : (1 - progress) ** 2);
      visible += 1;
    }
    this.activeCount = visible;
    this.mesh.count = visible;
    if (visible > 0) {
      this.opacity.clearUpdateRanges();
      this.opacity.addUpdateRange(0, visible);
      this.opacity.needsUpdate = true;
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
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(MAX_BEAMS * BEAM_VERTICES * 2), 2).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute("weaponEffect", new THREE.BufferAttribute(new Float32Array(MAX_BEAMS * BEAM_VERTICES * 2), 2).setUsage(THREE.DynamicDrawUsage));
  geometry.setDrawRange(0, 0);
  const mesh = new THREE.Mesh(geometry, createWeaponTrailMaterial(opacity));
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
  private readonly faction = new Uint8Array(MAX_BEAMS);
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
    color: number, width: number, now: number, duration = 145, faction: FactionId = "industrial",
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
    this.faction[index] = weaponFactionIndex(faction);
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
    const uv = mesh.geometry.getAttribute("uv") as THREE.BufferAttribute;
    const effect = mesh.geometry.getAttribute("weaponEffect") as THREE.BufferAttribute;
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
      for (let i = 0; i < 6; i++) effect.setXY(vertex + i, this.faction[index]!, age * 0.018 + index);
      uv.setXY(vertex, 0, -1); uv.setXY(vertex + 1, 0, 1); uv.setXY(vertex + 2, 1, 1);
      uv.setXY(vertex + 3, 0, -1); uv.setXY(vertex + 4, 1, 1); uv.setXY(vertex + 5, 1, -1);
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
      for (const attribute of [uv, effect]) {
        attribute.clearUpdateRanges(); attribute.addUpdateRange(0, vertex * 2); attribute.needsUpdate = true;
      }
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
  private spores?: EffectPool;
  private facets?: EffectPool;
  private quality: RenderQuality = "medium";

  constructor(private readonly scene: THREE.Scene) {
    this.muzzle = new EffectPool(scene, new THREE.PlaneGeometry(2, 2), 512, EffectMode.Flash, 0.95);
    this.shield = new EffectPool(scene, new THREE.RingGeometry(0.86, 1, 16), 512, EffectMode.Ripple, 0.18);
    this.flash = new EffectPool(scene, new THREE.PlaneGeometry(2, 2), 256, EffectMode.Flash, 0.92);
    this.shock = new EffectPool(scene, new THREE.RingGeometry(0.82, 1, 28), 256, EffectMode.Ring, 0.36);
    this.debris = new EffectPool(scene, new THREE.TetrahedronGeometry(1, 0), 768, EffectMode.Debris, 0.72);
    this.wreck = new EffectPool(
      scene, new THREE.OctahedronGeometry(1, 0).scale(1.1, 0.3, 1.9), 512, EffectMode.Debris, 0.96, THREE.NormalBlending,
    );
    this.beams = new BeamPool(scene);
  }

  setQuality(quality: RenderQuality): void { this.quality = quality; }

  spawnMuzzle(x: number, y: number, z: number, color: number, size: number, now: number): void {
    this.muzzle.spawn(x, y, z, size, color, now, 95);
  }

  spawnMissileLaunch(x: number, y: number, z: number, color: number, now: number, faction: FactionId = "industrial"): void {
    if (faction !== "industrial") {
      this.spawnFactionBurst(x, y, z, color, 1.15, now, faction);
      return;
    }
    this.muzzle.spawn(x, y, z, 0.78, 0xffd69b, now, 175, 0, 16, 0);
    this.shock.spawn(x, y + 0.2, z, 1.15, color, now, 260);
  }

  spawnDamageImpact(
    x: number, y: number, z: number, radius: number,
    seed: number, damage: number, shielded: boolean, now: number,
    shipClass?: ShipClass, yaw = 0, faction: FactionId = "industrial",
    attackerFaction: FactionId = "industrial",
  ): void {
    const angle = seed * 2.399963;
    const sites = shipClass ? getShipDamageSites(shipClass, faction) : undefined;
    const site = sites?.length ? sites[Math.abs(seed) % sites.length] : undefined;
    const localX = site?.position.x ?? Math.sin(angle) * radius * 0.32;
    const localZ = site?.position.z ?? Math.cos(angle) * radius * 0.5;
    const hitX = x + Math.cos(yaw) * localX + Math.sin(yaw) * localZ;
    const hitY = y + (site?.position.y ?? radius * 0.22);
    const hitZ = z - Math.sin(yaw) * localX + Math.cos(yaw) * localZ;
    if (shielded) {
      const rippleSize = Math.min(radius * 0.22, Math.max(0.65, radius * 0.14 + Math.sqrt(damage) * 0.06));
      this.shield.spawn(hitX, hitY, hitZ, rippleSize, 0xa8e9ff, now, 165);
      return;
    }
    const damageScale = Math.min(1, Math.sqrt(damage) / 12);
    const blastSize = Math.min(radius * 0.3, Math.max(0.75, radius * 0.07 + damageScale * 1.5));
    if (attackerFaction !== "industrial") {
      this.spawnFactionBurst(hitX, hitY, hitZ, getWeaponStyle("plasma", attackerFaction).color, blastSize, now, attackerFaction);
      return;
    }
    this.muzzle.spawn(hitX, hitY, hitZ, blastSize * 0.72, 0xffffff, now, 105);
    this.flash.spawn(hitX, hitY, hitZ, blastSize, 0xffb04f, now, 235);
    // Ordinary impacts throw hot metal; only large blasts get a shock ring.
    if (damage > 60) this.shock.spawn(hitX, hitY, hitZ, blastSize * 0.8, 0xff8844, now, 230);

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
    color: number, width: number, now: number, faction: FactionId = "industrial",
  ): void {
    this.beams.spawn(startX, startY, startZ, endX, endY, endZ, color, width * (faction === "brood" ? 1.35 : 1), now, 145, faction);
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

  spawnProjectileDetonation(x: number, y: number, z: number, color: number, size: number, now: number, faction: FactionId = "industrial"): void {
    if (faction !== "industrial") {
      this.spawnFactionBurst(x, y, z, color, size, now, faction);
      return;
    }
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

  private spawnFactionBurst(x: number, y: number, z: number, color: number, size: number, now: number, faction: FactionId): void {
    this.muzzle.spawn(x, y, z, Math.max(0.3, size * 0.58), color, now, 115);
    if (size < 1) return;
    const count = this.quality === "low" ? 1 : this.quality === "medium" ? 2 : 3;
    if (faction === "brood") {
      // A rupturing membrane and a few heavy droplets, without smoke emitters.
      this.spores ??= new EffectPool(this.scene, new THREE.IcosahedronGeometry(1), 256, EffectMode.Debris, 0.88, THREE.NormalBlending);
      this.flash.spawn(x, y, z, size * 0.7, color, now, 260);
      for (let i = 0; i < count; i++) {
        const a = i * 2.39996 + x * 0.13 + z * 0.17;
        const speed = 3 + size * 0.8;
        this.spores.spawn(x, y, z, Math.max(0.2, size * 0.18), color, now, 380 + i * 70,
          Math.sin(a) * speed, 2 + i, Math.cos(a) * speed);
      }
    } else {
      // A clean diamond interference wave, followed by narrow crystal splinters.
      this.facets ??= new EffectPool(this.scene, new THREE.RingGeometry(0.88, 1, 4), 128, EffectMode.Ring, 0.62);
      this.facets.spawn(x, y, z, size * 0.82, color, now, 280);
      for (let i = 0; i < count; i++) {
        const a = i * Math.PI * 2 / count + x * 0.11;
        this.debris.spawn(x, y, z, Math.max(0.18, size * 0.11), color, now, 210 + i * 40,
          Math.sin(a) * (5 + size), 2, Math.cos(a) * (5 + size));
      }
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

  update(now: number, camera?: THREE.Camera): void {
    this.muzzle.update(now, camera);
    this.shield.update(now, camera);
    this.flash.update(now, camera);
    this.shock.update(now, camera);
    this.debris.update(now, camera);
    this.wreck.update(now, camera);
    this.beams.update(now);
    this.spores?.update(now, camera);
    this.facets?.update(now, camera);
  }

  get activeCount(): number {
    return this.muzzle.activeCount + this.shield.activeCount + this.flash.activeCount
      + this.shock.activeCount + this.debris.activeCount + this.wreck.activeCount + this.beams.activeCount
      + (this.spores?.activeCount ?? 0) + (this.facets?.activeCount ?? 0);
  }

  get poolUsage(): string {
    const active = this.activeCount;
    const capacity = this.muzzle.capacity + this.shield.capacity + this.flash.capacity
      + this.shock.capacity + this.debris.capacity + this.wreck.capacity + this.beams.capacity
      + (this.spores?.capacity ?? 0) + (this.facets?.capacity ?? 0);
    return `${active} / ${capacity}`;
  }
}
