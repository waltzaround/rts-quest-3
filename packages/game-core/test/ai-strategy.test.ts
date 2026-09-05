import { describe, expect, it } from "vitest";
import { createPlanarCirclePhysicsWorld, loadPhysicsRuntime } from "@space-rts/box3d-wasm";
import {
  calculateChecksum, createCombatScenario, getFactionShipDefinition, projectPlayerView,
  restoreSimulation, ReplayRecorder, playReplay, validateReplay, SHIPS, SHIPYARD_TYPES, type FactionId, type GameSimulation,
} from "../src";
import { runAiStrategy } from "../src/ai-strategy";

function fixture(faction: FactionId = "industrial") {
  return createCombatScenario({ seed: 913, mapPreset: "open-expanse", startingFleet: true,
    players: [
      { id: "enemy", name: "Enemy", teamId: 1 },
      { id: "bot", name: "Bot", teamId: 2, faction, ai: true },
    ] });
}

function addBuilder(simulation: GameSimulation) {
  const template = simulation.state.ships.find((ship) => ship.ownerPlayerId === "bot")!;
  const builder = { ...structuredClone(template), id: simulation.state.nextEntityId++, class: "fabricator" as const, orders: [], turrets: [] };
  simulation.state.ships.push(builder);
  return builder;
}

function decide(simulation: GameSimulation) {
  simulation.state.commandQueue = [];
  runAiStrategy(simulation, simulation.state.players.find((player) => player.id === "bot")!,
    { difficulty: "normal", personality: "balanced" }, 40,
    { countConstruction: () => 0, economy() {}, infrastructure() {}, defenses() {}, industrialRoster: () => ["fighter"] });
}

describe("faction AI strategy", () => {
  it("remembers scouted structures without reading hidden enemy movements and keeps plans out of player views", () => {
    const simulation = fixture();
    const enemy = simulation.state.structures.find((structure) => structure.ownerPlayerId === "enemy" && structure.type === "commandCore")!;
    const visibility = simulation.state.visibility.find((view) => view.teamId === 2)!;
    visibility.visibleEntityIds = [enemy.id];
    decide(simulation);
    const contact = structuredClone(simulation.state.aiPlans!.bot!.knownStructures[0]);
    visibility.visibleEntityIds = [];
    enemy.x += 800;
    decide(simulation);
    expect(simulation.state.aiPlans!.bot!.knownStructures).toEqual([contact]);
    simulation.refreshChecksum();
    const snapshot = simulation.snapshot();
    const restored = restoreSimulation(snapshot);
    expect(restored.snapshot()).toEqual(snapshot);
    const checksum = calculateChecksum(snapshot);
    snapshot.aiPlans!.bot!.knownStructures[0]!.x += 100;
    expect(calculateChecksum(snapshot)).not.toBe(checksum);
    expect(projectPlayerView(simulation.state, "bot")).not.toHaveProperty("aiPlans");
    // Revisit the old contact's location with an owned sensor: it can now be forgotten.
    const scout = simulation.state.ships.find((ship) => ship.ownerPlayerId === "bot")!;
    scout.x = contact!.x; scout.z = contact!.z;
    decide(simulation);
    expect(simulation.state.aiPlans!.bot!.knownStructures).toEqual([]);
  });

  it("keeps a large assault aimed at the enemy base in a bounded formation", () => {
    const simulation = fixture();
    simulation.state.obstacles = [];
    const enemy = simulation.state.structures.find((structure) => structure.ownerPlayerId === "enemy" && structure.type === "commandCore")!;
    simulation.state.visibility.find((view) => view.teamId === 2)!.visibleEntityIds = [enemy.id];
    const template = simulation.state.ships.find((ship) => ship.ownerPlayerId === "bot" && ship.class === "fighter")!;
    simulation.state.ships = Array.from({ length: 300 }, (_, index) => ({ ...structuredClone(template),
      id: simulation.state.nextEntityId++, x: template.x + index % 20, orders: [] }));
    decide(simulation);
    const orders = simulation.state.commandQueue.filter((command) => command.type === "attackMove");
    expect(orders).toHaveLength(300);
    for (const order of orders) if (order.type === "attackMove") {
      expect(order.unitIds).toHaveLength(1);
      expect(Math.hypot(order.destination.x - enemy.x, order.destination.z - enemy.z)).toBeLessThan(100);
    }
  });

  it("diversifies permanent Brood nest capacity even when the current combat population is lost", () => {
    const simulation = fixture("brood");
    const yard = simulation.state.structures.find((structure) => structure.ownerPlayerId === "bot" && structure.type === "shipyard")!;
    yard.broodClass = "fighter";
    const seeder = { ...structuredClone(yard), id: simulation.state.nextEntityId++, broodClass: "fabricator" as const };
    const newNest = { ...structuredClone(yard), id: simulation.state.nextEntityId++ };
    delete newNest.broodClass;
    simulation.state.structures.push(seeder, newNest);
    simulation.state.ships = [];
    decide(simulation);
    expect(simulation.state.commandQueue).toContainEqual(expect.objectContaining({ type: "queueUnit", structureId: newNest.id, shipClass: "bomber" }));
    expect(simulation.state.commandQueue.some((command) => command.type === "queueUnit" && command.structureId === yard.id)).toBe(false);
  });

  it("withdraws Concord ships with depleted shields and only resumes after substantial recharge", () => {
    const simulation = fixture("concord");
    const ship = simulation.state.ships.find((candidate) => candidate.ownerPlayerId === "bot" && SHIPS[candidate.class].buildPower === 0)!;
    const maxShield = getFactionShipDefinition(ship.class, "concord").maxShield;
    ship.shields = maxShield * 0.1;
    decide(simulation);
    expect(simulation.state.aiPlans!.bot!.recoveringShipIds).toContain(ship.id);
    expect(simulation.state.commandQueue).toContainEqual(expect.objectContaining({ type: "move", unitIds: [ship.id] }));
    ship.shields = maxShield * 0.5;
    decide(simulation);
    expect(simulation.state.aiPlans!.bot!.recoveringShipIds).toContain(ship.id);
    ship.shields = maxShield * 0.9;
    decide(simulation);
    expect(simulation.state.aiPlans!.bot!.recoveringShipIds).not.toContain(ship.id);
  });

  it("cancels stalled expansion orders, backs off the site, and retains recovery through restore", () => {
    const simulation = fixture();
    const player = simulation.state.players.find((entry) => entry.id === "bot")!;
    const builder = addBuilder(simulation);
    const command = { type: "buildStructure" as const, playerId: "bot", sequence: 1, requestedTick: 1,
      structureType: "storage" as const, position: { x: 1_000, z: 1_000 }, builderUnitIds: [builder.id], queued: false };
    expect(simulation.submitCommand(command).accepted).toBe(true);
    const think = () => runAiStrategy(simulation, player, { difficulty: "normal", personality: "balanced" }, 40,
      { countConstruction: () => 1, economy() {}, infrastructure() {}, defenses() {}, industrialRoster: () => ["fighter"] });
    think();
    simulation.state.tick = 1_201;
    think();
    expect(simulation.state.commandQueue).toContainEqual(expect.objectContaining({ type: "cancelBuildOrder", buildSequence: 1 }));
    expect(simulation.state.aiPlans!.bot!.blockedSites).toEqual([{ ...command.position, untilTick: 3_601 }]);
    simulation.refreshChecksum();
    expect(restoreSimulation(simulation.snapshot()).snapshot()).toEqual(simulation.snapshot());
  });

  it("extends Concord's forward pylon line beyond the map center toward a scouted core", () => {
    const simulation = fixture("concord");
    simulation.state.obstacles = [];
    const core = simulation.state.structures.find((structure) => structure.ownerPlayerId === "bot" && structure.type === "commandCore")!;
    const enemy = simulation.state.structures.find((structure) => structure.ownerPlayerId === "enemy" && structure.type === "commandCore")!;
    core.x = 0; core.z = -2_400; enemy.x = 0; enemy.z = 2_400;
    addBuilder(simulation);
    const field = simulation.state.territories.find((entry) => entry.ownerPlayerId === "bot")!;
    field.x = 0; field.z = 400; field.radius = 300;
    simulation.state.visibility.find((view) => view.teamId === 2)!.visibleEntityIds = [enemy.id];
    simulation.state.tick = 360;
    runAiStrategy(simulation, simulation.state.players.find((entry) => entry.id === "bot")!,
      { difficulty: "normal", personality: "economic" }, 40,
      { countConstruction: () => 0, economy() {}, infrastructure() {}, defenses() {}, industrialRoster: () => ["fighter"] });
    const expansion = simulation.state.commandQueue.find((command) => command.type === "buildStructure" && command.structureType === "pylon");
    expect(expansion).toBeDefined();
    if (expansion?.type === "buildStructure") expect(expansion.position.z).toBeGreaterThan(600);
    const warp = simulation.state.commandQueue.find((command) => command.type === "setWarpPoint");
    expect(warp).toBeDefined();
    if (warp?.type === "setWarpPoint") expect(Math.hypot(warp.position.x - field.x, warp.position.z - field.z)).toBeLessThan(field.radius);
  });

  it("replays faction AI plans exactly from a common bootstrap with real WASM physics", async () => {
    const runtime = await loadPhysicsRuntime();
    const world = createPlanarCirclePhysicsWorld(runtime);
    const restoredWorld = createPlanarCirclePhysicsWorld(runtime);
    const replayWorld = createPlanarCirclePhysicsWorld(runtime);
    try {
      const opening = fixture("concord");
      opening.attachPhysicsWorld(world);
      opening.stepMany(800);
      opening.refreshChecksum();
      // Box3D's solver history is outside snapshots. Compare identical bootstrap
      // timelines, the same contract used by deterministic lockstep/replay.
      const bootstrap = opening.snapshot();
      const simulation = restoreSimulation(bootstrap, world);
      const restored = restoreSimulation(bootstrap, restoredWorld);
      expect(restored.snapshot()).toEqual(simulation.snapshot());
      const recorder = new ReplayRecorder(simulation, { checkpointIntervalTicks: 40 });
      for (let tick = 0; tick < 800; tick++) {
        recorder.step(); restored.step();
        restored.refreshChecksum(); simulation.refreshChecksum();
        expect(restored.state.checksum, `tick ${simulation.state.tick}`).toBe(simulation.state.checksum);
      }
      expect(restored.snapshot()).toEqual(simulation.snapshot());
      const replay = recorder.finalize();
      expect(playReplay(replay, replayWorld).ok).toBe(true);
      const malformed = structuredClone(replay);
      malformed.initialState.aiPlans!.bot!.knownStructures = null as never;
      expect(validateReplay(malformed).valid).toBe(false);
    } finally { world.dispose(); restoredWorld.dispose(); replayWorld.dispose(); }
  });

  it.each(["industrial", "brood", "concord"] as const)("continues growing %s production and income in a prolonged economy run", async (faction) => {
    const runtime = await loadPhysicsRuntime();
    const world = createPlanarCirclePhysicsWorld(runtime);
    const simulation = createCombatScenario({ seed: 915, mapPreset: "open-expanse", startingResources: "high", resourceDensity: "rich",
      players: [{ id: "enemy", name: "Passive target", teamId: 1 },
        { id: "bot", name: "Economy bot", teamId: 2, faction, ai: true, aiDifficulty: "hard", aiPersonality: "economic" }] });
    simulation.attachPhysicsWorld(world);
    const enemyCore = simulation.state.structures.find((structure) => structure.ownerPlayerId === "enemy" && structure.type === "commandCore")!;
    enemyCore.health = 1e9; enemyCore.shields = 1e9;
    const yards = () => simulation.state.structures.filter((structure) => structure.ownerPlayerId === "bot"
      && structure.buildProgress >= 1 && SHIPYARD_TYPES.includes(structure.type as typeof SHIPYARD_TYPES[number])).length;
    const player = simulation.state.players.find((entry) => entry.id === "bot")!;
    simulation.stepMany(6_000);
    const early = { yards: yards(), income: player.economy.alloyIncome };
    simulation.stepMany(6_000);
    const diagnostic = JSON.stringify({ early, final: { yards: yards(), income: player.economy.alloyIncome },
      plan: simulation.state.aiPlans?.bot, structures: simulation.state.structures.filter((structure) => structure.ownerPlayerId === "bot")
        .map((structure) => [structure.type, structure.buildProgress]) });
    expect(yards(), diagnostic).toBeGreaterThan(early.yards);
    expect(yards(), diagnostic).toBeGreaterThan(4);
    expect(player.economy.alloyIncome, diagnostic).toBeGreaterThan(early.income);
    world.dispose();
  }, 120_000);
});
