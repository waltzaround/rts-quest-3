import { describe, expect, it } from "vitest";
import {
  DEFENSIVE_STRUCTURE_TYPES,
  RESOURCE_EXTRACTOR_TYPES,
  SHIPYARD_TYPES,
  createCombatScenario,
  restoreSimulation,
  type ScenarioPlayerConfig,
} from "../src";

const players: readonly ScenarioPlayerConfig[] = [
  { id: "human", name: "Human", teamId: 1 },
  { id: "easy", name: "Easy Turtle", teamId: 2, ai: true, aiDifficulty: "easy", aiPersonality: "turtle" },
  { id: "hard", name: "Hard Raider", teamId: 3, ai: true, aiDifficulty: "hard", aiPersonality: "aggressive" },
];

describe("AI commander profiles", () => {
  it("stores difficulty and personality in deterministic state and restores them", () => {
    const simulation = createCombatScenario({ seed: 123, players });
    expect(simulation.state.aiCommanders).toEqual({
      easy: { difficulty: "easy", personality: "turtle" },
      hard: { difficulty: "hard", personality: "aggressive" },
    });
    expect(restoreSimulation(simulation.snapshot()).snapshot()).toEqual(simulation.snapshot());
  });

  it("lets harder commanders react and fill production queues sooner", () => {
    const simulation = createCombatScenario({ seed: 456, players });
    simulation.stepMany(40);
    const easyQueue = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "easy" && structure.type === "shipyard",
    )!.productionQueue;
    const hardQueue = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "hard" && structure.type === "shipyard",
    )!.productionQueue;
    expect(easyQueue).toHaveLength(0);
    expect(hardQueue.length).toBeGreaterThan(easyQueue.length);
  });

  it("scouts, discovers remote deposits, and sends mobile fabricators to expand", () => {
    const simulation = createCombatScenario({
      seed: 789,
      resourceDensity: "rich",
      players: [
        { id: "human", name: "Human", teamId: 1 },
        { id: "bot", name: "Expansion Bot", teamId: 2, ai: true, aiDifficulty: "hard", aiPersonality: "economic" },
      ],
    });
    const bot = simulation.state.players.find((player) => player.id === "bot")!;
    const initialDiscoveries = simulation.state.visibility.find(
      (visibility) => visibility.teamId === bot.teamId,
    )!.discoveredResourceNodeIds.length;

    simulation.stepMany(3_000);

    const discoveries = simulation.state.visibility.find(
      (visibility) => visibility.teamId === bot.teamId,
    )!.discoveredResourceNodeIds.length;
    const extractors = simulation.state.structures.filter(
      (structure) => structure.ownerPlayerId === bot.id
        && RESOURCE_EXTRACTOR_TYPES.includes(structure.type as typeof RESOURCE_EXTRACTOR_TYPES[number]),
    );
    const core = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === bot.id && structure.type === "commandCore",
    )!;
    const deployedShips = simulation.state.ships.filter((ship) => ship.ownerPlayerId === bot.id
      && Math.hypot(ship.x - core.x, ship.z - core.z) > 500);
    expect(discoveries).toBeGreaterThan(initialDiscoveries);
    expect(extractors.length, JSON.stringify({
      tick: simulation.state.tick,
      status: simulation.state.status,
      structures: simulation.state.structures.filter((structure) => structure.ownerPlayerId === bot.id)
        .map((structure) => [structure.type, structure.buildProgress]),
      ships: simulation.state.ships.filter((ship) => ship.ownerPlayerId === bot.id)
        .map((ship) => [ship.class, ship.orders[0]?.type]),
    })).toBeGreaterThan(1);
    expect(deployedShips.length).toBeGreaterThan(0);
  });

  it("gives a normal balanced commander a static defence program", () => {
    const simulation = createCombatScenario({
      seed: 914,
      startingResources: "high",
      players: [
        { id: "human", name: "Human", teamId: 1 },
        { id: "bot", name: "Defence Bot", teamId: 2, ai: true },
      ],
    });

    simulation.stepMany(1_000);

    const botStructures = simulation.state.structures.filter((structure) => structure.ownerPlayerId === "bot");
    expect(botStructures.some((structure) =>
      structure.ownerPlayerId === "bot"
      && DEFENSIVE_STRUCTURE_TYPES.includes(structure.type as typeof DEFENSIVE_STRUCTURE_TYPES[number]),
    ), JSON.stringify({
      structures: botStructures.map((structure) => [structure.type, structure.buildProgress]),
      ships: simulation.state.ships.filter((ship) => ship.ownerPlayerId === "bot").map((ship) => ship.class),
    })).toBe(true);
  });

  it("scales storage, alloy extraction, and production instead of starving its infrastructure", () => {
    const simulation = createCombatScenario({
      seed: 915,
      mapPreset: "open-expanse",
      mapSize: "medium",
      resourceDensity: "rich",
      startingResources: "high",
      players: [
        { id: "human", name: "Human", teamId: 1 },
        { id: "bot", name: "Economy Bot", teamId: 2, ai: true, aiDifficulty: "hard", aiPersonality: "economic" },
      ],
    });
    const humanCore = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "human" && structure.type === "commandCore",
    )!;
    humanCore.health = 1_000_000_000;
    humanCore.shields = 1_000_000_000;
    simulation.step();
    const bot = simulation.state.players.find((player) => player.id === "bot")!;
    const startingAlloyStorage = bot.economy.alloyStorage;

    simulation.stepMany(8_000);

    const botStructures = simulation.state.structures.filter((structure) => structure.ownerPlayerId === bot.id);
    const extractors = botStructures.filter((structure) =>
      RESOURCE_EXTRACTOR_TYPES.includes(structure.type as typeof RESOURCE_EXTRACTOR_TYPES[number]));
    const shipyards = botStructures.filter((structure) =>
      SHIPYARD_TYPES.includes(structure.type as typeof SHIPYARD_TYPES[number]));
    expect(bot.economy.alloyStorage, JSON.stringify({
      economy: bot.economy,
      structures: botStructures.map((structure) => [structure.type, structure.buildProgress]),
    })).toBeGreaterThan(startingAlloyStorage);
    expect(extractors.some((structure) => structure.type !== "extractor"), JSON.stringify({
      tick: simulation.state.tick,
      status: simulation.state.status,
      economy: bot.economy,
      structures: botStructures.map((structure) => [structure.type, structure.buildProgress]),
      ships: simulation.state.ships.filter((ship) => ship.ownerPlayerId === bot.id)
        .map((ship) => [ship.class, ship.orders[0]?.type]),
    })).toBe(true);
    expect(shipyards.length).toBeGreaterThan(1);
    expect(botStructures.some((structure) =>
      structure.type === "alloyRefinery" || structure.type === "matterForge",
    ), JSON.stringify(botStructures.map((structure) => [structure.type, structure.buildProgress]))).toBe(true);
  });

  it("sends unprovoked scouts deep enough to reveal the opposing side", () => {
    const simulation = createCombatScenario({
      seed: 912,
      mapPreset: "open-expanse",
      mapSize: "medium",
      startingFleet: true,
      players: [
        { id: "human", name: "Human", teamId: 1 },
        { id: "bot", name: "Scout Bot", teamId: 2, ai: true },
      ],
    });
    for (const ship of simulation.state.ships.filter((candidate) => candidate.ownerPlayerId === "bot")) {
      ship.orders = [];
    }

    simulation.stepMany(161);

    const core = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "bot" && structure.type === "commandCore",
    )!;
    const radialLength = Math.hypot(core.x, core.z);
    const inwardX = -core.x / radialLength;
    const inwardZ = -core.z / radialLength;
    const patrols = simulation.state.ships
      .filter((ship) => ship.ownerPlayerId === "bot" && ship.orders[0]?.type === "patrol")
      .map((ship) => ship.orders[0]!);
    expect(patrols.length).toBeGreaterThan(0);
    expect(patrols.every((order) =>
      (order.destination.x - core.x) * inwardX + (order.destination.z - core.z) * inwardZ > radialLength * 1.7,
    )).toBe(true);
  });

  it("advances a default unprovoked strike group instead of restaging near its base", () => {
    const simulation = createCombatScenario({
      seed: 913,
      mapPreset: "open-expanse",
      mapSize: "medium",
      startingFleet: true,
      players: [
        { id: "human", name: "Human", teamId: 1 },
        { id: "bot", name: "Attack Bot", teamId: 2, ai: true },
      ],
    });
    for (const ship of simulation.state.ships.filter((candidate) => candidate.ownerPlayerId === "bot")) {
      ship.orders = [];
    }

    simulation.stepMany(1_001);

    const core = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "bot" && structure.type === "commandCore",
    )!;
    const radialLength = Math.hypot(core.x, core.z);
    const inwardX = -core.x / radialLength;
    const inwardZ = -core.z / radialLength;
    const attackOrders = simulation.state.ships
      .filter((ship) => ship.ownerPlayerId === "bot" && ship.orders[0]?.type === "attackMove")
      .map((ship) => ship.orders[0]!);
    expect(attackOrders.length, JSON.stringify({
      tick: simulation.state.tick,
      status: simulation.state.status,
      structures: simulation.state.structures.filter((structure) => structure.ownerPlayerId === "bot")
        .map((structure) => [structure.type, structure.buildProgress]),
      ships: simulation.state.ships.filter((ship) => ship.ownerPlayerId === "bot")
        .map((ship) => [ship.class, ship.orders[0]?.type]),
    })).toBeGreaterThanOrEqual(5);
    expect(attackOrders.every((order) =>
      (order.destination.x - core.x) * inwardX + (order.destination.z - core.z) * inwardZ > radialLength * 0.5,
    )).toBe(true);
  });
});
