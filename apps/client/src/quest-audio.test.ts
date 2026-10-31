import { describe, expect, it } from "vitest";
import { QuestBattle } from "./quest-combat";
import { questAudioCues } from "./quest-audio";

describe("battle audio cues", () => {
  it("plays new weapons once and leaves visual events intact", () => {
    const battle = new QuestBattle(); battle.togglePause();
    const point = { x: 0, y: 1, z: 0 };
    battle.projectiles.push({ id: 100, side: 0, weapon: "heavyRail", position: point, previous: point, velocity: point, life: 10, damage: 1, radius: 0.01 });
    battle.events.push({ kind: "beam", from: point, to: point, tick: 0, color: 0xffffff });
    expect(questAudioCues(battle, new Set()).map(c => c.kind)).toEqual(["beam", "heavyRail"]);
    expect(questAudioCues(battle, new Set([100])).map(c => c.kind)).toEqual(["beam"]);
    expect(battle.events).toHaveLength(1);
  });
  it("coalesces volleys, prioritizes explosions and stays silent while paused", () => {
    const battle = new QuestBattle(); battle.togglePause();
    const point = { x: 0, y: 1, z: 0 };
    for (let i = 0; i < 100; i++) battle.events.push({ kind: "hit", from: point, to: point, tick: 0, color: 0xffffff });
    battle.events.push({ kind: "destroy", from: point, to: point, tick: 0, color: 0xffffff });
    expect(questAudioCues(battle, new Set()).map(c => c.kind)).toEqual(["explosion", "impact"]);
    battle.togglePause(); expect(questAudioCues(battle, new Set())).toEqual([]);
  });
});
