import { describe, expect, it } from "vitest";
import { createCombatScenario } from "../src/simulation";
import { createMapVariantLayout } from "../src/map-layouts";
import { SHIPS, STRUCTURES } from "../src/data";
import { ReplayRecorder, playReplay } from "../src/replay";
import type { ObstacleState } from "../src/types";

const PRESETS = ["twin-gates", "broken-halo", "resource-islands"] as const;
const SIZES = { small: 1_600, medium: 2_400, large: 4_000, huge: 6_000, colossal: 8_500 } as const;
const DENSITIES = { scarce: { count: 0.67, richness: 0.78 }, standard: { count: 1, richness: 1 }, rich: { count: 1.5, richness: 1.3 } } as const;
const players = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: `Player ${i}`, teamId: i + 1 }));

function clearance(x: number, z: number, obstacle: ObstacleState): number {
  if (obstacle.type !== "barrier") return Math.hypot(x - obstacle.x, z - obstacle.z) - obstacle.radius;
  return Math.hypot(Math.max(0, Math.abs(x - obstacle.x) - obstacle.width! / 2),
    Math.max(0, Math.abs(z - obstacle.z) - obstacle.depth! / 2));
}

describe("additional map layouts", () => {
  it.each(PRESETS)("keeps %s spawns and deposits clear at every map size, roster size and density", (mapPreset) => {
    for (const [mapSize, baseRadius] of Object.entries(SIZES)) for (const playerCount of [2, 4, 8]) {
      for (const [resourceDensity, density] of Object.entries(DENSITIES)) for (const seed of [17, 8128, 99021]) {
        const layout = createMapVariantLayout(mapPreset, { seed, playerCount, baseRadius,
          resourceCount: Math.max(4, Math.round(playerCount * 3 * density.count)), richness: density.richness })!;
        const simulation = createCombatScenario({ seed, mapPreset, players: players(playerCount), varyStartingPositions: true,
          mapSize: mapSize as keyof typeof SIZES, resourceDensity: resourceDensity as keyof typeof DENSITIES, startingBase: "fortified" });
        const state = simulation.state;
        const label = `${mapPreset}/${mapSize}/${playerCount}/${resourceDensity}/${seed}`;
        expect(state.obstacles, label).toEqual(layout.obstacles);
        // No silent relocation: previews and the real map use the same pockets.
        expect(state.resourceNodes.slice(0, layout.resources.length).map(({ x, z, richness }) => ({ x, z, richness })), label).toEqual(layout.resources);
        expect(state.resourceNodes.length, label).toBe(layout.resources.length + playerCount * 3);
        for (const node of state.resourceNodes) {
          for (const obstacle of state.obstacles) expect(clearance(node.x, node.z, obstacle), label).toBeGreaterThanOrEqual(48);
        }
        for (const structure of state.structures) {
          for (const obstacle of state.obstacles) expect(clearance(structure.x, structure.z, obstacle), label).toBeGreaterThan(STRUCTURES[structure.type].radius + 8);
        }
        for (let i = 0; i < layout.resources.length; i++) for (let j = 0; j < i; j++) {
          const a = layout.resources[i]!, b = layout.resources[j]!;
          expect(Math.hypot(a.x - b.x, a.z - b.z), label).toBeGreaterThan(96);
        }
        expect(state.obstacles.length).toBeLessThanOrEqual(32);
      }
    }
  });

  it.each(PRESETS)("repeats %s exactly, varies with seed and survives replay", (mapPreset) => {
    const options = { seed: 8128, mapPreset, players: players(4) };
    const first = createCombatScenario(options);
    expect(createCombatScenario(options).snapshot()).toEqual(first.snapshot());
    expect(createCombatScenario({ ...options, seed: 8129 }).state.obstacles).not.toEqual(first.state.obstacles);
    const recorder = new ReplayRecorder(first, { checkpointIntervalTicks: 10 });
    recorder.stepMany(40);
    expect(playReplay(recorder.finalize())).toMatchObject({ ok: true });
    expect(createCombatScenario({ seed: 8128, mapPreset }).state.resourceNodes.length).toBeGreaterThan(6);
  });

  it.each(PRESETS)("increases %s deposits as density rises, even with two players", (preset) => {
    const counts = [4, 6, 9].map(resourceCount => createMapVariantLayout(preset, {
      seed: 17, playerCount: 2, baseRadius: SIZES.small, resourceCount, richness: 1,
    })!.resources.length);
    expect(counts[1]).toBeGreaterThan(counts[0]!);
    expect(counts[2]).toBeGreaterThan(counts[1]!);
  });

  it("leaves two capital-width gates open through Twin Gates while blocking the center", () => {
    const scale = SIZES.small;
    const layout = createMapVariantLayout("twin-gates", { seed: 17, playerCount: 8, baseRadius: scale, resourceCount: 24, richness: 1 })!;
    const capitalRadius = Math.max(...Object.values(SHIPS).map(ship => ship.radius)) + 8;
    const gateX = layout.obstacles[0]!.width! / 2 + scale * 0.12;
    expect(clearance(0, 0, layout.obstacles[0]!)).toBe(0);
    for (const sign of [-1, 1]) for (let step = -10; step <= 10; step++) {
      for (const obstacle of layout.obstacles) expect(clearance(sign * gateX, step / 10 * scale, obstacle)).toBeGreaterThan(capitalRadius);
    }
  });

  it("keeps four capital-width passages through Broken Halo", () => {
    const scale = SIZES.small;
    const layout = createMapVariantLayout("broken-halo", { seed: 17, playerCount: 8, baseRadius: scale, resourceCount: 24, richness: 1 })!;
    const first = layout.obstacles[0]!;
    const rotation = Math.atan2(first.x, first.z) - 0.3;
    const capitalRadius = Math.max(...Object.values(SHIPS).map(ship => ship.radius)) + 8;
    for (let gate = 0; gate < 4; gate++) for (let step = 0; step <= 40; step++) {
      const angle = rotation + gate * Math.PI / 2;
      const radius = step / 40 * scale;
      for (const obstacle of layout.obstacles) expect(clearance(Math.sin(angle) * radius, Math.cos(angle) * radius, obstacle)).toBeGreaterThan(capitalRadius);
    }
  });

  it("gives Resource Islands equal pockets and leaves the center empty", () => {
    const scale = SIZES.small;
    const layout = createMapVariantLayout("resource-islands", { seed: 17, playerCount: 8, baseRadius: scale, resourceCount: 36, richness: 1 })!;
    expect(layout.resources).toHaveLength(40);
    for (const resource of layout.resources) expect(Math.hypot(resource.x, resource.z)).toBeGreaterThan(scale * 0.46);
    expect(new Set(layout.resources.map(resource => resource.richness)).size).toBe(1);
  });
});
