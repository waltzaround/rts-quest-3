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

  it("changes authoritative obstacle layouts by map preset", () => {
    const crossfire = createCombatScenario({ players: PLAYERS, mapPreset: "crossfire" });
    const open = createCombatScenario({ players: PLAYERS, mapPreset: "open-expanse" });
    expect(crossfire.state.obstacles.length).toBeGreaterThan(open.state.obstacles.length);
    expect(crossfire.state.obstacles.map((obstacle) => [obstacle.x, obstacle.z])).not.toEqual(
      open.state.obstacles.map((obstacle) => [obstacle.x, obstacle.z]),
    );
  });
});
