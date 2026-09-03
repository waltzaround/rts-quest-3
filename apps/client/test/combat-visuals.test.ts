import { describe, expect, it } from "vitest";
import { getTorpedoImpactPoint } from "../src/combat-visuals";

describe("VLS impact placement", () => {
  it("is deterministic and distributes consecutive missiles across the hull interior", () => {
    const target = { x: 120, z: -45, radius: 40, yaw: 0, isShip: true } as const;
    const points = Array.from({ length: 24 }, (_, index) => getTorpedoImpactPoint(500 + index, target));

    expect(getTorpedoImpactPoint(507, target)).toEqual(getTorpedoImpactPoint(507, target));
    expect(points.some((point) => point.x < target.x)).toBe(true);
    expect(points.some((point) => point.x > target.x)).toBe(true);
    expect(points.some((point) => point.z < target.z)).toBe(true);
    expect(points.some((point) => point.z > target.z)).toBe(true);

    for (const point of points) {
      const normalizedX = (point.x - target.x) / (target.radius * 0.48);
      const normalizedZ = (point.z - target.z) / (target.radius * 0.74);
      expect(normalizedX ** 2 + normalizedZ ** 2).toBeLessThan(0.79);
    }
  });

  it("rotates the impact pattern with the target ship", () => {
    const unrotated = getTorpedoImpactPoint(91, {
      x: 0, z: 0, radius: 30, yaw: 0, isShip: true,
    });
    const quarterTurn = getTorpedoImpactPoint(91, {
      x: 0, z: 0, radius: 30, yaw: Math.PI / 2, isShip: true,
    });

    expect(quarterTurn.x).toBeCloseTo(unrotated.z);
    expect(quarterTurn.z).toBeCloseTo(-unrotated.x);
  });
});
