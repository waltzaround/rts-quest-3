import * as THREE from "three";
import { FIGHTER_SQUAD_OFFSETS, SHIP_TURRET_SCALES, WEAPONS, getTurretMuzzleWorldPosition, type FactionId, type ShipState, type ProjectileState } from "@space-rts/game-core";

import { FIXED_DT } from "@space-rts/shared";

export const FIGHTER_GUN_HEIGHT = 0.98;
export const FIGHTER_GUN_Z = 2.1 + WEAPONS.autocannon.muzzleOffset * SHIP_TURRET_SCALES.fighter;
export const FIGHTER_GUN_SEPARATION = WEAPONS.autocannon.muzzleSeparation * SHIP_TURRET_SCALES.fighter;

export function fighterMemberCount(healthRatio: number): number {
  return Math.max(0, Math.min(FIGHTER_SQUAD_OFFSETS.length, Math.ceil(healthRatio * FIGHTER_SQUAD_OFFSETS.length - 1e-6)));
}

const position = new THREE.Vector3();
const rotation = new THREE.Quaternion();
const attitude = new THREE.Euler(0, 0, 0, "YXZ");
const scale = new THREE.Vector3(1, 1, 1);

// Distances stay inside the squad's visual envelope. Each pilot flies an
// independently inclined ellipse: broad banking passes, restless swarming,
// or restrained vertical slashes, respectively.
const FLIGHT_STYLES = {
  industrial: { rate: 0.72, width: 20, lift: 11, depth: 17, bank: 1.15, rollResponse: 24, maxRoll: 1.1 },
  brood: { rate: 0.95, width: 25, lift: 16, depth: 23, bank: 0.8, rollResponse: 19, maxRoll: 1.25 },
  concord: { rate: 0.65, width: 14, lift: 16, depth: 18, bank: 0.35, rollResponse: 42, maxRoll: 0.55 },
} satisfies Record<FactionId, { rate: number; width: number; lift: number; depth: number;
  bank: number; rollResponse: number; maxRoll: number }>;

/** Bounded, continuous flight paths around the authoritative squad center.
 * Nose and roll follow the path's velocity/acceleration, rather than unrelated
 * jitter. Fixed guns, exhaust and launch VFX all use this same cached matrix.
 */
export function fighterMemberMatrix(
  target: THREE.Matrix4, shipId: number, member: number, tick: number,
  x: number, y: number, z: number, yaw: number, bank: number,
  speed = 60, engagement = 0, pitch = 0, faction: FactionId = "industrial", turnVelocity = 0, formationYaw = yaw,
): THREE.Matrix4 {
  const base = FIGHTER_SQUAD_OFFSETS[member] ?? FIGHTER_SQUAD_OFFSETS[0]!;
  const style = FLIGHT_STYLES[faction];
  const time = tick * FIXED_DT;
  const phase = (shipId % 997) * 2.399963 + member * 1.618034;
  const rate = style.rate * (0.85 + ((shipId + member * 7) % 13) * 0.027);
  const a = time * rate + phase, b = time * rate * 0.57 + phase * 1.37;
  const sa = Math.sin(a), ca = Math.cos(a), sb = Math.sin(b), cb = Math.cos(b);
  const combat = THREE.MathUtils.clamp(engagement, 0, 1);
  const activity = Math.min(1, speed / 55) * (0.22 + combat * 0.78);
  const width = style.width * activity, depth = style.depth * activity, lift = style.lift * activity;
  const inclination = Math.sin(phase * 0.73) * (faction === "concord" ? 0.45 : 1.15);
  const ci = Math.cos(inclination), si = Math.sin(inclination);
  const sweep = width * (sa + sb * 0.25), heave = lift * ca;
  const sweepSpeed = width * rate * (ca + cb * 0.1425), heaveSpeed = -lift * rate * sa;
  const sweepAcceleration = -width * rate * rate * (sa + sb * 0.081225);
  const heaveAcceleration = -lift * rate * rate * ca;
  // Release assigned slots in combat, then rejoin as engagement fades. The
  // independent phases let pilots cross ahead/behind and above/below peers.
  const cohesion = 1 - combat * 0.65;
  const localX = base[0] * cohesion + sweep * ci - heave * si;
  const localY = sweep * si + heave * ci;
  const localZ = base[1] * cohesion + depth * cb;
  const dx = sweepSpeed * ci - heaveSpeed * si, dz = -depth * rate * 0.57 * sb;
  // A rotating formation slot has its own velocity. Ignoring these terms
  // makes every nose share the squad heading while its hull slides around
  // the same pivot, especially the inside/outside craft in a tight turn.
  const travelAngle = yaw - formationYaw;
  const lateralSpeed = Math.sin(travelAngle) * speed + dx + turnVelocity * localZ;
  const forwardSpeed = Math.cos(travelAngle) * speed + dz - turnVelocity * localX;
  const climbSpeed = sweepSpeed * si + heaveSpeed * ci;
  const lateralAcceleration = sweepAcceleration * ci - heaveAcceleration * si
    + 2 * turnVelocity * dz - turnVelocity * turnVelocity * localX;
  const forwardAcceleration = -depth * rate * rate * 0.3249 * cb
    - 2 * turnVelocity * dx - turnVelocity * turnVelocity * localZ;
  const heading = Math.atan2(lateralSpeed, forwardSpeed);
  const sideAcceleration = lateralAcceleration * Math.cos(heading) - forwardAcceleration * Math.sin(heading);
  const roll = THREE.MathUtils.clamp(bank * style.bank
    - Math.atan2(sideAcceleration, style.rollResponse), -style.maxRoll, style.maxRoll);
  const c = Math.cos(formationYaw), s = Math.sin(formationYaw);
  position.set(x + c * localX + s * localZ, y + localY, z - s * localX + c * localZ);
  attitude.set(pitch - Math.atan2(climbSpeed, Math.max(0.001, Math.hypot(lateralSpeed, forwardSpeed))), formationYaw + heading, roll, "YXZ");
  rotation.setFromEuler(attitude);
  return target.compose(position, rotation, scale);
}

export function fighterMuzzlePosition(target: THREE.Vector3, matrix: THREE.Matrix4, fireSequence: number): THREE.Vector3 {
  return target.set((fireSequence % 2 === 0 ? -1 : 1) * FIGHTER_GUN_SEPARATION,
    FIGHTER_GUN_HEIGHT, FIGHTER_GUN_Z).applyMatrix4(matrix);
}

/** Spectator snapshots can contain several burst rounds but only the latest
 * turret fire sequence. Recover unlabelled rounds from their launch position.
 */
export function inferFighterFiringMember(ship: ShipState, projectile: ProjectileState, tick: number): number {
  const age = Math.max(0, WEAPONS[projectile.weaponTypeId].projectileLifetimeTicks - projectile.lifetimeTicks);
  const seconds = age * FIXED_DT;
  const launchX = projectile.x - projectile.vx * seconds;
  const launchZ = projectile.z - projectile.vz * seconds;
  const atLaunch = { ...ship, x: ship.x - ship.vx * seconds, z: ship.z - ship.vz * seconds };
  let closest = 0, distance = Infinity;
  ship.turrets.forEach((turret, member) => {
    const muzzle = getTurretMuzzleWorldPosition(atLaunch, turret, 0, Math.max(0, tick - age));
    const squared = (muzzle.x - launchX) ** 2 + (muzzle.z - launchZ) ** 2;
    if (squared < distance) { distance = squared; closest = member; }
  });
  return closest;
}
