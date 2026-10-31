import { describe, expect, it } from "vitest";
import { Group, InstancedMesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry } from "three";
import { cardWeight, easeView, modelWeight } from "./quest-view-transition";
import { writeInstanceFade } from "./quest-instance-fade";
import { QuestBattle } from "./quest-combat";
import { QuestBattleView } from "./quest-battle-view";
import { directContact } from "./quest-direct-input";

describe("smooth strategic view transitions", () => {
  it("keeps a broad pure-icon band and complementary representation weights", () => {
    expect(modelWeight(8)).toBe(1); expect(modelWeight(10.5)).toBe(0);
    expect(cardWeight(27)).toBe(0); expect(cardWeight(32)).toBe(1);
    expect(modelWeight(18)).toBe(0); expect(cardWeight(18)).toBe(0);
    for (let distance = 0; distance < 45; distance += 0.1) {
      const cards = cardWeight(distance), models = modelWeight(distance) * (1 - cards), icons = (1 - modelWeight(distance)) * (1 - cards);
      expect(cards + models + icons).toBeCloseTo(1);
      expect(Math.abs(modelWeight(distance) - modelWeight(distance + 0.01))).toBeLessThan(0.007);
      expect(Math.abs(cardWeight(distance) - cardWeight(distance + 0.01))).toBeLessThan(0.004);
    }
  });
  it("eases fast reversals without jumps and behaves equally at headset refresh rates", () => {
    const run = (hz: number) => { let value = 0; for (let i = 0; i < hz / 2; i++) value = easeView(value, 1, 1 / hz); return value; };
    expect(run(72)).toBeCloseTo(run(120), 6);
    const outward = easeView(0, 1, 1 / 90), inward = easeView(outward, 0, 1 / 90);
    expect(outward).toBeGreaterThan(0); expect(outward).toBeLessThan(0.1);
    expect(inward).toBeGreaterThan(0); expect(inward).toBeLessThan(outward);
  });
  it("returns decluttered icons to moving ships before hulls fade in and reverses smoothly", () => {
    const battle = new QuestBattle(), ships = battle.fleet(0).slice(0, 3);
    battle.entities = ships;
    for (const ship of ships) ship.position = ship.previousPosition = { x: 0, y: 0, z: 0 };
    const view = new QuestBattleView(new Group()), camera = new PerspectiveCamera();
    view.reset(battle); camera.position.set(0, 0, 18); camera.lookAt(0, 0, 0);
    view.update(battle, new Set(), camera, 0);
    const displaced = ships.find(ship => view.iconPositions.get(ship.id)!.length() > 0.1)!;
    expect(displaced).toBeDefined();
    let previousOffset = Infinity;
    for (const distance of [18, 16, 14, 12, 10.5]) {
      camera.position.z = distance; view.update(battle, new Set(), camera, 0);
      const offset = view.iconPositions.get(displaced.id)!.length();
      expect(offset).toBeLessThan(previousOffset); previousOffset = offset;
      expect(view.pickables.find(proxy => proxy.userData.entityId === displaced.id)!.position.equals(view.iconPositions.get(displaced.id)!)).toBe(true);
    }
    expect(previousOffset).toBeCloseTo(0);
    // Moving simulation anchors stay exact during the hull crossfade.
    for (const ship of ships) ship.position = ship.previousPosition = { x: 0.2, y: 0.1, z: 0 };
    camera.position.z = 9.4; view.update(battle, new Set(), camera, 0);
    expect(view.iconPositions.get(displaced.id)!.toArray()).toEqual([0.2, 0.1, 0]);
    camera.position.z = 18; view.update(battle, new Set(), camera, 1 / 90);
    const outgoing = view.iconPositions.get(displaced.id)!.clone().sub({ x: 0.2, y: 0.1, z: 0 }).length();
    expect(outgoing).toBeGreaterThan(0); expect(outgoing).toBeLessThan(0.06);
    camera.position.z = 10; view.update(battle, new Set(), camera, 1 / 90);
    expect(view.iconPositions.get(displaced.id)!.clone().sub({ x: 0.2, y: 0.1, z: 0 }).length()).toBeLessThan(outgoing);
    expect(displaced.position).toEqual({ x: 0.2, y: 0.1, z: 0 });
  });
  it("shares vertex buffers while keeping opacity independent for each instance and batch", () => {
    const geometry = new PlaneGeometry(), material = new MeshBasicMaterial();
    const a = new InstancedMesh(geometry, material, 3), b = new InstancedMesh(geometry, material, 3);
    writeInstanceFade(a, 0, 0.25); writeInstanceFade(a, 1, 0.75); writeInstanceFade(b, 0, 0.9);
    expect(a.geometry.getAttribute("position")).toBe(geometry.getAttribute("position"));
    expect(a.geometry.getAttribute("questFade").getX(0)).toBeCloseTo(0.25);
    expect(a.geometry.getAttribute("questFade").getX(1)).toBeCloseTo(0.75);
    expect(b.geometry.getAttribute("questFade").getX(0)).toBeCloseTo(0.9);
    expect(geometry.getAttribute("questFade")).toBeUndefined(); expect(material.alphaHash).toBe(false);
  });
  it("renders both hull and symbol during the blend, then hands picking to the dominant layer", () => {
    const battle = new QuestBattle(), ship = battle.fleet(0)[0]!;
    battle.entities = [ship]; ship.position = ship.previousPosition = { x: 0, y: 0, z: 0 }; ship.encounterId = 0;
    const world = new Group(), view = new QuestBattleView(world), camera = new PerspectiveCamera(); view.reset(battle);
    camera.position.set(0, 0, 9.25); camera.lookAt(0, 0, 0); view.update(battle, new Set(), camera, 0);
    const fading = world.children.filter((mesh): mesh is InstancedMesh => mesh instanceof InstancedMesh && mesh.count > 0 && !!mesh.geometry.getAttribute("questFade"));
    expect(fading.some(mesh => mesh.renderOrder === 10)).toBe(true);
    expect(fading.some(mesh => mesh.renderOrder === 0)).toBe(true);
    for (const mesh of fading) expect(mesh.geometry.getAttribute("questFade").getX(0)).toBeCloseTo(0.5);
    camera.position.z = 5; view.update(battle, new Set(), camera, 1 / 90);
    expect(view.iconRadii.has(ship.id)).toBe(false); expect(view.pickableIds.has(ship.id)).toBe(true);
    camera.position.z = 18; view.update(battle, new Set(), camera, 0, 0.25);
    expect(view.iconRadii.has(ship.id)).toBe(true);
    view.update(battle, new Set(), camera, 0, 0.75);
    expect(view.pickableIds.size).toBe(0);
    expect(directContact(battle.entities, ship.position, 1, 0, view.iconRadii, view.iconPositions, view.pickableIds)).toBeUndefined();
    view.update(battle, new Set(), camera, 0, 1);
    expect(view.iconRadii.size).toBe(0);
    expect(world.children.some(mesh => mesh instanceof InstancedMesh && mesh.renderOrder === 10 && mesh.count > 0)).toBe(false);
    expect(ship.position).toEqual({ x: 0, y: 0, z: 0 });
  });
});
