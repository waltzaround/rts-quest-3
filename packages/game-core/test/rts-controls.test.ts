import { describe, expect, it } from "vitest";
import {
  computeFormationAssignments,
  createCombatScenario as createScenario,
  type FleetCommand,
  type ScenarioOptions,
} from "../src";

const createCombatScenario = (options: ScenarioOptions = {}) => createScenario({ ...options, startingFleet: true });

function moveCommand(
  simulation: ReturnType<typeof createCombatScenario>,
  sequence: number,
  unitIds: number[],
  x: number,
  z: number,
  queued = false,
): FleetCommand {
  return {
    type: "move",
    playerId: "pilot-blue",
    sequence,
    requestedTick: simulation.state.tick + 1,
    unitIds,
    queued,
    destination: { x, z },
  };
}

describe("authoritative RTS commands", () => {
  it("validates ownership and rejects duplicate sequences", () => {
    const simulation = createCombatScenario();
    const blue = simulation.state.ships.find((ship) => ship.teamId === 1)!;
    const red = simulation.state.ships.find((ship) => ship.teamId === 2)!;
    expect(simulation.submitCommand(moveCommand(simulation, 1, [blue.id, red.id], 300, -300))).toEqual({
      accepted: false,
      reason: "ownership",
    });
    expect(simulation.submitCommand(moveCommand(simulation, 1, [blue.id], 300, -300)).accepted).toBe(true);
    expect(simulation.submitCommand(moveCommand(simulation, 1, [blue.id], 200, -200))).toEqual({
      accepted: false,
      reason: "duplicate",
    });
  });

  it("ingests commands on their requested fixed tick and moves without stopping weapons", () => {
    const simulation = createCombatScenario();
    const blueDestroyer = simulation.state.ships.find((ship) => ship.teamId === 1 && ship.class === "destroyer")!;
    const start = { x: blueDestroyer.x, z: blueDestroyer.z };
    expect(simulation.submitCommand(moveCommand(simulation, 1, [blueDestroyer.id], -360, 220)).accepted).toBe(true);
    const firstTick = simulation.step();
    expect(firstTick.events.some((event) => event.type === "commandAccepted" && event.sequence === 1)).toBe(true);
    expect(blueDestroyer.orders[0]?.destination).toEqual({ x: -360, z: 220 });
    let shotsWhileMoving = 0;
    for (let tick = 0; tick < 180; tick += 1) {
      const snapshot = simulation.step();
      if (Math.hypot(blueDestroyer.vx, blueDestroyer.vz) > 1) {
        shotsWhileMoving += snapshot.events.filter(
          (event) => event.type === "weaponFired" && event.shipId === blueDestroyer.id,
        ).length;
      }
    }
    expect(Math.hypot(blueDestroyer.x - start.x, blueDestroyer.z - start.z)).toBeGreaterThan(80);
    expect(shotsWhileMoving).toBeGreaterThan(0);
  });

  it("queues waypoints rather than replacing the active order", () => {
    const simulation = createCombatScenario();
    const fighters = simulation.state.ships.filter((ship) => ship.teamId === 1 && ship.class === "fighter").slice(0, 3);
    const ids = fighters.map((ship) => ship.id);
    expect(simulation.submitCommand(moveCommand(simulation, 1, ids, -300, -50)).accepted).toBe(true);
    simulation.step();
    expect(simulation.submitCommand(moveCommand(simulation, 2, ids, 300, 40, true)).accepted).toBe(true);
    simulation.step();
    for (const fighter of fighters) {
      expect(fighter.orders).toHaveLength(2);
      expect(fighter.orders[1]!.destination.x).toBeGreaterThan(250);
    }
  });

  it("creates stable, spaced formation slots and minimizes crossing deterministically", () => {
    const simulation = createCombatScenario();
    const fleet = simulation.state.ships.filter((ship) => ship.teamId === 1);
    const first = computeFormationAssignments(fleet, { x: -180, z: 50 }, { x: 180, z: 50 });
    const second = computeFormationAssignments([...fleet].reverse(), { x: -180, z: 50 }, { x: 180, z: 50 });
    expect(second).toEqual(first);
    expect(new Set(first.map((assignment) => `${assignment.destination.x}:${assignment.destination.z}`)).size).toBe(fleet.length);
    const orderedX = first.map((assignment) => assignment.destination.x).sort((a, b) => a - b);
    for (let index = 1; index < orderedX.length; index += 1) {
      expect(orderedX[index]! - orderedX[index - 1]!).toBeGreaterThan(40);
    }
  });

  it("replays the same scheduled commands into identical checksums", () => {
    const first = createCombatScenario({ seed: 90210 });
    const second = createCombatScenario({ seed: 90210 });
    const ids = first.state.ships.filter((ship) => ship.teamId === 1).map((ship) => ship.id);
    for (const simulation of [first, second]) {
      simulation.submitCommand(moveCommand(simulation, 1, ids, -260, 80));
      simulation.stepMany(25);
      simulation.submitCommand({
        type: "attackMove",
        playerId: "pilot-blue",
        sequence: 2,
        requestedTick: simulation.state.tick + 1,
        unitIds: ids,
        queued: true,
        destination: { x: 260, z: 140 },
      });
    }
    expect(first.stepMany(300).checksum).toBe(second.stepMany(300).checksum);
    expect(first.snapshot()).toEqual(second.snapshot());
  });

  it("stops and holds an ordered fleet without disabling turret combat", () => {
    const simulation = createCombatScenario();
    const ids = simulation.state.ships.filter((ship) => ship.teamId === 1).map((ship) => ship.id);
    simulation.submitCommand({
      type: "hold", playerId: "pilot-blue", sequence: 1,
      requestedTick: 1, unitIds: ids, queued: false,
    });
    simulation.stepMany(30);
    const blueShips = simulation.state.ships.filter((ship) => ship.teamId === 1);
    expect(blueShips.every((ship) => Math.hypot(ship.vx, ship.vz) < 0.1)).toBe(true);
    expect(blueShips.every((ship) => ship.orders[0]?.type === "hold")).toBe(true);
    expect(blueShips.some((ship) => ship.turrets.some((turret) => turret.targetEntityId !== null))).toBe(true);
  });
});
