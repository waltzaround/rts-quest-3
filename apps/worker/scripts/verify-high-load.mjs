const authority = process.env.VOIDFRONT_AUTHORITY ?? "ws://127.0.0.1:8788";
const lockstepVersion = 6;
const unitsPerPlayer = Number(process.env.VOIDFRONT_SOAK_UNITS ?? 400);
const playerCount = Number(process.env.VOIDFRONT_SOAK_PLAYERS ?? 2);
const durationMs = Number(process.env.VOIDFRONT_SOAK_DURATION_MS ?? 180_000);
const exerciseRecovery = process.env.VOIDFRONT_SOAK_RECOVERY !== "0";
if (!Number.isInteger(playerCount) || playerCount < 2 || playerCount > 8 || playerCount % 2 !== 0) {
  throw new Error("VOIDFRONT_SOAK_PLAYERS must be an even number from 2 through 8");
}
const base = new URL(authority);
const basePath = base.pathname.replace(/\/+$/, "");
const matchId = "soak-" + playerCount + "p-" + unitsPerPlayer + "u-" + Date.now();

function endpoint(path, protocol = base.protocol) {
  const url = new URL(base);
  url.protocol = protocol;
  url.pathname = basePath + path;
  return url;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const frameChecksums = Array.from({ length: playerCount }, () => new Map());
let crossPeerFrameComparisons = 0;
let checksumMismatches = 0;

function compareChecksum(left, right) {
  crossPeerFrameComparisons += 1;
  if (left !== right) checksumMismatches += 1;
}

function recordFrame(peerIndex, message) {
  const own = frameChecksums[peerIndex];
  own.set(message.tick, message.checksum);
  if (peerIndex === 0) {
    for (let index = 1; index < frameChecksums.length; index += 1) {
      const candidate = frameChecksums[index];
      if (candidate.has(message.tick)) compareChecksum(message.checksum, candidate.get(message.tick));
    }
  } else if (frameChecksums[0].has(message.tick)) {
    compareChecksum(message.checksum, frameChecksums[0].get(message.tick));
  }
  while (own.size > 5_000) own.delete(own.keys().next().value);
}

class Peer {
  constructor(name, peerIndex, credentials) {
    this.name = name;
    this.peerIndex = peerIndex;
    this.credentials = credentials;
    this.queue = [];
    this.waiters = [];
    this.frameCount = 0;
    this.frameGaps = 0;
    this.duplicateFrames = 0;
    this.lastFrameTick = null;
    this.lastFrameChecksum = null;
    this.bytesReceived = 0;
    this.bytesSent = 0;
    this.lastMessageAt = Date.now();
    this.maxMessageSilenceMs = 0;
    this.unexpectedClose = null;
    this.expectedClose = false;
  }

  async connect() {
    this.socket = new WebSocket(endpoint("/matches/" + matchId + "/connect"));
    this.socket.addEventListener("message", (event) => this.receive(String(event.data)));
    this.socket.addEventListener("close", (event) => {
      if (!this.expectedClose) this.unexpectedClose = { code: event.code, reason: event.reason };
    });
    this.socket.addEventListener("error", () => {
      if (!this.expectedClose) this.unexpectedClose = { code: -1, reason: "websocket error" };
    });
    await this.waitFor((message) => message.type === "hello_required", 60_000);
    this.send({ type: "hello", name: this.name, lockstepVersion, ...(this.credentials ?? {}) });
    const welcome = await this.waitFor((message) => message.type === "welcome", 60_000);
    this.credentials = { playerId: welcome.playerId, reconnectToken: welcome.reconnectToken };
    return welcome;
  }

  receive(raw) {
    const now = Date.now();
    this.maxMessageSilenceMs = Math.max(this.maxMessageSilenceMs, now - this.lastMessageAt);
    this.lastMessageAt = now;
    this.bytesReceived += Buffer.byteLength(raw);
    const message = JSON.parse(raw);
    if (message.type === "lockstep_frame") {
      if (this.lastFrameTick !== null) {
        if (message.tick > this.lastFrameTick + 1) this.frameGaps += message.tick - this.lastFrameTick - 1;
        else if (message.tick <= this.lastFrameTick) this.duplicateFrames += 1;
      }
      this.lastFrameTick = message.tick;
      this.lastFrameChecksum = message.checksum;
      this.frameCount += 1;
      recordFrame(this.peerIndex, message);
    }
    const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const waiter = this.waiters.splice(waiterIndex, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    if (!["lockstep_frame", "checksum", "view"].includes(message.type)) this.queue.push(message);
  }

  send(message) {
    const raw = JSON.stringify(message);
    this.bytesSent += Buffer.byteLength(raw);
    this.socket.send(raw);
  }

  waitFor(predicate, timeoutMs = 30_000) {
    const queuedIndex = this.queue.findIndex(predicate);
    if (queuedIndex >= 0) return Promise.resolve(this.queue.splice(queuedIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: undefined };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("Timed out waiting for " + this.name));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async ping() {
    const clientTime = Date.now();
    this.send({ type: "ping", clientTime });
    await this.waitFor((message) => message.type === "pong" && message.clientTime === clientTime, 60_000);
    return Date.now() - clientTime;
  }

  close(reason = "High-load soak complete") {
    this.expectedClose = true;
    this.socket?.close(1000, reason);
  }
}

function assertBootstrap(message, label, playerIds) {
  if (message.type !== "lockstep_state" || message.reason !== "start") {
    throw new Error(label + " did not receive a start state");
  }
  if (message.state.tick !== message.tick || message.state.checksum !== message.checksum) {
    throw new Error(label + " bootstrap metadata was inconsistent");
  }
  if (message.state.ships.length !== unitsPerPlayer * playerCount) {
    throw new Error(label + " received " + message.state.ships.length + " ships instead of " + (unitsPerPlayer * playerCount));
  }
  for (const playerId of playerIds) {
    const owned = message.state.ships.filter((ship) => ship.ownerPlayerId === playerId).length;
    if (owned !== unitsPerPlayer) throw new Error(label + " received " + owned + " ships for " + playerId);
  }
  const teamSizes = new Map();
  for (const player of message.state.players) teamSizes.set(player.teamId, (teamSizes.get(player.teamId) ?? 0) + 1);
  if (teamSizes.size !== 2 || [...teamSizes.values()].some((size) => size !== playerCount / 2)) {
    throw new Error(label + " did not receive a balanced " + (playerCount / 2) + "v" + (playerCount / 2) + " team layout");
  }
}

function attackCommands(playerId, tick, unitIds) {
  const commands = [];
  for (let offset = 0; offset < unitIds.length; offset += 500) {
    commands.push({
      type: "attackMove",
      playerId,
      sequence: commands.length + 1,
      requestedTick: tick + 30,
      unitIds: unitIds.slice(offset, offset + 500),
      queued: false,
      destination: { x: 0, z: 0 },
    });
  }
  return commands;
}

const peers = Array.from({ length: playerCount }, (_, index) => new Peer("Soak Player " + (index + 1), index));
const retiredPeers = [];
const pingSamples = [];
let manualSnapshots = 0;
let reconnects = 0;
let peakProjectiles = 0;
let minimumSurvivingShips = unitsPerPlayer * playerCount;
let finalState = null;

try {
  const healthProtocol = base.protocol === "wss:" ? "https:" : "http:";
  const health = await (await fetch(endpoint("/health", healthProtocol))).json();
  if (!health.ok || health.simulationHz !== 20) throw new Error("Authority health check failed");

  const welcomes = [await peers[0].connect()];
  let lobbyMessage = await peers[0].waitFor(
    (message) => message.type === "lobby" && message.lobby.slots.length === 1,
    60_000,
  );
  if (playerCount > 6 && lobbyMessage.lobby.settings.mapSize !== "colossal") {
    peers[0].send({
      type: "set_settings",
      settings: { ...lobbyMessage.lobby.settings, mapSize: "colossal" },
    });
    lobbyMessage = await peers[0].waitFor(
      (message) => message.type === "lobby" && message.lobby.settings.mapSize === "colossal",
      60_000,
    );
  }
  for (let index = 1; index < peers.length; index += 1) welcomes.push(await peers[index].connect());
  lobbyMessage = await peers[0].waitFor(
    (message) => message.type === "lobby" && message.lobby.slots.length === playerCount,
    60_000,
  );
  for (const peer of peers) peer.send({ type: "set_ready", ready: true });
  await peers[0].waitFor(
    (message) => message.type === "lobby" && message.lobby.slots.every((slot) => slot.ready),
    60_000,
  );

  const startPromises = peers.map((peer) => peer.waitFor(
    (message) => message.type === "lockstep_state" && message.reason === "start",
    240_000,
  ));
  peers[0].send({ type: "start_match" });
  const startStates = await Promise.all(startPromises);
  const playerIds = welcomes.map((welcome) => welcome.playerId);
  for (let index = 0; index < startStates.length; index += 1) {
    assertBootstrap(startStates[index], peers[index].name, playerIds);
    if (startStates[index].checksum !== startStates[0].checksum) throw new Error("Bootstrap checksums differed");
  }

  await Promise.all(peers.map((peer) => peer.waitFor((message) => message.type === "lockstep_frame", 120_000)));

  const resultPromises = [];
  for (let index = 0; index < peers.length; index += 1) {
    const peer = peers[index];
    const state = startStates[index];
    const unitIds = state.state.ships
      .filter((ship) => ship.ownerPlayerId === welcomes[index].playerId)
      .map((ship) => ship.id);
    const commandTick = peer.lastFrameTick;
    const commands = attackCommands(welcomes[index].playerId, commandTick, unitIds);
    peer.send({
      type: "commands",
      clientTick: commandTick,
      clientChecksum: peer.lastFrameChecksum,
      commands,
    });
    resultPromises.push(peer.waitFor(
      (message) => message.type === "command_results" && message.outcomes.length === commands.length,
      120_000,
    ));
  }
  const results = await Promise.all(resultPromises);
  const rejectedOutcomes = results.flatMap((result, peerIndex) => result.outcomes
    .filter((outcome) => !outcome.result.accepted)
    .map((outcome) => ({ peer: peerIndex + 1, sequence: outcome.sequence, result: outcome.result })));
  if (rejectedOutcomes.length > 0) {
    throw new Error("Authority rejected high-load attack commands: " + JSON.stringify(rejectedOutcomes));
  }

  const routineReceivedBaseline = peers.reduce((sum, peer) => sum + peer.bytesReceived, 0);
  const routineSentBaseline = peers.reduce((sum, peer) => sum + peer.bytesSent, 0);
  const startedAt = Date.now();
  for (const peer of peers) {
    peer.maxMessageSilenceMs = 0;
    peer.lastMessageAt = startedAt;
  }
  // Bootstrap transfer can be enormous in the synthetic 16k-unit fixture and
  // the relay is already advancing while peers parse it. Measure sustained
  // cadence from the frame actually observed when the timed soak begins.
  const startTick = Math.max(...peers.map((peer) => peer.lastFrameTick ?? startStates[0].tick));
  let nextSnapshotAt = exerciseRecovery ? 30_000 : Number.POSITIVE_INFINITY;
  let reconnectComplete = false;
  let nextProgressAt = 30_000;
  while (Date.now() - startedAt < durationMs) {
    await delay(5_000);
    const elapsed = Date.now() - startedAt;
    const activePeers = [...peers];
    pingSamples.push(...await Promise.all(activePeers.map((peer) => peer.ping())));
    if (checksumMismatches > 0) throw new Error("Peer frame checksums diverged");
    if (activePeers.some((peer) => peer.unexpectedClose)) throw new Error("A peer disconnected unexpectedly");

    if (elapsed >= nextSnapshotAt) {
      peers[0].send({ type: "request_snapshot", reason: "manual" });
      const snapshot = await peers[0].waitFor(
        (message) => message.type === "lockstep_state" && message.reason === "manual",
        120_000,
      );
      manualSnapshots += 1;
      finalState = snapshot.state;
      peakProjectiles = Math.max(peakProjectiles, snapshot.state.projectiles.length);
      minimumSurvivingShips = Math.min(minimumSurvivingShips, snapshot.state.ships.length);
      if (snapshot.state.status !== "playing") throw new Error("Battle ended before the soak duration completed");
      nextSnapshotAt += 30_000;
    }

    if (exerciseRecovery && !reconnectComplete && elapsed >= durationMs / 2) {
      const reconnectIndex = peers.length - 1;
      const departing = peers[reconnectIndex];
      const credentials = departing.credentials;
      retiredPeers.push(departing);
      departing.close("Intentional soak reconnect");
      await delay(250);
      frameChecksums[reconnectIndex].clear();
      const replacement = new Peer(departing.name, reconnectIndex, credentials);
      peers[reconnectIndex] = replacement;
      const reconnectWelcome = await replacement.connect();
      const reconnectState = await replacement.waitFor(
        (message) => message.type === "lockstep_state" && message.reason === "reconnect",
        180_000,
      );
      if (reconnectWelcome.playerId !== welcomes[reconnectIndex].playerId || reconnectState.state.status !== "playing") {
        throw new Error("High-load reconnect did not restore the original active player");
      }
      reconnects += 1;
      reconnectComplete = true;
    }

    if (elapsed >= nextProgressAt) {
      const currentTick = Math.max(...peers.map((peer) => peer.lastFrameTick ?? startTick));
      const gaps = peers.reduce((count, peer) => count + peer.frameGaps, 0);
      console.log("SOAK progress=" + Math.round(elapsed / 1000) + "s tick=" + currentTick
        + " comparisons=" + crossPeerFrameComparisons + " gaps=" + gaps
        + " maxRtt=" + Math.max(...pingSamples) + "ms");
      nextProgressAt += 30_000;
    }
  }

  if (exerciseRecovery) {
    peers[0].send({ type: "request_snapshot", reason: "manual" });
    const endingSnapshot = await peers[0].waitFor(
      (message) => message.type === "lockstep_state" && message.reason === "manual",
      180_000,
    );
    finalState = endingSnapshot.state;
  } else {
    finalState = startStates[0].state;
  }
  peakProjectiles = Math.max(peakProjectiles, finalState.projectiles.length);
  minimumSurvivingShips = Math.min(minimumSurvivingShips, finalState.ships.length);
  const allPeers = [...peers, ...retiredPeers];
  const totalFrameGaps = allPeers.reduce((count, peer) => count + peer.frameGaps, 0);
  const totalDuplicateFrames = allPeers.reduce((count, peer) => count + peer.duplicateFrames, 0);
  // A manual bootstrap recovery deliberately re-anchors the peer at the current
  // frame. Count that separately from accidental duplicates in routine traffic.
  const maximumRecoveryAnchors = manualSnapshots + reconnects + 1;
  if (totalFrameGaps !== 0 || totalDuplicateFrames > maximumRecoveryAnchors) {
    throw new Error("Lockstep frame delivery failed: gaps=" + totalFrameGaps
      + " duplicates=" + totalDuplicateFrames + " recoveryAnchors=" + maximumRecoveryAnchors);
  }
  const minimumComparisons = Math.min(50, Math.max(2, Math.floor(durationMs / 1_000))) * (playerCount - 1);
  if (checksumMismatches !== 0 || crossPeerFrameComparisons < minimumComparisons) {
    throw new Error("Insufficient matching frame coverage");
  }
  if (peers.some((peer) => peer.unexpectedClose)) throw new Error("A peer disconnected unexpectedly");

  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  const finalTick = Math.max(...peers.map((peer) => peer.lastFrameTick ?? startTick));
  const observedSimulationHz = Number(((finalTick - startTick) / elapsedSeconds).toFixed(2));
  const averageRttMs = Number((pingSamples.reduce((sum, value) => sum + value, 0) / pingSamples.length).toFixed(1));
  const maxRttMs = Math.max(...pingSamples);
  const maxMessageSilenceMs = Math.max(...allPeers.map((peer) => peer.maxMessageSilenceMs));
  console.log(JSON.stringify({
    ok: true,
    matchId,
    players: playerCount,
    teamSize: playerCount / 2,
    unitsPerPlayer,
    initialShips: unitsPerPlayer * playerCount,
    initialTurrets: startStates[0].state.ships.reduce((count, ship) => count + ship.turrets.length, 0),
    durationSeconds: Number(elapsedSeconds.toFixed(1)),
    startTick,
    finalTick,
    observedSimulationHz,
    meetsRealtimeTarget: observedSimulationHz >= 18 && maxRttMs <= 250 && maxMessageSilenceMs <= 1_000,
    crossPeerFrameComparisons,
    checksumMismatches,
    frameGaps: totalFrameGaps,
    duplicateFrames: totalDuplicateFrames,
    reconnects,
    exerciseRecovery,
    manualSnapshots,
    peakObservedProjectiles: peakProjectiles,
    minimumSurvivingShips,
    finalShips: finalState.ships.length,
    finalProjectiles: finalState.projectiles.length,
    pingSamples: pingSamples.length,
    averageRttMs,
    maxRttMs,
    bytesReceived: allPeers.reduce((sum, peer) => sum + peer.bytesReceived, 0),
    bytesSent: allPeers.reduce((sum, peer) => sum + peer.bytesSent, 0),
    routineBytesReceived: peers.reduce((sum, peer) => sum + peer.bytesReceived, 0) - routineReceivedBaseline,
    routineBytesSent: peers.reduce((sum, peer) => sum + peer.bytesSent, 0) - routineSentBaseline,
    maxMessageSilenceMs,
  }));
} finally {
  for (const peer of [...peers, ...retiredPeers]) peer.close();
}
process.exit(0);
