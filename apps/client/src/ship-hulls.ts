import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { SHIPS, SHIP_TURRET_SCALES, type FactionId, type ShipClass, type WeaponTypeId } from "@space-rts/game-core";
import { BARBETTE_HEIGHT, SHIP_THRUSTERS, turretDeckHeight } from "./ship-layout";
import { buildFleetHull } from "./fleet-designs";
import { buildFactionHull, buildFactionTurret } from "./faction-models";

/**
 * Procedural low-poly hulls and turrets.
 *
 * Every ship is assembled from six geometry layers that the batched renderer
 * draws as separate instanced meshes:
 *
 * - `hull`   satin grey structural chassis. Medium uses a simplified construction;
 *            Far uses a separately baked, flat silhouette with open spaces.
 * - `armor`  pale plating, command blisters, weapon foundations and pods.
 *            Major masses survive Medium LOD; fine details are Close only.
 * - `dark`   near-black recesses, ribs, shrouds, masts, fins. Close LOD only.
 * - `accent` team-coloured glow strips and rings. Drawn even in large battles.
 * - `light`  white glow: window bands, bow stripes, hazard stripes, plaques,
 *            running lights. Close LOD only.
 * - `engine` legacy exhaust layer; fleet plumes use the shared thruster batch.
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

/** Faceted loft: broad shoulders, sloping armor and a narrower ventral keel.
 * Its widest ring retains the original footprint; detail costs less than a
 * beveled extrusion and is baked once, shared by every instance of the class.
 */
export function loft(points: ReadonlyArray<readonly [number, number]>, rings: readonly Vec3[]): THREE.BufferGeometry {
  let outline = [...points];
  const area = outline.reduce((sum, p, i) => {
    const next = outline[(i + 1) % outline.length]!;
    return sum + p[0] * next[1] - next[0] * p[1];
  }, 0);
  if (area < 0) outline = outline.reverse();
  const centerZ = outline.reduce((sum, p) => sum + p[1], 0) / outline.length;
  const centerX = outline.reduce((sum, p) => sum + p[0], 0) / outline.length;
  const vertices: number[] = [];
  const push = (ring: number, index: number): void => {
    const p = outline[index]!;
    const [width, length, y] = rings[ring]!;
    vertices.push(centerX + (p[0] - centerX) * width, y, centerZ + (p[1] - centerZ) * length);
  };
  const caps = THREE.ShapeUtils.triangulateShape(outline.map(p => new THREE.Vector2(...p)), []);
  for (const [a, b, c] of caps) {
    push(0, a!); push(0, b!); push(0, c!);
    push(rings.length - 1, c!); push(rings.length - 1, b!); push(rings.length - 1, a!);
  }
  for (let r = 0; r < rings.length - 1; r += 1) {
    for (let i = 0; i < outline.length; i += 1) {
      const next = (i + 1) % outline.length;
      push(r, i); push(r + 1, i); push(r, next);
      push(r, next); push(r + 1, i); push(r + 1, next);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  return geometry;
}

export function hullShell(points: ReadonlyArray<readonly [number, number]>, height: number, base: number, _bevel = 0): THREE.BufferGeometry {
  return loft(points, [[0.62, 0.94, base - height * 0.45], [1, 1, base + height * 0.38], [0.86, 0.97, base + height]]);
}

/** Six-sided armor module with a raked front and sloped flanks. */
export function armorBlock(size: Vec3, position: Vec3, rotation: Vec3 = [0, 0, 0]): THREE.BufferGeometry {
  const [w, h, d] = size;
  if (w < 1.5 || h < 0.6 || d < 2) return box(size, position, rotation);
  const outline: Array<[number, number]> = [
    [-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d * 0.28],
    [w * 0.32, d / 2], [-w * 0.32, d / 2], [-w / 2, d * 0.28],
  ];
  return transformed(loft(outline, [[1, 1, -h / 2], [0.86, 0.94, h / 2]]), position, rotation);
}

/** Painted surface mark, two triangles instead of a tiny solid box. */
export function deckMark(width: number, depth: number, position: Vec3, rotation: Vec3 = [0, 0, 0]): THREE.BufferGeometry {
  return transformed(new THREE.PlaneGeometry(width, depth).rotateX(-Math.PI / 2), position, rotation);
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
    this.add("armor", cylinder(radius * 0.84, radius, BARBETTE_HEIGHT, [x, top - BARBETTE_HEIGHT / 2, z], 8));
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
    this.add("hull", hullShell(
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
      armorBlock([width, height, depth], [x, base + height / 2, z]),
      armorBlock([upperWidth, upperHeight, upperDepth], [x, base + height + upperHeight / 2, z - depth * 0.06]),
      armorBlock([upperWidth * 0.62, capHeight, upperDepth * 0.7], [x, base + height + upperHeight + capHeight / 2, z]),
    );
    const windowY = base + height + upperHeight * 0.72;
    this.add(
      "light",
      box([upperWidth * 0.6, 0.19, 0.22], [x, windowY, z - depth * 0.06 + upperDepth * 0.47 + 0.06]),
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
      // Separate nacelles leave shadowed gaps between drives instead of a
      // single rectangular transom. The nozzle exits never move.
      const width = Math.min(housing.width / layout.offsets.length * 0.9, radius * 2.7);
      for (const x of layout.offsets) {
        this.add("armor", armorBlock([width, housing.height * 0.82, housing.depth], [x, layout.y, rear + housing.depth / 2 + 0.4]));
      }
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
    this.add("armor", armorBlock([width, height, depth], [x, y, z]));
    for (let rib = 0; rib < ribs; rib += 1) {
      const t = ribs === 1 ? 0 : (rib / (ribs - 1) - 0.5) * depth * 0.72;
      this.add("dark", deckMark(width * 0.78, 0.24, [x, y + height / 2 + 0.03, z + t]));
    }
    return this;
  }

  /** Diagonal white hazard stripes on a dark plate. */
  hazard(x: number, y: number, z: number, width: number, depth: number, count = 4, rotation: Vec3 = [0, 0, 0]): this {
    const plate = new THREE.PlaneGeometry(width, depth).rotateX(-Math.PI / 2);
    const parts: THREE.BufferGeometry[] = [];
    const spacing = width / count;
    for (let index = 0; index < count; index += 1) {
      const stripe = new THREE.PlaneGeometry(spacing * 0.3, depth * 0.78).rotateX(-Math.PI / 2);
      stripe.rotateY(HAZARD_ANGLE);
      stripe.translate((index - (count - 1) / 2) * spacing, 0.1, 0);
      parts.push(stripe);
    }
    const stripes = merge(parts);
    this.add("dark", transformed(plate, [x, y, z], rotation));
    this.add("light", transformed(stripes, [x, y, z], rotation));
    return this;
  }

  /** Small ID plaque: dark plate with two white text bars. */
  plaque(x: number, y: number, z: number, width: number, depth: number, rotation: Vec3 = [0, 0, 0]): this {
    this.add("dark", deckMark(width, depth, [x, y, z], rotation));
    const bars = merge([
      deckMark(width * 0.62, depth * 0.16, [-width * 0.08, 0.03, depth * 0.22]),
      deckMark(width * 0.4, depth * 0.16, [-width * 0.19, 0.03, -depth * 0.18]),
    ]);
    this.add("light", transformed(bars, [x, y, z], rotation));
    return this;
  }

  /** White bow identification bands across the deck. */
  bowBands(y: number, z: number, width: number, count = 2, spacing = 1.7): this {
    for (let index = 0; index < count; index += 1) {
      this.add("light", deckMark(width - index * width * 0.12, 0.38, [0, y + 0.02, z - index * spacing]));
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

const hullGeometries = new Map<string, HullGeometrySet>();

export function getShipHullGeometries(shipClass: ShipClass, faction: FactionId = "industrial"): HullGeometrySet {
  const key = `${faction}:${shipClass}`;
  const cached = hullGeometries.get(key);
  if (cached) return cached;
  if (faction !== "industrial") {
    const geometry = buildFactionHull(shipClass, faction);
    hullGeometries.set(key, geometry);
    return geometry;
  }
  const geometry = buildFleetHull(shipClass);
  // Bridge any gap between an unchanged weapon origin and the newly sculpted
  // deck. Do this once at construction time, never during rendering.
  if (shipClass !== "fighter") {
    const surfaces = [new THREE.Mesh(geometry.hull), new THREE.Mesh(geometry.armor)];
    const ray = new THREE.Raycaster();
    const supports: THREE.BufferGeometry[] = [];
    const mediumMounts: THREE.BufferGeometry[] = [];
    for (const hp of SHIPS[shipClass].hardpoints) {
      const base = turretDeckHeight(shipClass, hp.localX, hp.localZ, hp.weaponTypeId) - BARBETTE_HEIGHT;
      ray.set(new THREE.Vector3(hp.localX, base - 0.01, hp.localZ), new THREE.Vector3(0, -1, 0));
      const hit = ray.intersectObjects(surfaces)[0];
      const mediumHeight = BARBETTE_HEIGHT + (hit?.distance ?? 0);
      const mediumRadius = SHIP_TURRET_SCALES[shipClass] * (hp.weaponTypeId === "pointDefense" ? 1.8 : 2.5);
      mediumMounts.push(cylinder(mediumRadius * 0.85, mediumRadius, mediumHeight,
        [hp.localX, base + BARBETTE_HEIGHT - mediumHeight / 2, hp.localZ], 4, true));
      if (!hit || hit.distance < 0.3) continue;
      const height = base - hit.point.y + 0.2;
      const radius = SHIP_TURRET_SCALES[shipClass] * (hp.weaponTypeId === "pointDefense" ? 1.8 : 2.5);
      supports.push(cylinder(radius * 0.85, radius * 1.2, height, [hp.localX, base - height / 2, hp.localZ], 6));
    }
    surfaces.forEach(surface => (surface.material as THREE.Material).dispose());
    geometry.hull.userData.medium = merge([geometry.hull.userData.medium as THREE.BufferGeometry, ...mediumMounts]);
    if (supports.length) {
      const userData = geometry.hull.userData;
      geometry.hull = merge([geometry.hull, ...supports]);
      geometry.hull.userData = userData;
    }
  }
  hullGeometries.set(key, geometry);
  return geometry;
}

/** Flat role silhouette for tiny ships and large-battle LOD, generated once. */
export function getShipSilhouetteGeometry(shipClass: ShipClass, faction: FactionId = "industrial"): THREE.BufferGeometry {
  return getShipHullGeometries(shipClass, faction).hull.userData.silhouette as THREE.BufferGeometry;
}

export function getShipMediumGeometry(shipClass: ShipClass, layer: "hull" | "armor", faction: FactionId = "industrial"): THREE.BufferGeometry {
  return getShipHullGeometries(shipClass, faction)[layer].userData.medium as THREE.BufferGeometry;
}

// ---------------------------------------------------------------------------
// Turrets. Barrel tips sit at each weapon's muzzleOffset so projectile spawn
// points and muzzle flashes stay on the barrels.
// ---------------------------------------------------------------------------

function turretBase(radius: number, tall: boolean): THREE.BufferGeometry {
  const baseHeight = tall ? 0.7 : 0.5;
  return merge([
    cylinder(radius * 0.88, radius, baseHeight, [0, baseHeight / 2, 0], 8),
    armorBlock([radius * 1.45, 1.2, radius * 1.6], [0, baseHeight + 0.6, -radius * 0.12]),
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

const batchedTurretGeometries = new Map<string, THREE.BufferGeometry>();

export function getBatchedTurretGeometry(weaponTypeId: WeaponTypeId, faction: FactionId = "industrial"): THREE.BufferGeometry {
  const key = `${faction}:${weaponTypeId}`;
  const cached = batchedTurretGeometries.get(key);
  if (cached) return cached;
  if (faction !== "industrial") {
    const geometry = buildFactionTurret(weaponTypeId, faction);
    batchedTurretGeometries.set(key, geometry);
    return geometry;
  }
  const parts = makeTurretGeometry("frigate", weaponTypeId);
  const geometry = merge([
    applyVertexShade(parts.mount, 0.4),
    applyVertexShade(parts.barrel, 0.66),
    applyVertexShade(parts.dark, 0.18),
    applyVertexShade(parts.accent, 1),
  ]);
  batchedTurretGeometries.set(key, geometry);
  return geometry;
}
