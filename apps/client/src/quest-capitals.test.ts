import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import { SHIPS, SHIP_ECONOMY } from "@space-rts/game-core";
import { QuestBattle, questShipScale } from "./quest-combat";
import { turretDeckHeight } from "./ship-layout";
import { QuestDemo } from "./quest-demo";

describe("large capital ships", () => {
  it("makes battleships ten times a frigate's diameter with eighteen original hardpoints", () => {
    const battle = new QuestBattle();
    const frigate = battle.spawnShip(0, "frigate", { x: 0, y: 0.5, z: 0 });
    const capital = battle.spawnShip(0, "battleship", { x: 0, y: 1, z: 0 });
    expect(capital.radius / frigate.radius).toBeCloseTo(10);
    expect(capital.mounts).toHaveLength(18);
    expect(capital.mounts.filter(m => m.definition.weaponTypeId === "heavyRail")).toHaveLength(6);
    expect(capital.mounts.filter(m => m.definition.weaponTypeId === "pointDefense")).toHaveLength(8);
    expect(capital.maxHealth).toBe(SHIPS.battleship.maxHealth);
  });
  it("keeps all mounts attached to the enlarged hull when pitched and turned", () => {
    const battle = new QuestBattle();
    const capital = battle.spawnShip(0, "battleship", { x: 0.2, y: 0.8, z: -0.1 });
    capital.forward = new Vector3(1, 2, -3).normalize();
    const inverse = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), new Vector3().copy(capital.forward)).invert();
    const origins = capital.mounts.map(mount => {
      const origin = new Vector3().copy(battle.mountOrigin(capital, mount));
      const local = origin.clone().sub(capital.position).applyQuaternion(inverse).divideScalar(questShipScale("battleship"));
      expect(local.x).toBeCloseTo(mount.definition.localX);
      expect(local.y).toBeCloseTo(turretDeckHeight("battleship", mount.definition.localX, mount.definition.localZ, mount.definition.weaponTypeId));
      expect(local.z).toBeCloseTo(mount.definition.localZ);
      return origin.toArray().join(",");
    });
    expect(new Set(origins).size).toBe(18);
  });
  it("requires a completed capital yard and charges original production costs", () => {
    const battle = new QuestBattle(); battle.aiEnabled = false;
    battle.economy[0].alloy = battle.economy[0].energy = 10000;
    expect(battle.queueShip(0, "battleship")).toContain("Capital yard");
    const yard = battle.spawnStructure(0, "capitalShipyard", { x: 0, y: 0.7, z: 0 });
    yard.construction = 1;
    expect(battle.queueShip(0, "battleship")).toContain("Capital yard");
    yard.construction = 0;
    expect(battle.queueShip(0, "battleship")).toContain("queued");
    expect(battle.economy[0].alloy).toBe(10000 - SHIP_ECONOMY.battleship.alloyCost);
    yard.queue[0]!.remaining = 1;
    battle.togglePause(); battle.advance(0.05);
    const ship = battle.fleet(0).find(e => e.shipClass === "battleship")!;
    expect(ship).toBeDefined();
    expect(new Vector3().copy(ship.position).distanceTo(yard.position)).toBeGreaterThan(ship.radius + yard.radius);
  });
  it("includes and replenishes capitals in both demo fleets", () => {
    const demo = new QuestDemo(), battle = demo.create();
    for (const side of [0, 1] as const) {
      expect(battle.fleet(side).some(e => e.shipClass === "cruiser")).toBe(true);
      battle.fleet(side).find(e => e.shipClass === "battleship")!.health = 0;
    }
    battle.tick = 60; demo.update(battle);
    for (const side of [0, 1] as const) expect(battle.fleet(side).filter(e => e.shipClass === "battleship")).toHaveLength(3);
  });
});
