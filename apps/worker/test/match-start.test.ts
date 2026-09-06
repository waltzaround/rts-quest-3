import { afterEach, describe, expect, it, vi } from "vitest";
import { MATCH_START_DELAY_MS, type ClientMessage } from "@space-rts/protocol";
import { Match } from "../src/index";

type RunningMatch = {
  simulation: { state: { tick: number } };
  lobby: { phase: string };
  matchStartsAt: number;
  relayTick: number;
  ensureTicking(): void;
  sendCountdown(socket: WebSocket): void;
  handleCommands(socket: WebSocket, playerId: string, message: Extract<ClientMessage, { type: "commands" }>): void;
  currentMetadata(): unknown;
};

async function fixture(metadata?: unknown): Promise<RunningMatch> {
  let initialized = Promise.resolve();
  const ctx = {
    blockConcurrencyWhile: (fn: () => Promise<void>) => { initialized = fn(); },
    getWebSockets: () => [],
    storage: { get: async (key: string) => key === "match:metadata:v2" ? metadata : undefined },
  };
  const match = new Match(ctx as unknown as DurableObjectState, {} as never);
  await initialized;
  return match as unknown as RunningMatch;
}

afterEach(() => vi.useRealTimers());

describe("shared match start", () => {
  it("holds relay tick zero through loading/countdown and resumes without catching up those seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const match = await fixture();
    match.simulation = { state: { tick: 0 } };
    match.lobby.phase = "playing";
    match.matchStartsAt = Date.now() + MATCH_START_DELAY_MS;
    match.ensureTicking();
    vi.advanceTimersByTime(MATCH_START_DELAY_MS);
    expect(match.relayTick).toBe(0);
    vi.advanceTimersByTime(50);
    expect(match.relayTick).toBe(1);
    vi.advanceTimersByTime(950);
    expect(match.relayTick).toBe(20);
  });

  it("sends peers one deadline and reconnecting peers only the remaining time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const match = await fixture();
    match.matchStartsAt = 15_000;
    const send = vi.fn();
    const socket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
    match.sendCountdown(socket);
    match.sendCountdown(socket);
    expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
    vi.advanceTimersByTime(3_000);
    match.sendCountdown(socket);
    expect(JSON.parse(send.mock.calls[2]![0])).toEqual({ type: "match_countdown", serverTime: 13_000, startsAt: 15_000 });
    vi.advanceTimersByTime(2_000);
    match.sendCountdown(socket);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("rejects early orders before touching the simulation or consuming sequence numbers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const match = await fixture();
    match.simulation = { state: { tick: 0 } };
    match.lobby.phase = "playing";
    match.matchStartsAt = 15_000;
    const send = vi.fn();
    match.handleCommands({ readyState: WebSocket.OPEN, send } as unknown as WebSocket, "host", {
      type: "commands", clientTick: 0, commands: [{
        type: "move", playerId: "host", sequence: 1, requestedTick: 8,
        unitIds: [1], destination: { x: 0, z: 0 }, queued: false,
      }],
    });
    expect(JSON.parse(send.mock.calls[0]![0])).toMatchObject({ type: "error", code: "match_starting" });
    expect(match.relayTick).toBe(0);
  });

  it("preserves the deadline across storage reloads and supports older matches", async () => {
    const match = await fixture();
    match.matchStartsAt = 123_000;
    const metadata = match.currentMetadata();
    expect((await fixture(metadata)).matchStartsAt).toBe(123_000);
    const { matchStartsAt: ignored, ...legacy } = metadata as Record<string, unknown>;
    expect((await fixture(legacy)).matchStartsAt).toBe(0);
  });
});
