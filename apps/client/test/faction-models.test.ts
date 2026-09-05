import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { FACTIONS, FACTION_IDS, STRUCTURES, ECONOMY_STRUCTURE_TYPES, createCombatScenario, type StructureType } from "@space-rts/game-core";
import { getShipHullGeometries, getShipMediumGeometry, getShipSilhouetteGeometry } from "../src/ship-hulls";
import { getStructureModel } from "../src/structure-models";
import { getShipDamageSites } from "../src/ship-damage";
import { InterpolatedRenderState, RenderStateBuilder, SHIP_CLASSES, VisualLod } from "../src/render-state";
import { BatchedShipRenderer } from "../src/batched-renderer";
import { FIGHTER_GUN_HEIGHT, FIGHTER_GUN_Z } from "../src/fighter-visuals";
import budgets from "./ship-budgets.json";

describe("faction artwork", () => {
  it("provides cached distinct models, finite surfaces and bounded geometry for both rosters", () => {
    for (const faction of ["brood", "concord"] as const) {
      let close = 0, baselineClose = 0, medium = 0, baselineMedium = 0;
      for (const shipClass of FACTIONS[faction].ships) {
        const model = getShipHullGeometries(shipClass, faction);
        expect(getShipHullGeometries(shipClass, faction)).toBe(model);
        expect(model).not.toBe(getShipHullGeometries(shipClass));
        const bounds = new THREE.Box3();
        let vertices = 0;
        for (const geometry of Object.values(model)) {
          const p = geometry.getAttribute("position"), n = geometry.getAttribute("normal");
          vertices += p.count;
          for (let i = 0; i < p.count; i++) {
            expect(Number.isFinite(p.getX(i) + p.getY(i) + p.getZ(i))).toBe(true);
            expect(Math.hypot(n.getX(i), n.getY(i), n.getZ(i))).toBeCloseTo(1, 4);
          }
          if (p.count) { geometry.computeBoundingBox(); bounds.union(geometry.boundingBox!); }
        }
        const size = bounds.getSize(new THREE.Vector3());
        expect(size.x / budgets[shipClass].width, `${faction} ${shipClass} width`).toBeGreaterThan(0.84);
        expect(size.x / budgets[shipClass].width, `${faction} ${shipClass} width`).toBeLessThan(1.15);
        expect(size.z / budgets[shipClass].length, `${faction} ${shipClass} length`).toBeGreaterThan(0.85);
        expect(size.z / budgets[shipClass].length, `${faction} ${shipClass} length`).toBeLessThan(1.15);
        const silhouette = getShipSilhouetteGeometry(shipClass, faction);
        expect(silhouette.getAttribute("position").count).toBeLessThanOrEqual(budgets[shipClass].farVertices);
        expect(silhouette.getAttribute("normal").getY(0)).toBeGreaterThan(0.99);
        close += vertices; baselineClose += budgets[shipClass].vertices;
        medium += getShipMediumGeometry(shipClass, "hull", faction).getAttribute("position").count
          + getShipMediumGeometry(shipClass, "armor", faction).getAttribute("position").count + model.accent.getAttribute("position").count;
        baselineMedium += budgets[shipClass].mediumVertices;
      }
      expect(close, `${faction} close budget`).toBeLessThanOrEqual(baselineClose);
      expect(medium, `${faction} medium budget`).toBeLessThanOrEqual(baselineMedium);
    }
  });

  it("attaches damage to faction surfaces, including detached Concord blades", () => {
    const ray = new THREE.Raycaster();
    for (const faction of ["brood", "concord"] as const) for (const shipClass of FACTIONS[faction].ships.filter(c => c !== "fighter")) {
      const sites = getShipDamageSites(shipClass, faction);
      expect(sites.length, `${faction} ${shipClass}`).toBeGreaterThanOrEqual(3);
      const model = getShipHullGeometries(shipClass, faction);
      const surfaces = [new THREE.Mesh(model.hull), new THREE.Mesh(model.armor)];
      for (const site of sites) {
        const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(site.orientation);
        ray.set(site.position.clone().addScaledVector(normal, 0.2), normal.clone().negate());
        expect(ray.intersectObjects(surfaces)[0]?.distance).toBeCloseTo(0.26, 3);
      }
      surfaces.forEach(s => (s.material as THREE.Material).dispose());
    }
  });

  it("replaces every building body and keeps weapon foundations within its footprint", () => {
    for (const type of Object.keys(STRUCTURES) as StructureType[]) for (const faction of ["brood", "concord"] as const) {
      const model = getStructureModel(type, faction);
      expect(getStructureModel(type, faction)).toBe(model);
      expect(model.body).not.toBe(getStructureModel(type).body);
      let vertices = 0;
      for (const geometry of Object.values(model.body)) {
        vertices += geometry.getAttribute("position").count;
        geometry.computeBoundingBox();
        if (!geometry.getAttribute("position").count) continue;
        const size = geometry.boundingBox!.getSize(new THREE.Vector3());
        expect(size.x).toBeLessThan(STRUCTURES[type].radius * 2.2);
        expect(size.z).toBeLessThan(STRUCTURES[type].radius * 2.2);
      }
      expect(vertices).toBeGreaterThan(100);
      expect(vertices).toBeLessThan(6_000);
    }
  });

  it("routes same-class mixed-faction units to separate batches at every LOD", () => {
    const simulation = createCombatScenario({ enemyCommander: false, startingFleet: true });
    const base = simulation.state.ships.find(s => s.class === "frigate")!;
    const ships = FACTION_IDS.map((faction, i) => ({ ...base, id: 100 + i, faction, x: i * 30 - 30, y: 0, z: 0 }));
    const camera = new THREE.PerspectiveCamera(48, 1, 1, 8_000);
    camera.position.set(0, 100, 200); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    const state = new RenderStateBuilder().update({ players: simulation.state.players, ships }, new Map(), 1, camera, 1080, camera.position.length(), new Set(), "high", 0);
    expect([...state.shipFaction.slice(0, 3)]).toEqual([0, 1, 2]);
    const renderer = new BatchedShipRenderer(new THREE.Scene());
    for (const lod of [VisualLod.Close, VisualLod.Medium, VisualLod.Far, VisualLod.Tactical]) {
      state.shipLod.fill(lod, 0, 3);
      renderer.update(state, 0, camera, 1080);
      const active = renderer.group.children.filter((o): o is THREE.InstancedMesh => o instanceof THREE.InstancedMesh && o.count > 0);
      const geometryFor = (faction: typeof FACTION_IDS[number]) => lod === VisualLod.Close ? getShipHullGeometries("frigate", faction).hull
        : lod === VisualLod.Medium ? getShipMediumGeometry("frigate", "hull", faction) : getShipSilhouetteGeometry("frigate", faction);
      if (lod !== VisualLod.Tactical) for (const faction of FACTION_IDS) expect(active.some(mesh => mesh.geometry === geometryFor(faction))).toBe(true);
      expect(renderer.metrics.shipInstances).toBe(3);
      expect(active.length).toBeLessThan(40);
    }
  });

  it("supplies distinct industrial paint colors, including damaged and simplified ships", () => {
    const state = new InterpolatedRenderState();
    state.shipClass.fill(SHIP_CLASSES.indexOf("frigate"));
    state.shipEngine.fill(1);
    for (let i = 0; i < 770; i++) {
      state.shipIds[i] = i + 1;
      state.shipColor[i] = i % 2 === 0 ? 0x55b8ff : 0xff5a78;
    }
    const renderer = new BatchedShipRenderer(new THREE.Scene());
    const camera = new THREE.PerspectiveCamera();
    const blue = new THREE.Color(), red = new THREE.Color();
    for (const [count, lod, health] of [
      [2, VisualLod.Close, 1], [2, VisualLod.Medium, 1], [2, VisualLod.Far, 1],
      [770, VisualLod.Medium, 1], [2, VisualLod.Close, 0.25],
    ] as const) {
      state.shipCount = count;
      state.shipLod.fill(lod);
      state.shipHealth.fill(health);
      renderer.update(state, 0, camera, 720);
      const hull = lod === VisualLod.Far || count > 768 ? getShipSilhouetteGeometry("frigate")
        : lod === VisualLod.Medium ? getShipMediumGeometry("frigate", "hull") : getShipHullGeometries("frigate").hull;
      const geometry = [hull];
      if (lod !== VisualLod.Far && count <= 768) geometry.push(lod === VisualLod.Medium
        ? getShipMediumGeometry("frigate", "armor") : getShipHullGeometries("frigate").armor);
      for (const surface of geometry) {
        const batch = renderer.group.children.find((o): o is THREE.InstancedMesh =>
          o instanceof THREE.InstancedMesh && o.count > 0 && o.geometry === surface)!;
        expect(batch).toBeDefined();
        batch.getColorAt(0, blue); batch.getColorAt(1, red);
        // The shader consumes these as masked paint, not a whole-hull tint.
        // Preserve saturated ownership inputs even when armor is culled.
        expect(blue.b - blue.r).toBeGreaterThan(0.35);
        expect(red.r - red.b).toBeGreaterThan(0.35);
      }
    }
  });

  it("gives every economy role and tier distinct geometry rather than rescaling one body", () => {
    for (const faction of ["brood", "concord"] as const) {
      const shapes = new Set<string>();
      for (const type of ECONOMY_STRUCTURE_TYPES) {
        const body = getStructureModel(type, faction).body;
        const radius = STRUCTURES[type].radius;
        const signature: string[] = [];
        for (const geometry of Object.values(body)) {
          const p = geometry.getAttribute("position"), n = geometry.getAttribute("normal");
          for (let i = 0; i < p.count; i++) {
            expect(Number.isFinite(p.getX(i) + p.getY(i) + p.getZ(i))).toBe(true);
            expect(Math.hypot(n.getX(i), n.getY(i), n.getZ(i))).toBeCloseTo(1, 4);
            signature.push(`${Math.round(p.getX(i) / radius * 100)},${Math.round(p.getY(i) / radius * 100)},${Math.round(p.getZ(i) / radius * 100)}`);
          }
        }
        shapes.add(signature.join(";"));
      }
      expect(shapes.size, faction).toBe(ECONOMY_STRUCTURE_TYPES.length);
    }
  });

  it("keeps all five alien fighter members and aligns their guns through LOD changes", () => {
    const renderer = new BatchedShipRenderer(new THREE.Scene());
    const camera = new THREE.PerspectiveCamera();
    const state = new InterpolatedRenderState();
    state.shipCount = 2;
    state.shipIds.set([21, 22]); state.shipFaction.set([1, 2]);
    state.shipHealth.fill(1); state.shipEngine.fill(1); state.shipColor.fill(0xffffff);
    state.shipYaw.fill(0.7); state.shipBank.fill(0.3);
    const muzzle = new THREE.Vector3(), matrix = new THREE.Matrix4();
    for (const lod of [VisualLod.Close, VisualLod.Medium, VisualLod.Far]) {
      state.shipLod.fill(lod);
      renderer.update(state, 1000, camera, 720);
      for (const [index, faction] of (["brood", "concord"] as const).entries()) {
        const geometry = lod === VisualLod.Close ? getShipHullGeometries("fighter", faction).hull
          : lod === VisualLod.Medium ? getShipMediumGeometry("fighter", "hull", faction) : getShipSilhouetteGeometry("fighter", faction);
        const batch = renderer.group.children.find((mesh): mesh is THREE.InstancedMesh => mesh instanceof THREE.InstancedMesh && mesh.geometry === geometry && mesh.count > 0)!;
        expect(batch.count).toBe(5);
        for (let member = 0; member < 5; member++) {
          expect(renderer.getFighterMuzzle(21 + index, member, member, muzzle)).toBe(true);
          batch.getMatrixAt(member, matrix); muzzle.applyMatrix4(matrix.invert());
          expect(muzzle.y).toBeCloseTo(FIGHTER_GUN_HEIGHT, 4);
          expect(muzzle.z).toBeCloseTo(FIGHTER_GUN_Z, 4);
        }
      }
    }
  });
});
