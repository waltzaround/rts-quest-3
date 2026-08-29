import * as THREE from "three";
import {
  SHIPS,
  type ShipState,
  type SimulationEvent,
  type StructureState,
  type WeaponTypeId,
} from "@space-rts/game-core";

const MAX_TRANSIENT_VOICES = 32;
const MAX_ENGINE_VOICES = 12;
const MAX_PENDING_CUES = 72;
const MAX_CUES_PER_SECOND = 30;
const ENGINE_UPDATE_INTERVAL_MS = 125;
const ENGINE_CELL_SIZE = 135;
const MAX_AUDIBLE_DISTANCE = 1_500;
const CUE_LIFETIME_MS = 280;
const MASTER_LEVEL = 0.7;
const ENGINE_BUS_LEVEL = 0.46;

type CueKind = WeaponTypeId | "impact" | "explosion" | "command" | "construction" | "launch" | "victory";

interface EntityAudioSnapshot {
  x: number;
  y: number;
  z: number;
  seenAt: number;
}

interface PendingCue {
  kind: CueKind;
  x: number;
  y: number;
  z: number;
  count: number;
  priority: number;
  queuedAt: number;
}

interface AggregatedCue extends PendingCue {
  weight: number;
}

interface TransientVoice {
  source: AudioBufferSourceNode | null;
  highpass: BiquadFilterNode;
  presence: BiquadFilterNode;
  gain: GainNode;
  panner: PannerNode;
  priority: number;
  startedAt: number;
}

interface EngineCluster {
  key: string;
  x: number;
  y: number;
  z: number;
  weight: number;
  count: number;
  rate: number;
  tone: number;
  score: number;
}

interface MutableEngineCluster extends EngineCluster {
  weightedX: number;
  weightedY: number;
  weightedZ: number;
  weightedRate: number;
  weightedTone: number;
}

interface EngineVoice {
  key: string | null;
  source: AudioBufferSourceNode;
  highpass: BiquadFilterNode;
  lowpass: BiquadFilterNode;
  gain: GainNode;
  panner: PannerNode;
  level: number;
}

export interface BattleAudioMetrics {
  supported: boolean;
  enabled: boolean;
  activeTransientVoices: number;
  activeEngineClusters: number;
  pendingCues: number;
  droppedCues: number;
  entitySnapshots: number;
}

const CUE_BASE_PRIORITY: Readonly<Record<CueKind, number>> = {
  pointDefense: 0.65,
  autocannon: 0.8,
  torpedo: 1.3,
  plasma: 1.05,
  heavyRail: 1.45,
  beam: 1.4,
  impact: 0.72,
  explosion: 1.8,
  command: 1.35,
  construction: 1.15,
  launch: 1.3,
  victory: 4,
};

const CUE_GAIN: Readonly<Record<CueKind, number>> = {
  pointDefense: 0.16,
  autocannon: 0.22,
  torpedo: 0.3,
  plasma: 0.25,
  heavyRail: 0.36,
  beam: 0.26,
  impact: 0.2,
  explosion: 0.4,
  command: 0.15,
  construction: 0.18,
  launch: 0.23,
  victory: 0.28,
};

const CUE_TONE: Readonly<Record<CueKind, { highpass: number; presence: number; boost: number }>> = {
  pointDefense: { highpass: 280, presence: 1_900, boost: 1.5 },
  autocannon: { highpass: 155, presence: 1_250, boost: 1.8 },
  torpedo: { highpass: 92, presence: 680, boost: 1.7 },
  plasma: { highpass: 120, presence: 1_050, boost: 1.6 },
  heavyRail: { highpass: 68, presence: 760, boost: 2.2 },
  beam: { highpass: 90, presence: 1_100, boost: 1.2 },
  impact: { highpass: 105, presence: 980, boost: 2.1 },
  explosion: { highpass: 62, presence: 560, boost: 2.2 },
  command: { highpass: 210, presence: 1_250, boost: 0.8 },
  construction: { highpass: 90, presence: 620, boost: 1 },
  launch: { highpass: 82, presence: 690, boost: 1.7 },
  victory: { highpass: 68, presence: 520, boost: 1.7 },
};

const SHIP_ENGINE_WEIGHT: Readonly<Record<ShipState["class"], number>> = {
  fighter: 0.32,
  fabricator: 0.68,
  frigate: 0.82,
  bomber: 0.58,
  flakFrigate: 0.92,
  torpedoFrigate: 0.98,
  destroyer: 1.55,
  cruiser: 2.2,
  carrier: 3.1,
  battleship: 3.8,
};

const SHIP_ENGINE_TONE: Readonly<Record<ShipState["class"], number>> = {
  fighter: 1_450,
  fabricator: 980,
  bomber: 1_050,
  frigate: 820,
  flakFrigate: 880,
  torpedoFrigate: 780,
  destroyer: 650,
  cruiser: 540,
  carrier: 460,
  battleship: 410,
};

const AudioContextConstructor = window.AudioContext
  ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

function setParam(param: AudioParam, value: number, at: number, timeConstant = 0.025): void {
  param.cancelScheduledValues(at);
  param.setTargetAtTime(value, at, timeConstant);
}

function setPannerPosition(panner: PannerNode, x: number, y: number, z: number, at: number): void {
  setParam(panner.positionX, x, at);
  setParam(panner.positionY, y, at);
  setParam(panner.positionZ, z, at);
}

function makePanner(context: AudioContext, refDistance: number, rolloff: number): PannerNode {
  const panner = context.createPanner();
  panner.panningModel = "equalpower";
  panner.distanceModel = "inverse";
  panner.refDistance = refDistance;
  panner.maxDistance = MAX_AUDIBLE_DISTANCE;
  panner.rolloffFactor = rolloff;
  return panner;
}

function makeBuffer(
  context: AudioContext,
  duration: number,
  render: (time: number, random: () => number) => number,
  seed: number,
): AudioBuffer {
  const length = Math.max(1, Math.floor(context.sampleRate * duration));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const output = buffer.getChannelData(0);
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
  for (let index = 0; index < length; index += 1) {
    const time = index / context.sampleRate;
    output[index] = THREE.MathUtils.clamp(render(time, random), -1, 1);
  }
  return buffer;
}

function createCueBuffers(context: AudioContext): Record<CueKind, AudioBuffer> {
  const noise = (random: () => number) => random() * 2 - 1;
  return {
    pointDefense: makeBuffer(context, 0.065, (time, random) => {
      const breech = noise(random) * Math.exp(-time * 180);
      const gas = noise(random) * Math.exp(-time * 52);
      const mechanism = Math.sin(Math.PI * 2 * 1_380 * time) * Math.exp(-time * 120);
      return breech * 0.82 + gas * 0.22 + mechanism * 0.14;
    }, 0x01de_fade),
    autocannon: makeBuffer(context, 0.14, (time, random) => {
      const muzzle = noise(random) * Math.exp(-time * 145);
      const pressure = Math.sin(Math.PI * 2 * (310 * time - 80 * time * time)) * Math.exp(-time * 38);
      const bolt = Math.sin(Math.PI * 2 * 760 * time) * Math.exp(-time * 68);
      return muzzle * 0.72 + pressure * 0.74 + bolt * 0.12;
    }, 0xac01_ca77),
    torpedo: makeBuffer(context, 0.42, (time, random) => {
      const latch = noise(random) * Math.exp(-time * 150);
      const tube = Math.sin(Math.PI * 2 * (165 * time - 18 * time * time)) * Math.exp(-time * 13);
      const compressedGas = noise(random) * Math.min(1, time * 70) * Math.exp(-time * 13);
      const ignition = Math.sin(Math.PI * 2 * 238 * time) * Math.exp(-time * 18);
      return latch * 0.58 + tube * 0.62 + compressedGas * 0.34 + ignition * 0.12;
    }, 0x70a9_ed01),
    plasma: makeBuffer(context, 0.32, (time, random) => {
      const discharge = noise(random) * Math.exp(-time * 22) * (0.75 + Math.sin(time * 740) * 0.25);
      const transformer = Math.sin(Math.PI * 2 * 176 * time) * Math.exp(-time * 11);
      const arc = Math.sin(Math.PI * 2 * 690 * time) * Math.exp(-time * 34);
      return discharge * 0.62 + transformer * 0.55 + arc * 0.13;
    }, 0x0b1a_5a11),
    heavyRail: makeBuffer(context, 0.43, (time, random) => {
      const shock = noise(random) * Math.exp(-time * 175);
      const recoil = Math.sin(Math.PI * 2 * (112 * time - 10 * time * time)) * Math.exp(-time * 9.5);
      const structure = Math.sin(Math.PI * 2 * 390 * time) * Math.exp(-time * 20);
      const rails = noise(random) * Math.exp(-time * 17) * (0.6 + Math.sin(time * 390) * 0.4);
      return shock * 0.9 + recoil * 0.5 + structure * 0.25 + rails * 0.22;
    }, 0x7a11_5eed),
    beam: makeBuffer(context, 0.39, (time, random) => {
      const breaker = noise(random) * Math.exp(-time * 130);
      const power = noise(random) * Math.min(1, time * 110) * Math.exp(-time * 12);
      const bus = Math.sin(Math.PI * 2 * 310 * time) * Math.exp(-time * 14) * (0.7 + Math.sin(time * 83) * 0.3);
      return breaker * 0.55 + power * 0.58 + bus * 0.3;
    }, 0xbea7_0001),
    impact: makeBuffer(context, 0.21, (time, random) => {
      const strike = noise(random) * Math.exp(-time * 125);
      const fracture = noise(random) * Math.exp(-time * 20);
      const hull = Math.sin(Math.PI * 2 * (355 * time - 42 * time * time)) * Math.exp(-time * 25);
      return strike * 0.78 + fracture * 0.4 + hull * 0.42;
    }, 0x1a9a_c701),
    explosion: makeBuffer(context, 0.72, (time, random) => {
      const detonation = noise(random) * Math.exp(-time * 135);
      const pressure = Math.sin(Math.PI * 2 * (128 * time - 14 * time * time)) * Math.exp(-time * 7.2);
      const breakup = noise(random) * Math.min(1, time * 55) * Math.exp(-time * 8.2);
      const secondary = time > 0.14 ? noise(random) * Math.exp(-(time - 0.14) * 28) : 0;
      return detonation * 0.9 + pressure * 0.48 + breakup * 0.5 + secondary * 0.25;
    }, 0xe7a1_0510),
    command: makeBuffer(context, 0.16, (time, random) => {
      const relay = noise(random) * Math.exp(-time * 165);
      const squelch = noise(random) * (time > 0.025 ? 1 : 0) * Math.exp(-time * 42);
      const terminal = Math.sin(Math.PI * 2 * 620 * time) * Math.exp(-time * 54);
      return relay * 0.42 + squelch * 0.18 + terminal * 0.14;
    }, 0xc011_a11d),
    construction: makeBuffer(context, 0.62, (time, random) => {
      const clamp = noise(random) * Math.exp(-time * 95);
      const machinery = noise(random) * Math.min(1, time * 35) * Math.exp(-time * 7.5);
      const chassis = Math.sin(Math.PI * 2 * 142 * time) * Math.exp(-time * 7);
      return clamp * 0.36 + machinery * 0.26 + chassis * 0.32;
    }, 0xc057_0001),
    launch: makeBuffer(context, 0.56, (time, random) => {
      const clamp = noise(random) * Math.exp(-time * 130);
      const thruster = noise(random) * Math.min(1, time * 28) * Math.exp(-time * 5.6);
      const deck = Math.sin(Math.PI * 2 * 148 * time) * Math.exp(-time * 9.2);
      return clamp * 0.44 + thruster * 0.46 + deck * 0.34;
    }, 0x1a0c_0001),
    victory: makeBuffer(context, 1.25, (time, random) => {
      const strike = noise(random) * Math.exp(-time * 70);
      const lowDrum = Math.sin(Math.PI * 2 * (96 * time - 5 * time * time)) * Math.exp(-time * 3.2);
      const distantMetal = Math.sin(Math.PI * 2 * 193 * time) * Math.exp(-time * 3.7);
      return strike * 0.36 + lowDrum * 0.48 + distantMetal * 0.18;
    }, 0x71c7_0001),
  };
}

function createEngineBuffer(context: AudioContext): AudioBuffer {
  return makeBuffer(context, 2.4, (time, random) => {
    const noise = random() * 2 - 1;
    const body = Math.sin(Math.PI * 2 * 58 * time) * 0.14
      + Math.sin(Math.PI * 2 * 91 * time) * 0.1;
    const turbine = Math.sin(Math.PI * 2 * (137 * time + Math.sin(time * 1.3) * 0.8)) * 0.1
      + Math.sin(Math.PI * 2 * 229 * time) * 0.045;
    const vibration = 0.86 + Math.sin(Math.PI * 2 * 0.83 * time) * 0.045
      + Math.sin(Math.PI * 2 * 2.7 * time) * 0.025;
    return (noise * 0.22 + body + turbine) * vibration;
  }, 0xe09e_1a11);
}

function createReverbImpulse(context: AudioContext): AudioBuffer {
  return makeBuffer(context, 0.72, (time, random) => {
    const earlyReflection = time > 0.028 && time < 0.034 ? (random() * 2 - 1) * 0.3 : 0;
    const tail = (random() * 2 - 1) * Math.exp(-time * 7.2) * Math.min(1, time * 65);
    return earlyReflection + tail * 0.2;
  }, 0x5aace_001);
}

/**
 * Client-only spatial audio with fixed node budgets. Ships are summarized into
 * coarse fleet clusters, while dense combat events are coalesced and rate limited.
 */
export class ScalableBattleAudio {
  readonly metrics: BattleAudioMetrics = {
    supported: Boolean(AudioContextConstructor),
    enabled: localStorage.getItem("voidfront:audio") !== "muted",
    activeTransientVoices: 0,
    activeEngineClusters: 0,
    pendingCues: 0,
    droppedCues: 0,
    entitySnapshots: 0,
  };

  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private transientBus: GainNode | null = null;
  private engineBus: GainNode | null = null;
  private cueBuffers: Record<CueKind, AudioBuffer> | null = null;
  private engineBuffer: AudioBuffer | null = null;
  private readonly transientVoices: TransientVoice[] = [];
  private readonly engineVoices: EngineVoice[] = [];
  private readonly pendingCues: PendingCue[] = [];
  private readonly entitySnapshots = new Map<number, EntityAudioSnapshot>();
  private readonly shipsById = new Map<number, ShipState>();
  private readonly clusterScratch = new Map<string, MutableEngineCluster>();
  private readonly forward = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private cueTokens = 8;
  private lastUpdateAt = 0;
  private lastEngineUpdateAt = -Infinity;
  private lastSnapshotPruneAt = 0;
  private hidden = document.hidden;

  get enabled(): boolean {
    return this.metrics.enabled;
  }

  async unlock(): Promise<void> {
    if (!this.metrics.enabled || !AudioContextConstructor || this.hidden) return;
    if (!this.context) this.initialize(AudioContextConstructor);
    if (this.context?.state === "suspended") await this.context.resume();
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.metrics.enabled = enabled;
    localStorage.setItem("voidfront:audio", enabled ? "enabled" : "muted");
    if (enabled) {
      await this.unlock();
      if (this.context && this.masterGain) setParam(this.masterGain.gain, MASTER_LEVEL, this.context.currentTime, 0.03);
    } else {
      this.pendingCues.length = 0;
      this.fadeAll(0.03);
    }
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (!this.context) return;
    if (hidden) {
      void this.context.suspend();
    } else if (this.metrics.enabled) {
      void this.context.resume();
    }
  }

  captureWorld(ships: readonly ShipState[], structures: readonly StructureState[], now = performance.now()): void {
    const visibleEntityIds = new Set<number>();
    for (const ship of ships) {
      visibleEntityIds.add(ship.id);
      const snapshot = this.entitySnapshots.get(ship.id);
      if (snapshot) {
        snapshot.x = ship.x;
        snapshot.y = ship.y + 5;
        snapshot.z = ship.z;
        snapshot.seenAt = now;
      } else {
        this.entitySnapshots.set(ship.id, { x: ship.x, y: ship.y + 5, z: ship.z, seenAt: now });
      }
      this.shipsById.set(ship.id, ship);
    }
    for (const structure of structures) {
      visibleEntityIds.add(structure.id);
      const snapshot = this.entitySnapshots.get(structure.id);
      if (snapshot) {
        snapshot.x = structure.x;
        snapshot.y = 8;
        snapshot.z = structure.z;
        snapshot.seenAt = now;
      } else {
        this.entitySnapshots.set(structure.id, { x: structure.x, y: 8, z: structure.z, seenAt: now });
      }
    }
    for (const id of this.entitySnapshots.keys()) {
      if (!visibleEntityIds.has(id)) this.entitySnapshots.delete(id);
    }
    for (const id of this.shipsById.keys()) {
      if (!visibleEntityIds.has(id)) this.shipsById.delete(id);
    }
    this.metrics.entitySnapshots = this.entitySnapshots.size;
  }

  ingestEvents(
    events: readonly SimulationEvent[],
    ships: readonly ShipState[],
    selectedShipIds: ReadonlySet<number>,
    now = performance.now(),
  ): void {
    if (events.length === 0) return;
    const grouped = new Map<string, AggregatedCue>();
    let eventShipsById: Map<number, ShipState> | null = null;

    for (const event of events) {
      let kind: CueKind | null = null;
      let entityId: number | null = null;
      let selected = false;
      if (event.type === "weaponFired") {
        const ship = this.shipsById.get(event.shipId);
        kind = event.weaponTypeId;
        entityId = event.shipId;
        selected = selectedShipIds.has(event.shipId);
      } else if (event.type === "hit") {
        kind = "impact";
        entityId = event.targetId;
      } else if (event.type === "destroyed") {
        kind = "explosion";
        entityId = event.entityId;
      } else if (event.type === "commandAccepted" && event.unitIds.length > 0) {
        kind = "command";
        entityId = event.unitIds[0] ?? null;
        selected = true;
      } else if (event.type === "constructionCompleted") {
        kind = "construction";
        entityId = event.structureId;
      } else if (event.type === "unitProduced") {
        kind = "launch";
        entityId = event.shipId;
        let producedShip = this.shipsById.get(event.shipId);
        if (!producedShip) {
          eventShipsById ??= new Map(ships.map((ship) => [ship.id, ship]));
          producedShip = eventShipsById.get(event.shipId);
        }
        if (producedShip) {
          this.entitySnapshots.set(producedShip.id, {
            x: producedShip.x, y: producedShip.y + 5, z: producedShip.z, seenAt: now,
          });
          this.shipsById.set(producedShip.id, producedShip);
        }
      } else if (event.type === "victory") {
        kind = "victory";
      }
      if (!kind) continue;
      const position = entityId === null ? { x: 0, y: 0, z: 0 } : this.entitySnapshots.get(entityId);
      if (!position) continue;
      const cellX = Math.floor(position.x / 100);
      const cellZ = Math.floor(position.z / 100);
      const key = `${kind}:${cellX}:${cellZ}`;
      const weight = selected ? 2.2 : 1;
      const existing = grouped.get(key);
      if (existing) {
        existing.weight += weight;
        existing.x += position.x * weight;
        existing.y += position.y * weight;
        existing.z += position.z * weight;
        existing.count += 1;
        existing.priority = Math.max(existing.priority, CUE_BASE_PRIORITY[kind] * (selected ? 1.5 : 1));
      } else {
        grouped.set(key, {
          kind,
          x: position.x * weight,
          y: position.y * weight,
          z: position.z * weight,
          weight,
          count: 1,
          priority: CUE_BASE_PRIORITY[kind] * (selected ? 1.5 : 1),
          queuedAt: now,
        });
      }
    }

    for (const cue of grouped.values()) {
      cue.x /= cue.weight;
      cue.y /= cue.weight;
      cue.z /= cue.weight;
      cue.priority *= 1 + Math.min(1.1, Math.log2(cue.count + 1) * 0.22);
      this.enqueue(cue);
    }
    this.metrics.pendingCues = this.pendingCues.length;
  }

  update(ships: readonly ShipState[], camera: THREE.PerspectiveCamera, now: number, paused: boolean): void {
    if (!this.context || !this.metrics.enabled || this.context.state !== "running") return;
    const context = this.context;
    const delta = this.lastUpdateAt === 0 ? 0 : Math.min(0.1, Math.max(0, (now - this.lastUpdateAt) / 1_000));
    this.lastUpdateAt = now;
    this.cueTokens = Math.min(10, this.cueTokens + delta * MAX_CUES_PER_SECOND);
    this.updateListener(camera, context.currentTime);
    if (this.engineBus) setParam(this.engineBus.gain, paused ? 0 : ENGINE_BUS_LEVEL, context.currentTime, 0.08);
    if (!paused && now - this.lastEngineUpdateAt >= ENGINE_UPDATE_INTERVAL_MS) {
      this.lastEngineUpdateAt = now;
      this.updateEngineClusters(ships, camera.position, context.currentTime);
    }
    this.flushPendingCues(camera.position, now);
    this.pruneSnapshots(now);
    this.refreshMetrics();
  }

  reset(): void {
    this.pendingCues.length = 0;
    this.entitySnapshots.clear();
    this.shipsById.clear();
    this.metrics.pendingCues = 0;
    this.metrics.entitySnapshots = 0;
    if (!this.context) return;
    const at = this.context.currentTime;
    for (const voice of this.transientVoices) {
      if (voice.source) {
        voice.source.onended = null;
        voice.source.stop();
        voice.source.disconnect();
        voice.source = null;
      }
      voice.priority = 0;
      setParam(voice.gain.gain, 0, at, 0.015);
    }
    for (const voice of this.engineVoices) {
      voice.key = null;
      voice.level = 0;
      setParam(voice.gain.gain, 0, at, 0.04);
    }
    this.refreshMetrics();
  }

  private initialize(Context: typeof AudioContext): void {
    const context = new Context({ latencyHint: "interactive" });
    this.context = context;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -13;
    compressor.knee.value = 8;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.008;
    compressor.release.value = 0.18;
    const masterHighpass = context.createBiquadFilter();
    masterHighpass.type = "highpass";
    masterHighpass.frequency.value = 48;
    masterHighpass.Q.value = 0.65;
    const master = context.createGain();
    master.gain.value = MASTER_LEVEL;
    master.connect(masterHighpass).connect(compressor).connect(context.destination);
    this.masterGain = master;
    const transientBus = context.createGain();
    transientBus.gain.value = 0.9;
    const transientShelf = context.createBiquadFilter();
    transientShelf.type = "highshelf";
    transientShelf.frequency.value = 2_400;
    transientShelf.gain.value = -1.5;
    transientBus.connect(transientShelf).connect(master);
    const reverbSend = context.createGain();
    reverbSend.gain.value = 0.07;
    const reverb = context.createConvolver();
    reverb.buffer = createReverbImpulse(context);
    const reverbTone = context.createBiquadFilter();
    reverbTone.type = "lowpass";
    reverbTone.frequency.value = 1_250;
    const reverbReturn = context.createGain();
    reverbReturn.gain.value = 0.12;
    transientBus.connect(reverbSend).connect(reverb).connect(reverbTone).connect(reverbReturn).connect(master);
    this.transientBus = transientBus;
    const engineBus = context.createGain();
    engineBus.gain.value = ENGINE_BUS_LEVEL;
    engineBus.connect(master);
    this.engineBus = engineBus;
    this.cueBuffers = createCueBuffers(context);
    this.engineBuffer = createEngineBuffer(context);

    for (let index = 0; index < MAX_TRANSIENT_VOICES; index += 1) {
      const highpass = context.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = 120;
      highpass.Q.value = 0.7;
      const presence = context.createBiquadFilter();
      presence.type = "peaking";
      presence.frequency.value = 1_800;
      presence.Q.value = 0.85;
      presence.gain.value = 4;
      const gain = context.createGain();
      gain.gain.value = 0;
      const panner = makePanner(context, 140, 1.05);
      highpass.connect(presence).connect(gain).connect(panner).connect(transientBus);
      this.transientVoices.push({ source: null, highpass, presence, gain, panner, priority: 0, startedAt: 0 });
    }
    for (let index = 0; index < MAX_ENGINE_VOICES; index += 1) {
      const source = context.createBufferSource();
      source.buffer = this.engineBuffer;
      source.loop = true;
      source.playbackRate.value = 0.82 + index * 0.013;
      const highpass = context.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = 68;
      highpass.Q.value = 0.7;
      const lowpass = context.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = 900;
      lowpass.Q.value = 0.55;
      const gain = context.createGain();
      gain.gain.value = 0;
      const panner = makePanner(context, 115, 0.92);
      source.connect(highpass).connect(lowpass).connect(gain).connect(panner).connect(engineBus);
      source.start(0, (index * 0.173) % this.engineBuffer.duration);
      this.engineVoices.push({ key: null, source, highpass, lowpass, gain, panner, level: 0 });
    }
  }

  private enqueue(cue: PendingCue): void {
    if (this.pendingCues.length < MAX_PENDING_CUES) {
      this.pendingCues.push(cue);
      return;
    }
    let weakestIndex = 0;
    for (let index = 1; index < this.pendingCues.length; index += 1) {
      if (this.pendingCues[index]!.priority < this.pendingCues[weakestIndex]!.priority) weakestIndex = index;
    }
    if (cue.priority > this.pendingCues[weakestIndex]!.priority) this.pendingCues[weakestIndex] = cue;
    this.metrics.droppedCues += 1;
  }

  private flushPendingCues(listener: THREE.Vector3, now: number): void {
    if (!this.context || !this.cueBuffers || this.pendingCues.length === 0) return;
    const viable: PendingCue[] = [];
    for (const cue of this.pendingCues) {
      if (now - cue.queuedAt > CUE_LIFETIME_MS) {
        this.metrics.droppedCues += 1;
        continue;
      }
      const distance = Math.hypot(cue.x - listener.x, cue.y - listener.y, cue.z - listener.z);
      cue.priority *= 1 / (1 + distance / 520);
      viable.push(cue);
    }
    viable.sort((a, b) => b.priority - a.priority);
    this.pendingCues.length = 0;
    const playCount = Math.min(5, viable.length, Math.floor(this.cueTokens));
    for (let index = 0; index < playCount; index += 1) {
      this.playCue(viable[index]!);
      this.cueTokens -= 1;
    }
    for (let index = playCount; index < viable.length; index += 1) this.pendingCues.push(viable[index]!);
    this.metrics.pendingCues = this.pendingCues.length;
  }

  private playCue(cue: PendingCue): void {
    if (!this.context || !this.cueBuffers) return;
    const context = this.context;
    let voice = this.transientVoices.find((candidate) => candidate.source === null);
    if (!voice) {
      voice = this.transientVoices.reduce((weakest, candidate) => candidate.priority < weakest.priority ? candidate : weakest);
      if (voice.priority > cue.priority) {
        this.metrics.droppedCues += 1;
        return;
      }
      voice.source!.onended = null;
      voice.source!.stop();
      voice.source!.disconnect();
    }
    const source = context.createBufferSource();
    source.buffer = this.cueBuffers[cue.kind];
    const densityWeight = 1 - Math.min(0.045, Math.log2(cue.count + 1) * 0.009);
    source.playbackRate.value = densityWeight * (0.985 + Math.random() * 0.03);
    const gain = CUE_GAIN[cue.kind] * Math.min(2.1, 1 + Math.log2(cue.count + 1) * 0.24);
    const tone = CUE_TONE[cue.kind];
    setParam(voice.highpass.frequency, tone.highpass, context.currentTime, 0.003);
    setParam(voice.presence.frequency, tone.presence, context.currentTime, 0.003);
    setParam(voice.presence.gain, tone.boost, context.currentTime, 0.003);
    setParam(voice.gain.gain, gain, context.currentTime, 0.004);
    setPannerPosition(voice.panner, cue.x, cue.y, cue.z, context.currentTime);
    source.connect(voice.highpass);
    voice.source = source;
    voice.priority = cue.priority;
    voice.startedAt = context.currentTime;
    source.onended = () => {
      if (voice?.source !== source) return;
      source.disconnect();
      voice.source = null;
      voice.priority = 0;
    };
    source.start();
  }

  private updateListener(camera: THREE.PerspectiveCamera, at: number): void {
    if (!this.context) return;
    camera.getWorldDirection(this.forward);
    this.up.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
    const listener = this.context.listener;
    setParam(listener.positionX, camera.position.x, at);
    setParam(listener.positionY, camera.position.y, at);
    setParam(listener.positionZ, camera.position.z, at);
    setParam(listener.forwardX, this.forward.x, at);
    setParam(listener.forwardY, this.forward.y, at);
    setParam(listener.forwardZ, this.forward.z, at);
    setParam(listener.upX, this.up.x, at);
    setParam(listener.upY, this.up.y, at);
    setParam(listener.upZ, this.up.z, at);
  }

  private updateEngineClusters(ships: readonly ShipState[], listener: THREE.Vector3, at: number): void {
    this.clusterScratch.clear();
    for (const ship of ships) {
      const dx = ship.x - listener.x;
      const dy = ship.y - listener.y;
      const dz = ship.z - listener.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance > MAX_AUDIBLE_DISTANCE) continue;
      const speedRatio = Math.min(1.25, Math.hypot(ship.vx, ship.vz) / Math.max(1, SHIPS[ship.class].speed));
      const weight = SHIP_ENGINE_WEIGHT[ship.class] * (0.25 + speedRatio * 0.75);
      const cellX = Math.floor(ship.x / ENGINE_CELL_SIZE);
      const cellZ = Math.floor(ship.z / ENGINE_CELL_SIZE);
      const key = `${cellX}:${cellZ}`;
      let cluster = this.clusterScratch.get(key);
      if (!cluster) {
        cluster = {
          key, x: 0, y: 0, z: 0, weightedX: 0, weightedY: 0, weightedZ: 0,
          weight: 0, count: 0, rate: 0, tone: 0, weightedRate: 0, weightedTone: 0, score: 0,
        };
        this.clusterScratch.set(key, cluster);
      }
      cluster.weightedX += ship.x * weight;
      cluster.weightedY += (ship.y + 2) * weight;
      cluster.weightedZ += ship.z * weight;
      cluster.weightedRate += (0.82 + speedRatio * 0.22 + SHIP_ENGINE_WEIGHT[ship.class] * 0.025) * weight;
      cluster.weightedTone += SHIP_ENGINE_TONE[ship.class] * weight;
      cluster.weight += weight;
      cluster.count += 1;
    }

    const ranked: EngineCluster[] = [];
    for (const cluster of this.clusterScratch.values()) {
      cluster.x = cluster.weightedX / cluster.weight;
      cluster.y = cluster.weightedY / cluster.weight;
      cluster.z = cluster.weightedZ / cluster.weight;
      cluster.rate = cluster.weightedRate / cluster.weight;
      cluster.tone = cluster.weightedTone / cluster.weight;
      const distance = Math.hypot(cluster.x - listener.x, cluster.y - listener.y, cluster.z - listener.z);
      cluster.score = cluster.weight * (1 / (1 + distance / 360));
      ranked.push(cluster);
    }
    ranked.sort((a, b) => b.score - a.score);
    this.assignEngineVoices(ranked.slice(0, MAX_ENGINE_VOICES), at);
  }

  private assignEngineVoices(clusters: readonly EngineCluster[], at: number): void {
    const byKey = new Map(this.engineVoices.filter((voice) => voice.key !== null).map((voice) => [voice.key!, voice]));
    const used = new Set<EngineVoice>();
    for (const cluster of clusters) {
      let voice = byKey.get(cluster.key);
      if (!voice) voice = this.engineVoices.find((candidate) => !used.has(candidate) && !clusters.some((item) => item.key === candidate.key));
      if (!voice) continue;
      used.add(voice);
      voice.key = cluster.key;
      voice.level = Math.min(0.12, 0.01 + Math.sqrt(cluster.weight) * 0.014);
      setPannerPosition(voice.panner, cluster.x, cluster.y, cluster.z, at);
      setParam(voice.gain.gain, voice.level, at, 0.12);
      setParam(voice.source.playbackRate, cluster.rate, at, 0.16);
      setParam(voice.highpass.frequency, 42 + Math.min(28, (cluster.rate - 0.8) * 65), at, 0.2);
      setParam(voice.lowpass.frequency, Math.min(1_350, cluster.tone * 0.82 + cluster.count * 9), at, 0.2);
    }
    for (const voice of this.engineVoices) {
      if (used.has(voice)) continue;
      voice.key = null;
      voice.level = 0;
      setParam(voice.gain.gain, 0, at, 0.18);
    }
  }

  private pruneSnapshots(now: number): void {
    if (now - this.lastSnapshotPruneAt < 5_000) return;
    this.lastSnapshotPruneAt = now;
    for (const [id, snapshot] of this.entitySnapshots) {
      if (now - snapshot.seenAt <= 12_000) continue;
      this.entitySnapshots.delete(id);
      this.shipsById.delete(id);
    }
    this.metrics.entitySnapshots = this.entitySnapshots.size;
  }

  private fadeAll(timeConstant: number): void {
    if (!this.context) return;
    const at = this.context.currentTime;
    if (this.masterGain) setParam(this.masterGain.gain, this.metrics.enabled ? MASTER_LEVEL : 0, at, timeConstant);
    for (const voice of this.engineVoices) setParam(voice.gain.gain, 0, at, timeConstant);
  }

  private refreshMetrics(): void {
    this.metrics.activeTransientVoices = this.transientVoices.reduce((count, voice) => count + (voice.source ? 1 : 0), 0);
    this.metrics.activeEngineClusters = this.engineVoices.reduce((count, voice) => count + (voice.key ? 1 : 0), 0);
    this.metrics.pendingCues = this.pendingCues.length;
  }
}
