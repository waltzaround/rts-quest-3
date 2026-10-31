import { describe, expect, it } from "vitest";
import { Group, InstancedMesh, LineSegments, PerspectiveCamera } from "three";
import { weaponEffectStrength } from "./quest-effect-visibility";
import { QuestBattle } from "./quest-combat";
import { QuestBattleView } from "./quest-battle-view";

describe("quiet strategic weapon effects", () => {
  it("fades with distance and retains beams crossing nearby space", () => {
    const camera = { x: 0, y: 0, z: 0 };
    expect(weaponEffectStrength(camera, { x: 2, y: 0, z: 0 })).toBe(1);
    expect(weaponEffectStrength(camera, { x: 6, y: 0, z: 0 })).toBeCloseTo(0.5);
    expect(weaponEffectStrength(camera, { x: 8, y: 0, z: 0 })).toBe(0);
    expect(weaponEffectStrength(camera, { x: -20, y: 0, z: 0 }, { x: 20, y: 0, z: 0 })).toBe(1);
    expect(weaponEffectStrength(camera, { x: 0, y: 0, z: 0 }, undefined, true)).toBe(0);
  });
  it("clears every effect pass in overview and restores local combat without changing shots", () => {
    const battle = new QuestBattle(), world = new Group(), view = new QuestBattleView(world), camera = new PerspectiveCamera();
    battle.entities = [battle.fleet(0)[0]!];
    battle.entities[0]!.position = battle.entities[0]!.previousPosition = { x: 0, y: 1, z: 0 };
    const point = { x: 0, y: 1, z: 0 };
    battle.projectiles.push({ id: 9000, side: 0, weapon: "heavyRail", position: point, previous: point, velocity: { x: 1, y: 0, z: 0 }, life: 10, damage: 1, radius: 0.01 });
    battle.events.push({ kind: "beam", from: point, to: { x: 1, y: 1, z: 0 }, color: 0xffffff, tick: 0 },
      { kind: "destroy", from: point, to: point, color: 0xffffff, tick: 0 });
    camera.position.set(0, 1, 2); camera.lookAt(0, 1, 0);
    view.update(battle, new Set(), camera, 0);
    const trails = world.getObjectByName("weapon-trails") as LineSegments;
    const heads = world.getObjectByName("weapon-heads") as InstancedMesh;
    const flashes = world.getObjectByName("weapon-flashes") as InstancedMesh;
    const shockwaves = world.getObjectByName("weapon-shockwaves") as InstancedMesh;
    expect(trails.geometry.drawRange.count).toBeGreaterThan(0);
    expect(heads.count).toBe(1); expect(flashes.count).toBe(1); expect(shockwaves.count).toBe(1);
    camera.position.z = 40; view.update(battle, new Set(), camera, 0);
    expect(trails.geometry.drawRange.count).toBe(0);
    expect(heads.count).toBe(0); expect(flashes.count).toBe(0); expect(shockwaves.count).toBe(0);
    camera.position.z = 2; view.update(battle, new Set(), camera, 0);
    expect(trails.geometry.drawRange.count).toBeGreaterThan(0);
    expect(heads.count).toBe(1); expect(flashes.count).toBe(1);
    expect(battle.projectiles).toHaveLength(1); expect(battle.projectiles[0]!.damage).toBe(1);
  });
});
