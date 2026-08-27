import { describe, expect, it } from "vitest";
import { createCombatScenario, restoreSimulation, type ScenarioPlayerConfig } from "../src";

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
});
