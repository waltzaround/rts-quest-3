import type {
  CommandResult,
  GameCommand,
  PlayerViewState,
  ShipClass,
  StructureType,
  TeamViewState,
  AiDifficulty,
  AiPersonality,
} from "@space-rts/game-core";

// Wire allowlists intentionally live at the protocol boundary. The exhaustive
// records keep the built validator independent of TypeScript package loading,
// while making a new canonical union member a compile-time protocol decision.
const PROTOCOL_SHIP_CLASSES = {
  fighter: true, fabricator: true, frigate: true, bomber: true, flakFrigate: true, torpedoFrigate: true,
  destroyer: true, cruiser: true, carrier: true, battleship: true,
} satisfies Record<ShipClass, true>;
const PROTOCOL_BUILDABLE_STRUCTURE_TYPES = {
  extractor: true, deepCoreExtractor: true, singularityHarvester: true,
  solarArray: true, storage: true, quantumStorage: true, fabricator: true, shipyard: true,
  advancedFabrication: true, fusionReactor: true, fleetShipyard: true,
  antimatterReactor: true, capitalInfrastructure: true, capitalShipyard: true,
  pointDefenseBattery: true, missileBattery: true, railBattery: true,
} satisfies Record<Exclude<StructureType, "commandCore">, true>;

const hasOwn = (record: object, key: unknown): key is string =>
  typeof key === "string" && Object.prototype.hasOwnProperty.call(record, key);

export const MAX_PLAYERS = 8;
export const MAX_COMMAND_BATCH = 32;
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const REPLAY_CHUNK_BYTES = 32 * 1024;
export const MAX_REPLAY_BYTES = 32 * 1024 * 1024;
export const MAX_REPLAY_CHUNKS = MAX_REPLAY_BYTES / REPLAY_CHUNK_BYTES;

export type MatchPhase = "lobby" | "playing" | "finished";
export type MatchMode = "ffa" | "teams";
export type SpectatorMode = "team" | "replay";
export type ProjectedViewState = PlayerViewState | TeamViewState;
export type MapPreset = "orbital-ring" | "crossfire" | "open-expanse";
export type MapSize = "small" | "medium" | "large";
export type StartingResources = "low" | "standard" | "high";
export type ResourceDensity = "scarce" | "standard" | "rich";
export type TeamSpawnMode = "together" | "interleaved" | "random";

export interface LobbySettings {
  mapPreset: MapPreset;
  mapSize: MapSize;
  startingResources: StartingResources;
  resourceDensity: ResourceDensity;
  teamSpawnMode: TeamSpawnMode;
}

export const DEFAULT_LOBBY_SETTINGS: Readonly<LobbySettings> = {
  mapPreset: "orbital-ring",
  mapSize: "medium",
  startingResources: "standard",
  resourceDensity: "standard",
  teamSpawnMode: "together",
};

export interface LobbyPlayerSlot {
  playerId: string;
  name: string;
  slotIndex: number;
  teamId: number;
  color: number;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
  isAi: boolean;
  aiDifficulty?: AiDifficulty;
  aiPersonality?: AiPersonality;
}

export interface LobbyState {
  matchId: string;
  phase: MatchPhase;
  mode: MatchMode;
  settings: LobbySettings;
  maxPlayers: number;
  slots: LobbyPlayerSlot[];
  createdAt: number;
}

export type ClientMessage =
  | { type: "hello"; playerId?: string; name: string; reconnectToken?: string }
  | { type: "spectate"; name: string; mode: SpectatorMode; token?: string; spectatorId?: string; reconnectToken?: string }
  | { type: "ping"; clientTime: number }
  | { type: "request_snapshot"; reason: "join" | "reconnect" | "checksum" | "manual" }
  | { type: "set_ready"; ready: boolean }
  | { type: "set_team"; teamId: number; playerId?: string }
  | { type: "set_mode"; mode: MatchMode }
  | { type: "set_settings"; settings: LobbySettings }
  | { type: "add_ai"; name?: string; teamId?: number; difficulty?: AiDifficulty; personality?: AiPersonality }
  | { type: "set_ai_settings"; playerId: string; difficulty: AiDifficulty; personality: AiPersonality }
  | { type: "remove_slot"; playerId: string }
  | { type: "authorize_spectator"; teamId: number }
  | { type: "start_match" }
  | { type: "commands"; commands: GameCommand[]; clientTick: number; clientChecksum?: number }
  | { type: "checksum"; tick: number; checksum: number }
  | { type: "request_replay_manifest" }
  | { type: "request_replay_chunk"; index: number };

export interface ReplayManifest {
  version: 1;
  matchId: string;
  format: "space-rts-replay";
  tick: number;
  checksum: number;
  status: "finished";
  physicsBackend: "box3d-wasm" | "deterministic-fallback";
  winnerTeamId: number | null;
  completedAt: number;
  byteLength: number;
  chunkBytes: number;
  chunkCount: number;
  encoding: "base64-json";
}

export interface CommandOutcome {
  sequence: number;
  commandType: GameCommand["type"];
  result: CommandResult;
}

export type ServerMessage =
  | { type: "hello_required"; matchId: string; lobby: LobbyState }
  | { type: "welcome"; playerId: string; reconnectToken: string; lobby: LobbyState; tick: number }
  | { type: "spectator_authorized"; token: string; mode: "team"; teamId: number }
  | { type: "spectator_welcome"; spectatorId: string; reconnectToken: string | null; mode: SpectatorMode; teamId: number | null; lobby: LobbyState; tick: number }
  | { type: "lobby"; lobby: LobbyState }
  | { type: "match_started"; tick: number; checksum: number; view: ProjectedViewState }
  | { type: "view"; tick: number; checksum: number; view: ProjectedViewState }
  | { type: "command_results"; tick: number; outcomes: CommandOutcome[] }
  | { type: "checksum"; tick: number; checksum: number }
  | { type: "snapshot"; tick: number; checksum: number; view: ProjectedViewState; reason: "periodic" | "join" | "reconnect" | "checksum" | "manual" }
  | { type: "replay_manifest"; manifest: ReplayManifest }
  | { type: "replay_chunk"; index: number; chunkCount: number; data: string }
  | { type: "pong"; clientTime: number; serverTime: number; tick: number }
  | { type: "error"; code: string; message: string };

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isInteger = (value: unknown): value is number => Number.isSafeInteger(value);
const isString = (value: unknown, maximum = 64): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;
const isVec2 = (value: unknown): value is { x: number; z: number } =>
  isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.z);

function isLobbyPlayerSlot(value: unknown): value is LobbyPlayerSlot {
  return isRecord(value)
    && isString(value.playerId, 80)
    && typeof value.name === "string" && value.name.length <= 32
    && isInteger(value.slotIndex) && value.slotIndex >= 0 && value.slotIndex < MAX_PLAYERS
    && isInteger(value.teamId) && value.teamId >= 1 && value.teamId <= MAX_PLAYERS
    && isInteger(value.color) && value.color >= 0
    && typeof value.ready === "boolean"
    && typeof value.connected === "boolean"
    && typeof value.isHost === "boolean"
    && typeof value.isAi === "boolean"
    && (!value.isAi || (["easy", "normal", "hard"].includes(String(value.aiDifficulty))
      && ["balanced", "aggressive", "turtle", "economic"].includes(String(value.aiPersonality))));
}

function isLobbySettings(value: unknown): value is LobbySettings {
  return isRecord(value)
    && ["orbital-ring", "crossfire", "open-expanse"].includes(String(value.mapPreset))
    && ["small", "medium", "large"].includes(String(value.mapSize))
    && ["low", "standard", "high"].includes(String(value.startingResources))
    && ["scarce", "standard", "rich"].includes(String(value.resourceDensity))
    && ["together", "interleaved", "random"].includes(String(value.teamSpawnMode));
}

function isLobbyState(value: unknown): value is LobbyState {
  return isRecord(value)
    && isString(value.matchId, 80)
    && ["lobby", "playing", "finished"].includes(String(value.phase))
    && (value.mode === "ffa" || value.mode === "teams")
    && isLobbySettings(value.settings)
    && value.maxPlayers === MAX_PLAYERS
    && Array.isArray(value.slots) && value.slots.length <= MAX_PLAYERS && value.slots.every(isLobbyPlayerSlot)
    && isFiniteNumber(value.createdAt)
    && !("seed" in value);
}

function isProjectedViewState(value: unknown): value is ProjectedViewState {
  if (!isRecord(value)
    || value.version !== 1
    || value.simulationVersion !== 7
    || !isInteger(value.tick) || value.tick < 0
    || !isInteger(value.viewerTeamId) || value.viewerTeamId < 1
    || !Array.isArray(value.players)
    || !Array.isArray(value.teams)
    || !Array.isArray(value.ships)
    || !Array.isArray(value.structures)
    || !Array.isArray(value.resourceNodes)
    || !Array.isArray(value.obstacles)
    || !Array.isArray(value.projectiles)
    || !["playing", "finished"].includes(String(value.status))
    || !(value.winnerTeamId === null || (isInteger(value.winnerTeamId) && value.winnerTeamId >= 1))
    || !isInteger(value.checksum)) return false;

  const hasValidViewer = value.viewerPlayerId === null
    ? value.ownLastCommandSequence === null
    : isString(value.viewerPlayerId, 80)
      && isInteger(value.ownLastCommandSequence) && value.ownLastCommandSequence >= 0;
  if (!hasValidViewer) return false;

  // Full SimulationState-only fields must never cross the player-view boundary.
  return !("seed" in value)
    && !("nextEntityId" in value)
    && !("nextTurretId" in value)
    && !("nextQueueItemId" in value)
    && !("commandQueue" in value)
    && !("aiPlayerIds" in value)
    && !("aiCommanders" in value)
    && !("visibility" in value);
}

function isViewFrame(value: JsonRecord): boolean {
  return isInteger(value.tick) && value.tick >= 0
    && isInteger(value.checksum)
    && isProjectedViewState(value.view)
    && value.view.tick === value.tick
    && value.view.checksum === value.checksum
    && !("state" in value);
}

function isReplayManifest(value: unknown): value is ReplayManifest {
  return isRecord(value)
    && value.version === 1
    && value.format === "space-rts-replay"
    && isString(value.matchId, 80)
    && isInteger(value.tick) && value.tick >= 0
    && isInteger(value.checksum)
    && value.status === "finished"
    && (value.physicsBackend === "box3d-wasm" || value.physicsBackend === "deterministic-fallback")
    && (value.winnerTeamId === null || (isInteger(value.winnerTeamId) && value.winnerTeamId >= 1))
    && isFiniteNumber(value.completedAt)
    && isInteger(value.byteLength) && value.byteLength > 0 && value.byteLength <= MAX_REPLAY_BYTES
    && value.chunkBytes === REPLAY_CHUNK_BYTES
    && value.chunkCount === Math.ceil(value.byteLength / REPLAY_CHUNK_BYTES)
    && value.encoding === "base64-json";
}

function isGameCommand(value: unknown): value is GameCommand {
  if (!isRecord(value) || !isString(value.type, 32) || !isString(value.playerId, 80)
    || !isInteger(value.sequence) || value.sequence < 1
    || !isInteger(value.requestedTick) || value.requestedTick < 1) return false;

  if (["move", "attackMove", "patrol", "stop", "hold", "focusFire"].includes(value.type)) {
    if (!Array.isArray(value.unitIds) || value.unitIds.length > 512 || !value.unitIds.every((id) => isInteger(id) && id > 0)
      || typeof value.queued !== "boolean") return false;
    if (value.type === "move" || value.type === "attackMove" || value.type === "patrol") {
      return isVec2(value.destination) && (value.formationEnd === undefined || isVec2(value.formationEnd));
    }
    if (value.type === "focusFire") return isInteger(value.targetEntityId) && value.targetEntityId > 0;
    return true;
  }

  if (value.type === "buildStructure") {
    return hasOwn(PROTOCOL_BUILDABLE_STRUCTURE_TYPES, value.structureType)
      && isVec2(value.position)
      && (value.resourceNodeId === undefined || (isInteger(value.resourceNodeId) && value.resourceNodeId > 0))
      && (value.builderUnitIds === undefined || (Array.isArray(value.builderUnitIds)
        && value.builderUnitIds.length <= 32
        && value.builderUnitIds.every((id) => isInteger(id) && id > 0)))
      && typeof value.queued === "boolean";
  }
  if (value.type === "queueUnit") {
    return isInteger(value.structureId) && value.structureId > 0
      && hasOwn(PROTOCOL_SHIP_CLASSES, value.shipClass)
      && isInteger(value.count) && value.count >= 1 && value.count <= 5;
  }
  if (value.type === "cancelProduction") {
    return isInteger(value.structureId) && value.structureId > 0
      && isInteger(value.queueItemId) && value.queueItemId > 0;
  }
  if (value.type === "setRallyPoint") {
    return isInteger(value.structureId) && value.structureId > 0 && isVec2(value.position);
  }
  return false;
}

export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > MAX_MESSAGE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value) || !isString(value.type, 32)) return null;

  switch (value.type) {
    case "hello":
      return isString(value.name, 32)
        && (value.playerId === undefined || isString(value.playerId, 80))
        && (value.reconnectToken === undefined || isString(value.reconnectToken, 160))
        ? value as ClientMessage : null;
    case "spectate": {
      if (!isString(value.name, 32)) return null;
      if (value.mode === "replay") {
        return value.token === undefined && value.spectatorId === undefined && value.reconnectToken === undefined
          ? value as ClientMessage : null;
      }
      if (value.mode !== "team" || !isString(value.token, 160)) return null;
      const reconnecting = value.spectatorId !== undefined || value.reconnectToken !== undefined;
      return !reconnecting || (isString(value.spectatorId, 80) && isString(value.reconnectToken, 160))
        ? value as ClientMessage : null;
    }
    case "ping":
      return isFiniteNumber(value.clientTime) ? value as ClientMessage : null;
    case "request_snapshot":
      return ["join", "reconnect", "checksum", "manual"].includes(String(value.reason)) ? value as ClientMessage : null;
    case "set_ready":
      return typeof value.ready === "boolean" ? value as ClientMessage : null;
    case "set_team":
      return isInteger(value.teamId) && value.teamId >= 1 && value.teamId <= MAX_PLAYERS
        && (value.playerId === undefined || isString(value.playerId, 80)) ? value as ClientMessage : null;
    case "set_mode":
      return value.mode === "ffa" || value.mode === "teams" ? value as ClientMessage : null;
    case "set_settings":
      return isLobbySettings(value.settings) ? value as ClientMessage : null;
    case "add_ai":
      return (value.name === undefined || isString(value.name, 32))
        && (value.teamId === undefined || (isInteger(value.teamId) && value.teamId >= 1 && value.teamId <= MAX_PLAYERS))
        && (value.difficulty === undefined || ["easy", "normal", "hard"].includes(String(value.difficulty)))
        && (value.personality === undefined || ["balanced", "aggressive", "turtle", "economic"].includes(String(value.personality)))
        ? value as ClientMessage : null;
    case "set_ai_settings":
      return isString(value.playerId, 80)
        && ["easy", "normal", "hard"].includes(String(value.difficulty))
        && ["balanced", "aggressive", "turtle", "economic"].includes(String(value.personality))
        ? value as ClientMessage : null;
    case "remove_slot":
      return isString(value.playerId, 80) ? value as ClientMessage : null;
    case "authorize_spectator":
      return isInteger(value.teamId) && value.teamId >= 1 && value.teamId <= MAX_PLAYERS ? value as ClientMessage : null;
    case "start_match":
      return value as ClientMessage;
    case "commands":
      return Array.isArray(value.commands) && value.commands.length >= 1 && value.commands.length <= MAX_COMMAND_BATCH
        && value.commands.every(isGameCommand) && isInteger(value.clientTick) && value.clientTick >= 0
        && (value.clientChecksum === undefined || isInteger(value.clientChecksum))
        ? value as ClientMessage : null;
    case "checksum":
      return isInteger(value.tick) && value.tick >= 0 && isInteger(value.checksum) ? value as ClientMessage : null;
    case "request_replay_manifest":
      return value as ClientMessage;
    case "request_replay_chunk":
      return isInteger(value.index) && value.index >= 0 && value.index < MAX_REPLAY_CHUNKS ? value as ClientMessage : null;
    default:
      return null;
  }
}

export function parseServerMessage(raw: string): ServerMessage | null {
  if (raw.length > MAX_MESSAGE_BYTES * 16) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value) || !isString(value.type, 32)) return null;
  if ("state" in value || "events" in value || "commands" in value || "seed" in value) return null;
  if (value.type === "match_started" || value.type === "view") {
    return isViewFrame(value) ? value as ServerMessage : null;
  }
  if (value.type === "snapshot") {
    return isViewFrame(value)
      && ["periodic", "join", "reconnect", "checksum", "manual"].includes(String(value.reason))
      ? value as ServerMessage : null;
  }
  if (value.type === "hello_required") {
    return isString(value.matchId, 80) && isLobbyState(value.lobby) ? value as ServerMessage : null;
  }
  if (value.type === "welcome") {
    return isString(value.playerId, 80) && isString(value.reconnectToken, 160)
      && isLobbyState(value.lobby) && isInteger(value.tick) && value.tick >= 0
      ? value as ServerMessage : null;
  }
  if (value.type === "spectator_authorized") {
    return isString(value.token, 160) && value.mode === "team"
      && isInteger(value.teamId) && value.teamId >= 1 && value.teamId <= MAX_PLAYERS
      ? value as ServerMessage : null;
  }
  if (value.type === "spectator_welcome") {
    const reconnectTokenValid = value.mode === "replay"
      ? value.reconnectToken === null && value.teamId === null
      : value.mode === "team" && isString(value.reconnectToken, 160)
        && isInteger(value.teamId) && value.teamId >= 1 && value.teamId <= MAX_PLAYERS;
    return isString(value.spectatorId, 80) && reconnectTokenValid
      && isLobbyState(value.lobby) && isInteger(value.tick) && value.tick >= 0
      ? value as ServerMessage : null;
  }
  if (value.type === "lobby") return isLobbyState(value.lobby) ? value as ServerMessage : null;
  if (value.type === "replay_manifest") {
    return isReplayManifest(value.manifest) ? value as ServerMessage : null;
  }
  if (value.type === "replay_chunk") {
    return isInteger(value.index) && value.index >= 0
      && isInteger(value.chunkCount) && value.chunkCount >= 1 && value.index < value.chunkCount
      && isString(value.data, MAX_MESSAGE_BYTES)
      ? value as ServerMessage : null;
  }
  return [
    "command_results", "checksum", "pong", "error",
  ].includes(value.type) ? value as ServerMessage : null;
}
