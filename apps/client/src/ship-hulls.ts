import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { SHIPS, SHIP_TURRET_SCALES, type ShipClass, type WeaponTypeId } from "@space-rts/game-core";
import { BARBETTE_HEIGHT, SHIP_THRUSTERS, turretDeckHeight } from "./ship-layout";

/**
 * Procedural low-poly hulls and turrets.
 *
 * Every ship is assembled from six geometry layers that the batched renderer
 * draws as separate instanced meshes:
 *
 * - `hull`   main body, team tinted. The only layer drawn at Far LOD, so it
 *            must carry the silhouette on its own and stay cheap.
 * - `armor`  darker team-tinted plating, decks, towers, barbettes, pods.
 *            Drawn at Medium LOD, so structural masses live here.
 * - `dark`   near-black recesses, ribs, shrouds, masts, fins. Close LOD only.
 * - `accent` team-coloured glow strips and rings. Drawn even in large battles.
 * - `light`  white glow: window bands, bow stripes, hazard stripes, plaques,
 *            running lights. Close LOD only.
 * - `engine` additive exhaust cones.
 *
 * Coordinates are ship-local: +Z is the bow, +Y is up, +X is starboard.
 */

export interface HullGeometrySet {
  hull: THREE.BufferGeometry;
  armor: THREE.BufferGeometry;
  dark: THREE.BufferGeometry;
  accent: THREE.BufferGeometry;
  light: THREE.BufferGeometry;
  engine: THREE.BufferGeometry;
}

export interface TurretGeometrySet {
  mount: THREE.BufferGeometry;
  barrel: THREE.BufferGeometry;
  accent: THREE.BufferGeometry;
  dark: THREE.BufferGeometry;
}

export type Vec3 = readonly [number, number, number];
type Layer = keyof HullGeometrySet;

const HAZARD_ANGLE = 0.72;

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

export function extrudedShape(
  points: ReadonlyArray<readonly [number, number]>,
  height: number,
  y = 0,
  bevel = 0.35,
): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(points[0]![0], points[0]![1]);
  for (let index = 1; index < points.length; index += 1) shape.lineTo(points[index]![0], points[index]![1]);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    steps: 1,
    bevelEnabled: bevel > 0,
    bevelSegments: 1,
    bevelSize: bevel,
    bevelThickness: Math.min(bevel, height * 0.22),
    curveSegments: 1,
  });
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, y + height / 2, 0);
  geometry.computeVertexNormals();
  return geometry;
}

export function transformed(
  geometry: THREE.BufferGeometry,
  position: Vec3,
  rotation: Vec3 = [0, 0, 0],
  scale: Vec3 = [1, 1, 1],
): THREE.BufferGeometry {
  geometry.applyMatrix4(new THREE.Matrix4().compose(
    new THREE.Vector3(...position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)),
    new THREE.Vector3(...scale),
  ));
  return geometry;
}

export function box(size: Vec3, position: Vec3, rotation: Vec3 = [0, 0, 0]): THREE.BufferGeometry {
  return transformed(new THREE.BoxGeometry(...size), position, rotation);
}

/** Cylinder standing on Y. */
export function cylinder(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  position: Vec3,
  segments = 8,
  openEnded = false,
): THREE.BufferGeometry {
  return transformed(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments, 1, openEnded), position);
}

/** Cylinder lying along Z (a pipe or engine shroud). */
export function tube(radius: number, length: number, position: Vec3, segments = 8, openEnded = true): THREE.BufferGeometry {
  return transformed(
    new THREE.CylinderGeometry(radius, radius, length, segments, 1, openEnded),
    position,
    [Math.PI / 2, 0, 0],
  );
}

/** Thin open ring around Y, used for glowing barbette and engine rings. */
export function ring(radius: number, height: number, position: Vec3, segments = 8): THREE.BufferGeometry {
  return cylinder(radius, radius, height, position, segments, true);
}

export function cone(radius: number, length: number, position: Vec3, segments = 7): THREE.BufferGeometry {
  return transformed(new THREE.ConeGeometry(radius, length, segments, 1, true), position, [-Math.PI / 2, 0, 0]);
}

export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (parts.length === 0) {
    const empty = new THREE.BufferGeometry();
    empty.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
    empty.setAttribute("normal", new THREE.Float32BufferAttribute([], 3));
    empty.computeBoundingSphere();
    return empty;
  }
  const normalized = parts.map((part) => part.index ? part.toNonIndexed() : part);
  for (const part of normalized) part.deleteAttribute("uv");
  const geometry = mergeGeometries(normalized, false);
  if (!geometry) throw new Error("Could not merge ship geometry");
  for (let index = 0; index < parts.length; index += 1) {
    parts[index]!.dispose();
    if (normalized[index] !== parts[index]) normalized[index]!.dispose();
  }
  geometry.computeBoundingSphere();
  return geometry;
}

// ---------------------------------------------------------------------------
// Ship kit: reusable industrial parts that write into the six layers.
// ---------------------------------------------------------------------------

export class ShipKit {
  private readonly parts: Record<Layer, THREE.BufferGeometry[]> = {
    hull: [], armor: [], dark: [], accent: [], light: [], engine: [],
  };

  add(layer: Layer, ...geometries: THREE.BufferGeometry[]): this {
    this.parts[layer].push(...geometries);
    return this;
  }

  /** Mirrors a part across X by building it twice. */
  pair(layer: Layer, build: (side: number) => THREE.BufferGeometry): this {
    this.parts[layer].push(build(-1), build(1));
    return this;
  }

  build(scale = 1): HullGeometrySet {
    const set: HullGeometrySet = {
      hull: merge(this.parts.hull),
      armor: merge(this.parts.armor),
      dark: merge(this.parts.dark),
      accent: merge(this.parts.accent),
      light: merge(this.parts.light),
      engine: merge(this.parts.engine),
    };
    if (scale !== 1) {
      for (const geometry of Object.values(set)) {
        geometry.scale(scale, scale, scale);
        geometry.computeBoundingSphere();
      }
    }
    return set;
  }

  /**
   * Square barbette pedestal with a glowing ring; `top` is the turret mount
   * height. The pedestal sinks BARBETTE_HEIGHT into the deck beneath it.
   */
  barbette(x: number, top: number, z: number, radius: number): this {
    const size = radius * 2;
    this.add("armor", box([size, BARBETTE_HEIGHT, size], [x, top - BARBETTE_HEIGHT / 2, z]));
    this.add("accent", ring(radius * 0.98, 0.28, [x, top - 0.22, z]));
    return this;
  }

  /** Barbettes for every hardpoint of a ship class, using the shared deck heights. */
  barbettes(shipClass: ShipClass): this {
    for (const hardpoint of SHIPS[shipClass].hardpoints) {
      this.barbette(
        hardpoint.localX,
        turretDeckHeight(shipClass, hardpoint.localX, hardpoint.localZ, hardpoint.weaponTypeId),
        hardpoint.localZ,
        barbetteRadius(shipClass, hardpoint.weaponTypeId),
      );
    }
    return this;
  }

  /**
   * Stepped prow block on top of the keel: a chamfered nose with a centre
   * groove and white identification bands.
   */
  prow(tipZ: number, baseZ: number, halfWidth: number, keelTop: number, height: number, bandWidth: number): this {
    const length = tipZ - baseZ;
    const nose = halfWidth * 0.36;
    this.add("hull", extrudedShape(
      [[-nose, tipZ - 0.8], [-halfWidth, baseZ], [halfWidth, baseZ], [nose, tipZ - 0.8]],
      height,
      keelTop,
      0.4,
    ));
    const top = keelTop + height;
    this.add("dark", box([Math.max(0.5, halfWidth * 0.16), 0.16, length * 0.55], [0, top + 0.02, baseZ + length * 0.4]));
    this.bowBands(top + 0.08, baseZ + length * 0.7, bandWidth, 2, Math.max(1.6, length * 0.3));
    return this;
  }

  /** Stacked bridge tower with a white window band, an accent strip, and a mast. */
  tower(x: number, base: number, z: number, width: number, depth: number, height: number, mast = true): this {
    const upperWidth = width * 0.68;
    const upperDepth = depth * 0.72;
    const upperHeight = height * 0.62;
    const capHeight = Math.max(0.5, height * 0.28);
    this.add(
      "armor",
      box([width, height, depth], [x, base + height / 2, z]),
      box([upperWidth, upperHeight, upperDepth], [x, base + height + upperHeight / 2, z - depth * 0.06]),
      box([upperWidth * 0.62, capHeight, upperDepth * 0.7], [x, base + height + upperHeight + capHeight / 2, z]),
    );
    const windowY = base + height + upperHeight * 0.72;
    this.add(
      "light",
      box([upperWidth * 0.86, 0.34, 0.22], [x, windowY, z - depth * 0.06 + upperDepth / 2 + 0.06]),
    );
    this.add("accent", box([width * 0.94, 0.26, 0.28], [x, base + height * 0.8, z + depth / 2 + 0.08]));
    this.add(
      "dark",
      box([width * 0.3, 0.24, depth * 0.85], [x, base + height + 0.12, z]),
    );
    if (mast) {
      const mastBase = base + height + upperHeight + capHeight;
      this.add("dark", cylinder(0.16, 0.24, height * 0.9, [x + upperWidth * 0.25, mastBase + height * 0.45, z - upperDepth * 0.2], 5));
      this.add("light", box([0.44, 0.44, 0.44], [x + upperWidth * 0.25, mastBase + height * 0.9 + 0.2, z - upperDepth * 0.2]));
    }
    return this;
  }

  /** Engine block: armor housing, dark shrouds, accent rings, and exhaust cones. */
  engines(shipClass: ShipClass, radius: number, housing?: { width: number; height: number; depth: number }): this {
    const layout = SHIP_THRUSTERS[shipClass];
    const rear = layout.rear;
    if (housing) {
      this.add("armor", box([housing.width, housing.height, housing.depth], [0, layout.y, rear + housing.depth / 2 + 0.4]));
    }
    for (const x of layout.offsets) {
      this.add("dark", tube(radius, radius * 1.9, [x, layout.y, rear + radius * 0.95 + 0.1], 8));
      this.add("accent", tube(radius * 1.04, radius * 0.22, [x, layout.y, rear + 0.32], 8));
      this.add("engine", cone(radius * 0.8, radius * 2.6, [x, layout.y, rear - radius * 1.3]));
    }
    return this;
  }

  /** Lit deck trench: dark recess with white edge rails and a faint accent core. */
  trench(x: number, deck: number, z: number, width: number, length: number, core = true): this {
    this.add("dark", box([width, 0.5, length], [x, deck - 0.05, z]));
    this.add(
      "light",
      box([0.2, 0.2, length], [x - width / 2, deck + 0.12, z]),
      box([0.2, 0.2, length], [x + width / 2, deck + 0.12, z]),
    );
    if (core) this.add("accent", box([width * 0.22, 0.14, length * 0.9], [x, deck - 0.06 + 0.26, z]));
    return this;
  }

  /** Ribbed cargo or machinery module. */
  module(x: number, y: number, z: number, width: number, height: number, depth: number, ribs = 3): this {
    this.add("armor", box([width, height, depth], [x, y, z]));
    for (let rib = 0; rib < ribs; rib += 1) {
      const t = ribs === 1 ? 0 : (rib / (ribs - 1) - 0.5) * depth * 0.72;
      this.add("dark", box([width + 0.3, height * 0.78, 0.36], [x, y, z + t]));
    }
    return this;
  }

  /** Diagonal white hazard stripes on a dark plate. */
  hazard(x: number, y: number, z: number, width: number, depth: number, count = 4, rotation: Vec3 = [0, 0, 0]): this {
    const plate = new THREE.BoxGeometry(width, 0.16, depth);
    const parts: THREE.BufferGeometry[] = [];
    const spacing = width / count;
    for (let index = 0; index < count; index += 1) {
      const stripe = new THREE.BoxGeometry(spacing * 0.34, 0.2, depth * 1.35);
      stripe.rotateY(HAZARD_ANGLE);
      stripe.translate((index - (count - 1) / 2) * spacing, 0.1, 0);
      parts.push(stripe);
    }
    const stripes = mergeGeometries(parts.map((part) => part.toNonIndexed()), false)!;
    this.add("dark", transformed(plate, [x, y, z], rotation));
    this.add("light", transformed(stripes, [x, y, z], rotation));
    return this;
  }

  /** Small ID plaque: dark plate with two white text bars. */
  plaque(x: number, y: number, z: number, width: number, depth: number, rotation: Vec3 = [0, 0, 0]): this {
    this.add("dark", box([width, 0.16, depth], [x, y, z], rotation));
    const bars = mergeGeometries([
      new THREE.BoxGeometry(width * 0.62, 0.2, depth * 0.16).translate(-width * 0.08, 0.1, depth * 0.22),
      new THREE.BoxGeometry(width * 0.4, 0.2, depth * 0.16).translate(-width * 0.19, 0.1, -depth * 0.18),
    ].map((part) => part.toNonIndexed()), false)!;
    this.add("light", transformed(bars, [x, y, z], rotation));
    return this;
  }

  /** White bow identification bands across the deck. */
  bowBands(y: number, z: number, width: number, count = 2, spacing = 1.7): this {
    for (let index = 0; index < count; index += 1) {
      this.add("light", box([width - index * width * 0.12, 0.18, 0.7], [0, y, z - index * spacing]));
    }
    return this;
  }

  /** Vertical radiator fins beside the engine block. */
  fins(x: number, y: number, z: number, count: number, height: number, depth: number, spacing: number): this {
    for (let index = 0; index < count; index += 1) {
      this.add("dark", box([0.24, height, depth], [x, y, z + (index - (count - 1) / 2) * spacing]));
    }
    return this;
  }

  /** Sensor mast with a lit tip. */
  mast(x: number, base: number, z: number, height: number): this {
    this.add("dark", cylinder(0.14, 0.22, height, [x, base + height / 2, z], 5));
    this.add("light", box([0.4, 0.4, 0.4], [x, base + height + 0.18, z]));
    return this;
  }

  /** Dark hangar mouth with an accent frame. */
  hangar(x: number, y: number, z: number, width: number, height: number, rotation: Vec3 = [0, 0, 0]): this {
    this.add("dark", box([width, height, 0.6], [x, y, z], rotation));
    this.add(
      "accent",
      box([width + 0.4, 0.24, 0.3], [x, y + height / 2 + 0.1, z], rotation),
      box([width + 0.4, 0.24, 0.3], [x, y - height / 2 - 0.1, z], rotation),
    );
    return this;
  }

  /** Straight glow strip along Z. */
  stripe(layer: Layer, x: number, y: number, z: number, width: number, length: number, height = 0.22): this {
    this.add(layer, box([width, height, length], [x, y, z]));
    return this;
  }

  /** Dark panel groove across a deck. */
  groove(x: number, y: number, z: number, width: number): this {
    this.add("dark", box([width, 0.12, 0.22], [x, y, z]));
    return this;
  }

  /** Small running light. */
  lamp(x: number, y: number, z: number, size = 0.5): this {
    this.add("light", box([size, size * 0.6, size * 1.2], [x, y, z]));
    return this;
  }
}

// ---------------------------------------------------------------------------
// Barbette radii per weapon (in ship-local units, before turret scale).
// ---------------------------------------------------------------------------

function barbetteRadius(shipClass: ShipClass, weaponTypeId: WeaponTypeId): number {
  const scale = SHIP_TURRET_SCALES[shipClass];
  switch (weaponTypeId) {
    case "pointDefense": return 2.3 * scale;
    case "autocannon": return 2.4 * scale;
    case "flakCannon": return 2.7 * scale;
    case "plasma": return 2.8 * scale;
    case "beam": return 2.8 * scale;
    case "heavyRail": return 3.0 * scale;
    case "torpedo": return 3.1 * scale;
    case "lightArtillery": return 3.1 * scale;
    case "siegeArtillery": return 3.4 * scale;
    case "strategicArtillery": return 3.8 * scale;
  }
}

// ---------------------------------------------------------------------------
// Hull builders
// ---------------------------------------------------------------------------

function fighterGeometry(): HullGeometrySet {
  // Designed at 1/0.32 scale so the small craft keeps sensible detail sizes.
  const kit = new ShipKit();
  kit.add(
    "hull",
    extrudedShape([[0, 13], [-2.6, 6], [-2.2, -8], [0, -11], [2.2, -8], [2.6, 6]], 2.6, 0.6, 0.3),
    extrudedShape([[-2, 5], [-10.8, 0.5], [-9.2, -5.2], [-2.1, -2]], 1.05, 0.1, 0.16),
    extrudedShape([[2, 5], [10.8, 0.5], [9.2, -5.2], [2.1, -2]], 1.05, 0.1, 0.16),
  );
  kit.add(
    "armor",
    box([1.7, 1.3, 9], [0, 3.6, -0.5]),
    box([2.0, 1.2, 4.2], [0, 3.7, 6]),
    cylinder(1.0, 1.15, 1.2, [0, 4.4, 6.5], 8),
  );
  kit.pair("armor", (side) => box([1.4, 1.6, 5.6], [side * 1.6, 1.4, -7.4]));
  kit.pair("armor", (side) => box([1.3, 1.0, 3.6], [side * 9.3, 1.4, -2.4]));
  kit.add(
    "dark",
    transformed(new THREE.OctahedronGeometry(2.1, 0), [0, 3.9, 1.6], [0.12, 0, 0], [0.9, 0.62, 1.3]),
    box([4.4, 0.5, 1.2], [0, 1.8, -4.6]),
  );
  kit.pair("dark", (side) => tube(1.05, 2.2, [side * 1.6, 1.4, -10.4], 6));
  kit.pair("dark", (side) => box([5.2, 0.14, 0.22], [side * 5.6, 1.72, -1.4], [0, side * -0.42, 0]));
  kit.add("accent", box([0.4, 0.26, 6.5], [0, 4.35, -1]));
  kit.pair("accent", (side) => box([5.4, 0.3, 0.42], [side * 5.4, 1.5, -0.2], [0, side * 0.42, 0]));
  kit.pair("accent", (side) => tube(1.1, 0.4, [side * 1.6, 1.4, -11.3], 6));
  kit.add("light", box([2.2, 0.24, 0.7], [0, 3.32, 10.2]));
  kit.pair("light", (side) => box([0.5, 0.4, 0.75], [side * 9.3, 1.95, -3.6]));
  kit.pair("engine", (side) => cone(0.95, 2.8, [side * 1.6, 1.4, -12.6], 6));
  return kit.build(0.32);
}

function bomberGeometry(): HullGeometrySet {
  // Designed at 1/0.42 scale. Torpedo pylons sit on the forward wing roots.
  const kit = new ShipKit();
  kit.add(
    "hull",
    extrudedShape([[0, 16], [-4.5, 9], [-5, -9], [0, -13], [5, -9], [4.5, 9]], 3.6, 1.0, 0.42),
    extrudedShape([[-3.2, 8], [-13.5, 2], [-12, -5.5], [-5, -7], [-3.8, -1]], 1.8, 0.4, 0.25),
    extrudedShape([[3.2, 8], [13.5, 2], [12, -5.5], [5, -7], [3.8, -1]], 1.8, 0.4, 0.25),
  );
  kit.add("armor", box([3.2, 1.6, 12], [0, 5.2, 0]), box([2.8, 1.4, 3.6], [0, 6.2, 5]));
  kit.pair("armor", (side) => box([3.6, 3.4, 13], [side * 7.6, 2.6, -3]));
  kit.pair("armor", (side) => box([3.2, 2.0, 6], [side * 6.67, 4.6, 9.5]));
  kit.pair("armor", (side) => box([3.6, 1.5, 3.6], [side * 6.67, 5.65, 10]));
  kit.pair("accent", (side) => ring(1.55, 0.3, [side * 6.67, 6.2, 10]));
  kit.add("dark", transformed(new THREE.OctahedronGeometry(2.6, 0), [0, 7.2, 6.5], [0.1, 0, 0], [0.95, 0.66, 1.25]));
  kit.pair("dark", (side) => tube(1.65, 3.2, [side * 7.6, 1.6, -10.8], 7));
  for (const z of [-6, -2.5, 1]) kit.pair("dark", (side) => box([3.9, 2.6, 0.36], [side * 7.6, 2.6, z]));
  kit.add("accent", box([0.6, 0.26, 10], [0, 6.05, 0]));
  kit.pair("accent", (side) => box([0.5, 0.3, 8], [side * 7.6, 4.45, -3]));
  kit.add("light", box([3.0, 0.22, 0.7], [0, 4.75, 13]), box([2.6, 0.22, 0.7], [0, 4.75, 11.3]));
  kit.pair("light", (side) => box([1.2, 0.2, 0.2], [side * 6.67, 6.45, 8.0]));
  kit.pair("light", (side) => box([0.65, 0.45, 1.0], [side * 8.9, 4.4, -9.2]));
  kit.hazard(0, 6.05, -4.5, 3.0, 1.2, 3);
  kit.pair("engine", (side) => cone(1.55, 4.2, [side * 7.6, 1.2, -13.2], 7));
  return kit.build(0.42);
}

function fabricatorGeometry(): HullGeometrySet {
  // Industrial tug: forward manipulator arms, ribbed cargo modules, rear bridge.
  const kit = new ShipKit();
  kit.add(
    "hull",
    extrudedShape([[-2.1, 10], [-5, 7], [-5.5, -7], [-3.5, -11.5], [3.5, -11.5], [5.5, -7], [5, 7], [2.1, 10]], 4.5, 0.6, 0.5),
  );
  kit.add("armor", box([11.5, 0.9, 0.9], [0, 6.0, 7.2]));
  kit.pair("armor", (side) => box([1.4, 1.4, 8.5], [side * 4.6, 3.8, 11], [0, side * -0.12, 0]));
  kit.pair("armor", (side) => box([2.2, 0.8, 1.6], [side * 4.0, 3.8, 15.4]));
  kit.pair("armor", (side) => box([1.2, 0.5, 2.0], [side * 3.4, 3.8, 16.4], [0, side * 0.5, 0]));
  kit.module(-6.6, 3.2, -1, 3.2, 3.2, 7.5, 3);
  kit.module(6.6, 3.2, -1, 3.2, 3.2, 7.5, 3);
  kit.tower(0, 5.1, -7.4, 4.2, 3.2, 1.9, true);
  kit.barbettes("fabricator");
  kit.engines("fabricator", 1.5, { width: 9.5, height: 3.8, depth: 3.5 });
  kit.trench(0, 5.1, 1.5, 1.6, 7, false);
  kit.pair("accent", (side) => box([0.5, 0.3, 6.5], [side * 4.6, 4.55, 11], [0, side * -0.12, 0]));
  kit.pair("light", (side) => box([0.6, 0.6, 0.6], [side * 4.2, 3.8, 15.6]));
  kit.hazard(-6.6, 4.9, -1, 3.0, 1.4, 3);
  kit.hazard(6.6, 4.9, -1, 3.0, 1.4, 3);
  kit.bowBands(5.15, 8.4, 6, 2, 1.4);
  kit.plaque(2.2, 5.15, 4.2, 1.8, 1.1);
  kit.fins(-5.9, 2.4, -12.2, 2, 2.4, 2.2, 1.6);
  kit.fins(5.9, 2.4, -12.2, 2, 2.4, 2.2, 1.6);
  return kit.build();
}

function frigateHull(kit: ShipKit, shipClass: ShipClass, points: ReadonlyArray<readonly [number, number]>): void {
  kit.add("hull", extrudedShape(points, 4.4, 0.6, 0.5));
  kit.engines(shipClass, 1.75, { width: 12, height: 4.2, depth: 5 });
  kit.fins(-6.6, 2.6, -14.4, 3, 2.6, 2.4, 1.7);
  kit.fins(6.6, 2.6, -14.4, 3, 2.6, 2.4, 1.7);
  kit.hazard(0, 4.75, -13.4, 6, 1.2, 5);
}

function frigateGeometry(): HullGeometrySet {
  const kit = new ShipKit();
  frigateHull(kit, "frigate", [[-2.1, 17], [-5, 13], [-6, -9], [-4, -15], [4, -15], [6, -9], [5, 13], [2.1, 17]]);
  kit.add("armor", box([13, 1.6, 9], [0, 5.6, 8]));
  kit.pair("armor", (side) => box([4, 2.4, 7], [side * 7.5, 3.4, -1]));
  kit.tower(0, 5.0, -6.5, 5, 4, 2.6);
  kit.barbettes("frigate");
  kit.trench(0, 6.4, 8, 1.6, 7);
  for (const z of [-3.2, -1, 1.2]) kit.pair("dark", (side) => box([4.4, 1.9, 0.34], [side * 7.5, 3.4, z]));
  kit.pair("accent", (side) => box([0.5, 0.28, 5.5], [side * 7.5, 4.65, -1]));
  kit.add("accent", box([0.5, 0.26, 6], [0, 5.15, 0.5]));
  kit.prow(16.6, 11.5, 4.4, 5.0, 1.1, 5);
  kit.plaque(-7.5, 4.65, -1, 2.0, 1.2);
  kit.pair("light", (side) => box([0.5, 0.4, 1.0], [side * 9.3, 3.6, -1]));
  return kit.build();
}

function flakFrigateGeometry(): HullGeometrySet {
  const kit = new ShipKit();
  frigateHull(kit, "flakFrigate", [[-2.5, 18], [-6, 13], [-7, -9], [-4.5, -15], [4.5, -15], [7, -9], [6, 13], [2.5, 18]]);
  kit.add("armor", box([16, 1.6, 8.5], [0, 5.6, 6.5]));
  kit.pair("armor", (side) => box([4.2, 2.4, 7], [side * 8, 3.4, -2]));
  kit.tower(0, 5.0, -8.5, 5, 4, 2.6, false);
  // Phased array radar panel behind the bridge.
  kit.add("dark", box([4.8, 2.6, 0.5], [0, 10.4, -11.2]), cylinder(0.3, 0.4, 2.4, [0, 8.9, -11.2], 6));
  kit.add("accent", box([4.2, 0.3, 0.3], [0, 10.4, -10.85]));
  kit.add("light", box([0.5, 0.5, 0.5], [0, 12.0, -11.2]));
  kit.barbettes("flakFrigate");
  for (const z of [-4.2, -2, 0.2]) kit.pair("dark", (side) => box([4.6, 1.9, 0.34], [side * 8, 3.4, z]));
  kit.pair("accent", (side) => box([0.5, 0.28, 5.5], [side * 8, 4.65, -2]));
  kit.prow(17.6, 11, 5.2, 5.0, 1.1, 6);
  kit.hazard(-8, 4.65, -2, 2.6, 1.0, 3);
  kit.plaque(8, 4.65, -2, 2.0, 1.2);
  kit.pair("light", (side) => box([0.5, 0.4, 1.0], [side * 10, 3.6, -2]));
  return kit.build();
}

function torpedoFrigateGeometry(): HullGeometrySet {
  const kit = new ShipKit();
  frigateHull(kit, "torpedoFrigate", [[-2.1, 18], [-5, 14], [-6, -10], [-4, -16], [4, -16], [6, -10], [5, 14], [2.1, 18]]);
  // Side launcher racks carrying the four torpedo mounts.
  kit.pair("armor", (side) => box([4.6, 2.6, 13.5], [side * 6.4, 4.9, 5.5]));
  kit.pair("armor", (side) => box([4.2, 2.2, 5], [side * 7.2, 3.3, -5]));
  kit.add("armor", box([5, 1.2, 12], [0, 5.5, 5]));
  kit.tower(0, 5.0, -9.5, 5, 4, 2.6);
  kit.barbettes("torpedoFrigate");
  // Torpedo tube cells on the rack fronts.
  for (const x of [-1.2, 0, 1.2]) {
    kit.pair("dark", (side) => box([0.9, 0.9, 0.5], [side * 6.4 + x, 4.9, 12.3]));
  }
  kit.pair("accent", (side) => box([4.4, 0.24, 0.3], [side * 6.4, 5.7, 12.3]));
  for (const z of [-6.5, -4.5]) kit.pair("dark", (side) => box([4.6, 1.7, 0.34], [side * 7.2, 3.3, z]));
  kit.add("accent", box([0.5, 0.26, 10], [0, 6.15, 5]));
  kit.hazard(-6.4, 6.25, 5.5, 3.2, 1.2, 4);
  kit.hazard(6.4, 6.25, 5.5, 3.2, 1.2, 4);
  kit.prow(17.6, 12.5, 4.4, 5.0, 1.1, 5);
  kit.plaque(0, 6.15, -1.5, 2.0, 1.2);
  kit.pair("light", (side) => box([0.5, 0.4, 1.0], [side * 9.3, 3.5, -5]));
  return kit.build();
}

function artilleryFrigateGeometry(): HullGeometrySet {
  const kit = new ShipKit();
  frigateHull(kit, "artilleryFrigate", [[-1.9, 19], [-4.5, 14], [-5.5, -9], [-3.5, -16], [3.5, -16], [5.5, -9], [4.5, 14], [1.9, 19]]);
  // Gun cradle with recoil rails and stabiliser outriggers.
  kit.add("armor", box([6.5, 2.2, 10], [0, 5.9, 7]), box([8.5, 3.2, 5], [0, 5.4, -13]));
  kit.pair("armor", (side) => box([0.9, 0.9, 13], [side * 3.6, 6.3, 11]));
  kit.pair("armor", (side) => box([2.8, 2.2, 8], [side * 7.4, 3.2, -4]));
  kit.tower(0, 5.0, -8.5, 4.6, 3.6, 2.4);
  kit.barbettes("artilleryFrigate");
  for (const z of [-6.5, -4, -1.5]) kit.pair("dark", (side) => box([3.2, 1.7, 0.34], [side * 7.4, 3.2, z]));
  kit.pair("accent", (side) => box([0.5, 0.28, 10], [side * 3.6, 6.8, 11]));
  kit.hazard(-4.6, 5.15, 7, 2.2, 3.4, 3);
  kit.hazard(4.6, 5.15, 7, 2.2, 3.4, 3);
  kit.prow(18.6, 12.5, 3.9, 5.0, 1.1, 4.4);
  kit.plaque(-7.4, 4.35, -4, 2.0, 1.2);
  kit.add("dark", box([7.5, 0.4, 0.4], [0, 7.2, -13]), box([7.5, 0.4, 0.4], [0, 6.2, -15.3]));
  kit.pair("light", (side) => box([0.5, 0.4, 1.0], [side * 9.0, 3.4, -4]));
  return kit.build();
}

function destroyerHull(kit: ShipKit, shipClass: ShipClass, points: ReadonlyArray<readonly [number, number]>): void {
  kit.add("hull", extrudedShape(points, 5.6, 0.8, 0.7));
  kit.engines(shipClass, 2.2, { width: 24, height: 6, depth: 7 });
  kit.fins(-13, 3.8, -26, 3, 4, 3.2, 2.2);
  kit.fins(13, 3.8, -26, 3, 4, 3.2, 2.2);
  kit.hazard(0, 6.95, -24.5, 10, 1.4, 7);
}

function destroyerGeometry(): HullGeometrySet {
  const kit = new ShipKit();
  destroyerHull(kit, "destroyer", [[-3.4, 30], [-8, 22], [-10, -14], [-7, -24], [7, -24], [10, -14], [8, 22], [3.4, 30]]);
  kit.add("armor", box([18, 2.0, 12], [0, 7.4, 12]), box([4.5, 1.4, 16], [0, 7.1, -2]));
  kit.pair("armor", (side) => box([6, 3.2, 10], [side * 11, 4.6, 2]));
  kit.pair("armor", (side) => box([5, 2.6, 7], [side * 10, 4.2, -6]));
  kit.tower(0, 6.4, -12.5, 9, 8, 3.4);
  kit.module(-9.4, 3.4, 16, 2.2, 2.8, 14, 3);
  kit.module(9.4, 3.4, 16, 2.2, 2.8, 14, 3);
  kit.barbettes("destroyer");
  kit.trench(0, 7.8, -2, 1.8, 13);
  for (const z of [-1.5, 1.5, 4.5]) kit.pair("dark", (side) => box([6.4, 2.5, 0.36], [side * 11, 4.6, z]));
  kit.pair("dark", (side) => box([5.4, 2.0, 0.36], [side * 10, 4.2, -7.5]));
  kit.pair("accent", (side) => box([0.6, 0.3, 8], [side * 11, 6.25, 2]));
  kit.pair("accent", (side) => box([0.6, 0.3, 5], [side * 10, 5.55, -6]));
  kit.prow(29.6, 19, 7.2, 6.4, 1.5, 8);
  kit.groove(0, 6.45, 18, 15);
  kit.groove(0, 8.45, 8, 16);
  kit.plaque(-11, 6.25, -1, 3.0, 1.6);
  kit.hazard(11, 6.25, 6, 3.4, 1.4, 4);
  kit.pair("light", (side) => box([0.6, 0.5, 1.4], [side * 13.5, 4.8, 2]));
  kit.mast(-3.2, 8.4, -5, 5.5);
  return kit.build();
}

function artilleryDestroyerGeometry(): HullGeometrySet {
  const kit = new ShipKit();
  destroyerHull(kit, "artilleryDestroyer", [[-3.1, 29], [-7.5, 21], [-9.5, -13], [-6.5, -23], [6.5, -23], [9.5, -13], [7.5, 21], [3.1, 29]]);
  // Twin siege gun cradle deck with bracing beams and a heavy aft counter-mass.
  kit.add("armor", box([16, 2.4, 12], [0, 7.6, 12]), box([14, 5, 8], [0, 6.0, -14]));
  kit.pair("armor", (side) => box([1.1, 1.1, 18], [side * 9.2, 7.9, 12]));
  kit.pair("armor", (side) => box([4, 3, 9], [side * 12, 4, -5]));
  kit.tower(0, 8.5, -13.5, 7, 5, 2.4);
  kit.module(-9, 3.4, 15, 2.2, 2.8, 14, 3);
  kit.module(9, 3.4, 15, 2.2, 2.8, 14, 3);
  kit.barbettes("artilleryDestroyer");
  for (const z of [-17, -14, -11]) kit.add("dark", box([14.4, 3.9, 0.4], [0, 6.0, z]));
  for (const z of [-8, -5, -2]) kit.pair("dark", (side) => box([4.4, 2.3, 0.36], [side * 12, 4, z]));
  kit.pair("accent", (side) => box([0.6, 0.3, 14], [side * 9.2, 8.55, 12]));
  kit.add("accent", box([0.7, 0.3, 12], [0, 6.5, 0]));
  kit.pair("dark", (side) => box([1.6, 1.6, 6], [side * 3.4, 7.6, 3]));
  kit.hazard(-9.2, 8.55, 5, 1.6, 2.6, 3);
  kit.hazard(9.2, 8.55, 5, 1.6, 2.6, 3);
  kit.hazard(0, 8.9, -17.5, 10, 1.4, 6);
  kit.prow(28.6, 18.5, 6.6, 6.4, 1.5, 7.5);
  kit.plaque(-12, 5.6, -5, 2.6, 1.6);
  kit.pair("light", (side) => box([0.6, 0.5, 1.4], [side * 14.2, 4.5, -5]));
  kit.mast(3.4, 8.5, -10.5, 5.5);
  return kit.build();
}

function cruiserHull(kit: ShipKit, shipClass: ShipClass, points: ReadonlyArray<readonly [number, number]>): void {
  kit.add("hull", extrudedShape(points, 7, 1, 0.8));
  kit.engines(shipClass, 2.7, { width: 30, height: 7.5, depth: 9 });
  kit.fins(-16.5, 4.5, -37, 4, 5, 4, 2.6);
  kit.fins(16.5, 4.5, -37, 4, 5, 4, 2.6);
  kit.hazard(0, 8.3, -35.5, 14, 1.6, 8);
}

function cruiserGeometry(): HullGeometrySet {
  const kit = new ShipKit();
  cruiserHull(kit, "cruiser", [[-5.0, 36], [-12, 28], [-13, -22], [-9, -34], [9, -34], [13, -22], [12, 28], [5.0, 36]]);
  kit.add("hull", extrudedShape([[-3.4, 28], [-8, 22], [-9, -22], [-6, -30], [6, -30], [9, -22], [8, 22], [3.4, 28]], 1.6, 8, 0.4));
  // Forward gun deck, raised midship spine with a lit trench, long broadside
  // sponsons, aft torpedo deck, and a tall bridge tower.
  kit.add(
    "armor",
    box([24, 2.4, 14], [0, 9.2, 20]),
    box([10, 2.6, 22], [0, 9.3, 2]),
    box([22, 2.2, 8], [0, 9.1, -12]),
    box([18, 1.6, 6], [0, 8.6, -18]),
  );
  kit.pair("armor", (side) => box([8, 4, 30], [side * 16, 6, 4]));
  kit.module(-8.5, 9.6, 8, 5, 3, 9, 4);
  kit.module(8.5, 9.6, 8, 5, 3, 9, 4);
  kit.tower(0, 8.0, -26, 12, 7, 4);
  kit.module(-12.6, 4.6, 18, 2.6, 3.2, 20, 3);
  kit.module(12.6, 4.6, 18, 2.6, 3.2, 20, 3);
  kit.barbettes("cruiser");
  kit.trench(0, 10.6, 2, 2.4, 19);
  for (const z of [-8, -4, 12, 16]) kit.pair("dark", (side) => box([8.4, 3.2, 0.4], [side * 16, 6, z]));
  kit.pair("accent", (side) => box([0.7, 0.3, 26], [side * 16, 8.15, 4]));
  kit.pair("accent", (side) => box([0.7, 0.3, 6], [side * 7, 10.35, -12]));
  kit.hangar(-7, 9.1, -8.0, 4.5, 1.6);
  kit.hangar(7, 9.1, -8.0, 4.5, 1.6);
  kit.prow(35.6, 27.5, 10.6, 8.0, 2.0, 12);
  kit.groove(0, 10.45, 16, 20);
  kit.plaque(-16, 8.15, -6, 4, 2.2);
  kit.hazard(16, 8.15, -6, 4, 1.8, 5);
  kit.hazard(-8.5, 11.2, 8, 3.6, 1.4, 4);
  for (const z of [-10, -2, 6, 14]) kit.pair("light", (side) => box([0.5, 0.36, 1.2], [side * 19.6, 8.15, z]));
  kit.mast(-4.5, 9.4, -20, 7);
  return kit.build();
}

function artilleryCruiserGeometry(): HullGeometrySet {
  const kit = new ShipKit();
  cruiserHull(kit, "artilleryCruiser", [[-4.6, 38], [-11, 30], [-13, -24], [-9, -36], [9, -36], [13, -24], [11, 30], [4.6, 38]]);
  // Twin strategic guns on a braced gantry deck, heavy recoil mass aft.
  kit.add(
    "armor",
    box([26, 3, 18], [0, 9.5, 20]),
    box([22, 6, 12], [0, 7, -16]),
    box([8, 2.2, 22], [0, 9.1, 0]),
  );
  kit.pair("armor", (side) => box([1.4, 1.4, 26], [side * 13.8, 9.8, 16]));
  kit.pair("armor", (side) => box([1.4, 1.4, 26], [side * 4.6, 12.2, 14]));
  kit.pair("armor", (side) => box([5, 4, 14], [side * 16, 5, -4]));
  kit.tower(0, 10.0, -20, 9, 6, 3);
  kit.module(-12.2, 4.6, 16, 2.6, 3.2, 24, 4);
  kit.module(12.2, 4.6, 16, 2.6, 3.2, 24, 4);
  kit.barbettes("artilleryCruiser");
  for (const z of [-20, -16, -12]) kit.add("dark", box([22.4, 4.8, 0.44], [0, 7, z]));
  for (const z of [-9, -5, -1, 3]) kit.pair("dark", (side) => box([5.4, 3.2, 0.4], [side * 16, 5, z]));
  kit.pair("dark", (side) => box([2, 2, 8], [side * 9, 12.3, 12]));
  kit.pair("accent", (side) => box([0.7, 0.3, 22], [side * 13.8, 10.6, 16]));
  kit.add("accent", box([0.8, 0.3, 18], [0, 10.35, 0]));
  kit.hazard(-13.8, 10.7, 4, 1.8, 3, 3);
  kit.hazard(13.8, 10.7, 4, 1.8, 3, 3);
  kit.hazard(0, 10.1, -21.5, 16, 1.6, 8);
  kit.prow(37.6, 29.5, 9.6, 8.0, 2.0, 11);
  kit.plaque(-16, 7.1, -4, 3.6, 2.2);
  kit.plaque(0, 10.25, 6, 3.6, 2.2);
  kit.pair("light", (side) => box([0.6, 0.5, 1.6], [side * 18.7, 5.6, -4]));
  kit.mast(4, 11.8, -13, 7);
  return kit.build();
}

function carrierGeometry(): HullGeometrySet {
  const kit = new ShipKit();
  // Central keel with a lit flight trench, twin side decks carrying the
  // weapons, hangar mouths on the bow faces, and an offset aft island.
  kit.add("hull", extrudedShape([[-3.4, 40], [-8, 32], [-9, -30], [-6, -42], [6, -42], [9, -30], [8, 32], [3.4, 40]], 8, 1, 0.8));
  kit.pair("hull", (side) => extrudedShape(
    side < 0
      ? [[-9, 30], [-32, 26], [-34, -26], [-24, -38], [-9, -30]]
      : [[9, 30], [32, 26], [34, -26], [24, -38], [9, -30]],
    5,
    1.5,
    0.6,
  ));
  kit.engines("carrier", 2.4, { width: 40, height: 8, depth: 8 });
  kit.fins(-21, 5, -42, 4, 5.5, 4, 2.6);
  kit.fins(21, 5, -42, 4, 5.5, 4, 2.6);
  kit.pair("armor", (side) => box([22, 0.9, 54], [side * 21.5, 6.95, -2]));
  kit.pair("armor", (side) => box([6, 3.2, 8], [side * 30, 5.2, 24]));
  kit.add("armor", box([12, 1.6, 60], [0, 9.6, -2]));
  kit.tower(0, 10.4, -28, 10, 9, 4);
  kit.tower(0, 10.4, -12, 5, 4, 2, false);
  kit.barbettes("carrier");
  kit.trench(0, 10.4, 4, 5, 46);
  kit.hangar(-21, 4.4, 27.2, 12, 3.2);
  kit.hangar(21, 4.4, 27.2, 12, 3.2);
  for (const z of [-24, -12, 0, 12, 24]) kit.pair("light", (side) => box([0.5, 0.36, 1.6], [side * 31.4, 7.5, z]));
  kit.pair("dark", (side) => box([0.22, 0.14, 50], [side * 30.4, 7.45, -2]));
  kit.pair("dark", (side) => box([0.22, 0.14, 50], [side * 12.4, 7.45, -2]));
  kit.pair("accent", (side) => box([0.6, 0.3, 46], [side * 27, 7.5, -4]));
  kit.hazard(-21, 7.5, 22, 8, 1.6, 6);
  kit.hazard(21, 7.5, 22, 8, 1.6, 6);
  kit.hazard(0, 9.1, -40.5, 18, 1.6, 9);
  kit.prow(39.6, 31, 7.2, 9.0, 2.0, 8);
  kit.plaque(-21, 7.5, -30, 4.5, 2.4);
  kit.plaque(21, 7.5, -30, 4.5, 2.4);
  kit.mast(4, 14.4, -23, 8);
  return kit.build();
}

function battleshipGeometry(): HullGeometrySet {
  const kit = new ShipKit();
  // Tiered fore decks with superfiring rail barbettes, broadside sponsons,
  // twin-tower midship citadel, and an aft beam deck.
  kit.add(
    "hull",
    extrudedShape([[-5.9, 56], [-14, 40], [-18, -28], [-12, -50], [12, -50], [18, -28], [14, 40], [5.9, 56]], 9, 1, 1),
    extrudedShape([[-4.2, 42], [-10, 30], [-11, -30], [-8, -42], [8, -42], [11, -30], [10, 30], [4.2, 42]], 2.4, 10, 0.6),
  );
  kit.engines("battleship", 2.9, { width: 42, height: 9, depth: 10 });
  kit.fins(-22.5, 5.5, -50, 4, 6, 4.5, 2.8);
  kit.fins(22.5, 5.5, -50, 4, 6, 4.5, 2.8);
  kit.add(
    "armor",
    box([14, 2.4, 14], [0, 11.2, 34]),
    box([22, 3.0, 14], [0, 11.5, 21]),
    box([30, 3.6, 14], [0, 11.8, 6]),
    box([32, 2.6, 16], [0, 11.3, -26]),
  );
  kit.pair("armor", (side) => box([8, 4, 20], [side * 16, 7, -6]));
  kit.pair("armor", (side) => box([8, 3, 10], [side * 18, 7.5, -22]));
  kit.tower(0, 13.6, -6, 12, 10, 4);
  kit.tower(0, 12.6, -37, 8, 6, 3);
  kit.module(-17.2, 5.5, 18, 3, 4, 36, 5);
  kit.module(17.2, 5.5, 18, 3, 4, 36, 5);
  kit.module(-14.5, 11.3, 22, 5, 2.6, 10, 3);
  kit.module(14.5, 11.3, 22, 5, 2.6, 10, 3);
  kit.barbettes("battleship");
  kit.trench(0, 13.6, 6, 3, 10);
  for (const z of [-13, -8, -3, 2]) kit.pair("dark", (side) => box([8.4, 3.2, 0.44], [side * 16, 7, z]));
  for (const z of [-25, -20]) kit.pair("dark", (side) => box([8.4, 2.4, 0.44], [side * 18, 7.5, z]));
  kit.pair("accent", (side) => box([0.7, 0.3, 16], [side * 16, 9.15, -6]));
  kit.add(
    "accent",
    box([12, 0.3, 0.6], [0, 12.45, 27.2]),
    box([20, 0.3, 0.6], [0, 13.05, 13.2]),
    box([28, 0.3, 0.6], [0, 13.65, -1.2]),
  );
  kit.prow(55.6, 41.5, 12.2, 10.0, 2.6, 14);
  kit.groove(0, 10.05, 40, 24);
  kit.groove(0, 12.45, 30, 12);
  kit.plaque(-16, 9.15, 0, 4.5, 2.4);
  kit.hazard(16, 9.15, 0, 4.5, 2, 5);
  kit.hazard(0, 12.65, -33, 24, 1.8, 10);
  for (const z of [-30, -14, 2, 18]) kit.pair("light", (side) => box([0.6, 0.5, 1.6], [side * 18.4, 10.1, z]));
  kit.mast(-5, 20.4, -8, 9);
  return kit.build();
}

const hullGeometries = new Map<ShipClass, HullGeometrySet>();

export function getShipHullGeometries(shipClass: ShipClass): HullGeometrySet {
  const cached = hullGeometries.get(shipClass);
  if (cached) return cached;
  const geometry = buildHull(shipClass);
  hullGeometries.set(shipClass, geometry);
  return geometry;
}

function buildHull(shipClass: ShipClass): HullGeometrySet {
  switch (shipClass) {
    case "fighter": return fighterGeometry();
    case "bomber": return bomberGeometry();
    case "fabricator": return fabricatorGeometry();
    case "frigate": return frigateGeometry();
    case "flakFrigate": return flakFrigateGeometry();
    case "torpedoFrigate": return torpedoFrigateGeometry();
    case "artilleryFrigate": return artilleryFrigateGeometry();
    case "destroyer": return destroyerGeometry();
    case "artilleryDestroyer": return artilleryDestroyerGeometry();
    case "cruiser": return cruiserGeometry();
    case "artilleryCruiser": return artilleryCruiserGeometry();
    case "carrier": return carrierGeometry();
    case "battleship": return battleshipGeometry();
  }
}

// ---------------------------------------------------------------------------
// Turrets. Barrel tips sit at each weapon's muzzleOffset so projectile spawn
// points and muzzle flashes stay on the barrels.
// ---------------------------------------------------------------------------

function turretBase(radius: number, tall: boolean): THREE.BufferGeometry {
  const baseHeight = tall ? 0.7 : 0.5;
  return merge([
    cylinder(radius * 0.88, radius, baseHeight, [0, baseHeight / 2, 0], 8),
    box([radius * 1.45, 1.2, radius * 1.6], [0, baseHeight + 0.6, -radius * 0.12]),
  ]);
}

export function makeTurretGeometry(shipClass: ShipClass, weaponTypeId: WeaponTypeId): TurretGeometrySet {
  const large = shipClass === "destroyer" || shipClass === "artilleryDestroyer"
    || shipClass === "cruiser" || shipClass === "artilleryCruiser"
    || shipClass === "carrier" || shipClass === "battleship";
  const radius = large ? 2.0 : shipClass === "fighter" ? 0.5 : shipClass === "bomber" ? 0.75 : 1.6;
  const mount = turretBase(radius, large);
  const barrel: THREE.BufferGeometry[] = [];
  const accent: THREE.BufferGeometry[] = [];
  const dark: THREE.BufferGeometry[] = [];
  const y = 1.5;

  switch (weaponTypeId) {
    case "pointDefense": {
      // Boxy superposed-load point defence: a 2x2 barrel block, side ammo
      // canister, and a small sensor dome.
      barrel.push(
        box([1.3, 0.95, 1.5], [0, y, 0.5]),
        ...[-0.26, 0.26].flatMap((x) => [-0.2, 0.2].map((dy) => box([0.2, 0.2, 2.3], [x, y + dy, 2.1]))),
        box([0.62, 0.7, 1.2], [-1.05, y - 0.05, 0.1]),
      );
      dark.push(
        box([0.9, 0.5, 0.36], [0, y, 1.35]),
        transformed(new THREE.OctahedronGeometry(0.3, 0), [0.7, y + 0.6, -0.1]),
        box([0.3, 0.6, 0.9], [1.0, y - 0.1, 0.1]),
      );
      accent.push(box([0.5, 0.16, 0.5], [-1.05, y + 0.36, 0.1]), box([0.9, 0.16, 0.24], [0, y + 0.56, 0.5]));
      break;
    }
    case "autocannon": {
      barrel.push(
        box([1.4, 0.8, 1.7], [0, y, 0.3]),
        ...[-0.32, 0.32].map((x) => box([0.24, 0.24, 4.4], [x, y, 2.35])),
        ...[-0.32, 0.32].map((x) => box([0.36, 0.36, 0.5], [x, y, 4.35])),
      );
      dark.push(
        transformed(new THREE.CylinderGeometry(0.42, 0.42, 0.8, 6), [-0.95, y, -0.1], [0, 0, Math.PI / 2]),
        box([0.9, 0.2, 0.9], [0, y + 0.5, 0.2]),
      );
      accent.push(box([1.0, 0.16, 0.24], [0, y + 0.5, 0.95]), box([0.9, 0.14, 0.2], [0, y + 0.1, 3.9]));
      break;
    }
    case "flakCannon": {
      barrel.push(
        box([1.7, 1.0, 1.6], [0, y, 0.2]),
        ...[-0.3, 0.3].flatMap((x) => [-0.22, 0.22].map((dy) => box([0.2, 0.2, 3.3], [x, y + dy, 1.85]))),
        box([2.0, 1.3, 0.16], [0, y + 0.1, 1.0]),
      );
      dark.push(box([1.2, 0.4, 0.5], [0, y + 0.65, -0.2]), box([0.5, 0.5, 0.9], [1.05, y - 0.1, -0.2]));
      accent.push(box([1.8, 0.18, 0.2], [0, y + 0.8, 1.0]), box([0.6, 0.16, 0.7], [-1.0, y + 0.55, -0.2]));
      break;
    }
    case "plasma": {
      barrel.push(
        box([1.9, 0.9, 1.5], [0, y, 0.4]),
        ...[-0.45, 0.45].map((x) => box([0.6, 0.6, 4.9], [x, y, 2.65])),
        transformed(new THREE.CylinderGeometry(0.34, 0.34, 1.6, 6), [0, y + 0.66, -0.1], [Math.PI / 2, 0, 0]),
      );
      dark.push(...[-0.45, 0.45].map((x) => box([0.5, 0.5, 0.4], [x, y, 5.0])));
      for (const z of [2.2, 3.6]) {
        accent.push(...[-0.45, 0.45].map((x) => tube(0.42, 0.26, [x, y, z], 6)));
      }
      accent.push(box([1.4, 0.18, 0.24], [0, y + 0.5, 1.05]));
      break;
    }
    case "heavyRail": {
      barrel.push(
        box([2.0, 1.1, 2.2], [0, y, 0.2]),
        ...[-0.42, 0.42].map((x) => box([0.34, 0.5, 8.4], [x, y, 4.5])),
        ...[-0.7, 0.7].map((x) => box([0.3, 0.3, 2.0], [x, y - 0.25, 0.2])),
      );
      for (const z of [2.6, 5.0, 7.4]) accent.push(box([1.5, 0.3, 0.3], [0, y, z]));
      dark.push(
        ...[-0.4, 0, 0.4].map((x) => box([0.16, 0.6, 1.4], [x, y + 0.7, -0.2])),
        box([1.6, 0.5, 0.3], [0, y, 8.55]),
      );
      accent.push(box([1.6, 0.18, 0.3], [0, y + 0.6, 1.2]));
      break;
    }
    case "beam": {
      barrel.push(
        box([1.6, 1.0, 2.4], [0, y, 0.6]),
        transformed(new THREE.CylinderGeometry(0.36, 0.55, 7.6, 8), [0, y, 4.1], [Math.PI / 2, 0, 0]),
      );
      dark.push(...[-1.0, 1.0].flatMap((x) => [0.3, 1.3].map((z) => box([0.2, 1.3, 0.7], [x, y + 0.1, z]))));
      accent.push(
        tube(0.5, 0.3, [0, y, 7.6], 8),
        tube(0.62, 0.3, [0, y, 2.4], 8),
        box([1.2, 0.16, 0.3], [0, y + 0.58, 0.4]),
      );
      break;
    }
    case "torpedo": {
      // Six-cell box launcher. Cells sit on the front face.
      barrel.push(box([2.7, 1.25, 3.0], [0, y, 0.2]), box([0.5, 0.5, 0.9], [-1.55, y - 0.2, -0.5]));
      for (const x of [-0.85, 0, 0.85]) {
        for (const dy of [-0.3, 0.3]) dark.push(box([0.62, 0.42, 0.32], [x, y + dy, 1.72]));
      }
      accent.push(
        box([2.9, 0.18, 0.24], [0, y + 0.72, 1.6]),
        box([0.5, 0.16, 1.6], [1.5, y + 0.6, 0]),
      );
      break;
    }
    case "lightArtillery":
    case "siegeArtillery":
    case "strategicArtillery": {
      const length = weaponTypeId === "strategicArtillery" ? 14.8 : weaponTypeId === "siegeArtillery" ? 10.3 : 7.3;
      const bore = weaponTypeId === "strategicArtillery" ? 1.2 : weaponTypeId === "siegeArtillery" ? 0.95 : 0.72;
      const cradleWidth = bore * 2.6;
      barrel.push(
        box([cradleWidth, 1.1, 2.8], [0, y, 0.3]),
        box([bore, bore, length], [0, y + 0.25, length / 2 + 0.2]),
        box([bore * 1.35, bore * 1.35, bore * 0.9], [0, y + 0.25, length + 0.2 - bore * 0.5]),
        box([cradleWidth * 0.8, 0.9, 1.4], [0, y - 0.1, -1.5]),
      );
      dark.push(
        ...[-1, 1].map((side) => transformed(new THREE.CylinderGeometry(0.34, 0.34, 0.6, 6), [side * (cradleWidth / 2 + 0.2), y + 0.25, 0.6], [0, 0, Math.PI / 2])),
        ...[-1, 1].map((side) => box([0.3, 0.3, 2.6], [side * bore * 0.7, y - 0.35, 2.2])),
      );
      const ringCount = weaponTypeId === "strategicArtillery" ? 3 : weaponTypeId === "siegeArtillery" ? 2 : 1;
      for (let index = 0; index < ringCount; index += 1) {
        accent.push(box([bore * 1.3, bore * 1.3, 0.34], [0, y + 0.25, 2.6 + index * (length / (ringCount + 1))]));
      }
      accent.push(box([cradleWidth * 0.7, 0.16, 0.3], [0, y + 0.58, -1.5]));
      break;
    }
  }
  // Widen and raise the weapon parts for readability; Z is untouched so the
  // barrel tips stay on the muzzle offsets.
  const girth = new THREE.Matrix4().makeScale(1.3, 1.2, 1);
  return {
    mount,
    barrel: merge(barrel).applyMatrix4(girth),
    accent: merge(accent).applyMatrix4(girth),
    dark: merge(dark).applyMatrix4(girth),
  };
}

function applyVertexShade(geometry: THREE.BufferGeometry, shade: number): THREE.BufferGeometry {
  const positions = geometry.getAttribute("position");
  const colors = new Float32Array(positions.count * 3);
  colors.fill(shade);
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

const batchedTurretGeometries = new Map<WeaponTypeId, THREE.BufferGeometry>();

export function getBatchedTurretGeometry(weaponTypeId: WeaponTypeId): THREE.BufferGeometry {
  const cached = batchedTurretGeometries.get(weaponTypeId);
  if (cached) return cached;
  const parts = makeTurretGeometry("frigate", weaponTypeId);
  const geometry = merge([
    applyVertexShade(parts.mount, 0.4),
    applyVertexShade(parts.barrel, 0.66),
    applyVertexShade(parts.dark, 0.18),
    applyVertexShade(parts.accent, 1),
  ]);
  batchedTurretGeometries.set(weaponTypeId, geometry);
  return geometry;
}
