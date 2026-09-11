import { describe, expect, it } from "vitest";
import { createPlanarCirclePhysicsWorld, loadPhysicsRuntime } from "@space-rts/box3d-wasm";
import { createCombatScenario, restoreSimulation, SHIPS, type ObstacleState } from "../src";
import { runAiStrategy } from "../src/ai-strategy";

function crossing(obstacles: ObstacleState[], from = { x: -350, z: 0 }, to = { x: 350, z: 0 }) {
  const simulation = createCombatScenario({ startingFleet: true, enemyCommander: false });
  const ship = simulation.state.ships.find((ship) => ship.teamId === 1 && ship.class === "destroyer")!;
  simulation.state.ships = [ship];
  simulation.state.obstacles = obstacles;
  ship.x = from.x; ship.z = from.z; ship.yaw = Math.atan2(to.x - from.x, to.z - from.z);
  ship.vx = ship.vz = 0; ship.turrets = []; ship.focusTargetEntityId = null;
  ship.orders = [{ type: "move", destination: to, facing: ship.yaw }];
  return { simulation, ship, to };
}

describe("terrain navigation", () => {
  it.each([40, 108, 382.5])("crosses an asteroid crescent with radius %s without stalling", (radius) => {
    const rocks: ObstacleState[] = [-0.8, 0, 0.8].map((angle, index) => ({
      id: index + 1, type: "asteroid", x: Math.cos(angle) * radius * 3.78,
      z: Math.sin(angle) * radius * 3.78, radius, visualSeed: index,
    }));
    const { simulation, ship, to } = crossing(rocks, { x: 0, z: 0 }, { x: radius * 7 + 200, z: 0 });
    simulation.stepMany(4_000);
    expect(Math.hypot(ship.x - to.x, ship.z - to.z)).toBeLessThan(32);
    expect(ship.orders).toHaveLength(0);
  });

  it("routes around a wall instead of pressing against it, including after restore", () => {
    const { simulation, ship, to } = crossing([
      { id: 1, type: "barrier", x: 0, z: 0, width: 100, depth: 600, radius: 305, visualSeed: 1 },
    ]);
    simulation.stepMany(180);
    const restored = restoreSimulation(simulation.snapshot());
    for (let tick = 0; tick < 1_200; tick++) {
      simulation.step(); restored.step();
      expect(restored.state.ships[0]).toEqual(ship);
      expect(Math.abs(ship.x) >= 50 + SHIPS[ship.class].radius - 0.02
        || Math.abs(ship.z) >= 300 + SHIPS[ship.class].radius - 0.02).toBe(true);
    }
    expect(Math.hypot(ship.x - to.x, ship.z - to.z)).toBeLessThan(32);
    expect(ship.orders).toHaveLength(0);
  });

  it("moves an AI fleet out of a Resource Islands pocket with real collision physics", async () => {
    const world = createPlanarCirclePhysicsWorld(await loadPhysicsRuntime());
    try {
      const simulation = createCombatScenario({ seed: 17, mapPreset: "resource-islands", mapSize: "small",
        startingFleet: true, enemyCommander: false });
      const state = simulation.state;
      const rock = state.obstacles[1]!;
      const length = Math.hypot(rock.x, rock.z);
      const outward = { x: rock.x / length, z: rock.z / length };
      const core = state.structures.find(s => s.ownerPlayerId === "pilot-blue" && s.type === "commandCore")!;
      const enemy = state.structures.find(s => s.ownerPlayerId === "pilot-red" && s.type === "commandCore")!;
      core.x = rock.x + outward.x * 650; core.z = rock.z + outward.z * 650;
      enemy.x = 0; enemy.z = 0;
      state.structures = [core, enemy];
      const template = state.ships.find(s => s.teamId === 1 && s.class === "frigate")!;
      state.ships = Array.from({ length: 24 }, (_, index) => {
        const ship = structuredClone(template);
        ship.id = state.nextEntityId++;
        ship.health = 1e9; // Measure navigation without casualties from the target core.
        const forward = 260 + Math.floor(index / 6) * 55, side = (index % 6 - 2.5) * 55;
        ship.x = rock.x + outward.x * forward + outward.z * side;
        ship.z = rock.z + outward.z * forward - outward.x * side;
        ship.yaw = Math.atan2(-outward.x, -outward.z);
        ship.vx = ship.vz = 0; ship.orders = []; ship.turrets = []; ship.focusTargetEntityId = null;
        return ship;
      });
      state.visibility.find(view => view.teamId === 1)!.visibleEntityIds = [enemy.id];
      simulation.attachPhysicsWorld(world);
      for (let tick = 0; tick < 2_400; tick++) {
        if (tick % 40 === 0) runAiStrategy(simulation, state.players[0]!,
          { difficulty: "normal", personality: "balanced" }, 40,
          { countConstruction: () => 0, economy() {}, infrastructure() {}, defenses() {}, industrialRoster: () => [] });
        simulation.step();
      }
      const stalled = state.ships.filter(ship => Math.hypot(ship.x, ship.z) >= 260)
        .map(ship => ({ id: ship.id, x: ship.x, z: ship.z, vx: ship.vx, vz: ship.vz, order: ship.orders[0] }));
      expect(state.ships).toHaveLength(24);
      expect(state.ships.length - stalled.length, JSON.stringify(stalled)).toBeGreaterThanOrEqual(22);
      for (const ship of state.ships) for (const obstacle of state.obstacles) {
        expect(Math.hypot(ship.x - obstacle.x, ship.z - obstacle.z))
          .toBeGreaterThanOrEqual(obstacle.radius + SHIPS[ship.class].radius - 0.02);
      }
    } finally { world.dispose(); }
  });
});
