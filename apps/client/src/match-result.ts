import type { SimulationState } from "@space-rts/game-core";

type ResultState = Pick<SimulationState, "status" | "winnerTeamId"> & {
  players: readonly { id: string; teamId: number }[];
};

export interface MatchResultContext {
  mode: "player" | "team-spectator" | "post-match-omniscient";
  localPlayerId: string;
  spectatorTeamId: number | null;
  showingMenu: boolean;
  showingDemo: boolean;
  waitingForMatch: boolean;
}

export interface MatchResultPresentation {
  title: "VICTORY" | "DEFEAT" | "MATCH COMPLETE" | "DRAW";
  copy: string;
  defeated: boolean;
}

/** Results are durable state, not a combat effect that depends on a single tick's events. */
export function getMatchResult(state: ResultState, context: MatchResultContext): MatchResultPresentation | null {
  if (state.status !== "finished" || context.showingMenu || context.showingDemo
    || context.waitingForMatch || context.mode === "post-match-omniscient") return null;
  if (state.winnerTeamId === null) return { title: "DRAW", copy: "The engagement ended without a winning team.", defeated: false };
  const viewingTeamId = context.mode === "team-spectator" ? context.spectatorTeamId
    : state.players.find((player) => player.id === context.localPlayerId)?.teamId;
  if (context.mode === "team-spectator" || viewingTeamId == null) {
    return { title: "MATCH COMPLETE", copy: `Team ${state.winnerTeamId} controls the battlespace.`, defeated: false };
  }
  const won = viewingTeamId === state.winnerTeamId;
  return {
    title: won ? "VICTORY" : "DEFEAT",
    copy: won ? "All hostile command cores neutralized." : "Your team was eliminated.",
    defeated: !won,
  };
}
