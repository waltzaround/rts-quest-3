import { afterAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  createPlanarCirclePhysicsWorld,
  loadPhysicsRuntime,
  type PlanarCirclePhysicsWorld,
} from "@space-rts/box3d-wasm";
import { loadPhysicsRuntimeFromModule } from "@space-rts/box3d-wasm/worker";
import { SHIPS, createCombatScenario as createScenario, restoreSimulation, type ScenarioOptions } from "../src";

const createCombatScenario = (options: ScenarioOptions = {}) => createScenario({ ...options, startingFleet: true });

const worlds: PlanarCirclePhysicsWorld[] = [];

afterAll(() => {
  for (const world of worlds) world.dispose();
});

describe("authoritative asteroid physics", () => {
  it("keeps obstacle state deterministic and blocks construction overlap", () => {
    const first = createCombatScenario({ seed: 0x51a7, enemyCommander: false });
    const second = createCombatScenario({ seed: 0x51a7, enemyCommander: false });
    expect(first.state.obstacles).toEqual(second.state.obstacles);
    expect(first.state.checksum).toBe(second.state.checksum);
    expect(first.state.obstacles).toHaveLength(2);
    const obstacle = first.state.obstacles[0]!;
    expect(first.canPlaceStructure("pilot-blue", "fabricator", obstacle)).toBe(false);
  });

  it("starts every supported player count outside static colliders", () => {
    for (let playerCount = 2; playerCount <= 8; playerCount += 1) {
      const simulation = createCombatScenario({
        seed: 0x51a7,
        fightersPerTeam: 6,
        players: Array.from({ length: playerCount }, (_, index) => ({
          id: `pilot-${index + 1}`,
          name: `Pilot ${index + 1}`,
          teamId: index + 1,
        })),
      });
      expect(simulation.state.obstacles).toHaveLength(playerCount);
      for (const obstacle of simulation.state.obstacles) {
        expect(Math.hypot(obstacle.x, obstacle.z)).toBeCloseTo(2_400 * 0.32, 4);
        expect(obstacle.radius).toBe(32);
      }
      for (const ship of simulation.state.ships) {
        for (const obstacle of simulation.state.obstacles) {
          expect(
            Math.hypot(ship.x - obstacle.x, ship.z - obstacle.z),
            `${playerCount}p ship ${ship.id} overlaps asteroid ${obstacle.id}`,
          ).toBeGreaterThanOrEqual(SHIPS[ship.class].radius + obstacle.radius);
        }
        for (const order of ship.orders) {
          for (const obstacle of simulation.state.obstacles) {
            expect(
              Math.hypot(order.destination.x - obstacle.x, order.destination.z - obstacle.z),
              `${playerCount}p ship ${ship.id} received a blocked formation slot`,
            ).toBeGreaterThanOrEqual(SHIPS[ship.class].radius + obstacle.radius + 1.99);
          }
        }
      }
    }
  });

  it("absorbs a swept projectile before it can hit a target behind an asteroid", () => {
    const simulation = createCombatScenario({ seed: 0x51a7, enemyCommander: false });
    const attacker = simulation.state.ships.find((ship) => ship.ownerPlayerId === "pilot-blue")!;
    const target = simulation.state.ships.find((ship) => ship.ownerPlayerId === "pilot-red" && ship.class === "fighter")!;
    const obstacle = simulation.state.obstacles[0]!;
    simulation.state.ships = [attacker, target];
    attacker.x = obstacle.x;
    attacker.z = obstacle.z - obstacle.radius - SHIPS[attacker.class].radius - 45;
    target.x = obstacle.x;
    target.z = obstacle.z + obstacle.radius + SHIPS[target.class].radius + 24;
    attacker.turrets = [];
    target.turrets = [];
    attacker.orders = [];
    target.orders = [];
    const startingHealth = target.health;
    simulation.state.projectiles.push({
      id: simulation.state.nextEntityId++,
      ownerShipId: attacker.id,
      ownerTeamId: attacker.teamId,
      weaponTypeId: "heavyRail",
      targetEntityId: target.id,
      x: attacker.x,
      z: attacker.z,
      previousX: attacker.x,
      previousZ: attacker.z,
      vx: 0,
      vz: 510,
      radius: 2.5,
      damage: 42,
      lifetimeTicks: 32,
    });
    simulation.stepMany(12);
    expect(simulation.state.projectiles).toHaveLength(0);
    expect(target.health).toBe(startingHealth);
  });

  it("routes a capital ship around a collider and reproduces exactly after restore", async () => {
    const runtime = await loadPhysicsRuntime();
    const wasmBytes = await readFile(new URL("../../box3d-wasm/src/box3d.wasm", import.meta.url));
    const workerRuntime = await loadPhysicsRuntimeFromModule(await WebAssembly.compile(wasmBytes));
    const firstWorld = createPlanarCirclePhysicsWorld(runtime);
    const restoredWorld = createPlanarCirclePhysicsWorld(workerRuntime);
    worlds.push(firstWorld, restoredWorld);

    const first = createCombatScenario({ seed: 0x51a7, enemyCommander: false });
    const ship = first.state.ships.find(
      (candidate) => candidate.ownerPlayerId === "pilot-blue" && candidate.class === "destroyer",
    )!;
    first.state.ships = [ship];
    ship.turrets = [];
    ship.orders = [];
    ship.vx = 0;
    ship.vz = 0;
    const routingObstacle = first.state.obstacles[0]!;
    ship.x = routingObstacle.x - 100;
    ship.z = routingObstacle.z;
    first.attachPhysicsWorld(firstWorld);

    const start = { x: ship.x, z: ship.z };
    const destination = {
      x: routingObstacle.x + 100,
      z: routingObstacle.z,
    };
    expect(first.submitCommand({
      type: "move",
      playerId: "pilot-blue",
      sequence: 1,
      requestedTick: 1,
      unitIds: [ship.id],
      queued: false,
      destination,
    }).accepted).toBe(true);

    let maximumLateralDeviation = 0;
    let minimumClearance = Number.POSITIVE_INFINITY;
    let restored: ReturnType<typeof restoreSimulation> | null = null;
    for (let tick = 0; tick < 760; tick += 1) {
      const debug = first.step();
      const current = first.state.ships[0]!;
      for (const obstacle of first.state.obstacles) {
        minimumClearance = Math.min(
          minimumClearance,
          Math.hypot(current.x - obstacle.x, current.z - obstacle.z) - obstacle.radius - SHIPS[current.class].radius,
        );
      }
      const lineDx = destination.x - start.x;
      const lineDz = destination.z - start.z;
      const lineLength = Math.hypot(lineDx, lineDz);
      const deviation = Math.abs(lineDz * (current.x - start.x) - lineDx * (current.z - start.z)) / lineLength;
      maximumLateralDeviation = Math.max(maximumLateralDeviation, deviation);
      if (tick === 219) restored = restoreSimulation(first.snapshot(), restoredWorld);
      else if (restored) {
        const restoredDebug = restored.step();
        expect(restoredDebug.checksum).toBe(debug.checksum);
      }
    }

    const completedShip = first.state.ships[0]!;
    expect(minimumClearance).toBeGreaterThanOrEqual(-0.02);
    expect(maximumLateralDeviation).toBeGreaterThan(18);
    expect(Math.hypot(completedShip.x - destination.x, completedShip.z - destination.z)).toBeLessThan(32);
    expect(completedShip.orders).toHaveLength(0);
    expect(first.debugSnapshot().physicsBodyCount).toBeGreaterThan(first.state.obstacles.length);

    const blockedGoal = first.state.obstacles[0]!;
    expect(first.submitCommand({
      type: "move",
      playerId: "pilot-blue",
      sequence: 2,
      requestedTick: first.state.tick + 1,
      unitIds: [completedShip.id],
      queued: false,
      destination: blockedGoal,
    }).accepted).toBe(true);
    first.stepMany(500);
    expect(completedShip.orders).toHaveLength(0);
    expect(Math.hypot(completedShip.x - blockedGoal.x, completedShip.z - blockedGoal.z))
      .toBeGreaterThanOrEqual(blockedGoal.radius + SHIPS[completedShip.class].radius - 0.02);
  }, 20_000);
});
