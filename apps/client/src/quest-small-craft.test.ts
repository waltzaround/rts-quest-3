import { describe, expect, it } from "vitest";
import { SHIP_ECONOMY } from "@space-rts/game-core";
import { QuestBattle } from "./quest-combat";
import { DEMO_COMBAT_SITES, QuestDemo } from "./quest-demo";

describe("Quest small craft", () => {
  it.each(["fighter", "bomber"] as const)("produces the original five-unit %s batch with one resource charge", type => {
    const battle = new QuestBattle(); battle.aiEnabled = false;
    battle.entities.forEach(e => { e.mounts = []; });
    battle.economy[0].alloy = 1750; battle.economy[0].energy = 1750;
    const cost = SHIP_ECONOMY[type];
    expect(battle.queueShip(0, type)).toContain("queued");
    expect(battle.economy[0].alloy).toBe(1750 - cost.alloyCost);
    battle.togglePause();
    for (let i = 0; i < cost.buildTicks + 100; i++) battle.advance(0.05);
    expect(battle.fleet(0).filter(e => e.shipClass === type)).toHaveLength(5);
  });
  it("reserves fleet capacity for every queued squad, not just one per order", () => {
    const battle = new QuestBattle(); battle.economy[0].alloy = battle.economy[0].energy = 10000;
    for (let i = 0; i < 3; i++) expect(battle.queueShip(0, "fighter")).toContain("queued");
    expect(battle.queueShip(0, "fighter")).toContain("Fleet cap");
  });
  it("demo includes fighters and bombers on both sides and emits both weapons", () => {
    const demo = new QuestDemo(); let battle = demo.create();
    for (const side of [0, 1] as const) {
      expect(battle.fleet(side).filter(e => e.shipClass === "fighter")).toHaveLength(DEMO_COMBAT_SITES.reduce((n, site) => n + site.roster.filter(type => type === "fighter").length, 0));
      expect(battle.fleet(side).filter(e => e.shipClass === "bomber")).toHaveLength(DEMO_COMBAT_SITES.reduce((n, site) => n + site.roster.filter(type => type === "bomber").length, 0));
    }
    const weapons = new Set<string>();
    for (let i = 0; i < 800; i++) { battle.advance(0.05); battle = demo.update(battle); battle.projectiles.forEach(p => weapons.add(p.weapon)); }
    expect(weapons.has("autocannon")).toBe(true); expect(weapons.has("torpedo")).toBe(true);
  }, 15000); // Forty simulated seconds, including the fortified supply network.
});
