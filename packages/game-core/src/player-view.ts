import type {
  EntityId,
  OmniscientViewState,
  PlayerId,
  PlayerViewRelationship,
  PlayerViewShipState,
  PlayerViewState,
  PlayerViewStructureState,
  SimulationState,
  TeamId,
  TeamViewState,
} from "./types";
import { areTeamsAllied, getTeamVisibility } from "./visibility";

export function projectPlayerView(state: SimulationState, playerId: PlayerId): PlayerViewState | null {
  const viewer = state.players.find((player) => player.id === playerId);
  if (!viewer) return null;
  const visibility = getTeamVisibility(state, viewer.teamId);
  if (!visibility) return null;
  const visibleEntityIds = new Set(visibility.visibleEntityIds);
  const visibleProjectileIds = new Set(visibility.visibleProjectileIds);
  const discoveredResourceNodeIds = new Set(visibility.discoveredResourceNodeIds);
  const relationshipFor = (ownerPlayerId: PlayerId, teamId: number): PlayerViewRelationship => {
    if (ownerPlayerId === playerId) return "self";
    return areTeamsAllied(state, viewer.teamId, teamId) ? "ally" : "hostile";
  };

  const ships: PlayerViewShipState[] = state.ships
    .filter((ship) => visibleEntityIds.has(ship.id))
    .map((ship) => {
      const relationship = relationshipFor(ship.ownerPlayerId, ship.teamId);
      const sharesPrivateState = relationship !== "hostile";
      return {
        id: ship.id,
        ownerPlayerId: ship.ownerPlayerId,
        teamId: ship.teamId,
        relationship,
        class: ship.class,
        x: ship.x,
        z: ship.z,
        y: ship.y,
        yaw: ship.yaw,
        vx: ship.vx,
        vz: ship.vz,
        health: ship.health,
        shields: ship.shields,
        orders: sharesPrivateState ? ship.orders.map((order) => ({
          ...order,
          destination: { ...order.destination },
          ...(order.patrolOrigin ? { patrolOrigin: { ...order.patrolOrigin } } : {}),
        })) : [],
        focusTargetEntityId: sharesPrivateState && ship.focusTargetEntityId !== null
          && visibleEntityIds.has(ship.focusTargetEntityId)
          ? ship.focusTargetEntityId
          : null,
        turrets: ship.turrets.map((turret) => ({
          id: turret.id,
          parentShipId: turret.parentShipId,
          weaponTypeId: turret.weaponTypeId,
          localX: turret.localX,
          localZ: turret.localZ,
          yawCenter: turret.yawCenter,
          yawHalfArc: turret.yawHalfArc,
          currentYaw: turret.currentYaw,
          targetEntityId: sharesPrivateState && turret.targetEntityId !== null
            && visibleEntityIds.has(turret.targetEntityId)
            ? turret.targetEntityId
            : null,
          cooldownRemaining: sharesPrivateState ? turret.cooldownRemaining : 0,
          fireSequence: sharesPrivateState ? turret.fireSequence : 0,
        })),
      };
    });

  const structures: PlayerViewStructureState[] = state.structures
    .filter((structure) => visibleEntityIds.has(structure.id))
    .map((structure) => {
      const relationship = relationshipFor(structure.ownerPlayerId, structure.teamId);
      const sharesPrivateState = relationship !== "hostile";
      return {
        id: structure.id,
        ownerPlayerId: structure.ownerPlayerId,
        teamId: structure.teamId,
        relationship,
        type: structure.type,
        x: structure.x,
        z: structure.z,
        yaw: structure.yaw,
        health: structure.health,
        shields: structure.shields,
        buildProgress: structure.buildProgress,
        resourceNodeId: structure.resourceNodeId !== null
          && discoveredResourceNodeIds.has(structure.resourceNodeId)
          ? structure.resourceNodeId
          : null,
        productionQueue: sharesPrivateState
          ? structure.productionQueue.map((item) => ({ ...item }))
          : [],
        repeatProduction: sharesPrivateState && structure.repeatProduction,
        rallyPoint: sharesPrivateState ? { ...structure.rallyPoint } : null,
      };
    });

  const view: PlayerViewState = {
    version: 1,
    simulationVersion: 7,
    tick: state.tick,
    viewerPlayerId: viewer.id,
    viewerTeamId: viewer.teamId,
    ownLastCommandSequence: viewer.lastCommandSequence,
    players: state.players.map((player) => ({
      id: player.id,
      name: player.name,
      teamId: player.teamId,
      color: player.color,
      state: player.state,
      isAi: state.aiPlayerIds.includes(player.id),
      economy: areTeamsAllied(state, viewer.teamId, player.teamId) ? { ...player.economy } : null,
    })),
    teams: state.teams.map((team) => ({
      id: team.id,
      name: team.name,
      alliedTeamIds: [...team.alliedTeamIds].sort((left, right) => left - right),
    })),
    ships,
    structures,
    resourceNodes: state.resourceNodes
      .filter((node) => discoveredResourceNodeIds.has(node.id))
      .map((node) => ({
        ...node,
        claimedByStructureId: node.claimedByStructureId !== null
          && visibleEntityIds.has(node.claimedByStructureId)
          ? node.claimedByStructureId
          : null,
      })),
    obstacles: state.obstacles.map((obstacle) => ({ ...obstacle })),
    projectiles: state.projectiles
      .filter((projectile) => visibleProjectileIds.has(projectile.id))
      .map((projectile) => ({
        ...projectile,
        ownerShipId: visibleEntityIds.has(projectile.ownerShipId) ? projectile.ownerShipId : null,
        targetEntityId: visibleEntityIds.has(projectile.targetEntityId) ? projectile.targetEntityId : null,
      })),
    status: state.status,
    winnerTeamId: state.winnerTeamId,
    checksum: 0,
  };
  view.checksum = calculatePlayerViewChecksum(view);
  return view;
}

export function calculatePlayerViewChecksum(view: PlayerViewState): number {
  return calculateViewChecksum(view);
}

export function projectTeamView(state: SimulationState, teamId: TeamId): TeamViewState | null {
  const representative = state.players.find((player) => player.teamId === teamId);
  if (!representative) return null;
  const playerView = projectPlayerView(state, representative.id);
  if (!playerView) return null;
  const view: TeamViewState = {
    ...playerView,
    viewerPlayerId: null,
    viewerTeamId: teamId,
    ownLastCommandSequence: null,
    ships: playerView.ships.map((ship) => ({
      ...ship,
      relationship: ship.relationship === "hostile" ? "hostile" : "ally",
    })),
    structures: playerView.structures.map((structure) => ({
      ...structure,
      relationship: structure.relationship === "hostile" ? "hostile" : "ally",
    })),
    checksum: 0,
  };
  view.checksum = calculateTeamViewChecksum(view);
  return view;
}

export function calculateTeamViewChecksum(view: TeamViewState): number {
  return calculateViewChecksum(view);
}

export function projectOmniscientView(state: SimulationState): OmniscientViewState {
  const view: OmniscientViewState = {
    version: 1,
    simulationVersion: 7,
    tick: state.tick,
    players: state.players.map((player) => ({
      id: player.id,
      name: player.name,
      teamId: player.teamId,
      color: player.color,
      state: player.state,
      isAi: state.aiPlayerIds.includes(player.id),
      economy: { ...player.economy },
    })),
    teams: state.teams.map((team) => ({
      id: team.id,
      name: team.name,
      alliedTeamIds: [...team.alliedTeamIds].sort((left, right) => left - right),
    })),
    ships: state.ships.map((ship) => ({
      ...ship,
      relationship: "omniscient",
      orders: ship.orders.map((order) => ({
        ...order,
        destination: { ...order.destination },
        ...(order.patrolOrigin ? { patrolOrigin: { ...order.patrolOrigin } } : {}),
      })),
      turrets: ship.turrets.map((turret) => ({ ...turret })),
    })),
    structures: state.structures.map((structure) => ({
      ...structure,
      relationship: "omniscient",
      productionQueue: structure.productionQueue.map((item) => ({ ...item })),
      rallyPoint: { ...structure.rallyPoint },
    })),
    resourceNodes: state.resourceNodes.map((node) => ({ ...node })),
    obstacles: state.obstacles.map((obstacle) => ({ ...obstacle })),
    projectiles: state.projectiles.map((projectile) => ({ ...projectile })),
    status: state.status,
    winnerTeamId: state.winnerTeamId,
    checksum: 0,
  };
  view.checksum = calculateOmniscientViewChecksum(view);
  return view;
}

export function calculateOmniscientViewChecksum(view: OmniscientViewState): number {
  return calculateViewChecksum(view);
}

function calculateViewChecksum(view: PlayerViewState | TeamViewState | OmniscientViewState): number {
  let hash = 2166136261;
  const hashUint = (value: number): void => {
    hash ^= value >>> 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  };
  const hashString = (value: string): void => {
    hashUint(value.length);
    for (let index = 0; index < value.length; index += 1) hashUint(value.charCodeAt(index));
  };
  const visit = (value: unknown): void => {
    if (value === null) {
      hashUint(0);
    } else if (typeof value === "boolean") {
      hashUint(value ? 2 : 1);
    } else if (typeof value === "number") {
      hashUint(3);
      hashUint(Math.round(value * 100_000));
    } else if (typeof value === "string") {
      hashUint(4);
      hashString(value);
    } else if (Array.isArray(value)) {
      hashUint(5);
      hashUint(value.length);
      for (const item of value) visit(item);
    } else if (typeof value === "object") {
      hashUint(6);
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).filter((key) => key !== "checksum").sort();
      hashUint(keys.length);
      for (const key of keys) {
        hashString(key);
        visit(record[key]);
      }
    } else {
      hashUint(7);
    }
  };
  visit(view);
  return hash >>> 0;
}

export function visibleEntityIdsFromPlayerView(view: PlayerViewState): Set<EntityId> {
  return new Set([...view.ships, ...view.structures].map((entity) => entity.id));
}
