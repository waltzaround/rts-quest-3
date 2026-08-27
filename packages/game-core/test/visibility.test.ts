import { describe, expect, it } from "vitest";
import {
  calculateChecksum,
  calculateOmniscientViewChecksum,
  calculatePlayerViewChecksum,
  calculateTeamViewChecksum,
  createCombatScenario as createScenario,
  getTeamVisibility,
  isEntityVisibleToTeam,
  isProjectileVisibleToTeam,
  isResourceNodeDiscoveredByTeam,
  projectPlayerView,
  projectOmniscientView,
  projectTeamView,
  restoreSimulation,
  type SimulationState,
  type ScenarioOptions,
} from "../src";

const createCombatScenario = (options: ScenarioOptions = {}) => createScenario({ ...options, startingFleet: true });

function parkTeamSourcesFarAway(state: SimulationState, teamId: number): void {
  let index = 0;
  for (const ship of state.ships.filter((candidate) => candidate.teamId === teamId)) {
    ship.x = -4_000 - index * 80;
    ship.z = -4_000;
    ship.vx = 0;
    ship.vz = 0;
    ship.orders = [];
    index += 1;
  }
  for (const structure of state.structures.filter((candidate) => candidate.teamId === teamId)) {
    structure.x = -4_000 - index * 100;
    structure.z = -4_500;
    index += 1;
  }
}

describe("authoritative sensor visibility", () => {
  it("starts generic opposing fleets outside one another's sensor coverage", () => {
    const simulation = createCombatScenario({
      enemyCommander: false,
      players: [
        { id: "blue", name: "Blue", teamId: 1 },
        { id: "red", name: "Red", teamId: 2 },
      ],
    });

    expect(simulation.playerView("blue")!.ships.every((ship) => ship.teamId === 1)).toBe(true);
    expect(simulation.playerView("red")!.ships.every((ship) => ship.teamId === 2)).toBe(true);
    expect(simulation.playerView("blue")!.structures.every((structure) => structure.teamId === 1)).toBe(true);
    expect(simulation.playerView("red")!.structures.every((structure) => structure.teamId === 2)).toBe(true);
  });

  it("detects hostile entities at the deterministic sensor boundary", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    parkTeamSourcesFarAway(simulation.state, 1);
    const scout = simulation.state.ships.find((ship) => ship.teamId === 1 && ship.class === "fighter")!;
    const contact = simulation.state.ships.find((ship) => ship.teamId === 2 && ship.class === "fighter")!;
    scout.x = 0;
    scout.z = 0;
    contact.x = 270;
    contact.z = 0;
    contact.orders = [];

    simulation.step();
    expect(isEntityVisibleToTeam(simulation.state, 1, contact.id)).toBe(true);

    contact.x = 270.01;
    simulation.step();
    expect(isEntityVisibleToTeam(simulation.state, 1, contact.id)).toBe(false);
  });

  it("shares current contacts and discoveries across allied teams", () => {
    const simulation = createCombatScenario({
      enemyCommander: false,
      players: [
        { id: "scout", name: "Scout", teamId: 1 },
        { id: "ally", name: "Ally", teamId: 2 },
        { id: "hostile", name: "Hostile", teamId: 3 },
      ],
    });
    simulation.state.teams.find((team) => team.id === 1)!.alliedTeamIds = [2];
    simulation.state.teams.find((team) => team.id === 2)!.alliedTeamIds = [1];
    parkTeamSourcesFarAway(simulation.state, 1);
    parkTeamSourcesFarAway(simulation.state, 2);
    const scout = simulation.state.ships.find((ship) => ship.ownerPlayerId === "scout")!;
    const hostile = simulation.state.ships.find((ship) => ship.ownerPlayerId === "hostile")!;
    scout.x = 0;
    scout.z = 0;
    hostile.x = 200;
    hostile.z = 0;
    hostile.orders = [];
    const resource = {
      id: simulation.state.nextEntityId++,
      type: "alloy" as const,
      x: 210,
      z: 0,
      richness: 1.5,
      claimedByStructureId: null,
    };
    simulation.state.resourceNodes.push(resource);

    simulation.step();
    expect(isEntityVisibleToTeam(simulation.state, 2, hostile.id)).toBe(true);
    expect(isResourceNodeDiscoveredByTeam(simulation.state, 2, resource.id)).toBe(true);
  });

  it("remembers discovered resources but does not remember moving contacts", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    parkTeamSourcesFarAway(simulation.state, 1);
    const scout = simulation.state.ships.find((ship) => ship.teamId === 1 && ship.class === "fighter")!;
    const contact = simulation.state.ships.find((ship) => ship.teamId === 2 && ship.class === "fighter")!;
    const resource = {
      id: simulation.state.nextEntityId++,
      type: "alloy" as const,
      x: 100,
      z: 0,
      richness: 1.2,
      claimedByStructureId: null,
    };
    simulation.state.resourceNodes.push(resource);
    scout.x = 0;
    scout.z = 0;
    contact.x = 120;
    contact.z = 0;
    contact.orders = [];
    simulation.step();
    expect(isResourceNodeDiscoveredByTeam(simulation.state, 1, resource.id)).toBe(true);
    expect(isEntityVisibleToTeam(simulation.state, 1, contact.id)).toBe(true);

    scout.x = -4_000;
    scout.z = -4_000;
    simulation.step();
    expect(isResourceNodeDiscoveredByTeam(simulation.state, 1, resource.id)).toBe(true);
    expect(isEntityVisibleToTeam(simulation.state, 1, contact.id)).toBe(false);
  });

  it("rejects hidden focus fire and hidden extractor placement", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    parkTeamSourcesFarAway(simulation.state, 1);
    const ownedShip = simulation.state.ships.find((ship) => ship.teamId === 1)!;
    const hiddenTarget = simulation.state.ships.find((ship) => ship.teamId === 2)!;
    hiddenTarget.x = 4_000;
    hiddenTarget.z = 4_000;
    hiddenTarget.orders = [];
    const fabricator = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-blue" && structure.type === "shipyard",
    )!;
    fabricator.type = "fabricator";
    fabricator.x = 0;
    fabricator.z = 0;
    const hiddenNode = {
      id: simulation.state.nextEntityId++,
      type: "alloy" as const,
      x: 350,
      z: 0,
      richness: 1,
      claimedByStructureId: null,
    };
    simulation.state.resourceNodes.push(hiddenNode);
    simulation.step();

    expect(simulation.submitCommand({
      type: "focusFire",
      playerId: "pilot-blue",
      sequence: 1,
      requestedTick: simulation.state.tick + 1,
      unitIds: [ownedShip.id],
      queued: false,
      targetEntityId: hiddenTarget.id,
    })).toEqual({ accepted: false, reason: "target" });
    expect(simulation.canPlaceStructure("pilot-blue", "extractor", hiddenNode, hiddenNode.id)).toBe(false);

    ownedShip.x = hiddenNode.x;
    ownedShip.z = hiddenNode.z;
    simulation.step();
    expect(isResourceNodeDiscoveredByTeam(simulation.state, 1, hiddenNode.id)).toBe(true);
    expect(simulation.canPlaceStructure("pilot-blue", "extractor", hiddenNode, hiddenNode.id)).toBe(true);
  });

  it("revalidates a queued focus target when allied sensor contact is lost", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    parkTeamSourcesFarAway(simulation.state, 1);
    const scout = simulation.state.ships.find((ship) => ship.teamId === 1 && ship.class === "fighter")!;
    const orderedShip = simulation.state.ships.find((ship) => ship.teamId === 1 && ship.id !== scout.id)!;
    const target = simulation.state.ships.find((ship) => ship.teamId === 2 && ship.class === "fighter")!;
    scout.x = 0;
    scout.z = 0;
    target.x = 120;
    target.z = 0;
    target.orders = [];
    simulation.step();
    expect(simulation.submitCommand({
      type: "focusFire",
      playerId: "pilot-blue",
      sequence: 1,
      requestedTick: simulation.state.tick + 2,
      unitIds: [orderedShip.id],
      queued: false,
      targetEntityId: target.id,
    }).accepted).toBe(true);

    scout.x = -4_000;
    scout.z = -4_000;
    target.x = 4_000;
    target.z = 4_000;
    simulation.stepMany(2);
    expect(orderedShip.focusTargetEntityId).toBeNull();
    expect(orderedShip.turrets.every((turret) => turret.targetEntityId !== target.id)).toBe(true);
  });

  it("tracks allied and detected hostile projectiles separately", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    parkTeamSourcesFarAway(simulation.state, 1);
    const scout = simulation.state.ships.find((ship) => ship.teamId === 1 && ship.class === "fighter")!;
    scout.x = 0;
    scout.z = 0;
    const alliedProjectile = {
      id: simulation.state.nextEntityId++, ownerShipId: scout.id, ownerTeamId: 1,
      weaponTypeId: "autocannon" as const, targetEntityId: 0,
      x: 3_000, z: 3_000, previousX: 3_000, previousZ: 3_000,
      vx: 0, vz: 0, radius: 1, damage: 1, lifetimeTicks: 10,
    };
    const hostileProjectile = {
      ...alliedProjectile,
      id: simulation.state.nextEntityId++, ownerTeamId: 2, x: 120, z: 0,
      previousX: 120, previousZ: 0,
    };
    simulation.state.projectiles.push(alliedProjectile, hostileProjectile);
    simulation.step();

    expect(isProjectileVisibleToTeam(simulation.state, 1, alliedProjectile.id)).toBe(true);
    expect(isProjectileVisibleToTeam(simulation.state, 1, hostileProjectile.id)).toBe(true);
  });
});

describe("secure player view projection", () => {
  it("omits hidden hostiles and sanitizes visible hostile private state", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    parkTeamSourcesFarAway(simulation.state, 1);
    const scout = simulation.state.ships.find((ship) => ship.teamId === 1 && ship.class === "fighter")!;
    const visibleHostile = simulation.state.ships.find((ship) => ship.teamId === 2 && ship.class === "fighter")!;
    const hiddenHostile = simulation.state.ships.find((ship) => ship.teamId === 2 && ship.id !== visibleHostile.id)!;
    scout.x = 0;
    scout.z = 0;
    visibleHostile.x = 120;
    visibleHostile.z = 0;
    visibleHostile.orders = [{ type: "move", destination: { x: 900, z: 900 }, facing: 1 }];
    visibleHostile.focusTargetEntityId = scout.id;
    visibleHostile.turrets[0]!.targetEntityId = scout.id;
    visibleHostile.turrets[0]!.cooldownRemaining = 9;
    visibleHostile.turrets[0]!.fireSequence = 12;
    hiddenHostile.x = 4_000;
    hiddenHostile.z = 4_000;
    hiddenHostile.orders = [];
    simulation.state.players.find((player) => player.id === "pilot-blue")!.lastCommandSequence = 17;
    simulation.step();

    const view = projectPlayerView(simulation.state, "pilot-blue")!;
    expect(view.ownLastCommandSequence).toBe(17);
    expect(view.ships.some((ship) => ship.id === hiddenHostile.id)).toBe(false);
    const contact = view.ships.find((ship) => ship.id === visibleHostile.id)!;
    expect(contact.relationship).toBe("hostile");
    expect(contact.orders).toEqual([]);
    expect(contact.focusTargetEntityId).toBeNull();
    expect(contact.turrets[0]!.targetEntityId).toBeNull();
    expect(contact.turrets[0]!.cooldownRemaining).toBe(0);
    expect(contact.turrets[0]!.fireSequence).toBe(0);
    expect(view.players.find((player) => player.id === "pilot-red")!.economy).toBeNull();
    expect("seed" in view).toBe(false);
    expect("commandQueue" in view).toBe(false);
    expect(view.obstacles[0]!.visualSeed).toBe(simulation.state.obstacles[0]!.visualSeed);
    expect(calculatePlayerViewChecksum(view)).toBe(view.checksum);
  });

  it("does not leak hidden claim, projectile owner, or target identifiers", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    parkTeamSourcesFarAway(simulation.state, 1);
    const scout = simulation.state.ships.find((ship) => ship.teamId === 1 && ship.class === "fighter")!;
    const hiddenHostile = simulation.state.ships.find((ship) => ship.teamId === 2)!;
    scout.x = 0;
    scout.z = 0;
    hiddenHostile.x = 4_000;
    hiddenHostile.z = 4_000;
    hiddenHostile.orders = [];
    const node = {
      id: simulation.state.nextEntityId++, type: "alloy" as const,
      x: 100, z: 0, richness: 1, claimedByStructureId: hiddenHostile.id,
    };
    simulation.state.resourceNodes.push(node);
    const projectile = {
      id: simulation.state.nextEntityId++, ownerShipId: hiddenHostile.id, ownerTeamId: 2,
      weaponTypeId: "plasma" as const, targetEntityId: hiddenHostile.id,
      x: 120, z: 0, previousX: 120, previousZ: 0,
      vx: 0, vz: 0, radius: 1, damage: 1, lifetimeTicks: 10,
    };
    simulation.state.projectiles.push(projectile);
    simulation.step();

    const view = simulation.playerView("pilot-blue")!;
    expect(view.resourceNodes.find((resource) => resource.id === node.id)!.claimedByStructureId).toBeNull();
    expect(view.projectiles.find((candidate) => candidate.id === projectile.id)).toMatchObject({
      ownerShipId: null,
      targetEntityId: null,
    });
  });

  it("changes only for visible intel and is detached from authoritative state", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    parkTeamSourcesFarAway(simulation.state, 1);
    const hiddenHostile = simulation.state.ships.find((ship) => ship.teamId === 2)!;
    hiddenHostile.x = 4_000;
    hiddenHostile.z = 4_000;
    hiddenHostile.orders = [];
    simulation.step();
    const first = simulation.playerView("pilot-blue")!;
    hiddenHostile.health -= 50;
    const hiddenChange = simulation.playerView("pilot-blue")!;
    expect(hiddenChange.checksum).toBe(first.checksum);

    hiddenChange.players[0]!.name = "mutated view";
    expect(simulation.state.players[0]!.name).not.toBe("mutated view");
    simulation.state.players[0]!.economy.alloy += 1;
    expect(simulation.playerView("pilot-blue")!.checksum).not.toBe(first.checksum);
    expect(projectPlayerView(simulation.state, "unknown-player")).toBeNull();
  });

  it("keeps public obstacle layout and visual seeds independent of the private simulation seed", () => {
    const first = createCombatScenario({ seed: 111, enemyCommander: false });
    const second = createCombatScenario({ seed: 999_999, enemyCommander: false });
    expect(first.state.obstacles).toEqual(second.state.obstacles);
    expect(first.playerView("pilot-blue")!.obstacles).toEqual(second.playerView("pilot-blue")!.obstacles);
    expect(first.playerView("pilot-blue")!.checksum).toBe(second.playerView("pilot-blue")!.checksum);
  });

  it("projects a team spectator view without impersonating a player", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    parkTeamSourcesFarAway(simulation.state, 1);
    const hiddenHostile = simulation.state.ships.find((ship) => ship.teamId === 2)!;
    hiddenHostile.x = 4_000;
    hiddenHostile.z = 4_000;
    hiddenHostile.orders = [];
    simulation.step();

    const view = projectTeamView(simulation.state, 1)!;
    expect(view).toMatchObject({
      simulationVersion: 7,
      viewerPlayerId: null,
      viewerTeamId: 1,
      ownLastCommandSequence: null,
    });
    expect(view.ships.every((ship) => ship.teamId === 1 && ship.relationship === "ally")).toBe(true);
    expect(view.ships.some((ship) => ship.id === hiddenHostile.id)).toBe(false);
    expect(view.players.find((player) => player.teamId === 2)!.economy).toBeNull();
    expect(calculateTeamViewChecksum(view)).toBe(view.checksum);
    expect(simulation.teamView(1)).toEqual(view);
    expect(simulation.teamView(999)).toBeNull();
  });

  it("projects a seed-safe omniscient replay view with all tactical state", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    const enemy = simulation.state.ships.find((ship) => ship.teamId === 2)!;
    enemy.orders = [{ type: "move", destination: { x: 900, z: 700 }, facing: 0.5 }];
    enemy.focusTargetEntityId = simulation.state.ships.find((ship) => ship.teamId === 1)!.id;
    const view = projectOmniscientView(simulation.state);

    expect(view.simulationVersion).toBe(7);
    expect(view.ships).toHaveLength(simulation.state.ships.length);
    expect(view.structures).toHaveLength(simulation.state.structures.length);
    expect(view.resourceNodes).toHaveLength(simulation.state.resourceNodes.length);
    expect(view.ships.every((ship) => ship.relationship === "omniscient")).toBe(true);
    expect(view.ships.find((ship) => ship.id === enemy.id)).toMatchObject({
      orders: enemy.orders,
      focusTargetEntityId: enemy.focusTargetEntityId,
    });
    expect(view.players.every((player) => player.economy !== null)).toBe(true);
    expect("seed" in view).toBe(false);
    expect("commandQueue" in view).toBe(false);
    expect("visibility" in view).toBe(false);
    expect(calculateOmniscientViewChecksum(view)).toBe(view.checksum);
    expect(simulation.omniscientView()).toEqual(view);

    enemy.health -= 1;
    expect(projectOmniscientView(simulation.state).checksum).not.toBe(view.checksum);
  });
});

describe("visibility serialization", () => {
  it("hashes visibility and preserves discoveries through restore", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    const resource = {
      id: simulation.state.nextEntityId++, type: "alloy" as const,
      x: simulation.state.ships.find((ship) => ship.teamId === 1)!.x,
      z: simulation.state.ships.find((ship) => ship.teamId === 1)!.z,
      richness: 1, claimedByStructureId: null,
    };
    simulation.state.resourceNodes.push(resource);
    simulation.step();
    const snapshot = simulation.snapshot();
    const restored = restoreSimulation(snapshot);
    expect(isResourceNodeDiscoveredByTeam(restored.state, 1, resource.id)).toBe(true);
    expect(restored.snapshot()).toEqual(snapshot);

    const changed = restored.snapshot();
    getTeamVisibility(changed, 1)!.visibleEntityIds.pop();
    expect(calculateChecksum(changed)).not.toBe(calculateChecksum(snapshot));
  });

  it("upgrades a legacy snapshot with deterministic current visibility", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    const legacy = simulation.snapshot() as unknown as Omit<SimulationState, "version" | "visibility"> & {
      version: number;
      visibility?: SimulationState["visibility"];
    };
    legacy.version = 4;
    delete legacy.visibility;
    const restored = restoreSimulation(legacy as unknown as SimulationState);
    expect(restored.state.version).toBe(7);
    expect(restored.state.visibility.map((visibility) => visibility.teamId)).toEqual([1, 2]);
    expect(restored.state.visibility.every((visibility) => visibility.visibleEntityIds.length > 0)).toBe(true);
  });
});
