import { describe, expect, it } from "vitest";
import {
  SHIPS,
  SHIP_ECONOMY,
  createCombatScenario,
  getFighterSquadMemberPose,
  type GameSimulation,
  type ShipState,
} from "../src";

function prepareProduction(simulation: GameSimulation, shipClass: "fighter" | "bomber") {
  const player = simulation.state.players.find((candidate) => candidate.id === "pilot-blue")!;
  const yard = simulation.state.structures.find(
    (structure) => structure.ownerPlayerId === player.id && structure.type === "shipyard",
  )!;
  player.economy.alloy = player.economy.alloyStorage;
  player.economy.energy = player.economy.energyStorage;
  return { player, yard };
}

function produceSmallCraftSquad(shipClass: "fighter" | "bomber"): { simulation: GameSimulation; squad: ShipState[] } {
  const simulation = createCombatScenario({ enemyCommander: false });
  const { player, yard } = prepareProduction(simulation, shipClass);
  const startingIds = new Set(simulation.state.ships.map((ship) => ship.id));
  expect(simulation.submitCommand({
    type: "queueUnit",
    playerId: player.id,
    sequence: 1,
    requestedTick: 1,
    structureId: yard.id,
    shipClass,
    count: 1,
  }).accepted).toBe(true);
  simulation.stepMany(SHIP_ECONOMY[shipClass].buildTicks);
  const squad = simulation.state.ships.filter((ship) => !startingIds.has(ship.id) && ship.class === shipClass);
  return { simulation, squad };
}

describe("small-craft squadrons", () => {
  it("produces five fighter units from one queued batch", () => {
    const { squad } = produceSmallCraftSquad("fighter");
    expect(SHIP_ECONOMY.fighter.batchSize).toBe(5);
    expect(squad).toHaveLength(5);
    expect(squad.every((ship) => ship.turrets.length === 5)).toBe(true);
    expect(squad.every((ship) => ship.orders[0]?.type === "attackMove")).toBe(true);
    expect(new Set(squad.map((ship) => `${ship.orders[0]!.destination.x}:${ship.orders[0]!.destination.z}`))).toHaveLength(5);
  });

  it("keeps an anchor fighter centered while its wingmates jink across a loose formation", () => {
    expect(getFighterSquadMemberPose(42, 0, 0)).toEqual({ x: 0, y: 0, z: 0, yaw: 0, bank: 0 });
    expect(getFighterSquadMemberPose(42, 0, 200)).toEqual({ x: 0, y: 0, z: 0, yaw: 0, bank: 0 });
    const first = getFighterSquadMemberPose(42, 1, 0);
    const later = getFighterSquadMemberPose(42, 1, 20);
    expect(Math.hypot(first.x, first.z)).toBeGreaterThan(8);
    expect(Math.hypot(later.x - first.x, later.z - first.z)).toBeGreaterThan(1);
    expect(Math.abs(later.bank)).toBeGreaterThan(0.05);
  });

  it("keeps bombers as a five-ship production wing", () => {
    const { squad } = produceSmallCraftSquad("bomber");
    expect(SHIP_ECONOMY.bomber.batchSize).toBe(5);
    expect(squad).toHaveLength(5);
    expect(squad.every((ship) => ship.orders[0]?.type === "attackMove")).toBe(true);
    expect(new Set(squad.map((ship) => `${ship.orders[0]!.destination.x}:${ship.orders[0]!.destination.z}`))).toHaveLength(5);
  });

  it("drops one fighter and its gun for each fifth of squad hull lost", () => {
    const simulation = createCombatScenario({ enemyCommander: false, startingFleet: true });
    const fighter = simulation.state.ships.find(
      (ship) => ship.ownerPlayerId === "pilot-blue" && ship.class === "fighter",
    )!;
    const target = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-red" && structure.type === "commandCore",
    )!;
    simulation.state.obstacles = [];
    simulation.state.ships = [fighter];
    fighter.x = target.x;
    fighter.z = target.z - 170;
    fighter.yaw = 0;
    fighter.health = SHIPS.fighter.maxHealth * 0.4;
    fighter.orders = [{ type: "hold", destination: { x: fighter.x, z: fighter.z }, facing: 0 }];
    for (const turret of fighter.turrets) {
      turret.targetEntityId = target.id;
      turret.currentYaw = 0;
      turret.cooldownRemaining = 999;
    }

    simulation.step();

    expect(fighter.turrets.slice(0, 2).every((turret) => turret.targetEntityId === target.id)).toBe(true);
    expect(fighter.turrets.slice(2).every((turret) => turret.targetEntityId === null)).toBe(true);
  });

  it("makes fighters and bombers faster than their previous flight profiles", () => {
    expect(SHIPS.fighter.speed).toBeGreaterThan(52);
    expect(SHIPS.bomber.speed).toBeGreaterThan(32);
  });

  it.each(["fighter", "bomber"] as const)("flies lateral %s attack passes while firing", (shipClass) => {
    const { simulation, squad } = produceSmallCraftSquad(shipClass);
    const craft = squad[0]!;
    const target = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-red" && structure.type === "commandCore",
    )!;
    simulation.state.obstacles = [];
    simulation.state.ships = [craft];
    craft.x = target.x;
    craft.z = target.z - (shipClass === "fighter" ? 190 : 285);
    craft.yaw = 0;
    craft.vx = 0;
    craft.vz = 0;
    craft.focusTargetEntityId = target.id;
    craft.orders = [{ type: "attackMove", destination: { x: target.x, z: target.z }, facing: 0 }];
    target.health = 100_000;
    target.shields = 100_000;

    const lateralDirections = new Set<number>();
    let shots = 0;
    let maximumSpeed = 0;
    const ticks = 400;
    for (let tick = 0; tick < ticks; tick += 1) {
      const snapshot = simulation.step();
      shots += snapshot.events.filter((event) => event.type === "weaponFired" && event.shipId === craft.id).length;
      maximumSpeed = Math.max(maximumSpeed, Math.hypot(craft.vx, craft.vz));
      const dx = target.x - craft.x;
      const dz = target.z - craft.z;
      const distance = Math.hypot(dx, dz) || 1;
      const lateralSpeed = craft.vx * dz / distance - craft.vz * dx / distance;
      if (Math.abs(lateralSpeed) > SHIPS[shipClass].speed * 0.08) lateralDirections.add(Math.sign(lateralSpeed));
    }

    expect(shots).toBeGreaterThan(0);
    expect(lateralDirections.size).toBeGreaterThan(0);
    expect(maximumSpeed).toBeGreaterThan(SHIPS[shipClass].speed * 0.8);
  });
});
