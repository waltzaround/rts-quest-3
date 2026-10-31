import { describe, expect, it } from "vitest";
import { createPlanarCirclePhysicsWorld, loadPhysicsRuntime } from "@space-rts/box3d-wasm";
import {
  SHIPS, WEAPONS, computeFormationAssignments, createCombatScenario, restoreSimulation,
  type ShipClass, type ShipState,
} from "../src";

function makeFleet(count: number, classes: readonly ShipClass[] = ["fighter", "frigate", "battleship"]): ShipState[] {
  const simulation = createCombatScenario({ startingFleet: true, enemyCommander: false });
  const template = simulation.state.ships.find((ship) => ship.teamId === 1)!;
  return Array.from({ length: count }, (_, index) => ({
    ...template, id: simulation.state.nextEntityId + index, class: classes[index % classes.length]!,
    x: (index % 40 - 20) * 48, z: -1_500 - Math.floor(index / 40) * 48,
    vx: 0, vz: 0, orders: [], turrets: [], focusTargetEntityId: null,
  }));
}

describe("large attack-move formations", () => {
  it.each([128, 1_000, 12_000])("keeps every objective within fighting distance for %i mixed ships", (count) => {
    const fleet = makeFleet(count);
    const goal = { x: 900, z: 1_200 };
    const assignments = computeFormationAssignments(fleet, goal, undefined, "attackMove");

    expect(assignments).toHaveLength(count);
    expect(new Set(assignments.map((assignment) => assignment.shipId)).size).toBe(count);
    const greatestOffset = assignments.reduce((maximum, assignment) => Math.max(maximum,
      Math.hypot(assignment.destination.x - goal.x, assignment.destination.z - goal.z)), 0);
    // Even short-range escorts must advance close enough to engage at the click.
    expect(greatestOffset).toBeLessThan(WEAPONS.autocannon.range);
    expect(computeFormationAssignments([...fleet].reverse(), goal, undefined, "attackMove")).toEqual(assignments);
  });

  it("does not spread fighter destinations when a capital ship joins the selection", () => {
    const fighters = makeFleet(120, ["fighter"]);
    const goal = { x: 0, z: 1_000 };
    const capital = { ...fighters[0]!, id: fighters.at(-1)!.id + 1, class: "battleship" as const };
    const before = computeFormationAssignments(fighters, goal, undefined, "attackMove");
    const after = computeFormationAssignments([...fighters, capital], goal, undefined, "attackMove");
    expect(after.filter((assignment) => assignment.shipId !== capital.id)).toEqual(before);
  });

  it("lets distant wings approach from their own side without swapping across the objective", () => {
    const fleet = makeFleet(160, ["frigate"]);
    fleet.forEach((ship, index) => { ship.x = index < 80 ? -2_000 : 2_000; ship.z = 0; });
    const assignments = computeFormationAssignments(fleet, { x: 0, z: 0 }, undefined, "attackMove");
    for (let index = 0; index < fleet.length; index += 1) {
      const side = Math.sign(fleet[index]!.x);
      expect(assignments[index]!.destination.x * side).toBeGreaterThanOrEqual(-1e-9);
      expect(Math.sin(assignments[index]!.facing) * side).toBeLessThan(0);
    }
  });

  it("keeps a short dragged attack frontage narrow without adding map-length rear ranks", () => {
    const fleet = makeFleet(800);
    const start = { x: -100, z: 1_000 };
    const end = { x: 100, z: 1_000 };
    const assignments = computeFormationAssignments(fleet, start, end, "attackMove");
    for (const { destination } of assignments) {
      expect(destination.x).toBeGreaterThanOrEqual(start.x - 1e-9);
      expect(destination.x).toBeLessThanOrEqual(end.x + 1e-9);
      expect(destination.z).toBeLessThanOrEqual(start.z);
      expect(start.z - destination.z).toBeLessThan(WEAPONS.autocannon.range);
    }
  });

  it("uses the nearest section of a deliberately wide attack line", () => {
    const fleet = makeFleet(160, ["frigate"]);
    fleet.forEach((ship, index) => { ship.x = index < 80 ? -1_800 : 1_800; });
    const assignments = computeFormationAssignments(fleet, { x: -2_000, z: 1_000 }, { x: 2_000, z: 1_000 }, "attackMove");
    for (let index = 0; index < fleet.length; index += 1) {
      expect(Math.abs(assignments[index]!.destination.x - fleet[index]!.x)).toBeLessThan(400);
    }
  });

  it("issues the previewed destinations authoritatively and preserves queued orders after restore", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    simulation.state.obstacles = [];
    simulation.state.ships = makeFleet(128);
    simulation.state.nextEntityId = simulation.state.ships.at(-1)!.id + 1;
    const goal = { x: 0, z: 1_000 };
    const assignments = computeFormationAssignments(simulation.state.ships, goal, undefined, "attackMove");
    simulation.state.ships.forEach((ship) => {
      ship.health = SHIPS[ship.class].maxHealth;
      ship.orders = [{ type: "move", destination: { x: ship.x, z: ship.z - 500 }, facing: Math.PI }];
    });
    expect(simulation.submitCommand({
      type: "attackMove", playerId: "pilot-blue", sequence: 1, requestedTick: 1,
      unitIds: simulation.state.ships.map((ship) => ship.id), destination: goal, queued: true,
    }).accepted).toBe(true);
    const restored = restoreSimulation(simulation.snapshot());
    simulation.step();
    for (let index = 0; index < assignments.length; index += 1) {
      expect(simulation.state.ships[index]!.orders[1]).toEqual({
        type: "attackMove", destination: assignments[index]!.destination, facing: assignments[index]!.facing,
      });
    }
    restored.step();
    expect(restored.snapshot()).toEqual(simulation.snapshot());
  });

  it("brings a large mixed fleet into the attack area with real collision physics", async () => {
    const world = createPlanarCirclePhysicsWorld(await loadPhysicsRuntime());
    try {
      const simulation = createCombatScenario({ enemyCommander: false });
      simulation.state.obstacles = [];
      simulation.state.ships = makeFleet(256, ["frigate"]);
      simulation.state.ships[0]!.class = "battleship";
      simulation.state.ships[1]!.class = "battleship";
      simulation.state.nextEntityId = simulation.state.ships.at(-1)!.id + 1;
      simulation.attachPhysicsWorld(world);
      expect(simulation.submitCommand({
        type: "attackMove", playerId: "pilot-blue", sequence: 1, requestedTick: 1,
        unitIds: simulation.state.ships.map((ship) => ship.id), destination: { x: 0, z: 0 }, queued: false,
      }).accepted).toBe(true);
      simulation.stepMany(2_400);
      const inRange = simulation.state.ships.filter((ship) => Math.hypot(ship.x, ship.z) < WEAPONS.plasma.range);
      expect(inRange.length / simulation.state.ships.length).toBeGreaterThan(0.9);
    } finally {
      world.dispose();
    }
  }, 60_000); // 2,400 real-physics steps also need time on shared CI runners.
});
