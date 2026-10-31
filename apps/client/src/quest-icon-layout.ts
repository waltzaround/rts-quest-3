export type IconPoint = { id: number; x: number; y: number; radius?: number };
export const ICON_HALF_ANGLE = 0.009;
export const MAX_ICON_OFFSET = 0.055;
const SPACING = 0.026;

/** Small, stable camera-plane offsets. Dense views aggregate instead of drifting off-unit. */
export class QuestIconLayout {
  private offsets = new Map<number, { x: number; y: number }>();
  clear(): void { this.offsets.clear(); }
  arrange(points: readonly IconPoint[]): Map<number, { x: number; y: number }> {
    const placed = new Map<number, { x: number; y: number }>();
    const occupied: Array<{ x: number; y: number; radius: number }> = [];
    for (const point of [...points].sort((a, b) => a.id - b.id)) {
      const radius = point.radius ?? ICON_HALF_ANGLE;
      const free = (x: number, y: number) => occupied.every(other =>
        Math.abs(x - other.x) >= radius + other.radius + 0.004 || Math.abs(y - other.y) >= radius + other.radius + 0.004);
      const old = this.offsets.get(point.id) ?? { x: 0, y: 0 };
      let x = point.x + old.x, y = point.y + old.y;
      if (!free(x, y)) {
        x = point.x; y = point.y;
        const offsets: Array<{ x: number; y: number }> = [];
        for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
          if (Math.hypot(dx * SPACING, dy * SPACING) <= MAX_ICON_OFFSET) offsets.push({ x: dx * SPACING, y: dy * SPACING });
        }
        offsets.sort((a, b) => a.x * a.x + a.y * a.y - b.x * b.x - b.y * b.y);
        for (const offset of offsets) if (free(point.x + offset.x, point.y + offset.y)) {
          x += offset.x; y += offset.y; break;
        }
      }
      const position = { x, y };
      placed.set(point.id, position); occupied.push({ ...position, radius });
      this.offsets.set(point.id, { x: x - point.x, y: y - point.y });
    }
    for (const id of this.offsets.keys()) if (!placed.has(id)) this.offsets.delete(id);
    return placed;
  }
}
