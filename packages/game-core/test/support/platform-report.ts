import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { calculateChecksum, createCombatScenario, restoreSimulation, type GameCommand, type ScenarioOptions, type SimulationState } from "../../src";
import { createPlanarCirclePhysicsWorld, loadPhysicsRuntime } from "@space-rts/box3d-wasm";

export interface PlatformCase {
  name: string;
  backend: "box3d-wasm" | "deterministic-fallback";
  initialState: SimulationState;
  commands: GameCommand[];
  trace: Array<{ tick: number; checksum: number; exact: string }>;
  commandResults: Array<{ tick: number; playerId: string; sequence: number; accepted: boolean; reason: string }>;
  activity: { shots: number; hits: number; peakShips: number };
}
export interface PlatformReport {
  format: "space-rts-determinism-v1";
  sourceHash: string;
  runtime: { platform: string; arch: string; node: string; v8: string };
  ticks: number;
  cases: PlatformCase[];
}

/** Preserve every finite double (including -0), rather than rounding like the
 * production checksum. Invalid numbers fail here instead of becoming null.
 * Sorted object keys avoid incidental property-insertion-order differences;
 * array order is preserved because it can affect targeting tie-breaks.
 */
export function exactStateHash(value: unknown): string {
  const text = JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) throw new Error("Non-finite number in deterministic state");
      if (Object.is(entry, -0)) return { $number: "-0" };
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    }
    return entry;
  });
  return createHash("sha256").update(text).digest("hex");
}

/** Include uncommitted simulation code and the installed physics glue, not
 * just the git commit. Normalize source line endings for Windows checkouts.
 */
export function sourceFingerprint(root: string): string {
  const hash = createHash("sha256");
  const files: Array<[string, string]> = [];
  const collect = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = join(dir, entry.name), label = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) collect(full, label);
      else if (/\.(?:ts|js|mjs|wasm|json)$/.test(entry.name)) files.push([full, label]);
    }
  };
  for (const name of ["game-core", "shared", "box3d-wasm"]) collect(join(root, "packages", name, "src"), `${name}/src`);
  collect(join(root, "packages/game-core/test/support"), "probe");
  const physicsDir = realpathSync(join(root, "packages/box3d-wasm/node_modules/box3d.js"));
  const physicsPackage = JSON.parse(readFileSync(join(physicsDir, "package.json"), "utf8"));
  const inline = join(physicsDir, physicsPackage.exports["./inline"].import);
  files.push([inline, "installed-physics-inline"], [join(root, "pnpm-lock.yaml"), "pnpm-lock.yaml"]);
  for (const [path, label] of files) {
    hash.update(label).update("\0");
    const bytes = readFileSync(path);
    hash.update(path.endsWith(".wasm") ? bytes : bytes.toString("utf8").replace(/\r\n/g, "\n")).update("\0");
  }
  return hash.digest("hex");
}

export function makePlatformCases(): PlatformCase[] {
  const definitions: Array<[string, ScenarioOptions]> = [
    ["fighter-and-capital-combat", { seed: 0x51a75eed, fightersPerTeam: 18, bombersPerTeam: 6, mapPreset: "crossfire" }],
    ["asteroid-navigation", { seed: 0xdecafbad, fightersPerTeam: 32, bombersPerTeam: 8, mapPreset: "asteroid-belt" }],
    ["large-fleet", { seed: 0x7233, fightersPerTeam: 90, bombersPerTeam: 12, mapPreset: "shattered-core" }],
  ];
  const cases: PlatformCase[] = [];
  for (const [name, options] of definitions) {
    const simulation = createCombatScenario({ ...options, startingFleet: true, enemyCommander: false });
    const commands: GameCommand[] = [];
    simulation.state.players.forEach((player, team) => {
      const ships = simulation.state.ships.filter(ship => ship.ownerPlayerId === player.id);
      const side = team === 0 ? -1 : 1;
      ships.forEach((ship, i) => {
        ship.x = side * (240 + Math.floor(i / 12) * 28);
        ship.z = (i % 12 - 5.5) * 28;
        ship.yaw = -side * Math.PI / 2;
        ship.vx = 0; ship.vz = 0; ship.orders = [];
      });
      commands.push({ type: "attackMove", playerId: player.id, sequence: 1, requestedTick: 2,
        unitIds: ships.map(ship => ship.id), queued: false, destination: { x: -side * 100, z: 0 } });
      commands.push({ type: "patrol", playerId: player.id, sequence: 2, requestedTick: 240,
        unitIds: ships.filter(ship => ship.class === "fighter").slice(0, 6).map(ship => ship.id),
        queued: false, destination: { x: -side * 220, z: side * 180 } });
    });
    const initialState = simulation.snapshot();
    initialState.checksum = calculateChecksum(initialState);
    for (const backend of ["box3d-wasm", "deterministic-fallback"] as const) {
      cases.push({ name, backend, initialState, commands, trace: [], commandResults: [], activity: { shots: 0, hits: 0, peakShips: 0 } });
    }
  }
  return cases;
}

export async function recordPlatformReport(root: string, ticks: number, baseline?: PlatformReport): Promise<PlatformReport> {
  const sourceHash = sourceFingerprint(root);
  if (baseline && (baseline.format !== "space-rts-determinism-v1" || baseline.sourceHash !== sourceHash)) {
    throw new Error("Different simulation build or probe version. Copy the same source changes and use pnpm install --frozen-lockfile on both machines.");
  }
  const runtime = await loadPhysicsRuntime();
  const report: PlatformReport = {
    format: "space-rts-determinism-v1", sourceHash,
    runtime: { platform: process.platform, arch: process.arch, node: process.version, v8: process.versions.v8 },
    ticks: baseline?.ticks ?? ticks, cases: [],
  };
  for (const fixture of baseline?.cases ?? makePlatformCases()) {
    const world = fixture.backend === "box3d-wasm" ? createPlanarCirclePhysicsWorld(runtime) : undefined;
    try {
      // Both platforms start from the SAME serialized state and ordered inputs,
      // just like multiplayer bootstrap; each run owns its copy and physics world.
      const simulation = restoreSimulation(JSON.parse(JSON.stringify(fixture.initialState)), world);
      const result: PlatformCase = { ...fixture, trace: [], commandResults: [], activity: { shots: 0, hits: 0, peakShips: simulation.state.ships.length } };
      const sample = (): void => {
        // Force a fresh checksum; large battles normally cache it between audits.
        simulation.refreshChecksum();
        result.trace.push({ tick: simulation.state.tick, checksum: simulation.state.checksum, exact: exactStateHash({ state: simulation.state, commandResults: result.commandResults }) });
      };
      sample();
      for (let tick = 0; tick < report.ticks; tick++) {
        for (const command of fixture.commands) {
          if (command.requestedTick !== simulation.state.tick + 2) continue;
          const accepted = simulation.submitCommand(JSON.parse(JSON.stringify(command)));
          // A later order can name a craft destroyed since the input was
          // authored. Keep that fixed input and compare the rejection too.
          result.commandResults.push({ tick: simulation.state.tick, playerId: command.playerId,
            sequence: command.sequence, accepted: accepted.accepted, reason: accepted.accepted ? "accepted" : accepted.reason });
        }
        const debug = simulation.step();
        result.activity.shots += debug.events.filter(event => event.type === "weaponFired").length;
        result.activity.hits += debug.events.filter(event => event.type === "hit").length;
        result.activity.peakShips = Math.max(result.activity.peakShips, simulation.state.ships.length);
        sample();
        if (simulation.state.status !== "playing") break;
      }
      report.cases.push(result);
      console.log(`${fixture.name} / ${fixture.backend}: ${simulation.state.tick} ticks, ${result.activity.shots} shots, ${result.activity.hits} hits`);
    } finally {
      world?.dispose();
    }
  }
  // Do not label mixed versions as a valid run when another task edits the game.
  if (sourceFingerprint(root) !== sourceHash) throw new Error("Simulation files changed during this run; repeat after edits finish.");
  return report;
}
