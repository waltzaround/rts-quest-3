import { describe, expect, it } from "vitest";
import { Group, InstancedMesh, PerspectiveCamera, Vector3 } from "three";
import { TRAINABLE, QuestBattle } from "./quest-combat";
import { QuestBattleView } from "./quest-battle-view";
import { strategicIcon, strategicIconRadius, strategicOverview } from "./quest-strategic";
import { createTacticalGeometry } from "./tactical-icons";
import { directContact, inBattleVolume } from "./quest-direct-input";
import { DEMO_ENCOUNTERS, DEMO_COMBAT_SITES, DEMO_VOLUME, QuestDemo } from "./quest-demo";
import { ENCOUNTER_EXTENTS } from "./quest-simulation";

describe("strategic view", () => {
  it("uses hysteresis so small tracking movements do not flicker between icons and hulls", () => {
    expect(strategicIcon(9)).toBe(true); expect(strategicIcon(5)).toBe(false); expect(strategicIcon(2)).toBe(false);
    expect(strategicIcon(7.2, true)).toBe(true); expect(strategicIcon(7.2, false)).toBe(false);
    expect(strategicIconRadius(100)).toBeLessThanOrEqual(0.22);
    for (const type of TRAINABLE) {
      const geometry = createTacticalGeometry(type);
      expect(geometry.getAttribute("position").count).toBeGreaterThan(0); geometry.dispose();
    }
  });
  it("replaces ships with selectable icons and restores hull detail when approached", () => {
    const battle = new QuestBattle(), world = new Group(), view = new QuestBattleView(world), camera = new PerspectiveCamera();
    view.reset(battle); camera.position.set(0, 2, 16); camera.lookAt(0, 0.7, 0);
    view.update(battle, new Set(), camera, 0);
    expect(view.iconRadii.size).toBe(battle.entities.length);
    for (const id of view.iconGroups.keys()) view.expandGroup(id);
    view.update(battle, new Set(), camera, 0);
    const ship = battle.fleet(0)[0]!;
    expect(directContact(battle.entities, view.iconPositions.get(ship.id)!, 1, 0, view.iconRadii, view.iconPositions)?.id).toBe(ship.id);
    expect(view.pickables.find(p => p.userData.entityId === ship.id)!.scale.x).toBeCloseTo(view.iconRadii.get(ship.id)!);
    const hasFlags = () => world.children.some(child => child instanceof InstancedMesh && child.renderOrder === 10 && child.count > 0);
    expect(hasFlags()).toBe(true);
    battle.entities.forEach(e => { e.encounterId = 0; });
    view.update(battle, new Set(), camera, 0, true);
    expect(hasFlags()).toBe(false);
    expect(view.iconRadii.size).toBe(0);
    expect(view.iconPositions.size).toBe(0);
    expect(view.pickables).toHaveLength(0);
    view.update(battle, new Set(), camera, 0, false);
    expect(hasFlags()).toBe(true);
    expect(view.iconRadii.size).toBe(battle.entities.length);
    camera.position.copy(ship.position).add(new Vector3(0, 0.2, 0.5));
    view.update(battle, new Set([ship.id]), camera, 0);
    expect(view.iconRadii.has(ship.id)).toBe(false);
    expect(battle.fleet(0)[0]!.health).toBe(ship.maxHealth);
  });
});

describe("separate demo encounters", () => {
  it("supports orders and navigation in the expanded volume without changing normal skirmishes", () => {
    const battle = new QuestBattle(DEMO_VOLUME);
    const ship = battle.spawnShip(0, "frigate", { x: 4, y: 2, z: -2 });
    expect(ship.position.x).toBe(4);
    expect(inBattleVolume(ship.position, battle.volume)).toBe(true);
    expect(inBattleVolume(ship.position)).toBe(false);
    battle.issue(0, [ship.id], "move", { x: 4.5, y: 2.2, z: -2 });
    expect(ship.target.x).toBeCloseTo(4.5);
    expect(new QuestBattle().volume.x).toBe(1.35);
  });
  it("keeps three live fights separated with their own targets and reinforcements", () => {
    const demo = new QuestDemo(); let battle = demo.create();
    const fired = new Set<number>();
    for (let tick = 0; tick < 1200; tick++) {
      battle.advance(0.05); battle = demo.update(battle);
      battle.projectiles.forEach(p => { if (p.encounterId !== undefined) fired.add(p.encounterId); });
      if (tick % 60 === 0) for (const ship of battle.entities.filter(e => e.shipClass)) {
        const site = DEMO_COMBAT_SITES[ship.encounterId!]!;
        if (ship.supplyTransit) { expect(inBattleVolume(ship.position, battle.volume)).toBe(true); continue; }
        expect(Math.abs(ship.position.x - site.center.x)).toBeLessThanOrEqual(site.extents.x + 0.001);
        expect(Math.abs(ship.position.y - site.center.y)).toBeLessThanOrEqual(site.extents.y + 0.001);
        expect(Math.abs(ship.position.z - site.center.z)).toBeLessThanOrEqual(site.extents.z + 0.001);
        const target = battle.getEntity(ship.focusId);
        if (target) expect(target.encounterId).toBe(ship.encounterId);
      }
    }
    expect([...fired].sort()).toEqual(DEMO_COMBAT_SITES.map(site => site.id));
    for (const site of DEMO_COMBAT_SITES) {
      const casualty = battle.fleet(0).find(e => e.encounterId === site.id)!; casualty.health = 0;
    }
    battle.tick += 60; demo.update(battle);
    for (const site of DEMO_COMBAT_SITES) for (const side of [0, 1] as const)
      expect(battle.fleet(side).filter(e => e.encounterId === site.id)).toHaveLength(site.roster.length);
  }, 15000); // One simulated minute with defenses and travelling replacements.
});

it("keeps the flag layer well beyond the model threshold and reserves counts for the furthest zoom", () => {
  expect(strategicIcon(16)).toBe(true);
  expect(strategicOverview(16)).toBe(false);
  expect(strategicOverview(30)).toBe(false);
  expect(strategicOverview(34)).toBe(true);
  expect(strategicOverview(30, true)).toBe(true);
  expect(strategicOverview(26, true)).toBe(false);
});
