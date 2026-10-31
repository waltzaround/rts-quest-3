import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { QuestBattle } from "./quest-combat";
import { horizontalHandTurn, twoHandPosition, canTouchWrist, grabTransform, fastZoomScale, scaleAbout, issuePlayerOrder, MAX_BATTLE_SCALE, MIN_BATTLE_SCALE } from "./quest-spatial-controls";

describe("spatial battle manipulation", () => {
  it("pulls the battle with one hand in all three axes", () => {
    const result = grabTransform(new Vector3(0, 1, -2), 3, [new Vector3(0, 1, -0.5)], [new Vector3(0.2, 1.4, 0)]);
    expect(result.position.toArray()).toEqual([0.2, 1.4, -1.5]); expect(result.scale).toBe(3);
  });
  it("zooms about the hand midpoint while translating, preserving the grabbed point", () => {
    const position = new Vector3(0, 0, -2), midpoint = new Vector3(0, 1, -1);
    const localAnchor = midpoint.clone().sub(position).divideScalar(2);
    const result = grabTransform(position, 2, [new Vector3(-0.2, 1, -1), new Vector3(0.2, 1, -1)], [new Vector3(-0.3, 1.3, -0.5), new Vector3(0.5, 1.3, -0.5)]);
    expect(result.scale).toBe(4);
    expect(localAnchor.multiplyScalar(result.scale).add(result.position).distanceTo(new Vector3(0.1, 1.3, -0.5))).toBeLessThan(1e-10);
  });
  it("closes hands for overview, clamps scale, and handles coincident hands", () => {
    const pair = [new Vector3(-0.2, 0, 0), new Vector3(0.2, 0, 0)];
    expect(grabTransform(new Vector3(), 4, pair, pair.map(p => p.clone().multiplyScalar(0.5))).scale).toBe(2);
    expect(grabTransform(new Vector3(), 10, pair, pair.map(p => p.clone().multiplyScalar(100))).scale).toBe(MAX_BATTLE_SCALE);
    expect(grabTransform(new Vector3(), 1, pair, [new Vector3(), new Vector3()]).scale).toBe(MIN_BATTLE_SCALE);
    expect(grabTransform(new Vector3(), 1, [new Vector3(), new Vector3()], pair).scale).toBe(1);
  });
  it("does not jump when a hand joins or leaves", () => {
    const position = new Vector3(1, 2, 3);
    const result = grabTransform(position, 5, [new Vector3()], [new Vector3(2, 3, 4), new Vector3(5, 6, 7)]);
    expect(result.position).toEqual(position); expect(result.scale).toBe(5);
  });
});

describe("player order execution", () => {
  it("starts a fresh match on a movement order and actually moves the selected ship", () => {
    const battle = new QuestBattle(), ship = battle.fleet(0)[0]!, before = { ...ship.position };
    const message = issuePlayerOrder(battle, [ship.id], "move", { x: 0, y: 1.1, z: 0 });
    expect(message).toContain("Battle started"); expect(battle.status).toBe("running");
    for (let i = 0; i < 20; i++) battle.advance(0.05);
    expect(ship.position.x).toBeGreaterThan(before.x); expect(ship.position.y).toBeGreaterThan(before.y);
  });
  it("starts a fresh match on focus fire but not selection errors or hold", () => {
    const battle = new QuestBattle(), ship = battle.fleet(0)[0]!;
    issuePlayerOrder(battle, [], "move", { x: 0, y: 1, z: 0 }); expect(battle.status).toBe("ready");
    issuePlayerOrder(battle, [ship.id], "focus", undefined, ship.id); expect(battle.status).toBe("ready");
    issuePlayerOrder(battle, [ship.id], "hold"); expect(battle.status).toBe("ready");
    issuePlayerOrder(battle, [ship.id], "focus", undefined, battle.core(1)!.id); expect(battle.status).toBe("running");
  });
  it("keeps explicit pause, explains queued orders, and moves after resume", () => {
    const battle = new QuestBattle(), ship = battle.fleet(0)[0]!;
    battle.togglePause(); battle.togglePause();
    const before = { ...ship.position };
    expect(issuePlayerOrder(battle, [ship.id], "move", { x: 0, y: 1, z: 0 })).toContain("PAUSED");
    battle.advance(0.2); expect(ship.position).toEqual(before);
    battle.togglePause(); battle.advance(0.2); expect(ship.position).not.toEqual(before);
  });
});


describe("fast target-centered zoom", () => {
  it("covers overview to action in one 30 cm spread and reverses exactly", () => {
    const enlarged = fastZoomScale(0.8, 0.2, 0.5);
    expect(enlarged).toBeGreaterThan(4.8);
    expect(fastZoomScale(enlarged, 0.5, 0.2)).toBeCloseTo(0.8);
    expect(fastZoomScale(0.8, 0.5, 0.8)).toBeCloseTo(enlarged);
  });
  it("keeps a battle target stationary as zoom changes, without head or hand translation", () => {
    const position = new Vector3(1, 0, -2), anchor = new Vector3(0, 1.2, -1.5);
    const localTarget = anchor.clone().sub(position).divideScalar(0.8);
    const nextPosition = scaleAbout(position, 0.8, 5, anchor);
    expect(localTarget.multiplyScalar(5).add(nextPosition).distanceTo(anchor)).toBeLessThan(1e-10);
    expect(scaleAbout(nextPosition, 5, 0.8, anchor).distanceTo(position)).toBeLessThan(1e-10);
  });
  it("bounds exaggerated gestures", () => {
    expect(fastZoomScale(1, 0.1, 2)).toBe(MAX_BATTLE_SCALE);
    expect(fastZoomScale(1, 2, 0.1)).toBe(MIN_BATTLE_SCALE);
  });
});


describe("free two-hand manipulation", () => {
  it("moves and scales around the hands without turning when they twist", () => {
    const position = new Vector3(1, 0, -2);
    const before: [Vector3, Vector3] = [new Vector3(-0.2, 1, -1), new Vector3(0.2, 1, -1)];
    const after: [Vector3, Vector3] = [new Vector3(0.5, 1.1, -0.8), new Vector3(0.5, 1.9, -0.8)];
    const local = new Vector3(0, 1, -1).sub(position).divideScalar(2);
    const result = twoHandPosition(position, 2, 6, before, after);
    expect(local.multiplyScalar(6).add(result).distanceTo(new Vector3(0.5, 1.5, -0.8))).toBeLessThan(1e-10);
    // Equal spans and midpoints, regardless of hand-line direction, give the same pose.
    const horizontal: [Vector3, Vector3] = [new Vector3(0.1, 1.5, -0.8), new Vector3(0.9, 1.5, -0.8)];
    expect(twoHandPosition(position, 2, 6, before, horizontal).distanceTo(result)).toBeLessThan(1e-10);
  });
  it("preserves the position on re-grab and safely handles coincident hands", () => {
    const position = new Vector3(2, 3, 4);
    const pair: [Vector3, Vector3] = [new Vector3(-0.2, 1, 0), new Vector3(0.2, 1, 0)];
    expect(twoHandPosition(position, 3, 3, pair, pair).distanceTo(position)).toBeLessThan(1e-10);
    expect(twoHandPosition(position, 3, 3, pair, [new Vector3(), new Vector3()]).toArray().every(Number.isFinite)).toBe(true);
  });
  it("does not let the cuff catch its own hand's upward drag", () => {
    expect(canTouchWrist(0, 0)).toBe(false);
    expect(canTouchWrist(0, 1)).toBe(true);
    expect(canTouchWrist(1, 1)).toBe(false);
    expect(canTouchWrist(1, 0)).toBe(true);
    expect(canTouchWrist(-1, 0)).toBe(true);
  });
});


describe("horizontal battlefield rotation", () => {
  const pair = (angle: number, height = 1): [Vector3, Vector3] => [new Vector3(0, 1, 0), new Vector3(Math.sin(angle) * 0.4, height, Math.cos(angle) * 0.4)];
  it("uses horizontal heading and ignores one hand being raised", () => {
    expect(horizontalHandTurn(pair(0), pair(Math.PI / 2, 1.6))).toBeCloseTo(Math.PI / 2);
    expect(horizontalHandTurn(pair(0), pair(0, 2))).toBeCloseTo(0);
  });
  it("takes the short turn across the angle boundary and ignores unstable vertical spans", () => {
    expect(horizontalHandTurn(pair(Math.PI - 0.02), pair(-Math.PI + 0.02))).toBeCloseTo(0.04);
    const vertical: [Vector3, Vector3] = [new Vector3(0, 1, 0), new Vector3(0.001, 1.5, 0.001)];
    expect(horizontalHandTurn(pair(0), vertical)).toBe(0);
    expect(horizontalHandTurn(vertical, pair(Math.PI))).toBe(0);
  });
  it("keeps the grabbed point at the moving midpoint while yawing and zooming", () => {
    const position = new Vector3(1, 0, -2), before = pair(0), after = pair(Math.PI / 2, 1.5);
    const midpoint = before[0].clone().add(before[1]).multiplyScalar(0.5);
    const local = midpoint.sub(position).divideScalar(2);
    const yaw = horizontalHandTurn(before, after);
    const result = twoHandPosition(position, 2, 5, before, after, yaw);
    const expected = after[0].clone().add(after[1]).multiplyScalar(0.5);
    expect(local.multiplyScalar(5).applyAxisAngle(new Vector3(0, 1, 0), yaw).add(result).distanceTo(expected)).toBeLessThan(1e-10);
    expect(new Vector3(0, 1, 0).applyAxisAngle(new Vector3(0, 1, 0), yaw).toArray()).toEqual([0, 1, 0]);
  });
});

it("preserves the tiny top-zoom scale when a grab or stick zoom starts", () => {
  const pair = [new Vector3(-0.15, 1, -1), new Vector3(0.15, 1, -1)];
  const position = new Vector3(0, 1, -2);
  const result = grabTransform(position, 0.025, pair, pair);
  expect(result.scale).toBeCloseTo(0.025); expect(result.position).toEqual(position);
  expect(fastZoomScale(0.025, 0.3, 0.3)).toBeCloseTo(0.025);
  expect(MIN_BATTLE_SCALE).toBeLessThan(0.025);
});
