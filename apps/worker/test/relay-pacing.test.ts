import { afterEach, describe, expect, it, vi } from "vitest";
import { Match } from "../src/index";

// Exercise the actual Durable Object report handler and timers without a
// Cloudflare account. Storage is empty and network writes are captured locally.
async function matchFixture() {
  let initialized: Promise<unknown> = Promise.resolve();
  const ctx = {
    blockConcurrencyWhile: (initialize: () => Promise<unknown>) => { initialized = initialize(); },
    getWebSockets: () => [],
    storage: { get: async () => undefined },
  };
  const match = new Match(ctx as unknown as DurableObjectState, {} as never);
  await initialized;
  // These private fields form the persisted running match fixture.
  const running = match as unknown as {
    simulation: { state: { tick: number } };
    lobby: { phase: string; slots: { playerId: string; isAi: boolean; connected: boolean }[] };
    relayTick: number;
    relayIntervalMs: number;
    peerReportedTicks: Map<string, number>;
    recordSyncReport: (playerId: string, tick: number, checksum: number) => void;
    ensureTicking: () => void;
    tick: () => void;
  };
  running.simulation = { state: { tick: 0 } };
  running.lobby.phase = "playing";
  running.lobby.slots = ["host", "guest"].map((playerId) => ({ playerId, isAi: false, connected: true }));
  return running;
}

afterEach(() => vi.useRealTimers());

describe("multiplayer relay pacing", () => {
  it("does not slow healthy peers whose once-per-second reports arrive separately", async () => {
    const match = await matchFixture();
    for (let tick = 20; tick <= 400; tick += 20) {
      match.relayTick = tick + 2; // ordinary delivery latency
      match.recordSyncReport("host", tick, tick);
      expect(match.relayIntervalMs).toBe(50);
      match.relayTick = tick + 5;
      match.recordSyncReport("guest", tick, tick);
      expect(match.relayIntervalMs).toBe(50);
    }
  });

  it("slows for a stalled peer and restores 20 Hz after it catches up", async () => {
    const match = await matchFixture();
    match.relayTick = 80;
    match.recordSyncReport("host", 80, 123);
    expect(match.relayIntervalMs).toBe(100);
    match.recordSyncReport("guest", 40, 123);
    expect(match.relayIntervalMs).toBeCloseTo(1000 / 15);
    match.recordSyncReport("guest", 80, 123);
    expect(match.relayIntervalMs).toBe(50);
  });

  it("retains a steady clock across staggered reports and bounds delayed timer catch-up", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const match = await matchFixture();
    match.ensureTicking();
    for (let sample = 1; sample <= 10; sample += 1) {
      vi.advanceTimersByTime(1_000);
      expect(match.relayTick).toBe(sample * 20);
      match.recordSyncReport("host", sample * 20, sample);
      match.recordSyncReport("guest", sample * 20, sample);
    }
    vi.setSystemTime(Date.now() + 1_000);
    match.tick();
    expect(match.relayTick).toBe(204);
  });
});
