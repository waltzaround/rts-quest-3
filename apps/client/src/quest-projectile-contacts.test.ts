import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import { SHIP_TURRET_SCALES } from "@space-rts/game-core";
import { QuestBattle, questShipScale } from "./quest-combat";
import { turretBarrelTip } from "./ship-layout";

function battleWithTarget() {
  const battle = new QuestBattle(); battle.aiEnabled = false;
  battle.entities = battle.entities.filter(e => e.structureType === "commandCore");
  battle.entities.forEach(e => { e.mounts = []; });
  const target = battle.spawnShip(1, "battleship", { x: 0, y: 0.7, z: 0 }); target.mounts = [];
  battle.togglePause(); return { battle, target };
}
describe("turret muzzles and surface impacts", () => {
  it("transforms alternating barrel mouths with exactly the rendered turret pose and scale", () => {
    const battle = new QuestBattle();
    const ship = battle.spawnShip(0, "battleship", { x: 0, y: 0.6, z: 0 });
    ship.forward = new Vector3(1, 0.4, -0.2).normalize();
    const mount = ship.mounts[0]!; mount.aim = new Vector3(-0.3, 0.6, 1).normalize();
    const rotation = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), new Vector3().copy(mount.aim));
    for (let sequence = 0; sequence < 2; sequence++) {
      mount.sequence = sequence;
      const local = new Vector3().copy(battle.muzzleOrigin(ship, mount)).sub(battle.mountOrigin(ship, mount))
        .applyQuaternion(rotation.clone().invert()).divideScalar(questShipScale("battleship") * SHIP_TURRET_SCALES.battleship);
      expect(local.distanceTo(new Vector3().copy(turretBarrelTip("heavyRail", sequence)))).toBeLessThan(1e-10);
      expect(local.z).toBeCloseTo(8.7);
    }
  });
  it("actually launches projectiles at the barrel and ends beams at the near contact surface", () => {
    for (const weapon of ["heavyRail", "beam"] as const) {
      const { battle, target } = battleWithTarget();
      target.position.x = 0.35; target.target = { ...target.position };
      const ship = battle.spawnShip(0, "battleship", { x: -0.35, y: 0.7, z: 0 });
      ship.mounts = ship.mounts.filter(m => m.definition.weaponTypeId === weapon).slice(0, 1);
      const mount = ship.mounts[0]!;
      // Face the selected hardpoint's allowed arc toward the target.
      mount.definition = { ...mount.definition, yawCenter: 0, yawHalfArc: Math.PI };
      mount.cooldown = 0;
      for (let i = 0; i < 200 && !mount.sequence; i++) battle.step();
      expect(mount.sequence).toBe(1);
      mount.sequence = 0;
      const muzzle = battle.muzzleOrigin(ship, mount);
      if (weapon === "heavyRail") expect(battle.projectiles.find(p => p.weapon === weapon)!.previous).toEqual(muzzle);
      else {
        const beam = battle.events.find(e => e.kind === "beam")!;
        expect(beam.from).toEqual(muzzle);
        expect(new Vector3().copy(beam.to).distanceTo(target.position)).toBeCloseTo(target.radius);
        expect(beam.to.x).toBeLessThan(target.position.x);
      }
    }
  });
  it("places fast off-center hits at the swept contact surface, not the center", () => {
    const { battle, target } = battleWithTarget();
    battle.projectiles.push({ id: 90000, side: 0, weapon: "heavyRail", position: { x: -0.5, y: 0.8, z: 0.03 }, previous: { x: -0.5, y: 0.8, z: 0.03 }, velocity: { x: 20, y: 0, z: 0 }, radius: 0.005, life: 10, damage: 48 });
    battle.step();
    const hit = battle.events.find(e => e.kind === "hit")!;
    expect(hit).toBeDefined(); expect(hit.to.x).toBeLessThan(-0.2); expect(hit.to.y).toBeGreaterThan(0.79);
    expect(new Vector3().copy(hit.to).distanceTo(target.position)).toBeCloseTo(target.radius);
    expect(hit.normal!.x).toBeLessThan(0);
    expect(battle.events.some(e => e.kind === "destroy")).toBe(false);
    expect(battle.projectiles).toHaveLength(0);
  });
  it("keeps a surface hit plus a separate central blast only for a killing shot", () => {
    const { battle, target } = battleWithTarget(); target.shields = 0; target.health = 1;
    battle.projectiles.push({ id: 90001, side: 0, weapon: "heavyRail", position: { x: -0.5, y: 0.7, z: 0 }, previous: { x: -0.5, y: 0.7, z: 0 }, velocity: { x: 20, y: 0, z: 0 }, radius: 0.005, life: 10, damage: 48 });
    battle.step();
    expect(battle.events.find(e => e.kind === "hit")!.to.x).toBeCloseTo(-target.radius);
    expect(battle.events.find(e => e.kind === "destroy")!.to).toEqual(target.position);
  });
});
