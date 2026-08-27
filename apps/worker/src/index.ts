import box3dModule from "@space-rts/box3d-wasm/box3d.wasm";
import {
  createPlanarCirclePhysicsWorld,
  type PlanarCirclePhysicsWorld,
} from "@space-rts/box3d-wasm";
import { loadPhysicsRuntimeFromModule } from "@space-rts/box3d-wasm/worker";
import {
  createCombatScenario,
  projectTeamView,
  ReplayRecorder,
  restoreSimulation,
  type GameCommand,
  type GameSimulation,
  type PlayerViewState,
  type ReplayFile,
  type SimulationState,
  type TeamViewState,
} from "@space-rts/game-core";
import {
  DEFAULT_LOBBY_SETTINGS,
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
}

const PLAYER_COLORS = [0x59a7ff, 0xff5576, 0x62e6a7, 0xf3b65b, 0xb886ff, 0x55e1e8, 0xff8b55, 0xd8e65b];
const PHYSICS_BACKEND = "box3d-wasm-precompiled";
const VIEW_INTERVAL_TICKS = 2;
const CHECKSUM_INTERVAL_TICKS = 5;
const SNAPSHOT_INTERVAL_TICKS = SIMULATION_HZ * 5;
const PERSIST_INTERVAL_TICKS = SIMULATION_HZ;
const REPLAY_CHECKPOINT_INTERVAL_TICKS = SIMULATION_HZ * 5;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "voidfront-authority",
        physics: PHYSICS_BACKEND,
        physicsModule: box3dModule instanceof WebAssembly.Module ? "ready" : "unavailable",
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
  private physicsWorld: PlanarCirclePhysicsWorld | null = null;
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
  private persistChain: Promise<void> = Promise.resolve();

  constructor(private readonly ctx: DurableObjectState, _env: Env) {
    this.lobby = this.createLobby("pending");
    this.ctx.blockConcurrencyWhile(async () => {
      const physicsRuntime = await loadPhysicsRuntimeFromModule(box3dModule);
      this.physicsWorld = createPlanarCirclePhysicsWorld(physicsRuntime);
      const persisted = await this.ctx.storage.get<PersistedMatch>("match");
      if (!persisted) return;
      const legacySeed = (persisted.lobby as LobbyState & { seed?: unknown }).seed;
      this.seed = persisted.seed ?? (typeof legacySeed === "number" ? legacySeed : this.seed);
      const restoredLobby = persisted.lobby as LobbyState & { settings?: LobbySettings };
      this.lobby = this.redactLobby({
        ...restoredLobby,
        settings: restoredLobby.settings ?? { ...DEFAULT_LOBBY_SETTINGS },
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
      if (persisted.simulation) {
        this.simulation = restoreSimulation(persisted.simulation, this.physicsWorld);
        if (this.replay && !this.replay.finalized) {
          this.replayRecorder = ReplayRecorder.resume(this.simulation, this.replay, {
            checkpointIntervalTicks: REPLAY_CHECKPOINT_INTERVAL_TICKS,
          });
          if (this.simulation.state.status === "finished") {
            this.replay = this.replayRecorder.finalize();
            this.replayRecorder = null;
            this.replayCompletedAt ??= Date.now();
            this.lobby.phase = "finished";
            await this.persist();
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
      this.ctx.waitUntil(this.persist());
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
    this.send(server, { type: "hello_required", matchId: this.lobby.matchId, lobby: this.publicLobby() });
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
      this.handleHello(socket, message);
      return;
    }
    if (message.type === "spectate") {
      if (attachment.playerId || attachment.spectatorId) {
        this.fail(socket, "already_authenticated", "This connection already has a match role");
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
    const simPlayer = this.simulation?.state.players.find((player) => player.id === slot.playerId);
    if (simPlayer && simPlayer.state === "disconnected") {
      if (this.replayRecorder) this.replayRecorder.setPlayerState(slot.playerId, "playing");
      else simPlayer.state = "playing";
      this.invalidatePlayerViews();
    }
    this.sortSlots();
    this.send(socket, {
      type: "welcome",
      playerId: slot.playerId,
      reconnectToken: this.reconnectTokens[slot.playerId]!,
      lobby: this.publicLobby(),
      tick: this.simulation?.state.tick ?? 0,
    });
    if (this.simulation) {
      this.sendSnapshot(socket, reconnecting ? "reconnect" : "join");
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
      tick: this.simulation?.state.tick ?? 0,
    });
    if (this.simulation) {
      this.sendSnapshot(socket, reconnecting ? "reconnect" : "join");
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
        tick: this.simulation?.state.tick ?? this.replay?.result.tick ?? 0,
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
      const view = this.viewForSocket(socket);
      if (view && message.tick === view.tick && message.checksum !== view.checksum) {
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
          tick: this.simulation?.state.tick ?? 0,
        });
        return;
      case "request_snapshot":
        if (this.simulation) this.sendSnapshot(socket, message.reason);
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
        slot.teamId = message.teamId;
        slot.ready = false;
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
        if (this.simulation) {
          const view = this.playerView(playerId);
          if (view && message.tick === view.tick && message.checksum !== view.checksum) {
            this.sendSnapshot(socket, "checksum");
          }
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
      players: this.lobby.slots.map((slot) => ({
        id: slot.playerId,
        name: slot.name,
        teamId: slot.teamId,
        color: slot.color,
        ai: slot.isAi,
      })),
    });
    if (this.simulation.state.ships.length !== 0) {
      throw new Error("Authoritative matches must begin without free ships");
    }
    if (this.physicsWorld) this.simulation.attachPhysicsWorld(this.physicsWorld);
    this.replayRecorder = new ReplayRecorder(this.simulation, {
      checkpointIntervalTicks: REPLAY_CHECKPOINT_INTERVAL_TICKS,
    });
    this.replay = this.replayRecorder.archive();
    this.replayCompletedAt = null;
    this.invalidatePlayerViews();
    this.lobby.phase = "playing";
    this.broadcastPlayerViews("match_started");
    this.broadcastLobby();
    this.ensureTicking();
    this.ctx.waitUntil(this.persist());
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
    if (message.clientChecksum !== undefined
      && message.clientTick === this.simulation.state.tick) {
      const view = this.playerView(playerId);
      if (view && message.clientChecksum !== view.checksum) this.sendSnapshot(socket, "checksum");
    }

    const accepted: GameCommand[] = [];
    const outcomes = message.commands.map((command) => {
      const authoritative = { ...command, playerId } as GameCommand;
      const result = this.replayRecorder
        ? this.replayRecorder.submitCommand(authoritative)
        : this.simulation!.submitCommand(authoritative);
      if (result.accepted) accepted.push(authoritative);
      return { sequence: authoritative.sequence, commandType: authoritative.type, result };
    });
    this.send(socket, { type: "command_results", tick: this.simulation.state.tick, outcomes });
    if (accepted.length > 0) {
      this.invalidatePlayerViews();
      this.ctx.waitUntil(this.persist());
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
    const simPlayer = this.simulation?.state.players.find((player) => player.id === playerId);
    if (simPlayer && simPlayer.state === "playing") {
      if (this.replayRecorder) this.replayRecorder.setPlayerState(playerId, "disconnected");
      else simPlayer.state = "disconnected";
      this.invalidatePlayerViews();
    }
    this.broadcastLobby();
    this.ctx.waitUntil(this.persist());
  }

  private tick(): void {
    if (!this.simulation || this.lobby.phase !== "playing") return;
    const debug = this.replayRecorder ? this.replayRecorder.step() : this.simulation.step();
    if (debug.tick % VIEW_INTERVAL_TICKS === 0) this.broadcastPlayerViews("view");
    if (debug.tick % CHECKSUM_INTERVAL_TICKS === 0) this.broadcastPlayerChecksums();
    if (debug.tick % SNAPSHOT_INTERVAL_TICKS === 0) this.broadcastSnapshot("periodic");
    if (debug.tick % PERSIST_INTERVAL_TICKS === 0) this.ctx.waitUntil(this.persist());
    if (this.simulation.state.status === "finished") {
      this.lobby.phase = "finished";
      if (this.replayRecorder) {
        this.replay = this.replayRecorder.finalize();
        this.replayRecorder = null;
        this.replayCompletedAt = Date.now();
      }
      this.broadcastLobby();
      this.ctx.waitUntil(this.persist());
      this.stopTicking();
    }
  }

  private ensureTicking(): void {
    if (this.timer !== undefined || !this.simulation || this.lobby.phase !== "playing") return;
    this.timer = setInterval(() => this.tick(), 1000 / SIMULATION_HZ);
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

  private broadcastSnapshot(reason: Extract<ServerMessage, { type: "snapshot" }>["reason"]): void {
    for (const socket of this.ctx.getWebSockets()) this.sendSnapshot(socket, reason);
  }

  private sendSnapshot(socket: WebSocket, reason: Extract<ServerMessage, { type: "snapshot" }>["reason"]): void {
    const view = this.viewForSocket(socket);
    if (!view) return;
    this.send(socket, {
      type: "snapshot",
      tick: view.tick,
      checksum: view.checksum,
      view,
      reason,
    });
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

  private broadcastPlayerViews(type: "match_started" | "view"): void {
    for (const socket of this.ctx.getWebSockets()) {
      const view = this.viewForSocket(socket);
      if (!view) continue;
      this.send(socket, { type, tick: view.tick, checksum: view.checksum, view });
    }
  }

  private broadcastPlayerChecksums(): void {
    for (const socket of this.ctx.getWebSockets()) {
      const view = this.viewForSocket(socket);
      if (!view) continue;
      this.send(socket, { type: "checksum", tick: view.tick, checksum: view.checksum });
    }
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
    return { small: 4, medium: 6, large: 8 }[mapSize];
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

  private persist(): Promise<void> {
    if (this.replayRecorder) this.replay = this.replayRecorder.archive();
    const persisted: PersistedMatch = {
      lobby: this.publicLobby(),
      seed: this.seed,
      simulation: this.simulation?.snapshot() ?? null,
      reconnectTokens: { ...this.reconnectTokens },
      spectatorGrants: structuredClone(this.spectatorGrants),
      replay: this.replay,
      replayCompletedAt: this.replayCompletedAt,
      aiCounter: this.aiCounter,
    };
    const write = (): Promise<void> => this.ctx.storage.put("match", persisted);
    this.persistChain = this.persistChain.then(write, write);
    return this.persistChain;
  }

  private broadcast(message: ServerMessage): void {
    for (const socket of this.ctx.getWebSockets()) this.send(socket, message);
  }

  private fail(socket: WebSocket, code: string, message: string): void {
    this.send(socket, { type: "error", code, message });
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
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
