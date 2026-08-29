import { describe, expect, it } from "vitest";
import { calculateChecksum, createCombatScenario, STRUCTURES, type StructureState } from "../src";

describe("continuous economy and production", () => {
  it("derives continuous income and storage from completed structures", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    simulation.step();
    const economy = simulation.state.players.find((player) => player.id === "pilot-blue")!.economy;
    expect(economy.alloyIncome).toBe(14);
    expect(economy.energyIncome).toBe(34);
    expect(economy.alloyStorage).toBe(2_250);
    expect(economy.energyStorage).toBe(2_250);
  });

  it("places and continuously constructs an economic building", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    expect(simulation.submitCommand({
      type: "buildStructure", playerId: "pilot-blue", sequence: 1, requestedTick: 1,
      structureType: "solarArray", position: { x: -90, z: -205 }, queued: false,
    }).accepted).toBe(true);
    expect(simulation.submitCommand({
      type: "buildStructure", playerId: "pilot-blue", sequence: 2, requestedTick: 1,
      structureType: "storage", position: { x: -90, z: -205 }, queued: false,
    })).toEqual({ accepted: false, reason: "placement" });
    simulation.stepMany(STRUCTURES.solarArray.buildTicks + 1);
    const solar = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-blue" && structure.x === -90 && structure.z === -205,
    );
    expect(solar?.buildProgress).toBe(1);
    expect(simulation.state.players[0]!.economy.energyIncome).toBe(56);
    expect(simulation.state.players[0]!.economy.energy).toBeLessThan(1_200);
  });

  it("adds storage capacity after a Storage Array finishes", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    expect(simulation.submitCommand({
      type: "buildStructure", playerId: "pilot-blue", sequence: 1, requestedTick: 1,
      structureType: "storage", position: { x: -350, z: -410 }, queued: false,
    }).accepted).toBe(true);
    simulation.stepMany(131);
    const storage = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-blue" && structure.type === "storage",
    );
    expect(storage?.buildProgress).toBe(1);
    expect(simulation.state.players[0]!.economy.alloyStorage).toBe(3_450);
    expect(simulation.state.players[0]!.economy.energyStorage).toBe(3_450);
  });

  it("uses shipyard scale instead of abstract technology buildings", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    expect(simulation.state.ships).toHaveLength(0);
    expect(simulation.getAvailableStructureTypes("pilot-blue")).toContain("shipyard");
    expect(simulation.getAvailableStructureTypes("pilot-blue")).toContain("fleetShipyard");
    expect(simulation.getAvailableStructureTypes("pilot-blue")).not.toContain("capitalShipyard");
    expect(simulation.getAvailableStructureTypes("pilot-blue")).not.toContain("advancedFabrication");
    expect(simulation.getAvailableStructureTypes("pilot-blue")).not.toContain("fusionReactor");
    expect(simulation.getAvailableStructureTypes("pilot-blue")).not.toContain("capitalInfrastructure");
    expect(simulation.getAvailableShipClasses("pilot-blue")).toEqual(["fighter", "fabricator", "frigate", "bomber"]);
    const lightYard = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-blue" && structure.type === "shipyard",
    )!;
    expect(simulation.submitCommand({
      type: "queueUnit", playerId: "pilot-blue", sequence: 1, requestedTick: 1,
      structureId: lightYard.id, shipClass: "destroyer", count: 1,
    })).toEqual({ accepted: false, reason: "technology" });
    expect(simulation.submitCommand({
      type: "buildStructure", playerId: "pilot-blue", sequence: 1, requestedTick: 1,
      structureType: "advancedFabrication", position: { x: -170, z: -180 }, queued: false,
    })).toEqual({ accepted: false, reason: "technology" });
    expect(simulation.canStructureProduceShipClass("pilot-blue", lightYard.id, "bomber")).toBe(true);
  });

  it("uses only Command Cores and completed Fabricators as construction-range anchors", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    const forwardPosition = { x: -800, z: -410 };
    expect(simulation.canPlaceStructure("pilot-blue", "solarArray", forwardPosition)).toBe(false);
    simulation.submitCommand({
      type: "buildStructure", playerId: "pilot-blue", sequence: 1, requestedTick: 1,
      structureType: "fabricator", position: { x: -500, z: -410 }, queued: false,
    });
    simulation.stepMany(190);
    expect(simulation.canPlaceStructure("pilot-blue", "solarArray", forwardPosition)).toBe(true);
  });

  it("applies nearby Fabricator assistance deterministically at matching resource cost", () => {
    const createAssistedConstruction = () => {
      const simulation = createCombatScenario({ seed: 99, enemyCommander: false });
      simulation.submitCommand({
        type: "buildStructure", playerId: "pilot-blue", sequence: 1, requestedTick: 1,
        structureType: "fabricator", position: { x: -170, z: -250 }, queued: false,
      });
      simulation.stepMany(190);
      simulation.submitCommand({
        type: "buildStructure", playerId: "pilot-blue", sequence: 2, requestedTick: 191,
        structureType: "solarArray", position: { x: -100, z: -175 }, queued: false,
      });
      simulation.submitCommand({
        type: "buildStructure", playerId: "pilot-blue", sequence: 3, requestedTick: 191,
        structureType: "solarArray", position: { x: -500, z: -410 }, queued: false,
      });
      simulation.stepMany(50);
      return simulation;
    };

    const first = createAssistedConstruction();
    const second = createAssistedConstruction();
    const assisted = first.state.structures.find((structure) => structure.x === -100 && structure.z === -175)!;
    const unassisted = first.state.structures.find((structure) => structure.x === -500 && structure.z === -410)!;
    expect(first.getConstructionBuildPower(assisted.id)).toBe(2);
    expect(first.getConstructionBuildPower(unassisted.id)).toBe(1);
    expect(assisted.buildProgress).toBeCloseTo(100 / STRUCTURES.solarArray.buildTicks, 8);
    expect(unassisted.buildProgress).toBeCloseTo(50 / STRUCTURES.solarArray.buildTicks, 8);
    expect(first.snapshot()).toEqual(second.snapshot());
  });

  it("includes storage limits and structure ownership in authoritative checksums", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    const baseline = simulation.state.checksum;
    const storageChanged = simulation.snapshot();
    storageChanged.players[0]!.economy.alloyStorage += 1;
    expect(calculateChecksum(storageChanged)).not.toBe(baseline);
    const ownerChanged = simulation.snapshot();
    ownerChanged.structures[0]!.ownerPlayerId = ownerChanged.players[1]!.id;
    expect(calculateChecksum(ownerChanged)).not.toBe(baseline);
  });

  it("queues a ship, drains both resources, and spawns it at the rally point", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    const shipyard = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-blue" && structure.type === "shipyard",
    )!;
    const startingShipIds = new Set(simulation.state.ships.map((ship) => ship.id));
    expect(simulation.submitCommand({
      type: "queueUnit", playerId: "pilot-blue", sequence: 1, requestedTick: 1,
      structureId: shipyard.id, shipClass: "fighter", count: 1,
    }).accepted).toBe(true);
    simulation.stepMany(180);
    expect(shipyard.productionQueue).toHaveLength(0);
    expect(simulation.state.ships.some(
      (ship) => !startingShipIds.has(ship.id) && ship.ownerPlayerId === "pilot-blue" && ship.class === "fighter",
    )).toBe(true);
    expect(simulation.state.ships.filter(
      (ship) => !startingShipIds.has(ship.id) && ship.ownerPlayerId === "pilot-blue" && ship.class === "fighter",
    )).toHaveLength(5);
    expect(simulation.state.players[0]!.economy.alloy).toBeLessThan(900 + 90 * 0.05 * 14);
    expect(simulation.state.players[0]!.economy.energy).toBeLessThan(900 + 90 * 0.05 * 34);
  });

  it("produces bombers with a dedicated anti-capital torpedo loadout", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    const lightYard = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-blue" && structure.type === "shipyard",
    )!;
    simulation.state.players[0]!.economy.alloy = 3_000;
    simulation.state.players[0]!.economy.energy = 3_000;
    const startingShipIds = new Set(simulation.state.ships.map((ship) => ship.id));
    expect(simulation.submitCommand({
      type: "queueUnit", playerId: "pilot-blue", sequence: 1, requestedTick: 1,
      structureId: lightYard.id, shipClass: "bomber", count: 1,
    }).accepted).toBe(true);
    simulation.stepMany(440);
    const bomber = simulation.state.ships.find((ship) => !startingShipIds.has(ship.id));
    expect(bomber?.class).toBe("bomber");
    expect(bomber?.turrets).toHaveLength(2);
    expect(bomber?.turrets.every((turret) => turret.weaponTypeId === "torpedo")).toBe(true);
  });

  it("sets a shipyard rally point authoritatively and sends produced ships there", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    const shipyard = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-blue" && structure.type === "shipyard",
    )!;
    const rallyPoint = { x: 185, z: -115 };
    const startingShipIds = new Set(simulation.state.ships.map((ship) => ship.id));
    expect(simulation.submitCommand({
      type: "setRallyPoint", playerId: "pilot-blue", sequence: 1, requestedTick: 1,
      structureId: shipyard.id, position: rallyPoint,
    }).accepted).toBe(true);
    expect(simulation.submitCommand({
      type: "queueUnit", playerId: "pilot-blue", sequence: 2, requestedTick: 1,
      structureId: shipyard.id, shipClass: "fighter", count: 1,
    }).accepted).toBe(true);
    simulation.stepMany(180);
    expect(shipyard.rallyPoint).toEqual(rallyPoint);
    const produced = simulation.state.ships.find((ship) => !startingShipIds.has(ship.id))!;
    expect(Math.hypot(
      produced.orders[0]!.destination.x - rallyPoint.x,
      produced.orders[0]!.destination.z - rallyPoint.z,
    )).toBeLessThan(40);
  });

  it("keeps production at 1x per shipyard and scales through additional shipyards", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    const first = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-blue" && structure.type === "shipyard",
    )!;
    const second: StructureState = {
      ...first,
      id: simulation.state.nextEntityId++,
      x: first.x + 85,
      productionQueue: [],
      rallyPoint: { x: first.rallyPoint.x + 85, z: first.rallyPoint.z },
    };
    simulation.state.structures.push(second);
    const fabricator = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-blue" && structure.type === "solarArray",
    )!;
    fabricator.type = "fabricator";
    fabricator.x = first.x + 25;
    fabricator.z = first.z;
    const startingShipIds = new Set(simulation.state.ships.map((ship) => ship.id));
    expect(simulation.submitCommand({
      type: "queueUnit", playerId: "pilot-blue", sequence: 1, requestedTick: 1,
      structureId: first.id, shipClass: "fighter", count: 1,
    }).accepted).toBe(true);
    expect(simulation.submitCommand({
      type: "queueUnit", playerId: "pilot-blue", sequence: 2, requestedTick: 1,
      structureId: second.id, shipClass: "fighter", count: 1,
    }).accepted).toBe(true);
    simulation.stepMany(90);
    expect(first.productionQueue[0]?.progress).toBeCloseTo(0.5, 8);
    expect(second.productionQueue[0]?.progress).toBeCloseTo(0.5, 8);
    simulation.stepMany(90);
    expect(simulation.state.ships.filter(
      (ship) => !startingShipIds.has(ship.id) && ship.ownerPlayerId === "pilot-blue" && ship.class === "fighter",
    )).toHaveLength(10);
  });

  it("slows production proportionally when stored resources run out", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    const player = simulation.state.players[0]!;
    const shipyard = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === player.id && structure.type === "shipyard",
    )!;
    simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === player.id && structure.type === "extractor",
    )!.type = "storage";
    player.economy.alloy = 0;
    player.economy.energy = 0;
    simulation.submitCommand({
      type: "queueUnit", playerId: player.id, sequence: 1, requestedTick: 1,
      structureId: shipyard.id, shipClass: "fighter", count: 1,
    });
    simulation.stepMany(40);
    expect(player.economy.efficiency).toBeLessThan(0.5);
    expect(shipyard.productionQueue[0]!.progress).toBeLessThan(0.05);
  });

  it("cancels the active production item on an authoritative tick", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    const shipyard = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-blue" && structure.type === "shipyard",
    )!;
    simulation.submitCommand({
      type: "queueUnit", playerId: "pilot-blue", sequence: 1, requestedTick: 1,
      structureId: shipyard.id, shipClass: "frigate", count: 1,
    });
    simulation.step();
    const queueItemId = shipyard.productionQueue[0]!.id;
    expect(simulation.submitCommand({
      type: "cancelProduction", playerId: "pilot-blue", sequence: 2, requestedTick: 2,
      structureId: shipyard.id, queueItemId,
    }).accepted).toBe(true);
    simulation.step();
    expect(shipyard.productionQueue).toHaveLength(0);
  });

  it("cycles the full production queue while infinite production is enabled", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    const shipyard = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-blue" && structure.type === "shipyard",
    )!;
    const player = simulation.state.players.find((candidate) => candidate.id === "pilot-blue")!;
    player.economy.alloy = 2_000;
    player.economy.energy = 2_000;
    expect(simulation.submitCommand({
      type: "queueUnit", playerId: player.id, sequence: 1, requestedTick: 1,
      structureId: shipyard.id, shipClass: "fighter", count: 1,
    }).accepted).toBe(true);
    expect(simulation.submitCommand({
      type: "queueUnit", playerId: player.id, sequence: 2, requestedTick: 1,
      structureId: shipyard.id, shipClass: "frigate", count: 1,
    }).accepted).toBe(true);
    expect(simulation.submitCommand({
      type: "setProductionRepeat", playerId: player.id, sequence: 3, requestedTick: 1,
      structureId: shipyard.id, enabled: true,
    }).accepted).toBe(true);

    simulation.stepMany(180);
    expect(shipyard.repeatProduction).toBe(true);
    expect(shipyard.productionQueue.map((item) => item.shipClass)).toEqual(["frigate", "fighter"]);
    simulation.stepMany(190);
    expect(shipyard.productionQueue.map((item) => item.shipClass)).toEqual(["fighter", "frigate"]);
    expect(simulation.state.ships.filter((ship) => ship.ownerPlayerId === player.id)).toHaveLength(6);
  });

  it("stops every queued item and disables infinite production authoritatively", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    const shipyard = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-blue" && structure.type === "shipyard",
    )!;
    simulation.submitCommand({
      type: "queueUnit", playerId: "pilot-blue", sequence: 1, requestedTick: 1,
      structureId: shipyard.id, shipClass: "fighter", count: 3,
    });
    simulation.submitCommand({
      type: "setProductionRepeat", playerId: "pilot-blue", sequence: 2, requestedTick: 1,
      structureId: shipyard.id, enabled: true,
    });
    simulation.step();
    expect(shipyard.productionQueue).toHaveLength(3);
    expect(shipyard.repeatProduction).toBe(true);

    expect(simulation.submitCommand({
      type: "clearProductionQueue", playerId: "pilot-blue", sequence: 3, requestedTick: 2,
      structureId: shipyard.id,
    }).accepted).toBe(true);
    simulation.step();
    expect(shipyard.productionQueue).toHaveLength(0);
    expect(shipyard.repeatProduction).toBe(false);
  });

  it("runs the enemy commander deterministically and reinforces its fleet", () => {
    const first = createCombatScenario({ seed: 77 });
    const second = createCombatScenario({ seed: 77 });
    const startingTurrets = first.state.nextTurretId;
    const firstResult = first.stepMany(500);
    const secondResult = second.stepMany(500);
    expect(firstResult.checksum).toBe(secondResult.checksum);
    expect(first.snapshot()).toEqual(second.snapshot());
    expect(first.state.nextTurretId).toBeGreaterThan(startingTurrets);
    expect(first.state.structures.filter((structure) => structure.ownerPlayerId === "pilot-red" && structure.type === "extractor").length).toBeGreaterThan(1);
  });

  it("ends the match when a team's final Command Core is destroyed", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    const redCore = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-red" && structure.type === "commandCore",
    )!;
    redCore.health = 0;
    const result = simulation.stepMany(2);
    expect(simulation.state.status).toBe("finished");
    expect(simulation.state.winnerTeamId).toBe(1);
    expect(result.events).toContainEqual({ type: "victory", tick: 2, winnerTeamId: 1 });
  });
});
