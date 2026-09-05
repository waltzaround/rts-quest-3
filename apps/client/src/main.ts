import * as THREE from "three";
import { inferFighterFiringMember } from "./fighter-visuals";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  createPlanarCirclePhysicsWorld,
  loadPhysicsRuntime,
  runPhysicsProbe,
  type PhysicsRuntime,
  type PlanarCirclePhysicsWorld,
} from "@space-rts/box3d-wasm";
import {
  BUILDABLE_STRUCTURE_TYPES,
  LockstepInputs,
  BROOD_CAPACITY, CREEP_SPEED_MULTIPLIER, FACTIONS, FACTION_IDS, factionAllowsStructure, factionShipName, factionStructureName, factionStructureDescription,
  getFactionShipDefinition, getFactionShipEconomy, getFactionStructureDefinition, isInTerritory,
  type FactionId, type TerritoryFieldState,
  DEFENSIVE_STRUCTURE_TYPES,
  RESOURCE_EXTRACTOR_TYPES,
  SHIPS,
  SHIP_ECONOMY,
  SHIPYARD_TYPES,
  STRUCTURES,
  WEAPONS,
  ReplayPlayer,
  computeFormationAssignments,
  createCombatScenario,
  createMenuBattleScenario,
  createShowcaseScenario,
  getTurretMuzzleWorldPosition,
  getTurretWorldPosition,
  parseReplay,
  restoreSimulation,
  createSharedRenderBuffers,
  SharedRenderReader,
  type DebugSnapshot,
  type CombatTargetState,
  type EconomyCommand,
  type FleetCommand,
  type FormationAssignment,
  type GameCommand,
  type ObstacleState,
  type PlayerId,
  type ProjectileState,
  type CommandResult,
  type ResourceNodeState,
  type ReplayArchive,
  type ShipClass,
  type ShipState,
  type SimulationState,
  type SimulationEvent,
  type SharedRenderBuffers,
  type StructureState,
  type StructureType,
  type WeaponTypeId,
} from "@space-rts/game-core";
import {
  MAX_REPLAY_BYTES,
  LOCKSTEP_PROTOCOL_VERSION,
  parseServerMessage,
  type ClientMessage,
  type LobbyListEntry,
  type LobbySettings,
  type LobbyState,
  type ProjectedViewState,
  type ReplayManifest,
  type ServerMessage,
} from "@space-rts/protocol";
import { FIXED_DT } from "@space-rts/shared";
import { advanceLockstep } from "./lockstep-clock";
import { ScalableBattleAudio } from "./audio-system";
import { ProjectileVfx, getBatchedTurretGeometry, getTorpedoImpactPoint, type ProjectileVisualTarget } from "./combat-visuals";
import { getWeaponStyle, ProjectileAppearanceRegistry } from "./weapon-appearance";
import { STRUCTURE_TURRET_SCALE, getStructureModel } from "./structure-models";
import { FACTION_SURFACES } from "./ship-materials";
import { BatchedShipRenderer, CombatEffectRenderer } from "./batched-renderer";
import { RenderStateBuilder, SHIP_CLASSES, VisualStressScenario, turretVisualHeight, type RenderQuality } from "./render-state";
import { TerritoryRenderer } from "./territory-renderer";
import { LOCAL_PLAYER_ID, MAP_PLAYER_CAPACITY, createSingleplayerLobby, createSingleplayerScenario, lobbyLaunchIssue, updateSingleplayerLobby } from "./lobby-setup";
import "./styles.css";

const element = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element #${id}`);
  return value as T;
};

const canvas = element<HTMLCanvasElement>("battlefield");
const telemetryPanel = element<HTMLElement>("sim-telemetry");
if (import.meta.env.PROD) telemetryPanel.classList.add("hidden");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.4));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;

interface DisjointTimerExtension {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

class GpuFrameTimer {
  elapsedMs: number | null = null;
  private readonly gl: WebGL2RenderingContext | null;
  private readonly extension: DisjointTimerExtension | null;
  private pending: WebGLQuery | null = null;
  private active = false;

  constructor(webglRenderer: THREE.WebGLRenderer) {
    const context = webglRenderer.getContext();
    this.gl = context instanceof WebGL2RenderingContext ? context : null;
    this.extension = this.gl?.getExtension("EXT_disjoint_timer_query_webgl2") as DisjointTimerExtension | null;
  }

  poll(): void {
    if (!this.gl || !this.extension || !this.pending) return;
    const available = this.gl.getQueryParameter(this.pending, this.gl.QUERY_RESULT_AVAILABLE) as boolean;
    if (!available) return;
    const disjoint = this.gl.getParameter(this.extension.GPU_DISJOINT_EXT) as boolean;
    if (!disjoint) this.elapsedMs = (this.gl.getQueryParameter(this.pending, this.gl.QUERY_RESULT) as number) / 1_000_000;
    this.gl.deleteQuery(this.pending);
    this.pending = null;
  }

  begin(): void {
    if (!this.gl || !this.extension || this.pending) return;
    const query = this.gl.createQuery();
    if (!query) return;
    this.pending = query;
    this.gl.beginQuery(this.extension.TIME_ELAPSED_EXT, query);
    this.active = true;
  }

  end(): void {
    if (!this.gl || !this.extension || !this.active) return;
    this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
    this.active = false;
  }
}

const gpuFrameTimer = new GpuFrameTimer(renderer);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x020509);
scene.fog = new THREE.FogExp2(0x03070d, 0.00022);
const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 1, 80_000);
const STRATEGIC_ZOOM_DISTANCE = 1_100;
const MIN_CAMERA_DISTANCE = 220;
const MAX_CAMERA_DISTANCE = 28_000;

scene.add(new THREE.HemisphereLight(0xdde7e8, 0x52616b, 1.65));
const keyLight = new THREE.DirectionalLight(0xfff4dd, 2.1);
keyLight.position.set(-280, 450, -190);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0xa6cedd, 1.35);
rimLight.position.set(350, 130, 320);
scene.add(rimLight);

const worldRoot = new THREE.Group();
scene.add(worldRoot);
const territoryRenderer = new TerritoryRenderer(worldRoot);
createEnvironment();

const mapBoundaryGroup = new THREE.Group();
const mapBoundaryGlowMaterial = new THREE.MeshBasicMaterial({
  color: 0x3dbddd, transparent: true, opacity: 0.16, depthTest: false, depthWrite: false, fog: false,
});
const mapBoundaryCoreMaterial = new THREE.MeshBasicMaterial({
  color: 0x72e2ff, transparent: true, opacity: 0.72, depthTest: false, depthWrite: false, fog: false,
});
const mapBoundaryGlow: THREE.Mesh[] = [];
const mapBoundaryCore: THREE.Mesh[] = [];
for (let index = 0; index < 4; index += 1) {
  const glow = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mapBoundaryGlowMaterial);
  const core = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mapBoundaryCoreMaterial);
  glow.renderOrder = 31;
  core.renderOrder = 32;
  mapBoundaryGroup.add(glow, core);
  mapBoundaryGlow.push(glow);
  mapBoundaryCore.push(core);
}
mapBoundaryGroup.position.y = 1.5;
scene.add(mapBoundaryGroup);
let renderedMapBoundaryExtent = 0;

function updateMapBoundary(halfExtent: number): void {
  if (Math.abs(renderedMapBoundaryExtent - halfExtent) < 1) return;
  renderedMapBoundaryExtent = halfExtent;
  const length = halfExtent * 2;
  const configure = (pieces: readonly THREE.Mesh[], thickness: number, height: number) => {
    pieces[0]!.position.set(0, height, -halfExtent);
    pieces[0]!.scale.set(length, 0.35, thickness);
    pieces[1]!.position.set(0, height, halfExtent);
    pieces[1]!.scale.set(length, 0.35, thickness);
    pieces[2]!.position.set(-halfExtent, height, 0);
    pieces[2]!.scale.set(thickness, 0.35, length);
    pieces[3]!.position.set(halfExtent, height, 0);
    pieces[3]!.scale.set(thickness, 0.35, length);
  };
  configure(mapBoundaryGlow, 12, 0);
  configure(mapBoundaryCore, 2.5, 0.22);
};

interface StructureVisual {
  group: THREE.Group;
  shield: THREE.Mesh;
  progress: THREE.Mesh;
  marker: THREE.Mesh;
  hitTarget: THREE.Mesh;
  materials: THREE.Material[];
  factory: FactoryAnimationVisual | null;
  type: StructureType;
  /** One aiming turret per hardpoint, indexed like the definition's hardpoints. */
  mounts: StructureMountVisual[];
}

interface StructureMountVisual {
  group: THREE.Group;
  yaw: number;
}

interface FactoryAnimationVisual {
  gantries: readonly [THREE.Mesh, THREE.Mesh];
  scanner: THREE.Mesh;
  scannerMaterial: THREE.MeshBasicMaterial;
  assembly: THREE.Mesh;
  assemblyMaterial: THREE.MeshBasicMaterial;
  bayGlowMaterial: THREE.MeshBasicMaterial;
  workLightMaterial: THREE.MeshBasicMaterial;
}

interface ResourceVisual {
  group: THREE.Group;
  halo: THREE.Mesh;
}

interface ObstacleVisual {
  group: THREE.Group;
  colliderRing: THREE.Mesh;
}

interface RenderTransform {
  x: number;
  y: number;
  z: number;
  yaw: number;
  turretYaw: Map<number, number>;
}

type BuildableStructureType = (typeof BUILDABLE_STRUCTURE_TYPES)[number];
type ConstructionTier = "t1" | "t2" | "t3";

interface ConstructionHotkey {
  code: string;
  label: string;
  structureType: BuildableStructureType;
}

const STRUCTURE_BUTTON_IDS: Readonly<Record<BuildableStructureType, string>> = {
  creepNode: "build-creep-node", pylon: "build-pylon",
  extractor: "build-extractor",
  solarArray: "build-solar",
  storage: "build-storage",
  fabricator: "build-fabricator",
  shipyard: "build-shipyard",
  fleetShipyard: "build-fleet-yard",
  fusionReactor: "build-fusion",
  deepCoreExtractor: "build-deep-extractor",
  alloyRefinery: "build-alloy-refinery",
  capitalShipyard: "build-capital-yard",
  antimatterReactor: "build-antimatter",
  singularityHarvester: "build-singularity",
  matterForge: "build-matter-forge",
  quantumStorage: "build-quantum-storage",
  radarArray: "build-radar-array",
  phasedRadarArray: "build-phased-radar",
  deepSpaceRadarArray: "build-deep-space-radar",
  pointDefenseBattery: "build-pd-battery",
  missileBattery: "build-missile-battery",
  railBattery: "build-rail-battery",
  plasmaBattery: "build-plasma-battery",
  beamBattery: "build-beam-battery",
  artilleryBattery: "build-artillery-battery",
  heavyArtilleryBattery: "build-heavy-artillery-battery",
  strategicArtilleryArray: "build-strategic-artillery-array",
};
const CONSTRUCTION_TIER_HOTKEYS: Readonly<Record<ConstructionTier, Readonly<{ code: string; label: string }>>> = {
  t1: { code: "KeyZ", label: "Z" },
  t2: { code: "KeyX", label: "X" },
  t3: { code: "KeyC", label: "C" },
};
const CONSTRUCTION_HOTKEYS: Readonly<Record<ConstructionTier, readonly Readonly<ConstructionHotkey>[]>> = {
  t1: [
    { code: "KeyQ", label: "Q", structureType: "extractor" },
    { code: "KeyW", label: "W", structureType: "solarArray" },
    { code: "KeyE", label: "E", structureType: "storage" },
    { code: "KeyR", label: "R", structureType: "fabricator" },
    { code: "KeyT", label: "T", structureType: "shipyard" },
    { code: "KeyA", label: "A", structureType: "radarArray" },
    { code: "KeyS", label: "S", structureType: "pointDefenseBattery" },
    { code: "KeyD", label: "D", structureType: "missileBattery" },
    { code: "KeyF", label: "F", structureType: "artilleryBattery" },
  ],
  t2: [
    { code: "KeyQ", label: "Q", structureType: "deepCoreExtractor" },
    { code: "KeyW", label: "W", structureType: "alloyRefinery" },
    { code: "KeyE", label: "E", structureType: "fusionReactor" },
    { code: "KeyR", label: "R", structureType: "fleetShipyard" },
    { code: "KeyA", label: "A", structureType: "phasedRadarArray" },
    { code: "KeyS", label: "S", structureType: "railBattery" },
    { code: "KeyD", label: "D", structureType: "plasmaBattery" },
    { code: "KeyF", label: "F", structureType: "heavyArtilleryBattery" },
  ],
  t3: [
    { code: "KeyQ", label: "Q", structureType: "singularityHarvester" },
    { code: "KeyW", label: "W", structureType: "matterForge" },
    { code: "KeyE", label: "E", structureType: "antimatterReactor" },
    { code: "KeyR", label: "R", structureType: "quantumStorage" },
    { code: "KeyT", label: "T", structureType: "capitalShipyard" },
    { code: "KeyA", label: "A", structureType: "deepSpaceRadarArray" },
    { code: "KeyS", label: "S", structureType: "beamBattery" },
    { code: "KeyD", label: "D", structureType: "strategicArtilleryArray" },
  ],
};
let activeConstructionTier: ConstructionTier = "t1";
const SHIP_BUTTON_IDS: Readonly<Record<ShipClass, string>> = {
  fighter: "queue-fighter",
  fabricator: "queue-fabricator",
  frigate: "queue-frigate",
  bomber: "queue-bomber",
  flakFrigate: "queue-flak-frigate",
  torpedoFrigate: "queue-torpedo-frigate",
  artilleryFrigate: "queue-artillery-frigate",
  destroyer: "queue-destroyer",
  artilleryDestroyer: "queue-artillery-destroyer",
  cruiser: "queue-cruiser",
  artilleryCruiser: "queue-artillery-cruiser",
  carrier: "queue-carrier",
  battleship: "queue-battleship",
};
const SHIP_ABBREVIATIONS: Readonly<Record<ShipClass, string>> = {
  fighter: "F1",
  fabricator: "MF",
  frigate: "F2",
  bomber: "BM",
  flakFrigate: "FF",
  torpedoFrigate: "TF",
  artilleryFrigate: "AF",
  destroyer: "DD",
  artilleryDestroyer: "AD",
  cruiser: "CR",
  artilleryCruiser: "AC",
  carrier: "CV",
  battleship: "BB",
};
const SHIP_LABELS: Readonly<Record<ShipClass, string>> = {
  fighter: "FIGHTER SQUADRON",
  fabricator: "MOBILE FABRICATOR",
  frigate: "FRIGATE",
  bomber: "BOMBER",
  flakFrigate: "FLAK FRIGATE",
  torpedoFrigate: "TORPEDO FRIGATE",
  artilleryFrigate: "ARTILLERY FRIGATE",
  destroyer: "DESTROYER",
  artilleryDestroyer: "ARTILLERY DESTROYER",
  cruiser: "CRUISER",
  artilleryCruiser: "ARTILLERY CRUISER",
  carrier: "CARRIER",
  battleship: "BATTLESHIP",
};
const SHIP_THUMBNAIL_PATHS: Readonly<Record<ShipClass, string>> = {
  fighter: "M32 3 37 17 58 26 51 32 38 28 35 45 29 45 26 28 13 32 6 26 27 17Z",
  fabricator: "M32 4 44 8 52 16 51 25 43 31 39 43 25 43 21 31 13 25 12 16 20 8ZM8 17 14 21 18 38 12 42ZM56 17 50 21 46 38 52 42Z",
  frigate: "M32 4 45 8 52 17 45 25 36 28 36 44 32 48 28 44 28 28 19 25 12 17 19 8ZM12 27H18V45H12ZM46 27H52V45H46Z",
  bomber: "M32 3 39 14 58 22 53 34 41 30 37 45 27 45 23 30 11 34 6 22 25 14Z",
  flakFrigate: "M32 4 45 8 53 17 46 25 38 27 42 33 37 35 36 44 32 48 28 44 27 35 22 33 26 27 18 25 11 17 19 8Z",
  torpedoFrigate: "M32 4 44 8 51 17 45 25 36 28 36 44 32 48 28 44 28 28 19 25 13 17 20 8ZM9 24H17V46H9ZM47 24H55V46H47Z",
  artilleryFrigate: "M32 3 42 12 45 46 35 48 32 38 29 48 19 46 22 12Z",
  destroyer: "M32 2 53 39 45 46 19 46 11 39Z",
  artilleryDestroyer: "M32 2 45 12 49 45 37 47 32 38 27 47 15 45 19 12Z",
  cruiser: "M32 3 47 7 56 16 50 25 39 29 38 42 33 47 28 42 25 29 14 25 8 16 17 7ZM7 24H15V46H7ZM49 24H57V46H49Z",
  artilleryCruiser: "M32 2 47 9 51 46 38 48 32 37 26 48 13 46 17 9Z",
  carrier: "M29 4 18 7 5 20 7 39 19 47 27 38 23 25 28 16 32 46 36 16 41 25 37 38 45 47 57 39 59 20 46 7 35 4 32 13Z",
  battleship: "M32 2 57 41 47 47 17 47 7 41Z",
};
const SHIP_THUMBNAIL_DETAILS: Readonly<Record<ShipClass, string>> = {
  fighter: "M32 7V39M18 27 28 23M46 27 36 23",
  fabricator: "M18 19A14 12 0 1 0 46 19A14 12 0 1 0 18 19M32 13V40",
  frigate: "M18 17C21 8 43 8 46 17M32 10V42M12 35H18M46 35H52",
  bomber: "M15 24 27 20M49 24 37 20M32 9V40",
  flakFrigate: "M20 16 44 30M44 16 20 30M32 11V42",
  torpedoFrigate: "M13 29V42M51 29V42M32 10V41",
  artilleryFrigate: "M32 8V42M23 12V39M41 12V39",
  destroyer: "M32 7V40M20 35 32 31 44 35",
  artilleryDestroyer: "M25 8V39M39 8V39M18 34H46",
  cruiser: "M17 17C22 7 42 7 47 17M32 10V42M11 31H15M49 31H53",
  artilleryCruiser: "M23 8V41M41 8V41M15 35H49",
  carrier: "M10 23 24 18M54 23 40 18M32 14V40",
  battleship: "M32 7V42M17 38 32 33 47 38M22 28H42",
};
const STRUCTURE_LABELS: Readonly<Record<StructureType, string>> = {
  creepNode: "CREEP NODE", pylon: "PYLON",
  commandCore: "COMMAND CORE",
  extractor: "EXTRACTOR",
  deepCoreExtractor: "DEEP-CORE EXTRACTOR",
  singularityHarvester: "SINGULARITY HARVESTER",
  alloyRefinery: "ALLOY REFINERY",
  matterForge: "MATTER FORGE",
  solarArray: "SOLAR ARRAY",
  storage: "STORAGE",
  quantumStorage: "QUANTUM VAULT",
  fabricator: "FABRICATOR",
  advancedFabrication: "ADVANCED FABRICATION",
  fusionReactor: "FUSION REACTOR",
  antimatterReactor: "ANTIMATTER REACTOR",
  shipyard: "SMALL SHIPYARD",
  fleetShipyard: "MEDIUM SHIPYARD",
  capitalInfrastructure: "CAPITAL INFRASTRUCTURE",
  capitalShipyard: "LARGE SHIPYARD",
  radarArray: "RADAR ARRAY",
  phasedRadarArray: "PHASED RADAR ARRAY",
  deepSpaceRadarArray: "DEEP-SPACE RADAR ARRAY",
  pointDefenseBattery: "T1 FLAK BASTION",
  missileBattery: "T1 TORPEDO CITADEL",
  railBattery: "T2 RAIL FORTRESS",
  plasmaBattery: "T2 PLASMA FORTRESS",
  beamBattery: "T3 BEAM CITADEL",
  artilleryBattery: "T1 ARTILLERY BATTERY",
  heavyArtilleryBattery: "T2 HEAVY ARTILLERY BATTERY",
  strategicArtilleryArray: "T3 STRATEGIC ARTILLERY ARRAY",
};
const STRUCTURE_ICONS: Readonly<Record<StructureType, string>> = {
  creepNode: "✺", pylon: "◇",
  commandCore: "⬡",
  extractor: "◆",
  deepCoreExtractor: "⬟",
  singularityHarvester: "◈",
  alloyRefinery: "⬢",
  matterForge: "⬣",
  solarArray: "✦",
  storage: "▦",
  quantumStorage: "▩",
  fabricator: "⌬",
  advancedFabrication: "⬢",
  fusionReactor: "◎",
  antimatterReactor: "◉",
  shipyard: "▰",
  fleetShipyard: "▱",
  capitalInfrastructure: "◉",
  capitalShipyard: "▰",
  radarArray: "⌁",
  phasedRadarArray: "⌁⌁",
  deepSpaceRadarArray: "⌁⌁⌁",
  pointDefenseBattery: "✣",
  missileBattery: "▲",
  railBattery: "⇈",
  plasmaBattery: "◉",
  beamBattery: "⌁",
  artilleryBattery: "⇡",
  heavyArtilleryBattery: "⇈",
  strategicArtilleryArray: "⇮",
};

const SHIP_COMMAND_DESCRIPTIONS: Readonly<Record<ShipClass, string>> = {
  fighter: "Fast interceptor squadron. Excellent at screening bombers and overwhelming isolated targets, but vulnerable to flak.",
  fabricator: "Mobile construction vessel for forward bases, expansion routes, and battlefield repairs.",
  frigate: "Flexible escort with plasma batteries and point defence. Reliable protection for larger hulls.",
  bomber: "Strike squadron carrying anti-capital torpedoes. Devastating against large ships when left uncontested.",
  flakFrigate: "Dedicated anti-strike-craft escort. Its overlapping point-defence arcs punish fighters and bombers.",
  torpedoFrigate: "Long-range anti-ship platform. Strong against capital hulls, but dependent on escorts at close range.",
  artilleryFrigate: "Mobile T1 siege support. Sets up quickly and pressures fortifications, but cannot fire while moving or inside minimum range.",
  destroyer: "Armoured line combatant with rail, plasma, and point-defence batteries for sustained fleet engagements.",
  artilleryDestroyer: "Deployable long-range siege ship. Needs allied vision and protection; vulnerable inside its minimum range.",
  cruiser: "Heavy multirole warship with broad weapon coverage, durable shields, and strong fleet presence.",
  artilleryCruiser: "Strategic T3 siege platform with two long-range guns. Slow to deploy and exposed to close assault without escorts.",
  carrier: "Command-scale support hull with extensive defensive coverage and exceptional sensor reach.",
  battleship: "Fleet-breaking capital ship. Extremely durable and heavily armed, but slow to turn and expensive to replace.",
};

const DAMAGE_PROFILE_COPY = {
  rapid: "RAPID · STRONG VS LIGHT · WEAK VS HEAVY",
  flak: "FLAK · EXCELLENT VS LIGHT · WEAK VS LARGE HULLS",
  plasma: "PLASMA · STRONG VS SHIELDS/PLATED",
  ordnance: "ORDNANCE · STRONG VS HEAVY · WEAK VS LIGHT",
  penetrating: "PENETRATING · STRONG VS HEAVY/FORTIFIED",
  siege: "SIEGE · STRONG VS FORTIFIED · WEAK VS LIGHT",
} as const;

const WEAPON_LABELS: Readonly<Record<WeaponTypeId, string>> = {
  autocannon: "AUTOCANNON",
  torpedo: "TORPEDO LAUNCHER",
  plasma: "PLASMA BATTERY",
  heavyRail: "HEAVY RAILGUN",
  pointDefense: "POINT DEFENCE",
  flakCannon: "FLAK CANNON",
  beam: "BEAM LANCE",
  lightArtillery: "LIGHT ARTILLERY",
  siegeArtillery: "SIEGE ARTILLERY",
  strategicArtillery: "STRATEGIC ARTILLERY",
};

type ShipyardType = (typeof SHIPYARD_TYPES)[number];

const PRODUCTION_HOTKEYS: Readonly<Record<ShipyardType, readonly Readonly<{
  code: string;
  label: string;
  shipClass: ShipClass;
}>[]>> = {
  shipyard: [
    { code: "KeyQ", label: "Q", shipClass: "fighter" },
    { code: "KeyW", label: "W", shipClass: "fabricator" },
    { code: "KeyE", label: "E", shipClass: "frigate" },
    { code: "KeyR", label: "R", shipClass: "bomber" },
    { code: "KeyT", label: "T", shipClass: "artilleryFrigate" },
  ],
  fleetShipyard: [
    { code: "KeyQ", label: "Q", shipClass: "flakFrigate" },
    { code: "KeyW", label: "W", shipClass: "torpedoFrigate" },
    { code: "KeyE", label: "E", shipClass: "destroyer" },
    { code: "KeyR", label: "R", shipClass: "artilleryDestroyer" },
    { code: "KeyT", label: "T", shipClass: "cruiser" },
  ],
  capitalShipyard: [
    { code: "KeyQ", label: "Q", shipClass: "artilleryCruiser" },
    { code: "KeyW", label: "W", shipClass: "carrier" },
    { code: "KeyE", label: "E", shipClass: "battleship" },
  ],
};

const FLEET_COMMAND_TOOLTIPS: Readonly<Record<string, string>> = {
  "cmd-move": "Move the selected formation to a destination while preserving its current engagement posture.",
  "cmd-attack": "Advance toward a destination and engage hostile contacts encountered along the route.",
  "cmd-patrol": "Patrol repeatedly between the current position and a chosen destination.",
  focus: "Concentrate the selected fleet's weapons on one hostile target.",
  "cmd-stop": "Cancel current movement and combat orders immediately.",
  "cmd-hold": "Hold position and engage targets without pursuing them.",
  "set-warp": "Choose a visible owned pylon field. Completed units appear there immediately; lost coverage holds production at ready.",
  "set-rally": "Set the selected shipyard's launch destination and formation facing.",
};

function structureCommandDescription(type: StructureType): string {
  const theme = factionStructureDescription(type, getPlayerFaction());
  return `${theme ? `${theme} ` : ""}${structureMechanicsDescription(type)}`;
}

function structureMechanicsDescription(type: StructureType): string {
  if (type === "creepNode") return "Extends creep over 15 seconds. Brood units gain +20% speed and +10% damage. Nests need creep to hatch. Build inside existing creep.";
  if (type === "pylon") return "Projects a warp field. Concord ships take 20% less shield damage and recharge 2% shields per second after five seconds without damage. Destroying it removes coverage.";
  if (getPlayerFaction() === "brood" && (SHIPYARD_TYPES as readonly string[]).includes(type)) return "Choose one permanent brood specialization. The nest hatches up to capacity and replaces destroyed units for free; requires creep. Survivors are adopted by replacement nests.";
  if (getPlayerFaction() === "concord" && (SHIPYARD_TYPES as readonly string[]).includes(type)) return "Produces elite ships that immediately warp to the chosen pylon field. Set Warp controls arrival; Set Rally controls orders after arrival.";
  const definition = getFactionStructureDefinition(type, getPlayerFaction());
  if ((definition.hardpoints?.length ?? 0) > 0) return `${fortressLoadoutSummary(type as (typeof DEFENSIVE_STRUCTURE_TYPES)[number])}. Fixed fortress providing layered control of the surrounding battlespace.`;
  if (type === "shipyard") return "Produces fighters, bombers, fabricators, and light escort ships.";
  if (type === "fleetShipyard") return "Produces specialist frigates, line destroyers, artillery, and cruisers for sustained fleet combat.";
  if (type === "capitalShipyard") return "Constructs carriers and battleships. The foundation of a late-game capital fleet.";
  if (definition.alloyIncome > 0) return `Generates ${definition.alloyIncome} alloy per second${definition.energyUpkeep > 0 ? ` at ${definition.energyUpkeep} energy per second upkeep` : ""}.`;
  if (definition.energyIncome > 0) return `Generates ${definition.energyIncome} energy per second${definition.energyUpkeep > 0 ? ` with ${definition.energyUpkeep} consumed internally` : " with no upkeep"}.`;
  if (definition.alloyStorage > 0 || definition.energyStorage > 0) return `Expands reserves by ${definition.alloyStorage} alloy and ${definition.energyStorage} energy.`;
  if (definition.buildPower > 0) return `Static fabrication hub with ${definition.buildPower.toFixed(1)}× build power and ${definition.assistRange} assist range.`;
  if (type === "radarArray" || type === "phasedRadarArray" || type === "deepSpaceRadarArray") return `Provides ${definition.sensorRange} units of radar coverage without energy upkeep.`;
  return "Expands fleet infrastructure and unlocks additional construction options.";
}

function tooltipNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
}

function tooltipWeaponLoadout(
  hardpoints: readonly Readonly<{ weaponTypeId: WeaponTypeId }>[],
  rangeMultiplier = 1,
  damageMultiplier = 1,
): string {
  if (hardpoints.length === 0) return "";
  const counts = new Map<WeaponTypeId, number>();
  for (const hardpoint of hardpoints) {
    counts.set(hardpoint.weaponTypeId, (counts.get(hardpoint.weaponTypeId) ?? 0) + 1);
  }
  const rows = [...counts.entries()].map(([weaponTypeId, count]) => {
    const weapon = WEAPONS[weaponTypeId];
    const damage = weapon.damage * damageMultiplier;
    const cycleTicks = Math.max(1, weapon.cooldownTicks + (weapon.burstSize - 1) * weapon.burstIntervalTicks);
    const dps = damage * weapon.burstSize * 20 / cycleTicks;
    const minimumRange = weapon.minimumRange * rangeMultiplier;
    const maximumRange = weapon.range * rangeMultiplier;
    const range = minimumRange > 0
      ? `${tooltipNumber(minimumRange)}–${tooltipNumber(maximumRange)}`
      : tooltipNumber(maximumRange);
    return `<div class="tooltip-weapon"><div><strong>${count}× ${escapeHtml(WEAPON_LABELS[weaponTypeId])}</strong><span>${escapeHtml(weapon.damageProfile.toUpperCase())}</span></div><small>${tooltipNumber(damage)} DMG${weapon.burstSize > 1 ? ` × ${weapon.burstSize} BURST` : ""} · ${tooltipNumber(dps)} DPS EACH · ${range} RANGE</small></div>`;
  }).join("");
  return `<section class="tooltip-section tooltip-weapons"><h4>WEAPONS</h4>${rows}</section>`;
}

function structureEconomyTooltip(type: StructureType): string {
  const definition = getFactionStructureDefinition(type, getPlayerFaction());
  const output = [
    definition.alloyIncome > 0 ? `+${tooltipNumber(definition.alloyIncome)} A/S` : "",
    definition.energyIncome > 0 ? `+${tooltipNumber(definition.energyIncome)} E/S` : "",
  ].filter(Boolean).join(" · ") || "NO INCOME";
  const upkeep = definition.energyUpkeep > 0 ? `−${tooltipNumber(definition.energyUpkeep)} E/S` : "NONE";
  const netEnergy = definition.energyIncome - definition.energyUpkeep;
  const netEnergyText = `${netEnergy > 0 ? "+" : netEnergy < 0 ? "−" : ""}${tooltipNumber(Math.abs(netEnergy))} E/S`;
  const capacity = definition.alloyStorage > 0 || definition.energyStorage > 0
    ? `<div><small>CAPACITY</small><strong>${definition.alloyStorage > 0 ? `+${definition.alloyStorage} A` : ""}${definition.alloyStorage > 0 && definition.energyStorage > 0 ? " · " : ""}${definition.energyStorage > 0 ? `+${definition.energyStorage} E` : ""}</strong></div>`
    : "";
  return `<section class="tooltip-section"><h4>ECONOMY</h4><div class="tooltip-economy"><div><small>OUTPUT</small><strong class="${output === "NO INCOME" ? "neutral" : "positive"}">${output}</strong></div><div><small>IDLE UPKEEP</small><strong class="${definition.energyUpkeep > 0 ? "negative" : "neutral"}">${upkeep}</strong></div><div><small>NET ENERGY</small><strong class="${netEnergy > 0 ? "positive" : netEnergy < 0 ? "negative" : "neutral"}">${netEnergyText}</strong></div>${capacity}</div></section>`;
}

function productionLoadTooltip(shipClass: ShipClass): string {
  const economy = getFactionShipEconomy(shipClass, getPlayerFaction());
  const buildSeconds = economy.buildTicks * FIXED_DT;
  const output = shipClass === "fighter"
    ? `${economy.batchSize} SQUADRONS / ${economy.batchSize * 5} CRAFT`
    : `${economy.batchSize} SHIP${economy.batchSize === 1 ? "" : "S"}`;
  return `<section class="tooltip-section"><h4>PRODUCTION LOAD</h4><div class="tooltip-economy tooltip-production-load"><div><small>ACTIVE DRAW</small><strong class="negative">−${tooltipNumber(economy.alloyCost / buildSeconds)} A/S · −${tooltipNumber(economy.energyCost / buildSeconds)} E/S</strong></div><div><small>OUTPUT</small><strong>${output} / ${tooltipNumber(buildSeconds)}S</strong></div></div></section>`;
}

function installCommandTooltips(): void {
  const tooltip = element("command-tooltip");
  const structureByButton = new Map(Object.entries(STRUCTURE_BUTTON_IDS).map(([type, id]) => [id, type as StructureType]));
  const shipByButton = new Map(Object.entries(SHIP_BUTTON_IDS).map(([shipClass, id]) => [id, shipClass as ShipClass]));
  let activeButton: HTMLButtonElement | null = null;

  const hide = () => {
    activeButton?.removeAttribute("aria-describedby");
    activeButton = null;
    tooltip.classList.remove("visible");
    tooltip.setAttribute("aria-hidden", "true");
  };
  const show = (button: HTMLButtonElement) => {
    if (button.closest(".construction-tabs")) return;
    const structureType = structureByButton.get(button.id);
    const shipClass = shipByButton.get(button.id);
    const commandDescription = FLEET_COMMAND_TOOLTIPS[button.id];
    if (!structureType && !shipClass && !commandDescription) return;
    activeButton = button;
    const hotkey = button.querySelector("kbd")?.textContent?.trim();
    const lockedReason = button.classList.contains("locked")
      ? button.querySelector<HTMLElement>(".command-lock")?.textContent?.trim()
      : "";
    let title = button.querySelector("span")?.textContent?.trim() ?? "COMMAND";
    let description = commandDescription ?? "";
    let cost = "";
    let economy = "";
    let weapons = "";
    const stats: string[] = [];
    if (structureType) {
      const definition = getFactionStructureDefinition(structureType, getPlayerFaction());
      title = structureLabel(structureType);
      description = structureCommandDescription(structureType);
      cost = `${definition.alloyCost} ALLOY · ${definition.energyCost} ENERGY · ${(definition.buildTicks * FIXED_DT).toFixed(1)}s BUILD`;
      stats.push(`${definition.maxHealth} HULL`, `${definition.maxShield} SHIELD`);
      stats.push(`${definition.armorType.toUpperCase()} ARMOR`);
      if (definition.sensorRange > 0) stats.push(`${definition.sensorRange} SENSOR`);
      economy = structureEconomyTooltip(structureType);
      weapons = tooltipWeaponLoadout(
        definition.hardpoints ?? (definition.weaponTypeId ? [{ weaponTypeId: definition.weaponTypeId }] : []),
        definition.weaponRangeMultiplier,
        definition.weaponDamageMultiplier,
      );
    } else if (shipClass) {
      const ship = getFactionShipDefinition(shipClass, getPlayerFaction());
      const production = getFactionShipEconomy(shipClass, getPlayerFaction());
      title = shipLabel(shipClass);
      description = SHIP_COMMAND_DESCRIPTIONS[shipClass] + (getPlayerFaction() === "brood"
        ? ` Permanently specializes this nest to maintain ${BROOD_CAPACITY[shipClass]} units. Free replacements hatch only on creep.`
        : getPlayerFaction() === "concord" ? " Warps immediately on completion. Pylon fields grant shield resistance and recharge." : "");
      cost = `${production.alloyCost} ALLOY · ${production.energyCost} ENERGY · ${(production.buildTicks * FIXED_DT).toFixed(1)}s BUILD${production.batchSize > 1 ? ` · ×${production.batchSize}` : ""}`;
      const profiles = [...new Set(ship.hardpoints.map((hardpoint) => WEAPONS[hardpoint.weaponTypeId].damageProfile))];
      stats.push(`${ship.maxHealth} HULL`, `${ship.maxShield} SHIELD`, `${ship.armorType.toUpperCase()} ARMOR`, `${ship.speed} SPEED`);
      for (const profile of profiles) stats.push(DAMAGE_PROFILE_COPY[profile]);
      economy = productionLoadTooltip(shipClass);
      weapons = tooltipWeaponLoadout(ship.hardpoints);
    }
    tooltip.innerHTML = `<h3><span>${escapeHtml(title)}</span>${hotkey ? `<kbd class="tooltip-hotkey">${escapeHtml(hotkey)}</kbd>` : ""}</h3>${cost ? `<div class="tooltip-cost">${escapeHtml(cost)}</div>` : ""}<p class="tooltip-description">${escapeHtml(description)}</p>${stats.length > 0 ? `<div class="tooltip-stats">${stats.map((stat) => `<span>${escapeHtml(stat)}</span>`).join("")}</div>` : ""}${weapons}${economy}${shipClass && hotkey ? getPlayerFaction() === "brood" ? `<div class="tooltip-action-hint">${escapeHtml(hotkey)} · SPECIALIZE NEST ONCE</div>` : `<div class="tooltip-action-hint"><kbd>${escapeHtml(hotkey)}</kbd> QUEUE · <kbd>SHIFT+${escapeHtml(hotkey)}</kbd> QUEUE ×5</div>` : ""}${lockedReason ? `<div class="tooltip-requirement">${escapeHtml(lockedReason)}</div>` : ""}`;
    button.setAttribute("aria-describedby", "command-tooltip");
    tooltip.setAttribute("aria-hidden", "false");
    tooltip.classList.add("visible");
    const buttonRect = button.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const left = Math.min(window.innerWidth - tooltipRect.width - 8, Math.max(8, buttonRect.right - tooltipRect.width));
    let top = buttonRect.top - tooltipRect.height - 10;
    if (top < 8) top = Math.min(window.innerHeight - tooltipRect.height - 8, buttonRect.bottom + 10);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };
  document.addEventListener("pointerover", (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".command-grid button") : null;
    if (button && button !== activeButton) show(button);
  });
  document.addEventListener("pointerout", (event) => {
    if (!activeButton) return;
    const destination = event.relatedTarget;
    if (!(destination instanceof Node) || !activeButton.contains(destination)) hide();
  });
  document.addEventListener("focusin", (event) => {
    if (event.target instanceof HTMLButtonElement && event.target.closest(".command-grid")) show(event.target);
  });
  document.addEventListener("focusout", (event) => {
    if (event.target === activeButton) hide();
  });
}

function isDefensiveStructureType(type: StructureType): type is (typeof DEFENSIVE_STRUCTURE_TYPES)[number] {
  return DEFENSIVE_STRUCTURE_TYPES.includes(type as (typeof DEFENSIVE_STRUCTURE_TYPES)[number]);
}

function fortressLoadoutSummary(type: (typeof DEFENSIVE_STRUCTURE_TYPES)[number]): string {
  const hardpoints = STRUCTURES[type].hardpoints ?? [];
  const counts = new Map<WeaponTypeId, number>();
  for (const hardpoint of hardpoints) counts.set(hardpoint.weaponTypeId, (counts.get(hardpoint.weaponTypeId) ?? 0) + 1);
  return [...counts].map(([weapon, count]) => `${count}× ${WEAPON_LABELS[weapon]}`).join(" · ");
}

function isShipCruising(ship: ShipState): boolean {
  return Math.hypot(ship.vx, ship.vz) > getFactionShipDefinition(ship.class, ship.faction).speed
    * (ship.faction === "brood" ? CREEP_SPEED_MULTIPLIER : 1) * 1.01;
}

function artilleryWeaponForShip(shipClass: ShipClass) {
  return SHIPS[shipClass].hardpoints
    .map((hardpoint) => WEAPONS[hardpoint.weaponTypeId])
    .find((weapon) => weapon.artillery !== undefined);
}

function isResourceExtractorType(type: StructureType): type is (typeof RESOURCE_EXTRACTOR_TYPES)[number] {
  return RESOURCE_EXTRACTOR_TYPES.includes(type as (typeof RESOURCE_EXTRACTOR_TYPES)[number]);
}

function resourceExtractorUpgradeSourceInView(
  structureType: StructureType,
  resourceNodeId: number | undefined,
): StructureState | null {
  const targetRank = RESOURCE_EXTRACTOR_TYPES.indexOf(
    structureType as (typeof RESOURCE_EXTRACTOR_TYPES)[number],
  );
  if (targetRank <= 0 || resourceNodeId === undefined) return null;
  const node = clientView.resourceNodes.find((candidate) => candidate.id === resourceNodeId);
  const source = node?.claimedByStructureId === null || node?.claimedByStructureId === undefined
    ? undefined
    : clientView.structures.find((structure) => structure.id === node.claimedByStructureId);
  if (!source || source.ownerPlayerId !== localPlayerId || source.buildProgress < 1) return null;
  const sourceRank = RESOURCE_EXTRACTOR_TYPES.indexOf(
    source.type as (typeof RESOURCE_EXTRACTOR_TYPES)[number],
  );
  return sourceRank >= 0 && sourceRank < targetRank ? source : null;
}

const structureVisuals = new Map<number, StructureVisual>();
const defensiveAimYaw = new Map<number, Map<number, number>>();
const resourceVisuals = new Map<number, ResourceVisual>();
const obstacleVisuals = new Map<number, ObstacleVisual>();
const previousTransforms = new Map<number, RenderTransform>();
const projectileVfx = new ProjectileVfx(scene);
const projectileAppearances = new ProjectileAppearanceRegistry();
const projectileFaction = (id: number) => projectileAppearances.get(id);
const pendingFighterShots = new Map<number, { shipId: number; member: number; sequence: number; vx: number; vz: number }>();
const fighterMuzzleScratch = new THREE.Vector3();
const fighterTargetScratch = new THREE.Vector3();
const renderStateBuilder = new RenderStateBuilder();
const batchedShipRenderer = new BatchedShipRenderer(scene);
const combatEffects = new CombatEffectRenderer(scene);
const stressScenario = new VisualStressScenario();
const battleAudio = new ScalableBattleAudio();
const noPreviousTransforms = new Map<number, RenderTransform>();
let renderQuality: RenderQuality = "medium";
let renderPreparationMs = 0;
let simulationCpuMs = 0;
let frameCpuMs = 0;
let lastStressEffectAt = 0;
let lastStressExplosionAt = 0;
let stressEffectCursor = 0;
const RENDER_BUDGET = { minimumFps: 58, drawCalls: 120, preparationMs: 6, gpuMs: 12, transparentBatches: 14 } as const;
interface EffectOrigin {
  x: number;
  y: number;
  z: number;
  radius: number;
  color: number;
  isShip: boolean;
  vx: number;
  vz: number;
  shields: number;
  yaw: number;
  shipClass?: ShipClass;
  faction?: FactionId;
  hullTarget?: ProjectileVisualTarget;
}
const effectOrigins = new Map<number, EffectOrigin>();
const lastDamageEffectAt = new Map<number, number>();
const effectProjection = new THREE.Vector3();
const velocityLines = createDynamicLines(0x58b9e8, 0.55);
const targetLines = createDynamicLines(0xffb253, 0.34);
const turretArcLines = createDynamicLines(0x5fd4ff, 0.2);
const projectileLines = createDynamicLines(0xc5edff, 0.52);
const commandLines = createDynamicLines(0x62dcff, 0.82);
const colliderLines = createDynamicLines(0x8bc7de, 0.5);
const avoidanceLines = createDynamicLines(0xffbd59, 0.82);
const formationPreviewLine = createDynamicLines(0x62dcff, 0.9);
const rallyLines = createDynamicLines(0x69e6b0, 0.78);
scene.add(
  velocityLines, targetLines, turretArcLines, projectileLines, commandLines,
  colliderLines, avoidanceLines, formationPreviewLine, rallyLines,
);

let localPlayerId = "pilot-blue";
const selectedShipIds = new Set<number>();
const selectedStructureIds = new Set<number>();
let primaryStructureId: number | null = null;
let selectionRosterSignature = "";
const controlGroups = new Map<number, number[]>();
const formationSlotMeshes: THREE.Mesh[] = [];
const rallyPointMeshes: THREE.Mesh[] = [];
const commandMarkers: Array<{ mesh: THREE.Mesh; bornAt: number }> = [];
let commandSequence = 0;
let pendingCommandMode: "move" | "attackMove" | "patrol" | "focusFire" | null = null;
let pendingStructureType: BuildableStructureType | null = null;
let buildPlacementDrag: {
  candidate: NonNullable<ReturnType<typeof getPlacementCandidate>>;
  yaw: number;
  keepPlacing: boolean;
} | null = null;
let pendingRallyPoint = false;
let pendingWarpPoint = false;
let selectionDrag: { startX: number; startY: number; currentX: number; currentY: number; shift: boolean } | null = null;
let commandDrag: {
  type: "move" | "attackMove" | "patrol";
  button: number;
  startX: number;
  startY: number;
  destination: THREE.Vector3;
  formationEnd: THREE.Vector3;
  queued: boolean;
} | null = null;
let lastControlGroup = 0;
let lastControlGroupAt = 0;

const authorityUrl = import.meta.env.VITE_AUTHORITY_URL as string | undefined
  ?? (import.meta.env.DEV
    ? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/authority`
    : location.origin.replace(/^http/, "ws"));
let networkSocket: WebSocket | null = null;
let networkMode = false;
let landingLobbyActive = true;
let networkPanelOpenedFromGame = false;
let demoMode = false;
let menuBattleMode = false;
let networkView: ProjectedViewState | null = null;
let networkViewReceivedAt = 0;
let networkViewInterpolationMs = 100;
let networkLobby: LobbyState | null = null;
const singleplayerLobby = createSingleplayerLobby();
let singleplayerSetupActive = false;
let stressTestMode = false;
let lobbyBrowserTimer = 0;
let lobbyBrowserRequest: AbortController | null = null;
let joinableGames: LobbyListEntry[] = [];

function setupLobby(): LobbyState | null {
  return singleplayerSetupActive ? singleplayerLobby : networkLobby;
}

function setupPlayerId(): string {
  return singleplayerSetupActive ? LOCAL_PLAYER_ID : localPlayerId;
}

function sendLobbyMessage(message: ClientMessage): void {
  if (singleplayerSetupActive) {
    updateSingleplayerLobby(singleplayerLobby, message);
    renderLobby();
  } else sendNetworkMessage(message);
}
let networkMatchId = "";
let networkPilotName = "Commander";
let serverTick = 0;
let networkLatency = 0;
const pendingNetworkBuilds = new Map<number, Extract<EconomyCommand, { type: "buildStructure" }>>();
let reconnectTimer = 0;
let pingTimer = 0;
let manuallyClosed = false;
let lanInviteOrigin = location.origin;
let mapSettingsOpen = false;
let draftLobbySettings: LobbySettings | null = null;
let draftLobbyMode: LobbyState["mode"] | null = null;

type ClientViewMode = "player" | "team-spectator" | "post-match-omniscient";
type RequestedNetworkRole = "player" | "team" | "replay";
let clientViewMode: ClientViewMode = "player";
let requestedNetworkRole: RequestedNetworkRole = "player";
let spectatorTeamId: number | null = null;
let spectatorToken = "";
let spectatorId = "";
let spectatorReconnectToken = "";
let replayManifest: ReplayManifest | null = null;
let replayChunks: Array<Uint8Array | undefined> = [];
let replayPlayer: ReplayPlayer | null = null;
let pendingReplayArchive: ReplayArchive | null = null;
let replayPlaying = false;
let replaySpeed = 1;
const REPLAY_SPEEDS = [0.5, 1, 2, 4] as const;

const MAP_CATALOG: Readonly<Record<LobbySettings["mapPreset"], {
  readonly label: string;
  readonly family: string;
  readonly description: string;
}>> = {
  "orbital-ring": { label: "ORBITAL RING", family: "BALANCED", description: "Balanced resource ring with a valuable contested center." },
  crossfire: { label: "CROSSFIRE", family: "DUAL LANES", description: "Split inner and outer resource lanes around a denser asteroid crossfire." },
  "open-expanse": { label: "OPEN EXPANSE", family: "OPEN FIELD", description: "Widely dispersed resources with fewer navigation hazards." },
  "asteroid-belt": { label: "ASTEROID BELT", family: "DIVIDED FIELD", description: "A dense seeded asteroid belt divides the field into risky crossings and flanking routes." },
  "spiral-arms": { label: "SPIRAL ARMS", family: "CURVED LANES", description: "Twin resource spirals pull fleets through curved expansion lanes toward the outer sectors." },
  "shattered-core": { label: "SHATTERED CORE", family: "AMBUSH POCKETS", description: "Broken central clusters create short sightlines, ambush pockets, and fragmented riches." },
  "amazon-tunnel": { label: "AMAZON TUNNEL", family: "ONE CHOKE", description: "A broad central passage opens into a resource-rich contested basin between two blocked asteroid fields." },
  "core-rush": { label: "CORE RUSH", family: "CENTRAL WEALTH", description: "Outer sectors are lean while unusually rich deposits pull expansion and early fleets toward the exposed center." },
  "star-fortress": { label: "STAR FORTRESS", family: "DEFENDED START", description: "Each commander begins behind a broken asteroid rampart with one inward-facing gate and room to establish an economy." },
};
const MAP_PRESET_ORDER = Object.keys(MAP_CATALOG) as LobbySettings["mapPreset"][];

function renderMapPreview(settings: LobbySettings, playerCount: number, canvasId = "map-preview-canvas"): void {
  const canvas = element<HTMLCanvasElement>(canvasId);
  const context = canvas.getContext("2d");
  if (!context) return;
  const width = canvas.width;
  const height = canvas.height;
  context.clearRect(0, 0, width, height);
  let hash = 2_166_136_261;
  const sampleKey = `${settings.mapPreset}:${settings.mapSize}:${settings.resourceDensity}:${Math.max(2, playerCount)}`;
  for (let index = 0; index < sampleKey.length; index += 1) hash = Math.imul(hash ^ sampleKey.charCodeAt(index), 16_777_619) >>> 0;
  const random = mulberry32(hash);
  const toX = (value: number) => width * (0.5 + value * 0.43);
  const toY = (value: number) => height * (0.5 + value * 0.43);
  const rotation = random() * Math.PI * 2;

  const glow = context.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, width * 0.48);
  glow.addColorStop(0, "rgba(30,104,112,.2)");
  glow.addColorStop(0.55, "rgba(7,30,40,.12)");
  glow.addColorStop(1, "rgba(1,5,9,.75)");
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);

  const commanders = Math.max(2, playerCount);
  const obstacleCount = settings.mapPreset === "open-expanse" ? 4
    : settings.mapPreset === "asteroid-belt" ? 18
      : settings.mapPreset === "shattered-core" ? 15
        : settings.mapPreset === "crossfire" ? 12
          : settings.mapPreset === "amazon-tunnel" ? 56
            : settings.mapPreset === "star-fortress" ? commanders * 6
              : settings.mapPreset === "core-rush" ? 6 : 8;
  for (let index = 0; index < obstacleCount; index += 1) {
    let x = Number.NaN;
    let y = Number.NaN;
    if (settings.mapPreset === "amazon-tunnel") {
      const obstaclesPerBlock = obstacleCount / 2;
      const blockIndex = index % obstaclesPerBlock;
      const sign = index < obstaclesPerBlock ? 1 : -1;
      const left = -0.7;
      const right = 0.7;
      const horizontalProgress = blockIndex / obstaclesPerBlock;
      const near = 0.19 + Math.max(0, 1 - Math.abs(horizontalProgress * 2 - 1)) * 0.07;
      const far = 0.94;
      const blockWidth = right - left;
      const blockHeight = far - near;
      const perimeter = 2 * (blockWidth + blockHeight);
      let distance = blockIndex / obstaclesPerBlock * perimeter;
      if (distance <= blockWidth) {
        x = left + distance; y = near;
      } else if ((distance -= blockWidth) <= blockHeight) {
        x = right; y = near + distance;
      } else if ((distance -= blockHeight) <= blockWidth) {
        x = right - distance; y = far;
      } else {
        distance -= blockWidth; x = left; y = far - distance;
      }
      y *= sign;
    } else if (settings.mapPreset === "star-fortress") {
      const commanderIndex = Math.floor(index / 6);
      const wallIndex = index % 6;
      const baseAngle = Math.PI + commanderIndex / commanders * Math.PI * 2;
      const centerX = Math.sin(baseAngle) * 0.82;
      const centerY = Math.cos(baseAngle) * 0.82;
      const wallOffsets = [-2.25, -1.5, -0.75, 0.75, 1.5, 2.25] as const;
      const wallAngle = baseAngle + wallOffsets[wallIndex]!;
      x = centerX + Math.sin(wallAngle) * 0.13;
      y = centerY + Math.cos(wallAngle) * 0.13;
    } else if (settings.mapPreset === "asteroid-belt") {
      const along = index / Math.max(1, obstacleCount - 1) * 1.7 - 0.85;
      const across = (random() - 0.5) * 0.18;
      x = along * Math.cos(rotation) - across * Math.sin(rotation);
      y = along * Math.sin(rotation) + across * Math.cos(rotation);
    } else if (settings.mapPreset === "crossfire") {
      const along = (Math.floor(index / 2) / Math.max(1, Math.ceil(obstacleCount / 2) - 1) - 0.5) * 1.35;
      const across = (index % 2 ? -1 : 1) * along + (random() - 0.5) * 0.08;
      x = along * Math.cos(rotation) - across * Math.sin(rotation);
      y = along * Math.sin(rotation) + across * Math.cos(rotation);
    } else {
      let angle = rotation + index / obstacleCount * Math.PI * 2 + (random() - 0.5) * 0.35;
      let radius = settings.mapPreset === "shattered-core" ? 0.1 + random() * 0.32 : 0.28 + random() * 0.3;
      if (settings.mapPreset === "spiral-arms") {
        angle = rotation + (index % 2) * Math.PI + index / obstacleCount * Math.PI * 1.8;
        radius = 0.16 + index / obstacleCount * 0.48;
      }
      x = Math.sin(angle) * radius;
      y = Math.cos(angle) * radius;
    }
    const size = 4 + random() * 6;
    context.fillStyle = "rgba(98,111,119,.72)";
    context.strokeStyle = "rgba(157,181,190,.42)";
    context.lineWidth = 1;
    context.beginPath();
    context.arc(toX(x), toY(y), size, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }

  const densityScale = settings.resourceDensity === "scarce" ? 0.7 : settings.resourceDensity === "rich" ? 1.35 : 1;
  const resourceCount = Math.round(13 * densityScale);
  for (let index = 0; index < resourceCount; index += 1) {
    const progress = index / resourceCount;
    let angle = rotation + progress * Math.PI * 2;
    let radius = 0.48 + (random() - 0.5) * 0.1;
    let x = Number.NaN;
    let y = Number.NaN;
    if (settings.mapPreset === "open-expanse") {
      angle = random() * Math.PI * 2;
      radius = 0.22 + random() * 0.52;
    } else if (settings.mapPreset === "amazon-tunnel") {
      x = (progress - 0.5) * 1.2;
      const centerFlare = Math.max(0, 1 - Math.abs(x) / 0.34);
      y = (random() - 0.5) * (0.17 + centerFlare * 0.13);
      angle = 0;
      radius = 0;
    } else if (settings.mapPreset === "core-rush") {
      angle = random() * Math.PI * 2;
      radius = 0.06 + random() * 0.28;
    } else if (settings.mapPreset === "star-fortress") {
      radius = 0.3 + random() * 0.25;
    } else if (settings.mapPreset === "spiral-arms") {
      const armProgress = Math.floor(index / 2) / Math.max(1, Math.ceil(resourceCount / 2) - 1);
      angle = rotation + (index % 2) * Math.PI + armProgress * Math.PI * 1.65;
      radius = 0.14 + armProgress * 0.55;
    } else if (settings.mapPreset === "shattered-core") {
      angle = rotation + index % 3 * Math.PI * 2 / 3 + (random() - 0.5) * 0.4;
      radius = 0.28 + Math.floor(index / 3) / Math.max(1, Math.ceil(resourceCount / 3)) * 0.38;
    } else if (settings.mapPreset === "asteroid-belt") {
      const along = (progress - 0.5) * 1.35;
      const across = (index % 2 ? -1 : 1) * (0.18 + random() * 0.08);
      x = along * Math.cos(rotation) - across * Math.sin(rotation);
      y = along * Math.sin(rotation) + across * Math.cos(rotation);
      angle = 0;
      radius = 0;
    }
    if (Number.isNaN(x)) x = Math.sin(angle) * radius;
    if (Number.isNaN(y)) y = Math.cos(angle) * radius;
    context.save();
    context.translate(toX(x), toY(y));
    context.rotate(Math.PI / 4);
    context.fillStyle = "rgba(45,170,154,.88)";
    context.shadowColor = "#59e0cb";
    context.shadowBlur = 8;
    context.fillRect(-3.5, -3.5, 7, 7);
    context.restore();
  }

  for (let index = 0; index < commanders; index += 1) {
    let commanderX: number;
    let commanderY: number;
    if (settings.mapPreset === "amazon-tunnel") {
      const leftCount = Math.ceil(commanders / 2);
      const onLeft = index < leftCount;
      const sideIndex = onLeft ? index : index - leftCount;
      const sideCount = onLeft ? leftCount : commanders - leftCount;
      commanderX = onLeft ? -0.86 : 0.86;
      commanderY = (sideIndex - (sideCount - 1) / 2) * Math.min(0.38, 1.24 / Math.max(1, sideCount - 1));
    } else {
      const angle = Math.PI + index / commanders * Math.PI * 2;
      commanderX = Math.sin(angle) * 0.88;
      commanderY = Math.cos(angle) * 0.88;
    }
    const x = toX(commanderX);
    const y = toY(commanderY);
    context.fillStyle = `hsl(${195 + index * 137.5},85%,64%)`;
    context.shadowColor = context.fillStyle;
    context.shadowBlur = 10;
    context.beginPath();
    context.moveTo(x, y - 7);
    context.lineTo(x + 6, y + 5);
    context.lineTo(x - 6, y + 5);
    context.closePath();
    context.fill();
  }
  context.shadowBlur = 0;
  context.fillStyle = "rgba(133,205,210,.68)";
  context.font = '12px "JetBrains Mono"';
  context.fillText(MAP_CATALOG[settings.mapPreset].label, 12, 19);
}

const raycaster = new THREE.Raycaster();
const battlefieldPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const placementMaterial = new THREE.MeshBasicMaterial({
  color: 0x62dcff, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide,
});
const placementRingMaterial = new THREE.MeshBasicMaterial({
  color: 0x62dcff, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide,
});
const placementGhost = new THREE.Group();
const placementBody = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 7, 8), placementMaterial);
placementBody.position.y = 3.5;
const placementRing = new THREE.Mesh(new THREE.RingGeometry(1.04, 1.12, 32), placementRingMaterial);
placementRing.rotation.x = -Math.PI / 2;
placementRing.position.y = 0.5;
placementGhost.add(placementBody, placementRing);
placementGhost.visible = false;
scene.add(placementGhost);

function createTacticalIconBatch(
  sides: number,
  capacity: number,
  opacity = 0.96,
  innerRadius = 0.58,
  blending: THREE.Blending = THREE.AdditiveBlending,
): THREE.InstancedMesh {
  const geometry = new THREE.RingGeometry(innerRadius, 1, sides);
  return createTacticalGeometryBatch(geometry, capacity, opacity, blending);
}

function createTacticalGeometryBatch(
  geometry: THREE.BufferGeometry,
  capacity: number,
  opacity = 0.96,
  blending: THREE.Blending = THREE.AdditiveBlending,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity, side: THREE.DoubleSide,
    depthWrite: false, depthTest: false, fog: false, toneMapped: false,
    blending,
  }), capacity);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.renderOrder = 40;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(mesh);
  return mesh;
}

type TacticalStructureFamily = "command" | "alloy" | "energy" | "fabrication" | "shipyard" | "storage" | "radar" | "defence";
type TacticalStructureIconKey = `${TacticalStructureFamily}-${1 | 2 | 3}`;

function tacticalBadgeBar(fromX: number, fromY: number, toX: number, toY: number, thickness = 0.12): THREE.BufferGeometry {
  const deltaX = toX - fromX;
  const deltaY = toY - fromY;
  const bar = new THREE.PlaneGeometry(Math.hypot(deltaX, deltaY), thickness);
  bar.rotateZ(Math.atan2(deltaY, deltaX));
  bar.translate((fromX + toX) / 2, (fromY + toY) / 2, 0);
  return bar;
}

function createStructureTacticalGeometry(family: TacticalStructureFamily, tier: 1 | 2 | 3): THREE.BufferGeometry {
  const pieces: THREE.BufferGeometry[] = [new THREE.RingGeometry(0.78, 1, family === "defence" ? 8 : 4)];
  const add = (x1: number, y1: number, x2: number, y2: number, thickness = 0.12): void => {
    pieces.push(tacticalBadgeBar(x1, y1, x2, y2, thickness));
  };
  if (family === "command") {
    pieces.push(new THREE.RingGeometry(0.3, 0.45, 4));
    add(-0.55, 0, 0.55, 0, 0.1);
    add(0, -0.55, 0, 0.55, 0.1);
  } else if (family === "alloy") {
    add(-0.5, 0.42, 0, -0.42, 0.15);
    add(0.5, 0.42, 0, -0.42, 0.15);
    add(0, -0.42, 0, 0.52, 0.11);
  } else if (family === "energy") {
    add(0.25, 0.58, -0.2, 0.08, 0.17);
    add(-0.2, 0.08, 0.2, 0.08, 0.17);
    add(0.2, 0.08, -0.28, -0.58, 0.17);
  } else if (family === "fabrication") {
    add(-0.5, 0.48, -0.5, -0.48, 0.14);
    add(-0.5, 0.48, 0.48, 0.48, 0.14);
    add(-0.5, 0, 0.28, 0, 0.14);
    add(0.16, -0.5, 0.5, -0.16, 0.13);
    add(0.5, -0.16, 0.16, 0.18, 0.13);
  } else if (family === "shipyard") {
    add(-0.55, 0.5, -0.55, -0.5, 0.13);
    add(0.55, 0.5, 0.55, -0.5, 0.13);
    add(-0.55, -0.5, 0.55, -0.5, 0.13);
    add(0, -0.4, 0, 0.45, 0.15);
    add(-0.28, 0.18, 0, 0.48, 0.13);
    add(0, 0.48, 0.28, 0.18, 0.13);
  } else if (family === "storage") {
    add(-0.5, 0.38, 0.5, 0.38, 0.14);
    add(-0.5, 0, 0.5, 0, 0.14);
    add(-0.5, -0.38, 0.5, -0.38, 0.14);
  } else if (family === "radar") {
    add(0, -0.55, 0, 0.2, 0.12);
    add(-0.48, 0.48, 0, 0.08, 0.12);
    add(0, 0.08, 0.48, 0.48, 0.12);
    add(-0.38, -0.5, 0.38, -0.5, 0.12);
  } else {
    add(-0.52, 0, 0.52, 0, 0.16);
    add(0, -0.52, 0, 0.52, 0.16);
  }
  const pipWidth = 0.25;
  const pipGap = 0.1;
  const totalWidth = tier * pipWidth + (tier - 1) * pipGap;
  for (let pip = 0; pip < tier; pip += 1) {
    const start = -totalWidth / 2 + pip * (pipWidth + pipGap);
    add(start, 1.18, start + pipWidth, 1.18, 0.13);
  }
  const geometry = mergeGeometries(pieces, false);
  if (!geometry) throw new Error("Unable to build structure tactical icon");
  return geometry;
}

function structureTacticalIcon(structureType: StructureType): { family: TacticalStructureFamily; tier: 1 | 2 | 3 } {
  switch (structureType) {
    case "creepNode": return { family: "fabrication", tier: 1 };
    case "pylon": return { family: "energy", tier: 1 };
    case "extractor": return { family: "alloy", tier: 1 };
    case "deepCoreExtractor": case "alloyRefinery": return { family: "alloy", tier: 2 };
    case "singularityHarvester": case "matterForge": return { family: "alloy", tier: 3 };
    case "solarArray": return { family: "energy", tier: 1 };
    case "fusionReactor": return { family: "energy", tier: 2 };
    case "antimatterReactor": return { family: "energy", tier: 3 };
    case "fabricator": return { family: "fabrication", tier: 1 };
    case "advancedFabrication": return { family: "fabrication", tier: 2 };
    case "capitalInfrastructure": return { family: "fabrication", tier: 3 };
    case "shipyard": return { family: "shipyard", tier: 1 };
    case "fleetShipyard": return { family: "shipyard", tier: 2 };
    case "capitalShipyard": return { family: "shipyard", tier: 3 };
    case "storage": return { family: "storage", tier: 1 };
    case "quantumStorage": return { family: "storage", tier: 3 };
    case "radarArray": return { family: "radar", tier: 1 };
    case "phasedRadarArray": return { family: "radar", tier: 2 };
    case "deepSpaceRadarArray": return { family: "radar", tier: 3 };
    case "pointDefenseBattery": case "missileBattery": case "artilleryBattery": return { family: "defence", tier: 1 };
    case "railBattery": case "plasmaBattery": case "heavyArtilleryBattery": return { family: "defence", tier: 2 };
    case "beamBattery": case "strategicArtilleryArray": return { family: "defence", tier: 3 };
    default: return { family: "command", tier: 3 };
  }
}

const tacticalStructureIcons = new Map<TacticalStructureIconKey, THREE.InstancedMesh>();
for (const family of ["command", "alloy", "energy", "fabrication", "shipyard", "storage", "radar", "defence"] as const) {
  for (const tier of [1, 2, 3] as const) {
    tacticalStructureIcons.set(`${family}-${tier}`, createTacticalGeometryBatch(createStructureTacticalGeometry(family, tier), 1_024));
  }
}
const tacticalResourceIcons = createTacticalIconBatch(6, 1_024);
const tacticalObstacleIcons = createTacticalIconBatch(10, 1_024, 0.09, 0.94, THREE.NormalBlending);
const tacticalIconMatrix = new THREE.Matrix4();
const tacticalIconPosition = new THREE.Vector3();
const tacticalIconScale = new THREE.Vector3();
const tacticalIconColor = new THREE.Color();
const tacticalIconRotation = new THREE.Quaternion();

function createPlayableScenario(): ReturnType<typeof createCombatScenario> {
  return createSingleplayerScenario(singleplayerLobby, crypto.getRandomValues(new Uint32Array(1))[0] ?? Date.now());
}

let simulation = createPlayableScenario();
let lockstepInputs = new LockstepInputs(simulation);
let physicsWorld: PlanarCirclePhysicsWorld | null = null;
let physicsRuntime: PhysicsRuntime | null = null;
let pendingLockstepState: { state: SimulationState; notice?: string; focusStartingBase: boolean } | null = null;
let pendingLockstepCommands: GameCommand[] = [];
let pendingLockstepPlayerStates: Array<{
  tick: number;
  playerId: string;
  state: "playing" | "disconnected";
}> = [];
let pendingLockstepTargetTick = 0;
let lockstepTargetTick = 0;
let lockstepTargetChecksum = 0;
let lockstepResyncPending = false;
let lockstepResyncCooldownUntil = 0;
let lockstepChecksumGraceTick = 0;
let lastLockstepSyncReportTick = -1;
let lockstepResultReported = false;
const sharedSimulationTrialEnabled = new URLSearchParams(location.search).get("shared-sim") === "1";
let sharedSimulationWorker: Worker | null = null;
let sharedRenderReader: SharedRenderReader | null = null;
let sharedSimulationBuffers: SharedRenderBuffers | null = null;

function replacePhysicsWorld(): PlanarCirclePhysicsWorld {
  if (!physicsRuntime) throw new Error("Box3D runtime is not ready");
  physicsWorld?.dispose();
  physicsWorld = createPlanarCirclePhysicsWorld(physicsRuntime);
  return physicsWorld;
}

function initializeSharedSimulationTrial(state: SimulationState): void {
  sharedSimulationWorker?.terminate();
  sharedSimulationWorker = null;
  sharedRenderReader = null;
  sharedSimulationBuffers = null;
  if (!sharedSimulationTrialEnabled || !crossOriginIsolated || typeof SharedArrayBuffer === "undefined") return;
  const turretCount = state.ships.reduce((sum, ship) => sum + ship.turrets.length, 0);
  const buffers = createSharedRenderBuffers({
    ships: Math.max(4_096, Math.ceil(state.ships.length * 1.5)),
    turrets: Math.max(16_384, Math.ceil(turretCount * 1.5)),
    projectiles: Math.max(16_384, Math.ceil(state.projectiles.length * 2 + 4_096)),
  });
  const worker = new Worker(new URL("./simulation-render.worker.ts", import.meta.url), { type: "module" });
  worker.addEventListener("message", (event: MessageEvent<{ type: string; message?: string }>) => {
    if (event.data.type === "error") showNetworkError(event.data.message ?? "Shared simulation worker failed");
  });
  worker.postMessage({ type: "initialize", state, buffers });
  sharedSimulationWorker = worker;
  sharedSimulationBuffers = buffers;
  sharedRenderReader = new SharedRenderReader(buffers);
}
let networkInterpolationStartedAt = performance.now();
let lastDebug: DebugSnapshot = simulation.debugSnapshot();
let accumulator = 0;
let lastTime = performance.now();
let paused = false;
let fps = 60;
let frameCounter = 0;
let fpsTime = lastTime;
let toastTimer = 0;
let eventLines: string[] = ["<b>SYS</b> deterministic scenario initialized"];

const cameraRig = {
  target: new THREE.Vector3(0, 0, 0),
  distance: 610,
  azimuth: 0,
};
const cameraForward = new THREE.Vector3();
const cameraRight = new THREE.Vector3();
const cameraDirection = new THREE.Vector3();
const keys = new Set<string>();
let middleDrag = false;
let lastPointerX = 0;
let lastPointerY = 0;
let pointerX = innerWidth / 2;
let pointerY = innerHeight / 2;

for (const ship of simulation.state.ships) previousTransforms.set(ship.id, captureTransform(ship));

loadPhysicsRuntime()
  .then((runtime) => {
    const probe = runPhysicsProbe(runtime);
    physicsRuntime = runtime;
    physicsWorld = createPlanarCirclePhysicsWorld(runtime);
    if (replayPlayer?.replay.physicsBackend !== "deterministic-fallback") {
      simulation.attachPhysicsWorld(physicsWorld);
    }
    element("connection-detail").textContent = `BOX3D WASM · ${probe.x > 0 ? "VERIFIED" : "READY"}`;
    if (pendingReplayArchive) {
      const archive = pendingReplayArchive;
      pendingReplayArchive = null;
      installReplayArchive(archive);
    }
    if (pendingLockstepState) {
      const pending = pendingLockstepState;
      const pendingCommands = pendingLockstepCommands;
      const pendingPlayerStates = pendingLockstepPlayerStates;
      const pendingTargetTick = pendingLockstepTargetTick;
      pendingLockstepState = null;
      pendingLockstepCommands = [];
      pendingLockstepPlayerStates = [];
      pendingLockstepTargetTick = 0;
      installLockstepState(pending.state, pending.notice, pending.focusStartingBase);
      lockstepInputs.queueCommands(pendingCommands);
      sharedSimulationWorker?.postMessage({ type: "commands", commands: pendingCommands });
      for (const transition of pendingPlayerStates) {
        lockstepInputs.queuePlayerState(transition);
        sharedSimulationWorker?.postMessage({ type: "player_state", ...transition });
      }
      simulation.refreshChecksum();
      lockstepTargetTick = Math.max(lockstepTargetTick, pendingTargetTick, simulation.state.tick);
      sharedSimulationWorker?.postMessage({ type: "advance", targetTick: lockstepTargetTick });
      lastDebug = simulation.debugSnapshot();
      installClientView(buildClientVisibilityView(), false);
    }
  })
  .catch((error: unknown) => {
    element("connection-detail").textContent = "BOX3D LOAD ERROR";
    console.error(error);
  });

window.addEventListener("pagehide", () => {
  physicsWorld?.dispose();
  physicsWorld = null;
}, { once: true });

type ClientCommandResult = CommandResult | { accepted: false; reason: "offline" | "physics" | "spectator" | "replay" };

function canIssuePlayerCommands(): boolean {
  return clientViewMode === "player" && !demoMode;
}

function setClientViewMode(mode: ClientViewMode, teamId: number | null = null): void {
  clientViewMode = mode;
  spectatorTeamId = mode === "team-spectator" ? teamId : null;
  const showingDemo = demoMode && mode === "player";
  element("replay-controls").classList.toggle("hidden", mode !== "post-match-omniscient");
  document.querySelector(".camera-help")?.classList.toggle("hidden", mode === "post-match-omniscient" || showingDemo);
  document.querySelector(".command-deck")?.classList.toggle("view-locked", mode !== "player" || showingDemo);
  element<HTMLButtonElement>("pause").disabled = mode === "team-spectator";
  element<HTMLButtonElement>("step").disabled = mode === "team-spectator";
  element<HTMLSelectElement>("stress-count").disabled = mode !== "player" || showingDemo;
  if (mode !== "player" || showingDemo) {
    pendingCommandMode = null;
    pendingStructureType = null;
    pendingRallyPoint = false;
    commandDrag = null;
    selectionDrag = null;
    selectedShipIds.clear();
    selectedStructureIds.clear();
    primaryStructureId = null;
    placementGhost.visible = false;
    hideFormationPreview();
    element("command-mode").classList.remove("visible");
    element("directive").textContent = showingDemo
      ? "AUTONOMOUS WAR ECONOMY // ALL CONTACTS VISIBLE"
      : mode === "team-spectator"
      ? "VIEW ONLY // TEAM SENSOR FEED"
      : "VIEW ONLY // DETERMINISTIC MATCH REPLAY";
  }
  updateSelectionHud();
}

function nextCommandTick(): number {
  if (!networkMode) return simulation.state.tick + 1;
  // A frame's server tick is already roughly half an RTT old when it reaches us,
  // and the command needs the other half of the RTT to get back. Keep a small
  // four-tick execution cushion on top of the measured round trip. The authority
  // remains the final safeguard if a transient spike still makes the command late.
  const networkLeadTicks = Math.min(32, 4 + Math.ceil(networkLatency / (FIXED_DT * 1_000)));
  return Math.max(currentState().tick, serverTick) + networkLeadTicks;
}

function submitPlayerCommand(command: GameCommand): ClientCommandResult {
  if (!canIssuePlayerCommands()) {
    showToast(demoMode
      ? "SHOWCASE // AUTONOMOUS CONTROL"
      : clientViewMode === "team-spectator" ? "TEAM SPECTATOR // VIEW ONLY" : "REPLAY // VIEW ONLY");
    return { accepted: false, reason: clientViewMode === "team-spectator" ? "spectator" : "replay" };
  }
  if (!networkMode && !physicsWorld) {
    showToast("BOX3D PHYSICS INITIALIZING");
    return { accepted: false, reason: "physics" };
  }
  if (networkMode && networkSocket?.readyState !== WebSocket.OPEN) {
    return { accepted: false, reason: "offline" };
  }
  if (networkMode) {
    return sendNetworkMessage({
      type: "commands",
      commands: [command],
      clientTick: currentState().tick,
      clientChecksum: currentState().checksum,
    })
      ? { accepted: true, scheduledTick: command.requestedTick }
      : { accepted: false, reason: "offline" };
  }
  const result = simulation.submitCommand(command);
  return result;
}

function isHostileToLocalPlayer(teamId: number): boolean {
  const state = currentState();
  const localTeamId = clientView?.localTeamId
    ?? state.players.find((player) => player.id === localPlayerId)?.teamId;
  if (localTeamId === undefined || localTeamId === teamId) return false;
  return !state.teams.find((team) => team.id === localTeamId)?.alliedTeamIds.includes(teamId);
}

interface ClientVisibilityView {
  state: SimulationState | ProjectedViewState;
  localTeamId: number | null;
  visibilityFingerprint: number;
  visibleEntityIds: ReadonlySet<number>;
  visibleProjectileIds: ReadonlySet<number>;
  discoveredResourceNodeIds: ReadonlySet<number>;
  ships: readonly ShipState[];
  structures: readonly StructureState[];
  projectiles: readonly ProjectileState[];
  resourceNodes: readonly ResourceNodeState[];
  targetsById: ReadonlyMap<number, ProjectileVisualTarget>;
  verticalLaunchOwnerIds: ReadonlySet<number>;
}

function currentState(): SimulationState | ProjectedViewState {
  return networkMode && networkView ? networkView : simulation.state;
}

function getPlayerFaction(playerId = localPlayerId): FactionId {
  return currentState().players.find((player) => player.id === playerId)?.faction ?? "industrial";
}

function shipLabel(shipClass: ShipClass, faction = getPlayerFaction()): string {
  return factionShipName(shipClass, faction)?.toUpperCase() ?? SHIP_LABELS[shipClass];
}

function visibleTerritories(): readonly TerritoryFieldState[] {
  return currentState().territories.filter((field) => clientView.localTeamId === null
    || isAlliedToLocalPlayer(field.teamId) || clientView.visibleEntityIds.has(field.id));
}

function fingerprintVisibleEntities(entityIds: ReadonlySet<number>): number {
  let fingerprint = 0x811c9dc5;
  for (const entityId of entityIds) {
    fingerprint = Math.imul(fingerprint ^ entityId, 0x01000193);
  }
  return Math.imul(fingerprint ^ entityIds.size, 0x01000193) >>> 0;
}

function buildClientVisibilityView(): ClientVisibilityView {
  const state = currentState();
  const player = state.players.find((candidate) => candidate.id === localPlayerId);
  const localTeamId = demoMode || clientViewMode === "post-match-omniscient"
    ? null
    : clientViewMode === "team-spectator" ? spectatorTeamId
      : networkMode && networkView ? networkView.viewerTeamId : player?.teamId ?? null;
  if (networkMode && networkView) {
    const ships = state.ships as readonly ShipState[];
    const structures: readonly StructureState[] = state.structures.map((structure) => ({
      ...structure,
      repeatProduction: structure.repeatProduction ?? false,
      rallyPoint: structure.rallyPoint ?? { x: structure.x, z: structure.z },
    }));
    const projectiles: readonly ProjectileState[] = state.projectiles.map((projectile) => ({
      ...projectile,
      ownerShipId: projectile.ownerShipId ?? -1,
      targetEntityId: projectile.targetEntityId ?? -1,
    }));
    const targets = [...ships, ...structures];
    const visibleEntityIds = new Set(targets.map((entity) => entity.id));
    return {
      state, localTeamId,
      visibilityFingerprint: fingerprintVisibleEntities(visibleEntityIds),
      visibleEntityIds,
      visibleProjectileIds: new Set(projectiles.map((projectile) => projectile.id)),
      discoveredResourceNodeIds: new Set(state.resourceNodes.map((node) => node.id)),
      ships, structures, projectiles, resourceNodes: state.resourceNodes,
      targetsById: new Map(targets.map((target) => [target.id, {
        x: target.x,
        z: target.z,
        ...("class" in target ? { y: target.y, shipClass: target.class, faction: target.faction ?? "industrial" } : { y: 8 }),
        radius: "class" in target ? SHIPS[target.class].radius : STRUCTURES[target.type].radius,
        yaw: target.yaw,
        isShip: "class" in target,
      }])),
      verticalLaunchOwnerIds: new Set([
        ...ships.filter((ship) => ship.class !== "bomber"
          && ship.turrets.some((turret) => turret.weaponTypeId === "torpedo")).map((ship) => ship.id),
        ...structures.filter((structure) => structure.type === "missileBattery").map((structure) => structure.id),
      ]),
    };
  }
  const simulationState = state as SimulationState;
  const visibility = localTeamId !== null
    ? simulationState.visibility.find((candidate) => candidate.teamId === localTeamId)
    : undefined;
  const visibleEntityIds = new Set(visibility?.visibleEntityIds
    ?? [...simulationState.ships, ...simulationState.structures].map((entity) => entity.id));
  const visibleProjectileIds = new Set(visibility?.visibleProjectileIds
    ?? simulationState.projectiles.map((projectile) => projectile.id));
  const discoveredResourceNodeIds = new Set(visibility?.discoveredResourceNodeIds
    ?? simulationState.resourceNodes.map((node) => node.id));
  const ships = simulationState.ships.filter((ship) => visibleEntityIds.has(ship.id));
  const structures = simulationState.structures.filter((structure) => visibleEntityIds.has(structure.id));
  return {
    state, localTeamId,
    visibilityFingerprint: fingerprintVisibleEntities(visibleEntityIds),
    visibleEntityIds, visibleProjectileIds, discoveredResourceNodeIds,
    ships,
    structures,
    projectiles: simulationState.projectiles.filter((projectile) => visibleProjectileIds.has(projectile.id)),
    resourceNodes: simulationState.resourceNodes.filter((node) => discoveredResourceNodeIds.has(node.id)),
    targetsById: new Map([...ships, ...structures].map((target) => [target.id, {
      x: target.x,
      z: target.z,
      ...("class" in target ? { y: target.y, shipClass: target.class, faction: target.faction ?? "industrial" } : { y: 8 }),
      radius: "class" in target ? SHIPS[target.class].radius : STRUCTURES[target.type].radius,
      yaw: target.yaw,
      isShip: "class" in target,
    }])),
    verticalLaunchOwnerIds: new Set([
      ...ships.filter((ship) => ship.class !== "bomber"
        && ship.turrets.some((turret) => turret.weaponTypeId === "torpedo")).map((ship) => ship.id),
      ...structures.filter((structure) => structure.type === "missileBattery").map((structure) => structure.id),
    ]),
  };
}

let clientView = buildClientVisibilityView();

interface ClientVisibilityTransition {
  readonly generation: number;
  readonly appearedEntityIds: ReadonlySet<number>;
  readonly disappearedEntityIds: ReadonlySet<number>;
}

interface LastKnownContact {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly color: number;
  readonly lostAtTick: number;
  readonly expiresAtTick: number;
}

const LAST_KNOWN_CONTACT_TICKS = 200;
const MAX_LAST_KNOWN_CONTACTS = 4_096;
const lastKnownContacts = new Map<number, LastKnownContact>();
let lastKnownContactsDirty = true;
let clientVisibilityTransition: ClientVisibilityTransition = {
  generation: 1,
  appearedEntityIds: new Set(clientView.visibleEntityIds),
  disappearedEntityIds: new Set<number>(),
};

function isHostileInView(view: ClientVisibilityView, teamId: number): boolean {
  if (view.localTeamId === null || view.localTeamId === teamId) return false;
  return !view.state.teams.find((team) => team.id === view.localTeamId)?.alliedTeamIds.includes(teamId);
}

function rememberLastKnownContact(entity: ShipState | StructureState, tick: number): void {
  const radius = "class" in entity ? SHIPS[entity.class].radius : STRUCTURES[entity.type].radius;
  if (!lastKnownContacts.has(entity.id) && lastKnownContacts.size >= MAX_LAST_KNOWN_CONTACTS) {
    const oldestId = lastKnownContacts.keys().next().value as number | undefined;
    if (oldestId !== undefined) lastKnownContacts.delete(oldestId);
  }
  lastKnownContacts.set(entity.id, {
    id: entity.id,
    x: entity.x,
    z: entity.z,
    radius,
    color: colorForPlayer(entity.ownerPlayerId, entity.teamId),
    lostAtTick: tick,
    expiresAtTick: tick + LAST_KNOWN_CONTACT_TICKS,
  });
  lastKnownContactsDirty = true;
}

function installClientView(next: ClientVisibilityView, preserveLastKnownContacts = true): void {
  const previous = clientView;
  const teamChanged = previous.localTeamId !== next.localTeamId;
  if (teamChanged || next.state.tick < previous.state.tick) projectileAppearances.clear();
  projectileAppearances.sync(next.projectiles, next.ships, next.structures, next.state.players);
  const contactsChanged = teamChanged
    || previous.visibleEntityIds.size !== next.visibleEntityIds.size
    || previous.visibilityFingerprint !== next.visibilityFingerprint;

  if (!contactsChanged) {
    clientView = next;
    return;
  }

  const appearedEntityIds = new Set<number>();
  const disappearedEntityIds = new Set<number>();
  for (const entityId of next.visibleEntityIds) {
    if (!previous.visibleEntityIds.has(entityId)) appearedEntityIds.add(entityId);
    lastKnownContacts.delete(entityId);
  }
  for (const entityId of previous.visibleEntityIds) {
    if (!next.visibleEntityIds.has(entityId)) disappearedEntityIds.add(entityId);
  }

  if (!preserveLastKnownContacts || teamChanged || next.localTeamId === null) {
    if (lastKnownContacts.size > 0) lastKnownContactsDirty = true;
    lastKnownContacts.clear();
  } else if (disappearedEntityIds.size > 0) {
    for (const entity of [...previous.ships, ...previous.structures]) {
      if (disappearedEntityIds.has(entity.id) && isHostileInView(previous, entity.teamId)) {
        rememberLastKnownContact(entity, next.state.tick);
      }
    }
  }

  clientVisibilityTransition = {
    generation: clientVisibilityTransition.generation + 1,
    appearedEntityIds,
    disappearedEntityIds,
  };
  lastKnownContactsDirty = true;
  clientView = next;
  if (pruneSelectionsOutsideView()) updateSelectionHud();
}

function pruneSelectionsOutsideView(): boolean {
  let changed = false;
  selectedShipIds.forEach((id) => {
    if (clientView.ships.some((ship) => ship.id === id)) return;
    selectedShipIds.delete(id);
    changed = true;
  });
  selectedStructureIds.forEach((id) => {
    if (clientView.structures.some((structure) => structure.id === id)) return;
    selectedStructureIds.delete(id);
    changed = true;
  });
  if (primaryStructureId !== null && !selectedStructureIds.has(primaryStructureId)) {
    primaryStructureId = null;
    changed = true;
  }
  return changed;
}

function isAlliedToLocalPlayer(teamId: number): boolean {
  return clientView.localTeamId !== null && !isHostileToLocalPlayer(teamId);
}

function structureSensorRange(structure: StructureState): number {
  return STRUCTURES[structure.type].sensorRange;
}

const localSensorDiscBuffer: Array<{ x: number; z: number; range: number }> = [];
const collapsedFogSensorDiscBuffer: Array<{ x: number; z: number; range: number }> = [];
const fogSensorCells = new Map<string, { x: number; z: number; range: number }>();
const FOG_SENSOR_COLLAPSE_THRESHOLD = 256;
const FOG_SENSOR_CELL_SIZE = 320;

function collapseFogSensorDiscs(
  sensors: readonly { x: number; z: number; range: number }[],
): readonly { x: number; z: number; range: number }[] {
  if (sensors.length <= FOG_SENSOR_COLLAPSE_THRESHOLD) return sensors;
  fogSensorCells.clear();
  for (const sensor of sensors) {
    const cellX = Math.floor(sensor.x / FOG_SENSOR_CELL_SIZE);
    const cellZ = Math.floor(sensor.z / FOG_SENSOR_CELL_SIZE);
    const x = (cellX + 0.5) * FOG_SENSOR_CELL_SIZE;
    const z = (cellZ + 0.5) * FOG_SENSOR_CELL_SIZE;
    const range = sensor.range + Math.hypot(sensor.x - x, sensor.z - z);
    const key = `${cellX}:${cellZ}`;
    const existing = fogSensorCells.get(key);
    if (!existing || range > existing.range) fogSensorCells.set(key, { x, z, range });
  }
  collapsedFogSensorDiscBuffer.length = 0;
  for (const sensor of fogSensorCells.values()) collapsedFogSensorDiscBuffer.push(sensor);
  return collapsedFogSensorDiscBuffer;
}

function localSensorDiscs(alpha: number): readonly { x: number; z: number; range: number }[] {
  localSensorDiscBuffer.length = 0;
  for (const ship of clientView.ships) {
    if (!isAlliedToLocalPlayer(ship.teamId)) continue;
    const previous = previousTransforms.get(ship.id);
    localSensorDiscBuffer.push({
      x: THREE.MathUtils.lerp(previous?.x ?? ship.x, ship.x, alpha),
      z: THREE.MathUtils.lerp(previous?.z ?? ship.z, ship.z, alpha),
      range: SHIPS[ship.class].sensorRange,
    });
  }
  for (const structure of clientView.structures) {
    const range = structureSensorRange(structure);
    if (isAlliedToLocalPlayer(structure.teamId) && structure.buildProgress >= 1 && range > 0) {
      localSensorDiscBuffer.push({ x: structure.x, z: structure.z, range });
    }
  }
  return collapseFogSensorDiscs(localSensorDiscBuffer);
}

const FOG_TEXTURE_SIZE = 384;
const FOG_UPDATE_INTERVAL_MS = 160;
const FOG_UNEXPLORED_ALPHA = 0.995;
const FOG_EXPLORED_REVEAL = 0.7;
const FOG_VISIBLE_REVEAL = 0.995;
const fogExploredCanvas = document.createElement("canvas");
const fogVisibleCanvas = document.createElement("canvas");
const fogCompositeCanvas = document.createElement("canvas");
const fogResizeCanvas = document.createElement("canvas");
const fogNoiseCanvas = document.createElement("canvas");
for (const layer of [fogExploredCanvas, fogVisibleCanvas, fogCompositeCanvas, fogResizeCanvas]) {
  layer.width = FOG_TEXTURE_SIZE;
  layer.height = FOG_TEXTURE_SIZE;
}
fogNoiseCanvas.width = 64;
fogNoiseCanvas.height = 64;

function fogCanvasContext(layer: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = layer.getContext("2d");
  if (!context) throw new Error("Fog of war canvas rendering is unavailable");
  return context;
}
const fogExploredContext = fogCanvasContext(fogExploredCanvas);
const fogVisibleContext = fogCanvasContext(fogVisibleCanvas);
const fogCompositeContext = fogCanvasContext(fogCompositeCanvas);
const fogResizeContext = fogCanvasContext(fogResizeCanvas);
const fogNoiseContext = fogCanvasContext(fogNoiseCanvas);

const fogNoiseRandom = mulberry32(0xf06c0de);
fogNoiseContext.clearRect(0, 0, fogNoiseCanvas.width, fogNoiseCanvas.height);
for (let index = 0; index < 180; index += 1) {
  const value = 38 + Math.floor(fogNoiseRandom() * 46);
  fogNoiseContext.fillStyle = `rgba(${value * 0.45},${value * 0.8},${value},${0.1 + fogNoiseRandom() * 0.18})`;
  const size = fogNoiseRandom() > 0.86 ? 2 : 1;
  fogNoiseContext.fillRect(
    Math.floor(fogNoiseRandom() * fogNoiseCanvas.width),
    Math.floor(fogNoiseRandom() * fogNoiseCanvas.height),
    size,
    size,
  );
}
fogNoiseContext.strokeStyle = "rgba(71, 126, 151, .09)";
fogNoiseContext.lineWidth = 1;
for (let offset = -64; offset < 64; offset += 12) {
  fogNoiseContext.beginPath();
  fogNoiseContext.moveTo(offset, 64);
  fogNoiseContext.lineTo(offset + 64, 0);
  fogNoiseContext.stroke();
}
fogNoiseContext.strokeStyle = "rgba(50, 91, 112, .045)";
for (let offset = 0; offset < 128; offset += 24) {
  fogNoiseContext.beginPath();
  fogNoiseContext.moveTo(offset, 0);
  fogNoiseContext.lineTo(offset - 64, 64);
  fogNoiseContext.stroke();
}
const fogUnexploredNoisePattern = fogResizeContext.createPattern(fogNoiseCanvas, "repeat");

function createFogTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

const fogTexture = createFogTexture(fogCompositeCanvas);
const fogOfWarPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(2, 2),
  new THREE.MeshBasicMaterial({
    map: fogTexture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false,
    side: THREE.DoubleSide,
  }),
);
fogOfWarPlane.rotation.x = -Math.PI / 2;
fogOfWarPlane.position.y = 1.25;
fogOfWarPlane.renderOrder = 30;
fogOfWarPlane.frustumCulled = false;
fogOfWarPlane.visible = false;
scene.add(fogOfWarPlane);

const worldBoundaryPositions = new Float32Array([
  -1, 1.5, -1, 1, 1.5, -1,
  1, 1.5, -1, 1, 1.5, 1,
  1, 1.5, 1, -1, 1.5, 1,
  -1, 1.5, 1, -1, 1.5, -1,
  -0.992, 1.5, -0.992, 0.992, 1.5, -0.992,
  0.992, 1.5, -0.992, 0.992, 1.5, 0.992,
  0.992, 1.5, 0.992, -0.992, 1.5, 0.992,
  -0.992, 1.5, 0.992, -0.992, 1.5, -0.992,
]);
const worldBoundaryGeometry = new THREE.BufferGeometry();
worldBoundaryGeometry.setAttribute("position", new THREE.BufferAttribute(worldBoundaryPositions, 3));
const worldBoundaryLines = new THREE.LineSegments(
  worldBoundaryGeometry,
  new THREE.LineBasicMaterial({
    color: 0x66c5de,
    transparent: true,
    opacity: 0.68,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  }),
);
worldBoundaryLines.renderOrder = 36;
worldBoundaryLines.frustumCulled = false;
scene.add(worldBoundaryLines);
let worldBoundaryHalfExtent = 0;

function updateWorldBoundaryScale(halfExtent: number): void {
  if (Math.abs(worldBoundaryHalfExtent - halfExtent) <= 1) return;
  worldBoundaryHalfExtent = halfExtent;
  worldBoundaryLines.scale.set(halfExtent, 1, halfExtent);
}

const lastKnownContactGeometry = new THREE.RingGeometry(0.72, 1, 20);
lastKnownContactGeometry.rotateX(-Math.PI / 2);
const lastKnownContactMarkers = new THREE.InstancedMesh(
  lastKnownContactGeometry,
  new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.58,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  }),
  MAX_LAST_KNOWN_CONTACTS,
);
lastKnownContactMarkers.count = 0;
lastKnownContactMarkers.frustumCulled = false;
lastKnownContactMarkers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
lastKnownContactMarkers.setColorAt(0, new THREE.Color(0xffffff));
lastKnownContactMarkers.renderOrder = 34;
scene.add(lastKnownContactMarkers);
const lastKnownContactMatrix = new THREE.Matrix4();
const lastKnownContactPosition = new THREE.Vector3();
const lastKnownContactScale = new THREE.Vector3();
const lastKnownContactColor = new THREE.Color();
const lastKnownContactRotation = new THREE.Quaternion();
let lastKnownContactsUpdatedAt = -Infinity;

function updateLastKnownContactVisuals(visualTick: number, now: number, hidden: boolean): void {
  lastKnownContactMarkers.visible = !hidden && clientView.localTeamId !== null;
  if (!lastKnownContactMarkers.visible) return;
  if (!lastKnownContactsDirty && now - lastKnownContactsUpdatedAt < 80) return;
  lastKnownContactsUpdatedAt = now;
  lastKnownContactsDirty = false;
  let count = 0;
  for (const [entityId, contact] of lastKnownContacts) {
    if (clientView.visibleEntityIds.has(entityId) || visualTick >= contact.expiresAtTick) {
      lastKnownContacts.delete(entityId);
      continue;
    }
    if (count >= MAX_LAST_KNOWN_CONTACTS) break;
    const remaining = THREE.MathUtils.clamp(
      (contact.expiresAtTick - visualTick) / Math.max(1, contact.expiresAtTick - contact.lostAtTick),
      0,
      1,
    );
    const markerRadius = Math.max(7, contact.radius * 1.08);
    lastKnownContactPosition.set(contact.x, 1.62, contact.z);
    lastKnownContactScale.set(markerRadius, markerRadius, markerRadius);
    lastKnownContactMatrix.compose(lastKnownContactPosition, lastKnownContactRotation, lastKnownContactScale);
    lastKnownContactMarkers.setMatrixAt(count, lastKnownContactMatrix);
    lastKnownContactColor.setHex(contact.color).multiplyScalar(0.12 + remaining * 0.88);
    lastKnownContactMarkers.setColorAt(count, lastKnownContactColor);
    count += 1;
  }
  lastKnownContactMarkers.count = count;
  if (count > 0) {
    lastKnownContactMarkers.instanceMatrix.clearUpdateRanges();
    lastKnownContactMarkers.instanceMatrix.addUpdateRange(0, count * 16);
    lastKnownContactMarkers.instanceMatrix.needsUpdate = true;
    if (lastKnownContactMarkers.instanceColor) lastKnownContactMarkers.instanceColor.needsUpdate = true;
  }
}

let fogWorldHalfExtent = 0;
let fogTeamId: number | null = null;
let fogLastUpdatedAt = -Infinity;

function resetFogOfWar(): void {
  fogExploredContext.clearRect(0, 0, FOG_TEXTURE_SIZE, FOG_TEXTURE_SIZE);
  fogVisibleContext.clearRect(0, 0, FOG_TEXTURE_SIZE, FOG_TEXTURE_SIZE);
  fogCompositeContext.clearRect(0, 0, FOG_TEXTURE_SIZE, FOG_TEXTURE_SIZE);
  fogWorldHalfExtent = 0;
  fogTeamId = null;
  fogLastUpdatedAt = -Infinity;
  fogOfWarPlane.visible = false;
  fogTexture.needsUpdate = true;
}

function fogCoordinate(value: number, halfExtent: number): number {
  return (value + halfExtent) / (halfExtent * 2) * FOG_TEXTURE_SIZE;
}

function resizeExploredFog(previousHalfExtent: number, nextHalfExtent: number): void {
  fogResizeContext.clearRect(0, 0, FOG_TEXTURE_SIZE, FOG_TEXTURE_SIZE);
  fogResizeContext.drawImage(fogExploredCanvas, 0, 0);
  fogExploredContext.clearRect(0, 0, FOG_TEXTURE_SIZE, FOG_TEXTURE_SIZE);
  const preservedSize = FOG_TEXTURE_SIZE * previousHalfExtent / nextHalfExtent;
  const preservedOffset = (FOG_TEXTURE_SIZE - preservedSize) / 2;
  fogExploredContext.drawImage(
    fogResizeCanvas,
    0, 0, FOG_TEXTURE_SIZE, FOG_TEXTURE_SIZE,
    preservedOffset, preservedOffset, preservedSize, preservedSize,
  );
}

function paintSensorDisc(
  context: CanvasRenderingContext2D,
  sensor: { x: number; z: number; range: number },
  halfExtent: number,
  softEdge: boolean,
): void {
  const x = fogCoordinate(sensor.x, halfExtent);
  const y = fogCoordinate(sensor.z, halfExtent);
  const radius = sensor.range / (halfExtent * 2) * FOG_TEXTURE_SIZE;
  if (radius <= 0) return;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  if (softEdge) {
    const gradient = context.createRadialGradient(x, y, radius * 0.82, x, y, radius);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.9, "rgba(255,255,255,.98)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
  } else {
    context.fillStyle = "#fff";
  }
  context.fill();
}

function updateFogOfWar(now: number, alpha = 1, force = false): void {
  const teamId = clientView.localTeamId;
  if (teamId === null) {
    fogOfWarPlane.visible = false;
    fogTeamId = null;
    return;
  }
  fogOfWarPlane.visible = true;
  if (fogTeamId === teamId && !force && now - fogLastUpdatedAt < FOG_UPDATE_INTERVAL_MS) return;
  const halfExtent = minimapHalfExtent();
  updateWorldBoundaryScale(halfExtent);
  if (fogTeamId !== teamId) {
    resetFogOfWar();
    fogTeamId = teamId;
    fogWorldHalfExtent = halfExtent;
    fogOfWarPlane.scale.set(halfExtent, halfExtent, 1);
    force = true;
  } else if (Math.abs(fogWorldHalfExtent - halfExtent) > 1) {
    resizeExploredFog(fogWorldHalfExtent, halfExtent);
    fogWorldHalfExtent = halfExtent;
    fogOfWarPlane.scale.set(halfExtent, halfExtent, 1);
    force = true;
  }
  fogLastUpdatedAt = now;

  const sensors = localSensorDiscs(alpha);
  fogVisibleContext.clearRect(0, 0, FOG_TEXTURE_SIZE, FOG_TEXTURE_SIZE);
  for (const sensor of sensors) {
    paintSensorDisc(fogExploredContext, sensor, halfExtent, false);
    paintSensorDisc(fogVisibleContext, sensor, halfExtent, true);
  }

  fogCompositeContext.globalCompositeOperation = "source-over";
  fogCompositeContext.globalAlpha = 1;
  fogCompositeContext.filter = "none";
  fogCompositeContext.clearRect(0, 0, FOG_TEXTURE_SIZE, FOG_TEXTURE_SIZE);
  fogCompositeContext.fillStyle = `rgba(1, 4, 10, ${FOG_UNEXPLORED_ALPHA})`;
  fogCompositeContext.fillRect(0, 0, FOG_TEXTURE_SIZE, FOG_TEXTURE_SIZE);
  // Keep explored territory visibly dimmed while current sensor coverage cuts almost completely clear.
  fogCompositeContext.globalCompositeOperation = "destination-out";
  fogCompositeContext.globalAlpha = FOG_EXPLORED_REVEAL;
  fogCompositeContext.filter = "blur(2px)";
  fogCompositeContext.drawImage(fogExploredCanvas, 0, 0);

  // Restrict the scan-noise hatch to territory that has never been explored.
  // Reusing the resize canvas avoids another texture or GPU pass.
  fogResizeContext.globalCompositeOperation = "source-over";
  fogResizeContext.globalAlpha = 1;
  fogResizeContext.filter = "none";
  fogResizeContext.clearRect(0, 0, FOG_TEXTURE_SIZE, FOG_TEXTURE_SIZE);
  if (fogUnexploredNoisePattern) {
    fogResizeContext.fillStyle = fogUnexploredNoisePattern;
    fogResizeContext.fillRect(0, 0, FOG_TEXTURE_SIZE, FOG_TEXTURE_SIZE);
    fogResizeContext.globalCompositeOperation = "destination-out";
    fogResizeContext.drawImage(fogExploredCanvas, 0, 0);
    fogCompositeContext.globalCompositeOperation = "source-over";
    fogCompositeContext.globalAlpha = 0.95;
    fogCompositeContext.filter = "none";
    fogCompositeContext.drawImage(fogResizeCanvas, 0, 0);
  }

  fogCompositeContext.globalCompositeOperation = "destination-out";
  fogCompositeContext.globalAlpha = FOG_VISIBLE_REVEAL;
  fogCompositeContext.filter = "none";
  fogCompositeContext.drawImage(fogVisibleCanvas, 0, 0);

  fogCompositeContext.globalCompositeOperation = "source-over";
  fogCompositeContext.globalAlpha = 1;
  fogCompositeContext.filter = "none";
  fogTexture.needsUpdate = true;
}

function canBuildStructureInView(playerId: string, structureType: BuildableStructureType): boolean {
  const player = currentState().players.find((candidate) => candidate.id === playerId);
  if (!player || player.state === "defeated" || !factionAllowsStructure(player.faction, structureType)) return false;
  const completed = new Set(clientView.structures
    .filter((structure) => structure.ownerPlayerId === playerId && structure.buildProgress >= 1)
    .map((structure) => structure.type));
  return STRUCTURES[structureType].requiredStructures.every((required) => completed.has(required));
}

function canProduceShipInView(playerId: string, shipClass: ShipClass, structureId?: number): boolean {
  const player = currentState().players.find((candidate) => candidate.id === playerId);
  if (!player || player.state === "defeated" || !FACTIONS[player.faction].ships.includes(shipClass)) return false;
  const completed = new Set(clientView.structures
    .filter((structure) => structure.ownerPlayerId === playerId && structure.buildProgress >= 1)
    .map((structure) => structure.type));
  const definition = getFactionShipEconomy(shipClass, getPlayerFaction());
  if (!completed.has(definition.yardType)
    || !definition.requiredStructures.every((required) => completed.has(required))) return false;
  if (structureId === undefined) return true;
  return clientView.structures.some((structure) =>
    structure.id === structureId
      && structure.ownerPlayerId === playerId
      && structure.buildProgress >= 1
      && structure.type === definition.yardType
      && (player.faction !== "brood" || structure.broodClass === undefined),
  );
}

function assistingFabricatorIdsInView(structureId: number): number[] {
  const construction = clientView.structures.find((structure) => structure.id === structureId);
  if (!construction || construction.buildProgress >= 1) return [];
  const staticFabricators = clientView.structures.filter((structure) =>
    structure.ownerPlayerId === construction.ownerPlayerId
      && structure.type === "fabricator"
      && structure.buildProgress >= 1
      && Math.hypot(structure.x - construction.x, structure.z - construction.z) <= STRUCTURES.fabricator.assistRange,
  ).sort((a, b) => a.id - b.id).map((structure) => structure.id);
  const mobileFabricators = clientView.ships.filter((ship) =>
    ship.ownerPlayerId === construction.ownerPlayerId
      && SHIPS[ship.class].buildPower > 0
      && Math.hypot(ship.x - construction.x, ship.z - construction.z) <= SHIPS[ship.class].buildRange,
  ).sort((a, b) => a.id - b.id).map((ship) => ship.id);
  return [...staticFabricators, ...mobileFabricators].sort((a, b) => a - b);
}

function constructionBuildPowerInView(structureId: number): number {
  const structure = clientView.structures.find((candidate) => candidate.id === structureId);
  if (!structure || structure.buildProgress >= 1) return 0;
  return 1 + assistingFabricatorIdsInView(structureId).reduce((total, id) => {
    const staticFabricator = clientView.structures.find((candidate) => candidate.id === id);
    if (staticFabricator) return total + STRUCTURES[staticFabricator.type].buildPower;
    const mobileFabricator = clientView.ships.find((candidate) => candidate.id === id);
    return total + (mobileFabricator ? SHIPS[mobileFabricator.class].buildPower : 0);
  }, 0);
}

function sendNetworkMessage(message: ClientMessage): boolean {
  if (networkSocket?.readyState !== WebSocket.OPEN) return false;
  networkSocket.send(JSON.stringify(message));
  return true;
}

function generateLobbyCode(): string {
  const randomValue = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return String(randomValue % 10_000).padStart(4, "0");
}

function normalizeLobbyCode(value: string): string {
  return value.replace(/\D/g, "").slice(0, 4);
}

function lobbyInviteUrl(matchId = networkMatchId): string {
  const url = new URL(lanInviteOrigin);
  url.searchParams.set("match", matchId);
  return url.toString();
}

function refreshLobbyInvite(): void {
  if (!networkMatchId) return;
  element("lobby-invite-url").textContent = lobbyInviteUrl();
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // LAN HTTP origins may not expose the secure Clipboard API; use the selection fallback below.
    }
  }
  const field = document.createElement("textarea");
  field.value = value;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  document.execCommand("copy");
  field.remove();
}

function formatReplayTick(tick: number): string {
  const seconds = Math.floor(tick * FIXED_DT);
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function updateReplayReadout(tick = replayPlayer?.currentTick ?? 0): void {
  const scrub = element<HTMLInputElement>("replay-scrub");
  scrub.value = String(tick);
  element("replay-current").textContent = formatReplayTick(tick);
  element("replay-end").textContent = formatReplayTick(replayPlayer?.endTick ?? tick);
}

function setReplayPlaying(playing: boolean): void {
  replayPlaying = playing && replayPlayer !== null;
  const toggle = element<HTMLButtonElement>("replay-toggle");
  toggle.textContent = replayPlaying ? "Ⅱ" : "▶";
  toggle.setAttribute("aria-label", replayPlaying ? "Pause replay" : "Play replay");
  toggle.classList.toggle("active", replayPlaying);
}

function resetReplaySession(): void {
  replayManifest = null;
  replayChunks = [];
  replayPlayer = null;
  pendingReplayArchive = null;
  replayPlaying = false;
  replaySpeed = 1;
  accumulator = 0;
  element<HTMLButtonElement>("replay-toggle").textContent = "▶";
  element<HTMLButtonElement>("replay-speed").textContent = "1×";
  const scrub = element<HTMLInputElement>("replay-scrub");
  scrub.min = "0";
  scrub.max = "0";
  scrub.value = "0";
  updateReplayReadout(0);
}

function beginReplayDownload(manifest: ReplayManifest): void {
  if (clientViewMode !== "post-match-omniscient") return;
  if (manifest.byteLength <= 0 || manifest.byteLength > MAX_REPLAY_BYTES || manifest.chunkCount <= 0) {
    showNetworkError(`Replay archive size is invalid or exceeds the ${MAX_REPLAY_BYTES / (1024 * 1024)} MB client limit.`);
    return;
  }
  replayManifest = manifest;
  replayChunks = new Array<Uint8Array | undefined>(manifest.chunkCount);
  element("lobby-status").textContent = `DOWNLOADING REPLAY // 0 / ${manifest.chunkCount}`;
  sendNetworkMessage({ type: "request_replay_chunk", index: 0 });
}

function decodeReplayChunk(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function acceptReplayChunk(index: number, chunkCount: number, data: string): void {
  const manifest = replayManifest;
  if (!manifest || chunkCount !== manifest.chunkCount || index < 0 || index >= manifest.chunkCount) {
    showNetworkError("Replay archive chunks do not match the manifest.");
    return;
  }
  if (!replayChunks[index]) {
    try {
      const bytes = decodeReplayChunk(data);
      const expectedBytes = index === manifest.chunkCount - 1
        ? manifest.byteLength - manifest.chunkBytes * index
        : manifest.chunkBytes;
      if (bytes.byteLength !== expectedBytes) throw new Error("Replay chunk length mismatch");
      replayChunks[index] = bytes;
    } catch {
      showNetworkError(`Replay chunk ${index + 1} is invalid or has the wrong length.`);
      return;
    }
  }
  const received = replayChunks.filter(Boolean).length;
  element("lobby-status").textContent = `DOWNLOADING REPLAY // ${received} / ${manifest.chunkCount}`;
  const nextIndex = replayChunks.findIndex((chunk) => chunk === undefined);
  if (nextIndex >= 0) {
    sendNetworkMessage({ type: "request_replay_chunk", index: nextIndex });
    return;
  }
  assembleReplayArchive();
}

function assembleReplayArchive(): void {
  const manifest = replayManifest;
  if (!manifest) return;
  const byteLength = replayChunks.reduce((sum, chunk) => sum + (chunk?.byteLength ?? 0), 0);
  if (byteLength !== manifest.byteLength) {
    showNetworkError(`Replay archive is incomplete (${byteLength} / ${manifest.byteLength} bytes).`);
    return;
  }
  try {
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of replayChunks) {
      if (!chunk) throw new Error("Replay chunk missing");
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const validation = parseReplay(decoded);
    if (!validation.valid) throw new Error(validation.reason);
    const replay = validation.replay;
    if (!replay.finalized
      || replay.physicsBackend !== manifest.physicsBackend
      || replay.result.tick !== manifest.tick
      || replay.result.checksum !== manifest.checksum
      || replay.result.status !== manifest.status
      || replay.result.winnerTeamId !== manifest.winnerTeamId) {
      throw new Error("Replay result does not match the authority manifest");
    }
    replayManifest = null;
    replayChunks = [];
    if (replay.physicsBackend === "box3d-wasm" && !physicsWorld) {
      pendingReplayArchive = replay;
      element("lobby-status").textContent = "REPLAY READY // WAITING FOR BOX3D";
      showToast("REPLAY READY // BOX3D INITIALIZING");
      return;
    }
    installReplayArchive(replay);
  } catch (error: unknown) {
    showNetworkError(error instanceof Error ? `Replay rejected: ${error.message}` : "Replay archive could not be loaded.");
  }
}

function installReplayArchive(archive: ReplayArchive): void {
  if (archive.physicsBackend === "box3d-wasm" && !physicsWorld) {
    pendingReplayArchive = archive;
    return;
  }
  try {
    replayPlayer = new ReplayPlayer(
      archive,
      archive.physicsBackend === "box3d-wasm" ? physicsWorld ?? undefined : undefined,
    );
    simulation = replayPlayer.simulation;
    networkView = null;
    accumulator = 0;
    lastDebug = replayPlayer.lastDebug;
    installClientView(buildClientVisibilityView(), false);
    stressScenario.configure(0);
    element<HTMLSelectElement>("stress-count").value = "0";
    clearWorldVisuals();
    previousTransforms.clear();
    for (const ship of clientView.ships) previousTransforms.set(ship.id, captureTransform(ship));
    battleAudio.captureWorld(clientView.ships, clientView.structures);
    const scrub = element<HTMLInputElement>("replay-scrub");
    scrub.min = String(replayPlayer.startTick);
    scrub.max = String(replayPlayer.endTick);
    scrub.value = String(replayPlayer.startTick);
    setReplayPlaying(false);
    updateReplayReadout();
    eventLines = ["<b>REPLAY</b> deterministic archive verified // omniscient review"];
    element("network-overlay").classList.remove("visible");
    element("victory-overlay").classList.remove("visible", "defeat");
    element("directive").textContent = "REPLAY READY // PRESS PLAY OR SCRUB TIMELINE";
    setConnectionState(
      "MATCH REPLAY",
      `${networkMatchId} // ${archive.physicsBackend === "box3d-wasm" ? "BOX3D VERIFIED" : "FALLBACK VERIFIED"}`,
      "online",
    );
    showToast("DETERMINISTIC REPLAY READY");
  } catch (error: unknown) {
    showNetworkError(error instanceof Error ? `Replay rejected: ${error.message}` : "Replay could not initialize.");
  }
}

function syncReplaySimulation(clearVisuals = false): void {
  if (!replayPlayer) return;
  simulation = replayPlayer.simulation;
  installClientView(buildClientVisibilityView(), false);
  lastDebug = replayPlayer.lastDebug;
  if (clearVisuals) clearWorldVisuals();
  previousTransforms.clear();
  for (const ship of clientView.ships) previousTransforms.set(ship.id, captureTransform(ship));
  battleAudio.captureWorld(clientView.ships, clientView.structures);
  updateReplayReadout();
}

function stepReplay(): void {
  if (!replayPlayer) return;
  const before = clientView;
  rememberEffectOrigins(before);
  battleAudio.captureWorld(before.ships, before.structures);
  previousTransforms.clear();
  for (const ship of before.ships) previousTransforms.set(ship.id, captureTransform(ship));
  const result = replayPlayer.step();
  if (!result.ok) {
    setReplayPlaying(false);
    showNetworkError(`Replay verification failed at tick ${result.tick}: ${result.message}`);
    showToast("REPLAY VERIFICATION FAILED");
    return;
  }
  simulation = replayPlayer.simulation;
  installClientView(buildClientVisibilityView());
  lastDebug = result.debug;
  const visibleEvents = lastDebug.events.filter((event) => isEventVisible(event, before, clientView));
  battleAudio.ingestEvents(visibleEvents, clientView.ships, selectedShipIds);
  processEvents(visibleEvents);
  battleAudio.captureWorld(clientView.ships, clientView.structures);
  updateReplayReadout(result.tick);
  if (result.done) {
    setReplayPlaying(false);
    element("directive").textContent = replayPlayer.replay.result.winnerTeamId === null
      ? "REPLAY COMPLETE // NO VICTOR"
      : `REPLAY COMPLETE // TEAM ${replayPlayer.replay.result.winnerTeamId} VICTORIOUS`;
    showToast("REPLAY COMPLETE");
  }
}

function seekReplay(tick: number): void {
  if (!replayPlayer) return;
  setReplayPlaying(false);
  const result = replayPlayer.seek(Math.round(tick));
  if (!result.ok) {
    showNetworkError(`Replay seek failed at tick ${result.tick}: ${result.message}`);
    return;
  }
  accumulator = 0;
  syncReplaySimulation(true);
  element("directive").textContent = `REPLAY POSITION // TICK ${result.tick}`;
}

function connectToMatch(matchId: string, pilotName: string, role: RequestedNetworkRole = requestedNetworkRole): void {
  const normalizedMatchId = normalizeLobbyCode(matchId);
  const normalizedName = pilotName.trim().slice(0, 32);
  if (normalizedMatchId.length !== 4 || !normalizedName) {
    showNetworkError("Enter a pilot name and four-digit lobby code.");
    return;
  }
  stopLobbyBrowser();
  singleplayerSetupActive = false;
  stressTestMode = false;
  hideMenuPages();
  element("network-lobby-view").classList.remove("singleplayer-lobby");
  element("lobby-title").textContent = "MULTIPLAYER LOBBY";
  element("lobby-subtitle").textContent = "CUSTOM ENGAGEMENT";
  element("lobby-code-summary").classList.remove("hidden");
  element("lobby-slots").replaceChildren();
  element<HTMLButtonElement>("start-match").disabled = true;
  element<HTMLButtonElement>("ready-toggle").disabled = true;
  element("ready-toggle").classList.remove("hidden");
  window.clearTimeout(reconnectTimer);
  demoMode = false;
  menuBattleMode = false;
  if (role === "player") setClientViewMode("player");
  networkMatchId = normalizedMatchId;
  networkPilotName = normalizedName;
  requestedNetworkRole = role;
  localStorage.setItem("voidfront:pilot-name", normalizedName);
  networkMode = true;
  landingLobbyActive = false;
  element("network-overlay").classList.remove("start-screen-active");
  element("app").classList.remove("start-screen-active");
  manuallyClosed = false;
  showNetworkError("");
  setConnectionState("CONNECTING", `${normalizedMatchId} // LINKING`, "connecting");
  element("start-view").classList.add("hidden");
  element("network-join-view").classList.add("hidden");
  element("network-lobby-view").classList.remove("hidden");
  element("lobby-match-code").textContent = normalizedMatchId.toUpperCase();
  element("lobby-status").textContent = "CONTACTING AUTHORITY…";
  const pageUrl = new URL(location.href);
  pageUrl.searchParams.set("match", normalizedMatchId);
  history.replaceState(null, "", pageUrl);
  refreshLobbyInvite();

  const socket = new WebSocket(`${authorityUrl}/matches/${encodeURIComponent(normalizedMatchId)}/connect`);
  networkSocket = socket;
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const message = parseServerMessage(event.data);
    if (!message) {
      showNetworkError("Authority sent an unreadable message.");
      return;
    }
    handleServerMessage(message);
  });
  socket.addEventListener("close", () => {
    if (networkSocket !== socket) return;
    networkSocket = null;
    window.clearInterval(pingTimer);
    if (manuallyClosed || !networkMode) return;
    setConnectionState("RECONNECTING", `${networkMatchId} // LINK LOST`, "offline");
    showNetworkError("Connection interrupted. Rejoining automatically…");
    reconnectTimer = window.setTimeout(() => connectToMatch(networkMatchId, networkPilotName, requestedNetworkRole), 1_500);
  });
  socket.addEventListener("error", () => showNetworkError("Could not reach the multiplayer server. Check your connection and try again."));
}

function handleServerMessage(message: ServerMessage): void {
  switch (message.type) {
    case "hello_required": {
      if (message.lockstepVersion !== LOCKSTEP_PROTOCOL_VERSION) {
        showNetworkError("This page uses different game rules from the match authority. Reload both players before joining.");
        return;
      }
      if (requestedNetworkRole === "team") {
        const stored = readSpectatorCredentials(networkMatchId);
        const reconnecting = stored?.token === spectatorToken;
        sendNetworkMessage({
          type: "spectate",
          name: networkPilotName,
          mode: "team",
          lockstepVersion: LOCKSTEP_PROTOCOL_VERSION,
          token: spectatorToken,
          ...(reconnecting && stored.spectatorId ? { spectatorId: stored.spectatorId } : {}),
          ...(reconnecting && stored.reconnectToken ? { reconnectToken: stored.reconnectToken } : {}),
        });
        return;
      }
      if (requestedNetworkRole === "replay") {
        sendNetworkMessage({
          type: "spectate", name: networkPilotName, mode: "replay",
          lockstepVersion: LOCKSTEP_PROTOCOL_VERSION,
        });
        return;
      }
      const stored = readMatchCredentials(networkMatchId);
      sendNetworkMessage({
        type: "hello",
        name: networkPilotName,
        lockstepVersion: LOCKSTEP_PROTOCOL_VERSION,
        ...(stored?.playerId ? { playerId: stored.playerId } : {}),
        ...(stored?.reconnectToken ? { reconnectToken: stored.reconnectToken } : {}),
      });
      return;
    }
    case "welcome":
      localPlayerId = message.playerId;
      serverTick = message.tick;
      localStorage.setItem(`voidfront:match:${networkMatchId}`, JSON.stringify({
        playerId: message.playerId,
        reconnectToken: message.reconnectToken,
      }));
      updateNetworkLobby(message.lobby);
      setConnectionState("MULTIPLAYER", `${networkMatchId} // ${Math.round(networkLatency)}MS`, "online");
      window.clearInterval(pingTimer);
      pingTimer = window.setInterval(() => sendNetworkMessage({ type: "ping", clientTime: performance.now() }), 5_000);
      return;
    case "spectator_welcome":
      spectatorId = message.spectatorId;
      spectatorReconnectToken = message.reconnectToken ?? "";
      localPlayerId = `spectator:${message.spectatorId}`;
      serverTick = message.tick;
      if (message.mode === "team") {
        setClientViewMode("team-spectator", message.teamId);
        if (message.reconnectToken) {
          localStorage.setItem(`voidfront:spectator:${networkMatchId}`, JSON.stringify({
            spectatorId: message.spectatorId,
            reconnectToken: message.reconnectToken,
            token: spectatorToken,
          }));
        }
      } else {
        setClientViewMode("post-match-omniscient");
        networkView = null;
        if (!replayPlayer) sendNetworkMessage({ type: "request_replay_manifest" });
      }
      updateNetworkLobby(message.lobby);
      setConnectionState(
        message.mode === "team" ? "TEAM SPECTATOR" : "MATCH REPLAY",
        `${networkMatchId} // ${message.mode === "team" ? `TEAM ${message.teamId ?? "?"}` : "OMNISCIENT"}`,
        "online",
      );
      window.clearInterval(pingTimer);
      pingTimer = window.setInterval(() => sendNetworkMessage({ type: "ping", clientTime: performance.now() }), 5_000);
      return;
    case "spectator_authorized":
      element("spectator-grant-token").textContent = message.token;
      element("spectator-grant").classList.remove("hidden");
      showToast(`TEAM ${message.teamId} VIEW TOKEN CREATED`);
      return;
    case "lobby":
      updateNetworkLobby(message.lobby);
      return;
    case "lockstep_state":
      serverTick = Math.max(serverTick, message.tick);
      if (!physicsWorld) {
        pendingLockstepState = {
          state: message.state,
          notice: message.reason === "checksum" ? "LOCKSTEP RESYNCHRONIZED" : "LOCKSTEP SYNCHRONIZED",
          focusStartingBase: message.reason === "start",
        };
        pendingLockstepCommands = [];
        pendingLockstepPlayerStates = [];
        pendingLockstepTargetTick = message.tick;
        return;
      }
      installLockstepState(
        message.state,
        message.reason === "checksum" ? "LOCKSTEP RESYNCHRONIZED" : "LOCKSTEP SYNCHRONIZED",
        message.reason === "start",
      );
      if (message.reason === "start") {
        networkLobby = networkLobby ? { ...networkLobby, phase: "playing" } : null;
        element("network-overlay").classList.remove("visible");
      }
      return;
    case "lockstep_commands":
      if (pendingLockstepState) {
        pendingLockstepCommands.push(...message.commands);
        return;
      }
      if (!lockstepInputs.queueCommands(message.commands)) requestLockstepRecovery();
      sharedSimulationWorker?.postMessage({ type: "commands", commands: message.commands });
      return;
    case "lockstep_player_state": {
      serverTick = Math.max(serverTick, message.tick);
      if (pendingLockstepState) {
        pendingLockstepPlayerStates.push({
          tick: message.tick, playerId: message.playerId, state: message.state,
        });
        pendingLockstepTargetTick = Math.max(pendingLockstepTargetTick, message.tick);
        return;
      }
      if (networkView) return;
      if (!lockstepInputs.queuePlayerState(message)) requestLockstepRecovery();
      lockstepTargetTick = Math.max(lockstepTargetTick, message.tick);
      sharedSimulationWorker?.postMessage({
        type: "player_state", playerId: message.playerId, state: message.state, tick: message.tick,
      });
      return;
    }
    case "lockstep_frame":
      serverTick = Math.max(serverTick, message.tick);
      if (pendingLockstepState) {
        pendingLockstepTargetTick = Math.max(pendingLockstepTargetTick, message.tick);
        return;
      }
      if (networkView) return;
      if (message.tick >= lockstepTargetTick) {
        lockstepTargetTick = message.tick;
        lockstepTargetChecksum = message.checksum;
        sharedSimulationWorker?.postMessage({ type: "advance", targetTick: message.tick });
      }
      return;
    case "match_started":
      serverTick = message.tick;
      adoptAuthoritativeView(message.view, "MATCH SYNCHRONIZED");
      networkLobby = networkLobby ? { ...networkLobby, phase: "playing" } : null;
      element("network-overlay").classList.remove("visible");
      element("directive").textContent = canIssuePlayerCommands()
        ? "AUTHORITATIVE LINK // COMMAND YOUR FLEET"
        : "VIEW ONLY // TEAM SENSOR FEED";
      showToast(canIssuePlayerCommands() ? "MATCH LAUNCHED" : "TEAM SENSOR FEED ONLINE");
      return;
    case "view":
      adoptAuthoritativeView(message.view);
      return;
    case "command_results":
      serverTick = Math.max(serverTick, message.tick);
      for (const outcome of message.outcomes) {
        if (!outcome.result.accepted) pendingNetworkBuilds.delete(outcome.sequence);
        if (outcome.result.accepted) continue;
        showToast(`ORDER REJECTED // ${outcome.result.reason.toUpperCase()}`);
      }
      return;
    case "checksum": {
      serverTick = Math.max(serverTick, message.tick);
      if (networkView?.tick === message.tick && networkView.checksum !== message.checksum) {
        sendNetworkMessage({ type: "request_snapshot", reason: "checksum" });
      }
      return;
    }
    case "snapshot": {
      serverTick = Math.max(serverTick, message.tick);
      const sameView = networkView?.tick === message.tick && networkView.checksum === message.checksum;
      if (!sameView) adoptAuthoritativeView(message.view, message.reason === "checksum" ? "VIEW RESYNCHRONIZED" : undefined);
      return;
    }
    case "replay_manifest":
      beginReplayDownload(message.manifest);
      return;
    case "replay_chunk":
      acceptReplayChunk(message.index, message.chunkCount, message.data);
      return;
    case "pong":
      serverTick = Math.max(serverTick, message.tick);
      networkLatency = Math.max(0, performance.now() - message.clientTime);
      setConnectionState(
        clientViewMode === "team-spectator" ? "TEAM SPECTATOR"
          : clientViewMode === "post-match-omniscient" ? "MATCH REPLAY" : "MULTIPLAYER",
        `${networkMatchId} // ${Math.round(networkLatency)}MS`,
        "online",
      );
      return;
    case "error":
      showNetworkError(message.message);
      showToast(message.code.replaceAll("_", " ").toUpperCase());
      renderLobby();
      return;
  }
}

function focusCameraOnLocalBase(): boolean {
  const commandCore = clientView.structures.find(
    (structure) => structure.type === "commandCore" && structure.ownerPlayerId === localPlayerId,
  ) ?? clientView.structures.find(
    (structure) => structure.type === "commandCore" && !isHostileToLocalPlayer(structure.teamId),
  );
  if (!commandCore) return false;
  cameraRig.target.set(commandCore.x, 0, commandCore.z);
  cameraRig.distance = 560;
  return true;
}

function installLockstepState(state: SimulationState, notice?: string, focusStartingBase = false): void {
  simulation = restoreSimulation(state, replacePhysicsWorld());
  lockstepInputs = new LockstepInputs(simulation);
  initializeSharedSimulationTrial(state);
  const localPlayer = state.players.find((player) => player.id === localPlayerId);
  if (localPlayer) commandSequence = Math.max(commandSequence, localPlayer.lastCommandSequence);
  lockstepTargetTick = state.tick;
  lockstepTargetChecksum = state.checksum;
  lockstepResyncPending = false;
  lockstepChecksumGraceTick = state.tick + 20;
  lastLockstepSyncReportTick = state.tick;
  lockstepResultReported = state.status === "finished";
  networkView = null;
  accumulator = 0;
  networkInterpolationStartedAt = performance.now();
  lastDebug = simulation.debugSnapshot();
  installClientView(buildClientVisibilityView(), false);
  clearWorldVisuals();
  previousTransforms.clear();
  for (const ship of clientView.ships) previousTransforms.set(ship.id, captureTransform(ship));
  battleAudio.captureWorld(clientView.ships, clientView.structures);
  if (focusStartingBase) focusCameraOnLocalBase();
  element("network-overlay").classList.remove("visible");
  element("directive").textContent = canIssuePlayerCommands()
    ? "DETERMINISTIC LOCKSTEP // COMMAND YOUR FLEET"
    : "LOCKSTEP OBSERVER // LOCAL SIMULATION";
  if (notice) {
    showNetworkError("");
    eventLines = [`<b>NET</b> ${escapeHtml(notice.toLowerCase())}`];
    showToast(notice);
  }
  updateSelectionHud();
}

function verifyLockstepFrame(): void {
  // A zero checksum is a Spring-style relay frame pulse. Authoritative hashes
  // now come from sparse peer sync reports rather than a server-side simulation.
  if (lockstepTargetChecksum === 0) return;
  if (simulation.state.tick !== lockstepTargetTick || simulation.state.tick < lockstepChecksumGraceTick) return;
  if (simulation.state.checksum === lockstepTargetChecksum) return;
  requestLockstepRecovery();
}

function requestLockstepRecovery(): void {
  const now = performance.now();
  if (lockstepResyncPending || now < lockstepResyncCooldownUntil) return;
  lockstepResyncPending = true;
  lockstepResyncCooldownUntil = now + 5_000;
  sendNetworkMessage({ type: "request_snapshot", reason: "checksum" });
}

function adoptAuthoritativeView(view: ProjectedViewState, notice?: string): void {
  const firstView = networkView === null;
  const before = clientView;
  if (!firstView) {
    rememberEffectOrigins(before);
    battleAudio.captureWorld(before.ships, before.structures);
  }
  const previousProjectilePositions = new Map(firstView ? [] : clientView.projectiles.map((projectile) => [
    projectile.id, { x: projectile.x, z: projectile.z },
  ] as const));
  previousTransforms.clear();
  for (const ship of clientView.ships) previousTransforms.set(ship.id, captureTransform(ship));
  networkView = view;
  const receivedAt = performance.now();
  if (networkViewReceivedAt > 0) {
    const arrivalInterval = receivedAt - networkViewReceivedAt;
    networkViewInterpolationMs = THREE.MathUtils.clamp(
      networkViewInterpolationMs * 0.7 + arrivalInterval * 0.3,
      80,
      320,
    );
  }
  networkViewReceivedAt = receivedAt;
  serverTick = Math.max(serverTick, view.tick);
  installClientView(buildClientVisibilityView(), !firstView);
  for (const [sequence, command] of pendingNetworkBuilds) {
    const materialized = clientView.structures.some((structure) =>
      structure.ownerPlayerId === localPlayerId
        && structure.type === command.structureType
        && (command.resourceNodeId !== undefined
          ? structure.resourceNodeId === command.resourceNodeId
          : Math.hypot(structure.x - command.position.x, structure.z - command.position.z) < 1),
    );
    const resourceNodeClaimed = command.resourceNodeId !== undefined
      && clientView.resourceNodes.some((node) =>
        node.id === command.resourceNodeId && node.claimedByStructureId !== null,
      );
    if (materialized || resourceNodeClaimed || view.tick > command.requestedTick + 2_400) {
      pendingNetworkBuilds.delete(sequence);
    }
  }
  for (const projectile of clientView.projectiles) {
    const previous = previousProjectilePositions.get(projectile.id);
    if (previous) {
      projectile.previousX = previous.x;
      projectile.previousZ = previous.z;
    }
  }
  if (view.ownLastCommandSequence !== null) {
    commandSequence = Math.max(commandSequence, view.ownLastCommandSequence);
  }
  pruneSelectionsOutsideView();
  lastDebug = {
    tick: view.tick, checksum: view.checksum, activeTargetingTurrets: 0,
    shotsFired: 0, hits: 0, physicsBodyCount: 0, avoidance: [], events: [],
  };
  if (!firstView) {
    const inferredEvents = inferNetworkCombatEvents(before, clientView, view.tick);
    lastDebug.events = inferredEvents;
    lastDebug.shotsFired = inferredEvents.filter((event) => event.type === "weaponFired").length;
    lastDebug.hits = inferredEvents.filter((event) => event.type === "hit").length;
    battleAudio.ingestEvents(inferredEvents, clientView.ships, selectedShipIds);
    processEvents(inferredEvents);
  }
  if (firstView) {
    stressScenario.configure(0);
    element<HTMLSelectElement>("stress-count").value = "0";
    accumulator = 0;
    resetFogOfWar();
    clearWorldVisuals();
    previousTransforms.clear();
    for (const ship of clientView.ships) previousTransforms.set(ship.id, captureTransform(ship));
    const focusCore = clientView.structures.find(
      (structure) => structure.type === "commandCore" && structure.ownerPlayerId === localPlayerId,
    ) ?? clientView.structures.find(
      (structure) => structure.type === "commandCore" && !isHostileToLocalPlayer(structure.teamId),
    );
    if (focusCore) {
      cameraRig.target.set(focusCore.x, 0, focusCore.z);
      cameraRig.distance = 720;
    }
    element("victory-overlay").classList.remove("visible", "defeat");
  }
  battleAudio.captureWorld(clientView.ships, clientView.structures);
  if (notice) {
    eventLines = [`<b>NET</b> ${escapeHtml(notice.toLowerCase())}`];
    showToast(notice);
  }
  if (view.status === "finished" && view.winnerTeamId !== null) showVictory(view.winnerTeamId);
  updateSelectionHud();
}

function inferNetworkCombatEvents(
  before: ClientVisibilityView,
  after: ClientVisibilityView,
  tick: number,
): SimulationEvent[] {
  const events: SimulationEvent[] = [];
  const beforeShips = new Map(before.ships.map((ship) => [ship.id, ship]));
  const newProjectiles = after.projectiles.filter((projectile) => !before.visibleProjectileIds.has(projectile.id));
  const representedProjectiles = new Set<number>();
  const newProjectilesByShot = new Map<string, ProjectileState[]>();
  const newProjectileCursorByShot = new Map<string, number>();
  const beforeProjectileByTarget = new Map<number, ProjectileState>();
  const newProjectileByTarget = new Map<number, ProjectileState>();
  for (const projectile of before.projectiles) {
    if (projectile.targetEntityId !== null && !beforeProjectileByTarget.has(projectile.targetEntityId)) {
      beforeProjectileByTarget.set(projectile.targetEntityId, projectile);
    }
  }
  for (const projectile of newProjectiles) {
    if (projectile.targetEntityId === null || projectile.ownerShipId === null) continue;
    const key = `${projectile.ownerShipId}:${projectile.weaponTypeId}:${projectile.targetEntityId}`;
    const shots = newProjectilesByShot.get(key);
    if (shots) shots.push(projectile);
    else newProjectilesByShot.set(key, [projectile]);
    if (!newProjectileByTarget.has(projectile.targetEntityId)) {
      newProjectileByTarget.set(projectile.targetEntityId, projectile);
    }
  }

  for (const ship of after.ships) {
    const previousShip = beforeShips.get(ship.id);
    if (!previousShip) continue;
    const previousTurrets = new Map(previousShip.turrets.map((turret) => [turret.id, turret]));
    for (const turret of ship.turrets) {
      const previousTurret = previousTurrets.get(turret.id);
      if (!previousTurret || turret.fireSequence <= previousTurret.fireSequence || turret.targetEntityId === null) continue;
      const shotKey = `${ship.id}:${turret.weaponTypeId}:${turret.targetEntityId}`;
      const matchingProjectiles = newProjectilesByShot.get(shotKey);
      const projectileCursor = newProjectileCursorByShot.get(shotKey) ?? 0;
      const projectile = matchingProjectiles?.[projectileCursor];
      if (projectile) newProjectileCursorByShot.set(shotKey, projectileCursor + 1);
      events.push({
        type: "weaponFired",
        tick,
        turretId: turret.id,
        shipId: ship.id,
        targetId: turret.targetEntityId,
        projectileId: projectile?.id ?? -turret.id,
        weaponTypeId: turret.weaponTypeId,
      });
      if (projectile) representedProjectiles.add(projectile.id);
    }
  }
  for (const projectile of newProjectiles) {
    if (representedProjectiles.has(projectile.id)
      || projectile.ownerShipId === null || projectile.targetEntityId === null) continue;
    events.push({
      type: "weaponFired",
      tick,
      turretId: -projectile.ownerShipId,
      shipId: projectile.ownerShipId,
      targetId: projectile.targetEntityId,
      projectileId: projectile.id,
      weaponTypeId: projectile.weaponTypeId,
    });
  }

  const previousTargets = new Map<number, ShipState | StructureState>();
  const hitProjectileIds = new Set<number>();
  for (const ship of before.ships) previousTargets.set(ship.id, ship);
  for (const structure of before.structures) previousTargets.set(structure.id, structure);
  for (const target of [...after.ships, ...after.structures]) {
    const previous = previousTargets.get(target.id);
    if (!previous) continue;
    const damage = previous.health + previous.shields - target.health - target.shields;
    if (damage <= 0) continue;
    const projectile = beforeProjectileByTarget.get(target.id) ?? newProjectileByTarget.get(target.id);
    const projectileId = projectile?.id ?? -target.id;
    const shieldDamage = Math.max(0, previous.shields - target.shields);
    const hullDamage = Math.max(0, previous.health - target.health);
    events.push({
      type: "hit", tick, projectileId, targetId: target.id, damage,
      rawDamage: damage, shieldDamage, hullDamage,
    });
    if (projectile) {
      hitProjectileIds.add(projectile.id);
      const owner = projectile.ownerShipId === null ? undefined : beforeShips.get(projectile.ownerShipId);
      if (projectile.weaponTypeId === "torpedo" || owner?.class !== "fighter") {
        const speed = Math.max(0.001, Math.hypot(projectile.vx, projectile.vz));
        const targetRadius = "class" in target ? SHIPS[target.class].radius : STRUCTURES[target.type].radius;
        events.push({
          type: "projectileDetonated", tick, projectileId: projectile.id,
          weaponTypeId: projectile.weaponTypeId,
          x: target.x - projectile.vx / speed * (targetRadius + projectile.radius * 0.5),
          z: target.z - projectile.vz / speed * (targetRadius + projectile.radius * 0.5),
        });
      }
    }
  }
  const afterProjectileIds = new Set(after.projectiles.map((projectile) => projectile.id));
  const elapsedTicks = Math.max(1, after.state.tick - before.state.tick);
  for (const projectile of before.projectiles) {
    if (afterProjectileIds.has(projectile.id) || hitProjectileIds.has(projectile.id)) continue;
    const owner = projectile.ownerShipId === null ? undefined : beforeShips.get(projectile.ownerShipId);
    if (projectile.weaponTypeId !== "torpedo" && owner?.class === "fighter") continue;
    const targetStillVisible = projectile.targetEntityId !== null && after.visibleEntityIds.has(projectile.targetEntityId);
    if (!targetStillVisible && projectile.lifetimeTicks > elapsedTicks + 2) continue;
    events.push({
      type: "projectileDetonated", tick, projectileId: projectile.id,
      weaponTypeId: projectile.weaponTypeId, x: projectile.x, z: projectile.z,
    });
  }
  return events;
}

function clearWorldVisuals(): void {
  for (const visual of structureVisuals.values()) worldRoot.remove(visual.group);
  structureVisuals.clear();
  defensiveAimYaw.clear();
  for (const visual of resourceVisuals.values()) worldRoot.remove(visual.group);
  resourceVisuals.clear();
  for (const visual of obstacleVisuals.values()) worldRoot.remove(visual.group);
  obstacleVisuals.clear();
  renderStateBuilder.clearHistory();
  batchedShipRenderer.clearHistory();
  projectileVfx.clearHistory();
  projectileAppearances.clear();
  pendingFighterShots.clear();
  lastKnownContacts.clear();
  lastKnownContactsDirty = true;
  lastKnownContactMarkers.count = 0;
  effectOrigins.clear();
  lastDamageEffectAt.clear();
  battleAudio.reset();
}

function updateNetworkLobby(lobby: LobbyState): void {
  const needsTerminalSnapshot = lobby.phase === "finished"
    && (networkView ? networkView.status !== "finished" : simulation.state.status !== "finished");
  networkLobby = lobby;
  renderLobby();
  if (needsTerminalSnapshot) sendNetworkMessage({ type: "request_snapshot", reason: "manual" });
}

function renderLobby(): void {
  const lobby = setupLobby();
  if (!lobby) return;
  const singleplayer = singleplayerSetupActive;
  element("network-lobby-view").classList.toggle("singleplayer-lobby", singleplayer);
  element("lobby-title").textContent = singleplayer ? "SINGLEPLAYER" : "MULTIPLAYER LOBBY";
  element("lobby-subtitle").textContent = singleplayer ? "SET UP YOUR BATTLE" : "CUSTOM ENGAGEMENT";
  element("lobby-code-summary").classList.toggle("hidden", singleplayer);
  element("lobby-status-column").textContent = singleplayer ? "CONTROL" : "STATUS";
  element("open-player-invite").classList.toggle("hidden", singleplayer);
  element("open-spectator-invite").classList.toggle("hidden", singleplayer);
  element("leave-match").textContent = singleplayer ? "BACK TO MAIN MENU" : "LEAVE LOBBY";
  refreshLobbyInvite();
  const localSlot = lobby.slots.find((slot) => slot.playerId === setupPlayerId());
  const observing = !singleplayer && clientViewMode !== "player";
  const canEditMap = Boolean(localSlot?.isHost) && lobby.phase === "lobby";
  element("lobby-match-code").textContent = lobby.matchId.toUpperCase();
  element("lobby-status").textContent = lobby.phase === "lobby"
    ? `${lobby.slots.length} SLOTS // ${lobby.mode.toUpperCase()} // ${lobby.settings.mapSize.toUpperCase()}`
    : lobby.phase === "playing" ? "ENGAGEMENT IN PROGRESS" : "ENGAGEMENT COMPLETE";
  renderLobbyMapSidebar(lobby.settings, lobby.mode, canEditMap);
  const mapCapacity = MAP_PLAYER_CAPACITY[lobby.settings.mapSize];
  const occupiedSlots = lobby.slots.map((slot) => {
    const canAssignTeam = lobby!.mode === "teams" && lobby!.phase === "lobby"
      && (localSlot?.isHost || slot.playerId === setupPlayerId());
    const teamControl = lobby!.mode === "ffa"
      ? `<em>SIDE ${slot.slotIndex + 1}</em>`
      : `<select class="slot-team-select" data-team-player="${escapeHtml(slot.playerId)}" aria-label="Team for ${escapeHtml(slot.name)}" ${canAssignTeam ? "" : "disabled"}>${Array.from({ length: 8 }, (_, index) => `<option value="${index + 1}" ${slot.teamId === index + 1 ? "selected" : ""}>TEAM ${index + 1}</option>`).join("")}</select>`;
    const canEditAi = slot.isAi && localSlot?.isHost && lobby!.phase === "lobby";
    const canChooseFaction = lobby!.phase === "lobby" && (slot.playerId === setupPlayerId() || (slot.isAi && localSlot?.isHost));
    const factionControl = `<select class="slot-faction-select" data-faction-player="${escapeHtml(slot.playerId)}" aria-label="Faction for ${escapeHtml(slot.name)}" ${canChooseFaction ? "" : "disabled"}>${FACTION_IDS.map((id) => `<option value="${id}" ${slot.faction === id ? "selected" : ""}>${FACTIONS[id].name.toUpperCase()}</option>`).join("")}</select>`;
    const commanderDetail = slot.isAi
      ? "<small>COMPUTER CONTROL</small>"
      : `<small>${singleplayer ? "PLAYER CONTROL" : slot.connected ? "CONNECTED" : "RECONNECTING"}</small>`;
    const typeControl = slot.isAi
      ? canEditAi
        ? `<select class="slot-ai-select slot-type-select" data-ai-personality="${escapeHtml(slot.playerId)}" aria-label="Type for ${escapeHtml(slot.name)}"><option value="balanced" ${!slot.aiPersonality || slot.aiPersonality === "balanced" ? "selected" : ""}>BALANCED</option><option value="aggressive" ${slot.aiPersonality === "aggressive" ? "selected" : ""}>AGGRESSIVE</option><option value="turtle" ${slot.aiPersonality === "turtle" ? "selected" : ""}>TURTLE</option><option value="economic" ${slot.aiPersonality === "economic" ? "selected" : ""}>ECONOMIC</option></select>`
        : `<span class="slot-type">${(slot.aiPersonality ?? "balanced").toUpperCase()}</span>`
      : "<span class=\"slot-type\">HUMAN</span>";
    const difficultyControl = slot.isAi
      ? canEditAi
        ? `<select class="slot-ai-select slot-difficulty-select" data-ai-difficulty="${escapeHtml(slot.playerId)}" aria-label="Difficulty for ${escapeHtml(slot.name)}"><option value="easy" ${slot.aiDifficulty === "easy" ? "selected" : ""}>EASY</option><option value="normal" ${!slot.aiDifficulty || slot.aiDifficulty === "normal" ? "selected" : ""}>NORMAL</option><option value="hard" ${slot.aiDifficulty === "hard" ? "selected" : ""}>HARD</option></select>`
        : `<span class="slot-difficulty">${(slot.aiDifficulty ?? "normal").toUpperCase()}</span>`
      : "<em class=\"slot-difficulty\">—</em>";
    return `
      <div class="lobby-slot ${slot.playerId === setupPlayerId() ? "local" : ""}">
        <i style="--slot-color:#${slot.color.toString(16).padStart(6, "0")}"></i>
        <span class="slot-commander"><b title="${escapeHtml(slot.name)}">${escapeHtml(slot.name)}</b>${commanderDetail}</span>
        ${factionControl}
        ${typeControl}
        ${difficultyControl}
        ${teamControl}
        ${singleplayer ? `<strong>${slot.isAi ? "AI" : "YOU"}</strong>` : slot.isHost ? "<strong>HOST</strong>" : slot.ready ? "<strong>READY</strong>" : "<strong>NOT READY</strong>"}
        ${localSlot?.isHost && slot.playerId !== setupPlayerId() && lobby.phase === "lobby" ? `<button data-remove-slot="${escapeHtml(slot.playerId)}" aria-label="Remove ${escapeHtml(slot.name)}" title="Remove commander">×</button>` : "<span class=\"slot-pad\"></span>"}
      </div>`;
  });
  const emptySlots = Array.from({ length: Math.max(0, mapCapacity - lobby.slots.length) }, (_, index) => `
    <div class="lobby-slot empty"><i></i><span class="slot-commander"><b>OPEN SLOT</b><small>${singleplayer ? "ADD AN AI COMMANDER" : "AWAITING COMMANDER"}</small></span><em>—</em><em>—</em><em class="slot-difficulty">—</em><em>—</em><strong>OPEN</strong><span class="slot-pad"></span></div>
  `);
  element("lobby-slots").innerHTML = [...occupiedSlots, ...emptySlots].join("");
  const exceedsMapCapacity = lobby.slots.length > mapCapacity;
  const capacity = element("lobby-capacity");
  capacity.textContent = `${lobby.slots.length} / ${mapCapacity}`;
  capacity.classList.toggle("over-capacity", exceedsMapCapacity);
  element("settings-authority").textContent = canEditMap ? "HOST CONTROL" : "HOST LOCKED · VIEW ONLY";
  if (!mapSettingsOpen || !draftLobbySettings || !draftLobbyMode || !canEditMap) {
    draftLobbySettings = { ...lobby.settings };
    draftLobbyMode = lobby.mode;
    syncMapSettingsForm(draftLobbySettings, draftLobbyMode, canEditMap);
  } else {
    setMapSettingsEditingEnabled(canEditMap);
  }
  const canAddAi = Boolean(localSlot?.isHost) && lobby.phase === "lobby";
  element("lobby-ai-actions").classList.toggle("hidden", !canAddAi);
  element<HTMLButtonElement>("add-ai").disabled = !canAddAi
    || lobby.slots.length >= Math.min(lobby.maxPlayers, mapCapacity);
  element<HTMLButtonElement>("open-player-invite").disabled = !canAddAi;
  element<HTMLButtonElement>("open-spectator-invite").disabled = !canAddAi;
  element<HTMLButtonElement>("authorize-spectator").disabled = !localSlot?.isHost || lobby.phase === "finished";
  element<HTMLSelectElement>("spectator-team-select").disabled = !localSlot?.isHost || lobby.phase === "finished";
  const startMatch = element<HTMLButtonElement>("start-match");
  const launchIssue = lobbyLaunchIssue(lobby, singleplayer);
  startMatch.disabled = !localSlot?.isHost || launchIssue !== null;
  startMatch.textContent = singleplayer ? "START GAME" : "LAUNCH MATCH";
  element("lobby-launch-status").textContent = launchIssue ?? (singleplayer ? "Your battlefield is ready." : "All commanders ready. Launch when you are.");
  startMatch.classList.toggle("hidden", !localSlot?.isHost);
  document.querySelector(".lobby-final-actions")?.classList.toggle("hidden", observing);
  const ready = element<HTMLButtonElement>("ready-toggle");
  ready.classList.toggle("hidden", singleplayer);
  ready.textContent = localSlot?.ready ? "STAND DOWN" : "MARK READY";
  ready.classList.toggle("active", Boolean(localSlot?.ready));
  ready.disabled = !localSlot || lobby.phase !== "lobby";
}

function renderLobbyMapSidebar(settings: LobbySettings, mode: LobbyState["mode"], canEdit: boolean): void {
  const map = MAP_CATALOG[settings.mapPreset];
  const capacity = MAP_PLAYER_CAPACITY[settings.mapSize];
  element("lobby-map-name").textContent = map.label;
  element("lobby-map-summary").textContent = `${settings.mapSize.toUpperCase()} · ${settings.resourceDensity.toUpperCase()}`;
  element("lobby-map-description").textContent = map.description;
  element("lobby-map-size-summary").textContent = `${settings.mapSize.toUpperCase()} · 2–${capacity}`;
  element("lobby-density-summary").textContent = settings.resourceDensity.toUpperCase();
  element("lobby-deployment-summary").textContent = mode === "ffa"
    ? "INDIVIDUAL SIDES"
    : settings.teamSpawnMode === "together" ? "ALLIED SECTORS"
      : settings.teamSpawnMode === "interleaved" ? "INTERLEAVED" : "SEEDED RANDOM";
  element("lobby-map-preview").className = `map-preview map-${settings.mapPreset}`;
  renderMapPreview(settings, setupLobby()?.slots.length ?? 2, "lobby-map-preview-canvas");

  const startingResources = element<HTMLSelectElement>("starting-resources");
  startingResources.value = settings.startingResources;
  startingResources.disabled = !canEdit;
  const startingBase = element<HTMLSelectElement>("starting-base");
  startingBase.value = settings.startingBase;
  startingBase.disabled = !canEdit;
  element("mode-teams").classList.toggle("active", mode === "teams");
  element("mode-ffa").classList.toggle("active", mode === "ffa");
  element<HTMLButtonElement>("mode-teams").disabled = !canEdit;
  element<HTMLButtonElement>("mode-ffa").disabled = !canEdit;
}

function selectedLobbySettings(): LobbySettings {
  return {
    mapPreset: element<HTMLInputElement>("map-preset").value as LobbySettings["mapPreset"],
    mapSize: element<HTMLSelectElement>("map-size").value as LobbySettings["mapSize"],
    startingResources: element<HTMLSelectElement>("starting-resources").value as LobbySettings["startingResources"],
    startingBase: element<HTMLSelectElement>("starting-base").value as LobbySettings["startingBase"],
    resourceDensity: element<HTMLSelectElement>("resource-density").value as LobbySettings["resourceDensity"],
    teamSpawnMode: element<HTMLSelectElement>("team-spawn-mode").value as LobbySettings["teamSpawnMode"],
  };
}

function ensureMapPresetCatalog(): void {
  const grid = element("map-preset-grid");
  if (grid.childElementCount > 0) return;
  grid.innerHTML = MAP_PRESET_ORDER.map((mapPreset) => {
    const map = MAP_CATALOG[mapPreset];
    return `<button class="map-preset-card" type="button" data-map-preset="${mapPreset}"><b>${map.label}</b><small>${map.family}</small></button>`;
  }).join("");
}

function mapSettingsDescription(settings: LobbySettings, mode: LobbyState["mode"]): string {
  const mapCapacity = MAP_PLAYER_CAPACITY[settings.mapSize];
  const deploymentDescription = mode === "teams"
    ? ` Team deployment: ${settings.teamSpawnMode === "together" ? "allies share adjacent sectors" : settings.teamSpawnMode === "interleaved" ? "teams alternate around the perimeter" : "commanders receive seeded random sectors"}.`
    : "";
  const baseDescription = settings.startingBase === "command-core"
    ? "a lone Command Core"
    : settings.startingBase === "fortified"
      ? "a full base protected by two perimeter batteries"
      : "a full economy and shipyard base";
  return `${MAP_CATALOG[settings.mapPreset].description} ${settings.mapSize.toUpperCase()} sectors support up to ${mapCapacity} commanders; each begins with ${baseDescription}, ${settings.startingResources.toUpperCase()} reserves, and ${settings.resourceDensity.toUpperCase()} deposits.${deploymentDescription}`;
}

function setMapSettingsEditingEnabled(canEdit: boolean): void {
  for (const card of document.querySelectorAll<HTMLButtonElement>("[data-map-preset]")) card.disabled = !canEdit;
  for (const id of ["map-size", "resource-density", "team-spawn-mode"]) {
    element<HTMLSelectElement>(id).disabled = !canEdit;
  }
  element<HTMLButtonElement>("apply-map-settings").disabled = !canEdit;
  element("cancel-map-settings").textContent = canEdit ? "CANCEL" : "CLOSE";
}

function updateMapSettingsDraftView(): void {
  if (!draftLobbyMode) return;
  draftLobbySettings = selectedLobbySettings();
  const settings = draftLobbySettings;
  for (const card of document.querySelectorAll<HTMLButtonElement>("[data-map-preset]")) {
    card.classList.toggle("active", card.dataset.mapPreset === settings.mapPreset);
  }
  element("team-spawn-setting").classList.toggle("hidden", draftLobbyMode !== "teams");
  element("map-description").textContent = mapSettingsDescription(settings, draftLobbyMode);
  element("map-preview").className = `map-preview map-${settings.mapPreset}`;
  renderMapPreview(settings, setupLobby()?.slots.length ?? 2);
}

function syncMapSettingsForm(settings: LobbySettings, mode: LobbyState["mode"], canEdit: boolean): void {
  ensureMapPresetCatalog();
  element<HTMLInputElement>("map-preset").value = settings.mapPreset;
  element<HTMLSelectElement>("map-size").value = settings.mapSize;
  element<HTMLSelectElement>("starting-resources").value = settings.startingResources;
  element<HTMLSelectElement>("starting-base").value = settings.startingBase;
  element<HTMLSelectElement>("resource-density").value = settings.resourceDensity;
  element<HTMLSelectElement>("team-spawn-mode").value = settings.teamSpawnMode;
  draftLobbyMode = mode;
  setMapSettingsEditingEnabled(canEdit);
  updateMapSettingsDraftView();
}

function openMapSettings(): void {
  const lobby = setupLobby();
  if (!lobby) return;
  const localSlot = lobby.slots.find((slot) => slot.playerId === setupPlayerId());
  draftLobbySettings = { ...lobby.settings };
  draftLobbyMode = lobby.mode;
  mapSettingsOpen = true;
  syncMapSettingsForm(draftLobbySettings, draftLobbyMode, Boolean(localSlot?.isHost) && lobby.phase === "lobby");
  element("map-settings-modal").classList.remove("hidden");
  document.querySelector<HTMLButtonElement>(`[data-map-preset="${draftLobbySettings.mapPreset}"]`)?.focus();
}

function closeMapSettings(): void {
  mapSettingsOpen = false;
  draftLobbySettings = null;
  draftLobbyMode = null;
  element("map-settings-modal").classList.add("hidden");
}

type LobbyUtilityModalId = "player-invite-modal" | "spectator-invite-modal";

function closeLobbyUtilityModals(): void {
  element("player-invite-modal").classList.add("hidden");
  element("spectator-invite-modal").classList.add("hidden");
}

function openLobbyUtilityModal(modalId: LobbyUtilityModalId, focusId: string): void {
  if (!networkLobby) return;
  closeMapSettings();
  closeLobbyUtilityModals();
  element(modalId).classList.remove("hidden");
  element<HTMLElement>(focusId).focus();
}

function lobbySettingsEqual(left: LobbySettings, right: LobbySettings): boolean {
  return left.mapPreset === right.mapPreset
    && left.mapSize === right.mapSize
    && left.startingResources === right.startingResources
    && left.startingBase === right.startingBase
    && left.resourceDensity === right.resourceDensity
    && left.teamSpawnMode === right.teamSpawnMode;
}

function setConnectionState(title: string, detail: string, state: "online" | "connecting" | "offline"): void {
  element("connection-title").textContent = title;
  element("connection-detail").textContent = detail;
  const button = element("network-open");
  button.classList.toggle("online", state === "online");
  button.classList.toggle("connecting", state === "connecting");
  button.classList.toggle("offline", state === "offline");
}

function readMatchCredentials(matchId: string): { playerId: string; reconnectToken: string } | null {
  try {
    const raw = localStorage.getItem(`voidfront:match:${matchId}`);
    return raw ? JSON.parse(raw) as { playerId: string; reconnectToken: string } : null;
  } catch {
    return null;
  }
}

function readSpectatorCredentials(matchId: string): { spectatorId: string; reconnectToken: string; token?: string } | null {
  try {
    const raw = localStorage.getItem(`voidfront:spectator:${matchId}`);
    return raw ? JSON.parse(raw) as { spectatorId: string; reconnectToken: string; token?: string } : null;
  } catch {
    return null;
  }
}

function showNetworkError(message: string): void {
  element("network-error").textContent = message;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;",
  })[character]!);
}

function leaveNetworkMatch(destination: "menu" | "browser" = "menu"): void {
  manuallyClosed = true;
  networkMode = false;
  networkView = null;
  networkLobby = null;
  networkMatchId = "";
  pendingNetworkBuilds.clear();
  requestedNetworkRole = "player";
  spectatorTeamId = null;
  spectatorToken = "";
  spectatorId = "";
  spectatorReconnectToken = "";
  resetReplaySession();
  window.clearTimeout(reconnectTimer);
  window.clearInterval(pingTimer);
  networkSocket?.close(1000, "Left match");
  networkSocket = null;
  localPlayerId = "pilot-blue";
  const pageUrl = new URL(location.href);
  pageUrl.searchParams.delete("match");
  history.replaceState(null, "", pageUrl);
  setConnectionState("MULTIPLAYER", "LAN LOBBY", "online");
  closeMapSettings();
  closeLobbyUtilityModals();
  element("spectator-grant").classList.add("hidden");
  setClientViewMode("player");
  showStartScreen(true);
  if (destination === "browser") showMultiplayerJoinScreen();
}

function showStartScreen(resetBattle = false): void {
  stopLobbyBrowser();
  singleplayerSetupActive = false;
  stressTestMode = false;
  hideMenuPages();
  networkPanelOpenedFromGame = false;
  networkMode = false;
  networkView = null;
  networkLobby = null;
  pendingNetworkBuilds.clear();
  landingLobbyActive = true;
  element("network-overlay").classList.add("visible", "start-screen-active");
  element("app").classList.add("start-screen-active");
  element("start-view").classList.remove("hidden");
  element("network-join-view").classList.add("hidden");
  element("network-lobby-view").classList.add("hidden");
  closeMapSettings();
  closeLobbyUtilityModals();
  showNetworkError("");
  if (resetBattle || !demoMode) {
    resetReplaySession();
    requestedNetworkRole = "player";
    demoMode = true;
    menuBattleMode = true;
    localPlayerId = "menu-aster";
    setClientViewMode("player");
    if (paused) {
      paused = false;
      element("pause").classList.remove("active");
    }
    resetSimulation();
    lastTime = performance.now();
    accumulator = 0;
  }
  setConnectionState("LOCAL SIMULATION", "MENU SHOWCASE", "online");
}

function hideMenuPages(): void {
  for (const id of ["start-view", "network-join-view", "network-lobby-view", "stress-test-view", "settings-view"]) {
    element(id).classList.add("hidden");
  }
}

function showMenuPage(viewId: string): void {
  stopLobbyBrowser();
  hideMenuPages();
  closeMapSettings();
  closeLobbyUtilityModals();
  singleplayerSetupActive = false;
  element("network-overlay").classList.remove("start-screen-active");
  element("network-overlay").classList.add("visible");
  element("app").classList.toggle("start-screen-active", !networkPanelOpenedFromGame);
  element(viewId).classList.remove("hidden");
  showNetworkError("");
}

function showSingleplayerSetup(): void {
  showMenuPage("network-lobby-view");
  singleplayerSetupActive = true;
  renderLobby();
}

function showMultiplayerJoinScreen(openedFromGame = false): void {
  networkPanelOpenedFromGame = openedFromGame;
  showMenuPage("network-join-view");
  joinableGames = [];
  element("joinable-games").replaceChildren();
  element("game-count").textContent = "SEARCHING";
  element("game-browser-status").textContent = "Looking for open lobbies…";
  void refreshJoinableGames();
  lobbyBrowserTimer = window.setInterval(() => { void refreshJoinableGames(); }, 8_000);
}

function stopLobbyBrowser(): void {
  window.clearInterval(lobbyBrowserTimer);
  lobbyBrowserRequest?.abort();
  lobbyBrowserRequest = null;
}

async function refreshJoinableGames(): Promise<void> {
  if (lobbyBrowserRequest || element("network-join-view").classList.contains("hidden")) return;
  const controller = new AbortController();
  lobbyBrowserRequest = controller;
  const timeout = window.setTimeout(() => controller.abort(), 7_000);
  const refresh = element<HTMLButtonElement>("refresh-games");
  refresh.disabled = true;
  refresh.textContent = "SEARCHING…";
  try {
    const response = await fetch(`${authorityUrl.replace(/^ws/, "http")}/matches`, {
      cache: "no-store", signal: controller.signal,
    });
    if (!response.ok) throw new Error("Game browser unavailable");
    const data = await response.json() as { matches?: LobbyListEntry[] };
    if (!Array.isArray(data.matches)) throw new Error("Game browser unavailable");
    if (lobbyBrowserRequest !== controller) return;
    joinableGames = data.matches;
    renderJoinableGames();
  } catch {
    if (lobbyBrowserRequest !== controller) return;
    joinableGames = [];
    element("joinable-games").replaceChildren();
    element("game-count").textContent = "OFFLINE";
    element("game-browser-status").textContent = "Cannot reach the multiplayer server. Check your connection and try Refresh.";
  } finally {
    window.clearTimeout(timeout);
    if (lobbyBrowserRequest === controller) {
      lobbyBrowserRequest = null;
      refresh.disabled = false;
      refresh.textContent = "↻ REFRESH";
    }
  }
}

function renderJoinableGames(): void {
  const search = element<HTMLInputElement>("game-search").value.trim().toLowerCase();
  const games = joinableGames.filter((game) => `${game.hostName} ${game.matchId} ${game.mapPreset}`.toLowerCase().replaceAll("-", " ").includes(search.replaceAll("-", " ")));
  element("game-count").textContent = `${games.length} ${games.length === 1 ? "GAME" : "GAMES"}`;
  element("joinable-games").innerHTML = games.map((game) => `
    <div class="joinable-game">
      <span><b>${escapeHtml(game.hostName)}</b><small>LOBBY ${escapeHtml(game.matchId)}</small></span>
      <span>${escapeHtml(MAP_CATALOG[game.mapPreset]?.label ?? game.mapPreset)}<small>${escapeHtml(game.mapSize.toUpperCase())}</small></span>
      <span>${game.mode === "teams" ? "TEAMS" : "FREE-FOR-ALL"}</span>
      <span>${game.playerCount} / ${game.capacity}<small>${game.aiCount} AI</small></span>
      <button class="network-secondary" type="button" data-join-game="${escapeHtml(game.matchId)}" aria-label="Join ${escapeHtml(game.hostName)}">JOIN ↗</button>
    </div>`).join("");
  element("game-browser-status").textContent = games.length ? "" : joinableGames.length
    ? "No lobbies match your search. Try another host, map, or code."
    : "No open games yet. Host a game and invite other commanders to join you.";
}

function startLocalSkirmish(): void {
  const issue = lobbyLaunchIssue(singleplayerLobby, true);
  if (issue) { showNetworkError(issue); return; }
  singleplayerSetupActive = false;
  stopLobbyBrowser();
  pendingNetworkBuilds.clear();
  resetReplaySession();
  requestedNetworkRole = "player";
  demoMode = false;
  menuBattleMode = false;
  setClientViewMode("player");
  landingLobbyActive = false;
  networkPanelOpenedFromGame = false;
  element("network-overlay").classList.remove("start-screen-active");
  element("app").classList.remove("start-screen-active");
  element("network-overlay").classList.remove("visible");
  if (paused) {
    paused = false;
    element("pause").classList.remove("active");
  }
  resetSimulation();
  lastTime = performance.now();
  accumulator = 0;
  setConnectionState("MULTIPLAYER", "OPEN LOBBY", "online");
  showToast("LOCAL SKIRMISH STARTED");
}

function startStressTest(): void {
  stressTestMode = true;
  singleplayerSetupActive = false;
  resetReplaySession();
  demoMode = true;
  menuBattleMode = false;
  landingLobbyActive = false;
  networkPanelOpenedFromGame = false;
  element("network-overlay").classList.remove("start-screen-active", "visible");
  element("app").classList.remove("start-screen-active");
  setClientViewMode("player");
  resetSimulation();
  // The benchmark animates synthetic fleets independently of simulation ticks.
  paused = true;
  element("pause").classList.add("active");
  element<HTMLSelectElement>("stress-count").disabled = false;
  telemetryPanel.classList.remove("hidden");
  telemetryPanel.classList.add("telemetry-forced");
  element("debug-content").style.display = "block";
  element("collapse-debug").textContent = "−";
  setConnectionState("STRESS TEST", "VISUAL BENCHMARK", "online");
}

function createEnvironment(): void {
  const random = mulberry32(0x48a2c);
  const positions = new Float32Array(6000 * 3);
  const colors = new Float32Array(6000 * 3);
  for (let index = 0; index < 6000; index += 1) {
    const radius = 500 + random() * 7000;
    const angle = random() * Math.PI * 2;
    positions[index * 3] = Math.cos(angle) * radius;
    positions[index * 3 + 1] = (random() - 0.25) * 2400;
    positions[index * 3 + 2] = Math.sin(angle) * radius;
    const warmth = random();
    colors[index * 3] = 0.55 + warmth * 0.35;
    colors[index * 3 + 1] = 0.68 + warmth * 0.2;
    colors[index * 3 + 2] = 0.86 + (1 - warmth) * 0.14;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  scene.add(new THREE.Points(geometry, new THREE.PointsMaterial({
    size: 1.65, vertexColors: true, transparent: true, opacity: 0.78,
    sizeAttenuation: true, depthWrite: false,
  })));

  const grid = new THREE.GridHelper(12_000, 120, 0x133449, 0x0b202e);
  const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
  for (const material of gridMaterials) {
    material.transparent = true;
    material.opacity = 0.2;
    material.depthWrite = false;
  }
  scene.add(grid);

  const planet = new THREE.Mesh(
    new THREE.IcosahedronGeometry(145, 3),
    new THREE.MeshStandardMaterial({ color: 0x0b1822, roughness: 1, emissive: 0x06131d }),
  );
  planet.position.set(-650, -180, -520);
  scene.add(planet);
  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(153, 32, 16),
    new THREE.MeshBasicMaterial({ color: 0x3a97b9, transparent: true, opacity: 0.06, side: THREE.BackSide }),
  );
  planet.add(atmosphere);

}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function colorForTeam(teamId: number): number {
  return currentState().players.find((player) => player.teamId === teamId)?.color
    ?? [0x59a7ff, 0xff5576, 0x62e6a7, 0xf3b65b, 0xb886ff, 0x55e1e8, 0xff8b55, 0xd8e65b][(teamId - 1) % 8]
    ?? 0x9cb4c5;
}

function colorForPlayer(playerId: PlayerId, teamId: number): number {
  return currentState().players.find((player) => player.id === playerId)?.color ?? colorForTeam(teamId);
}

function createResourceVisual(node: ResourceNodeState): ResourceVisual {
  const group = new THREE.Group();
  const asteroid = new THREE.Mesh(
    new THREE.IcosahedronGeometry(9 + node.richness * 3, 1),
    new THREE.MeshStandardMaterial({ color: 0x4b4231, roughness: 0.92, metalness: 0.2, emissive: 0x251b08 }),
  );
  asteroid.scale.y = 0.72;
  asteroid.rotation.set(node.id * 0.37, node.id * 0.63, node.id * 0.19);
  asteroid.position.y = 2;
  group.add(asteroid);
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(15 + node.richness * 3, 17 + node.richness * 3, 30),
    new THREE.MeshBasicMaterial({ color: 0xf6bd5d, transparent: true, opacity: 0.58, side: THREE.DoubleSide, depthWrite: false }),
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.5;
  group.add(halo);
  group.position.set(node.x, 0, node.z);
  worldRoot.add(group);
  return { group, halo };
}

function createObstacleVisual(obstacle: ObstacleState): ObstacleVisual {
  const group = new THREE.Group();
  const seed = obstacle.visualSeed >>> 0;
  const tint = 0x151c22 + (seed % 3) * 0x010100;
  if (obstacle.type === "barrier" && obstacle.width && obstacle.depth) {
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(obstacle.width, 30, obstacle.depth),
      new THREE.MeshStandardMaterial({ color: tint, roughness: 1, metalness: 0.08, emissive: 0x020609 }),
    );
    slab.position.y = 12;
    group.add(slab);
    const colliderRing = new THREE.Mesh(
      new THREE.PlaneGeometry(obstacle.width, obstacle.depth),
      new THREE.MeshBasicMaterial({ color: 0x26343e, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
    );
    colliderRing.rotation.x = -Math.PI / 2;
    colliderRing.position.y = 27.1;
    group.add(colliderRing);
    group.position.set(obstacle.x, 0, obstacle.z);
    worldRoot.add(group);
    return { group, colliderRing };
  }
  const asteroid = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1, 1),
    new THREE.MeshStandardMaterial({
      color: tint,
      roughness: 1,
      metalness: 0.04,
      emissive: 0x020609,
      flatShading: true,
    }),
  );
  asteroid.scale.set(obstacle.radius, obstacle.radius * (0.46 + (seed % 11) / 100), obstacle.radius);
  asteroid.position.y = obstacle.radius * 0.22;
  asteroid.rotation.set(
    ((seed >>> 3) % 628) / 100,
    ((seed >>> 11) % 628) / 100,
    ((seed >>> 19) % 628) / 100,
  );
  group.add(asteroid);

  const colliderRing = new THREE.Mesh(
    new THREE.RingGeometry(obstacle.radius * 0.985, obstacle.radius, 48),
    new THREE.MeshBasicMaterial({
      color: 0x71818c,
      transparent: true,
      opacity: 0.07,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  colliderRing.rotation.x = -Math.PI / 2;
  colliderRing.position.y = 0.35;
  group.add(colliderRing);
  group.position.set(obstacle.x, 0, obstacle.z);
  worldRoot.add(group);
  return { group, colliderRing };
}

interface FactoryGeometryTemplates {
  gantry: THREE.BufferGeometry;
  assembly: THREE.BufferGeometry;
  workLights: THREE.BufferGeometry;
  bayGlow: THREE.PlaneGeometry;
  scanner: THREE.BoxGeometry;
}

let factoryGeometryTemplates: FactoryGeometryTemplates | null = null;

function factoryGeometryPart(
  geometry: THREE.BufferGeometry,
  position: readonly [number, number, number],
  rotation: readonly [number, number, number] = [0, 0, 0],
  scale: readonly [number, number, number] = [1, 1, 1],
): THREE.BufferGeometry {
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(...position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)),
    new THREE.Vector3(...scale),
  );
  geometry.applyMatrix4(matrix);
  return geometry;
}

function mergeFactoryGeometry(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error("Factory geometry could not be merged");
  return merged;
}

function getFactoryGeometryTemplates(): FactoryGeometryTemplates {
  if (factoryGeometryTemplates) return factoryGeometryTemplates;
  const gantry = mergeFactoryGeometry([
    factoryGeometryPart(new THREE.BoxGeometry(3, 17, 3), [-18, 15, 0]),
    factoryGeometryPart(new THREE.BoxGeometry(3, 17, 3), [18, 15, 0]),
    factoryGeometryPart(new THREE.BoxGeometry(39, 3, 3), [0, 23, 0]),
  ]);
  const assembly = mergeFactoryGeometry([
    factoryGeometryPart(new THREE.ConeGeometry(4, 18, 5), [0, 0, 3], [Math.PI / 2, 0, 0]),
    factoryGeometryPart(new THREE.BoxGeometry(24, 0.8, 7), [0, -0.4, 0]),
    factoryGeometryPart(new THREE.BoxGeometry(11, 1.1, 4), [0, 0.1, -7]),
  ]);
  const workLightParts: THREE.BufferGeometry[] = [];
  for (const x of [-20, 20]) {
    for (const z of [-20, 20]) {
      workLightParts.push(factoryGeometryPart(new THREE.SphereGeometry(0.85, 8, 5), [x, 17.5, z]));
    }
  }
  factoryGeometryTemplates = {
    gantry,
    assembly,
    workLights: mergeFactoryGeometry(workLightParts),
    bayGlow: new THREE.PlaneGeometry(30, 38),
    scanner: new THREE.BoxGeometry(31, 0.35, 0.9),
  };
  return factoryGeometryTemplates;
}

function createStructureVisual(structure: StructureState): StructureVisual {
  const faction = getPlayerFaction(structure.ownerPlayerId);
  const teamColor = structure.type === "creepNode" ? FACTIONS.brood.color : structure.type === "pylon" ? FACTIONS.concord.color
    : colorForPlayer(structure.ownerPlayerId, structure.teamId);
  const definition = STRUCTURES[structure.type];
  const group = new THREE.Group();
  const teamTint = new THREE.Color(faction === "industrial" ? teamColor : FACTIONS[faction].color).lerp(new THREE.Color(0xffffff), 0.58);
  const hull = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x6d8290).multiply(teamTint), emissive: 0x102936, emissiveIntensity: 0.62,
    metalness: 0.66, roughness: 0.44, flatShading: true, transparent: true,
  });
  const dark = new THREE.MeshStandardMaterial({
    color: 0x192d39, emissive: 0x091923, emissiveIntensity: 0.55,
    metalness: 0.56, roughness: 0.54, flatShading: true, transparent: true,
  });
  const accent = new THREE.MeshStandardMaterial({
    color: teamColor, emissive: teamColor, emissiveIntensity: 2.15, metalness: 0.2, roughness: 0.42, transparent: true,
  });
  const armor = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x4f6270).multiply(teamTint), emissive: 0x0b1d29, emissiveIntensity: 0.58,
    metalness: 0.74, roughness: 0.38, flatShading: true, transparent: true,
  });
  const light = new THREE.MeshBasicMaterial({
    color: new THREE.Color(teamColor).lerp(new THREE.Color(0xffffff), 0.72), transparent: true, toneMapped: false,
  });
  const turretMaterial = new THREE.MeshStandardMaterial({
    color: teamColor, emissive: 0x061017, emissiveIntensity: 0.5, metalness: 0.72, roughness: 0.34,
    flatShading: true, vertexColors: true, transparent: true,
  });
  // Index 2 must stay the accent material: the update loop pulses it on reveal.
  const materials: THREE.Material[] = [hull, dark, accent, armor, light, turretMaterial];
  let factory: FactoryAnimationVisual | null = null;

  if (faction !== "industrial") {
    const surfaces = FACTION_SURFACES[faction];
    hull.color.setHex(surfaces.hull);
    armor.color.setHex(surfaces.armor);
    hull.metalness = armor.metalness = faction === "brood" ? 0.06 : 0.28;
    hull.roughness = armor.roughness = faction === "brood" ? 0.79 : 0.62;
    dark.color.setHex(surfaces.dark);
    light.color.setHex(surfaces.glow);
    turretMaterial.color.copy(new THREE.Color(teamColor).lerp(new THREE.Color(0xffffff), 0.9));
  }
  const model = getStructureModel(structure.type, faction);
  group.add(
    new THREE.Mesh(model.body.hull, hull),
    new THREE.Mesh(model.body.armor, armor),
    new THREE.Mesh(model.body.dark, dark),
    new THREE.Mesh(model.body.accent, accent),
    new THREE.Mesh(model.body.light, light),
  );

  // Weapon mounts live in a container that cancels the base yaw because the
  // simulation places hardpoints on world axes relative to the structure.
  const mountRoot = new THREE.Group();
  mountRoot.rotation.y = -structure.yaw;
  mountRoot.add(
    new THREE.Mesh(model.mounts.armor, armor),
    new THREE.Mesh(model.mounts.accent, accent),
  );
  group.add(mountRoot);
  const mounts: StructureMountVisual[] = [];
  for (const hardpoint of definition.hardpoints ?? []) {
    const mount = new THREE.Group();
    mount.position.set(hardpoint.localX, model.turretHeight, hardpoint.localZ);
    mount.rotation.y = Math.atan2(hardpoint.localX, hardpoint.localZ);
    const turretMesh = new THREE.Mesh(getBatchedTurretGeometry(hardpoint.weaponTypeId, faction), turretMaterial);
    turretMesh.scale.copy(STRUCTURE_TURRET_SCALE);
    mount.add(turretMesh);
    mountRoot.add(mount);
    mounts.push({ group: mount, yaw: mount.rotation.y });
  }

  if (faction === "industrial" && SHIPYARD_TYPES.includes(structure.type as (typeof SHIPYARD_TYPES)[number])) {
    const yardScale = structure.type === "capitalShipyard" ? 1.72 : structure.type === "fleetShipyard" ? 1.28 : 1;
    const templates = getFactoryGeometryTemplates();
    const yard = new THREE.Group();
    yard.scale.setScalar(yardScale);

    const bayGlowMaterial = new THREE.MeshBasicMaterial({
      color: teamColor,
      transparent: true,
      opacity: 0.03,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const bayGlow = new THREE.Mesh(templates.bayGlow, bayGlowMaterial);
    bayGlow.rotation.x = -Math.PI / 2;
    bayGlow.position.y = 6.68;
    bayGlow.renderOrder = 3;
    yard.add(bayGlow);

    const gantryA = new THREE.Mesh(templates.gantry, dark);
    const gantryB = new THREE.Mesh(templates.gantry, dark);
    gantryA.position.z = -13;
    gantryB.position.z = 13;
    yard.add(gantryA, gantryB);

    const scannerMaterial = new THREE.MeshBasicMaterial({
      color: teamColor,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const scanner = new THREE.Mesh(templates.scanner, scannerMaterial);
    scanner.position.y = 9.1;
    scanner.visible = false;
    scanner.renderOrder = 4;
    yard.add(scanner);

    const assemblyMaterial = new THREE.MeshBasicMaterial({
      color: teamColor,
      transparent: true,
      opacity: 0,
      wireframe: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const assembly = new THREE.Mesh(templates.assembly, assemblyMaterial);
    assembly.position.y = 11;
    assembly.visible = false;
    assembly.renderOrder = 4;
    yard.add(assembly);

    const workLightMaterial = new THREE.MeshBasicMaterial({
      color: teamColor,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      toneMapped: false,
    });
    const workLights = new THREE.Mesh(templates.workLights, workLightMaterial);
    yard.add(workLights);
    group.add(yard);
    factory = {
      gantries: [gantryA, gantryB],
      scanner,
      scannerMaterial,
      assembly,
      assemblyMaterial,
      bayGlowMaterial,
      workLightMaterial,
    };
  }

  const shield = new THREE.Mesh(
    new THREE.SphereGeometry(definition.radius * 1.08, 18, 10),
    new THREE.MeshBasicMaterial({ color: teamColor, transparent: true, opacity: 0.045, wireframe: true, depthWrite: false }),
  );
  shield.scale.y = 0.45;
  shield.position.y = 7;
  group.add(shield);
  const marker = new THREE.Mesh(
    new THREE.RingGeometry(definition.radius * 1.14, definition.radius * 1.23, 40),
    new THREE.MeshBasicMaterial({ color: teamColor, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }),
  );
  marker.rotation.x = -Math.PI / 2;
  marker.position.y = 0.35;
  marker.visible = false;
  group.add(marker);
  const progress = new THREE.Mesh(
    new THREE.BoxGeometry(definition.radius * 2, 1.2, 2.2),
    new THREE.MeshBasicMaterial({ color: 0x62dcff, transparent: true, opacity: 0.9, depthWrite: false }),
  );
  progress.position.set(0, 1.5, definition.radius + 8);
  group.add(progress);
  const hitTarget = new THREE.Mesh(
    new THREE.SphereGeometry(definition.radius * 1.15, 8, 6),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
  );
  hitTarget.position.y = 7;
  hitTarget.userData.structureId = structure.id;
  group.add(hitTarget);
  group.position.set(structure.x, 0, structure.z);
  group.rotation.y = structure.yaw;
  worldRoot.add(group);
  return { group, shield, progress, marker, hitTarget, materials, factory, type: structure.type, mounts };
}

function createDynamicLines(color: number, opacity: number): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  const positions = new THREE.BufferAttribute(new Float32Array(32_768 * 3), 3);
  positions.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", positions);
  geometry.setDrawRange(0, 0);
  return new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
  );
}

function updateDynamicLines(lines: THREE.LineSegments, points: readonly THREE.Vector3[]): void {
  const positions = lines.geometry.getAttribute("position") as THREE.BufferAttribute;
  const count = Math.min(points.length, positions.count);
  for (let index = 0; index < count; index += 1) {
    const point = points[index]!;
    positions.setXYZ(index, point.x, point.y, point.z);
  }
  if (count > 0) {
    positions.clearUpdateRanges();
    positions.addUpdateRange(0, count * 3);
    positions.needsUpdate = true;
  }
  lines.geometry.setDrawRange(0, count);
}

function captureTransform(ship: ShipState): RenderTransform {
  return {
    x: ship.x, y: ship.y, z: ship.z, yaw: ship.yaw,
    turretYaw: new Map(ship.turrets.map((turret) => [turret.id, turret.currentYaw])),
  };
}

const PROJECTILE_LIMIT: Readonly<Record<RenderQuality, number>> = { low: 1_500, medium: 4_000, high: 8_192 };

function updateVisuals(alpha: number, now: number): void {
  const benchmarkActive = stressScenario.activeCount > 0;
  const strategicZoom = !benchmarkActive && cameraRig.distance >= STRATEGIC_ZOOM_DISTANCE;
  if (benchmarkActive) {
    stressScenario.update(now);
    emitStressEffects(now);
  }
  worldRoot.visible = !benchmarkActive;
  for (const iconBatch of tacticalStructureIcons.values()) iconBatch.visible = !benchmarkActive;
  tacticalResourceIcons.visible = !benchmarkActive;
  tacticalObstacleIcons.visible = !benchmarkActive;
  placementGhost.visible = !benchmarkActive && placementGhost.visible;
  worldBoundaryLines.visible = !benchmarkActive;
  if (benchmarkActive) fogOfWarPlane.visible = false;
  else updateFogOfWar(now, alpha);

  if (!benchmarkActive) updateStaticWorldVisuals(now);
  territoryRenderer.update(benchmarkActive ? [] : visibleTerritories());
  const source = benchmarkActive ? stressScenario : { players: clientView.state.players, ships: clientView.ships };
  const previous = benchmarkActive ? noPreviousTransforms : previousTransforms;
  const visualTick = benchmarkActive ? now * 0.02 : Math.max(0, clientView.state.tick - 1 + alpha);
  const renderState = renderStateBuilder.update(
    source, previous, alpha, camera, innerHeight, cameraRig.distance, selectedShipIds, renderQuality, now, strategicZoom,
    benchmarkActive ? undefined : clientVisibilityTransition, visualTick,
  );
  updateLastKnownContactVisuals(visualTick, now, benchmarkActive);
  batchedShipRenderer.update(
    renderState,
    now,
    camera,
    innerHeight,
    Math.pow(Math.max(1, cameraRig.distance / STRATEGIC_ZOOM_DISTANCE), 0.35),
    visualTick,
    !landingLobbyActive && !benchmarkActive,
  );
  const projectiles = benchmarkActive ? stressScenario.projectiles : clientView.projectiles;
  if (pendingFighterShots.size > 0) {
    for (const projectile of projectiles) {
      const shot = pendingFighterShots.get(projectile.id);
      if (!shot || !batchedShipRenderer.getFighterMuzzle(shot.shipId, shot.member, shot.sequence, fighterMuzzleScratch)) continue;
      const targetY = batchedShipRenderer.getVisualPosition(projectile.targetEntityId, fighterTargetScratch)
        ? fighterTargetScratch.y + 1 : 4.2;
      const elapsedTicks = Math.max(0, WEAPONS.autocannon.projectileLifetimeTicks - projectile.lifetimeTicks - 1);
      if (elapsedTicks <= 1 && isEffectVisible(fighterMuzzleScratch.x, fighterMuzzleScratch.y, fighterMuzzleScratch.z)) {
        combatEffects.spawnMuzzle(fighterMuzzleScratch.x, fighterMuzzleScratch.y, fighterMuzzleScratch.z,
          getWeaponStyle("autocannon", projectileFaction(projectile.id)).color, 0.42, now);
      }
      fighterMuzzleScratch.x -= shot.vx * elapsedTicks * FIXED_DT;
      fighterMuzzleScratch.z -= shot.vz * elapsedTicks * FIXED_DT;
      projectileVfx.registerFighterLaunch(projectile, fighterMuzzleScratch, targetY, alpha, elapsedTicks);
    }
    pendingFighterShots.clear();
  }
  const tacticalRatio = renderState.shipCount > 0 ? renderState.metrics.lod[3] / renderState.shipCount : 0;
  const projectileLimit = Math.max(500, Math.round(PROJECTILE_LIMIT[renderQuality] * (1 - tacticalRatio * 0.68)));
  if (!benchmarkActive) {
    // Use the same interpolated position and bank as the visible hull.
    for (let index = 0; index < renderState.shipCount; index++) {
      const target = clientView.targetsById.get(renderState.shipIds[index]!);
      if (!target) continue;
      target.x = renderState.shipPosition[index * 3]!;
      target.y = renderState.shipPosition[index * 3 + 1]!;
      target.z = renderState.shipPosition[index * 3 + 2]!;
      target.yaw = renderState.shipYaw[index]!;
      target.bank = renderState.shipBank[index]!;
      target.pitch = renderState.shipPitch[index]!;
    }
  }
  projectileVfx.update(
    projectiles,
    alpha,
    projectileLimit,
    benchmarkActive ? undefined : clientView.targetsById,
    benchmarkActive ? undefined : clientView.verticalLaunchOwnerIds,
    benchmarkActive ? undefined : projectileFaction,
  );
  combatEffects.update(now, camera);
  battleAudio.update(source.ships, camera, now, paused || landingLobbyActive);
  updateDebugVisuals(benchmarkActive);
  updateRallyVisuals(benchmarkActive);
}

function updateRallyVisuals(hidden: boolean): void {
  const shipyards = hidden ? [] : getSelectedShipyards();
  const destinations = shipyards.flatMap((yard) => [
    { yard, point: yard.rallyPoint, warp: false },
    ...(yard.warpPoint ? [{ yard, point: yard.warpPoint, warp: true }] : []),
  ]);
  while (rallyPointMeshes.length < destinations.length) {
    const marker = new THREE.Mesh(
      new THREE.RingGeometry(7, 9, 24),
      new THREE.MeshBasicMaterial({
        color: 0x69e6b0, transparent: true, opacity: 0.82,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    marker.rotation.x = -Math.PI / 2;
    scene.add(marker);
    rallyPointMeshes.push(marker);
  }
  const points: THREE.Vector3[] = [];
  for (let index = 0; index < rallyPointMeshes.length; index += 1) {
    const marker = rallyPointMeshes[index]!;
    const destination = destinations[index];
    marker.visible = destination !== undefined;
    if (!destination) continue;
    const shipyard = destination.yard;
    (marker.material as THREE.MeshBasicMaterial).color.setHex(destination.warp ? 0x74efdf : 0xe8ba75);
    marker.scale.setScalar(destination.warp ? 1.5 : 1);
    marker.position.set(destination.point.x, 2, destination.point.z);
    points.push(
      new THREE.Vector3(shipyard.x, 2, shipyard.z),
      new THREE.Vector3(destination.point.x, 2, destination.point.z),
    );
  }
  updateDynamicLines(rallyLines, points);
  rallyLines.visible = !hidden && shipyards.length > 0;
}

function emitStressEffects(now: number): void {
  if (stressScenario.ships.length === 0 || now - lastStressEffectAt < 90) return;
  lastStressEffectAt = now;
  const burstCount = renderQuality === "low" ? 6 : renderQuality === "medium" ? 14 : 24;
  for (let index = 0; index < burstCount; index += 1) {
    const ship = stressScenario.ships[(stressEffectCursor + index * 37) % stressScenario.ships.length]!;
    const color = stressScenario.players[ship.teamId - 1]?.color ?? 0xffffff;
    const radius = SHIPS[ship.class].radius;
    combatEffects.spawnMuzzle(ship.x, ship.y + radius * 0.35, ship.z, color, Math.max(1.4, radius * 0.16), now);
    if (index % 2 === 0) {
      combatEffects.spawnDamageImpact(
        ship.x, ship.y, ship.z, radius,
        stressEffectCursor + index, index % 4 === 0 ? 18 : 5, index % 4 !== 0, now, ship.class, ship.yaw, ship.faction,
      );
    }
    if (index % 5 === 0) {
      const target = stressScenario.ships[(stressEffectCursor + index * 37 + 97) % stressScenario.ships.length]!;
      combatEffects.spawnBeam(
        ship.x, ship.y + radius * 0.3, ship.z,
        target.x, target.y + SHIPS[target.class].radius * 0.25, target.z,
        WEAPONS.beam.color, Math.max(0.45, radius * 0.045), now,
      );
    }
  }
  stressEffectCursor = (stressEffectCursor + burstCount * 37) % stressScenario.ships.length;
  if (now - lastStressExplosionAt >= 620) {
    lastStressExplosionAt = now;
    const ship = stressScenario.ships[stressEffectCursor]!;
    combatEffects.spawnShipDeath(
      ship.x, ship.y, ship.z,
      stressScenario.players[ship.teamId - 1]?.color ?? 0xffffff,
      SHIPS[ship.class].radius, ship.vx, ship.vz, ship.id, now,
    );
  }
}

function updateFactoryAnimation(
  factory: FactoryAnimationVisual,
  structure: StructureState,
  now: number,
  reveal: number,
): void {
  const structureBuilding = structure.buildProgress < 1;
  const production = structureBuilding ? undefined : structure.broodClass && (structure.broodProgress ?? 0) > 0
    ? { shipClass: structure.broodClass, progress: structure.broodProgress ?? 0 } : structure.productionQueue[0];
  const working = structureBuilding || production !== undefined;
  const progress = production?.progress ?? structure.buildProgress;
  const phase = now * 0.001 + structure.id * 0.173;
  const pulse = 0.5 + Math.sin(phase * 5.2) * 0.5;

  factory.scanner.visible = working;
  if (working) {
    const scan = (now * 0.00034 + structure.id * 0.119) % 1;
    factory.scanner.position.z = -16 + scan * 32;
    factory.scannerMaterial.opacity = (0.24 + pulse * 0.42) * reveal;
  } else {
    factory.scannerMaterial.opacity = 0;
  }

  factory.assembly.visible = production !== undefined;
  if (production) {
    factory.assembly.scale.set(
      0.72 + progress * 0.28,
      0.68 + progress * 0.32,
      0.14 + progress * 0.86,
    );
    factory.assembly.position.y = 11 + Math.sin(phase * 2.1) * 0.22;
    factory.assembly.rotation.y = Math.sin(phase * 0.72) * 0.035;
    factory.assemblyMaterial.opacity = (0.18 + progress * 0.18 + pulse * 0.09) * reveal;
  } else {
    factory.assemblyMaterial.opacity = 0;
  }

  for (let index = 0; index < factory.gantries.length; index += 1) {
    factory.gantries[index]!.position.z = working
      ? Math.sin(phase * 0.72 + index * Math.PI) * 11
      : index === 0 ? -13 : 13;
  }
  factory.bayGlowMaterial.opacity = (working ? 0.07 + pulse * 0.1 : 0.025) * reveal;
  factory.workLightMaterial.opacity = (working ? 0.28 + pulse * 0.62 : 0.18) * reveal;
}

function updateStaticWorldVisuals(now: number): void {
  const tactical = cameraRig.distance >= STRATEGIC_ZOOM_DISTANCE;
  const liveObstacleIds = new Set(clientView.state.obstacles.map((obstacle) => obstacle.id));
  for (const [id, visual] of obstacleVisuals) {
    if (liveObstacleIds.has(id)) continue;
    worldRoot.remove(visual.group);
    obstacleVisuals.delete(id);
  }
  for (const obstacle of clientView.state.obstacles) {
    let visual = obstacleVisuals.get(obstacle.id);
    if (!visual) {
      visual = createObstacleVisual(obstacle);
      obstacleVisuals.set(obstacle.id, visual);
    }
    visual.group.position.set(obstacle.x, 0, obstacle.z);
    visual.group.visible = obstacle.type === "barrier" || !tactical;
    (visual.colliderRing.material as THREE.MeshBasicMaterial).opacity = 0.18 + Math.sin(now * 0.0008 + obstacle.visualSeed) * 0.04;
  }
  const liveResourceIds = new Set(clientView.resourceNodes.map((node) => node.id));
  for (const [id, visual] of resourceVisuals) {
    if (liveResourceIds.has(id)) continue;
    worldRoot.remove(visual.group);
    resourceVisuals.delete(id);
  }
  for (const node of clientView.resourceNodes) {
    let visual = resourceVisuals.get(node.id);
    if (!visual) {
      visual = createResourceVisual(node);
      resourceVisuals.set(node.id, visual);
    }
    visual.group.visible = !tactical;
    const knownClaim = node.claimedByStructureId !== null && clientView.visibleEntityIds.has(node.claimedByStructureId);
    (visual.halo.material as THREE.MeshBasicMaterial).opacity = knownClaim ? 0.16 : 0.58;
    visual.halo.rotation.z += 0.0015;
  }

  const liveStructureIds = new Set(clientView.structures.map((structure) => structure.id));
  for (const [id, visual] of structureVisuals) {
    if (liveStructureIds.has(id)) continue;
    worldRoot.remove(visual.group);
    structureVisuals.delete(id);
    defensiveAimYaw.delete(id);
    selectedStructureIds.delete(id);
    if (primaryStructureId === id) primaryStructureId = null;
  }
  for (const structure of clientView.structures) {
    let visual = structureVisuals.get(structure.id);
    if (visual && visual.type !== structure.type) {
      worldRoot.remove(visual.group);
      structureVisuals.delete(structure.id);
      visual = undefined;
    }
    if (!visual) {
      visual = createStructureVisual(structure);
      structureVisuals.set(structure.id, visual);
    }
    visual.group.visible = !tactical;
    const reveal = 0.24 + structure.buildProgress * 0.76;
    for (const material of visual.materials) material.opacity = reveal;
    const accentMaterial = visual.materials[2] as THREE.MeshStandardMaterial;
    accentMaterial.emissiveIntensity = (structure.revealedUntilTick ?? 0) >= clientView.state.tick ? 4.4 : 2.15;
    if (visual.factory) updateFactoryAnimation(visual.factory, structure, now, reveal);
    const aims = defensiveAimYaw.get(structure.id);
    if (aims) {
      for (let mountIndex = 0; mountIndex < visual.mounts.length; mountIndex += 1) {
        const desiredWorldYaw = aims.get(mountIndex);
        if (desiredWorldYaw === undefined) continue;
        const mount = visual.mounts[mountIndex]!;
        // Mounts sit in a container that cancels the base yaw, so the world
        // aim angle applies directly.
        const yawDelta = Math.atan2(Math.sin(desiredWorldYaw - mount.yaw), Math.cos(desiredWorldYaw - mount.yaw));
        mount.yaw += yawDelta * 0.18;
        mount.group.rotation.y = mount.yaw;
      }
    }
    visual.group.scale.y = 0.72 + structure.buildProgress * 0.28;
    visual.progress.visible = structure.buildProgress < 1;
    visual.progress.scale.x = Math.max(0.01, structure.buildProgress);
    visual.marker.visible = selectedStructureIds.has(structure.id);
    const maxShield = STRUCTURES[structure.type].maxShield;
    visual.shield.visible = selectedStructureIds.has(structure.id) && maxShield > 0;
    (visual.shield.material as THREE.MeshBasicMaterial).opacity = visual.shield.visible
      ? 0.015 + structure.shields / maxShield * 0.05
      : 0;
  }
  updateTacticalWorldMarkers(tactical);
}

function updateTacticalWorldMarkers(visible: boolean): void {
  if (!visible) {
    for (const iconBatch of tacticalStructureIcons.values()) iconBatch.count = 0;
    tacticalResourceIcons.count = 0;
    tacticalObstacleIcons.count = 0;
    return;
  }
  tacticalIconRotation.copy(camera.quaternion);
  const strategicScale = Math.max(1, cameraRig.distance / STRATEGIC_ZOOM_DISTANCE);
  const distantStructureScale = Math.pow(strategicScale, 0.35);
  let obstacleCount = 0;
  const obstacleLimit = Math.min(1_024, clientView.state.obstacles.length);
  const smallestObstacleRadius = clientView.state.obstacles.reduce(
    (smallest, obstacle) => Math.min(smallest, obstacle.radius),
    Number.POSITIVE_INFINITY,
  );
  const terrainFillThreshold = smallestObstacleRadius * 2.2;
  for (let index = 0; index < obstacleLimit; index += 1) {
    const obstacle = clientView.state.obstacles[index]!;
    if (obstacle.type === "barrier") continue;
    // Large overlapping obstacles seal otherwise empty terrain fields. They are
    // collision coverage, not useful tactical contacts, so only show the smaller
    // perimeter pieces that communicate the actual navigable boundary.
    if (obstacle.radius > terrainFillThreshold) continue;
    tacticalIconPosition.set(obstacle.x, 1, obstacle.z);
    tacticalIconScale.setScalar(obstacle.radius * strategicScale * 0.72);
    tacticalIconMatrix.compose(tacticalIconPosition, tacticalIconRotation, tacticalIconScale);
    tacticalObstacleIcons.setMatrixAt(obstacleCount, tacticalIconMatrix);
    tacticalObstacleIcons.setColorAt(obstacleCount, tacticalIconColor.setHex(0x52616a));
    obstacleCount += 1;
  }
  tacticalObstacleIcons.count = obstacleCount;
  tacticalObstacleIcons.instanceMatrix.needsUpdate = obstacleCount > 0;
  if (tacticalObstacleIcons.instanceColor) tacticalObstacleIcons.instanceColor.needsUpdate = obstacleCount > 0;
  const structureCounts = new Map<TacticalStructureIconKey, number>();
  for (const [key, iconBatch] of tacticalStructureIcons) {
    structureCounts.set(key, 0);
    iconBatch.count = 0;
  }
  const structureLimit = Math.min(1_024, clientView.structures.length);
  for (let index = 0; index < structureLimit; index += 1) {
    const structure = clientView.structures[index]!;
    const icon = structureTacticalIcon(structure.type);
    const iconKey: TacticalStructureIconKey = `${icon.family}-${icon.tier}`;
    const iconBatch = tacticalStructureIcons.get(iconKey)!;
    const structureCount = structureCounts.get(iconKey)!;
    const baseIconRadius = THREE.MathUtils.clamp(STRUCTURES[structure.type].radius * 0.58, 10, 23);
    const radius = baseIconRadius
      * (selectedStructureIds.has(structure.id) ? 1.18 : 1)
      * distantStructureScale;
    tacticalIconPosition.set(structure.x, 1.5, structure.z);
    tacticalIconScale.setScalar(radius);
    tacticalIconMatrix.compose(tacticalIconPosition, tacticalIconRotation, tacticalIconScale);
    iconBatch.setMatrixAt(structureCount, tacticalIconMatrix);
    iconBatch.setColorAt(
      structureCount,
      tacticalIconColor.setHex(colorForPlayer(structure.ownerPlayerId, structure.teamId)),
    );
    structureCounts.set(iconKey, structureCount + 1);
  }
  for (const [key, iconBatch] of tacticalStructureIcons) {
    const structureCount = structureCounts.get(key)!;
    iconBatch.count = structureCount;
    iconBatch.instanceMatrix.needsUpdate = structureCount > 0;
    if (iconBatch.instanceColor) iconBatch.instanceColor.needsUpdate = structureCount > 0;
  }
  let resourceCount = 0;
  const resourceLimit = Math.min(1_024, clientView.resourceNodes.length);
  for (let index = 0; index < resourceLimit; index += 1) {
    const node = clientView.resourceNodes[index]!;
    const knownClaim = node.claimedByStructureId !== null && clientView.visibleEntityIds.has(node.claimedByStructureId);
    if (knownClaim && strategicScale >= 1.8) continue;
    tacticalIconPosition.set(node.x, 1.2, node.z);
    tacticalIconScale.setScalar((13 + node.richness * 3) * Math.pow(strategicScale, 0.35));
    tacticalIconMatrix.compose(tacticalIconPosition, tacticalIconRotation, tacticalIconScale);
    tacticalResourceIcons.setMatrixAt(resourceCount, tacticalIconMatrix);
    tacticalResourceIcons.setColorAt(resourceCount, tacticalIconColor.setHex(knownClaim ? 0x76633d : 0xf2bd5c));
    resourceCount += 1;
  }
  tacticalResourceIcons.count = resourceCount;
  tacticalResourceIcons.instanceMatrix.needsUpdate = resourceCount > 0;
  if (tacticalResourceIcons.instanceColor) tacticalResourceIcons.instanceColor.needsUpdate = resourceCount > 0;
}

function updateDebugVisuals(benchmarkActive: boolean): void {
  if (benchmarkActive) {
    updateDynamicLines(velocityLines, []);
    updateDynamicLines(targetLines, []);
    updateDynamicLines(turretArcLines, []);
    updateDynamicLines(commandLines, []);
    updateDynamicLines(projectileLines, []);
    updateDynamicLines(colliderLines, []);
    updateDynamicLines(avoidanceLines, []);
    return;
  }
  const velocityPoints: THREE.Vector3[] = [];
  const targetPoints: THREE.Vector3[] = [];
  const orderPoints: THREE.Vector3[] = [];
  const arcPoints: THREE.Vector3[] = [];
  const pathPoints: THREE.Vector3[] = [];
  const colliderPoints: THREE.Vector3[] = [];
  const avoidancePoints: THREE.Vector3[] = [];
  const showVelocity = element<HTMLInputElement>("show-velocity").checked;
  const showTargets = element<HTMLInputElement>("show-targets").checked;
  const showArcs = element<HTMLInputElement>("show-arcs").checked;
  const showPaths = element<HTMLInputElement>("show-paths").checked;
  const showColliders = element<HTMLInputElement>("show-colliders").checked;
  const showAvoidance = element<HTMLInputElement>("show-avoidance").checked;
  if (showColliders) {
    for (const obstacle of clientView.state.obstacles) {
      appendDebugCircle(colliderPoints, obstacle.x, obstacle.z, obstacle.radius, 0.8, 32);
    }
    for (const structure of clientView.structures) {
      appendDebugCircle(colliderPoints, structure.x, structure.z, STRUCTURES[structure.type].radius, 1, 24);
    }
    for (const ship of clientView.ships) {
      appendDebugCircle(colliderPoints, ship.x, ship.z, SHIPS[ship.class].radius, ship.y + 0.8, 16);
    }
  }
  if (showAvoidance) {
    for (const avoidance of lastDebug.avoidance.filter((item) => clientView.visibleEntityIds.has(item.shipId))) {
      avoidancePoints.push(
        new THREE.Vector3(avoidance.x, 4, avoidance.z),
        new THREE.Vector3(avoidance.x + avoidance.vectorX * 42, 4, avoidance.z + avoidance.vectorZ * 42),
      );
    }
  }
  const byId = new Map<number, ShipState | StructureState>();
  if (showTargets) {
    for (const ship of clientView.ships) byId.set(ship.id, ship);
    for (const structure of clientView.structures) byId.set(structure.id, structure);
  }
  for (const ship of clientView.ships) {
    if (selectedShipIds.has(ship.id)) {
      let fromX = ship.x;
      let fromZ = ship.z;
      for (const order of ship.orders) {
        orderPoints.push(new THREE.Vector3(fromX, ship.y + 1, fromZ), new THREE.Vector3(order.destination.x, ship.y + 1, order.destination.z));
        fromX = order.destination.x;
        fromZ = order.destination.z;
      }
      if (showArcs) {
        for (const turret of ship.turrets) {
          const range = WEAPONS[turret.weaponTypeId].range * 0.32;
          let previousX = ship.x;
          let previousZ = ship.z;
          for (let segment = 0; segment <= 12; segment += 1) {
            const angle = ship.yaw + turret.yawCenter - turret.yawHalfArc + turret.yawHalfArc * 2 * segment / 12;
            const nextX = ship.x + Math.sin(angle) * range;
            const nextZ = ship.z + Math.cos(angle) * range;
            if (segment > 0) arcPoints.push(new THREE.Vector3(previousX, ship.y - 2, previousZ), new THREE.Vector3(nextX, ship.y - 2, nextZ));
            previousX = nextX; previousZ = nextZ;
          }
        }
      }
    }
    if (showTargets) {
      for (const turret of ship.turrets) {
        if (turret.targetEntityId === null) continue;
        const target = byId.get(turret.targetEntityId);
        if (!target) continue;
        const origin = getTurretWorldPosition(ship, turret);
        targetPoints.push(new THREE.Vector3(origin.x, ship.y + 8, origin.z), new THREE.Vector3(target.x, "class" in target ? target.y + 3 : 10, target.z));
      }
    }
    if (showVelocity) velocityPoints.push(new THREE.Vector3(ship.x, ship.y + 2, ship.z), new THREE.Vector3(ship.x + ship.vx * 2.2, ship.y + 2, ship.z + ship.vz * 2.2));
  }
  if (showPaths) {
    const projectileCount = Math.min(2_000, clientView.projectiles.length);
    for (let index = 0; index < projectileCount; index += 1) {
      const projectile = clientView.projectiles[index]!;
      const y = projectile.weaponTypeId === "heavyRail" ? 10 : projectile.weaponTypeId === "torpedo" ? 8 : 6;
      pathPoints.push(new THREE.Vector3(projectile.previousX, y, projectile.previousZ), new THREE.Vector3(projectile.x, y, projectile.z));
    }
  }
  updateDynamicLines(velocityLines, velocityPoints);
  velocityLines.visible = showVelocity;
  updateDynamicLines(targetLines, targetPoints);
  targetLines.visible = showTargets;
  updateDynamicLines(turretArcLines, arcPoints);
  turretArcLines.visible = showArcs;
  updateDynamicLines(commandLines, orderPoints);
  updateDynamicLines(projectileLines, pathPoints);
  projectileLines.visible = showPaths;
  updateDynamicLines(colliderLines, colliderPoints);
  colliderLines.visible = showColliders;
  updateDynamicLines(avoidanceLines, avoidancePoints);
  avoidanceLines.visible = showAvoidance;
}

function appendDebugCircle(
  points: THREE.Vector3[], x: number, z: number, radius: number, y: number, segments: number,
): void {
  for (let segment = 0; segment < segments; segment += 1) {
    const from = segment / segments * Math.PI * 2;
    const to = (segment + 1) / segments * Math.PI * 2;
    points.push(
      new THREE.Vector3(x + Math.cos(from) * radius, y, z + Math.sin(from) * radius),
      new THREE.Vector3(x + Math.cos(to) * radius, y, z + Math.sin(to) * radius),
    );
  }
}

function updateCamera(delta: number): void {
  if (element("app").classList.contains("start-screen-active")) {
    cameraRig.target.set(0, 0, 0);
    cameraRig.distance = 720;
    cameraRig.azimuth = 0.18;
    const horizontal = cameraRig.distance * 0.68;
    camera.position.set(
      Math.sin(cameraRig.azimuth) * horizontal,
      cameraRig.distance * 0.72,
      Math.cos(cameraRig.azimuth) * horizontal,
    );
    camera.lookAt(cameraRig.target);
    return;
  }
  const edge = 24;
  cameraForward.set(Math.sin(cameraRig.azimuth), 0, Math.cos(cameraRig.azimuth));
  cameraRight.set(cameraForward.z, 0, -cameraForward.x);
  cameraDirection.set(0, 0, 0);
  if (keys.has("ArrowUp") || pointerY < edge) cameraDirection.addScaledVector(cameraForward, -1);
  if (keys.has("ArrowDown") || pointerY > innerHeight - edge) cameraDirection.add(cameraForward);
  if (keys.has("ArrowLeft") || pointerX < edge) cameraDirection.addScaledVector(cameraRight, -1);
  if (keys.has("ArrowRight") || pointerX > innerWidth - edge) cameraDirection.add(cameraRight);
  const panLimit = minimapHalfExtent();
  if (cameraDirection.lengthSq() > 0) {
    const fastPan = keys.has("ShiftLeft") || keys.has("ShiftRight") ? 2.25 : 1;
    const panSpeed = Math.max(cameraRig.distance * 0.78, panLimit * 0.2) * fastPan;
    cameraRig.target.add(cameraDirection.normalize().multiplyScalar(delta * panSpeed));
  }
  clampCameraTarget(panLimit);
  const horizontal = cameraRig.distance * 0.68;
  camera.position.set(
    cameraRig.target.x + Math.sin(cameraRig.azimuth) * horizontal,
    cameraRig.distance * 0.72,
    cameraRig.target.z + Math.cos(cameraRig.azimuth) * horizontal,
  );
  camera.lookAt(cameraRig.target);
}

function clampCameraTarget(panLimit = minimapHalfExtent()): void {
  cameraRig.target.x = THREE.MathUtils.clamp(cameraRig.target.x, -panLimit, panLimit);
  cameraRig.target.z = THREE.MathUtils.clamp(cameraRig.target.z, -panLimit, panLimit);
}

function tickSimulation(): void {
  if (demoMode && simulation.state.status === "finished") {
    resetSimulation();
    return;
  }
  if (demoMode && !menuBattleMode) {
    const productionEnabled = simulation.state.ships.length < 420;
    for (const player of simulation.state.players) {
      player.economy.alloy = productionEnabled ? player.economy.alloyStorage : 0;
      player.economy.energy = productionEnabled ? player.economy.energyStorage : 0;
    }
  }
  const startedAt = performance.now();
  const before = clientView;
  rememberEffectOrigins(before);
  battleAudio.captureWorld(before.ships, before.structures);
  previousTransforms.clear();
  for (const ship of before.ships) previousTransforms.set(ship.id, captureTransform(ship));
  lastDebug = networkMode && !networkView ? lockstepInputs.step()
    : menuBattleMode ? simulation.stepMenuBattle() : simulation.step();
  if (networkMode && !networkView && simulation.state.tick > 0
    && simulation.state.tick % 20 === 0 && simulation.state.tick !== lastLockstepSyncReportTick) {
    lastLockstepSyncReportTick = simulation.state.tick;
    sendNetworkMessage({ type: "checksum", tick: simulation.state.tick, checksum: simulation.state.checksum });
  }
  if (networkMode && simulation.state.status === "finished" && !lockstepResultReported) {
    lockstepResultReported = true;
    sendNetworkMessage({
      type: "match_finished",
      tick: simulation.state.tick,
      checksum: simulation.state.checksum,
      winnerTeamId: simulation.state.winnerTeamId,
    });
  }
  installClientView(buildClientVisibilityView());
  const visibleEvents = lastDebug.events.filter((event) => isEventVisible(event, before, clientView));
  if (!landingLobbyActive) {
    battleAudio.ingestEvents(visibleEvents, clientView.ships, selectedShipIds);
  }
  processEvents(visibleEvents);
  simulationCpuMs = performance.now() - startedAt;
}

function rememberEffectOrigins(view: ClientVisibilityView): void {
  const visibleIds = new Set<number>();
  for (const ship of view.ships) {
    visibleIds.add(ship.id);
    const origin: EffectOrigin = effectOrigins.get(ship.id) ?? {
      x: 0, y: 0, z: 0, radius: 0, color: 0, isShip: true, vx: 0, vz: 0, shields: 0, yaw: 0,
    };
    origin.x = ship.x; origin.y = ship.y + 3; origin.z = ship.z;
    origin.radius = SHIPS[ship.class].radius; origin.color = colorForTeam(ship.teamId);
    origin.isShip = true; origin.vx = ship.vx; origin.vz = ship.vz; origin.shields = ship.shields; origin.yaw = ship.yaw;
    origin.shipClass = ship.class;
    origin.faction = ship.faction ?? "industrial";
    const renderedTarget = view.targetsById.get(ship.id);
    if (renderedTarget) origin.hullTarget = { ...renderedTarget };
    effectOrigins.set(ship.id, origin);
  }
  for (const structure of view.structures) {
    visibleIds.add(structure.id);
    const origin = effectOrigins.get(structure.id) ?? {
      x: 0, y: 0, z: 0, radius: 0, color: 0, isShip: false, vx: 0, vz: 0, shields: 0, yaw: 0,
    };
    origin.x = structure.x; origin.y = 8; origin.z = structure.z;
    origin.radius = STRUCTURES[structure.type].radius;
    origin.color = colorForPlayer(structure.ownerPlayerId, structure.teamId);
    origin.isShip = false; origin.vx = 0; origin.vz = 0; origin.shields = structure.shields; origin.yaw = structure.yaw;
    origin.faction = view.state.players.find(player => player.id === structure.ownerPlayerId)?.faction ?? "industrial";
    effectOrigins.set(structure.id, origin);
  }
  for (const id of effectOrigins.keys()) {
    if (!visibleIds.has(id)) {
      effectOrigins.delete(id);
      lastDamageEffectAt.delete(id);
    }
  }
}

function isEventVisible(
  event: SimulationEvent,
  before: ClientVisibilityView,
  after: ClientVisibilityView,
): boolean {
  if (clientViewMode === "post-match-omniscient") return true;
  const entityVisible = (id: number) => before.visibleEntityIds.has(id) || after.visibleEntityIds.has(id);
  const projectileVisible = (id: number) => before.visibleProjectileIds.has(id) || after.visibleProjectileIds.has(id);
  if (event.type === "victory") return true;
  if (event.type === "commandAccepted") return event.playerId === localPlayerId;
  if (event.type === "constructionStarted" || event.type === "constructionCompleted") {
    return event.playerId === localPlayerId || entityVisible(event.structureId);
  }
  if (event.type === "unitQueued") return event.playerId === localPlayerId;
  if (event.type === "unitProduced") return event.playerId === localPlayerId || entityVisible(event.shipId);
  if (event.type === "weaponFired") return entityVisible(event.shipId) || entityVisible(event.targetId);
  if (event.type === "artilleryRevealed") return entityVisible(event.entityId);
  if (event.type === "hit") return entityVisible(event.targetId) || projectileVisible(event.projectileId);
  if (event.type === "projectileDetonated") {
    if (projectileVisible(event.projectileId)) return true;
    // A fast projectile can be created and destroyed between multiplayer view snapshots.
    // Keep the impact if it lands against an entity that is actually visible to this client.
    return [...before.targetsById.values(), ...after.targetsById.values()].some(
      (target) => Math.hypot(target.x - event.x, target.z - event.z) <= target.radius + 12,
    );
  }
  return event.type === "destroyed" && entityVisible(event.entityId);
}

function processEvents(events: SimulationEvent[]): void {
  const detonatedProjectileIds = new Set(events.flatMap(
    (event) => event.type === "projectileDetonated" ? [event.projectileId] : [],
  ));
  const hitTargetsByProjectileId = new Map(events.flatMap(
    (event) => event.type === "hit" ? [[event.projectileId, event.targetId] as const] : [],
  ));
  for (const event of events) {
    if (event.type === "commandAccepted" && event.unitIds.length > 0) {
      eventLines.unshift(`<b>CMD</b> ${event.commandType} // ${event.unitIds.length} units`);
    } else if (event.type === "constructionStarted") {
      eventLines.unshift(`<b>BUILD</b> ${structureLabel(event.structureType, event.playerId)} frame established`);
    } else if (event.type === "constructionCompleted") {
      eventLines.unshift(`<b>READY</b> ${structureLabel(event.structureType, event.playerId)} online`);
    } else if (event.type === "unitProduced") {
      eventLines.unshift(`<b>DEPLOY</b> ${shipLabel(event.shipClass, getPlayerFaction(event.playerId))} ${event.shipId} launched`);
      if (event.playerId === localPlayerId) showToast(`${shipLabel(event.shipClass, getPlayerFaction(event.playerId))} DEPLOYED`);
    } else if (event.type === "weaponFired") {
      const ship = clientView.ships.find((candidate) => candidate.id === event.shipId);
      const sourceFaction = ship?.faction ?? effectOrigins.get(event.shipId)?.faction;
      if (sourceFaction) projectileAppearances.remember(event.projectileId, sourceFaction);
      const turret = ship?.turrets.find((candidate) => candidate.id === event.turretId);
      if (ship?.class === "fighter" && stressScenario.activeCount === 0) {
        // Resolve after render interpolation, using the very same member matrix
        // as its hull and fixed barrels (including its dogfight altitude).
        const projectile = clientView.projectiles.find(candidate => candidate.id === event.projectileId);
        if (projectile) pendingFighterShots.set(event.projectileId, {
          shipId: ship.id,
          member: turret ? ship.turrets.indexOf(turret) : inferFighterFiringMember(ship, projectile, event.tick),
          sequence: Math.max(0, (turret?.fireSequence ?? 1) - 1), vx: ship.vx, vz: ship.vz,
        });
        continue;
      }
      const defense = clientView.structures.find((candidate) => candidate.id === event.shipId);
      const defenseWeaponType = defense ? event.weaponTypeId : undefined;
      if (((ship && turret) || (defense && defenseWeaponType)) && stressScenario.activeCount === 0) {
        const projectile = clientView.projectiles.find((candidate) => candidate.id === event.projectileId);
        const target = effectOrigins.get(event.targetId);
        const defenseMountIndex = defense ? (-event.turretId - 1) % 16 : -1;
        const defenseMount = defense
          ? STRUCTURES[defense.type].hardpoints?.[defenseMountIndex] ?? { localX: 0, localZ: 0 }
          : null;
        if (defense && defenseMount && target) {
          const mountX = defense.x + defenseMount.localX;
          const mountZ = defense.z + defenseMount.localZ;
          let aims = defensiveAimYaw.get(defense.id);
          if (!aims) {
            aims = new Map();
            defensiveAimYaw.set(defense.id, aims);
          }
          aims.set(defenseMountIndex, Math.atan2(target.x - mountX, target.z - mountZ));
        }
        const muzzle = projectile
          ? { x: projectile.previousX, z: projectile.previousZ }
          : ship && turret ? getTurretMuzzleWorldPosition(
            ship,
            turret,
            Math.max(0, turret.fireSequence - 1),
            clientView.state.tick,
          ) : defense && defenseMount && target ? (() => {
            const mountX = defense.x + defenseMount.localX;
            const mountZ = defense.z + defenseMount.localZ;
            const dx = target.x - mountX;
            const dz = target.z - mountZ;
            const distance = Math.max(1, Math.hypot(dx, dz));
            const muzzleOffset = WEAPONS[event.weaponTypeId].muzzleOffset;
            return { x: mountX + dx / distance * muzzleOffset, z: mountZ + dz / distance * muzzleOffset };
          })() : { x: defense!.x, z: defense!.z };
        const weaponTypeId = turret?.weaponTypeId ?? defenseWeaponType!;
        const y = ship && turret
          ? ship.y + turretVisualHeight(ship.class, turret.localX, turret.localZ, turret.weaponTypeId) + 1.2
          : defense ? getStructureModel(defense.type, getPlayerFaction(defense.ownerPlayerId)).turretHeight + 2.2 : 14;
        const muzzleSize = weaponTypeId === "heavyRail" || WEAPONS[weaponTypeId].artillery
          ? 4.2
          : weaponTypeId === "torpedo"
            ? 3.4
            : weaponTypeId === "autocannon" || weaponTypeId === "pointDefense" || weaponTypeId === "flakCannon"
              ? 0.72
              : 2.2;
        const now = performance.now();
        const firingFaction = ship?.faction ?? (defense ? getPlayerFaction(defense.ownerPlayerId) : projectileFaction(event.projectileId));
        projectileAppearances.remember(event.projectileId, firingFaction);
        const weaponColor = getWeaponStyle(weaponTypeId, firingFaction).color;
        if (weaponTypeId === "beam") {
          if (target && isEffectVisible(muzzle.x, y, muzzle.z, 1.4)) {
            combatEffects.spawnBeam(
              muzzle.x, y, muzzle.z, target.x, target.y, target.z,
              weaponColor, Math.max(0.42, ship ? SHIPS[ship.class].radius * 0.035 : 0.7), now, firingFaction,
            );
          }
        } else if (isEffectVisible(muzzle.x, y, muzzle.z)) {
          if (weaponTypeId === "torpedo") {
            combatEffects.spawnMissileLaunch(muzzle.x, y, muzzle.z, weaponColor, now, firingFaction);
          } else {
            combatEffects.spawnMuzzle(muzzle.x, y, muzzle.z, weaponColor, muzzleSize, now);
          }
        }
      }
      if (event.turretId % 7 === 0) eventLines.unshift(`<b>T${event.tick}</b> turret ${event.turretId} → contact ${event.targetId}`);
    } else if (event.type === "artilleryRevealed") {
      const contact = clientView.ships.find((ship) => ship.id === event.entityId)
        ?? clientView.structures.find((structure) => structure.id === event.entityId);
      eventLines.unshift(`<b>COUNTER-BATTERY</b> artillery contact ${event.entityId} revealed`);
      if (contact && contact.ownerPlayerId !== localPlayerId) showToast(`HOSTILE ARTILLERY ${event.entityId} REVEALED`);
    } else if (event.type === "hit") {
      const origin = effectOrigins.get(event.targetId);
      if (origin) {
        const shielded = event.shieldDamage > 0;
        origin.shields = Math.max(0, origin.shields - event.shieldDamage);
        const now = performance.now();
        if (!detonatedProjectileIds.has(event.projectileId)
          && stressScenario.activeCount === 0
          && now - (lastDamageEffectAt.get(event.targetId) ?? -Infinity) >= 55
          && isEffectVisible(origin.x, origin.y, origin.z)) {
          combatEffects.spawnDamageImpact(
            origin.x, origin.y - (origin.isShip ? 3 : 0), origin.z, origin.radius,
            event.projectileId, event.damage, shielded, now, origin.shipClass, origin.yaw, origin.faction,
            projectileFaction(event.projectileId),
          );
          lastDamageEffectAt.set(event.targetId, now);
        }
      }
    } else if (event.type === "projectileDetonated") {
      const style = {
        autocannon: { y: 4.2, size: 0.55 }, pointDefense: { y: 6.8, size: 0.45 },
        flakCannon: { y: 7.1, size: 0.7 },
        plasma: { y: 7.2, size: 1.7 }, torpedo: { y: 10, size: 7.2 },
        heavyRail: { y: 10.2, size: 2.35 }, beam: { y: 8.5, size: 1.4 },
        lightArtillery: { y: 9.5, size: 3.6 },
        siegeArtillery: { y: 11, size: 5.2 },
        strategicArtillery: { y: 14, size: 8.2 },
      }[event.weaponTypeId];
      const hitTargetId = hitTargetsByProjectileId.get(event.projectileId);
      let impactOrigin = effectOrigins.get(hitTargetId ?? -1);
      let nearestImpactDistance = Infinity;
      if (hitTargetId !== undefined && !impactOrigin) {
        for (const origin of effectOrigins.values()) {
          const distance = Math.hypot(origin.x - event.x, origin.z - event.z);
          if (distance <= origin.radius + 12 && distance < nearestImpactDistance) {
            impactOrigin = origin;
            nearestImpactDistance = distance;
          }
        }
      }
      const lastVisualPose = event.weaponTypeId === "torpedo" && hitTargetId === undefined
        ? projectileVfx.getLastVisualPose(event.projectileId)
        : undefined;
      const impactPoint = event.weaponTypeId === "torpedo" && impactOrigin
        ? getTorpedoImpactPoint(event.projectileId, impactOrigin.hullTarget ?? {
          ...impactOrigin, y: impactOrigin.y - (impactOrigin.isShip ? 3 : 0),
        })
        : lastVisualPose ?? event;
      const impactY = "y" in impactPoint ? impactPoint.y : impactOrigin?.y ?? style.y;
      const impactSize = event.weaponTypeId === "torpedo" && impactOrigin
        ? THREE.MathUtils.clamp(impactOrigin.radius * 0.22, style.size, 13)
        : style.size;
      if (stressScenario.activeCount === 0 && isEffectVisible(impactPoint.x, impactY, impactPoint.z)) {
        combatEffects.spawnProjectileDetonation(
          impactPoint.x, impactY, impactPoint.z, getWeaponStyle(event.weaponTypeId, projectileFaction(event.projectileId)).color,
          impactSize, performance.now(), projectileFaction(event.projectileId),
        );
      }
    } else if (event.type === "destroyed") {
      if (lastKnownContacts.delete(event.entityId)) lastKnownContactsDirty = true;
      eventLines.unshift(`<b>ALERT</b> contact ${event.entityId} destroyed`);
      const origin = effectOrigins.get(event.entityId);
      if (origin) {
        if (stressScenario.activeCount === 0 && isEffectVisible(origin.x, origin.y, origin.z, 1.45)) {
          if (origin.isShip) {
            combatEffects.spawnShipDeath(
              origin.x, origin.y, origin.z, origin.color, origin.radius,
              origin.vx, origin.vz, event.entityId, performance.now(),
            );
          } else {
            combatEffects.spawnExplosion(origin.x, origin.y, origin.z, origin.color, origin.radius, performance.now());
          }
        }
        effectOrigins.delete(event.entityId);
        lastDamageEffectAt.delete(event.entityId);
      }
    } else if (event.type === "victory") {
      eventLines.unshift(`<b>END</b> team ${event.winnerTeamId} controls the battlespace`);
      showVictory(event.winnerTeamId);
    }
  }
  eventLines = eventLines.slice(0, 4);
}

function isEffectVisible(x: number, y: number, z: number, margin = 1.2): boolean {
  effectProjection.set(x, y, z).project(camera);
  return effectProjection.z >= -1.1 && effectProjection.z <= 1.1
    && Math.abs(effectProjection.x) <= margin && Math.abs(effectProjection.y) <= margin;
}

function updateHud(): void {
  const state = currentState();
  const totalTurrets = clientView.ships.reduce((sum, ship) => sum + ship.turrets.length, 0);
  const visibleTargetingTurrets = clientView.ships.reduce(
    (sum, ship) => sum + ship.turrets.filter((turret) => turret.targetEntityId !== null && clientView.visibleEntityIds.has(turret.targetEntityId)).length,
    0,
  );
  element("tick").textContent = state.tick.toString();
  element("checksum").textContent = state.checksum.toString(16).padStart(8, "0").toUpperCase();
  element("entity-count").textContent = `${clientView.ships.length} / ${totalTurrets}`;
  element("target-count").textContent = visibleTargetingTurrets.toString();
  element("projectile-count").textContent = clientView.projectiles.length.toString();
  element("physics-body-count").textContent = `${clientView.state.obstacles.length + clientView.ships.length + clientView.structures.length}`;
  element("avoidance-count").textContent = lastDebug.avoidance.filter((item) => clientView.visibleEntityIds.has(item.shipId)).length.toString();
  element("audio-count").textContent = battleAudio.metrics.supported
    ? `${battleAudio.metrics.activeEngineClusters} / ${battleAudio.metrics.activeTransientVoices}`
    : "UNAVAILABLE";
  element("fps").textContent = `${Math.round(fps)} FPS`;
  element("render-count").textContent = `${renderer.info.render.calls} / ${renderer.info.render.triangles.toLocaleString()}`;
  const renderMetrics = renderStateBuilder.state.metrics;
  const activeProjectiles = stressScenario.activeCount > 0 ? stressScenario.projectiles.length : clientView.projectiles.length;
  element("entity-count").textContent = `${stressScenario.activeCount > 0 ? stressScenario.activeCount : clientView.ships.length} / ${renderMetrics.simulatedTurrets}`;
  element("projectile-count").textContent = `${activeProjectiles.toLocaleString()} / ${projectileVfx.renderedCount.toLocaleString()}`;
  element("cpu-frame").textContent = `${frameCpuMs.toFixed(2)} / ${renderPreparationMs.toFixed(2)} MS`;
  element("gpu-frame").textContent = gpuFrameTimer.elapsedMs === null ? "N/A" : `${gpuFrameTimer.elapsedMs.toFixed(2)} MS`;
  element("sim-cpu").textContent = `${simulationCpuMs.toFixed(2)} MS`;
  element("visible-ships").textContent = `${renderMetrics.visibleShips.toLocaleString()} / ${batchedShipRenderer.metrics.shipInstances.toLocaleString()}`;
  element("rendered-turrets").textContent = `${renderMetrics.simulatedTurrets.toLocaleString()} / ${renderMetrics.renderedTurrets.toLocaleString()}`;
  element("lod-counts").textContent = renderMetrics.lod.join(" / ");
  element("effect-pool").textContent = combatEffects.poolUsage;
  element("batch-count").textContent = `${batchedShipRenderer.metrics.activeBatches} / ${batchedShipRenderer.metrics.transparentBatches}`;
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  element("memory-count").textContent = memory ? `${(memory.usedJSHeapSize / 1_048_576).toFixed(0)} MB` : "N/A";
  const budgetBreaches: string[] = [];
  if (fps < RENDER_BUDGET.minimumFps) budgetBreaches.push("FPS");
  if (renderer.info.render.calls > RENDER_BUDGET.drawCalls) budgetBreaches.push("DRAW");
  if (renderPreparationMs > RENDER_BUDGET.preparationMs) budgetBreaches.push("PREP");
  if (gpuFrameTimer.elapsedMs !== null && gpuFrameTimer.elapsedMs > RENDER_BUDGET.gpuMs) budgetBreaches.push("GPU");
  if (batchedShipRenderer.metrics.transparentBatches > RENDER_BUDGET.transparentBatches) budgetBreaches.push("TRANS");
  const budgetStatus = element("budget-status");
  budgetStatus.textContent = budgetBreaches.length === 0 ? "OK" : budgetBreaches.join(" + ");
  budgetStatus.classList.toggle("over-budget", budgetBreaches.length > 0);
  const player = canIssuePlayerCommands()
    ? state.players.find((candidate) => candidate.id === localPlayerId)
    : undefined;
  if (player?.economy) {
    const economy = player.economy;
    const alloyStored = Math.floor(economy.alloy);
    const energyStored = Math.floor(economy.energy);
    const alloyCapacity = Math.floor(economy.alloyStorage);
    const energyCapacity = Math.floor(economy.energyStorage);
    const alloyRemaining = Math.max(0, Math.floor(economy.alloyStorage - economy.alloy));
    const energyRemaining = Math.max(0, Math.floor(economy.energyStorage - economy.energy));
    const alloyFill = alloyCapacity > 0 ? THREE.MathUtils.clamp(economy.alloy / economy.alloyStorage, 0, 1) : 0;
    const energyFill = energyCapacity > 0 ? THREE.MathUtils.clamp(economy.energy / economy.energyStorage, 0, 1) : 0;
    element("alloy-value").textContent = Math.floor(economy.alloy).toLocaleString();
    element("energy-value").textContent = Math.floor(economy.energy).toLocaleString();
    element("alloy-value").title = `${alloyStored.toLocaleString()} stored // ${alloyRemaining.toLocaleString()} capacity remaining // ${alloyCapacity.toLocaleString()} total`;
    element("energy-value").title = `${energyStored.toLocaleString()} stored // ${energyRemaining.toLocaleString()} capacity remaining // ${energyCapacity.toLocaleString()} total`;
    element("alloy-rate").textContent = `+${economy.alloyIncome.toFixed(0)} / −${economy.alloySpend.toFixed(0)}`;
    element("energy-rate").textContent = `+${economy.energyIncome.toFixed(0)} / −${economy.energySpend.toFixed(0)}`;
    element("alloy-rate").classList.toggle("stalled", economy.efficiency < 0.999 && economy.alloy < 1);
    element("energy-rate").classList.toggle("stalled", economy.efficiency < 0.999 && economy.energy < 1);
    element("alloy-resource").style.setProperty("--storage-fill", `${(alloyFill * 100).toFixed(2)}%`);
    element("energy-resource").style.setProperty("--storage-fill", `${(energyFill * 100).toFixed(2)}%`);
    element("economy-efficiency").textContent = `${Math.round(economy.efficiency * 100)}%`;
  } else {
    element("alloy-value").textContent = "—";
    element("energy-value").textContent = "—";
    element("alloy-value").title = "Economy hidden in observer mode";
    element("energy-value").title = "Economy hidden in observer mode";
    element("alloy-rate").textContent = "VIEW ONLY";
    element("energy-rate").textContent = "VIEW ONLY";
    element("alloy-rate").classList.remove("stalled");
    element("energy-rate").classList.remove("stalled");
    element("alloy-resource").style.setProperty("--storage-fill", "0%");
    element("energy-resource").style.setProperty("--storage-fill", "0%");
    element("economy-efficiency").textContent = "—";
  }
  const seconds = Math.floor(state.tick * FIXED_DT);
  element("sim-time").textContent = `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
  element("event-feed").innerHTML = eventLines.map((line) => `<span>${line}</span>`).join("");
  updateProgressionControls();
  updateSelectionHud();
  drawMinimap();
}

let minimapExtentCacheTick = -1;
let minimapExtentCacheChecksum = -1;
let minimapExtentCacheValue = 500;

function minimapHalfExtent(): number {
  if (
    minimapExtentCacheTick === clientView.state.tick
    && minimapExtentCacheChecksum === clientView.state.checksum
  ) return minimapExtentCacheValue;
  let furthest = 0;
  for (const obstacle of clientView.state.obstacles) {
    furthest = Math.max(furthest, Math.abs(obstacle.x) + obstacle.radius, Math.abs(obstacle.z) + obstacle.radius);
  }
  for (const node of clientView.resourceNodes) {
    furthest = Math.max(furthest, Math.abs(node.x) + 24, Math.abs(node.z) + 24);
  }
  for (const structure of clientView.structures) {
    furthest = Math.max(furthest, Math.abs(structure.x) + 80, Math.abs(structure.z) + 80);
  }
  for (const ship of clientView.ships) {
    furthest = Math.max(furthest, Math.abs(ship.x) + 50, Math.abs(ship.z) + 50);
  }
  minimapExtentCacheTick = clientView.state.tick;
  minimapExtentCacheChecksum = clientView.state.checksum;
  minimapExtentCacheValue = Math.max(500, Math.ceil((furthest + 40) / 100) * 100);
  return minimapExtentCacheValue;
}

function minimapCoordinate(value: number, halfExtent: number, width: number): number {
  return (value + halfExtent) / (halfExtent * 2) * width;
}

function drawMinimap(): void {
  const minimap = element<HTMLCanvasElement>("minimap");
  const context = minimap.getContext("2d");
  if (!context) return;
  const width = minimap.width;
  const halfExtent = minimapHalfExtent();
  updateMapBoundary(halfExtent);
  updateWorldBoundaryScale(halfExtent);
  context.clearRect(0, 0, width, width);
  context.fillStyle = "#04090e";
  context.fillRect(0, 0, width, width);
  context.strokeStyle = "rgba(87,157,195,.12)";
  context.lineWidth = 1;
  for (let index = 1; index < 4; index += 1) {
    context.beginPath(); context.moveTo(index * width / 4, 0); context.lineTo(index * width / 4, width); context.stroke();
    context.beginPath(); context.moveTo(0, index * width / 4); context.lineTo(width, index * width / 4); context.stroke();
  }
  for (const field of visibleTerritories()) {
    context.beginPath();
    context.arc(minimapCoordinate(field.x, halfExtent, width), minimapCoordinate(field.z, halfExtent, width), field.radius / (halfExtent * 2) * width, 0, Math.PI * 2);
    context.fillStyle = field.kind === "creep" ? "rgba(180,103,217,.28)" : "rgba(75,218,199,.22)";
    context.fill();
  }
  for (const obstacle of clientView.state.obstacles) {
    const x = minimapCoordinate(obstacle.x, halfExtent, width);
    const y = minimapCoordinate(obstacle.z, halfExtent, width);
    if (obstacle.type === "barrier" && obstacle.width && obstacle.depth) {
      const obstacleWidth = obstacle.width / (halfExtent * 2) * width;
      const obstacleDepth = obstacle.depth / (halfExtent * 2) * width;
      context.fillStyle = "#26313a";
      context.fillRect(x - obstacleWidth / 2, y - obstacleDepth / 2, obstacleWidth, obstacleDepth);
      context.strokeStyle = "#71818c";
      context.strokeRect(x - obstacleWidth / 2, y - obstacleDepth / 2, obstacleWidth, obstacleDepth);
      continue;
    }
    const radius = Math.max(2, obstacle.radius / (halfExtent * 2) * width);
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = "#26313a";
    context.fill();
    context.strokeStyle = "#71818c";
    context.lineWidth = 0.8;
    context.stroke();
  }
  for (const node of clientView.resourceNodes) {
    const x = minimapCoordinate(node.x, halfExtent, width);
    const y = minimapCoordinate(node.z, halfExtent, width);
    const knownClaim = node.claimedByStructureId !== null && clientView.visibleEntityIds.has(node.claimedByStructureId);
    context.fillStyle = knownClaim ? "#695839" : "#d9a851";
    context.fillRect(x - 1.5, y - 1.5, 3, 3);
  }
  drawMinimapFog(context, width, halfExtent);
  drawMinimapWorldBoundary(context, width);
  if (clientView.localTeamId !== null && lastKnownContacts.size > 0) {
    context.save();
    context.setLineDash([2, 2]);
    context.lineWidth = 1;
    for (const contact of lastKnownContacts.values()) {
      const remaining = THREE.MathUtils.clamp(
        (contact.expiresAtTick - clientView.state.tick) / Math.max(1, contact.expiresAtTick - contact.lostAtTick),
        0,
        1,
      );
      if (remaining <= 0) continue;
      const x = minimapCoordinate(contact.x, halfExtent, width);
      const y = minimapCoordinate(contact.z, halfExtent, width);
      context.globalAlpha = 0.2 + remaining * 0.55;
      context.strokeStyle = `#${contact.color.toString(16).padStart(6, "0")}`;
      context.beginPath();
      context.arc(x, y, THREE.MathUtils.clamp(contact.radius / 5, 2.5, 7), 0, Math.PI * 2);
      context.stroke();
    }
    context.restore();
  }
  for (const structure of clientView.structures) {
    const x = minimapCoordinate(structure.x, halfExtent, width);
    const y = minimapCoordinate(structure.z, halfExtent, width);
    context.strokeStyle = `#${colorForPlayer(structure.ownerPlayerId, structure.teamId).toString(16).padStart(6, "0")}`;
    context.lineWidth = structure.type === "commandCore" ? 2 : 1;
    const size = structure.type === "commandCore"
      ? 7
      : SHIPYARD_TYPES.includes(structure.type as (typeof SHIPYARD_TYPES)[number])
        ? structure.type === "capitalShipyard" ? 7 : 5
        : 3.5;
    context.strokeRect(x - size / 2, y - size / 2, size, size);
  }
  for (const ship of clientView.ships) {
    const x = minimapCoordinate(ship.x, halfExtent, width);
    const y = minimapCoordinate(ship.z, halfExtent, width);
    context.fillStyle = `#${colorForTeam(ship.teamId).toString(16).padStart(6, "0")}`;
    context.shadowColor = context.fillStyle;
    context.shadowBlur = ship.class === "fighter" ? 3 : ship.class === "bomber" ? 5 : 7;
    const size = THREE.MathUtils.clamp(SHIPS[ship.class].radius / 4.2, 1.35, 8);
    context.fillRect(x - size / 2, y - size / 2, size, size);
  }
  context.shadowBlur = 0;
  context.strokeStyle = "rgba(112,226,255,.78)";
  context.lineWidth = 1.5;
  context.strokeRect(1.25, 1.25, width - 2.5, width - 2.5);
  context.strokeStyle = "rgba(141,221,255,.65)";
  const viewSize = Math.min(width, (cameraRig.distance / (halfExtent * 2)) * width * 0.65);
  const viewX = minimapCoordinate(cameraRig.target.x, halfExtent, width);
  const viewY = minimapCoordinate(cameraRig.target.z, halfExtent, width);
  context.strokeRect(viewX - viewSize / 2, viewY - viewSize / 2, viewSize, viewSize);
}

function drawMinimapFog(context: CanvasRenderingContext2D, width: number, halfExtent: number): void {
  if (clientView.localTeamId === null) return;
  context.drawImage(fogCompositeCanvas, 0, 0, width, width);
}

function drawMinimapWorldBoundary(context: CanvasRenderingContext2D, width: number): void {
  context.save();
  context.strokeStyle = "rgba(102, 197, 222, .82)";
  context.lineWidth = 1.5;
  context.strokeRect(1, 1, width - 2, width - 2);
  context.strokeStyle = "rgba(102, 197, 222, .28)";
  context.lineWidth = 1;
  context.strokeRect(3.5, 3.5, width - 7, width - 7);
  context.restore();
}

function getSelectedShips(): ShipState[] {
  return clientView.ships
    .filter((ship) => selectedShipIds.has(ship.id) && ship.ownerPlayerId === localPlayerId)
    .sort((a, b) => a.id - b.id);
}

function getDisplayedSelectedShips(): ShipState[] {
  return clientView.ships
    .filter((ship) => selectedShipIds.has(ship.id))
    .sort((a, b) => a.id - b.id);
}

function getSelectedStructures(): StructureState[] {
  return clientView.structures
    .filter((structure) => selectedStructureIds.has(structure.id) && structure.ownerPlayerId === localPlayerId)
    .sort((a, b) => a.id - b.id);
}

function getDisplayedSelectedStructures(): StructureState[] {
  return clientView.structures
    .filter((structure) => selectedStructureIds.has(structure.id))
    .sort((a, b) => a.id - b.id);
}

function getSelectedShipyards(): StructureState[] {
  return getSelectedStructures().filter(
    (structure) => SHIPYARD_TYPES.includes(structure.type as (typeof SHIPYARD_TYPES)[number]) && structure.buildProgress >= 1,
  );
}

function getSelectedBuilders(): Array<StructureState | ShipState> {
  const structures = getSelectedStructures().filter(
    (structure) => (structure.type === "commandCore" || structure.type === "fabricator")
      && structure.buildProgress >= 1,
  );
  const ships = getSelectedShips().filter((ship) => SHIPS[ship.class].buildPower > 0);
  return [...structures, ...ships].sort((a, b) => a.id - b.id);
}

function getSelectedMobileBuilderIds(): number[] {
  return getSelectedShips()
    .filter((ship) => SHIPS[ship.class].buildPower > 0)
    .map((ship) => ship.id);
}

function getWorldPoint(clientX: number, clientY: number): THREE.Vector3 | null {
  const pointer = new THREE.Vector2(clientX / innerWidth * 2 - 1, -(clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.ray.intersectPlane(battlefieldPlane, new THREE.Vector3());
}

function pickCombatTarget(clientX: number, clientY: number): CombatTargetState | undefined {
  const projected = new THREE.Vector3();
  const focalPixels = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  let nearest: CombatTargetState | undefined;
  let nearestScore = Number.POSITIVE_INFINITY;
  for (const candidate of [...clientView.ships, ...clientView.structures] as CombatTargetState[]) {
    const y = "class" in candidate ? candidate.y : 7;
    projected.set(candidate.x, y, candidate.z).project(camera);
    if (projected.z < -1 || projected.z > 1) continue;
    const screenX = (projected.x + 1) * 0.5 * innerWidth;
    const screenY = (1 - projected.y) * 0.5 * innerHeight;
    const screenDistance = Math.hypot(screenX - clientX, screenY - clientY);
    const dx = camera.position.x - candidate.x;
    const dy = camera.position.y - y;
    const dz = camera.position.z - candidate.z;
    const worldDistance = Math.max(1, Math.hypot(dx, dy, dz));
    const radius = "class" in candidate ? SHIPS[candidate.class].radius : STRUCTURES[candidate.type].radius;
    const hitRadius = THREE.MathUtils.clamp(radius * focalPixels / worldDistance * 1.5, 9, 38);
    const score = screenDistance / hitRadius;
    if (score <= 1 && score < nearestScore) {
      nearest = candidate;
      nearestScore = score;
    }
  }
  return nearest;
}

function setSelection(ids: readonly number[], additive = false, toggle = false): void {
  if (!canIssuePlayerCommands()) return;
  const ownedIds = new Set(clientView.ships
    .filter((ship) => ship.ownerPlayerId === localPlayerId)
    .map((ship) => ship.id));
  if (ids.length > 0 || !additive) {
    selectedStructureIds.clear();
    primaryStructureId = null;
  }
  if (!additive) selectedShipIds.clear();
  for (const id of ids) {
    if (!ownedIds.has(id)) continue;
    if (toggle && selectedShipIds.has(id)) selectedShipIds.delete(id);
    else selectedShipIds.add(id);
  }
  setCommandMode(null);
  setStructureMode(null);
  setRallyPointMode(false);
  updateSelectionHud();
}

function setStructureSelection(ids: readonly number[], additive = false, toggle = false): void {
  if (!canIssuePlayerCommands()) return;
  const ownedById = new Map(clientView.structures
    .filter((structure) => structure.ownerPlayerId === localPlayerId)
    .map((structure) => [structure.id, structure]));
  const requested = ids.map((id) => ownedById.get(id)).filter((structure): structure is StructureState => Boolean(structure));
  const requestedType = requested[0]?.type;
  const selected = getSelectedStructures();
  const requestedAreShipyards = requested.length > 0 && requested.every((structure) =>
    SHIPYARD_TYPES.includes(structure.type as (typeof SHIPYARD_TYPES)[number]));
  const selectedAreShipyards = selected.length > 0 && selected.every((structure) =>
    SHIPYARD_TYPES.includes(structure.type as (typeof SHIPYARD_TYPES)[number]));
  const keepExisting = additive && requestedType !== undefined && (
    (requestedAreShipyards && selectedAreShipyards)
    || selected.every((structure) => structure.type === requestedType)
  );
  selectedShipIds.clear();
  if (!keepExisting) selectedStructureIds.clear();
  for (const structure of requested) {
    if (!requestedAreShipyards && requestedType !== undefined && structure.type !== requestedType) continue;
    if (toggle && selectedStructureIds.has(structure.id)) selectedStructureIds.delete(structure.id);
    else {
      selectedStructureIds.add(structure.id);
      primaryStructureId = structure.id;
    }
  }
  if (primaryStructureId !== null && !selectedStructureIds.has(primaryStructureId)) {
    primaryStructureId = [...selectedStructureIds].at(-1) ?? null;
  }
  setCommandMode(null);
  setStructureMode(null);
  setRallyPointMode(false);
  updateSelectionHud();
}

function inspectHostile(target: CombatTargetState): void {
  if (!canIssuePlayerCommands() || !isHostileToLocalPlayer(target.teamId)) return;
  selectedShipIds.clear();
  selectedStructureIds.clear();
  primaryStructureId = null;
  if ("class" in target) selectedShipIds.add(target.id);
  else {
    selectedStructureIds.add(target.id);
    primaryStructureId = target.id;
  }
  setCommandMode(null);
  setStructureMode(null);
  setRallyPointMode(false);
  updateSelectionHud();
}

function selectEntitiesInBox(drag: NonNullable<typeof selectionDrag>): void {
  const left = Math.min(drag.startX, drag.currentX);
  const right = Math.max(drag.startX, drag.currentX);
  const top = Math.min(drag.startY, drag.currentY);
  const bottom = Math.max(drag.startY, drag.currentY);
  const shipIds: number[] = [];
  const structureIds: number[] = [];
  const projected = new THREE.Vector3();
  for (const ship of clientView.ships) {
    if (ship.ownerPlayerId !== localPlayerId) continue;
    projected.set(ship.x, ship.y, ship.z).project(camera);
    if (projected.z < -1 || projected.z > 1) continue;
    const screenX = (projected.x + 1) * 0.5 * innerWidth;
    const screenY = (1 - projected.y) * 0.5 * innerHeight;
    if (screenX >= left && screenX <= right && screenY >= top && screenY <= bottom) shipIds.push(ship.id);
  }
  const focalPixels = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  for (const structure of clientView.structures) {
    if (structure.ownerPlayerId !== localPlayerId) continue;
    projected.set(structure.x, 7, structure.z).project(camera);
    if (projected.z < -1 || projected.z > 1) continue;
    const screenX = (projected.x + 1) * 0.5 * innerWidth;
    const screenY = (1 - projected.y) * 0.5 * innerHeight;
    const worldDistance = Math.max(1, camera.position.distanceTo(new THREE.Vector3(structure.x, 7, structure.z)));
    const screenRadius = THREE.MathUtils.clamp(STRUCTURES[structure.type].radius * focalPixels / worldDistance, 7, 72);
    if (
      screenX + screenRadius >= left && screenX - screenRadius <= right
      && screenY + screenRadius >= top && screenY - screenRadius <= bottom
    ) structureIds.push(structure.id);
  }
  if (shipIds.length > 0) setSelection(shipIds, drag.shift);
  else if (structureIds.length > 0) setStructureSelection(structureIds, drag.shift);
  else if (!drag.shift) setSelection([]);
}

function updateSelectionBox(): void {
  const box = element("selection-box");
  if (!selectionDrag) { box.style.display = "none"; return; }
  const width = Math.abs(selectionDrag.currentX - selectionDrag.startX);
  const height = Math.abs(selectionDrag.currentY - selectionDrag.startY);
  if (width < 4 && height < 4) { box.style.display = "none"; return; }
  box.style.display = "block";
  box.style.left = `${Math.min(selectionDrag.startX, selectionDrag.currentX)}px`;
  box.style.top = `${Math.min(selectionDrag.startY, selectionDrag.currentY)}px`;
  box.style.width = `${width}px`;
  box.style.height = `${height}px`;
}

function clearSelectionRoster(): void {
  const roster = element("selection-roster");
  roster.classList.add("hidden");
  element("selection-detail").classList.remove("has-roster");
  if (selectionRosterSignature !== "") roster.innerHTML = "";
  selectionRosterSignature = "";
}

function renderSelectionRoster(ships: readonly ShipState[]): void {
  const roster = element("selection-roster");
  const signature = ships.map((ship) => {
    const definition = getFactionShipDefinition(ship.class, ship.faction);
    const hullStep = Math.round((ship.health / definition.maxHealth) * 20);
    const shieldStep = definition.maxShield > 0 ? Math.round((ship.shields / definition.maxShield) * 20) : 0;
    return `${ship.id}:${ship.class}:${ship.teamId}:${hullStep}:${shieldStep}`;
  }).join("|");
  roster.classList.remove("hidden");
  element("selection-detail").classList.add("has-roster");
  if (signature === selectionRosterSignature) return;
  selectionRosterSignature = signature;
  roster.innerHTML = ships.map((ship, index) => {
    const definition = getFactionShipDefinition(ship.class, ship.faction);
    const hullPercent = Math.max(0, Math.min(100, Math.round((ship.health / definition.maxHealth) * 100)));
    const shieldPercent = definition.maxShield > 0
      ? Math.max(0, Math.min(100, Math.round((ship.shields / definition.maxShield) * 100)))
      : 0;
    const teamColor = `#${colorForTeam(ship.teamId).toString(16).padStart(6, "0")}`;
    const squadSize = ship.class === "fighter" ? 5 : 1;
    const badge = squadSize > 1 ? `<em class="unit-thumb-badge">×${squadSize}</em>` : "";
    const shieldCopy = definition.maxShield > 0 ? `, ${shieldPercent}% shields` : "";
    return `<button class="unit-thumb${index === 0 ? " primary" : ""}${hullPercent < 30 ? " critical" : ""}" data-selection-ship-id="${ship.id}" style="--team:${teamColor};--hull:${hullPercent}%;--shield:${shieldPercent}%" title="${shipLabel(ship.class, ship.faction)} ${ship.id}" aria-label="${shipLabel(ship.class, ship.faction)} ${ship.id}, ${hullPercent}% hull${shieldCopy}">
      <span class="unit-thumb-art"><svg viewBox="0 0 64 48" aria-hidden="true"><path d="${SHIP_THUMBNAIL_PATHS[ship.class]}"></path><path class="unit-thumb-detail" d="${SHIP_THUMBNAIL_DETAILS[ship.class]}"></path></svg></span>
      <span class="unit-thumb-code">${SHIP_ABBREVIATIONS[ship.class]}</span>${badge}<i class="unit-thumb-shield"></i><i class="unit-thumb-hull"></i>
    </button>`;
  }).join("");
}

function updateSelectionHud(): void {
  const ships = getDisplayedSelectedShips();
  const structures = getDisplayedSelectedStructures();
  const inspectedHostile = ships.length + structures.length === 1
    ? [...ships, ...structures].find((entity) => isHostileToLocalPlayer(entity.teamId))
    : undefined;
  const commandDeck = document.querySelector(".command-deck");
  commandDeck?.classList.toggle("view-locked", !canIssuePlayerCommands());
  commandDeck?.classList.toggle("hostile-selection", inspectedHostile !== undefined);
  const title = element("selection-title");
  const eyebrow = element("selection-eyebrow");
  const summary = element("selection-summary");
  const icon = element("selection-icon");
  const bars = element("selection-bars");
  const empty = element("command-empty");
  const fleetControls = element("fleet-controls");
  const constructionControls = element("construction-controls");
  const constructionSiteControls = element("construction-site-controls");
  const productionControls = element("production-controls");
  const queueConsole = element("selection-queue");
  fleetControls.classList.add("hidden");
  constructionControls.classList.add("hidden");
  constructionSiteControls.classList.add("hidden");
  productionControls.classList.add("hidden");
  queueConsole.classList.add("hidden");
  empty.classList.remove("hostile-intel");
  icon.classList.remove("fighter-squad-symbol");
  if (!canIssuePlayerCommands() || structures.length > 0 || ships.length <= 1) clearSelectionRoster();

  if (!canIssuePlayerCommands()) {
    eyebrow.textContent = demoMode
      ? "AUTONOMOUS BATTLE"
      : clientViewMode === "team-spectator" ? "TEAM SENSOR FEED" : "MATCH REVIEW";
    title.textContent = "VIEW ONLY";
    summary.textContent = demoMode
      ? `${clientView.ships.length} live ships · factories replenish both alliances`
      : clientViewMode === "team-spectator"
      ? `Team ${spectatorTeamId ?? "?"} intelligence · fog of war active`
      : "Post-match omniscient replay";
    icon.textContent = demoMode ? "✦" : clientViewMode === "team-spectator" ? "◉" : "▶";
    bars.innerHTML = "";
    empty.classList.remove("hidden");
    empty.innerHTML = demoMode
      ? "<span>✦</span><p>AI FACTORIES ONLINE<br />CAMERA + MINIMAP AVAILABLE</p>"
      : clientViewMode === "team-spectator"
      ? "<span>◉</span><p>LIVE TEAM VIEW<br />COMMANDS DISABLED</p>"
      : "<span>▶</span><p>USE THE REPLAY TIMELINE<br />COMMANDS DISABLED</p>";
    element("command-context-title").textContent = demoMode ? "BATTLE SHOWCASE" : "OBSERVER CONTROLS";
    element("command-context-subtitle").textContent = demoMode
      ? "PRODUCTION GOVERNOR · 420 SHIP CAP"
      : "CAMERA + MINIMAP AVAILABLE";
    return;
  }

  if (ships.length === 0 && structures.length === 0) {
    eyebrow.textContent = "TACTICAL CONTROL";
    title.textContent = "NO SELECTION";
    summary.textContent = "Select a vessel or structure";
    icon.textContent = "◇";
    bars.innerHTML = "";
    empty.classList.remove("hidden");
    empty.innerHTML = "<span>◇</span><p>SELECT A FRIENDLY UNIT<br />OR STRUCTURE</p>";
    element("command-context-title").textContent = "COMMAND CARD";
    element("command-context-subtitle").textContent = "AWAITING SELECTION";
    return;
  }

  if (inspectedHostile) {
    const player = clientView.state.players.find((candidate) => candidate.id === inspectedHostile.ownerPlayerId);
    const isShip = "class" in inspectedHostile;
    const shipDefinition = "class" in inspectedHostile ? getFactionShipDefinition(inspectedHostile.class, inspectedHostile.faction) : undefined;
    const structureDefinition = "type" in inspectedHostile ? STRUCTURES[inspectedHostile.type] : undefined;
    const definition = shipDefinition ?? structureDefinition!;
    const hardpoints: readonly Readonly<{ weaponTypeId: WeaponTypeId }>[] = shipDefinition?.hardpoints
      ?? structureDefinition?.hardpoints
      ?? (structureDefinition?.weaponTypeId ? [{ weaponTypeId: structureDefinition.weaponTypeId }] : []);
    const weaponCounts = new Map<WeaponTypeId, number>();
    for (const hardpoint of hardpoints) {
      weaponCounts.set(hardpoint.weaponTypeId, (weaponCounts.get(hardpoint.weaponTypeId) ?? 0) + 1);
    }
    const weaponSummary = [...weaponCounts.entries()]
      .map(([weaponTypeId, count]) => `${count}× ${WEAPON_LABELS[weaponTypeId]}`)
      .join(" · ") || "UNARMED";
    const maximumWeaponRange = hardpoints.reduce((maximum, hardpoint) => Math.max(
      maximum,
      WEAPONS[hardpoint.weaponTypeId].range * (structureDefinition?.weaponRangeMultiplier ?? 1),
    ), 0);
    const hull = Math.max(0, Math.ceil(inspectedHostile.health));
    const shields = Math.max(0, Math.ceil(inspectedHostile.shields));
    eyebrow.textContent = "VISIBLE HOSTILE CONTACT";
    title.textContent = isShip ? shipLabel(inspectedHostile.class, inspectedHostile.faction) : structureLabel(inspectedHostile.type, inspectedHostile.ownerPlayerId);
    summary.textContent = `${player?.name ?? "UNKNOWN COMMAND"} · TEAM ${inspectedHostile.teamId} · CONTACT ${inspectedHostile.id}`;
    if (isShip && inspectedHostile.class === "fighter") {
      icon.classList.add("fighter-squad-symbol");
      icon.textContent = "⌃\n⌃ ⌃\n⌃ ⌃";
    } else {
      icon.textContent = isShip
        ? inspectedHostile.class === "fabricator" ? "⌁"
          : inspectedHostile.class === "carrier" ? "▣"
          : inspectedHostile.class === "battleship" ? "⬣"
          : inspectedHostile.class === "cruiser" || inspectedHostile.class === "destroyer" ? "⬢"
          : inspectedHostile.class === "bomber" ? "◆" : "△"
        : STRUCTURE_ICONS[inspectedHostile.type];
    }
    bars.innerHTML = selectionMetersHtml(
      inspectedHostile.health,
      definition.maxHealth,
      inspectedHostile.shields,
      definition.maxShield,
    );
    empty.classList.remove("hidden");
    empty.classList.add("hostile-intel");
    empty.innerHTML = `<div class="hostile-intel-grid">
      <div><small>HULL</small><strong>${hull.toLocaleString()} / ${definition.maxHealth.toLocaleString()}</strong></div>
      <div><small>SHIELDS</small><strong>${shields.toLocaleString()} / ${definition.maxShield.toLocaleString()}</strong></div>
      <div><small>ARMOR</small><strong>${definition.armorType.toUpperCase()}</strong></div>
      <div><small>${isShip ? "SPEED" : "SENSOR"}</small><strong>${shipDefinition ? tooltipNumber(shipDefinition.speed) : definition.sensorRange.toLocaleString()}</strong></div>
      <div class="hostile-intel-loadout"><small>WEAPONS${maximumWeaponRange > 0 ? ` · ${tooltipNumber(maximumWeaponRange)} MAX RANGE` : ""}</small><strong>${weaponSummary}</strong></div>
    </div>`;
    element("command-context-title").textContent = "CONTACT INTELLIGENCE";
    element("command-context-subtitle").textContent = "VISIBLE SENSOR DATA · COMMANDS DISABLED";
    return;
  }

  empty.classList.add("hidden");
  if (structures.length > 0) {
    const primary = structures.find((structure) => structure.id === primaryStructureId) ?? structures[0]!;
    const definition = STRUCTURES[primary.type];
    const health = structures.reduce((sum, structure) => sum + structure.health, 0);
    const maxHealth = structures.reduce((sum, structure) => sum + STRUCTURES[structure.type].maxHealth, 0);
    const shields = structures.reduce((sum, structure) => sum + structure.shields, 0);
    const maxShields = structures.reduce((sum, structure) => sum + STRUCTURES[structure.type].maxShield, 0);
    const assistingFabricatorIds = assistingFabricatorIdsInView(primary.id);
    const buildPower = constructionBuildPowerInView(primary.id);
    const assistedConstructions = primary.type === "fabricator" && primary.buildProgress >= 1
      ? clientView.structures.filter((structure) =>
          structure.ownerPlayerId === localPlayerId
          && structure.buildProgress < 1
          && assistingFabricatorIdsInView(structure.id).includes(primary.id),
        )
      : [];
    eyebrow.textContent = structures.length === 1 ? "SELECTED STRUCTURE" : "STRUCTURE GROUP";
    title.textContent = structures.length === 1 ? structureLabel(primary.type, primary.ownerPlayerId) : `${structures.length} × ${structureLabel(primary.type, primary.ownerPlayerId)}`;
    summary.textContent = primary.buildProgress < 1
      ? `CONSTRUCTION ${Math.floor(primary.buildProgress * 100)}% · ${buildPower.toFixed(1)}× POWER · FRAME ${primary.id}`
      : primary.type === "commandCore"
        ? "FLEET HEADQUARTERS · BUILDS CORE INFRASTRUCTURE"
      : primary.type === "fabricator"
        ? `FRAME ${primary.id} · ASSISTING ${assistedConstructions.length} SITE${assistedConstructions.length === 1 ? "" : "S"}`
        : `FRAME ${primary.id} · ${Math.floor(primary.health)} HULL · ${Math.floor(primary.shields)} SHIELD`;
    icon.textContent = STRUCTURE_ICONS[primary.type];
    bars.innerHTML = selectionMetersHtml(health, maxHealth, shields, maxShields);

    if (primary.buildProgress < 1) {
      const player = currentState().players.find((candidate) => candidate.id === localPlayerId);
      const gridLimited = (player?.economy?.efficiency ?? 1) < 0.999;
      const fabricatorLabel = assistingFabricatorIds.length > 0
        ? `${assistingFabricatorIds.length} × ${structureLabel("fabricator", primary.ownerPlayerId)} ASSISTING`
        : "BASE CONSTRUCTION CREW";
      const progressPercent = Math.floor(primary.buildProgress * 100);
      constructionSiteControls.classList.remove("hidden");
      element("construction-site-label").textContent = `${fabricatorLabel} · ${buildPower.toFixed(1)}× POWER`;
      element("construction-site-progress").textContent = `${progressPercent}%`;
      element("construction-site-progress-bar").style.width = `${progressPercent}%`;
      element<HTMLButtonElement>("cancel-construction").disabled = primary.ownerPlayerId !== localPlayerId;
      element("command-context-title").textContent = structureLabel(primary.type, primary.ownerPlayerId);
      element("command-context-subtitle").textContent = gridLimited ? "CONSTRUCTION GRID LIMITED" : "CONSTRUCTION ACTIVE";
    } else if (primary.type === "commandCore" || primary.type === "fabricator") {
      constructionControls.classList.remove("hidden");
      element("command-context-title").textContent = "CONSTRUCTION";
      element("command-context-subtitle").textContent = primary.type === "fabricator"
        ? `${structureLabel(primary.type, primary.ownerPlayerId)} ${primary.id} · ${assistedConstructions.length} ASSISTED`
        : `${structureLabel(primary.type, primary.ownerPlayerId)} ${primary.id}`;
    } else if (SHIPYARD_TYPES.includes(primary.type as (typeof SHIPYARD_TYPES)[number])) {
      updateProductionRosterVisibility();
      productionControls.classList.remove("hidden");
      element("command-context-title").textContent = "PRODUCTION";
      element("command-context-subtitle").textContent = structures.length > 1
        ? `${structures.length} SHIPYARDS LINKED · RMB SET RALLY`
        : `${structureLabel(primary.type, primary.ownerPlayerId)} ${primary.id} · RMB SET RALLY`;
      renderSelectedProduction();
    } else {
      const passiveCopy = primary.type === "creepNode"
        ? { icon: "✺", text: "CREEP · +20% SPEED · +10% DAMAGE · SUSTAINS NESTS" }
        : primary.type === "pylon"
        ? { icon: "◇", text: "WARP FIELD · 20% SHIELD RESISTANCE · 2%/S RECHARGE AFTER 5S WITHOUT DAMAGE" }
        : isResourceExtractorType(primary.type)
        ? { icon: "+A", text: `ALLOY UPLINK +${definition.alloyIncome}` }
        : primary.type === "alloyRefinery" || primary.type === "matterForge"
          ? { icon: "+A", text: `DIRECT ALLOY +${definition.alloyIncome}/S · −${definition.energyUpkeep}E/S` }
        : primary.type === "storage" || primary.type === "quantumStorage"
          ? { icon: "+CAP", text: `STORAGE +${definition.alloyStorage}A · +${definition.energyStorage}E` }
        : primary.type === "advancedFabrication" || primary.type === "capitalInfrastructure"
          ? { icon: STRUCTURE_ICONS[primary.type], text: structureMechanicsDescription(primary.type) }
        : primary.type === "radarArray" || primary.type === "phasedRadarArray" || primary.type === "deepSpaceRadarArray"
          ? { icon: STRUCTURE_ICONS[primary.type], text: `LONG-RANGE SENSOR ${definition.sensorRange} · NO UPKEEP` }
        : isDefensiveStructureType(primary.type)
          ? { icon: STRUCTURE_ICONS[primary.type], text: `${fortressLoadoutSummary(primary.type)} · −${definition.energyUpkeep}E/S` }
          : { icon: "+E", text: `ENERGY GRID +${definition.energyIncome}` };
      empty.classList.remove("hidden");
      empty.innerHTML = `<span>${passiveCopy.icon}</span><p>${passiveCopy.text}</p>`;
      element("command-context-title").textContent = structureLabel(primary.type, primary.ownerPlayerId);
      element("command-context-subtitle").textContent = "PASSIVE STRUCTURE";
    }
    return;
  }

  const counts = new Map<ShipClass, number>();
  for (const ship of ships) counts.set(ship.class, (counts.get(ship.class) ?? 0) + 1);
  const health = ships.reduce((sum, ship) => sum + ship.health, 0);
  const maxHealth = ships.reduce((sum, ship) => sum + getFactionShipDefinition(ship.class, ship.faction).maxHealth, 0);
  const shields = ships.reduce((sum, ship) => sum + ship.shields, 0);
  const maxShields = ships.reduce((sum, ship) => sum + getFactionShipDefinition(ship.class, ship.faction).maxShield, 0);
  const sharedClass = counts.size === 1 ? ships[0]!.class : null;
  eyebrow.textContent = ships.length === 1 ? "SELECTED VESSEL" : `${ships.length} UNIT CONTROL GROUP`;
  title.textContent = ships.length === 1
    ? shipLabel(ships[0]!.class, ships[0]!.faction)
    : sharedClass === "fighter"
      ? `${shipLabel("fighter", ships[0]!.faction)} GROUP`
      : sharedClass
        ? `${shipLabel(sharedClass, ships[0]!.faction)} GROUP`
        : "MIXED FLEET";
  const composition = [...counts.entries()].map(([type, count]) => `${count} ${shipLabel(type, ships[0]!.faction)}`).join(" · ");
  const sharedArmor = sharedClass ? `${SHIPS[sharedClass].armorType.toUpperCase()} ARMOR` : "MIXED ARMOR";
  const selectedArtilleryWeapon = ships.length === 1 ? artilleryWeaponForShip(ships[0]!.class) : undefined;
  const artillerySetupTicks = selectedArtilleryWeapon?.artillery?.setupTicks ?? 1;
  const tacticalState = ships.length === 1 && selectedArtilleryWeapon
    ? isShipCruising(ships[0]!)
      ? "CRUISING · DEPLOYMENT RESET"
      : (ships[0]!.artilleryDeploymentTicks ?? 0) >= artillerySetupTicks
        ? "ARTILLERY DEPLOYED"
        : `DEPLOYING ${Math.floor((ships[0]!.artilleryDeploymentTicks ?? 0) / artillerySetupTicks * 100)}%`
    : ships.some(isShipCruising) ? "CRUISE DRIVE" : "TACTICAL DRIVE";
  const fieldKind = getPlayerFaction() === "brood" ? "creep" : "pylon";
  const covered = getPlayerFaction() === "industrial" ? 0 : ships.filter((ship) =>
    isInTerritory(visibleTerritories(), ship.ownerPlayerId, fieldKind, ship)).length;
  const fieldBonus = covered === 0 ? "" : fieldKind === "creep"
    ? ` · ${covered} ON CREEP: +20% SPEED / +10% DAMAGE` : ` · ${covered} IN PYLON FIELD: SHIELDS FORTIFIED`;
  summary.textContent = `${composition} · ${sharedArmor} · ${tacticalState}${fieldBonus}`;
  if (ships.length === 1 && ships[0]!.class === "fighter") {
    icon.classList.add("fighter-squad-symbol");
    icon.textContent = "⌃\n⌃ ⌃\n⌃ ⌃";
  } else {
    icon.textContent = ships.length === 1
      ? ships[0]!.class === "fabricator" ? "⌁"
        : ships[0]!.class === "carrier" ? "▣"
        : ships[0]!.class === "battleship" ? "⬣"
          : ships[0]!.class === "cruiser" || ships[0]!.class === "destroyer" ? "⬢"
            : ships[0]!.class === "bomber" ? "◆" : "△"
      : "◈";
  }
  bars.innerHTML = selectionMetersHtml(health, maxHealth, shields, maxShields);
  if (ships.length > 1) renderSelectionRoster(ships);
  const mobileBuilders = ships.filter((ship) => SHIPS[ship.class].buildPower > 0);
  if (mobileBuilders.length === ships.length) {
    constructionControls.classList.remove("hidden");
    renderSelectedConstructionQueue(mobileBuilders);
    element("command-context-title").textContent = "MOBILE CONSTRUCTION";
    element("command-context-subtitle").textContent = ships.length === 1
      ? `FABRICATOR ${ships[0]!.id} · ${SHIPS[ships[0]!.class].buildPower.toFixed(2)}× POWER`
      : `${ships.length} FABRICATORS LINKED`;
  } else {
    fleetControls.classList.remove("hidden");
    element("command-context-title").textContent = "FLEET COMMANDS";
    element("command-context-subtitle").textContent = ships.length === 1 ? `VESSEL ${ships[0]!.id}` : `${ships.length} VESSELS LINKED`;
  }
}

function selectionMetersHtml(health: number, maxHealth: number, shields: number, maxShields: number): string {
  const hullPercent = Math.round(THREE.MathUtils.clamp(health / Math.max(1, maxHealth), 0, 1) * 100);
  const shieldPercent = Math.round(THREE.MathUtils.clamp(shields / Math.max(1, maxShields), 0, 1) * 100);
  const hull = `<i style="--value:${hullPercent}%" data-label="H ${hullPercent}%" title="Hull ${Math.ceil(health)} / ${Math.ceil(maxHealth)}"></i>`;
  const shield = maxShields > 0
    ? `<i class="shield" style="--value:${shieldPercent}%" data-label="S ${shieldPercent}%" title="Shields ${Math.ceil(shields)} / ${Math.ceil(maxShields)}"></i>`
    : "";
  return hull + shield;
}

function renderSelectedProduction(): void {
  const shipyards = getSelectedShipyards();
  const console = element("selection-queue");
  if (shipyards.length === 0) {
    console.classList.add("hidden");
    return;
  }
  console.classList.remove("hidden");
  console.classList.remove("construction-mode");
  element("cancel-production").classList.toggle("hidden", getPlayerFaction() === "brood");
  element("production-queue-actions").classList.remove("hidden");
  element("construction-queue-actions").classList.add("hidden");
  if (getPlayerFaction() === "brood") {
    element("production-queue-actions").classList.add("hidden");
    const live = new Map<number, number>();
    for (const ship of clientView.ships) if (ship.broodNestId !== undefined) live.set(ship.broodNestId, (live.get(ship.broodNestId) ?? 0) + 1);
    const primary = shipyards.find((yard) => yard.id === primaryStructureId) ?? shipyards[0]!;
    const progress = primary.broodProgress ?? 0;
    const capacity = shipyards.reduce((sum, yard) => sum + (yard.broodClass ? BROOD_CAPACITY[yard.broodClass] : 0), 0);
    const count = shipyards.reduce((sum, yard) => sum + (live.get(yard.id) ?? 0), 0);
    element("queue-count").textContent = `BROOD ${count} / ${capacity}`;
    element("production-idle-upkeep").textContent = `${shipyards.reduce((sum, yard) => sum + STRUCTURES[yard.type].energyUpkeep, 0)} E/S`;
    element("production-active-load").textContent = "FREE REPLACEMENTS";
    element("production-label").textContent = !primary.broodClass ? "CHOOSE A PERMANENT SPECIALIZATION BELOW"
      : !isInTerritory(visibleTerritories(), localPlayerId, "creep", primary) ? "HATCHING PAUSED // NEEDS CREEP"
      : (live.get(primary.id) ?? 0) >= BROOD_CAPACITY[primary.broodClass] ? "POPULATION COMPLETE // REPLACES LOSSES"
      : `${shipLabel(primary.broodClass)} // HATCHING ${Math.floor(progress * 100)}%`;
    element("production-progress").style.width = `${progress * 100}%`;
    element("queue-items").innerHTML = shipyards.map((yard) => `<span class="brood-population">N${yard.id} · ${yard.broodClass ? `${shipLabel(yard.broodClass)} ${live.get(yard.id) ?? 0}/${BROOD_CAPACITY[yard.broodClass]}` : "UNSPECIALIZED"}</span>`).join("");
    return;
  }
  const totalQueued = shipyards.reduce((sum, shipyard) => sum + shipyard.productionQueue.length, 0);
  const activeShipyards = shipyards.filter((shipyard) => shipyard.productionQueue[0]);
  const drawingShipyards = activeShipyards.filter((shipyard) => {
    const item = shipyard.productionQueue[0];
    return item !== undefined && item.progress < 1 && canProduceShipInView(localPlayerId, item.shipClass, shipyard.id);
  });
  const idleUpkeep = shipyards.reduce((sum, shipyard) => sum + STRUCTURES[shipyard.type].energyUpkeep, 0);
  const activeAlloyLoad = drawingShipyards.reduce((sum, shipyard) => {
    const production = getFactionShipEconomy(shipyard.productionQueue[0]!.shipClass, getPlayerFaction());
    return sum + production.alloyCost / (production.buildTicks * FIXED_DT);
  }, 0);
  const activeEnergyLoad = drawingShipyards.reduce((sum, shipyard) => {
    const production = getFactionShipEconomy(shipyard.productionQueue[0]!.shipClass, getPlayerFaction());
    return sum + production.energyCost / (production.buildTicks * FIXED_DT);
  }, 0);
  element("production-idle-upkeep").textContent = idleUpkeep > 0 ? `−${tooltipNumber(idleUpkeep)} E/S` : "NONE";
  element("production-active-load").textContent = drawingShipyards.length > 0
    ? `−${tooltipNumber(activeAlloyLoad)} A/S · −${tooltipNumber(activeEnergyLoad)} E/S`
    : "NONE";
  const primary = shipyards.find((shipyard) => shipyard.id === primaryStructureId) ?? activeShipyards[0] ?? shipyards[0]!;
  const activeItem = primary.productionQueue[0];
  const activeProductionOnline = !activeItem || canProduceShipInView(localPlayerId, activeItem.shipClass, primary.id);
  element("queue-count").textContent = shipyards.length === 1
    ? `QUEUE ${totalQueued}`
    : `${shipyards.length} YARDS · ${totalQueued} QUEUED`;
  element("production-label").textContent = shipyards.length === 1
    ? activeItem
      ? `${shipLabel(activeItem.shipClass)}${getFactionShipEconomy(activeItem.shipClass, getPlayerFaction()).batchSize > 1 ? ` ×${getFactionShipEconomy(activeItem.shipClass, getPlayerFaction()).batchSize}` : ""} // ${activeItem.progress >= 1 ? "READY · SET WARP / CLEAR ARRIVAL SPACE" : activeProductionOnline ? `${Math.floor(activeItem.progress * 100)}%` : "YARD OFFLINE"}`
      : `SHIPYARD ${primary.id} // IDLE`
    : `${activeShipyards.length} / ${shipyards.length} SHIPYARDS ACTIVE`;
  const progress = shipyards.length === 1
    ? activeItem?.progress ?? 0
    : activeShipyards.reduce((sum, shipyard) => sum + (shipyard.productionQueue[0]?.progress ?? 0), 0) / Math.max(1, activeShipyards.length);
  element("production-progress").style.width = `${progress * 100}%`;
  element<HTMLButtonElement>("cancel-production").disabled = activeShipyards.length === 0;
  const repeatingShipyards = shipyards.filter((shipyard) => shipyard.repeatProduction);
  const allRepeating = repeatingShipyards.length === shipyards.length;
  const mixedRepeating = repeatingShipyards.length > 0 && !allRepeating;
  const infiniteButton = element<HTMLButtonElement>("toggle-infinite-production");
  infiniteButton.classList.toggle("active", allRepeating);
  infiniteButton.classList.toggle("mixed", mixedRepeating);
  infiniteButton.setAttribute("aria-pressed", allRepeating ? "true" : "false");
  element("infinite-production-state").textContent = allRepeating ? "ON" : mixedRepeating ? "MIXED" : "OFF";
  element<HTMLButtonElement>("stop-production-all").disabled = totalQueued === 0 && repeatingShipyards.length === 0;
  element("queue-items").innerHTML = shipyards.map((shipyard, yardIndex) => {
    const label = shipyards.length > 1 ? `<span class="queue-lane-label">Y${shipyard.id}</span>` : "";
    const tokens = shipyard.productionQueue.map((item, itemIndex) => {
      const abbreviation = SHIP_ABBREVIATIONS[item.shipClass];
      const batchLabel = getFactionShipEconomy(item.shipClass, getPlayerFaction()).batchSize > 1 ? `×${getFactionShipEconomy(item.shipClass, getPlayerFaction()).batchSize}` : "";
      const progressLabel = itemIndex === 0 ? `<em>${Math.floor(item.progress * 100)}%</em>` : "";
      return `<button class="queue-token" data-structure-id="${shipyard.id}" data-queue-item-id="${item.id}" title="Cancel ${shipLabel(item.shipClass)}${batchLabel ? " squad" : ""}">${abbreviation}${batchLabel}${progressLabel}</button>`;
    }).join("");
    const separator = yardIndex < shipyards.length - 1 ? '<span class="queue-lane-separator"></span>' : "";
    return `${label}${tokens || '<span class="queue-lane-label">IDLE</span>'}${separator}`;
  }).join("");
}

function selectedBuilderBuildOrders(builderIds: ReadonlySet<number>): Extract<EconomyCommand, { type: "buildStructure" }>[] {
  const commands = networkMode
    ? [...pendingNetworkBuilds.values()]
    : simulation.state.commandQueue.filter((command): command is Extract<GameCommand, { type: "buildStructure" }> =>
      command.type === "buildStructure",
    );
  return commands
    .filter((command) => command.playerId === localPlayerId
      && (command.builderUnitIds ?? []).some((builderId) => builderIds.has(builderId)))
    .sort((left, right) => left.sequence - right.sequence);
}

function renderSelectedConstructionQueue(builders: readonly ShipState[]): void {
  const console = element("selection-queue");
  const builderIds = new Set(builders.map((builder) => builder.id));
  const activeConstructionIds = new Set(builders.flatMap((builder) =>
    builder.orders.flatMap((order) => order.constructionId === undefined ? [] : [order.constructionId])));
  const activeSites = clientView.structures
    .filter((structure) => activeConstructionIds.has(structure.id) && structure.buildProgress < 1)
    .sort((left, right) => left.id - right.id);
  const queuedOrders = selectedBuilderBuildOrders(builderIds);
  const active = activeSites[0];
  console.classList.remove("hidden");
  console.classList.add("construction-mode");
  element("production-queue-actions").classList.add("hidden");
  element("construction-queue-actions").classList.remove("hidden");
  element("production-label").textContent = active
    ? `${structureLabel(active.type)} // ${Math.floor(active.buildProgress * 100)}%`
    : queuedOrders.length > 0 ? "FABRICATORS EN ROUTE" : "BUILD ROUTE IDLE";
  element("queue-count").textContent = `${activeSites.length} ACTIVE · ${queuedOrders.length} QUEUED`;
  element("production-progress").style.width = `${(active?.buildProgress ?? 0) * 100}%`;
  element<HTMLButtonElement>("clear-build-queue").disabled = queuedOrders.length === 0;
  const activeTokens = activeSites.map((site) =>
    `<button class="queue-token active-construction" data-construction-id="${site.id}" title="Cancel active ${escapeHtml(structureLabel(site.type))}">${escapeHtml(STRUCTURE_ICONS[site.type])}<em>${Math.floor(site.buildProgress * 100)}%</em></button>`);
  const queuedTokens = queuedOrders.map((command, index) =>
    `<button class="queue-token queued-construction" data-build-sequence="${command.sequence}" title="Cancel queued ${escapeHtml(structureLabel(command.structureType))}">${escapeHtml(STRUCTURE_ICONS[command.structureType])}<em>${index + 1}</em></button>`);
  element("queue-items").innerHTML = [...activeTokens, ...queuedTokens].join("")
    || '<span class="queue-lane-label">HOLD SHIFT WHILE PLACING TO QUEUE A BUILD ROUTE</span>';
}

function setRallyPointMode(enabled: boolean, warp = false): void {
  if (enabled && !canIssuePlayerCommands()) {
    showToast(clientViewMode === "team-spectator" ? "TEAM SPECTATOR // VIEW ONLY" : "REPLAY // VIEW ONLY");
    return;
  }
  if (enabled && getSelectedShipyards().length === 0) {
    showToast("SELECT A COMPLETED SHIPYARD");
    return;
  }
  if (enabled) {
    setCommandMode(null);
    setStructureMode(null);
  }
  pendingRallyPoint = enabled;
  pendingWarpPoint = enabled && warp;
  element("set-rally").classList.toggle("active", enabled && !warp);
  element("set-warp").classList.toggle("active", enabled && warp);
  const banner = element("command-mode");
  banner.classList.toggle("visible", enabled || pendingCommandMode !== null || pendingStructureType !== null);
  if (enabled) banner.textContent = warp ? "WARP POINT // SELECT OWN PYLON FIELD" : "RALLY POINT // SELECT DESTINATION";
}

function setCommandMode(mode: "move" | "attackMove" | "patrol" | "focusFire" | null): void {
  if (mode !== null && !canIssuePlayerCommands()) {
    showToast(clientViewMode === "team-spectator" ? "TEAM SPECTATOR // VIEW ONLY" : "REPLAY // VIEW ONLY");
    return;
  }
  if (mode !== null && getSelectedShips().length === 0) {
    showToast("SELECT YOUR UNITS FIRST");
    return;
  }
  if (mode !== null) {
    setStructureMode(null);
    setRallyPointMode(false);
  }
  pendingCommandMode = mode;
  element("cmd-move").classList.toggle("active", mode === "move");
  element("cmd-attack").classList.toggle("active", mode === "attackMove");
  element("cmd-patrol").classList.toggle("active", mode === "patrol");
  element("focus").classList.toggle("active", mode === "focusFire");
  const banner = element("command-mode");
  banner.classList.toggle("visible", mode !== null);
  banner.textContent = mode === "focusFire"
    ? "FOCUS FIRE // SELECT HOSTILE CONTACT"
    : mode === "attackMove"
    ? "ATTACK-MOVE // CLICK OR DRAG FORMATION"
    : mode === "patrol"
      ? "PATROL // SELECT ENDPOINT OR DRAG FORMATION"
    : mode === "move"
      ? "MOVE // CLICK OR DRAG FORMATION"
      : "";
}

function economyCost(alloyCost: number, energyCost: number): string {
  return `${alloyCost}A · ${energyCost}E`;
}

function missingStructureRequirements(type: BuildableStructureType): StructureType[] {
  const completedTypes = new Set(clientView.structures
    .filter((structure) => structure.ownerPlayerId === localPlayerId && structure.buildProgress >= 1)
    .map((structure) => structure.type));
  return STRUCTURES[type].requiredStructures.filter((requiredType) => !completedTypes.has(requiredType));
}

function setProgressionButtonState(button: HTMLButtonElement, unlocked: boolean, requirement: string): void {
  const available = canIssuePlayerCommands() && unlocked;
  button.disabled = !available;
  button.classList.toggle("locked", !available);
  const lock = button.querySelector<HTMLElement>(".command-lock");
  const unavailableReason = canIssuePlayerCommands() ? requirement : "VIEW ONLY";
  if (lock) lock.textContent = available ? "" : unavailableReason;
  button.title = available ? "" : unavailableReason;
}

function updateConstructionHotkeyHints(): void {
  for (const tier of Object.keys(CONSTRUCTION_HOTKEYS) as ConstructionTier[]) {
    for (const hotkey of CONSTRUCTION_HOTKEYS[tier]) {
      const button = element<HTMLButtonElement>(STRUCTURE_BUTTON_IDS[hotkey.structureType]);
      let hint = button.querySelector<HTMLElement>("kbd.construction-hotkey");
      if (!hint) {
        hint = document.createElement("kbd");
        hint.className = "construction-hotkey";
        button.append(hint);
      }
      hint.textContent = hotkey.label;
      button.setAttribute("aria-keyshortcuts", hotkey.label);
    }
  }
}

function constructionHotkeyStructureType(code: string): BuildableStructureType | null {
  return CONSTRUCTION_HOTKEYS[activeConstructionTier]
    .find((hotkey) => hotkey.code === code)?.structureType ?? null;
}

function constructionHotkeyTier(code: string): ConstructionTier | null {
  return (Object.keys(CONSTRUCTION_TIER_HOTKEYS) as ConstructionTier[])
    .find((tier) => CONSTRUCTION_TIER_HOTKEYS[tier].code === code) ?? null;
}

function constructionControlsActive(): boolean {
  return !element("construction-controls").classList.contains("hidden");
}

function selectedProductionYardType(): ShipyardType | null {
  const shipyards = getSelectedShipyards();
  const primary = shipyards.find((shipyard) => shipyard.id === primaryStructureId) ?? shipyards[0];
  return (primary?.type as ShipyardType | undefined) ?? null;
}

function updateProductionHotkeyHints(): void {
  const yardType = selectedProductionYardType();
  const hotkeyByClass = new Map((yardType ? PRODUCTION_HOTKEYS[yardType] : [])
    .map((hotkey) => [hotkey.shipClass, hotkey]));
  for (const shipClass of SHIP_CLASSES) {
    const button = element<HTMLButtonElement>(SHIP_BUTTON_IDS[shipClass]);
    const hotkey = hotkeyByClass.get(shipClass);
    let hint = button.querySelector<HTMLElement>("kbd.production-hotkey");
    if (!hotkey) {
      hint?.remove();
      continue;
    }
    if (!hint) {
      hint = document.createElement("kbd");
      hint.className = "production-hotkey";
      button.append(hint);
    }
    hint.textContent = hotkey.label;
  }
}

function productionHotkeyShipClass(code: string): ShipClass | null {
  const yardType = selectedProductionYardType();
  return yardType
    ? PRODUCTION_HOTKEYS[yardType].find((hotkey) => hotkey.code === code)?.shipClass ?? null
    : null;
}

function updateProductionRosterVisibility(): void {
  const selectedYardTypes = new Set(getSelectedShipyards().map((yard) => yard.type));
  for (const shipClass of SHIP_CLASSES) {
    element<HTMLButtonElement>(SHIP_BUTTON_IDS[shipClass]).classList.toggle(
      "hidden",
      !selectedYardTypes.has(SHIP_ECONOMY[shipClass].yardType) || !FACTIONS[getPlayerFaction()].ships.includes(shipClass),
    );
  }
  element("set-warp").classList.toggle("hidden", getPlayerFaction() !== "concord");
  updateProductionHotkeyHints();
}

function updateProgressionControls(): void {
  updateConstructionHotkeyHints();
  const availableStructureTypes = new Set(BUILDABLE_STRUCTURE_TYPES.filter((type) => canBuildStructureInView(localPlayerId, type)));
  for (const structureType of BUILDABLE_STRUCTURE_TYPES) {
    const definition = getFactionStructureDefinition(structureType, getPlayerFaction());
    const button = element<HTMLButtonElement>(STRUCTURE_BUTTON_IDS[structureType]);
    button.classList.toggle("hidden", !factionAllowsStructure(getPlayerFaction(), structureType));
    const label = button.querySelector<HTMLElement>("span");
    if (label) label.textContent = structureLabel(structureType);
    const cost = button.querySelector<HTMLElement>("small");
    if (cost) cost.textContent = economyCost(definition.alloyCost, definition.energyCost);
    const missing = missingStructureRequirements(structureType);
    setProgressionButtonState(
      button,
      availableStructureTypes.has(structureType),
      `NEEDS ${missing.map((type) => structureLabel(type)).join(" + ") || "PREREQUISITE"}`,
    );
  }

  const selectedYards = getSelectedShipyards();
  updateProductionRosterVisibility();
  for (const shipClass of SHIP_CLASSES) {
    const definition = getFactionShipEconomy(shipClass, getPlayerFaction());
    const button = element<HTMLButtonElement>(SHIP_BUTTON_IDS[shipClass]);
    const label = button.querySelector<HTMLElement>("span");
    if (label) label.textContent = shipLabel(shipClass);
    const badge = button.querySelector<HTMLElement>("b");
    const cost = button.querySelector<HTMLElement>("small");
    if (badge) badge.textContent = definition.batchSize > 1
      ? `${SHIP_ABBREVIATIONS[shipClass]}×${definition.batchSize}`
      : SHIP_ABBREVIATIONS[shipClass];
    if (cost) cost.textContent = getPlayerFaction() === "brood"
      ? `MAINTAINS ${BROOD_CAPACITY[shipClass]} · FREE REPLACEMENTS` : economyCost(definition.alloyCost, definition.energyCost);
    const missing = definition.requiredStructures.filter((requiredType) => !clientView.structures.some((structure) =>
      structure.ownerPlayerId === localPlayerId && structure.type === requiredType && structure.buildProgress >= 1,
    ));
    const correctYardSelected = selectedYards.some((yard) => yard.type === definition.yardType);
    const requirement = getPlayerFaction() === "brood" && selectedYards.every((yard) => yard.broodClass !== undefined)
      ? "NEST SPECIALIZATION IS PERMANENT" : !correctYardSelected
      ? `NEEDS ${structureLabel(definition.yardType)}`
      : `NEEDS ${missing.map((type) => structureLabel(type)).join(" + ") || "TECH"}`;
    setProgressionButtonState(
      button,
      selectedYards.some((yard) => canProduceShipInView(localPlayerId, shipClass, yard.id)),
      requirement,
    );
  }
}

function setConstructionCategory(category: ConstructionTier): void {
  activeConstructionTier = category;
  for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-construction-tab]")) {
    const active = tab.dataset.constructionTab === category;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-pressed", active.toString());
  }
  for (const panel of document.querySelectorAll<HTMLElement>("[data-construction-category]")) {
    panel.classList.toggle("active", panel.dataset.constructionCategory === category);
  }
}

function setStructureMode(type: BuildableStructureType | null): void {
  if (type !== null && !canIssuePlayerCommands()) {
    showToast(clientViewMode === "team-spectator" ? "TEAM SPECTATOR // VIEW ONLY" : "REPLAY // VIEW ONLY");
    return;
  }
  if (type !== null && getSelectedBuilders().length === 0) {
    showToast("SELECT A COMPLETED CORE OR FABRICATOR");
    return;
  }
  if (type !== null && !canBuildStructureInView(localPlayerId, type)) {
    const missing = missingStructureRequirements(type).map((type) => structureLabel(type)).join(" + ");
    showToast(`${structureLabel(type)} LOCKED // NEEDS ${missing || "TECH"}`);
    return;
  }
  pendingStructureType = type;
  buildPlacementDrag = null;
  placementGhost.rotation.y = 0;
  placementGhost.visible = false;
  for (const structureType of BUILDABLE_STRUCTURE_TYPES) {
    element(STRUCTURE_BUTTON_IDS[structureType]).classList.toggle("active", type === structureType);
  }
  if (type !== null) {
    setCommandMode(null);
    setRallyPointMode(false);
  }
  const banner = element("command-mode");
  banner.classList.toggle("visible", type !== null || pendingCommandMode !== null || pendingRallyPoint);
  if (type !== null) banner.textContent = `${structureLabel(type)} // CLICK PLACE · DRAG ROTATE · SHIFT QUEUE · RMB CANCEL`;
}

function structureLabel(type: StructureType, playerId = localPlayerId): string {
  return factionStructureName(type, getPlayerFaction(playerId))?.toUpperCase() ?? STRUCTURE_LABELS[type];
}

function canPlaceStructureInView(
  structureType: BuildableStructureType,
  position: Readonly<{ x: number; z: number }>,
  resourceNodeId?: number,
): boolean {
  if (!canBuildStructureInView(localPlayerId, structureType)) return false;
  if (structureType === "creepNode" && !isInTerritory(visibleTerritories(), localPlayerId, "creep", position)) return false;
  const definition = getFactionStructureDefinition(structureType, getPlayerFaction());
  const upgradeSource = resourceExtractorUpgradeSourceInView(structureType, resourceNodeId);
  const hasAssignedMobileBuilder = getSelectedMobileBuilderIds().length > 0;
  // Legacy medium/large matches placed their initial expansion nodes just past
  // the normal 360-unit construction radius. Preserve those live matches while
  // keeping the standard range for every non-extractor structure.
  const staticBuildRange = isResourceExtractorType(structureType) ? 420 : 360;
  const inBuildRange = clientView.structures.some((structure) =>
    structure.ownerPlayerId === localPlayerId
      && structure.buildProgress >= 1
      && (structure.type === "commandCore" || structure.type === "fabricator")
      && Math.hypot(structure.x - position.x, structure.z - position.z) <= staticBuildRange,
  ) || hasAssignedMobileBuilder;
  if (!inBuildRange) return false;
  for (const structure of clientView.structures) {
    if (structure.id === upgradeSource?.id) continue;
    if (Math.hypot(structure.x - position.x, structure.z - position.z)
      < STRUCTURES[structure.type].radius + definition.radius + 8) return false;
  }
  for (const obstacle of clientView.state.obstacles) {
    if (obstacle.type === "barrier" && obstacle.width && obstacle.depth) {
      const nearestX = THREE.MathUtils.clamp(position.x, obstacle.x - obstacle.width / 2, obstacle.x + obstacle.width / 2);
      const nearestZ = THREE.MathUtils.clamp(position.z, obstacle.z - obstacle.depth / 2, obstacle.z + obstacle.depth / 2);
      if (Math.hypot(position.x - nearestX, position.z - nearestZ) < definition.radius + 8) return false;
    } else if (Math.hypot(obstacle.x - position.x, obstacle.z - position.z) < obstacle.radius + definition.radius + 8) return false;
  }
  const queuedBuilds = networkMode
    ? pendingNetworkBuilds.values()
    : simulation.state.commandQueue.filter((command): command is Extract<GameCommand, { type: "buildStructure" }> =>
      command.type === "buildStructure",
    );
  for (const command of queuedBuilds) {
      if (command.type !== "buildStructure" || command.playerId !== localPlayerId) continue;
      if (isResourceExtractorType(structureType)
        && isResourceExtractorType(command.structureType)
        && command.resourceNodeId === resourceNodeId) continue;
      const commandNode = command.resourceNodeId === undefined
        ? undefined
        : clientView.resourceNodes.find((candidate) => candidate.id === command.resourceNodeId);
      const reservedPosition = commandNode ?? command.position;
      if (Math.hypot(reservedPosition.x - position.x, reservedPosition.z - position.z)
        < STRUCTURES[command.structureType].radius + definition.radius + 8) return false;
  }
  if (!isResourceExtractorType(structureType)) return resourceNodeId === undefined;
  const node = clientView.resourceNodes.find((candidate) => candidate.id === resourceNodeId);
  const knownClaim = node?.claimedByStructureId !== null
    && node?.claimedByStructureId !== undefined
    && clientView.visibleEntityIds.has(node.claimedByStructureId);
  return Boolean(node && (!knownClaim || upgradeSource !== null)
    && Math.hypot(node.x - position.x, node.z - position.z) <= 34);
}

function getPlacementCandidate(clientX: number, clientY: number): {
  position: THREE.Vector3;
  nodeId?: number;
  valid: boolean;
} | null {
  if (!pendingStructureType) return null;
  const point = getWorldPoint(clientX, clientY);
  if (!point) return null;
  let nodeId: number | undefined;
  if (isResourceExtractorType(pendingStructureType)) {
    const extractorType = pendingStructureType;
    const node = clientView.resourceNodes
      .filter((candidate) => candidate.claimedByStructureId === null
        || resourceExtractorUpgradeSourceInView(extractorType, candidate.id) !== null
        || !clientView.visibleEntityIds.has(candidate.claimedByStructureId))
      .sort((a, b) => Math.hypot(a.x - point.x, a.z - point.z) - Math.hypot(b.x - point.x, b.z - point.z) || a.id - b.id)[0];
    if (node && Math.hypot(node.x - point.x, node.z - point.z) <= 60) {
      point.set(node.x, 0, node.z);
      nodeId = node.id;
    }
  }
  return {
    position: point,
    valid: canPlaceStructureInView(pendingStructureType, point, nodeId),
    ...(nodeId === undefined ? {} : { nodeId }),
  };
}

function updatePlacementGhost(clientX: number, clientY: number): void {
  const candidate = getPlacementCandidate(clientX, clientY);
  if (!candidate || !pendingStructureType) { placementGhost.visible = false; return; }
  const definition = STRUCTURES[pendingStructureType];
  placementGhost.visible = true;
  placementGhost.position.copy(candidate.position);
  placementBody.scale.set(definition.radius, 1, definition.radius);
  placementRing.scale.set(definition.radius, definition.radius, definition.radius);
  const color = candidate.valid ? 0x62dcff : 0xff5278;
  placementMaterial.color.setHex(color);
  placementRingMaterial.color.setHex(color);
}

function issueBuildStructure(
  candidate: NonNullable<ReturnType<typeof getPlacementCandidate>>,
  keepPlacing: boolean,
  yaw = 0,
): void {
  if (!pendingStructureType || !candidate.valid) {
    showToast("INVALID BUILD SITE");
    return;
  }
  commandSequence += 1;
  const command: EconomyCommand = {
    type: "buildStructure", playerId: localPlayerId, sequence: commandSequence,
    requestedTick: nextCommandTick(), structureType: pendingStructureType,
    position: { x: candidate.position.x, z: candidate.position.z }, queued: keepPlacing,
    yaw,
    builderUnitIds: getSelectedMobileBuilderIds(),
    ...(candidate.nodeId === undefined ? {} : { resourceNodeId: candidate.nodeId }),
  };
  const result = submitPlayerCommand(command);
  if (result.accepted) {
    if (networkMode) pendingNetworkBuilds.set(command.sequence, command);
    showCommandMarker(candidate.position);
    element("directive").textContent = `${structureLabel(pendingStructureType)} CONSTRUCTION QUEUED`;
    showToast("CONSTRUCTION ORDER");
  } else {
    showToast(`BUILD REJECTED // ${result.reason.toUpperCase()}`);
  }
  if (!keepPlacing) setStructureMode(null);
}

function issueCancelConstruction(structureId: number): boolean {
  const construction = clientView.structures.find((structure) =>
    structure.id === structureId
    && structure.ownerPlayerId === localPlayerId
    && structure.buildProgress < 1,
  );
  if (!construction) return false;
  commandSequence += 1;
  const result = submitPlayerCommand({
    type: "cancelConstruction", playerId: localPlayerId, sequence: commandSequence,
    requestedTick: nextCommandTick(), structureId,
  });
  if (!result.accepted) {
    showToast(`CANCEL REJECTED // ${result.reason.toUpperCase()}`);
    return false;
  }
  element("directive").textContent = `${structureLabel(construction.type)} CONSTRUCTION CANCELLED`;
  showToast("CONSTRUCTION CANCELLED");
  return true;
}

function issueCancelBuildOrder(buildSequence: number, notify = true): boolean {
  const pending = pendingNetworkBuilds.get(buildSequence)
    ?? simulation.state.commandQueue.find((command): command is Extract<GameCommand, { type: "buildStructure" }> =>
      command.type === "buildStructure" && command.playerId === localPlayerId && command.sequence === buildSequence,
    );
  if (!pending) return false;
  commandSequence += 1;
  const result = submitPlayerCommand({
    type: "cancelBuildOrder", playerId: localPlayerId, sequence: commandSequence,
    requestedTick: nextCommandTick(), buildSequence,
  });
  if (!result.accepted) {
    if (notify) showToast(`QUEUE CANCEL REJECTED // ${result.reason.toUpperCase()}`);
    return false;
  }
  if (networkMode) pendingNetworkBuilds.delete(buildSequence);
  if (notify) showToast(`${structureLabel(pending.structureType)} ORDER CANCELLED`);
  return true;
}

function clearSelectedBuildQueue(): void {
  const builderIds = new Set(getSelectedShips()
    .filter((ship) => SHIPS[ship.class].buildPower > 0)
    .map((ship) => ship.id));
  const queuedOrders = selectedBuilderBuildOrders(builderIds);
  const cancelled = queuedOrders.reduce((total, command) =>
    total + Number(issueCancelBuildOrder(command.sequence, false)), 0);
  if (cancelled > 0) {
    element("directive").textContent = `BUILD ROUTE CLEARED // ${cancelled} SITE${cancelled === 1 ? "" : "S"}`;
    showToast(`BUILD ROUTE CLEARED // ${cancelled}`);
  }
}

function issueQueueUnit(shipClass: ShipClass, count: number): void {
  if (getPlayerFaction() === "brood") count = 1;
  if (!canProduceShipInView(localPlayerId, shipClass)) {
    const definition = getFactionShipEconomy(shipClass, getPlayerFaction());
    showToast(`${shipLabel(shipClass)} LOCKED // NEEDS ${structureLabel(definition.yardType)}`);
    return;
  }
  const shipyards = getSelectedShipyards().filter((yard) => canProduceShipInView(localPlayerId, shipClass, yard.id));
  if (shipyards.length === 0) {
    showToast(`SELECT A ${structureLabel(SHIP_ECONOMY[shipClass].yardType)}`);
    return;
  }
  const ordered = [...shipyards].sort((a, b) =>
    Number(b.id === primaryStructureId) - Number(a.id === primaryStructureId) || a.id - b.id,
  );
  let acceptedCount = 0;
  let rejection: string | null = null;
  for (const shipyard of ordered) {
    commandSequence += 1;
    const command: EconomyCommand = {
      type: "queueUnit", playerId: localPlayerId, sequence: commandSequence,
      requestedTick: nextCommandTick(), structureId: shipyard.id, shipClass, count,
    };
    const result = submitPlayerCommand(command);
    if (result.accepted) acceptedCount += count;
    else rejection = result.reason.toUpperCase();
  }
  if (acceptedCount > 0) {
    if (getPlayerFaction() === "brood") {
      showToast(`${shipLabel(shipClass)} SPECIALIZED // ${BROOD_CAPACITY[shipClass]} CAPACITY PER NEST`);
      return;
    }
    const cost = getFactionShipEconomy(shipClass, getPlayerFaction());
    const hullCount = acceptedCount * cost.batchSize;
    const batchDescription = shipClass === "fighter"
      ? `${hullCount} SQUADRON${hullCount === 1 ? "" : "S"} / ${hullCount * 5} CRAFT`
      : cost.batchSize > 1
        ? `${acceptedCount} SQUAD${acceptedCount === 1 ? "" : "S"} / ${hullCount} SHIPS`
        : `${acceptedCount} SHIP${acceptedCount === 1 ? "" : "S"}`;
    element("directive").textContent = `${shipLabel(shipClass)} // ${batchDescription} // ${shipyards.length} YARD${shipyards.length === 1 ? "" : "S"}`;
    showToast(`${shipLabel(shipClass)} QUEUED // ${cost.alloyCost * acceptedCount}A ${cost.energyCost * acceptedCount}E`);
  } else if (rejection) showToast(`QUEUE REJECTED // ${rejection}`);
}

function issueRallyPoint(position: THREE.Vector3): void {
  const warp = pendingWarpPoint;
  if (warp && !isInTerritory(visibleTerritories(), localPlayerId, "pylon", position)) {
    showToast("WARP REQUIRES AN OWNED PYLON FIELD");
    return;
  }
  const shipyards = getSelectedShipyards();
  if (shipyards.length === 0) { showToast("SELECT A COMPLETED SHIPYARD"); return; }
  let accepted = 0;
  let rejection: string | null = null;
  for (const shipyard of shipyards) {
    commandSequence += 1;
    const result = submitPlayerCommand({
      type: warp ? "setWarpPoint" : "setRallyPoint", playerId: localPlayerId, sequence: commandSequence,
      requestedTick: nextCommandTick(), structureId: shipyard.id,
      position: { x: position.x, z: position.z },
    });
    if (result.accepted) accepted += 1;
    else rejection = result.reason.toUpperCase();
  }
  if (accepted > 0) {
    showCommandMarker(position);
    element("directive").textContent = `${warp ? "WARP" : "RALLY"} POINT // ${accepted} SHIPYARD${accepted === 1 ? "" : "S"} LINKED`;
    showToast(`${warp ? "WARP" : "RALLY"} POINT SET // ${accepted} YARD${accepted === 1 ? "" : "S"}`);
  } else if (rejection) showToast(`RALLY REJECTED // ${rejection}`);
  setRallyPointMode(false);
}

function cancelCurrentProduction(): void {
  const shipyards = getSelectedShipyards();
  const shipyard = shipyards.find((candidate) => candidate.id === primaryStructureId && candidate.productionQueue[0])
    ?? shipyards.find((candidate) => candidate.productionQueue[0]);
  const item = shipyard?.productionQueue[0];
  if (!shipyard || !item) return;
  cancelProductionItem(shipyard.id, item.id);
}

function cancelProductionItem(structureId: number, queueItemId: number): void {
  const shipyard = getSelectedShipyards().find((candidate) => candidate.id === structureId);
  if (!shipyard?.productionQueue.some((item) => item.id === queueItemId)) return;
  commandSequence += 1;
  const result = submitPlayerCommand({
    type: "cancelProduction", playerId: localPlayerId, sequence: commandSequence,
    requestedTick: nextCommandTick(), structureId, queueItemId,
  });
  if (result.accepted) showToast("PRODUCTION CANCELLED");
}

function toggleInfiniteProduction(): void {
  const shipyards = getSelectedShipyards();
  if (shipyards.length === 0) return;
  const enabled = !shipyards.every((shipyard) => shipyard.repeatProduction);
  let accepted = 0;
  let rejection: string | null = null;
  for (const shipyard of shipyards) {
    commandSequence += 1;
    const result = submitPlayerCommand({
      type: "setProductionRepeat", playerId: localPlayerId, sequence: commandSequence,
      requestedTick: nextCommandTick(), structureId: shipyard.id, enabled,
    });
    if (result.accepted) accepted += 1;
    else rejection = result.reason.toUpperCase();
  }
  if (accepted > 0) {
    element("directive").textContent = `INFINITE QUEUE // ${enabled ? "ENABLED" : "DISABLED"} // ${accepted} YARD${accepted === 1 ? "" : "S"}`;
    showToast(`INFINITE QUEUE ${enabled ? "ON" : "OFF"}`);
  } else if (rejection) showToast(`PRODUCTION CONTROL REJECTED // ${rejection}`);
}

function stopAllProduction(): void {
  const shipyards = getSelectedShipyards();
  if (shipyards.length === 0) return;
  let accepted = 0;
  let rejection: string | null = null;
  for (const shipyard of shipyards) {
    commandSequence += 1;
    const result = submitPlayerCommand({
      type: "clearProductionQueue", playerId: localPlayerId, sequence: commandSequence,
      requestedTick: nextCommandTick(), structureId: shipyard.id,
    });
    if (result.accepted) accepted += 1;
    else rejection = result.reason.toUpperCase();
  }
  if (accepted > 0) {
    element("directive").textContent = `PRODUCTION HALTED // ${accepted} YARD${accepted === 1 ? "" : "S"}`;
    showToast("ALL PRODUCTION STOPPED");
  } else if (rejection) showToast(`STOP REJECTED // ${rejection}`);
}

function issueNavigationCommand(
  type: "move" | "attackMove" | "patrol",
  destination: THREE.Vector3,
  formationEnd: THREE.Vector3 | undefined,
  queued: boolean,
): void {
  const ships = getSelectedShips();
  if (ships.length === 0 || currentState().status !== "playing") {
    showToast("SELECT YOUR UNITS FIRST");
    setCommandMode(null);
    return;
  }
  commandSequence += 1;
  const base = {
    playerId: localPlayerId,
    sequence: commandSequence,
    requestedTick: nextCommandTick(),
    unitIds: ships.map((ship) => ship.id),
    queued,
    type,
    destination: { x: destination.x, z: destination.z },
  } as const;
  const command: FleetCommand = formationEnd
    ? { ...base, formationEnd: { x: formationEnd.x, z: formationEnd.z } }
    : base;
  const result = submitPlayerCommand(command);
  if (result.accepted) {
    showCommandMarker(destination);
    const orderLabel = type === "attackMove" ? "ATTACK" : type === "patrol" ? "PATROL" : "MOVE";
    element("directive").textContent = queued
      ? `${orderLabel} WAYPOINT QUEUED`
      : `${type === "attackMove" ? "ATTACK-MOVE" : type === "patrol" ? "PATROL ROUTE" : "FORMATION MOVE"} EXECUTING`;
    showToast(queued ? "ORDER QUEUED" : type === "attackMove" ? "ATTACK-MOVE" : type === "patrol" ? "PATROL ACTIVE" : "MOVE ORDER");
  } else {
    showToast(`COMMAND REJECTED // ${result.reason.toUpperCase()}`);
  }
  setCommandMode(null);
}

function issueSimpleCommand(type: "stop" | "hold"): void {
  const ships = getSelectedShips();
  if (ships.length === 0 || currentState().status !== "playing") { showToast("SELECT YOUR UNITS FIRST"); return; }
  commandSequence += 1;
  const command: FleetCommand = {
    type, playerId: localPlayerId, sequence: commandSequence,
    requestedTick: nextCommandTick(),
    unitIds: ships.map((ship) => ship.id), queued: false,
  };
  const result = submitPlayerCommand(command);
  if (result.accepted) {
    element("directive").textContent = type === "hold" ? "HOLD POSITION // WEAPONS FREE" : "FLEET STOPPING";
    showToast(type === "hold" ? "HOLD POSITION" : "STOP ORDER");
  }
}

function issueFocusFire(target: CombatTargetState): void {
  const ships = getSelectedShips();
  if (ships.length === 0 || !isHostileToLocalPlayer(target.teamId) || currentState().status !== "playing") return;
  commandSequence += 1;
  const command: FleetCommand = {
    type: "focusFire", playerId: localPlayerId, sequence: commandSequence,
    requestedTick: nextCommandTick(),
    unitIds: ships.map((ship) => ship.id), queued: false, targetEntityId: target.id,
  };
  const result = submitPlayerCommand(command);
  if (result.accepted) {
    showCommandMarker(new THREE.Vector3(target.x, 0, target.z));
    element("directive").textContent = `FOCUS FIRE // CONTACT ${target.id}`;
    showToast(`FOCUS FIRE // ${("class" in target ? target.class : target.type).toUpperCase()}`);
  }
}

function ensureFormationSlotCount(count: number): void {
  while (formationSlotMeshes.length < count) {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(3.2, 4.3, 18),
      new THREE.MeshBasicMaterial({ color: 0x62dcff, transparent: true, opacity: 0.72, side: THREE.DoubleSide, depthWrite: false }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.visible = false;
    scene.add(mesh);
    formationSlotMeshes.push(mesh);
  }
}

function updateFormationPreview(assignments: readonly FormationAssignment[], start: THREE.Vector3, end?: THREE.Vector3): void {
  ensureFormationSlotCount(assignments.length);
  for (let index = 0; index < formationSlotMeshes.length; index += 1) {
    const mesh = formationSlotMeshes[index]!;
    const assignment = assignments[index];
    mesh.visible = assignment !== undefined;
    if (assignment) {
      mesh.position.set(assignment.destination.x, 2, assignment.destination.z);
      const ship = clientView.ships.find((candidate) => candidate.id === assignment.shipId);
      mesh.scale.setScalar(ship ? Math.max(0.8, SHIPS[ship.class].radius / 8) : 1);
    }
  }
  updateDynamicLines(formationPreviewLine, end
    ? [new THREE.Vector3(start.x, 2, start.z), new THREE.Vector3(end.x, 2, end.z)]
    : []);
}

function hideFormationPreview(): void {
  for (const mesh of formationSlotMeshes) mesh.visible = false;
  updateDynamicLines(formationPreviewLine, []);
}

function showCommandMarker(position: THREE.Vector3): void {
  let marker = commandMarkers.find((candidate) => !candidate.mesh.visible);
  if (!marker) {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(8, 10, 28),
      new THREE.MeshBasicMaterial({ color: 0x62dcff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
    );
    mesh.rotation.x = -Math.PI / 2;
    scene.add(mesh);
    marker = { mesh, bornAt: 0 };
    commandMarkers.push(marker);
  }
  marker.mesh.visible = true;
  marker.mesh.position.set(position.x, 2, position.z);
  marker.mesh.scale.setScalar(0.55);
  marker.bornAt = performance.now();
}

function updateCommandMarkers(now: number): void {
  for (const marker of commandMarkers) {
    if (!marker.mesh.visible) continue;
    const age = (now - marker.bornAt) / 1000;
    if (age >= 1.1) { marker.mesh.visible = false; continue; }
    marker.mesh.scale.setScalar(0.55 + age * 1.1);
    (marker.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - age / 1.1);
  }
}

function focusSelection(): void {
  const ships = getSelectedShips();
  if (ships.length === 0) { focusBattle(); return; }
  cameraRig.target.set(
    ships.reduce((sum, ship) => sum + ship.x / ships.length, 0),
    0,
    ships.reduce((sum, ship) => sum + ship.z / ships.length, 0),
  );
  cameraRig.distance = ships.length === 1 ? 300 : Math.min(560, 300 + ships.length * 18);
  showToast("SELECTION FOCUSED");
}

function recallControlGroup(group: number): void {
  if (!canIssuePlayerCommands()) {
    showToast(clientViewMode === "team-spectator" ? "TEAM SPECTATOR // VIEW ONLY" : "REPLAY // VIEW ONLY");
    return;
  }
  const ids = controlGroups.get(group)?.filter((id) => clientView.ships.some((ship) => ship.id === id)) ?? [];
  if (ids.length === 0) { showToast(`CONTROL GROUP ${group} EMPTY`); return; }
  setSelection(ids);
  const now = performance.now();
  if (lastControlGroup === group && now - lastControlGroupAt < 500) focusSelection();
  lastControlGroup = group;
  lastControlGroupAt = now;
  showToast(`CONTROL GROUP ${group} // ${ids.length} UNITS`);
}

function showVictory(winnerTeamId: number): void {
  const overlay = element("victory-overlay");
  if (clientViewMode === "post-match-omniscient") {
    overlay.classList.remove("visible", "defeat");
    element("directive").textContent = `MATCH COMPLETE // TEAM ${winnerTeamId} VICTORIOUS`;
    return;
  }
  const viewingTeamId = clientViewMode === "team-spectator"
    ? spectatorTeamId
    : currentState().players.find((player) => player.id === localPlayerId)?.teamId;
  const won = winnerTeamId === viewingTeamId;
  overlay.classList.toggle("defeat", !won);
  overlay.classList.add("visible");
  element("victory-title").textContent = clientViewMode === "team-spectator" ? "MATCH COMPLETE" : won ? "VICTORY" : "DEFEAT";
  element("victory-copy").textContent = clientViewMode === "team-spectator"
    ? `Team ${winnerTeamId} controls the battlespace.`
    : won ? "All hostile command cores neutralized." : "Your team was eliminated.";
}

function animate(now: number): void {
  const frameStartedAt = performance.now();
  const delta = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  if (clientViewMode === "post-match-omniscient" && replayPlayer && replayPlaying) {
    accumulator += delta * replaySpeed;
    while (accumulator >= FIXED_DT && replayPlaying) {
      stepReplay();
      accumulator -= FIXED_DT;
    }
  } else if (!paused && !networkMode && (!landingLobbyActive || demoMode) && physicsWorld) {
    accumulator += delta;
    while (accumulator >= FIXED_DT) {
      tickSimulation();
      accumulator -= FIXED_DT;
    }
  } else if (!paused && networkMode && !networkView && !pendingLockstepState && physicsWorld) {
    if (advanceLockstep(simulation.state, lockstepTargetTick, tickSimulation) > 0) {
      networkInterpolationStartedAt = now;
    }
    verifyLockstepFrame();
  }
  updateCamera(delta);
  const preparationStartedAt = performance.now();
  const interpolationAlpha = clientViewMode === "post-match-omniscient"
    ? replayPlaying ? accumulator / FIXED_DT : 1
    : networkMode
      ? networkView
        ? Math.min(1, Math.max(0, (now - networkViewReceivedAt) / networkViewInterpolationMs))
        : Math.min(1, Math.max(0, (now - networkInterpolationStartedAt) / (FIXED_DT * 1_000)))
      : paused ? 1 : accumulator / FIXED_DT;
  updateVisuals(interpolationAlpha, now);
  renderPreparationMs = performance.now() - preparationStartedAt;
  updateCommandMarkers(now);
  gpuFrameTimer.poll();
  gpuFrameTimer.begin();
  renderer.render(scene, camera);
  gpuFrameTimer.end();
  frameCpuMs = performance.now() - frameStartedAt;
  frameCounter += 1;
  if (now - fpsTime >= 500) {
    fps = frameCounter / ((now - fpsTime) / 1000);
    frameCounter = 0;
    fpsTime = now;
    updateHud();
  }
  requestAnimationFrame(animate);
}

function togglePause(): void {
  if (clientViewMode === "post-match-omniscient") {
    if (!replayPlayer) { showToast("REPLAY STILL LOADING"); return; }
    if (!replayPlaying && replayPlayer.currentTick >= replayPlayer.endTick) seekReplay(replayPlayer.startTick);
    setReplayPlaying(!replayPlaying);
    showToast(replayPlaying ? `REPLAY PLAYING // ${replaySpeed}×` : "REPLAY PAUSED");
    return;
  }
  if (networkMode) {
    showToast("MULTIPLAYER AUTHORITY CANNOT BE PAUSED");
    return;
  }
  paused = !paused;
  element("pause").classList.toggle("active", paused);
  showToast(paused ? "SIMULATION PAUSED" : "SIMULATION RUNNING");
}

function resetSimulation(): void {
  if (networkMode) {
    showToast("LEAVE THE MATCH TO RESET");
    return;
  }
  simulation = menuBattleMode
    ? createMenuBattleScenario([
      FACTION_IDS[Math.floor(Math.random() * FACTION_IDS.length)]!,
      FACTION_IDS[Math.floor(Math.random() * FACTION_IDS.length)]!,
    ])
    : demoMode ? createShowcaseScenario() : createPlayableScenario();
  localPlayerId = menuBattleMode ? "menu-aster" : demoMode ? "showcase-aster" : "pilot-blue";
  if (physicsWorld) simulation.attachPhysicsWorld(physicsWorld);
  stressScenario.configure(0);
  element<HTMLSelectElement>("stress-count").value = "0";
  lastDebug = simulation.debugSnapshot();
  installClientView(buildClientVisibilityView(), false);
  resetFogOfWar();
  commandSequence = 0;
  selectedShipIds.clear();
  selectedStructureIds.clear();
  primaryStructureId = null;
  controlGroups.clear();
  setCommandMode(null);
  setStructureMode(null);
  setRallyPointMode(false);
  hideFormationPreview();
  element("victory-overlay").classList.remove("visible", "defeat");
  element("directive").textContent = demoMode
    ? menuBattleMode ? "LOCAL 1V1 // AUTONOMOUS FLEETS ENGAGED" : "AUTONOMOUS WAR ECONOMY // FACTORIES ONLINE"
    : "SELECT FLEET // ENGAGE HOSTILE FORCES";
  previousTransforms.clear();
  for (const ship of simulation.state.ships) previousTransforms.set(ship.id, captureTransform(ship));
  clearWorldVisuals();
  cameraRig.target.set(0, 0, 0);
  cameraRig.distance = menuBattleMode ? 720 : demoMode ? 980 : 610;
  cameraRig.azimuth = demoMode ? 0.18 : 0;
  if (!menuBattleMode && !demoMode) focusCameraOnLocalBase();
  eventLines = [demoMode
    ? menuBattleMode
      ? "<b>SIM</b> fighter-heavy local 1v1 // autonomous engagement"
      : "<b>SHOWCASE</b> 284 combat vessels // 16 autonomous shipyards"
    : `<b>SYS</b> new ${simulation.state.obstacles.length}-hazard seeded battlefield generated`];
  updateSelectionHud();
  if (stressTestMode) configureVisualStress(Number(element<HTMLSelectElement>("menu-stress-count").value));
  else showToast(demoMode ? menuBattleMode ? "LOCAL 1V1 RESTARTED" : "SHOWCASE RESTARTED" : "NEW BATTLEFIELD GENERATED");
}

function focusBattle(): void {
  cameraRig.target.set(0, 0, 0);
  cameraRig.distance = 610;
  showToast("CAMERA FOCUSED");
}

function showToast(message: string): void {
  const toast = element("toast");
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 1200);
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable);
}

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      showToast("FULLSCREEN DISABLED");
    } else {
      await document.documentElement.requestFullscreen({ navigationUI: "hide" });
      showToast("FULLSCREEN ENABLED // \\ TO EXIT");
    }
  } catch (error: unknown) {
    console.warn("Fullscreen request failed", error);
    showToast("FULLSCREEN UNAVAILABLE");
  }
}

function toggleTelemetry(): void {
  const shouldShow = getComputedStyle(telemetryPanel).display === "none";
  telemetryPanel.classList.toggle("hidden", !shouldShow);
  telemetryPanel.classList.toggle("telemetry-forced", shouldShow);
  showToast(shouldShow ? "SIM TELEMETRY VISIBLE" : "SIM TELEMETRY HIDDEN");
}

const gameMenu = element<HTMLElement>("game-menu");
const gameMenuToggle = element<HTMLButtonElement>("game-menu-toggle");
const gameMenuPanel = element<HTMLElement>("game-menu-panel");

function updateGameMenuOptions(): void {
  const pauseButton = element<HTMLButtonElement>("game-menu-pause");
  pauseButton.textContent = clientViewMode === "post-match-omniscient"
    ? replayPlaying ? "PAUSE REPLAY" : "PLAY REPLAY"
    : paused ? "RESUME SIMULATION" : "PAUSE SIMULATION";
  pauseButton.disabled = networkMode && clientViewMode !== "post-match-omniscient";
  pauseButton.title = pauseButton.disabled ? "Multiplayer matches cannot be paused" : "";
  const resetButton = element<HTMLButtonElement>("reset");
  resetButton.disabled = networkMode;
  resetButton.title = networkMode ? "Leave the multiplayer match before restarting" : "Restart engagement (R)";
  element("game-menu-fullscreen").textContent = document.fullscreenElement ? "EXIT FULLSCREEN" : "ENTER FULLSCREEN";
  element("settings-fullscreen").textContent = document.fullscreenElement ? "EXIT FULLSCREEN" : "ENTER FULLSCREEN";
  element("game-menu-main").textContent = networkMode ? "LEAVE MATCH" : "RETURN TO MAIN MENU";
}

function setGameMenuOpen(open: boolean): void {
  gameMenu.classList.toggle("open", open);
  gameMenuPanel.hidden = !open;
  gameMenuToggle.setAttribute("aria-expanded", open.toString());
  gameMenuToggle.setAttribute("aria-label", open ? "Close game menu" : "Open game menu");
  if (open) updateGameMenuOptions();
}

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
const unlockBattleAudio = () => {
  void battleAudio.unlock().then(updateAudioToggle);
};
addEventListener("pointerdown", unlockBattleAudio);
addEventListener("keydown", (event) => {
  unlockBattleAudio();
  if (element("network-overlay").classList.contains("visible")) {
    if (event.code === "Escape" && !mapSettingsOpen
      && ["player-invite-modal", "spectator-invite-modal"].every((id) => element(id).classList.contains("hidden"))) {
      element<HTMLButtonElement>("network-close").click();
    }
    return;
  }
  if (isTextEntryTarget(event.target)) return;
  if (event.code === "Backquote") {
    event.preventDefault();
    if (!event.repeat) toggleTelemetry();
    return;
  }
  if (event.code.startsWith("Arrow")) event.preventDefault();
  keys.add(event.code);
  const digitMatch = event.code.match(/^Digit([1-9])$/);
  if (digitMatch?.[1]) {
    event.preventDefault();
    if (!canIssuePlayerCommands()) return;
    const group = Number(digitMatch[1]);
    if (event.ctrlKey || event.metaKey) {
      const ids = getSelectedShips().map((ship) => ship.id);
      controlGroups.set(group, ids);
      showToast(`CONTROL GROUP ${group} SET // ${ids.length} UNITS`);
    } else {
      recallControlGroup(group);
    }
    return;
  }
  if (event.repeat) return;
  if ((event.code === "Backslash" || event.key === "\\") && !isTextEntryTarget(event.target)) {
    event.preventDefault();
    void toggleFullscreen();
    return;
  }
  if (event.code === "Escape") {
    if (!gameMenuPanel.hidden) {
      event.preventDefault();
      setGameMenuOpen(false);
      return;
    }
    setCommandMode(null); setStructureMode(null); setRallyPointMode(false); hideFormationPreview();
  }
  if (event.code === "Space") { event.preventDefault(); togglePause(); }
  if (event.code === "Period" && clientViewMode === "post-match-omniscient" && !replayPlaying) stepReplay();
  else if (event.code === "Period" && paused) tickSimulation();
  if (!canIssuePlayerCommands()) return;
  if (constructionControlsActive() && !event.ctrlKey && !event.metaKey && !event.altKey) {
    const constructionTier = constructionHotkeyTier(event.code);
    if (constructionTier) {
      event.preventDefault();
      setConstructionCategory(constructionTier);
      return;
    }
    const structureType = constructionHotkeyStructureType(event.code);
    if (structureType) {
      event.preventDefault();
      setStructureMode(structureType);
      return;
    }
  }
  const productionHotkey = !event.ctrlKey && !event.metaKey && !event.altKey
    ? productionHotkeyShipClass(event.code)
    : null;
  if (productionHotkey) {
    event.preventDefault();
    issueQueueUnit(productionHotkey, event.shiftKey ? 5 : 1);
    return;
  }
  if (event.code === "KeyR") resetSimulation();
  if (event.code === "KeyF") setCommandMode("focusFire");
  if (event.code === "KeyM") setCommandMode("move");
  if (event.code === "KeyA") setCommandMode("attackMove");
  if (event.code === "KeyP") setCommandMode("patrol");
  if (event.code === "KeyS") issueSimpleCommand("stop");
  if (event.code === "KeyH") issueSimpleCommand("hold");
  if (event.code === "KeyY") setRallyPointMode(true);
});
addEventListener("keyup", (event) => keys.delete(event.code));
addEventListener("pointermove", (event) => {
  pointerX = event.clientX; pointerY = event.clientY;
  if (buildPlacementDrag) {
    const direction = getWorldPoint(event.clientX, event.clientY);
    if (direction) {
      const dx = direction.x - buildPlacementDrag.candidate.position.x;
      const dz = direction.z - buildPlacementDrag.candidate.position.z;
      if (Math.hypot(dx, dz) >= 4) buildPlacementDrag.yaw = Math.atan2(dx, dz);
      placementGhost.position.copy(buildPlacementDrag.candidate.position);
      placementGhost.rotation.y = buildPlacementDrag.yaw;
    }
  } else if (pendingStructureType) updatePlacementGhost(event.clientX, event.clientY);
  if (middleDrag && !element("app").classList.contains("start-screen-active")) {
    const deltaX = event.clientX - lastPointerX;
    const deltaY = event.clientY - lastPointerY;
    if (event.shiftKey) {
      const dragScale = Math.max(0.45, cameraRig.distance * 0.0018);
      cameraRig.target.addScaledVector(cameraRight, -deltaX * dragScale);
      cameraRig.target.addScaledVector(cameraForward, -deltaY * dragScale);
      clampCameraTarget();
    } else {
      cameraRig.azimuth -= deltaX * 0.006;
    }
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
  }
  if (selectionDrag) {
    selectionDrag.currentX = event.clientX;
    selectionDrag.currentY = event.clientY;
    updateSelectionBox();
  }
  if (commandDrag) {
    const point = getWorldPoint(event.clientX, event.clientY);
    if (point) commandDrag.formationEnd.copy(point);
    const hasLine = commandDrag.destination.distanceTo(commandDrag.formationEnd) >= 18;
    const assignments = computeFormationAssignments(
      getSelectedShips(),
      { x: commandDrag.destination.x, z: commandDrag.destination.z },
      hasLine ? { x: commandDrag.formationEnd.x, z: commandDrag.formationEnd.z } : undefined,
    );
    updateFormationPreview(assignments, commandDrag.destination, hasLine ? commandDrag.formationEnd : undefined);
  }
});
addEventListener("pointerdown", (event) => {
  if (event.button === 1) {
    middleDrag = true;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
    event.preventDefault();
  }
});
addEventListener("pointerup", (event) => {
  if (event.button === 1) middleDrag = false;
  if (buildPlacementDrag && event.button === 0) {
    const drag = buildPlacementDrag;
    buildPlacementDrag = null;
    issueBuildStructure(drag.candidate, drag.keepPlacing, drag.yaw);
    return;
  }
  if (selectionDrag && event.button === 0) {
    const drag = selectionDrag;
    selectionDrag = null;
    updateSelectionBox();
    const distance = Math.hypot(drag.currentX - drag.startX, drag.currentY - drag.startY);
    if (distance >= 6) {
      selectEntitiesInBox(drag);
    } else {
      const target = pickCombatTarget(event.clientX, event.clientY);
      if (target && target.ownerPlayerId === localPlayerId) {
        if ("class" in target) setSelection([target.id], drag.shift, drag.shift);
        else setStructureSelection([target.id], drag.shift, drag.shift);
      } else if (target && isHostileToLocalPlayer(target.teamId)) {
        inspectHostile(target);
      } else if (!drag.shift) setSelection([]);
    }
  }
  if (commandDrag && event.button === commandDrag.button) {
    const drag = commandDrag;
    commandDrag = null;
    hideFormationPreview();
    const screenDistance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    const target = screenDistance < 6 && drag.button === 2 ? pickCombatTarget(event.clientX, event.clientY) : undefined;
    if (target && isHostileToLocalPlayer(target.teamId)) {
      issueFocusFire(target);
      setCommandMode(null);
    } else {
      issueNavigationCommand(
        drag.type,
        drag.destination,
        screenDistance >= 6 && drag.destination.distanceTo(drag.formationEnd) >= 18 ? drag.formationEnd : undefined,
        drag.queued,
      );
    }
  }
});
addEventListener("wheel", (event) => {
  if (element("app").classList.contains("start-screen-active")) return;
  const anchorBeforeZoom = getWorldPoint(event.clientX, event.clientY);
  const wheelDelta = THREE.MathUtils.clamp(event.deltaY, -600, 600);
  const nextDistance = THREE.MathUtils.clamp(
    cameraRig.distance * Math.exp(wheelDelta * 0.003),
    MIN_CAMERA_DISTANCE,
    MAX_CAMERA_DISTANCE,
  );
  if (nextDistance === cameraRig.distance) return;

  cameraRig.distance = nextDistance;
  updateCamera(0);
  camera.updateMatrixWorld();
  const anchorAfterZoom = getWorldPoint(event.clientX, event.clientY);
  if (anchorBeforeZoom && anchorAfterZoom) {
    cameraRig.target.x += anchorBeforeZoom.x - anchorAfterZoom.x;
    cameraRig.target.z += anchorBeforeZoom.z - anchorAfterZoom.z;
    clampCameraTarget();
    updateCamera(0);
    camera.updateMatrixWorld();
  }
}, { passive: true });

canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 && event.button !== 2) return;
  if (event.button === 2) event.preventDefault();
  if (!canIssuePlayerCommands()) return;
  if (pendingRallyPoint && event.button === 2) {
    setRallyPointMode(false);
    showToast("DESTINATION CANCELLED");
    return;
  }
  if (event.button === 2 && getSelectedShipyards().length > 0) {
    const position = getWorldPoint(event.clientX, event.clientY);
    if (position) issueRallyPoint(position);
    return;
  }
  if (pendingRallyPoint && event.button === 2) {
    setRallyPointMode(false);
    showToast("RALLY POINT CANCELLED");
    return;
  }
  if (pendingRallyPoint && event.button === 0) {
    const position = getWorldPoint(event.clientX, event.clientY);
    if (position) issueRallyPoint(position);
    return;
  }
  if (pendingStructureType && event.button === 2) {
    setStructureMode(null);
    showToast("PLACEMENT CANCELLED");
    return;
  }
  if (pendingStructureType && event.button === 0) {
    const candidate = getPlacementCandidate(event.clientX, event.clientY);
    if (candidate) {
      buildPlacementDrag = { candidate, yaw: 0, keepPlacing: event.shiftKey };
      placementGhost.rotation.y = 0;
    }
    return;
  }
  if (event.button === 0 && pendingCommandMode === "focusFire") {
    const target = pickCombatTarget(event.clientX, event.clientY);
    if (target && isHostileToLocalPlayer(target.teamId)) issueFocusFire(target);
    else showToast("SELECT A HOSTILE CONTACT");
    setCommandMode(null);
    return;
  }
  const commandType = event.button === 2
    ? "move"
    : pendingCommandMode === "move" || pendingCommandMode === "attackMove" || pendingCommandMode === "patrol"
      ? pendingCommandMode
      : null;
  if (commandType) {
    const destination = getWorldPoint(event.clientX, event.clientY);
    if (!destination) return;
    if (getSelectedShips().length === 0) { showToast("SELECT YOUR UNITS FIRST"); return; }
    commandDrag = {
      type: commandType,
      button: event.button,
      startX: event.clientX,
      startY: event.clientY,
      destination,
      formationEnd: destination.clone(),
      queued: event.shiftKey,
    };
    const assignments = computeFormationAssignments(
      getSelectedShips(),
      { x: destination.x, z: destination.z },
    );
    updateFormationPreview(assignments, destination);
    return;
  }
  if (event.button === 0) {
    selectionDrag = {
      startX: event.clientX, startY: event.clientY,
      currentX: event.clientX, currentY: event.clientY, shift: event.shiftKey,
    };
  }
});
canvas.addEventListener("dblclick", (event) => {
  if (!canIssuePlayerCommands()) return;
  const target = pickCombatTarget(event.clientX, event.clientY);
  if (!target || target.ownerPlayerId !== localPlayerId) return;
  if ("class" in target) {
    const nearby = clientView.ships.filter((candidate) =>
      candidate.ownerPlayerId === localPlayerId
      && candidate.class === target.class
      && Math.hypot(candidate.x - target.x, candidate.z - target.z) <= 300,
    );
    setSelection(nearby.map((candidate) => candidate.id), event.shiftKey);
    showToast(`${nearby.length} ${shipLabel(target.class, target.faction)} SELECTED`);
  } else {
    const sameType = clientView.structures.filter((candidate) =>
      candidate.ownerPlayerId === localPlayerId && candidate.type === target.type,
    );
    setStructureSelection(sameType.map((candidate) => candidate.id), event.shiftKey);
    showToast(`${sameType.length} × ${structureLabel(target.type, target.ownerPlayerId)} SELECTED`);
  }
});
canvas.addEventListener("contextmenu", (event) => event.preventDefault());

element("selection-roster").addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>("[data-selection-ship-id]");
  if (!button) return;
  const shipId = Number(button.dataset.selectionShipId);
  const ship = clientView.ships.find((candidate) => candidate.id === shipId);
  if (!ship || ship.ownerPlayerId !== localPlayerId) return;
  if (event.ctrlKey || event.metaKey) {
    setSelection(getSelectedShips()
      .filter((candidate) => candidate.class === ship.class)
      .map((candidate) => candidate.id));
  } else if (event.shiftKey) {
    setSelection([shipId], true, true);
  } else {
    setSelection([shipId]);
  }
});

element("pause").addEventListener("click", togglePause);
element("game-menu-pause").addEventListener("click", () => {
  setGameMenuOpen(false);
  togglePause();
});
element("step").addEventListener("click", () => {
  if (clientViewMode === "post-match-omniscient") {
    if (!replayPlaying) stepReplay();
    return;
  }
  if (networkMode) { showToast("STEP IS LOCAL-ONLY"); return; }
  if (!paused) togglePause();
  tickSimulation();
});
element("reset").addEventListener("click", () => {
  setGameMenuOpen(false);
  resetSimulation();
});
element("audio-toggle").addEventListener("click", () => {
  setGameMenuOpen(false);
  void battleAudio.setEnabled(!battleAudio.enabled).then(() => {
    updateAudioToggle();
    showToast(battleAudio.enabled ? "BATTLE AUDIO ONLINE" : "BATTLE AUDIO MUTED");
  });
});
gameMenuToggle.addEventListener("click", () => setGameMenuOpen(gameMenuPanel.hidden));
element("game-menu-fullscreen").addEventListener("click", () => {
  setGameMenuOpen(false);
  void toggleFullscreen();
});
element("game-menu-main").addEventListener("click", () => {
  setGameMenuOpen(false);
  if (networkMode) leaveNetworkMatch();
  else showStartScreen(true);
});
document.addEventListener("pointerdown", (event) => {
  if (!gameMenuPanel.hidden && !gameMenu.contains(event.target as Node)) setGameMenuOpen(false);
});
document.addEventListener("fullscreenchange", updateGameMenuOptions);
element("replay-toggle").addEventListener("click", togglePause);
element("replay-speed").addEventListener("click", () => {
  const currentIndex = REPLAY_SPEEDS.findIndex((speed) => speed === replaySpeed);
  replaySpeed = REPLAY_SPEEDS[(currentIndex + 1) % REPLAY_SPEEDS.length] ?? 1;
  element("replay-speed").textContent = `${replaySpeed}×`;
  showToast(`REPLAY SPEED // ${replaySpeed}×`);
});
element<HTMLInputElement>("replay-scrub").addEventListener("input", (event) => {
  element("replay-current").textContent = formatReplayTick(Number((event.currentTarget as HTMLInputElement).value));
});
element<HTMLInputElement>("replay-scrub").addEventListener("change", (event) => {
  seekReplay(Number((event.currentTarget as HTMLInputElement).value));
});
element("focus").addEventListener("click", () => setCommandMode("focusFire"));
element("cmd-move").addEventListener("click", () => setCommandMode("move"));
element("cmd-attack").addEventListener("click", () => setCommandMode("attackMove"));
element("cmd-patrol").addEventListener("click", () => setCommandMode("patrol"));
element("cmd-stop").addEventListener("click", () => issueSimpleCommand("stop"));
element("cmd-hold").addEventListener("click", () => issueSimpleCommand("hold"));
for (const type of BUILDABLE_STRUCTURE_TYPES) {
  element(STRUCTURE_BUTTON_IDS[type]).addEventListener("click", () => setStructureMode(type));
}
for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-construction-tab]")) {
  tab.addEventListener("click", () => {
    const tier = tab.dataset.constructionTab;
    if (tier === "t1" || tier === "t2" || tier === "t3") setConstructionCategory(tier);
  });
}
element("queue-fighter").addEventListener("click", (event) => issueQueueUnit("fighter", event.shiftKey ? 5 : 1));
element("queue-fabricator").addEventListener("click", (event) => issueQueueUnit("fabricator", event.shiftKey ? 5 : 1));
element("queue-bomber").addEventListener("click", (event) => issueQueueUnit("bomber", event.shiftKey ? 5 : 1));
element("queue-frigate").addEventListener("click", (event) => issueQueueUnit("frigate", event.shiftKey ? 5 : 1));
element("queue-flak-frigate").addEventListener("click", (event) => issueQueueUnit("flakFrigate", event.shiftKey ? 5 : 1));
element("queue-torpedo-frigate").addEventListener("click", (event) => issueQueueUnit("torpedoFrigate", event.shiftKey ? 5 : 1));
element("queue-artillery-destroyer").addEventListener("click", (event) => issueQueueUnit("artilleryDestroyer", event.shiftKey ? 5 : 1));
element("queue-artillery-frigate").addEventListener("click", (event) => issueQueueUnit("artilleryFrigate", event.shiftKey ? 5 : 1));
element("queue-destroyer").addEventListener("click", (event) => issueQueueUnit("destroyer", event.shiftKey ? 5 : 1));
element("queue-cruiser").addEventListener("click", (event) => issueQueueUnit("cruiser", event.shiftKey ? 5 : 1));
element("queue-artillery-cruiser").addEventListener("click", (event) => issueQueueUnit("artilleryCruiser", event.shiftKey ? 5 : 1));
element("queue-carrier").addEventListener("click", (event) => issueQueueUnit("carrier", event.shiftKey ? 5 : 1));
element("queue-battleship").addEventListener("click", (event) => issueQueueUnit("battleship", event.shiftKey ? 5 : 1));
element("set-warp").addEventListener("click", () => setRallyPointMode(!pendingWarpPoint, true));
element("set-rally").addEventListener("click", () => setRallyPointMode(!pendingRallyPoint));
element("cancel-production").addEventListener("click", cancelCurrentProduction);
element("toggle-infinite-production").addEventListener("click", toggleInfiniteProduction);
element("stop-production-all").addEventListener("click", stopAllProduction);
element("cancel-construction").addEventListener("click", () => {
  const construction = getSelectedStructures()
    .find((structure) => structure.id === primaryStructureId && structure.buildProgress < 1)
    ?? getSelectedStructures().find((structure) => structure.buildProgress < 1);
  if (construction) issueCancelConstruction(construction.id);
});
element("clear-build-queue").addEventListener("click", clearSelectedBuildQueue);
element("queue-items").addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".queue-token") : null;
  if (!button) return;
  const constructionId = Number(button.dataset.constructionId);
  if (Number.isInteger(constructionId)) {
    issueCancelConstruction(constructionId);
    return;
  }
  const buildSequence = Number(button.dataset.buildSequence);
  if (Number.isInteger(buildSequence)) {
    issueCancelBuildOrder(buildSequence);
    return;
  }
  const structureId = Number(button.dataset.structureId);
  const queueItemId = Number(button.dataset.queueItemId);
  if (Number.isInteger(structureId) && Number.isInteger(queueItemId)) cancelProductionItem(structureId, queueItemId);
});
element("play-again").addEventListener("click", () => networkMode ? leaveNetworkMatch() : resetSimulation());
element("collapse-debug").addEventListener("click", () => {
  const content = element("debug-content");
  const collapsed = content.style.display === "none";
  content.style.display = collapsed ? "block" : "none";
  element("collapse-debug").textContent = collapsed ? "−" : "+";
});
function setRenderQuality(value: string): void {
  if (value !== "low" && value !== "medium" && value !== "high") return;
  renderQuality = value;
  batchedShipRenderer.setQuality(value);
  combatEffects.setQuality(value);
  renderStateBuilder.clearHistory();
  const pixelRatio = value === "low" ? 1 : value === "medium" ? 1.4 : Math.min(devicePixelRatio, 1.75);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  for (const id of ["render-quality", "settings-quality", "stress-quality"]) element<HTMLSelectElement>(id).value = value;
  localStorage.setItem("voidfront:render-quality", value);
}
for (const id of ["render-quality", "settings-quality", "stress-quality"]) {
  element<HTMLSelectElement>(id).addEventListener("change", (event) => {
    setRenderQuality((event.currentTarget as HTMLSelectElement).value);
  });
}
setRenderQuality(localStorage.getItem("voidfront:render-quality") ?? "medium");
function configureVisualStress(count: number): void {
  element<HTMLSelectElement>("stress-count").value = String(count);
  stressScenario.configure(Number.isFinite(count) ? count : 0);
  selectedShipIds.clear();
  selectedStructureIds.clear();
  primaryStructureId = null;
  setRallyPointMode(false);
  renderStateBuilder.clearHistory();
  if (count > 0) {
    cameraRig.target.set(0, 0, 0);
    cameraRig.distance = count >= 1_000 ? 920 : 720;
    showToast(`VISUAL STRESS // ${count.toLocaleString()} SHIPS`);
  } else {
    worldRoot.visible = true;
    showToast("VISUAL STRESS DISABLED");
  }
}
element<HTMLSelectElement>("stress-count").addEventListener("change", (event) => {
  configureVisualStress(Number((event.currentTarget as HTMLSelectElement).value));
});
const minimapElement = element<HTMLCanvasElement>("minimap");
let minimapDragPointerId: number | null = null;
const worldPointFromMinimap = (event: PointerEvent): THREE.Vector3 => {
  const rect = minimapElement.getBoundingClientRect();
  const halfExtent = minimapHalfExtent();
  const x = THREE.MathUtils.clamp((event.clientX - rect.left) / rect.width, 0, 1);
  const y = THREE.MathUtils.clamp((event.clientY - rect.top) / rect.height, 0, 1);
  return new THREE.Vector3(x * halfExtent * 2 - halfExtent, 0, y * halfExtent * 2 - halfExtent);
};
const moveCameraFromMinimap = (event: PointerEvent) => {
  cameraRig.target.copy(worldPointFromMinimap(event));
};
minimapElement.addEventListener("pointerdown", (event) => {
  if (event.button === 2) {
    event.preventDefault();
    if (!canIssuePlayerCommands()) return;
    if (getSelectedShips().length === 0) {
      showToast("SELECT YOUR UNITS FIRST");
      return;
    }
    if (pendingStructureType) setStructureMode(null);
    if (pendingRallyPoint) setRallyPointMode(false);
    issueNavigationCommand("move", worldPointFromMinimap(event), undefined, event.shiftKey);
    return;
  }
  if (event.button !== 0) return;
  minimapDragPointerId = event.pointerId;
  minimapElement.setPointerCapture(event.pointerId);
  minimapElement.classList.add("dragging");
  moveCameraFromMinimap(event);
  event.preventDefault();
});
minimapElement.addEventListener("pointermove", (event) => {
  if (event.pointerId !== minimapDragPointerId || !minimapElement.hasPointerCapture(event.pointerId)) return;
  moveCameraFromMinimap(event);
  event.preventDefault();
});
const endMinimapDrag = (event: PointerEvent) => {
  if (event.pointerId !== minimapDragPointerId) return;
  if (minimapElement.hasPointerCapture(event.pointerId)) minimapElement.releasePointerCapture(event.pointerId);
  minimapDragPointerId = null;
  minimapElement.classList.remove("dragging");
};
minimapElement.addEventListener("pointerup", endMinimapDrag);
minimapElement.addEventListener("pointercancel", endMinimapDrag);
minimapElement.addEventListener("lostpointercapture", (event) => {
  if (event.pointerId !== minimapDragPointerId) return;
  minimapDragPointerId = null;
  minimapElement.classList.remove("dragging");
});
minimapElement.addEventListener("contextmenu", (event) => event.preventDefault());

element<HTMLInputElement>("pilot-name").value = localStorage.getItem("voidfront:pilot-name") ?? "Commander";
element("network-overlay").classList.add("visible");
const invitedMatchId = new URL(location.href).searchParams.get("match");
if (invitedMatchId) {
  element<HTMLInputElement>("match-code").value = normalizeLobbyCode(invitedMatchId);
  element<HTMLDetailsElement>("direct-join").open = true;
}
void fetch("/__voidfront/lan-info", { cache: "no-store" })
  .then((response) => response.ok ? response.json() as Promise<{ origin?: unknown }> : null)
  .then((info) => {
    const currentHostIsLoopback = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
    if (currentHostIsLoopback && typeof info?.origin === "string") lanInviteOrigin = new URL(info.origin).origin;
    refreshLobbyInvite();
  })
  .catch(() => undefined);
element("network-open").addEventListener("click", () => {
  if (networkMode) {
    element("network-overlay").classList.add("visible");
    element("start-view").classList.add("hidden");
    element("network-join-view").classList.add("hidden");
    element("network-lobby-view").classList.remove("hidden");
    if (networkLobby) renderLobby();
    return;
  }
  showMultiplayerJoinScreen(!landingLobbyActive);
});
element("network-close").addEventListener("click", () => {
  if (networkMode) {
    if (networkLobby?.phase === "playing") element("network-overlay").classList.remove("visible");
    else leaveNetworkMatch("browser");
    return;
  }
  if (networkPanelOpenedFromGame) {
    stopLobbyBrowser();
    networkPanelOpenedFromGame = false;
    element("network-overlay").classList.remove("visible");
  } else showStartScreen();
});
element("open-multiplayer").addEventListener("click", () => showMultiplayerJoinScreen());
element("play-local").addEventListener("click", showSingleplayerSetup);
element("open-stress").addEventListener("click", () => showMenuPage("stress-test-view"));
element("open-settings").addEventListener("click", () => { showMenuPage("settings-view"); updateAudioToggle(); updateGameMenuOptions(); });
element("start-stress").addEventListener("click", startStressTest);
element("settings-audio").addEventListener("click", () => element<HTMLButtonElement>("audio-toggle").click());
element("settings-fullscreen").addEventListener("click", () => { void toggleFullscreen(); });
element("refresh-games").addEventListener("click", () => { void refreshJoinableGames(); });
element("game-search").addEventListener("input", renderJoinableGames);
element("joinable-games").addEventListener("click", (event) => {
  const matchId = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-join-game]")?.dataset.joinGame;
  if (matchId) connectToMatch(matchId, element<HTMLInputElement>("pilot-name").value, "player");
});
element("create-match").addEventListener("click", () => {
  const code = generateLobbyCode();
  element<HTMLInputElement>("match-code").value = code;
  connectToMatch(code, element<HTMLInputElement>("pilot-name").value, "player");
});
element("connect-match").addEventListener("click", () => connectToMatch(
  element<HTMLInputElement>("match-code").value,
  element<HTMLInputElement>("pilot-name").value,
  "player",
));
element("watch-team").addEventListener("click", () => {
  spectatorToken = element<HTMLInputElement>("spectator-token").value.trim();
  if (!spectatorToken) {
    showNetworkError("Paste the host-issued team spectator token first.");
    return;
  }
  connectToMatch(
    element<HTMLInputElement>("match-code").value,
    element<HTMLInputElement>("pilot-name").value,
    "team",
  );
});
element("watch-replay").addEventListener("click", () => connectToMatch(
  element<HTMLInputElement>("match-code").value,
  element<HTMLInputElement>("pilot-name").value,
  "replay",
));
for (const inputId of ["pilot-name", "match-code"]) {
  element<HTMLInputElement>(inputId).addEventListener("keydown", (event) => {
    if (event.key === "Enter") element<HTMLButtonElement>("connect-match").click();
  });
}
element("copy-lobby-invite").addEventListener("click", () => {
  void copyText(lobbyInviteUrl()).then(() => {
    element("copy-lobby-invite").textContent = "COPIED";
    showToast("LAN INVITE COPIED");
    window.setTimeout(() => { element("copy-lobby-invite").textContent = "COPY INVITE"; }, 1_200);
  }).catch(() => showNetworkError("Copy failed. Select the invite address manually."));
});
element("ready-toggle").addEventListener("click", () => {
  const slot = networkLobby?.slots.find((candidate) => candidate.playerId === localPlayerId);
  if (slot) sendNetworkMessage({ type: "set_ready", ready: !slot.ready });
});
element("open-map-settings").addEventListener("click", openMapSettings);
element("open-player-invite").addEventListener("click", () => {
  refreshLobbyInvite();
  openLobbyUtilityModal("player-invite-modal", "copy-lobby-invite");
});
element("open-spectator-invite").addEventListener("click", () => {
  openLobbyUtilityModal("spectator-invite-modal", "spectator-team-select");
});
element("close-map-settings").addEventListener("click", closeMapSettings);
element("cancel-map-settings").addEventListener("click", closeMapSettings);
element("close-player-invite").addEventListener("click", closeLobbyUtilityModals);
element("close-spectator-invite").addEventListener("click", closeLobbyUtilityModals);
element("map-settings-modal").addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (target.closest("[data-close-map-settings]")) closeMapSettings();
});
for (const modalId of ["player-invite-modal", "spectator-invite-modal"]) {
  element(modalId).addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("[data-close-lobby-modal]")) closeLobbyUtilityModals();
  });
}
element("map-preset-grid").addEventListener("click", (event) => {
  const card = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-map-preset]");
  if (!card || card.disabled || !card.dataset.mapPreset) return;
  element<HTMLInputElement>("map-preset").value = card.dataset.mapPreset;
  updateMapSettingsDraftView();
});
element("mode-teams").addEventListener("click", () => {
  if (element<HTMLButtonElement>("mode-teams").disabled) return;
  sendLobbyMessage({ type: "set_mode", mode: "teams" });
});
element("mode-ffa").addEventListener("click", () => {
  if (element<HTMLButtonElement>("mode-ffa").disabled) return;
  sendLobbyMessage({ type: "set_mode", mode: "ffa" });
});
element<HTMLSelectElement>("starting-resources").addEventListener("change", () => {
  const lobby = setupLobby();
  if (!lobby) return;
  sendLobbyMessage({
    type: "set_settings",
    settings: {
      ...lobby.settings,
      startingResources: element<HTMLSelectElement>("starting-resources").value as LobbySettings["startingResources"],
    },
  });
});
element<HTMLSelectElement>("starting-base").addEventListener("change", () => {
  const lobby = setupLobby();
  if (!lobby) return;
  sendLobbyMessage({
    type: "set_settings",
    settings: {
      ...lobby.settings,
      startingBase: element<HTMLSelectElement>("starting-base").value as LobbySettings["startingBase"],
    },
  });
});
for (const settingId of ["map-size", "resource-density", "team-spawn-mode"]) {
  element<HTMLSelectElement>(settingId).addEventListener("change", () => {
    updateMapSettingsDraftView();
  });
}
element("apply-map-settings").addEventListener("click", () => {
  const lobby = setupLobby();
  if (!lobby || !draftLobbyMode) return;
  const localSlot = lobby.slots.find((slot) => slot.playerId === setupPlayerId());
  if (!localSlot?.isHost || lobby.phase !== "lobby") return;
  const settings = selectedLobbySettings();
  if (!lobbySettingsEqual(settings, lobby.settings)) sendLobbyMessage({ type: "set_settings", settings });
  closeMapSettings();
});
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const utilityModalOpen = ["player-invite-modal", "spectator-invite-modal"]
    .some((modalId) => !element(modalId).classList.contains("hidden"));
  if (!mapSettingsOpen && !utilityModalOpen) return;
  event.preventDefault();
  if (mapSettingsOpen) closeMapSettings();
  closeLobbyUtilityModals();
});
element("add-ai").addEventListener("click", () => sendLobbyMessage({
  type: "add_ai",
  teamId: (setupLobby()?.slots.find((slot) => slot.playerId === setupPlayerId())?.teamId ?? 1) === 1 ? 2 : 1,
  difficulty: "normal",
  personality: "balanced",
}));
element("authorize-spectator").addEventListener("click", () => sendLobbyMessage({
  type: "authorize_spectator",
  teamId: Number(element<HTMLSelectElement>("spectator-team-select").value),
}));
element("copy-spectator-token").addEventListener("click", () => {
  const token = element("spectator-grant-token").textContent ?? "";
  void copyText(token).then(() => showToast("TEAM VIEW TOKEN COPIED"));
});
element("start-match").addEventListener("click", () => singleplayerSetupActive ? startLocalSkirmish() : sendNetworkMessage({ type: "start_match" }));
element("leave-match").addEventListener("click", () => singleplayerSetupActive ? showStartScreen() : leaveNetworkMatch("browser"));
element("lobby-slots").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-remove-slot]");
  const playerId = button?.dataset.removeSlot;
  if (playerId) sendLobbyMessage({ type: "remove_slot", playerId });
});
element("lobby-slots").addEventListener("change", (event) => {
  const target = event.target as HTMLSelectElement;
  const factionSelect = target.closest<HTMLSelectElement>("[data-faction-player]");
  if (factionSelect?.dataset.factionPlayer) {
    sendLobbyMessage({ type: "set_faction", faction: factionSelect.value as FactionId, playerId: factionSelect.dataset.factionPlayer });
    return;
  }
  const teamSelect = target.closest<HTMLSelectElement>("[data-team-player]");
  const teamPlayerId = teamSelect?.dataset.teamPlayer;
  if (teamSelect && teamPlayerId) {
    sendLobbyMessage({ type: "set_team", teamId: Number(teamSelect.value), playerId: teamPlayerId });
    return;
  }
  const aiPlayerId = target.dataset.aiDifficulty ?? target.dataset.aiPersonality;
  if (!aiPlayerId) return;
  const difficulty = document.querySelector<HTMLSelectElement>(`[data-ai-difficulty="${CSS.escape(aiPlayerId)}"]`)?.value;
  const personality = document.querySelector<HTMLSelectElement>(`[data-ai-personality="${CSS.escape(aiPlayerId)}"]`)?.value;
  if (difficulty && personality) sendLobbyMessage({
    type: "set_ai_settings", playerId: aiPlayerId,
    difficulty: difficulty as "easy" | "normal" | "hard",
    personality: personality as "balanced" | "aggressive" | "turtle" | "economic",
  });
});

function updateAudioToggle(): void {
  const button = element<HTMLButtonElement>("audio-toggle");
  const online = battleAudio.enabled && battleAudio.metrics.supported;
  button.classList.toggle("active", online);
  button.textContent = online ? "AUDIO ON" : "AUDIO MUTED";
  button.title = battleAudio.metrics.supported
    ? (online ? "Mute battle audio" : "Enable battle audio")
    : "Battle audio is unavailable in this browser";
  button.setAttribute("aria-pressed", online.toString());
  button.disabled = !battleAudio.metrics.supported;
  const settingsButton = element<HTMLButtonElement>("settings-audio");
  settingsButton.textContent = !battleAudio.metrics.supported ? "UNAVAILABLE" : online ? "ON" : "OFF";
  settingsButton.setAttribute("aria-pressed", String(online));
  settingsButton.disabled = !battleAudio.metrics.supported;
}

document.addEventListener("visibilitychange", () => battleAudio.setHidden(document.hidden));

installCommandTooltips();
updateAudioToggle();
showStartScreen(true);
if (invitedMatchId) showMultiplayerJoinScreen();
updateHud();
requestAnimationFrame(() => {
  document.documentElement.classList.add("app-ready");
  window.setTimeout(() => document.getElementById("boot-screen")?.remove(), 300);
});
requestAnimationFrame(animate);
