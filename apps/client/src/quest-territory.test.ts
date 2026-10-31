import { describe, expect, it } from "vitest";
import { BufferAttribute, Group, PerspectiveCamera, ShaderMaterial } from "three";
import { MarchingCubes } from "three/addons/objects/MarchingCubes.js";
import { QuestBattle } from "./quest-combat";
import { DEMO_DEFENSES, DEMO_ENCOUNTERS, QuestDemo } from "./quest-demo";
import { QuestTerritoryView, territoryInfluence } from "./quest-territory";
import { inBattleVolume } from "./quest-direct-input";

describe("space fronts", () => {
  it("uses height as well as horizontal distance and excludes dead or unfinished installations", () => {
    const battle = new QuestBattle(), station = battle.spawnStructure(0, "plasmaBattery", { x: 0, y: 0.7, z: 0 });
    const center = territoryInfluence(station, station.position);
    expect(center).toBeGreaterThan(territoryInfluence(station, { x: 0, y: 1.7, z: 0 }));
    expect(territoryInfluence(station, { x: 0, y: 3, z: 0 })).toBe(0);
    station.health *= 0.25; station.shields = 0;
    expect(territoryInfluence(station, station.position)).toBeLessThan(center);
    station.construction = 20; expect(territoryInfluence(station, station.position)).toBe(0);
    station.construction = 0; station.health = 0; expect(territoryInfluence(station, station.position)).toBe(0);
  });

  it("anchors three spatially separated fronts with bounded, stationary defenses on both sides", () => {
    const demo = new QuestDemo(), battle = demo.create();
    const defenses = () => battle.entities.filter(e => e.structureType && e.encounterId !== undefined && e.health > 0);
    expect(new Set(DEMO_ENCOUNTERS.map(e => e.center.y)).size).toBe(3);
    expect(new Set(DEMO_ENCOUNTERS.map(e => e.center.z)).size).toBe(3);
    expect(defenses()).toHaveLength(DEMO_ENCOUNTERS.length * 2 * DEMO_DEFENSES.length);
    for (const station of defenses()) expect(inBattleVolume(station.position, battle.volume)).toBe(true);
    const station = defenses()[0]!, position = { ...station.position };
    for (let i = 0; i < 60; i++) { battle.advance(0.05); demo.update(battle); }
    expect(station.position).toEqual(position);
    station.health = 0; battle.tick = 240; demo.update(battle);
    expect(defenses()).toHaveLength(18);
    battle.tick = 480; demo.update(battle); expect(defenses()).toHaveLength(18);
    expect(battle.entities.filter(e => e.health > 0).length).toBeLessThanOrEqual(160);
  });

  it("creates genuine 3D territory meshes, freezes with simulation time and replaces them on reset", () => {
    const battle = new QuestDemo().create(), world = new Group(), view = new QuestTerritoryView(world), camera = new PerspectiveCamera();
    camera.position.set(0, 6, 20);
    const start = performance.now(); view.update(battle, true, camera);
    const surfaces = world.children as MarchingCubes[];
    expect(surfaces).toHaveLength(2);
    for (const surface of surfaces) {
      expect(surface.geometry.drawRange.count).toBeGreaterThan(0);
      expect(surface.geometry.drawRange.count).toBeLessThanOrEqual(surface.geometry.getAttribute("position").count);
      surface.geometry.computeBoundingBox();
      const box = surface.geometry.boundingBox!;
      // Ignore unused buffer capacity; geometry must extend vertically, not lie on a map plane.
      expect(box.max.y - box.min.y).toBeGreaterThan(0.1);
      expect((surface.material as ShaderMaterial).depthWrite).toBe(false);
    }
    const version = (surfaces[0]!.geometry.getAttribute("position") as BufferAttribute).version;
    battle.entities = []; view.update(battle, true, camera);
    expect((surfaces[0]!.geometry.getAttribute("position") as BufferAttribute).version).toBe(version);
    battle.tick = 10; view.update(battle, true, camera);
    expect(surfaces.every(s => s.geometry.drawRange.count === 0)).toBe(true);
    view.update(new QuestBattle(), false, camera);
    expect(world.children).toHaveLength(0);
    console.info(`3D territory initial build: ${(performance.now() - start).toFixed(1)} ms on this host (includes test checks and reset).`);
  });

  it("keeps repeated shared-front rebuilds inside fixed geometry buffers", () => {
    const battle = new QuestDemo().create(), world = new Group(), view = new QuestTerritoryView(world), camera = new PerspectiveCamera();
    camera.position.set(0, 6, 20); view.update(battle, true, camera);
    const times: number[] = [];
    for (let i = 0; i < 12; i++) {
      battle.tick += 10; const start = performance.now(); view.update(battle, true, camera); times.push(performance.now() - start);
      for (const mesh of world.children as MarchingCubes[]) expect(mesh.geometry.drawRange.count).toBeLessThanOrEqual(mesh.geometry.getAttribute("position").count);
    }
    times.sort((a, b) => a - b);
    console.info(`Shared 3D front rebuild: median ${times[6]!.toFixed(1)} ms, max ${times[11]!.toFixed(1)} ms on this host; two draw calls (not headset timings).`);
  });
});
