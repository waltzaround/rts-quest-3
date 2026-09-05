import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createPlanarCirclePhysicsWorld, loadPhysicsRuntime } from "@space-rts/box3d-wasm";
import { LockstepInputs, restoreSimulation, type GameSimulation, type GameCommand, type FactionId } from "@space-rts/game-core";
import { LOCKSTEP_PROTOCOL_VERSION, type LobbyState, type ServerMessage } from "@space-rts/protocol";
import { advanceLockstep } from "../../client/src/lockstep-clock";

// Explicit opt-in: join a dedicated lobby hosted by a real browser. This uses
// ordinary production commands, without changing deployment or server fixtures.
const authority = process.env.VOIDFRONT_PRODUCTION_AUTHORITY;
const matchId = process.env.VOIDFRONT_PRODUCTION_MATCH;
const reportPath = process.env.VOIDFRONT_PRODUCTION_REPORT;
type UnscheduledCommand<T = GameCommand> = T extends GameCommand
  ? Omit<T, "sequence" | "playerId" | "requestedTick"> : never;

it.runIf(Boolean(authority && matchId))("checks three simulated peers alongside a production browser", async () => {
  const runtime = await loadPhysicsRuntime();
  const errors: string[] = [];
  const peers: Peer[] = [];
  const traces = Array.from({ length: 3 }, () => new Map<number, number>());
  let comparisons = 0;
  let startedAt = 0;
  let stage = "joining";
  let closing = false;
  const delays = new Set<ReturnType<typeof setTimeout>>();
  const settings = [
    { fps: 60, delayMs: 0, faction: "industrial" },
    { fps: 30, delayMs: 80, faction: "brood" },
    { fps: 15, delayMs: 160, faction: "concord" },
  ] as const;

  function report() {
    const result = { authority, matchId, stage, startedAt: startedAt ? new Date(startedAt).toISOString() : null,
      elapsedSeconds: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0, comparisons, errors,
      peers: peers.map((peer) => ({ ...settings[peer.index], playerId: peer.playerId, tick: peer.simulation?.state.tick,
        targetTick: peer.targetTick, recoveries: peer.recoveries, commands: peer.sequence,
        ships: peer.simulation?.state.ships.filter((ship) => ship.ownerPlayerId === peer.playerId).length,
        structures: peer.simulation?.state.structures.filter((structure) => structure.ownerPlayerId === peer.playerId).length,
        totalShips: peer.simulation?.state.ships.length,
        builtYard: peer.yardId ? peer.simulation?.state.structures.find((structure) => structure.id === peer.yardId)?.buildProgress : null,
      })) };
    if (reportPath) writeFileSync(reportPath, JSON.stringify(result, null, 2));
    return result;
  }

  class Peer {
    socket: WebSocket;
    world = createPlanarCirclePhysicsWorld(runtime);
    simulation: GameSimulation | null = null;
    inputs: LockstepInputs | null = null;
    lobby: LobbyState | null = null;
    playerId = "";
    targetTick = 0;
    recoveries = 0;
    sequence = 0;
    yardId = 0;
    position: { x: number; z: number } | null = null;
    interval: ReturnType<typeof setInterval>;

    constructor(readonly index: number) {
      this.socket = new WebSocket(`${authority}/matches/${matchId}/connect`);
      this.socket.addEventListener("message", ({ data }) => {
        if (closing) return;
        const timer = setTimeout(() => {
          delays.delete(timer);
          try { this.receive(JSON.parse(String(data))); }
          catch (error) { errors.push(String(error)); }
        }, settings[index]!.delayMs);
        delays.add(timer);
      });
      this.socket.addEventListener("error", () => { if (!closing) errors.push(`peer ${index} socket error`); });
      this.interval = setInterval(() => {
        if (!this.simulation || !this.inputs || errors.length) return;
        advanceLockstep(this.simulation.state, this.targetTick, () => {
          this.inputs!.step();
          const { tick, checksum } = this.simulation!.state;
          const prior = traces[index]!.get(tick);
          if (prior !== undefined && prior !== checksum) errors.push(`peer ${index} recovery differs at ${tick}`);
          traces[index]!.set(tick, checksum);
          for (let other = 0; other < traces.length; other += 1) {
            if (other === index) continue;
            const expected = traces[other]!.get(tick);
            if (expected !== undefined) {
              comparisons += 1;
              if (expected !== checksum) errors.push(`peer ${index} vs ${other} mismatch at ${tick}: ${checksum}/${expected}`);
            }
          }
          if (tick % 20 === 0) this.send({ type: "checksum", tick, checksum });
        });
      }, 1000 / settings[index]!.fps);
    }

    send(message: unknown) { if (!closing) this.socket.send(JSON.stringify(message)); }
    command(command: UnscheduledCommand) {
      const state = this.simulation!.state;
      this.send({ type: "commands", clientTick: state.tick, clientChecksum: state.checksum,
        commands: [{ ...command, playerId: this.playerId, sequence: ++this.sequence, requestedTick: this.targetTick + 12 }] });
    }
    receive(message: ServerMessage) {
      if (message.type === "hello_required") {
        if (message.lockstepVersion !== LOCKSTEP_PROTOCOL_VERSION) throw new Error("Production protocol differs from test client");
        this.send({ type: "hello", name: `Production QA ${this.index + 1}`, lockstepVersion: LOCKSTEP_PROTOCOL_VERSION });
      } else if (message.type === "welcome") {
        this.playerId = message.playerId; this.lobby = message.lobby;
        this.send({ type: "set_faction", faction: settings[this.index]!.faction satisfies FactionId });
      } else if (message.type === "lobby") this.lobby = message.lobby;
      else if (message.type === "lockstep_state") {
        if (this.simulation) this.recoveries += 1;
        this.world.dispose(); this.world = createPlanarCirclePhysicsWorld(runtime);
        this.simulation = restoreSimulation(message.state, this.world);
        this.inputs = new LockstepInputs(this.simulation); this.targetTick = message.tick;
      } else if (message.type === "lockstep_commands") {
        if (!this.inputs?.queueCommands(message.commands)) errors.push(`peer ${this.index} late command`);
      } else if (message.type === "lockstep_player_state") {
        if (!this.inputs?.queuePlayerState(message)) errors.push(`peer ${this.index} late transition`);
      } else if (message.type === "lockstep_frame") this.targetTick = Math.max(this.targetTick, message.tick);
      else if (message.type === "error") errors.push(`${this.index}: ${message.code}: ${message.message}`);
      else if (message.type === "command_results" && message.outcomes.some((outcome) => !outcome.result.accepted)) {
        errors.push(`peer ${this.index} rejected command: ${JSON.stringify(message.outcomes)}`);
      }
    }
    close() { clearInterval(this.interval); this.socket.close(1000, "Production verification complete"); this.world.dispose(); }
  }

  async function until(predicate: () => boolean, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      expect(errors).toEqual([]);
      if (Date.now() > deadline) throw new Error(`Timed out at ${stage}: ${predicate.toString()}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(errors).toEqual([]);
  }

  const reporter = setInterval(report, 1_000);
  try {
    for (let index = 0; index < settings.length; index += 1) {
      const peer = new Peer(index); peers.push(peer);
      await until(() => Boolean(peer.playerId));
    }
    await until(() => peers.every((peer) => peer.lobby?.slots.length === 4));
    for (const peer of peers) peer.send({ type: "set_ready", ready: true });
    stage = "waiting for browser host to launch"; report();
    await until(() => peers.every((peer) => Boolean(peer.simulation)), 90_000);
    startedAt = Date.now(); stage = "building";
    await until(() => peers.every((peer) => peer.simulation!.state.tick >= 38));
    for (const peer of peers) {
      const sim = peer.simulation!;
      const core = sim.state.structures.find((structure) => structure.ownerPlayerId === peer.playerId && structure.type === "commandCore")!;
      peer.position = [120, 180, 240].flatMap((radius) => Array.from({ length: 32 }, (_, index) => ({
        x: core.x + Math.sin(index * Math.PI / 16) * radius, z: core.z + Math.cos(index * Math.PI / 16) * radius,
      }))).find((point) => sim.canPlaceStructure(peer.playerId, "shipyard", point))!;
      expect(peer.position).toBeDefined();
      peer.command({ type: "buildStructure", structureType: "shipyard", position: peer.position, builderUnitIds: [], queued: false });
    }
    await until(() => peers.every((peer) => {
      const yard = peer.simulation!.state.structures.find((structure) => structure.ownerPlayerId === peer.playerId
        && structure.type === "shipyard" && structure.x === peer.position!.x && structure.z === peer.position!.z);
      if (yard) peer.yardId = yard.id;
      return yard?.buildProgress === 1;
    }), 60_000);
    stage = "producing";
    for (const peer of peers) peer.command({ type: "queueUnit", structureId: peer.yardId, shipClass: "fighter", count: 3 });
    await until(() => peers.every((peer) => peer.simulation!.state.ships.some((ship) => ship.ownerPlayerId === peer.playerId)), 40_000);
    stage = "combat";
    for (const peer of peers) {
      const unitIds = peer.simulation!.state.ships.filter((ship) => ship.ownerPlayerId === peer.playerId).map((ship) => ship.id);
      peer.command({ type: "attackMove", unitIds, destination: { x: 0, z: 0 }, queued: false });
    }
    await until(() => Date.now() - startedAt >= 100_000, 100_000);
    expect(peers.every((peer) => peer.recoveries === 0)).toBe(true);
    stage = "checking recovery";
    const guest = peers[2]!;
    const recoveryTarget = guest.targetTick;
    guest.send({ type: "request_snapshot", reason: "checksum" });
    await until(() => guest.recoveries === 1 && guest.simulation!.state.tick >= recoveryTarget, 60_000);
    expect(guest.simulation!.state.structures.find((structure) => structure.id === guest.yardId)?.buildProgress).toBe(1);
    stage = "post-recovery";
    await until(() => guest.simulation!.state.tick >= recoveryTarget + 100, 30_000);
    expect(comparisons).toBeGreaterThan(3_000);
    expect(errors).toEqual([]);
    stage = "passed"; report();
  } catch (error) {
    errors.push(String(error)); stage = "failed"; report(); throw error;
  } finally {
    clearInterval(reporter); closing = true;
    for (const peer of peers) peer.close();
    for (const timer of delays) clearTimeout(timer);
  }
}, 300_000);
