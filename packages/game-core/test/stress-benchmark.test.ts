import { performance } from "node:perf_hooks";
import { describe, it } from "vitest";
import { createCombatScenario, projectPlayerView } from "../src";

const RUN_STRESS_BENCHMARK = process.env.RUN_STRESS_BENCHMARK === "1";
const SIMULATION_HZ = 20;

interface StressResult {
  ships: number;
  turrets: number;
  projectiles: number;
  tickAverageMs: number;
  tickP95Ms: number;
  viewAverageMs: number;
  stringifyAverageMs: number;
  snapshotKiB: number;
  simCpuPerSecondMs: number;
  lockstepKiBPerSecond: number;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

describe("synthetic authority stress benchmark", () => {
  it.runIf(RUN_STRESS_BENCHMARK)("measures combat ticks and full player views", () => {
    const fleetSizes = [128, 256, 482, 768] as const;
    const results: StressResult[] = [];

    for (const shipCount of fleetSizes) {
      const fightersPerTeam = Math.max(0, Math.floor((shipCount - 4) / 2));
      const simulation = createCombatScenario({
        seed: 0x7233,
        startingFleet: true,
        fightersPerTeam,
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

      simulation.stepMany(80);
      const tickSamples: number[] = [];
      const viewSamples: number[] = [];
      const stringifySamples: number[] = [];
      let viewBytes = 0;
      for (let tick = 0; tick < 160; tick += 1) {
        const tickStartedAt = performance.now();
        simulation.step();
        tickSamples.push(performance.now() - tickStartedAt);
        if (tick % 4 !== 0) continue;
        const viewStartedAt = performance.now();
        const view = projectPlayerView(simulation.state, "pilot-blue");
        viewSamples.push(performance.now() - viewStartedAt);
        const stringifyStartedAt = performance.now();
        const serialized = JSON.stringify(view);
        stringifySamples.push(performance.now() - stringifyStartedAt);
        viewBytes = Buffer.byteLength(serialized);
      }

      const average = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
      results.push({
        ships: simulation.state.ships.length,
        turrets: simulation.state.ships.reduce((sum, ship) => sum + ship.turrets.length, 0),
        projectiles: simulation.state.projectiles.length,
        tickAverageMs: average(tickSamples),
        tickP95Ms: percentile(tickSamples, 0.95),
        viewAverageMs: average(viewSamples),
        stringifyAverageMs: average(stringifySamples),
        snapshotKiB: viewBytes / 1_024,
        simCpuPerSecondMs: average(tickSamples) * SIMULATION_HZ,
        lockstepKiBPerSecond: Buffer.byteLength(JSON.stringify({
          type: "lockstep_frame", tick: simulation.state.tick, checksum: simulation.state.checksum,
        })) * SIMULATION_HZ / 1_024,
      });
    }

    console.table(results.map((result) => ({
      ships: result.ships,
      turrets: result.turrets,
      projectiles: result.projectiles,
      "tick avg ms": result.tickAverageMs.toFixed(2),
      "tick p95 ms": result.tickP95Ms.toFixed(2),
      "view ms": result.viewAverageMs.toFixed(2),
      "JSON ms": result.stringifyAverageMs.toFixed(2),
      "snapshot KiB": result.snapshotKiB.toFixed(0),
      "sim CPU ms/s": result.simCpuPerSecondMs.toFixed(0),
      "lockstep KiB/s": result.lockstepKiBPerSecond.toFixed(2),
    })));
  }, 120_000);
});
