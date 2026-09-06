import type { ObstacleState, SimulationState } from "./types";

export interface MapVariantLayout {
  obstacles: ObstacleState[];
  resources: Array<{ x: number; z: number; richness: number }>;
}

/** Shared by the simulation and the lobby's illustrative seeded preview.
 * Only new presets use this path; existing maps keep their generation order.
 */
export function createMapVariantLayout(
  preset: NonNullable<SimulationState["mapPreset"]>,
  options: { seed: number; playerCount: number; baseRadius: number; resourceCount: number; richness: number },
): MapVariantLayout | undefined {
  if (preset !== "twin-gates" && preset !== "broken-halo" && preset !== "resource-islands") return undefined;
  const { baseRadius: scale, playerCount } = options;
  let randomState = (options.seed ^ Math.imul(playerCount, 0x85ebca6b)) >>> 0;
  const random = () => {
    randomState += 0x6d2b79f5;
    let n = Math.imul(randomState ^ randomState >>> 15, randomState | 1);
    n ^= n + Math.imul(n ^ n >>> 7, n | 61);
    return ((n ^ n >>> 14) >>> 0) / 0x1_0000_0000;
  };
  const quantize = (value: number) => Math.round(value * 100_000) / 100_000;
  const layout: MapVariantLayout = { obstacles: [], resources: [] };
  const rock = (x: number, z: number, radius: number) => {
    layout.obstacles.push({ id: layout.obstacles.length + 1, type: "asteroid",
      x: quantize(x * scale), z: quantize(z * scale), radius: quantize(radius * scale),
      visualSeed: Math.floor(random() * 0x1_0000_0000) >>> 0 });
  };
  const barrier = (x: number, width: number) => {
    layout.obstacles.push({ id: layout.obstacles.length + 1, type: "barrier",
      x: quantize(x * scale), z: 0, width: quantize(width * scale), depth: quantize(0.14 * scale),
      radius: quantize(Math.hypot(width, 0.14) * scale * 0.5),
      visualSeed: Math.floor(random() * 0x1_0000_0000) >>> 0 });
  };
  const resource = (x: number, z: number, richness: number) => {
    layout.resources.push({ x: quantize(x * scale), z: quantize(z * scale), richness: richness * options.richness });
  };
  const count = Math.max(4, Math.ceil(options.resourceCount / 2) * 2);

  if (preset === "twin-gates") {
    // A divided field with two capital-width crossings and longer outer
    // flanks. Keep resources inside the clear corridors, never in the wall.
    const gateX = 0.36 + (random() - 0.5) * 0.035;
    const gateHalfWidth = 0.12;
    const outerStart = gateX + gateHalfWidth;
    barrier(0, (gateX - gateHalfWidth) * 2);
    barrier(-(outerStart + 0.82) * 0.5, 0.82 - outerStart);
    barrier((outerStart + 0.82) * 0.5, 0.82 - outerStart);
    for (let i = 0; i < count / 2; i++) {
      const x = gateX + (i % 2 === 0 ? -0.045 : 0.045);
      const z = (i / Math.max(1, count / 2 - 1) - 0.5) * 0.68;
      const richness = 1.45 + random() * 0.1;
      resource(x, z, richness);
      resource(-x, -z, richness);
    }
  } else if (preset === "broken-halo") {
    const rotation = random() * Math.PI * 2;
    for (let sector = 0; sector < 4; sector++) {
      for (let piece = 0; piece < 7; piece++) {
        const angle = rotation + sector * Math.PI / 2 + 0.3 + piece / 6 * (Math.PI / 2 - 0.6);
        rock(Math.sin(angle) * 0.46, Math.cos(angle) * 0.46, 0.045);
      }
    }
    for (let i = 0; i < count / 2; i++) {
      const angle = rotation + i / (count / 2) * Math.PI * 2;
      resource(Math.sin(angle) * 0.22, Math.cos(angle) * 0.22, 1.8);
      resource(Math.sin(angle) * 0.67, Math.cos(angle) * 0.67, 1.25);
    }
  } else {
    const islands = Math.max(4, playerCount);
    const perIsland = Math.max(1, Math.ceil(options.resourceCount / islands));
    const rotation = Math.PI + Math.PI / islands + (random() - 0.5) * 0.08;
    for (let island = 0; island < islands; island++) {
      const angle = rotation + island / islands * Math.PI * 2;
      const x = Math.sin(angle) * 0.53;
      const z = Math.cos(angle) * 0.53;
      // A crescent of cover faces the center; the other side stays open.
      for (const offset of [-0.8, 0, 0.8]) {
        const wallAngle = angle + Math.PI + offset;
        rock(x + Math.sin(wallAngle) * 0.17, z + Math.cos(wallAngle) * 0.17, 0.045);
      }
      for (let node = 0; node < perIsland; node++) {
        const nodeAngle = angle + node / perIsland * Math.PI * 2;
        const radius = perIsland === 1 ? 0 : 0.065;
        resource(x + Math.sin(nodeAngle) * radius, z + Math.cos(nodeAngle) * radius, 1.5);
      }
    }
  }
  return layout;
}
