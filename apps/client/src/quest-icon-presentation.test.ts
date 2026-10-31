import { describe, expect, it } from "vitest";
import { Group, PerspectiveCamera, InstancedMesh, MeshBasicMaterial, GreaterDepth, Matrix4, Vector3 } from "three";
import { groupStrategicIcons, iconHalfAngle, iconEmphasis, showHealthBar, type IconCandidate } from "./quest-icon-presentation";
import { QuestBattle } from "./quest-combat";
import { QuestBattleView } from "./quest-battle-view";
import { directContact } from "./quest-direct-input";
import { createQuestCountDigit, createQuestOccludedFrame } from "./quest-nato-icons";

const candidate = (id: number, changes: Partial<IconCandidate> = {}): IconCandidate => ({ id, side: 0, type: "frigate", depth: 40, x: id * 0.002, y: 0, position: { x: id * 0.04, y: 0, z: 0 }, ...changes });

describe("depth-aware strategic symbols", () => {
  it("preserves perspective and contrast cues within readable bounds", () => {
    expect(iconHalfAngle(9)).toBeGreaterThan(iconHalfAngle(20));
    expect(iconHalfAngle(20)).toBeGreaterThan(iconHalfAngle(100));
    expect(iconHalfAngle(1000)).toBeGreaterThan(0.005);
    expect(iconEmphasis(30, false)).toBeLessThan(iconEmphasis(10, false));
    expect(iconEmphasis(1000, true)).toBe(1);
    expect(iconEmphasis(1000, false)).toBeGreaterThanOrEqual(0.4);
  });
  it("groups nearby same-class allies, keeps depth/side/site/class distinct, and expands on demand", () => {
    const fleet = [candidate(1), candidate(2), candidate(3)];
    expect(groupStrategicIcons(fleet, new Set())[0]!.members).toEqual([1, 2, 3]);
    expect(groupStrategicIcons(fleet, new Set([1, 2, 3]))).toHaveLength(3);
    for (const changes of [{ side: 1 }, { type: "bomber" }, { encounter: 1 }, { depth: 44 }, { position: { x: 4, y: 0, z: 0 } }, { x: 0.2 }])
      expect(groupStrategicIcons([fleet[0]!, fleet[1]!, candidate(3, changes)], new Set())).toHaveLength(3);
    expect(groupStrategicIcons(fleet.map(p => ({ ...p, depth: 10 })), new Set())).toHaveLength(3);
    expect(groupStrategicIcons(fleet.map(p => ({ ...p, type: "structure" })), new Set())).toHaveLength(3);
    expect(groupStrategicIcons(fleet.map(p => ({ ...p, depth: 30 })), new Set(), new Set([1, 2, 3]))).toHaveLength(1);
  });
  it("shows health only for selection, hover, construction or recent damage", () => {
    expect(showHealthBar(false, false, 100, -1000)).toBe(false);
    expect(showHealthBar(false, false, 100, 39)).toBe(false);
    expect(showHealthBar(false, false, 100, 40)).toBe(true);
    expect(showHealthBar(true, false, 100, -1000)).toBe(true);
    expect(showHealthBar(false, true, 100, -1000)).toBe(true);
    expect(showHealthBar(false, false, 100, -1000, true)).toBe(true);
  });
  it("keeps grouped contact at the displayed centroid, restores members and clears state on reset", () => {
    const battle = new QuestBattle(), world = new Group(), view = new QuestBattleView(world), camera = new PerspectiveCamera();
    battle.entities = battle.fleet(0).slice(0, 3);
    battle.entities.forEach((ship, i) => { ship.position = ship.previousPosition = { x: i * 0.04, y: 0, z: 0 }; });
    camera.position.set(0, 0, 40); camera.lookAt(0, 0, 0); view.reset(battle);
    view.update(battle, new Set(), camera, 0);
    const id = battle.entities[0]!.id;
    expect(view.iconGroups.get(id)).toHaveLength(3);
    expect(view.pickables).toHaveLength(1);
    expect(directContact(battle.entities, view.iconPositions.get(id)!, 1, 0, view.iconRadii, view.iconPositions)?.id).toBe(id);
    expect(view.iconPositions.has(battle.entities[1]!.id)).toBe(false);
    view.expandGroup(id); view.update(battle, new Set([id]), camera, 0);
    expect(view.pickables).toHaveLength(3);
    expect(view.iconGroups.size).toBe(0);
    const ink = world.children.find(c => c instanceof InstancedMesh && c.renderOrder === 10 && c.count === 3) as InstancedMesh;
    const material = ink.material as MeshBasicMaterial;
    expect(material.depthTest).toBe(true); expect(material.depthWrite).toBe(false);
    const backing = world.children.find(c => c instanceof InstancedMesh && c.renderOrder === 9 && c.count === 3) as InstancedMesh;
    expect((backing.material as MeshBasicMaterial).depthWrite).toBe(true);
    expect((backing.material as MeshBasicMaterial).polygonOffset).toBe(true);
    const ghost = world.children.find(c => c instanceof InstancedMesh && c.renderOrder === 11 && c.count === 1) as InstancedMesh;
    expect((ghost.material as MeshBasicMaterial).depthFunc).toBe(GreaterDepth);
    view.reset(battle);
    expect(view.iconGroups.size).toBe(0); expect(view.iconPositions.size).toBe(0); expect(ghost.count).toBe(0);
    view.update(battle, new Set(), camera, 0); expect(view.iconGroups.size).toBe(1);
  });
  it("keeps anchors at true positions while badge offsets and picking move together", () => {
    const battle = new QuestBattle(), world = new Group(), view = new QuestBattleView(world), camera = new PerspectiveCamera();
    battle.entities = battle.fleet(0).slice(0, 2);
    battle.entities.forEach(ship => { ship.position = ship.previousPosition = { x: 0, y: 0, z: 0 }; });
    view.reset(battle); camera.position.set(0, 0, 18); camera.lookAt(0, 0, 0);
    view.update(battle, new Set(), camera, 0);
    const dots = world.children.find(c => c instanceof InstancedMesh && c.renderOrder === 8) as InstancedMesh;
    expect(dots.count).toBe(1);
    const matrix = new Matrix4(); dots.getMatrixAt(0, matrix);
    expect(new Vector3().setFromMatrixPosition(matrix).length()).toBeCloseTo(0);
    for (const p of view.pickables) expect(p.position.equals(view.iconPositions.get(p.userData.entityId)!)).toBe(true);
  });
  it("builds reusable vector counts and dashed frames without DOM textures", () => {
    for (const geometry of [...Array.from({ length: 10 }, (_, i) => createQuestCountDigit(i)), createQuestOccludedFrame(0), createQuestOccludedFrame(1)]) {
      expect(geometry.getAttribute("position").count).toBeGreaterThan(0); geometry.dispose();
    }
  });
});

it("retains every individual flag throughout the middle layer and prevents far fights aggregating while close up", () => {
  const fleet = [candidate(1), candidate(2), candidate(3)];
  for (const depth of [9, 16, 24, 26]) expect(groupStrategicIcons(fleet.map(p => ({ ...p, depth })), new Set())).toHaveLength(3);
  expect(groupStrategicIcons(fleet, new Set(), new Set(), false)).toHaveLength(3);
  const battle = new QuestBattle(), world = new Group(), view = new QuestBattleView(world), camera = new PerspectiveCamera();
  battle.entities = battle.fleet(0).slice(0, 3);
  battle.entities.forEach(ship => { ship.position = ship.previousPosition = { x: 0, y: 0, z: 0 }; });
  view.reset(battle); camera.position.set(0, 0, 20); camera.lookAt(0, 0, 0);
  view.update(battle, new Set(), camera, 0);
  expect(view.countsVisible).toBe(false); expect(view.iconPositions.size).toBe(3);
  camera.position.z = 40; view.update(battle, new Set(), camera, 0);
  expect(view.countsVisible).toBe(true); expect(view.iconPositions.size).toBe(1);
  camera.position.z = 24; view.update(battle, new Set(), camera, 0);
  expect(view.countsVisible).toBe(false); expect(view.iconPositions.size).toBe(3);
});

it("replaces only the three main fights with force cards at top zoom, retaining depth skirmish symbols", async () => {
  const { QuestDemo, DEMO_ENCOUNTERS, DEMO_SKIRMISHES } = await import("./quest-demo");
  const battle = new QuestDemo().create(), world = new Group(), view = new QuestBattleView(world), camera = new PerspectiveCamera();
  view.reset(battle); camera.position.set(0, 4, 60); camera.lookAt(0, 4, 0);
  view.update(battle, new Set(), camera, 0, true);
  const displayed = new Set(view.pickables.map(p => p.userData.entityId));
  for (const site of DEMO_ENCOUNTERS) expect(battle.entities.filter(e => e.encounterId === site.id).some(e => displayed.has(e.id))).toBe(false);
  for (const site of DEMO_SKIRMISHES) expect(battle.entities.filter(e => e.encounterId === site.id).some(e => displayed.has(e.id))).toBe(true);
});
