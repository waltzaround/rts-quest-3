import { describe, expect, it } from "vitest";
import { createCombatScenario, restoreSimulation } from "@space-rts/game-core";
import { getMatchResult, type MatchResultContext } from "../src/match-result";

const context: MatchResultContext = {
  mode: "player", localPlayerId: "blue", spectatorTeamId: null,
  showingMenu: false, showingDemo: false, waitingForMatch: false,
};
const players = [
  { id: "blue", name: "Blue", teamId: 1 },
  { id: "red", name: "Red", teamId: 2 },
];
const finished = { status: "finished" as const, winnerTeamId: 1, players };

describe("end-of-match results", () => {
  it("shows results from a restored finished match with no victory event", () => {
    const game = createCombatScenario({ seed: 42, players, startingFleet: false });
    game.state.structures = game.state.structures.filter((structure) => structure.ownerPlayerId !== "red");
    game.step();
    expect(game.step().events.some((event) => event.type === "victory")).toBe(true);
    game.step(); // The one-time victory event has already been consumed.
    const restored = restoreSimulation(game.snapshot());
    expect(restored.debugSnapshot().events).toEqual([]);
    expect(getMatchResult(restored.state, context)?.title).toBe("VICTORY");
    expect(getMatchResult(restored.state, { ...context, localPlayerId: "red" })?.title).toBe("DEFEAT");
  });

  it("keeps the result available on subsequent frames and terminal snapshots", () => {
    expect(getMatchResult(finished, context)).toEqual(getMatchResult(structuredClone(finished), context));
    expect(getMatchResult(finished, context)).toMatchObject({ title: "VICTORY", defeated: false });
  });

  it("does not show a previous result in a new lobby or while waiting for its match state", () => {
    expect(getMatchResult(finished, { ...context, waitingForMatch: true })).toBeNull();
    expect(getMatchResult({ ...finished, status: "playing", winnerTeamId: null }, context)).toBeNull();
  });

  it("keeps menu battles, benchmarks, and replay playback free of result overlays", () => {
    expect(getMatchResult(finished, { ...context, showingMenu: true })).toBeNull();
    expect(getMatchResult(finished, { ...context, showingDemo: true })).toBeNull();
    expect(getMatchResult(finished, { ...context, mode: "post-match-omniscient" })).toBeNull();
  });

  it("shows completion for a team spectator without declaring them defeated", () => {
    expect(getMatchResult(finished, { ...context, mode: "team-spectator", spectatorTeamId: 2 }))
      .toEqual({ title: "MATCH COMPLETE", copy: "Team 1 controls the battlespace.", defeated: false });
  });

  it("handles a finished match without a winner", () => {
    expect(getMatchResult({ ...finished, winnerTeamId: null }, context)?.title).toBe("DRAW");
  });
});
