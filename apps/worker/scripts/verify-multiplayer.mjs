const authority = process.env.VOIDFRONT_AUTHORITY ?? "ws://127.0.0.1:8787";
const authorityBase = new URL(authority);
const authorityBasePath = authorityBase.pathname.replace(/\/+$/, "");
const matchId = `verify-${Date.now()}`;
const shipRadii = { fighter: 6, frigate: 13, destroyer: 23 };

function authorityEndpoint(path, protocol = authorityBase.protocol) {
  const url = new URL(authorityBase);
  url.protocol = protocol;
  url.pathname = `${authorityBasePath}${path}`;
  return url;
}

function assertProjectedView(view, label) {
  if (view.version !== 1 || view.simulationVersion !== 9) {
    throw new Error(`${label} did not use ProjectedViewState v1 over SimulationState v7`);
  }
  if ("seed" in view || "nextEntityId" in view || "nextTurretId" in view || "nextQueueItemId" in view
    || "commandQueue" in view || "aiPlayerIds" in view || "visibility" in view) {
    throw new Error(`${label} leaked private simulation fields`);
  }
  const playerView = typeof view.viewerPlayerId === "string"
    && Number.isInteger(view.ownLastCommandSequence) && view.ownLastCommandSequence >= 0;
  const teamView = view.viewerPlayerId === null && view.ownLastCommandSequence === null;
  if (!playerView && !teamView) {
    throw new Error(`${label} had an invalid projected viewer identity`);
  }
  if (!Array.isArray(view.obstacles) || view.obstacles.length < 2) {
    throw new Error(`${label} omitted authoritative asteroid obstacles`);
  }
  const ids = new Set();
  for (const obstacle of view.obstacles) {
    if (obstacle.type !== "asteroid" || !Number.isInteger(obstacle.id) || ids.has(obstacle.id)
      || !Number.isFinite(obstacle.x) || !Number.isFinite(obstacle.z)
      || !Number.isFinite(obstacle.radius) || obstacle.radius <= 0
      || !Number.isInteger(obstacle.visualSeed)) {
      throw new Error(`${label} contained malformed obstacle state`);
    }
    ids.add(obstacle.id);
  }
}

function assertShipsClearObstacles(view, label) {
  for (const ship of view.ships) {
    const shipRadius = shipRadii[ship.class];
    for (const obstacle of view.obstacles) {
      const clearance = Math.hypot(ship.x - obstacle.x, ship.z - obstacle.z) - shipRadius - obstacle.radius;
      if (clearance < -0.03) {
        throw new Error(`${label} ship ${ship.id} penetrated obstacle ${obstacle.id} by ${(-clearance).toFixed(3)}`);
      }
    }
  }
}

function obstacleCrossingDestination(ship, view) {
  const obstacle = [...view.obstacles].sort((a, b) =>
    Math.hypot(a.x - ship.x, a.z - ship.z) - Math.hypot(b.x - ship.x, b.z - ship.z) || a.id - b.id
  )[0];
  if (!obstacle) throw new Error("No obstacle was available for steering verification");
  const distance = Math.hypot(obstacle.x - ship.x, obstacle.z - ship.z) || 1;
  const directionX = (obstacle.x - ship.x) / distance;
  const directionZ = (obstacle.z - ship.z) / distance;
  return {
    obstacle,
    destination: {
      x: obstacle.x + directionX * 190,
      z: obstacle.z + directionZ * 190,
    },
  };
}

class Peer {
  constructor(name, credentials) {
    this.name = name;
    this.credentials = credentials;
    this.messages = [];
    this.received = [];
    this.waiters = [];
  }

  async connect() {
    const welcome = await this.open({ type: "hello", name: this.name, ...(this.credentials ?? {}) }, "welcome");
    this.credentials = { playerId: welcome.playerId, reconnectToken: welcome.reconnectToken };
    return welcome;
  }

  async open(handshake, welcomeType) {
    this.socket = new WebSocket(authorityEndpoint(`/matches/${matchId}/connect`));
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      this.received.push(message);
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (waiterIndex >= 0) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.messages.push(message);
      }
    });
    const helloRequired = await this.waitFor((message) => message.type === "hello_required");
    if (helloRequired.matchId !== matchId) throw new Error("Authority routed the socket to the wrong match");
    this.send(handshake);
    return this.waitFor((message) => message.type === welcomeType);
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  waitFor(predicate, timeoutMs = 5_000) {
    const queuedIndex = this.messages.findIndex(predicate);
    if (queuedIndex >= 0) return Promise.resolve(this.messages.splice(queuedIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: undefined };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for ${this.name}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  close() {
    this.socket?.close(1000, "Verification complete");
  }
}

class SpectatorPeer extends Peer {
  constructor(name, token, credentials) {
    super(name);
    this.token = token;
    this.credentials = credentials;
  }

  async connect() {
    const welcome = await this.open({
      type: "spectate",
      name: this.name,
      mode: "team",
      token: this.token,
      ...(this.credentials ?? {}),
    }, "spectator_welcome");
    this.credentials = {
      spectatorId: welcome.spectatorId,
      reconnectToken: welcome.reconnectToken,
    };
    return welcome;
  }
}

function assertNoInformationLeaks(peer) {
  for (const message of peer.received) {
    if (message.type === "commands" || message.type === "events" || "state" in message) {
      throw new Error(`${peer.name} received legacy global ${message.type ?? "state"} data`);
    }
    if (message.lobby && "seed" in message.lobby) throw new Error(`${peer.name} received the private match seed`);
    if (message.view) assertProjectedView(message.view, `${peer.name} ${message.type}`);
  }
}

const host = new Peer("Host Vega");
const wing = new Peer("Wing Lyra");
let observer;
let rejoinedObserver;
let unauthorizedSpectator;
let rejoined;

try {
  const healthUrl = authorityEndpoint("/health", authorityBase.protocol === "wss:" ? "https:" : "http:");
  const healthResponse = await fetch(healthUrl);
  const health = await healthResponse.json();
  if (!healthResponse.ok || health.ok !== true || health.physics !== "box3d-wasm-precompiled"
    || health.physicsModule !== "ready" || health.simulationHz !== 20) {
    throw new Error(`Authority health did not report ready Box3D physics: ${JSON.stringify(health)}`);
  }

  const hostWelcome = await host.connect();
  const wingWelcome = await wing.connect();
  const twoPlayerLobby = await host.waitFor((message) => message.type === "lobby" && message.lobby.slots.length === 2);
  if (!twoPlayerLobby.lobby.slots.find((slot) => slot.playerId === hostWelcome.playerId)?.isHost) {
    throw new Error("First pilot was not assigned host");
  }
  const hostTeamId = twoPlayerLobby.lobby.slots.find((slot) => slot.playerId === hostWelcome.playerId)?.teamId;
  const wingTeamId = twoPlayerLobby.lobby.slots.find((slot) => slot.playerId === wingWelcome.playerId)?.teamId;
  if (!hostTeamId || !wingTeamId || hostTeamId === wingTeamId) throw new Error("Verification pilots were not opponents");

  host.send({ type: "authorize_spectator", teamId: wingTeamId });
  const enemyGrantRejected = await host.waitFor(
    (message) => message.type === "error" && message.code === "spectator_team_forbidden",
  );
  if (!enemyGrantRejected) throw new Error("Host could authorize an opposing-team spectator");
  host.send({ type: "authorize_spectator", teamId: hostTeamId });
  const spectatorGrant = await host.waitFor((message) => message.type === "spectator_authorized");
  if (spectatorGrant.teamId !== hostTeamId || !spectatorGrant.token) {
    throw new Error("Authority did not issue an own-team spectator token to the host");
  }
  observer = new SpectatorPeer("Observer Nova", spectatorGrant.token);
  const observerWelcome = await observer.connect();
  if (observerWelcome.mode !== "team" || observerWelcome.teamId !== hostTeamId || !observerWelcome.reconnectToken) {
    throw new Error("Team spectator received an invalid role or reconnect grant");
  }

  const requestedSettings = {
    mapPreset: "crossfire",
    mapSize: "large",
    startingResources: "high",
    resourceDensity: "rich",
    teamSpawnMode: "together",
  };
  host.send({ type: "set_settings", settings: requestedSettings });
  const configuredLobby = await wing.waitFor((message) => message.type === "lobby"
    && message.lobby.settings?.mapPreset === requestedSettings.mapPreset
    && message.lobby.settings?.mapSize === requestedSettings.mapSize);
  if (JSON.stringify(configuredLobby.lobby.settings) !== JSON.stringify(requestedSettings)) {
    throw new Error("Lobby settings did not synchronize to every pilot");
  }

  host.send({ type: "set_ready", ready: true });
  wing.send({ type: "set_ready", ready: true });
  await host.waitFor((message) => message.type === "lobby" && message.lobby.slots.every((slot) => slot.ready));
  host.send({ type: "start_match" });
  const hostStart = await host.waitFor((message) => message.type === "match_started");
  const wingStart = await wing.waitFor((message) => message.type === "match_started");
  const observerStart = await observer.waitFor((message) => message.type === "match_started");
  assertProjectedView(hostStart.view, "Host start view");
  assertProjectedView(wingStart.view, "Wing start view");
  assertProjectedView(observerStart.view, "Team spectator start view");
  if (observerStart.view.viewerPlayerId !== null || observerStart.view.viewerTeamId !== hostTeamId
    || observerStart.view.ownLastCommandSequence !== null) {
    throw new Error("Team spectator view impersonated a player");
  }
  if (JSON.stringify(observerStart.view.ships.map((ship) => ship.id))
    !== JSON.stringify(hostStart.view.ships.map((ship) => ship.id))) {
    throw new Error("Team spectator visibility differed from its authorized team");
  }
  if (hostStart.checksum !== hostStart.view.checksum || wingStart.checksum !== wingStart.view.checksum) {
    throw new Error("Initial frame checksums did not match their projected views");
  }
  if (hostStart.view.viewerPlayerId !== hostWelcome.playerId || wingStart.view.viewerPlayerId !== wingWelcome.playerId) {
    throw new Error("Authority delivered a view for the wrong pilot");
  }
  const hostEconomy = hostStart.view.players.find((player) => player.id === hostWelcome.playerId)?.economy;
  if (hostEconomy?.alloy !== 1_800 || hostEconomy.energy !== 1_800) {
    throw new Error("Lobby starting resources were not applied to the authoritative scenario");
  }
  if (hostStart.checksum === wingStart.checksum) {
    throw new Error("Opponent views unexpectedly shared a player-specific checksum");
  }
  if (JSON.stringify(hostStart.view.obstacles) !== JSON.stringify(wingStart.view.obstacles)) {
    throw new Error("Initial obstacle snapshots disagree");
  }
  assertShipsClearObstacles(hostStart.view, "Initial host view");
  assertShipsClearObstacles(wingStart.view, "Initial wing view");

  const ownedCore = hostStart.view.structures.find(
    (structure) => structure.ownerPlayerId === hostWelcome.playerId && structure.type === "commandCore",
  );
  const wingCore = wingStart.view.structures.find(
    (structure) => structure.ownerPlayerId === wingWelcome.playerId && structure.type === "commandCore",
  );
  const ownedYard = hostStart.view.structures.find(
    (structure) => structure.ownerPlayerId === hostWelcome.playerId && structure.type === "shipyard",
  );
  const wingYard = wingStart.view.structures.find(
    (structure) => structure.ownerPlayerId === wingWelcome.playerId && structure.type === "shipyard",
  );
  if (hostStart.view.ships.length !== 0 || wingStart.view.ships.length !== 0 || observerStart.view.ships.length !== 0) {
    throw new Error("Authoritative match started with free ships");
  }
  if (!ownedCore || !wingCore || !ownedYard || !wingYard) {
    throw new Error("Starting Command Cores and Light Shipyards were not assigned to both pilots");
  }
  if (hostStart.view.ships.some((ship) => ship.ownerPlayerId === wingWelcome.playerId)
    || hostStart.view.structures.some((structure) => structure.ownerPlayerId === wingWelcome.playerId)) {
    throw new Error("Host view leaked hidden opponent forces at match start");
  }
  if (wingStart.view.ships.some((ship) => ship.ownerPlayerId === hostWelcome.playerId)
    || wingStart.view.structures.some((structure) => structure.ownerPlayerId === hostWelcome.playerId)) {
    throw new Error("Wing view leaked hidden opponent forces at match start");
  }

  observer.send({
    type: "commands",
    clientTick: observerStart.tick,
    commands: [{
      type: "hold", playerId: hostWelcome.playerId, sequence: 1, requestedTick: observerStart.tick + 8,
      unitIds: [ownedCore.id], queued: false,
    }],
  });
  await observer.waitFor((message) => message.type === "error" && message.code === "spectator_read_only");
  observer.send({ type: "request_replay_manifest" });
  await observer.waitFor((message) => message.type === "error" && message.code === "replay_unavailable");

  unauthorizedSpectator = new Peer("Unauthorized Observer");
  const unauthorizedResult = await unauthorizedSpectator.open({
    type: "spectate", name: "Unauthorized Observer", mode: "replay",
  }, "error");
  if (unauthorizedResult.code !== "spectator_unauthorized") {
    throw new Error("Unauthenticated live omniscient spectator was not rejected");
  }
  unauthorizedSpectator.close();

  host.send({
    type: "commands",
    clientTick: hostStart.tick,
    clientChecksum: hostStart.checksum,
    commands: [{
      type: "buildStructure", playerId: hostWelcome.playerId, sequence: 1, requestedTick: hostStart.tick + 8,
      structureType: "fusionReactor", position: { x: ownedCore.x, z: ownedCore.z + 180 }, queued: false,
    }],
  });
  const technologyRejected = await host.waitFor(
    (message) => message.type === "command_results" && message.outcomes[0]?.sequence === 1,
  );
  if (technologyRejected.outcomes[0].result.accepted || technologyRejected.outcomes[0].result.reason !== "technology") {
    throw new Error("Authority allowed a Fusion Reactor before its Fabricator prerequisite");
  }

  const coreDistance = Math.hypot(ownedCore.x, ownedCore.z) || 1;
  const storagePosition = {
    x: ownedCore.x - ownedCore.x / coreDistance * 180,
    z: ownedCore.z - ownedCore.z / coreDistance * 180,
  };
  const storageRequestedTick = technologyRejected.tick + 8;
  host.send({
    type: "commands",
    clientTick: technologyRejected.tick,
    commands: [{
      type: "buildStructure", playerId: "spoofed-id", sequence: 1, requestedTick: storageRequestedTick,
      structureType: "storage", position: storagePosition, queued: false,
    }],
  });
  const storageAccepted = await host.waitFor(
    (message) => message.type === "command_results" && message.outcomes[0]?.sequence === 1,
  );
  if (!storageAccepted.outcomes[0].result.accepted) throw new Error("Valid Storage construction was rejected");

  const productionRequestedTick = storageAccepted.tick + 8;
  host.send({
    type: "commands",
    clientTick: storageAccepted.tick,
    commands: [{
      type: "queueUnit", playerId: hostWelcome.playerId, sequence: 2, requestedTick: productionRequestedTick,
      structureId: ownedYard.id, shipClass: "fighter", count: 1,
    }],
  });
  wing.send({
    type: "commands",
    clientTick: storageAccepted.tick,
    commands: [{
      type: "queueUnit", playerId: wingWelcome.playerId, sequence: 1, requestedTick: productionRequestedTick,
      structureId: wingYard.id, shipClass: "fighter", count: 1,
    }],
  });
  const hostProductionAccepted = await host.waitFor(
    (message) => message.type === "command_results" && message.outcomes[0]?.sequence === 2,
  );
  const wingProductionAccepted = await wing.waitFor(
    (message) => message.type === "command_results" && message.outcomes[0]?.sequence === 1,
  );
  if (!hostProductionAccepted.outcomes[0].result.accepted || !wingProductionAccepted.outcomes[0].result.accepted) {
    throw new Error("Light Yard Fighter production was rejected");
  }
  const hostProductionView = await host.waitFor(
    (message) => message.type === "view" && message.view.ships.some(
      (ship) => ship.ownerPlayerId === hostWelcome.playerId && ship.class === "fighter",
    ),
    20_000,
  );
  const wingProductionView = await wing.waitFor(
    (message) => message.type === "view" && message.view.ships.some(
      (ship) => ship.ownerPlayerId === wingWelcome.playerId && ship.class === "fighter",
    ),
    20_000,
  );
  const ownedShip = hostProductionView.view.ships.find(
    (ship) => ship.ownerPlayerId === hostWelcome.playerId && ship.class === "fighter",
  );
  const wingShip = wingProductionView.view.ships.find(
    (ship) => ship.ownerPlayerId === wingWelcome.playerId && ship.class === "fighter",
  );
  if (!ownedShip || !wingShip) throw new Error("Queued Fighters were not produced");

  const { obstacle: steeringObstacle, destination } = obstacleCrossingDestination(ownedShip, hostStart.view);
  const movementStart = { x: ownedShip.x, z: ownedShip.z, yaw: ownedShip.yaw };
  const requestedTick = Math.max(hostProductionView.tick, wingProductionView.tick) + 8;
  host.send({
    type: "commands",
    clientTick: hostProductionView.tick,
    commands: [{
      type: "move", playerId: "spoofed-id", sequence: 3, requestedTick,
      unitIds: [ownedShip.id], queued: false, destination,
    }],
  });
  const accepted = await host.waitFor((message) => message.type === "command_results" && message.outcomes[0]?.sequence === 3);
  if (!accepted.outcomes[0].result.accepted) throw new Error("Valid owned command was rejected");

  host.send({
    type: "commands",
    clientTick: accepted.tick,
    commands: [{
      type: "focusFire", playerId: hostWelcome.playerId, sequence: 4, requestedTick: accepted.tick + 8,
      unitIds: [ownedShip.id], targetEntityId: wingShip.id, queued: false,
    }],
  });
  const hiddenTargetRejected = await host.waitFor(
    (message) => message.type === "command_results" && message.outcomes[0]?.sequence === 4,
  );
  if (hiddenTargetRejected.outcomes[0].result.accepted || hiddenTargetRejected.outcomes[0].result.reason !== "target") {
    throw new Error("Authority revealed or accepted a hidden focus-fire target");
  }

  host.send({
    type: "commands",
    clientTick: hiddenTargetRejected.tick,
    commands: [{
      type: "focusFire", playerId: hostWelcome.playerId, sequence: 4, requestedTick: hiddenTargetRejected.tick + 8,
      unitIds: [ownedShip.id], targetEntityId: 2_000_000_000, queued: false,
    }],
  });
  const nonexistentTargetRejected = await host.waitFor(
    (message) => message.type === "command_results" && message.outcomes[0]?.sequence === 4,
  );
  if (JSON.stringify(nonexistentTargetRejected.outcomes[0].result) !== JSON.stringify(hiddenTargetRejected.outcomes[0].result)) {
    throw new Error("Hidden and nonexistent focus-fire targets produced distinguishable results");
  }

  const hostViewFrame = await host.waitFor(
    (message) => message.type === "view" && message.tick >= requestedTick + 20 && message.tick % 10 === 0,
    10_000,
  );
  const checksum = await host.waitFor(
    (message) => message.type === "checksum" && message.tick === hostViewFrame.tick,
    10_000,
  );
  if (checksum.checksum !== hostViewFrame.view.checksum) {
    throw new Error("Host checksum did not match the same-tick projected view");
  }
  const wingViewFrame = await wing.waitFor(
    (message) => message.type === "view" && message.tick === checksum.tick,
    10_000,
  );
  const wingChecksum = await wing.waitFor(
    (message) => message.type === "checksum" && message.tick === checksum.tick,
    10_000,
  );
  if (wingChecksum.checksum !== wingViewFrame.view.checksum) {
    throw new Error("Wing checksum did not match the same-tick projected view");
  }
  host.send({ type: "request_snapshot", reason: "manual" });
  const movementSnapshot = await host.waitFor(
    (message) => message.type === "snapshot" && message.reason === "manual" && message.tick >= checksum.tick,
  );
  assertProjectedView(movementSnapshot.view, "Movement snapshot");
  assertShipsClearObstacles(movementSnapshot.view, "Movement snapshot");
  const movedShip = movementSnapshot.view.ships.find((ship) => ship.id === ownedShip.id);
  if (!movedShip || Math.hypot(movedShip.x - movementStart.x, movedShip.z - movementStart.z) < 8) {
    throw new Error("Accepted move command did not steer the selected ship");
  }
  const directDistance = Math.abs(
    (destination.z - movementStart.z) * (movedShip.x - movementStart.x)
      - (destination.x - movementStart.x) * (movedShip.z - movementStart.z)
  ) / Math.max(1, Math.hypot(destination.x - movementStart.x, destination.z - movementStart.z));
  const steeringClearance = Math.hypot(movedShip.x - steeringObstacle.x, movedShip.z - steeringObstacle.z)
    - shipRadii[movedShip.class] - steeringObstacle.radius;
  if (steeringClearance < -0.03) throw new Error("Steered ship penetrated its blocking obstacle");

  const observerCredentials = observer.credentials;
  observer.close();
  rejoinedObserver = new SpectatorPeer("Observer Nova", spectatorGrant.token, observerCredentials);
  const observerReconnectWelcome = await rejoinedObserver.connect();
  const observerReconnectSnapshot = await rejoinedObserver.waitFor(
    (message) => message.type === "snapshot" && message.reason === "reconnect",
  );
  if (observerReconnectWelcome.spectatorId !== observerWelcome.spectatorId
    || observerReconnectSnapshot.view.viewerPlayerId !== null
    || observerReconnectSnapshot.view.viewerTeamId !== hostTeamId) {
    throw new Error("Team spectator reconnect did not restore the authorized team view");
  }

  const reconnectCredentials = wing.credentials;
  wing.close();
  rejoined = new Peer("Wing Lyra", reconnectCredentials);
  const reconnectWelcome = await rejoined.connect();
  const reconnectSnapshot = await rejoined.waitFor((message) => message.type === "snapshot" && message.reason === "reconnect");
  if (reconnectWelcome.playerId !== wingWelcome.playerId || reconnectSnapshot.tick < checksum.tick) {
    throw new Error("Reconnect did not restore the original pilot at the current authority tick");
  }
  assertProjectedView(reconnectSnapshot.view, "Reconnect snapshot");
  assertShipsClearObstacles(reconnectSnapshot.view, "Reconnect snapshot");
  if (reconnectSnapshot.view.viewerPlayerId !== wingWelcome.playerId) {
    throw new Error("Reconnect received another pilot's projected view");
  }
  if (JSON.stringify(reconnectSnapshot.view.obstacles) !== JSON.stringify(hostStart.view.obstacles)) {
    throw new Error("Reconnect changed authoritative obstacle state");
  }
  if (reconnectSnapshot.view.structures.some(
    (structure) => structure.ownerPlayerId === hostWelcome.playerId && structure.type === "storage",
  )) {
    throw new Error("Reconnect leaked a hidden opponent Storage structure");
  }

  host.send({ type: "request_snapshot", reason: "manual" });
  const persistedHostSnapshot = await host.waitFor(
    (message) => message.type === "snapshot" && message.reason === "manual" && message.tick >= reconnectSnapshot.tick,
  );
  if (!persistedHostSnapshot.view.structures.some(
    (structure) => structure.ownerPlayerId === hostWelcome.playerId && structure.type === "storage",
  )) {
    throw new Error("Owner view omitted synchronized Storage construction after reconnect");
  }

  assertNoInformationLeaks(host);
  assertNoInformationLeaks(wing);
  assertNoInformationLeaks(rejoined);
  assertNoInformationLeaks(observer);
  assertNoInformationLeaks(rejoinedObserver);

  console.log(JSON.stringify({
    ok: true,
    matchId,
    players: hostStart.view.players.length,
    initialChecksum: hostStart.checksum,
    verifiedChecksumTick: checksum.tick,
    reconnectedAtTick: reconnectSnapshot.tick,
    projectedViewBoundary: "passed",
    hiddenTargetIndistinguishability: "passed",
    opponentCommandRedaction: "passed",
    teamSpectatorAuthorization: "passed",
    spectatorReconnect: "passed",
    liveOmniscientRejection: "passed",
    progressionValidation: "passed",
    physicsHealth: "passed",
    obstacleCount: hostStart.view.obstacles.length,
    movementDistance: Number(Math.hypot(movedShip.x - movementStart.x, movedShip.z - movementStart.z).toFixed(3)),
    lateralSteering: Number(directDistance.toFixed(3)),
    obstacleClearance: Number(steeringClearance.toFixed(3)),
    perViewChecksums: "passed",
    reconnectPhysicsState: "passed",
  }));
} finally {
  host.close();
  wing.close();
  observer?.close();
  rejoinedObserver?.close();
  unauthorizedSpectator?.close();
  rejoined?.close();
}
process.exit(0);
