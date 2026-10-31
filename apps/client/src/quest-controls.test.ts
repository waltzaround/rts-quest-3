import { describe, expect, it } from "vitest";
import { QuestBattle } from "./quest-combat";
import { selectShips } from "./quest-controls";

describe("experimental fleet selection", () => {
  it("replaces single selections and toggles with Shift or toggle mode", () => {
    const battle = new QuestBattle(), [first, second] = battle.fleet(0);
    const selected = new Set([first!.id, second!.id]);
    expect([...selectShips(battle.entities, selected, first!, "single")]).toEqual([first!.id]);
    expect([...selectShips(battle.entities, selected, first!, "single", true)]).toEqual([second!.id]);
    expect([...selectShips(battle.entities, selected, first!, "toggle")]).toEqual([second!.id]);
    expect(selected.size).toBe(2);
  });

  it("selects a class across the fleet, excluding enemy and dead ships", () => {
    const battle = new QuestBattle(), anchor = battle.fleet(0)[0]!;
    const dead = battle.spawnShip(0, "frigate", { x: 0, y: 1, z: 0 }); dead.health = 0;
    const expected = battle.fleet(0).filter(e => e.shipClass === anchor.shipClass).map(e => e.id);
    const selected = selectShips(battle.entities, new Set([dead.id]), anchor, "class");
    expect([...selected]).toEqual(expected);
    expect(selected.size).toBe(4);
  });

  it("measures nearby groups in XYZ, includes the radius boundary and adds groups with Shift", () => {
    const battle = new QuestBattle(); battle.entities = [];
    const anchor = battle.spawnShip(0, "frigate", { x: 0, y: 0.5, z: 0 });
    const near = battle.spawnShip(0, "destroyer", { x: 0.35, y: 0.5, z: 0 });
    const above = battle.spawnShip(0, "frigate", { x: 0, y: 1, z: 0 });
    battle.spawnShip(1, "frigate", anchor.position);
    battle.spawnStructure(0, "shipyard", anchor.position);
    const current = new Set([above.id]);
    expect([...selectShips(battle.entities, current, anchor, "nearby")]).toEqual([anchor.id, near.id]);
    expect([...selectShips(battle.entities, current, anchor, "nearby", true)]).toEqual([above.id, anchor.id, near.id]);
  });

  it("rejects enemy anchors and prunes stale selections", () => {
    const battle = new QuestBattle(), friendly = battle.fleet(0)[0]!, enemy = battle.fleet(1)[0]!;
    expect([...selectShips(battle.entities, new Set([friendly.id, enemy.id, -1]), enemy, "class")]).toEqual([friendly.id]);
  });
});
