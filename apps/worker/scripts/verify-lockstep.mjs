const authority = process.env.VOIDFRONT_AUTHORITY ?? "ws://127.0.0.1:8787";
import { LOCKSTEP_PROTOCOL_VERSION as lockstepVersion } from "../../../packages/protocol/dist/index.js";
const base = new URL(authority);
const basePath = base.pathname.replace(/\/+$/, "");
const matchId = `lockstep-${Date.now()}`;

function endpoint(path, protocol = base.protocol) {
  const url = new URL(base);
  url.protocol = protocol;
  url.pathname = `${basePath}${path}`;
  return url;
}

class Peer {
  constructor(name, credentials) {
    this.name = name;
    this.credentials = credentials;
    this.queue = [];
    this.waiters = [];
    this.routineBytes = 0;
  }

  async connect() {
    this.socket = new WebSocket(endpoint(`/matches/${matchId}/connect`));
    this.socket.addEventListener("message", (event) => {
      const raw = String(event.data);
      const message = JSON.parse(raw);
      if (message.type === "lockstep_frame" || message.type === "lockstep_commands") this.routineBytes += raw.length;
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else this.queue.push(message);
    });
    const hello = await this.waitFor((message) => message.type === "hello_required");
    if (hello.lockstepVersion !== lockstepVersion) throw new Error("Authority advertised incompatible lockstep rules");
    this.send({ type: "hello", name: this.name, lockstepVersion, ...(this.credentials ?? {}) });
    const welcome = await this.waitFor((message) => message.type === "welcome");
    this.credentials = { playerId: welcome.playerId, reconnectToken: welcome.reconnectToken };
    return welcome;
  }

  send(message) { this.socket.send(JSON.stringify(message)); }

  waitFor(predicate, timeoutMs = 10_000) {
    const queued = this.queue.findIndex(predicate);
    if (queued >= 0) return Promise.resolve(this.queue.splice(queued, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: undefined };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for ${this.name}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  close() { this.socket?.close(1000, "Lockstep verification complete"); }
}

function assertLockstepState(message, label) {
  const state = message.state;
  if (message.type !== "lockstep_state" || state?.version !== 12 || state.tick !== message.tick
    || state.checksum !== message.checksum || !Number.isInteger(state.seed)
    || !Array.isArray(state.commandQueue) || !Array.isArray(state.visibility)) {
    throw new Error(`${label} was not a complete deterministic bootstrap state`);
  }
}

const host = new Peer("Lockstep Host");
const wing = new Peer("Lockstep Wing");
let rejoined;
try {
  const healthProtocol = base.protocol === "wss:" ? "https:" : "http:";
  const health = await (await fetch(endpoint("/health", healthProtocol))).json();
  if (!health.ok || health.simulationHz !== 20) throw new Error("Authority health check failed");

  const hostWelcome = await host.connect();
  const wingWelcome = await wing.connect();
  await host.waitFor((message) => message.type === "lobby" && message.lobby.slots.length === 2);
  host.send({ type: "set_faction", faction: "brood" });
  wing.send({ type: "set_faction", faction: "concord" });
  await host.waitFor((message) => message.type === "lobby"
    && message.lobby.slots.find((slot) => slot.playerId === hostWelcome.playerId)?.faction === "brood"
    && message.lobby.slots.find((slot) => slot.playerId === wingWelcome.playerId)?.faction === "concord");
  wing.send({ type: "set_faction", faction: "industrial", playerId: hostWelcome.playerId });
  await wing.waitFor((message) => message.type === "error" && message.code === "faction_owner");
  host.send({ type: "set_ready", ready: true });
  await host.waitFor((message) => message.type === "lobby"
    && message.lobby.slots.find((slot) => slot.playerId === hostWelcome.playerId)?.ready);
  wing.send({ type: "set_faction", faction: "industrial" });
  await host.waitFor((message) => message.type === "lobby"
    && message.lobby.slots.every((slot) => !slot.ready)
    && message.lobby.slots.find((slot) => slot.playerId === wingWelcome.playerId)?.faction === "industrial");
  wing.send({ type: "set_faction", faction: "concord" });
  await host.waitFor((message) => message.type === "lobby"
    && message.lobby.slots.find((slot) => slot.playerId === wingWelcome.playerId)?.faction === "concord");
  host.send({ type: "start_match" });
  await host.waitFor((message) => message.type === "error" && message.code === "players_not_ready");
  wing.send({ type: "start_match" });
  await wing.waitFor((message) => message.type === "error" && message.code === "host_only");
  wing.send({ type: "set_ready", ready: true });
  await host.waitFor((message) => message.type === "lobby"
    && message.lobby.slots.find((slot) => slot.playerId === wingWelcome.playerId)?.ready
    && message.lobby.slots.find((slot) => slot.playerId === hostWelcome.playerId)?.ready === false);
  host.send({ type: "start_match" });

  const hostStart = await host.waitFor((message) => message.type === "lockstep_state" && message.reason === "start");
  const wingStart = await wing.waitFor((message) => message.type === "lockstep_state" && message.reason === "start");
  assertLockstepState(hostStart, "Host start");
  assertLockstepState(wingStart, "Wing start");
  if (hostStart.state.players.find((player) => player.id === hostWelcome.playerId)?.faction !== "brood"
    || hostStart.state.players.find((player) => player.id === wingWelcome.playerId)?.faction !== "concord"
    || !hostStart.state.territories.some((field) => field.kind === "creep")
    || !hostStart.state.territories.some((field) => field.kind === "pylon")) {
    throw new Error("Selected factions or initial territory missing from bootstrap");
  }
  host.send({ type: "set_faction", faction: "industrial" });
  await host.waitFor((message) => message.type === "error" && message.code === "lobby_locked");
  if (JSON.stringify(hostStart.state) !== JSON.stringify(wingStart.state)) {
    throw new Error("Peers did not receive the same bootstrap state");
  }

  const hostCountdown = await host.waitFor((message) => message.type === "match_countdown");
  const wingCountdown = await wing.waitFor((message) => message.type === "match_countdown");
  if (hostCountdown.startsAt !== wingCountdown.startsAt
    || hostCountdown.startsAt - hostCountdown.serverTime > 5_000) {
    throw new Error("Peers did not receive the same bounded start deadline");
  }
  host.send({ type: "commands", clientTick: 0, commands: [{
    type: "move", playerId: hostWelcome.playerId, sequence: 1, requestedTick: 8,
    unitIds: [1], destination: { x: 0, z: 0 }, queued: false,
  }] });
  await host.waitFor((message) => message.type === "error" && message.code === "match_starting");
  const firstFrame = await host.waitFor((message) => message.type === "lockstep_frame" && message.tick > 0);
  await wing.waitFor((message) => message.type === "lockstep_frame" && message.tick > 0);

  const core = hostStart.state.structures.find(
    (structure) => structure.ownerPlayerId === hostWelcome.playerId && structure.type === "commandCore",
  );
  if (!core) throw new Error("Host Command Core missing");
  const radial = Math.hypot(core.x, core.z) || 1;
  const position = { x: core.x - core.x / radial * 180, z: core.z - core.z / radial * 180 };
  host.send({
    type: "commands", clientTick: firstFrame.tick, clientChecksum: hostStart.checksum,
    commands: [{
      type: "buildStructure", playerId: "spoofed", sequence: 1, requestedTick: firstFrame.tick + 8,
      structureType: "storage", position, queued: false,
    }],
  });
  const result = await host.waitFor((message) => message.type === "command_results" && message.outcomes[0]?.sequence === 1);
  if (!result.outcomes[0].result.accepted) throw new Error("Authority rejected valid lockstep command");
  const hostCommands = await host.waitFor((message) => message.type === "lockstep_commands");
  const wingCommands = await wing.waitFor((message) => message.type === "lockstep_commands");
  if (JSON.stringify(hostCommands) !== JSON.stringify(wingCommands)
    || hostCommands.commands[0].playerId !== hostWelcome.playerId) {
    throw new Error("Accepted command stream differed between peers or retained a spoofed player ID");
  }

  const verifiedFrame = await host.waitFor(
    (message) => message.type === "lockstep_frame" && message.tick >= result.tick + 40,
  );
  const wingFrame = await wing.waitFor(
    (message) => message.type === "lockstep_frame" && message.tick === verifiedFrame.tick,
  );
  if (verifiedFrame.checksum !== wingFrame.checksum) throw new Error("Frame checksums differed between peers");
  if (verifiedFrame.checksum !== 0) throw new Error("Relay frame unexpectedly carried an authoritative checksum");

  const syncTick = verifiedFrame.tick - verifiedFrame.tick % 20;
  host.send({ type: "checksum", tick: syncTick, checksum: 0x11111111 });
  wing.send({ type: "checksum", tick: syncTick, checksum: 0x22222222 });
  const hostDesync = await host.waitFor((message) => message.type === "error" && message.code === "lockstep_desync");
  const wingDesync = await wing.waitFor((message) => message.type === "error" && message.code === "lockstep_desync");
  if (!hostDesync.message.includes(String(syncTick)) || !wingDesync.message.includes(String(syncTick))) {
    throw new Error("Lockstep mismatch did not identify the divergent tick");
  }
  const hostAutoRecovery = await host.waitFor(
    (message) => message.type === "lockstep_state" && message.reason === "checksum",
  );
  const wingAutoRecovery = await wing.waitFor(
    (message) => message.type === "lockstep_state" && message.reason === "checksum",
  );
  assertLockstepState(hostAutoRecovery, "Host automatic recovery");
  assertLockstepState(wingAutoRecovery, "Wing automatic recovery");
  if (JSON.stringify(hostAutoRecovery.state) !== JSON.stringify(wingAutoRecovery.state)) {
    throw new Error("Peers did not receive the same automatic recovery bootstrap");
  }
  await host.waitFor((message) => message.type === "lockstep_commands");
  await wing.waitFor((message) => message.type === "lockstep_commands");
  await host.waitFor((message) => message.type === "lockstep_frame" && message.tick >= verifiedFrame.tick);
  await wing.waitFor((message) => message.type === "lockstep_frame" && message.tick >= verifiedFrame.tick);

  host.send({ type: "request_snapshot", reason: "manual" });
  const recovery = await host.waitFor((message) => message.type === "lockstep_state" && message.reason === "manual");
  assertLockstepState(recovery, "Recovery state");
  if (JSON.stringify(recovery.state) !== JSON.stringify(hostStart.state)) {
    throw new Error("Relay recovery did not retain the immutable bootstrap");
  }
  const recoveryCommands = await host.waitFor((message) => message.type === "lockstep_commands");
  if (JSON.stringify(recoveryCommands.commands) !== JSON.stringify(hostCommands.commands)) {
    throw new Error("Relay recovery omitted the ordered command journal");
  }
  await host.waitFor((message) => message.type === "lockstep_frame" && message.tick >= verifiedFrame.tick);

  const reconnectCredentials = wing.credentials;
  wing.close();
  const disconnected = await host.waitFor(
    (message) => message.type === "lockstep_player_state" && message.playerId === wingWelcome.playerId,
  );
  if (disconnected.state !== "disconnected") throw new Error("Disconnect did not use the lightweight state transition");
  rejoined = new Peer("Lockstep Wing", reconnectCredentials);
  const reconnectWelcome = await rejoined.connect();
  const resumed = await host.waitFor(
    (message) => message.type === "lockstep_player_state" && message.playerId === wingWelcome.playerId,
  );
  const reconnectState = await rejoined.waitFor(
    (message) => message.type === "lockstep_state" && message.reason === "reconnect",
  );
  assertLockstepState(reconnectState, "Reconnect state");
  const reconnectCommands = await rejoined.waitFor((message) => message.type === "lockstep_commands");
  if (resumed.state !== "playing" || reconnectWelcome.playerId !== wingWelcome.playerId
    || JSON.stringify(reconnectCommands.commands) !== JSON.stringify(hostCommands.commands)) {
    throw new Error("Reconnect did not restore the original player at the current tick");
  }

  console.log(JSON.stringify({
    ok: true,
    matchId,
    simulationHz: health.simulationHz,
    bootstrapBytes: JSON.stringify(hostStart).length,
    routineBytesThroughTick: host.routineBytes,
    verifiedTick: verifiedFrame.tick,
    checksum: verifiedFrame.checksum,
    commandBroadcast: "passed",
    hostLaunchWithoutReady: "passed",
    guestReadinessAndHostOnlyLaunch: "passed",
    factionSelectionAndOwnership: "passed",
    factionReadyResetAndMatchLock: "passed",
    automaticDesyncRecovery: "passed",
    recovery: "bootstrap-plus-command-journal passed",
    reconnect: "passed",
  }));
} finally {
  host.close();
  wing.close();
  rejoined?.close();
}
process.exit(0);
