import type { SimulationState } from "./types";

function hashUint(hash: number, value: number): number {
  let result = hash;
  result ^= value >>> 0;
  return Math.imul(result, 16777619) >>> 0;
}

function quantize(value: number): number {
  return Math.round(value * 100_000);
}

function hashString(hash: number, value: string): number {
  let result = hash;
  for (let index = 0; index < value.length; index += 1) result = hashUint(result, value.charCodeAt(index));
  return result;
}

export function calculateChecksum(state: SimulationState): number {
  let hash = 2166136261;
  hash = hashUint(hash, state.version);
  hash = hashUint(hash, state.seed);
  hash = hashUint(hash, state.tick);
  hash = hashUint(hash, state.nextEntityId);
  hash = hashUint(hash, state.nextTurretId);
  hash = hashUint(hash, state.nextQueueItemId);
  hash = hashUint(hash, state.status === "playing" ? 1 : 2);
  hash = hashUint(hash, state.winnerTeamId ?? 0);
  for (const player of state.players) {
    hash = hashString(hash, player.id);
    hash = hashUint(hash, player.teamId);
    hash = hashString(hash, player.state);
    hash = hashUint(hash, player.lastCommandSequence);
    hash = hashUint(hash, quantize(player.economy.alloy));
    hash = hashUint(hash, quantize(player.economy.energy));
    hash = hashUint(hash, quantize(player.economy.alloyIncome));
    hash = hashUint(hash, quantize(player.economy.energyIncome));
    hash = hashUint(hash, quantize(player.economy.alloySpend));
    hash = hashUint(hash, quantize(player.economy.energySpend));
    hash = hashUint(hash, quantize(player.economy.alloyStorage));
    hash = hashUint(hash, quantize(player.economy.energyStorage));
    hash = hashUint(hash, quantize(player.economy.efficiency));
  }
  for (const team of state.teams) {
    hash = hashUint(hash, team.id);
    hash = hashUint(hash, team.alliedTeamIds.length);
    for (const alliedTeamId of team.alliedTeamIds) hash = hashUint(hash, alliedTeamId);
  }
  for (const ship of state.ships) {
    hash = hashUint(hash, ship.id);
    hash = hashString(hash, ship.ownerPlayerId);
    hash = hashUint(hash, ship.teamId);
    hash = hashString(hash, ship.class);
    hash = hashUint(hash, quantize(ship.x));
    hash = hashUint(hash, quantize(ship.z));
    hash = hashUint(hash, quantize(ship.y));
    hash = hashUint(hash, quantize(ship.yaw));
    hash = hashUint(hash, quantize(ship.vx));
    hash = hashUint(hash, quantize(ship.vz));
    hash = hashUint(hash, quantize(ship.health));
    hash = hashUint(hash, quantize(ship.shields));
    hash = hashUint(hash, ship.focusTargetEntityId ?? 0);
    for (const order of ship.orders) {
      hash = hashUint(hash, order.type === "move" ? 1 : order.type === "attackMove" ? 2 : order.type === "hold" ? 3 : 4);
      hash = hashUint(hash, quantize(order.destination.x));
      hash = hashUint(hash, quantize(order.destination.z));
      hash = hashUint(hash, quantize(order.facing));
      if (order.type === "patrol" && order.patrolOrigin) {
        hash = hashUint(hash, 1);
        hash = hashUint(hash, quantize(order.patrolOrigin.x));
        hash = hashUint(hash, quantize(order.patrolOrigin.z));
      }
    }
    for (const turret of ship.turrets) {
      hash = hashUint(hash, turret.id);
      hash = hashUint(hash, quantize(turret.currentYaw));
      hash = hashUint(hash, turret.targetEntityId ?? 0);
      hash = hashUint(hash, turret.cooldownRemaining);
      hash = hashUint(hash, turret.fireSequence);
    }
  }
  for (const projectile of state.projectiles) {
    hash = hashUint(hash, projectile.id);
    hash = hashUint(hash, projectile.ownerShipId);
    hash = hashUint(hash, projectile.ownerTeamId);
    hash = hashString(hash, projectile.weaponTypeId);
    hash = hashUint(hash, projectile.targetEntityId);
    hash = hashUint(hash, quantize(projectile.x));
    hash = hashUint(hash, quantize(projectile.z));
    hash = hashUint(hash, quantize(projectile.previousX));
    hash = hashUint(hash, quantize(projectile.previousZ));
    hash = hashUint(hash, quantize(projectile.vx));
    hash = hashUint(hash, quantize(projectile.vz));
    hash = hashUint(hash, quantize(projectile.radius));
    hash = hashUint(hash, quantize(projectile.damage));
    hash = hashUint(hash, projectile.lifetimeTicks);
  }
  for (const structure of state.structures) {
    hash = hashUint(hash, structure.id);
    hash = hashString(hash, structure.ownerPlayerId);
    hash = hashUint(hash, structure.teamId);
    hash = hashString(hash, structure.type);
    hash = hashUint(hash, quantize(structure.x));
    hash = hashUint(hash, quantize(structure.z));
    hash = hashUint(hash, quantize(structure.yaw));
    hash = hashUint(hash, quantize(structure.health));
    hash = hashUint(hash, quantize(structure.shields));
    hash = hashUint(hash, quantize(structure.buildProgress));
    hash = hashUint(hash, structure.resourceNodeId ?? 0);
    if (structure.repeatProduction) hash = hashUint(hash, 1);
    hash = hashUint(hash, quantize(structure.rallyPoint.x));
    hash = hashUint(hash, quantize(structure.rallyPoint.z));
    for (const item of structure.productionQueue) {
      hash = hashUint(hash, item.id);
      hash = hashString(hash, item.shipClass);
      hash = hashUint(hash, quantize(item.progress));
    }
  }
  for (const node of state.resourceNodes) {
    hash = hashUint(hash, node.id);
    hash = hashString(hash, node.type);
    hash = hashUint(hash, quantize(node.x));
    hash = hashUint(hash, quantize(node.z));
    hash = hashUint(hash, quantize(node.richness));
    hash = hashUint(hash, node.claimedByStructureId ?? 0);
  }
  for (const obstacle of state.obstacles) {
    hash = hashUint(hash, obstacle.id);
    hash = hashString(hash, obstacle.type);
    hash = hashUint(hash, quantize(obstacle.x));
    hash = hashUint(hash, quantize(obstacle.z));
    hash = hashUint(hash, quantize(obstacle.radius));
    hash = hashUint(hash, obstacle.visualSeed);
  }
  for (const visibility of state.visibility) {
    hash = hashUint(hash, visibility.teamId);
    hash = hashUint(hash, visibility.visibleEntityIds.length);
    for (const entityId of visibility.visibleEntityIds) hash = hashUint(hash, entityId);
    hash = hashUint(hash, visibility.visibleProjectileIds.length);
    for (const projectileId of visibility.visibleProjectileIds) hash = hashUint(hash, projectileId);
    hash = hashUint(hash, visibility.discoveredResourceNodeIds.length);
    for (const resourceNodeId of visibility.discoveredResourceNodeIds) hash = hashUint(hash, resourceNodeId);
  }
  for (const command of state.commandQueue) {
    hash = hashString(hash, command.playerId);
    hash = hashUint(hash, command.sequence);
    hash = hashUint(hash, command.requestedTick);
    hash = hashString(hash, command.type);
    if ("queued" in command) hash = hashUint(hash, command.queued ? 1 : 0);
    if ("unitIds" in command) {
      for (const unitId of command.unitIds) hash = hashUint(hash, unitId);
      if (command.type === "move" || command.type === "attackMove" || command.type === "patrol") {
        hash = hashUint(hash, quantize(command.destination.x));
        hash = hashUint(hash, quantize(command.destination.z));
        if (command.formationEnd) {
          hash = hashUint(hash, 1);
          hash = hashUint(hash, quantize(command.formationEnd.x));
          hash = hashUint(hash, quantize(command.formationEnd.z));
        } else {
          hash = hashUint(hash, 0);
        }
      } else if (command.type === "focusFire") {
        hash = hashUint(hash, command.targetEntityId);
      }
    } else if (command.type === "buildStructure") {
      hash = hashString(hash, command.structureType);
      hash = hashUint(hash, quantize(command.position.x));
      hash = hashUint(hash, quantize(command.position.z));
      hash = hashUint(hash, command.resourceNodeId ?? 0);
      const builderUnitIds = [...(command.builderUnitIds ?? [])].sort((a, b) => a - b);
      hash = hashUint(hash, builderUnitIds.length);
      for (const builderUnitId of builderUnitIds) hash = hashUint(hash, builderUnitId);
    } else {
      hash = hashUint(hash, command.structureId);
      if (command.type === "queueUnit") {
        hash = hashString(hash, command.shipClass);
        hash = hashUint(hash, command.count);
      } else if (command.type === "cancelProduction") {
        hash = hashUint(hash, command.queueItemId);
      } else if (command.type === "setProductionRepeat") {
        hash = hashUint(hash, command.enabled ? 1 : 0);
      } else if (command.type === "setRallyPoint") {
        hash = hashUint(hash, quantize(command.position.x));
        hash = hashUint(hash, quantize(command.position.z));
      }
    }
  }
  for (const playerId of state.aiPlayerIds) {
    hash = hashString(hash, playerId);
    const commander = state.aiCommanders?.[playerId];
    hash = hashString(hash, commander?.difficulty ?? "normal");
    hash = hashString(hash, commander?.personality ?? "balanced");
  }
  return hash >>> 0;
}
