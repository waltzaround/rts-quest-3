import * as THREE from "three";
import type { QuestBattle } from "./quest-combat";
import type { Point3 } from "./quest-simulation";

const FILES: Record<string, string> = {
  autocannon: "autocannon.ogg", torpedo: "torpedo.ogg", plasma: "plasma.ogg", heavyRail: "heavy-rail.ogg",
  pointDefense: "point-defense.ogg", flakCannon: "flak-cannon.ogg", beam: "beam.wav",
  lightArtillery: "light-artillery.ogg", siegeArtillery: "siege-artillery.ogg", strategicArtillery: "strategic-artillery.ogg",
  impact: "impact.ogg", explosion: "explosion.ogg", engine: "engine-loop.ogg",
};
type Cue = { kind: string; point: Point3 };
export function questAudioCues(battle: QuestBattle, previousShots: ReadonlySet<number>): Cue[] {
  if (battle.status !== "running") return [];
  const cues: Cue[] = [];
  for (const event of battle.events) if (event.kind === "destroy") cues.push({ kind: "explosion", point: event.to });
  for (const event of battle.events) if (event.kind !== "destroy") cues.push({ kind: event.kind === "beam" ? "beam" : event.kind === "intercept" ? "pointDefense" : "impact", point: event.kind === "beam" ? event.from : event.to });
  for (const shot of battle.projectiles) if (!previousShots.has(shot.id)) cues.push({ kind: shot.weapon, point: shot.previous });
  // Coalesce dense gunfire: at most one cue of each kind per simulation update.
  return cues.filter((cue, index) => cues.findIndex(other => other.kind === cue.kind) === index).slice(0, 8);
}

type Voice = { source: AudioBufferSourceNode; panner: PannerNode; gain: GainNode; point: THREE.Vector3 };

/** Head-tracked audio using the original assets, with bounded overlapping voices. */
export class QuestAudio {
  enabled = true;
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private voices = new Set<Voice>();
  private previousShots = new Set<number>();
  private engine: Voice | null = null;
  private loading: Promise<void> | null = null;
  private tokens = 8;
  private lastTime = 0;
  private position = new THREE.Vector3();
  private forward = new THREE.Vector3();
  private up = new THREE.Vector3();
  private orientation = new THREE.Quaternion();
  get status(): string {
    if (!this.enabled) return "Muted";
    if (!this.context) return "Audio ready";
    if (this.context.state !== "running") return "Tap to enable audio";
    return this.buffers.size ? "Audio on" : "Loading audio…";
  }
  async unlock(): Promise<void> {
    if (!this.enabled || !globalThis.AudioContext) return;
    try {
      if (!this.context) {
        const context = this.context = new AudioContext();
        this.master = context.createGain(); this.master.gain.value = 0;
        const limiter = context.createDynamicsCompressor(); limiter.threshold.value = -12; limiter.ratio.value = 8;
        this.master.connect(limiter); limiter.connect(context.destination);
        this.loading = Promise.all(Object.entries(FILES).map(async ([kind, file]) => {
          try { const response = await fetch(`/audio/${file}`); if (response.ok) this.buffers.set(kind, await context.decodeAudioData(await response.arrayBuffer())); } catch { /* Other cues can still play. */ }
        })).then(() => {});
      }
      if (this.context.state === "suspended") await this.context.resume();
      await this.loading;
    } catch { /* A later explicit user gesture can retry. */ }
  }
  toggle(): void { this.enabled = !this.enabled; if (this.enabled) void this.unlock(); else this.silence(); }
  silence(): void {
    if (this.context && this.master) this.master.gain.setTargetAtTime(0, this.context.currentTime, 0.015);
    for (const voice of [...this.voices]) voice.source.stop();
  }
  reset(): void { this.silence(); this.previousShots.clear(); this.tokens = 8; }
  private play(cue: Cue, loop = false): Voice | null {
    const context = this.context, buffer = this.buffers.get(cue.kind);
    if (!context || !this.master || !buffer) return null;
    const source = context.createBufferSource(); source.buffer = buffer; source.loop = loop;
    const panner = context.createPanner(); panner.panningModel = "HRTF"; panner.distanceModel = "inverse";
    panner.refDistance = 1; panner.maxDistance = 30; panner.rolloffFactor = 0.9;
    const gain = context.createGain(); gain.gain.value = loop ? 0.07 : cue.kind === "explosion" ? 0.5 : cue.kind === "impact" ? 0.13 : 0.23;
    source.connect(gain); gain.connect(panner); panner.connect(this.master);
    const voice = { source, gain, panner, point: new THREE.Vector3().copy(cue.point) };
    if (!loop) { this.voices.add(voice); source.onended = () => { this.voices.delete(voice); source.disconnect(); gain.disconnect(); panner.disconnect(); }; }
    source.start(); return voice;
  }
  update(battle: QuestBattle, world: THREE.Group, camera: THREE.Camera, visible: boolean): void {
    const cues = questAudioCues(battle, this.previousShots);
    this.previousShots = new Set(battle.projectiles.map(p => p.id));
    const context = this.context;
    if (!context || context.state !== "running" || !this.master) return;
    const now = context.currentTime;
    this.tokens = Math.min(8, this.tokens + Math.min(0.1, now - this.lastTime) * 24); this.lastTime = now;
    const audible = this.enabled && visible && battle.status === "running";
    this.master.gain.setTargetAtTime(audible ? 0.55 : 0, now, 0.025);
    camera.getWorldPosition(this.position); camera.getWorldQuaternion(this.orientation);
    this.forward.set(0, 0, -1).applyQuaternion(this.orientation); this.up.set(0, 1, 0).applyQuaternion(this.orientation);
    const listener = context.listener;
    listener.setPosition(this.position.x, this.position.y, this.position.z);
    listener.setOrientation(this.forward.x, this.forward.y, this.forward.z, this.up.x, this.up.y, this.up.z);
    if (audible) {
      for (const cue of cues) if (this.tokens >= 1 && this.voices.size < 24) {
        if (this.play(cue)) this.tokens--;
      }
      this.engine ??= this.play({ kind: "engine", point: { x: 0, y: 0.65, z: 0 } }, true);
    }
    world.updateWorldMatrix(true, false);
    for (const voice of [...this.voices, ...(this.engine ? [this.engine] : [])]) {
      this.position.copy(voice.point); world.localToWorld(this.position);
      voice.panner.positionX.setValueAtTime(this.position.x, now); voice.panner.positionY.setValueAtTime(this.position.y, now); voice.panner.positionZ.setValueAtTime(this.position.z, now);
    }
  }
}
