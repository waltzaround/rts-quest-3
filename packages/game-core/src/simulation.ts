import { sweptCircleHitFraction, type PlanarCirclePhysicsWorld } from "@space-rts/box3d-wasm";
import { FIXED_DT, distanceSquared, moveTowardAngle, wrapAngle } from "@space-rts/shared";
import { calculateChecksum } from "./checksum";
import {
  ALL_SHIP_CLASSES,
  BUILDABLE_STRUCTURE_TYPES,
  DAMAGE_PROFILE_MULTIPLIERS,
  DEFENSIVE_STRUCTURE_TYPES,
  FIGHTER_SQUAD_OFFSETS,
  RESOURCE_EXTRACTOR_TYPES,
  SHIPS,
  SHIP_TURRET_SCALES,
  SHIP_ECONOMY,
  SHIPYARD_TYPES,
  STRUCTURES,
  WEAPONS,
  calculateProfiledDamage,
  getFighterSquadMemberPose,
  getStructureWeaponDamage,
  getStructureWeaponRange,
} from "./data";
import { SpatialHash } from "./spatial-hash";
import { projectOmniscientView, projectPlayerView, projectTeamView } from "./player-view";
import {
  areTeamsAllied,
  initializeTeamVisibility,
  isResourceNodeDiscoveredByTeam,
  updateTeamVisibility,
} from "./visibility";
import type {
  CombatTargetState, CommandResult, DebugSnapshot, EntityId, FleetCommand,
  FormationAssignment, GameCommand, NavigationOrder, PlayerId, PlayerState, ProjectileState,
  ObstacleState, ResourceNodeState, ShipClass, ShipState, SimulationEvent, SimulationState,
  AiCommanderSettings, AiDifficulty, AiPersonality, OmniscientViewState, PlayerViewState, ShipyardType, StructureState, StructureType,
  TeamId, TeamState, TeamViewState, TurretState,
} from "./types";

const TARGET_REEVALUATION_TICKS = 10;
const VISIBILITY_UPDATE_TICKS = 2;
const LARGE_BATTLE_SHIP_COUNT = 128;
const LARGE_BATTLE_TARGET_REEVALUATION_TICKS = 20;
const LARGE_BATTLE_VISIBILITY_UPDATE_TICKS = 3;
const STRATEGIC_BATTLE_SHIP_COUNT = 1_000;
const STRATEGIC_NAVIGATION_UPDATE_TICKS = 4;
const STRATEGIC_WEAPON_UPDATE_TICKS = 4;
const STRATEGIC_VISIBILITY_UPDATE_TICKS = 10;
const STRATEGIC_TARGET_REEVALUATION_TICKS = 30;
const MAX_COMBAT_TARGET_RADIUS = Math.max(
  ...Object.values(SHIPS).map((definition) => definition.radius),
  ...Object.values(STRUCTURES).map((definition) => definition.radius),
);
const MAX_SHIP_RADIUS = Math.max(...Object.values(SHIPS).map((definition) => definition.radius));
const MAX_COMMAND_LEAD_TICKS = 40;
const BUILD_RANGE = 360;
const EXTRACTOR_BUILD_RANGE = 420;
const PLACEMENT_PADDING = 8;
const AI_THINK_TICKS = 40;
const CRUISE_DELAY_TICKS = 60;
const BASE_CONSTRUCTION_BUILD_POWER = 1;
const OBSTACLE_CLEARANCE = 8;
const PHYSICS_SUBSTEPS = 4;
const MEDIUM_BATTLE_PHYSICS_SHIP_COUNT = 512;
const LARGE_BATTLE_CHECKSUM_INTERVAL_TICKS = 20;
const CONTESTED_RESOURCE_NODES_PER_PLAYER = 3;
const STARTING_RESOURCE_NODES_PER_PLAYER = 3;
const CAPITAL_SHIP_CLASSES: ReadonlySet<ShipClass> = new Set(["cruiser", "artilleryCruiser", "carrier", "battleship"]);
const CAPITAL_VS_SMALL_CRAFT_HIT_RADIUS_SCALE = 0.78;
const STATIC_COLLISION_CATEGORY = 0x1;
const REGULAR_SHIP_COLLISION_CATEGORY = 0x2;
const SMALL_CRAFT_COLLISION_CATEGORY = 0x4;
const CAPITAL_SHIP_COLLISION_CATEGORY = 0x8;
const ALL_COLLISION_CATEGORIES = STATIC_COLLISION_CATEGORY
  | REGULAR_SHIP_COLLISION_CATEGORY
  | SMALL_CRAFT_COLLISION_CATEGORY
  | CAPITAL_SHIP_COLLISION_CATEGORY;

function strategicWeaponUpdateTicks(shipCount: number): number {
  if (shipCount >= 12_000) return 32;
  if (shipCount >= 8_000) return 16;
  if (shipCount >= 4_000) return 8;
  return STRATEGIC_WEAPON_UPDATE_TICKS;
}

function shipsPhaseThroughStructure(type: StructureType): boolean {
  return SHIPYARD_TYPES.includes(type as ShipyardType)
    || type === "fabricator"
    || type === "advancedFabrication"
    || type === "capitalInfrastructure";
}

function getShipArtilleryWeapon(shipClass: ShipClass) {
  return SHIPS[shipClass].hardpoints
    .map((hardpoint) => WEAPONS[hardpoint.weaponTypeId])
    .find((weapon) => weapon.artillery !== undefined);
}

function shouldEmitProjectileDetonation(projectile: ProjectileState, owner: ShipState | undefined): boolean {
  return projectile.weaponTypeId === "torpedo" || owner?.class !== "fighter";
}

export interface ScenarioOptions {
  seed?: number;
  fightersPerTeam?: number;
  bombersPerTeam?: number;
  /** Explicit combat/test fixture. Normal matches always begin with no ships. */
  startingFleet?: boolean;
  /** Local deterministic showcase with prebuilt industry and a large mixed fleet. */
  showcase?: boolean;
  /** Lightweight title-screen battle with two fighter-heavy AI fleets. */
  menuBattle?: boolean;
  enemyCommander?: boolean;
  mapPreset?: "orbital-ring" | "crossfire" | "open-expanse" | "asteroid-belt" | "spiral-arms" | "shattered-core"
    | "amazon-tunnel" | "core-rush" | "star-fortress";
  mapSize?: "small" | "medium" | "large" | "huge" | "colossal";
  startingResources?: "low" | "standard" | "high";
  startingBase?: "full" | "fortified" | "command-core";
  resourceDensity?: "scarce" | "standard" | "rich";
  teamSpawnMode?: "together" | "interleaved" | "random";
  /** Seeded one-on-one deployment variation for playable matches. */
  varyStartingPositions?: boolean;
  players?: readonly ScenarioPlayerConfig[];
}

export interface ScenarioPlayerConfig {
  id: string;
  name: string;
  teamId: number;
  color?: number;
  ai?: boolean;
  aiDifficulty?: AiDifficulty;
  aiPersonality?: AiPersonality;
}

export class GameSimulation {
  readonly state: SimulationState;
  private readonly spatialHash = new SpatialHash<CombatTargetState>(160);
  private readonly navigationHash = new SpatialHash<ShipState>(160);
  private readonly obstacleHash = new SpatialHash<ObstacleState>(220);
  private readonly staticCollisionHash = new SpatialHash<{ id: number; x: number; z: number; radius: number }>(220);
  private readonly targetsById = new Map<EntityId, CombatTargetState>();
  private readonly visibleEntityIdsByTeam = new Map<TeamId, Set<EntityId>>();
  private readonly alliedTeamIdsByTeam = new Map<TeamId, Set<TeamId>>();
  private readonly events: SimulationEvent[] = [];
  private shotsFired = 0;
  private hits = 0;
  private physicsWorld: PlanarCirclePhysicsWorld | null = null;
  private physicsBodyCount = 0;
  private avoidance: import("./types").AvoidanceDebugState[] = [];
  private readonly productionRateMultiplier: number;
  private checksumTick = -1;
  private maxObstacleRadius = 0;
  private maxStaticRadius = 0;
  /** Derived every tick; intentionally excluded from deterministic snapshots. */
  private readonly cruisingShipIds = new Set<EntityId>();

  constructor(
    state: SimulationState,
    physicsWorld?: PlanarCirclePhysicsWorld,
    productionRateMultiplier = 1,
  ) {
    this.state = state;
    this.physicsWorld = physicsWorld ?? null;
    // A restored snapshot begins a new deterministic timeline. Box2D keeps
    // contact and allocator history outside our serialized state, so it must
    // not leak in from a menu battle, replay seek, or earlier multiplayer run.
    this.physicsWorld?.reset();
    this.productionRateMultiplier = Math.max(1, productionRateMultiplier);
    for (const structure of this.state.structures) {
      structure.repeatProduction ??= false;
      if (STRUCTURES[structure.type].hardpoints?.some((hardpoint) => WEAPONS[hardpoint.weaponTypeId].artillery)) {
        structure.revealedUntilTick ??= 0;
      }
    }
    for (const ship of this.state.ships) {
      ship.lastCombatTick ??= this.state.tick;
      if (getShipArtilleryWeapon(ship.class)) {
        ship.artilleryDeploymentTicks ??= 0;
        ship.revealedUntilTick ??= 0;
      }
    }
    for (const projectile of this.state.projectiles) {
      projectile.targetX ??= projectile.x + projectile.vx * FIXED_DT * projectile.lifetimeTicks;
      projectile.targetZ ??= projectile.z + projectile.vz * FIXED_DT * projectile.lifetimeTicks;
      projectile.fixedTrajectory ??= false;
    }
    if (this.state.visibility.length === 0) {
      initializeTeamVisibility(this.state);
      updateTeamVisibility(this.state);
    }
    this.refreshVisibilityCache();
    this.state.checksum = calculateChecksum(this.state);
    this.checksumTick = this.state.tick;
  }

  attachPhysicsWorld(physicsWorld: PlanarCirclePhysicsWorld): void {
    physicsWorld.reset();
    this.physicsWorld = physicsWorld;
    this.physicsBodyCount = 0;
  }

  get physicsBackend(): "box3d-wasm" | "deterministic-fallback" {
    return this.physicsWorld ? "box3d-wasm" : "deterministic-fallback";
  }

  maintainMenuBattleReinforcements(capPerPlayer = 28, cadenceTicks = 90): void {
    if (this.state.status !== "playing") return;
    for (const structure of this.state.structures) {
      structure.productionQueue = [];
      structure.repeatProduction = false;
    }
    for (const player of this.state.players) {
      player.economy.alloy = 0;
      player.economy.energy = 0;
    }
    if (this.state.tick % cadenceTicks !== 0) return;
    const roster: readonly ShipClass[] = [
      "fighter", "fighter", "fighter", "bomber", "fighter", "fighter",
      "cruiser", "fighter", "fighter", "bomber", "fighter", "battleship",
    ];
    const fleetCounts = new Map(this.state.players.map((player) => [
      player.id,
      this.state.ships.filter((ship) => ship.ownerPlayerId === player.id).length,
    ]));
    const leadingFleetCount = Math.max(0, ...fleetCounts.values());
    const waveIndex = Math.floor(this.state.tick / cadenceTicks);
    for (const player of this.state.players) {
      const ownedCount = fleetCounts.get(player.id) ?? 0;
      if (ownedCount >= capPerPlayer) continue;
      const core = this.state.structures.find(
        (structure) => structure.ownerPlayerId === player.id && structure.type === "commandCore",
      );
      if (!core) continue;
      const radialLength = Math.hypot(core.x, core.z) || 1;
      const outwardX = core.x / radialLength;
      const outwardZ = core.z / radialLength;
      const spawnX = outwardX * 600;
      const spawnZ = outwardZ * 600;
      const yaw = Math.atan2(-outwardX, -outwardZ);
      const catchUpCount = Math.min(2, Math.max(0, leadingFleetCount - ownedCount));
      const reinforcementCount = Math.min(capPerPlayer - ownedCount, 1 + catchUpCount);
      for (let reinforcement = 0; reinforcement < reinforcementCount; reinforcement += 1) {
        const shipClass = roster[(waveIndex + reinforcement) % roster.length]!;
        const yardType: ShipyardType = shipClass === "cruiser"
          ? "fleetShipyard"
          : shipClass === "battleship" ? "capitalShipyard" : "shipyard";
        const ship = this.spawnShip(player, shipClass, spawnX, spawnZ, yaw, yardType);
        ship.orders = [{
          type: "patrol",
          destination: projectNavigableDestination(this.state, ship, { x: 0, z: 0 }),
          facing: yaw,
          patrolOrigin: { x: ship.x, z: ship.z },
        }];
      }
    }
    for (const ship of this.state.ships) {
      if (ship.orders.length > 0) continue;
      ship.orders = [{
        type: "patrol",
        destination: projectNavigableDestination(this.state, ship, { x: 0, z: 0 }),
        facing: Math.atan2(-ship.x, -ship.z),
        patrolOrigin: { x: ship.x, z: ship.z },
      }];
    }
  }

  step(): DebugSnapshot {
    this.events.length = 0;
    this.shotsFired = 0;
    this.hits = 0;
    this.avoidance = [];
    this.state.tick += 1;
    this.ingestCommands();
    this.updateEconomyAndProduction();
    this.obstacleHash.rebuild(this.state.obstacles);
    this.maxObstacleRadius = this.state.obstacles.reduce(
      (largest, obstacle) => obstacle.type === "asteroid" ? Math.max(largest, obstacle.radius) : largest, 0,
    );
    if (this.state.ships.length <= STRATEGIC_BATTLE_SHIP_COUNT
      || this.state.tick % STRATEGIC_NAVIGATION_UPDATE_TICKS === 1) {
      this.navigationHash.rebuild(this.state.ships);
    }
    this.updateNavigation();
    this.updateArtilleryDeployment();
    this.integrateMovement();
    const combatTargets: CombatTargetState[] = [...this.state.ships, ...this.state.structures];
    this.spatialHash.rebuild(combatTargets);
    this.targetsById.clear();
    for (const target of combatTargets) this.targetsById.set(target.id, target);
    const visibilityUpdateTicks = this.state.ships.length > STRATEGIC_BATTLE_SHIP_COUNT
      ? STRATEGIC_VISIBILITY_UPDATE_TICKS
      : this.state.ships.length > LARGE_BATTLE_SHIP_COUNT
        ? LARGE_BATTLE_VISIBILITY_UPDATE_TICKS
        : VISIBILITY_UPDATE_TICKS;
    if (this.state.tick === 1 || this.state.tick % visibilityUpdateTicks === 0) {
      updateTeamVisibility(this.state, this.spatialHash);
      this.refreshVisibilityCache();
    }
    this.updateTargetingAndTraverse();
    this.fireWeapons();
    this.fireDefensiveStructures();
    this.integrateProjectilesAndDamage();
    this.destroyDeadEntities();
    this.evaluateVictory();
    this.runEnemyCommanders();
    if (this.state.ships.length < MEDIUM_BATTLE_PHYSICS_SHIP_COUNT
      || this.state.tick - this.checksumTick >= LARGE_BATTLE_CHECKSUM_INTERVAL_TICKS) {
      this.refreshChecksum();
    }
    return this.debugSnapshot();
  }

  stepMany(count: number): DebugSnapshot {
    let snapshot = this.debugSnapshot();
    for (let index = 0; index < count; index += 1) snapshot = this.step();
    return snapshot;
  }

  snapshot(): SimulationState {
    return JSON.parse(JSON.stringify(this.state)) as SimulationState;
  }

  /** Forces a full-state determinism audit before checkpoints and resynchronization snapshots. */
  refreshChecksum(): number {
    this.state.checksum = calculateChecksum(this.state);
    this.checksumTick = this.state.tick;
    return this.state.checksum;
  }

  playerView(playerId: string): PlayerViewState | null {
    return projectPlayerView(this.state, playerId);
  }

  teamView(teamId: number): TeamViewState | null {
    return projectTeamView(this.state, teamId);
  }

  omniscientView(): OmniscientViewState {
    return projectOmniscientView(this.state);
  }

  submitCommand(command: GameCommand): CommandResult {
    const player = this.state.players.find((candidate) => candidate.id === command.playerId);
    if (!player) return { accepted: false, reason: "unknownPlayer" };
    if (player.state === "defeated") return { accepted: false, reason: "ownership" };
    if (command.sequence <= player.lastCommandSequence) return { accepted: false, reason: "duplicate" };
    if (command.requestedTick <= this.state.tick || command.requestedTick > this.state.tick + MAX_COMMAND_LEAD_TICKS) {
      return { accepted: false, reason: "timing" };
    }

    let normalizedCommand = command;
    if (command.type === "move" || command.type === "attackMove" || command.type === "patrol" || command.type === "stop" || command.type === "hold" || command.type === "focusFire") {
      const uniqueUnitIds = [...new Set(command.unitIds)].sort((a, b) => a - b);
      if (uniqueUnitIds.length === 0) return { accepted: false, reason: "empty" };
      const byId = new Map(this.state.ships.map((ship) => [ship.id, ship]));
      if (uniqueUnitIds.some((id) => byId.get(id)?.ownerPlayerId !== command.playerId)) {
        return { accepted: false, reason: "ownership" };
      }
      if (command.type === "focusFire") {
        const target = this.findTarget(command.targetEntityId);
        if (!target || !this.isHostile(player.teamId, target.teamId)
          || !this.isEntityVisible(player.teamId, target.id)) {
          return { accepted: false, reason: "target" };
        }
      }
      normalizedCommand = { ...command, unitIds: uniqueUnitIds };
    } else if (command.type === "buildStructure") {
      const builderUnitIds = [...new Set(command.builderUnitIds ?? [])].sort((a, b) => a - b);
      if (builderUnitIds.length > 32) return { accepted: false, reason: "empty" };
      const shipsById = new Map(this.state.ships.map((ship) => [ship.id, ship]));
      if (builderUnitIds.some((id) => {
        const ship = shipsById.get(id);
        return !ship || ship.ownerPlayerId !== command.playerId || SHIPS[ship.class].buildPower <= 0;
      })) return { accepted: false, reason: "ownership" };
      if (!this.canBuildStructure(command.playerId, command.structureType)) {
        return { accepted: false, reason: "technology" };
      }
      if (!this.canPlaceStructure(
        command.playerId, command.structureType, command.position, command.resourceNodeId, builderUnitIds,
      )) {
        return { accepted: false, reason: "placement" };
      }
      normalizedCommand = { ...command, builderUnitIds };
    } else if (command.type === "cancelConstruction") {
      const structure = this.state.structures.find((candidate) => candidate.id === command.structureId);
      if (!structure || structure.ownerPlayerId !== command.playerId || structure.buildProgress >= 1) {
        return { accepted: false, reason: "structure" };
      }
    } else if (command.type === "cancelBuildOrder") {
      const hasPendingOrder = this.state.commandQueue.some((candidate) =>
        candidate.type === "buildStructure"
        && candidate.playerId === command.playerId
        && candidate.sequence === command.buildSequence,
      );
      const hasMaterializedSite = this.state.structures.some((structure) =>
        structure.ownerPlayerId === command.playerId
        && structure.buildProgress < 1
        && structure.constructionSequence === command.buildSequence,
      );
      if (!hasPendingOrder && !hasMaterializedSite) return { accepted: false, reason: "queue" };
    } else if (command.type === "queueUnit" || command.type === "cancelProduction"
      || command.type === "setProductionRepeat" || command.type === "clearProductionQueue"
      || command.type === "setRallyPoint") {
      const structure = this.state.structures.find((candidate) => candidate.id === command.structureId);
      if (!structure || structure.ownerPlayerId !== command.playerId
        || !SHIPYARD_TYPES.includes(structure.type as ShipyardType) || structure.buildProgress < 1) {
        return { accepted: false, reason: "structure" };
      }
      if (command.type === "queueUnit" && !this.canStructureProduceShipClass(command.playerId, structure.id, command.shipClass)) {
        return { accepted: false, reason: "technology" };
      }
      if (command.type === "queueUnit" && (command.count < 1 || command.count > 5)) {
        return { accepted: false, reason: "queue" };
      }
      if (command.type === "cancelProduction" && !structure.productionQueue.some((item) => item.id === command.queueItemId)) {
        return { accepted: false, reason: "queue" };
      }
      if (command.type === "setRallyPoint" && (!Number.isFinite(command.position.x) || !Number.isFinite(command.position.z))) {
        return { accepted: false, reason: "target" };
      }
    }

    player.lastCommandSequence = command.sequence;
    this.state.commandQueue.push(JSON.parse(JSON.stringify(normalizedCommand)) as GameCommand);
    this.state.commandQueue.sort((a, b) =>
      a.requestedTick - b.requestedTick || compareCodeUnits(a.playerId, b.playerId) || a.sequence - b.sequence,
    );
    return { accepted: true, scheduledTick: command.requestedTick };
  }

  canPlaceStructure(
    playerId: string,
    structureType: Exclude<StructureType, "commandCore">,
    position: Readonly<{ x: number; z: number }>,
    resourceNodeId?: EntityId,
    builderUnitIds: readonly EntityId[] = [],
  ): boolean {
    if (!this.canBuildStructure(playerId, structureType)) return false;
    const definition = STRUCTURES[structureType];
    const isExtractor = RESOURCE_EXTRACTOR_TYPES.includes(
      structureType as (typeof RESOURCE_EXTRACTOR_TYPES)[number],
    );
    const resourceNode = isExtractor
      ? this.state.resourceNodes.find((candidate) => candidate.id === resourceNodeId)
      : undefined;
    const placementPosition = resourceNode ?? position;
    const upgradeSource = this.getResourceExtractorUpgradeSource(playerId, structureType, resourceNodeId);
    const inStaticBuildRange = this.hasStaticBuildAnchorInRange(
      playerId,
      placementPosition,
      isExtractor ? EXTRACTOR_BUILD_RANGE : BUILD_RANGE,
    );
    const hasAssignedMobileBuilder = this.getAssignedMobileBuilders(playerId, builderUnitIds).length > 0;
    if (!inStaticBuildRange && !hasAssignedMobileBuilder) {
      return false;
    }
    for (const structure of this.state.structures) {
      if (structure.id === upgradeSource?.id) continue;
      const minimumDistance = STRUCTURES[structure.type].radius + definition.radius + PLACEMENT_PADDING;
      if (Math.hypot(structure.x - placementPosition.x, structure.z - placementPosition.z) < minimumDistance) return false;
    }
    for (const obstacle of this.state.obstacles) {
      if (circleOverlapsObstacle(placementPosition.x, placementPosition.z, definition.radius + PLACEMENT_PADDING, obstacle)) return false;
    }
    for (const command of this.state.commandQueue) {
      if (command.type !== "buildStructure") continue;
      const queuedIsExtractor = RESOURCE_EXTRACTOR_TYPES.includes(
        command.structureType as (typeof RESOURCE_EXTRACTOR_TYPES)[number],
      );
      if (isExtractor && queuedIsExtractor && command.resourceNodeId === resourceNodeId
        && resourceNode?.claimedByStructureId === null) continue;
      const minimumDistance = STRUCTURES[command.structureType].radius + definition.radius + PLACEMENT_PADDING;
      const queuedNode = queuedIsExtractor
        ? this.state.resourceNodes.find((candidate) => candidate.id === command.resourceNodeId)
        : undefined;
      const queuedPosition = queuedNode ?? command.position;
      if (Math.hypot(queuedPosition.x - placementPosition.x, queuedPosition.z - placementPosition.z) < minimumDistance) return false;
    }
    if (isExtractor) {
      const player = this.state.players.find((candidate) => candidate.id === playerId);
      return Boolean(player && resourceNode
        && isResourceNodeDiscoveredByTeam(this.state, player.teamId, resourceNode.id)
        && (resourceNode.claimedByStructureId === null || upgradeSource !== null));
    }
    return resourceNodeId === undefined;
  }

  private getResourceExtractorUpgradeSource(
    playerId: string,
    structureType: Exclude<StructureType, "commandCore">,
    resourceNodeId?: EntityId,
  ): StructureState | null {
    const targetRank = RESOURCE_EXTRACTOR_TYPES.indexOf(
      structureType as (typeof RESOURCE_EXTRACTOR_TYPES)[number],
    );
    if (targetRank <= 0 || resourceNodeId === undefined) return null;
    const node = this.state.resourceNodes.find((candidate) => candidate.id === resourceNodeId);
    if (!node || node.claimedByStructureId === null) return null;
    const source = this.state.structures.find((structure) => structure.id === node.claimedByStructureId);
    if (!source || source.ownerPlayerId !== playerId || source.buildProgress < 1) return null;
    const sourceRank = RESOURCE_EXTRACTOR_TYPES.indexOf(
      source.type as (typeof RESOURCE_EXTRACTOR_TYPES)[number],
    );
    return sourceRank >= 0 && sourceRank < targetRank ? source : null;
  }

  private hasStaticBuildAnchorInRange(
    playerId: string,
    position: Readonly<{ x: number; z: number }>,
    range = BUILD_RANGE,
  ): boolean {
    return this.state.structures.some((structure) =>
      structure.ownerPlayerId === playerId
        && structure.buildProgress >= 1
        && (structure.type === "commandCore" || structure.type === "fabricator")
        && Math.hypot(structure.x - position.x, structure.z - position.z) <= range,
    );
  }

  private getAssignedMobileBuilders(playerId: string, builderUnitIds: readonly EntityId[]): ShipState[] {
    const requestedBuilderIds = new Set(builderUnitIds);
    return this.state.ships
      .filter((ship) => requestedBuilderIds.has(ship.id)
        && ship.ownerPlayerId === playerId
        && SHIPS[ship.class].buildPower > 0)
      .sort((left, right) => left.id - right.id);
  }

  private sendMobileBuilderToSite(
    builder: ShipState,
    position: Readonly<{ x: number; z: number }>,
    queued: boolean,
  ): void {
    const alreadyQueued = builder.orders.some((order) =>
      order.type === "move"
        && Math.hypot(order.destination.x - position.x, order.destination.z - position.z) < 0.001,
    );
    if (queued && alreadyQueued) return;
    const order: NavigationOrder = {
      type: "move",
      destination: projectNavigableDestination(this.state, builder, position),
      facing: Math.atan2(position.x - builder.x, position.z - builder.z),
    };
    if (queued) builder.orders.push(order);
    else builder.orders = [order];
    builder.focusTargetEntityId = null;
  }

  private removeMobileBuilderSiteOrder(
    builder: ShipState,
    position: Readonly<{ x: number; z: number }>,
  ): void {
    const siteOrderRadius = Math.max(1, SHIPS[builder.class].buildRange);
    builder.orders = builder.orders.filter((order) =>
      order.type !== "move"
        || Math.hypot(order.destination.x - position.x, order.destination.z - position.z) > siteOrderRadius,
    );
    builder.focusTargetEntityId = null;
  }

  private holdMobileBuilderAtConstruction(builder: ShipState, construction: StructureState): void {
    this.removeMobileBuilderSiteOrder(builder, construction);
    builder.orders = builder.orders.filter((order) => order.constructionId !== construction.id);
    builder.orders.unshift({
      type: "hold",
      destination: { x: construction.x, z: construction.z },
      facing: Math.atan2(construction.x - builder.x, construction.z - builder.z),
      constructionId: construction.id,
    });
    builder.focusTargetEntityId = null;
  }

  private assignMobileBuilderToConstruction(
    builder: ShipState,
    construction: StructureState,
    queued: boolean,
  ): void {
    const inRange = Math.hypot(builder.x - construction.x, builder.z - construction.z)
      <= SHIPS[builder.class].buildRange;
    if (inRange) {
      this.holdMobileBuilderAtConstruction(builder, construction);
      return;
    }
    this.sendMobileBuilderToSite(builder, construction, queued);
    builder.orders = builder.orders.filter((order) => order.constructionId !== construction.id);
    const siteOrderRadius = Math.max(1, SHIPS[builder.class].buildRange);
    const siteOrderIndex = builder.orders.findIndex((order) =>
      order.type === "move"
      && Math.hypot(order.destination.x - construction.x, order.destination.z - construction.z) <= siteOrderRadius,
    );
    const holdOrder: NavigationOrder = {
      type: "hold", destination: { x: construction.x, z: construction.z },
      facing: Math.atan2(construction.x - builder.x, construction.z - builder.z),
      constructionId: construction.id,
    };
    builder.orders.splice(siteOrderIndex < 0 ? 0 : siteOrderIndex + 1, 0, holdOrder);
  }

  private releaseMobileBuildersFromConstruction(structureId: EntityId): void {
    for (const builder of this.state.ships) {
      builder.orders = builder.orders.filter((order) => order.constructionId !== structureId);
    }
  }

  private cancelConstructionSite(structure: StructureState): void {
    this.releaseMobileBuildersFromConstruction(structure.id);
    this.state.structures = this.state.structures.filter((candidate) => candidate.id !== structure.id);
    if (structure.resourceNodeId === null) return;
    const node = this.state.resourceNodes.find((candidate) => candidate.id === structure.resourceNodeId);
    if (!node || node.claimedByStructureId !== structure.id) return;
    if (!structure.upgradeSourceType) {
      node.claimedByStructureId = null;
      return;
    }
    const sourceDefinition = STRUCTURES[structure.upgradeSourceType];
    const restoredSource: StructureState = {
      id: this.state.nextEntityId++, ownerPlayerId: structure.ownerPlayerId, teamId: structure.teamId,
      type: structure.upgradeSourceType, x: node.x, z: node.z,
      yaw: wrapAngle(structure.upgradeSourceYaw ?? structure.yaw),
      health: Math.min(sourceDefinition.maxHealth, structure.upgradeSourceHealth ?? sourceDefinition.maxHealth),
      shields: Math.min(sourceDefinition.maxShield, structure.upgradeSourceShields ?? sourceDefinition.maxShield),
      buildProgress: 1, resourceNodeId: node.id, productionQueue: [], repeatProduction: false,
      rallyPoint: structure.upgradeSourceRallyPoint
        ? { ...structure.upgradeSourceRallyPoint }
        : this.defaultRallyPoint(structure.ownerPlayerId, node.x, node.z),
    };
    this.state.structures.push(restoredSource);
    node.claimedByStructureId = restoredSource.id;
  }

  private cancelPendingBuildOrder(playerId: PlayerId, buildSequence: number): boolean {
    const pending = this.state.commandQueue.find(
      (command): command is Extract<GameCommand, { type: "buildStructure" }> =>
        command.type === "buildStructure"
        && command.playerId === playerId
        && command.sequence === buildSequence,
    );
    if (pending) {
      this.state.commandQueue = this.state.commandQueue.filter((command) => command !== pending);
      const node = pending.resourceNodeId === undefined
        ? undefined
        : this.state.resourceNodes.find((candidate) => candidate.id === pending.resourceNodeId);
      const position = node ?? pending.position;
      for (const builder of this.getAssignedMobileBuilders(playerId, pending.builderUnitIds ?? [])) {
        this.removeMobileBuilderSiteOrder(builder, position);
      }
      return true;
    }
    const construction = this.state.structures.find((structure) =>
      structure.ownerPlayerId === playerId
      && structure.buildProgress < 1
      && structure.constructionSequence === buildSequence,
    );
    if (!construction) return false;
    this.cancelConstructionSite(construction);
    return true;
  }

  private cancelCompetingResourceExtractorOrders(
    resourceNodeId: EntityId,
    position: Readonly<{ x: number; z: number }>,
  ): void {
    const competingOrders = this.state.commandQueue.filter(
      (command): command is Extract<GameCommand, { type: "buildStructure" }> =>
        command.type === "buildStructure"
        && command.resourceNodeId === resourceNodeId
        && RESOURCE_EXTRACTOR_TYPES.includes(
          command.structureType as (typeof RESOURCE_EXTRACTOR_TYPES)[number],
        ),
    );
    if (competingOrders.length === 0) return;
    const cancelledCommands: ReadonlySet<GameCommand> = new Set(competingOrders as GameCommand[]);
    this.state.commandQueue = this.state.commandQueue.filter((command) => !cancelledCommands.has(command));
    for (const command of competingOrders) {
      for (const builder of this.getAssignedMobileBuilders(command.playerId, command.builderUnitIds ?? [])) {
        this.removeMobileBuilderSiteOrder(builder, position);
      }
    }
  }

  canBuildStructure(playerId: string, structureType: Exclude<StructureType, "commandCore">): boolean {
    const player = this.state.players.find((candidate) => candidate.id === playerId);
    if (!player || player.state === "defeated"
      || !BUILDABLE_STRUCTURE_TYPES.includes(structureType as (typeof BUILDABLE_STRUCTURE_TYPES)[number])) return false;
    const completedTypes = new Set(
      this.state.structures
        .filter((structure) => structure.ownerPlayerId === playerId && structure.buildProgress >= 1)
        .map((structure) => structure.type),
    );
    return STRUCTURES[structureType].requiredStructures.every((requiredType) => completedTypes.has(requiredType));
  }

  getAvailableStructureTypes(playerId: string): Exclude<StructureType, "commandCore">[] {
    return BUILDABLE_STRUCTURE_TYPES.filter((structureType) => this.canBuildStructure(playerId, structureType));
  }

  canProduceShipClass(playerId: string, shipClass: ShipClass): boolean {
    const player = this.state.players.find((candidate) => candidate.id === playerId);
    if (!player || player.state === "defeated") return false;
    const completedTypes = new Set(
      this.state.structures
        .filter((structure) => structure.ownerPlayerId === playerId && structure.buildProgress >= 1)
        .map((structure) => structure.type),
    );
    const economy = SHIP_ECONOMY[shipClass];
    return completedTypes.has(economy.yardType)
      && economy.requiredStructures.every((requiredType) => completedTypes.has(requiredType));
  }

  canStructureProduceShipClass(playerId: string, structureId: EntityId, shipClass: ShipClass): boolean {
    const structure = this.state.structures.find((candidate) => candidate.id === structureId);
    return Boolean(
      structure
      && structure.ownerPlayerId === playerId
      && structure.buildProgress >= 1
      && structure.type === SHIP_ECONOMY[shipClass].yardType
      && this.canProduceShipClass(playerId, shipClass),
    );
  }

  getAvailableShipClasses(playerId: string): ShipClass[] {
    return ALL_SHIP_CLASSES.filter((shipClass) => this.canProduceShipClass(playerId, shipClass));
  }

  getConstructionAssistingFabricatorIds(structureId: EntityId): EntityId[] {
    const construction = this.state.structures.find((structure) => structure.id === structureId);
    if (!construction || construction.buildProgress >= 1) return [];
    const staticFabricators = this.state.structures
      .filter((structure) => {
        if (structure.ownerPlayerId !== construction.ownerPlayerId
          || structure.type !== "fabricator"
          || structure.buildProgress < 1) return false;
        const definition = STRUCTURES[structure.type];
        return Math.hypot(structure.x - construction.x, structure.z - construction.z) <= definition.assistRange;
      })
      .sort((a, b) => a.id - b.id)
      .map((structure) => structure.id);
    const mobileFabricators = this.state.ships
      .filter((ship) => ship.ownerPlayerId === construction.ownerPlayerId
        && SHIPS[ship.class].buildPower > 0
        && Math.hypot(ship.x - construction.x, ship.z - construction.z) <= SHIPS[ship.class].buildRange)
      .sort((a, b) => a.id - b.id)
      .map((ship) => ship.id);
    return [...staticFabricators, ...mobileFabricators].sort((a, b) => a - b);
  }

  getConstructionBuildPower(structureId: EntityId): number {
    const construction = this.state.structures.find((structure) => structure.id === structureId);
    if (!construction || construction.buildProgress >= 1) return 0;
    return BASE_CONSTRUCTION_BUILD_POWER + this.getConstructionAssistingFabricatorIds(structureId)
      .reduce((total, fabricatorId) => {
        const structure = this.state.structures.find((candidate) => candidate.id === fabricatorId);
        if (structure) return total + STRUCTURES[structure.type].buildPower;
        const ship = this.state.ships.find((candidate) => candidate.id === fabricatorId);
        return total + (ship ? SHIPS[ship.class].buildPower : 0);
      }, 0);
  }

  debugSnapshot(): DebugSnapshot {
    return {
      tick: this.state.tick,
      checksum: this.state.checksum,
      activeTargetingTurrets: this.state.ships.reduce(
        (count, ship) => count + ship.turrets.filter((turret) => turret.targetEntityId !== null).length,
        0,
      ),
      shotsFired: this.shotsFired,
      hits: this.hits,
      physicsBodyCount: this.physicsBodyCount,
      avoidance: [...this.avoidance],
      events: [...this.events],
    };
  }

  private ingestCommands(): void {
    const due: GameCommand[] = [];
    const pending: GameCommand[] = [];
    for (const command of this.state.commandQueue) {
      if (command.requestedTick <= this.state.tick) due.push(command);
      else pending.push(command);
    }
    this.state.commandQueue = pending;
    const byId = new Map(this.state.ships.map((ship) => [ship.id, ship]));

    for (const command of due) {
      if (isFleetCommand(command)) {
        const ships = command.unitIds
          .map((id) => byId.get(id))
          .filter((ship): ship is ShipState => ship?.ownerPlayerId === command.playerId)
          .sort((a, b) => a.id - b.id);
        if (ships.length === 0) continue;
        if (command.type === "move" || command.type === "attackMove" || command.type === "patrol") {
          const assignments = computeFormationAssignments(ships, command.destination, command.formationEnd);
          for (const assignment of assignments) {
            const ship = byId.get(assignment.shipId)!;
            const order: NavigationOrder = {
              type: command.type,
              destination: projectNavigableDestination(this.state, ship, assignment.destination),
              facing: assignment.facing,
              ...(command.type === "patrol" ? { patrolOrigin: { x: ship.x, z: ship.z } } : {}),
            };
            if (command.queued) ship.orders.push(order);
            else ship.orders = [order];
            ship.focusTargetEntityId = null;
          }
        } else if (command.type === "stop" || command.type === "hold") {
          for (const ship of ships) {
            ship.orders = command.type === "hold"
              ? [{ type: "hold", destination: { x: ship.x, z: ship.z }, facing: ship.yaw }]
              : [];
            ship.focusTargetEntityId = null;
          }
        } else if (command.type === "focusFire") {
          const player = this.state.players.find((candidate) => candidate.id === command.playerId);
          const target = this.findTarget(command.targetEntityId);
          if (!player || !target || !this.isHostile(player.teamId, target.teamId)
            || !this.isEntityVisible(player.teamId, target.id)) continue;
          for (const ship of ships) {
            ship.focusTargetEntityId = command.targetEntityId;
            for (const turret of ship.turrets) turret.targetEntityId = null;
          }
        }
        this.events.push({
          type: "commandAccepted", tick: this.state.tick, playerId: command.playerId,
          sequence: command.sequence, unitIds: ships.map((ship) => ship.id), commandType: command.type,
        });
        continue;
      }

      if (command.type === "buildStructure") {
        const builderUnitIds = command.builderUnitIds ?? [];
        if (!this.canBuildStructure(command.playerId, command.structureType)
          || !this.canPlaceStructure(
            command.playerId, command.structureType, command.position, command.resourceNodeId, builderUnitIds,
          )) {
          const claimedNode = command.resourceNodeId === undefined
            ? undefined
            : this.state.resourceNodes.find((candidate) => candidate.id === command.resourceNodeId);
          if (claimedNode?.claimedByStructureId !== null && claimedNode?.claimedByStructureId !== undefined
            && RESOURCE_EXTRACTOR_TYPES.includes(
              command.structureType as (typeof RESOURCE_EXTRACTOR_TYPES)[number],
            )) {
            for (const builder of this.getAssignedMobileBuilders(command.playerId, builderUnitIds)) {
              this.removeMobileBuilderSiteOrder(builder, claimedNode);
            }
          }
          continue;
        }
        const node = command.resourceNodeId === undefined
          ? undefined
          : this.state.resourceNodes.find((candidate) => candidate.id === command.resourceNodeId);
        const constructionPosition = node ?? command.position;
        const upgradeSource = this.getResourceExtractorUpgradeSource(
          command.playerId, command.structureType, command.resourceNodeId,
        );
        const mobileBuilders = this.getAssignedMobileBuilders(command.playerId, builderUnitIds);
        const waitingForEarlierConstruction = command.queued && mobileBuilders.some((builder) =>
          builder.orders.some((order) => order.constructionId !== undefined),
        );
        if (waitingForEarlierConstruction) {
          command.requestedTick = this.state.tick + 1;
          this.state.commandQueue.push(command);
          continue;
        }
        const mobileBuilderInRange = mobileBuilders.some((builder) =>
          Math.hypot(builder.x - constructionPosition.x, builder.z - constructionPosition.z)
            <= SHIPS[builder.class].buildRange,
        );
        if (!this.hasStaticBuildAnchorInRange(command.playerId, constructionPosition)
          && !mobileBuilderInRange) {
          for (const builder of mobileBuilders) {
            this.sendMobileBuilderToSite(builder, constructionPosition, command.queued);
          }
          command.requestedTick = this.state.tick + 1;
          this.state.commandQueue.push(command);
          continue;
        }
        const definition = STRUCTURES[command.structureType];
        const structure: StructureState = {
          id: this.state.nextEntityId++, ownerPlayerId: command.playerId,
          teamId: this.state.players.find((player) => player.id === command.playerId)!.teamId,
          type: command.structureType,
          x: node?.x ?? command.position.x, z: node?.z ?? command.position.z, yaw: wrapAngle(command.yaw ?? 0),
          health: definition.maxHealth * 0.1, shields: 0, buildProgress: 0,
          resourceNodeId: node?.id ?? null, productionQueue: [], repeatProduction: false,
          rallyPoint: this.defaultRallyPoint(command.playerId, node?.x ?? command.position.x, node?.z ?? command.position.z),
          constructionSequence: command.sequence,
          ...(definition.hardpoints?.some((hardpoint) => WEAPONS[hardpoint.weaponTypeId].artillery)
            ? { revealedUntilTick: 0 }
            : {}),
          ...(upgradeSource ? {
            upgradeSourceType: upgradeSource.type,
            upgradeSourceHealth: upgradeSource.health,
            upgradeSourceShields: upgradeSource.shields,
            upgradeSourceYaw: upgradeSource.yaw,
            upgradeSourceRallyPoint: { ...upgradeSource.rallyPoint },
          } : {}),
        };
        if (upgradeSource) {
          this.state.structures = this.state.structures.filter((candidate) => candidate.id !== upgradeSource.id);
        }
        this.state.structures.push(structure);
        if (node) {
          node.claimedByStructureId = structure.id;
          this.cancelCompetingResourceExtractorOrders(node.id, constructionPosition);
        }
        for (const builder of mobileBuilders) {
          this.assignMobileBuilderToConstruction(builder, structure, command.queued);
        }
        this.events.push({ type: "constructionStarted", tick: this.state.tick, playerId: command.playerId, structureId: structure.id, structureType: structure.type });
      } else if (command.type === "cancelConstruction") {
        const structure = this.state.structures.find((candidate) => candidate.id === command.structureId);
        if (!structure || structure.ownerPlayerId !== command.playerId || structure.buildProgress >= 1) continue;
        this.cancelConstructionSite(structure);
      } else if (command.type === "cancelBuildOrder") {
        if (!this.cancelPendingBuildOrder(command.playerId, command.buildSequence)) continue;
      } else {
        const structure = this.state.structures.find((candidate) => candidate.id === command.structureId);
        if (!structure || structure.ownerPlayerId !== command.playerId) continue;
        if (command.type === "queueUnit") {
          if (!this.canStructureProduceShipClass(command.playerId, structure.id, command.shipClass)) continue;
          for (let index = 0; index < command.count; index += 1) {
            const item = { id: this.state.nextQueueItemId++, shipClass: command.shipClass, progress: 0 };
            structure.productionQueue.push(item);
            this.events.push({
              type: "unitQueued", tick: this.state.tick, playerId: command.playerId,
              structureId: structure.id, shipClass: command.shipClass, queueItemId: item.id,
            });
          }
        } else if (command.type === "cancelProduction") {
          structure.productionQueue = structure.productionQueue.filter((item) => item.id !== command.queueItemId);
        } else if (command.type === "setProductionRepeat") {
          structure.repeatProduction = command.enabled;
        } else if (command.type === "clearProductionQueue") {
          structure.productionQueue = [];
          structure.repeatProduction = false;
        } else {
          structure.rallyPoint = { ...command.position };
        }
      }
      this.events.push({
        type: "commandAccepted", tick: this.state.tick, playerId: command.playerId,
        sequence: command.sequence,
        unitIds: command.type === "buildStructure" ? command.builderUnitIds ?? [] : [],
        commandType: command.type,
      });
    }
    this.state.commandQueue.sort((a, b) =>
      a.requestedTick - b.requestedTick || compareCodeUnits(a.playerId, b.playerId) || a.sequence - b.sequence,
    );
    this.state.structures.sort((a, b) => a.id - b.id);
  }

  private updateEconomyAndProduction(): void {
    for (const player of this.state.players) {
      const structures = this.state.structures.filter((structure) => structure.ownerPlayerId === player.id);
      let alloyIncome = 0;
      let energyIncome = 0;
      let alloyStorage = 500;
      let energyStorage = 500;
      for (const structure of structures) {
        if (structure.buildProgress < 1) continue;
        const definition = STRUCTURES[structure.type];
        const richness = RESOURCE_EXTRACTOR_TYPES.includes(
          structure.type as (typeof RESOURCE_EXTRACTOR_TYPES)[number],
        )
          ? this.state.resourceNodes.find((node) => node.id === structure.resourceNodeId)?.richness ?? 1
          : 1;
        alloyIncome += definition.alloyIncome * richness;
        energyIncome += definition.energyIncome;
        alloyStorage += definition.alloyStorage;
        energyStorage += definition.energyStorage;
      }
      const economy = player.economy;
      economy.alloyIncome = alloyIncome;
      economy.energyIncome = energyIncome;
      economy.alloyStorage = alloyStorage;
      economy.energyStorage = energyStorage;
      economy.alloy = Math.min(alloyStorage, economy.alloy + alloyIncome * FIXED_DT);
      economy.energy = Math.min(energyStorage, economy.energy + energyIncome * FIXED_DT);

      const construction = structures.filter((structure) => structure.buildProgress < 1);
      const producing = structures.filter((structure) => {
        const item = structure.productionQueue[0];
        return structure.buildProgress >= 1
          && item !== undefined
          && this.canStructureProduceShipClass(player.id, structure.id, item.shipClass);
      });
      const constructionBuildPower = new Map(
        construction.map((structure) => [structure.id, this.getConstructionBuildPower(structure.id)]),
      );
      const idleEnergyDraw = structures
        .filter((structure) => structure.buildProgress >= 1)
        .reduce((sum, structure) => sum + STRUCTURES[structure.type].energyUpkeep * FIXED_DT, 0);
      const requestedAlloy = construction.reduce((sum, structure) => {
        const definition = STRUCTURES[structure.type];
        return sum + definition.alloyCost * constructionBuildPower.get(structure.id)! / definition.buildTicks;
      }, 0) + producing.reduce((sum, structure) => {
        const definition = SHIP_ECONOMY[structure.productionQueue[0]!.shipClass];
        return sum + definition.alloyCost * this.productionRateMultiplier / definition.buildTicks;
      }, 0);
      const requestedEnergy = idleEnergyDraw + construction.reduce((sum, structure) => {
        const definition = STRUCTURES[structure.type];
        return sum + definition.energyCost * constructionBuildPower.get(structure.id)! / definition.buildTicks;
      }, 0) + producing.reduce((sum, structure) => {
        const definition = SHIP_ECONOMY[structure.productionQueue[0]!.shipClass];
        return sum + definition.energyCost * this.productionRateMultiplier / definition.buildTicks;
      }, 0);
      const efficiency = Math.min(
        1,
        requestedAlloy > 0 ? economy.alloy / requestedAlloy : 1,
        requestedEnergy > 0 ? economy.energy / requestedEnergy : 1,
      );
      economy.efficiency = efficiency;
      economy.alloy -= requestedAlloy * efficiency;
      economy.energy -= requestedEnergy * efficiency;
      economy.alloySpend = requestedAlloy * efficiency / FIXED_DT;
      economy.energySpend = requestedEnergy * efficiency / FIXED_DT;

      for (const structure of construction) {
        const definition = STRUCTURES[structure.type];
        const previousProgress = structure.buildProgress;
        const buildPower = constructionBuildPower.get(structure.id)!;
        structure.buildProgress = Math.min(1, structure.buildProgress + efficiency * buildPower / definition.buildTicks);
        const progressDelta = structure.buildProgress - previousProgress;
        structure.health = Math.min(definition.maxHealth, structure.health + definition.maxHealth * 0.9 * progressDelta);
        if (previousProgress < 1 && structure.buildProgress >= 1 - 1e-9) {
          structure.buildProgress = 1;
          structure.health = definition.maxHealth;
          structure.shields = definition.maxShield;
          this.releaseMobileBuildersFromConstruction(structure.id);
          delete structure.constructionSequence;
          delete structure.upgradeSourceType;
          delete structure.upgradeSourceHealth;
          delete structure.upgradeSourceShields;
          delete structure.upgradeSourceYaw;
          delete structure.upgradeSourceRallyPoint;
          this.events.push({
            type: "constructionCompleted", tick: this.state.tick, playerId: player.id,
            structureId: structure.id, structureType: structure.type,
          });
        }
      }

      for (const structure of producing) {
        const item = structure.productionQueue[0];
        if (!item) continue;
        const definition = SHIP_ECONOMY[item.shipClass];
        item.progress = Math.min(
          1,
          item.progress + efficiency * this.productionRateMultiplier / definition.buildTicks,
        );
        if (item.progress < 1 - 1e-9) continue;
        item.progress = 1;
        structure.productionQueue.shift();
        if (structure.repeatProduction) {
          const repeatedItem = { id: this.state.nextQueueItemId++, shipClass: item.shipClass, progress: 0 };
          structure.productionQueue.push(repeatedItem);
          this.events.push({
            type: "unitQueued", tick: this.state.tick, playerId: player.id,
            structureId: structure.id, shipClass: item.shipClass, queueItemId: repeatedItem.id,
          });
        }
        const spawnYaw = Math.atan2(structure.rallyPoint.x - structure.x, structure.rallyPoint.z - structure.z);
        const batch = Array.from({ length: definition.batchSize }, () =>
          this.spawnShip(player, item.shipClass, structure.x, structure.z, spawnYaw, structure.type as ShipyardType));
        const assignments = computeFormationAssignments(batch, structure.rallyPoint);
        for (const assignment of assignments) {
          const ship = batch.find((candidate) => candidate.id === assignment.shipId)!;
          ship.orders = [{
            type: "attackMove",
            destination: projectNavigableDestination(this.state, ship, assignment.destination),
            facing: assignment.facing,
          }];
          this.events.push({
            type: "unitProduced", tick: this.state.tick, playerId: player.id,
            structureId: structure.id, shipId: ship.id, shipClass: ship.class,
          });
        }
      }
    }
  }

  private updateNavigation(): void {
    const navigationStatics = buildNavigableStatics(this.state);
    const staggerSlowUpdates = this.state.ships.length > STRATEGIC_BATTLE_SHIP_COUNT;
    this.cruisingShipIds.clear();
    for (const ship of this.state.ships) {
      const definition = SHIPS[ship.class];
      if (ship.revealedUntilTick !== undefined && ship.revealedUntilTick < this.state.tick) ship.revealedUntilTick = 0;
      const order = ship.orders[0];
      const cruising = Boolean(
        order
        && order.type !== "hold"
        && definition.cruiseMultiplier > 1
        && this.state.tick - ship.lastCombatTick >= CRUISE_DELAY_TICKS
        && ship.focusTargetEntityId === null
        && ship.turrets.every((turret) => turret.targetEntityId === null)
        && !this.detectsNearbyHostile(ship),
      );
      if (cruising) this.cruisingShipIds.add(ship.id);
      if (cruising && ship.artilleryDeploymentTicks !== undefined) ship.artilleryDeploymentTicks = 0;
      if (!order || order.type === "hold") {
        ship.vx *= 0.72;
        ship.vz *= 0.72;
        if (Math.hypot(ship.vx, ship.vz) < 0.05) { ship.vx = 0; ship.vz = 0; }
        continue;
      }
      if (staggerSlowUpdates && (this.state.tick + ship.id) % STRATEGIC_NAVIGATION_UPDATE_TICKS !== 0) {
        continue;
      }
      const combatVector = this.getSmallCraftCombatVector(ship, order);
      if (combatVector) {
        this.steerShip(ship, combatVector.x, combatVector.z, 1);
        continue;
      }
      const navigableDestination = projectNavigableDestination(this.state, ship, order.destination, navigationStatics);
      order.destination = navigableDestination;
      const arrivalRadius = Math.max(10, definition.radius * 1.2);
      const distanceToGoal = Math.sqrt(distanceSquared(ship, order.destination));
      if (distanceToGoal <= arrivalRadius) {
        if (order.type === "patrol" && order.patrolOrigin) {
          const reached = order.destination;
          order.destination = projectNavigableDestination(this.state, ship, order.patrolOrigin, navigationStatics);
          order.patrolOrigin = { x: reached.x, z: reached.z };
          order.facing = Math.atan2(order.destination.x - ship.x, order.destination.z - ship.z);
          ship.focusTargetEntityId = null;
          continue;
        }
        ship.orders.shift();
        if (ship.orders.length === 0) {
          ship.yaw = moveTowardAngle(ship.yaw, order.facing, definition.turnRate * FIXED_DT);
          ship.vx *= 0.55;
          ship.vz *= 0.55;
        }
        continue;
      }
      let seekX = (order.destination.x - ship.x) / Math.max(distanceToGoal, 0.001);
      let seekZ = (order.destination.z - ship.z) / Math.max(distanceToGoal, 0.001);
      const arrivalScale = Math.min(1, distanceToGoal / Math.max(60, definition.radius * 4));
      this.steerShip(ship, seekX, seekZ, arrivalScale);
    }
  }

  private detectsNearbyHostile(ship: ShipState): boolean {
    const range = SHIPS[ship.class].sensorRange;
    const rangeSquared = range * range;
    for (const target of this.navigationHash.query(ship.x, ship.z, range)) {
      if (target.id === ship.id || target.health <= 0 || !this.isHostile(ship.teamId, target.teamId)) continue;
      if (distanceSquared(ship, target) <= rangeSquared) return true;
    }
    for (const target of this.state.structures) {
      if (target.health <= 0 || !this.isHostile(ship.teamId, target.teamId)) continue;
      if (distanceSquared(ship, target) <= rangeSquared) return true;
    }
    return false;
  }

  private updateArtilleryDeployment(): void {
    for (const ship of this.state.ships) {
      const artillery = getShipArtilleryWeapon(ship.class)?.artillery;
      if (!artillery) continue;
      if (this.cruisingShipIds.has(ship.id) || Math.hypot(ship.vx, ship.vz) > 0.05) {
        ship.artilleryDeploymentTicks = 0;
      } else {
        ship.artilleryDeploymentTicks = Math.min(artillery.setupTicks, (ship.artilleryDeploymentTicks ?? 0) + 1);
      }
    }
  }

  private getSmallCraftCombatVector(
    ship: ShipState,
    order: NavigationOrder | undefined,
  ): { x: number; z: number } | null {
    if (ship.class !== "fighter" && ship.class !== "bomber") return null;
    if (order?.type === "hold" || (order?.type !== "attackMove" && order?.type !== "patrol" && ship.focusTargetEntityId === null)) return null;
    const targetId = ship.focusTargetEntityId
      ?? ship.turrets.find((turret) => turret.weaponTypeId !== "pointDefense" && turret.targetEntityId !== null)?.targetEntityId
      ?? null;
    if (targetId === null) return null;
    const target = this.findTarget(targetId);
    if (!target || target.health <= 0 || !this.isHostile(ship.teamId, target.teamId)
      || !this.isEntityVisible(ship.teamId, target.id)) return null;

    const dx = target.x - ship.x;
    const dz = target.z - ship.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 0.001) return null;
    const towardX = dx / distance;
    const towardZ = dz / distance;
    const period = ship.class === "fighter" ? 88 : 132;
    const phaseTick = this.state.tick + ship.id * 17;
    const passIndex = Math.floor(phaseTick / period);
    const phase = phaseTick % period / period;
    const outerRange = ship.class === "fighter" ? 205 : 325;
    const breakawayRange = ship.class === "fighter" ? 72 : 95;
    const approaching = distance > outerRange || (distance >= breakawayRange && phase < 0.64);
    const side = (passIndex + ship.id) % 2 === 0 ? 1 : -1;
    const lateral = approaching
      ? (ship.class === "fighter" ? 0.34 : 0.22)
      : (ship.class === "fighter" ? 0.78 : 0.62);
    const radial = approaching ? 1 : -1;
    return {
      x: towardX * radial + towardZ * side * lateral,
      z: towardZ * radial - towardX * side * lateral,
    };
  }

  private steerShip(ship: ShipState, desiredX: number, desiredZ: number, speedScale: number): void {
      const definition = SHIPS[ship.class];
      let seekX = desiredX;
      let seekZ = desiredZ;
      let separationX = 0;
      let separationZ = 0;
      const neighborRange = (definition.radius + MAX_SHIP_RADIUS) * 2.25;
      for (const neighbor of this.navigationHash.query(ship.x, ship.z, neighborRange)) {
        if (neighbor.id === ship.id || neighbor.teamId !== ship.teamId) continue;
        if (!shipsUseFormationSeparation(ship.class, neighbor.class)) continue;
        const dx = ship.x - neighbor.x;
        const dz = ship.z - neighbor.z;
        const distance = Math.hypot(dx, dz);
        const desiredSpacing = (definition.radius + SHIPS[neighbor.class].radius) * 1.25;
        if (distance > 0.001 && distance < desiredSpacing * 1.8) {
          const strength = (desiredSpacing * 1.8 - distance) / (desiredSpacing * 1.8);
          separationX += dx / distance * strength;
          separationZ += dz / distance * strength;
        }
      }
      seekX += separationX * 0.72;
      seekZ += separationZ * 0.72;
      const avoidance = this.computeObstacleAvoidance(ship, seekX, seekZ);
      if (avoidance) {
        seekX += avoidance.vectorX * 1.65;
        seekZ += avoidance.vectorZ * 1.65;
        this.avoidance.push({
          shipId: ship.id,
          obstacleId: avoidance.obstacleId,
          x: ship.x,
          z: ship.z,
          vectorX: avoidance.vectorX,
          vectorZ: avoidance.vectorZ,
        });
      }
      const steerLength = Math.hypot(seekX, seekZ) || 1;
      const desiredYaw = Math.atan2(seekX / steerLength, seekZ / steerLength);
      ship.yaw = moveTowardAngle(ship.yaw, desiredYaw, definition.turnRate * FIXED_DT);
      const movementSpeed = definition.speed * (this.cruisingShipIds.has(ship.id) ? definition.cruiseMultiplier : 1);
      ship.vx = Math.sin(ship.yaw) * movementSpeed * speedScale;
      ship.vz = Math.cos(ship.yaw) * movementSpeed * speedScale;
  }

  private integrateMovement(): void {
    const overlapStatics = [
      ...this.state.obstacles.filter((obstacle) => obstacle.type === "asteroid")
        .map((obstacle) => ({ id: -obstacle.id, x: obstacle.x, z: obstacle.z, radius: obstacle.radius })),
      ...this.state.structures.filter((structure) => !shipsPhaseThroughStructure(structure.type)).map((structure) => ({
        id: structure.id, x: structure.x, z: structure.z, radius: STRUCTURES[structure.type].radius,
      })),
    ];
    this.staticCollisionHash.rebuild(overlapStatics);
    this.maxStaticRadius = overlapStatics.reduce((largest, obstacle) => Math.max(largest, obstacle.radius), 0);
    if (this.physicsWorld) {
      const staticCircles = [
        ...this.state.obstacles.filter((obstacle) => obstacle.type === "asteroid").map((obstacle) => ({
          id: `obstacle:${obstacle.id}`, x: obstacle.x, z: obstacle.z, radius: obstacle.radius,
        })),
        ...this.state.structures.filter((structure) => !shipsPhaseThroughStructure(structure.type)).map((structure) => ({
          id: `structure:${structure.id}`, x: structure.x, z: structure.z, radius: STRUCTURES[structure.type].radius,
        })),
      ];
      this.physicsWorld.syncBodies({
        staticCircles,
        dynamicCircles: this.state.ships.map((ship) => {
          const definition = SHIPS[ship.class];
          const sphereVolume = 4 / 3 * Math.PI * definition.radius ** 3;
          const collision = shipCollisionFilter(ship.class);
          return {
            id: `ship:${ship.id}`, x: ship.x, z: ship.z, radius: definition.radius,
            vx: ship.vx, vz: ship.vz, density: definition.mass / sphereVolume,
            collisionCategory: collision.category,
            collisionMask: collision.mask,
          };
        }),
      });
      const shipsByPhysicsId = new Map(this.state.ships.map((ship) => [`ship:${ship.id}`, ship]));
      const physicsSubsteps = this.state.ships.length > LARGE_BATTLE_SHIP_COUNT ? 2 : PHYSICS_SUBSTEPS;
      for (const body of this.physicsWorld.step(FIXED_DT, physicsSubsteps)) {
        const ship = shipsByPhysicsId.get(body.id);
        if (!ship) continue;
        ship.x = quantizePhysics(body.x);
        ship.z = quantizePhysics(body.z);
        ship.vx = quantizePhysics(body.vx);
        ship.vz = quantizePhysics(body.vz);
        this.resolveStaticOverlaps(ship);
        this.resolveBarrierOverlaps(ship);
      }
      this.physicsBodyCount = this.physicsWorld.bodyCount;
      return;
    }
    for (const ship of this.state.ships) {
      ship.x += ship.vx * FIXED_DT;
      ship.z += ship.vz * FIXED_DT;
      this.resolveStaticOverlaps(ship);
      this.resolveBarrierOverlaps(ship);
    }
    this.physicsBodyCount = 0;
  }

  private computeObstacleAvoidance(
    ship: ShipState,
    desiredX: number,
    desiredZ: number,
  ): { obstacleId: number; vectorX: number; vectorZ: number } | null {
    const desiredLength = Math.hypot(desiredX, desiredZ);
    if (desiredLength < 0.001) return null;
    const forwardX = desiredX / desiredLength;
    const forwardZ = desiredZ / desiredLength;
    const definition = SHIPS[ship.class];
    let totalX = 0;
    let totalZ = 0;
    let strongestObstacleId = -1;
    let strongest = 0;
    const searchRadius = Math.max(
      this.maxObstacleRadius * 2.1 + definition.radius + OBSTACLE_CLEARANCE,
      definition.speed * 2.4 + this.maxObstacleRadius,
    );
    for (const obstacle of this.obstacleHash.query(ship.x, ship.z, searchRadius)) {
      if (obstacle.type === "barrier") continue;
      const toX = obstacle.x - ship.x;
      const toZ = obstacle.z - ship.z;
      const clearance = obstacle.radius + definition.radius + OBSTACLE_CLEARANCE;
      const lookahead = Math.max(clearance * 2.1, definition.speed * 2.4);
      const projection = toX * forwardX + toZ * forwardZ;
      if (projection < -clearance || projection > lookahead) continue;
      const closestProjection = Math.max(0, projection);
      let offsetX = ship.x + forwardX * closestProjection - obstacle.x;
      let offsetZ = ship.z + forwardZ * closestProjection - obstacle.z;
      let lateralDistance = Math.hypot(offsetX, offsetZ);
      if (lateralDistance >= clearance) continue;
      const cross = forwardX * toZ - forwardZ * toX;
      const side = Math.abs(cross) > 0.001 ? Math.sign(cross) : ((ship.id + obstacle.id) % 2 === 0 ? 1 : -1);
      if (lateralDistance < 0.001) {
        offsetX = forwardZ * side;
        offsetZ = -forwardX * side;
        lateralDistance = 1;
      }
      const urgency = (1 - lateralDistance / clearance)
        * (1 - Math.max(0, projection) / Math.max(lookahead, 1) * 0.3);
      const tangentX = forwardZ * side;
      const tangentZ = -forwardX * side;
      const vectorX = offsetX / lateralDistance * urgency * 1.35 + tangentX * urgency;
      const vectorZ = offsetZ / lateralDistance * urgency * 1.35 + tangentZ * urgency;
      totalX += vectorX;
      totalZ += vectorZ;
      const strength = Math.hypot(vectorX, vectorZ);
      if (strength > strongest || (strength === strongest && obstacle.id < strongestObstacleId)) {
        strongest = strength;
        strongestObstacleId = obstacle.id;
      }
    }
    return strongestObstacleId < 0 ? null : { obstacleId: strongestObstacleId, vectorX: totalX, vectorZ: totalZ };
  }

  private resolveStaticOverlaps(
    ship: ShipState,
  ): void {
    const radius = SHIPS[ship.class].radius;
    const statics = this.staticCollisionHash.query(ship.x, ship.z, radius + this.maxStaticRadius + 1);
    for (let pass = 0; pass < 4; pass += 1) {
      let resolved = false;
      for (const obstacle of statics) {
        let dx = ship.x - obstacle.x;
        let dz = ship.z - obstacle.z;
        let distance = Math.hypot(dx, dz);
        const minimumDistance = radius + obstacle.radius;
        if (distance >= minimumDistance - 0.00001) continue;
        if (distance < 0.001) {
          const angle = (ship.id * 2.399963229728653) % (Math.PI * 2);
          dx = Math.sin(angle);
          dz = Math.cos(angle);
          distance = 1;
        }
        ship.x = obstacle.x + dx / distance * minimumDistance;
        ship.z = obstacle.z + dz / distance * minimumDistance;
        const inwardVelocity = ship.vx * dx / distance + ship.vz * dz / distance;
        if (inwardVelocity < 0) {
          ship.vx -= dx / distance * inwardVelocity;
          ship.vz -= dz / distance * inwardVelocity;
        }
        resolved = true;
      }
      if (!resolved) break;
    }
  }

  private resolveBarrierOverlaps(ship: ShipState): void {
    const radius = SHIPS[ship.class].radius;
    for (const obstacle of this.state.obstacles) {
      if (obstacle.type !== "barrier" || !obstacle.width || !obstacle.depth) continue;
      const halfWidth = obstacle.width * 0.5;
      const halfDepth = obstacle.depth * 0.5;
      const nearestX = Math.max(obstacle.x - halfWidth, Math.min(ship.x, obstacle.x + halfWidth));
      const nearestZ = Math.max(obstacle.z - halfDepth, Math.min(ship.z, obstacle.z + halfDepth));
      let dx = ship.x - nearestX;
      let dz = ship.z - nearestZ;
      let distance = Math.hypot(dx, dz);
      if (distance >= radius) continue;
      if (distance < 0.001) {
        const left = Math.abs(ship.x - (obstacle.x - halfWidth));
        const right = Math.abs(obstacle.x + halfWidth - ship.x);
        const top = Math.abs(ship.z - (obstacle.z - halfDepth));
        const bottom = Math.abs(obstacle.z + halfDepth - ship.z);
        const nearest = Math.min(left, right, top, bottom);
        if (nearest === left) { dx = -1; dz = 0; ship.x = obstacle.x - halfWidth - radius; }
        else if (nearest === right) { dx = 1; dz = 0; ship.x = obstacle.x + halfWidth + radius; }
        else if (nearest === top) { dx = 0; dz = -1; ship.z = obstacle.z - halfDepth - radius; }
        else { dx = 0; dz = 1; ship.z = obstacle.z + halfDepth + radius; }
        distance = 1;
      } else {
        ship.x = nearestX + dx / distance * radius;
        ship.z = nearestZ + dz / distance * radius;
      }
      const inwardVelocity = ship.vx * dx / distance + ship.vz * dz / distance;
      if (inwardVelocity < 0) {
        ship.vx -= dx / distance * inwardVelocity;
        ship.vz -= dz / distance * inwardVelocity;
      }
    }
  }

  private updateTargetingAndTraverse(): void {
    const weaponUpdateTicks = this.state.ships.length > STRATEGIC_BATTLE_SHIP_COUNT
      ? strategicWeaponUpdateTicks(this.state.ships.length)
      : 1;
    const targetReevaluationTicks = this.state.ships.length > STRATEGIC_BATTLE_SHIP_COUNT
      ? STRATEGIC_TARGET_REEVALUATION_TICKS
      : this.state.ships.length > LARGE_BATTLE_SHIP_COUNT
        ? LARGE_BATTLE_TARGET_REEVALUATION_TICKS
        : TARGET_REEVALUATION_TICKS;
    for (const ship of this.state.ships) {
      if (weaponUpdateTicks > 1 && (this.state.tick + ship.id) % weaponUpdateTicks !== 0) continue;
      if (ship.focusTargetEntityId !== null
        && !this.isEntityVisible(ship.teamId, ship.focusTargetEntityId)) {
        ship.focusTargetEntityId = null;
      }
      const targetLoad = new Map<EntityId, number>();
      const operationalTurretCount = getOperationalTurretCount(ship);
      for (let turretIndex = 0; turretIndex < ship.turrets.length; turretIndex += 1) {
        const turret = ship.turrets[turretIndex]!;
        if (turretIndex >= operationalTurretCount) {
          turret.targetEntityId = null;
          continue;
        }
        const weapon = WEAPONS[turret.weaponTypeId];
        let target = turret.targetEntityId === null ? undefined : this.findTarget(turret.targetEntityId);
        const reevaluationTicks = Math.max(
          targetReevaluationTicks,
          weapon.artillery?.targetReevaluationTicks ?? 0,
        );
        const mustReevaluate = (this.state.tick + turret.id) % reevaluationTicks < weaponUpdateTicks;
        if (!target || !this.isValidTarget(ship, turret, target) || mustReevaluate) {
          target = this.acquireTarget(ship, turret, targetLoad);
          turret.targetEntityId = target?.id ?? null;
        }
        if (target) {
          targetLoad.set(target.id, (targetLoad.get(target.id) ?? 0) + 1);
          turret.currentYaw = moveTowardAngle(
            turret.currentYaw,
            getLocalBearing(ship, target.x, target.z),
            weapon.traverseRate * FIXED_DT * weaponUpdateTicks,
          );
        } else {
          turret.currentYaw = moveTowardAngle(
            turret.currentYaw,
            turret.yawCenter,
            weapon.traverseRate * FIXED_DT * weaponUpdateTicks,
          );
        }
        if (turret.cooldownRemaining > 0) turret.cooldownRemaining = Math.max(0, turret.cooldownRemaining - weaponUpdateTicks);
      }
    }
  }

  private acquireTarget(ship: ShipState, turret: TurretState, targetLoad: ReadonlyMap<EntityId, number>): CombatTargetState | undefined {
    const weapon = WEAPONS[turret.weaponTypeId];
    if (ship.focusTargetEntityId !== null) {
      const focused = this.findTarget(ship.focusTargetEntityId);
      if (focused && this.isValidTarget(ship, turret, focused)) return focused;
    }
    let best: CombatTargetState | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const candidate of this.spatialHash.query(ship.x, ship.z, weapon.range)) {
      if (!this.isValidTarget(ship, turret, candidate)) continue;
      const rangeScore = distanceSquared(ship, candidate) / (weapon.range * weapon.range) * 100_000;
      const preference = isShip(candidate)
        ? weapon.targetPreference[candidate.class]
        : getStructureTargetPreference(turret.weaponTypeId, candidate.type);
      const armorType = isShip(candidate) ? SHIPS[candidate.class].armorType : STRUCTURES[candidate.type].armorType;
      const effectiveMultiplier = candidate.shields > 0
        ? weapon.shieldMultiplier
        : DAMAGE_PROFILE_MULTIPLIERS[weapon.damageProfile][armorType];
      const cycleTicks = Math.max(1, weapon.cooldownTicks + (weapon.burstSize - 1) * weapon.burstIntervalTicks);
      const expectedDps = weapon.damage * weapon.burstSize * effectiveMultiplier * 20 / cycleTicks;
      const distribution = (targetLoad.get(candidate.id) ?? 0) * 25_000;
      const roleHint = Math.max(-10, Math.min(10, preference));
      const score = -expectedDps * 1_000_000 + roleHint * 100_000 + distribution + rangeScore;
      if (score < bestScore || (score === bestScore && candidate.id < (best?.id ?? Infinity))) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  }

  private isValidTarget(ship: ShipState, turret: TurretState, target: CombatTargetState): boolean {
    if (target.health <= 0 || !this.isHostile(ship.teamId, target.teamId)
      || !this.isEntityVisible(ship.teamId, target.id)) return false;
    const weapon = WEAPONS[turret.weaponTypeId];
    if (weapon.artillery
      && (this.cruisingShipIds.has(ship.id)
        || (ship.artilleryDeploymentTicks ?? 0) < weapon.artillery.setupTicks
        || Math.hypot(ship.vx, ship.vz) > 0.05)) return false;
    const rangeSquared = distanceSquared(ship, target);
    if (rangeSquared > weapon.range ** 2 || rangeSquared < weapon.minimumRange ** 2) return false;
    return isPointInTurretArc(ship, turret, target.x, target.z);
  }

  private fireWeapons(): void {
    const weaponUpdateTicks = this.state.ships.length > STRATEGIC_BATTLE_SHIP_COUNT
      ? strategicWeaponUpdateTicks(this.state.ships.length)
      : 1;
    for (const ship of this.state.ships) {
      if (weaponUpdateTicks > 1 && (this.state.tick + ship.id) % weaponUpdateTicks !== 0) continue;
      const operationalTurretCount = getOperationalTurretCount(ship);
      for (let turretIndex = 0; turretIndex < operationalTurretCount; turretIndex += 1) {
        const turret = ship.turrets[turretIndex]!;
        if (turret.cooldownRemaining > 0 || turret.targetEntityId === null) continue;
        const target = this.findTarget(turret.targetEntityId);
        if (!target || !this.isValidTarget(ship, turret, target)) continue;
        const weapon = WEAPONS[turret.weaponTypeId];
        const desiredYaw = getLocalBearing(ship, target.x, target.z);
        if (Math.abs(wrapAngle(desiredYaw - turret.currentYaw)) > weapon.alignmentTolerance) continue;
        const muzzle = getTurretMuzzleWorldPosition(ship, turret, turret.fireSequence, this.state.tick);
        const dx = target.x - muzzle.x;
        const dz = target.z - muzzle.z;
        const length = Math.hypot(dx, dz) || 1;
        const weaponCycleTicks = Math.max(
          1,
          (weapon.burstSize - 1) * weapon.burstIntervalTicks + weapon.cooldownTicks,
        );
        const consolidatedDamageScale = Math.max(
          1,
          weaponUpdateTicks * weapon.burstSize / weaponCycleTicks,
        );
        const projectileId = this.state.nextEntityId++;
        if (weapon.delivery === "projectile") {
          const projectile: ProjectileState = {
            id: projectileId, ownerShipId: ship.id, ownerTeamId: ship.teamId,
            weaponTypeId: turret.weaponTypeId, targetEntityId: target.id,
            targetX: target.x, targetZ: target.z,
            fixedTrajectory: weapon.artillery !== undefined,
            x: muzzle.x, z: muzzle.z, previousX: muzzle.x, previousZ: muzzle.z,
            vx: dx / length * weapon.projectileSpeed, vz: dz / length * weapon.projectileSpeed,
            radius: weapon.projectileRadius,
            damage: weapon.damage * consolidatedDamageScale,
            lifetimeTicks: weapon.projectileLifetimeTicks,
          };
          this.state.projectiles.push(projectile);
        }
        turret.fireSequence += 1;
        turret.cooldownRemaining = turret.fireSequence % weapon.burstSize === 0
          ? weapon.cooldownTicks
          : weapon.burstIntervalTicks;
        this.shotsFired += 1;
        ship.lastCombatTick = this.state.tick;
        this.cruisingShipIds.delete(ship.id);
        if (weapon.artillery) {
          const newlyRevealed = (ship.revealedUntilTick ?? 0) < this.state.tick;
          ship.revealedUntilTick = Math.max(
            ship.revealedUntilTick ?? 0,
            this.state.tick + weapon.artillery.mobileRevealTicks,
          );
          this.revealArtilleryToHostiles(ship);
          if (newlyRevealed) {
            this.events.push({
              type: "artilleryRevealed", tick: this.state.tick,
              entityId: ship.id, untilTick: ship.revealedUntilTick,
            });
          }
        }
        this.events.push({
          type: "weaponFired", tick: this.state.tick, turretId: turret.id,
          shipId: ship.id, targetId: target.id, projectileId, weaponTypeId: turret.weaponTypeId,
        });
        if (weapon.delivery === "beam") {
          this.applyDamage(target, weapon.damage * consolidatedDamageScale, projectileId, turret.weaponTypeId);
        }
      }
    }
  }

  private fireDefensiveStructures(): void {
    for (const structure of this.state.structures) {
      const definition = STRUCTURES[structure.type];
      if (structure.revealedUntilTick !== undefined && structure.revealedUntilTick < this.state.tick) {
        structure.revealedUntilTick = 0;
      }
      const mounts = definition.hardpoints
        ?? (definition.weaponTypeId ? [{
          localX: 0, localZ: 0, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: definition.weaponTypeId,
        }] : []);
      if (mounts.length === 0 || structure.buildProgress < 1 || structure.health <= 0) continue;
      for (let mountIndex = 0; mountIndex < mounts.length; mountIndex += 1) {
        const mount = mounts[mountIndex]!;
        const weaponTypeId = mount.weaponTypeId;
        const weapon = WEAPONS[weaponTypeId];
        const weaponRange = getStructureWeaponRange(structure.type, weaponTypeId);
        const weaponDamage = getStructureWeaponDamage(structure.type, weaponTypeId);
        const burstTicks = Math.max(1, (weapon.burstSize - 1) * weapon.burstIntervalTicks + 1);
        const cycleTicks = burstTicks + weapon.cooldownTicks;
        const phase = (this.state.tick + structure.id * 17 + mountIndex * 11) % cycleTicks;
        if (phase >= burstTicks || phase % weapon.burstIntervalTicks !== 0) continue;

        let target: CombatTargetState | null = null;
        let bestScore = Infinity;
        for (const candidate of this.spatialHash.query(structure.x, structure.z, weaponRange)) {
          if (candidate.id === structure.id || candidate.health <= 0
            || !this.isHostile(structure.teamId, candidate.teamId)
            || !this.isEntityVisible(structure.teamId, candidate.id)) continue;
          const rangeSquared = distanceSquared(structure, candidate);
          if (rangeSquared > weaponRange ** 2 || rangeSquared < weapon.minimumRange ** 2) continue;
          const preference = isShip(candidate)
            ? weapon.targetPreference[candidate.class]
            : getStructureTargetPreference(weaponTypeId, candidate.type);
          const score = preference * 10_000_000 + rangeSquared;
          if (score < bestScore || (score === bestScore && candidate.id < (target?.id ?? Infinity))) {
            target = candidate;
            bestScore = score;
          }
        }
        if (!target) continue;

        const mountX = structure.x + mount.localX;
        const mountZ = structure.z + mount.localZ;
        const dx = target.x - mountX;
        const dz = target.z - mountZ;
        const length = Math.hypot(dx, dz) || 1;
        const muzzle = {
          x: mountX + dx / length * weapon.muzzleOffset,
          z: mountZ + dz / length * weapon.muzzleOffset,
        };
        const projectileId = this.state.nextEntityId++;
        if (weapon.delivery === "projectile") {
          const lifetimeTicks = Math.max(
            weapon.projectileLifetimeTicks,
            Math.ceil(weaponRange / Math.max(1, weapon.projectileSpeed * FIXED_DT)) + 2,
          );
          this.state.projectiles.push({
            id: projectileId, ownerShipId: structure.id, ownerTeamId: structure.teamId,
            weaponTypeId, targetEntityId: target.id,
            targetX: target.x, targetZ: target.z, fixedTrajectory: weapon.artillery !== undefined,
            x: muzzle.x, z: muzzle.z, previousX: muzzle.x, previousZ: muzzle.z,
            vx: dx / length * weapon.projectileSpeed, vz: dz / length * weapon.projectileSpeed,
            radius: weapon.projectileRadius, damage: weaponDamage, lifetimeTicks,
          });
        }
        this.shotsFired += 1;
        if (weapon.artillery) {
          const newlyRevealed = (structure.revealedUntilTick ?? 0) < this.state.tick;
          structure.revealedUntilTick = Math.max(
            structure.revealedUntilTick ?? 0,
            this.state.tick + weapon.artillery.structureRevealTicks,
          );
          this.revealArtilleryToHostiles(structure);
          if (newlyRevealed) {
            this.events.push({
              type: "artilleryRevealed", tick: this.state.tick,
              entityId: structure.id, untilTick: structure.revealedUntilTick,
            });
          }
        }
        this.events.push({
          type: "weaponFired", tick: this.state.tick,
          turretId: -(structure.id * 16 + mountIndex + 1),
          shipId: structure.id, targetId: target.id, projectileId, weaponTypeId,
        });
        if (weapon.delivery === "beam") this.applyDamage(target, weaponDamage, projectileId, weaponTypeId);
      }
    }
  }

  private applyDamage(
    target: CombatTargetState,
    rawDamage: number,
    projectileId: EntityId,
    weaponTypeId: import("./types").WeaponTypeId,
  ): void {
    const armorType = isShip(target) ? SHIPS[target.class].armorType : STRUCTURES[target.type].armorType;
    const damage = calculateProfiledDamage(weaponTypeId, rawDamage, target.shields, armorType);
    target.shields -= damage.shieldDamage;
    target.health -= damage.hullDamage;
    if (isShip(target)) {
      target.lastCombatTick = this.state.tick;
      this.cruisingShipIds.delete(target.id);
      const tacticalSpeed = SHIPS[target.class].speed;
      const currentSpeed = Math.hypot(target.vx, target.vz);
      if (currentSpeed > tacticalSpeed && currentSpeed > 0) {
        target.vx = target.vx / currentSpeed * tacticalSpeed;
        target.vz = target.vz / currentSpeed * tacticalSpeed;
      }
      if (target.artilleryDeploymentTicks !== undefined) target.artilleryDeploymentTicks = 0;
    }
    this.hits += 1;
    this.events.push({
      type: "hit", tick: this.state.tick, projectileId, targetId: target.id,
      damage: damage.shieldDamage + damage.hullDamage,
      rawDamage: damage.rawDamage,
      shieldDamage: damage.shieldDamage,
      hullDamage: damage.hullDamage,
    });
  }

  private integrateProjectilesAndDamage(): void {
    const survivingProjectiles: ProjectileState[] = [];
    const projectileOwners = new Map(this.state.ships.map((ship) => [ship.id, ship]));
    for (const projectile of this.state.projectiles) {
      projectile.previousX = projectile.x;
      projectile.previousZ = projectile.z;
      const weapon = WEAPONS[projectile.weaponTypeId];
      const ageTicks = weapon.projectileLifetimeTicks - projectile.lifetimeTicks;
      const launchProgress = projectile.weaponTypeId === "torpedo"
        ? Math.min(1, Math.max(0, (ageTicks - 2) / 6))
        : 1;
      const easedLaunch = launchProgress * launchProgress * (3 - 2 * launchProgress);
      const thrustScale = projectile.weaponTypeId === "torpedo" ? 0.08 + easedLaunch * 0.92 : 1;
      projectile.x += projectile.vx * FIXED_DT * thrustScale;
      projectile.z += projectile.vz * FIXED_DT * thrustScale;
      projectile.lifetimeTicks -= 1;
      let impact: { fraction: number; key: string; target: CombatTargetState | null } | null = null;
      const considerImpact = (fraction: number | null, key: string, target: CombatTargetState | null): void => {
        if (fraction === null) return;
        if (impact === null || fraction < impact.fraction - 1e-9
          || (Math.abs(fraction - impact.fraction) <= 1e-9 && compareCodeUnits(key, impact.key) < 0)) {
          impact = { fraction, key, target };
        }
      };
      const segmentX = projectile.x - projectile.previousX;
      const segmentZ = projectile.z - projectile.previousZ;
      const queryX = (projectile.previousX + projectile.x) * 0.5;
      const queryZ = (projectile.previousZ + projectile.z) * 0.5;
      const obstacleQueryRadius = Math.hypot(segmentX, segmentZ) * 0.5 + projectile.radius + this.maxObstacleRadius;
      for (const obstacle of this.obstacleHash.query(queryX, queryZ, obstacleQueryRadius)) {
        if (obstacle.type === "barrier") continue;
        const obstacleHit = sweptCircleHitFraction({
          fromX: projectile.previousX, fromZ: projectile.previousZ,
          toX: projectile.x, toZ: projectile.z,
          centerX: obstacle.x, centerZ: obstacle.z,
          radius: projectile.radius + obstacle.radius,
        });
        considerImpact(obstacleHit, `0:${obstacle.id}`, null);
      }
      for (const obstacle of this.state.obstacles) {
        if (obstacle.type !== "barrier" || !obstacle.width || !obstacle.depth) continue;
        considerImpact(sweptCircleRectangleHitFraction(
          projectile.previousX, projectile.previousZ, projectile.x, projectile.z,
          obstacle.x, obstacle.z, obstacle.width, obstacle.depth, projectile.radius,
        ), `0:${obstacle.id}`, null);
      }
      const queryRadius = Math.hypot(segmentX, segmentZ) * 0.5 + projectile.radius + MAX_COMBAT_TARGET_RADIUS;
      for (const target of this.spatialHash.query(queryX, queryZ, queryRadius)) {
        if (target.health <= 0 || !this.isHostile(projectile.ownerTeamId, target.teamId)) continue;
        const owner = projectileOwners.get(projectile.ownerShipId);
        const smallCraftEvasionScale = owner && CAPITAL_SHIP_CLASSES.has(owner.class) && isShip(target)
          && (target.class === "fighter" || target.class === "bomber")
          ? CAPITAL_VS_SMALL_CRAFT_HIT_RADIUS_SCALE
          : 1;
        considerImpact(sweptCircleHitFraction({
          fromX: projectile.previousX, fromZ: projectile.previousZ,
          toX: projectile.x, toZ: projectile.z,
          centerX: target.x, centerZ: target.z,
          radius: projectile.radius + getTargetRadius(target) * smallCraftEvasionScale,
        }), `1:${target.id}`, target);
      }
      const resolvedImpact = impact as { fraction: number; key: string; target: CombatTargetState | null } | null;
      if (resolvedImpact?.target) {
        projectile.x = projectile.previousX + (projectile.x - projectile.previousX) * resolvedImpact.fraction;
        projectile.z = projectile.previousZ + (projectile.z - projectile.previousZ) * resolvedImpact.fraction;
        this.applyDamage(resolvedImpact.target, projectile.damage, projectile.id, projectile.weaponTypeId);
        const owner = projectileOwners.get(projectile.ownerShipId);
        if (shouldEmitProjectileDetonation(projectile, owner)) {
          this.events.push({
            type: "projectileDetonated", tick: this.state.tick,
            projectileId: projectile.id, weaponTypeId: projectile.weaponTypeId,
            x: projectile.x, z: projectile.z,
          });
        }
      } else if (resolvedImpact === null && projectile.lifetimeTicks > 0) {
        survivingProjectiles.push(projectile);
      } else {
        const owner = projectileOwners.get(projectile.ownerShipId);
        if (shouldEmitProjectileDetonation(projectile, owner)) {
          if (resolvedImpact) {
            projectile.x = projectile.previousX + (projectile.x - projectile.previousX) * resolvedImpact.fraction;
            projectile.z = projectile.previousZ + (projectile.z - projectile.previousZ) * resolvedImpact.fraction;
          }
          this.events.push({
            type: "projectileDetonated", tick: this.state.tick,
            projectileId: projectile.id, weaponTypeId: projectile.weaponTypeId,
            x: projectile.x, z: projectile.z,
          });
        }
      }
    }
    this.state.projectiles = survivingProjectiles;
  }

  private destroyDeadEntities(): void {
    const destroyedShips = this.state.ships.filter((ship) => ship.health <= 0);
    const destroyedStructures = this.state.structures.filter((structure) => structure.health <= 0);
    if (destroyedShips.length === 0 && destroyedStructures.length === 0) return;
    const destroyedIds = new Set([...destroyedShips, ...destroyedStructures].map((entity) => entity.id));
    const projectileOwners = new Map(this.state.ships.map((ship) => [ship.id, ship]));
    const abandonedProjectiles = this.state.projectiles.filter(
      (projectile) => !projectile.fixedTrajectory && destroyedIds.has(projectile.targetEntityId),
    );
    for (const projectile of abandonedProjectiles) {
      if (!shouldEmitProjectileDetonation(projectile, projectileOwners.get(projectile.ownerShipId))) continue;
      this.events.push({
        type: "projectileDetonated", tick: this.state.tick,
        projectileId: projectile.id, weaponTypeId: projectile.weaponTypeId,
        x: projectile.x, z: projectile.z,
      });
    }
    for (const entityId of [...destroyedIds].sort((a, b) => a - b)) {
      this.events.push({ type: "destroyed", tick: this.state.tick, entityId });
    }
    for (const structure of destroyedStructures) {
      this.releaseMobileBuildersFromConstruction(structure.id);
      if (structure.resourceNodeId === null) continue;
      const node = this.state.resourceNodes.find((candidate) => candidate.id === structure.resourceNodeId);
      if (node?.claimedByStructureId === structure.id) node.claimedByStructureId = null;
    }
    this.state.ships = this.state.ships.filter((ship) => !destroyedIds.has(ship.id));
    this.state.structures = this.state.structures.filter((structure) => !destroyedIds.has(structure.id));
    this.state.projectiles = this.state.projectiles.filter(
      (projectile) => projectile.fixedTrajectory || !destroyedIds.has(projectile.targetEntityId),
    );
    for (const ship of this.state.ships) {
      if (ship.focusTargetEntityId !== null && destroyedIds.has(ship.focusTargetEntityId)) ship.focusTargetEntityId = null;
      for (const turret of ship.turrets) {
        if (turret.targetEntityId !== null && destroyedIds.has(turret.targetEntityId)) turret.targetEntityId = null;
      }
    }
  }

  private evaluateVictory(): void {
    if (this.state.status === "finished" || this.state.tick < 2) return;
    const survivingTeams = new Set(
      this.state.structures.filter((structure) => structure.type === "commandCore").map((structure) => structure.teamId),
    );
    for (const player of this.state.players) {
      const hasCore = this.state.structures.some(
        (structure) => structure.type === "commandCore" && structure.ownerPlayerId === player.id,
      );
      if (!hasCore) player.state = "defeated";
    }
    if (survivingTeams.size !== 1) return;
    const winnerTeamId = [...survivingTeams][0];
    if (winnerTeamId === undefined) return;
    this.state.status = "finished";
    this.state.winnerTeamId = winnerTeamId;
    this.events.push({ type: "victory", tick: this.state.tick, winnerTeamId });
  }

  private runEnemyCommanders(): void {
    if (this.state.status !== "playing") return;
    for (const playerId of this.state.aiPlayerIds) {
      const player = this.state.players.find((candidate) => candidate.id === playerId);
      if (!player || player.state !== "playing") continue;
      const settings = this.state.aiCommanders[playerId] ?? { difficulty: "normal", personality: "balanced" };
      const thinkTicks = settings.difficulty === "easy" ? AI_THINK_TICKS * 2
        : settings.difficulty === "hard" ? Math.floor(AI_THINK_TICKS / 2) : AI_THINK_TICKS;
      if (this.state.tick % thinkTicks !== 0) continue;
      const yards = this.state.structures
        .filter((structure) => structure.ownerPlayerId === playerId
          && SHIPYARD_TYPES.includes(structure.type as ShipyardType)
          && structure.buildProgress >= 1)
        .sort((left, right) => left.id - right.id);
      const ownedShips = this.state.ships.filter((ship) => ship.ownerPlayerId === playerId);
      const hasMobileFabricator = ownedShips.some((ship) => SHIPS[ship.class].buildPower > 0);
      const attackThreshold = settings.personality === "aggressive" ? 3
        : settings.personality === "turtle" ? 10
          : settings.personality === "economic" ? 7 : 5;
      const combatFleetCount = ownedShips.filter((ship) => SHIPS[ship.class].buildPower <= 0).length;
      const reserveForInfrastructure = this.aiConstructionCount(playerId) > 0
        && hasMobileFabricator
        && combatFleetCount > 0;
      const queueDepth = reserveForInfrastructure ? 0 : (settings.difficulty === "easy" ? 1 : settings.difficulty === "hard" ? 4 : 3)
        + (settings.personality === "aggressive" ? 1 : 0);
      for (const yard of yards) {
        const yardQueueDepth = yard.type === "shipyard" && !hasMobileFabricator ? 1
          : settings.personality === "economic" ? Math.min(2, queueDepth) : queueDepth;
        if (yard.productionQueue.length >= yardQueueDepth) continue;
        const roster = this.aiProductionRoster(
          yard.type as ShipyardType, hasMobileFabricator, settings.personality, player.teamId,
        );
        const shipClass = roster[(ownedShips.length + yard.id + this.state.tick / thinkTicks) % roster.length | 0]!;
        if (!this.canStructureProduceShipClass(playerId, yard.id, shipClass)) continue;
        this.submitCommand({
          type: "queueUnit", playerId, sequence: player.lastCommandSequence + 1,
          requestedTick: this.state.tick + 1, structureId: yard.id, shipClass, count: 1,
        });
      }
      if (this.state.tick % (thinkTicks * 4) === 0) {
        this.dispatchAiScouts(playerId, settings);
      }
      let activeConstructionCount = this.aiConstructionCount(playerId);
      const constructionLimit = 1;
      if (this.state.tick % (thinkTicks * 3) === 0 && activeConstructionCount < constructionLimit) {
        const constructionCycle = Math.floor(this.state.tick / (thinkTicks * 3));
        const extractorCount = this.state.structures.filter((structure) =>
          structure.ownerPlayerId === playerId
            && RESOURCE_EXTRACTOR_TYPES.includes(structure.type as typeof RESOURCE_EXTRACTOR_TYPES[number]),
        ).length;
        const prioritizingEarlyExtractors = extractorCount < 3;
        const needsInitialDefense = settings.personality !== "economic"
          && extractorCount >= 3
          && !this.state.structures.some((structure) =>
            structure.ownerPlayerId === playerId
              && DEFENSIVE_STRUCTURE_TYPES.includes(structure.type as typeof DEFENSIVE_STRUCTURE_TYPES[number]));
        const defenseInterval = settings.personality === "turtle" ? 2
          : settings.personality === "aggressive" ? 5
            : settings.personality === "economic" ? 4 : 3;
        const defenseTurn = constructionCycle % defenseInterval === defenseInterval - 1;
        const economyTurn = constructionCycle % 2 === 0;
        if (prioritizingEarlyExtractors) this.expandAiEconomy(playerId, settings);
        else if (needsInitialDefense || defenseTurn) this.advanceAiDefenses(playerId, settings);
        else if (economyTurn) this.expandAiEconomy(playerId, settings);
        else this.advanceAiInfrastructure(playerId, settings);
        activeConstructionCount = this.aiConstructionCount(playerId);
        if (activeConstructionCount < constructionLimit) {
          if (prioritizingEarlyExtractors || economyTurn) this.advanceAiInfrastructure(playerId, settings);
          else this.expandAiEconomy(playerId, settings);
        }
      }
      const attackCadence = settings.personality === "aggressive" ? 3 : settings.personality === "turtle" ? 9 : 5;
      if (this.state.tick % (thinkTicks * attackCadence) === 0) {
        const fleet = this.state.ships.filter(
          (ship) => ship.ownerPlayerId === playerId && SHIPS[ship.class].buildPower <= 0,
        );
        const center = fleet.reduce((point, ship) => ({ x: point.x + ship.x, z: point.z + ship.z }), { x: 0, z: 0 });
        if (fleet.length > 0) { center.x /= fleet.length; center.z /= fleet.length; }
        const target = ([...this.state.structures, ...this.state.ships] as CombatTargetState[])
          .filter((candidate) => this.isHostile(player.teamId, candidate.teamId)
            && this.isEntityVisible(player.teamId, candidate.id))
          .sort((left, right) => {
            const priority = (candidate: CombatTargetState) => !isShip(candidate) && candidate.type === "commandCore" ? 0
              : !isShip(candidate) && SHIPYARD_TYPES.includes(candidate.type as ShipyardType) ? 1
                : isShip(candidate) ? 2 : 3;
            return priority(left) - priority(right)
              || distanceSquared(center, left) - distanceSquared(center, right)
              || left.id - right.id;
          })[0];
        if (fleet.length >= attackThreshold && target) {
          const tunnelWaypoint = this.amazonTunnelWaypoint(center);
          this.submitCommand({
            type: "attackMove", playerId, sequence: player.lastCommandSequence + 1,
            requestedTick: this.state.tick + 1, unitIds: fleet.map((ship) => ship.id), queued: false,
            destination: tunnelWaypoint ?? { x: target.x, z: target.z },
          });
        } else if (fleet.length >= attackThreshold && !target) {
          const strikeGroup = fleet
            .sort((left, right) => {
              const orderRank = (ship: ShipState) => ship.orders.length === 0 ? 0
                : ship.orders[0]?.type === "patrol" ? 1 : 2;
              return orderRank(left) - orderRank(right) || left.id - right.id;
            })
            .slice(0, Math.max(attackThreshold, Math.ceil(fleet.length * 0.6)));
          const core = this.state.structures.find(
            (structure) => structure.ownerPlayerId === playerId && structure.type === "commandCore",
          );
          if (core && strikeGroup.length >= attackThreshold) {
            const strikeCenter = strikeGroup.reduce(
              (point, ship) => ({ x: point.x + ship.x / strikeGroup.length, z: point.z + ship.z / strikeGroup.length }),
              { x: 0, z: 0 },
            );
            const radialLength = Math.hypot(core.x, core.z) || 1;
            const inwardX = -core.x / radialLength;
            const inwardZ = -core.z / radialLength;
            const tangentX = inwardZ;
            const tangentZ = -inwardX;
            const currentProgress = Math.max(
              0,
              (strikeCenter.x - core.x) * inwardX + (strikeCenter.z - core.z) * inwardZ,
            );
            const nextProgress = Math.min(
              radialLength * 2.05,
              currentProgress + Math.max(900, radialLength * 0.55),
            );
            const searchCycle = Math.floor(this.state.tick / (thinkTicks * attackCadence));
            const searchLane = nextProgress >= radialLength * 1.85 ? [0, -1, 1][searchCycle % 3]! : 0;
            const laneOffset = searchLane * Math.max(360, radialLength * 0.24);
            const tunnelWaypoint = this.amazonTunnelWaypoint(strikeCenter);
            this.submitCommand({
              type: "attackMove", playerId, sequence: player.lastCommandSequence + 1,
              requestedTick: this.state.tick + 1, unitIds: strikeGroup.map((ship) => ship.id), queued: false,
              destination: tunnelWaypoint
                ?? {
                  x: core.x + inwardX * nextProgress + tangentX * laneOffset,
                  z: core.z + inwardZ * nextProgress + tangentZ * laneOffset,
                },
            });
          }
        }
      }
    }
  }

  private aiConstructionCount(playerId: PlayerId): number {
    const activeStructures = this.state.structures.filter(
      (structure) => structure.ownerPlayerId === playerId && structure.buildProgress < 1,
    ).length;
    const pendingOrders = this.state.commandQueue.filter(
      (command) => command.playerId === playerId && command.type === "buildStructure",
    ).length;
    return activeStructures + pendingOrders;
  }

  private amazonTunnelWaypoint(fleetCenter: Readonly<{ x: number; z: number }>): { x: number; z: number } | null {
    if (this.state.mapPreset !== "amazon-tunnel") return null;
    const outerX = Math.max(0, ...this.state.obstacles.map((obstacle) => Math.abs(obstacle.x)));
    const baseRadius = outerX / 1.08;
    if (baseRadius <= 0 || Math.abs(fleetCenter.z) <= baseRadius * 0.16) return null;
    const side = fleetCenter.x < 0 ? -1 : 1;
    return { x: side * baseRadius * 0.82, z: 0 };
  }

  private dispatchAiScouts(playerId: PlayerId, settings: AiCommanderSettings): void {
    const player = this.state.players.find((candidate) => candidate.id === playerId);
    const core = this.state.structures.find(
      (structure) => structure.ownerPlayerId === playerId && structure.type === "commandCore",
    );
    if (!player || !core) return;
    const scoutLimit = (settings.difficulty === "easy" ? 1 : settings.difficulty === "hard" ? 3 : 2)
      + (settings.personality === "economic" ? 1 : 0);
    const activeScouts = this.state.ships.filter(
      (ship) => ship.ownerPlayerId === playerId && ship.orders[0]?.type === "patrol",
    ).length;
    const candidates = this.state.ships
      .filter((ship) => ship.ownerPlayerId === playerId
        && ship.orders.length === 0
        && (ship.class === "fighter" || ship.class === "frigate" || ship.class === "bomber"))
      .sort((left, right) => {
        const rank = (ship: ShipState) => ship.class === "fighter" ? 0 : ship.class === "frigate" ? 1 : 2;
        return rank(left) - rank(right) || left.id - right.id;
      })
      .slice(0, Math.max(0, scoutLimit - activeScouts));
    const radialLength = Math.hypot(core.x, core.z) || 1;
    const inwardX = -core.x / radialLength;
    const inwardZ = -core.z / radialLength;
    const tangentX = inwardZ;
    const tangentZ = -inwardX;
    const explorationDistance = Math.max(1_000, radialLength * 1.95);
    const explorationStep = Math.max(90, radialLength * 0.025);
    const laneSpacing = Math.max(320, radialLength * 0.16);
    for (let index = 0; index < candidates.length; index += 1) {
      const scout = candidates[index]!;
      const lane = index - (candidates.length - 1) / 2;
      const destination = {
        x: core.x + inwardX * (explorationDistance + index * explorationStep) + tangentX * lane * laneSpacing,
        z: core.z + inwardZ * (explorationDistance + index * explorationStep) + tangentZ * lane * laneSpacing,
      };
      this.submitCommand({
        type: "patrol", playerId, sequence: player.lastCommandSequence + 1,
        requestedTick: this.state.tick + 1, unitIds: [scout.id], queued: false, destination,
      });
    }
  }

  private expandAiEconomy(playerId: PlayerId, settings: AiCommanderSettings): void {
    const player = this.state.players.find((candidate) => candidate.id === playerId);
    const core = this.state.structures.find(
      (structure) => structure.ownerPlayerId === playerId && structure.type === "commandCore",
    );
    if (!player || !core) return;
    if (this.aiConstructionCount(playerId) > 0) return;
    const solarTarget = (settings.difficulty === "easy" ? 2 : settings.difficulty === "hard" ? 4 : 3)
      + (settings.personality === "economic" ? 1 : 0);
    const solarCount = this.state.structures.filter(
      (structure) => structure.ownerPlayerId === playerId && structure.type === "solarArray",
    ).length;
    const buildSolarArray = (): boolean => {
      if (solarCount >= solarTarget || !this.canBuildStructure(playerId, "solarArray")) return false;
      const position = this.findAiBuildPosition(playerId, "solarArray", core);
      if (!position) return false;
      return this.submitCommand({
        type: "buildStructure", playerId, sequence: player.lastCommandSequence + 1,
        requestedTick: this.state.tick + 1, structureType: "solarArray", position, queued: false,
      }).accepted;
    };
    const energyReserveLow = player.economy.energy < player.economy.energyStorage * 0.2
      || (player.economy.efficiency < 0.6 && player.economy.energy < player.economy.alloy);
    if (energyReserveLow && buildSolarArray()) return;
    const extractorTarget = (settings.difficulty === "easy" ? 3 : settings.difficulty === "hard" ? 7 : 5)
      + (settings.personality === "economic" ? 2 : settings.personality === "turtle" ? 1 : 0);
    const extractors = this.state.structures.filter(
      (structure) => structure.ownerPlayerId === playerId
        && RESOURCE_EXTRACTOR_TYPES.includes(structure.type as typeof RESOURCE_EXTRACTOR_TYPES[number]),
    );
    const reservedBuilders = new Set(this.state.commandQueue.flatMap((command) =>
      command.type === "buildStructure" ? command.builderUnitIds ?? [] : []));
    const builders = this.state.ships
      .filter((ship) => ship.ownerPlayerId === playerId
        && SHIPS[ship.class].buildPower > 0
        && !reservedBuilders.has(ship.id));
    const closestBuilder = (target: Readonly<{ x: number; z: number }>): ShipState | undefined => builders
      .slice()
      .sort((left, right) => distanceSquared(left, target) - distanceSquared(right, target) || left.id - right.id)[0];
    const tryUpgradeExtractor = (): boolean => {
      const upgradeCandidates = extractors
        .filter((structure) => structure.buildProgress >= 1 && structure.resourceNodeId !== null)
        .sort((left, right) => {
          const leftRank = RESOURCE_EXTRACTOR_TYPES.indexOf(left.type as typeof RESOURCE_EXTRACTOR_TYPES[number]);
          const rightRank = RESOURCE_EXTRACTOR_TYPES.indexOf(right.type as typeof RESOURCE_EXTRACTOR_TYPES[number]);
          return leftRank - rightRank || distanceSquared(core, left) - distanceSquared(core, right) || left.id - right.id;
        });
      for (const extractor of upgradeCandidates) {
        const rank = RESOURCE_EXTRACTOR_TYPES.indexOf(extractor.type as typeof RESOURCE_EXTRACTOR_TYPES[number]);
        const upgradeType = RESOURCE_EXTRACTOR_TYPES[rank + 1];
        const node = this.state.resourceNodes.find((candidate) => candidate.id === extractor.resourceNodeId);
        if (!upgradeType || !node || !this.canBuildStructure(playerId, upgradeType)) continue;
        const builder = closestBuilder(node);
        const builderUnitIds = builder ? [builder.id] : [];
        if (!this.canPlaceStructure(playerId, upgradeType, node, node.id, builderUnitIds)) continue;
        const result = this.submitCommand({
          type: "buildStructure", playerId, sequence: player.lastCommandSequence + 1,
          requestedTick: this.state.tick + 1, structureType: upgradeType,
          position: { x: node.x, z: node.z }, resourceNodeId: node.id,
          builderUnitIds, queued: false,
        });
        if (result.accepted) return true;
      }
      return false;
    };
    if (extractors.length >= Math.min(3, extractorTarget) && tryUpgradeExtractor()) return;
    if (extractors.length < extractorTarget) {
      const reservedNodeIds = new Set(this.state.commandQueue
        .filter((command) => command.type === "buildStructure"
          && command.playerId === playerId && command.resourceNodeId !== undefined)
        .map((command) => command.type === "buildStructure" ? command.resourceNodeId : undefined));
      const node = this.state.resourceNodes
        .filter((candidate) => candidate.claimedByStructureId === null
          && !reservedNodeIds.has(candidate.id)
          && isResourceNodeDiscoveredByTeam(this.state, player.teamId, candidate.id))
        .sort((left, right) => distanceSquared(core, left) - distanceSquared(core, right) || left.id - right.id)[0];
      if (node) {
        const builder = closestBuilder(node);
        const builderUnitIds = builder ? [builder.id] : [];
        if (this.canPlaceStructure(playerId, "extractor", node, node.id, builderUnitIds)) {
          this.submitCommand({
            type: "buildStructure", playerId, sequence: player.lastCommandSequence + 1,
            requestedTick: this.state.tick + 1, structureType: "extractor",
            position: { x: node.x, z: node.z }, resourceNodeId: node.id,
            builderUnitIds, queued: false,
          });
          return;
        }
      }
    }
    if (tryUpgradeExtractor()) return;
    const hasComfortableEnergy = player.economy.energyIncome >= Math.max(50, player.economy.alloyIncome * 2.5);
    if (!hasComfortableEnergy) buildSolarArray();
  }

  private aiProductionRoster(
    yardType: ShipyardType,
    hasFabricator: boolean,
    personality: AiPersonality,
    teamId: TeamId,
  ): readonly ShipClass[] {
    const visibleIds = this.visibleEntityIdsByTeam.get(teamId) ?? new Set<EntityId>();
    const visibleHostiles = this.state.ships.filter(
      (ship) => visibleIds.has(ship.id) && this.isHostile(teamId, ship.teamId),
    );
    const armorCounts = visibleHostiles.reduce((counts, ship) => {
      counts[SHIPS[ship.class].armorType] += 1;
      return counts;
    }, { light: 0, plated: 0, heavy: 0, fortified: 0 });
    const visibleFortifications = this.state.structures.filter(
      (structure) => visibleIds.has(structure.id) && this.isHostile(teamId, structure.teamId),
    ).length;
    if (yardType === "capitalShipyard") {
      const base: ShipClass[] = personality === "turtle"
      ? ["battleship", "carrier", "battleship"] : personality === "aggressive"
        ? ["battleship", "battleship", "carrier"] : ["carrier", "battleship"];
      if (visibleFortifications > 2) base.push("battleship");
      if (visibleFortifications >= 2) base.push("artilleryCruiser");
      return base;
    }
    if (yardType === "fleetShipyard") {
      const base: ShipClass[] = personality === "turtle"
      ? ["flakFrigate", "destroyer", "flakFrigate", "cruiser"] : personality === "aggressive"
        ? ["torpedoFrigate", "destroyer", "torpedoFrigate", "cruiser"]
        : ["flakFrigate", "torpedoFrigate", "destroyer", "cruiser"];
      if (armorCounts.light >= 3) base.push("flakFrigate", "destroyer");
      if (armorCounts.plated >= 3) base.push("destroyer", "cruiser");
      if (armorCounts.heavy >= 2) base.push("torpedoFrigate");
      if (visibleFortifications >= 2) base.push("artilleryDestroyer");
      return base;
    }
    if (!hasFabricator) return ["fabricator"];
    const base: ShipClass[] = personality === "aggressive" ? ["fighter", "bomber", "fighter", "frigate", "bomber"]
      : personality === "turtle" ? ["frigate", "fighter", "frigate", "bomber"]
        : personality === "economic" ? ["fighter", "fighter", "frigate", "bomber"]
          : ["fighter", "fighter", "bomber", "frigate"];
    if (armorCounts.light >= 3) base.push("fighter");
    if (armorCounts.plated >= 3) base.push("frigate");
    if (armorCounts.heavy >= 2) base.push("bomber");
    if (visibleFortifications >= 2) base.push("artilleryFrigate");
    return base;
  }

  private advanceAiInfrastructure(playerId: PlayerId, settings: AiCommanderSettings): void {
    const player = this.state.players.find((candidate) => candidate.id === playerId);
    const core = this.state.structures.find(
      (structure) => structure.ownerPlayerId === playerId && structure.type === "commandCore" && structure.buildProgress >= 1,
    );
    if (!player || !core) return;
    const ownedStructures = this.state.structures.filter((structure) => structure.ownerPlayerId === playerId);
    const count = (structureType: StructureType): number => ownedStructures.filter(
      (structure) => structure.type === structureType,
    ).length;
    const storageUse = Math.max(
      player.economy.alloyStorage > 0 ? player.economy.alloy / player.economy.alloyStorage : 0,
      player.economy.energyStorage > 0 ? player.economy.energy / player.economy.energyStorage : 0,
    );
    const lightYardTarget = settings.difficulty === "easy" ? 1 : settings.difficulty === "hard" ? 3 : 2;
    const fleetYardTarget = settings.difficulty === "easy" ? 1 : 2
      + (settings.personality === "economic" ? 1 : 0);
    const capitalYardTarget = settings.difficulty === "hard" || settings.personality === "aggressive" ? 2 : 1;
    const storageTarget = 1 + (storageUse >= 0.72 ? 1 : 0)
      + (settings.personality === "economic" && storageUse >= 0.55 ? 1 : 0);
    const refineryTarget = 1 + (settings.difficulty === "hard" ? 1 : 0)
      + (settings.personality === "economic" ? 1 : 0);
    const forgeTarget = settings.difficulty === "hard" || settings.personality === "economic" ? 2 : 1;
    const priorities: readonly { type: Exclude<StructureType, "commandCore">; target: number }[] = [
      { type: "fabricator", target: 1 },
      { type: "storage", target: 1 },
      { type: "fleetShipyard", target: 1 },
      { type: "fusionReactor", target: 1 },
      { type: "alloyRefinery", target: 1 },
      { type: "shipyard", target: lightYardTarget + (settings.personality === "aggressive" ? 1 : 0) },
      { type: "storage", target: storageTarget },
      { type: "capitalShipyard", target: 1 },
      { type: "antimatterReactor", target: 1 },
      { type: "matterForge", target: 1 },
      { type: "fleetShipyard", target: fleetYardTarget },
      { type: "quantumStorage", target: 1 },
      { type: "alloyRefinery", target: refineryTarget },
      { type: "matterForge", target: forgeTarget },
      { type: "capitalShipyard", target: capitalYardTarget },
    ];
    for (const { type: structureType, target } of priorities) {
      if (count(structureType) >= target) continue;
      if (!this.canBuildStructure(playerId, structureType)) continue;
      const position = this.findAiBuildPosition(playerId, structureType, core);
      if (!position) continue;
      const result = this.submitCommand({
        type: "buildStructure",
        playerId,
        sequence: player.lastCommandSequence + 1,
        requestedTick: this.state.tick + 1,
        structureType,
        position,
        queued: false,
      });
      if (result.accepted) return;
    }
  }

  private advanceAiDefenses(playerId: PlayerId, settings: AiCommanderSettings): void {
    const core = this.state.structures.find(
      (structure) => structure.ownerPlayerId === playerId && structure.type === "commandCore" && structure.buildProgress >= 1,
    );
    if (!core) return;
    const defenses = this.state.structures.filter(
      (structure) => structure.ownerPlayerId === playerId && DEFENSIVE_STRUCTURE_TYPES.includes(structure.type as typeof DEFENSIVE_STRUCTURE_TYPES[number]),
    );
    const hasFusionPower = this.state.structures.some((structure) =>
      structure.ownerPlayerId === playerId && structure.type === "fusionReactor" && structure.buildProgress >= 1);
    const hasAdvancedAlloyIncome = this.state.structures.some((structure) =>
      structure.ownerPlayerId === playerId
        && (structure.type === "alloyRefinery" || structure.type === "matterForge"));
    if (settings.personality === "economic" && !hasAdvancedAlloyIncome) return;
    const limit = settings.personality === "turtle" ? (settings.difficulty === "hard" ? 8 : 6)
      : settings.personality === "economic" && !hasFusionPower ? 1
        : settings.personality === "aggressive" ? 2 : 3;
    if (defenses.length >= limit) return;
    const choices: readonly Exclude<StructureType, "commandCore">[] = [
      "pointDefenseBattery", "artilleryBattery", "missileBattery", "railBattery",
      "heavyArtilleryBattery", "plasmaBattery", "beamBattery", "strategicArtilleryArray",
    ];
    const structureType = Array.from({ length: choices.length }, (_, offset) =>
      choices[(defenses.length + offset) % choices.length]!).find((candidate) =>
      this.canBuildStructure(playerId, candidate));
    if (!structureType) return;
    const builder = this.state.ships
      .filter((ship) => ship.ownerPlayerId === playerId && SHIPS[ship.class].buildPower > 0)
      .sort((left, right) => distanceSquared(left, core) - distanceSquared(right, core) || left.id - right.id)[0];
    if (!builder) return;
    const builderUnitIds = [builder.id];
    const position = this.findAiBuildPosition(playerId, structureType, core, builderUnitIds);
    if (!position) return;
    const player = this.state.players.find((candidate) => candidate.id === playerId)!;
    this.submitCommand({ type: "buildStructure", playerId, sequence: player.lastCommandSequence + 1,
      requestedTick: this.state.tick + 1, structureType, position, builderUnitIds, queued: false });
  }

  private findAiBuildPosition(
    playerId: PlayerId,
    structureType: Exclude<StructureType, "commandCore">,
    core: StructureState,
    builderUnitIds: readonly EntityId[] = [],
  ): { x: number; z: number } | null {
    const typeIndex = (BUILDABLE_STRUCTURE_TYPES as readonly StructureType[]).indexOf(structureType);
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const ring = 105 + Math.floor(attempt / 8) * 72;
      const angle = (typeIndex * 2.17 + attempt * Math.PI / 4 + core.id * 0.37) % (Math.PI * 2);
      const position = { x: core.x + Math.sin(angle) * ring, z: core.z + Math.cos(angle) * ring };
      if (this.canPlaceStructure(playerId, structureType, position, undefined, builderUnitIds)) return position;
    }
    return null;
  }

  private spawnShip(
    player: PlayerState,
    shipClass: ShipClass,
    x: number,
    z: number,
    yaw: number,
    yardType: ShipyardType,
  ): ShipState {
    const definition = SHIPS[shipClass];
    const artillery = getShipArtilleryWeapon(shipClass)?.artillery;
    const id = this.state.nextEntityId++;
    const forwardX = Math.sin(yaw);
    const forwardZ = Math.cos(yaw);
    const ship: ShipState = {
      id, ownerPlayerId: player.id, teamId: player.teamId, class: shipClass,
      x: x + ((id * 37) % 5 - 2) * Math.max(9, definition.radius * 2.4) + forwardX * (STRUCTURES[yardType].radius + definition.radius + 15),
      z: z + forwardZ * (STRUCTURES[yardType].radius + definition.radius + 15),
      y: getPublicShipAltitude(id, shipClass),
      yaw, vx: 0, vz: 0, health: definition.maxHealth, shields: definition.maxShield,
      orders: [], focusTargetEntityId: null,
      lastCombatTick: this.state.tick,
      ...(artillery ? { artilleryDeploymentTicks: 0, revealedUntilTick: 0 } : {}),
      turrets: definition.hardpoints.map((hardpoint) => {
        const turretId = this.state.nextTurretId++;
        return {
          id: turretId, parentShipId: id, weaponTypeId: hardpoint.weaponTypeId,
          localX: hardpoint.localX, localZ: hardpoint.localZ,
          yawCenter: hardpoint.yawCenter, yawHalfArc: hardpoint.yawHalfArc,
          currentYaw: hardpoint.yawCenter, targetEntityId: null,
          cooldownRemaining: turretId * 7 % WEAPONS[hardpoint.weaponTypeId].cooldownTicks, fireSequence: 0,
        };
      }),
    };
    const launchPosition = projectNavigableDestination(this.state, ship, ship);
    ship.x = launchPosition.x;
    ship.z = launchPosition.z;
    this.state.ships.push(ship);
    this.state.ships.sort((a, b) => a.id - b.id);
    return ship;
  }

  private defaultRallyPoint(playerId: string, x: number, z: number): { x: number; z: number } {
    const player = this.state.players.find((candidate) => candidate.id === playerId);
    const hostileCore = player && this.state.structures.find(
      (structure) => structure.type === "commandCore"
        && this.isHostile(player.teamId, structure.teamId)
        && this.isEntityVisible(player.teamId, structure.id),
    );
    const targetX = hostileCore?.x ?? 0;
    const targetZ = hostileCore?.z ?? 0;
    const length = Math.hypot(targetX - x, targetZ - z) || 1;
    return { x: x + (targetX - x) / length * 110, z: z + (targetZ - z) / length * 110 };
  }

  private findTarget(id: EntityId): CombatTargetState | undefined {
    return this.targetsById.get(id)
      ?? this.state.ships.find((ship) => ship.id === id)
      ?? this.state.structures.find((structure) => structure.id === id);
  }

  private refreshVisibilityCache(): void {
    this.visibleEntityIdsByTeam.clear();
    for (const visibility of this.state.visibility) {
      this.visibleEntityIdsByTeam.set(visibility.teamId, new Set(visibility.visibleEntityIds));
    }
    this.alliedTeamIdsByTeam.clear();
    for (const team of this.state.teams) {
      const allied = new Set<TeamId>();
      for (const candidate of this.state.teams) {
        if (areTeamsAllied(this.state, team.id, candidate.id)) allied.add(candidate.id);
      }
      this.alliedTeamIdsByTeam.set(team.id, allied);
    }
  }

  private revealArtilleryToHostiles(entity: CombatTargetState): void {
    for (const visibility of this.state.visibility) {
      if (!this.isHostile(visibility.teamId, entity.teamId) || visibility.visibleEntityIds.includes(entity.id)) continue;
      visibility.visibleEntityIds.push(entity.id);
      visibility.visibleEntityIds.sort((left, right) => left - right);
      this.visibleEntityIdsByTeam.get(visibility.teamId)?.add(entity.id);
    }
  }

  private isEntityVisible(teamId: TeamId, entityId: EntityId): boolean {
    return this.visibleEntityIdsByTeam.get(teamId)?.has(entityId) ?? false;
  }

  private isHostile(teamA: number, teamB: number): boolean {
    return !(this.alliedTeamIdsByTeam.get(teamA)?.has(teamB) ?? areTeamsAllied(this.state, teamA, teamB));
  }
}

export function createCombatScenario(options: ScenarioOptions = {}): GameSimulation {
  const seed = options.seed ?? 0xc0ffee;
  const fightersPerTeam = options.fightersPerTeam ?? 2;
  const bombersPerTeam = options.bombersPerTeam ?? 2;
  const palette = [0x59a7ff, 0xff5576, 0x62e6a7, 0xf3b65b, 0xb886ff, 0x55e1e8, 0xff8b55, 0xd8e65b];
  const suppliedConfigs: readonly ScenarioPlayerConfig[] = options.players ?? [
    { id: "pilot-blue", name: "Player Command", teamId: 1, color: palette[0]! },
    { id: "pilot-red", name: "AI Command", teamId: 2, color: palette[1]!, ai: options.enemyCommander !== false },
  ];
  const teamSpawnMode = options.teamSpawnMode ?? "interleaved";
  const configs = orderPlayersForSpawns(suppliedConfigs, teamSpawnMode, seed);
  if (configs.length < 2 || configs.length > 8) throw new Error("A scenario requires 2–8 players");
  if (new Set(configs.map((player) => player.id)).size !== configs.length) throw new Error("Player IDs must be unique");
  const mapPreset = options.mapPreset ?? "orbital-ring";
  const mapRandom = createMapRandom(seed, mapPreset);
  const mapSize = options.mapSize ?? "medium";
  const startingBase = options.startingBase ?? "full";
  const resourceDensity = options.resourceDensity ?? "standard";
  const baseRadius = { small: 1_600, medium: 2_400, large: 4_000, huge: 6_000, colossal: 8_500 }[mapSize];
  const isOneVsOneMatch = options.varyStartingPositions === true
    && configs.length === 2
    && configs[0]!.teamId !== configs[1]!.teamId
    && options.showcase !== true
    && options.menuBattle !== true;
  const spawnRandom = createMapRandom(seed ^ 0x1a11_ce55, `${mapPreset}:spawns`);
  const oneVsOneRotation = isOneVsOneMatch ? (spawnRandom() - 0.5) * Math.PI / 3 : 0;
  const oneVsOneSeparationOffset = isOneVsOneMatch ? (spawnRandom() - 0.5) * Math.PI / 6 : 0;
  const spawnAngles = configs.map((_, index) => (
    Math.PI + index / configs.length * Math.PI * 2
      + oneVsOneRotation
      + (isOneVsOneMatch && index === 1 ? oneVsOneSeparationOffset : 0)
  ));
  const oneVsOneTunnelOffsets = isOneVsOneMatch
    ? [(spawnRandom() - 0.5) * baseRadius * 0.56, (spawnRandom() - 0.5) * baseRadius * 0.56] as const
    : [0, 0] as const;
  const mapScale = baseRadius / 420;
  const startingResourceAmount = { low: 500, standard: 900, high: 1_800 }[options.startingResources ?? "standard"];
  const density = {
    scarce: { count: 0.67, richness: 0.78 },
    standard: { count: 1, richness: 1 },
    rich: { count: 1.5, richness: 1.3 },
  }[resourceDensity];
  const createEconomy = () => ({
    alloy: startingResourceAmount, energy: startingResourceAmount, alloyIncome: 0, energyIncome: 0,
    alloySpend: 0, energySpend: 0,
    alloyStorage: Math.max(2_000, startingResourceAmount * 1.5),
    energyStorage: Math.max(2_000, startingResourceAmount * 1.5),
    efficiency: 1,
  });
  const players: PlayerState[] = configs.map((config, index) => ({
    id: config.id, name: config.name, teamId: config.teamId, color: config.color ?? palette[index]!,
    state: "playing", lastCommandSequence: 0, economy: createEconomy(),
  }));
  const teamIds = [...new Set(players.map((player) => player.teamId))].sort((a, b) => a - b);
  const teams: TeamState[] = teamIds.map((id) => ({ id, name: `Team ${id}`, alliedTeamIds: [] }));
  const state: SimulationState = {
    version: 9, seed, tick: 0, nextEntityId: 1, nextTurretId: 1, nextQueueItemId: 1,
    players, teams, ships: [], structures: [], resourceNodes: [],
    obstacles: createScenarioObstacles(players.length, mapPreset, baseRadius, seed, spawnAngles),
    visibility: [],
    projectiles: [], commandQueue: [],
    aiPlayerIds: configs.filter((player) => player.ai).map((player) => player.id),
    aiCommanders: Object.fromEntries(configs.filter((player) => player.ai).map((player) => [player.id, {
      difficulty: player.aiDifficulty ?? "normal",
      personality: player.aiPersonality ?? "balanced",
    }])),
    mapPreset,
    status: "playing", winnerTeamId: null, checksum: 0,
  };

  const addNode = (x: number, z: number, richness = 1): ResourceNodeState => {
    const node = { id: state.nextEntityId++, type: "alloy" as const, x, z, richness, claimedByStructureId: null };
    state.resourceNodes.push(node);
    return node;
  };
  const addMapNode = (x: number, z: number, richness: number): ResourceNodeState => {
    let candidateX = x;
    let candidateZ = z;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const blocked = state.obstacles.some((obstacle) =>
        circleOverlapsObstacle(candidateX, candidateZ, 48, obstacle),
      );
      if (!blocked) break;
      const angle = Math.atan2(candidateX, candidateZ) + 0.31 + mapRandom() * 0.17;
      const radius = Math.max(90, Math.hypot(candidateX, candidateZ) + 45 + attempt * 12);
      candidateX = Math.sin(angle) * radius;
      candidateZ = Math.cos(angle) * radius;
    }
    return addNode(quantizePhysics(candidateX), quantizePhysics(candidateZ), richness);
  };
  const addStructure = (
    player: PlayerState,
    type: StructureType,
    x: number,
    z: number,
    yaw: number,
    rallyPoint: Readonly<{ x: number; z: number }>,
    node?: ResourceNodeState,
  ): StructureState => {
    const definition = STRUCTURES[type];
    const structure: StructureState = {
      id: state.nextEntityId++, ownerPlayerId: player.id, teamId: player.teamId,
      type, x, z, yaw,
      health: definition.maxHealth, shields: definition.maxShield, buildProgress: 1,
      resourceNodeId: node?.id ?? null, productionQueue: [], repeatProduction: false,
      rallyPoint: { ...rallyPoint },
      ...(definition.hardpoints?.some((hardpoint) => WEAPONS[hardpoint.weaponTypeId].artillery)
        ? { revealedUntilTick: 0 }
        : {}),
    };
    state.structures.push(structure);
    if (node) node.claimedByStructureId = structure.id;
    return structure;
  };

  const spawn = (owner: PlayerState, shipClass: ShipClass, x: number, z: number, yaw: number): void => {
    const definition = SHIPS[shipClass];
    const artillery = getShipArtilleryWeapon(shipClass)?.artillery;
    const id = state.nextEntityId++;
    state.ships.push({
      id, ownerPlayerId: owner.id, teamId: owner.teamId, class: shipClass,
      x, z, y: getPublicShipAltitude(id, shipClass),
      yaw, vx: 0, vz: 0, health: definition.maxHealth, shields: definition.maxShield,
      orders: [], focusTargetEntityId: null,
      lastCombatTick: state.tick,
      ...(artillery ? { artilleryDeploymentTicks: 0, revealedUntilTick: 0 } : {}),
      turrets: definition.hardpoints.map((hardpoint) => {
        const turretId = state.nextTurretId++;
        return {
          id: turretId, parentShipId: id, weaponTypeId: hardpoint.weaponTypeId,
          localX: hardpoint.localX, localZ: hardpoint.localZ,
          yawCenter: hardpoint.yawCenter, yawHalfArc: hardpoint.yawHalfArc,
          currentYaw: hardpoint.yawCenter, targetEntityId: null,
          cooldownRemaining: turretId * 7 % WEAPONS[hardpoint.weaponTypeId].cooldownTicks, fireSequence: 0,
        };
      }),
    });
  };

  if (options.players === undefined) {
    const blueSafeNode = addNode(-80, -315, 1);
    addNode(-390, -325, 1); addNode(40, -535, 1);
    addNode(-260, -220, 1.15); addNode(210, -180, 1.25); addNode(-180, 0, 1.4);
    addNode(0, 0, 1.7); addNode(180, 0, 1.4); addNode(-210, 180, 1.25); addNode(260, 220, 1.15);
    const redSafeNode = addNode(80, 315, 1);
    addNode(390, 325, 1); addNode(-40, 535, 1);
    addStructure(players[0]!, "commandCore", -170, -410, 0, { x: -170, z: -290 });
    addStructure(players[0]!, "extractor", blueSafeNode.x, blueSafeNode.z, 0, { x: -80, z: -205 }, blueSafeNode);
    addStructure(players[0]!, "solarArray", -265, -330, 0, { x: -265, z: -210 });
    addStructure(players[0]!, "shipyard", 35, -360, 0, { x: 35, z: -240 });
    addStructure(players[1]!, "commandCore", 170, 410, Math.PI, { x: 170, z: 290 });
    addStructure(players[1]!, "extractor", redSafeNode.x, redSafeNode.z, Math.PI, { x: 80, z: 205 }, redSafeNode);
    addStructure(players[1]!, "solarArray", 265, 330, Math.PI, { x: 265, z: 210 });
    addStructure(players[1]!, "shipyard", -35, 360, Math.PI, { x: -35, z: 240 });
    if (options.startingFleet === true) {
      spawn(players[0]!, "destroyer", -75, -250, 0); spawn(players[0]!, "frigate", 80, -220, 0);
      spawn(players[1]!, "destroyer", 75, 250, Math.PI); spawn(players[1]!, "frigate", -80, 220, Math.PI);
      for (let index = 0; index < fightersPerTeam; index += 1) {
        const x = -135 + index * (270 / Math.max(1, fightersPerTeam - 1));
        spawn(players[0]!, "fighter", x, -175 - index % 2 * 28, 0);
        spawn(players[1]!, "fighter", -x, 175 + index % 2 * 28, Math.PI);
      }
      for (let index = 0; index < bombersPerTeam; index += 1) {
        const x = (index - (bombersPerTeam - 1) / 2) * 48;
        spawn(players[0]!, "bomber", x, -215, 0);
        spawn(players[1]!, "bomber", -x, 215, Math.PI);
      }
    }
  } else {
    if (mapPreset !== "asteroid-belt" && mapPreset !== "shattered-core" && mapPreset !== "amazon-tunnel") {
      addMapNode((mapRandom() - 0.5) * baseRadius * 0.06, (mapRandom() - 0.5) * baseRadius * 0.06, 1.9 * density.richness);
    }
    if (mapPreset === "amazon-tunnel") {
      const basinNodes = [
        { x: 0, z: 0, richness: 3.2 },
        { x: -baseRadius * 0.085, z: -baseRadius * 0.045, richness: 2.55 },
        { x: baseRadius * 0.085, z: baseRadius * 0.045, richness: 2.55 },
      ] as const;
      for (const node of basinNodes) addMapNode(node.x, node.z, node.richness * density.richness);
    }
    const contestedCount = Math.max(
      4,
      Math.round(players.length * CONTESTED_RESOURCE_NODES_PER_PLAYER * density.count),
    );
    const layoutRotation = mapPreset === "orbital-ring"
      ? (mapRandom() - 0.5) * Math.PI * 2 / contestedCount * 0.6
      : mapRandom() * Math.PI * 2;
    for (let index = 0; index < contestedCount; index += 1) {
      const progress = index / contestedCount;
      let angle = progress * Math.PI * 2 + layoutRotation;
      let radius = baseRadius * (0.49 + (mapRandom() - 0.5) * 0.1);
      let x: number;
      let z: number;
      let richnessMultiplier = 1;
      if (mapPreset === "orbital-ring" && index < players.length) {
        // Preserve one fair inward expansion lane per spawn, then randomize the remaining ring nodes.
        angle = (isOneVsOneMatch ? spawnAngles[index]! : index / players.length * Math.PI * 2)
          + (mapRandom() - 0.5) * 0.08;
        radius = baseRadius * (0.5 + (mapRandom() - 0.5) * 0.025);
      } else if (mapPreset === "crossfire") {
        angle += Math.PI / 4;
        radius *= index % 2 === 0 ? 0.7 : 1.15;
      } else if (mapPreset === "open-expanse") {
        radius = baseRadius * (0.25 + mapRandom() * 0.48);
        angle = mapRandom() * Math.PI * 2;
      } else if (mapPreset === "amazon-tunnel") {
        x = (progress - 0.5) * baseRadius * 1.25;
        const centerFlare = Math.max(0, 1 - Math.abs(x) / (baseRadius * 0.32));
        z = (mapRandom() - 0.5) * baseRadius * (0.14 + centerFlare * 0.12);
        richnessMultiplier = 1.18;
        addMapNode(x, z, (1.25 + index % 3 * 0.12 + mapRandom() * 0.08) * density.richness * richnessMultiplier);
        continue;
      } else if (mapPreset === "core-rush") {
        angle = mapRandom() * Math.PI * 2;
        radius = baseRadius * (0.07 + mapRandom() * 0.27);
        richnessMultiplier = 1.42;
      } else if (mapPreset === "star-fortress") {
        radius = baseRadius * (0.28 + mapRandom() * 0.3);
      } else if (mapPreset === "spiral-arms") {
        const armProgress = Math.floor(index / 2) / Math.max(1, Math.ceil(contestedCount / 2) - 1);
        angle = layoutRotation + (index % 2) * Math.PI + armProgress * Math.PI * 1.65 + (mapRandom() - 0.5) * 0.18;
        radius = baseRadius * (0.16 + armProgress * 0.52);
      } else if (mapPreset === "shattered-core") {
        const cluster = index % 3;
        angle = layoutRotation + cluster * Math.PI * 2 / 3 + (mapRandom() - 0.5) * 0.42;
        radius = baseRadius * (0.3 + Math.floor(index / 3) / Math.max(1, Math.ceil(contestedCount / 3)) * 0.38);
      } else if (mapPreset === "asteroid-belt") {
        const along = (progress - 0.5) * baseRadius * 1.35;
        const across = (index % 2 === 0 ? -1 : 1) * baseRadius * (0.13 + mapRandom() * 0.09);
        x = along * Math.cos(layoutRotation) - across * Math.sin(layoutRotation);
        z = along * Math.sin(layoutRotation) + across * Math.cos(layoutRotation);
        addMapNode(x, z, (1.25 + index % 3 * 0.12 + mapRandom() * 0.08) * density.richness);
        continue;
      }
      x = Math.sin(angle) * radius;
      z = Math.cos(angle) * radius;
      addMapNode(x, z, (1.25 + index % 3 * 0.12 + mapRandom() * 0.08) * density.richness * richnessMultiplier);
    }
    const tunnelSpawnByIndex = new Map<number, { side: -1 | 1; z: number }>();
    if (mapPreset === "amazon-tunnel") {
      const orderedTeamIds = [...new Set(configs.map((config) => config.teamId))].sort((a, b) => a - b);
      const indicesBySide: Record<-1 | 1, number[]> = { [-1]: [], [1]: [] };
      for (let index = 0; index < configs.length; index += 1) {
        const teamIndex = Math.max(0, orderedTeamIds.indexOf(configs[index]!.teamId));
        const side = (teamIndex % 2 === 0 ? -1 : 1) as -1 | 1;
        indicesBySide[side].push(index);
      }
      for (const side of [-1, 1] as const) {
        const sideIndices = indicesBySide[side];
        for (let sideIndex = 0; sideIndex < sideIndices.length; sideIndex += 1) {
          const normalized = sideIndices.length <= 1 ? 0 : sideIndex / (sideIndices.length - 1) - 0.5;
          const playerIndex = sideIndices[sideIndex]!;
          const oneVsOneOffset = sideIndices.length === 1 ? oneVsOneTunnelOffsets[playerIndex]! : 0;
          tunnelSpawnByIndex.set(playerIndex, { side, z: normalized * baseRadius * 1.22 + oneVsOneOffset });
        }
      }
    }
    for (let index = 0; index < players.length; index += 1) {
      const player = players[index]!;
      const tunnelSpawn = tunnelSpawnByIndex.get(index);
      const angle = spawnAngles[index]!;
      const outwardX = tunnelSpawn?.side ?? Math.sin(angle);
      const outwardZ = tunnelSpawn ? 0 : Math.cos(angle);
      const inwardX = -outwardX;
      const inwardZ = -outwardZ;
      const tangentX = outwardZ;
      const tangentZ = -outwardX;
      const baseX = outwardX * baseRadius * (tunnelSpawn ? 0.88 : 1);
      const baseZ = tunnelSpawn?.z ?? outwardZ * baseRadius;
      const yaw = Math.atan2(inwardX, inwardZ);
      const clusterScale = Math.min(1.2, Math.max(0.9, mapScale));
      // Static construction range does not scale with map size. Keep each
      // player's two initial expansion nodes reachable from their Command Core.
      const expansionScale = Math.min(1, clusterScale);
      const rally = { x: baseX + inwardX * 145 * clusterScale, z: baseZ + inwardZ * 145 * clusterScale };
      const safeNode = addNode(
        baseX + inwardX * 105 * clusterScale + tangentX * 55 * clusterScale,
        baseZ + inwardZ * 105 * clusterScale + tangentZ * 55 * clusterScale,
        density.richness,
      );
      for (let localNode = 1; localNode < STARTING_RESOURCE_NODES_PER_PLAYER; localNode += 1) {
        const tangent = (localNode === 1 ? -1 : 1) * 220 * expansionScale;
        addNode(
          baseX + inwardX * 260 * expansionScale + tangentX * tangent,
          baseZ + inwardZ * 260 * expansionScale + tangentZ * tangent,
          density.richness,
        );
      }
      addStructure(player, "commandCore", baseX, baseZ, yaw, rally);
      if (startingBase !== "command-core") {
        addStructure(player, "extractor", safeNode.x, safeNode.z, yaw, rally, safeNode);
        addStructure(player, "solarArray", baseX + inwardX * 70 * clusterScale - tangentX * 92 * clusterScale, baseZ + inwardZ * 70 * clusterScale - tangentZ * 92 * clusterScale, yaw, rally);
        addStructure(player, "shipyard", baseX + inwardX * 65 * clusterScale + tangentX * 105 * clusterScale, baseZ + inwardZ * 65 * clusterScale + tangentZ * 105 * clusterScale, yaw, rally);
      }
      if (startingBase === "fortified") {
        for (const side of [-1, 1] as const) {
          addStructure(
            player,
            "pointDefenseBattery",
            baseX + inwardX * 25 * clusterScale + tangentX * side * 165 * clusterScale,
            baseZ + inwardZ * 25 * clusterScale + tangentZ * side * 165 * clusterScale,
            yaw,
            rally,
          );
        }
      }
      if (options.showcase === true) {
        const showcaseRally = { x: 0, z: 0 };
        const placeShowcaseStructure = (type: StructureType, inward: number, tangent: number): void => {
          addStructure(
            player,
            type,
            baseX + inwardX * inward * clusterScale + tangentX * tangent * clusterScale,
            baseZ + inwardZ * inward * clusterScale + tangentZ * tangent * clusterScale,
            yaw,
            showcaseRally,
          );
        };
        placeShowcaseStructure("fabricator", 175, -165);
        placeShowcaseStructure("storage", 185, 155);
        placeShowcaseStructure("fleetShipyard", 330, -135);
        placeShowcaseStructure("shipyard", 330, 0);
        placeShowcaseStructure("capitalShipyard", 475, 0);
        placeShowcaseStructure("fusionReactor", 440, -210);
        placeShowcaseStructure("antimatterReactor", 520, 210);
        placeShowcaseStructure("quantumStorage", 390, 260);
        placeShowcaseStructure("radarArray", 265, -250);
        placeShowcaseStructure("pointDefenseBattery", 175, -70);
        placeShowcaseStructure("missileBattery", 215, 35);
        placeShowcaseStructure("railBattery", 300, 145);
        for (const yard of state.structures.filter((structure) =>
          structure.ownerPlayerId === player.id && SHIPYARD_TYPES.includes(structure.type as ShipyardType),
        )) yard.rallyPoint = { ...showcaseRally };

        const spawnFormation = (
          shipClass: ShipClass,
          count: number,
          radialDistance: number,
          columns: number,
          lateralSpacing: number,
          depthSpacing: number,
        ): void => {
          for (let unit = 0; unit < count; unit += 1) {
            const row = Math.floor(unit / columns);
            const column = unit % columns;
            const unitsInRow = Math.min(columns, count - row * columns);
            const lateral = (column - (unitsInRow - 1) / 2) * lateralSpacing;
            const radius = radialDistance + row * depthSpacing;
            spawn(
              player,
              shipClass,
              outwardX * radius + tangentX * lateral,
              outwardZ * radius + tangentZ * lateral,
              yaw,
            );
          }
        };
        spawnFormation("fighter", 9, 270, 5, 42, 44);
        spawnFormation("bomber", 8, 360, 8, 22, 24);
        spawnFormation("frigate", 6, 420, 6, 34, 38);
        spawnFormation("flakFrigate", 4, 475, 4, 38, 42);
        spawnFormation("torpedoFrigate", 4, 530, 4, 40, 44);
        spawnFormation("destroyer", 2, 600, 2, 70, 70);
        spawnFormation("artilleryDestroyer", 1, 640, 1, 1, 1);
        spawnFormation("cruiser", 1, 680, 1, 1, 1);
        spawnFormation("carrier", 1, 770, 1, 1, 1);
        spawnFormation("battleship", 1, 870, 1, 1, 1);
      }
      if (options.menuBattle === true) {
        const spawnMenuFormation = (
          shipClass: ShipClass,
          count: number,
          radialDistance: number,
          columns: number,
          lateralSpacing: number,
          depthSpacing: number,
        ): void => {
          for (let unit = 0; unit < count; unit += 1) {
            const row = Math.floor(unit / columns);
            const column = unit % columns;
            const unitsInRow = Math.min(columns, count - row * columns);
            const lateral = (column - (unitsInRow - 1) / 2) * lateralSpacing;
            const radius = radialDistance + row * depthSpacing;
            spawn(player, shipClass, outwardX * radius + tangentX * lateral, outwardZ * radius + tangentZ * lateral, yaw);
          }
        };
        spawnMenuFormation("fighter", 16, 300, 8, 38, 42);
        spawnMenuFormation("bomber", 4, 390, 4, 48, 52);
        spawnMenuFormation("cruiser", 1, 475, 1, 1, 1);
        spawnMenuFormation("battleship", 1, 560, 1, 1, 1);
      }
      if (options.startingFleet === true) {
        const fleetX = baseX + inwardX * 120;
        const fleetZ = baseZ + inwardZ * 120;
        spawn(player, "destroyer", fleetX - tangentX * 48, fleetZ - tangentZ * 48, yaw);
        spawn(player, "frigate", fleetX + tangentX * 48, fleetZ + tangentZ * 48, yaw);
        for (let fighter = 0; fighter < fightersPerTeam; fighter += 1) {
          const lateral = (fighter - (fightersPerTeam - 1) / 2) * 42;
          spawn(player, "fighter", fleetX + tangentX * lateral + inwardX * 55, fleetZ + tangentZ * lateral + inwardZ * 55, yaw);
        }
        for (let bomber = 0; bomber < bombersPerTeam; bomber += 1) {
          const lateral = (bomber - (bombersPerTeam - 1) / 2) * 42;
          spawn(player, "bomber", fleetX + tangentX * lateral + inwardX * 24, fleetZ + tangentZ * lateral + inwardZ * 24, yaw);
        }
      }
    }
  }

  state.ships.sort((a, b) => a.id - b.id);
  if (options.showcase === true) {
    for (const player of players) {
      player.economy.alloy = 20_000;
      player.economy.energy = 20_000;
      const fleet = state.ships.filter((ship) => ship.ownerPlayerId === player.id);
      for (let index = 0; index < fleet.length; index += 1) {
        const ship = fleet[index]!;
        const lane = index % 9 - 4;
        const rank = Math.floor(index / 9) % 5 - 2;
        const destination = { x: lane * 22, z: rank * 22 };
        ship.orders = [{
          type: "attackMove",
          destination: projectNavigableDestination(state, ship, destination),
          facing: Math.atan2(destination.x - ship.x, destination.z - ship.z),
        }];
      }
      const yards = state.structures
        .filter((structure) => structure.ownerPlayerId === player.id
          && SHIPYARD_TYPES.includes(structure.type as ShipyardType))
        .sort((left, right) => left.id - right.id);
      let lightYardIndex = 0;
      for (const yard of yards) {
        const roster: readonly ShipClass[] = yard.type === "capitalShipyard"
          ? ["battleship", "carrier", "battleship"]
          : yard.type === "fleetShipyard"
            ? ["destroyer", "artilleryDestroyer", "cruiser", "flakFrigate"]
            : lightYardIndex++ % 2 === 0
              ? ["fighter", "bomber", "frigate"]
              : ["frigate", "fighter", "bomber"];
        for (const shipClass of roster) {
          yard.productionQueue.push({ id: state.nextQueueItemId++, shipClass, progress: 0 });
        }
      }
    }
  } else if (options.menuBattle === true) {
    for (const player of players) {
      const fleet = state.ships.filter((ship) => ship.ownerPlayerId === player.id);
      const classes = [...new Set(fleet.map((ship) => ship.class))];
      for (const shipClass of classes) {
        const classFleet = fleet.filter((ship) => ship.class === shipClass);
        for (const assignment of computeFormationAssignments(classFleet, { x: 0, z: 0 })) {
          const ship = state.ships.find((candidate) => candidate.id === assignment.shipId)!;
          ship.orders = [{
            type: "patrol",
            destination: projectNavigableDestination(state, ship, assignment.destination),
            facing: assignment.facing,
            patrolOrigin: { x: ship.x, z: ship.z },
          }];
        }
      }
    }
  } else if (options.startingFleet === true) {
    for (const player of players) {
      const fleet = state.ships.filter((ship) => ship.ownerPlayerId === player.id);
      const core = state.structures.find((structure) => structure.ownerPlayerId === player.id && structure.type === "commandCore")!;
      const inwardLength = Math.hypot(core.x, core.z) || 1;
      const destination = { x: core.x - core.x / inwardLength * 500, z: core.z - core.z / inwardLength * 500 };
      for (const assignment of computeFormationAssignments(fleet, destination)) {
        const ship = state.ships.find((candidate) => candidate.id === assignment.shipId)!;
        ship.orders = [{
          type: "attackMove",
          destination: projectNavigableDestination(state, ship, assignment.destination),
          facing: assignment.facing,
        }];
      }
    }
  }
  return new GameSimulation(state, undefined, options.showcase === true ? 6 : 1);
}

function orderPlayersForSpawns(
  players: readonly ScenarioPlayerConfig[],
  mode: NonNullable<ScenarioOptions["teamSpawnMode"]>,
  seed: number,
): ScenarioPlayerConfig[] {
  const ordered = [...players];
  if (mode === "together") {
    return ordered.sort((a, b) => a.teamId - b.teamId);
  }
  if (mode === "random") {
    let state = (seed ^ 0x51a7_5eed) >>> 0;
    const random = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
    for (let index = ordered.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [ordered[index], ordered[swapIndex]] = [ordered[swapIndex]!, ordered[index]!];
    }
  }
  return ordered;
}

function createMapRandom(seed: number, preset: string): () => number {
  let presetHash = 2_166_136_261;
  for (let index = 0; index < preset.length; index += 1) {
    presetHash = Math.imul(presetHash ^ preset.charCodeAt(index), 16_777_619) >>> 0;
  }
  let state = (seed ^ presetHash ^ 0x6d2b_79f5) >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 0x1_0000_0000;
  };
}

export function createShowcaseScenario(): GameSimulation {
  return createCombatScenario({
    seed: 0x5a0ca5e,
    showcase: true,
    mapPreset: "open-expanse",
    mapSize: "small",
    startingResources: "high",
    resourceDensity: "rich",
    players: [
      { id: "showcase-aster", name: "Vanguard Command", teamId: 1, color: 0x59a7ff, ai: true },
      { id: "showcase-crimson", name: "Relay Command", teamId: 2, color: 0xff5576, ai: true },
      { id: "showcase-helios", name: "Helios Wing", teamId: 1, color: 0x55e1e8, ai: true },
      { id: "showcase-ember", name: "Ember Legion", teamId: 2, color: 0xff8b55, ai: true },
    ],
  });
}

export function createMenuBattleScenario(): GameSimulation {
  return createCombatScenario({
    seed: 0x1f1f7,
    menuBattle: true,
    mapPreset: "open-expanse",
    mapSize: "small",
    startingResources: "high",
    resourceDensity: "scarce",
    players: [
      {
        id: "menu-aster", name: "Interceptor Wing", teamId: 1, color: 0x59a7ff,
        ai: true, aiDifficulty: "hard", aiPersonality: "aggressive",
      },
      {
        id: "menu-crimson", name: "Strike Group", teamId: 2, color: 0xff5576,
        ai: true, aiDifficulty: "hard", aiPersonality: "aggressive",
      },
    ],
  });
}

export function computeFormationAssignments(
  ships: readonly ShipState[],
  destination: Readonly<{ x: number; z: number }>,
  formationEnd?: Readonly<{ x: number; z: number }>,
): FormationAssignment[] {
  if (ships.length === 0) return [];
  const stableShips = [...ships].sort((a, b) => a.id - b.id);
  const centroid = stableShips.reduce(
    (sum, ship) => ({ x: sum.x + ship.x / ships.length, z: sum.z + ship.z / ships.length }),
    { x: 0, z: 0 },
  );
  const maxRadius = Math.max(...ships.map((ship) => SHIPS[ship.class].radius));
  const spacing = Math.max(18, maxRadius * 2.35);
  const hasLine = formationEnd !== undefined && Math.hypot(formationEnd.x - destination.x, formationEnd.z - destination.z) >= 18;
  const slots: Array<{ x: number; z: number; index: number }> = [];
  let facing: number;

  if (hasLine && formationEnd) {
    const midpoint = { x: (destination.x + formationEnd.x) / 2, z: (destination.z + formationEnd.z) / 2 };
    facing = Math.atan2(midpoint.x - centroid.x, midpoint.z - centroid.z);
    const lineX = formationEnd.x - destination.x;
    const lineZ = formationEnd.z - destination.z;
    const lineLength = Math.hypot(lineX, lineZ);
    const directionX = lineX / lineLength;
    const directionZ = lineZ / lineLength;
    const forwardX = Math.sin(facing);
    const forwardZ = Math.cos(facing);
    // The drag defines the available frontage, not a compulsory single rank.
    // Ships that do not fit across that frontage fill centered ranks behind it.
    const compactColumns = Math.max(1, Math.ceil(Math.sqrt(ships.length * 1.6)));
    const draggedColumns = Math.floor(lineLength / spacing) + 1;
    const columns = Math.min(ships.length, Math.max(compactColumns, draggedColumns));
    const columnSpacing = columns <= 1 ? 0 : Math.max(spacing, lineLength / (columns - 1));
    for (let index = 0; index < ships.length; index += 1) {
      const row = Math.floor(index / columns);
      const column = index % columns;
      const unitsInRow = Math.min(columns, ships.length - row * columns);
      const lateral = (column - (unitsInRow - 1) / 2) * columnSpacing;
      const depth = row * spacing;
      slots.push({
        x: midpoint.x + directionX * lateral - forwardX * depth,
        z: midpoint.z + directionZ * lateral - forwardZ * depth,
        index,
      });
    }
  } else {
    facing = Math.atan2(destination.x - centroid.x, destination.z - centroid.z);
    const rightX = Math.cos(facing);
    const rightZ = -Math.sin(facing);
    const forwardX = Math.sin(facing);
    const forwardZ = Math.cos(facing);
    const columns = Math.max(1, Math.ceil(Math.sqrt(ships.length * 1.6)));
    for (let index = 0; index < ships.length; index += 1) {
      const row = Math.floor(index / columns);
      const column = index % columns;
      const unitsInRow = Math.min(columns, ships.length - row * columns);
      const lateral = (column - (unitsInRow - 1) / 2) * spacing;
      const depth = row * spacing;
      slots.push({
        x: destination.x + rightX * lateral - forwardX * depth,
        z: destination.z + rightZ * lateral - forwardZ * depth,
        index,
      });
    }
  }

  const remainingSlots = [...slots];
  const assignments: FormationAssignment[] = [];
  const orderedShips = [...ships].sort((a, b) => SHIPS[b.class].radius - SHIPS[a.class].radius || a.id - b.id);
  for (const ship of orderedShips) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < remainingSlots.length; index += 1) {
      const slot = remainingSlots[index]!;
      const distance = (slot.x - ship.x) ** 2 + (slot.z - ship.z) ** 2;
      if (distance < bestDistance || (distance === bestDistance && slot.index < remainingSlots[bestIndex]!.index)) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    const [slot] = remainingSlots.splice(bestIndex, 1);
    assignments.push({ shipId: ship.id, destination: { x: slot!.x, z: slot!.z }, facing });
  }
  return assignments.sort((a, b) => a.shipId - b.shipId);
}

export function restoreSimulation(snapshot: SimulationState, physicsWorld?: PlanarCirclePhysicsWorld): GameSimulation {
  const restored = JSON.parse(JSON.stringify(snapshot)) as SimulationState & {
    obstacles?: ObstacleState[];
    visibility?: SimulationState["visibility"];
    version: number;
    aiCommanders?: SimulationState["aiCommanders"];
  };
  restored.obstacles ??= [];
  restored.visibility ??= [];
  restored.aiCommanders ??= Object.fromEntries(restored.aiPlayerIds.map((playerId) => [playerId, {
    difficulty: "normal", personality: "balanced",
  }]));
  restored.version = 9;
  return new GameSimulation(restored as SimulationState, physicsWorld);
}

export function getLocalBearing(ship: ShipState, worldX: number, worldZ: number): number {
  return wrapAngle(Math.atan2(worldX - ship.x, worldZ - ship.z) - ship.yaw);
}

export function isPointInTurretArc(ship: ShipState, turret: TurretState, worldX: number, worldZ: number): boolean {
  const localBearing = getLocalBearing(ship, worldX, worldZ);
  return Math.abs(wrapAngle(localBearing - turret.yawCenter)) <= turret.yawHalfArc;
}

export function getTurretWorldPosition(ship: ShipState, turret: TurretState): { x: number; z: number } {
  const cosine = Math.cos(ship.yaw);
  const sine = Math.sin(ship.yaw);
  return { x: ship.x + cosine * turret.localX + sine * turret.localZ, z: ship.z - sine * turret.localX + cosine * turret.localZ };
}

export function getTurretMuzzleWorldPosition(
  ship: ShipState,
  turret: TurretState,
  fireSequence = turret.fireSequence,
  tick = 0,
): { x: number; z: number } {
  const weapon = WEAPONS[turret.weaponTypeId];
  const scale = SHIP_TURRET_SCALES[ship.class];
  let mount = getTurretWorldPosition(ship, turret);
  let yaw = ship.yaw + turret.currentYaw;
  if (ship.class === "fighter") {
    const memberIndex = ship.turrets.findIndex((candidate) => candidate.id === turret.id);
    const base = FIGHTER_SQUAD_OFFSETS[memberIndex];
    if (memberIndex >= 0 && base) {
      const pose = getFighterSquadMemberPose(ship.id, memberIndex, tick);
      const gunOffset = turret.localZ - base[1];
      const localX = pose.x + Math.sin(pose.yaw) * gunOffset;
      const localZ = pose.z + Math.cos(pose.yaw) * gunOffset;
      const cosine = Math.cos(ship.yaw);
      const sine = Math.sin(ship.yaw);
      mount = {
        x: ship.x + cosine * localX + sine * localZ,
        z: ship.z - sine * localX + cosine * localZ,
      };
      yaw = ship.yaw + pose.yaw;
    }
  }
  const forwardX = Math.sin(yaw);
  const forwardZ = Math.cos(yaw);
  const rightX = Math.cos(yaw);
  const rightZ = -Math.sin(yaw);
  const barrelSide = weapon.muzzleSeparation === 0 ? 0 : fireSequence % 2 === 0 ? -1 : 1;
  return {
    x: mount.x + forwardX * weapon.muzzleOffset * scale + rightX * weapon.muzzleSeparation * scale * barrelSide,
    z: mount.z + forwardZ * weapon.muzzleOffset * scale + rightZ * weapon.muzzleSeparation * scale * barrelSide,
  };
}

function getOperationalTurretCount(ship: ShipState): number {
  if (ship.health <= 0 || ship.turrets.length === 0) return 0;
  if (ship.class !== "fighter") return ship.turrets.length;
  const healthFraction = ship.health / SHIPS.fighter.maxHealth;
  return Math.max(1, Math.min(ship.turrets.length, Math.ceil(healthFraction * ship.turrets.length)));
}

function isFleetCommand(command: GameCommand): command is FleetCommand {
  return "unitIds" in command;
}

function isShip(target: CombatTargetState): target is ShipState {
  return "class" in target;
}

function getTargetRadius(target: CombatTargetState): number {
  return isShip(target) ? SHIPS[target.class].radius : STRUCTURES[target.type].radius;
}

function getStructureTargetPreference(weaponType: string, structureType: StructureType): number {
  if (weaponType === "pointDefense" || weaponType === "flakCannon") return 12;
  if (weaponType === "lightArtillery" || weaponType === "siegeArtillery" || weaponType === "strategicArtillery") {
    return structureType === "commandCore" ? -4 : 0;
  }
  if (weaponType === "torpedo") return structureType === "commandCore" ? -24 : 2;
  if (weaponType === "heavyRail") return structureType === "commandCore" ? -12 : 4;
  if (weaponType === "beam") return structureType === "commandCore" ? -8 : 10;
  if (weaponType === "plasma") return structureType === "commandCore" ? 12 : 28;
  return structureType === "commandCore" ? 70 : 95;
}

function createScenarioObstacles(
  playerCount: number,
  mapPreset: NonNullable<ScenarioOptions["mapPreset"]> = "orbital-ring",
  baseRadius = 2_400,
  seed = 0xc0ffee,
  spawnAngles?: readonly number[],
): ObstacleState[] {
  const random = createMapRandom(seed ^ Math.imul(playerCount, 0x85ebca6b), mapPreset);
  const obstacles: ObstacleState[] = [];
  const addObstacle = (x: number, z: number, radius: number): void => {
    obstacles.push({
      id: obstacles.length + 1,
      type: "asteroid",
      x: quantizePhysics(x),
      z: quantizePhysics(z),
      radius: quantizePhysics(radius),
      visualSeed: Math.floor(random() * 0x1_0000_0000) >>> 0,
    });
  };
  const addBarrier = (x: number, z: number, width: number, depth: number): void => {
    obstacles.push({
      id: obstacles.length + 1,
      type: "barrier",
      x: quantizePhysics(x), z: quantizePhysics(z),
      radius: quantizePhysics(Math.hypot(width, depth) * 0.5),
      width: quantizePhysics(width), depth: quantizePhysics(depth),
      visualSeed: Math.floor(random() * 0x1_0000_0000) >>> 0,
    });
  };

  if (mapPreset === "amazon-tunnel") {
    // A closed outer boundary and two sealed inner fields create an actual H-shaped
    // arena. Fleets can move vertically on either home side, but the only route
    // between opponents is the narrow horizontal tunnel through the center.
    const outerX = baseRadius * 1.08;
    const outerZ = baseRadius * 0.91;
    const fieldX = baseRadius * 0.7;
    const tunnelHalfWidth = baseRadius * 0.18;
    const border = Math.max(120, baseRadius * 0.055);
    const fieldDepth = outerZ - tunnelHalfWidth;
    addBarrier(0, tunnelHalfWidth + fieldDepth * 0.5, fieldX * 2, fieldDepth);
    addBarrier(0, -tunnelHalfWidth - fieldDepth * 0.5, fieldX * 2, fieldDepth);
    addBarrier(0, outerZ + border * 0.5, outerX * 2 + border * 2, border);
    addBarrier(0, -outerZ - border * 0.5, outerX * 2 + border * 2, border);
    addBarrier(-outerX - border * 0.5, 0, border, outerZ * 2);
    addBarrier(outerX + border * 0.5, 0, border, outerZ * 2);
    return obstacles;
  }

  if (mapPreset === "star-fortress") {
    const wallRadius = Math.max(38, baseRadius * 0.022);
    const wallDistance = Math.max(320, baseRadius * 0.19);
    const wallPieces = 12;
    for (let playerIndex = 0; playerIndex < playerCount; playerIndex += 1) {
      const spawnAngle = spawnAngles?.[playerIndex] ?? Math.PI + playerIndex / playerCount * Math.PI * 2;
      const centerX = Math.sin(spawnAngle) * baseRadius;
      const centerZ = Math.cos(spawnAngle) * baseRadius;
      for (let wallIndex = 0; wallIndex < wallPieces; wallIndex += 1) {
        const offset = wallIndex / wallPieces * Math.PI * 2;
        const inwardOffset = Math.abs(Math.atan2(Math.sin(offset - Math.PI), Math.cos(offset - Math.PI)));
        if (inwardOffset < Math.PI / 5) continue;
        addObstacle(
          centerX + Math.sin(spawnAngle + offset) * wallDistance,
          centerZ + Math.cos(spawnAngle + offset) * wallDistance,
          wallRadius * (0.82 + random() * 0.22),
        );
      }
    }
    return obstacles;
  }

  const obstacleCount = mapPreset === "open-expanse" ? Math.max(2, Math.ceil(playerCount / 2))
    : mapPreset === "crossfire" ? Math.max(6, playerCount * 2)
      : mapPreset === "asteroid-belt" ? Math.max(10, playerCount * 3)
        : mapPreset === "shattered-core" ? Math.max(9, playerCount * 2)
          : mapPreset === "spiral-arms" ? Math.max(6, playerCount)
            : mapPreset === "core-rush" ? Math.max(3, Math.ceil(playerCount * 0.75))
              : playerCount;
  const rotation = random() * Math.PI * 2;
  for (let index = 0; index < obstacleCount; index += 1) {
    let x = 0;
    let z = 0;
    if (mapPreset === "asteroid-belt") {
      const along = (index / Math.max(1, obstacleCount - 1) - 0.5) * baseRadius * 1.18;
      const across = (random() - 0.5) * baseRadius * 0.16;
      x = along * Math.cos(rotation) - across * Math.sin(rotation);
      z = along * Math.sin(rotation) + across * Math.cos(rotation);
    } else if (mapPreset === "crossfire") {
      const lane = index % 2 === 0 ? 1 : -1;
      const along = (Math.floor(index / 2) / Math.max(1, Math.ceil(obstacleCount / 2) - 1) - 0.5) * baseRadius * 1.05;
      const across = lane * along + (random() - 0.5) * baseRadius * 0.08;
      x = along * Math.cos(rotation) - across * Math.sin(rotation);
      z = along * Math.sin(rotation) + across * Math.cos(rotation);
    } else {
      const progress = index / obstacleCount;
      let angle = rotation + progress * Math.PI * 2 + (random() - 0.5) * 0.28;
      let radialScale = 0.3 + (random() - 0.5) * 0.08;
      if (mapPreset === "open-expanse") radialScale = 0.25 + random() * 0.36;
      else if (mapPreset === "spiral-arms") {
        angle = rotation + (index % 2) * Math.PI + progress * Math.PI * 1.8;
        radialScale = 0.16 + progress * 0.43;
      } else if (mapPreset === "shattered-core") radialScale = 0.1 + random() * 0.28;
      x = Math.sin(angle) * baseRadius * radialScale;
      z = Math.cos(angle) * baseRadius * radialScale;
    }
    const radiusBase = mapPreset === "open-expanse" ? 22 : mapPreset === "asteroid-belt" ? 35 : 30;
    const radius = radiusBase * (0.72 + random() * 0.58);
    addObstacle(x, z, radius);
  }
  return obstacles;
}

function quantizePhysics(value: number): number {
  return Math.round(value * 100_000) / 100_000;
}

function getPublicShipAltitude(id: EntityId, shipClass: ShipClass): number {
  const classSalt = shipClass === "fighter"
    ? 0x51ed270b
    : shipClass === "bomber" ? 0x47b6137d : shipClass === "frigate" ? 0x2c9277b5 : 0x6d2b79f5;
  const value = Math.imul(id ^ classSalt, 0x9e3779b1) >>> 0;
  const altitudeSpread = shipClass === "fighter" ? 18 : shipClass === "bomber" ? 11 : 5;
  return ((value % 1_000) / 1_000 - 0.5) * altitudeSpread;
}

function isSmallCraft(shipClass: ShipClass): boolean {
  return shipClass === "fighter" || shipClass === "bomber";
}

function shipsUseFormationSeparation(left: ShipClass, right: ShipClass): boolean {
  return !(isSmallCraft(left) && CAPITAL_SHIP_CLASSES.has(right)
    || CAPITAL_SHIP_CLASSES.has(left) && isSmallCraft(right));
}

function shipCollisionFilter(shipClass: ShipClass): { category: number; mask: number } {
  if (isSmallCraft(shipClass)) {
    return {
      category: SMALL_CRAFT_COLLISION_CATEGORY,
      mask: ALL_COLLISION_CATEGORIES
        & ~SMALL_CRAFT_COLLISION_CATEGORY
        & ~CAPITAL_SHIP_COLLISION_CATEGORY,
    };
  }
  if (CAPITAL_SHIP_CLASSES.has(shipClass)) {
    return {
      category: CAPITAL_SHIP_COLLISION_CATEGORY,
      mask: ALL_COLLISION_CATEGORIES & ~SMALL_CRAFT_COLLISION_CATEGORY,
    };
  }
  return { category: REGULAR_SHIP_COLLISION_CATEGORY, mask: ALL_COLLISION_CATEGORIES };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function circleOverlapsObstacle(x: number, z: number, radius: number, obstacle: ObstacleState): boolean {
  if (obstacle.type !== "barrier" || !obstacle.width || !obstacle.depth) {
    return Math.hypot(obstacle.x - x, obstacle.z - z) < obstacle.radius + radius;
  }
  const nearestX = Math.max(obstacle.x - obstacle.width * 0.5, Math.min(x, obstacle.x + obstacle.width * 0.5));
  const nearestZ = Math.max(obstacle.z - obstacle.depth * 0.5, Math.min(z, obstacle.z + obstacle.depth * 0.5));
  return Math.hypot(x - nearestX, z - nearestZ) < radius;
}

function sweptCircleRectangleHitFraction(
  fromX: number, fromZ: number, toX: number, toZ: number,
  centerX: number, centerZ: number, width: number, depth: number, radius: number,
): number | null {
  const minX = centerX - width * 0.5 - radius;
  const maxX = centerX + width * 0.5 + radius;
  const minZ = centerZ - depth * 0.5 - radius;
  const maxZ = centerZ + depth * 0.5 + radius;
  const dx = toX - fromX;
  const dz = toZ - fromZ;
  let entry = 0;
  let exit = 1;
  for (const [origin, delta, minimum, maximum] of [[fromX, dx, minX, maxX], [fromZ, dz, minZ, maxZ]] as const) {
    if (Math.abs(delta) < 1e-9) {
      if (origin < minimum || origin > maximum) return null;
      continue;
    }
    const first = (minimum - origin) / delta;
    const second = (maximum - origin) / delta;
    entry = Math.max(entry, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    if (entry > exit) return null;
  }
  return entry >= 0 && entry <= 1 ? entry : null;
}

interface NavigableStatic {
  key: string;
  x: number;
  z: number;
  radius: number;
  width?: number;
  depth?: number;
}

function buildNavigableStatics(state: SimulationState): NavigableStatic[] {
  return [
    ...state.obstacles.map((obstacle) => ({
      key: `obstacle:${obstacle.id}`, x: obstacle.x, z: obstacle.z, radius: obstacle.radius,
      width: obstacle.width, depth: obstacle.depth,
    })),
    ...state.structures.filter((structure) => !shipsPhaseThroughStructure(structure.type)).map((structure) => ({
      key: `structure:${structure.id}`, x: structure.x, z: structure.z, radius: STRUCTURES[structure.type].radius,
    })),
  ].sort((left, right) => compareCodeUnits(left.key, right.key));
}

function projectNavigableDestination(
  state: SimulationState,
  ship: ShipState,
  destination: Readonly<{ x: number; z: number }>,
  statics: readonly NavigableStatic[] = buildNavigableStatics(state),
): { x: number; z: number } {
  const shipRadius = SHIPS[ship.class].radius;
  let x = destination.x;
  let z = destination.z;
  for (let pass = 0; pass < 8; pass += 1) {
    let projected = false;
    for (let index = 0; index < statics.length; index += 1) {
      const obstacle = statics[index]!;
      if (obstacle.width && obstacle.depth) {
        const halfWidth = obstacle.width * 0.5;
        const halfDepth = obstacle.depth * 0.5;
        const nearestX = Math.max(obstacle.x - halfWidth, Math.min(x, obstacle.x + halfWidth));
        const nearestZ = Math.max(obstacle.z - halfDepth, Math.min(z, obstacle.z + halfDepth));
        let dx = x - nearestX;
        let dz = z - nearestZ;
        let distance = Math.hypot(dx, dz);
        if (distance >= shipRadius + 2) continue;
        if (distance < 0.001) {
          const distances = [
            { value: Math.abs(x - (obstacle.x - halfWidth)), x: obstacle.x - halfWidth - shipRadius - 2, z },
            { value: Math.abs(obstacle.x + halfWidth - x), x: obstacle.x + halfWidth + shipRadius + 2, z },
            { value: Math.abs(z - (obstacle.z - halfDepth)), x, z: obstacle.z - halfDepth - shipRadius - 2 },
            { value: Math.abs(obstacle.z + halfDepth - z), x, z: obstacle.z + halfDepth + shipRadius + 2 },
          ].sort((left, right) => left.value - right.value);
          x = distances[0]!.x; z = distances[0]!.z;
        } else {
          distance = shipRadius + 2;
          x = nearestX + dx / Math.hypot(dx, dz) * distance;
          z = nearestZ + dz / Math.hypot(dx, dz) * distance;
        }
        projected = true;
        continue;
      }
      let dx = x - obstacle.x;
      let dz = z - obstacle.z;
      let distance = Math.hypot(dx, dz);
      const minimumDistance = shipRadius + obstacle.radius + 2;
      if (distance >= minimumDistance) continue;
      if (distance < 0.001) {
        const angle = ((ship.id * 17 + index * 31) * 2.399963229728653) % (Math.PI * 2);
        dx = Math.sin(angle);
        dz = Math.cos(angle);
        distance = 1;
      }
      x = obstacle.x + dx / distance * minimumDistance;
      z = obstacle.z + dz / distance * minimumDistance;
      projected = true;
    }
    if (!projected) break;
  }
  return { x, z };
}
