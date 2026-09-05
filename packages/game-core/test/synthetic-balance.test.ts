import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { createPlanarCirclePhysicsWorld, loadPhysicsRuntime } from "@space-rts/box3d-wasm";
import { SIMULATION_HZ, FIXED_DT } from "@space-rts/shared";
import {
  BROOD_CAPACITY, FACTION_IDS, SHIPS, SHIP_ECONOMY, SHIPYARD_TYPES, STRUCTURES,
  calculateChecksum, createCombatScenario, isInTerritory,
  type AiDifficulty, type AiPersonality, type FactionId, type GameSimulation,
  type ScenarioOptions, type ShipClass, type ShipyardType,
} from "../src";
import { sourceFingerprint } from "./support/platform-report";

// Opt-in observation harness: it never edits a live simulation state or issues
// player commands. All production, construction and combat decisions come from AI.
const output = process.env.RTS_BALANCE_OUTPUT;
const profiles: Record<string, {
  scenario: ScenarioOptions; difficulty: AiDifficulty; personality: AiPersonality;
}> = {
  orbital: { scenario: { mapPreset: "orbital-ring" }, difficulty: "normal", personality: "balanced" },
  open: { scenario: { mapPreset: "open-expanse" }, difficulty: "normal", personality: "balanced" },
  tunnel: { scenario: { mapPreset: "amazon-tunnel" }, difficulty: "normal", personality: "balanced" },
  pressure: { scenario: { mapPreset: "core-rush", mapSize: "small", startingResources: "low", resourceDensity: "scarce" }, difficulty: "hard", personality: "aggressive" },
  macro: { scenario: { mapPreset: "open-expanse", startingResources: "high", resourceDensity: "rich" }, difficulty: "hard", personality: "economic" },
};

type Identity = { playerId: string; kind: "ship" | "structure"; name: string };
const bump = (record: Record<string, number>, key: string) => { record[key] = (record[key] ?? 0) + 1; };
const sum = (record: Record<string, number>) => Object.values(record).reduce((total, value) => total + value, 0);
function tally(names: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  names.forEach((name) => bump(counts, name));
  return counts;
}
function playerMetrics(id: string, faction: FactionId) {
  return {
    id, faction, produced: {} as Record<string, number>, lost: {} as Record<string, number>,
    structuresStarted: {} as Record<string, number>, structuresCompleted: {} as Record<string, number>,
    structuresLost: {} as Record<string, number>,
    firstUnitSeconds: null as number | null, firstCombatUnitSeconds: null as number | null,
    firstBuilderSeconds: null as number | null, firstTerritoryNodeSeconds: null as number | null,
    firstTier2YardSeconds: null as number | null,
    shipDamageTaken: 0, structureDamageTaken: 0, coreDamageTaken: 0,
    shotsByShips: 0, shotsByStructures: 0,
    alloyIncomeIntegrated: 0, energyIncomeIntegrated: 0,
    alloySpent: 0, energySpent: 0,
    samples: 0, efficiencySum: 0, starvedSamples: 0, peakCombatShips: 0,
    combatShipSamples: 0, fightingShipSamples: 0, fightingInOwnFieldSamples: 0,
    completedYardSamples: 0, readyBlockedYardSamples: 0,
    specializedNestSamples: 0, cappedNestSamples: 0, uncoveredNestSamples: 0,
  };
}

function pointInOwnField(simulation: GameSimulation, playerId: string, point: { x: number; z: number }) {
  const faction = simulation.state.players.find((player) => player.id === playerId)!.faction;
  return faction !== "industrial" && isInTerritory(simulation.state.territories, playerId,
    faction === "brood" ? "creep" : "pylon", point);
}

function summarizePlayer(simulation: GameSimulation, playerId: string) {
  const player = simulation.state.players.find((entry) => entry.id === playerId)!;
  const ships = simulation.state.ships.filter((ship) => ship.ownerPlayerId === playerId);
  const structures = simulation.state.structures.filter((structure) => structure.ownerPlayerId === playerId);
  const core = structures.find((structure) => structure.type === "commandCore");
  return {
    id: playerId, faction: player.faction, ships: tally(ships.map((ship) => ship.class)),
    combatShips: ships.filter((ship) => SHIPS[ship.class].buildPower === 0).length,
    // Common role reference only. This is neither money spent nor a win score.
    industrialEquivalentArmyCost: ships.filter((ship) => SHIPS[ship.class].buildPower === 0)
      .reduce((total, ship) => total + (SHIP_ECONOMY[ship.class].alloyCost + SHIP_ECONOMY[ship.class].energyCost)
        / SHIP_ECONOMY[ship.class].batchSize, 0),
    structures: tally(structures.filter((structure) => structure.buildProgress >= 1).map((structure) => structure.type)),
    constructing: tally(structures.filter((structure) => structure.buildProgress < 1).map((structure) => structure.type)),
    coreHullFraction: core ? core.health / STRUCTURES.commandCore.maxHealth : 0,
    coreShieldFraction: core ? core.shields / STRUCTURES.commandCore.maxShield : 0,
    economy: { ...player.economy },
    territorySources: simulation.state.territories.filter((field) => field.ownerPlayerId === playerId).length,
  };
}

it.skipIf(!output)("records paired AI faction balance experiments with production WASM physics", async () => {
  const root = resolve(import.meta.dirname, "../../..");
  const directory = resolve(output!);
  const maxTicks = Number(process.env.RTS_BALANCE_TICKS ?? 12_000);
  const seeds = (process.env.RTS_BALANCE_SEEDS ?? "1729,7384").split(",").map(Number);
  const selectedProfiles = (process.env.RTS_BALANCE_PROFILES ?? Object.keys(profiles).join(",")).split(",");
  const pairs: FactionId[][] = process.env.RTS_BALANCE_PAIRS
    ? process.env.RTS_BALANCE_PAIRS.split(",").map((pair) => pair.split(":") as FactionId[])
    : [["industrial", "brood"], ["industrial", "concord"], ["brood", "concord"]];
  expect(Number.isInteger(maxTicks) && maxTicks > 0).toBe(true);
  expect(seeds.every((seed) => Number.isSafeInteger(seed) && seed > 0)).toBe(true);
  expect(selectedProfiles.every((name) => profiles[name])).toBe(true);
  expect(pairs.every((pair) => pair.length === 2 && pair.every((faction) => FACTION_IDS.includes(faction)))).toBe(true);
  const cases = selectedProfiles.flatMap((profile) => seeds.flatMap((seed) => pairs.flatMap((pair) =>
    [pair, [...pair].reverse()].map((factions, leg) => ({
      id: `${profile}-${seed}-${pair.join("-vs-")}-${leg + 1}`,
      profile, seed, leg: leg + 1, factions,
    })))));
  if (process.env.RTS_BALANCE_MIRRORS !== "0") {
    for (const faction of FACTION_IDS) for (const seed of seeds) cases.push({
      id: `orbital-${seed}-${faction}-mirror`, profile: "orbital", seed, leg: 1, factions: [faction, faction],
    });
  }
  mkdirSync(resolve(directory, "matches"), { recursive: true });
  const sourceHash = sourceFingerprint(root);
  const report = {
    format: "space-rts-ai-balance-v1", createdAt: new Date().toISOString(), sourceHash,
    runnerHash: createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex"),
    runtime: { platform: process.platform, arch: process.arch, node: process.version, v8: process.versions.v8 },
    backend: "box3d-wasm", maxTicks, simulationHz: SIMULATION_HZ,
    profiles, seeds, plannedMatches: cases.length, completedMatches: 0,
    methodology: "No injected units/resources/orders or changed stats. Normal game victory only; timeouts remain unresolved. Each cross-faction pairing swaps factions between fixed player IDs/positions on the same seed. 1-second state sampling, per-tick event/economy accounting; 30-second timeline. A unit is one controllable entity, not one drawn fighter craft.",
    sourceUnchanged: false, matches: [] as Record<string, unknown>[],
  };
  writeFileSync(resolve(directory, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(resolve(directory, "progress.jsonl"), "");
  const runtime = await loadPhysicsRuntime();
  const world = createPlanarCirclePhysicsWorld(runtime);
  const geometryHashes = new Map<string, string>();
  try {
    for (const match of cases) {
      const started = performance.now();
      const profile = profiles[match.profile]!;
      const options: ScenarioOptions = {
        mapSize: "medium", startingResources: "standard", resourceDensity: "standard",
        startingBase: "full", startingFleet: false, varyStartingPositions: true,
        ...profile.scenario, seed: match.seed,
        players: match.factions.map((faction, index) => ({
          id: `slot-${index + 1}`, name: `Slot ${index + 1}`, teamId: index + 1,
          faction, ai: true, aiDifficulty: profile.difficulty, aiPersonality: profile.personality,
        })),
      };
      const simulation = createCombatScenario(options);
      simulation.attachPhysicsWorld(world);
      expect(simulation.physicsBackend).toBe("box3d-wasm");
      expect(simulation.state.ships).toHaveLength(0);
      const geometryHash = createHash("sha256").update(JSON.stringify({
        obstacles: simulation.state.obstacles, resources: simulation.state.resourceNodes,
        structures: simulation.state.structures.map(({ id, type, ownerPlayerId, x, z }) => ({ id, type, ownerPlayerId, x, z })),
      })).digest("hex");
      const geometryKey = `${match.profile}-${match.seed}`;
      if (geometryHashes.has(geometryKey)) expect(geometryHash).toBe(geometryHashes.get(geometryKey));
      geometryHashes.set(geometryKey, geometryHash);
      const metrics = simulation.state.players.map((player) => playerMetrics(player.id, player.faction));
      const byPlayer = new Map(metrics.map((metric) => [metric.id, metric]));
      const identities = new Map<number, Identity>(simulation.state.structures.map((structure) => [structure.id,
        { playerId: structure.ownerPlayerId, kind: "structure", name: structure.type }]));
      let firstHitSeconds: number | null = null;
      let lastHitSeconds: number | null = null;
      let hitCount = 0;
      const timeline = [{ seconds: 0, players: metrics.map((metric) => summarizePlayer(simulation, metric.id)) }];
      while (simulation.state.status === "playing" && simulation.state.tick < maxTicks) {
        simulation.step();
        const seconds = simulation.state.tick / SIMULATION_HZ;
        for (const event of simulation.debugSnapshot().events) {
          if (event.type === "unitProduced") {
            const metric = byPlayer.get(event.playerId)!;
            identities.set(event.shipId, { playerId: event.playerId, kind: "ship", name: event.shipClass });
            bump(metric.produced, event.shipClass);
            metric.firstUnitSeconds ??= seconds;
            if (SHIPS[event.shipClass].buildPower === 0) metric.firstCombatUnitSeconds ??= seconds;
            else metric.firstBuilderSeconds ??= seconds;
          } else if (event.type === "constructionStarted" || event.type === "constructionCompleted") {
            const metric = byPlayer.get(event.playerId)!;
            identities.set(event.structureId, { playerId: event.playerId, kind: "structure", name: event.structureType });
            bump(event.type === "constructionStarted" ? metric.structuresStarted : metric.structuresCompleted, event.structureType);
            if (event.type === "constructionCompleted") {
              if (event.structureType === "creepNode" || event.structureType === "pylon") metric.firstTerritoryNodeSeconds ??= seconds;
              if (event.structureType === "fleetShipyard") metric.firstTier2YardSeconds ??= seconds;
            }
          } else if (event.type === "destroyed") {
            const identity = identities.get(event.entityId);
            expect(identity, `Untracked destruction ${event.entityId}`).toBeDefined();
            const metric = byPlayer.get(identity!.playerId)!;
            bump(identity!.kind === "ship" ? metric.lost : metric.structuresLost, identity!.name);
          } else if (event.type === "hit") {
            firstHitSeconds ??= seconds;
            lastHitSeconds = seconds;
            hitCount++;
            const identity = identities.get(event.targetId);
            expect(identity, `Untracked damage ${event.targetId}`).toBeDefined();
            const metric = byPlayer.get(identity!.playerId)!;
            if (identity!.kind === "ship") metric.shipDamageTaken += event.damage;
            else metric.structureDamageTaken += event.damage;
            if (identity!.name === "commandCore") metric.coreDamageTaken += event.damage;
          } else if (event.type === "weaponFired") {
            const identity = identities.get(event.shipId);
            expect(identity, `Untracked weapon owner ${event.shipId}`).toBeDefined();
            const metric = byPlayer.get(identity!.playerId)!;
            if (identity!.kind === "ship") metric.shotsByShips++;
            else metric.shotsByStructures++;
          }
        }
        for (const player of simulation.state.players) {
          const metric = byPlayer.get(player.id)!;
          metric.alloySpent += player.economy.alloySpend * FIXED_DT;
          metric.energySpent += player.economy.energySpend * FIXED_DT;
          metric.alloyIncomeIntegrated += player.economy.alloyIncome * FIXED_DT;
          metric.energyIncomeIntegrated += player.economy.energyIncome * FIXED_DT;
        }
        if (simulation.state.tick % SIMULATION_HZ === 0) {
          for (const metric of metrics) {
            const economy = simulation.state.players.find((player) => player.id === metric.id)!.economy;
            metric.samples++;
            metric.efficiencySum += economy.efficiency;
            if (economy.efficiency < 0.9) metric.starvedSamples++;
            const ships = simulation.state.ships.filter((ship) => ship.ownerPlayerId === metric.id);
            const combatShips = ships.filter((ship) => SHIPS[ship.class].buildPower === 0);
            metric.peakCombatShips = Math.max(metric.peakCombatShips, combatShips.length);
            metric.combatShipSamples += combatShips.length;
            for (const ship of combatShips) if (ship.lastCombatTick >= simulation.state.tick - SIMULATION_HZ) {
              metric.fightingShipSamples++;
              if (pointInOwnField(simulation, metric.id, ship)) metric.fightingInOwnFieldSamples++;
            }
            for (const yard of simulation.state.structures.filter((structure) => structure.ownerPlayerId === metric.id
              && structure.buildProgress >= 1 && SHIPYARD_TYPES.includes(structure.type as ShipyardType))) {
              metric.completedYardSamples++;
              if (metric.faction === "concord" && (yard.productionQueue[0]?.progress ?? 0) >= 1) metric.readyBlockedYardSamples++;
              if (yard.broodClass !== undefined) {
                metric.specializedNestSamples++;
                if (ships.filter((ship) => ship.broodNestId === yard.id).length >= BROOD_CAPACITY[yard.broodClass]) metric.cappedNestSamples++;
                if (!pointInOwnField(simulation, metric.id, yard)) metric.uncoveredNestSamples++;
              }
            }
          }
          for (const entity of [...simulation.state.ships, ...simulation.state.structures]) {
            if (![entity.x, entity.z, entity.health, entity.shields].every(Number.isFinite)) throw new Error(`Invalid state in ${match.id}`);
          }
        }
        if (simulation.state.tick % (SIMULATION_HZ * 30) === 0) timeline.push({
          seconds, players: metrics.map((metric) => summarizePlayer(simulation, metric.id)),
        });
      }
      const final = metrics.map((metric) => summarizePlayer(simulation, metric.id));
      for (const metric of metrics) {
        expect(sum(metric.produced) - sum(metric.lost), `${match.id}/${metric.id} production conservation`)
          .toBe(sum(final.find((entry) => entry.id === metric.id)!.ships));
      }
      const winner = simulation.state.players.find((player) => player.teamId === simulation.state.winnerTeamId);
      const result = {
        ...match, options, geometryHash, ticks: simulation.state.tick, seconds: simulation.state.tick / SIMULATION_HZ,
        outcome: winner ? "victory" : simulation.state.structures.every((structure) => structure.type !== "commandCore") ? "mutual-core-loss" : "timeout",
        winnerFaction: winner?.faction ?? null, winnerSlot: winner?.id ?? null,
        firstHitSeconds, lastHitSeconds, hitCount, checksum: calculateChecksum(simulation.state),
        wallSeconds: (performance.now() - started) / 1_000,
        metrics, final, timeline,
        terminalAiPlans: simulation.state.aiPlans,
        terminalBuildOrders: simulation.state.commandQueue.filter((command) => command.type === "buildStructure"),
        terminalStructures: simulation.state.structures.map((structure) => ({
          id: structure.id, playerId: structure.ownerPlayerId, type: structure.type, x: structure.x, z: structure.z,
          progress: structure.buildProgress, health: structure.health, shields: structure.shields,
          broodClass: structure.broodClass, broodProgress: structure.broodProgress,
          warpPoint: structure.warpPoint, rallyPoint: structure.rallyPoint,
          queue: structure.productionQueue.map((item) => ({ shipClass: item.shipClass, progress: item.progress })),
        })),
        terminalShips: simulation.state.ships.map((ship) => ({
          id: ship.id, playerId: ship.ownerPlayerId, class: ship.class, x: ship.x, z: ship.z,
          health: ship.health, shields: ship.shields, broodNestId: ship.broodNestId,
          orders: ship.orders, lastCombatTick: ship.lastCombatTick,
        })),
      };
      writeFileSync(resolve(directory, "matches", `${match.id}.json`), JSON.stringify(result));
      const { timeline: _timeline, terminalShips: _ships, terminalStructures: _structures, terminalAiPlans: _plans, terminalBuildOrders: _builds, ...compact } = result;
      report.matches.push(compact);
      report.completedMatches = report.matches.length;
      writeFileSync(resolve(directory, "report.json"), JSON.stringify(report, null, 2));
      const progress = { completed: report.completedMatches, total: cases.length, id: match.id,
        winner: winner?.faction ?? result.outcome, seconds: result.seconds, wallSeconds: result.wallSeconds,
        shipsProduced: metrics.map((metric) => sum(metric.produced)),
        coreHull: final.map((entry) => entry.coreHullFraction) };
      appendFileSync(resolve(directory, "progress.jsonl"), `${JSON.stringify(progress)}\n`);
      console.log(JSON.stringify(progress));
    }
  } finally {
    world.dispose();
  }
  report.sourceUnchanged = sourceFingerprint(root) === sourceHash;
  writeFileSync(resolve(directory, "report.json"), JSON.stringify(report, null, 2));
  expect(report.sourceUnchanged, "Gameplay/dependency source changed during the experiment").toBe(true);
}, 3_600_000);
