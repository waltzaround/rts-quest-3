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
    hash = hashString(hash, player.faction);
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
    hash = hashUint(hash, player.stats.unitsProduced);
    hash = hashUint(hash, player.stats.structuresBuilt);
    hash = hashUint(hash, player.stats.enemyShipsDestroyed);
    hash = hashUint(hash, player.stats.enemyStructuresDestroyed);
    hash = hashUint(hash, player.stats.shipsLost);
    hash = hashUint(hash, player.stats.structuresLost);
    hash = hashUint(hash, quantize(player.stats.alloyCollected));
    hash = hashUint(hash, quantize(player.stats.energyGenerated));
    hash = hashUint(hash, quantize(player.stats.alloySpent));
    hash = hashUint(hash, quantize(player.stats.energySpent));
    hash = hashUint(hash, quantize(player.stats.damageDealt));
    hash = hashUint(hash, quantize(player.stats.damageTaken));
  }
  for (const team of state.teams) {
    hash = hashUint(hash, team.id);
    hash = hashUint(hash, team.alliedTeamIds.length);
    for (const alliedTeamId of team.alliedTeamIds) hash = hashUint(hash, alliedTeamId);
  }
  for (const ship of state.ships) {
    hash = hashUint(hash, ship.id);
    hash = hashString(hash, ship.faction ?? "industrial");
    hash = hashUint(hash, ship.broodNestId ?? 0);
    hash = hashUint(hash, ship.lastDamageTick ?? 0);
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
    hash = hashUint(hash, ship.lastCombatTick);
    hash = hashUint(hash, ship.artilleryDeploymentTicks ?? 0);
    hash = hashUint(hash, ship.revealedUntilTick ?? 0);
    for (const order of ship.orders) {
      hash = hashUint(hash, order.type === "move" ? 1 : order.type === "attackMove" ? 2 : order.type === "hold" ? 3 : 4);
      hash = hashUint(hash, quantize(order.destination.x));
      hash = hashUint(hash, quantize(order.destination.z));
      hash = hashUint(hash, quantize(order.facing));
      hash = hashUint(hash, order.constructionId ?? 0);
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
      hash = hashUint(hash, turret.idleRetargetTick ?? 0);
    }
  }
  for (const projectile of state.projectiles) {
    hash = hashUint(hash, projectile.id);
    hash = hashUint(hash, projectile.ownerShipId);
    hash = hashString(hash, projectile.ownerPlayerId ?? "");
    hash = hashUint(hash, projectile.ownerTeamId);
    hash = hashString(hash, projectile.weaponTypeId);
    hash = hashUint(hash, projectile.targetEntityId);
    hash = hashUint(hash, quantize(projectile.targetX));
    hash = hashUint(hash, quantize(projectile.targetZ));
    hash = hashUint(hash, projectile.fixedTrajectory ? 1 : 0);
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
    hash = hashString(hash, structure.broodClass ?? "");
    hash = hashUint(hash, quantize(structure.broodProgress ?? 0));
    hash = hashUint(hash, structure.warpPoint ? 1 : 0);
    hash = hashUint(hash, quantize(structure.warpPoint?.x ?? 0));
    hash = hashUint(hash, quantize(structure.warpPoint?.z ?? 0));
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
    hash = hashUint(hash, structure.constructionSequence ?? 0);
    hash = hashUint(hash, structure.revealedUntilTick ?? 0);
    hash = hashString(hash, structure.upgradeSourceType ?? "");
    hash = hashUint(hash, quantize(structure.upgradeSourceHealth ?? 0));
    hash = hashUint(hash, quantize(structure.upgradeSourceShields ?? 0));
    hash = hashUint(hash, quantize(structure.upgradeSourceYaw ?? 0));
    hash = hashUint(hash, quantize(structure.upgradeSourceRallyPoint?.x ?? 0));
    hash = hashUint(hash, quantize(structure.upgradeSourceRallyPoint?.z ?? 0));
    if (structure.repeatProduction) hash = hashUint(hash, 1);
    hash = hashUint(hash, quantize(structure.rallyPoint.x));
    hash = hashUint(hash, quantize(structure.rallyPoint.z));
    for (const item of structure.productionQueue) {
      hash = hashUint(hash, item.id);
      hash = hashString(hash, item.shipClass);
      hash = hashUint(hash, quantize(item.progress));
    }
  }
  for (const field of state.territories) {
    hash = hashUint(hash, field.id);
    hash = hashString(hash, field.ownerPlayerId);
    hash = hashUint(hash, field.teamId);
    hash = hashString(hash, field.kind);
    hash = hashUint(hash, quantize(field.x));
    hash = hashUint(hash, quantize(field.z));
    hash = hashUint(hash, quantize(field.radius));
    hash = hashUint(hash, quantize(field.maxRadius));
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
    hash = hashUint(hash, quantize(obstacle.width ?? 0));
    hash = hashUint(hash, quantize(obstacle.depth ?? 0));
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
    } else if (command.type === "cancelBuildOrder") {
      hash = hashUint(hash, command.buildSequence);
    } else {
      hash = hashUint(hash, command.structureId);
      if (command.type === "queueUnit") {
        hash = hashString(hash, command.shipClass);
        hash = hashUint(hash, command.count);
      } else if (command.type === "cancelProduction") {
        hash = hashUint(hash, command.queueItemId);
      } else if (command.type === "setProductionRepeat") {
        hash = hashUint(hash, command.enabled ? 1 : 0);
      } else if (command.type === "setRallyPoint" || command.type === "setWarpPoint") {
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
    const plan = state.aiPlans?.[playerId];
    hash = hashUint(hash, plan ? 1 : 0);
    if (plan) {
      hash = hashUint(hash, plan.searchIndex);
      hash = hashUint(hash, plan.knownStructures.length);
      for (const contact of plan.knownStructures) {
        hash = hashUint(hash, contact.id);
        hash = hashString(hash, contact.type);
        hash = hashUint(hash, quantize(contact.x));
        hash = hashUint(hash, quantize(contact.z));
      }
      hash = hashUint(hash, plan.recoveringShipIds.length);
      for (const id of plan.recoveringShipIds) hash = hashUint(hash, id);
      hash = hashUint(hash, plan.constructionWatch ? 1 : 0);
      if (plan.constructionWatch) {
        hash = hashString(hash, plan.constructionWatch.key);
        hash = hashUint(hash, quantize(plan.constructionWatch.progress));
        hash = hashUint(hash, plan.constructionWatch.lastProgressTick);
      }
      hash = hashUint(hash, plan.blockedSites?.length ?? 0);
      for (const site of plan.blockedSites ?? []) {
        hash = hashUint(hash, quantize(site.x));
        hash = hashUint(hash, quantize(site.z));
        hash = hashUint(hash, site.untilTick);
      }
    }
  }
  return hash >>> 0;
}
