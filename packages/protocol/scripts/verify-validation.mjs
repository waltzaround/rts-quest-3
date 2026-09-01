import assert from "node:assert/strict";
import { MAX_FLEET_COMMAND_UNITS, parseClientMessage, parseServerMessage } from "../dist/index.js";

const buildCommand = (structureType) => JSON.stringify({
  type: "commands",
  clientTick: 0,
  commands: [{
    type: "buildStructure",
    playerId: "pilot-blue",
    sequence: 1,
    requestedTick: 1,
    structureType,
    position: { x: 120, z: -40 },
    queued: false,
    builderUnitIds: [14],
  }],
});

for (const structureType of ["storage", "fabricator", "fusionReactor"]) {
  const message = parseClientMessage(buildCommand(structureType));
  assert.equal(message?.type, "commands", `${structureType} should pass protocol validation`);
  assert.equal(message.commands[0]?.structureType, structureType);
}

assert.equal(parseClientMessage(JSON.stringify({
  type: "commands",
  clientTick: 0,
  commands: [{
    type: "queueUnit", playerId: "pilot-blue", sequence: 1, requestedTick: 1,
    structureId: 12, shipClass: "fabricator", count: 1,
  }],
}))?.type, "commands", "Fabricator vessels should pass protocol validation");

const fleetCommand = (unitCount) => JSON.stringify({
  type: "commands",
  clientTick: 0,
  commands: [{
    type: "move", playerId: "pilot-blue", sequence: 1, requestedTick: 1,
    unitIds: Array.from({ length: unitCount }, (_, index) => index + 1),
    queued: false, destination: { x: 120, z: -40 },
  }],
});
assert.equal(
  parseClientMessage(fleetCommand(1_500))?.type,
  "commands",
  "A 1,500-unit fleet order should pass protocol validation",
);
assert.equal(
  parseClientMessage(fleetCommand(MAX_FLEET_COMMAND_UNITS + 1)),
  null,
  "Fleet orders must remain bounded above the supported large-battle limit",
);

for (const command of [
  { type: "setProductionRepeat", structureId: 12, enabled: true },
  { type: "clearProductionQueue", structureId: 12 },
  { type: "cancelConstruction", structureId: 12 },
  { type: "cancelBuildOrder", buildSequence: 4 },
]) {
  assert.equal(parseClientMessage(JSON.stringify({
    type: "commands",
    clientTick: 0,
    commands: [{
      ...command, playerId: "pilot-blue", sequence: 1, requestedTick: 1,
    }],
  }))?.type, "commands", `${command.type} should pass protocol validation`);
}

for (const structureType of ["commandCore", "advancedShipyard", "unknown"]) {
  assert.equal(parseClientMessage(buildCommand(structureType)), null, `${structureType} should fail protocol validation`);
}

const playerView = {
  version: 1,
  simulationVersion: 9,
  tick: 12,
  viewerPlayerId: "pilot-blue",
  viewerTeamId: 1,
  ownLastCommandSequence: 3,
  players: [],
  teams: [],
  ships: [],
  structures: [],
  resourceNodes: [],
  obstacles: [],
  projectiles: [],
  status: "playing",
  winnerTeamId: null,
  checksum: 91234,
};
const frame = { type: "match_started", tick: 12, checksum: 91234, view: playerView };
assert.equal(parseServerMessage(JSON.stringify(frame))?.type, "match_started", "player view frame should validate");
assert.equal(parseServerMessage(JSON.stringify({ ...frame, type: "view" }))?.type, "view", "view update should validate");
assert.equal(parseServerMessage(JSON.stringify({ ...frame, type: "snapshot", reason: "reconnect" }))?.type, "snapshot");
const teamView = { ...playerView, viewerPlayerId: null, ownLastCommandSequence: null };
assert.equal(
  parseServerMessage(JSON.stringify({ ...frame, type: "view", view: teamView }))?.type,
  "view",
  "team spectator view should validate",
);
assert.equal(
  parseServerMessage(JSON.stringify({ ...frame, view: { ...teamView, ownLastCommandSequence: 3 } })),
  null,
  "team views must not expose a player's command sequence",
);

for (const leakedField of ["seed", "nextEntityId", "nextTurretId", "nextQueueItemId", "commandQueue", "aiPlayerIds", "visibility"]) {
  assert.equal(
    parseServerMessage(JSON.stringify({ ...frame, view: { ...playerView, [leakedField]: leakedField === "seed" ? 123 : [] } })),
    null,
    `${leakedField} must not cross the projected-view protocol boundary`,
  );
}
assert.equal(parseServerMessage(JSON.stringify({ ...frame, state: playerView, view: undefined })), null, "legacy state frames must fail");
assert.equal(parseServerMessage(JSON.stringify({ type: "commands", tick: 12, commands: [] })), null, "command relays must fail");
assert.equal(parseServerMessage(JSON.stringify({ type: "events", tick: 12, events: [] })), null, "global events must fail");
assert.equal(parseServerMessage(JSON.stringify({ ...frame, checksum: playerView.checksum + 1 })), null, "frame checksum must match its view");

const lockstepState = {
  version: 9, seed: 0x7233, tick: 12, nextEntityId: 1, nextTurretId: 1, nextQueueItemId: 1,
  players: [], teams: [], ships: [], structures: [], resourceNodes: [], obstacles: [], visibility: [],
  projectiles: [], commandQueue: [], aiPlayerIds: [], aiCommanders: {},
  status: "playing", winnerTeamId: null, checksum: 91234,
};
assert.equal(parseServerMessage(JSON.stringify({
  type: "lockstep_state", tick: 12, checksum: 91234, state: lockstepState, reason: "start",
}))?.type, "lockstep_state", "complete lockstep bootstrap state should validate");
assert.equal(parseServerMessage(JSON.stringify({
  type: "lockstep_state", tick: 13, checksum: 91234, state: lockstepState, reason: "start",
})), null, "lockstep bootstrap tick must match its state");
assert.equal(parseServerMessage(JSON.stringify({
  type: "lockstep_frame", tick: 13, checksum: 12345,
}))?.type, "lockstep_frame", "lockstep frame marker should validate");
assert.equal(parseServerMessage(JSON.stringify({
  type: "lockstep_commands", commands: [{
    type: "hold", playerId: "pilot-blue", sequence: 4, requestedTick: 20, unitIds: [7], queued: false,
  }],
}))?.type, "lockstep_commands", "validated command streams should cross the lockstep boundary");
assert.equal(parseServerMessage(JSON.stringify({
  type: "lockstep_player_state", tick: 13, playerId: "pilot-blue", state: "disconnected",
}))?.type, "lockstep_player_state", "player connection transitions should cross the lockstep boundary");
assert.equal(parseServerMessage(JSON.stringify({
  type: "lockstep_player_state", tick: 13, playerId: "pilot-blue", state: "defeated",
})), null, "player connection transitions must not override defeat state");

const lobby = {
  matchId: "secure-match",
  phase: "lobby",
  mode: "teams",
  settings: {
    mapPreset: "orbital-ring",
    mapSize: "medium",
    startingResources: "standard",
    resourceDensity: "standard",
    teamSpawnMode: "together",
  },
  maxPlayers: 8,
  slots: [],
  createdAt: Date.now(),
};
assert.equal(parseClientMessage(JSON.stringify({
  type: "hello", name: "Commander", lockstepVersion: 2,
}))?.type, "hello", "lockstep clients should identify their deterministic rules version");
assert.equal(parseClientMessage(JSON.stringify({
  type: "hello", name: "Commander", lockstepVersion: "old",
})), null, "invalid lockstep versions must fail validation");
assert.equal(parseServerMessage(JSON.stringify({
  type: "hello_required", matchId: lobby.matchId, lobby, lockstepVersion: 2,
}))?.type, "hello_required", "authorities should advertise their deterministic rules version");
assert.equal(parseServerMessage(JSON.stringify({ type: "lobby", lobby }))?.type, "lobby");
assert.equal(parseServerMessage(JSON.stringify({ type: "lobby", lobby: { ...lobby, seed: 123 } })), null, "lobby seed must be private");
assert.equal(parseClientMessage(JSON.stringify({ type: "set_settings", settings: lobby.settings }))?.type, "set_settings");
for (const mapPreset of ["amazon-tunnel", "core-rush", "star-fortress"]) {
  assert.equal(parseClientMessage(JSON.stringify({
    type: "set_settings", settings: { ...lobby.settings, mapPreset },
  }))?.type, "set_settings", `${mapPreset} should pass lobby validation`);
}
assert.equal(parseClientMessage(JSON.stringify({
  type: "set_settings",
  settings: { ...lobby.settings, mapSize: "planet-sized" },
})), null, "unknown lobby settings must fail validation");
assert.equal(parseClientMessage(JSON.stringify({
  type: "set_settings",
  settings: { ...lobby.settings, teamSpawnMode: "host-picks" },
})), null, "unknown team deployment modes must fail validation");

const spectatorToken = "grant-123456789";
assert.equal(parseClientMessage(JSON.stringify({
  type: "spectate", name: "Observer", mode: "team", token: spectatorToken,
}))?.type, "spectate");
assert.equal(parseClientMessage(JSON.stringify({ type: "spectate", name: "Observer", mode: "team" })), null);
assert.equal(parseClientMessage(JSON.stringify({
  type: "spectate", name: "Observer", mode: "replay", token: spectatorToken,
})), null, "clients cannot supply a live omniscient token");
assert.equal(parseClientMessage(JSON.stringify({ type: "spectate", name: "Observer", mode: "replay" }))?.type, "spectate");
assert.equal(parseClientMessage(JSON.stringify({ type: "authorize_spectator", teamId: 1 }))?.type, "authorize_spectator");
assert.equal(parseClientMessage(JSON.stringify({ type: "request_replay_chunk", index: 0 }))?.type, "request_replay_chunk");
assert.equal(parseClientMessage(JSON.stringify({ type: "request_replay_chunk", index: -1 })), null);
assert.equal(parseClientMessage(JSON.stringify({
  type: "match_finished", tick: 120, checksum: 123456, winnerTeamId: 1,
}))?.type, "match_finished");
assert.equal(parseClientMessage(JSON.stringify({
  type: "match_finished", tick: 120, checksum: 123456, winnerTeamId: 99,
})), null, "relay match results must identify a valid team");
assert.equal(parseClientMessage(JSON.stringify({
  type: "commands", clientTick: 0,
  commands: [{
    type: "buildStructure", playerId: "pilot-blue", sequence: 2, requestedTick: 2,
    structureType: "storage", position: { x: 0, z: 0 }, queued: false, builderUnitIds: "14",
  }],
})), null, "builder IDs must be a bounded entity-ID array");

assert.equal(parseServerMessage(JSON.stringify({
  type: "spectator_authorized", token: spectatorToken, mode: "team", teamId: 1,
}))?.type, "spectator_authorized");
assert.equal(parseServerMessage(JSON.stringify({
  type: "spectator_welcome", spectatorId: "spectator-1", reconnectToken: "reconnect-123456789",
  mode: "team", teamId: 1, lobby, tick: 12,
}))?.type, "spectator_welcome");
assert.equal(parseServerMessage(JSON.stringify({
  type: "spectator_welcome", spectatorId: "replay-1", reconnectToken: null,
  mode: "replay", teamId: null, lobby: { ...lobby, phase: "finished" }, tick: 120,
}))?.type, "spectator_welcome");

const replayManifest = {
  version: 1,
  matchId: lobby.matchId,
  format: "space-rts-replay",
  tick: 120,
  checksum: 123456,
  status: "finished",
  physicsBackend: "box3d-wasm",
  winnerTeamId: 1,
  completedAt: Date.now(),
  byteLength: 60_000,
  chunkBytes: 32 * 1024,
  chunkCount: 2,
  encoding: "base64-json",
};
assert.equal(parseServerMessage(JSON.stringify({ type: "replay_manifest", manifest: replayManifest }))?.type, "replay_manifest");
assert.equal(parseServerMessage(JSON.stringify({
  type: "replay_chunk", index: 0, chunkCount: 2, data: "c2VjdXJlLXJlcGxheQ==",
}))?.type, "replay_chunk");
assert.equal(parseServerMessage(JSON.stringify({
  type: "replay_chunk", index: 2, chunkCount: 2, data: "bad",
})), null, "out-of-range replay chunks must fail validation");

console.log("Protocol command, lockstep, projected-view, spectator, and replay validation passed");
