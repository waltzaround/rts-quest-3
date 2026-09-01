import { describe, expect, it } from "vitest";
import { createPlanarCirclePhysicsWorld, loadPhysicsRuntime } from "@space-rts/box3d-wasm";
import { createCombatScenario, restoreSimulation, type GameCommand } from "../src";

describe("deterministic lockstep mirror", () => {
  it("stays checksum-identical from one bootstrap state and command stream", () => {
    const authority = createCombatScenario({
      seed: 0x51a7_5eed,
      startingFleet: true,
      fightersPerTeam: 18,
      bombersPerTeam: 6,
      enemyCommander: false,
    });
    const mirror = restoreSimulation(authority.snapshot());
    const blueShipIds = authority.state.ships
      .filter((ship) => ship.ownerPlayerId === "pilot-blue")
      .map((ship) => ship.id);
    const redShipIds = authority.state.ships
      .filter((ship) => ship.ownerPlayerId === "pilot-red")
      .map((ship) => ship.id);
    const commands: GameCommand[] = [
      {
        type: "attackMove", playerId: "pilot-blue", sequence: 1, requestedTick: 8,
        unitIds: blueShipIds, queued: false, destination: { x: 0, z: 120 },
      },
      {
        type: "attackMove", playerId: "pilot-red", sequence: 1, requestedTick: 8,
        unitIds: redShipIds, queued: false, destination: { x: 0, z: -120 },
      },
      {
        type: "patrol", playerId: "pilot-blue", sequence: 2, requestedTick: 140,
        unitIds: blueShipIds.slice(0, 8), queued: true, destination: { x: 280, z: 0 },
      },
    ];
    for (const command of commands) {
      expect(authority.submitCommand(command)).toEqual(mirror.submitCommand(command));
    }
    for (let tick = 0; tick < 420; tick += 1) {
      authority.step();
      mirror.step();
      expect(mirror.state.checksum, `checksum at tick ${authority.state.tick}`).toBe(authority.state.checksum);
    }
    expect(mirror.snapshot()).toEqual(authority.snapshot());
  });

  it("recovers exactly from a later full state", () => {
    const authority = createCombatScenario({ seed: 0x7233, startingFleet: true, fightersPerTeam: 24 });
    authority.stepMany(180);
    const recovered = restoreSimulation(authority.snapshot());
    expect(recovered.state.checksum, "checksum immediately after recovery").toBe(authority.state.checksum);
    for (let tick = 0; tick < 120; tick += 1) {
      authority.step();
      recovered.step();
      expect(recovered.state.checksum).toBe(authority.state.checksum);
    }
  });

  it("clears different WASM histories before restoring the same lockstep state", async () => {
    const runtime = await loadPhysicsRuntime();
    const firstWorld = createPlanarCirclePhysicsWorld(runtime);
    const secondWorld = createPlanarCirclePhysicsWorld(runtime);
    try {
      const firstHistory = restoreSimulation(createCombatScenario({
        seed: 0x1111, startingFleet: true, fightersPerTeam: 24, bombersPerTeam: 8,
      }).snapshot(), firstWorld);
      const secondHistory = restoreSimulation(createCombatScenario({
        seed: 0x2222, startingFleet: true, fightersPerTeam: 8, bombersPerTeam: 2,
      }).snapshot(), secondWorld);
      firstHistory.stepMany(180);
      secondHistory.stepMany(45);
      const bootstrap = createCombatScenario({
        seed: 0xdecafbad, startingFleet: true, fightersPerTeam: 32, bombersPerTeam: 10,
        enemyCommander: false,
      }).snapshot();
      const first = restoreSimulation(bootstrap, firstWorld);
      const second = restoreSimulation(bootstrap, secondWorld);
      for (let tick = 0; tick < 500; tick += 1) {
        first.step();
        second.step();
        expect(second.state.checksum, `WASM checksum at tick ${first.state.tick}`).toBe(first.state.checksum);
      }
    } finally {
      firstWorld.dispose();
      secondWorld.dispose();
    }
  });
});
