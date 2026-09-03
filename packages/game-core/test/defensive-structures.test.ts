import { describe, expect, it } from "vitest";
import { DEFENSIVE_STRUCTURE_TYPES, SHIPS, STRUCTURES, createCombatScenario, type ShipClass } from "../src";

describe("defensive structures", () => {
  it("gives the Command Core four short-range anti-rush mounts", () => {
    expect(STRUCTURES.commandCore.hardpoints).toHaveLength(4);
    expect(STRUCTURES.commandCore.hardpoints?.every(
      (hardpoint) => hardpoint.weaponTypeId === "pointDefense",
    )).toBe(true);

    const simulation = createCombatScenario({ enemyCommander: false, startingFleet: true });
    simulation.state.obstacles = [];
    const core = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-blue" && structure.type === "commandCore",
    )!;
    const raider = simulation.state.ships.find(
      (ship) => ship.ownerPlayerId === "pilot-red" && ship.class === "fighter",
    )!;
    raider.x = core.x;
    raider.z = core.z + 120;
    raider.vx = 0;
    raider.vz = 0;
    raider.orders = [{ type: "hold", destination: { x: raider.x, z: raider.z }, facing: Math.PI }];
    simulation.state.ships = [raider];

    const firingMounts = new Set<number>();
    for (let tick = 0; tick < 30; tick += 1) {
      for (const event of simulation.step().events) {
        if (event.type === "weaponFired" && event.shipId === core.id) firingMounts.add(event.turretId);
      }
    }
    expect(firingMounts.size).toBe(4);
  });

  it("exposes distinct fleet-tech T2 and capital-tech T3 batteries", () => {
    expect(DEFENSIVE_STRUCTURE_TYPES).toContain("plasmaBattery");
    expect(DEFENSIVE_STRUCTURE_TYPES).toContain("beamBattery");
    expect(STRUCTURES.plasmaBattery).toMatchObject({
      weaponTypeId: "plasma",
      requiredStructures: ["commandCore", "fleetShipyard"],
    });
    expect(STRUCTURES.beamBattery).toMatchObject({
      weaponTypeId: "beam",
      requiredStructures: ["commandCore", "capitalShipyard"],
    });
    expect(STRUCTURES.beamBattery.maxHealth).toBeGreaterThan(STRUCTURES.plasmaBattery.maxHealth);
  });

  it("requires a mobile Fabricator to place defensive structures, including near a Command Core", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    simulation.state.obstacles = [];
    const player = simulation.state.players.find((candidate) => candidate.id === "pilot-blue")!;
    const yard = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === player.id && structure.type === "shipyard",
    )!;
    player.economy.alloy = player.economy.alloyStorage;
    player.economy.energy = player.economy.energyStorage;
    expect(simulation.submitCommand({
      type: "queueUnit", playerId: player.id, sequence: 1, requestedTick: 1,
      structureId: yard.id, shipClass: "fabricator", count: 1,
    }).accepted).toBe(true);
    simulation.stepMany(232);
    const fabricator = simulation.state.ships.find(
      (ship) => ship.ownerPlayerId === player.id && ship.class === "fabricator",
    )!;
    const core = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === player.id && structure.type === "commandCore",
    )!;
    const site = { x: core.x + 105, z: core.z + 25 };

    expect(simulation.canPlaceStructure(player.id, "pointDefenseBattery", site)).toBe(false);
    expect(simulation.canPlaceStructure(player.id, "pointDefenseBattery", site, undefined, [fabricator.id])).toBe(true);
    expect(simulation.submitCommand({
      type: "buildStructure", playerId: player.id, sequence: 2,
      requestedTick: simulation.state.tick + 1, structureType: "pointDefenseBattery",
      position: site, builderUnitIds: [fabricator.id], queued: false,
    }).accepted).toBe(true);
  });

  it("fires deterministic pooled projectiles from completed defensive batteries", () => {
    const simulation = createCombatScenario({ enemyCommander: false, startingFleet: true });
    simulation.state.obstacles = [];
    const defense = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-blue" && structure.type === "solarArray",
    )!;
    defense.type = "pointDefenseBattery";
    defense.x = 0;
    defense.z = 0;
    defense.health = STRUCTURES.pointDefenseBattery.maxHealth;
    defense.shields = STRUCTURES.pointDefenseBattery.maxShield;
    defense.buildProgress = 1;
    const target = simulation.state.ships.find((ship) => ship.ownerPlayerId === "pilot-red" && ship.class === "fighter")!;
    target.x = 0;
    target.z = 120;
    target.vx = 0;
    target.vz = 0;
    target.orders = [{ type: "hold", destination: { x: 0, z: 120 }, facing: Math.PI }];
    simulation.state.ships = [target];

    let firedProjectileId: number | null = null;
    for (let tick = 0; tick < 40 && firedProjectileId === null; tick += 1) {
      const snapshot = simulation.step();
      const event = snapshot.events.find(
        (candidate) => candidate.type === "weaponFired" && candidate.shipId === defense.id,
      );
      if (event?.type === "weaponFired") firedProjectileId = event.projectileId;
    }

    expect(firedProjectileId).not.toBeNull();
    expect(simulation.state.projectiles.find((projectile) => projectile.id === firedProjectileId)).toMatchObject({
      ownerShipId: defense.id,
      weaponTypeId: "pointDefense",
      targetEntityId: target.id,
      damage: 4,
    });
    expect(SHIPS.fabricator.buildPower).toBeGreaterThan(0);
  });

  it.each(["fighter", "bomber"] as const)("always detonates VLS missiles that miss a %s", (targetClass) => {
    const simulation = createCombatScenario({ enemyCommander: false, startingFleet: true });
    simulation.state.obstacles = [];
    const battery = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-blue" && structure.type === "solarArray",
    )!;
    battery.type = "missileBattery";
    battery.buildProgress = 0;
    const target = simulation.state.ships.find((ship) => ship.ownerPlayerId === "pilot-red")!;
    target.class = targetClass as ShipClass;
    target.x = 90;
    target.z = 90;
    target.turrets = [];
    simulation.state.ships = [target];
    const projectileId = simulation.state.nextEntityId++;
    simulation.state.projectiles = [{
      id: projectileId, ownerShipId: battery.id, ownerTeamId: battery.teamId,
      weaponTypeId: "torpedo", targetEntityId: target.id,
      targetX: target.x, targetZ: target.z, fixedTrajectory: false,
      x: 0, z: 0, previousX: 0, previousZ: 0,
      vx: 0, vz: 0, radius: 4.2, damage: 32, lifetimeTicks: 1,
    }];

    const events = simulation.step().events;

    expect(events).toContainEqual(expect.objectContaining({
      type: "projectileDetonated", projectileId, weaponTypeId: "torpedo", x: 0, z: 0,
    }));
  });

  it.each(["fighter", "bomber"] as const)("always detonates VLS missiles that hit a %s", (targetClass) => {
    const simulation = createCombatScenario({ enemyCommander: false, startingFleet: true });
    simulation.state.obstacles = [];
    const battery = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-blue" && structure.type === "solarArray",
    )!;
    battery.type = "missileBattery";
    battery.buildProgress = 0;
    const target = simulation.state.ships.find((ship) => ship.ownerPlayerId === "pilot-red")!;
    target.class = targetClass as ShipClass;
    target.x = 0;
    target.z = 30;
    target.vx = 0;
    target.vz = 0;
    target.health = SHIPS[targetClass].maxHealth;
    target.shields = SHIPS[targetClass].maxShield;
    target.orders = [{ type: "hold", destination: { x: target.x, z: target.z }, facing: Math.PI }];
    target.turrets = [];
    simulation.state.ships = [target];
    const projectileId = simulation.state.nextEntityId++;
    simulation.state.projectiles = [{
      id: projectileId, ownerShipId: battery.id, ownerTeamId: battery.teamId,
      weaponTypeId: "torpedo", targetEntityId: target.id,
      targetX: target.x, targetZ: target.z, fixedTrajectory: false,
      x: target.x, z: target.z, previousX: target.x, previousZ: target.z,
      vx: 0, vz: 0, radius: 4.2, damage: 32, lifetimeTicks: 40,
    }];

    const events = simulation.step().events;

    expect(events).toContainEqual(expect.objectContaining({ type: "hit", projectileId, targetId: target.id }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "projectileDetonated", projectileId, weaponTypeId: "torpedo",
    }));
  });

  it.each(["fighter", "bomber"] as const)("detonates VLS missiles when another shot destroys the %s target", (targetClass) => {
    const simulation = createCombatScenario({ enemyCommander: false, startingFleet: true });
    simulation.state.obstacles = [];
    const battery = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-blue" && structure.type === "solarArray",
    )!;
    battery.type = "missileBattery";
    battery.buildProgress = 0;
    const target = simulation.state.ships.find((ship) => ship.ownerPlayerId === "pilot-red")!;
    target.class = targetClass as ShipClass;
    target.health = 0;
    target.turrets = [];
    simulation.state.ships = [target];
    const projectileId = simulation.state.nextEntityId++;
    simulation.state.projectiles = [{
      id: projectileId, ownerShipId: battery.id, ownerTeamId: battery.teamId,
      weaponTypeId: "torpedo", targetEntityId: target.id,
      targetX: target.x, targetZ: target.z, fixedTrajectory: false,
      x: 18, z: 24, previousX: 18, previousZ: 24,
      vx: 0, vz: 0, radius: 4.2, damage: 32, lifetimeTicks: 40,
    }];

    const events = simulation.step().events;

    expect(events).toContainEqual(expect.objectContaining({
      type: "projectileDetonated", projectileId, weaponTypeId: "torpedo", x: 18, z: 24,
    }));
  });
});
