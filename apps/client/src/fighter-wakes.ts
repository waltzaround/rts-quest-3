import * as THREE from "three";
import type { RenderQuality } from "./render-state";

const MAX_CRAFT = 1_280;
const SAMPLES = 6;
const SAMPLE_TICKS = 0.9;

/** Short curved engine wakes in one draw call. History uses simulation time,
 * fixed buffers and a quality cap, and is discarded on seeks or visibility loss.
 */
export class FighterWakes {
  readonly mesh: THREE.LineSegments;
  private readonly positions = new THREE.BufferAttribute(new Float32Array(MAX_CRAFT * SAMPLES * 6), 3);
  private readonly colors = new THREE.BufferAttribute(new Float32Array(MAX_CRAFT * SAMPLES * 6), 3);
  private readonly points = new Float32Array(MAX_CRAFT * SAMPLES * 3);
  private readonly times = new Float64Array(MAX_CRAFT);
  private readonly heads = new Uint8Array(MAX_CRAFT);
  private readonly counts = new Uint8Array(MAX_CRAFT);
  private readonly seen = new Uint32Array(MAX_CRAFT);
  private readonly slots = new Map<number, number>();
  private readonly free: number[] = [];
  private readonly nozzle = new THREE.Vector3();
  private frame = 0;
  private tick = 0;
  private limit = 0;
  private vertex = 0;
  private craftCount = 0;

  constructor() {
    this.positions.setUsage(THREE.DynamicDrawUsage);
    this.colors.setUsage(THREE.DynamicDrawUsage);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", this.positions);
    geometry.setAttribute("color", this.colors);
    geometry.setDrawRange(0, 0);
    this.mesh = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.24,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    this.mesh.name = "fighter-wakes";
    this.mesh.frustumCulled = false;
    this.clear();
  }

  clear(): void {
    this.slots.clear();
    this.free.length = 0;
    for (let i = MAX_CRAFT - 1; i >= 0; i--) this.free.push(i);
    this.counts.fill(0);
    this.mesh.geometry.setDrawRange(0, 0);
  }

  beginFrame(tick: number, quality: RenderQuality): void {
    if (tick < this.tick || tick - this.tick > 10 || (quality === "low" && this.slots.size > 0)) this.clear();
    this.frame++;
    this.tick = tick;
    this.limit = quality === "high" ? MAX_CRAFT : quality === "medium" ? 640 : 0;
    this.vertex = 0;
    this.craftCount = 0;
    for (const [id, slot] of this.slots) {
      if (this.seen[slot]! < this.frame - 1) {
        this.slots.delete(id);
        this.counts[slot] = 0;
        this.free.push(slot);
      }
    }
  }

  write(shipId: number, member: number, matrix: THREE.Matrix4, color: THREE.Color, reset: boolean): void {
    if (this.craftCount++ >= this.limit) return;
    const id = shipId * 5 + member;
    let slot = this.slots.get(id);
    if (slot === undefined) {
      slot = this.free.pop();
      if (slot === undefined) return;
      this.slots.set(id, slot);
      this.counts[slot] = 0;
    }
    this.seen[slot] = this.frame;
    if (reset) this.counts[slot] = 0;
    this.nozzle.set(0, 0.45, -3.6).applyMatrix4(matrix);
    let head = this.heads[slot]!;
    const oldPoint = (slot * SAMPLES + head) * 3;
    const dx = this.nozzle.x - this.points[oldPoint]!, dy = this.nozzle.y - this.points[oldPoint + 1]!, dz = this.nozzle.z - this.points[oldPoint + 2]!;
    if (dx * dx + dy * dy + dz * dz > 60 * 60) this.counts[slot] = 0;
    if (this.counts[slot] === 0 || this.tick - this.times[slot]! >= SAMPLE_TICKS) {
      head = (head + 1) % SAMPLES;
      this.heads[slot] = head;
      this.times[slot] = this.tick;
      this.counts[slot] = Math.min(SAMPLES, this.counts[slot]! + 1);
      const point = (slot * SAMPLES + head) * 3;
      this.points[point] = this.nozzle.x;
      this.points[point + 1] = this.nozzle.y;
      this.points[point + 2] = this.nozzle.z;
    }
    let x = this.nozzle.x, y = this.nozzle.y, z = this.nozzle.z;
    for (let sample = 0; sample < this.counts[slot]!; sample++) {
      const point = (slot * SAMPLES + (head - sample + SAMPLES) % SAMPLES) * 3;
      const nx = this.points[point]!, ny = this.points[point + 1]!, nz = this.points[point + 2]!;
      const brightness = (1 - sample / SAMPLES) ** 2;
      const tail = (1 - (sample + 1) / SAMPLES) ** 2;
      this.positions.setXYZ(this.vertex, x, y, z);
      this.colors.setXYZ(this.vertex++, color.r * brightness, color.g * brightness, color.b * brightness);
      this.positions.setXYZ(this.vertex, nx, ny, nz);
      this.colors.setXYZ(this.vertex++, color.r * tail, color.g * tail, color.b * tail);
      x = nx; y = ny; z = nz;
    }
  }

  endFrame(): void {
    this.mesh.visible = this.vertex > 0;
    this.mesh.geometry.setDrawRange(0, this.vertex);
    if (this.vertex === 0) return;
    for (const attribute of [this.positions, this.colors]) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, this.vertex * 3);
      attribute.needsUpdate = true;
    }
  }
}
