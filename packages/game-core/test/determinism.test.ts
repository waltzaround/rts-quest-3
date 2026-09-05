import { describe, expect, it } from "vitest";
import { createCombatScenario, restoreSimulation } from "../src";

describe("same-runtime deterministic simulation", () => {
  it("produces the same checksum in two instances of the same runtime", () => {
    const browserHarness = createCombatScenario({ seed: 0x1234abcd });
    const workerHarness = restoreSimulation(browserHarness.snapshot());
    const browserChecksums: number[] = [];
    const workerChecksums: number[] = [];
    for (let tick = 0; tick < 600; tick += 1) {
      browserChecksums.push(browserHarness.step().checksum);
      workerChecksums.push(workerHarness.step().checksum);
    }
    expect(workerChecksums).toEqual(browserChecksums);
    expect(workerHarness.snapshot()).toEqual(browserHarness.snapshot());
  });

  it("replays the same seed into the same final checksum", () => {
    const first = createCombatScenario({ seed: 73 });
    const second = createCombatScenario({ seed: 73 });
    expect(first.stepMany(1_000).checksum).toBe(second.stepMany(1_000).checksum);
  });

  it("initializes two generic hostile teams with infrastructure but no starting units", () => {
    const simulation = createCombatScenario({ fightersPerTeam: 6 });
    expect(simulation.state.players).toHaveLength(2);
    expect(simulation.state.teams.map((team) => team.id)).toEqual([1, 2]);
    expect(simulation.state.ships).toHaveLength(0);
    expect(simulation.state.structures.filter((structure) => structure.type === "shipyard")).toHaveLength(2);
  });
});
