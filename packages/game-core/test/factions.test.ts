import { describe, expect, it } from "vitest";
import {
  BROOD_CAPACITY, CREEP_DAMAGE_MULTIPLIER, CREEP_SPEED_MULTIPLIER, FACTIONS,
  PYLON_SHIELD_RESISTANCE, ReplayRecorder, SHIPS, STRUCTURES, WEAPONS,
  calculateChecksum, calculateProfiledDamage, createCombatScenario, getFactionShipDefinition,
  getFactionShipEconomy, isInTerritory, playReplay, restoreSimulation,
  updateTerritoryFields, type FactionId, type GameSimulation, type ShipClass, type ShipState, type StructureState, type StructureType,
} from "../src";

function fixture(faction: FactionId = "brood", opponent: FactionId = "industrial") {
  const simulation = createCombatScenario({ startingBase: "command-core", players: [
    { id: "a", name: "Alpha", teamId: 1, faction },
    { id: "b", name: "Beta", teamId: 2, faction: opponent },
  ] });
  simulation.state.obstacles = [];
  simulation.state.territories = [];
  simulation.state.structures.forEach((core, index) => { core.x = index * 5_000; core.z = 0; });
  updateTerritoryFields(simulation.state, false);
  return simulation;
}

function structure(simulation: GameSimulation, type: StructureType, x = 120, z = 0, owner = "a"): StructureState {
  const core = simulation.state.structures.find((entry) => entry.ownerPlayerId === owner)!;
  const definition = STRUCTURES[type];
  const result = {
    ...core, id: simulation.state.nextEntityId++, type, x, z,
    health: definition.maxHealth, shields: definition.maxShield, buildProgress: 1,
    productionQueue: [], repeatProduction: false, rallyPoint: { x: 450, z: 150 },
  };
  simulation.state.structures.push(result);
  return result;
}

function ship(simulation: GameSimulation, shipClass: ShipClass, x = 100, z = 100, owner = "a"): ShipState {
  const player = simulation.state.players.find((entry) => entry.id === owner)!;
  const definition = getFactionShipDefinition(shipClass, player.faction);
  const result: ShipState = {
    id: simulation.state.nextEntityId++, ownerPlayerId: owner, teamId: player.teamId,
    faction: player.faction, class: shipClass, x, z, y: 0, yaw: 0, vx: 0, vz: 0,
    health: definition.maxHealth, shields: definition.maxShield, orders: [], focusTargetEntityId: null,
    lastCombatTick: simulation.state.tick,
    turrets: definition.hardpoints.map((point) => ({ ...point, id: simulation.state.nextTurretId++,
      parentShipId: simulation.state.nextEntityId - 1, currentYaw: point.yawCenter,
      targetEntityId: null, cooldownRemaining: 0, fireSequence: 0 })),
  };
  simulation.state.ships.push(result);
  return result;
}

function queue(simulation: GameSimulation, structureId: number, shipClass: ShipClass) {
  const player = simulation.state.players[0]!;
  return simulation.submitCommand({ type: "queueUnit", playerId: "a", sequence: player.lastCommandSequence + 1,
    requestedTick: simulation.state.tick + 1, structureId, shipClass, count: 1 });
}

describe("faction production", () => {
  it("limits faction rosters and buildings", () => {
    const simulation = fixture();
    structure(simulation, "shipyard");
    expect(simulation.canBuildStructure("a", "creepNode")).toBe(true);
    expect(simulation.canBuildStructure("a", "pylon")).toBe(false);
    expect(simulation.canBuildStructure("b", "creepNode")).toBe(false);
    expect(simulation.canProduceShipClass("a", "artilleryFrigate")).toBe(false);
    expect(FACTIONS.brood.ships).toContain("bomber");
  });

  it("funds a second nest and income expansion at full speed from standard opening reserves", () => {
    const simulation = createCombatScenario({ startingResources: "standard", players: [
      { id: "a", name: "Brood", teamId: 1, faction: "brood" },
      { id: "b", name: "Opponent", teamId: 2 },
    ] });
    const core = simulation.state.structures.find((entry) => entry.ownerPlayerId === "a" && entry.type === "commandCore")!;
    const firstNest = simulation.state.structures.find((entry) => entry.ownerPlayerId === "a" && entry.type === "shipyard")!;
    expect(queue(simulation, firstNest.id, "fighter").accepted).toBe(true);
    for (const [index, type] of (["shipyard", "solarArray"] as const).entries()) {
      expect(simulation.submitCommand({
        type: "buildStructure", playerId: "a", sequence: index + 2, requestedTick: 1,
        structureType: type, position: { x: core.x + index * 130, z: core.z - 140 }, queued: false,
      }).accepted).toBe(true);
    }
    const economy = simulation.state.players.find((player) => player.id === "a")!.economy;
    let alloySpent = 0;
    let constructionEnergySpent = 0;
    for (let tick = 0; tick < 520; tick++) {
      const upkeep = simulation.state.structures.filter((entry) => entry.ownerPlayerId === "a" && entry.buildProgress === 1)
        .reduce((sum, entry) => sum + STRUCTURES[entry.type].energyUpkeep, 0);
      simulation.step();
      expect(economy.efficiency).toBe(1);
      alloySpent += economy.alloySpend / 20;
      constructionEnergySpent += (economy.energySpend - upkeep) / 20;
    }
    const secondNest = simulation.state.structures.find((entry) => entry.ownerPlayerId === "a"
      && entry.type === "shipyard" && entry.id !== firstNest.id)!;
    expect(secondNest.buildProgress).toBe(1);
    expect(alloySpent - STRUCTURES.solarArray.alloyCost).toBeCloseTo(720, 6);
    expect(constructionEnergySpent - STRUCTURES.solarArray.energyCost).toBeCloseTo(480, 6);
    expect(economy.alloy).toBeGreaterThan(300);
    expect(economy.energyIncome).toBe(56);
    expect(queue(simulation, secondNest.id, "fabricator").accepted).toBe(true);
    simulation.stepMany(getFactionShipEconomy("fabricator", "brood").buildTicks);
    expect(simulation.state.ships.filter((unit) => unit.ownerPlayerId === "a" && unit.class === "fabricator")).toHaveLength(1);
    expect(simulation.state.ships.filter((unit) => unit.broodNestId === firstNest.id)).toHaveLength(BROOD_CAPACITY.fighter);
    expect(economy.alloySpend).toBe(0);
  });

  it("hatches to capacity, idles without banking progress, and only replaces casualties", () => {
    const simulation = fixture();
    const nest = structure(simulation, "shipyard");
    expect(queue(simulation, nest.id, "fighter").accepted).toBe(true);
    const hatchTicks = getFactionShipEconomy("fighter", "brood").buildTicks;
    simulation.stepMany(hatchTicks * BROOD_CAPACITY.fighter + 2);
    expect(simulation.state.ships).toHaveLength(12);
    expect(nest.broodClass).toBe("fighter");
    expect(nest.productionQueue).toHaveLength(0);
    expect(simulation.state.players[0]!.economy.alloySpend).toBe(0);
    expect(queue(simulation, nest.id, "frigate").accepted).toBe(false);
    simulation.state.ships.forEach((unit) => { unit.x = 1_200; unit.orders = []; });
    simulation.stepMany(hatchTicks * 2);
    expect(simulation.state.ships).toHaveLength(12);
    expect(nest.broodProgress).toBe(0);
    simulation.state.ships.slice(0, 3).forEach((unit) => { unit.health = 0; });
    simulation.step();
    expect(simulation.state.ships).toHaveLength(9);
    simulation.stepMany(hatchTicks - 2);
    expect(simulation.state.ships).toHaveLength(9);
    simulation.stepMany(hatchTicks * 3);
    expect(simulation.state.ships).toHaveLength(12);
  });

  it("adopts orphan survivors into new nests before hatching and preserves ownership on restore", () => {
    const simulation = fixture();
    const nest = structure(simulation, "shipyard");
    queue(simulation, nest.id, "fighter");
    simulation.stepMany(getFactionShipEconomy("fighter", "brood").buildTicks * 3);
    const survivors = simulation.state.ships.map((unit) => unit.id);
    nest.health = 0;
    simulation.step();
    const replacement = structure(simulation, "shipyard");
    queue(simulation, replacement.id, "fighter");
    simulation.step();
    expect(simulation.state.ships.filter((unit) => survivors.includes(unit.id)).every((unit) => unit.broodNestId === replacement.id)).toBe(true);
    const restored = restoreSimulation(simulation.snapshot());
    simulation.stepMany(1_000);
    restored.stepMany(1_000);
    expect(simulation.state.ships).toHaveLength(12);
    expect(restored.snapshot()).toEqual(simulation.snapshot());
  });

  it("pauses an uncovered nest even with full reserves and resumes on creep", () => {
    const simulation = fixture();
    const nest = structure(simulation, "shipyard", 900, 0);
    queue(simulation, nest.id, "fighter");
    simulation.stepMany(100);
    expect(simulation.state.ships).toHaveLength(0);
    expect(nest.broodProgress).toBe(0);
    structure(simulation, "creepNode", 900, 60);
    simulation.state.players[0]!.economy.alloy = 0;
    simulation.stepMany(160);
    expect(simulation.state.ships.length).toBeGreaterThan(0);
  });

  it("warps immediately on completion to an independent destination and keeps rally orders", () => {
    const simulation = fixture("concord");
    const yard = structure(simulation, "shipyard");
    const pylon = structure(simulation, "pylon", 1_000, 0);
    updateTerritoryFields(simulation.state, false);
    const point = { x: pylon.x + 90, z: 0 };
    expect(simulation.submitCommand({ type: "setWarpPoint", playerId: "a", sequence: 1, requestedTick: 1,
      structureId: yard.id, position: point }).accepted).toBe(true);
    queue(simulation, yard.id, "frigate");
    const buildTicks = getFactionShipEconomy("frigate", "concord").buildTicks;
    simulation.stepMany(buildTicks - 1);
    expect(simulation.state.ships).toHaveLength(0);
    simulation.step();
    expect(simulation.state.ships).toHaveLength(1);
    const unit = simulation.state.ships[0]!;
    expect(Math.hypot(unit.x - point.x, unit.z - point.z)).toBeLessThan(5);
    expect(unit.orders[0]?.destination).toEqual(yard.rallyPoint);
    expect(unit.shields).toBe(getFactionShipDefinition("frigate", "concord").maxShield);
  });

  it("holds completed production without further spending when a pylon is destroyed, then retargets", () => {
    const simulation = fixture("concord");
    const yard = structure(simulation, "shipyard");
    const pylon = structure(simulation, "pylon", 1_000, 0);
    updateTerritoryFields(simulation.state, false);
    simulation.submitCommand({ type: "setWarpPoint", playerId: "a", sequence: 1, requestedTick: 1,
      structureId: yard.id, position: { x: 1_100, z: 0 } });
    queue(simulation, yard.id, "frigate");
    queue(simulation, yard.id, "fighter");
    simulation.step();
    pylon.health = 0;
    simulation.stepMany(400);
    expect(simulation.state.ships).toHaveLength(0);
    expect(yard.productionQueue.map((item) => item.progress)).toEqual([1, 0]);
    expect(simulation.state.players[0]!.economy.alloySpend).toBe(0);
    expect(simulation.state.players[0]!.economy.energySpend).toBeCloseTo(STRUCTURES.shipyard.energyUpkeep);
    expect(simulation.submitCommand({ type: "setWarpPoint", playerId: "a", sequence: 4,
      requestedTick: simulation.state.tick + 1, structureId: yard.id, position: { x: 230, z: 100 } }).accepted).toBe(true);
    simulation.step();
    expect(simulation.state.ships).toHaveLength(1);
    expect(yard.productionQueue).toHaveLength(1);
  });

  it("rejects foreign warp coverage and waits if the whole arrival field is blocked", () => {
    const simulation = fixture("concord", "concord");
    const yard = structure(simulation, "shipyard");
    expect(simulation.submitCommand({ type: "setWarpPoint", playerId: "a", sequence: 1, requestedTick: 1,
      structureId: yard.id, position: { x: 5_050, z: 0 } }).accepted).toBe(false);
    simulation.submitCommand({ type: "setWarpPoint", playerId: "a", sequence: 1, requestedTick: 1,
      structureId: yard.id, position: { x: 200, z: 100 } });
    queue(simulation, yard.id, "frigate");
    simulation.state.obstacles = [{ id: 1, type: "asteroid", x: 0, z: 0, radius: 800, visualSeed: 1 }];
    simulation.stepMany(400);
    expect(simulation.state.ships).toHaveLength(0);
    simulation.state.obstacles = [];
    simulation.step();
    expect(simulation.state.ships).toHaveLength(1);
  });
});

describe("territory combat and deterministic state", () => {
  it("uses pylon resistance on actual hits and removes it as soon as the source dies", () => {
    const simulation = fixture("concord");
    const pylon = structure(simulation, "pylon", 1_000, 0);
    const unit = ship(simulation, "frigate", 1_100, 0);
    const fire = () => {
      const before = unit.shields;
      simulation.state.projectiles.push({
        id: simulation.state.nextEntityId++, ownerShipId: simulation.state.structures[1]!.id,
        ownerTeamId: 2, weaponTypeId: "plasma", targetEntityId: unit.id,
        targetX: unit.x, targetZ: unit.z, fixedTrajectory: false,
        x: unit.x, z: unit.z - 20, previousX: unit.x, previousZ: unit.z - 20,
        vx: 0, vz: 400, radius: 1, damage: 10, lifetimeTicks: 5,
      });
      simulation.step();
      return before - unit.shields;
    };
    expect(fire()).toBeCloseTo(10 * WEAPONS.plasma.shieldMultiplier * PYLON_SHIELD_RESISTANCE);
    pylon.health = 0;
    expect(fire()).toBeCloseTo(10 * WEAPONS.plasma.shieldMultiplier);
    expect(simulation.state.territories.some((field) => field.id === pylon.id)).toBe(false);
  });

  it("lets both AI factions produce armies, build territory, and restore without divergence", () => {
    const simulation = createCombatScenario({ seed: 7384, startingResources: "high", players: [
      { id: "a", name: "Brood", teamId: 1, faction: "brood", ai: true },
      { id: "b", name: "Concord", teamId: 2, faction: "concord", ai: true },
    ] });
    simulation.stepMany(4_000);
    for (const id of ["a", "b"]) {
      expect(simulation.state.ships.filter((unit) => unit.ownerPlayerId === id).length).toBeGreaterThan(2);
    }
    expect(simulation.state.structures.some((building) => building.type === "creepNode")).toBe(true);
    expect(simulation.state.structures.some((building) => building.type === "pylon")).toBe(true);
    expect(simulation.state.structures.some((building) => building.broodClass === "fabricator")).toBe(true);
    const restored = restoreSimulation(simulation.snapshot());
    simulation.stepMany(100);
    restored.stepMany(100);
    expect(restored.snapshot()).toEqual(simulation.snapshot());
  });

  it("grows and recedes creep, instantly removes pylon fields, and prevents overlap stacking", () => {
    const simulation = fixture();
    const node = structure(simulation, "creepNode", 250, 0);
    updateTerritoryFields(simulation.state, false);
    const initial = simulation.state.territories.find((field) => field.id === node.id)!.radius;
    simulation.stepMany(100);
    expect(simulation.state.territories.find((field) => field.id === node.id)!.radius).toBeGreaterThan(initial);
    node.health = 0;
    simulation.stepMany(201);
    expect(simulation.state.territories.some((field) => field.id === node.id)).toBe(false);
    expect(isInTerritory(simulation.state.territories, "b", "creep", { x: 0, z: 0 })).toBe(false);
    expect(simulation.canPlaceStructure("a", "creepNode", { x: 800, z: 0 })).toBe(false);
  });

  it("applies creep speed to normal movement and damage to shots at firing time", () => {
    const simulation = fixture();
    const unit = ship(simulation, "frigate", 80, 80);
    unit.orders = [{ type: "move", destination: { x: 80, z: 700 }, facing: 0 }];
    simulation.stepMany(15);
    const speed = Math.hypot(unit.vx, unit.vz);
    expect(speed).toBeCloseTo(getFactionShipDefinition("frigate", "brood").speed * CREEP_SPEED_MULTIPLIER, 1);
    const target = ship(simulation, "frigate", unit.x, unit.z + 150, "b");
    target.health = 1_000_000;
    unit.orders = [{ type: "hold", destination: { x: unit.x, z: unit.z }, facing: 0 }];
    structure(simulation, "creepNode", unit.x + 40, unit.z);
    simulation.stepMany(20);
    const shot = simulation.state.projectiles.find((projectile) => projectile.ownerShipId === unit.id);
    expect(shot).toBeDefined();
    expect(shot!.damage).toBeCloseTo(WEAPONS[shot!.weaponTypeId].damage * CREEP_DAMAGE_MULTIPLIER);
  });

  it("reduces shield damage without discounting hull spillover and recharges only after the quiet window", () => {
    const full = calculateProfiledDamage("plasma", 100, 1_000, "plated", PYLON_SHIELD_RESISTANCE);
    expect(full.shieldDamage).toBeCloseTo(100 * WEAPONS.plasma.shieldMultiplier * 0.8);
    const broken = calculateProfiledDamage("plasma", 100, 0, "plated", PYLON_SHIELD_RESISTANCE);
    expect(broken).toEqual(calculateProfiledDamage("plasma", 100, 0, "plated"));
    const simulation = fixture("concord");
    const unit = ship(simulation, "frigate");
    unit.shields = 0;
    unit.lastDamageTick = 1;
    simulation.stepMany(100);
    expect(unit.shields).toBe(0);
    simulation.step();
    expect(unit.shields).toBeGreaterThan(0);
    unit.x = 1_000;
    const shields = unit.shields;
    simulation.stepMany(50);
    expect(unit.shields).toBe(shields);
  });

  it("does not expose hostile field sources, nest ownership, or warp plans through fog", () => {
    const simulation = fixture("brood", "concord");
    const nest = structure(simulation, "shipyard");
    queue(simulation, nest.id, "fighter");
    structure(simulation, "pylon", 5_100, 0, "b");
    simulation.stepMany(80);
    const view = simulation.playerView("b")!;
    expect(view.territories.every((field) => field.ownerPlayerId === "b")).toBe(true);
    const ownUnit = simulation.state.ships[0]!;
    ownUnit.x = 5_100;
    ownUnit.z = 50;
    simulation.stepMany(2);
    const hostile = simulation.playerView("b")!.ships.find((unit) => unit.id === ownUnit.id)!;
    expect(hostile).toBeDefined();
    expect(hostile.broodNestId).toBeUndefined();
  });

  it("checksums faction state and replays replenishment identically", () => {
    const simulation = fixture();
    const nest = structure(simulation, "shipyard");
    simulation.refreshChecksum();
    const recorder = new ReplayRecorder(simulation);
    const command = { type: "queueUnit" as const, playerId: "a", sequence: 1, requestedTick: 1,
      structureId: nest.id, shipClass: "fighter" as const, count: 1 };
    const result = simulation.submitCommand(command);
    recorder.recordAcceptedCommand(command, result);
    recorder.stepMany(400);
    const archive = recorder.finalize();
    const replay = playReplay(archive);
    expect(replay.ok).toBe(true);
    const before = calculateChecksum(simulation.state);
    nest.broodProgress = 0.123;
    expect(calculateChecksum(simulation.state)).not.toBe(before);
  });
});
