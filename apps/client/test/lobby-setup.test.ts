import { describe, expect, it } from "vitest";
import { createCombatScenario } from "@space-rts/game-core";
import { createSingleplayerLobby, createSingleplayerScenario, lobbyLaunchIssue, updateSingleplayerLobby } from "../src/lobby-setup";

describe("singleplayer lobby", () => {
  it("launches without a human readiness phase", () => {
    const lobby = createSingleplayerLobby();
    lobby.slots[0]!.ready = false;
    expect(lobbyLaunchIssue(lobby, true)).toBeNull();
    expect(lobbyLaunchIssue(lobby, false)).toBeNull();
    expect(createSingleplayerScenario(lobby, 42).state.ships).toHaveLength(0);
  });

  it("uses the complete battlefield and roster configuration in the actual simulation", () => {
    const lobby = createSingleplayerLobby();
    updateSingleplayerLobby(lobby, { type: "set_settings", settings: {
      mapPreset: "amazon-tunnel", mapSize: "large", startingResources: "high",
      startingBase: "fortified", resourceDensity: "rich", teamSpawnMode: "interleaved",
    } });
    updateSingleplayerLobby(lobby, { type: "set_faction", playerId: "pilot-blue", faction: "concord" });
    updateSingleplayerLobby(lobby, { type: "set_ai_settings", playerId: "local-ai-1", difficulty: "hard", personality: "economic" });
    updateSingleplayerLobby(lobby, { type: "add_ai", faction: "industrial", teamId: 1, difficulty: "easy", personality: "turtle" });
    const actual = createSingleplayerScenario(lobby, 518).snapshot();
    // A direct scenario represents what the same network lobby launches.
    const expected = createCombatScenario({
      seed: 518, mapPreset: "amazon-tunnel", mapSize: "large", startingResources: "high",
      startingBase: "fortified", resourceDensity: "rich", teamSpawnMode: "interleaved",
      varyStartingPositions: true, startingFleet: false,
      players: [
        { id: "pilot-blue", name: "You", teamId: 1, color: 0x59a7ff, faction: "concord", ai: false, aiDifficulty: "normal", aiPersonality: "balanced" },
        { id: "local-ai-1", name: "AI Commander 1", teamId: 2, color: 0xff5576, faction: "brood", ai: true, aiDifficulty: "hard", aiPersonality: "economic" },
        { id: "local-ai-2", name: "AI Commander 2", teamId: 1, color: 0x62e6a7, faction: "industrial", ai: true, aiDifficulty: "easy", aiPersonality: "turtle" },
      ],
    }).snapshot();
    expect(actual).toEqual(expected);
  });

  it("prevents invalid launches after removing opponents or assigning everyone to one team", () => {
    const lobby = createSingleplayerLobby();
    updateSingleplayerLobby(lobby, { type: "set_team", playerId: "local-ai-1", teamId: 1 });
    expect(() => createSingleplayerScenario(lobby, 42)).toThrow("opposing teams");
    updateSingleplayerLobby(lobby, { type: "remove_slot", playerId: "local-ai-1" });
    expect(lobbyLaunchIssue(lobby, true)).toContain("opponent");
    updateSingleplayerLobby(lobby, { type: "remove_slot", playerId: "pilot-blue" });
    expect(lobby.slots).toHaveLength(1);
  });

  it("enforces map capacity and warns when an existing roster outgrows a smaller map", () => {
    const lobby = createSingleplayerLobby();
    for (let index = 0; index < 8; index++) updateSingleplayerLobby(lobby, { type: "add_ai" });
    expect(lobby.slots).toHaveLength(6);
    updateSingleplayerLobby(lobby, { type: "set_settings", settings: { ...lobby.settings, mapSize: "small" } });
    expect(lobby.slots).toHaveLength(6); // Never silently delete commanders.
    expect(lobbyLaunchIssue(lobby, true)).toContain("larger map");
    expect(() => createSingleplayerScenario(lobby, 42)).toThrow("larger map");
  });

  it("keeps unique player identities when removing and replacing AI slots", () => {
    const lobby = createSingleplayerLobby();
    updateSingleplayerLobby(lobby, { type: "add_ai" });
    updateSingleplayerLobby(lobby, { type: "remove_slot", playerId: "local-ai-1" });
    updateSingleplayerLobby(lobby, { type: "set_mode", mode: "ffa" });
    updateSingleplayerLobby(lobby, { type: "add_ai" });
    expect(new Set(lobby.slots.map((slot) => slot.playerId)).size).toBe(3);
    expect(new Set(lobby.slots.map((slot) => slot.teamId)).size).toBe(3);
    updateSingleplayerLobby(lobby, { type: "set_mode", mode: "teams" });
    expect(lobby.slots.map((slot) => slot.teamId)).toEqual([1, 2, 1]);
  });

  it("does not mutate the chosen setup when a scenario is played or restarted", () => {
    const lobby = createSingleplayerLobby();
    const saved = structuredClone(lobby);
    const game = createSingleplayerScenario(lobby, 22);
    for (let tick = 0; tick < 5; tick++) game.step();
    expect(lobby).toEqual(saved);
    expect(createSingleplayerScenario(lobby, 22).state.tick).toBe(0);
  });
});

describe("multiplayer launch readiness", () => {
  it("lets an unready host launch when all guests are ready", () => {
    const lobby = createSingleplayerLobby();
    lobby.slots[0]!.ready = false;
    lobby.slots[1]!.isAi = false;
    expect(lobbyLaunchIssue(lobby, false)).toBeNull();
    lobby.slots[1]!.ready = false;
    expect(lobbyLaunchIssue(lobby, false)).toContain("guests to get ready");
  });

  it("still requires every human to be connected, including the host", () => {
    const lobby = createSingleplayerLobby();
    lobby.slots[0]!.connected = false;
    expect(lobbyLaunchIssue(lobby, false)).toContain("rejoin");
    lobby.slots[0]!.connected = true;
    lobby.slots[1]!.isAi = false;
    lobby.slots[1]!.connected = false;
    expect(lobbyLaunchIssue(lobby, false)).toContain("rejoin");
  });

  it("moves the readiness exemption with the host role", () => {
    const lobby = createSingleplayerLobby();
    lobby.slots[0]!.isHost = false;
    lobby.slots[0]!.ready = false;
    lobby.slots[1]!.isAi = false;
    lobby.slots[1]!.isHost = true;
    lobby.slots[1]!.ready = false;
    expect(lobbyLaunchIssue(lobby, false)).toContain("guests to get ready");
    lobby.slots[0]!.ready = true;
    expect(lobbyLaunchIssue(lobby, false)).toBeNull();
  });
});
