import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { QuestBattle, WORLD_SCALE } from "./quest-combat";
import { directContact, inBattleVolume } from "./quest-direct-input";
import { fighterMemberMatrix } from "./fighter-visuals";

describe("direct controller XYZ input", () => {
  it("selects by proximity regardless of aim direction and rejects distant targets", () => {
    const battle = new QuestBattle(), ship = battle.fleet(0)[0]!;
    expect(directContact(battle.entities, ship.position, 1)).toBe(ship);
    expect(directContact([ship], { ...ship.position, y: ship.position.y + 0.5 }, 1)).toBeUndefined();
    ship.health = 0; expect(directContact([ship], ship.position, 1)).toBeUndefined();
  });
  it("keeps a three-centimetre contact allowance at every zoom scale", () => {
    const battle = new QuestBattle(), ship = battle.fleet(1)[0]!;
    for (const scale of [0.35, 1, 5, 12]) {
      expect(directContact([ship], { ...ship.position, x: ship.position.x + ship.radius + 0.02 / scale }, scale)).toBe(ship);
      expect(directContact([ship], { ...ship.position, x: ship.position.x + ship.radius + 0.04 / scale }, scale)).toBeUndefined();
    }
  });
  it("allows touching individual rendered squad members", () => {
    const battle = new QuestBattle(), ship = battle.spawnShip(0, "fighter", { x: 0, y: 0.7, z: 0 });
    ship.velocity = { x: 0.1, y: 0, z: 0 }; ship.combatTargetId = battle.core(1)!.id;
    const matrix = fighterMemberMatrix(new THREE.Matrix4(), ship.id, 3, 90, 0, 0.7 / WORLD_SCALE, 0, Math.PI / 2, 0, 50, 1, 0);
    const point = new THREE.Vector3().setFromMatrixPosition(matrix).multiplyScalar(WORLD_SCALE);
    expect(directContact([ship], point, 12, 90)).toBe(ship);
  });
  it("accepts different XYZ destinations and rejects positions outside the volume", () => {
    expect(inBattleVolume({ x: 0, y: 0.2, z: 0.5 })).toBe(true);
    expect(inBattleVolume({ x: 0, y: 1.4, z: -0.5 })).toBe(true);
    expect(inBattleVolume({ x: 2, y: 0.5, z: 0 })).toBe(false);
    expect(inBattleVolume({ x: 0, y: -0.1, z: 0 })).toBe(false);
  });
});
