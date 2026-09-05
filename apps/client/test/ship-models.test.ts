import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { ALL_SHIP_CLASSES, SHIPS } from "@space-rts/game-core";
import { getShipHullGeometries, getShipSilhouetteGeometry, getShipMediumGeometry } from "../src/ship-hulls";
import { getShipDamageSites } from "../src/ship-damage";
import { CombatEffectRenderer } from "../src/batched-renderer";
import budgets from "./ship-budgets.json";

describe("fleet geometry budgets and physical scale", () => {
  it("keeps fleet detail and distant silhouettes within the original aggregate vertex budget", () => {
    let close = 0, medium = 0, far = 0, originalClose = 0, originalMedium = 0, originalFar = 0;
    for (const name of ALL_SHIP_CLASSES) {
      const hull = getShipHullGeometries(name);
      const vertices = Object.values(hull).reduce((sum, g) => sum + g.getAttribute("position").count, 0);
      const silhouetteVertices = getShipSilhouetteGeometry(name).getAttribute("position").count;
      close += vertices; far += silhouetteVertices;
      medium += getShipMediumGeometry(name, "hull").getAttribute("position").count
        + getShipMediumGeometry(name, "armor").getAttribute("position").count
        + hull.accent.getAttribute("position").count;
      originalMedium += budgets[name].mediumVertices;
      originalClose += budgets[name].vertices; originalFar += budgets[name].farVertices;
      expect(vertices, name).toBeLessThan(budgets[name].vertices * 1.2);
      expect(silhouetteVertices, `${name} far LOD`).toBeLessThanOrEqual(budgets[name].farVertices);
      const bounds = new THREE.Box3();
      for (const [layer, geometry] of Object.entries(hull)) {
        const positions = geometry.getAttribute("position");
        const normals = geometry.getAttribute("normal");
        for (let i = 0; i < positions.count; i += 1) {
          expect(Number.isFinite(positions.getX(i) + positions.getY(i) + positions.getZ(i)), name).toBe(true);
          expect(Math.hypot(normals.getX(i), normals.getY(i), normals.getZ(i)), `${name} normal`).toBeCloseTo(1, 4);
        }
        if (layer === "engine" || positions.count === 0) continue;
        geometry.computeBoundingBox();
        bounds.union(geometry.boundingBox!);
      }
      const size = bounds.getSize(new THREE.Vector3());
      expect(size.x / budgets[name].width, `${name} beam`).toBeGreaterThan(0.84);
      expect(size.x / budgets[name].width, `${name} beam`).toBeLessThan(1.14);
      expect(size.z / budgets[name].length, `${name} length`).toBeGreaterThan(0.86);
      expect(size.z / budgets[name].length, `${name} length`).toBeLessThan(1.12);
    }
    expect(close).toBeLessThan(originalClose);
    expect(medium).toBeLessThan(originalMedium);
    expect(far).toBeLessThan(originalFar);
  });

  it("anchors damage on real upward-facing hull surfaces, including ships with open decks", () => {
    const ray = new THREE.Raycaster();
    for (const name of ALL_SHIP_CLASSES.filter(c => c !== "fighter" && c !== "bomber")) {
      const sites = getShipDamageSites(name);
      expect(sites.length, name).toBeGreaterThanOrEqual(3);
      expect(getShipDamageSites(name)).toBe(sites);
      const hull = getShipHullGeometries(name);
      const surfaces = [new THREE.Mesh(hull.hull), new THREE.Mesh(hull.armor)];
      for (const site of sites) {
        const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(site.orientation);
        expect(normal.y, name).toBeGreaterThan(0.3);
        ray.set(site.position.clone().addScaledVector(normal, 0.2), normal.clone().negate());
        const hit = ray.intersectObjects(surfaces)[0];
        expect(hit, name).toBeDefined();
        expect(hit!.distance, name).toBeCloseTo(0.26, 3);
      }
      surfaces.forEach(mesh => (mesh.material as THREE.Material).dispose());
    }
  });
});

describe("pooled damage effects", () => {
  it("fades each effect independently and never exceeds fixed pool capacities", () => {
    const effects = new CombatEffectRenderer(new THREE.Scene());
    const camera = new THREE.PerspectiveCamera();
    effects.spawnDamageImpact(0, 0, 0, SHIPS.cruiser.radius, 12, 40, false, 1_000, "cruiser");
    effects.update(1_030, camera);
    const alpha = effects.flash.mesh.geometry.getAttribute("effectOpacity").getX(0);
    expect(alpha).toBeGreaterThan(0.5);
    effects.update(1_180, camera);
    expect(effects.flash.mesh.geometry.getAttribute("effectOpacity").getX(0)).toBeLessThan(alpha);
    for (let i = 0; i < 2_000; i += 1) effects.spawnShipDeath(0, 0, 0, 0xff6644, 30, 0, 0, i, 2_000);
    effects.update(2_100, camera);
    for (const pool of [effects.flash, effects.shock, effects.debris, effects.wreck]) {
      expect(pool.activeCount).toBeLessThanOrEqual(pool.capacity);
      expect(pool.mesh.instanceMatrix.updateRanges).toHaveLength(1);
    }
    effects.update(10_000, camera);
    expect(effects.activeCount).toBe(0);
  });
});
