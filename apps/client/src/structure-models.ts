import * as THREE from "three";
import { STRUCTURES, type StructureType, type WeaponTypeId } from "@space-rts/game-core";
import { BARBETTE_HEIGHT } from "./ship-layout";
import {
  ShipKit,
  box,
  cylinder,
  ring,
  transformed,
  tube,
  type HullGeometrySet,
} from "./ship-hulls";

/**
 * Procedural structure models built on the same industrial kit as the ships.
 *
 * `getStructureGeometry` returns the static body in the six hull layers. The
 * geometry is cached per type and shared by every instance, so a structure
 * costs five draw calls plus one per weapon mount instead of dozens of
 * individual meshes.
 *
 * Weapon mounts are returned separately by `getStructureMountGeometry`. The
 * simulation fires from `structure + hardpoint` without applying the
 * structure's yaw, so the client keeps barbettes and turrets in a container
 * that counter-rotates the base yaw.
 */

export interface StructureModel {
  body: HullGeometrySet;
  mounts: HullGeometrySet;
  /** Ship-local Y of the turret base on every hardpoint. */
  turretHeight: number;
}

/** Structure turrets are widened but keep their Z so barrel tips stay on the muzzle offsets. */
export const STRUCTURE_TURRET_SCALE: THREE.Vector3 = new THREE.Vector3(1.35, 1.3, 1);

const models = new Map<StructureType, StructureModel>();

function barbetteRadius(weaponTypeId: WeaponTypeId): number {
  switch (weaponTypeId) {
    case "pointDefense": return 2.6;
    case "autocannon": return 2.8;
    case "flakCannon": return 3.0;
    case "plasma": return 3.2;
    case "beam": return 3.2;
    case "heavyRail": return 3.4;
    case "torpedo": return 3.5;
    case "lightArtillery": return 3.5;
    case "siegeArtillery": return 3.9;
    case "strategicArtillery": return 4.4;
  }
}

function hardpointsOf(type: StructureType) {
  return STRUCTURES[type].hardpoints ?? [];
}

/** Picks the candidate spot furthest from every hardpoint. */
function freeSpot(type: StructureType, candidates: ReadonlyArray<readonly [number, number]>): readonly [number, number] {
  const hardpoints = hardpointsOf(type);
  let best = candidates[0]!;
  let bestDistance = -1;
  for (const candidate of candidates) {
    let nearest = Number.POSITIVE_INFINITY;
    for (const hardpoint of hardpoints) {
      nearest = Math.min(nearest, Math.hypot(hardpoint.localX - candidate[0], hardpoint.localZ - candidate[1]));
    }
    if (nearest > bestDistance) {
      bestDistance = nearest;
      best = candidate;
    }
  }
  return best;
}

/** Octagonal foundation slab with armored deck, perimeter ring, and edge markings. */
function platform(kit: ShipKit, radius: number, height: number, sides = 8): number {
  kit.add("hull", cylinder(radius * 0.96, radius, height, [0, height / 2, 0], sides));
  const deckTop = height + 1.6;
  kit.add("armor", cylinder(radius * 0.84, radius * 0.9, 1.6, [0, height + 0.8, 0], sides));
  kit.add("accent", ring(radius * 0.92, 0.5, [0, height + 0.9, 0], sides));
  for (let index = 0; index < 4; index += 1) {
    const angle = index * Math.PI / 2 + Math.PI / 4;
    const x = Math.sin(angle) * radius * 0.78;
    const z = Math.cos(angle) * radius * 0.78;
    kit.hazard(x, deckTop + 0.02, z, radius * 0.34, 1.4, 4, [0, angle, 0]);
  }
  for (let index = 0; index < sides; index += 1) {
    const angle = (index + 0.5) * Math.PI * 2 / sides;
    kit.lamp(Math.sin(angle) * radius * 0.87, deckTop + 0.3, Math.cos(angle) * radius * 0.87, 0.9);
  }
  return deckTop;
}

/** Ribbed cargo module rotated about Y. */
function rotatedModule(kit: ShipKit, angle: number, distance: number, y: number, width: number, height: number, depth: number, ribs = 3): void {
  const x = Math.sin(angle) * distance;
  const z = Math.cos(angle) * distance;
  kit.add("armor", box([width, height, depth], [x, y, z], [0, angle, 0]));
  for (let rib = 0; rib < ribs; rib += 1) {
    const t = ribs === 1 ? 0 : (rib / (ribs - 1) - 0.5) * depth * 0.72;
    kit.add("dark", box([width + 0.3, height * 0.78, 0.36], [x + Math.sin(angle) * t, y, z + Math.cos(angle) * t], [0, angle, 0]));
  }
  kit.hazard(x, y + height / 2 + 0.02, z, width * 0.8, 1.2, 3, [0, angle, 0]);
}

/** Cooling stack: hull cylinder with a dark cap and an accent vent ring. */
function stack(kit: ShipKit, x: number, base: number, z: number, radius: number, height: number): void {
  kit.add("hull", cylinder(radius * 0.8, radius, height, [x, base + height / 2, z], 8));
  kit.add("dark", cylinder(radius * 0.86, radius * 0.86, 0.8, [x, base + height + 0.4, z], 8));
  kit.add("accent", ring(radius * 0.9, 0.5, [x, base + height - 0.6, z]));
}

/** Horizontal pipe run between two points at height y. */
function pipe(kit: ShipKit, from: readonly [number, number], to: readonly [number, number], y: number, radius = 0.7): void {
  const dx = to[0] - from[0];
  const dz = to[1] - from[1];
  const geometry = new THREE.CylinderGeometry(radius, radius, Math.hypot(dx, dz), 6, 1, true);
  geometry.rotateX(Math.PI / 2);
  geometry.rotateY(Math.atan2(dx, dz));
  geometry.translate((from[0] + to[0]) / 2, y, (from[1] + to[1]) / 2);
  kit.add("dark", geometry);
}

function radialFins(kit: ShipKit, radius: number, y: number, count: number, height: number, depth: number): void {
  for (let index = 0; index < count; index += 1) {
    const angle = index * Math.PI * 2 / count + Math.PI / count;
    kit.add("dark", box([0.3, height, depth], [Math.sin(angle) * radius, y, Math.cos(angle) * radius], [0, angle, 0]));
  }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function commandCore(kit: ShipKit): number {
  const deck = platform(kit, 36, 6);
  // Central keep: three stacked tiers with window bands and a glowing crown.
  kit.add(
    "armor",
    box([24, 10, 24], [0, deck + 5, 0]),
    box([17, 9, 17], [0, deck + 14.5, 0]),
    box([11, 8, 11], [0, deck + 23, 0]),
  );
  for (let index = 0; index < 4; index += 1) {
    const angle = index * Math.PI / 2;
    kit.add("light", box([13, 0.6, 0.3], [Math.sin(angle) * 12.2, deck + 8, Math.cos(angle) * 12.2], [0, angle, 0]));
    kit.add("light", box([9, 0.5, 0.3], [Math.sin(angle) * 8.7, deck + 17, Math.cos(angle) * 8.7], [0, angle, 0]));
    kit.add("accent", box([16, 0.4, 0.4], [Math.sin(angle) * 12.3, deck + 2, Math.cos(angle) * 12.3], [0, angle, 0]));
    // Wall sections with hazard plating and radial gantries.
    kit.add("hull", box([22, 7, 5], [Math.sin(angle) * 28, deck + 3.5, Math.cos(angle) * 28], [0, angle, 0]));
    kit.hazard(Math.sin(angle) * 28, deck + 7.02, Math.cos(angle) * 28, 18, 1.6, 6, [0, angle, 0]);
    kit.add("dark", box([3.5, 3, 22], [Math.sin(angle) * 14, deck + 22, Math.cos(angle) * 14], [0, angle, 0]));
    kit.add("accent", box([1, 0.6, 20], [Math.sin(angle) * 14, deck + 23.8, Math.cos(angle) * 14], [0, angle, 0]));
    kit.add("accent", transformed(new THREE.OctahedronGeometry(2.6, 0), [Math.sin(angle) * 25, deck + 21, Math.cos(angle) * 25]));
    kit.plaque(Math.sin(angle) * 20, deck + 0.05, Math.cos(angle) * 20, 4, 2.4, [0, angle, 0]);
  }
  kit.add("accent", ring(7.2, 1.2, [0, deck + 27.6, 0]));
  kit.add("accent", transformed(new THREE.OctahedronGeometry(4, 0), [0, deck + 31.5, 0]));
  kit.mast(4.2, deck + 27, -4.2, 9);
  kit.mast(-4.2, deck + 27, 4.2, 6);
  return deck;
}

function extractor(kit: ShipKit, tier: 1 | 2 | 3): number {
  const scale = tier === 3 ? 1.55 : tier === 2 ? 1.25 : 1;
  const deck = platform(kit, 15 * scale, 4);
  // Drill tower with radial support arms and pipe runs.
  kit.add("armor", cylinder(5 * scale, 7.5 * scale, 14 * scale, [0, deck + 7 * scale, 0], 8));
  kit.add("dark", cylinder(3.2 * scale, 3.2 * scale, 6 * scale, [0, deck + 16 * scale, 0], 8));
  kit.add("accent", ring(5.4 * scale, 0.8, [0, deck + 12 * scale, 0]));
  kit.add("accent", cylinder(1.6 * scale, 1.6 * scale, 7 * scale, [0, deck + 21 * scale, 0], 6));
  const arms = tier === 1 ? 3 : tier === 2 ? 4 : 6;
  for (let index = 0; index < arms; index += 1) {
    const angle = index * Math.PI * 2 / arms;
    rotatedModule(kit, angle, 9.5 * scale, deck + 1.6, 3.4 * scale, 3.2, 10 * scale, 3);
    pipe(kit, [Math.sin(angle) * 4 * scale, Math.cos(angle) * 4 * scale], [Math.sin(angle) * 13 * scale, Math.cos(angle) * 13 * scale], deck + 4.2, 0.6);
  }
  if (tier >= 2) {
    kit.add("dark", transformed(new THREE.TorusGeometry(8.5 * scale, 0.9, 5, 20), [0, deck + 20 * scale, 0], [Math.PI / 2, 0, 0]));
  }
  if (tier === 3) {
    kit.add("accent", transformed(new THREE.IcosahedronGeometry(4.5 * scale, 1), [0, deck + 26 * scale, 0]));
  }
  kit.mast(6 * scale, deck + 1.6, -6 * scale, 10 * scale);
  return deck;
}

function solarArray(kit: ShipKit): number {
  const deck = platform(kit, 8, 5);
  kit.tower(0, deck, 0, 6, 6, 5);
  for (const side of [-1, 1]) {
    kit.add("armor", box([16, 1.4, 2.2], [side * 12, deck + 3, 0]));
    kit.add("dark", box([24, 0.9, 15], [side * 22, deck + 3, 0]));
    kit.add("accent", box([24.4, 0.3, 0.5], [side * 22, deck + 3.6, 7.6]), box([24.4, 0.3, 0.5], [side * 22, deck + 3.6, -7.6]));
    for (const z of [-4, 0, 4]) kit.add("light", box([23, 0.2, 0.22], [side * 22, deck + 3.55, z]));
    for (const x of [-6, 6]) kit.add("light", box([0.22, 0.2, 14], [side * 22 + x, deck + 3.55, 0]));
  }
  return deck;
}

function refinery(kit: ShipKit, tier: 1 | 2): number {
  const scale = tier === 2 ? 1.38 : 1;
  const deck = platform(kit, 22 * scale, 5, 10);
  kit.add("armor", cylinder(8 * scale, 11 * scale, 15 * scale, [0, deck + 7.5 * scale, 0], 8));
  kit.add("accent", transformed(new THREE.IcosahedronGeometry(5.5 * scale, 1), [0, deck + 18 * scale, 0]));
  kit.add("accent", ring(9.6 * scale, 0.7, [0, deck + 4 * scale, 0]));
  const stacks = tier === 2 ? 4 : 3;
  for (let index = 0; index < stacks; index += 1) {
    const angle = index / stacks * Math.PI * 2;
    const x = Math.sin(angle) * 15 * scale;
    const z = Math.cos(angle) * 15 * scale;
    stack(kit, x, deck, z, 3.4 * scale, 18 * scale);
    pipe(kit, [Math.sin(angle) * 9 * scale, Math.cos(angle) * 9 * scale], [x, z], deck + 9 * scale, 0.9);
    rotatedModule(kit, angle + Math.PI / stacks, 15 * scale, deck + 1.8, 5 * scale, 3.4, 6 * scale, 2);
  }
  return deck;
}

function storage(kit: ShipKit, tier: 1 | 2): number {
  const scale = tier === 2 ? 1.45 : 1;
  const deck = platform(kit, 17 * scale, 4);
  for (const x of [-10, 0, 10]) {
    const silo = 4.6 * scale;
    kit.add("armor", cylinder(silo, silo, 12 * scale, [x * scale, deck + 6 * scale, 0], 8));
    kit.add("dark", cylinder(silo * 0.82, silo * 0.82, 1.2, [x * scale, deck + 12.6 * scale, 0], 8));
    kit.add("accent", ring(silo * 1.02, 0.6, [x * scale, deck + 4 * scale, 0]), ring(silo * 1.02, 0.6, [x * scale, deck + 9 * scale, 0]));
    kit.plaque(x * scale, deck + 0.05, 7.5 * scale, 4, 2, [0, 0, 0]);
    kit.hazard(x * scale, deck + 0.05, -7.5 * scale, 5, 1.2, 3);
  }
  pipe(kit, [-10 * scale, 0], [10 * scale, 0], deck + 2.2, 0.7);
  if (tier === 2) {
    kit.add("accent", transformed(new THREE.IcosahedronGeometry(6, 1), [0, deck + 22 * scale, 0]));
    kit.add("dark", cylinder(1.2, 1.6, 8 * scale, [0, deck + 16 * scale, 0], 6));
  }
  return deck;
}

function fabricator(kit: ShipKit, advanced: boolean): number {
  const radius = advanced ? 26 : 20;
  const deck = platform(kit, radius, 6, advanced ? 10 : 8);
  kit.add("accent", cylinder(4, 6, 16, [0, deck + 8, 0], 6));
  kit.add("armor", cylinder(6.5, 8.5, 5, [0, deck + 2.5, 0], 8));
  for (let index = 0; index < 4; index += 1) {
    const angle = index * Math.PI / 2;
    const distance = advanced ? 18 : 12;
    kit.add("dark", box([3.5, 3.5, 24], [Math.sin(angle) * distance * 0.5, deck + 12, Math.cos(angle) * distance * 0.5], [0, angle, 0]));
    kit.add("accent", box([1, 0.5, 22], [Math.sin(angle) * distance * 0.5, deck + 14.1, Math.cos(angle) * distance * 0.5], [0, angle, 0]));
    kit.add("accent", transformed(new THREE.OctahedronGeometry(3, 0), [Math.sin(angle) * (distance + 10), deck + 11, Math.cos(angle) * (distance + 10)]));
    rotatedModule(kit, angle + Math.PI / 4, radius * 0.62, deck + 2, 5, 4, 8, 3);
    if (advanced) {
      kit.tower(Math.sin(angle) * 18, deck, Math.cos(angle) * 18, 5.5, 5.5, 12, index === 0);
    }
  }
  if (advanced) kit.add("accent", transformed(new THREE.OctahedronGeometry(8, 0), [0, deck + 24, 0]));
  return deck;
}

function reactor(kit: ShipKit, tier: 1 | 2 | 3): number {
  const scale = tier === 3 ? 1.35 : tier === 2 ? 1.28 : 1;
  const deck = platform(kit, 24 * scale, 6, 10);
  const coreY = deck + 13 * scale;
  kit.add("accent", transformed(new THREE.IcosahedronGeometry(8 * scale, 1), [0, coreY, 0]));
  const rings = tier === 1 ? 3 : 4;
  for (let index = 0; index < rings; index += 1) {
    const torus = new THREE.TorusGeometry((13 + index * 2.4) * scale, 1.2 * scale, 5, 24);
    kit.add(index % 2 === 0 ? "dark" : "armor", transformed(torus, [0, coreY, 0], [
      index % 2 === 0 ? Math.PI / 2 : 0, index > 1 ? Math.PI / 2 : 0, index * 0.55,
    ]));
  }
  const towers = tier === 3 ? 6 : 4;
  for (let index = 0; index < towers; index += 1) {
    const angle = index * Math.PI * 2 / towers + Math.PI / towers;
    const x = Math.sin(angle) * 18 * scale;
    const z = Math.cos(angle) * 18 * scale;
    stack(kit, x, deck, z, 3 * scale, 12 * scale);
    pipe(kit, [Math.sin(angle) * 8 * scale, Math.cos(angle) * 8 * scale], [x, z], deck + 3, 0.8);
  }
  kit.add("armor", cylinder(9 * scale, 11 * scale, 4, [0, deck + 2, 0], 8));
  return deck;
}

function radar(kit: ShipKit, tier: 1 | 2 | 3): number {
  const scale = tier === 3 ? 1.55 : tier === 2 ? 1.25 : 1;
  const deck = platform(kit, 15 * scale, 5);
  kit.tower(-6 * scale, deck, -6 * scale, 6 * scale, 5 * scale, 4 * scale, false);
  kit.add("dark", cylinder(2 * scale, 3.6 * scale, 24 * scale, [0, deck + 12 * scale, 0], 7));
  kit.add("accent", ring(3.4 * scale, 0.6, [0, deck + 6 * scale, 0]));
  const dish = new THREE.SphereGeometry(12 * scale, 14, 7, 0, Math.PI * 2, 0, Math.PI * 0.34);
  dish.scale(1, 0.42, 1);
  kit.add("accent", transformed(dish, [0, deck + 27 * scale, 2 * scale], [Math.PI * 0.28, 0, 0]));
  kit.add("light", transformed(new THREE.OctahedronGeometry(2 * scale, 0), [0, deck + 33 * scale, -scale]));
  for (let extra = 1; extra < tier; extra += 1) {
    const side = extra % 2 === 1 ? -1 : 1;
    const small = new THREE.SphereGeometry(7 * scale, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.34);
    small.scale(1, 0.42, 1);
    kit.add("accent", transformed(small, [side * 11 * scale, deck + (18 + extra * 3) * scale, -4 * scale], [Math.PI * 0.28, 0, side * 0.32]));
    kit.add("dark", cylinder(1.2 * scale, 1.6 * scale, 12 * scale, [side * 11 * scale, deck + 8 * scale, -4 * scale], 6));
  }
  rotatedModule(kit, Math.PI * 0.75, 9 * scale, deck + 1.8, 4 * scale, 3.2, 6 * scale, 2);
  return deck;
}

function shipyard(kit: ShipKit): number {
  // Dock base with a recessed assembly bay; the animated gantries, scanner,
  // and assembly wireframe are added by the client on top of this body.
  kit.add("hull", box([56, 5, 50], [0, 2.5, 0]), box([38, 3, 6], [0, 6, -23]), box([38, 3, 6], [0, 6, 23]));
  kit.add("dark", box([31, 1.2, 38], [0, 6, 0]));
  kit.pair("armor", (side) => box([8, 11, 46], [side * 24, 9, 0]));
  for (const x of [-24, 24]) {
    for (const z of [-20, 20]) kit.add("armor", box([7, 14, 8], [x, 10, z]));
  }
  for (const z of [-14, -7, 0, 7, 14]) kit.pair("dark", (side) => box([8.4, 8, 0.4], [side * 24, 9, z]));
  kit.pair("accent", (side) => box([2.2, 0.5, 40], [side * 24, 15.3, 0]));
  kit.pair("light", (side) => box([0.4, 0.25, 34], [side * 14.2, 6.75, 0]));
  kit.add("accent", box([28, 0.8, 1], [0, 7.9, -23.1]), box([28, 0.8, 1], [0, 7.9, 23.1]));
  kit.tower(0, 7.5, -22, 12, 7, 6, true);
  kit.hazard(0, 7.55, 24.5, 30, 1.6, 10);
  kit.hazard(-24, 17.02, 0, 6, 1.4, 4);
  kit.hazard(24, 17.02, 0, 6, 1.4, 4);
  kit.plaque(18, 7.55, -24.5, 5, 2.4);
  for (const z of [-18, -6, 6, 18]) kit.pair("light", (side) => box([0.6, 0.5, 1.4], [side * 28.4, 5.6, z]));
  kit.pair("dark", (side) => box([1.2, 9, 1.2], [side * 27.5, 21, -20]));
  kit.pair("light", (side) => box([0.6, 0.6, 0.6], [side * 27.5, 26, -20]));
  return 7.5;
}

function battery(kit: ShipKit, type: StructureType): number {
  const radius = STRUCTURES[type].radius * 0.92;
  const deck = platform(kit, radius, 5);
  const spots = [
    [0, 0], [0, -radius * 0.58], [0, radius * 0.58], [-radius * 0.58, 0], [radius * 0.58, 0],
    [-radius * 0.45, -radius * 0.45], [radius * 0.45, -radius * 0.45],
    [-radius * 0.45, radius * 0.45], [radius * 0.45, radius * 0.45],
  ] as const;
  const bunker = freeSpot(type, spots);
  const towerSize = Math.max(6, radius * 0.28);
  kit.tower(bunker[0], deck, bunker[1], towerSize, towerSize * 0.85, Math.max(4, radius * 0.18));
  const remaining = spots.filter((spot) => Math.hypot(spot[0] - bunker[0], spot[1] - bunker[1]) > radius * 0.3);
  const moduleSpot = freeSpot(type, remaining);
  const moduleAngle = Math.atan2(moduleSpot[0], moduleSpot[1]);
  rotatedModule(kit, moduleAngle, Math.hypot(moduleSpot[0], moduleSpot[1]), deck + 2, radius * 0.24, 4, radius * 0.3, 3);
  radialFins(kit, radius * 0.8, deck + 1.6, 6, 3.2, radius * 0.16);

  switch (type) {
    case "missileBattery": {
      // Vertical launch cells beside the bunker.
      for (const side of [-1, 1]) {
        const x = bunker[0] + side * (towerSize * 0.5 + 4);
        const z = bunker[1];
        kit.add("armor", box([6, 3.5, 6], [x, deck + 1.75, z]));
        for (const cx of [-1.7, 0, 1.7]) {
          for (const cz of [-1.7, 0, 1.7]) kit.add("dark", box([1.2, 0.4, 1.2], [x + cx, deck + 3.6, z + cz]));
        }
        kit.add("accent", box([6.4, 0.3, 0.4], [x, deck + 3.6, z + 3.2]));
      }
      break;
    }
    case "railBattery": {
      // Capacitor bank tubes with accent rings feeding the rail mounts.
      for (const side of [-1, 1]) {
        const x = side * radius * 0.5;
        kit.add("dark", tube(1.8, radius * 0.6, [x, deck + 2, -radius * 0.45], 8, false));
        kit.add("accent", tube(1.9, 0.5, [x, deck + 2, -radius * 0.3], 8), tube(1.9, 0.5, [x, deck + 2, -radius * 0.6], 8));
      }
      break;
    }
    case "plasmaBattery": {
      for (let index = 0; index < 4; index += 1) {
        const angle = index * Math.PI / 2 + Math.PI / 4;
        const x = Math.sin(angle) * radius * 0.72;
        const z = Math.cos(angle) * radius * 0.72;
        kit.add("dark", cylinder(2.2, 2.2, 7, [x, deck + 3.5, z], 8, false));
        kit.add("accent", ring(2.3, 0.5, [x, deck + 5.5, z]), ring(2.3, 0.5, [x, deck + 2.5, z]));
      }
      break;
    }
    case "beamBattery": {
      // Heavy radiator arrays around the rim.
      for (let index = 0; index < 4; index += 1) {
        const angle = index * Math.PI / 2;
        kit.fins(Math.sin(angle) * radius * 0.82, deck + 3.5, Math.cos(angle) * radius * 0.82, 4, 7, radius * 0.14, 2.4);
      }
      break;
    }
    case "artilleryBattery":
    case "heavyArtilleryBattery":
    case "strategicArtilleryArray": {
      // Blast walls behind the guns and an ammunition hoist.
      kit.add("armor", box([radius * 1.1, 4, 2.4], [0, deck + 2, -radius * 0.7]));
      kit.hazard(0, deck + 4.02, -radius * 0.7, radius, 1.4, 8);
      kit.add("dark", box([1.4, 1.4, radius * 0.9], [-radius * 0.7, deck + 9, -radius * 0.2]), cylinder(0.5, 0.6, 9, [-radius * 0.7, deck + 4.5, -radius * 0.62], 5));
      kit.add("accent", box([0.6, 0.4, radius * 0.8], [-radius * 0.7, deck + 9.9, -radius * 0.2]));
      break;
    }
    default:
      break;
  }
  return deck;
}

function buildBody(type: StructureType, kit: ShipKit): number {
  switch (type) {
    case "commandCore": return commandCore(kit);
    case "extractor": return extractor(kit, 1);
    case "deepCoreExtractor": return extractor(kit, 2);
    case "singularityHarvester": return extractor(kit, 3);
    case "alloyRefinery": return refinery(kit, 1);
    case "matterForge": return refinery(kit, 2);
    case "solarArray": return solarArray(kit);
    case "storage": return storage(kit, 1);
    case "quantumStorage": return storage(kit, 2);
    case "fabricator": return fabricator(kit, false);
    case "advancedFabrication": return fabricator(kit, true);
    case "fusionReactor": return reactor(kit, 1);
    case "antimatterReactor": return reactor(kit, 2);
    case "capitalInfrastructure": return reactor(kit, 3);
    case "shipyard":
    case "fleetShipyard":
    case "capitalShipyard":
      return shipyard(kit);
    case "radarArray": return radar(kit, 1);
    case "phasedRadarArray": return radar(kit, 2);
    case "deepSpaceRadarArray": return radar(kit, 3);
    case "pointDefenseBattery":
    case "missileBattery":
    case "railBattery":
    case "plasmaBattery":
    case "beamBattery":
    case "artilleryBattery":
    case "heavyArtilleryBattery":
    case "strategicArtilleryArray":
      return battery(kit, type);
  }
}

const SHIPYARD_SCALE: Partial<Record<StructureType, number>> = { fleetShipyard: 1.28, capitalShipyard: 1.72 };

export function getStructureModel(type: StructureType): StructureModel {
  const cached = models.get(type);
  if (cached) return cached;
  const kit = new ShipKit();
  const deck = buildBody(type, kit);
  const scale = SHIPYARD_SCALE[type] ?? 1;
  const body = kit.build(scale);
  const turretHeight = deck * scale + BARBETTE_HEIGHT;
  const mountKit = new ShipKit();
  for (const hardpoint of hardpointsOf(type)) {
    mountKit.barbette(hardpoint.localX, turretHeight, hardpoint.localZ, barbetteRadius(hardpoint.weaponTypeId));
  }
  const model: StructureModel = { body, mounts: mountKit.build(), turretHeight };
  models.set(type, model);
  return model;
}
