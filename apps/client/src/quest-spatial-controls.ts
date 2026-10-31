import { Vector3 } from "three";
import type { QuestBattle, Order } from "./quest-combat";
import type { Point3 } from "./quest-simulation";

export const MIN_BATTLE_SCALE = 0.02;
export const MAX_BATTLE_SCALE = 12;

/** Keep the world point under the hands fixed while translating and scaling. */
export function grabTransform(position: Vector3, scale: number, previous: Vector3[], current: Vector3[]): { position: Vector3; scale: number } {
  if (!previous.length || previous.length !== current.length) return { position: position.clone(), scale };
  const center = (points: Vector3[]) => points.reduce((sum, point) => sum.add(point), new Vector3()).divideScalar(points.length);
  const before = center(previous), after = center(current);
  const oldSpan = previous.length === 2 ? previous[0]!.distanceTo(previous[1]!) : 0;
  const ratio = oldSpan > 0.06 ? current[0]!.distanceTo(current[1]!) / oldSpan : 1;
  const nextScale = Math.max(MIN_BATTLE_SCALE, Math.min(MAX_BATTLE_SCALE, scale * ratio));
  return { position: position.clone().sub(before).multiplyScalar(nextScale / scale).add(after), scale: nextScale };
}

/** Start on the first valid actionable order; a deliberately paused match stays paused. */
export function issuePlayerOrder(battle: QuestBattle, ids: number[], order: Order, destination?: Point3, targetId?: number): string {
  const valid = !battle.terminal && battle.fleet(0).some(e => ids.includes(e.id)) &&
    (order === "focus" ? battle.getEntity(targetId ?? null)?.side === 1 : order === "hold" || !!destination);
  if (valid) for (const ship of battle.fleet(0).filter(e => ids.includes(e.id))) {
    ship.playerControlled = true;
    if (ship.supplyTransit) { ship.speed = ship.supplyTransit.combatSpeed; delete ship.supplyTransit; }
    delete ship.encounterCenter; delete ship.encounterExtents;
  }
  const result = battle.issue(0, ids, order, destination, targetId);
  if (valid && order !== "hold" && battle.status === "ready") {
    battle.togglePause(); return `${result} Battle started.`;
  }
  return valid && battle.status === "paused" ? `${result} PAUSED — press Resume to execute.` : result;
}

/** A 30 cm spread gives ~6× zoom; independent of initial hand spacing. */
export function fastZoomScale(startScale: number, startSpan: number, span: number): number {
  return Math.max(MIN_BATTLE_SCALE, Math.min(MAX_BATTLE_SCALE, startScale * Math.exp((span - startSpan) * 6)));
}

/** Scale about a fixed battle target, never the eyes or a moving hand midpoint. */
export function scaleAbout(position: Vector3, scale: number, nextScale: number, anchor: Vector3): Vector3 {
  return position.clone().sub(anchor).multiplyScalar(nextScale / scale).add(anchor);
}

/** Horizontal turn only; ignore near-vertical hand lines where heading is unstable. */
export function horizontalHandTurn(previous: readonly [Vector3, Vector3], current: readonly [Vector3, Vector3]): number {
  const before = previous[1].clone().sub(previous[0]), after = current[1].clone().sub(current[0]);
  if (Math.hypot(before.x, before.z) < 0.08 || Math.hypot(after.x, after.z) < 0.08) return 0;
  const delta = Math.atan2(after.x, after.z) - Math.atan2(before.x, before.z);
  return Math.atan2(Math.sin(delta), Math.cos(delta));
}

/** Translate, scale and yaw around the moving hand midpoint; never pitch or roll. */
export function twoHandPosition(position: Vector3, startScale: number, scale: number,
  start: readonly [Vector3, Vector3], current: readonly [Vector3, Vector3], yaw = 0): Vector3 {
  const before = start[0].clone().add(start[1]).multiplyScalar(0.5);
  const after = current[0].clone().add(current[1]).multiplyScalar(0.5);
  return position.clone().sub(before).multiplyScalar(scale / startScale).applyAxisAngle(new Vector3(0, 1, 0), yaw).add(after);
}

export function canTouchWrist(owner: number, actor: number): boolean { return owner < 0 || owner !== actor; }
