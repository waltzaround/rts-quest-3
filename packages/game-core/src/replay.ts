import type { PlanarCirclePhysicsWorld } from "@space-rts/box3d-wasm";
import { calculateChecksum } from "./checksum";
import { ALL_SHIP_CLASSES, BUILDABLE_STRUCTURE_TYPES } from "./data";
import { GameSimulation, restoreSimulation } from "./simulation";
import type {
  CommandResult,
  DebugSnapshot,
  GameCommand,
  PlayerId,
  PlayerState,
  SimulationState,
  TeamId,
} from "./types";

export const REPLAY_FORMAT = "space-rts-replay" as const;
export const REPLAY_FORMAT_VERSION = 1 as const;

export type ReplayAction = ReplayCommandAction | ReplayPlayerStateAction;

export interface ReplayActionBase {
  acceptedAtTick: number;
  order: number;
}

export interface ReplayCommandAction extends ReplayActionBase {
  type: "command";
  command: GameCommand;
}

export interface ReplayPlayerStateAction extends ReplayActionBase {
  type: "playerState";
  playerId: PlayerId;
  state: PlayerState["state"];
}

export interface ReplayChecksumCheckpoint {
  tick: number;
  afterActionOrder: number;
  checksum: number;
}

export interface ReplayResult {
  tick: number;
  afterActionOrder: number;
  checksum: number;
  status: SimulationState["status"];
  winnerTeamId: TeamId | null;
}

export interface ReplayFile {
  format: typeof REPLAY_FORMAT;
  version: typeof REPLAY_FORMAT_VERSION;
  simulationVersion: SimulationState["version"];
  physicsBackend: "box3d-wasm" | "deterministic-fallback";
  finalized: boolean;
  initialState: SimulationState;
  initialChecksum: number;
  actions: ReplayAction[];
  checkpoints: ReplayChecksumCheckpoint[];
  result: ReplayResult;
}

export type ReplayArchive = ReplayFile;

export interface ReplayRecorderOptions {
  checkpointIntervalTicks?: number;
}

export type ReplayValidationResult =
  | { valid: true; replay: ReplayFile }
  | { valid: false; reason: string };

export type ReplayPlaybackFailureReason =
  | "invalidReplay"
  | "initialChecksumMismatch"
  | "actionRejected"
  | "checkpointMismatch"
  | "finalMismatch";

export interface ReplayPlaybackFailure {
  ok: false;
  reason: ReplayPlaybackFailureReason;
  tick: number;
  message: string;
  actionOrder?: number;
  expectedChecksum?: number;
  actualChecksum?: number;
}

export interface ReplayPlaybackProgress {
  ok: true;
  done: boolean;
  tick: number;
  checksum: number;
  verifiedCheckpoints: number;
  debug: DebugSnapshot;
}

export interface ReplayPlaybackSuccess {
  ok: true;
  simulation: GameSimulation;
  verifiedCheckpoints: number;
  debug: DebugSnapshot;
  result: ReplayResult;
}

export type ReplayPlaybackResult = ReplayPlaybackSuccess | ReplayPlaybackFailure;
export type ReplayStepResult = ReplayPlaybackProgress | ReplayPlaybackFailure;

export class ReplayRecorder {
  readonly simulation: GameSimulation;
  private initialState: SimulationState;
  private initialChecksum: number;
  private actions: ReplayAction[] = [];
  private checkpoints: ReplayChecksumCheckpoint[] = [];
  private nextActionOrder = 1;
  private checkpointIntervalTicks: number;
  private physicsBackend: ReplayFile["physicsBackend"];
  private lastAutomaticCheckpointTick: number;
  private isFinalized = false;

  constructor(simulation: GameSimulation, options: ReplayRecorderOptions = {}) {
    this.simulation = simulation;
    this.checkpointIntervalTicks = normalizeCheckpointInterval(options.checkpointIntervalTicks);
    this.physicsBackend = simulation.physicsBackend;
    this.initialState = simulation.snapshot();
    this.initialChecksum = calculateChecksum(this.initialState);
    this.initialState.checksum = this.initialChecksum;
    this.lastAutomaticCheckpointTick = this.initialState.tick;
    this.recordCheckpoint();
  }

  static resume(
    simulation: GameSimulation,
    replayInput: ReplayFile,
    options: ReplayRecorderOptions = {},
  ): ReplayRecorder {
    const validation = validateReplay(replayInput);
    if (!validation.valid) throw new Error(`Cannot resume invalid replay: ${validation.reason}`);
    const replay = validation.replay;
    if (replay.finalized) throw new Error("Cannot resume a finalized replay");
    if (simulation.physicsBackend !== replay.physicsBackend) {
      throw new Error("Cannot resume replay with a different physics backend");
    }
    const actualChecksum = calculateChecksum(simulation.state);
    if (simulation.state.tick !== replay.result.tick || actualChecksum !== replay.result.checksum) {
      throw new Error("Cannot resume replay from a different simulation state");
    }
    const recorder = new ReplayRecorder(simulation, options);
    recorder.initialState = clone(replay.initialState);
    recorder.initialChecksum = replay.initialChecksum;
    recorder.physicsBackend = replay.physicsBackend;
    recorder.actions = clone(replay.actions);
    recorder.checkpoints = clone(replay.checkpoints);
    recorder.nextActionOrder = replay.actions.length + 1;
    recorder.lastAutomaticCheckpointTick = replay.checkpoints.at(-1)?.tick ?? replay.initialState.tick;
    recorder.isFinalized = false;
    return recorder;
  }

  submitCommand(command: GameCommand): CommandResult {
    this.assertRecording();
    const result = this.simulation.submitCommand(command);
    this.recordAcceptedCommand(command, result);
    return result;
  }

  recordAcceptedCommand(command: GameCommand, result: CommandResult): void {
    this.assertRecording();
    if (!result.accepted) return;
    if (this.actions.some((action) => action.type === "command"
      && action.command.playerId === command.playerId
      && action.command.sequence === command.sequence)) {
      throw new Error(`Command ${command.playerId}:${command.sequence} was already recorded`);
    }
    const canonical = this.simulation.state.commandQueue.find(
      (queued) => queued.playerId === command.playerId && queued.sequence === command.sequence,
    );
    if (!canonical) throw new Error("Accepted command must be recorded immediately after submission");
    this.appendAction({
      type: "command",
      acceptedAtTick: this.simulation.state.tick,
      order: this.nextActionOrder++,
      command: clone(canonical),
    });
  }

  setPlayerState(playerId: PlayerId, state: PlayerState["state"]): boolean {
    this.assertRecording();
    const player = this.simulation.state.players.find((candidate) => candidate.id === playerId);
    if (!player || player.state === state) return false;
    player.state = state;
    this.recordPlayerStateTransition(playerId, state);
    return true;
  }

  recordPlayerStateTransition(playerId: PlayerId, state: PlayerState["state"]): void {
    this.assertRecording();
    const player = this.simulation.state.players.find((candidate) => candidate.id === playerId);
    if (!player || player.state !== state) {
      throw new Error("Player state transition must be recorded immediately after applying it");
    }
    this.appendAction({
      type: "playerState",
      acceptedAtTick: this.simulation.state.tick,
      order: this.nextActionOrder++,
      playerId,
      state,
    });
  }

  step(): DebugSnapshot {
    this.assertRecording();
    const debug = this.simulation.step();
    if (debug.tick - this.lastAutomaticCheckpointTick >= this.checkpointIntervalTicks) {
      this.recordCheckpoint();
      this.lastAutomaticCheckpointTick = debug.tick;
    }
    return debug;
  }

  stepMany(count: number): DebugSnapshot {
    let debug = this.simulation.debugSnapshot();
    for (let index = 0; index < count; index += 1) debug = this.step();
    return debug;
  }

  recordCheckpoint(): void {
    this.assertRecording();
    const checksum = this.simulation.refreshChecksum();
    const checkpoint: ReplayChecksumCheckpoint = {
      tick: this.simulation.state.tick,
      afterActionOrder: this.nextActionOrder - 1,
      checksum,
    };
    const previous = this.checkpoints.at(-1);
    if (previous?.tick === checkpoint.tick && previous.afterActionOrder === checkpoint.afterActionOrder) {
      this.checkpoints[this.checkpoints.length - 1] = checkpoint;
    } else {
      this.checkpoints.push(checkpoint);
    }
  }

  archive(): ReplayFile {
    this.assertRecording();
    this.recordCheckpoint();
    return this.buildReplay(false);
  }

  finalize(): ReplayFile {
    this.assertRecording();
    this.recordCheckpoint();
    this.isFinalized = true;
    return this.buildReplay(true);
  }

  private appendAction(action: ReplayAction): void {
    const previous = this.actions.at(-1);
    if (previous && action.acceptedAtTick < previous.acceptedAtTick) {
      throw new Error("Replay actions cannot move backward in time");
    }
    this.actions.push(action);
  }

  private buildReplay(finalized: boolean): ReplayFile {
    const result = resultFromState(this.simulation.state, this.nextActionOrder - 1);
    return clone({
      format: REPLAY_FORMAT,
      version: REPLAY_FORMAT_VERSION,
      simulationVersion: this.initialState.version,
      physicsBackend: this.physicsBackend,
      finalized,
      initialState: this.initialState,
      initialChecksum: this.initialChecksum,
      actions: this.actions,
      checkpoints: this.checkpoints,
      result,
    });
  }

  private assertRecording(): void {
    if (this.isFinalized) throw new Error("Replay recorder is finalized");
    if (this.simulation.physicsBackend !== this.physicsBackend) {
      throw new Error("Replay physics backend changed while recording");
    }
  }
}

export class ReplayPlayer {
  readonly replay: ReplayFile;
  simulation: GameSimulation;
  readonly startTick: number;
  readonly endTick: number;
  lastDebug: DebugSnapshot;
  private readonly physicsWorld: PlanarCirclePhysicsWorld | undefined;
  private actionIndex = 0;
  private checkpointIndex = 0;
  private verifiedCheckpoints = 0;
  private failure: ReplayPlaybackFailure | null = null;

  constructor(replayInput: ReplayFile, physicsWorld?: PlanarCirclePhysicsWorld) {
    const validation = validateReplay(replayInput);
    if (!validation.valid) throw new Error(`Invalid replay: ${validation.reason}`);
    this.replay = validation.replay;
    this.startTick = this.replay.initialState.tick;
    this.endTick = this.replay.result.tick;
    this.physicsWorld = physicsWorld;
    const suppliedBackend = physicsWorld ? "box3d-wasm" : "deterministic-fallback";
    if (suppliedBackend !== this.replay.physicsBackend) {
      throw new Error(`Replay requires ${this.replay.physicsBackend} physics`);
    }
    const initialActual = calculateChecksum(this.replay.initialState);
    if (initialActual !== this.replay.initialChecksum) {
      throw new Error("Replay initial checksum mismatch");
    }
    this.simulation = restoreSimulation(this.replay.initialState, physicsWorld);
    this.lastDebug = this.simulation.debugSnapshot();
    this.failure = this.prepareCurrentTick();
  }

  get currentTick(): number {
    return this.simulation.state.tick;
  }

  step(): ReplayStepResult {
    if (this.failure) return this.failure;
    if (this.simulation.state.tick >= this.endTick) return this.finishProgress();
    this.lastDebug = this.simulation.step();
    this.failure = this.prepareCurrentTick();
    if (this.failure) return this.failure;
    return this.finishProgress();
  }

  seek(tick: number): ReplayStepResult {
    if (!Number.isSafeInteger(tick) || tick < this.startTick || tick > this.endTick) {
      return {
        ok: false,
        reason: "invalidReplay",
        tick: this.simulation.state.tick,
        message: `Replay tick must be between ${this.startTick} and ${this.endTick}`,
      };
    }
    this.simulation = restoreSimulation(this.replay.initialState, this.physicsWorld);
    this.lastDebug = this.simulation.debugSnapshot();
    this.actionIndex = 0;
    this.checkpointIndex = 0;
    this.verifiedCheckpoints = 0;
    this.failure = this.prepareCurrentTick();
    if (this.failure) return this.failure;
    while (this.simulation.state.tick < tick) {
      const progress = this.step();
      if (!progress.ok) return progress;
    }
    return this.finishProgress();
  }

  playToEnd(): ReplayPlaybackResult {
    while (this.simulation.state.tick < this.endTick) {
      const progress = this.step();
      if (!progress.ok) return progress;
    }
    const progress = this.finishProgress();
    if (!progress.ok) return progress;
    const actual = resultFromState(this.simulation.state, this.actionIndex);
    return {
      ok: true,
      simulation: this.simulation,
      verifiedCheckpoints: this.verifiedCheckpoints,
      debug: this.lastDebug,
      result: actual,
    };
  }

  private prepareCurrentTick(): ReplayPlaybackFailure | null {
    const tick = this.simulation.state.tick;
    const beforeActionsFailure = this.verifyCurrentCheckpoints();
    if (beforeActionsFailure) return beforeActionsFailure;
    while (this.actionIndex < this.replay.actions.length) {
      const action = this.replay.actions[this.actionIndex]!;
      if (action.acceptedAtTick !== tick) break;
      const failure = this.applyAction(action);
      if (failure) return failure;
      this.actionIndex += 1;
      const checkpointFailure = this.verifyCurrentCheckpoints();
      if (checkpointFailure) return checkpointFailure;
    }
    return null;
  }

  private applyAction(action: ReplayAction): ReplayPlaybackFailure | null {
    if (action.type === "command") {
      const result = this.simulation.submitCommand(clone(action.command));
      if (!result.accepted) {
        return {
          ok: false,
          reason: "actionRejected",
          tick: this.simulation.state.tick,
          actionOrder: action.order,
          message: `Recorded command was rejected during playback: ${result.reason}`,
        };
      }
      return null;
    }
    const player = this.simulation.state.players.find((candidate) => candidate.id === action.playerId);
    if (!player) {
      return {
        ok: false,
        reason: "actionRejected",
        tick: this.simulation.state.tick,
        actionOrder: action.order,
        message: `Recorded player ${action.playerId} does not exist`,
      };
    }
    player.state = action.state;
    return null;
  }

  private verifyCurrentCheckpoints(): ReplayPlaybackFailure | null {
    while (this.checkpointIndex < this.replay.checkpoints.length) {
      const checkpoint = this.replay.checkpoints[this.checkpointIndex]!;
      if (checkpoint.tick !== this.simulation.state.tick || checkpoint.afterActionOrder !== this.actionIndex) break;
      const actualChecksum = calculateChecksum(this.simulation.state);
      if (actualChecksum !== checkpoint.checksum) {
        return {
          ok: false,
          reason: "checkpointMismatch",
          tick: checkpoint.tick,
          actionOrder: checkpoint.afterActionOrder,
          message: "Replay checkpoint checksum mismatch",
          expectedChecksum: checkpoint.checksum,
          actualChecksum,
        };
      }
      this.simulation.state.checksum = actualChecksum;
      this.checkpointIndex += 1;
      this.verifiedCheckpoints += 1;
    }
    return null;
  }

  private finishProgress(): ReplayStepResult {
    if (this.failure) return this.failure;
    const done = this.simulation.state.tick >= this.endTick;
    if (done) {
      const actual = resultFromState(this.simulation.state, this.actionIndex);
      if (this.actionIndex !== this.replay.actions.length
        || this.checkpointIndex !== this.replay.checkpoints.length
        || actual.afterActionOrder !== this.replay.result.afterActionOrder
        || actual.checksum !== this.replay.result.checksum
        || actual.status !== this.replay.result.status
        || actual.winnerTeamId !== this.replay.result.winnerTeamId) {
        return {
          ok: false,
          reason: "finalMismatch",
          tick: this.simulation.state.tick,
          message: "Replay final result does not match the recording",
          expectedChecksum: this.replay.result.checksum,
          actualChecksum: actual.checksum,
        };
      }
    }
    return {
      ok: true,
      done,
      tick: this.simulation.state.tick,
      checksum: calculateChecksum(this.simulation.state),
      verifiedCheckpoints: this.verifiedCheckpoints,
      debug: this.lastDebug,
    };
  }
}

export function playReplay(
  replayInput: unknown,
  physicsWorld?: PlanarCirclePhysicsWorld,
): ReplayPlaybackResult {
  const validation = validateReplay(replayInput);
  if (!validation.valid) {
    return { ok: false, reason: "invalidReplay", tick: 0, message: validation.reason };
  }
  const initialActual = safeChecksum(validation.replay.initialState);
  if (initialActual === null) {
    return {
      ok: false,
      reason: "invalidReplay",
      tick: validation.replay.initialState.tick,
      message: "Replay initial snapshot cannot be checksummed",
    };
  }
  if (initialActual !== validation.replay.initialChecksum) {
    return {
      ok: false,
      reason: "initialChecksumMismatch",
      tick: validation.replay.initialState.tick,
      message: "Replay initial snapshot was modified",
      expectedChecksum: validation.replay.initialChecksum,
      actualChecksum: initialActual,
    };
  }
  try {
    return new ReplayPlayer(validation.replay, physicsWorld).playToEnd();
  } catch (error) {
    return {
      ok: false,
      reason: "invalidReplay",
      tick: validation.replay.initialState.tick,
      message: error instanceof Error ? error.message : "Replay could not be loaded",
    };
  }
}

export function parseReplay(input: string | unknown): ReplayValidationResult {
  if (typeof input !== "string") return validateReplay(input);
  try {
    return validateReplay(JSON.parse(input) as unknown);
  } catch {
    return { valid: false, reason: "Replay is not valid JSON" };
  }
}

export function validateReplay(input: unknown): ReplayValidationResult {
  if (!isRecord(input)) return { valid: false, reason: "Replay must be an object" };
  if (input.format !== REPLAY_FORMAT || input.version !== REPLAY_FORMAT_VERSION) {
    return { valid: false, reason: "Unsupported replay format or version" };
  }
  if (input.simulationVersion !== 7
    || (input.physicsBackend !== "box3d-wasm" && input.physicsBackend !== "deterministic-fallback")
    || typeof input.finalized !== "boolean") {
    return { valid: false, reason: "Unsupported simulation version" };
  }
  if (!isSimulationStateShape(input.initialState)) return { valid: false, reason: "Invalid initial snapshot" };
  if (!isChecksum(input.initialChecksum)) return { valid: false, reason: "Invalid initial checksum" };
  if (!Array.isArray(input.actions) || !input.actions.every(isReplayAction)) {
    return { valid: false, reason: "Invalid replay actions" };
  }
  if (!Array.isArray(input.checkpoints) || !input.checkpoints.every(isCheckpoint)) {
    return { valid: false, reason: "Invalid replay checkpoints" };
  }
  if (!isReplayResult(input.result)) return { valid: false, reason: "Invalid replay result" };

  const replay = clone(input as unknown as ReplayFile);
  if (replay.initialState.version !== replay.simulationVersion) {
    return { valid: false, reason: "Initial snapshot version does not match replay" };
  }
  if (replay.initialState.checksum !== replay.initialChecksum) {
    return { valid: false, reason: "Initial snapshot checksum field is inconsistent" };
  }
  if (replay.result.tick < replay.initialState.tick
    || replay.result.afterActionOrder !== replay.actions.length) {
    return { valid: false, reason: "Replay result bounds are inconsistent" };
  }
  for (let index = 0; index < replay.actions.length; index += 1) {
    const action = replay.actions[index]!;
    if (action.order !== index + 1
      || action.acceptedAtTick < replay.initialState.tick
      || action.acceptedAtTick > replay.result.tick
      || (index > 0 && action.acceptedAtTick < replay.actions[index - 1]!.acceptedAtTick)) {
      return { valid: false, reason: "Replay action ordering is inconsistent" };
    }
  }
  let previousCheckpoint: ReplayChecksumCheckpoint | undefined;
  for (const checkpoint of replay.checkpoints) {
    const minimumActionOrder = replay.actions.filter((action) => action.acceptedAtTick < checkpoint.tick).length;
    const maximumActionOrder = replay.actions.filter((action) => action.acceptedAtTick <= checkpoint.tick).length;
    if (checkpoint.tick < replay.initialState.tick || checkpoint.tick > replay.result.tick
      || checkpoint.afterActionOrder > replay.actions.length
      || checkpoint.afterActionOrder < minimumActionOrder
      || checkpoint.afterActionOrder > maximumActionOrder
      || (previousCheckpoint && (checkpoint.tick < previousCheckpoint.tick
        || (checkpoint.tick === previousCheckpoint.tick
          && checkpoint.afterActionOrder <= previousCheckpoint.afterActionOrder)))) {
      return { valid: false, reason: "Replay checkpoint ordering is inconsistent" };
    }
    previousCheckpoint = checkpoint;
  }
  if (safeChecksum(replay.initialState) === null) return { valid: false, reason: "Initial snapshot cannot be checksummed" };
  return { valid: true, replay };
}

function resultFromState(state: SimulationState, afterActionOrder: number): ReplayResult {
  return {
    tick: state.tick,
    afterActionOrder,
    checksum: calculateChecksum(state),
    status: state.status,
    winnerTeamId: state.winnerTeamId,
  };
}

function normalizeCheckpointInterval(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("checkpointIntervalTicks must be a positive integer");
  return value;
}

function isReplayAction(value: unknown): value is ReplayAction {
  if (!isRecord(value)
    || !isNonNegativeInteger(value.acceptedAtTick)
    || !isPositiveInteger(value.order)) return false;
  if (value.type === "playerState") {
    return typeof value.playerId === "string" && value.playerId.length > 0
      && ["playing", "disconnected", "defeated"].includes(String(value.state));
  }
  return value.type === "command" && isGameCommandShape(value.command);
}

function isGameCommandShape(value: unknown): value is GameCommand {
  if (!isRecord(value)
    || typeof value.type !== "string"
    || typeof value.playerId !== "string" || value.playerId.length === 0
    || !isPositiveInteger(value.sequence)
    || !isPositiveInteger(value.requestedTick)) return false;
  if (["move", "attackMove", "patrol", "stop", "hold", "focusFire"].includes(value.type)) {
    if (!Array.isArray(value.unitIds) || value.unitIds.length < 1 || value.unitIds.length > 512
      || !value.unitIds.every(isPositiveInteger)
      || typeof value.queued !== "boolean") return false;
    if (value.type === "move" || value.type === "attackMove" || value.type === "patrol") {
      return isVec2(value.destination) && (value.formationEnd === undefined || isVec2(value.formationEnd));
    }
    return value.type !== "focusFire" || isPositiveInteger(value.targetEntityId);
  }
  if (value.type === "buildStructure") {
    return BUILDABLE_STRUCTURE_TYPES.includes(value.structureType as never)
      && isVec2(value.position)
      && (value.yaw === undefined || (typeof value.yaw === "number" && Number.isFinite(value.yaw)))
      && (value.resourceNodeId === undefined || isPositiveInteger(value.resourceNodeId))
      && (value.builderUnitIds === undefined || (Array.isArray(value.builderUnitIds)
        && value.builderUnitIds.length <= 32 && value.builderUnitIds.every(isPositiveInteger)))
      && typeof value.queued === "boolean";
  }
  if (value.type === "queueUnit") {
    return isPositiveInteger(value.structureId)
      && ALL_SHIP_CLASSES.includes(value.shipClass as never)
      && isPositiveInteger(value.count) && Number(value.count) <= 5;
  }
  if (value.type === "cancelProduction") {
    return isPositiveInteger(value.structureId) && isPositiveInteger(value.queueItemId);
  }
  if (value.type === "cancelConstruction") return isPositiveInteger(value.structureId);
  if (value.type === "cancelBuildOrder") return isPositiveInteger(value.buildSequence);
  if (value.type === "setProductionRepeat") {
    return isPositiveInteger(value.structureId) && typeof value.enabled === "boolean";
  }
  if (value.type === "clearProductionQueue") return isPositiveInteger(value.structureId);
  return value.type === "setRallyPoint" && isPositiveInteger(value.structureId) && isVec2(value.position);
}

function isVec2(value: unknown): boolean {
  return isRecord(value) && Number.isFinite(value.x) && Number.isFinite(value.z);
}

function isCheckpoint(value: unknown): value is ReplayChecksumCheckpoint {
  return isRecord(value)
    && isNonNegativeInteger(value.tick)
    && isNonNegativeInteger(value.afterActionOrder)
    && isChecksum(value.checksum);
}

function isReplayResult(value: unknown): value is ReplayResult {
  return isRecord(value)
    && isNonNegativeInteger(value.tick)
    && isNonNegativeInteger(value.afterActionOrder)
    && isChecksum(value.checksum)
    && (value.status === "playing" || value.status === "finished")
    && (value.winnerTeamId === null || isPositiveInteger(value.winnerTeamId));
}

function isSimulationStateShape(value: unknown): value is SimulationState {
  return isRecord(value)
    && value.version === 7
    && isNonNegativeInteger(value.tick)
    && Array.isArray(value.players)
    && Array.isArray(value.teams)
    && Array.isArray(value.ships)
    && Array.isArray(value.structures)
    && Array.isArray(value.resourceNodes)
    && Array.isArray(value.obstacles)
    && Array.isArray(value.visibility)
    && Array.isArray(value.projectiles)
    && Array.isArray(value.commandQueue);
}

function safeChecksum(state: SimulationState): number | null {
  try {
    return calculateChecksum(state);
  } catch {
    return null;
  }
}

function isChecksum(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 0xffff_ffff;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
