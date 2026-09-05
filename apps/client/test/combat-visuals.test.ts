import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { FACTION_IDS, FACTIONS, SHIPS, WEAPONS, type ProjectileState } from "@space-rts/game-core";
import { getTorpedoImpactPoint, ProjectileVfx, type ProjectileVisualTarget } from "../src/combat-visuals";
import { getShipHullGeometries } from "../src/ship-hulls";

describe("VLS impact placement", () => {
  it("is deterministic and distributes consecutive missiles across the hull interior", () => {
    const target = { x: 120, z: -45, radius: 40, yaw: 0, isShip: true } as const;
    const points = Array.from({ length: 24 }, (_, index) => getTorpedoImpactPoint(500 + index, target));

    expect(getTorpedoImpactPoint(507, target)).toEqual(getTorpedoImpactPoint(507, target));
    expect(points.some((point) => point.x < target.x)).toBe(true);
    expect(points.some((point) => point.x > target.x)).toBe(true);
    expect(points.some((point) => point.z < target.z)).toBe(true);
    expect(points.some((point) => point.z > target.z)).toBe(true);

    for (const point of points) {
      const normalizedX = (point.x - target.x) / (target.radius * 0.48);
      const normalizedZ = (point.z - target.z) / (target.radius * 0.74);
      expect(normalizedX ** 2 + normalizedZ ** 2).toBeLessThan(0.79);
    }
  });

  it("rotates the impact pattern with the target ship", () => {
    const unrotated = getTorpedoImpactPoint(91, {
      x: 0, z: 0, radius: 30, yaw: 0, isShip: true,
    });
    const quarterTurn = getTorpedoImpactPoint(91, {
      x: 0, z: 0, radius: 30, yaw: Math.PI / 2, isShip: true,
    });

    expect(quarterTurn.x).toBeCloseTo(unrotated.z);
    expect(quarterTurn.z).toBeCloseTo(-unrotated.x);
  });

  it("places impacts on real hull surfaces for every frigate and larger faction ship, including bank and altitude", () => {
    const ray = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    for (const faction of FACTION_IDS) for (const shipClass of FACTIONS[faction].ships) {
      if (["fighter", "bomber", "fabricator"].includes(shipClass)) continue;
      const geometry = getShipHullGeometries(shipClass, faction);
      const surfaces = [new THREE.Mesh(geometry.hull), new THREE.Mesh(geometry.armor)];
      const target = { x: 240, y: 17, z: -120, radius: SHIPS[shipClass].radius,
        yaw: 0.7, bank: -0.12, pitch: 0.04, shipClass, faction, isShip: true };
      const inverse = new THREE.Matrix4().compose(new THREE.Vector3(target.x, target.y, target.z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(target.pitch, target.yaw, target.bank, "YXZ")),
        new THREE.Vector3(1, 1, 1)).invert();
      for (let id = 1; id <= 24; id++) {
        const impact = getTorpedoImpactPoint(id, target);
        const local = new THREE.Vector3(impact.x, impact.y, impact.z).applyMatrix4(inverse);
        ray.set(local.clone().add(new THREE.Vector3(0, 1, 0)), down);
        const hit = ray.intersectObjects(surfaces, false)[0];
        expect(hit, `${faction} ${shipClass}: impact must not land in a gap`).toBeDefined();
        expect(Math.abs(hit!.point.y - local.y), `${faction} ${shipClass}: impact must touch the armor`).toBeLessThan(0.11);
      }
      for (const mesh of surfaces) (mesh.material as THREE.Material).dispose();
    }
  });

  function missile(x: number, age = 50): ProjectileState {
    return { id: 503, ownerShipId: 1, ownerTeamId: 1, targetEntityId: 2, weaponTypeId: "torpedo",
      x, z: 0, previousX: x - 4, previousZ: 0, vx: WEAPONS.torpedo.projectileSpeed, vz: 0,
      radius: WEAPONS.torpedo.projectileRadius, damage: WEAPONS.torpedo.damage,
      lifetimeTicks: WEAPONS.torpedo.projectileLifetimeTicks - age,
      targetX: 400, targetZ: 0, fixedTrajectory: false };
  }

  it("finishes its descent at the same hull point as the explosion on a moving target", () => {
    const vfx = new ProjectileVfx(new THREE.Scene());
    const target: ProjectileVisualTarget = { x: 400, y: 23, z: 0, radius: SHIPS.cruiser.radius,
      shipClass: "cruiser", faction: "concord", isShip: true, yaw: 0.3, bank: 0.1 };
    const targets = new Map([[2, target]]);
    vfx.update([missile(100)], 1, 10, targets);
    target.x += 90; target.y += 5; target.yaw += 0.6;
    const contact = missile(target.x - target.radius - WEAPONS.torpedo.projectileRadius, 60);
    vfx.update([contact], 1, 10, targets);
    const pose = vfx.getLastVisualPose(contact.id)!;
    const impact = getTorpedoImpactPoint(contact.id, target);
    expect(pose.x).toBeCloseTo(impact.x, 5);
    expect(pose.y).toBeCloseTo(impact.y, 5);
    expect(pose.z).toBeCloseTo(impact.z, 5);
    expect(pose.directionY).toBeLessThan(0);
  });

  it("keeps a missile above the hull until contact instead of settling at its old arrival time", () => {
    const vfx = new ProjectileVfx(new THREE.Scene());
    const target = { x: 160, y: 5, z: 0, radius: SHIPS.frigate.radius, shipClass: "frigate" as const, isShip: true };
    const targets = new Map([[2, target]]);
    vfx.update([missile(0, 2)], 1, 10, targets);
    target.x = 400;
    vfx.update([missile(320, 60)], 1, 10, targets);
    expect(vfx.getLastVisualPose(503)!.y).toBeGreaterThan(getTorpedoImpactPoint(503, target).y + 2);
  });

  it("lets misses continue along the real track instead of landing on a ship that moved aside", () => {
    const vfx = new ProjectileVfx(new THREE.Scene());
    const target = { x: 160, y: 5, z: 0, radius: SHIPS.frigate.radius, shipClass: "frigate" as const, isShip: true };
    const targets = new Map([[2, target]]);
    vfx.update([missile(0, 2)], 1, 10, targets);
    target.z = 200;
    vfx.update([missile(400, 70)], 1, 10, targets);
    expect(vfx.getLastVisualPose(503)!.x).toBeCloseTo(400);
    expect(vfx.getLastVisualPose(503)!.z).toBeCloseTo(0);
    vfx.update([], 1);
    expect(vfx.getLastVisualPose(503)).toBeUndefined();
  });

  it("does not fake a hull strike when the target moves beyond the missile's remaining lifetime", () => {
    const vfx = new ProjectileVfx(new THREE.Scene());
    const target = { x: 160, y: 5, z: 0, radius: SHIPS.frigate.radius, shipClass: "frigate" as const, isShip: true };
    const targets = new Map([[2, target]]);
    vfx.update([missile(0, 2)], 1, 10, targets);
    target.x = 900;
    const almostExpired = missile(380, WEAPONS.torpedo.projectileLifetimeTicks - 1);
    vfx.update([almostExpired], 1, 10, targets);
    expect(vfx.getLastVisualPose(503)!.x).toBeCloseTo(almostExpired.x);
  });
});
