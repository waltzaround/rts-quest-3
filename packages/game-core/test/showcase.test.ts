import { describe, expect, it } from "vitest";
import { SHIPYARD_TYPES, createMenuBattleScenario, createShowcaseScenario, type ShipyardType } from "../src";

describe("battle showcase scenario", () => {
  it("starts a deterministic automated battle with hundreds of mixed ships and active factories", () => {
    const first = createShowcaseScenario();
    const second = createShowcaseScenario();

    expect(first.snapshot()).toEqual(second.snapshot());
    expect(first.state.players).toHaveLength(4);
    expect(first.state.teams).toHaveLength(2);
    expect(first.state.aiPlayerIds).toHaveLength(4);
    expect(first.state.ships).toHaveLength(148);
    const visibleCraftCount = first.state.ships.reduce(
      (total, ship) => total + (ship.class === "fighter" ? 5 : 1),
      0,
    );
    expect(visibleCraftCount).toBe(292);
    expect(new Set(first.state.ships.map((ship) => ship.class))).toEqual(new Set([
      "fighter", "bomber", "frigate", "flakFrigate", "torpedoFrigate",
      "destroyer", "artilleryDestroyer", "cruiser", "carrier", "battleship",
    ]));
    expect(first.state.ships.every((ship) => ship.orders[0]?.type === "attackMove")).toBe(true);

    const yards = first.state.structures.filter((structure) =>
      SHIPYARD_TYPES.includes(structure.type as ShipyardType),
    );
    expect(yards).toHaveLength(16);
    expect(yards.every((yard) => yard.productionQueue.length === (yard.type === "fleetShipyard" ? 4 : 3))).toBe(true);
    expect(yards.every((yard) => yard.rallyPoint.x === 0 && yard.rallyPoint.z === 0)).toBe(true);

    let sawWeaponsFire = false;
    let sawUnitProduced = false;
    for (let tick = 0; tick < 80; tick += 1) {
      const debug = first.step();
      sawWeaponsFire ||= debug.shotsFired > 0;
      sawUnitProduced ||= debug.events.some((event) => event.type === "unitProduced");
    }
    expect(sawWeaponsFire).toBe(true);
    expect(sawUnitProduced).toBe(true);
    expect(yards.some((yard) => yard.productionQueue[0]!.progress > 0)).toBe(true);
    expect(first.state.ships.length).toBeGreaterThan(140);
  });
});

describe("title-screen battle scenario", () => {
  it("uses mirrored reinforcement waves and helps the trailing fleet recover", () => {
    const simulation = createMenuBattleScenario();
    const trailingId = "menu-crimson";
    const removedIds = simulation.state.ships
      .filter((ship) => ship.ownerPlayerId === trailingId)
      .slice(0, 5)
      .map((ship) => ship.id);
    simulation.state.ships = simulation.state.ships.filter((ship) => !removedIds.includes(ship.id));
    const before = Object.fromEntries(simulation.state.players.map((player) => [
      player.id, simulation.state.ships.filter((ship) => ship.ownerPlayerId === player.id).length,
    ]));
    const firstNewId = simulation.state.nextEntityId;

    simulation.maintainMenuBattleReinforcements(28, 90);

    const after = Object.fromEntries(simulation.state.players.map((player) => [
      player.id, simulation.state.ships.filter((ship) => ship.ownerPlayerId === player.id).length,
    ]));
    expect(after["menu-aster"]! - before["menu-aster"]!).toBe(1);
    expect(after[trailingId]! - before[trailingId]!).toBe(3);
    const firstReinforcementByPlayer = simulation.state.players.map((player) =>
      simulation.state.ships.find((ship) => ship.id >= firstNewId && ship.ownerPlayerId === player.id)!.class);
    expect(new Set(firstReinforcementByPlayer).size).toBe(1);
  });

  it("runs a deterministic fighter-heavy 1v1 without reusing the large showcase", () => {
    const first = createMenuBattleScenario();
    const second = createMenuBattleScenario();

    expect(first.snapshot()).toEqual(second.snapshot());
    expect(first.state.players).toHaveLength(2);
    expect(first.state.aiPlayerIds).toHaveLength(2);
    expect(first.state.ships).toHaveLength(44);
    expect(first.state.ships.filter((ship) => ship.class === "fighter")).toHaveLength(32);
    expect(first.state.ships.filter((ship) => ship.class === "bomber")).toHaveLength(8);
    expect(first.state.ships.filter((ship) => ship.class === "cruiser" || ship.class === "battleship")).toHaveLength(4);
    expect(first.state.ships.every((ship) => ship.orders[0]?.type === "patrol")).toBe(true);
    const averageStartRadius = first.state.ships.reduce((sum, ship) => sum + Math.hypot(ship.x, ship.z), 0) / first.state.ships.length;
    const averageDestinationRadius = first.state.ships.reduce((sum, ship) => {
      const destination = ship.orders[0]!.destination;
      return sum + Math.hypot(destination.x, destination.z);
    }, 0) / first.state.ships.length;
    expect(averageDestinationRadius).toBeLessThan(averageStartRadius);

    const firstReinforcementId = first.state.nextEntityId;
    const fighterStarts = new Map(first.state.ships
      .filter((ship) => ship.class === "fighter")
      .map((ship) => [ship.id, { x: ship.x, z: ship.z }]));
    const maximumFleetByPlayer = new Map<string, number>();
    for (let tick = 0; tick < 600 && first.state.status === "playing"; tick += 1) {
      first.maintainMenuBattleReinforcements(28, 90);
      first.step();
      for (const player of first.state.players) {
        const count = first.state.ships.filter((ship) => ship.ownerPlayerId === player.id).length;
        maximumFleetByPlayer.set(player.id, Math.max(maximumFleetByPlayer.get(player.id) ?? 0, count));
      }
    }
    expect(first.state.nextEntityId).toBeGreaterThan(firstReinforcementId);
    expect([...maximumFleetByPlayer.values()].every((count) => count <= 28)).toBe(true);
    const survivingOpeningFighters = first.state.ships.filter((ship) => fighterStarts.has(ship.id));
    expect(survivingOpeningFighters.length).toBeGreaterThan(0);
    expect(survivingOpeningFighters.every((ship) => {
      const start = fighterStarts.get(ship.id)!;
      return Math.hypot(ship.x - start.x, ship.z - start.z) > 30;
    })).toBe(true);
  });
});
