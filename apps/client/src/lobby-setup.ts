import { createCombatScenario } from "@space-rts/game-core";
import { DEFAULT_LOBBY_SETTINGS, MAX_PLAYERS, type ClientMessage, type LobbyState, type MapSize } from "@space-rts/protocol";

export const MAP_PLAYER_CAPACITY: Readonly<Record<MapSize, number>> = {
  small: 4, medium: 6, large: 8, huge: 8, colossal: 8,
};
const PLAYER_COLORS = [0x59a7ff, 0xff5576, 0x62e6a7, 0xf3b65b, 0xb886ff, 0x55e1e8, 0xff8b55, 0xd8e65b];
export const LOCAL_PLAYER_ID = "pilot-blue";

export function createSingleplayerLobby(): LobbyState {
  return {
    matchId: "local", phase: "lobby", mode: "teams", maxPlayers: MAX_PLAYERS, createdAt: 0,
    settings: { ...DEFAULT_LOBBY_SETTINGS },
    slots: [
      { playerId: LOCAL_PLAYER_ID, name: "You", slotIndex: 0, teamId: 1, color: PLAYER_COLORS[0]!,
        ready: true, connected: true, isHost: true, isAi: false, faction: "industrial" },
      { playerId: "local-ai-1", name: "AI Commander 1", slotIndex: 1, teamId: 2, color: PLAYER_COLORS[1]!,
        ready: true, connected: true, isHost: false, isAi: true, faction: "brood",
        aiDifficulty: "normal", aiPersonality: "balanced" },
    ],
  };
}

/** Apply the same lobby controls locally without a socket or a readiness phase. */
export function updateSingleplayerLobby(lobby: LobbyState, message: ClientMessage): void {
  if (lobby.phase !== "lobby") return;
  switch (message.type) {
    case "set_settings": lobby.settings = { ...message.settings }; break;
    case "set_mode":
      lobby.mode = message.mode;
      // Match the network lobby's team assignment when switching modes.
      lobby.slots.forEach((slot, index) => { slot.teamId = message.mode === "ffa" ? slot.slotIndex + 1 : index % 2 + 1; });
      break;
    case "set_team": {
      const slot = lobby.slots.find((candidate) => candidate.playerId === (message.playerId ?? LOCAL_PLAYER_ID));
      if (slot && lobby.mode === "teams") slot.teamId = message.teamId;
      break;
    }
    case "set_faction": {
      const slot = lobby.slots.find((candidate) => candidate.playerId === (message.playerId ?? LOCAL_PLAYER_ID));
      if (slot) slot.faction = message.faction;
      break;
    }
    case "set_ai_settings": {
      const slot = lobby.slots.find((candidate) => candidate.playerId === message.playerId && candidate.isAi);
      if (slot) { slot.aiDifficulty = message.difficulty; slot.aiPersonality = message.personality; }
      break;
    }
    case "add_ai": {
      if (lobby.slots.length >= Math.min(lobby.maxPlayers, MAP_PLAYER_CAPACITY[lobby.settings.mapSize])) return;
      const slotIndex = PLAYER_COLORS.findIndex((_, index) => !lobby.slots.some((slot) => slot.slotIndex === index));
      lobby.slots.push({
        playerId: `local-ai-${slotIndex}`, name: `AI Commander ${slotIndex}`, slotIndex,
        teamId: lobby.mode === "ffa" ? slotIndex + 1 : message.teamId ?? 2, color: PLAYER_COLORS[slotIndex]!,
        ready: true, connected: true, isHost: false, isAi: true, faction: message.faction ?? "industrial",
        aiDifficulty: message.difficulty ?? "normal", aiPersonality: message.personality ?? "balanced",
      });
      lobby.slots.sort((left, right) => left.slotIndex - right.slotIndex);
      break;
    }
    case "remove_slot": lobby.slots = lobby.slots.filter((slot) => !slot.isAi || slot.playerId !== message.playerId); break;
  }
}

export function lobbyLaunchIssue(lobby: LobbyState, singleplayer: boolean): string | null {
  if (lobby.phase !== "lobby") return "This match has already launched.";
  if (lobby.slots.length < 2) return "Add an AI opponent to begin.";
  if (lobby.slots.length > MAP_PLAYER_CAPACITY[lobby.settings.mapSize]) return "Choose a larger map or remove a commander.";
  if (new Set(lobby.slots.map((slot) => slot.teamId)).size < 2) return "Choose at least two opposing teams.";
  if (!singleplayer && lobby.slots.some((slot) => !slot.isAi && !slot.connected)) {
    return "Waiting for disconnected commanders to rejoin.";
  }
  if (!singleplayer && lobby.slots.some((slot) => !slot.isAi && !slot.isHost && !slot.ready)) {
    return "Waiting for guests to get ready.";
  }
  return null;
}

export function createSingleplayerScenario(lobby: LobbyState, seed: number): ReturnType<typeof createCombatScenario> {
  const issue = lobbyLaunchIssue(lobby, true);
  if (issue) throw new Error(issue);
  return createCombatScenario({
    seed, ...lobby.settings, varyStartingPositions: true, startingFleet: false,
    players: lobby.slots.map((slot) => ({
      id: slot.playerId, name: slot.name, teamId: slot.teamId, color: slot.color, faction: slot.faction,
      ai: slot.isAi, aiDifficulty: slot.aiDifficulty ?? "normal", aiPersonality: slot.aiPersonality ?? "balanced",
    })),
  });
}
