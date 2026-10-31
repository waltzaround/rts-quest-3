import { STRATEGIC_COUNT_DISTANCE, STRATEGIC_COUNT_RETURN_DISTANCE } from "./quest-strategic";

export function smoothBand(distance: number, near: number, far: number): number {
  const t = Math.max(0, Math.min(1, (distance - near) / (far - near)));
  return t * t * (3 - 2 * t);
}
export const cardWeight = (distance: number): number => smoothBand(distance, STRATEGIC_COUNT_RETURN_DISTANCE, STRATEGIC_COUNT_DISTANCE);
export const modelWeight = (distance: number): number => 1 - smoothBand(distance, 8, 10.5);
/** Bring displaced symbols home while they are still legible, before the hull crossfade. */
export const iconAnchorWeight = (distance: number): number => 1 - smoothBand(distance, 10.5, 18);

/** Short, frame-rate-independent easing also handles sudden dive/overview jumps. */
export function easeView(current: number | undefined, target: number, seconds: number): number {
  if (current === undefined || seconds <= 0) return target;
  const next = current + (target - current) * (1 - Math.exp(-seconds / 0.12));
  return Math.abs(next - target) < 0.001 ? target : next;
}
