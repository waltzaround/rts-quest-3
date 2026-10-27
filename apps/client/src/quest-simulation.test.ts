import { describe, expect, it } from "vitest";
import { createFleet, moveFormation, stepVessel, VOLUME } from "./quest-simulation";

describe("volumetric fleet experiment", () => {
  it("moves vertically and in depth, without overshooting", () => {
    const ship = createFleet(1)[0]!;
    ship.position = { x: 0, y: 0.2, z: 0 };
    ship.target = { x: 0.5, y: 1, z: -0.5 };
    stepVessel(ship, 1);
    expect(ship.position.y).toBeGreaterThan(0.2);
    expect(ship.position.z).toBeLessThan(0);
    stepVessel(ship, 100);
    expect(ship.position).toEqual(ship.target);
  });
  it("preserves XYZ formation offsets at the volume boundary", () => {
    const ships = createFleet();
    const before = ships.map(s => ({ ...s.position }));
    moveFormation(ships, { x: 8, y: 8, z: -8 });
    for (const [i, ship] of ships.entries()) {
      expect(ship.target.x).toBeLessThanOrEqual(VOLUME.x);
      expect(ship.target.y).toBeLessThanOrEqual(VOLUME.maxY);
      expect(ship.target.z).toBeGreaterThanOrEqual(-VOLUME.z);
      for (const axis of ["x", "y", "z"] as const) {
        expect(ship.target[axis] - ships[0]!.target[axis]).toBeCloseTo(before[i]![axis] - before[0]![axis]);
      }
    }
  });
  it("is frame-rate independent for fixed goals", () => {
    const a = createFleet(1)[0]!, b = createFleet(1)[0]!;
    a.target = b.target = { x: 1, y: 1.2, z: 0.8 };
    for (let i = 0; i < 72; i++) stepVessel(a, 1 / 72);
    for (let i = 0; i < 120; i++) stepVessel(b, 1 / 120);
    for (const axis of ["x", "y", "z"] as const) expect(a.position[axis]).toBeCloseTo(b.position[axis], 10);
  });
  it("bounds fleet size and accepts empty selection", () => {
    expect(createFleet(1000)).toHaveLength(48);
    expect(() => moveFormation([], { x: 0, y: 1, z: 0 })).not.toThrow();
  });
});
