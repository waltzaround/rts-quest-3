import type { Vec2 } from "@space-rts/shared";

export type PlayerId = string;
export type TeamId = number;
export type EntityId = number;
export type FactionId = "industrial" | "brood" | "concord";
export type ShipClass =
  | "fighter"
  | "fabricator"
  | "frigate"
  | "bomber"
  | "flakFrigate"
  | "torpedoFrigate"
  | "artilleryFrigate"
  | "destroyer"
  | "artilleryDestroyer"
  | "cruiser"
  | "artilleryCruiser"
  | "carrier"
  | "battleship";
export type WeaponTypeId =
  | "autocannon"
  | "torpedo"
  | "plasma"
  | "heavyRail"
  | "pointDefense"
  | "flakCannon"
  | "beam"
  | "lightArtillery"
  | "siegeArtillery"
  | "strategicArtillery";
export type ArmorType = "light" | "plated" | "heavy" | "fortified";
export type DamageProfile = "rapid" | "flak" | "plasma" | "ordnance" | "penetrating" | "siege";
export type StructureType =
  | "creepNode"
  | "pylon"
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
  | "beamBattery"
  | "artilleryBattery"
  | "heavyArtilleryBattery"
  | "strategicArtilleryArray";
export type ShipyardType = "shipyard" | "fleetShipyard" | "capitalShipyard";
export type ResourceType = "alloy";
export type AiDifficulty = "easy" | "normal" | "hard";
export type AiPersonality = "balanced" | "aggressive" | "turtle" | "economic";

export interface AiCommanderSettings {
  difficulty: AiDifficulty;
  personality: AiPersonality;
}

/** Scouted intelligence and ongoing orders; serialized so AI survives replay/reconnect. */
export interface AiPlanState {
  knownStructures: Array<{ id: EntityId; type: StructureType; x: number; z: number }>;
  searchIndex: number;
  recoveringShipIds: EntityId[];
  constructionWatch?: { key: string; progress: number; lastProgressTick: number };
  blockedSites?: Array<{ x: number; z: number; untilTick: number }>;
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

export interface PlayerMatchStats {
  unitsProduced: number;
  structuresBuilt: number;
  enemyShipsDestroyed: number;
  enemyStructuresDestroyed: number;
  shipsLost: number;
  structuresLost: number;
  alloyCollected: number;
  energyGenerated: number;
  alloySpent: number;
  energySpent: number;
  damageDealt: number;
  damageTaken: number;
}

export interface PlayerState {
  id: PlayerId;
  faction: FactionId;
  name: string;
  teamId: TeamId;
  color: number;
  state: "playing" | "disconnected" | "defeated";
  lastCommandSequence: number;
  economy: EconomyState;
  stats: PlayerMatchStats;
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
  armorType: ArmorType;
  radius: number;
  mass: number;
  maxHealth: number;
  maxShield: number;
  speed: number;
  turnRate: number;
  sensorRange: number;
  cruiseMultiplier: number;
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
  damageProfile: DamageProfile;
  shieldMultiplier: number;
  traverseRate: number;
  alignmentTolerance: number;
  targetPreference: Readonly<Record<ShipClass, number>>;
  color: number;
  /** Artillery-only timings. Their presence identifies a fixed-trajectory artillery weapon. */
  artillery?: {
    setupTicks: number;
    mobileRevealTicks: number;
    structureRevealTicks: number;
    targetReevaluationTicks: number;
  };
}

export interface StructureDefinition {
  type: StructureType;
  armorType: ArmorType;
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
  /** Structure-only reach modifier; does not alter ships using the same weapon. */
  weaponRangeMultiplier?: number;
  /** Structure-only raw-damage modifier; does not alter ships using the same weapon. */
  weaponDamageMultiplier?: number;
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
  /**
   * Tick before which a turret whose last scan found nothing skips further scans.
   * Idle rescans dominate simulation cost in large battles otherwise.
   */
  idleRetargetTick?: number;
}

export type NavigationOrderType = "move" | "attackMove" | "patrol" | "hold";

export interface NavigationOrder {
  type: NavigationOrderType;
  destination: Vec2;
  facing: number;
  patrolOrigin?: Vec2;
  constructionId?: EntityId;
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
  | (FleetCommandBase & { type: "stop" | "hold" | "selfDestruct" })
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
      type: "cancelConstruction";
      structureId: EntityId;
    })
  | (EconomyCommandBase & {
      type: "cancelBuildOrder";
      buildSequence: number;
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
      type: "setWarpPoint";
      structureId: EntityId;
      position: Vec2;
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
  faction?: FactionId;
  broodNestId?: EntityId;
  lastDamageTick?: number;
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
  /** Last weapon fire or damage tick; cruise requires a quiet window after either. */
  lastCombatTick: number;
  /** Artillery-only live state; absent on ordinary ships. */
  artilleryDeploymentTicks?: number;
  /** Artillery-only live state; absent when the entity is not an artillery platform. */
  revealedUntilTick?: number;
}

export interface ProjectileState {
  id: EntityId;
  ownerShipId: EntityId;
  /** Retained for score attribution if the firing entity dies before impact. */
  ownerPlayerId?: PlayerId;
  ownerTeamId: TeamId;
  weaponTypeId: WeaponTypeId;
  targetEntityId: EntityId;
  targetX: number;
  targetZ: number;
  fixedTrajectory: boolean;
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
  warpPoint?: Vec2;
  broodClass?: ShipClass;
  broodProgress?: number;
  constructionSequence?: number;
  upgradeSourceType?: StructureType;
  upgradeSourceHealth?: number;
  upgradeSourceShields?: number;
  upgradeSourceYaw?: number;
  upgradeSourceRallyPoint?: Vec2;
  /** Artillery-only live state; absent on ordinary structures. */
  revealedUntilTick?: number;
}

export type CombatTargetState = ShipState | StructureState;

export type SimulationEvent =
  | { type: "commandAccepted"; tick: number; playerId: PlayerId; sequence: number; unitIds: EntityId[]; commandType: GameCommand["type"] }
  | { type: "constructionStarted"; tick: number; playerId: PlayerId; structureId: EntityId; structureType: StructureType }
  | { type: "constructionCompleted"; tick: number; playerId: PlayerId; structureId: EntityId; structureType: StructureType }
  | { type: "unitQueued"; tick: number; playerId: PlayerId; structureId: EntityId; shipClass: ShipClass; queueItemId: EntityId }
  | { type: "unitProduced"; tick: number; playerId: PlayerId; structureId: EntityId; shipId: EntityId; shipClass: ShipClass }
  | { type: "weaponFired"; tick: number; turretId: number; shipId: number; targetId: number; projectileId: number; weaponTypeId: WeaponTypeId }
  | { type: "hit"; tick: number; projectileId: number; targetId: number; damage: number; rawDamage: number; shieldDamage: number; hullDamage: number }
  | { type: "artilleryRevealed"; tick: number; entityId: number; untilTick: number }
  | { type: "projectileDetonated"; tick: number; projectileId: number; weaponTypeId: WeaponTypeId; x: number; z: number }
  | { type: "destroyed"; tick: number; entityId: number }
  | { type: "victory"; tick: number; winnerTeamId: TeamId };

export interface SimulationState {
  version: 12;
  seed: number;
  mapPreset?: "orbital-ring" | "crossfire" | "open-expanse" | "asteroid-belt" | "spiral-arms" | "shattered-core" | "amazon-tunnel" | "core-rush" | "star-fortress" | "twin-gates" | "broken-halo" | "resource-islands";
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
  territories: TerritoryFieldState[];
  projectiles: ProjectileState[];
  commandQueue: GameCommand[];
  aiPlayerIds: PlayerId[];
  aiCommanders: Record<PlayerId, AiCommanderSettings>;
  aiPlans?: Record<PlayerId, AiPlanState>;
  status: "playing" | "finished";
  winnerTeamId: TeamId | null;
  checksum: number;
}

export type PlayerViewRelationship = "self" | "ally" | "hostile" | "omniscient";

/** Creep can outlive its source while receding; pylon fields vanish with their source. */
export interface TerritoryFieldState {
  id: EntityId;
  ownerPlayerId: PlayerId;
  teamId: TeamId;
  kind: "creep" | "pylon";
  x: number;
  z: number;
  radius: number;
  maxRadius: number;
}

export interface PlayerViewPlayerState {
  id: PlayerId;
  faction: FactionId;
  name: string;
  teamId: TeamId;
  color: number;
  state: PlayerState["state"];
  isAi: boolean;
  economy: EconomyState | null;
  /** Hidden until combat resolution to avoid leaking live opponent intelligence. */
  stats: PlayerMatchStats | null;
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
  faction?: FactionId;
  broodNestId?: EntityId;
  lastDamageTick?: number;
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
  lastCombatTick: number;
  artilleryDeploymentTicks?: number;
  revealedUntilTick?: number;
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
  warpPoint?: Vec2;
  broodClass?: ShipClass;
  broodProgress?: number;
  revealedUntilTick?: number;
}

export interface PlayerViewResourceNodeState extends ResourceNodeState {}

export interface PlayerViewProjectileState {
  id: EntityId;
  ownerShipId: EntityId | null;
  ownerTeamId: TeamId;
  weaponTypeId: WeaponTypeId;
  targetEntityId: EntityId | null;
  targetX: number;
  targetZ: number;
  fixedTrajectory: boolean;
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
  simulationVersion: 12;
  territories: TerritoryFieldState[];
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
  simulationVersion: 12;
  territories: TerritoryFieldState[];
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
  simulationVersion: 12;
  territories: TerritoryFieldState[];
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
