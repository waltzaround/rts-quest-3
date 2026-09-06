import { describe, expect, it } from "vitest";
import { MatchStartSequence } from "../src/match-start";

describe("match start presentation", () => {
  it("holds gameplay for two loading seconds and a full 3–2–1 countdown", () => {
    const intro = new MatchStartSequence();
    intro.start(100);
    expect(intro.update(100, true)).toEqual({ phase: "loading", progress: 0, countdown: 0 });
    expect(intro.update(1_100, true)?.progress).toBe(0.5);
    expect(intro.update(2_099, true)?.phase).toBe("loading");
    for (const [time, countdown] of [[2_100, 3], [3_100, 2], [4_100, 1], [5_099, 1]]) {
      expect(intro.update(time!, true)).toEqual({ phase: "countdown", progress: 1, countdown });
      expect(intro.blocksGameplay).toBe(true);
    }
    expect(intro.update(5_100, true)?.phase).toBe("engage");
    expect(intro.blocksGameplay).toBe(false);
    expect(intro.update(5_600, true)).toBeNull();
  });

  it("waits for local initialization before counting down without falsely reaching 100%", () => {
    const intro = new MatchStartSequence();
    intro.start(0);
    expect(intro.update(9_000, false)).toEqual({ phase: "loading", progress: 0.99, countdown: 0 });
    expect(intro.blocksGameplay).toBe(true);
    expect(intro.update(9_000, true)?.countdown).toBe(3);
    expect(intro.update(11_999, true)?.countdown).toBe(1);
    expect(intro.blocksGameplay).toBe(true);
    expect(intro.update(12_000, true)?.phase).toBe("engage");
  });

  it("uses the remaining shared deadline when joining during the countdown", () => {
    const intro = new MatchStartSequence();
    intro.start(800_000, 1_800, true);
    expect(intro.update(800_000, true)?.countdown).toBe(2);
    expect(intro.update(800_800, true)?.countdown).toBe(1);
    expect(intro.update(801_800, true)?.phase).toBe("engage");
  });

  it("waits for a late multiplayer bootstrap without restarting the server countdown", () => {
    const intro = new MatchStartSequence();
    intro.start(0, 1_000, true);
    expect(intro.update(7_000, false)?.phase).toBe("loading");
    expect(intro.blocksGameplay).toBe(true);
    expect(intro.update(7_001, true)?.phase).toBe("engage");
    expect(intro.blocksGameplay).toBe(false);
  });

  it("clears an abandoned countdown and starts the next match from zero progress", () => {
    const intro = new MatchStartSequence();
    intro.start(0);
    intro.cancel();
    expect(intro.blocksGameplay).toBe(false);
    expect(intro.update(3_000, true)).toBeNull();
    intro.start(4_000);
    expect(intro.update(4_000, true)?.progress).toBe(0);
    expect(intro.blocksGameplay).toBe(true);
    expect(intro.update(30_000, true)?.phase).toBe("engage");
  });
});
