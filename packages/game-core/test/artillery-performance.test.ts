import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  SHIPS,
  STRUCTURES,
  WEAPONS,
  calculateChecksum,
  createCombatScenario,
  restoreSimulation,
  type ShipClass,
  type ShipState,
  type StructureState,
  type StructureType,
} from "../src";

const RUN_BENCHMARK = process.env.RUN_ARTILLERY_BENCHMARK === "1";
const MOBILE_COUNT = 240;
const STATIC_COUNT = 120;
const MEASURED_TICKS = 200;

type BenchmarkKind = "baseline" | "artillery";

function makeShip(
  state: ReturnType<ReturnType<typeof createCombatScenario>["snapshot"]>,
  shipClass: ShipClass,
  index: number,
): ShipState {
  const definition = SHIPS[shipClass];
  const teamId = index % 2 + 1;
  const ownerPlayerId = teamId === 1 ? "blue" : "red";
  const side = teamId === 1 ? -1 : 1;
  const teamIndex = Math.floor(index / 2);
  const column = teamIndex % 20;
  const row = Math.floor(teamIndex / 20);
  const id = state.nextEntityId++;
  const artillery = definition.hardpoints
    .map((hardpoint) => WEAPONS[hardpoint.weaponTypeId])
    .find((weapon) => weapon.artillery)?.artillery;
  return {
    id,
    ownerPlayerId,
    teamId,
    class: shipClass,
    x: (column - 9.5) * 23 + (row % 2) * 7,
    z: side * (80 + row * 10),
    y: 0,
    yaw: teamId === 1 ? 0 : Math.PI,
    vx: 0,
    vz: 0,
    health: definition.maxHealth * 1_000,
    shields: definition.maxShield * 1_000,
    orders: [{
      type: "hold",
      destination: { x: (column - 9.5) * 23, z: side * (80 + row * 10) },
      facing: teamId === 1 ? 0 : Math.PI,
    }],
    focusTargetEntityId: null,
    lastCombatTick: -1_000,
    ...(artillery ? { artilleryDeploymentTicks: artillery.setupTicks, revealedUntilTick: 0 } : {}),
    turrets: definition.hardpoints.map((hardpoint) => {
      const turretId = state.nextTurretId++;
      return {
        id: turretId,
        parentShipId: id,
        weaponTypeId: hardpoint.weaponTypeId,
        localX: hardpoint.localX,
        localZ: hardpoint.localZ,
        yawCenter: hardpoint.yawCenter,
        yawHalfArc: hardpoint.yawHalfArc,
        currentYaw: 0,
        targetEntityId: null,
        cooldownRemaining: 0,
        fireSequence: 0,
      };
    }),
  };
}

function makeStructure(
  state: ReturnType<ReturnType<typeof createCombatScenario>["snapshot"]>,
  structureType: StructureType,
  index: number,
): StructureState {
  const definition = STRUCTURES[structureType];
  const teamId = index % 2 + 1;
  const ownerPlayerId = teamId === 1 ? "blue" : "red";
  const side = teamId === 1 ? -1 : 1;
  const teamIndex = Math.floor(index / 2);
  const column = teamIndex % 15;
  const row = Math.floor(teamIndex / 15);
  const artillery = definition.hardpoints?.some((hardpoint) => WEAPONS[hardpoint.weaponTypeId].artillery);
  return {
    id: state.nextEntityId++,
    ownerPlayerId,
    teamId,
    type: structureType,
    x: (column - 7) * 31,
    z: side * (180 + row * 20),
    yaw: teamId === 1 ? 0 : Math.PI,
    health: definition.maxHealth * 1_000,
    shields: definition.maxShield * 1_000,
    buildProgress: 1,
    resourceNodeId: null,
    productionQueue: [],
    repeatProduction: false,
    rallyPoint: { x: 0, z: 0 },
    ...(artillery ? { revealedUntilTick: 0 } : {}),
  };
}

function benchmarkScenario(kind: BenchmarkKind) {
  const template = createCombatScenario({
    seed: 0xa771_1137,
    enemyCommander: false,
    players: [
      { id: "blue", name: "Blue", teamId: 1 },
      { id: "red", name: "Red", teamId: 2 },
    ],
  }).snapshot();
  template.obstacles = [];
  template.resourceNodes = [];
  template.projectiles = [];
  template.commandQueue = [];
  template.structures = template.structures.filter((structure) => structure.type === "commandCore");
  for (const core of template.structures) {
    core.x = core.teamId === 1 ? -8_000 : 8_000;
    core.z = core.teamId === 1 ? -8_000 : 8_000;
  }

  const mobileClasses: ShipClass[] = kind === "artillery"
    ? [
        ...Array<ShipClass>(80).fill("artilleryFrigate"),
        ...Array<ShipClass>(80).fill("artilleryDestroyer"),
        ...Array<ShipClass>(80).fill("artilleryCruiser"),
      ]
    : [
        ...Array<ShipClass>(160).fill("fabricator"),
        ...Array<ShipClass>(40).fill("bomber"),
        ...Array<ShipClass>(40).fill("frigate"),
      ];
  const structureTypes: StructureType[] = kind === "artillery"
    ? [
        ...Array<StructureType>(40).fill("artilleryBattery"),
        ...Array<StructureType>(40).fill("heavyArtilleryBattery"),
        ...Array<StructureType>(40).fill("strategicArtilleryArray"),
      ]
    : [
        ...Array<StructureType>(80).fill("storage"),
        ...Array<StructureType>(20).fill("railBattery"),
        ...Array<StructureType>(20).fill("pointDefenseBattery"),
      ];
  template.ships = mobileClasses.map((shipClass, index) => makeShip(template, shipClass, index));
  template.structures.push(...structureTypes.map((structureType, index) =>
    makeStructure(template, structureType, index)));
  template.visibility = [];
  template.checksum = calculateChecksum(template);
  return restoreSimulation(template);
}

function turretCount(simulation: ReturnType<typeof benchmarkScenario>): number {
  const mobile = simulation.state.ships.reduce((sum, ship) => sum + ship.turrets.length, 0);
  const staticTurrets = simulation.state.structures.reduce((sum, structure) =>
    sum + (STRUCTURES[structure.type].hardpoints?.length ?? (STRUCTURES[structure.type].weaponTypeId ? 1 : 0)), 0);
  return mobile + staticTurrets;
}

function runSample(kind: BenchmarkKind): { milliseconds: number; peakProjectiles: number; snapshotBytes: number } {
  const simulation = benchmarkScenario(kind);
  const snapshotBytes = Buffer.byteLength(JSON.stringify(simulation.snapshot()));
  let peakProjectiles = 0;
  const startedAt = performance.now();
  for (let tick = 0; tick < MEASURED_TICKS; tick += 1) {
    simulation.step();
    peakProjectiles = Math.max(peakProjectiles, simulation.state.projectiles.length);
  }
  return { milliseconds: performance.now() - startedAt, peakProjectiles, snapshotBytes };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

describe("artillery family performance", () => {
  it.runIf(RUN_BENCHMARK)("benchmarks equal entity and turret counts against a non-artillery baseline", () => {
    const baselineFixture = benchmarkScenario("baseline");
    const artilleryFixture = benchmarkScenario("artillery");
    expect(baselineFixture.state.ships).toHaveLength(MOBILE_COUNT);
    expect(artilleryFixture.state.ships).toHaveLength(MOBILE_COUNT);
    expect(baselineFixture.state.structures).toHaveLength(STATIC_COUNT + 2);
    expect(artilleryFixture.state.structures).toHaveLength(STATIC_COUNT + 2);
    expect(turretCount(artilleryFixture)).toBe(turretCount(baselineFixture));

    runSample("baseline");
    runSample("artillery");
    const baseline = Array.from({ length: 5 }, () => runSample("baseline"));
    const artillery = Array.from({ length: 5 }, () => runSample("artillery"));
    const baselineMs = median(baseline.map((sample) => sample.milliseconds));
    const artilleryMs = median(artillery.map((sample) => sample.milliseconds));
    const regressionPercent = (artilleryMs / baselineMs - 1) * 100;
    const result = {
      entities: MOBILE_COUNT + STATIC_COUNT + 2,
      turrets: turretCount(artilleryFixture),
      ticks: MEASURED_TICKS,
      baselineMedianMs: Number(baselineMs.toFixed(2)),
      artilleryMedianMs: Number(artilleryMs.toFixed(2)),
      runtimeRegressionPercent: Number(regressionPercent.toFixed(2)),
      baselineSnapshotBytes: baseline[0]!.snapshotBytes,
      artillerySnapshotBytes: artillery[0]!.snapshotBytes,
      snapshotDeltaBytes: artillery[0]!.snapshotBytes - baseline[0]!.snapshotBytes,
      baselinePeakProjectiles: Math.max(...baseline.map((sample) => sample.peakProjectiles)),
      artilleryPeakProjectiles: Math.max(...artillery.map((sample) => sample.peakProjectiles)),
    };
    console.info(`ARTILLERY_BENCHMARK ${JSON.stringify(result)}`);
    expect(regressionPercent).toBeLessThan(10);
  }, 120_000);
});
