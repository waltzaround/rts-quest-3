import * as THREE from "three";
import { SHIPS, SHIP_TURRET_SCALES, type ShipClass } from "@space-rts/game-core";
import { FIGHTER_GUN_HEIGHT, FIGHTER_GUN_Z, FIGHTER_GUN_SEPARATION } from "./fighter-visuals";
import { SHIP_THRUSTERS, turretDeckHeight } from "./ship-layout";
import { ShipKit, armorBlock, box, cylinder, deckMark, hullShell, loft, merge, transformed, tube, type HullGeometrySet, type Vec3 } from "./ship-hulls";

/** Silhouettes encode roles before surface detail: dart, claw, spear,
 * hammerhead, missile catamaran, forked gun, arrowhead, broadside cruiser,
 * open flight deck and armored dreadnought. Everything stays in six batches.
 */
export const SHIP_ROLE_LABELS: Readonly<Record<ShipClass, string>> = {
  fighter: "Dart · interceptor squadron", bomber: "Manta · strike bomber",
  fabricator: "Claw · construction tender", frigate: "Spear · escort",
  flakFrigate: "Aegis · flak screen", torpedoFrigate: "Quiver · missile boat",
  artilleryFrigate: "Lance · light artillery", destroyer: "Arrow · line destroyer",
  artilleryDestroyer: "Ballista · siege artillery", cruiser: "Trident · broadside cruiser",
  artilleryCruiser: "Longbow · strategic artillery", carrier: "Atlas · fleet carrier",
  battleship: "Bastion · battleship",
};

type Outline = ReadonlyArray<readonly [number, number]>;
const silhouettes = new WeakMap<ShipKit, THREE.BufferGeometry[]>();
const mediumParts = new WeakMap<ShipKit, { hull: THREE.BufferGeometry[]; armor: THREE.BufferGeometry[] }>();

function major(kit: ShipKit, layer: "hull" | "armor", geometry: THREE.BufferGeometry): void {
  kit.add(layer, geometry);
  const parts = mediumParts.get(kit) ?? { hull: [], armor: [] };
  parts[layer].push(geometry.clone());
  mediumParts.set(kit, parts);
}

function pairMajor(kit: ShipKit, layer: "hull" | "armor", build: (side: number) => THREE.BufferGeometry): void {
  major(kit, layer, build(-1));
  major(kit, layer, build(1));
}

function silhouette(kit: ShipKit, outline: Outline): void {
  const shape = new THREE.Shape(outline.map(p => new THREE.Vector2(...p)));
  const geometry = new THREE.ShapeGeometry(shape, 1).rotateX(Math.PI / 2);
  const indices = geometry.getIndex()!;
  for (let i = 0; i < indices.count; i += 3) {
    const b = indices.getX(i + 1);
    indices.setX(i + 1, indices.getX(i + 2));
    indices.setX(i + 2, b);
  }
  geometry.computeVertexNormals();
  const parts = silhouettes.get(kit) ?? [];
  parts.push(geometry);
  silhouettes.set(kit, parts);
}

function finish(kit: ShipKit): HullGeometrySet {
  const geometry = kit.build();
  geometry.hull.userData.silhouette = merge(silhouettes.get(kit) ?? []);
  const medium = mediumParts.get(kit);
  geometry.hull.userData.medium = merge(medium?.hull ?? []);
  geometry.armor.userData.medium = merge(medium?.armor ?? []);
  silhouettes.delete(kit);
  mediumParts.delete(kit);
  return geometry;
}

function shell(kit: ShipKit, outline: Outline, height: number, base: number): void {
  major(kit, "hull", hullShell(outline, height, base));
  silhouette(kit, outline);
}

function plate(kit: ShipKit, size: Vec3, at: Vec3): void {
  major(kit, "armor", armorBlock(size, at));
}

function strut(kit: ShipKit, from: Vec3, to: Vec3, width: number, layer: "hull" | "armor" = "hull"): void {
  const a = new THREE.Vector3(...from);
  const b = new THREE.Vector3(...to);
  const direction = b.clone().sub(a);
  const geometry = new THREE.BoxGeometry(width, width, direction.length());
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction.normalize()));
  geometry.translate(...a.add(b).multiplyScalar(0.5).toArray());
  major(kit, layer, geometry);
  if (layer === "hull") {
    const dx = to[0] - from[0], dz = to[2] - from[2];
    const length = Math.hypot(dx, dz) || 1;
    const sx = -dz / length * width / 2, sz = dx / length * width / 2;
    silhouette(kit, [[from[0] + sx, from[2] + sz], [to[0] + sx, to[2] + sz], [to[0] - sx, to[2] - sz], [from[0] - sx, from[2] - sz]]);
  }
}

/** Low slanted command blister, with a dark wraparound canopy and ivory cap. */
function bridge(kit: ShipKit, x: number, base: number, z: number, width: number, length: number, height: number): void {
  major(kit, "hull", armorBlock([width, height, length], [x, base + height / 2, z]));
  kit.add("dark", armorBlock([width * 0.84, height * 0.55, length * 0.58], [x, base + height * 0.91, z + length * 0.1]));
  plate(kit, [width * 0.82, height * 0.25, length * 0.6], [x, base + height * 1.27, z - length * 0.09]);
  kit.add("light", box([width * 0.52, 0.14, 0.12], [x, base + height, z + length * 0.39]));
}

function vents(kit: ShipKit, x: number, deckY: number, z: number, width: number, length: number, rows = 6): void {
  // The vent backing and its slats must occupy distinct depth planes. A
  // coplanar backing flickers through the armor as the camera moves.
  const y = deckY + 0.06;
  kit.add("dark", deckMark(width, length, [x, y, z]));
  for (let i = 0; i < rows; i += 1) {
    kit.add("armor", deckMark(width * 0.88, Math.min(0.16, length / rows * 0.18), [x, y + 0.025, z + (i / rows - 0.5) * length * 0.9]));
  }
}

function insignia(kit: ShipKit, x: number, y: number, z: number, size: number, bars: number): void {
  kit.add("accent", deckMark(size * 0.7, size * 2.1, [x, y, z]));
  for (let i = 0; i < bars; i += 1) {
    kit.add("light", deckMark(size * 0.68, size * 0.15, [x, y + 0.025, z + size * (0.65 - i * 0.4)]));
  }
}

function drives(kit: ShipKit, shipClass: ShipClass, radius: number, depth: number): void {
  const layout = SHIP_THRUSTERS[shipClass];
  for (const x of layout.offsets) {
    // Sloped fairing leads into an open bell. The nozzle stays at the original
    // thrust anchor; the dark throat is recessed, never a white disk on a box.
    const front = layout.rear + depth;
    major(kit, "hull", loft([
      [x - radius * 0.86, layout.rear + radius * 1.25],
      [x - radius * 1.14, layout.rear + depth * 0.4],
      [x - radius * 0.7, front], [x + radius * 0.7, front],
      [x + radius * 1.14, layout.rear + depth * 0.4],
      [x + radius * 0.86, layout.rear + radius * 1.25],
    ], [[0.88, 0.98, layout.y - radius * 0.7], [1, 1, layout.y + radius * 0.75]]));
    silhouette(kit, [[x - radius, layout.rear], [x + radius, layout.rear], [x + radius, front], [x - radius, front]]);
    plate(kit, [radius * 1.55, radius * 0.26, depth * 0.62], [x, layout.y + radius * 0.79, layout.rear + depth * 0.62]);
    const bell = new THREE.CylinderGeometry(radius * 0.58, radius * 0.94, radius * 1.25, 8, 1, true);
    bell.rotateX(Math.PI / 2);
    major(kit, "hull", bell.translate(x, layout.y, layout.rear + radius * 0.625));
    const lip = new THREE.RingGeometry(radius * 0.79, radius * 0.97, 8);
    kit.add("armor", transformed(lip, [x, layout.y, layout.rear], [0, Math.PI, 0]));
    kit.add("dark", transformed(new THREE.CircleGeometry(radius * 0.66, 6), [x, layout.y, layout.rear + radius * 0.9], [0, Math.PI, 0]));
    kit.add("light", transformed(new THREE.RingGeometry(radius * 0.32, radius * 0.46, 8), [x, layout.y, layout.rear + radius * 0.87], [0, Math.PI, 0]));
  }
}

function weapons(kit: ShipKit, shipClass: ShipClass): void {
  for (const hp of SHIPS[shipClass].hardpoints) {
    const top = turretDeckHeight(shipClass, hp.localX, hp.localZ, hp.weaponTypeId);
    const radius = SHIP_TURRET_SCALES[shipClass] * (hp.weaponTypeId === "pointDefense" ? 2.0 : 2.8);
    // A chamfered foundation anchors each mount without another glowing ring.
    kit.add("hull", cylinder(radius * 0.9, radius * 1.16, 1.5, [hp.localX, top - 0.75, hp.localZ], 6));
    kit.add("armor", cylinder(radius * 0.95, radius, 0.28, [hp.localX, top - 0.16, hp.localZ], 6));
  }
}

function fighter(): HullGeometrySet {
  const kit = new ShipKit();
  shell(kit, [[0, 4.15], [-0.75, 0.7], [-3.4, -1.6], [-2.8, -2.5], [-0.5, -1.8], [0, -3.5], [0.5, -1.8], [2.8, -2.5], [3.4, -1.6], [0.75, 0.7]], 0.65, 0.1);
  pairMajor(kit, "armor", s => hullShell([[s * 0.7, 1.1], [s * 3.25, -1.7], [s * 2.7, -2.1], [s * 0.5, -0.7]], 0.14, 0.58));
  bridge(kit, 0, 0.72, 0.1, 0.95, 2.5, 0.45);
  drives(kit, "fighter", 0.42, 1.9);
  // Fixed twin cannon barrels belong to each craft, including Medium LOD.
  for (const side of [-1, 1]) {
    major(kit, "armor", box([0.095, 0.11, 1.15],
      [side * FIGHTER_GUN_SEPARATION, FIGHTER_GUN_HEIGHT, FIGHTER_GUN_Z - 0.575]));
  }
  kit.pair("accent", s => deckMark(0.22, 1.0, [s * 2.2, 0.8, -1.3], [0, s * 0.7, 0]));
  return finish(kit);
}

function bomber(): HullGeometrySet {
  const kit = new ShipKit();
  shell(kit, [[0, 6.7], [-2.3, 3.9], [-5.6, 1], [-4.9, -4.3], [-2.5, -3], [0, -1.5], [2.5, -3], [4.9, -4.3], [5.6, 1], [2.3, 3.9]], 1.35, 0.2);
  pairMajor(kit, "armor", s => hullShell([[s * 1.1, 3.5], [s * 3.6, 5.1], [s * 4.8, 0.2], [s * 4.4, -2.8], [s * 1.3, -0.8]], 0.75, 1.2));
  bridge(kit, 0, 1.55, 2.2, 1.6, 2.5, 0.65);
  drives(kit, "bomber", 0.87, 4);
  weapons(kit, "bomber");
  for (const s of [-1, 1]) insignia(kit, s * 3.3, 2.04, 0.8, 0.48, 2);
  return finish(kit);
}

function fabricator(): HullGeometrySet {
  const kit = new ShipKit();
  shell(kit, [[-2, 7], [-4.8, 3], [-5.5, -9], [-3.8, -12], [3.8, -12], [5.5, -9], [4.8, 3], [2, 7]], 3.1, 0.4);
  for (const s of [-1, 1]) {
    // The open lifting frame and two forward claws identify the civilian ship.
    strut(kit, [s * 4.5, 2.1, 1], [s * 4.5, 2.1, 14.2], 1.3);
    strut(kit, [s * 4.5, 2.1, 14.2], [s * 2.8, 2.1, 16.4], 1.1, "armor");
    strut(kit, [s * 5, 2.8, -6], [s * 5, 8, -5], 0.8, "armor");
    strut(kit, [s * 5, 8, -5], [s * 2.8, 10, -5], 0.8, "armor");
    plate(kit, [3.2, 3.6, 5.2], [s * 6.7, 2.9, -2]);
    insignia(kit, s * 6.7, 4.74, -2, 0.8, 1);
  }
  strut(kit, [-2.8, 10, -5], [2.8, 10, -5], 0.8, "armor");
  plate(kit, [6.5, 0.8, 6.3], [0, 4, -3]);
  bridge(kit, 0, 3.5, -9, 4.2, 3, 1.3);
  drives(kit, "fabricator", 1.45, 4.8);
  weapons(kit, "fabricator");
  return finish(kit);
}

function escort(): HullGeometrySet {
  const kit = new ShipKit();
  shell(kit, [[0, 17], [-2.6, 12], [-3.7, -7], [-5.8, -14], [5.8, -14], [3.7, -7], [2.6, 12]], 4, 0.5);
  shell(kit, [[-1.5, 12], [-6.4, 10], [-9.3, -2], [-6.8, -6], [-2, 1], [2, 1], [6.8, -6], [9.3, -2], [6.4, 10], [1.5, 12]], 2.6, 2.4);
  pairMajor(kit, "armor", s => hullShell([[s * 1.2, 13], [s * 6.2, 9.5], [s * 7, 5], [s * 3, 3]], 0.8, 4.9));
  plate(kit, [4, 1.1, 13], [0, 4.5, 5]);
  bridge(kit, 0, 4.5, -5.5, 4.3, 6, 1.8);
  for (const s of [-1, 1]) insignia(kit, s * 3.9, 5.76, 8, 0.8, 1);
  drives(kit, "frigate", 1.75, 7);
  weapons(kit, "frigate");
  return finish(kit);
}

function flak(): HullGeometrySet {
  const kit = new ShipKit();
  // Transverse armored hammerhead, distinct from the pointed escort.
  shell(kit, [[-2.6, 18], [-3.8, 11], [-9.8, 8], [-10, -3.5], [-4.6, -7], [-4.5, -15], [4.5, -15], [4.6, -7], [10, -3.5], [9.8, 8], [3.8, 11], [2.6, 18]], 3.9, 0.5);
  plate(kit, [18.6, 1.6, 9], [0, 5.0, 5]);
  plate(kit, [5, 1.0, 8], [0, 4.3, 12.2]);
  pairMajor(kit, "armor", s => armorBlock([5.2, 1.0, 5], [s * 7.4, 3.5, -2]));
  // Shallow circular sensor array reads clearly in a tactical overhead view.
  kit.add("hull", cylinder(3.7, 3.3, 1.3, [0, 6.5, -5.5], 12));
  kit.add("armor", cylinder(3.2, 3.6, 0.5, [0, 7.3, -5.5], 12));
  kit.add("dark", cylinder(2.6, 2.6, 0.12, [0, 7.6, -5.5], 12));
  kit.add("accent", box([5.5, 0.15, 0.3], [0, 7.7, -5.5]));
  bridge(kit, 0, 4.4, -11.5, 3.6, 3, 1.2);
  for (const s of [-1, 1]) insignia(kit, s * 4.2, 5.84, 5.2, 1.1, 3);
  drives(kit, "flakFrigate", 1.8, 5.3);
  weapons(kit, "flakFrigate");
  return finish(kit);
}

function torpedo(): HullGeometrySet {
  const kit = new ShipKit();
  shell(kit, [[0, 9], [-2.6, 6], [-3.2, -13], [3.2, -13], [2.6, 6]], 3.6, 0.5);
  for (const s of [-1, 1]) {
    strut(kit, [0, 3, -4], [s * 7.2, 3, -4], 2.3);
    shell(kit, [[s * 3.8, 17.8], [s * 7.6, 16], [s * 9, 8], [s * 8.8, -6], [s * 4.3, -8]], 3.3, 2);
    // Long separate magazines create a forked bow with a visible central gap.
    plate(kit, [4.5, 1.4, 19], [s * 6.2, 5.3, 6.5]);
    for (const z of [-0.5, 4.2, 11.8, 14.6]) {
      kit.add("dark", deckMark(3.0, 1.9, [s * 6.2, 6.03, z]));
      kit.add("light", deckMark(1.9, 0.13, [s * 6.2, 6.06, z]));
    }
    insignia(kit, s * 7.9, 6.04, 7, 0.6, 2);
  }
  bridge(kit, 0, 4.1, -7.8, 4.7, 4.4, 1.5);
  drives(kit, "torpedoFrigate", 1.8, 7.5);
  weapons(kit, "torpedoFrigate");
  return finish(kit);
}

/** A family of exposed gun frames; larger variants gain radiator wings.
 * Scale is authored in existing local units and turret origins stay fixed.
 */
function artillery(shipClass: "artilleryFrigate" | "artilleryDestroyer" | "artilleryCruiser"): HullGeometrySet {
  const kit = new ShipKit();
  const factor = shipClass === "artilleryFrigate" ? 1 : shipClass === "artilleryDestroyer" ? 1.55 : 2.08;
  const top = turretDeckHeight(shipClass);
  const rear = SHIP_THRUSTERS[shipClass].rear;
  shell(kit, [[-2.6 * factor, 8 * factor], [-3.4 * factor, -9 * factor], [-5 * factor, rear + 4], [5 * factor, rear + 4], [3.4 * factor, -9 * factor], [2.6 * factor, 8 * factor]], 3.2 * factor, 0.5);
  const gunXs = SHIPS[shipClass].hardpoints.map(hp => hp.localX);
  for (const x of gunXs) {
    const z = SHIPS[shipClass].hardpoints[0]!.localZ;
    shell(kit, [[x - 1.7 * factor, 18.7 * factor], [x - 2.4 * factor, 11 * factor], [x - 2.4 * factor, -2 * factor], [x + 2.4 * factor, -2 * factor], [x + 2.4 * factor, 11 * factor], [x + 1.7 * factor, 18.7 * factor]], 2 * factor, top - 1.6 - 2 * factor);
    plate(kit, [3.8 * factor, 0.6 * factor, 8 * factor], [x, top - 1.3, z - 2 * factor]);
    for (const s of [-1, 1]) {
      major(kit, "armor", armorBlock([0.6 * factor, 0.8 * factor, 15 * factor], [x + s * 1.65 * factor, top - 0.3, 10.8 * factor]));
      kit.add("accent", deckMark(0.18 * factor, 12 * factor, [x + s * 1.65 * factor, top + 0.12 * factor, 11 * factor]));
    }
  }
  for (const s of [-1, 1]) {
    // Swept radiator wings have real cutouts between spars, not a wide deck.
    shell(kit, [[s * 3 * factor, -1 * factor], [s * 8.6 * factor, -4 * factor], [s * 8.2 * factor, -11 * factor], [s * 3 * factor, -8 * factor]], 0.7 * factor, 2.3 * factor);
    vents(kit, s * 5.6 * factor, 3 * factor, -6.6 * factor, 3.7 * factor, 4.7 * factor, 8);
    insignia(kit, s * 2.8 * factor, 3.8 * factor, -10 * factor, 0.6 * factor, gunXs.length);
  }
  bridge(kit, 0, 3.7 * factor, -11.5 * factor, 3.8 * factor, 3.5 * factor, 1.5 * factor);
  drives(kit, shipClass, 1.7 * factor / (factor > 1 ? 1.25 : 1), 5 * factor);
  weapons(kit, shipClass);
  return finish(kit);
}

function destroyer(): HullGeometrySet {
  const kit = new ShipKit();
  shell(kit, [[0, 30], [-5, 23], [-8.5, 14], [-14, 3], [-11.6, -8], [-6, -15], [-8, -25], [8, -25], [6, -15], [11.6, -8], [14, 3], [8.5, 14], [5, 23]], 5.1, 0.7);
  for (const s of [-1, 1]) {
    major(kit, "armor", hullShell([[s * 0.9, 26.5], [s * 7.7, 18.5], [s * 9.6, 7], [s * 3.2, 4]], 1.0, 6.0));
    plate(kit, [6.5, 1.2, 12], [s * 10, 4.9, -0.5]);
    insignia(kit, s * 4.5, 7.04, 17, 1.2, 2);
  }
  plate(kit, [4.4, 2.3, 22], [0, 6.1, 0]);
  bridge(kit, 0, 7.3, -9, 5.8, 8, 2.2);
  vents(kit, 0, 5.8, -20, 6, 6, 7);
  drives(kit, "destroyer", 2.1, 9);
  weapons(kit, "destroyer");
  return finish(kit);
}

function cruiser(): HullGeometrySet {
  const kit = new ShipKit();
  shell(kit, [[0, 36], [-6, 27], [-7, -21], [-10, -34], [10, -34], [7, -21], [6, 27]], 6.5, 0.7);
  for (const s of [-1, 1]) {
    // Three separated armored broadside teeth are readable at battle zoom.
    for (const [x, z, length, deck] of [[10, 19, 17, 9.7], [16, 3, 20, 7.3], [8, -15, 12, 8.7]]) {
      strut(kit, [s * 3.5, deck! - 2, z!], [s * x!, deck! - 2, z!], 3);
      shell(kit, [[s * (x! - 3.1), z! + length! / 2], [s * (x! + 3.3), z! + length! / 2 - 3], [s * (x! + 4), z! - length! / 2], [s * (x! - 3.5), z! - length! / 2 + 1]], 3.6, deck! - 4);
      plate(kit, [6.6, 1.0, length! * 0.86], [s * x!, deck! - 0.5, z!]);
      insignia(kit, s * x!, deck! + 0.03, z! - 3, 1.1, 3);
    }
  }
  const spineDeckY = 7.8;
  plate(kit, [7, 1.2, 34], [0, spineDeckY - 0.6, 1]);
  bridge(kit, 0, spineDeckY, -22, 7.5, 9, 3.1);
  vents(kit, 0, spineDeckY, 7, 3.5, 12, 10);
  drives(kit, "cruiser", 2.7, 12);
  weapons(kit, "cruiser");
  return finish(kit);
}

function carrier(): HullGeometrySet {
  const kit = new ShipKit();
  // Two long hulls around a completely open central launch corridor. The
  // transverse aft gantry and offset island distinguish it from a battleship.
  for (const s of [-1, 1]) {
    shell(kit, [[s * 8, 40], [s * 18, 34], [s * 32, 19], [s * 34, -15], [s * 24, -39], [s * 9, -42]], 4.4, 0.4);
    plate(kit, [10.5, 1, 56], [s * 16.5, 6.1, -2]);
    for (const z of [-21, -6, 9]) {
      plate(kit, [9, 1.2, 12], [s * 26, 5.4, z]);
      vents(kit, s * 26, 6.0, z, 6.7, 7.5, 8);
    }
    kit.add("dark", deckMark(6, 45, [s * 16.5, 6.64, -2]));
    for (const z of [-20, -12, -4, 4, 12, 20]) {
      kit.add("light", deckMark(0.26, 3.3, [s * 16.5, 6.69, z]));
      kit.add("accent", deckMark(0.32, 1.0, [s * 13.7, 6.68, z]));
    }
    insignia(kit, s * 21, 6.66, 25, 1.6, 1);
    kit.hangar(s * 15, 3.7, 31.3, 7, 2.9);
  }
  strut(kit, [-15, 2.5, -34], [15, 2.5, -34], 5);
  strut(kit, [-11, 5, -30], [-8, 13, -28], 1.5, "armor");
  strut(kit, [11, 5, -30], [8, 13, -28], 1.5, "armor");
  strut(kit, [-8, 13, -28], [8, 13, -28], 1.5, "armor");
  bridge(kit, -25, 6.6, -16, 7.4, 13, 3.7);
  drives(kit, "carrier", 2.5, 10);
  weapons(kit, "carrier");
  return finish(kit);
}

function battleship(): HullGeometrySet {
  const kit = new ShipKit();
  // A heavy split-armored wedge. The higher central citadel and six exposed
  // drives communicate mass without making the ship longer or wider.
  shell(kit, [[0, 56], [-7, 49], [-15.8, 31], [-19.5, 10], [-17.2, -10], [-22, -23], [-18, -41], [-13, -50], [13, -50], [18, -41], [22, -23], [17.2, -10], [19.5, 10], [15.8, 31], [7, 49]], 8.1, 0.6);
  for (const s of [-1, 1]) {
    major(kit, "armor", hullShell([[s * 0.7, 53], [s * 6, 46], [s * 13.2, 32], [s * 7.3, 29], [s * 1, 38]], 2.1, 8));
    // Separated sloping armor shoulders leave a dark spinal channel.
    for (const [x, z, width, length, top] of [[6, 34, 7, 14, 11.7], [9, 21, 9.5, 12, 12.3], [12.5, 7, 9, 13, 12.9], [16, -9, 7.5, 13, 8.3], [16.5, -27, 9, 14, 11.9]]) {
      plate(kit, [width!, 2.8, length!], [s * x!, top! - 1.4, z!]);
      insignia(kit, s * (x! - width! * 0.22), top! + 0.03, z! - length! * 0.2, 0.85, 3);
    }
    // Long dark radiator recesses break up the bulky sides.
    vents(kit, s * 18, 8.7, -20, 3.2, 6, 7);
  }
  plate(kit, [6.8, 3.1, 45], [0, 10.3, 4]);
  bridge(kit, 0, 11.9, -11.5, 9.2, 13, 4.1);
  plate(kit, [9, 1.3, 13], [0, 8.8, -35]);
  vents(kit, 0, 9.45, -35, 6.5, 8.5, 9);
  // A six-sided reactor brace gives the heavy hull a recognizable stern
  // profile, within the original beam and maximum mast height.
  const arch: Vec3[] = [[-20, 4, -43], [-20, 15, -43], [-10, 24, -43], [10, 24, -43], [20, 15, -43], [20, 4, -43]];
  for (let i = 1; i < arch.length; i += 1) strut(kit, arch[i - 1]!, arch[i]!, 1.6, "armor");
  drives(kit, "battleship", 3, 12);
  weapons(kit, "battleship");
  return finish(kit);
}

export function buildFleetHull(shipClass: ShipClass): HullGeometrySet {
  switch (shipClass) {
    case "fighter": return fighter();
    case "bomber": return bomber();
    case "fabricator": return fabricator();
    case "frigate": return escort();
    case "flakFrigate": return flak();
    case "torpedoFrigate": return torpedo();
    case "artilleryFrigate": case "artilleryDestroyer": case "artilleryCruiser": return artillery(shipClass);
    case "destroyer": return destroyer();
    case "cruiser": return cruiser();
    case "carrier": return carrier();
    case "battleship": return battleship();
  }
}
