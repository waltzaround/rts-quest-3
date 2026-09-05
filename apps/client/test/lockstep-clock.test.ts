import { describe, expect, it } from "vitest";
import { advanceLockstep } from "../src/lockstep-clock";

describe("multiplayer catch-up", () => {
  it("keeps a 20 Hz simulation current at 15 rendered frames per second", () => {
    const state = { tick: 0 };
    let simulatedMs = 0;
    for (let frame = 1; frame <= 150; frame += 1) {
      const target = Math.floor(frame * 20 / 15);
      advanceLockstep(state, target, () => {
        state.tick += 1;
        simulatedMs += 2;
      }, () => simulatedMs);
      expect(state.tick).toBe(target);
    }
    expect(state.tick).toBe(200);
  });

  it("recovers a delayed burst without dropping ticks or running past the server", () => {
    const state = { tick: 0 };
    const executed: number[] = [];
    const step = () => { executed.push(++state.tick); };
    expect(advanceLockstep(state, 10, step, () => 0)).toBe(4);
    expect(advanceLockstep(state, 10, step, () => 0)).toBe(4);
    expect(advanceLockstep(state, 10, step, () => 0)).toBe(2);
    expect(advanceLockstep(state, 10, step, () => 0)).toBe(0);
    expect(executed).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("yields for rendering once the CPU budget is spent", () => {
    const state = { tick: 0 };
    let time = 0;
    const step = () => { state.tick += 1; time += 5; };
    expect(advanceLockstep(state, 10_000, step, () => time)).toBe(2);
    expect(state.tick).toBe(2);
  });

  it("still makes progress when one tick exceeds the budget", () => {
    const state = { tick: 0 };
    let time = 0;
    expect(advanceLockstep(state, 10, () => { state.tick += 1; time += 30; }, () => time)).toBe(1);
  });

  it("stops stepping a finished simulation", () => {
    expect(advanceLockstep({ tick: 3 }, 100, () => {}, () => 0)).toBe(1);
  });
});
