import { describe, expect, it } from "vitest";
import { forceSummary } from "./quest-force-summary";
import { DEMO_ENCOUNTERS, DEMO_TEAM_CAP, QuestDemo } from "./quest-demo";

describe("strategic force cards", () => {
  it("counts each side and encounter independently, including fighter squads as single units", () => {
    const battle = new QuestDemo().create();
    expect(battle.fleet(0)).toHaveLength(DEMO_TEAM_CAP);
    for (const site of DEMO_ENCOUNTERS) for (const side of [0, 1] as const) {
      const summary = forceSummary(battle.entities, site.id, side, site.roster);
      expect(summary.units).toBe(site.roster.length);
      expect(summary.strength).toBe(100);
      expect(summary.squadrons).toBe(site.roster.filter(type => type === "fighter").length);
      expect(summary.bombers).toBe(site.roster.filter(type => type === "bomber").length);
      expect(summary.warships + summary.squadrons + summary.bombers).toBe(summary.units);
    }
  });
  it("shows damage and losses against full force strength, and recovers after reinforcement", () => {
    const demo = new QuestDemo(), battle = demo.create(), site = DEMO_ENCOUNTERS[1]!;
    const summary = () => forceSummary(battle.entities, site.id, 0, site.roster);
    battle.fleet(0).filter(ship => ship.encounterId === site.id).forEach(ship => {
      ship.health *= 0.5; ship.shields *= 0.5;
    });
    expect(summary().strength).toBe(50);
    expect(summary().units).toBe(15);
    battle.fleet(0).filter(ship => ship.encounterId === site.id).forEach(ship => { ship.health = 0; });
    expect(summary()).toMatchObject({ units: 0, strength: 0, capacity: 15 });
    expect(forceSummary(battle.entities, site.id, 1, site.roster).strength).toBe(100);
    battle.tick += 60; demo.update(battle);
    expect(summary()).toMatchObject({ units: 15, strength: 100 });
  });
});
