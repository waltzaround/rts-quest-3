export const SIMULATION_HZ = 20;
export const FIXED_DT = 1 / SIMULATION_HZ;

export type Vec2 = Readonly<{ x: number; z: number }>;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function wrapAngle(angle: number): number {
  let result = angle % (Math.PI * 2);
  if (result > Math.PI) result -= Math.PI * 2;
  if (result < -Math.PI) result += Math.PI * 2;
  return result;
}

export function moveTowardAngle(current: number, target: number, maxDelta: number): number {
  const delta = wrapAngle(target - current);
  return wrapAngle(current + clamp(delta, -maxDelta, maxDelta));
}

export function distanceSquared(a: Vec2, b: Vec2): number {
  const x = a.x - b.x;
  const z = a.z - b.z;
  return x * x + z * z;
}
