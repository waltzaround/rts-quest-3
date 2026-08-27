import { describe, expect, it } from "vitest";
import { calculateChecksum, createCombatScenario as createScenario, type ScenarioOptions, type SimulationState } from "../src";

const createCombatScenario = (options: ScenarioOptions = {}) => createScenario({ ...options, startingFleet: true });

function changedChecksum(mutator: (state: SimulationState) => void): [number, number] {
  const state = createCombatScenario({ enemyCommander: false }).snapshot();
  const before = calculateChecksum(state);
  mutator(state);
  return [before, calculateChecksum(state)];
}

describe("authoritative checksum coverage", () => {
  it.each([
    ["canonical position precision", (state: SimulationState) => { state.ships[0]!.x += 0.00001; }],
    ["ship class", (state: SimulationState) => { state.ships[0]!.class = "fighter"; }],
    ["velocity", (state: SimulationState) => { state.ships[0]!.vx += 0.00001; }],
    ["next entity id", (state: SimulationState) => { state.nextEntityId += 1; }],
    ["resource position", (state: SimulationState) => { state.resourceNodes[0]!.x += 1; }],
    ["alliance state", (state: SimulationState) => { state.teams[0]!.alliedTeamIds.push(2); }],
  ] as const)("detects %s divergence", (_label, mutate) => {
    const [before, after] = changedChecksum(mutate);
    expect(after).not.toBe(before);
  });

  it("detects line-formation endpoint divergence", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    const ship = simulation.state.ships.find((candidate) => candidate.ownerPlayerId === "pilot-blue")!;
    expect(simulation.submitCommand({
      type: "move",
      playerId: "pilot-blue",
      sequence: 1,
      requestedTick: 2,
      unitIds: [ship.id],
      queued: false,
      destination: { x: 10, z: 20 },
      formationEnd: { x: 50, z: 20 },
    }).accepted).toBe(true);
    const first = simulation.snapshot();
    const second = simulation.snapshot();
    const command = second.commandQueue[0];
    if (command?.type !== "move") throw new Error("Expected queued move command");
    command.formationEnd = { ...command.formationEnd!, x: command.formationEnd!.x + 1 };
    expect(calculateChecksum(second)).not.toBe(calculateChecksum(first));
  });
});
