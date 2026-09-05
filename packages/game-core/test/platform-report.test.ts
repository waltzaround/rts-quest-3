import { describe, expect, it } from "vitest";
import { exactStateHash } from "./support/platform-report";
import { calculateChecksum, createCombatScenario } from "../src";

describe("platform probe precision", () => {
  it("detects floating-point drift smaller than the gameplay checksum rounding", () => {
    const state = createCombatScenario({ startingFleet: true }).snapshot();
    const checksum = calculateChecksum(state), exact = exactStateHash(state);
    state.ships[0]!.x += 1e-10;
    expect(calculateChecksum(state)).toBe(checksum);
    expect(exactStateHash(state)).not.toBe(exact);
  });
  it("preserves signed zero and array order, without depending on object key insertion order", () => {
    expect(exactStateHash({ x: -0 })).not.toBe(exactStateHash({ x: 0 }));
    expect(exactStateHash([1, 2])).not.toBe(exactStateHash([2, 1]));
    expect(exactStateHash({ x: 1, y: 2 })).toBe(exactStateHash({ y: 2, x: 1 }));
  });
  it("rejects invalid physics numbers instead of silently converting them to null", () => {
    for (const value of [NaN, Infinity, -Infinity]) expect(() => exactStateHash({ x: value })).toThrow("Non-finite");
  });
});
