import type { Vec2 } from "@space-rts/shared";

export type PlayerId = string;
export type TeamId = number;
export type EntityId = number;
export type ShipClass =
  | "fighter"
  | "fabricator"
  | "frigate"
  | "bomber"
  | "flakFrigate"
  | "torpedoFrigate"
  | "destroyer"
  | "cruiser"
  | "carrier"
  | "battleship";
export type WeaponTypeId = "autocannon" | "torpedo" | "plasma" | "heavyRail" | "pointDefense" | "beam";
export type StructureType =
  | "commandCore"
  | "extractor"
  | "deepCoreExtractor"
  | "singularityHarvester"
  | "alloyRefinery"
  | "matterForge"
  | "solarArray"
  | "storage"
  | "quantumStorage"
  | "fabricator"
  | "advancedFabrication"
  | "fusionReactor"
  | "antimatterReactor"
  | "shipyard"
  | "fleetShipyard"
  | "capitalInfrastructure"
  | "capitalShipyard"
  | "radarArray"
  | "phasedRadarArray"
  | "deepSpaceRadarArray"
  | "pointDefenseBattery"
  | "missileBattery"
  | "railBattery"
  | "plasmaBattery"
  | "beamBattery";
export type ShipyardType = "shipyard" | "fleetShipyard" | "capitalShipyard";
export type ResourceType = "alloy";
export type AiDifficulty = "easy" | "normal" | "hard";
export type AiPersonality = "balanced" | "aggressive" | "turtle" | "economic";

export interface AiCommanderSettings {
  difficulty: AiDifficulty;
  personality: AiPersonality;
}

export interface EconomyState {
  alloy: number;
  energy: number;
  alloyIncome: number;
  energyIncome: number;
  alloySpend: number;
  energySpend: number;
  alloyStorage: number;
  energyStorage: number;
  efficiency: number;
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  teamId: TeamId;
  color: number;
  state: "playing" | "disconnected" | "defeated";
  lastCommandSequence: number;
  economy: EconomyState;
}

export interface TeamState {
  id: TeamId;
  name: string;
  alliedTeamIds: TeamId[];
}

export interface TurretHardpointDefinition {
  localX: number;
  localZ: number;
  yawCenter: number;
  yawHalfArc: number;
  weaponTypeId: WeaponTypeId;
}

export interface ShipDefinition {
  class: ShipClass;
  radius: number;
  mass: number;
  maxHealth: number;
  maxShield: number;
  speed: number;
  turnRate: number;
  sensorRange: number;
  buildPower: number;
  buildRange: number;
  hardpoints: readonly TurretHardpointDefinition[];
}

export interface WeaponDefinition {
  id: WeaponTypeId;
  delivery: "projectile" | "beam";
  range: number;
  minimumRange: number;
  cooldownTicks: number;
  burstSize: number;
  burstIntervalTicks: number;
  projectileSpeed: number;
  projectileRadius: number;
  projectileLifetimeTicks: number;
  /** Distance from the rotating hardpoint to the visible end of the weapon. */
  muzzleOffset: number;
  /** Half-spacing between paired barrels; zero for a single emitter. */
  muzzleSeparation: number;
  damage: number;
  traverseRate: number;
  alignmentTolerance: number;
  targetPreference: Readonly<Record<ShipClass, number>>;
  color: number;
}

export interface StructureDefinition {
  type: StructureType;
  radius: number;
  maxHealth: number;
  maxShield: number;
  alloyCost: number;
  energyCost: number;
  buildTicks: number;
  alloyIncome: number;
  energyIncome: number;
  energyUpkeep: number;
  alloyStorage: number;
  energyStorage: number;
  requiredStructures: readonly StructureType[];
  buildPower: number;
  assistRange: number;
  sensorRange: number;
  /** Optional shared weapon used by completed defensive emplacements. */
  weaponTypeId?: WeaponTypeId;
  /** Independent weapon mounts used by fortress-style defensive structures. */
  hardpoints?: readonly TurretHardpointDefinition[];
}

export interface ShipEconomyDefinition {
  alloyCost: number;
  energyCost: number;
  buildTicks: number;
  batchSize: number;
  yardType: ShipyardType;
  requiredStructures: readonly StructureType[];
}

export interface TurretState {
  id: number;
  parentShipId: EntityId;
  weaponTypeId: WeaponTypeId;
  localX: number;
  localZ: number;
  yawCenter: number;
  yawHalfArc: number;
  currentYaw: number;
  targetEntityId: EntityId | null;
  cooldownRemaining: number;
  fireSequence: number;
}

export type NavigationOrderType = "move" | "attackMove" | "patrol" | "hold";

export interface NavigationOrder {
  type: NavigationOrderType;
  destination: Vec2;
  facing: number;
  patrolOrigin?: Vec2;
}

interface FleetCommandBase {
  playerId: PlayerId;
  sequence: number;
  requestedTick: number;
  unitIds: EntityId[];
  queued: boolean;
}

export type FleetCommand =
  | (FleetCommandBase & {
      type: "move" | "attackMove" | "patrol";
      destination: Vec2;
      formationEnd?: Vec2;
    })
  | (FleetCommandBase & { type: "stop" | "hold" })
  | (FleetCommandBase & { type: "focusFire"; targetEntityId: EntityId });

interface EconomyCommandBase {
  playerId: PlayerId;
  sequence: number;
  requestedTick: number;
}

export type EconomyCommand =
  | (EconomyCommandBase & {
      type: "buildStructure";
      structureType: Exclude<StructureType, "commandCore">;
      position: Vec2;
      yaw?: number;
      resourceNodeId?: EntityId;
      builderUnitIds?: EntityId[];
      queued: boolean;
    })
  | (EconomyCommandBase & {
      type: "queueUnit";
      structureId: EntityId;
      shipClass: ShipClass;
      count: number;
    })
  | (EconomyCommandBase & {
      type: "cancelProduction";
      structureId: EntityId;
      queueItemId: EntityId;
    })
  | (EconomyCommandBase & {
      type: "setProductionRepeat";
      structureId: EntityId;
      enabled: boolean;
    })
  | (EconomyCommandBase & {
      type: "clearProductionQueue";
      structureId: EntityId;
    })
  | (EconomyCommandBase & {
      type: "setRallyPoint";
      structureId: EntityId;
      position: Vec2;
    });

export type GameCommand = FleetCommand | EconomyCommand;

export interface FormationAssignment {
  shipId: EntityId;
  destination: Vec2;
  facing: number;
}

export type CommandResult =
  | { accepted: true; scheduledTick: number }
  | { accepted: false; reason: "unknownPlayer" | "duplicate" | "timing" | "ownership" | "target" | "empty" | "placement" | "technology" | "structure" | "queue" };

export interface ShipState {
  id: EntityId;
  ownerPlayerId: PlayerId;
  teamId: TeamId;
  class: ShipClass;
  x: number;
  z: number;
  y: number;
  yaw: number;
  vx: number;
  vz: number;
  health: number;
  shields: number;
  orders: NavigationOrder[];
  focusTargetEntityId: EntityId | null;
  turrets: TurretState[];
}

export interface ProjectileState {
  id: EntityId;
  ownerShipId: EntityId;
  ownerTeamId: TeamId;
  weaponTypeId: WeaponTypeId;
  targetEntityId: EntityId;
  x: number;
  z: number;
  previousX: number;
  previousZ: number;
  vx: number;
  vz: number;
  radius: number;
  damage: number;
  lifetimeTicks: number;
}

export interface ResourceNodeState {
  id: EntityId;
  type: ResourceType;
  x: number;
  z: number;
  richness: number;
  claimedByStructureId: EntityId | null;
}

export interface ObstacleState {
  id: number;
  type: "asteroid" | "barrier";
  x: number;
  z: number;
  radius: number;
  width?: number;
  depth?: number;
  visualSeed: number;
}

export interface TeamVisibilityState {
  teamId: TeamId;
  visibleEntityIds: EntityId[];
  visibleProjectileIds: EntityId[];
  discoveredResourceNodeIds: EntityId[];
}

export interface ProductionQueueItem {
  id: EntityId;
  shipClass: ShipClass;
  progress: number;
}

export interface StructureState {
  id: EntityId;
  ownerPlayerId: PlayerId;
  teamId: TeamId;
  type: StructureType;
  x: number;
  z: number;
  yaw: number;
  health: number;
  shields: number;
  buildProgress: number;
  resourceNodeId: EntityId | null;
  productionQueue: ProductionQueueItem[];
  repeatProduction: boolean;
  rallyPoint: Vec2;
}

export type CombatTargetState = ShipState | StructureState;

export type SimulationEvent =
  | { type: "commandAccepted"; tick: number; playerId: PlayerId; sequence: number; unitIds: EntityId[]; commandType: GameCommand["type"] }
  | { type: "constructionStarted"; tick: number; playerId: PlayerId; structureId: EntityId; structureType: StructureType }
  | { type: "constructionCompleted"; tick: number; playerId: PlayerId; structureId: EntityId; structureType: StructureType }
  | { type: "unitQueued"; tick: number; playerId: PlayerId; structureId: EntityId; shipClass: ShipClass; queueItemId: EntityId }
  | { type: "unitProduced"; tick: number; playerId: PlayerId; structureId: EntityId; shipId: EntityId; shipClass: ShipClass }
  | { type: "weaponFired"; tick: number; turretId: number; shipId: number; targetId: number; projectileId: number; weaponTypeId: WeaponTypeId }
  | { type: "hit"; tick: number; projectileId: number; targetId: number; damage: number }
  | { type: "projectileDetonated"; tick: number; projectileId: number; weaponTypeId: WeaponTypeId; x: number; z: number }
  | { type: "destroyed"; tick: number; entityId: number }
  | { type: "victory"; tick: number; winnerTeamId: TeamId };

export interface SimulationState {
  version: 7;
  seed: number;
  mapPreset?: "orbital-ring" | "crossfire" | "open-expanse" | "asteroid-belt" | "spiral-arms" | "shattered-core" | "amazon-tunnel" | "core-rush" | "star-fortress";
  tick: number;
  nextEntityId: number;
  nextTurretId: number;
  nextQueueItemId: number;
  players: PlayerState[];
  teams: TeamState[];
  ships: ShipState[];
  structures: StructureState[];
  resourceNodes: ResourceNodeState[];
  obstacles: ObstacleState[];
  visibility: TeamVisibilityState[];
  projectiles: ProjectileState[];
  commandQueue: GameCommand[];
  aiPlayerIds: PlayerId[];
  aiCommanders: Record<PlayerId, AiCommanderSettings>;
  status: "playing" | "finished";
  winnerTeamId: TeamId | null;
  checksum: number;
}

export type PlayerViewRelationship = "self" | "ally" | "hostile" | "omniscient";

export interface PlayerViewPlayerState {
  id: PlayerId;
  name: string;
  teamId: TeamId;
  color: number;
  state: PlayerState["state"];
  isAi: boolean;
  economy: EconomyState | null;
}

export interface PlayerViewTurretState {
  id: number;
  parentShipId: EntityId;
  weaponTypeId: WeaponTypeId;
  localX: number;
  localZ: number;
  yawCenter: number;
  yawHalfArc: number;
  currentYaw: number;
  targetEntityId: EntityId | null;
  cooldownRemaining: number;
  fireSequence: number;
}

export interface PlayerViewShipState {
  id: EntityId;
  ownerPlayerId: PlayerId;
  teamId: TeamId;
  relationship: PlayerViewRelationship;
  class: ShipClass;
  x: number;
  z: number;
  y: number;
  yaw: number;
  vx: number;
  vz: number;
  health: number;
  shields: number;
  orders: NavigationOrder[];
  focusTargetEntityId: EntityId | null;
  turrets: PlayerViewTurretState[];
}

export interface PlayerViewStructureState {
  id: EntityId;
  ownerPlayerId: PlayerId;
  teamId: TeamId;
  relationship: PlayerViewRelationship;
  type: StructureType;
  x: number;
  z: number;
  yaw: number;
  health: number;
  shields: number;
  buildProgress: number;
  resourceNodeId: EntityId | null;
  productionQueue: ProductionQueueItem[];
  repeatProduction: boolean;
  rallyPoint: Vec2 | null;
}

export interface PlayerViewResourceNodeState extends ResourceNodeState {}

export interface PlayerViewProjectileState {
  id: EntityId;
  ownerShipId: EntityId | null;
  ownerTeamId: TeamId;
  weaponTypeId: WeaponTypeId;
  targetEntityId: EntityId | null;
  x: number;
  z: number;
  previousX: number;
  previousZ: number;
  vx: number;
  vz: number;
  radius: number;
  damage: number;
  lifetimeTicks: number;
}

export interface PlayerViewState {
  version: 1;
  simulationVersion: 7;
  tick: number;
  viewerPlayerId: PlayerId;
  viewerTeamId: TeamId;
  ownLastCommandSequence: number;
  players: PlayerViewPlayerState[];
  teams: TeamState[];
  ships: PlayerViewShipState[];
  structures: PlayerViewStructureState[];
  resourceNodes: PlayerViewResourceNodeState[];
  obstacles: ObstacleState[];
  projectiles: PlayerViewProjectileState[];
  status: SimulationState["status"];
  winnerTeamId: TeamId | null;
  checksum: number;
}

export interface TeamViewState {
  version: 1;
  simulationVersion: 7;
  tick: number;
  viewerPlayerId: null;
  viewerTeamId: TeamId;
  ownLastCommandSequence: null;
  players: PlayerViewPlayerState[];
  teams: TeamState[];
  ships: PlayerViewShipState[];
  structures: PlayerViewStructureState[];
  resourceNodes: PlayerViewResourceNodeState[];
  obstacles: ObstacleState[];
  projectiles: PlayerViewProjectileState[];
  status: SimulationState["status"];
  winnerTeamId: TeamId | null;
  checksum: number;
}

export interface OmniscientViewState {
  version: 1;
  simulationVersion: 7;
  tick: number;
  players: PlayerViewPlayerState[];
  teams: TeamState[];
  ships: PlayerViewShipState[];
  structures: PlayerViewStructureState[];
  resourceNodes: PlayerViewResourceNodeState[];
  obstacles: ObstacleState[];
  projectiles: PlayerViewProjectileState[];
  status: SimulationState["status"];
  winnerTeamId: TeamId | null;
  checksum: number;
}

export interface AvoidanceDebugState {
  shipId: EntityId;
  obstacleId: number;
  x: number;
  z: number;
  vectorX: number;
  vectorZ: number;
}

export interface DebugSnapshot {
  tick: number;
  checksum: number;
  activeTargetingTurrets: number;
  shotsFired: number;
  hits: number;
  physicsBodyCount: number;
  avoidance: AvoidanceDebugState[];
  events: SimulationEvent[];
}
