import * as THREE from "three";
import { WORLD_SCALE, type CombatEntity } from "./quest-combat";
import { fighterMemberMatrix, fighterMemberCount } from "./fighter-visuals";
import { VOLUME, type Point3 } from "./quest-simulation";

export function inBattleVolume(point: Point3, volume = VOLUME): boolean {
  return Math.abs(point.x) <= volume.x && Math.abs(point.z) <= volume.z && point.y >= volume.minY && point.y <= volume.maxY;
}

/** Physical 3 cm contact tolerance, independent of battlefield magnification. */
export function directContact(entities: readonly CombatEntity[], point: Point3, scale: number, tick = 0, iconRadii?: ReadonlyMap<number, number>, iconPositions?: ReadonlyMap<number, Point3>, pickableIds?: ReadonlySet<number>): CombatEntity | undefined {
  let closest: CombatEntity | undefined, best = Infinity;
  for (const entity of entities) {
    if (entity.health <= 0 || (pickableIds && !pickableIds.has(entity.id))) continue;
    const iconRadius = iconRadii?.get(entity.id);
    const position = iconPositions?.get(entity.id) ?? entity.position;
    if (iconRadius !== undefined && iconPositions && !iconPositions.has(entity.id)) continue;
    let gap = Math.hypot(point.x - position.x, point.y - position.y, point.z - position.z) - (iconRadius ?? entity.radius);
    if (entity.shipClass === "fighter" && iconRadius === undefined) {
      gap = Infinity;
      for (let member = 0; member < fighterMemberCount(entity.health / entity.maxHealth); member++) {
        fighterMemberMatrix(memberMatrix, entity.id, member, tick,
          entity.position.x / WORLD_SCALE, entity.position.y / WORLD_SCALE, entity.position.z / WORLD_SCALE,
          Math.atan2(entity.forward.x, entity.forward.z), 0, Math.hypot(entity.velocity.x, entity.velocity.y, entity.velocity.z) / WORLD_SCALE,
          entity.combatTargetId === null ? 0 : 1, -Math.asin(entity.forward.y));
        memberPosition.setFromMatrixPosition(memberMatrix).multiplyScalar(WORLD_SCALE);
        gap = Math.min(gap, memberPosition.distanceTo(new THREE.Vector3().copy(point)) - 0.012);
      }
    }
    if (gap <= 0.03 / Math.max(0.01, scale) && gap < best) { closest = entity; best = gap; }
  }
  return closest;
}

const memberMatrix = new THREE.Matrix4(), memberPosition = new THREE.Vector3();
