import {
  calculateChecksum,
  createCombatScenario,
  projectTeamView,
  ReplayRecorder,
  restoreSimulation,
  SHIPS,
  type GameCommand,
  type CommandResult,
  type GameSimulation,
  type PlayerViewState,
  type ReplayFile,
  type SimulationState,
  type TeamViewState,
} from "@space-rts/game-core";
import {
  DEFAULT_LOBBY_SETTINGS,
  LOCKSTEP_PROTOCOL_VERSION,
  MAX_REPLAY_BYTES,
  MAX_PLAYERS,
  REPLAY_CHUNK_BYTES,
  parseClientMessage,
  type ClientMessage,
  type LobbyPlayerSlot,
  type LobbySettings,
  type LobbyState,
  type MatchMode,
  type ServerMessage,
} from "@space-rts/protocol";
import { SIMULATION_HZ } from "@space-rts/shared";

interface Env {
  MATCH: DurableObjectNamespace;
  /** Local-only opt-in used by the sustained multiplayer load verifier. */
  VOIDFRONT_SOAK_UNITS_PER_PLAYER?: string;
}

interface SocketAttachment {
  playerId: string | null;
  spectatorId?: string;
  spectatorMode?: "team" | "replay";
  spectatorTeamId?: number;
}

interface SpectatorGrant {
  teamId: number;
  issuedByPlayerId: string;
  issuedAt: number;
  spectatorId: string | null;
  spectatorName: string | null;
  reconnectToken: string | null;
}

interface PersistedMatch {
  lobby: LobbyState;
  seed?: number;
  simulation: SimulationState | null;
  reconnectTokens: Record<string, string>;
  spectatorGrants?: Record<string, SpectatorGrant>;
  replay?: ReplayFile | null;
  replayCompletedAt?: number | null;
  aiCounter: number;
  relayTick?: number;
  relayCommands?: GameCommand[];
  relayPlayerStates?: RelayPlayerState[];
}

interface RelayPlayerState {
  tick: number;
  playerId: string;
  state: "playing" | "disconnected";
}

interface PersistedCheckpointPayload {
  simulation: SimulationState | null;
  replay: ReplayFile | null;
  relayTick?: number;
  relayCommands?: GameCommand[];
  relayPlayerStates?: RelayPlayerState[];
}

interface PersistedCheckpointManifest {
  generation: string;
  chunkCount: number;
  byteLength: number;
  sha256: string;
}

interface PersistedMatchMetadata {
  version: 2;
  lobby: LobbyState;
  seed: number;
  reconnectTokens: Record<string, string>;
  spectatorGrants: Record<string, SpectatorGrant>;
  replayCompletedAt: number | null;
  aiCounter: number;
  checkpoint: PersistedCheckpointManifest | null;
  relayTick?: number;
}

const PLAYER_COLORS = [0x59a7ff, 0xff5576, 0x62e6a7, 0xf3b65b, 0xb886ff, 0x55e1e8, 0xff8b55, 0xd8e65b];
const PHYSICS_BACKEND = "client-relay-lockstep";
const PERSIST_INTERVAL_TICKS = SIMULATION_HZ * 300;
const REPLAY_CHECKPOINT_INTERVAL_TICKS = SIMULATION_HZ * 5;
// Keep Spring's lightweight NEWFRAME cadence for smooth interpolation. These
// pulses contain no world data; the expensive traffic was resync snapshots.
const RELAY_FRAME_BATCH_TICKS = 1;
const RELAY_SYNC_INTERVAL_TICKS = SIMULATION_HZ;
// Spring suppresses repeated sync warnings for several hundred frames. A much
// shorter window is enough here because recovery is automatic, but it still
// prevents a broken peer from causing a snapshot storm while it is replaying.
const RELAY_RECOVERY_COOLDOWN_TICKS = SIMULATION_HZ * 4;
const MATCH_METADATA_KEY = "match:metadata:v2";
const LEGACY_MATCH_KEY = "match";
const CHECKPOINT_CHUNK_PREFIX = "match:checkpoint:v2:";
const CHECKPOINT_CHUNK_BYTES = 128 * 1024;
const CHECKPOINT_STORAGE_BATCH = 16;
const MAX_CHECKPOINT_CHUNKS = 2_048;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "voidfront-authority",
        physics: PHYSICS_BACKEND,
        physicsModule: "client-owned",
        simulationHz: SIMULATION_HZ,
      });
    }

    const match = url.pathname.match(/^\/matches\/([a-zA-Z0-9_-]+)(?:\/connect)?$/);
    if (!match?.[1]) {
      return Response.json({
        service: "voidfront-authority",
        routes: ["GET /health", "GET /matches/:id", "WS /matches/:id/connect"],
      });
    }
    const id = env.MATCH.idFromName(match[1]);
    return env.MATCH.get(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;

export class Match implements DurableObject {
  private simulation: GameSimulation | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lobby: LobbyState;
  private seed = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0xc0ffee;
  private reconnectTokens: Record<string, string> = {};
  private spectatorGrants: Record<string, SpectatorGrant> = {};
  private replayRecorder: ReplayRecorder | null = null;
  private replay: ReplayFile | null = null;
  private replayCompletedAt: number | null = null;
  private aiCounter = 0;
  private viewCacheTick = -1;
  private readonly viewCache = new Map<string, PlayerViewState | TeamViewState>();
  private lockstepStateCache: {
    tick: number;
    checksum: number;
    stateJson: string;
    messages: Map<Extract<ServerMessage, { type: "lockstep_state" }>["reason"], string>;
  } | null = null;
  private persistChain: Promise<void> = Promise.resolve();
  private checkpointManifest: PersistedCheckpointManifest | null = null;
  private relayTick = 0;
  private relayCommands: GameCommand[] = [];
  private relayPlayerStates: RelayPlayerState[] = [];
  private readonly relaySequences = new Map<string, number>();
  private readonly syncReports = new Map<number, Map<string, number>>();
  private readonly peerReportedTicks = new Map<string, number>();
  private lastRecoveryTick = -RELAY_RECOVERY_COOLDOWN_TICKS;
  private relayIntervalMs = 1000 / SIMULATION_HZ;
  private relayClockAt = 0;
  private relayClockAccumulatorMs = 0;
  private readonly soakUnitsPerPlayer: number;

  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {
    const requestedSoakUnits = Number(this.env.VOIDFRONT_SOAK_UNITS_PER_PLAYER ?? 0);
    this.soakUnitsPerPlayer = Number.isInteger(requestedSoakUnits)
      && requestedSoakUnits >= 2 && requestedSoakUnits <= 2_000
      ? requestedSoakUnits
      : 0;
    this.lobby = this.createLobby("pending");
    this.ctx.blockConcurrencyWhile(async () => {
      const persisted = await this.loadPersistedMatch();
      if (!persisted) return;
      const legacySeed = (persisted.lobby as LobbyState & { seed?: unknown }).seed;
      this.seed = persisted.seed ?? (typeof legacySeed === "number" ? legacySeed : this.seed);
      const restoredLobby = persisted.lobby as LobbyState & { settings?: LobbySettings };
      this.lobby = this.redactLobby({
        ...restoredLobby,
        settings: { ...DEFAULT_LOBBY_SETTINGS, ...restoredLobby.settings },
        slots: restoredLobby.slots.map((slot) => slot.isAi ? {
          ...slot,
          aiDifficulty: slot.aiDifficulty ?? "normal",
          aiPersonality: slot.aiPersonality ?? "balanced",
        } : slot),
      });
      if (this.lobby.phase === "lobby" && !this.lobby.slots.some((slot) => slot.isHost)) {
        const fallbackHost = this.lobby.slots.find((slot) => !slot.isAi);
        if (fallbackHost) fallbackHost.isHost = true;
      }
      this.reconnectTokens = persisted.reconnectTokens;
      this.spectatorGrants = persisted.spectatorGrants ?? {};
      this.replay = persisted.replay ?? null;
      this.replayCompletedAt = persisted.replayCompletedAt ?? null;
      this.aiCounter = persisted.aiCounter;
      this.relayTick = persisted.relayTick ?? persisted.simulation?.tick ?? 0;
      this.relayCommands = persisted.relayCommands ?? [];
      this.relayPlayerStates = persisted.relayPlayerStates ?? [];
      for (const command of this.relayCommands) {
        this.relaySequences.set(command.playerId, Math.max(this.relaySequences.get(command.playerId) ?? 0, command.sequence));
      }
      if (persisted.simulation) {
        this.simulation = restoreSimulation(persisted.simulation);
        if (this.replay && !this.replay.finalized) {
          this.replayRecorder = ReplayRecorder.resume(this.simulation, this.replay, {
            checkpointIntervalTicks: REPLAY_CHECKPOINT_INTERVAL_TICKS,
          });
          if (this.simulation.state.status === "finished") {
            this.replay = this.replayRecorder.finalize();
            this.replayRecorder = null;
            this.replayCompletedAt ??= Date.now();
            this.lobby.phase = "finished";
            await this.persistCheckpoint();
          }
        }
        if (this.lobby.phase === "playing" && this.ctx.getWebSockets().length > 0) {
          this.ensureTicking();
        }
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const routeMatchId = url.pathname.match(/^\/matches\/([a-zA-Z0-9_-]+)/)?.[1];
    if (routeMatchId && this.lobby.matchId === "pending") {
      this.lobby.matchId = routeMatchId;
      this.ctx.waitUntil(this.persistMetadata());
    }

    const upgrade = request.headers.get("Upgrade");
    if (upgrade?.toLowerCase() !== "websocket") {
      return Response.json({
        lobby: this.publicLobby(),
        tick: this.simulation?.state.tick ?? 0,
        connections: this.ctx.getWebSockets().length,
        physics: PHYSICS_BACKEND,
      });
    }

    if (!url.pathname.endsWith("/connect")) {
      return Response.json({ error: "WebSockets connect at /matches/:id/connect" }, { status: 400 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ playerId: null } satisfies SocketAttachment);
    this.send(server, {
      type: "hello_required",
      matchId: this.lobby.matchId,
      lobby: this.publicLobby(),
      lockstepVersion: LOCKSTEP_PROTOCOL_VERSION,
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): void {
    if (typeof raw !== "string") {
      this.fail(socket, "invalid_message", "Expected a JSON text message");
      return;
    }
    const message = parseClientMessage(raw);
    if (!message) {
      this.fail(socket, "invalid_message", "Malformed or unsupported protocol message");
      return;
    }
    const attachment = this.attachment(socket);
    if (message.type === "hello") {
      if (attachment.playerId || attachment.spectatorId) {
        this.fail(socket, "already_authenticated", "This connection already has a match role");
        return;
      }
      if (message.lockstepVersion !== LOCKSTEP_PROTOCOL_VERSION) {
        this.fail(socket, "client_update_required", "Game rules changed; reload the page before joining this match");
        return;
      }
      this.handleHello(socket, message);
      return;
    }
    if (message.type === "spectate") {
      if (attachment.playerId || attachment.spectatorId) {
        this.fail(socket, "already_authenticated", "This connection already has a match role");
        return;
      }
      if (message.lockstepVersion !== LOCKSTEP_PROTOCOL_VERSION) {
        this.fail(socket, "client_update_required", "Game rules changed; reload the page before joining this match");
        return;
      }
      this.handleSpectate(socket, message);
      return;
    }

    if (attachment.spectatorId && attachment.spectatorMode) {
      this.handleSpectatorMessage(socket, attachment, message);
      return;
    }
    const playerId = attachment.playerId;
    if (!playerId) {
      this.fail(socket, "hello_required", "Introduce this connection before sending match messages");
      return;
    }
    this.handlePlayerMessage(socket, playerId, message);
  }

  webSocketClose(socket: WebSocket, _code: number, _reason: string): void {
    const playerId = this.attachment(socket).playerId;
    if (playerId) this.disconnectPlayer(playerId);
    if (this.ctx.getWebSockets().length === 0) this.stopTicking();
  }

  webSocketError(socket: WebSocket): void {
    const playerId = this.attachment(socket).playerId;
    if (playerId) this.disconnectPlayer(playerId);
    socket.close(1011, "WebSocket error");
    if (this.ctx.getWebSockets().length === 0) this.stopTicking();
  }

  private createLobby(matchId: string): LobbyState {
    return {
      matchId,
      phase: "lobby",
      mode: "teams",
      settings: { ...DEFAULT_LOBBY_SETTINGS },
      maxPlayers: MAX_PLAYERS,
      slots: [],
      createdAt: Date.now(),
    };
  }

  private handleHello(socket: WebSocket, message: Extract<ClientMessage, { type: "hello" }>): void {
    const requestedId = message.playerId;
    const reconnecting = requestedId !== undefined
      && message.reconnectToken !== undefined
      && this.reconnectTokens[requestedId] === message.reconnectToken;
    let slot = reconnecting
      ? this.lobby.slots.find((candidate) => candidate.playerId === requestedId && !candidate.isAi)
      : undefined;

    if (!slot) {
      if (this.lobby.phase !== "lobby") {
        this.fail(socket, "match_in_progress", "This match has already started; reconnect with the original token");
        return;
      }
      if (requestedId && this.lobby.slots.some((candidate) => candidate.playerId === requestedId)) {
        this.fail(socket, "player_taken", "That pilot identity is already in this lobby");
        return;
      }
      if (this.lobby.slots.length >= Math.min(this.lobby.maxPlayers, this.mapPlayerCapacity())) {
        this.fail(socket, "map_capacity", `The selected map size supports up to ${this.mapPlayerCapacity()} commanders`);
        return;
      }
      const playerId = requestedId ?? `pilot-${crypto.randomUUID()}`;
      const slotIndex = this.nextSlotIndex();
      const becomesHost = !this.lobby.slots.some((candidate) => !candidate.isAi && candidate.isHost && candidate.connected);
      if (becomesHost) {
        for (const candidate of this.lobby.slots) candidate.isHost = false;
      }
      slot = {
        playerId,
        name: message.name.trim().slice(0, 32),
        slotIndex,
        teamId: this.lobby.mode === "ffa" ? slotIndex + 1 : this.smallestTeam(),
        color: PLAYER_COLORS[slotIndex]!,
        ready: false,
        connected: true,
        isHost: becomesHost,
        isAi: false,
      };
      this.lobby.slots.push(slot);
      this.reconnectTokens[playerId] = this.createReconnectToken();
    } else {
      slot.connected = true;
      slot.name = message.name.trim().slice(0, 32);
      socket.serializeAttachment({ playerId: slot.playerId } satisfies SocketAttachment);
      for (const candidate of this.ctx.getWebSockets()) {
        if (candidate !== socket && this.attachment(candidate).playerId === slot.playerId) {
          candidate.close(4001, "Reconnected from another client");
        }
      }
    }

    if (this.lobby.phase === "lobby" && !this.lobby.slots.some((candidate) => candidate.isHost)) {
      slot.isHost = true;
    }

    socket.serializeAttachment({ playerId: slot.playerId } satisfies SocketAttachment);
    const lastRelayState = [...this.relayPlayerStates].reverse().find((entry) => entry.playerId === slot.playerId)?.state;
    if (this.simulation && lastRelayState === "disconnected") {
      this.relayPlayerStates.push({ tick: this.relayTick, playerId: slot.playerId, state: "playing" });
      this.broadcastPlayerState(slot.playerId, "playing", socket);
    }
    this.sortSlots();
    this.send(socket, {
      type: "welcome",
      playerId: slot.playerId,
      reconnectToken: this.reconnectTokens[slot.playerId]!,
      lobby: this.publicLobby(),
      tick: this.relayTick,
    });
    if (this.simulation) {
      this.sendSnapshot(socket, reconnecting ? "reconnect" : "join");
      this.sendRelayHistory(socket);
      this.ensureTicking();
    }
    this.broadcastLobby();
    this.ctx.waitUntil(this.persist());
  }

  private handleSpectate(socket: WebSocket, message: Extract<ClientMessage, { type: "spectate" }>): void {
    if (message.mode === "replay") {
      if (this.lobby.phase !== "finished" || !this.replay?.finalized || !this.replayCompletedAt) {
        this.fail(socket, "spectator_unauthorized", "Spectator access is unavailable");
        return;
      }
      const spectatorId = `replay-${crypto.randomUUID()}`;
      socket.serializeAttachment({
        playerId: null,
        spectatorId,
        spectatorMode: "replay",
      } satisfies SocketAttachment);
      this.send(socket, {
        type: "spectator_welcome",
        spectatorId,
        reconnectToken: null,
        mode: "replay",
        teamId: null,
        lobby: this.publicLobby(),
        tick: this.replay.result.tick,
      });
      return;
    }

    const grant = message.token ? this.spectatorGrants[message.token] : undefined;
    const grantIssuer = grant
      ? this.lobby.slots.find((slot) => slot.playerId === grant.issuedByPlayerId && slot.teamId === grant.teamId)
      : undefined;
    const reconnecting = message.spectatorId !== undefined || message.reconnectToken !== undefined;
    if (!grant || !grantIssuer
      || (grant.spectatorId === null && reconnecting)
      || (grant.spectatorId !== null && (!reconnecting
        || message.spectatorId !== grant.spectatorId
        || message.reconnectToken !== grant.reconnectToken))) {
      this.fail(socket, "spectator_unauthorized", "Spectator access is unavailable");
      return;
    }

    if (grant.spectatorId === null) {
      grant.spectatorId = `spectator-${crypto.randomUUID()}`;
      grant.spectatorName = message.name.trim().slice(0, 32);
      grant.reconnectToken = this.createReconnectToken();
    } else {
      grant.spectatorName = message.name.trim().slice(0, 32);
    }
    const spectatorId = grant.spectatorId;
    socket.serializeAttachment({
      playerId: null,
      spectatorId,
      spectatorMode: "team",
      spectatorTeamId: grant.teamId,
    } satisfies SocketAttachment);
    for (const candidate of this.ctx.getWebSockets()) {
      if (candidate !== socket && this.attachment(candidate).spectatorId === spectatorId) {
        candidate.close(4001, "Reconnected from another client");
      }
    }
    this.send(socket, {
      type: "spectator_welcome",
      spectatorId,
      reconnectToken: grant.reconnectToken,
      mode: "team",
      teamId: grant.teamId,
      lobby: this.publicLobby(),
      tick: this.relayTick,
    });
    if (this.simulation) {
      this.sendSnapshot(socket, reconnecting ? "reconnect" : "join");
      this.sendRelayHistory(socket);
      this.ensureTicking();
    }
    this.ctx.waitUntil(this.persist());
  }

  private handleSpectatorMessage(
    socket: WebSocket,
    attachment: SocketAttachment,
    message: Exclude<ClientMessage, { type: "hello" | "spectate" }>,
  ): void {
    if (message.type === "ping") {
      this.send(socket, {
        type: "pong",
        clientTime: message.clientTime,
        serverTime: Date.now(),
        tick: this.relayTick || this.replay?.result.tick || 0,
      });
      return;
    }
    if (message.type === "request_replay_manifest") {
      this.sendReplayManifest(socket);
      return;
    }
    if (message.type === "request_replay_chunk") {
      this.sendReplayChunk(socket, message.index);
      return;
    }
    if (attachment.spectatorMode === "team" && message.type === "request_snapshot") {
      if (this.simulation) this.sendSnapshot(socket, message.reason);
      return;
    }
    if (attachment.spectatorMode === "team" && message.type === "checksum") {
      const state = this.simulation?.state;
      if (state && message.tick === state.tick && message.checksum !== state.checksum) {
        this.sendSnapshot(socket, "checksum");
      }
      return;
    }
    this.fail(socket, "spectator_read_only", "Spectators cannot send match commands or change the lobby");
  }

  private handlePlayerMessage(
    socket: WebSocket,
    playerId: string,
    message: Exclude<ClientMessage, { type: "hello" | "spectate" }>,
  ): void {
    const slot = this.lobby.slots.find((candidate) => candidate.playerId === playerId);
    if (!slot) {
      this.fail(socket, "unknown_player", "This pilot no longer occupies a lobby slot");
      return;
    }

    switch (message.type) {
      case "ping":
        this.send(socket, {
          type: "pong",
          clientTime: message.clientTime,
          serverTime: Date.now(),
          tick: this.relayTick,
        });
        return;
      case "request_snapshot":
        if (this.simulation) {
          this.sendSnapshot(socket, message.reason);
          this.sendRelayHistory(socket);
        }
        return;
      case "set_ready":
        if (!this.requireLobby(socket)) return;
        slot.ready = message.ready;
        this.lobbyChanged();
        return;
      case "set_team":
        if (!this.requireLobby(socket)) return;
        if (this.lobby.mode !== "teams") {
          this.fail(socket, "ffa_teams_locked", "Free-for-all gives every pilot a separate team");
          return;
        }
        const targetSlot = message.playerId
          ? this.lobby.slots.find((candidate) => candidate.playerId === message.playerId)
          : slot;
        if (!targetSlot) {
          this.fail(socket, "slot_missing", "That commander is no longer in the lobby");
          return;
        }
        if (targetSlot.playerId !== slot.playerId && !slot.isHost) {
          this.fail(socket, "host_required", "Only the host can assign another commander's team");
          return;
        }
        targetSlot.teamId = message.teamId;
        if (!targetSlot.isAi) targetSlot.ready = false;
        this.lobbyChanged();
        return;
      case "set_mode":
        if (!this.requireHost(socket, slot) || !this.requireLobby(socket)) return;
        this.setMode(message.mode);
        this.lobbyChanged();
        return;
      case "set_settings":
        if (!this.requireHost(socket, slot) || !this.requireLobby(socket)) return;
        if (this.lobby.slots.length > this.playerCapacityForSize(message.settings.mapSize)) {
          this.fail(socket, "map_capacity", `That map size supports up to ${this.playerCapacityForSize(message.settings.mapSize)} commanders`);
          return;
        }
        this.setSettings(message.settings);
        this.lobbyChanged();
        return;
      case "add_ai":
        if (!this.requireHost(socket, slot) || !this.requireLobby(socket)) return;
        this.addAi(socket, message);
        return;
      case "set_ai_settings": {
        if (!this.requireHost(socket, slot) || !this.requireLobby(socket)) return;
        const aiSlot = this.lobby.slots.find((candidate) => candidate.playerId === message.playerId && candidate.isAi);
        if (!aiSlot) {
          this.fail(socket, "ai_slot_missing", "That AI commander is no longer in the lobby");
          return;
        }
        aiSlot.aiDifficulty = message.difficulty;
        aiSlot.aiPersonality = message.personality;
        this.lobbyChanged();
        return;
      }
      case "remove_slot":
        if (!this.requireHost(socket, slot) || !this.requireLobby(socket)) return;
        this.removeSlot(socket, playerId, message.playerId);
        return;
      case "authorize_spectator":
        if (!this.requireHost(socket, slot)) return;
        if (this.lobby.phase === "finished") {
          this.fail(socket, "spectator_grants_closed", "Team spectator grants close when the match finishes");
          return;
        }
        if (message.teamId !== slot.teamId) {
          this.fail(socket, "spectator_team_forbidden", "Hosts can authorize spectators only for their own team");
          return;
        }
        this.authorizeSpectator(socket, playerId, message.teamId);
        return;
      case "start_match":
        if (!this.requireHost(socket, slot) || !this.requireLobby(socket)) return;
        this.startMatch(socket);
        return;
      case "commands":
        this.handleCommands(socket, playerId, message);
        return;
      case "checksum":
        this.recordSyncReport(playerId, message.tick, message.checksum);
        return;
      case "match_finished":
        if (this.lobby.phase === "playing" && message.tick <= this.relayTick) {
          this.lobby.phase = "finished";
          this.replayCompletedAt = Date.now();
          this.stopTicking();
          this.broadcastLobby();
          this.ctx.waitUntil(this.persistCheckpoint());
        }
        return;
      case "request_replay_manifest":
        this.sendReplayManifest(socket);
        return;
      case "request_replay_chunk":
        this.sendReplayChunk(socket, message.index);
        return;
    }
  }

  private authorizeSpectator(socket: WebSocket, playerId: string, teamId: number): void {
    if (!this.lobby.slots.some((slot) => slot.teamId === teamId)) {
      this.fail(socket, "spectator_team_unknown", "That spectator team does not exist");
      return;
    }
    const token = this.createReconnectToken();
    this.spectatorGrants[token] = {
      teamId,
      issuedByPlayerId: playerId,
      issuedAt: Date.now(),
      spectatorId: null,
      spectatorName: null,
      reconnectToken: null,
    };
    this.send(socket, { type: "spectator_authorized", token, mode: "team", teamId });
    this.ctx.waitUntil(this.persist());
  }

  private addAi(socket: WebSocket, message: Extract<ClientMessage, { type: "add_ai" }>): void {
    if (this.lobby.slots.length >= Math.min(this.lobby.maxPlayers, this.mapPlayerCapacity())) {
      this.fail(socket, "map_capacity", `The selected map size supports up to ${this.mapPlayerCapacity()} commanders`);
      return;
    }
    this.aiCounter += 1;
    const slotIndex = this.nextSlotIndex();
    const ai: LobbyPlayerSlot = {
      playerId: `ai-${this.aiCounter}`,
      name: message.name?.trim().slice(0, 32) ?? `Relay AI ${this.aiCounter}`,
      slotIndex,
      teamId: this.lobby.mode === "ffa" ? slotIndex + 1 : message.teamId ?? this.smallestTeam(),
      color: PLAYER_COLORS[slotIndex]!,
      ready: true,
      connected: true,
      isHost: false,
      isAi: true,
      aiDifficulty: message.difficulty ?? "normal",
      aiPersonality: message.personality ?? "balanced",
    };
    this.lobby.slots.push(ai);
    this.lobbyChanged();
  }

  private removeSlot(socket: WebSocket, actingPlayerId: string, targetPlayerId: string): void {
    if (actingPlayerId === targetPlayerId) {
      this.fail(socket, "host_cannot_remove_self", "Transfer host by leaving the lobby instead");
      return;
    }
    const index = this.lobby.slots.findIndex((candidate) => candidate.playerId === targetPlayerId);
    if (index < 0) {
      this.fail(socket, "unknown_slot", "That lobby slot no longer exists");
      return;
    }
    this.lobby.slots.splice(index, 1);
    delete this.reconnectTokens[targetPlayerId];
    for (const candidate of this.ctx.getWebSockets()) {
      if (this.attachment(candidate).playerId === targetPlayerId) candidate.close(4002, "Removed from lobby");
    }
    this.lobbyChanged();
  }

  private startMatch(socket: WebSocket): void {
    const humans = this.lobby.slots.filter((slot) => !slot.isAi);
    if (this.lobby.slots.length < 2) {
      this.fail(socket, "not_enough_players", "Add at least one pilot or AI opponent");
      return;
    }
    if (humans.some((slot) => !slot.connected || !slot.ready)) {
      this.fail(socket, "players_not_ready", "Every human pilot must be connected and ready");
      return;
    }
    if (new Set(this.lobby.slots.map((slot) => slot.teamId)).size < 2) {
      this.fail(socket, "one_team", "A match needs at least two opposing teams");
      return;
    }
    if (this.lobby.slots.length > this.mapPlayerCapacity()) {
      this.fail(socket, "map_capacity", `The selected map size supports up to ${this.mapPlayerCapacity()} commanders`);
      return;
    }

    this.simulation = createCombatScenario({
      seed: this.seed,
      ...this.lobby.settings,
      startingFleet: this.soakUnitsPerPlayer > 0,
      fightersPerTeam: Math.max(0, this.soakUnitsPerPlayer - 2),
      bombersPerTeam: 0,
      players: this.lobby.slots.map((slot) => ({
        id: slot.playerId,
        name: slot.name,
        teamId: slot.teamId,
        color: slot.color,
        ai: slot.isAi,
        aiDifficulty: slot.aiDifficulty ?? "normal",
        aiPersonality: slot.aiPersonality ?? "balanced",
      })),
    });
    if (this.soakUnitsPerPlayer > 0) this.configureSoakBattle(this.soakUnitsPerPlayer);
    if (this.soakUnitsPerPlayer === 0 && this.simulation.state.ships.length !== 0) {
      throw new Error("Authoritative matches must begin without free ships");
    }
    // Spring-style relay lockstep: this state is the immutable bootstrap. From
    // here on clients simulate, while the Durable Object only sequences frames
    // and commands. This deliberately trades server-side anti-cheat for scale.
    this.replayRecorder = null;
    this.replay = null;
    this.replayCompletedAt = null;
    this.relayTick = this.simulation.state.tick;
    this.relayCommands = [];
    this.relayPlayerStates = [];
    this.relaySequences.clear();
    this.syncReports.clear();
    this.peerReportedTicks.clear();
    this.lastRecoveryTick = -RELAY_RECOVERY_COOLDOWN_TICKS;
    this.invalidatePlayerViews();
    this.lobby.phase = "playing";
    this.broadcastLockstepState("start");
    this.broadcastLobby();
    this.ensureTicking();
    this.ctx.waitUntil(this.persistCheckpoint());
  }

  private configureSoakBattle(unitsPerPlayer: number): void {
    if (!this.simulation || this.simulation.state.players.length < 2) {
      throw new Error("The multiplayer soak fixture requires at least two players");
    }
    const state = this.simulation.state;
    const shipClassForIndex = (index: number): keyof typeof SHIPS => {
      const progress = index / unitsPerPlayer;
      if (progress < 0.75) return "fighter";
      if (progress < 0.85) return "frigate";
      if (progress < 0.9) return "flakFrigate";
      if (progress < 0.9375) return "torpedoFrigate";
      if (progress < 0.9625) return "destroyer";
      if (progress < 0.9825) return "cruiser";
      if (progress < 0.9925) return "carrier";
      return "battleship";
    };

    const teamIds = [...new Set(state.players.map((player) => player.teamId))].sort((left, right) => left - right);
    if (teamIds.length !== 2) throw new Error("The multiplayer soak fixture requires exactly two opposing teams");
    state.nextTurretId = 1;
    for (let playerIndex = 0; playerIndex < state.players.length; playerIndex += 1) {
      const player = state.players[playerIndex]!;
      const teamIndex = teamIds.indexOf(player.teamId);
      const teammates = state.players.filter((candidate) => candidate.teamId === player.teamId);
      const teammateIndex = teammates.findIndex((candidate) => candidate.id === player.id);
      const side = teamIndex === 0 ? -1 : 1;
      const laneOffset = (teammateIndex - (teammates.length - 1) / 2) * 1_250;
      const fleet = state.ships.filter((ship) => ship.ownerPlayerId === player.id);
      if (fleet.length !== unitsPerPlayer) {
        throw new Error(`Soak fixture created ${fleet.length} of ${unitsPerPlayer} units for ${player.id}`);
      }
      for (let index = 0; index < fleet.length; index += 1) {
        const ship = fleet[index]!;
        const shipClass = shipClassForIndex(index);
        const definition = SHIPS[shipClass];
        const capitalRankStart = Math.ceil(unitsPerPlayer * 0.9375);
        const isCapitalRank = index >= capitalRankStart;
        const localIndex = isCapitalRank ? index - capitalRankStart : index;
        const columns = isCapitalRank ? 8 : 32;
        const spacing = isCapitalRank ? 120 : 32;
        const row = Math.floor(localIndex / columns);
        const column = localIndex % columns;
        ship.class = shipClass;
        ship.x = laneOffset + (column - (columns - 1) / 2) * spacing;
        ship.z = side * ((isCapitalRank ? 1_250 : 125) + row * spacing);
        ship.yaw = side < 0 ? 0 : Math.PI;
        ship.vx = 0;
        ship.vz = 0;
        ship.health = definition.maxHealth * 20;
        ship.shields = definition.maxShield * 20;
        ship.focusTargetEntityId = null;
        ship.orders = [{ type: "attackMove", destination: { x: 0, z: 0 }, facing: ship.yaw }];
        ship.turrets = definition.hardpoints.map((hardpoint) => {
          const turretId = state.nextTurretId++;
          return {
            id: turretId,
            parentShipId: ship.id,
            weaponTypeId: hardpoint.weaponTypeId,
            localX: hardpoint.localX,
            localZ: hardpoint.localZ,
            yawCenter: hardpoint.yawCenter,
            yawHalfArc: hardpoint.yawHalfArc,
            currentYaw: hardpoint.yawCenter,
            targetEntityId: null,
            cooldownRemaining: turretId * 7 % SHIPS[shipClass].hardpoints.length,
            fireSequence: 0,
          };
        });
      }
    }
    state.checksum = calculateChecksum(state);
  }

  private handleCommands(
    socket: WebSocket,
    playerId: string,
    message: Extract<ClientMessage, { type: "commands" }>,
  ): void {
    if (!this.simulation || this.lobby.phase !== "playing") {
      this.fail(socket, "match_not_playing", "Commands are accepted only during an active match");
      return;
    }
    const accepted: GameCommand[] = [];
    const outcomes = message.commands.map((command) => {
      // The command must have enough lead time not only to reach the authority,
      // but also to be rebroadcast to every lockstep mirror before execution.
      // Use the sender's observed tick lag as a conservative return-trip estimate.
      const observedLagTicks = Math.max(0, this.relayTick - message.clientTick);
      const deliveryLeadTicks = Math.min(32, Math.max(4, observedLagTicks + 4));
      const requestedTick = Math.max(
        command.requestedTick,
        this.relayTick + deliveryLeadTicks,
      );
      const authoritative = { ...command, playerId, requestedTick } as GameCommand;
      const player = this.simulation!.state.players.find((candidate) => candidate.id === playerId);
      const lastSequence = this.relaySequences.get(playerId) ?? 0;
      const result: CommandResult = !player
        ? { accepted: false as const, reason: "unknownPlayer" }
        : authoritative.sequence <= lastSequence
          ? { accepted: false as const, reason: "duplicate" }
          : requestedTick > this.relayTick + 40
            ? { accepted: false as const, reason: "timing" }
            : { accepted: true as const, scheduledTick: requestedTick };
      if (result.accepted && player) {
        this.relaySequences.set(playerId, authoritative.sequence);
        accepted.push(authoritative);
        this.relayCommands.push(structuredClone(authoritative));
      }
      return { sequence: authoritative.sequence, commandType: authoritative.type, result };
    });
    this.send(socket, { type: "command_results", tick: this.relayTick, outcomes });
    if (accepted.length > 0) {
      this.broadcast({ type: "lockstep_commands", commands: accepted });
      this.invalidatePlayerViews();
      this.invalidateLockstepState();
    }
  }

  private setMode(mode: MatchMode): void {
    this.lobby.mode = mode;
    this.sortSlots();
    for (let index = 0; index < this.lobby.slots.length; index += 1) {
      const slot = this.lobby.slots[index]!;
      slot.teamId = mode === "ffa" ? slot.slotIndex + 1 : index % 2 + 1;
      if (!slot.isAi) slot.ready = false;
    }
  }

  private setSettings(settings: LobbySettings): void {
    this.lobby.settings = { ...settings };
    for (const slot of this.lobby.slots) if (!slot.isAi) slot.ready = false;
  }

  private disconnectPlayer(playerId: string): void {
    const slot = this.lobby.slots.find((candidate) => candidate.playerId === playerId && !candidate.isAi);
    if (!slot) return;
    const stillConnected = this.ctx.getWebSockets().some(
      (candidate) => this.attachment(candidate).playerId === playerId && candidate.readyState === WebSocket.OPEN,
    );
    if (stillConnected) return;
    slot.connected = false;
    if (this.lobby.phase === "lobby" && slot.isHost) {
      const successor = this.lobby.slots.find((candidate) => !candidate.isAi && candidate.connected);
      if (successor) {
        slot.isHost = false;
        successor.isHost = true;
      }
    }
    if (this.simulation && this.lobby.phase === "playing") {
      this.relayPlayerStates.push({ tick: this.relayTick, playerId, state: "disconnected" });
      this.broadcastPlayerState(playerId, "disconnected");
    }
    this.broadcastLobby();
    this.ctx.waitUntil(this.persist());
  }

  private tick(): void {
    if (!this.simulation || this.lobby.phase !== "playing") return;
    const now = Date.now();
    if (this.relayClockAt === 0) this.relayClockAt = now;
    this.relayClockAccumulatorMs += Math.min(1_000, Math.max(0, now - this.relayClockAt));
    this.relayClockAt = now;
    const ticksDue = Math.min(4, Math.floor(this.relayClockAccumulatorMs / this.relayIntervalMs));
    if (ticksDue === 0) return;
    this.relayClockAccumulatorMs -= ticksDue * this.relayIntervalMs;
    for (let index = 0; index < ticksDue; index += 1) {
      this.relayTick += 1;
      if (this.relayTick % RELAY_FRAME_BATCH_TICKS === 0) {
        this.broadcast({ type: "lockstep_frame", tick: this.relayTick, checksum: 0 });
      }
      if (this.relayTick % PERSIST_INTERVAL_TICKS === 0) this.ctx.waitUntil(this.persistCheckpoint());
    }
  }

  private sendRelayHistory(socket: WebSocket): void {
    for (let offset = 0; offset < this.relayCommands.length; offset += 32) {
      this.send(socket, { type: "lockstep_commands", commands: this.relayCommands.slice(offset, offset + 32) });
    }
    for (const transition of this.relayPlayerStates) {
      this.send(socket, { type: "lockstep_player_state", ...transition });
    }
    if (this.simulation && this.relayTick > this.simulation.state.tick) {
      this.send(socket, { type: "lockstep_frame", tick: this.relayTick, checksum: 0 });
    }
  }

  private recordSyncReport(playerId: string, tick: number, checksum: number): void {
    if (tick <= 0 || tick > this.relayTick || tick % RELAY_SYNC_INTERVAL_TICKS !== 0) return;
    const reports = this.syncReports.get(tick) ?? new Map<string, number>();
    reports.set(playerId, checksum);
    this.peerReportedTicks.set(playerId, Math.max(this.peerReportedTicks.get(playerId) ?? 0, tick));
    this.syncReports.set(tick, reports);
    const connectedHumans = this.lobby.slots.filter((slot) => !slot.isAi && slot.connected);
    if (connectedHumans.length > 1 && connectedHumans.every((slot) => reports.has(slot.playerId))) {
      const checksumGroups = new Map<number, string[]>();
      for (const slot of connectedHumans) {
        const peerChecksum = reports.get(slot.playerId)!;
        const members = checksumGroups.get(peerChecksum) ?? [];
        members.push(slot.playerId);
        checksumGroups.set(peerChecksum, members);
      }
      if (checksumGroups.size > 1) {
        const orderedGroups = [...checksumGroups.entries()].sort((left, right) => {
          const countDifference = right[1].length - left[1].length;
          return countDifference !== 0 ? countDifference : left[0] - right[0];
        });
        const majority = orderedGroups[0]!;
        const hasStrictMajority = majority[1].length > connectedHumans.length / 2;
        // A dedicated Spring server uses the checksum held by most players as
        // its baseline. We can go one step further and rebuild only that
        // minority from our immutable bootstrap and ordered command journal.
        // With a tied result (especially 1v1), there is no trustworthy peer,
        // so every client is rebuilt from the common deterministic history.
        const recoveryIds = hasStrictMajority
          ? new Set(connectedHumans
            .map((slot) => slot.playerId)
            .filter((id) => reports.get(id) !== majority[0]))
          : new Set(connectedHumans.map((slot) => slot.playerId));
        if (tick - this.lastRecoveryTick < RELAY_RECOVERY_COOLDOWN_TICKS) {
          this.syncReports.delete(tick);
          return;
        }
        this.lastRecoveryTick = tick;
        for (const id of recoveryIds) {
          this.peerReportedTicks.set(id, this.simulation?.state.tick ?? 0);
        }
        for (const candidate of this.ctx.getWebSockets()) {
          const id = this.attachment(candidate).playerId;
          if (id && recoveryIds.has(id)) {
            const recoveryScope = hasStrictMajority ? "this peer" : "all peers";
            this.fail(candidate, "lockstep_desync", `Simulation mismatch at tick ${tick}; rebuilding ${recoveryScope}`);
            this.sendSnapshot(candidate, "checksum");
            this.sendRelayHistory(candidate);
          }
        }
        this.syncReports.clear();
        this.adjustRelayPacing();
        return;
      }
      this.syncReports.delete(tick);
    }
    for (const reportTick of this.syncReports.keys()) {
      if (reportTick < this.relayTick - RELAY_SYNC_INTERVAL_TICKS * 4) this.syncReports.delete(reportTick);
    }
    this.adjustRelayPacing();
  }

  private adjustRelayPacing(): void {
    const connected = this.lobby.slots.filter((slot) => !slot.isAi && slot.connected);
    if (connected.length === 0) return;
    const worstLag = connected.reduce((largest, slot) => {
      // A peer that has not produced a sync response is not assumed healthy.
      // Starting it at the bootstrap tick makes the relay naturally slow down
      // while a joining or recovering browser catches up.
      const reported = this.peerReportedTicks.get(slot.playerId) ?? this.simulation?.state.tick ?? 0;
      return Math.max(largest, this.relayTick - reported);
    }, 0);
    const intervalMs = worstLag > SIMULATION_HZ ? 100
      : worstLag > 8 ? 1000 / 15
      : 1000 / SIMULATION_HZ;
    if (Math.abs(intervalMs - this.relayIntervalMs) < 1) return;
    this.relayIntervalMs = intervalMs;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.relayClockAt = Date.now();
      this.timer = setInterval(() => this.tick(), this.relayIntervalMs);
    }
  }

  private ensureTicking(): void {
    if (this.timer !== undefined || !this.simulation || this.lobby.phase !== "playing") return;
    this.relayClockAt = Date.now();
    this.relayClockAccumulatorMs = 0;
    this.timer = setInterval(() => this.tick(), this.relayIntervalMs);
  }

  private stopTicking(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private requireLobby(socket: WebSocket): boolean {
    if (this.lobby.phase === "lobby") return true;
    this.fail(socket, "lobby_locked", "Lobby settings are locked after launch");
    return false;
  }

  private requireHost(socket: WebSocket, slot: LobbyPlayerSlot): boolean {
    if (slot.isHost) return true;
    this.fail(socket, "host_only", "Only the lobby host can do that");
    return false;
  }

  private lobbyChanged(): void {
    this.sortSlots();
    this.revokeInvalidSpectatorGrants();
    this.broadcastLobby();
    this.ctx.waitUntil(this.persist());
  }

  private revokeInvalidSpectatorGrants(): void {
    for (const [token, grant] of Object.entries(this.spectatorGrants)) {
      const remainsOwnTeam = this.lobby.slots.some(
        (slot) => slot.playerId === grant.issuedByPlayerId && slot.teamId === grant.teamId,
      );
      if (remainsOwnTeam) continue;
      delete this.spectatorGrants[token];
      if (!grant.spectatorId) continue;
      for (const socket of this.ctx.getWebSockets()) {
        if (this.attachment(socket).spectatorId === grant.spectatorId) {
          socket.close(4003, "Spectator grant revoked");
        }
      }
    }
  }

  private publicLobby(): LobbyState {
    return this.redactLobby(this.lobby);
  }

  private redactLobby(lobby: LobbyState): LobbyState {
    const { seed: _seed, ...publicLobby } = lobby as LobbyState & { seed?: number };
    return structuredClone(publicLobby);
  }

  private broadcastLobby(): void {
    this.broadcast({ type: "lobby", lobby: this.publicLobby() });
  }

  private sendSnapshot(socket: WebSocket, reason: Extract<ServerMessage, { type: "snapshot" }>["reason"]): void {
    if (!this.simulation) return;
    const lockstepReason = reason === "periodic" ? "manual" : reason;
    this.sendRaw(socket, this.serializedLockstepState(lockstepReason));
  }

  private broadcastLockstepState(reason: "start" | "manual"): void {
    if (!this.simulation) return;
    const serialized = this.serializedLockstepState(reason);
    for (const socket of this.ctx.getWebSockets()) this.sendRaw(socket, serialized);
  }

  private broadcastPlayerState(
    playerId: string,
    state: "playing" | "disconnected",
    excludedSocket?: WebSocket,
  ): void {
    if (!this.simulation) return;
    const message: ServerMessage = {
      type: "lockstep_player_state",
      tick: this.relayTick,
      playerId,
      state,
    };
    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== excludedSocket) this.send(socket, message);
    }
  }

  private serializedLockstepState(
    reason: Extract<ServerMessage, { type: "lockstep_state" }>["reason"],
  ): string {
    if (!this.simulation) throw new Error("Cannot serialize a missing simulation");
    this.simulation.refreshChecksum();
    const { tick, checksum } = this.simulation.state;
    if (!this.lockstepStateCache
      || this.lockstepStateCache.tick !== tick
      || this.lockstepStateCache.checksum !== checksum) {
      this.lockstepStateCache = {
        tick,
        checksum,
        stateJson: JSON.stringify(this.simulation.snapshot()),
        messages: new Map(),
      };
    }
    const cached = this.lockstepStateCache.messages.get(reason);
    if (cached) return cached;
    const serialized = `{"type":"lockstep_state","tick":${tick},"checksum":${checksum},"state":${this.lockstepStateCache.stateJson},"reason":${JSON.stringify(reason)}}`;
    this.lockstepStateCache.messages.set(reason, serialized);
    return serialized;
  }

  private invalidateLockstepState(): void {
    this.lockstepStateCache = null;
  }

  private playerView(playerId: string): PlayerViewState | null {
    if (!this.simulation) return null;
    if (this.viewCacheTick !== this.simulation.state.tick) {
      this.viewCacheTick = this.simulation.state.tick;
      this.viewCache.clear();
    }
    const cached = this.viewCache.get(playerId);
    if (cached) return cached as PlayerViewState;
    const view = this.simulation.playerView(playerId);
    if (view) this.viewCache.set(playerId, view);
    return view;
  }

  private teamView(teamId: number): TeamViewState | null {
    if (!this.simulation) return null;
    if (this.viewCacheTick !== this.simulation.state.tick) {
      this.viewCacheTick = this.simulation.state.tick;
      this.viewCache.clear();
    }
    const cacheKey = `team:${teamId}`;
    const cached = this.viewCache.get(cacheKey);
    if (cached) return cached as TeamViewState;
    const view = projectTeamView(this.simulation.state, teamId);
    if (view) this.viewCache.set(cacheKey, view);
    return view;
  }

  private viewForSocket(socket: WebSocket): PlayerViewState | TeamViewState | null {
    const attachment = this.attachment(socket);
    if (attachment.playerId) return this.playerView(attachment.playerId);
    if (attachment.spectatorMode === "team" && attachment.spectatorTeamId !== undefined) {
      return this.teamView(attachment.spectatorTeamId);
    }
    return null;
  }

  private invalidatePlayerViews(): void {
    this.viewCacheTick = -1;
    this.viewCache.clear();
  }

  private sortSlots(): void {
    this.lobby.slots.sort((a, b) => a.slotIndex - b.slotIndex);
  }

  private nextSlotIndex(): number {
    const occupied = new Set(this.lobby.slots.map((slot) => slot.slotIndex));
    for (let index = 0; index < MAX_PLAYERS; index += 1) if (!occupied.has(index)) return index;
    return MAX_PLAYERS - 1;
  }

  private smallestTeam(): number {
    const teamOne = this.lobby.slots.filter((slot) => slot.teamId === 1).length;
    const teamTwo = this.lobby.slots.filter((slot) => slot.teamId === 2).length;
    return teamOne <= teamTwo ? 1 : 2;
  }

  private mapPlayerCapacity(): number {
    return this.playerCapacityForSize(this.lobby.settings.mapSize);
  }

  private playerCapacityForSize(mapSize: LobbySettings["mapSize"]): number {
    return { small: 4, medium: 6, large: 8, huge: 8, colossal: 8 }[mapSize];
  }

  private createReconnectToken(): string {
    return `${crypto.randomUUID()}-${crypto.randomUUID()}`;
  }

  private sendReplayManifest(socket: WebSocket): void {
    const replay = this.completedReplay();
    if (!replay) {
      this.fail(socket, "replay_unavailable", "The omniscient replay is available only after the match finishes");
      return;
    }
    const bytes = new TextEncoder().encode(JSON.stringify(replay));
    if (bytes.byteLength > MAX_REPLAY_BYTES) {
      this.fail(socket, "replay_too_large", "This replay exceeds the transfer size limit");
      return;
    }
    this.send(socket, {
      type: "replay_manifest",
      manifest: {
        version: 1,
        matchId: this.lobby.matchId,
        format: "space-rts-replay",
        tick: replay.result.tick,
        checksum: replay.result.checksum,
        status: "finished",
        physicsBackend: replay.physicsBackend,
        winnerTeamId: replay.result.winnerTeamId,
        completedAt: this.replayCompletedAt!,
        byteLength: bytes.byteLength,
        chunkBytes: REPLAY_CHUNK_BYTES,
        chunkCount: Math.ceil(bytes.byteLength / REPLAY_CHUNK_BYTES),
        encoding: "base64-json",
      },
    });
  }

  private sendReplayChunk(socket: WebSocket, index: number): void {
    const replay = this.completedReplay();
    if (!replay) {
      this.fail(socket, "replay_unavailable", "The omniscient replay is available only after the match finishes");
      return;
    }
    const bytes = new TextEncoder().encode(JSON.stringify(replay));
    if (bytes.byteLength > MAX_REPLAY_BYTES) {
      this.fail(socket, "replay_too_large", "This replay exceeds the transfer size limit");
      return;
    }
    const chunkCount = Math.ceil(bytes.byteLength / REPLAY_CHUNK_BYTES);
    if (index >= chunkCount) {
      this.fail(socket, "replay_chunk_unknown", "That replay chunk does not exist");
      return;
    }
    const start = index * REPLAY_CHUNK_BYTES;
    this.send(socket, {
      type: "replay_chunk",
      index,
      chunkCount,
      data: bytesToBase64(bytes.subarray(start, Math.min(start + REPLAY_CHUNK_BYTES, bytes.byteLength))),
    });
  }

  private completedReplay(): ReplayFile | null {
    return this.lobby.phase === "finished" && this.replay?.finalized && this.replayCompletedAt
      ? this.replay
      : null;
  }

  private attachment(socket: WebSocket): SocketAttachment {
    return socket.deserializeAttachment() as SocketAttachment ?? { playerId: null };
  }

  private async loadPersistedMatch(): Promise<PersistedMatch | undefined> {
    const metadata = await this.ctx.storage.get<PersistedMatchMetadata>(MATCH_METADATA_KEY);
    const legacy = await this.ctx.storage.get<PersistedMatch>(LEGACY_MATCH_KEY);
    if (!metadata || metadata.version !== 2) return legacy;

    this.checkpointManifest = metadata.checkpoint;
    let checkpoint: PersistedCheckpointPayload | null = null;
    if (metadata.checkpoint) {
      try {
        checkpoint = await this.loadCheckpoint(metadata.checkpoint);
      } catch (error) {
        console.error("Failed to load the current match checkpoint; trying legacy state", error);
      }
    }
    return {
      lobby: metadata.lobby,
      seed: metadata.seed,
      simulation: checkpoint?.simulation ?? legacy?.simulation ?? null,
      reconnectTokens: metadata.reconnectTokens,
      spectatorGrants: metadata.spectatorGrants,
      replay: checkpoint?.replay ?? legacy?.replay ?? null,
      replayCompletedAt: metadata.replayCompletedAt,
      aiCounter: metadata.aiCounter,
      relayTick: checkpoint?.relayTick ?? metadata.relayTick ?? legacy?.relayTick ?? 0,
      relayCommands: checkpoint?.relayCommands ?? legacy?.relayCommands ?? [],
      relayPlayerStates: checkpoint?.relayPlayerStates ?? legacy?.relayPlayerStates ?? [],
    };
  }

  private async loadCheckpoint(manifest: PersistedCheckpointManifest): Promise<PersistedCheckpointPayload> {
    if (!Number.isInteger(manifest.chunkCount)
      || manifest.chunkCount < 1
      || manifest.chunkCount > MAX_CHECKPOINT_CHUNKS
      || !Number.isInteger(manifest.byteLength)
      || manifest.byteLength < 1) {
      throw new Error("Invalid checkpoint manifest");
    }
    const bytes = new Uint8Array(manifest.byteLength);
    let offset = 0;
    const keys = Array.from(
      { length: manifest.chunkCount },
      (_, index) => this.checkpointChunkKey(manifest.generation, index),
    );
    for (let start = 0; start < keys.length; start += CHECKPOINT_STORAGE_BATCH) {
      const batchKeys = keys.slice(start, start + CHECKPOINT_STORAGE_BATCH);
      const chunks = await this.ctx.storage.get<Uint8Array>(batchKeys);
      for (const key of batchKeys) {
        const chunk = chunks.get(key);
        if (!(chunk instanceof Uint8Array) || offset + chunk.byteLength > bytes.byteLength) {
          throw new Error(`Checkpoint chunk ${key} is missing or invalid`);
        }
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
    if (offset !== bytes.byteLength || await sha256Hex(bytes) !== manifest.sha256) {
      throw new Error("Checkpoint integrity verification failed");
    }
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<PersistedCheckpointPayload>;
    if (!("simulation" in parsed) || !("replay" in parsed)) throw new Error("Checkpoint payload is incomplete");
    return parsed as PersistedCheckpointPayload;
  }

  private persist(): Promise<void> {
    return this.persistMetadata();
  }

  private persistMetadata(): Promise<void> {
    const write = (): Promise<void> => this.ctx.storage.put(MATCH_METADATA_KEY, this.currentMetadata());
    this.persistChain = this.persistChain.then(write, write);
    return this.persistChain;
  }

  private persistCheckpoint(): Promise<void> {
    const write = (): Promise<void> => this.writeCheckpoint();
    this.persistChain = this.persistChain.then(write, write);
    return this.persistChain;
  }

  private currentMetadata(checkpoint = this.checkpointManifest): PersistedMatchMetadata {
    return {
      version: 2,
      lobby: this.publicLobby(),
      seed: this.seed,
      reconnectTokens: { ...this.reconnectTokens },
      spectatorGrants: structuredClone(this.spectatorGrants),
      replayCompletedAt: this.replayCompletedAt,
      aiCounter: this.aiCounter,
      checkpoint,
      relayTick: this.relayTick,
    };
  }

  private async writeCheckpoint(): Promise<void> {
    if (this.replayRecorder) this.replay = this.replayRecorder.archive();
    const payload: PersistedCheckpointPayload = {
      simulation: this.simulation?.snapshot() ?? null,
      replay: this.replay,
      relayTick: this.relayTick,
      relayCommands: this.relayCommands,
      relayPlayerStates: this.relayPlayerStates,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const chunkCount = Math.ceil(bytes.byteLength / CHECKPOINT_CHUNK_BYTES);
    if (chunkCount < 1 || chunkCount > MAX_CHECKPOINT_CHUNKS) {
      throw new Error(`Checkpoint requires ${chunkCount} chunks; maximum is ${MAX_CHECKPOINT_CHUNKS}`);
    }

    const generation = `${this.relayTick}-${crypto.randomUUID()}`;
    for (let startIndex = 0; startIndex < chunkCount; startIndex += CHECKPOINT_STORAGE_BATCH) {
      const entries: Record<string, Uint8Array> = {};
      for (let index = startIndex; index < Math.min(startIndex + CHECKPOINT_STORAGE_BATCH, chunkCount); index += 1) {
        const start = index * CHECKPOINT_CHUNK_BYTES;
        entries[this.checkpointChunkKey(generation, index)] = bytes.slice(
          start,
          Math.min(start + CHECKPOINT_CHUNK_BYTES, bytes.byteLength),
        );
      }
      await this.ctx.storage.put(entries);
    }

    const previous = this.checkpointManifest;
    const manifest: PersistedCheckpointManifest = {
      generation,
      chunkCount,
      byteLength: bytes.byteLength,
      sha256: await sha256Hex(bytes),
    };
    await this.ctx.storage.put(MATCH_METADATA_KEY, this.currentMetadata(manifest));
    this.checkpointManifest = manifest;
    await this.ctx.storage.delete(LEGACY_MATCH_KEY);
    if (previous && previous.generation !== generation) await this.deleteCheckpoint(previous);
  }

  private async deleteCheckpoint(manifest: PersistedCheckpointManifest): Promise<void> {
    const keys = Array.from(
      { length: manifest.chunkCount },
      (_, index) => this.checkpointChunkKey(manifest.generation, index),
    );
    for (let start = 0; start < keys.length; start += 64) {
      await this.ctx.storage.delete(keys.slice(start, start + 64));
    }
  }

  private checkpointChunkKey(generation: string, index: number): string {
    return `${CHECKPOINT_CHUNK_PREFIX}${generation}:${index}`;
  }

  private broadcast(message: ServerMessage): void {
    const serialized = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) this.sendRaw(socket, serialized);
  }

  private fail(socket: WebSocket, code: string, message: string): void {
    this.send(socket, { type: "error", code, message });
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    this.sendRaw(socket, JSON.stringify(message));
  }

  private sendRaw(socket: WebSocket, message: string): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(message);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const batchSize = 8 * 1024;
  for (let offset = 0; offset < bytes.length; offset += batchSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + batchSize, bytes.length)));
  }
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digestInput = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", digestInput));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}
