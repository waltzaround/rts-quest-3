import { describe, expect, it } from "vitest";
import { createCombatScenario, type ScenarioPlayerConfig } from "../src";

const PLAYERS: readonly ScenarioPlayerConfig[] = [
  { id: "alpha", name: "Alpha", teamId: 1 },
  { id: "beta", name: "Beta", teamId: 2 },
];

describe("RTS scenario settings", () => {
  it("uses a 50% larger default battlefield", () => {
    const scenario = createCombatScenario({ seed: 91, players: PLAYERS });
    const core = scenario.state.structures.find(
      (structure) => structure.ownerPlayerId === "alpha" && structure.type === "commandCore",
    )!;

    expect(Math.hypot(core.x, core.z)).toBeCloseTo(2_400, 8);
  });

  it("applies map size, starting resources, and resource density deterministically", () => {
    const small = createCombatScenario({
      seed: 91,
      players: PLAYERS,
      mapSize: "small",
      startingResources: "low",
      resourceDensity: "scarce",
    });
    const large = createCombatScenario({
      seed: 91,
      players: PLAYERS,
      mapSize: "large",
      startingResources: "high",
      resourceDensity: "rich",
    });

    const smallCore = small.state.structures.find((structure) => structure.ownerPlayerId === "alpha" && structure.type === "commandCore")!;
    const largeCore = large.state.structures.find((structure) => structure.ownerPlayerId === "alpha" && structure.type === "commandCore")!;
    expect(Math.hypot(smallCore.x, smallCore.z)).toBeCloseTo(1_600, 8);
    expect(Math.hypot(largeCore.x, largeCore.z)).toBeCloseTo(4_000, 8);
    expect(Math.hypot(largeCore.x, largeCore.z)).toBeGreaterThan(Math.hypot(smallCore.x, smallCore.z));
    expect(small.state.players[0]!.economy.alloy).toBe(500);
    expect(large.state.players[0]!.economy.alloy).toBe(1_800);
    expect(large.state.resourceNodes.length).toBeGreaterThan(small.state.resourceNodes.length);
    expect(createCombatScenario({ seed: 91, players: PLAYERS, mapSize: "large", startingResources: "high", resourceDensity: "rich" }).snapshot()).toEqual(large.snapshot());
  });

  it("supports huge and colossal battlefields", () => {
    const huge = createCombatScenario({ seed: 91, players: PLAYERS, mapSize: "huge" });
    const colossal = createCombatScenario({ seed: 91, players: PLAYERS, mapSize: "colossal" });
    const hugeCore = huge.state.structures.find(
      (structure) => structure.ownerPlayerId === "alpha" && structure.type === "commandCore",
    )!;
    const colossalCore = colossal.state.structures.find(
      (structure) => structure.ownerPlayerId === "alpha" && structure.type === "commandCore",
    )!;
    expect(Math.hypot(hugeCore.x, hugeCore.z)).toBeCloseTo(6_000, 8);
    expect(Math.hypot(colossalCore.x, colossalCore.z)).toBeCloseTo(8_500, 8);
    expect(colossal.state.obstacles.every((obstacle) => Math.hypot(obstacle.x, obstacle.z) < 8_500)).toBe(true);
  });

  it("changes authoritative obstacle layouts by map preset", () => {
    const crossfire = createCombatScenario({ players: PLAYERS, mapPreset: "crossfire" });
    const open = createCombatScenario({ players: PLAYERS, mapPreset: "open-expanse" });
    expect(crossfire.state.obstacles.length).toBeGreaterThan(open.state.obstacles.length);
    expect(crossfire.state.obstacles.map((obstacle) => [obstacle.x, obstacle.z])).not.toEqual(
      open.state.obstacles.map((obstacle) => [obstacle.x, obstacle.z]),
    );
  });

  it("offers distinct seeded layouts across every map family", () => {
    const presets = [
      "orbital-ring", "crossfire", "open-expanse", "asteroid-belt", "spiral-arms", "shattered-core",
      "amazon-tunnel", "core-rush", "star-fortress",
      "twin-gates", "broken-halo", "resource-islands",
    ] as const;
    const signatures = presets.map((mapPreset) => {
      const scenario = createCombatScenario({ seed: 4_242, players: PLAYERS, mapPreset });
      return JSON.stringify({
        obstacles: scenario.state.obstacles.map(({ x, z, radius }) => [x, z, radius]),
        resources: scenario.state.resourceNodes.map(({ x, z }) => [x, z]),
      });
    });
    expect(new Set(signatures).size).toBe(presets.length);
    const first = createCombatScenario({ seed: 4_242, players: PLAYERS, mapPreset: "spiral-arms" });
    const repeated = createCombatScenario({ seed: 4_242, players: PLAYERS, mapPreset: "spiral-arms" });
    const rerolled = createCombatScenario({ seed: 4_243, players: PLAYERS, mapPreset: "spiral-arms" });
    expect(repeated.snapshot()).toEqual(first.snapshot());
    expect(rerolled.state.resourceNodes).not.toEqual(first.state.resourceNodes);
    expect(rerolled.state.obstacles).not.toEqual(first.state.obstacles);
  });

  it("builds Amazon Tunnel as blocked fields around a broad, resource-rich central basin", () => {
    const baseRadius = 2_400;
    const scenario = createCombatScenario({ seed: 4_242, players: PLAYERS, mapPreset: "amazon-tunnel" });
    const alphaCore = scenario.state.structures.find(
      (structure) => structure.ownerPlayerId === "alpha" && structure.type === "commandCore",
    )!;
    const betaCore = scenario.state.structures.find(
      (structure) => structure.ownerPlayerId === "beta" && structure.type === "commandCore",
    )!;

    expect(alphaCore.x).toBeLessThan(0);
    expect(betaCore.x).toBeGreaterThan(0);
    expect(Math.abs(alphaCore.z)).toBeLessThan(baseRadius * 0.01);
    expect(Math.abs(betaCore.z)).toBeLessThan(baseRadius * 0.01);
    expect(scenario.state.obstacles).toHaveLength(6);
    expect(scenario.state.obstacles.every((obstacle) => obstacle.type === "barrier")).toBe(true);
    expect(scenario.state.resourceNodes.filter((node) => (
      Math.abs(node.x) < baseRadius * 0.65 && Math.abs(node.z) < baseRadius * 0.075
    )).length).toBeGreaterThanOrEqual(4);
    expect(scenario.state.resourceNodes.some((node) => (
      Math.hypot(node.x, node.z) < baseRadius * 0.02 && node.richness >= 3.2
    ))).toBe(true);
    // The inaccessible upper and lower fields are enclosed by their perimeter
    // walls instead of being packed with hundreds of redundant collision bodies.
    expect(scenario.state.obstacles.filter((obstacle) => (
      obstacle.width === baseRadius * 1.4 && (obstacle.depth ?? 0) > baseRadius * 0.7
    ))).toHaveLength(2);
  });

  it("gives the new economy and defended-start maps distinct strategic pressure", () => {
    const baseRadius = 2_400;
    const coreRush = createCombatScenario({ seed: 8_181, players: PLAYERS, mapPreset: "core-rush" });
    const starFortress = createCombatScenario({ seed: 8_181, players: PLAYERS, mapPreset: "star-fortress" });
    const centralRiches = coreRush.state.resourceNodes.filter((node) => Math.hypot(node.x, node.z) < baseRadius * 0.4);
    expect(centralRiches.length).toBeGreaterThanOrEqual(5);

    for (const player of PLAYERS) {
      const core = starFortress.state.structures.find(
        (structure) => structure.ownerPlayerId === player.id && structure.type === "commandCore",
      )!;
      const nearbyRampart = starFortress.state.obstacles.filter(
        (obstacle) => Math.hypot(obstacle.x - core.x, obstacle.z - core.z) < baseRadius * 0.28,
      );
      expect(nearbyRampart.length).toBeGreaterThanOrEqual(7);
    }
  });

  it("gives every human spawn a visible valid extractor expansion", () => {
    const players: readonly ScenarioPlayerConfig[] = [
      { id: "alpha", name: "Alpha", teamId: 1 },
      { id: "beta", name: "Beta", teamId: 1 },
      { id: "gamma", name: "Gamma", teamId: 2 },
      { id: "delta", name: "Delta", teamId: 2 },
    ];
    const presets = [
      "orbital-ring", "crossfire", "open-expanse", "asteroid-belt", "spiral-arms", "shattered-core",
      "amazon-tunnel", "core-rush", "star-fortress",
    ] as const;
    const spawnModes = ["together", "interleaved", "random"] as const;
    for (const mapPreset of [...presets, "twin-gates", "broken-halo", "resource-islands"] as const) {
      for (const teamSpawnMode of spawnModes) {
        const scenario = createCombatScenario({ seed: 7_233, players, mapPreset, teamSpawnMode });
        for (const player of scenario.state.players) {
          const startingShipyard = scenario.state.structures.find((structure) =>
            structure.ownerPlayerId === player.id && structure.type === "shipyard",
          );
          expect(startingShipyard, `${mapPreset}/${teamSpawnMode}/${player.id} starting shipyard`).toBeDefined();
          expect(
            scenario.canStructureProduceShipClass(player.id, startingShipyard!.id, "fighter"),
            `${mapPreset}/${teamSpawnMode}/${player.id} fighter production`,
          ).toBe(true);
          const validNodes = scenario.state.resourceNodes.filter((node) =>
            node.claimedByStructureId === null
              && scenario.canPlaceStructure(player.id, "extractor", node, node.id),
          );
          const core = scenario.state.structures.find((structure) =>
            structure.ownerPlayerId === player.id && structure.type === "commandCore",
          )!;
          const nearby = scenario.state.resourceNodes.filter((node) =>
            node.claimedByStructureId === null && Math.hypot(node.x - core.x, node.z - core.z) <= 360,
          ).map((node) => ({ id: node.id, x: node.x, z: node.z }));
          expect(validNodes.length, `${mapPreset}/${teamSpawnMode}/${player.id} nearby=${JSON.stringify(nearby)}`).toBeGreaterThan(0);
        }
      }
    }
  });
});
