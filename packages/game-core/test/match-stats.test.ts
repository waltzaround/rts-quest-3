import { describe, expect, it } from "vitest";
import { calculateChecksum, createCombatScenario, projectOmniscientView, projectPlayerView, type ProjectileState } from "../src";

describe("authoritative match statistics", () => {
  it("records actual economy income and includes statistics in the deterministic checksum", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    const player = simulation.state.players.find((candidate) => candidate.id === "pilot-blue")!;
    const checksumBefore = calculateChecksum(simulation.state);

    simulation.step();

    expect(player.stats.alloyCollected).toBeGreaterThan(0);
    expect(player.stats.energyGenerated).toBeGreaterThan(0);
    expect(calculateChecksum(simulation.state)).not.toBe(checksumBefore);
  });

  it("attributes damage, kills, and losses after the firing ship is gone", () => {
    const simulation = createCombatScenario({ startingFleet: true, enemyCommander: false });
    simulation.state.obstacles = [];
    const attacker = simulation.state.ships.find((ship) => ship.teamId === 1)!;
    const target = simulation.state.ships.find((ship) => ship.teamId === 2)!;
    const attackerPlayer = simulation.state.players.find((player) => player.id === attacker.ownerPlayerId)!;
    const defenderPlayer = simulation.state.players.find((player) => player.id === target.ownerPlayerId)!;
    attacker.turrets = [];
    target.turrets = [];
    target.health = 20;
    target.shields = 0;
    target.x = 10;
    target.z = 0;
    target.orders = [{ type: "hold", destination: { x: target.x, z: target.z }, facing: 0 }];
    simulation.state.ships = [target];
    const projectile: ProjectileState = {
      id: simulation.state.nextEntityId++,
      ownerShipId: attacker.id,
      ownerPlayerId: attacker.ownerPlayerId,
      ownerTeamId: attacker.teamId,
      weaponTypeId: "plasma",
      targetEntityId: target.id,
      targetX: target.x,
      targetZ: target.z,
      fixedTrajectory: false,
      x: target.x,
      z: target.z,
      previousX: target.x,
      previousZ: target.z,
      vx: 0,
      vz: 0,
      radius: 3,
      damage: 100,
      lifetimeTicks: 2,
    };
    simulation.state.projectiles = [projectile];

    simulation.step();

    expect(attackerPlayer.stats.enemyShipsDestroyed).toBe(1);
    expect(attackerPlayer.stats.damageDealt).toBe(20);
    expect(defenderPlayer.stats.shipsLost).toBe(1);
    expect(defenderPlayer.stats.damageTaken).toBe(20);
  });

  it("reveals detached score totals only when the match has finished", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    const player = simulation.state.players[0]!;
    player.stats.unitsProduced = 7;
    expect(projectPlayerView(simulation.state, player.id)!.players.every((candidate) => candidate.stats === null)).toBe(true);
    expect(projectOmniscientView(simulation.state).players.every((candidate) => candidate.stats === null)).toBe(true);

    simulation.state.status = "finished";
    simulation.state.winnerTeamId = player.teamId;
    const view = projectPlayerView(simulation.state, player.id)!;
    expect(view.players.find((candidate) => candidate.id === player.id)!.stats?.unitsProduced).toBe(7);
    view.players.find((candidate) => candidate.id === player.id)!.stats!.unitsProduced = 99;
    expect(player.stats.unitsProduced).toBe(7);
  });
});
