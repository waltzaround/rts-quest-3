import * as THREE from "three";
import { STRUCTURES, type EconomyStructureType } from "@space-rts/game-core";
import { ShipKit, cylinder, hullShell, transformed, type HullGeometrySet, type Vec3 } from "./ship-hulls";

type Faction = "brood" | "concord";

function organ(size: Vec3, at: Vec3): THREE.BufferGeometry {
  return transformed(new THREE.SphereGeometry(1, 8, 5), at, [0, 0, 0], size);
}
function gem(size: Vec3, at: Vec3): THREE.BufferGeometry {
  return transformed(new THREE.OctahedronGeometry(1), at, [0, 0, 0], size);
}
function rib(from: Vec3, bend: Vec3, to: Vec3, radius: number): THREE.BufferGeometry {
  const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(...from), new THREE.Vector3(...bend), new THREE.Vector3(...to));
  const geometry = new THREE.TubeGeometry(curve, 4, radius, 5, false);
  const p = geometry.getAttribute("position");
  const center = new THREE.Vector3(), vertex = new THREE.Vector3();
  for (let row = 0; row <= 4; row++) {
    curve.getPointAt(row / 4, center);
    for (let col = 0; col <= 5; col++) {
      const i = row * 6 + col;
      vertex.fromBufferAttribute(p, i).sub(center).multiplyScalar(1 - row * 0.19).add(center);
      p.setXYZ(i, vertex.x, vertex.y, vertex.z);
    }
  }
  geometry.computeVertexNormals();
  return geometry;
}
function hoop(radius: number, thickness: number, at: Vec3, rotation: Vec3 = [Math.PI / 2, 0, 0], sides = 8): THREE.BufferGeometry {
  return transformed(new THREE.TorusGeometry(radius, thickness, 4, sides), at, rotation);
}
function spoke(kit: ShipKit, angle: number, geometry: THREE.BufferGeometry, layer: keyof HullGeometrySet = "armor"): void {
  kit.add(layer, geometry.rotateY(angle));
}

/** Economy models have role-specific silhouettes, authored at unit radius
 * and scaled once to the existing footprint. All details merge into the same
 * five static material layers; no per-building lights or animation objects. */
export function buildFactionEconomy(type: EconomyStructureType, faction: Faction): { body: HullGeometrySet; deck: number } {
  const kit = new ShipKit();
  const mining = type === "extractor" || type === "deepCoreExtractor" || type === "singularityHarvester";
  const refining = type === "alloyRefinery" || type === "matterForge";
  const storage = type === "storage" || type === "quantumStorage";
  const energy = type === "fusionReactor" || type === "antimatterReactor";
  const advanced = ["singularityHarvester", "matterForge", "quantumStorage", "antimatterReactor", "capitalInfrastructure"].includes(type);

  if (faction === "brood") {
    kit.add("hull", organ([0.73, 0.14, 0.73], [0, 0.07, 0]));
    for (let i = 0; i < 5; i++) spoke(kit, i * Math.PI * 2 / 5,
      rib([0, 0.1, 0.3], [0.1, 0.12, 0.72], [0.22, 0.015, 0.94], 0.065), "hull");

    if (mining) {
      // Broad, dark mouths and inward-pointing teeth read as extraction.
      const maws = type === "singularityHarvester" ? 3 : 1;
      const radius = maws === 1 ? 0.47 : 0.29;
      for (let i = 0; i < maws; i++) {
        const a = i * Math.PI * 2 / maws;
        const x = maws === 1 ? 0 : Math.sin(a) * 0.36;
        const z = maws === 1 ? 0 : Math.cos(a) * 0.36;
        kit.add("dark", cylinder(radius * 0.75, radius * 0.8, 0.08, [x, 0.18, z], 8));
        kit.add("armor", hoop(radius, 0.085, [x, 0.22, z]));
        for (let tooth = 0; tooth < 6; tooth++) {
          const t = tooth * Math.PI / 3, sx = Math.sin(t), sz = Math.cos(t);
          kit.add("armor", rib([x + sx * radius, 0.21, z + sz * radius], [x + sx * radius * 0.7, 0.55, z + sz * radius * 0.7], [x + sx * radius * 0.2, 0.3, z + sz * radius * 0.2], 0.06));
        }
      }
      if (type === "deepCoreExtractor") for (const x of [-0.57, 0.57]) {
        kit.add("hull", organ([0.19, 0.38, 0.29], [x, 0.37, 0]));
        kit.add("light", organ([0.085, 0.09, 0.17], [x, 0.62, 0]));
      }
    } else if (type === "solarArray") {
      // Five low photosynthetic fronds with raised central veins.
      for (let i = 0; i < 5; i++) {
        const a = i * Math.PI * 2 / 5;
        const leaf = [[0, 0.11], [-0.29, 0.49], [-0.2, 0.8], [0, 0.96], [0.2, 0.8], [0.29, 0.49]] as const;
        spoke(kit, a, hullShell(leaf, 0.07, 0.19), "armor");
        spoke(kit, a, rib([0, 0.29, 0.18], [0, 0.4, 0.6], [0, 0.28, 0.94], 0.018), "light");
      }
      kit.add("hull", organ([0.22, 0.23, 0.22], [0, 0.28, 0]));
    } else if (storage) {
      // Three reserve sacs; the mature reservoir gains a second tier.
      for (let i = 0; i < (advanced ? 6 : 3); i++) {
        const a = i * Math.PI * 2 / (advanced ? 6 : 3);
        const x = Math.sin(a) * 0.42, z = Math.cos(a) * 0.42;
        kit.add("hull", organ([0.23, 0.32, 0.25], [x, 0.34, z]));
        kit.add("armor", organ([0.24, 0.095, 0.26], [x, 0.6, z]));
        kit.add("accent", organ([0.07, 0.16, 0.07], [x * 1.3, 0.37, z * 1.3]));
      }
      if (advanced) {
        kit.add("hull", organ([0.3, 0.38, 0.3], [0, 0.71, 0]));
        kit.add("armor", hoop(0.25, 0.04, [0, 0.95, 0]));
      }
    } else if (refining) {
      const sacs = advanced ? 3 : 2;
      for (let i = 0; i < sacs; i++) {
        const a = i * Math.PI * 2 / sacs;
        const x = Math.cos(a) * 0.36, z = Math.sin(a) * 0.36;
        kit.add("hull", organ([0.27, 0.44, 0.28], [x, 0.5, z]));
        kit.add("armor", cylinder(0.16, 0.22, 0.22, [x, 0.9, z], 7));
        kit.add("dark", cylinder(0.12, 0.12, 0.025, [x, 1.02, z], 7));
        kit.add("light", hoop(0.23, 0.022, [x, 0.46, z]));
      }
      if (advanced) kit.add("armor", rib([0, 0.2, -0.58], [0, 1.5, -0.32], [0, 1.25, 0.18], 0.19));
      else kit.add("armor", rib([-0.35, 0.25, 0], [0, 0.7, 0.12], [0.35, 0.25, 0], 0.1));
    } else if (energy) {
      for (const x of advanced ? [0] : [-0.27, 0.27]) {
        kit.add("hull", organ([advanced ? 0.4 : 0.23, advanced ? 0.53 : 0.31, 0.3], [x, advanced ? 0.69 : 0.47, 0]));
        kit.add("light", organ([0.12, advanced ? 0.38 : 0.18, 0.22], [x, advanced ? 0.69 : 0.47, 0.15]));
      }
      for (let i = 0; i < (advanced ? 6 : 4); i++) spoke(kit, i * Math.PI * 2 / (advanced ? 6 : 4),
        rib([0, 0.14, 0.66], [0, advanced ? 1.4 : 0.94, 0.66], [0, advanced ? 1.27 : 0.8, 0.13], 0.11));
    } else {
      // Construction arms, neural research lobes, then a tall capital cortex.
      const y = type === "capitalInfrastructure" ? 0.92 : type === "advancedFabrication" ? 0.53 : 0.33;
      if (type === "advancedFabrication") for (const x of [-0.2, 0.2]) kit.add("hull", organ([0.25, 0.34, 0.39], [x, y, 0]));
      else kit.add("hull", organ([0.27, y * 0.55, 0.3], [0, y, 0]));
      kit.add("light", organ([0.11, 0.13, 0.18], [0, y + 0.26, 0]));
      for (let i = 0; i < 3; i++) spoke(kit, i * Math.PI * 2 / 3,
        rib([0, 0.16, 0.64], [0.3, y + 0.64, 0.6], [0, y + 0.4, 0.12], 0.12));
      if (advanced) for (let i = 0; i < 3; i++) spoke(kit, i * Math.PI * 2 / 3,
        organ([0.16, 0.24, 0.17], [0, 0.34, 0.65]), "accent");
    }
  } else {
    // A compact six-sided foundation, with role-specific floating assemblies.
    kit.add("hull", cylinder(0.68, 0.8, 0.16, [0, 0.08, 0], 6));
    kit.add("accent", hoop(0.61, 0.012, [0, 0.17, 0], [Math.PI / 2, 0, 0], 6));
    if (mining) {
      kit.add("dark", cylinder(0.38, 0.43, 0.03, [0, 0.18, 0], 6));
      kit.add("armor", hoop(0.53, 0.06, [0, 0.27, 0], [Math.PI / 2, 0, 0], 6));
      kit.add("light", gem([0.17, 0.39, 0.17], [0, 0.66, 0]));
      if (type !== "extractor") {
        kit.add("armor", hoop(0.4, 0.045, [0, 0.92, 0], advanced ? [0.3, 0, 0.3] : [Math.PI / 2, 0, 0], 6));
        for (let i = 0; i < 3; i++) spoke(kit, i * Math.PI * 2 / 3, gem([0.1, 0.27, 0.13], [0, 0.51, 0.62]));
      }
      if (advanced) kit.add("armor", hoop(0.48, 0.035, [0, 0.84, 0], [0, Math.PI / 2, 0.3], 6));
    } else if (type === "solarArray") {
      for (let i = 0; i < 3; i++) {
        const a = i * Math.PI * 2 / 3;
        spoke(kit, a, hullShell([[-0.13, 0.2], [-0.4, 0.64], [0, 0.98], [0.4, 0.64], [0.13, 0.2]], 0.06, 0.24));
        spoke(kit, a, gem([0.29, 0.018, 0.25], [0, 0.32, 0.63]), "hull");
        spoke(kit, a, gem([0.014, 0.025, 0.32], [0, 0.34, 0.62]), "light");
      }
      kit.add("light", gem([0.1, 0.13, 0.1], [0, 0.35, 0]));
    } else if (storage) {
      if (advanced) {
        // Two nested diamond frames enclose a sealed storage crystal.
        for (const size of [0.37, 0.6]) {
          kit.add("armor", hoop(size, 0.045, [0, 0.76, 0], [0, 0, Math.PI / 4], 4));
          kit.add("armor", hoop(size, 0.045, [0, 0.76, 0], [0, Math.PI / 2, Math.PI / 4], 4));
        }
        kit.add("hull", gem([0.25, 0.33, 0.25], [0, 0.76, 0]));
        kit.add("light", gem([0.1, 0.13, 0.1], [0, 1.16, 0]));
      } else for (let i = 0; i < 3; i++) {
        const a = i * Math.PI * 2 / 3;
        spoke(kit, a, gem([0.24, 0.26, 0.28], [0, 0.49, 0.36]));
        spoke(kit, a, gem([0.045, 0.075, 0.13], [0, 0.73, 0.36]), "light");
      }
    } else if (refining) {
      if (advanced) {
        kit.add("light", gem([0.12, 0.6, 0.12], [0, 0.82, 0]));
        for (let i = 0; i < 3; i++) spoke(kit, i * Math.PI * 2 / 3,
          gem([0.17, 0.55, 0.24], [0, 0.72 + i * 0.12, 0.35]));
        kit.add("hull", hoop(0.48, 0.05, [0, 0.39, 0], [Math.PI / 2, 0, 0], 6));
      } else for (const x of [-0.38, 0, 0.38]) {
        kit.add("armor", gem([0.16, 0.27, 0.49], [x, 0.48, 0]));
        kit.add("light", gem([0.055, 0.04, 0.34], [x, 0.75, 0]));
      }
    } else if (energy) {
      kit.add(advanced ? "dark" : "light", organ([0.24, 0.24, 0.24], [0, 0.75, 0]));
      kit.add("armor", hoop(0.5, 0.045, [0, 0.75, 0], [0.42, 0.3, 0]));
      kit.add("armor", hoop(0.42, 0.04, [0, 0.75, 0], [Math.PI / 2, 0.4, 0.4]));
      kit.add("light", hoop(0.31, 0.018, [0, 0.75, 0], [0, Math.PI / 2, -0.4]));
      if (advanced) for (let i = 0; i < 3; i++) spoke(kit, i * Math.PI * 2 / 3, gem([0.085, 0.48, 0.13], [0, 0.63, 0.64]));
    } else {
      const y = advanced ? 0.96 : type === "advancedFabrication" ? 0.68 : 0.44;
      for (let i = 0; i < 3; i++) {
        const a = i * Math.PI * 2 / 3;
        spoke(kit, a, gem([0.12, y * 0.72, 0.17], [0, y * 0.83, 0.58]));
        spoke(kit, a, gem([0.1, 0.065, 0.3], [0, y * 1.6, 0.32]));
      }
      if (type === "advancedFabrication") for (const x of [-0.18, 0.18]) kit.add("hull", gem([0.16, 0.37, 0.26], [x, 0.71, 0]));
      else kit.add("hull", gem([0.2, y * 0.5, 0.2], [0, y, 0]));
      kit.add("light", gem([0.09, y * 0.45, 0.09], [0, y + 0.1, 0]));
      if (advanced) for (const level of [0.42, 0.92, 1.42]) kit.add("armor", hoop(0.42, 0.035, [0, level, 0], [Math.PI / 2, 0, 0], 3));
    }
  }
  const radius = STRUCTURES[type].radius;
  return { body: kit.build(radius), deck: radius * 0.25 };
}
