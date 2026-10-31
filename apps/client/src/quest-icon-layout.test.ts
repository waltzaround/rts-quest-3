import { describe, expect, it } from "vitest";
import { Group, PerspectiveCamera, Vector3 } from "three";
import { ICON_HALF_ANGLE, MAX_ICON_OFFSET, QuestIconLayout } from "./quest-icon-layout";
import { createQuestNatoIcon } from "./quest-nato-icons";
import { QuestBattle, TRAINABLE } from "./quest-combat";
import { QuestBattleView } from "./quest-battle-view";
import { directContact } from "./quest-direct-input";

describe("NATO unit symbols and decluttering", () => {
  it("bounds dense-fleet displacement, retains stable offsets, and expires missing units", () => {
    const layout = new QuestIconLayout();
    const input = Array.from({ length: 160 }, (_, id) => ({ id, x: 0, y: 0 }));
    const result = layout.arrange(input), points = [...result.values()];
    expect(points).toHaveLength(160);
    for (const point of points) expect(Math.hypot(point.x, point.y)).toBeLessThanOrEqual(MAX_ICON_OFFSET);
    expect(layout.arrange(input)).toEqual(result);
    const moved = layout.arrange(input.map(p => ({ ...p, x: 0.001, y: -0.002 })));
    for (const [id, point] of result) { expect(moved.get(id)!.x).toBeCloseTo(point.x + 0.001); expect(moved.get(id)!.y).toBeCloseTo(point.y - 0.002); }
    expect(layout.arrange([]).size).toBe(0);
    expect(layout.arrange([{ id: 159, x: 0, y: 0 }]).get(159)).toEqual({ x: 0, y: 0 });
  });
  it("builds bounded friendly and hostile frames for every class", () => {
    for (const type of [...TRAINABLE, "structure"] as const) for (const side of [0, 1]) {
      const { ink, fill } = createQuestNatoIcon(type, side);
      for (const geometry of [ink, fill]) {
        geometry.computeBoundingBox();
        expect(geometry.boundingBox!.min.x).toBeGreaterThan(-1);
        expect(geometry.boundingBox!.max.x).toBeLessThan(1);
        expect(geometry.getAttribute("position").count).toBeGreaterThan(0);
        geometry.dispose();
      }
    }
  });
  it("moves picking with visible icons without moving ships and keeps models until the later threshold", () => {
    const battle = new QuestBattle(), world = new Group(), view = new QuestBattleView(world), camera = new PerspectiveCamera();
    const ships = battle.fleet(0).slice(0, 3); battle.entities = ships;
    for (const ship of ships) ship.position = ship.previousPosition = { x: 0, y: 0, z: 0 };
    view.reset(battle); camera.position.set(0, 0, 5); camera.lookAt(0, 0, 0);
    view.update(battle, new Set(), camera, 0); expect(view.iconRadii.size).toBe(0);
    camera.position.z = 40; view.update(battle, new Set(), camera, 0);
    expect(view.iconPositions.size).toBe(1);
    expect(view.expandGroup(ships[0]!.id)).toEqual(ships.map(s => s.id));
    view.update(battle, new Set(), camera, 0);
    expect(view.iconPositions.size).toBe(3);
    for (const ship of ships) {
      const shown = view.iconPositions.get(ship.id)!;
      expect(ship.position).toEqual({ x: 0, y: 0, z: 0 });
      expect(directContact(ships, shown, 1, 0, view.iconRadii, view.iconPositions)?.id).toBe(ship.id);
      expect(view.pickables.find(p => p.userData.entityId === ship.id)!.position.equals(shown)).toBe(true);
    }
    expect([...view.iconPositions.values()].some(p => p.distanceTo(new Vector3()) > 0.1)).toBe(true);
    const shown = [...view.iconPositions.values()];
    for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++)
      expect(shown[i]!.distanceTo(shown[j]!)).toBeGreaterThan(40 * ICON_HALF_ANGLE * 0.62 * 2);
    view.collapseGroups(); view.update(battle, new Set(), camera, 0);
    expect(view.iconGroups.size).toBe(1);
    camera.position.z = 5; view.update(battle, new Set(), camera, 0);
    expect(view.iconPositions.size).toBe(0);
  });
});
