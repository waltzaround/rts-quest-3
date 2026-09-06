import { describe, expect, it } from "vitest";
import { SpatialHash } from "../src/spatial-hash";

describe("spatial hash", () => {
  it("returns entities whose cells overlap the query radius", () => {
    const hash = new SpatialHash<{ id: number; x: number; z: number }>(100);
    hash.rebuild([
      { id: 1, x: 0, z: 0 },
      { id: 2, x: 250, z: 0 },
      { id: 3, x: -40, z: -40 },
    ]);
    const nearby = hash.query(0, 0, 80);
    expect(nearby.map((entity) => entity.id).sort((left, right) => left - right)).toEqual([1, 3]);
  });

  it("keeps negative cell coordinates distinct from positive ones", () => {
    const hash = new SpatialHash<{ id: number; x: number; z: number }>(10);
    hash.rebuild([
      { id: 1, x: -15, z: -15 },
      { id: 2, x: 15, z: 15 },
    ]);
    expect(hash.query(-15, -15, 1).map((entity) => entity.id)).toEqual([1]);
    expect(hash.query(15, 15, 1).map((entity) => entity.id)).toEqual([2]);
  });

  it("reuses a caller-owned buffer without leaking prior results", () => {
    const hash = new SpatialHash<{ id: number; x: number; z: number }>(50);
    hash.rebuild([
      { id: 1, x: 0, z: 0 },
      { id: 2, x: 200, z: 200 },
    ]);
    const buffer: Array<{ id: number; x: number; z: number }> = [{ id: 99, x: 0, z: 0 }];
    const first = hash.query(0, 0, 10, buffer);
    expect(first).toBe(buffer);
    expect(first.map((entity) => entity.id)).toEqual([1]);
    const second = hash.query(200, 200, 10, buffer);
    expect(second).toBe(buffer);
    expect(second.map((entity) => entity.id)).toEqual([2]);
  });

  it("allocates a fresh array when no buffer is supplied", () => {
    const hash = new SpatialHash<{ id: number; x: number; z: number }>(50);
    hash.rebuild([{ id: 1, x: 0, z: 0 }]);
    const first = hash.query(0, 0, 10);
    const second = hash.query(0, 0, 10);
    expect(first).not.toBe(second);
    expect(first.map((entity) => entity.id)).toEqual([1]);
    expect(second.map((entity) => entity.id)).toEqual([1]);
  });
});
