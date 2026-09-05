import * as THREE from "three";
import { FIGHTER_SQUAD_OFFSETS, SHIP_TURRET_SCALES, WEAPONS, getTurretMuzzleWorldPosition, type ShipState, type ProjectileState } from "@space-rts/game-core";

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

/** Bounded, continuous flight paths around the authoritative squad center.
 * Nose and roll follow the path's velocity/acceleration, rather than unrelated
 * jitter. Fixed guns, exhaust and launch VFX all use this same cached matrix.
 */
export function fighterMemberMatrix(
  target: THREE.Matrix4, shipId: number, member: number, tick: number,
  x: number, y: number, z: number, yaw: number, bank: number,
  speed = 60, engagement = 0, pitch = 0,
): THREE.Matrix4 {
  const base = FIGHTER_SQUAD_OFFSETS[member] ?? FIGHTER_SQUAD_OFFSETS[0]!;
  const time = tick * FIXED_DT;
  const phase = (shipId % 997) * 2.399963 + member * 1.618034;
  const rate = 0.8 + ((shipId + member * 7) % 13) * 0.027;
  const a = time * rate + phase, b = time * rate * 0.57 + phase * 1.37;
  const sa = Math.sin(a), ca = Math.cos(a), sb = Math.sin(b), cb = Math.cos(b);
  const activity = 0.3 + Math.min(1, speed / 55) * 0.3 + engagement * 0.4;
  const width = (member === 0 ? 4 : 6.5) * activity;
  const depth = (4 + engagement * 4) * activity;
  const lift = (1.5 + engagement * 4) * activity;
  const localX = base[0] + width * (sa + sb * 0.32) - bank * base[1] * 0.22;
  const localZ = base[1] + depth * cb;
  const localY = lift * Math.sin(b + member * 0.8);
  const lateralSpeed = width * rate * (ca + cb * 0.1824);
  const forwardSpeed = Math.max(24, speed) - depth * rate * 0.57 * sb;
  const climbSpeed = lift * rate * 0.57 * Math.cos(b + member * 0.8);
  const lateralAcceleration = -width * rate * rate * (sa + sb * 0.103968);
  const heading = Math.atan2(lateralSpeed, forwardSpeed);
  const roll = THREE.MathUtils.clamp(bank * (0.8 + member * 0.045)
    - Math.atan2(lateralAcceleration, 18), -0.85, 0.85);
  const c = Math.cos(yaw), s = Math.sin(yaw);
  position.set(x + c * localX + s * localZ, y + localY, z - s * localX + c * localZ);
  attitude.set(pitch - Math.atan2(climbSpeed, forwardSpeed), yaw + heading, roll, "YXZ");
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
