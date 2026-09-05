import { expect, it } from "vitest";
import { createPlanarCirclePhysicsWorld, loadPhysicsRuntime } from "@space-rts/box3d-wasm";
import { LockstepInputs, restoreSimulation, type GameCommand, type GameSimulation } from "@space-rts/game-core";
import { LOCKSTEP_PROTOCOL_VERSION, type LobbyState, type ServerMessage } from "@space-rts/protocol";
import { advanceLockstep } from "../../client/src/lockstep-clock";

// Opt in against a local Wrangler server; ordinary unit tests need no sockets.
const authority = process.env.VOIDFRONT_INTEGRATION_AUTHORITY;

it.runIf(Boolean(authority))("keeps two WASM clients synchronized through construction, production and recovery", async () => {
  const runtime = await loadPhysicsRuntime();
  const matchId = `recovery-${Date.now()}`;
  const errors: string[] = [];
  const traces = [new Map<number, number>(), new Map<number, number>()];
  let comparisons = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const peers: Peer[] = [];

  class Peer {
    socket: WebSocket;
    simulation: GameSimulation | null = null;
    inputs: LockstepInputs | null = null;
    world = createPlanarCirclePhysicsWorld(runtime);
    lobby: LobbyState | null = null;
    playerId = "";
    targetTick = 0;
    recoveries = 0;
    interval: ReturnType<typeof setInterval>;

    constructor(readonly index: number, frameMs: number, deliveryDelayMs: number) {
      this.socket = new WebSocket(`${authority}/matches/${matchId}/connect`);
      this.socket.addEventListener("message", ({ data }) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          try { this.receive(JSON.parse(String(data))); }
          catch (error) { errors.push(String(error)); }
        }, deliveryDelayMs);
        timers.add(timer);
      });
      this.socket.addEventListener("error", () => errors.push(`peer ${index} socket failed`));
      this.interval = setInterval(() => {
        if (!this.simulation || !this.inputs) return;
        advanceLockstep(this.simulation.state, this.targetTick, () => {
          this.inputs!.step();
          const { tick, checksum } = this.simulation!.state;
          const previous = traces[this.index]!.get(tick);
          if (previous !== undefined && previous !== checksum) errors.push(`recovery diverged at ${tick}`);
          traces[this.index]!.set(tick, checksum);
          const other = traces[1 - this.index]!.get(tick);
          if (other !== undefined) {
            comparisons += 1;
            if (other !== checksum) errors.push(`peers diverged at ${tick}`);
          }
          if (tick % 20 === 0) this.send({ type: "checksum", tick, checksum });
        });
      }, frameMs);
    }

    send(message: unknown) { this.socket.send(JSON.stringify(message)); }

    receive(message: ServerMessage) {
      if (message.type === "hello_required") {
        this.send({ type: "hello", name: `Recovery verifier ${this.index}`, lockstepVersion: LOCKSTEP_PROTOCOL_VERSION });
      } else if (message.type === "welcome") {
        this.playerId = message.playerId;
        this.lobby = message.lobby;
      } else if (message.type === "lobby") this.lobby = message.lobby;
      else if (message.type === "lockstep_state") {
        if (this.simulation) this.recoveries += 1;
        this.world.dispose();
        this.world = createPlanarCirclePhysicsWorld(runtime);
        this.simulation = restoreSimulation(message.state, this.world);
        this.inputs = new LockstepInputs(this.simulation);
        this.targetTick = message.tick;
      } else if (message.type === "lockstep_commands") {
        if (!this.inputs?.queueCommands(message.commands)) errors.push("late command");
      } else if (message.type === "lockstep_player_state") {
        if (!this.inputs?.queuePlayerState(message)) errors.push("late player transition");
      } else if (message.type === "lockstep_frame") this.targetTick = Math.max(this.targetTick, message.tick);
      else if (message.type === "error") errors.push(`${message.code}: ${message.message}`);
      else if (message.type === "command_results" && message.outcomes.some((outcome) => !outcome.result.accepted)) {
        errors.push(`rejected command: ${JSON.stringify(message.outcomes)}`);
      }
    }

    close() { clearInterval(this.interval); this.socket.close(); this.world.dispose(); }
  }

  async function until(predicate: () => boolean, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      expect(errors).toEqual([]);
      if (Date.now() >= deadline) throw new Error(`Timed out: ${predicate.toString()}`);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    expect(errors).toEqual([]);
  }

  try {
    const host = new Peer(0, 1000 / 60, 0);
    peers.push(host);
    await until(() => Boolean(host.playerId));
    const guest = new Peer(1, 1000 / 15, 140);
    peers.push(guest);
    await until(() => host.lobby?.slots.length === 2 && Boolean(guest.playerId));
    host.send({ type: "set_ready", ready: true });
    guest.send({ type: "set_ready", ready: true });
    await until(() => host.lobby!.slots.every((slot) => slot.ready));
    host.send({ type: "start_match" });
    await until(() => Boolean(host.simulation && guest.simulation));
    await until(() => host.simulation!.state.tick >= 38);
    const live = host.simulation!;
    const core = live.state.structures.find((structure) => structure.ownerPlayerId === host.playerId && structure.type === "commandCore")!;
    const position = Array.from({ length: 32 }, (_, index) => ({
      x: core.x + Math.sin(index * Math.PI / 16) * 180,
      z: core.z + Math.cos(index * Math.PI / 16) * 180,
    })).find((candidate) => live.canPlaceStructure(host.playerId, "shipyard", candidate))!;
    expect(position).toBeDefined();
    const build: GameCommand = {
      type: "buildStructure", playerId: host.playerId, sequence: 1, requestedTick: host.targetTick + 8,
      structureType: "shipyard", position, builderUnitIds: [], queued: false,
    };
    host.send({ type: "commands", clientTick: live.state.tick, clientChecksum: live.state.checksum, commands: [build] });
    const builtYard = () => host.simulation!.state.structures.find((structure) => structure.type === "shipyard"
      && structure.x === position.x && structure.z === position.z);
    await until(() => builtYard()?.buildProgress === 1, 45_000);
    const yardId = builtYard()!.id;
    host.send({ type: "commands", clientTick: live.state.tick, clientChecksum: live.state.checksum, commands: [{
      type: "queueUnit", playerId: host.playerId, sequence: 2, requestedTick: host.targetTick + 8,
      structureId: yardId, shipClass: "fighter", count: 1,
    }] });
    await until(() => Boolean(guest.simulation!.state.ships.find((ship) => ship.ownerPlayerId === host.playerId)), 25_000);
    const shipIds = guest.simulation!.state.ships.filter((ship) => ship.ownerPlayerId === host.playerId).map((ship) => ship.id);
    expect(host.recoveries + guest.recoveries).toBe(0);

    // Exercise exactly the bootstrap-plus-journal path used after a desync.
    const recoveryTarget = host.targetTick;
    guest.send({ type: "request_snapshot", reason: "checksum" });
    await until(() => guest.recoveries === 1 && guest.simulation!.state.tick >= recoveryTarget, 20_000);
    expect(guest.simulation!.state.structures.find((structure) => structure.id === yardId)?.buildProgress).toBe(1);
    expect(guest.simulation!.state.ships.filter((ship) => ship.ownerPlayerId === host.playerId).map((ship) => ship.id)).toEqual(shipIds);
    await until(() => guest.simulation!.state.tick >= recoveryTarget + 40);
    expect(comparisons).toBeGreaterThan(300);
    console.log(JSON.stringify({ comparisons, tick: guest.simulation!.state.tick, recoveredBuildings: 1,
      recoveredShips: shipIds.length, guestFrameRate: 15, guestDeliveryDelayMs: 140, errors }));
  } finally {
    for (const peer of peers) peer.close();
    for (const timer of timers) clearTimeout(timer);
  }
}, 100_000);
