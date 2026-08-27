import { describe, expect, it } from "vitest";
import { SHIPYARD_TYPES, createShowcaseScenario, type ShipyardType } from "../src";

describe("battle showcase scenario", () => {
  it("starts a deterministic automated battle with hundreds of mixed ships and active factories", () => {
    const first = createShowcaseScenario();
    const second = createShowcaseScenario();

    expect(first.snapshot()).toEqual(second.snapshot());
    expect(first.state.players).toHaveLength(4);
    expect(first.state.teams).toHaveLength(2);
    expect(first.state.aiPlayerIds).toHaveLength(4);
    expect(first.state.ships).toHaveLength(144);
    const visibleCraftCount = first.state.ships.reduce(
      (total, ship) => total + (ship.class === "fighter" ? 5 : 1),
      0,
    );
    expect(visibleCraftCount).toBe(288);
    expect(new Set(first.state.ships.map((ship) => ship.class))).toEqual(new Set([
      "fighter", "bomber", "frigate", "flakFrigate", "torpedoFrigate",
      "destroyer", "cruiser", "carrier", "battleship",
    ]));
    expect(first.state.ships.every((ship) => ship.orders[0]?.type === "attackMove")).toBe(true);

    const yards = first.state.structures.filter((structure) =>
      SHIPYARD_TYPES.includes(structure.type as ShipyardType),
    );
    expect(yards).toHaveLength(16);
    expect(yards.every((yard) => yard.productionQueue.length === 3)).toBe(true);
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
