import * as THREE from "three";
import { SHIPS, SHIP_TURRET_SCALES, STRUCTURES, ECONOMY_STRUCTURE_TYPES, type EconomyStructureType, type FactionId, type ShipClass, type StructureType, type WeaponTypeId } from "@space-rts/game-core";
import { buildFactionEconomy } from "./faction-economy-models";
import { ShipKit, cylinder, hullShell, loft, merge, transformed, type HullGeometrySet, type Vec3 } from "./ship-hulls";
import { SHIP_THRUSTERS, turretDeckHeight } from "./ship-layout";
import { FIGHTER_GUN_HEIGHT, FIGHTER_GUN_Z, FIGHTER_GUN_SEPARATION } from "./fighter-visuals";

type AlienFaction = Exclude<FactionId, "industrial">;
type Outline = ReadonlyArray<readonly [number, number]>;
// Authored in the same local units as the Industrial fleet. These are visual
// envelopes, independent of physics, balance, weapon origins and simulation.
const ENVELOPES: Record<ShipClass, readonly [number, number]> = {
  fighter: [7, 8], bomber: [11.6, 12.6], fabricator: [16.7, 31.8],
  frigate: [19.4, 34.8], flakFrigate: [20.6, 36], torpedoFrigate: [19.1, 36.8],
  artilleryFrigate: [18.5, 38], destroyer: [28.4, 60.8], artilleryDestroyer: [29, 59.5],
  cruiser: [40.4, 79.7], artilleryCruiser: [38, 82.2], carrier: [69.2, 88.7], battleship: [45.2, 113.6],
};

function oval(x: number, z: number, width: number, length: number): Outline {
  return Array.from({ length: 8 }, (_, i) => [x + Math.sin(i * Math.PI / 4) * width / 2, z + Math.cos(i * Math.PI / 4) * length / 2] as const);
}

function pod(size: Vec3, at: Vec3): THREE.BufferGeometry {
  return loft(oval(at[0], at[2], size[0], size[2]), [
    [0.64, 0.78, at[1] - size[1] / 2], [1, 1, at[1]], [0.48, 0.65, at[1] + size[1] / 2],
  ]);
}

function lowPod(size: Vec3, at: Vec3): THREE.BufferGeometry {
  const outline = Array.from({ length: 6 }, (_, i) => [at[0] + Math.sin(i * Math.PI / 3) * size[0] / 2, at[2] + Math.cos(i * Math.PI / 3) * size[2] / 2] as const);
  return loft(outline, [[1, 1, at[1] - size[1] * 0.22], [0.48, 0.65, at[1] + size[1] / 2]]);
}

function crystal(size: Vec3, at: Vec3): THREE.BufferGeometry {
  return transformed(new THREE.OctahedronGeometry(1), at, [0, 0, 0], size);
}

function link(from: Vec3, to: Vec3, width: number): THREE.BufferGeometry {
  const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
  const direction = b.clone().sub(a);
  return new THREE.CylinderGeometry(width * 0.55, width, direction.length(), 5)
    .applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()))
    .translate(...a.add(b).multiplyScalar(0.5).toArray());
}

function horn(from: Vec3, bend: Vec3, to: Vec3, radius: number): THREE.BufferGeometry {
  const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(...from), new THREE.Vector3(...bend), new THREE.Vector3(...to));
  const tube = new THREE.TubeGeometry(curve, 4, radius, 5, false);
  const positions = tube.getAttribute("position");
  const center = new THREE.Vector3(), point = new THREE.Vector3();
  for (let ring = 0; ring <= 4; ring++) {
    curve.getPointAt(ring / 4, center);
    const taper = 1 - ring / 4 * 0.93;
    for (let side = 0; side <= 5; side++) {
      const i = ring * 6 + side;
      point.fromBufferAttribute(positions, i).sub(center).multiplyScalar(taper).add(center);
      positions.setXYZ(i, point.x, point.y, point.z);
    }
  }
  tube.computeVertexNormals();
  return tube;
}

/** Only primary masses enter Medium; the Far mesh preserves gaps and claws.
 * Both are baked once, with no animated bones, textures or per-unit objects. */
class AlienKit {
  private kit = new ShipKit();
  add(layer: keyof HullGeometrySet, geometry: THREE.BufferGeometry): void { this.kit.add(layer, geometry); }
  private medium = { hull: [] as THREE.BufferGeometry[], armor: [] as THREE.BufferGeometry[] };
  private outlines: THREE.BufferGeometry[] = [];
  mass(layer: "hull" | "armor", geometry: THREE.BufferGeometry, outline?: Outline, medium?: THREE.BufferGeometry | false): void {
    this.add(layer, geometry);
    if (medium !== false) this.medium[layer].push(medium ?? geometry.clone());
    if (outline) {
      const flat = new THREE.ShapeGeometry(new THREE.Shape(outline.map(p => new THREE.Vector2(...p))));
      flat.rotateX(Math.PI / 2);
      const indices = flat.getIndex()!;
      for (let i = 0; i < indices.count; i += 3) {
        const b = indices.getX(i + 1);
        indices.setX(i + 1, indices.getX(i + 2)); indices.setX(i + 2, b);
      }
      flat.computeVertexNormals();
      this.outlines.push(flat);
    }
  }
  finish(): HullGeometrySet {
    const result = this.kit.build();
    result.hull.userData.medium = merge(this.medium.hull);
    result.armor.userData.medium = merge(this.medium.armor);
    result.hull.userData.silhouette = merge(this.outlines);
    return result;
  }
}

export function buildFactionHull(shipClass: ShipClass, faction: AlienFaction): HullGeometrySet {
  const kit = new AlienKit();
  const [width, length] = ENVELOPES[shipClass];
  const w = width / 2, l = length / 2;
  const small = shipClass === "fighter" || shipClass === "bomber";
  const h = small ? (shipClass === "fighter" ? 0.65 : 1.4) : 3.3 + length * 0.064;
  const rear = SHIP_THRUSTERS[shipClass].rear;
  const center = rear + l;
  const artillery = shipClass.startsWith("artillery");
  const capital = length > 75;
  const isClaw = shipClass === "fabricator";
  const isWide = shipClass === "bomber" || shipClass === "flakFrigate";

  if (faction === "brood") {
    // Segmented thorax, overlapping carapace and swept scythe limbs. A light
    // bone shell over aubergine tissue keeps the full volume legible in space.
    const core = oval(0, center - l * 0.15, w * (isWide ? 1.3 : 1.16), length * 0.85);
    kit.mass("hull", pod([w * (isWide ? 1.3 : 1.16), h, length * 0.85], [0, h * 0.4, center - l * 0.15]), core,
      lowPod([w * (isWide ? 1.3 : 1.16), h, length * 0.85], [0, h * 0.4, center - l * 0.15]));
    const segments = small ? 2 : capital ? 5 : 3;
    for (let i = 0; i < segments; i++) {
      const z = center + l * (0.46 - i * 1.22 / segments);
      const breadth = w * (0.91 + Math.sin((i + 1) / (segments + 1) * Math.PI) * 0.4);
      kit.mass("armor", pod([breadth, h * 0.65, length * 0.75 / segments], [0, h * 0.76, z]), undefined,
        lowPod([breadth, h * 0.65, length * 0.75 / segments], [0, h * 0.76, z]));
      if (!small) kit.add("dark", pod([breadth * 0.65, h * 0.17, length * 0.025], [0, h * 1.1, z - length * 0.18 / segments]));
    }
    for (const s of [-1, 1]) {
      // Broad fins on bombers/screens; forward mandibles on builders and line units.
      const fin: Outline = isWide
        ? [[s * w * 0.22, center + l * 0.65], [s * w, center + l * 0.3], [s * w * 0.92, center - l * 0.5], [s * w * 0.56, center - l * 0.13], [s * w * 0.25, center - l * 0.55]]
        : [[s * w * 0.25, center - l * 0.5], [s * w * 0.88, center - l * 0.24], [s * w, center + l * 0.3], [s * w * (isClaw ? 0.38 : 0.26), center + l], [s * w * 0.57, center + l * 0.26]];
      kit.mass("armor", hullShell(fin, h * 0.47, h * 0.23), fin);
      if (!small) {
        const rows = capital ? 3 : 2;
        for (let i = 0; i < rows; i++) {
          const z = center - l * (0.1 + i * 0.23);
          kit.add("hull", link([s * w * 0.34, h * 0.2, z], [s * w * (0.85 - i * 0.09), -h * 0.15, z - l * 0.2], h * 0.12));
        }
      }
      kit.add("light", pod([w * 0.14, h * 0.17, l * 0.09], [s * w * 0.25, h * 1.02, center + l * 0.4]));
    }
    if (isWide || shipClass === "carrier" || isClaw) {
      for (const s of [-1, 1]) for (let i = 0; i < (small ? 1 : 3); i++) {
        kit.add("accent", pod([w * 0.23, h * 0.4, l * 0.23], [s * w * 0.62, h * 0.75, center + l * (0.18 - i * 0.3)]));
      }
    }
    if (artillery || shipClass === "battleship") {
      kit.add("armor", horn([0, h * 0.86, center - l * 0.26], [0, h * 1.8, center], [0, h * 1.26, center + l * 0.32], w * 0.15));
    }
  } else {
    // A suspended crystal spine surrounded by detached porcelain blades.
    // Open channels survive every LOD; each role changes the blade planform.
    const spine: Outline = [[0, center + l * (isClaw ? 0.35 : 1)], [-w * 0.26, center - l * 0.12], [0, rear + l * 0.08], [w * 0.26, center - l * 0.12]];
    kit.mass("hull", hullShell(spine, h * 0.8, h * 0.15), spine);
    kit.mass("armor", crystal([w * 0.24, h * 0.47, l * 0.3], [0, h * 0.92, center - l * 0.14]));
    kit.add("light", crystal([w * 0.13, h * 0.27, l * 0.21], [0, h * 1.35, center - l * 0.14]));
    for (const s of [-1, 1]) {
      const blade: Outline = artillery || shipClass === "torpedoFrigate" || isClaw
        ? [[s * w * 0.5, center + l * 0.95], [s * w * 0.85, center + l * 0.4], [s * w, center - l * 0.55], [s * w * 0.4, center - l * 0.24]]
        : [[s * w * 0.12, center + l * 0.66], [s * w, center + l * (isWide ? 0.14 : -0.08)], [s * w * 0.87, center - l * 0.78], [s * w * 0.53, center - l * 0.24], [s * w * 0.32, center + l * 0.12]];
      kit.mass("armor", hullShell(blade, h * 0.48, h * 0.18), blade);
      const inlay = blade.map(([x, z]) => [x * 0.94, center + (z - center) * 0.81] as const);
      kit.add("hull", hullShell(inlay, h * 0.1, h * 0.72));
      const beam = [[s * w * 0.43, center + l * 0.23], [s * w * 0.48, center + l * 0.18], [s * w * 0.77, center - l * 0.49], [s * w * 0.71, center - l * 0.44]] as const;
      kit.add("accent", hullShell(beam, h * 0.035, h * 0.86));
      if (capital || shipClass === "destroyer") {
        const petal: Outline = [[s * w * 0.6, center + l * 0.82], [s * w * 0.94, center + l * 0.43], [s * w * 0.68, center + l * 0.08], [s * w * 0.37, center + l * 0.4]];
        kit.mass("armor", hullShell(petal, h * 0.34, h * 0.86), petal);
        kit.add("light", crystal([w * 0.07, h * 0.1, l * 0.12], [s * w * 0.65, h * 1.26, center + l * 0.42]));
      }
    }
    if (shipClass === "flakFrigate" || isClaw || shipClass === "carrier") {
      const halo = new THREE.TorusGeometry(w * 0.33, h * 0.1, 4, 12);
      kit.mass("armor", transformed(halo, [0, h * 1.25, center + l * 0.2]));
    }
  }

  // The weapon organs/emitters use the authoritative hardpoint coordinates.
  if (shipClass !== "fighter") for (const hp of SHIPS[shipClass].hardpoints) {
    const top = turretDeckHeight(shipClass, hp.localX, hp.localZ, hp.weaponTypeId);
    const r = SHIP_TURRET_SCALES[shipClass] * (hp.weaponTypeId === "pointDefense" ? 1.6 : 2.05);
    const base = Math.min(h * 0.65, top - 0.65);
    kit.mass("hull", faction === "brood"
      ? cylinder(r * 0.95, r * 1.5, top - base, [hp.localX, (top + base) / 2, hp.localZ], 7)
      : cylinder(r * 0.68, r, top - base, [hp.localX, (top + base) / 2, hp.localZ], 4), undefined,
      cylinder(r * 0.85, r * 1.1, top - base, [hp.localX, (top + base) / 2, hp.localZ], 4, true));
  }
  if (shipClass === "fighter") for (const s of [-1, 1]) {
    kit.mass("armor", link([s * FIGHTER_GUN_SEPARATION, FIGHTER_GUN_HEIGHT, FIGHTER_GUN_Z - 1.15],
      [s * FIGHTER_GUN_SEPARATION, FIGHTER_GUN_HEIGHT, FIGHTER_GUN_Z], 0.07));
  }
  for (const x of SHIP_THRUSTERS[shipClass].offsets) {
    const drive = SHIP_THRUSTERS[shipClass];
    const r = drive.width * 1.1;
    if (faction === "brood" && !small) kit.mass("hull", link([x * 0.65, h * 0.36, rear + l * 0.4], [x, drive.y, rear + r * 1.4], r * 0.74), undefined, false);
    const shape = oval(x, rear + r * 1.4, r * 2, r * 2.8);
    kit.mass("hull", faction === "brood"
      ? pod([r * 2, r * 1.6, r * 2.8], [x, drive.y, rear + r * 1.4])
      : crystal([r * 0.9, r * 0.7, r * 2.8], [x, drive.y, rear + r * 2.8]), shape,
      faction === "brood" ? lowPod([r * 2, r * 1.6, r * 2.8], [x, drive.y, rear + r * 1.4]) : undefined);
    kit.add("light", transformed(new THREE.CircleGeometry(r * 0.61, faction === "brood" ? 8 : 4), [x, drive.y, rear - 0.02], [0, Math.PI, 0]));
  }
  return kit.finish();
}

/** Faction weapon geometry shares the existing yaw, scale and muzzle reach. */
export function buildFactionTurret(type: WeaponTypeId, faction: AlienFaction): THREE.BufferGeometry {
  const length: Record<WeaponTypeId, number> = { pointDefense: 3.25, autocannon: 4.6, flakCannon: 3.5, plasma: 5.2, heavyRail: 8.7, beam: 7.9, torpedo: 1.9, lightArtillery: 7.5, siegeArtillery: 10.5, strategicArtillery: 15 };
  const reach = length[type];
  const parts: Array<[THREE.BufferGeometry, number]> = faction === "brood" ? [
    [pod([3.5, 1.6, 3], [0, 0.85, -0.3]), 0xb69ca9],
    [transformed(new THREE.CylinderGeometry(0.32, 0.85, reach, 6), [0, 1.8, reach / 2], [Math.PI / 2, 0, 0]), 0xe6cfb2],
    [transformed(new THREE.CircleGeometry(0.25, 6), [0, 1.8, reach + 0.01]), 0xc5ffa5],
  ] : [
    [crystal([2.1, 1, 2], [0, 0.9, 0]), 0xb4b5a4],
    [hullShell([[-0.75, -1], [-1.1, 1], [-0.4, reach], [0.4, reach], [1.1, 1], [0.75, -1]], 0.65, 1.3), 0xe4ede5],
    [crystal([0.22, 0.22, reach / 2], [0, 2.1, reach / 2]), 0x83ffe8],
  ];
  return merge(parts.map(([geometry, hex]) => {
    const color = new THREE.Color(hex);
    const data = new Float32Array(geometry.getAttribute("position").count * 3);
    for (let i = 0; i < data.length; i += 3) color.toArray(data, i);
    geometry.setAttribute("color", new THREE.BufferAttribute(data, 3));
    return geometry;
  }));
}

export function buildFactionStructure(type: StructureType, faction: AlienFaction): { body: HullGeometrySet; deck: number } {
  if ((ECONOMY_STRUCTURE_TYPES as readonly StructureType[]).includes(type)) return buildFactionEconomy(type as EconomyStructureType, faction);
  const kit = new ShipKit();
  const r = STRUCTURES[type].radius;
  const yard = ["shipyard", "fleetShipyard", "capitalShipyard"].includes(type);
  const core = type === "commandCore";
  const energy = ["fusionReactor", "antimatterReactor", "capitalInfrastructure", "solarArray"].includes(type);
  const mining = ["extractor", "deepCoreExtractor", "singularityHarvester"].includes(type);
  const storage = type === "storage" || type === "quantumStorage";
  const radar = type.toLowerCase().includes("radar");
  const production = ["alloyRefinery", "matterForge", "fabricator", "advancedFabrication"].includes(type);
  const field = type === "creepNode" || type === "pylon";
  const deck = r * 0.25;
  const count = yard ? (type === "shipyard" ? 3 : type === "fleetShipyard" ? 4 : 6) : core ? 6 : radar ? 3 : 4;
  if (faction === "brood") {
    kit.add("hull", pod([r * 1.65, r * 0.42, r * 1.65], [0, r * 0.13, 0]));
    // Rooted tendons and curling bone buttresses define every hive building.
    for (let i = 0; i < count; i++) {
      const a = i * Math.PI * 2 / count;
      const x = Math.sin(a), z = Math.cos(a);
      kit.add("hull", link([x * r * 0.3, r * 0.22, z * r * 0.3], [x * r * 0.96, 0, z * r * 0.96], r * 0.09));
      kit.add("armor", horn([x * r * 0.7, deck * 0.6, z * r * 0.7],
        [x * r * 0.85, r * (core ? 1.2 : 0.9), z * r * 0.85],
        [x * r * 0.22, r * (core ? 1.1 : 0.77), z * r * 0.22], r * 0.15));
    }
    if (yard || storage || production) {
      // Open nests have visible individual eggs, storage has a swollen sac,
      // and production buildings have twin vented organs.
      const sacs = yard ? count : storage ? 1 : 2;
      for (let i = 0; i < sacs; i++) {
        const a = i * Math.PI * 2 / sacs;
        const d = sacs === 1 ? 0 : r * 0.35;
        kit.add("accent", pod([r * (sacs === 1 ? 0.88 : 0.38), r * 0.62, r * 0.42], [Math.sin(a) * d, r * 0.4, Math.cos(a) * d]));
        kit.add("armor", pod([r * 0.28, r * 0.23, r * 0.44], [Math.sin(a) * d, r * 0.72, Math.cos(a) * d]));
      }
    } else if (radar) {
      kit.add("armor", link([0, deck, 0], [0, r * 1.25, 0], r * 0.14));
      for (const s of [-1, 1]) kit.add("armor", link([0, r * 0.85, 0], [s * r * 0.6, r * 1.1, r * 0.1], r * 0.075));
      kit.add("light", pod([r * 0.18, r * 0.18, r * 0.18], [0, r * 1.3, 0]));
    } else if (energy || core || field) {
      kit.add("armor", pod([r * 0.93, r * 0.72, r * 0.93], [0, r * 0.42, 0]));
      kit.add("light", pod([r * 0.47, r * (field ? 0.65 : 0.35), r * 0.47], [0, r * 0.83, 0]));
      if (energy) for (const x of [-0.42, 0.42]) kit.add("dark", cylinder(r * 0.09, r * 0.16, r * 0.65, [x * r, r * 0.6, 0], 6));
    } else if (mining) {
      kit.add("armor", cylinder(r * 0.22, r * 0.44, r * 0.7, [0, r * 0.3, 0], 7));
      kit.add("accent", pod([r * 0.45, r * 0.3, r * 0.45], [0, r * 0.71, 0]));
    }
  } else {
    kit.add("hull", cylinder(r * 0.65, r * 0.86, deck, [0, deck / 2, 0], 6));
    // Detached architectural petals leave space around a suspended heart.
    for (let i = 0; i < count; i++) {
      const a = i * Math.PI * 2 / count;
      const outline: Outline = [[-r * 0.15, r * 0.32], [-r * 0.23, r * 0.76], [0, r * 0.98], [r * 0.23, r * 0.76], [r * 0.15, r * 0.32]];
      kit.add("armor", hullShell(outline, r * 0.17, deck * 0.75).rotateY(a));
      if (core || yard || field || radar) kit.add("armor", crystal([r * 0.11, r * (yard ? 0.7 : 0.46), r * 0.16], [Math.sin(a) * r * 0.7, r * 0.64, Math.cos(a) * r * 0.7]));
    }
    if (yard) {
      // Vertical, open warp gate. Tier changes the number of spires and size.
      kit.add("armor", transformed(new THREE.TorusGeometry(r * 0.42, r * 0.075, 4, 6), [0, r * 0.7, 0]));
      kit.add("light", transformed(new THREE.TorusGeometry(r * 0.33, r * 0.018, 3, 6), [0, r * 0.7, 0]));
    } else if (storage || production) {
      for (const x of [-0.28, 0.28]) kit.add("armor", crystal([r * 0.23, r * 0.43, r * 0.32], [x * r, r * 0.6, 0]));
      kit.add("light", crystal([r * 0.09, r * 0.36, r * 0.13], [0, r * 0.63, 0]));
    } else if (core || field || energy || radar) {
      kit.add("light", crystal([r * 0.22, r * (radar ? 0.7 : 0.43), r * 0.22], [0, r * (radar ? 1.05 : 0.85), 0]));
      kit.add("armor", transformed(new THREE.TorusGeometry(r * 0.4, r * 0.045, 4, radar ? 3 : 6), [0, r * 0.65, 0], [Math.PI / 2, 0, 0]));
      if (type === "solarArray") for (const s of [-1, 1]) kit.add("accent", crystal([r * 0.39, r * 0.035, r * 0.65], [s * r * 0.55, r * 0.43, 0]));
    } else if (mining) {
      kit.add("armor", cylinder(r * 0.19, r * 0.42, r * 0.7, [0, r * 0.42, 0], 4));
      kit.add("light", crystal([r * 0.14, r * 0.34, r * 0.14], [0, r * 0.97, 0]));
    }
  }
  return { body: kit.build(), deck };
}
