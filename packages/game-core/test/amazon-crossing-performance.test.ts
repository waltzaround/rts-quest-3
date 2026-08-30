import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { createCombatScenario } from "../src";

const RUN_BENCHMARK = process.env.RUN_AMAZON_BENCHMARK === "1";

describe("Amazon Crossing performance", () => {
  it.runIf(RUN_BENCHMARK)("measures a 482-unit lockstep battle", () => {
    const simulation = createCombatScenario({
      seed: 0x7233,
      mapPreset: "amazon-tunnel",
      startingFleet: true,
      fightersPerTeam: 239,
      bombersPerTeam: 0,
      enemyCommander: false,
    });
    simulation.stepMany(20);
    const samples: number[] = [];
    for (let tick = 0; tick < 80; tick += 1) {
      const startedAt = performance.now();
      simulation.step();
      samples.push(performance.now() - startedAt);
    }
    const sorted = [...samples].sort((left, right) => left - right);
    const average = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    console.table([{ ships: simulation.state.ships.length, obstacles: simulation.state.obstacles.length,
      "tick avg ms": average.toFixed(2), "tick p95 ms": p95.toFixed(2) }]);
    expect(simulation.state.obstacles).toHaveLength(6);
  }, 120_000);
});
