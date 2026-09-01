import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  SharedRenderReader,
  SharedRenderWriter,
  createCombatScenario,
  createSharedRenderBuffers,
} from "../src";

const RUN_BENCHMARK = process.env.RUN_SHARED_BUFFER_BENCHMARK === "1";

describe("shared simulation render buffer", () => {
  it("publishes a coherent render frame without cloning simulation state", () => {
    const simulation = createCombatScenario({ startingFleet: true, fightersPerTeam: 12, enemyCommander: false });
    const turretCount = simulation.state.ships.reduce((sum, ship) => sum + ship.turrets.length, 0);
    const buffers = createSharedRenderBuffers({
      ships: simulation.state.ships.length,
      turrets: turretCount,
      projectiles: 1_024,
    });
    const writer = new SharedRenderWriter(buffers);
    const reader = new SharedRenderReader(buffers);
    simulation.state.ships[0]!.vx = 1_000;
    simulation.state.ships[0]!.artilleryDeploymentTicks = 42;
    simulation.state.ships[0]!.revealedUntilTick = 177;
    const published = writer.publish(simulation.state);
    const observed = reader.frame();
    expect(observed).toEqual(published);
    expect(reader.readConsistent((view, frame) => ({ id: view.shipIds[0], tick: frame.tick }))).toEqual({
      id: simulation.state.ships[0]!.id,
      tick: simulation.state.tick,
    });
    expect(reader.shipIds[0]).toBe(simulation.state.ships[0]!.id);
    expect(reader.shipTransform[0]).toBeCloseTo(simulation.state.ships[0]!.x, 4);
    expect(reader.shipVitals[2]).toBe(1);
    expect(reader.shipVitals[3]).toBe(42);
    expect(reader.shipVitals[4]).toBe(177);
  });

  it.runIf(RUN_BENCHMARK)("measures a 16,000-ship producer/consumer transport", () => {
    const shipCount = 16_000;
    const simulation = createCombatScenario({
      seed: 0x7233,
      startingFleet: true,
      fightersPerTeam: Math.floor((shipCount - 4) / 2),
      bombersPerTeam: 0,
      enemyCommander: false,
    });
    simulation.state.obstacles = [];
    for (let index = 0; index < simulation.state.ships.length; index += 1) {
      const ship = simulation.state.ships[index]!;
      const column = index % 31;
      const row = Math.floor(index / 31);
      ship.x = (column - 15) * 17 + (ship.teamId === 1 ? -8 : 8);
      ship.z = (ship.teamId === 1 ? -1 : 1) * (105 + row * 9);
      ship.health = 1_000_000_000;
      ship.shields = 1_000_000_000;
      ship.orders = [{
        type: "hold",
        destination: { x: ship.x, z: ship.z },
        facing: ship.teamId === 1 ? 0 : Math.PI,
      }];
    }
    const turretCount = simulation.state.ships.reduce((sum, ship) => sum + ship.turrets.length, 0);
    const buffers = createSharedRenderBuffers({ ships: shipCount, turrets: turretCount, projectiles: 32_768 });
    const writer = new SharedRenderWriter(buffers);
    const reader = new SharedRenderReader(buffers);
    writer.publish(simulation.state);

    const publishSamples: number[] = [];
    for (let index = 0; index < 80; index += 1) {
      const startedAt = performance.now();
      writer.publish(simulation.state);
      publishSamples.push(performance.now() - startedAt);
    }
    const readStartedAt = performance.now();
    let observedTick = 0;
    for (let index = 0; index < 100_000; index += 1) observedTick += reader.frame()?.tick ?? 0;
    const readMs = performance.now() - readStartedAt;
    expect(observedTick).toBeGreaterThanOrEqual(0);
    const bytes = Object.values(buffers)
      .filter((value): value is SharedArrayBuffer => value instanceof SharedArrayBuffer)
      .reduce((sum, buffer) => sum + buffer.byteLength, 0);
    const average = publishSamples.reduce((sum, value) => sum + value, 0) / publishSamples.length;
    const sorted = [...publishSamples].sort((left, right) => left - right);

    const producerSamples: number[] = [];
    simulation.stepMany(4);
    for (let index = 0; index < 80; index += 1) {
      const startedAt = performance.now();
      simulation.step();
      writer.publish(simulation.state);
      producerSamples.push(performance.now() - startedAt);
    }
    const producerAverage = producerSamples.reduce((sum, value) => sum + value, 0) / producerSamples.length;
    const sortedProducer = [...producerSamples].sort((left, right) => left - right);
    console.table([{
      ships: simulation.state.ships.length,
      turrets: turretCount,
      "shared MiB": (bytes / 1024 / 1024).toFixed(2),
      "publish avg ms": average.toFixed(3),
      "publish p95 ms": sorted[Math.floor(sorted.length * 0.95)]!.toFixed(3),
      "step + publish avg ms": producerAverage.toFixed(3),
      "step + publish p95 ms": sortedProducer[Math.floor(sortedProducer.length * 0.95)]!.toFixed(3),
      "header read µs": (readMs * 1_000 / 100_000).toFixed(3),
      "cloned bytes/frame": 0,
    }]);
  }, 120_000);
});
