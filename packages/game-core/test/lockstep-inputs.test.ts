import { describe, expect, it } from "vitest";
import { createCombatScenario, restoreSimulation, LockstepInputs, type GameCommand } from "../src";

function constructionFixture() {
  const simulation = createCombatScenario({ seed: 7301, enemyCommander: false });
  const core = simulation.state.structures.find((structure) => structure.ownerPlayerId === "pilot-blue" && structure.type === "commandCore")!;
  const position = Array.from({ length: 32 }, (_, index) => ({
    x: core.x + Math.sin(index * Math.PI / 16) * 180,
    z: core.z + Math.cos(index * Math.PI / 16) * 180,
  })).find((candidate) => simulation.canPlaceStructure("pilot-blue", "shipyard", candidate))!;
  expect(position).toBeDefined();
  const build: GameCommand = {
    type: "buildStructure", playerId: "pilot-blue", sequence: 1, requestedTick: 80,
    structureType: "shipyard", position, builderUnitIds: [], queued: false,
  };
  return { simulation, build };
}

describe("network input scheduling", () => {
  it("keeps every checksum identical when a construction order arrives at different times", () => {
    const { simulation: first, build } = constructionFixture();
    const second = restoreSimulation(first.snapshot());
    const firstInputs = new LockstepInputs(first);
    const secondInputs = new LockstepInputs(second);
    for (let tick = 1; tick <= 160; tick += 1) {
      if (tick === 60) expect(firstInputs.queueCommands([build])).toBe(true);
      if (tick === 70) expect(secondInputs.queueCommands([build])).toBe(true);
      firstInputs.step();
      secondInputs.step();
      expect(first.state.checksum, `tick ${tick}`).toBe(second.state.checksum);
    }
    expect(first.state.structures.some((structure) => structure.constructionSequence === 1)).toBe(true);
  });

  it("preserves constructed buildings and produced units when replaying a full recovery journal", () => {
    const { simulation: live, build } = constructionFixture();
    const bootstrap = live.snapshot();
    const inputs = new LockstepInputs(live);
    const journal: GameCommand[] = [build];
    const checksums: number[] = [];
    for (let tick = 1; tick <= 1_400; tick += 1) {
      if (tick === 60) inputs.queueCommands([build]);
      if (tick === 1_000) {
        const yard = live.state.structures.find((structure) => structure.type === "shipyard"
          && build.type === "buildStructure" && structure.x === build.position.x && structure.z === build.position.z)!;
        expect(yard?.buildProgress).toBe(1);
        const produce: GameCommand = {
          type: "queueUnit", playerId: "pilot-blue", sequence: 2, requestedTick: 1_020,
          structureId: yard.id, shipClass: "fighter", count: 1,
        };
        journal.push(produce);
        inputs.queueCommands([produce]);
      }
      inputs.step();
      checksums.push(live.state.checksum);
    }
    expect(live.state.ships.some((ship) => ship.ownerPlayerId === "pilot-blue")).toBe(true);

    const recovered = restoreSimulation(bootstrap);
    const recoveryInputs = new LockstepInputs(recovered);
    expect(recoveryInputs.queueCommands(journal)).toBe(true);
    for (let tick = 1; tick <= 1_400; tick += 1) {
      recoveryInputs.step();
      expect(recovered.state.checksum, `recovered tick ${tick}`).toBe(checksums[tick - 1]);
    }
    expect(recovered.snapshot()).toEqual(live.snapshot());
  });

  it("replays disconnect/reconnect transitions without advancing the simulation on receipt", () => {
    const { simulation: live } = constructionFixture();
    const recovered = restoreSimulation(live.snapshot());
    const liveInputs = new LockstepInputs(live);
    const recoveredInputs = new LockstepInputs(recovered);
    const disconnected = { tick: 40, playerId: "pilot-blue", state: "disconnected" as const };
    const reconnected = { tick: 100, playerId: "pilot-blue", state: "playing" as const };
    recoveredInputs.queuePlayerState(disconnected);
    recoveredInputs.queuePlayerState(reconnected);
    expect(recovered.state.tick).toBe(0);
    for (let tick = 0; tick < 140; tick += 1) {
      if (tick === 40) liveInputs.queuePlayerState(disconnected);
      if (tick === 100) liveInputs.queuePlayerState(reconnected);
      liveInputs.step();
      recoveredInputs.step();
      expect(recovered.state.checksum, `transition tick ${tick + 1}`).toBe(live.state.checksum);
    }
  });

  it("requests recovery for inputs received after their execution tick", () => {
    const { simulation, build } = constructionFixture();
    const inputs = new LockstepInputs(simulation);
    simulation.stepMany(100);
    expect(inputs.queueCommands([build])).toBe(false);
    expect(inputs.queuePlayerState({ tick: 99, playerId: "pilot-blue", state: "disconnected" })).toBe(false);
  });
});
