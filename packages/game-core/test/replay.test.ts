import { describe, expect, it } from "vitest";
import {
  ReplayPlayer,
  ReplayRecorder,
  createCombatScenario,
  parseReplay,
  playReplay,
  validateReplay,
  type ReplayArchive,
} from "../src";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function recordBattle(): { recorder: ReplayRecorder; replay: ReplayArchive } {
  const simulation = createCombatScenario({ seed: 0x12345678, enemyCommander: false, startingFleet: true });
  const recorder = new ReplayRecorder(simulation, { checkpointIntervalTicks: 20 });
  const blueShips = simulation.state.ships
    .filter((ship) => ship.ownerPlayerId === "pilot-blue")
    .slice(0, 3)
    .map((ship) => ship.id);

  expect(recorder.submitCommand({
    type: "move",
    playerId: "pilot-blue",
    sequence: 1,
    requestedTick: 1,
    unitIds: [blueShips[0]!, blueShips[0]!, ...blueShips.slice(1)],
    queued: false,
    destination: { x: -240, z: 80 },
  }).accepted).toBe(true);
  recorder.stepMany(35);
  expect(recorder.setPlayerState("pilot-red", "disconnected")).toBe(true);
  expect(recorder.submitCommand({
    type: "attackMove",
    playerId: "pilot-blue",
    sequence: 2,
    requestedTick: simulation.state.tick + 1,
    unitIds: blueShips,
    queued: true,
    destination: { x: 210, z: 140 },
  }).accepted).toBe(true);
  recorder.stepMany(45);
  expect(recorder.setPlayerState("pilot-red", "playing")).toBe(true);
  recorder.stepMany(30);
  return { recorder, replay: recorder.finalize() };
}

describe("deterministic replay capture and playback", () => {
  it("reconstructs the exact final state from canonical commands and authority transitions", () => {
    const { recorder, replay } = recordBattle();
    expect(replay.format).toBe("space-rts-replay");
    expect(replay.version).toBe(1);
    expect(replay.simulationVersion).toBe(11);
    expect(replay.finalized).toBe(true);
    expect(replay.actions.map((action) => action.order)).toEqual([1, 2, 3, 4]);
    expect(replay.actions[0]).toMatchObject({
      type: "command",
      acceptedAtTick: 0,
      command: { unitIds: expect.arrayContaining([]) },
    });
    if (replay.actions[0]?.type !== "command") throw new Error("Expected command action");
    if (!("unitIds" in replay.actions[0].command)) throw new Error("Expected fleet command");
    expect(new Set(replay.actions[0].command.unitIds).size).toBe(replay.actions[0].command.unitIds.length);
    expect(replay.actions.filter((action) => action.type === "playerState")).toHaveLength(2);
    expect(replay.checkpoints.length).toBeGreaterThan(5);
    expect(validateReplay(replay).valid).toBe(true);

    const playback = playReplay(replay);
    expect(playback.ok).toBe(true);
    if (!playback.ok) return;
    expect(playback.result).toEqual(replay.result);
    expect(playback.simulation.snapshot()).toEqual(recorder.simulation.snapshot());
  });

  it("supports deterministic stepping and seeking in both directions", () => {
    const { replay } = recordBattle();
    const player = new ReplayPlayer(replay);
    expect(player.currentTick).toBe(player.startTick);
    const firstStep = player.step();
    expect(firstStep).toMatchObject({ ok: true, tick: player.startTick + 1 });
    const middleTick = Math.floor((player.startTick + player.endTick) / 2);
    expect(player.seek(middleTick)).toMatchObject({ ok: true, tick: middleTick });
    const middleChecksum = player.simulation.state.checksum;
    expect(player.seek(player.startTick)).toMatchObject({ ok: true, tick: player.startTick });
    expect(player.seek(middleTick)).toMatchObject({ ok: true, tick: middleTick });
    expect(player.simulation.state.checksum).toBe(middleChecksum);
    expect(player.seek(player.endTick)).toMatchObject({ ok: true, done: true, tick: player.endTick });
    expect(player.playToEnd()).toMatchObject({ ok: true, result: replay.result });
    expect(player.seek(player.endTick + 1)).toMatchObject({ ok: false, reason: "invalidReplay" });
  });

  it("archives and resumes an in-progress recorder across an authority restart", () => {
    const simulation = createCombatScenario({ enemyCommander: false, startingFleet: true });
    const recorder = new ReplayRecorder(simulation, { checkpointIntervalTicks: 10 });
    const ship = simulation.state.ships.find((candidate) => candidate.ownerPlayerId === "pilot-blue")!;
    recorder.submitCommand({
      type: "hold", playerId: "pilot-blue", sequence: 1,
      requestedTick: 1, unitIds: [ship.id], queued: false,
    });
    recorder.stepMany(25);
    const archive = recorder.archive();
    expect(archive.finalized).toBe(false);

    const resumedSimulation = recorder.simulation;
    const resumed = ReplayRecorder.resume(resumedSimulation, archive, { checkpointIntervalTicks: 10 });
    resumed.setPlayerState("pilot-red", "disconnected");
    resumed.stepMany(25);
    const replay = resumed.finalize();
    expect(replay.actions.map((action) => action.order)).toEqual([1, 2]);
    expect(playReplay(replay)).toMatchObject({ ok: true, result: replay.result });
    expect(() => ReplayRecorder.resume(resumedSimulation, replay)).toThrow("finalized");

    const wrongSimulation = createCombatScenario({ enemyCommander: false, startingFleet: true });
    expect(() => ReplayRecorder.resume(wrongSimulation, archive)).toThrow("different simulation state");
  });

  it("records authority mutations applied outside the recorder wrapper", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    const recorder = new ReplayRecorder(simulation);
    const player = simulation.state.players.find((candidate) => candidate.id === "pilot-red")!;
    player.state = "disconnected";
    recorder.recordPlayerStateTransition(player.id, player.state);
    recorder.step();
    const replay = recorder.finalize();
    const playback = playReplay(replay);
    expect(playback.ok).toBe(true);
    if (playback.ok) {
      expect(playback.simulation.state.players.find((candidate) => candidate.id === player.id)?.state)
        .toBe("disconnected");
    }
  });

  it("round-trips JSON and rejects unsupported replay versions", () => {
    const { replay } = recordBattle();
    expect(parseReplay(JSON.stringify(replay))).toEqual({ valid: true, replay });
    const future = { ...replay, version: 2 };
    expect(validateReplay(future)).toEqual({ valid: false, reason: "Unsupported replay format or version" });
    expect(parseReplay("not json")).toEqual({ valid: false, reason: "Replay is not valid JSON" });
  });
});

describe("replay tamper detection", () => {
  it("detects a modified initial snapshot", () => {
    const { replay } = recordBattle();
    const tampered = clone(replay);
    tampered.initialState.ships[0]!.health -= 1;
    expect(playReplay(tampered)).toMatchObject({ ok: false, reason: "initialChecksumMismatch" });
  });

  it("detects modified command payloads at a deterministic checkpoint", () => {
    const { replay } = recordBattle();
    const tampered = clone(replay);
    const command = tampered.actions.find((action) => action.type === "command");
    if (!command || (command.command.type !== "move" && command.command.type !== "attackMove")) {
      throw new Error("Expected navigation command");
    }
    command.command.destination = {
      ...command.command.destination,
      x: command.command.destination.x + 200,
    };
    expect(playReplay(tampered)).toMatchObject({ ok: false, reason: "checkpointMismatch" });
  });

  it("detects modified authority transitions and checkpoint checksums", () => {
    const { replay } = recordBattle();
    const authorityTamper = clone(replay);
    const transition = authorityTamper.actions.find((action) => action.type === "playerState");
    if (!transition || transition.type !== "playerState") throw new Error("Expected state transition");
    transition.state = "playing";
    expect(playReplay(authorityTamper)).toMatchObject({ ok: false, reason: "checkpointMismatch" });

    const checkpointTamper = clone(replay);
    checkpointTamper.checkpoints[1]!.checksum = (checkpointTamper.checkpoints[1]!.checksum ^ 1) >>> 0;
    expect(playReplay(checkpointTamper)).toMatchObject({ ok: false, reason: "checkpointMismatch" });
  });

  it("verifies the final manifest when stepping or seeking directly to the end", () => {
    const { replay } = recordBattle();
    const tampered = clone(replay);
    tampered.result.checksum = (tampered.result.checksum ^ 1) >>> 0;
    const player = new ReplayPlayer(tampered);
    expect(player.seek(player.endTick)).toMatchObject({ ok: false, reason: "finalMismatch" });
    expect(playReplay(tampered)).toMatchObject({ ok: false, reason: "finalMismatch" });
  });

  it("requires the recorded physics backend during playback", () => {
    const { replay } = recordBattle();
    const tampered = clone(replay);
    tampered.physicsBackend = "box3d-wasm";
    expect(playReplay(tampered)).toMatchObject({
      ok: false,
      reason: "invalidReplay",
      message: expect.stringContaining("box3d-wasm"),
    });
  });

  it("rejects reordered actions and unreachable checkpoints before playback", () => {
    const { replay } = recordBattle();
    const reordered = clone(replay);
    reordered.actions[1]!.order = 99;
    expect(validateReplay(reordered)).toEqual({ valid: false, reason: "Replay action ordering is inconsistent" });

    const unreachable = clone(replay);
    unreachable.checkpoints[0]!.afterActionOrder = unreachable.actions.length;
    expect(validateReplay(unreachable)).toEqual({ valid: false, reason: "Replay checkpoint ordering is inconsistent" });
  });
});
