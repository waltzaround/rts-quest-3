import { SHIPS, STRUCTURES } from "./data";
import { SpatialHash } from "./spatial-hash";
import type {
  CombatTargetState,
  EntityId,
  ProjectileState,
  ResourceNodeState,
  SimulationState,
  TeamId,
  TeamVisibilityState,
} from "./types";

interface SensorSource {
  x: number;
  z: number;
  range: number;
}

const STRATEGIC_SENSOR_SHIP_COUNT = 1_000;
const STRATEGIC_SENSOR_CELL_SIZE = 320;

function collapseStrategicSensors(sources: readonly SensorSource[]): SensorSource[] {
  const cells = new Map<string, SensorSource>();
  for (const source of sources) {
    const cellX = Math.floor(source.x / STRATEGIC_SENSOR_CELL_SIZE);
    const cellZ = Math.floor(source.z / STRATEGIC_SENSOR_CELL_SIZE);
    const centerX = (cellX + 0.5) * STRATEGIC_SENSOR_CELL_SIZE;
    const centerZ = (cellZ + 0.5) * STRATEGIC_SENSOR_CELL_SIZE;
    const coveringRange = source.range + Math.hypot(source.x - centerX, source.z - centerZ);
    const key = `${cellX}:${cellZ}`;
    const existing = cells.get(key);
    if (!existing || coveringRange > existing.range) {
      cells.set(key, { x: centerX, z: centerZ, range: coveringRange });
    }
  }
  return [...cells.values()];
}

export function areTeamsAllied(state: SimulationState, teamA: TeamId, teamB: TeamId): boolean {
  if (teamA === teamB) return true;
  const first = state.teams.find((team) => team.id === teamA);
  const second = state.teams.find((team) => team.id === teamB);
  return Boolean(first?.alliedTeamIds.includes(teamB) || second?.alliedTeamIds.includes(teamA));
}

export function getTeamVisibility(state: SimulationState, teamId: TeamId): TeamVisibilityState | undefined {
  return state.visibility.find((visibility) => visibility.teamId === teamId);
}

export function isEntityVisibleToTeam(
  state: SimulationState,
  teamId: TeamId,
  entityId: EntityId,
): boolean {
  return getTeamVisibility(state, teamId)?.visibleEntityIds.includes(entityId) ?? false;
}

export function isProjectileVisibleToTeam(
  state: SimulationState,
  teamId: TeamId,
  projectileId: EntityId,
): boolean {
  return getTeamVisibility(state, teamId)?.visibleProjectileIds.includes(projectileId) ?? false;
}

export function isResourceNodeDiscoveredByTeam(
  state: SimulationState,
  teamId: TeamId,
  resourceNodeId: EntityId,
): boolean {
  return getTeamVisibility(state, teamId)?.discoveredResourceNodeIds.includes(resourceNodeId) ?? false;
}

export function initializeTeamVisibility(state: SimulationState): void {
  const previousByTeam = new Map((state.visibility ?? []).map((visibility) => [visibility.teamId, visibility]));
  state.visibility = [...state.teams]
    .sort((left, right) => left.id - right.id)
    .map((team) => ({
      teamId: team.id,
      visibleEntityIds: [],
      visibleProjectileIds: [],
      discoveredResourceNodeIds: [...new Set(previousByTeam.get(team.id)?.discoveredResourceNodeIds ?? [])]
        .sort((left, right) => left - right),
    }));
}

export function updateTeamVisibility(
  state: SimulationState,
  existingTargetHash?: SpatialHash<CombatTargetState>,
): void {
  const priorDiscovery = new Map(
    (state.visibility ?? []).map((visibility) => [visibility.teamId, visibility.discoveredResourceNodeIds]),
  );
  const teamIds = [...state.teams].sort((left, right) => left.id - right.id).map((team) => team.id);
  const targetHash = existingTargetHash ?? new SpatialHash<CombatTargetState>(160);
  if (!existingTargetHash) {
    targetHash.rebuild([...state.ships, ...state.structures].filter((target) => target.health > 0));
  }
  const projectileHash = new SpatialHash<ProjectileState>(160);
  projectileHash.rebuild(state.projectiles);
  const resourceHash = state.resourceNodes.length > 32 ? new SpatialHash<ResourceNodeState>(160) : null;
  resourceHash?.rebuild(state.resourceNodes);

  const ownedEntityIds = new Map<TeamId, Set<EntityId>>();
  const ownedProjectileIds = new Map<TeamId, Set<EntityId>>();
  const detectedEntityIds = new Map<TeamId, Set<EntityId>>();
  const detectedProjectileIds = new Map<TeamId, Set<EntityId>>();
  const detectedResourceIds = new Map<TeamId, Set<EntityId>>();
  const sourcesByTeam = new Map<TeamId, SensorSource[]>();

  for (const teamId of teamIds) {
    ownedEntityIds.set(teamId, new Set());
    ownedProjectileIds.set(teamId, new Set());
    detectedEntityIds.set(teamId, new Set());
    detectedProjectileIds.set(teamId, new Set());
    detectedResourceIds.set(teamId, new Set());
    sourcesByTeam.set(teamId, []);
  }
  for (const ship of state.ships) {
    if (ship.health <= 0) continue;
    ownedEntityIds.get(ship.teamId)?.add(ship.id);
    sourcesByTeam.get(ship.teamId)?.push({ x: ship.x, z: ship.z, range: SHIPS[ship.class].sensorRange });
  }
  for (const structure of state.structures) {
    if (structure.health <= 0) continue;
    ownedEntityIds.get(structure.teamId)?.add(structure.id);
    if (structure.buildProgress >= 1) {
      sourcesByTeam.get(structure.teamId)?.push({
        x: structure.x,
        z: structure.z,
        range: STRUCTURES[structure.type].sensorRange,
      });
    }
  }
  for (const projectile of state.projectiles) ownedProjectileIds.get(projectile.ownerTeamId)?.add(projectile.id);

  if (state.ships.length > STRATEGIC_SENSOR_SHIP_COUNT) {
    for (const teamId of teamIds) {
      sourcesByTeam.set(teamId, collapseStrategicSensors(sourcesByTeam.get(teamId)!));
    }
  }

  for (const teamId of teamIds) {
    const detectedEntities = detectedEntityIds.get(teamId)!;
    const detectedProjectiles = detectedProjectileIds.get(teamId)!;
    const detectedResources = detectedResourceIds.get(teamId)!;
    const sources = sourcesByTeam.get(teamId)!;
    for (const source of sources) {
      const rangeSquared = source.range ** 2;
      for (const target of targetHash.query(source.x, source.z, source.range)) {
        if (distanceSquared(source, target) <= rangeSquared) detectedEntities.add(target.id);
      }
      for (const projectile of projectileHash.query(source.x, source.z, source.range)) {
        if (distanceSquared(source, projectile) <= rangeSquared) detectedProjectiles.add(projectile.id);
      }
      const nearbyResources = resourceHash?.query(source.x, source.z, source.range) ?? state.resourceNodes;
      for (const resource of nearbyResources) {
        if (distanceSquared(source, resource) <= rangeSquared) detectedResources.add(resource.id);
      }
    }
  }

  state.visibility = teamIds.map((viewerTeamId) => {
    const visibleEntityIds = new Set<EntityId>();
    const visibleProjectileIds = new Set<EntityId>();
    const discoveredResourceNodeIds = new Set(priorDiscovery.get(viewerTeamId) ?? []);
    for (const sourceTeamId of teamIds) {
      if (!areTeamsAllied(state, viewerTeamId, sourceTeamId)) continue;
      for (const entityId of ownedEntityIds.get(sourceTeamId)!) visibleEntityIds.add(entityId);
      for (const entityId of detectedEntityIds.get(sourceTeamId)!) visibleEntityIds.add(entityId);
      for (const projectileId of ownedProjectileIds.get(sourceTeamId)!) visibleProjectileIds.add(projectileId);
      for (const projectileId of detectedProjectileIds.get(sourceTeamId)!) visibleProjectileIds.add(projectileId);
      for (const resourceId of detectedResourceIds.get(sourceTeamId)!) discoveredResourceNodeIds.add(resourceId);
    }
    for (const ship of state.ships) {
      if ((ship.revealedUntilTick ?? 0) > 0 && (ship.revealedUntilTick ?? 0) >= state.tick
        && !areTeamsAllied(state, viewerTeamId, ship.teamId)) {
        visibleEntityIds.add(ship.id);
      }
    }
    for (const structure of state.structures) {
      if ((structure.revealedUntilTick ?? 0) > 0 && (structure.revealedUntilTick ?? 0) >= state.tick
        && !areTeamsAllied(state, viewerTeamId, structure.teamId)) {
        visibleEntityIds.add(structure.id);
      }
    }
    return {
      teamId: viewerTeamId,
      visibleEntityIds: [...visibleEntityIds].sort((left, right) => left - right),
      visibleProjectileIds: [...visibleProjectileIds].sort((left, right) => left - right),
      discoveredResourceNodeIds: [...discoveredResourceNodeIds].sort((left, right) => left - right),
    };
  });
}

function distanceSquared(
  left: Readonly<{ x: number; z: number }>,
  right: Readonly<{ x: number; z: number }>,
): number {
  return (left.x - right.x) ** 2 + (left.z - right.z) ** 2;
}
