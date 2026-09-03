import { describe, expect, it } from "vitest";
import { createCombatScenario } from "../src";

const players = (count: number, teams: number) => Array.from({ length: count }, (_, index) => ({
  id: `pilot-${index + 1}`,
  name: `Pilot ${index + 1}`,
  teamId: index % teams + 1,
  ai: index > 3,
}));

describe("multiplayer scenarios", () => {
  it("scales resource points while guaranteeing three nodes at every spawn", () => {
    for (const playerCount of [2, 4, 6, 8]) {
      const scenario = createCombatScenario({
        seed: 8128,
        players: players(playerCount, playerCount),
        resourceDensity: "standard",
      });

      expect(scenario.state.resourceNodes, `${playerCount}-player resource points`)
        .toHaveLength(playerCount * 6 + 1);
      expect(scenario.state.resourceNodes.filter((node) => node.claimedByStructureId !== null))
        .toHaveLength(playerCount);
      expect(scenario.state.resourceNodes.filter((node) => node.claimedByStructureId === null))
        .toHaveLength(playerCount * 5 + 1);
      for (const core of scenario.state.structures.filter((structure) => structure.type === "commandCore")) {
        const nearbyNodes = scenario.state.resourceNodes.filter(
          (node) => Math.hypot(node.x - core.x, node.z - core.z) <= 420,
        );
        expect(nearbyNodes, `${playerCount}-player spawn at ${core.x},${core.z}`).toHaveLength(3);
      }
    }
  });

  it("creates a deterministic eight-player free-for-all with complete starting bases", () => {
    const config = players(8, 8);
    const first = createCombatScenario({ seed: 8128, players: config });
    const second = createCombatScenario({ seed: 8128, players: config });

    expect(first.state.players).toHaveLength(8);
    expect(first.state.teams).toHaveLength(8);
    expect(first.state.aiPlayerIds).toEqual(["pilot-5", "pilot-6", "pilot-7", "pilot-8"]);
    expect(first.state.structures.filter((structure) => structure.type === "commandCore")).toHaveLength(8);
    expect(first.state.structures.filter((structure) => structure.type === "shipyard")).toHaveLength(8);
    expect(new Set(first.state.structures
      .filter((structure) => structure.type === "commandCore")
      .map((structure) => `${structure.x.toFixed(3)},${structure.z.toFixed(3)}`)).size).toBe(8);
    expect(first.snapshot()).toEqual(second.snapshot());
  });

  it("supports full, fortified, and Command Core-only starting bases", () => {
    const config = players(2, 2);
    const ownedTypes = (startingBase: "full" | "fortified" | "command-core") => createCombatScenario({
      seed: 8128, players: config, startingBase,
    }).state.structures
      .filter((structure) => structure.ownerPlayerId === "pilot-1")
      .map((structure) => structure.type);

    expect(ownedTypes("full")).toEqual(["commandCore", "extractor", "solarArray", "shipyard"]);
    expect(ownedTypes("fortified")).toEqual([
      "commandCore", "extractor", "solarArray", "shipyard", "pointDefenseBattery", "pointDefenseBattery",
    ]);
    expect(ownedTypes("command-core")).toEqual(["commandCore"]);
  });

  it("supports grouped, interleaved, and deterministic random team deployments", () => {
    const config = players(4, 2);
    const coreOwners = (mode: "together" | "interleaved" | "random") => createCombatScenario({
      seed: 8128, players: config, teamSpawnMode: mode,
    }).state.structures.filter((structure) => structure.type === "commandCore").map((core) => core.ownerPlayerId);

    expect(coreOwners("together")).toEqual(["pilot-1", "pilot-3", "pilot-2", "pilot-4"]);
    expect(coreOwners("interleaved")).toEqual(["pilot-1", "pilot-2", "pilot-3", "pilot-4"]);
    expect(coreOwners("random")).toEqual(coreOwners("random"));
  });

  it("varies one-on-one starting sectors deterministically between match seeds", () => {
    const config = players(2, 2);
    const presets = [
      "orbital-ring", "crossfire", "open-expanse", "asteroid-belt", "spiral-arms",
      "shattered-core", "amazon-tunnel", "core-rush", "star-fortress",
    ] as const;
    const corePositions = (seed: number, mapPreset: (typeof presets)[number]) => createCombatScenario({
      seed, mapPreset, mapSize: "small", varyStartingPositions: true, players: config,
    }).state.structures
      .filter((structure) => structure.type === "commandCore")
      .map((core) => ({ ownerPlayerId: core.ownerPlayerId, x: core.x, z: core.z }));

    for (const mapPreset of presets) {
      const first = corePositions(8_128, mapPreset);
      const repeated = corePositions(8_128, mapPreset);
      const rerolled = corePositions(8_129, mapPreset);
      expect(repeated, `${mapPreset} repeated seed`).toEqual(first);
      expect(rerolled, `${mapPreset} new seed`).not.toEqual(first);
      expect(Math.hypot(first[0]!.x - first[1]!.x, first[0]!.z - first[1]!.z), mapPreset)
        .toBeGreaterThan(2_500);
    }
  });

  it("keeps a team alive while any allied Command Core survives", () => {
    const simulation = createCombatScenario({
      players: players(4, 2).map((player, index) => ({ ...player, teamId: index < 2 ? 1 : 2, ai: false })),
    });
    const teamTwoCores = simulation.state.structures.filter(
      (structure) => structure.type === "commandCore" && structure.teamId === 2,
    );

    teamTwoCores[0]!.health = 0;
    simulation.stepMany(2);
    expect(simulation.state.status).toBe("playing");
    expect(simulation.state.players.find((player) => player.id === "pilot-3")?.state).toBe("defeated");
    expect(simulation.state.players.find((player) => player.id === "pilot-4")?.state).toBe("playing");

    teamTwoCores[1]!.health = 0;
    simulation.step();
    expect(simulation.state.status).toBe("finished");
    expect(simulation.state.winnerTeamId).toBe(1);
  });

  it("rejects invalid lobby sizes and duplicate player identities", () => {
    expect(() => createCombatScenario({ players: players(1, 1) })).toThrow("2–8");
    expect(() => createCombatScenario({ players: players(9, 9) })).toThrow("2–8");
    expect(() => createCombatScenario({
      players: [
        { id: "same", name: "One", teamId: 1 },
        { id: "same", name: "Two", teamId: 2 },
      ],
    })).toThrow("unique");
  });
});
