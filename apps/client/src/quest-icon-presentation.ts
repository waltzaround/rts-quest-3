import type { Point3 } from "./quest-simulation";
import { STRATEGIC_COUNT_DISTANCE, STRATEGIC_COUNT_RETURN_DISTANCE } from "./quest-strategic";
import { ICON_HALF_ANGLE } from "./quest-icon-layout";

/** Retain readability, but allow nearer symbols to subtend a larger angle. */
export function iconHalfAngle(depth: number): number {
  return ICON_HALF_ANGLE * Math.max(0.62, Math.min(1.25, Math.sqrt(12 / Math.max(0.1, depth))));
}
export function iconEmphasis(depth: number, highlighted: boolean): number {
  return highlighted ? 1 : Math.max(0.42, Math.min(1, 1 - (depth - 8) / 45));
}
export function showHealthBar(selected: boolean, hovered: boolean, tick: number, lastDamageTick: number, constructing = false): boolean {
  return selected || hovered || constructing || (lastDamageTick >= 0 && tick - lastDamageTick <= 60);
}
export type IconCandidate = {
  id: number; side: number; type: string; encounter?: number | undefined;
  position: Point3; depth: number; x: number; y: number;
};
export type IconGroup = { id: number; members: number[]; position: Point3 };

/** Group in XYZ as well as projection: aligned but distant fleets must stay distinct. */
export function groupStrategicIcons(candidates: readonly IconCandidate[], expanded: ReadonlySet<number>, previousGrouped: ReadonlySet<number> = new Set(), countsEnabled = true): IconGroup[] {
  const remaining = new Set(candidates.map(p => p.id));
  const result: IconGroup[] = [];
  for (const seed of [...candidates].sort((a, b) => a.id - b.id)) {
    if (!remaining.has(seed.id)) continue;
    const threshold = previousGrouped.has(seed.id) ? STRATEGIC_COUNT_RETURN_DISTANCE : STRATEGIC_COUNT_DISTANCE;
    const nearby = countsEnabled && seed.type !== "structure" && seed.depth > threshold && !expanded.has(seed.id)
      ? candidates.filter(p => remaining.has(p.id) && !expanded.has(p.id) && p.depth > threshold && p.side === seed.side && p.type === seed.type && p.encounter === seed.encounter
        && Math.abs(p.depth - seed.depth) < Math.min(1.8, seed.depth * 0.12)
        && Math.hypot(p.x - seed.x, p.y - seed.y) < 0.055
        && Math.hypot(p.position.x - seed.position.x, p.position.y - seed.position.y, p.position.z - seed.position.z) < Math.min(1.5, seed.depth * 0.06))
      : [];
    const members = nearby.length >= 3 ? nearby : [seed];
    const position = { x: 0, y: 0, z: 0 };
    for (const p of members) {
      remaining.delete(p.id);
      position.x += p.position.x / members.length; position.y += p.position.y / members.length; position.z += p.position.z / members.length;
    }
    result.push({ id: seed.id, members: members.map(p => p.id), position });
  }
  return result;
}
