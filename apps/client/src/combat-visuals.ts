import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { WEAPONS, type ProjectileState, type ShipClass, type WeaponTypeId } from "@space-rts/game-core";

const MAX_PROJECTILES = 8_192;
const VERTICES_PER_STREAK = 6;

interface ShipMaterials {
  hull: THREE.MeshStandardMaterial;
  armor: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  light: THREE.MeshBasicMaterial;
  engine: THREE.MeshBasicMaterial;
}

export interface HullGeometrySet {
  hull: THREE.BufferGeometry;
  armor: THREE.BufferGeometry;
  dark: THREE.BufferGeometry;
  accent: THREE.BufferGeometry;
  light: THREE.BufferGeometry;
  engine: THREE.BufferGeometry;
}

interface TurretGeometrySet {
  mount: THREE.BufferGeometry;
  barrel: THREE.BufferGeometry;
  accent: THREE.BufferGeometry;
}

export interface ShipHullVisual {
  group: THREE.Group;
  engineGlow: THREE.Mesh;
}

const shipMaterials = new Map<number, ShipMaterials>();
const hullGeometries = new Map<ShipClass, HullGeometrySet>();
const turretGeometries = new Map<string, TurretGeometrySet>();

function materialsForTeam(teamId: number): ShipMaterials {
  const cached = shipMaterials.get(teamId);
  if (cached) return cached;
  const palette = [0x59baff, 0xff5a78, 0x62e6a7, 0xf3b65b, 0xb886ff, 0x55e1e8, 0xff8b55, 0xd8e65b];
  const teamColor = palette[(teamId - 1) % palette.length] ?? 0x9cb4c5;
  const shade = (amount: number) => new THREE.Color(teamColor).multiplyScalar(amount).getHex();
  const glow = (amount: number) => new THREE.Color(teamColor).lerp(new THREE.Color(0xffffff), amount).getHex();
  const materials: ShipMaterials = {
    hull: new THREE.MeshStandardMaterial({
      color: shade(0.48),
      emissive: shade(0.16),
      emissiveIntensity: 0.68,
      metalness: 0.7,
      roughness: 0.36,
      flatShading: true,
    }),
    armor: new THREE.MeshStandardMaterial({
      color: shade(0.32),
      emissive: shade(0.1),
      emissiveIntensity: 0.58,
      metalness: 0.78,
      roughness: 0.32,
      flatShading: true,
    }),
    dark: new THREE.MeshStandardMaterial({
      color: 0x1b2b36,
      emissive: shade(0.065),
      emissiveIntensity: 0.72,
      metalness: 0.62,
      roughness: 0.46,
      flatShading: true,
    }),
    accent: new THREE.MeshStandardMaterial({
      color: teamColor,
      emissive: teamColor,
      emissiveIntensity: 2.25,
      metalness: 0.35,
      roughness: 0.28,
      toneMapped: false,
    }),
    light: new THREE.MeshBasicMaterial({ color: glow(0.62), toneMapped: false }),
    engine: new THREE.MeshBasicMaterial({
      color: glow(0.4),
      transparent: true,
      opacity: 0.88,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  };
  shipMaterials.set(teamId, materials);
  return materials;
}

function extrudedShape(
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

function transformed(
  geometry: THREE.BufferGeometry,
  position: readonly [number, number, number],
  rotation: readonly [number, number, number] = [0, 0, 0],
  scale: readonly [number, number, number] = [1, 1, 1],
): THREE.BufferGeometry {
  const clone = geometry.clone();
  clone.applyMatrix4(new THREE.Matrix4().compose(
    new THREE.Vector3(...position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)),
    new THREE.Vector3(...scale),
  ));
  return clone;
}

function box(
  size: readonly [number, number, number],
  position: readonly [number, number, number],
  rotation: readonly [number, number, number] = [0, 0, 0],
): THREE.BufferGeometry {
  return transformed(new THREE.BoxGeometry(...size), position, rotation);
}

function disc(
  radius: number,
  height: number,
  position: readonly [number, number, number],
  scale: readonly [number, number, number] = [1, 1, 1],
  segments = 12,
): THREE.BufferGeometry {
  return transformed(new THREE.CylinderGeometry(radius, radius * 0.92, height, segments), position, [0, 0, 0], scale);
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const normalized = parts.map((part) => part.index ? part.toNonIndexed() : part);
  const geometry = mergeGeometries(normalized, false);
  if (!geometry) throw new Error("Could not merge ship geometry");
  for (let index = 0; index < parts.length; index += 1) {
    parts[index]!.dispose();
    if (normalized[index] !== parts[index]) normalized[index]!.dispose();
  }
  geometry.computeBoundingSphere();
  return geometry;
}

function fighterGeometry(): HullGeometrySet {
  const hull = merge([
    extrudedShape([[0, 13], [-2.4, 5], [-2.1, -7.5], [0, -11], [2.1, -7.5], [2.4, 5]], 2.2, 0.5, 0.3),
    extrudedShape([[-2, 5], [-10.8, 0.5], [-9.2, -5.2], [-2.1, -2]], 1.05, 0.1, 0.16),
    extrudedShape([[2, 5], [10.8, 0.5], [9.2, -5.2], [2.1, -2]], 1.05, 0.1, 0.16),
  ]);
  const armor = merge([
    extrudedShape([[-2, 3.7], [-9.5, 0], [-8.6, -2], [-2.1, -0.4]], 0.62, 1.18, 0.1),
    extrudedShape([[2, 3.7], [9.5, 0], [8.6, -2], [2.1, -0.4]], 0.62, 1.18, 0.1),
    box([1.25, 1.6, 5.4], [-1.45, 1.2, -7.2]),
    box([1.25, 1.6, 5.4], [1.45, 1.2, -7.2]),
  ]);
  const dark = merge([
    transformed(new THREE.OctahedronGeometry(2.25, 0), [0, 3.1, 2.2], [0.12, 0, 0], [1, 0.72, 1.28]),
    box([4.2, 0.62, 1.2], [0, 1.5, -4.7]),
  ]);
  const accent = merge([
    box([0.55, 0.42, 7.4], [0, 3.75, 5.7]),
    box([5.4, 0.35, 0.46], [-5.4, 1.45, -0.2], [0, -0.42, 0]),
    box([5.4, 0.35, 0.46], [5.4, 1.45, -0.2], [0, 0.42, 0]),
  ]);
  const light = merge([
    box([1.25, 0.4, 0.75], [0, 4.5, 2.8]),
    box([0.5, 0.42, 0.75], [-1.45, 2.05, -9.6]),
    box([0.5, 0.42, 0.75], [1.45, 2.05, -9.6]),
  ]);
  const engine = merge([
    transformed(new THREE.ConeGeometry(0.95, 2.8, 6, 1, true), [-1.45, 0.5, -11.4], [-Math.PI / 2, 0, 0]),
    transformed(new THREE.ConeGeometry(0.95, 2.8, 6, 1, true), [1.45, 0.5, -11.4], [-Math.PI / 2, 0, 0]),
  ]);
  // Fighters should read as genuinely small strike craft beside bombers and frigates.
  for (const geometry of [hull, armor, dark, accent, light, engine]) geometry.scale(0.32, 0.32, 0.32);
  return { hull, armor, dark, accent, light, engine };
}

function bomberGeometry(): HullGeometrySet {
  const hull = merge([
    extrudedShape([[0, 16], [-4, 9], [-4.8, -8], [0, -13], [4.8, -8], [4, 9]], 3.4, 1.1, 0.42),
    extrudedShape([[-3.2, 8], [-13.5, 2], [-12, -5.5], [-5, -7], [-3.8, -1]], 1.8, 0.4, 0.25),
    extrudedShape([[3.2, 8], [13.5, 2], [12, -5.5], [5, -7], [3.8, -1]], 1.8, 0.4, 0.25),
  ]);
  const armor = merge([
    box([3.4, 3.2, 13.5], [-7.4, 2.4, -4.2], [0, 0, -0.06]),
    box([3.4, 3.2, 13.5], [7.4, 2.4, -4.2], [0, 0, 0.06]),
    extrudedShape([[0, 13], [-2.7, 7], [-2.8, -5], [0, -8], [2.8, -5], [2.7, 7]], 2.4, 5.0, 0.34),
  ]);
  const dark = merge([
    transformed(new THREE.OctahedronGeometry(3.2, 0), [0, 7, 3], [0.1, 0, 0], [1, 0.72, 1.22]),
    box([2.3, 1.4, 9.5], [-7.4, 4.4, -3.8]),
    box([2.3, 1.4, 9.5], [7.4, 4.4, -3.8]),
  ]);
  const accent = merge([
    box([0.8, 0.46, 14.5], [0, 8.0, 2]),
    box([0.58, 0.42, 9.2], [-7.4, 5.2, -3.7]),
    box([0.58, 0.42, 9.2], [7.4, 5.2, -3.7]),
  ]);
  const light = merge([
    box([2.4, 0.42, 0.65], [0, 8.7, 5]),
    box([0.65, 0.48, 1.1], [-7.4, 5.15, -10.8]),
    box([0.65, 0.48, 1.1], [7.4, 5.15, -10.8]),
  ]);
  const engine = merge([-7.4, 7.4].map((x) =>
    transformed(new THREE.ConeGeometry(1.55, 4.2, 7, 1, true), [x, 1.2, -12.2], [-Math.PI / 2, 0, 0]),
  ));
  return scaleHullSet({ hull, armor, dark, accent, light, engine }, 0.42, 0.42, 0.42);
}

function frigateGeometry(): HullGeometrySet {
  const hull = merge([
    disc(9.5, 3.2, [0, 3.2, 6], [1, 1, 1.18], 14),
    extrudedShape([[0, 3], [-4.7, -2], [-4.2, -12], [0, -16], [4.2, -12], [4.7, -2]], 4.2, 1.4, 0.5),
    box([6, 3.2, 7.5], [0, 3.0, -4]),
  ]);
  const armor = merge([
    disc(7.6, 1.6, [0, 5.5, 6.2], [1, 1, 1.12], 14),
    box([3.2, 3.2, 17], [-10.5, 2.6, -5.8], [0, 0, -0.04]),
    box([3.2, 3.2, 17], [10.5, 2.6, -5.8], [0, 0, 0.04]),
    box([2.2, 2.2, 5.5], [-7.2, 2.2, 0.5], [0, -0.4, 0]),
    box([2.2, 2.2, 5.5], [7.2, 2.2, 0.5], [0, 0.4, 0]),
  ]);
  const dark = merge([
    disc(3.8, 2.1, [0, 7.0, 5.6], [1, 1, 1.1], 12),
    box([2.0, 1.3, 12.5], [-10.5, 4.5, -5.2]),
    box([2.0, 1.3, 12.5], [10.5, 4.5, -5.2]),
    box([4.8, 1.1, 4.2], [0, 6.1, -9.2]),
  ]);
  const accent = merge([
    box([0.72, 0.5, 12.5], [0, 8.2, 4.7]),
    box([0.55, 0.45, 12], [-10.5, 5.25, -5.2]),
    box([0.55, 0.45, 12], [10.5, 5.25, -5.2]),
    box([5.4, 0.45, 0.65], [0, 6.85, -8.9]),
  ]);
  const light = merge([
    box([2.8, 0.4, 0.52], [0, 8.9, 7.8]),
    box([0.58, 0.48, 1.3], [-10.5, 5.15, -13.9]),
    box([0.58, 0.48, 1.3], [10.5, 5.15, -13.9]),
  ]);
  const engine = merge([-10.5, 10.5].map((x) =>
    transformed(new THREE.ConeGeometry(1.6, 4.2, 7, 1, true), [x, 2.4, -15.1], [-Math.PI / 2, 0, 0]),
  ));
  return { hull, armor, dark, accent, light, engine };
}

function destroyerGeometry(): HullGeometrySet {
  const hull = merge([
    extrudedShape([[0, 29], [-18, -19], [-11, -27], [11, -27], [18, -19]], 4.8, 1.4, 0.7),
    extrudedShape([[0, 25], [-11.5, -15], [-7, -23], [7, -23], [11.5, -15]], 3.6, 5.8, 0.52),
  ]);
  const armor = merge([
    extrudedShape([[-2, 19], [-14.2, -14], [-9.3, -18], [-4.4, 5]], 2.2, 6.2, 0.34),
    extrudedShape([[2, 19], [14.2, -14], [9.3, -18], [4.4, 5]], 2.2, 6.2, 0.34),
    box([7.5, 3.8, 9], [-9.7, 3.1, -17.8], [0, 0, -0.08]),
    box([7.5, 3.8, 9], [9.7, 3.1, -17.8], [0, 0, 0.08]),
  ]);
  const dark = merge([
    box([8.5, 3.2, 6.5], [0, 11.5, -8]),
    box([4.5, 3.8, 4.8], [0, 14.7, -8]),
    box([2.4, 1.3, 18], [-7.2, 8.1, -5], [0, 0, -0.16]),
    box([2.4, 1.3, 18], [7.2, 8.1, -5], [0, 0, 0.16]),
  ]);
  const accent = merge([
    box([0.92, 0.55, 31], [0, 10.15, 1]),
    box([5.5, 0.46, 0.75], [0, 17.0, -7.7]),
    box([0.6, 0.44, 15], [-7.2, 8.85, -5]),
    box([0.6, 0.44, 15], [7.2, 8.85, -5]),
  ]);
  const light = merge([
    box([3.8, 0.46, 0.62], [0, 17.65, -6.7]),
    box([0.62, 0.5, 1.5], [-9, 5.4, -25.2]),
    box([0.62, 0.5, 1.5], [9, 5.4, -25.2]),
  ]);
  const engine = merge([-9, -3, 3, 9].map((x) =>
    transformed(new THREE.ConeGeometry(1.8, 5.2, 7, 1, true), [x, 1.8, -29.2], [-Math.PI / 2, 0, 0]),
  ));
  return { hull, armor, dark, accent, light, engine };
}

function scaleHullSet(set: HullGeometrySet, x: number, y: number, z: number): HullGeometrySet {
  for (const geometry of Object.values(set)) geometry.scale(x, y, z);
  return set;
}

function mobileFabricatorGeometry(): HullGeometrySet {
  const set = scaleHullSet(frigateGeometry(), 0.74, 0.82, 0.76);
  set.armor = merge([
    set.armor,
    transformed(new THREE.TorusGeometry(7.3, 0.72, 5, 18), [0, 5.5, 4.6], [Math.PI / 2, 0, 0], [1, 1, 1.08]),
    box([2.1, 1.7, 10], [-7.8, 3.8, 1.5], [0, -0.22, 0]),
    box([2.1, 1.7, 10], [7.8, 3.8, 1.5], [0, 0.22, 0]),
    box([1.5, 1.5, 9], [-10.8, 4.5, 7.3], [0, -0.46, 0]),
    box([1.5, 1.5, 9], [10.8, 4.5, 7.3], [0, 0.46, 0]),
  ]);
  set.accent = merge([
    set.accent,
    transformed(new THREE.TorusGeometry(7.3, 0.24, 4, 18), [0, 6.35, 4.6], [Math.PI / 2, 0, 0], [1, 1, 1.08]),
    box([0.62, 0.5, 7.5], [-10.8, 5.35, 7.3], [0, -0.46, 0]),
    box([0.62, 0.5, 7.5], [10.8, 5.35, 7.3], [0, 0.46, 0]),
  ]);
  return set;
}

function specialistFrigateGeometry(role: "flak" | "torpedo"): HullGeometrySet {
  const set = scaleHullSet(frigateGeometry(), role === "flak" ? 1.08 : 1.12, 1.04, 1.02);
  const roleDetails = role === "flak"
    ? [
        box([3.2, 1.2, 3.2], [-8.6, 5.3, 4]), box([3.2, 1.2, 3.2], [8.6, 5.3, 4]),
        box([3.2, 1.2, 3.2], [-8.6, 5.3, -5]), box([3.2, 1.2, 3.2], [8.6, 5.3, -5]),
      ]
    : [
        box([3.5, 2.4, 13], [-8.2, 3.2, 0]), box([3.5, 2.4, 13], [8.2, 3.2, 0]),
        box([2.8, 2.1, 9], [-4.8, 4.2, -8]), box([2.8, 2.1, 9], [4.8, 4.2, -8]),
      ];
  set.armor = merge([set.armor, ...roleDetails]);
  if (role === "flak") {
    set.dark = merge([
      set.dark,
      transformed(new THREE.CylinderGeometry(2.6, 3.2, 1.2, 8), [0, 10.2, -1]),
      transformed(new THREE.CylinderGeometry(0.45, 0.45, 5.2, 6), [0, 12.7, -1]),
    ]);
    set.accent = merge([
      set.accent,
      transformed(new THREE.TorusGeometry(3.5, 0.28, 4, 12), [0, 15.2, -1], [Math.PI / 2, 0, 0]),
    ]);
  } else {
    set.dark = merge([
      set.dark,
      box([2.2, 1.4, 14.5], [-8.15, 4.5, 0]),
      box([2.2, 1.4, 14.5], [8.15, 4.5, 0]),
    ]);
    set.accent = merge([
      set.accent,
      box([0.55, 0.5, 12], [-8.15, 5.28, 0]),
      box([0.55, 0.5, 12], [8.15, 5.28, 0]),
    ]);
  }
  return set;
}

function capitalGeometry(role: "cruiser" | "carrier" | "battleship"): HullGeometrySet {
  if (role === "cruiser") {
    const hull = merge([
      disc(18.5, 5.4, [0, 2.1, 10], [1.18, 1, 1.0], 14),
      extrudedShape([[0, 13], [-7, 5], [-9, -29], [-5, -38], [5, -38], [9, -29], [7, 5]], 7.0, 1.4, 0.6),
      box([9, 5.4, 14], [0, 4.8, -1]),
    ]);
    const armor = merge([
      disc(14.2, 2.8, [0, 6.0, 10.5], [1.18, 1, 1], 14),
      extrudedShape([[-5, 1], [-9, -8], [-8, -31], [-4, -36], [-1, -26]], 3.4, 6.3, 0.45),
      extrudedShape([[5, 1], [9, -8], [8, -31], [4, -36], [1, -26]], 3.4, 6.3, 0.45),
      extrudedShape([[0, 12], [-4, 7], [-3.5, -4], [0, -8], [3.5, -4], [4, 7]], 3.3, 8.8, 0.4),
      box([6.8, 4.2, 24], [-22, 3.0, -20], [0, 0, -0.04]),
      box([6.8, 4.2, 24], [22, 3.0, -20], [0, 0, 0.04]),
    ]);
    const dark = merge([
      disc(6.0, 2.2, [0, 9.0, 10], [1.22, 1, 1], 12),
      box([5.2, 2.6, 30], [-22, 5.7, -20], [0, 0, -0.04]),
      box([5.2, 2.6, 30], [22, 5.7, -20], [0, 0, 0.04]),
      box([2.5, 1.0, 21], [-7.7, 7.7, -18], [0, 0, -0.05]),
      box([2.5, 1.0, 21], [7.7, 7.7, -18], [0, 0, 0.05]),
    ]);
    const accent = merge([
      transformed(new THREE.TorusGeometry(14.8, 0.42, 4, 28), [0, 7.55, 10.5], [Math.PI / 2, 0, 0], [1.18, 1, 1]),
      box([0.9, 0.55, 31], [0, 10.7, -13]),
      box([0.72, 0.5, 20], [-22, 7.3, -20]),
      box([0.72, 0.5, 20], [22, 7.3, -20]),
    ]);
    const light = merge([
      ...[-12, -8, -4, 4, 8, 12].map((x) => box([1.7, 0.48, 0.7], [x, 7.8, 21.5])),
      box([4.8, 0.5, 0.8], [0, 10.3, 14]),
      box([0.8, 0.55, 2.0], [-22, 7.45, -31]),
      box([0.8, 0.55, 2.0], [22, 7.45, -31]),
    ]);
    const engine = merge([-22, 22].map((x) =>
      transformed(new THREE.ConeGeometry(2.45, 7.2, 8, 1, true), [x, 3.2, -34.8], [-Math.PI / 2, 0, 0]),
    ));
    return { hull, armor, dark, accent, light, engine };
  }
  if (role === "carrier") {
    const hull = merge([
      extrudedShape([[-3, 39], [-20, 34], [-39, 10], [-42, -25], [-30, -43], [-9, -32], [-13, -6], [-7, 22]], 6.2, 1.2, 0.58),
      extrudedShape([[3, 39], [20, 34], [39, 10], [42, -25], [30, -43], [9, -32], [13, -6], [7, 22]], 6.2, 1.2, 0.58),
      extrudedShape([[0, 35], [-6, 26], [-7, -26], [0, -39], [7, -26], [6, 26]], 7.2, 2.0, 0.62),
    ]);
    const armor = merge([
      extrudedShape([[-7, 28], [-20, 29], [-33, 10], [-34, -22], [-23, -34], [-12, -27], [-16, -3]], 2.8, 5.5, 0.42),
      extrudedShape([[7, 28], [20, 29], [33, 10], [34, -22], [23, -34], [12, -27], [16, -3]], 2.8, 5.5, 0.42),
      extrudedShape([[0, 25], [-5, 18], [-5, -20], [0, -30], [5, -20], [5, 18]], 4.5, 7.0, 0.5),
      box([8, 4.2, 17], [0, 9.1, 7]),
    ]);
    const dark = merge([
      extrudedShape([[-10, 23], [-20, 24], [-29, 7], [-29, -18], [-21, -27], [-13, -22], [-17, -2]], 1.0, 7.45, 0.25),
      extrudedShape([[10, 23], [20, 24], [29, 7], [29, -18], [21, -27], [13, -22], [17, -2]], 1.0, 7.45, 0.25),
      box([8.5, 2.1, 24], [-10.2, 5.2, -13], [0, 0, -0.12]),
      box([8.5, 2.1, 24], [10.2, 5.2, -13], [0, 0, 0.12]),
      disc(4.6, 2.5, [0, 12.3, 8], [1.25, 1, 1], 10),
    ]);
    const accent = merge([
      box([0.9, 0.5, 39], [-22, 8.2, 1], [0, -0.1, 0]),
      box([0.9, 0.5, 39], [22, 8.2, 1], [0, 0.1, 0]),
      box([8.5, 0.48, 0.9], [-22, 8.25, 23]),
      box([8.5, 0.48, 0.9], [22, 8.25, 23]),
      box([0.95, 0.52, 22], [0, 14.0, 8]),
    ]);
    const deckLights: THREE.BufferGeometry[] = [];
    for (const x of [-28, -19, 19, 28]) {
      for (const z of [-20, -7, 6, 19]) deckLights.push(box([0.52, 0.45, 1.25], [x, 8.22, z]));
    }
    const light = merge([
      ...deckLights,
      box([4.5, 0.5, 0.78], [0, 14.5, 13]),
    ]);
    const engine = merge([-30, -21, -5, 5, 21, 30].map((x) =>
      transformed(new THREE.ConeGeometry(2.2, 7.0, 7, 1, true), [x, 1.8, -45.5], [-Math.PI / 2, 0, 0]),
    ));
    return { hull, armor, dark, accent, light, engine };
  }
  const hull = merge([
    extrudedShape([[0, 55], [-31, -39], [-22, -53], [22, -53], [31, -39]], 9.0, 0.8, 0.9),
    extrudedShape([[0, 48], [-23, -35], [-15, -45], [15, -45], [23, -35]], 5.8, 8.0, 0.7),
  ]);
  const armor = merge([
    extrudedShape([[0, 42], [-17, -28], [-11, -39], [-3, -31]], 4.2, 12.1, 0.55),
    extrudedShape([[0, 42], [17, -28], [11, -39], [3, -31]], 4.2, 12.1, 0.55),
    extrudedShape([[-6, 22], [-24, -31], [-18, -42], [-10, -31]], 3.1, 9.2, 0.48),
    extrudedShape([[6, 22], [24, -31], [18, -42], [10, -31]], 3.1, 9.2, 0.48),
    box([16, 4.8, 14], [0, 14.0, -5]),
  ]);
  const dark = merge([
    box([3.3, 1.5, 45], [-10.5, 10.8, -7], [0, 0, -0.12]),
    box([3.3, 1.5, 45], [10.5, 10.8, -7], [0, 0, 0.12]),
    extrudedShape([[0, 13], [-6, -12], [-5, -30], [0, -37], [5, -30], [6, -12]], 4.5, 17.0, 0.48),
    box([10.5, 4.2, 10], [0, 20.8, -13]),
    box([6.0, 3.0, 7], [0, 24.2, -13]),
  ]);
  const accent = merge([
    box([1.2, 0.66, 69], [0, 20.0, -1]),
    box([0.85, 0.58, 32], [-18.2, 12.5, -16], [0, 0, -0.18]),
    box([0.85, 0.58, 32], [18.2, 12.5, -16], [0, 0, 0.18]),
    box([13, 0.58, 0.9], [0, 26.0, -10]),
  ]);
  const light = merge([
    box([7.5, 0.58, 0.82], [0, 26.7, -6]),
    ...[-19, -14, -9, 9, 14, 19].map((x) => box([1.4, 0.55, 0.72], [x, 10.8, -37])),
  ]);
  const engine = merge([-18, -11, -4, 4, 11, 18].map((x) =>
    transformed(new THREE.ConeGeometry(2.6, 8.2, 8, 1, true), [x, 2.0, -56], [-Math.PI / 2, 0, 0]),
  ));
  return { hull, armor, dark, accent, light, engine };
}

export function getShipHullGeometries(shipClass: ShipClass): HullGeometrySet {
  const cached = hullGeometries.get(shipClass);
  if (cached) return cached;
  const geometry = shipClass === "fighter"
    ? fighterGeometry()
    : shipClass === "fabricator"
      ? mobileFabricatorGeometry()
      : shipClass === "frigate"
        ? frigateGeometry()
        : shipClass === "bomber"
          ? bomberGeometry()
          : shipClass === "flakFrigate"
            ? specialistFrigateGeometry("flak")
            : shipClass === "torpedoFrigate"
              ? specialistFrigateGeometry("torpedo")
              : shipClass === "destroyer"
                ? destroyerGeometry()
                : shipClass === "cruiser"
                  ? capitalGeometry("cruiser")
                  : shipClass === "carrier"
                    ? capitalGeometry("carrier")
                    : capitalGeometry("battleship");
  hullGeometries.set(shipClass, geometry);
  return geometry;
}

export function createShipHull(shipClass: ShipClass, teamId: number): ShipHullVisual {
  const geometry = getShipHullGeometries(shipClass);
  const material = materialsForTeam(teamId);
  const group = new THREE.Group();
  group.add(
    new THREE.Mesh(geometry.hull, material.hull),
    new THREE.Mesh(geometry.armor, material.armor),
    new THREE.Mesh(geometry.dark, material.dark),
    new THREE.Mesh(geometry.accent, material.accent),
    new THREE.Mesh(geometry.light, material.light),
  );
  const engineGlow = new THREE.Mesh(geometry.engine, material.engine);
  engineGlow.renderOrder = 2;
  group.add(engineGlow);
  return { group, engineGlow };
}

function makeTurretGeometry(shipClass: ShipClass, weaponTypeId: WeaponTypeId): TurretGeometrySet {
  const large = shipClass === "destroyer" || shipClass === "cruiser" || shipClass === "carrier" || shipClass === "battleship";
  const mountRadius = large ? 1.62 : shipClass === "fighter" ? 0.42 : shipClass === "bomber" ? 0.62 : 1.05;
  const housingScale = mountRadius / 1.45;
  const mount = merge([
    transformed(
      new THREE.CylinderGeometry(mountRadius * 0.78, mountRadius, large ? 0.72 : 0.5, 10),
      [0, 0.12, 0],
    ),
    transformed(
      extrudedShape([[0, 1.5], [-0.92, 0.46], [-0.76, -0.92], [0, -1.18], [0.76, -0.92], [0.92, 0.46]], 0.42, 0.34, 0.12),
      [0, 0, 0], [0, 0, 0], [housingScale, housingScale, housingScale],
    ),
  ]);
  let barrel: THREE.BufferGeometry;
  let accent: THREE.BufferGeometry;
  if (weaponTypeId === "torpedo") {
    barrel = merge([
      box([2.4, 0.48, 2.85], [0, 0.52, 0.12]),
      box([0.2, 0.32, 2.95], [-1.2, 0.58, 0.12]),
      box([0.2, 0.32, 2.95], [1.2, 0.58, 0.12]),
    ]);
    accent = merge([
      box([0.48, 0.14, 0.62], [-0.58, 0.84, -0.58]),
      box([0.48, 0.14, 0.62], [0.58, 0.84, -0.58]),
      box([0.48, 0.14, 0.62], [-0.58, 0.84, 0.58]),
      box([0.48, 0.14, 0.62], [0.58, 0.84, 0.58]),
    ]);
  } else if (weaponTypeId === "heavyRail") {
    barrel = merge([
      box([0.42, 0.5, 8.6], [-0.42, 0.78, 4.35]),
      box([0.42, 0.5, 8.6], [0.42, 0.78, 4.35]),
      box([1.45, 0.5, 2.2], [0, 0.66, 1.25]),
      box([1.8, 0.62, 1.05], [0, 0.56, -0.2]),
    ]);
    accent = merge([
      box([1.2, 0.18, 0.3], [0, 1.08, 2.5]),
      box([1.2, 0.18, 0.3], [0, 1.08, 4.55]),
      box([1.2, 0.18, 0.3], [0, 1.08, 6.6]),
    ]);
  } else if (weaponTypeId === "plasma") {
    barrel = merge([
      box([0.62, 0.62, 5.0], [-0.42, 0.72, 2.6]),
      box([0.62, 0.62, 5.0], [0.42, 0.72, 2.6]),
      box([1.7, 0.48, 1.35], [0, 0.55, 0.72]),
    ]);
    accent = merge([
      box([0.36, 0.22, 0.42], [-0.42, 1.08, 5.0]),
      box([0.36, 0.22, 0.42], [0.42, 1.08, 5.0]),
    ]);
  } else if (weaponTypeId === "beam") {
    barrel = merge([
      transformed(new THREE.CylinderGeometry(0.3, 0.5, 7.8, 8), [0, 0.74, 4.0], [Math.PI / 2, 0, 0]),
      box([1.35, 0.5, 2.0], [0, 0.58, 1.12]),
    ]);
    accent = merge([
      transformed(new THREE.TorusGeometry(0.42, 0.1, 4, 8), [0, 0.79, 6.2], [Math.PI / 2, 0, 0]),
      box([1.0, 0.18, 0.3], [0, 0.98, 2.35]),
    ]);
  } else if (weaponTypeId === "autocannon") {
    barrel = merge([
      box([0.22, 0.24, 4.5], [-0.3, 0.66, 2.3]),
      box([0.22, 0.24, 4.5], [0.3, 0.66, 2.3]),
      box([1.05, 0.46, 1.5], [0, 0.52, 0.78]),
      box([0.72, 0.6, 0.8], [0, 0.56, -0.28]),
    ]);
    accent = merge([
      box([0.82, 0.16, 0.24], [0, 0.9, 1.25]),
      box([0.72, 0.14, 0.2], [0, 0.82, 4.55]),
    ]);
  } else {
    barrel = merge([
      box([0.18, 0.2, 3.1], [-0.25, 0.6, 1.62]),
      box([0.18, 0.2, 3.1], [0.25, 0.6, 1.62]),
      box([0.86, 0.42, 1.2], [0, 0.48, 0.62]),
    ]);
    accent = merge([
      box([0.68, 0.14, 0.22], [0, 0.8, 0.95]),
      box([0.54, 0.12, 0.18], [0, 0.74, 3.12]),
    ]);
  }
  return { mount, barrel, accent };
}

export function createTurretVisual(shipClass: ShipClass, weaponTypeId: WeaponTypeId, teamId: number): THREE.Group {
  const key = `${shipClass}:${weaponTypeId}`;
  let geometry = turretGeometries.get(key);
  if (!geometry) {
    geometry = makeTurretGeometry(shipClass, weaponTypeId);
    turretGeometries.set(key, geometry);
  }
  const material = materialsForTeam(teamId);
  const group = new THREE.Group();
  group.add(
    new THREE.Mesh(geometry.mount, material.dark),
    new THREE.Mesh(geometry.barrel, material.hull),
    new THREE.Mesh(geometry.accent, material.accent),
  );
  return group;
}

const batchedTurretGeometries = new Map<WeaponTypeId, THREE.BufferGeometry>();

function applyVertexShade(geometry: THREE.BufferGeometry, shade: number): THREE.BufferGeometry {
  const positions = geometry.getAttribute("position");
  const colors = new Float32Array(positions.count * 3);
  for (let index = 0; index < positions.count; index += 1) {
    colors[index * 3] = shade;
    colors[index * 3 + 1] = shade;
    colors[index * 3 + 2] = shade;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

export function getBatchedTurretGeometry(weaponTypeId: WeaponTypeId): THREE.BufferGeometry {
  const cached = batchedTurretGeometries.get(weaponTypeId);
  if (cached) return cached;
  const parts = makeTurretGeometry("frigate", weaponTypeId);
  const geometry = merge([
    applyVertexShade(parts.mount, 0.46),
    applyVertexShade(parts.barrel, 0.62),
    applyVertexShade(parts.accent, 1),
  ]);
  batchedTurretGeometries.set(weaponTypeId, geometry);
  return geometry;
}

interface WeaponStyle {
  color: number;
  rgb: readonly [number, number, number];
  height: number;
  trailLength: number;
  width: number;
  headScale: readonly [number, number, number];
  brightness: number;
}

function weaponStyle(
  color: number,
  height: number,
  trailLength: number,
  width: number,
  headScale: readonly [number, number, number],
  brightness = 1,
): WeaponStyle {
  const rgb = new THREE.Color(color);
  return { color, rgb: [rgb.r, rgb.g, rgb.b], height, trailLength, width, headScale, brightness };
}

const WEAPON_STYLE: Readonly<Record<WeaponTypeId, WeaponStyle>> = {
  autocannon: weaponStyle(0xf0bd69, 4.2, 4.2, 0.09, [0.12, 0.12, 0.5], 0.34),
  torpedo: weaponStyle(0xff795f, 10, 8, 0.28, [0.46, 0.46, 1.35], 0.9),
  plasma: weaponStyle(0x58ddff, 7.2, 14, 0.45, [0.55, 0.55, 0.9], 0.85),
  heavyRail: weaponStyle(0xfff0c2, 10.2, 40, 0.42, [0.38, 0.38, 3.2], 1.08),
  pointDefense: weaponStyle(0x8dffb0, 6.8, 5.5, 0.07, [0.12, 0.12, 0.65], 0.38),
  beam: weaponStyle(0xa8f7ff, 8.5, 54, 0.55, [0.4, 0.4, 3.2]),
};

interface ProjectileVisualPose {
  x: number;
  y: number;
  z: number;
  directionX: number;
  directionY: number;
  directionZ: number;
}

function smoothstep(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return clamped * clamped * (3 - 2 * clamped);
}

function projectileVisualPose(projectile: ProjectileState, alpha: number, style: WeaponStyle): ProjectileVisualPose {
  const x = THREE.MathUtils.lerp(projectile.previousX, projectile.x, alpha);
  const z = THREE.MathUtils.lerp(projectile.previousZ, projectile.z, alpha);
  const speed = Math.max(0.001, Math.hypot(projectile.vx, projectile.vz));
  const horizontalX = projectile.vx / speed;
  const horizontalZ = projectile.vz / speed;
  if (projectile.weaponTypeId !== "torpedo") {
    return { x, y: style.height, z, directionX: horizontalX, directionY: 0, directionZ: horizontalZ };
  }
  const ageTicks = Math.max(0, WEAPONS.torpedo.projectileLifetimeTicks - projectile.lifetimeTicks + alpha);
  const rise = smoothstep(ageTicks / 3.5);
  const pitch = smoothstep((ageTicks - 2) / 6);
  const horizontal = Math.sin(pitch * Math.PI / 2);
  return {
    x,
    y: style.height + rise * (1 - pitch) * 16,
    z,
    directionX: horizontalX * horizontal,
    directionY: Math.cos(pitch * Math.PI / 2),
    directionZ: horizontalZ * horizontal,
  };
}

function projectileGeometry(weaponTypeId: WeaponTypeId): THREE.BufferGeometry {
  if (weaponTypeId === "torpedo") {
    const geometry = new THREE.CapsuleGeometry(0.72, 2.6, 3, 8);
    geometry.rotateX(Math.PI / 2);
    return geometry;
  }
  if (weaponTypeId === "plasma") {
    const geometry = new THREE.ConeGeometry(0.95, 4.8, 6);
    geometry.rotateX(Math.PI / 2);
    return geometry;
  }
  if (weaponTypeId === "heavyRail") return new THREE.OctahedronGeometry(1, 0);
  return new THREE.BoxGeometry(0.7, 0.7, 2.1);
}

function createStreakMesh(opacity: number): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  const vertexCount = MAX_PROJECTILES * VERTICES_PER_STREAK;
  const positions = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
  const colors = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
  positions.setUsage(THREE.DynamicDrawUsage);
  colors.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", positions);
  geometry.setAttribute("color", colors);
  geometry.setDrawRange(0, 0);
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  }));
}

function setStreakVertex(
  positions: THREE.BufferAttribute,
  colors: THREE.BufferAttribute,
  vertex: number,
  x: number,
  y: number,
  z: number,
  rgb: readonly [number, number, number],
  brightness: number,
): void {
  positions.setXYZ(vertex, x, y, z);
  colors.setXYZ(vertex, rgb[0] * brightness, rgb[1] * brightness, rgb[2] * brightness);
}

export class ProjectileVfx {
  private readonly heads = new Map<WeaponTypeId, THREE.InstancedMesh>();
  private readonly coreStreaks = createStreakMesh(0.98);
  private readonly glowStreaks = createStreakMesh(0.28);
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly forward = new THREE.Vector3(0, 0, 1);

  constructor(scene: THREE.Scene) {
    for (const weaponTypeId of Object.keys(WEAPON_STYLE) as WeaponTypeId[]) {
      const style = WEAPON_STYLE[weaponTypeId];
      const mesh = new THREE.InstancedMesh(
        projectileGeometry(weaponTypeId),
        new THREE.MeshBasicMaterial({
          color: style.color,
          blending: weaponTypeId === "autocannon" ? THREE.NormalBlending : THREE.AdditiveBlending,
          transparent: true,
          opacity: weaponTypeId === "autocannon" ? 0.52 : weaponTypeId === "plasma" ? 0.92 : 1,
          depthWrite: false,
          toneMapped: false,
        }),
        MAX_PROJECTILES,
      );
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.renderOrder = 4;
      this.heads.set(weaponTypeId, mesh);
      scene.add(mesh);
    }
    this.glowStreaks.renderOrder = 2;
    this.coreStreaks.renderOrder = 3;
    scene.add(this.glowStreaks, this.coreStreaks);
  }

  renderedCount = 0;

  update(projectiles: readonly ProjectileState[], alpha: number, renderLimit = MAX_PROJECTILES): void {
    const counts = new Map<WeaponTypeId, number>();
    const visibleCount = Math.min(projectiles.length, MAX_PROJECTILES, renderLimit);
    this.renderedCount = visibleCount;
    for (let projectileIndex = 0; projectileIndex < visibleCount; projectileIndex += 1) {
      const projectile = projectiles[projectileIndex]!;
      const style = WEAPON_STYLE[projectile.weaponTypeId];
      const instanceIndex = counts.get(projectile.weaponTypeId) ?? 0;
      const head = this.heads.get(projectile.weaponTypeId)!;
      const pose = projectileVisualPose(projectile, alpha, style);
      this.position.set(pose.x, pose.y, pose.z);
      this.direction.set(pose.directionX, pose.directionY, pose.directionZ).normalize();
      this.quaternion.setFromUnitVectors(this.forward, this.direction);
      this.scale.set(...style.headScale);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      head.setMatrixAt(instanceIndex, this.matrix);
      counts.set(projectile.weaponTypeId, instanceIndex + 1);
    }
    for (const [weaponTypeId, head] of this.heads) {
      head.count = counts.get(weaponTypeId) ?? 0;
      if (head.count > 0) {
        head.instanceMatrix.clearUpdateRanges();
        head.instanceMatrix.addUpdateRange(0, head.count * 16);
        head.instanceMatrix.needsUpdate = true;
      }
    }
    this.writeStreaks(this.glowStreaks, projectiles, visibleCount, alpha, 3.8, 0.14);
    this.writeStreaks(this.coreStreaks, projectiles, visibleCount, alpha, 1, 0.025);
  }

  private writeStreaks(
    mesh: THREE.Mesh,
    projectiles: readonly ProjectileState[],
    projectileCount: number,
    alpha: number,
    widthScale: number,
    tailBrightness: number,
  ): void {
    const positions = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const colors = mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    let vertex = 0;
    for (let projectileIndex = 0; projectileIndex < projectileCount; projectileIndex += 1) {
      const projectile = projectiles[projectileIndex]!;
      const style = WEAPON_STYLE[projectile.weaponTypeId];
      const pose = projectileVisualPose(projectile, alpha, style);
      const tailX = pose.x - pose.directionX * style.trailLength;
      const tailY = pose.y - pose.directionY * style.trailLength;
      const tailZ = pose.z - pose.directionZ * style.trailLength;
      const horizontalLength = Math.hypot(pose.directionX, pose.directionZ);
      const sideX = horizontalLength > 0.05
        ? -pose.directionZ / horizontalLength * style.width * widthScale
        : style.width * widthScale;
      const sideZ = horizontalLength > 0.05
        ? pose.directionX / horizontalLength * style.width * widthScale
        : 0;
      const headBrightness = (widthScale > 1 ? 0.65 : 1.25) * style.brightness;
      setStreakVertex(positions, colors, vertex++, tailX - sideX * 0.2, tailY, tailZ - sideZ * 0.2, style.rgb, tailBrightness * style.brightness);
      setStreakVertex(positions, colors, vertex++, tailX + sideX * 0.2, tailY, tailZ + sideZ * 0.2, style.rgb, tailBrightness * style.brightness);
      setStreakVertex(positions, colors, vertex++, pose.x + sideX, pose.y, pose.z + sideZ, style.rgb, headBrightness);
      setStreakVertex(positions, colors, vertex++, tailX - sideX * 0.2, tailY, tailZ - sideZ * 0.2, style.rgb, tailBrightness * style.brightness);
      setStreakVertex(positions, colors, vertex++, pose.x + sideX, pose.y, pose.z + sideZ, style.rgb, headBrightness);
      setStreakVertex(positions, colors, vertex++, pose.x - sideX, pose.y, pose.z - sideZ, style.rgb, headBrightness);
    }
    if (vertex > 0) {
      positions.clearUpdateRanges();
      positions.addUpdateRange(0, vertex * 3);
      positions.needsUpdate = true;
      colors.clearUpdateRanges();
      colors.addUpdateRange(0, vertex * 3);
      colors.needsUpdate = true;
    }
    mesh.geometry.setDrawRange(0, vertex);
  }
}
