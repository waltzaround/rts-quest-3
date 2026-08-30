import { describe, expect, it } from "vitest";
import {
  SHIPS,
  SHIP_ECONOMY,
  STRUCTURES,
  createCombatScenario,
  type ShipClass,
  type StructureState,
  type StructureType,
} from "../src";

function addCompletedStructure(
  simulation: ReturnType<typeof createCombatScenario>,
  type: StructureType,
): StructureState {
  const template = simulation.state.structures.find(
    (structure) => structure.ownerPlayerId === "pilot-blue" && structure.type === "shipyard",
  )!;
  const definition = STRUCTURES[type];
  const structure: StructureState = {
    ...template,
    id: simulation.state.nextEntityId++,
    type,
    x: template.x + simulation.state.nextEntityId * 7,
    health: definition.maxHealth,
    shields: definition.maxShield,
    buildProgress: 1,
    productionQueue: [],
  };
  simulation.state.structures.push(structure);
  return structure;
}

describe("horizontal infrastructure progression", () => {
  it("preserves player-selected construction rotation", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    const core = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-blue" && structure.type === "commandCore",
    )!;
    const position = Array.from({ length: 16 }, (_, index) => ({
      x: core.x + Math.sin(index * Math.PI / 8) * 180,
      z: core.z + Math.cos(index * Math.PI / 8) * 180,
    })).find((candidate) => simulation.canPlaceStructure("pilot-blue", "fabricator", candidate))!;
    const yaw = 1.234;
    expect(simulation.submitCommand({
      type: "buildStructure", playerId: "pilot-blue", sequence: 1, requestedTick: 1,
      structureType: "fabricator", position, yaw, builderUnitIds: [], queued: false,
    }).accepted).toBe(true);
    simulation.step();
    const fabricator = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-blue" && structure.type === "fabricator",
    );
    expect(fabricator?.yaw).toBeCloseTo(yaw);
  });

  it("starts normal matches with economy and production infrastructure but no free army", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    expect(simulation.state.ships).toHaveLength(0);
    expect(simulation.state.structures.filter((structure) => structure.type === "commandCore")).toHaveLength(2);
    expect(simulation.state.structures.filter((structure) => structure.type === "shipyard")).toHaveLength(2);
    expect(simulation.getAvailableShipClasses("pilot-blue")).toEqual(["fighter", "fabricator", "frigate", "bomber"]);
    expect(simulation.getAvailableStructureTypes("pilot-blue")).not.toContain("advancedFabrication");
    expect(simulation.getAvailableStructureTypes("pilot-blue")).not.toContain("fusionReactor");
    expect(simulation.getAvailableStructureTypes("pilot-blue")).not.toContain("capitalInfrastructure");
    expect(simulation.getAvailableStructureTypes("pilot-blue")).toContain("radarArray");
    expect(STRUCTURES.radarArray.sensorRange).toBeGreaterThan(STRUCTURES.commandCore.sensorRange);
  });

  it("provides upkeep-free radar tiers with progressively wider coverage", () => {
    expect(STRUCTURES.radarArray.energyUpkeep).toBe(0);
    expect(STRUCTURES.phasedRadarArray.energyUpkeep).toBe(0);
    expect(STRUCTURES.deepSpaceRadarArray.energyUpkeep).toBe(0);
    expect(STRUCTURES.phasedRadarArray.sensorRange).toBeGreaterThan(STRUCTURES.radarArray.sensorRange);
    expect(STRUCTURES.deepSpaceRadarArray.sensorRange).toBeGreaterThan(STRUCTURES.phasedRadarArray.sensorRange);
    expect(STRUCTURES.phasedRadarArray.requiredStructures).toContain("radarArray");
    expect(STRUCTURES.deepSpaceRadarArray.requiredStructures).toContain("phasedRadarArray");
  });

  it("binds each role to a physical yard while preserving light-unit production", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    const lightYard = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-blue" && structure.type === "shipyard",
    )!;
    const fleetYard = addCompletedStructure(simulation, "fleetShipyard");
    const capitalYard = addCompletedStructure(simulation, "capitalShipyard");

    expect(simulation.canStructureProduceShipClass("pilot-blue", lightYard.id, "fighter")).toBe(true);
    expect(simulation.canStructureProduceShipClass("pilot-blue", lightYard.id, "fabricator")).toBe(true);
    expect(simulation.canStructureProduceShipClass("pilot-blue", lightYard.id, "frigate")).toBe(true);
    expect(simulation.canStructureProduceShipClass("pilot-blue", lightYard.id, "bomber")).toBe(true);
    expect(simulation.canStructureProduceShipClass("pilot-blue", lightYard.id, "destroyer")).toBe(false);
    expect(simulation.canStructureProduceShipClass("pilot-blue", fleetYard.id, "flakFrigate")).toBe(true);
    expect(simulation.canStructureProduceShipClass("pilot-blue", fleetYard.id, "cruiser")).toBe(true);
    expect(simulation.canStructureProduceShipClass("pilot-blue", fleetYard.id, "fighter")).toBe(false);
    expect(simulation.canStructureProduceShipClass("pilot-blue", capitalYard.id, "carrier")).toBe(true);
    expect(simulation.canStructureProduceShipClass("pilot-blue", capitalYard.id, "battleship")).toBe(true);
    expect(simulation.canStructureProduceShipClass("pilot-blue", capitalYard.id, "frigate")).toBe(false);

    simulation.state.players[0]!.economy.alloy = 6_000;
    simulation.state.players[0]!.economy.energy = 6_000;
    expect(simulation.submitCommand({
      type: "queueUnit", playerId: "pilot-blue", sequence: 1, requestedTick: 1,
      structureId: capitalYard.id, shipClass: "carrier", count: 1,
    }).accepted).toBe(true);
    simulation.stepMany(10);
    const progressBeforeInfrastructureLoss = capitalYard.productionQueue[0]!.progress;
    expect(progressBeforeInfrastructureLoss).toBeGreaterThan(0);
    simulation.state.structures = simulation.state.structures.filter(
      (structure) => structure.id !== fleetYard.id,
    );
    simulation.stepMany(10);
    expect(capitalYard.productionQueue[0]!.progress).toBeGreaterThan(progressBeforeInfrastructureLoss);
    expect(simulation.canProduceShipClass("pilot-blue", "carrier")).toBe(true);
    expect(simulation.canProduceShipClass("pilot-blue", "fighter")).toBe(true);
  });

  it("defines horizontal roles instead of stat-replacement tiers", () => {
    const expectedYards: Readonly<Record<ShipClass, StructureType>> = {
      fighter: "shipyard",
      fabricator: "shipyard",
      frigate: "shipyard",
      bomber: "shipyard",
      flakFrigate: "fleetShipyard",
      torpedoFrigate: "fleetShipyard",
      destroyer: "fleetShipyard",
      cruiser: "fleetShipyard",
      carrier: "capitalShipyard",
      battleship: "capitalShipyard",
    };
    for (const [shipClass, yardType] of Object.entries(expectedYards) as [ShipClass, StructureType][]) {
      expect(SHIP_ECONOMY[shipClass].yardType).toBe(yardType);
    }
    expect(SHIP_ECONOMY.fighter.batchSize).toBe(5);
    expect(SHIP_ECONOMY.frigate.batchSize).toBe(1);
    expect(STRUCTURES.fleetShipyard.energyUpkeep).toBeGreaterThan(STRUCTURES.shipyard.energyUpkeep);
    expect(STRUCTURES.capitalShipyard.energyUpkeep).toBeGreaterThan(STRUCTURES.fleetShipyard.energyUpkeep);
  });

  it("unlocks stronger economy through completed shipyard scale", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    expect(simulation.getAvailableStructureTypes("pilot-blue")).not.toContain("fusionReactor");
    expect(simulation.getAvailableStructureTypes("pilot-blue")).not.toContain("deepCoreExtractor");
    expect(simulation.getAvailableStructureTypes("pilot-blue")).not.toContain("alloyRefinery");
    expect(simulation.getAvailableStructureTypes("pilot-blue")).not.toContain("antimatterReactor");

    addCompletedStructure(simulation, "fleetShipyard");
    expect(simulation.getAvailableStructureTypes("pilot-blue")).toContain("fusionReactor");
    expect(simulation.getAvailableStructureTypes("pilot-blue")).toContain("deepCoreExtractor");
    expect(simulation.getAvailableStructureTypes("pilot-blue")).not.toContain("alloyRefinery");
    expect(simulation.getAvailableStructureTypes("pilot-blue")).not.toContain("antimatterReactor");

    addCompletedStructure(simulation, "fusionReactor");
    expect(simulation.getAvailableStructureTypes("pilot-blue")).toContain("alloyRefinery");
    expect(simulation.getAvailableStructureTypes("pilot-blue")).not.toContain("matterForge");

    addCompletedStructure(simulation, "capitalShipyard");
    addCompletedStructure(simulation, "antimatterReactor");
    expect(simulation.getAvailableStructureTypes("pilot-blue")).toEqual(expect.arrayContaining([
      "antimatterReactor", "singularityHarvester", "matterForge", "quantumStorage",
    ]));
    expect(STRUCTURES.fusionReactor.energyIncome).toBeGreaterThan(STRUCTURES.solarArray.energyIncome);
    expect(STRUCTURES.deepCoreExtractor.alloyIncome).toBeGreaterThan(STRUCTURES.extractor.alloyIncome);
    expect(STRUCTURES.antimatterReactor.energyIncome).toBeGreaterThan(STRUCTURES.fusionReactor.energyIncome);
    expect(STRUCTURES.singularityHarvester.alloyIncome).toBeGreaterThan(STRUCTURES.deepCoreExtractor.alloyIncome);
    expect(STRUCTURES.alloyRefinery.alloyIncome).toBeLessThan(STRUCTURES.deepCoreExtractor.alloyIncome);
    expect(STRUCTURES.matterForge.alloyIncome).toBeGreaterThan(STRUCTURES.alloyRefinery.alloyIncome);
    expect(STRUCTURES.quantumStorage.energyStorage).toBeGreaterThan(STRUCTURES.storage.energyStorage);
  });

  it("keeps advanced extractors tied to contested resource points", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    simulation.state.obstacles = [];
    addCompletedStructure(simulation, "fleetShipyard");
    addCompletedStructure(simulation, "capitalShipyard");
    const core = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-blue" && structure.type === "commandCore",
    )!;
    const node = {
      id: simulation.state.nextEntityId++, type: "alloy" as const,
      x: core.x + 240, z: core.z + 240, richness: 1.4, claimedByStructureId: null,
    };
    simulation.state.resourceNodes.push(node);
    const visibility = simulation.state.visibility.find((entry) => entry.teamId === core.teamId)!;
    visibility.discoveredResourceNodeIds.push(node.id);

    expect(simulation.canPlaceStructure("pilot-blue", "deepCoreExtractor", node)).toBe(false);
    expect(simulation.canPlaceStructure("pilot-blue", "deepCoreExtractor", node, node.id)).toBe(true);
    expect(simulation.canPlaceStructure("pilot-blue", "singularityHarvester", node, node.id)).toBe(true);
  });

  it("upgrades owned extractors in place without losing the resource claim", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    simulation.state.obstacles = [];
    addCompletedStructure(simulation, "fleetShipyard");
    addCompletedStructure(simulation, "capitalShipyard");
    const basicExtractor = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-blue" && structure.type === "extractor",
    )!;
    const node = simulation.state.resourceNodes.find((candidate) => candidate.id === basicExtractor.resourceNodeId)!;
    const site = { x: basicExtractor.x, z: basicExtractor.z };

    expect(simulation.canPlaceStructure("pilot-blue", "deepCoreExtractor", site, node.id)).toBe(true);
    expect(simulation.submitCommand({
      type: "buildStructure", playerId: "pilot-blue", sequence: 1, requestedTick: 1,
      structureType: "deepCoreExtractor", position: site, resourceNodeId: node.id, queued: false,
    }).accepted).toBe(true);
    simulation.step();

    const deepExtractor = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-blue"
        && structure.type === "deepCoreExtractor" && structure.resourceNodeId === node.id,
    )!;
    expect(deepExtractor).toBeDefined();
    expect(simulation.state.structures.some((structure) => structure.id === basicExtractor.id)).toBe(false);
    expect(node.claimedByStructureId).toBe(deepExtractor.id);
    expect(simulation.canPlaceStructure("pilot-blue", "singularityHarvester", site, node.id)).toBe(false);

    deepExtractor.buildProgress = 1;
    deepExtractor.health = STRUCTURES.deepCoreExtractor.maxHealth;
    deepExtractor.shields = STRUCTURES.deepCoreExtractor.maxShield;
    expect(simulation.canPlaceStructure("pilot-blue", "singularityHarvester", site, node.id)).toBe(true);
    expect(simulation.submitCommand({
      type: "buildStructure", playerId: "pilot-blue", sequence: 2,
      requestedTick: simulation.state.tick + 1, structureType: "singularityHarvester",
      position: site, resourceNodeId: node.id, queued: false,
    }).accepted).toBe(true);
    simulation.step();

    const harvester = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-blue"
        && structure.type === "singularityHarvester" && structure.resourceNodeId === node.id,
    )!;
    expect(harvester).toBeDefined();
    expect(simulation.state.structures.some((structure) => structure.id === deepExtractor.id)).toBe(false);
    expect(node.claimedByStructureId).toBe(harvester.id);
  });

  it("queues a remote construction site until its mobile fabricator reaches build range", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    const player = simulation.state.players.find((candidate) => candidate.id === "pilot-blue")!;
    const lightYard = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === player.id && structure.type === "shipyard",
    )!;
    player.economy.alloy = 2_000;
    player.economy.energy = 2_000;
    expect(simulation.submitCommand({
      type: "queueUnit", playerId: player.id, sequence: 1, requestedTick: 1,
      structureId: lightYard.id, shipClass: "fabricator", count: 1,
    }).accepted).toBe(true);
    simulation.stepMany(232);
    const fabricator = simulation.state.ships.find(
      (ship) => ship.ownerPlayerId === player.id && ship.class === "fabricator",
    )!;
    expect(fabricator).toBeDefined();

    fabricator.x = 650;
    fabricator.z = -410;
    const remoteSite = { x: 1_050, z: -410 };
    const queuedSite = { x: 1_400, z: -410 };
    expect(simulation.canPlaceStructure(player.id, "solarArray", remoteSite)).toBe(false);
    expect(simulation.canPlaceStructure(player.id, "solarArray", remoteSite, undefined, [fabricator.id])).toBe(true);
    expect(simulation.submitCommand({
      type: "buildStructure", playerId: player.id, sequence: 2, requestedTick: simulation.state.tick + 1,
      structureType: "solarArray", position: remoteSite, builderUnitIds: [fabricator.id], queued: false,
    }).accepted).toBe(true);
    expect(simulation.submitCommand({
      type: "buildStructure", playerId: player.id, sequence: 3, requestedTick: simulation.state.tick + 1,
      structureType: "solarArray", position: queuedSite, builderUnitIds: [fabricator.id], queued: true,
    }).accepted).toBe(true);
    simulation.step();

    expect(simulation.state.structures.some(
      (structure) => structure.ownerPlayerId === player.id
        && structure.type === "solarArray" && structure.x === remoteSite.x,
    )).toBe(false);
    expect(fabricator.orders[0]).toMatchObject({ type: "move", destination: remoteSite });
    expect(fabricator.orders[1]).toMatchObject({ type: "move", destination: queuedSite });
    expect(simulation.state.commandQueue.some((command) =>
      command.type === "buildStructure" && command.position.x === remoteSite.x,
    )).toBe(true);

    let construction: StructureState | undefined;
    for (let tick = 0; tick < 220; tick += 1) {
      simulation.step();
      construction = simulation.state.structures.find(
        (structure) => structure.ownerPlayerId === player.id
          && structure.type === "solarArray" && structure.x === remoteSite.x,
      );
      if (construction
        && simulation.getConstructionAssistingFabricatorIds(construction.id).includes(fabricator.id)) break;
    }
    expect(construction).toBeDefined();
    expect(Math.hypot(fabricator.x - remoteSite.x, fabricator.z - remoteSite.z))
      .toBeLessThanOrEqual(SHIPS.fabricator.buildRange);
    expect(simulation.getConstructionAssistingFabricatorIds(construction!.id)).toContain(fabricator.id);
    expect(simulation.getConstructionBuildPower(construction!.id)).toBeCloseTo(2.35);
    expect(simulation.state.commandQueue.some((command) =>
      command.type === "buildStructure" && command.position.x === remoteSite.x,
    )).toBe(false);
    expect(simulation.state.structures.some((structure) =>
      structure.ownerPlayerId === player.id
        && structure.type === "solarArray" && structure.x === queuedSite.x,
    )).toBe(false);
    expect(simulation.state.commandQueue.some((command) =>
      command.type === "buildStructure" && command.position.x === queuedSite.x,
    )).toBe(true);

    simulation.stepMany(320);
    expect(simulation.state.structures.some((structure) =>
      structure.ownerPlayerId === player.id
        && structure.type === "solarArray" && structure.x === queuedSite.x,
    )).toBe(true);
    expect(simulation.state.commandQueue.some((command) =>
      command.type === "buildStructure" && command.position.x === queuedSite.x,
    )).toBe(false);
  });

  it("places direct alloy generators away from resource nodes", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    simulation.state.obstacles = [];
    addCompletedStructure(simulation, "fleetShipyard");
    addCompletedStructure(simulation, "fusionReactor");
    const core = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-blue" && structure.type === "commandCore",
    )!;
    const site = { x: core.x, z: core.z + 250 };
    expect(simulation.canPlaceStructure("pilot-blue", "alloyRefinery", site)).toBe(true);
    expect(simulation.canPlaceStructure("pilot-blue", "alloyRefinery", site, simulation.state.resourceNodes[0]!.id)).toBe(false);
  });

  it("uses authoritative resource-node coordinates for mobile extractor orders", () => {
    const simulation = createCombatScenario({ enemyCommander: false, startingFleet: true });
    const player = simulation.state.players.find((candidate) => candidate.id === "pilot-blue")!;
    const fabricator = simulation.state.ships.find((ship) => ship.ownerPlayerId === player.id)!;
    fabricator.class = "fabricator";
    const visibility = simulation.state.visibility.find((entry) => entry.teamId === player.teamId)!;
    const node = simulation.state.resourceNodes.find(
      (candidate) => candidate.claimedByStructureId === null
        && visibility.discoveredResourceNodeIds.includes(candidate.id),
    )!;
    expect(fabricator).toBeDefined();
    expect(node).toBeDefined();

    const interpolatedCursorPosition = { x: node.x + 30, z: node.z - 30 };
    expect(simulation.submitCommand({
      type: "buildStructure", playerId: player.id, sequence: 1, requestedTick: 1,
      structureType: "extractor", position: interpolatedCursorPosition,
      resourceNodeId: node.id, builderUnitIds: [fabricator.id], queued: false,
    }).accepted).toBe(true);
    simulation.step();

    expect(simulation.state.commandQueue.some((command) =>
      command.type === "buildStructure"
        && command.resourceNodeId === node.id
        && command.builderUnitIds?.includes(fabricator.id),
    ) || simulation.state.structures.some((structure) =>
      structure.type === "extractor" && structure.resourceNodeId === node.id,
    )).toBe(true);
  });

  it("awards a contested resource node to the first mobile builder to arrive", () => {
    const simulation = createCombatScenario({ startingFleet: true });
    simulation.state.obstacles = [];
    const blue = simulation.state.players.find((player) => player.id === "pilot-blue")!;
    const red = simulation.state.players.find((player) => player.id === "pilot-red")!;
    const blueBuilder = simulation.state.ships.find((ship) => ship.ownerPlayerId === blue.id)!;
    const redBuilder = simulation.state.ships.find((ship) => ship.ownerPlayerId === red.id)!;
    blueBuilder.class = "fabricator";
    redBuilder.class = "fabricator";
    blueBuilder.orders = [];
    redBuilder.orders = [];
    const node = simulation.state.resourceNodes.find((candidate) => candidate.claimedByStructureId === null)!;
    for (const visibility of simulation.state.visibility) {
      if (!visibility.discoveredResourceNodeIds.includes(node.id)) {
        visibility.discoveredResourceNodeIds.push(node.id);
      }
    }
    blueBuilder.x = node.x - 220;
    blueBuilder.z = node.z;
    redBuilder.x = node.x + 650;
    redBuilder.z = node.z;

    expect(simulation.submitCommand({
      type: "buildStructure", playerId: blue.id, sequence: 1, requestedTick: 1,
      structureType: "extractor", position: node, resourceNodeId: node.id,
      builderUnitIds: [blueBuilder.id], queued: false,
    }).accepted).toBe(true);
    expect(simulation.submitCommand({
      type: "buildStructure", playerId: red.id, sequence: 1, requestedTick: 1,
      structureType: "extractor", position: node, resourceNodeId: node.id,
      builderUnitIds: [redBuilder.id], queued: false,
    }).accepted).toBe(true);

    let extractor: StructureState | undefined;
    for (let tick = 0; tick < 400; tick += 1) {
      simulation.step();
      extractor = simulation.state.structures.find((structure) =>
        structure.resourceNodeId === node.id && structure.type === "extractor",
      );
      if (extractor) break;
    }

    expect(extractor?.ownerPlayerId).toBe(blue.id);
    expect(node.claimedByStructureId).toBe(extractor?.id);
    expect(simulation.state.commandQueue.some((command) =>
      command.type === "buildStructure" && command.resourceNodeId === node.id,
    )).toBe(false);
    expect(redBuilder.orders).toHaveLength(0);
  });
});
