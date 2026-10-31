import { describe, expect, it } from "vitest";
import { QuestBattle } from "./quest-combat";
import { BattlePressureTracker, ForceBannerSelection, PRESSURE_WINDOW_TICKS } from "./quest-force-status";

describe("force banner activation", () => {
  it("highlights first, enters only on the same force, and can be cleared", () => {
    const selection = new ForceBannerSelection();
    expect(selection.activate({ encounterId: 0, side: 0 })).toBe("highlight");
    expect(selection.activate({ encounterId: 0, side: 1 })).toBe("highlight");
    expect(selection.activate({ encounterId: 1, side: 1 })).toBe("highlight");
    expect(selection.activate({ encounterId: 1, side: 1 })).toBe("enter");
    selection.clear();
    expect(selection.target).toBeNull();
    expect(selection.activate({ encounterId: 1, side: 1 })).toBe("highlight");
  });
});

describe("recent battle pressure", () => {
  it("counts losses once and waits for reinforcements to arrive, independently per battle", () => {
    const battle = new QuestBattle(), tracker = new BattlePressureTracker();
    battle.entities = [];
    const friendly = battle.spawnShip(0, "frigate", { x: 0, y: 1, z: 0 }); friendly.encounterId = 0;
    const enemy = battle.spawnShip(1, "frigate", { x: 0, y: 1, z: 0 }); enemy.encounterId = 0;
    tracker.update(battle); expect(tracker.summary(0).leader).toBeNull();
    enemy.health = 0; battle.tick++;
    tracker.update(battle);
    expect(tracker.summary(0)).toMatchObject({ leader: 0, losses: [0, 1], balance: 1 });
    battle.tick++; tracker.update(battle);
    expect(tracker.summary(0).losses).toEqual([0, 1]);
    const replacement = battle.spawnShip(1, "frigate", { x: 0, y: 1, z: 0 }); replacement.encounterId = 0;
    replacement.supplyTransit = { route: [], waypoint: 0, combatSpeed: replacement.speed };
    battle.tick++; tracker.update(battle);
    expect(tracker.summary(0).arrivals).toEqual([0, 0]);
    delete replacement.supplyTransit; battle.tick++; tracker.update(battle);
    expect(tracker.summary(0)).toMatchObject({ leader: null, balance: 0, arrivals: [0, 1] });
    friendly.health = 0; battle.tick++; tracker.update(battle);
    expect(tracker.summary(0).leader).toBe(1);
    expect(tracker.summary(1)).toMatchObject({ balance: 0, arrivals: [0, 0], losses: [0, 0] });
  });
  it("expires in simulation time and clears history when the demo restarts", () => {
    const battle = new QuestBattle(), tracker = new BattlePressureTracker();
    const ship = battle.fleet(0)[0]!; ship.encounterId = 0;
    tracker.update(battle); ship.health = 0; battle.tick = 1; tracker.update(battle);
    expect(tracker.summary(0).balance).toBe(-1);
    tracker.update(battle); expect(tracker.summary(0).balance).toBe(-1);
    battle.tick += PRESSURE_WINDOW_TICKS; tracker.update(battle);
    expect(tracker.summary(0).balance).toBe(0);
    tracker.update(new QuestBattle());
    expect(tracker.summary(0).losses).toEqual([0, 0]);
  });
});
