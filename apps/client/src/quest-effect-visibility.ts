import type { Point3 } from "./quest-simulation";
import { SHIP_DETAIL_DISTANCE } from "./quest-strategic";

/** Local combat stays vivid; effects fade through the detail range and disappear in overview. */
export function weaponEffectStrength(camera: Point3, from: Point3, to = from, overview = false): number {
  if (overview) return 0;
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  const t = lengthSquared ? Math.max(0, Math.min(1,
    ((camera.x - from.x) * dx + (camera.y - from.y) * dy + (camera.z - from.z) * dz) / lengthSquared)) : 0;
  const distance = Math.hypot(from.x + t * dx - camera.x, from.y + t * dy - camera.y, from.z + t * dz - camera.z);
  return Math.max(0, Math.min(1, (SHIP_DETAIL_DISTANCE - distance) / (SHIP_DETAIL_DISTANCE / 2)));
}
