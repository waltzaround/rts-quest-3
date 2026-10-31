import { afterEach, expect, it, vi } from "vitest";
import { Box3Helper, Group, Mesh, PerspectiveCamera, Vector3 } from "three";
import { QuestEncountersView } from "./quest-encounters-view";
import { QuestDemo } from "./quest-demo";

function stubCanvas(): void {
  const context = new Proxy({}, { get: () => () => {} });
  vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => context }) });
}
afterEach(() => vi.unstubAllGlobals());

it("keeps composition panels fixed in battle space when the camera moves or turns", () => {
  stubCanvas();
  const world = new Group(), view = new QuestEncountersView(world), camera = new PerspectiveCamera(), battle = new QuestDemo().create();
  camera.position.set(0, 5, 60); view.update(battle, camera);
  const panels = world.children.filter(child => child instanceof Mesh);
  const positions = panels.map(panel => panel.position.clone());
  const rotations = panels.map(panel => panel.quaternion.clone());
  camera.position.set(40, 12, -40); camera.lookAt(new Vector3());
  view.update(battle, camera);
  panels.forEach((panel, i) => {
    expect(panel.position).toEqual(positions[i]); expect(panel.quaternion.toArray()).toEqual(rotations[i]!.toArray());
  });
  expect(view.contact(panels[0]!.position, 1)).toBe(0);
  expect(view.contactForce(panels[0]!.position, 1)).toEqual({ encounterId: 0, side: 0 });
  expect(view.contactForce(panels[1]!.position, 1)).toEqual({ encounterId: 0, side: 1 });
  expect(view.contactForce(panels[1]!.position, 0.025)).toEqual({ encounterId: 0, side: 1 });
});

it("highlights the chosen force immediately, switches sides, and clears when leaving overview", () => {
  stubCanvas();
  const world = new Group(), view = new QuestEncountersView(world), camera = new PerspectiveCamera();
  const battle = new QuestDemo().create(); camera.position.set(0, 5, 60);
  view.update(battle, camera);
  expect(view.activate({ encounterId: 0, side: 0 })).toBe("highlight");
  view.update(battle, camera);
  expect(view.pickables[0]!.userData.selected).toBe(true);
  const outline = world.getObjectByName("selected-force-outline") as Box3Helper;
  expect(outline.visible).toBe(true);
  const deployed = battle.fleet(0).filter(ship => ship.encounterId === 0 && !ship.supplyTransit);
  expect(deployed.every(ship => outline.box.containsPoint(new Vector3().copy(ship.position)))).toBe(true);
  expect(view.activate({ encounterId: 0, side: 1 })).toBe("highlight");
  view.update(battle, camera);
  expect(view.pickables[0]!.userData.selected).toBe(false);
  expect(view.pickables[1]!.userData.selected).toBe(true);
  expect(view.activate({ encounterId: 0, side: 1 })).toBe("enter");
  camera.position.set(0, 5, 0); view.update(battle, camera);
  expect(view.selectedForce).toBeNull(); expect(outline.visible).toBe(false);
  expect(view.contactForce(new Vector3().copy(deployed[0]!.position), 1)).toBeNull();
});

it("keeps cards and their hit targets out of the wide flag layer and shows them only at top zoom", () => {
  stubCanvas();
  const world = new Group(), view = new QuestEncountersView(world), camera = new PerspectiveCamera(), battle = new QuestDemo().create();
  camera.position.set(0, 4, 18); view.update(battle, camera);
  expect(view.visible).toBe(false); expect(view.pickables).toHaveLength(0); expect(view.opacity).toBe(0);
  camera.position.z = 45; view.update(battle, camera);
  expect(view.visible).toBe(true); expect(view.pickables).toHaveLength(6);
  camera.position.z = 18; view.update(battle, camera);
  expect(view.visible).toBe(false); expect(view.pickables).toHaveLength(0);
  expect(view.contact(world.children[0]!.position, 1)).toBeNull();
});
